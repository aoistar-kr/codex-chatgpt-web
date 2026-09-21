/**
 * Live contract check for an abandoned Codex Native invocation against the running daemon.
 *
 * The MCP bridge abandons an invocation whose transport deadline expired and then receives the
 * native result late. This drives the running daemon over its real broker endpoint with that exact
 * sequence and requires the deployed build to keep the turn token valid and to absorb the late
 * result. It is the fastest way to prove that a freshly deployed cli.js is actually the one the
 * daemon has in memory.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { callTurnBroker, type BrokerToolResult } from "../src/adapters/chatgpt-web/turn-broker";
import type { ChatGptTurnEnvironment } from "../src/adapters/chatgpt-web/environment";
import { defaultBrokerEndpoint } from "../src/config";

type JsonObject = Record<string, unknown>;

const ENDPOINT = process.env.CODEX_CHATGPT_WEB_LIVE_BROKER_ENDPOINT?.trim() || defaultBrokerEndpoint();
const CWD = process.cwd();
const launcherLog = join(
  process.env.APPDATA || join(homedir(), "AppData", "Roaming"),
  "Codex Web GPT",
  "logs",
  "launcher.jsonl",
);
const logOffset = existsSync(launcherLog) ? readFileSync(launcherLog, "utf8").length : 0;

function logLines(): string[] {
  return readFileSync(launcherLog, "utf8").slice(logOffset).split(/\r?\n/).filter(Boolean);
}

function toolResult(value: JsonObject): BrokerToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
}

const environment = {
  cwd: CWD,
  roots: [CWD],
  writableRoots: [CWD],
  sandboxPolicy: { type: "readOnly" },
  tools: [{
    name: "exec_command",
    description: "Run a command",
    parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
  }],
} as unknown as ChatGptTurnEnvironment;

const traceId = `live-daemon-broker-${Date.now().toString(36)}`;
const checks: JsonObject = {};
let token: string | undefined;

try {
  const status = await callTurnBroker<{ acceptingExternalOwners?: unknown; protocolVersion?: unknown }>(
    ENDPOINT,
    { method: "owner_status" },
    10_000,
  );
  checks.endpoint = ENDPOINT;
  checks.acceptingExternalOwners = status.acceptingExternalOwners === true;
  checks.protocolVersion = status.protocolVersion ?? null;
  if (status.acceptingExternalOwners !== true) throw new Error("the running daemon is not accepting external owners");

  const registered = await callTurnBroker<{ token?: unknown }>(
    ENDPOINT,
    { method: "owner_register", environment, ttlMs: 300_000, traceId },
    10_000,
  );
  if (typeof registered.token !== "string") throw new Error("owner_register returned no token");
  token = registered.token;
  checks.registered = true;

  const claimed = await callTurnBroker<{ bindingId: string }>(ENDPOINT, { method: "claim", token }, 10_000);
  checks.firstBindingId = claimed.bindingId;

  // The rejection is claimed at creation time so the deliberately abandoned invocation never shows
  // up as an unhandled rejection.
  const invocation = callTurnBroker<BrokerToolResult>(ENDPOINT, {
    method: "invoke",
    bindingId: claimed.bindingId,
    wireName: "exec_command",
    freeform: false,
    arguments: { cmd: "cmd.exe /d /c ping -n 200 127.0.0.1" },
  }, 60_000).then(
    () => "resolved",
    error => String((error as Error).message ?? error),
  );
  const batch = await callTurnBroker<{ requests: Array<{ callId: string }> }>(ENDPOINT, { method: "owner_next", token }, 20_000);
  const callId = batch.requests?.[0]?.callId;
  if (typeof callId !== "string") throw new Error("owner_next returned no queued call");
  checks.queuedCallId = callId;

  // The MCP bridge's transport-deadline path: the invocation is abandoned while the native tool
  // keeps running.
  const released = await callTurnBroker<{ released?: unknown }>(ENDPOINT, { method: "release", bindingId: claimed.bindingId }, 10_000);
  checks.released = released.released === true;
  checks.abandonedRejection = await invocation;

  // The owner's late completion must be absorbed instead of failing the turn.
  const completed = await callTurnBroker<{ completed?: unknown }>(ENDPOINT, {
    method: "owner_complete",
    token,
    callId,
    toolResult: toolResult({ output: "late result after the deadline" }),
  }, 10_000);
  checks.lateCompletionAbsorbed = completed.completed === true;

  // A second completion for the same call stays a protocol error.
  checks.secondCompletionRejected = await callTurnBroker(ENDPOINT, {
    method: "owner_complete",
    token,
    callId,
    toolResult: toolResult({ output: "duplicate" }),
  }, 10_000).then(() => false, error => String((error as Error).message ?? error).includes("not pending"));

  // The response that is still generating must be able to claim again with the same token.
  const reclaimed = await callTurnBroker<{ bindingId: string }>(ENDPOINT, { method: "claim", token }, 10_000);
  checks.secondBindingId = reclaimed.bindingId;
  checks.tokenSurvivedRelease = reclaimed.bindingId !== claimed.bindingId;
} catch (error) {
  checks.error = String((error as Error)?.message ?? error).slice(0, 300);
} finally {
  if (token) await callTurnBroker(ENDPOINT, { method: "owner_revoke", token }, 10_000).catch(() => {});
}

await Bun.sleep(500);
const lines = logLines();
const releaseWithoutRetireLog = lines
  .filter(line => line.includes("released binding") && line.includes("without retiring the turn")).length;
const absorbedLog = lines.filter(line => line.includes("absorbed late result for released call=")).length;
const retiredTokenRejections = lines
  .filter(line => line.includes("valid=false") && line.includes("retiredTurn=") && line.includes(traceId)).length;

const verdict = {
  live_daemon_broker_pass: checks.acceptingExternalOwners === true
    && checks.released === true
    && checks.lateCompletionAbsorbed === true
    && checks.secondCompletionRejected === true
    && checks.tokenSurvivedRelease === true
    && releaseWithoutRetireLog >= 1
    && absorbedLog >= 1
    && retiredTokenRejections === 0
    && checks.error === undefined,
  ...checks,
  releaseWithoutRetireLog,
  absorbedLog,
  retiredTokenRejections,
};
process.stdout.write(`${JSON.stringify(verdict)}\n`);
if (!verdict.live_daemon_broker_pass) process.exitCode = 1;
