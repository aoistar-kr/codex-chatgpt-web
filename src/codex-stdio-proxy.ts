import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveOriginalCodexCli } from "./codex-cli-resolver";

interface ProxyConfig {
  host: string;
  port: number;
  controlToken: string;
}

export type CodexProxyControlFrame =
  | {
      kind: "steer";
      payload: {
        threadId: string;
        turnId: string;
        itemId: string;
        content: Array<{ type: "input_text" | "text"; text: string }>;
      };
    }
  | { kind: "interrupt"; payload: { threadId: string; turnId: string } };

const IDENTIFIER = /^[A-Za-z0-9_-]{6,128}$/;

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function parseCodexProxyControlFrame(line: string): CodexProxyControlFrame | undefined {
  let message: Record<string, unknown> | undefined;
  try { message = object(JSON.parse(line)); } catch { return undefined; }
  if (!message) return undefined;
  const params = object(message.params);
  if (!params) return undefined;
  if (message.method === "turn/interrupt") {
    const threadId = typeof params.threadId === "string" ? params.threadId.trim() : "";
    const turnId = typeof params.turnId === "string" ? params.turnId.trim() : "";
    if (!IDENTIFIER.test(threadId) || !IDENTIFIER.test(turnId)) return undefined;
    return { kind: "interrupt", payload: { threadId, turnId } };
  }
  if (message.method !== "turn/steer") return undefined;
  const threadId = typeof params.threadId === "string" ? params.threadId.trim() : "";
  const turnId = typeof params.expectedTurnId === "string" ? params.expectedTurnId.trim() : "";
  if (!IDENTIFIER.test(threadId) || !IDENTIFIER.test(turnId) || !Array.isArray(params.input)) return undefined;
  const content: Array<{ type: "text"; text: string }> = [];
  let textBytes = 0;
  for (const raw of params.input) {
    const input = object(raw);
    if (!input || input.type !== "text" || typeof input.text !== "string" || input.text.length === 0) {
      return undefined;
    }
    textBytes += Buffer.byteLength(input.text, "utf8");
    if (textBytes > 32 * 1024) return undefined;
    content.push({ type: "text", text: input.text });
  }
  if (content.length < 1 || content.length > 16) return undefined;
  const requestedItemId = typeof params.clientUserMessageId === "string"
    ? params.clientUserMessageId.trim()
    : "";
  const itemId = IDENTIFIER.test(requestedItemId)
    ? requestedItemId
    : `steer_${createHash("sha256").update(`${threadId}\0${turnId}\0${line}`).digest("hex").slice(0, 24)}`;
  return {
    kind: "steer",
    payload: { threadId, turnId, itemId, content },
  };
}

function configPath(): string {
  const explicit = process.env.CODEX_CHATGPT_WEB_HOME;
  const home = explicit ? resolve(explicit) : join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".codex-chatgpt-web");
  return join(home, "config.json");
}

function loadProxyConfig(): ProxyConfig {
  const parsed = JSON.parse(readFileSync(configPath(), "utf8")) as Partial<ProxyConfig>;
  const host = typeof parsed.host === "string" ? parsed.host.trim() : "";
  const port = parsed.port;
  const controlToken = typeof parsed.controlToken === "string" ? parsed.controlToken : "";
  if (!new Set(["127.0.0.1", "localhost", "::1"]).has(host)
    || !Number.isInteger(port) || (port as number) < 1 || (port as number) > 65_535
    || controlToken.length < 16) {
    throw new Error("WebGPT control configuration is missing or unsafe");
  }
  return { host, port: port as number, controlToken };
}

async function postControl(frame: CodexProxyControlFrame): Promise<void> {
  const config = loadProxyConfig();
  const path = frame.kind === "steer" ? "steer-turn" : "interrupt-turn";
  const deadline = Date.now() + 1_500;
  do {
    const response = await fetch(`http://${config.host}:${config.port}/admin/${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.controlToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(frame.payload),
      signal: AbortSignal.timeout(1_000),
    });
    if (!response.ok) {
      const detail = (await response.text()).replace(/[\r\n]+/g, " ").slice(0, 512);
      throw new Error(`WebGPT ${frame.kind} control returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
    }
    if (frame.kind === "interrupt") return;
    const result = await response.json() as { accepted_browser_turns?: unknown };
    if (result.accepted_browser_turns === 1) return;
    if (result.accepted_browser_turns !== 0 || Date.now() >= deadline) {
      throw new Error("WebGPT did not acknowledge the exact active browser turn");
    }
    await Bun.sleep(50);
  } while (Date.now() < deadline);
}

async function run(): Promise<number> {
  const args = process.argv.slice(2);
  const realCodex = resolveOriginalCodexCli({ explicitPath: process.env.CODEX_WEBGPT_REAL_CODEX });
  const appServer = args.includes("app-server");
  if (!appServer) {
    const child = Bun.spawn([realCodex, ...args], { stdin: "inherit", stdout: "inherit", stderr: "inherit", env: process.env });
    return await child.exited;
  }

  const child = Bun.spawn([realCodex, ...args], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: process.env });
  const decoder = new TextDecoder();
  let pending = "";
  const forward = async (chunk: Uint8Array): Promise<void> => {
    pending += decoder.decode(chunk, { stream: true });
    for (;;) {
      const newline = pending.indexOf("\n");
      if (newline < 0) break;
      const wireLine = pending.slice(0, newline + 1);
      const line = wireLine.slice(0, -1).replace(/\r$/, "");
      pending = pending.slice(newline + 1);
      const frame = parseCodexProxyControlFrame(line);
      if (frame) {
        try { await postControl(frame); }
        catch (error) {
          process.stderr.write(`codex-webgpt-proxy: ${error instanceof Error ? error.message : String(error)}\n`);
        }
      }
      child.stdin.write(wireLine);
    }
  };
  const input = (async () => {
    for await (const raw of process.stdin) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      await forward(chunk);
    }
    pending += decoder.decode();
    if (pending) child.stdin.write(pending);
    child.stdin.end();
  })();
  const stdout = (async () => { for await (const chunk of child.stdout) process.stdout.write(chunk); })();
  const stderr = (async () => { for await (const chunk of child.stderr) process.stderr.write(chunk); })();
  const terminate = () => { try { child.kill(); } catch {} };
  process.once("SIGINT", terminate);
  process.once("SIGTERM", terminate);
  const exitCode = await child.exited;
  await Promise.allSettled([input, stdout, stderr]);
  return exitCode;
}

if (import.meta.main) {
  run().then(code => { process.exitCode = code; }).catch(error => {
    process.stderr.write(`codex-webgpt-proxy: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
