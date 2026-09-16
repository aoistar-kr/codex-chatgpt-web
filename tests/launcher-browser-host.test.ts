import { afterEach, expect, spyOn, test } from "bun:test";
import { createServer } from "node:http";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LAUNCHER_BROWSER_HOST_KIND,
  LAUNCHER_BROWSER_IDLE_URL,
  LauncherRetainedConversationUnavailableError,
  LauncherBrowserTurnCancelledError,
  inspectLauncherBrowserHost,
  connectLauncherBrowserHost,
  notifyLauncherTurn,
  readLauncherBrowserHostDescriptor,
  releaseLauncherRetainedConversation,
  selectLauncherPage,
} from "../src/launcher-browser-host";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { chromium } from "playwright-core";

const roots: string[] = [];

test("late CDP readiness cannot start an attach after caller cancellation", async () => {
  const controller = new AbortController();
  const attach = spyOn(chromium, "connectOverCDP").mockImplementation(async () => { throw new Error("unexpected attach"); });
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation((async () => {
    controller.abort();
    return new Response(JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1:39110/devtools/browser/fixture" }));
  }) as unknown as typeof fetch);
  try {
    await expect(connectLauncherBrowserHost(descriptorFile(), 100, undefined, controller.signal)).rejects.toThrow("aborted");
    expect(attach).not.toHaveBeenCalled();
  } finally { fetchMock.mockRestore(); attach.mockRestore(); }
});

test("launcher heartbeat shares caller cancellation and pre-abort sends nothing", async () => {
  const controller = new AbortController();
  let observed: AbortSignal | null | undefined;
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation((async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    observed = init?.signal;
    return new Promise<Response>((_, reject) => {
      observed?.addEventListener("abort", () => reject(new Error("fixture fetch aborted")), { once: true });
    });
  }) as unknown as typeof fetch);
  try {
    await expect(notifyLauncherTurn("must-not-be-read", { phase: "heartbeat", traceId: "fixture", helperPid: process.pid }, 100, AbortSignal.abort()))
      .rejects.toThrow("aborted");
    expect(fetchMock).not.toHaveBeenCalled();
    const pending = notifyLauncherTurn(descriptorFile(), { phase: "heartbeat", traceId: "fixture", helperPid: process.pid, refreshViewport: true }, 1000, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow("aborted");
    expect(observed?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  } finally { fetchMock.mockRestore(); }
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function descriptorFile(
  controlEndpoint = "http://127.0.0.1:39111",
  profile: "production" | "development" = "production",
): string {
  const root = mkdtempSync(join(tmpdir(), "codex-launcher-descriptor-"));
  roots.push(root);
  const path = join(root, "launcher-browser.json");
  writeFileSync(path, `${JSON.stringify({
    version: 3,
    kind: LAUNCHER_BROWSER_HOST_KIND,
    profile,
    pid: process.pid,
    endpoint: "http://127.0.0.1:39110",
    control: {
      endpoint: controlEndpoint,
      token: "launcher-control-token-0123456789abcdefghijklmnop",
    },
    helper: {
      executable: process.execPath,
      script: import.meta.path,
    },
    partition: profile === "development"
      ? "persist:codex-web-gpt-dev-chatgpt"
      : "persist:codex-web-gpt-chatgpt",
    idleUrl: LAUNCHER_BROWSER_IDLE_URL,
    surfaceId: "launcher_surface_id_0123456789AB",
    surfaceTargets: { launcher_surface_id_0123456789AB: "target-owned" },
    createdAt: new Date().toISOString(),
  })}\n`, { mode: 0o600 });
  return path;
}

test("launcher descriptor is owner-only, loopback-only, and process-bound", () => {
  const path = descriptorFile();
  expect(readLauncherBrowserHostDescriptor(path)).toMatchObject({
    kind: LAUNCHER_BROWSER_HOST_KIND,
    profile: "production",
    pid: process.pid,
    endpoint: "http://127.0.0.1:39110",
    surfaceId: "launcher_surface_id_0123456789AB",
  });
  if (process.platform !== "win32") {
    chmodSync(path, 0o644);
    expect(() => readLauncherBrowserHostDescriptor(path)).toThrow("unsafe permissions");
  }
});

test("launcher turn control sends authenticated lifecycle events", async () => {
  let received: { authorization?: string; body?: unknown } = {};
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received = {
      authorization: request.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(request.url === "/v1/turn/start"
      ? '{"ok":true,"surfaceId":"launcher_surface_id_0123456789AB","reused":true,"connectorBound":true}\n'
      : request.url === "/v1/turn/stop"
        ? '{"ok":true,"stopped":true}\n'
      : request.url === "/v1/turn/end"
        ? '{"ok":true,"cancelledByUser":false}\n'
        : '{"ok":true}\n');
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");
    const path = descriptorFile(`http://127.0.0.1:${address.port}`);
    await expect(notifyLauncherTurn(path, {
      phase: "start",
      traceId: "abc123def456",
      helperPid: process.pid,
      conversationKey: "a".repeat(64),
      connectorIdentity: "Codex Native2",
      requireRetainedConversation: true,
    })).resolves.toEqual({
      surfaceId: "launcher_surface_id_0123456789AB",
      reused: true,
      connectorBound: true,
    });
    expect(received.authorization).toBe("Bearer launcher-control-token-0123456789abcdefghijklmnop");
    expect(received.body).toEqual({
      phase: "start",
      traceId: "abc123def456",
      helperPid: process.pid,
      conversationKey: "a".repeat(64),
      connectorIdentity: "Codex Native2",
      requireRetainedConversation: true,
    });
    await notifyLauncherTurn(path, {
      phase: "heartbeat",
      traceId: "abc123def456",
      helperPid: process.pid,
      refreshViewport: true,
    });
    expect(received.body).toEqual({
      phase: "heartbeat",
      traceId: "abc123def456",
      helperPid: process.pid,
      refreshViewport: true,
    });
    await expect(notifyLauncherTurn(path, {
      phase: "stop",
      traceId: "abc123def456",
      helperPid: process.pid,
    })).resolves.toEqual({ stopped: true });
    expect(received.body).toEqual({
      phase: "stop",
      traceId: "abc123def456",
      helperPid: process.pid,
    });
    await expect(notifyLauncherTurn(path, {
      phase: "end",
      traceId: "abc123def456",
      helperPid: process.pid,
      status: "completed",
      retain: true,
      connectorBound: true,
    })).resolves.toEqual({ cancelledByUser: false });
    expect(received.body).toEqual({
      phase: "end",
      traceId: "abc123def456",
      helperPid: process.pid,
      status: "completed",
      retain: true,
      connectorBound: true,
    });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("launcher turn control exposes a proven hot-surface effort prewarm only when the launcher reports it", async () => {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    expect(body.modelId).toBe("gpt-5.6-sol");
    expect(body.reasoning).toBe("medium");
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true,"surfaceId":"launcher_surface_id_0123456789AB","reused":false,"connectorBound":false,"effortPrepared":true}\n');
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");
    const path = descriptorFile(`http://127.0.0.1:${address.port}`);
    await expect(notifyLauncherTurn(path, {
      phase: "start",
      traceId: "prewarm123456",
      helperPid: process.pid,
      modelId: "gpt-5.6-sol",
      reasoning: "medium",
    })).resolves.toEqual({
      surfaceId: "launcher_surface_id_0123456789AB",
      reused: false,
      connectorBound: false,
      effortPrepared: true,
    });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("launcher retained-conversation release uses its authenticated exact-key endpoint", async () => {
  let received: { url?: string; authorization?: string; body?: unknown } = {};
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received = {
      url: request.url,
      authorization: request.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    };
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true,"released":1}\n');
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");
    const path = descriptorFile(`http://127.0.0.1:${address.port}`);
    await expect(releaseLauncherRetainedConversation(path, "b".repeat(64))).resolves.toBe(1);
    expect(received).toEqual({
      url: "/v1/turn/release",
      authorization: "Bearer launcher-control-token-0123456789abcdefghijklmnop",
      body: { conversationKey: "b".repeat(64) },
    });
    await expect(releaseLauncherRetainedConversation(path, "not-a-key"))
      .rejects.toThrow("retained conversation key is invalid");
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("launcher turn control preserves explicit user cancellation as a terminal signal", async () => {
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain request */ }
    response.writeHead(409, { "content-type": "application/json" });
    response.end('{"error":"turn closed by user","code":"turn_cancelled"}\n');
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");
    const path = descriptorFile(`http://127.0.0.1:${address.port}`);
    const error = await notifyLauncherTurn(path, {
      phase: "start",
      traceId: "cancelled123",
      helperPid: process.pid,
    }).catch(cause => cause);
    expect(error).toBeInstanceOf(LauncherBrowserTurnCancelledError);
    expect((error as Error).message).toBe("turn closed by user");
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("launcher turn control preserves a missing retained conversation as a typed signal", async () => {
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain request */ }
    response.writeHead(409, { "content-type": "application/json" });
    response.end('{"error":"retained source missing","code":"retained_conversation_unavailable"}\n');
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");
    const path = descriptorFile(`http://127.0.0.1:${address.port}`);
    const error = await notifyLauncherTurn(path, {
      phase: "start",
      traceId: "missing123456",
      helperPid: process.pid,
      conversationKey: "a".repeat(64),
      requireRetainedConversation: true,
    }).catch(caught => caught);
    expect(error).toBeInstanceOf(LauncherRetainedConversationUnavailableError);
    expect(error.message).toContain("retained source missing");
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("launcher session verification uses the authenticated control channel instead of Bun CDP", async () => {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    expect(request.url).toBe("/v1/session/inspect");
    expect(request.headers.authorization).toBe("Bearer launcher-control-token-0123456789abcdefghijklmnop");
    expect(JSON.parse(Buffer.concat(chunks).toString("utf8"))).toEqual({ detectCapabilities: true });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      authenticated: true,
      temporary: true,
      solAvailable: true,
      proAvailable: true,
      url: "https://chatgpt.com/?temporary-chat=true",
    }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");
    const path = descriptorFile(`http://127.0.0.1:${address.port}`);
    expect(await inspectLauncherBrowserHost(path, { detectCapabilities: true })).toEqual({
      solAvailable: true,
      proAvailable: true,
      url: "https://chatgpt.com/?temporary-chat=true",
    });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("launcher session verification reports its own deadline instead of a generic abort", async () => {
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume request */ }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 30));
    if (!response.destroyed) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end('{"error":"late"}\n');
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");
    const path = descriptorFile(`http://127.0.0.1:${address.port}`);
    await expect(inspectLauncherBrowserHost(path, { detectCapabilities: true, timeoutMs: 5 }))
      .rejects.toThrow("session inspection timed out after 5ms");
  } finally {
    await new Promise<void>(resolveClose => server.close(() => resolveClose()));
  }
});

test("launcher descriptor rejects non-loopback browser ownership", () => {
  const path = descriptorFile();
  const value = JSON.parse(readFileSync(path, "utf8"));
  value.endpoint = "https://example.com:443";
  writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  expect(() => readLauncherBrowserHostDescriptor(path)).toThrow("http://127.0.0.1");
});

test("launcher profile checks reject cross-profile browser ownership", async () => {
  const path = descriptorFile("http://127.0.0.1:39111", "development");
  expect(readLauncherBrowserHostDescriptor(path)).toMatchObject({
    profile: "development",
    partition: "persist:codex-web-gpt-dev-chatgpt",
  });
  await expect(inspectLauncherBrowserHost(path, { expectedProfile: "production", timeoutMs: 5 }))
    .rejects.toThrow("belongs to development");
});

test("launcher page selection uses the native target map instead of renderer evaluation or URL order", async () => {
  const descriptor = readLauncherBrowserHostDescriptor(descriptorFile());
  const hiddenPage = { url: () => "https://chatgpt.com/?temporary-chat=true" } as unknown as Page;
  const ownedPage = { url: () => LAUNCHER_BROWSER_IDLE_URL } as unknown as Page;
  const sessions = new Map<Page, string>([[hiddenPage, "target-hidden"], [ownedPage, "target-owned"]]);
  const context = {
    pages: () => [hiddenPage, ownedPage],
    newCDPSession: async (page: Page) => ({
      send: async (method: string) => {
        expect(method).toBe("Target.getTargetInfo");
        return { targetInfo: { targetId: sessions.get(page)! } };
      },
      detach: async () => {},
    }),
  } as unknown as BrowserContext;
  const browser = { contexts: () => [context] } as unknown as Browser;

  expect(await selectLauncherPage(browser, descriptor, 20)).toEqual({ context, page: ownedPage });
});

test("launcher page selection rejects duplicated native target ownership", async () => {
  const descriptor = readLauncherBrowserHostDescriptor(descriptorFile());
  const page = () => ({}) as unknown as Page;
  const pages = [page(), page()];
  const context = {
    pages: () => pages,
    newCDPSession: async () => ({
      send: async () => ({ targetInfo: { targetId: "target-owned" } }),
      detach: async () => {},
    }),
  } as unknown as BrowserContext;
  const browser = { contexts: () => [context] } as unknown as Browser;

  expect(selectLauncherPage(browser, descriptor, 20)).rejects.toThrow(
    "2 surfaces with the same native target",
  );
});

test("launcher page selection stops immediately when acquisition is aborted", async () => {
  const descriptor = readLauncherBrowserHostDescriptor(descriptorFile());
  const browser = {
    contexts: () => [],
  } as unknown as Browser;
  const controller = new AbortController();
  controller.abort();

  expect(selectLauncherPage(
    browser,
    descriptor,
    60_000,
    descriptor.surfaceId,
    controller.signal,
  )).rejects.toMatchObject({ name: "AbortError" });
});
