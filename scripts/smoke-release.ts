import { cpSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { defaultBrokerEndpoint } from "../src/config";
import { VERSION } from "../src/version";

const require = createRequire(import.meta.url);
const { validateRuntimeBundle } = require("../launcher/electron/runtime-install.cjs") as {
  validateRuntimeBundle: (
    runtimeRoot: string,
    identity: { version: string; platform: string; arch: string },
  ) => string;
};

const HTTP_TIMEOUT_MS = 3_000;
const HEALTH_DEADLINE_MS = 10_000;
const CHILD_GRACEFUL_TIMEOUT_MS = 2_000;
const CHILD_FORCE_TIMEOUT_MS = 2_000;
const DIAGNOSTIC_TAIL_CHARS = 8_000;
const DIAGNOSTIC_TAIL_TIMEOUT_MS = 1_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function redactDiagnostic(value: string): string {
  return value
    .replace(/Bearer\s+\S+/gi, "Bearer <redacted>")
    .replace(/(authorization|cookie|set-cookie|controlToken|tokenHash|token|secret|api[_-]?key)\s*[:=]\s*("[^"]*"|'[^']*'|[^,\s}\r\n]+)/gi, "$1=<redacted>");
}

async function captureStreamTail(
  stream: unknown,
): Promise<string> {
  if (!(stream instanceof ReadableStream)) return "";
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let tail = "";
  const append = (chunk: string): void => {
    tail += chunk;
    if (tail.length > DIAGNOSTIC_TAIL_CHARS) tail = tail.slice(-DIAGNOSTIC_TAIL_CHARS);
  };
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      if (result.value) append(decoder.decode(result.value, { stream: true }));
    }
    append(decoder.decode());
  } catch (error) {
    append(`\n[diagnostic stream read failed: ${errorMessage(error)}]`);
  } finally {
    reader.releaseLock();
  }
  return redactDiagnostic(tail);
}

async function boundedDiagnosticTail(tail: Promise<string>): Promise<string> {
  return await Promise.race([
    tail,
    Bun.sleep(DIAGNOSTIC_TAIL_TIMEOUT_MS).then(
      () => `[diagnostic stream tail unavailable after ${DIAGNOSTIC_TAIL_TIMEOUT_MS}ms]`,
    ),
  ]);
}

async function fetchStage(
  stage: string,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  parseJson = false,
): Promise<{ response: Response; body?: unknown }> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, HTTP_TIMEOUT_MS);
  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    if (parseJson) return { response, body: await response.json() };
    await response.arrayBuffer();
    return { response };
  } catch (error) {
    if (timedOut) throw new Error(`${stage} timed out after ${HTTP_TIMEOUT_MS}ms`);
    throw new Error(`${stage} failed: ${errorMessage(error)}`);
  } finally {
    clearTimeout(timer);
  }
}

async function waitForChild(child: Bun.Subprocess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null) return true;
  return await Promise.race([
    child.exited.then(() => true),
    Bun.sleep(timeoutMs).then(() => false),
  ]);
}

async function stopChild(child: Bun.Subprocess): Promise<{ exited: boolean; forced: boolean }> {
  if (child.exitCode === null) {
    try {
      child.kill("SIGTERM");
    } catch {}
  }
  if (await waitForChild(child, CHILD_GRACEFUL_TIMEOUT_MS)) {
    return { exited: true, forced: false };
  }
  if (child.exitCode === null) {
    try {
      child.kill("SIGKILL");
    } catch {}
  }
  return {
    exited: await waitForChild(child, CHILD_FORCE_TIMEOUT_MS),
    forced: true,
  };
}

function childDiagnostics(stdout: string, stderr: string): string {
  return [
    "child stdout tail:",
    stdout || "(empty)",
    "child stderr tail:",
    stderr || "(empty)",
  ].join("\n");
}

async function main(): Promise<void> {
  const sourceBundle = resolve(process.argv[2] ?? "dist/runtime");
  const sourceRoot = resolve(import.meta.dir, "..");
  const root = join(homedir(), `.codex-chatgpt-web-release-smoke-${process.pid}-${Date.now()}`);
  const firstLocation = join(root, "first-location");
  const runtimeRoot = join(root, "relocated-runtime");
  let child: Bun.Subprocess | undefined;
  let childStdoutTail: Promise<string> | undefined;
  let childStderrTail: Promise<string> | undefined;
  let gracefulShutdownObserved = false;
  let primaryError: unknown;
  let cleanupError: string | undefined;
  let termination: { exited: boolean; forced: boolean } | undefined;

  try {
    cpSync(sourceBundle, firstLocation, { recursive: true, verbatimSymlinks: true });
    renameSync(firstLocation, runtimeRoot);
    validateRuntimeBundle(runtimeRoot, {
      version: VERSION,
      platform: process.platform,
      arch: process.arch,
    });

    const manifest = JSON.parse(readFileSync(join(runtimeRoot, "manifest.json"), "utf8")) as Record<string, unknown>;
    if (manifest.schemaVersion !== 2
      || manifest.appVersion !== VERSION
      || manifest.playwright !== "1.62.0"
      || !Array.isArray(manifest.files)
      || manifest.files.length === 0
      || !/^[a-f0-9]{64}$/.test(String(manifest.bundleId ?? ""))) {
      throw new Error(`Unexpected runtime manifest: ${JSON.stringify(manifest)}`);
    }
    if (typeof manifest.launcher !== "string" || typeof manifest.entrypoint !== "string") {
      throw new Error(`Runtime manifest has no launcher or entrypoint: ${JSON.stringify(manifest)}`);
    }
    const launcher = join(runtimeRoot, manifest.launcher);
    const runtimeExecutable = join(runtimeRoot, "runtime", process.platform === "win32" ? "bun.exe" : "bun");
    const entrypoint = join(runtimeRoot, manifest.entrypoint);
    const runtimeCommand = [runtimeExecutable, entrypoint];
    const cliBundle = readFileSync(join(runtimeRoot, "app", "cli.js"), "utf8");
    const launcherText = readFileSync(launcher, "utf8");
    for (const forbidden of [sourceRoot, dirname(sourceBundle), "/private/tmp/codex-chatgpt-web-verify", "/tmp/codex-chatgpt-web-verify"]) {
      if (cliBundle.includes(forbidden) || launcherText.includes(forbidden)) {
        throw new Error(`Runtime artifact embeds an ephemeral build path: ${forbidden}`);
      }
    }

    const version = Bun.spawnSync([...runtimeCommand, "--version"], { stdout: "pipe", stderr: "pipe" });
    if (version.exitCode !== 0 || version.stdout.toString().trim() !== VERSION) {
      throw new Error(`Relocated launcher failed: ${version.stderr.toString()}`);
    }

    const appHome = join(root, "app-state");
    const codexHome = join(root, "codex");
    mkdirSync(join(appHome, "browser"), { recursive: true });
    mkdirSync(codexHome, { recursive: true });
    const portServer = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const port = portServer.port;
    portServer.stop();
    const config = {
      version: 3,
      releaseVersion: VERSION,
      mode: "browser-only",
      host: "127.0.0.1",
      port,
      contextWindow: 256_000,
      appName: "Codex Native",
      browserHost: "managed-chrome",
      chromeExecutablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      storageStatePath: join(appHome, "browser", "storage-state.json"),
      brokerSocketPath: defaultBrokerEndpoint(appHome),
      headed: true,
      proAvailable: true,
      autoApproveToolCalls: false,
      controlToken: "release-smoke-control-token-0123456789abcdef",
      runtimeCommand,
      acknowledgedUnofficialAt: new Date().toISOString(),
    };
    writeFileSync(join(appHome, "config.json"), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    writeFileSync(config.storageStatePath, "{}\n", { mode: 0o600 });

    const env = { ...process.env, CODEX_CHATGPT_WEB_HOME: appHome, CODEX_HOME: codexHome };
    child = Bun.spawn([...runtimeCommand, "serve"], { env, stdout: "pipe", stderr: "pipe" });
    childStdoutTail = captureStreamTail(child.stdout);
    childStderrTail = captureStreamTail(child.stderr);

    const healthDeadline = Date.now() + HEALTH_DEADLINE_MS;
    let healthPayload: Record<string, unknown> | undefined;
    let lastHealthFailure = "no response";
    while (Date.now() < healthDeadline) {
      try {
        const health = await fetchStage("healthz probe", `http://127.0.0.1:${port}/healthz`, undefined, true);
        if (health.response.ok) {
          healthPayload = health.body as Record<string, unknown>;
          break;
        }
        lastHealthFailure = `HTTP ${health.response.status}`;
      } catch (error) {
        lastHealthFailure = errorMessage(error);
      }
      await Bun.sleep(Math.min(50, Math.max(0, healthDeadline - Date.now())));
    }
    if (!healthPayload) {
      throw new Error(`healthz probe did not become healthy within ${HEALTH_DEADLINE_MS}ms; last=${lastHealthFailure}`);
    }
    if (healthPayload.service !== "codex-chatgpt-web" || healthPayload.mode !== "browser-only") {
      throw new Error(`healthz payload mismatch: ${JSON.stringify(healthPayload)}`);
    }

    const unauthenticatedModels = await fetchStage("unauthenticated models check", `http://127.0.0.1:${port}/v1/models`, undefined, true);
    const unauthenticatedModelsBody = unauthenticatedModels.body as { error?: { message?: string } };
    if (unauthenticatedModels.response.status !== 502
      || !unauthenticatedModelsBody.error?.message?.includes("incoming Bearer authorization")) {
      throw new Error(`native model passthrough did not fail closed without Codex auth: ${JSON.stringify(unauthenticatedModelsBody)}`);
    }

    const websocketNegotiation = await fetchStage("Responses WebSocket negotiation", `http://127.0.0.1:${port}/v1/responses`, undefined);
    if (websocketNegotiation.response.status !== 426) {
      throw new Error(`Responses WebSocket negotiation did not select Codex HTTP/SSE fallback: HTTP ${websocketNegotiation.response.status}`);
    }

    const invalid = await fetchStage("unsupported model rejection", `http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "chatgpt-web/not-enabled", input: "test", stream: false }),
    });
    if (invalid.response.status !== 400) throw new Error(`unsupported model did not fail closed: HTTP ${invalid.response.status}`);

    const unauthorizedDrain = await fetchStage("unauthorized drain rejection", `http://127.0.0.1:${port}/admin/drain`, {
      method: "POST",
      headers: { authorization: "Bearer wrong-release-smoke-token" },
    });
    if (unauthorizedDrain.response.status !== 401) throw new Error(`lifecycle control accepted an invalid token: HTTP ${unauthorizedDrain.response.status}`);

    const drain = await fetchStage("authenticated drain", `http://127.0.0.1:${port}/admin/drain`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.controlToken}` },
    }, true);
    const drainPayload = drain.body as Record<string, unknown>;
    if (!drain.response.ok || drainPayload.accepting_turns !== false
      || drainPayload.active_http_turns !== 0 || drainPayload.active_browser_turns !== 0) {
      throw new Error(`daemon did not acknowledge an idle authenticated drain: ${JSON.stringify(drainPayload)}`);
    }

    const rejectedWhileDraining = await fetchStage("draining turn rejection", `http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "chatgpt-web/high", reasoning: { effort: "high" }, input: "test", stream: false }),
    });
    if (rejectedWhileDraining.response.status !== 503) {
      throw new Error(`daemon accepted a new turn while draining: HTTP ${rejectedWhileDraining.response.status}`);
    }

    const resume = await fetchStage("authenticated resume", `http://127.0.0.1:${port}/admin/resume`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.controlToken}` },
    }, true);
    const resumePayload = resume.body as Record<string, unknown>;
    if (!resume.response.ok || resumePayload.accepting_turns !== true) {
      throw new Error(`daemon did not resume after the drain smoke: ${JSON.stringify(resumePayload)}`);
    }

    if (process.platform === "darwin") {
      const browser = Bun.spawnSync([...runtimeCommand, "browser", "check"], { env, stdout: "pipe", stderr: "pipe" });
      if (browser.exitCode !== 0) throw new Error(`relocated Playwright smoke failed: ${browser.stderr.toString()}`);
    }

    const finalDrain = await fetchStage("final authenticated drain", `http://127.0.0.1:${port}/admin/drain`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.controlToken}` },
    });
    if (!finalDrain.response.ok) throw new Error(`relocated daemon refused final drain: HTTP ${finalDrain.response.status}`);
    const shutdown = await fetchStage("authenticated shutdown", `http://127.0.0.1:${port}/admin/shutdown`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.controlToken}` },
    });
    if (!shutdown.response.ok) throw new Error(`relocated daemon refused graceful shutdown: HTTP ${shutdown.response.status}`);
    if (!await waitForChild(child, CHILD_GRACEFUL_TIMEOUT_MS)) {
      throw new Error(`relocated daemon did not exit after graceful shutdown within ${CHILD_GRACEFUL_TIMEOUT_MS}ms`);
    }
    gracefulShutdownObserved = true;
  } catch (error) {
    primaryError = error;
  } finally {
    if (child && !gracefulShutdownObserved) termination = await stopChild(child);
    const stdout = childStdoutTail ? await boundedDiagnosticTail(childStdoutTail) : "";
    const stderr = childStderrTail ? await boundedDiagnosticTail(childStderrTail) : "";
    if (primaryError && (stdout || stderr)) {
      primaryError = new Error(`${errorMessage(primaryError)}\n${childDiagnostics(stdout, stderr)}`);
    }
    try {
      rmSync(root, { recursive: true, force: true });
    } catch (error) {
      cleanupError = errorMessage(error);
    }
  }

  if (primaryError) {
    if (cleanupError) primaryError = new Error(`${errorMessage(primaryError)}\nsmoke temp cleanup failed: ${cleanupError}`);
    if (termination && !termination.exited) {
      primaryError = new Error(`${errorMessage(primaryError)}\nspawned runtime child did not exit after bounded force termination`);
    }
    throw primaryError;
  }
  if (cleanupError) throw new Error(`runtime smoke cleanup failed: ${cleanupError}`);
  if (termination && !termination.exited) {
    throw new Error("spawned runtime child did not exit after bounded force termination");
  }
  process.stdout.write("RELOCATABLE_RUNTIME_SMOKE_OK\n");
}

await main();
