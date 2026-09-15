import { expect, test } from "bun:test";
import type { Page } from "playwright-core";
import { ChatGptWebStreamTap } from "../src/adapters/chatgpt-web/web-stream/network-observer";

async function fixture(enabled: boolean, action: (value: {
  tap: ChatGptWebStreamTap; page: Page; root: any; calls: Array<[unknown, unknown]>; failNext(): void;
}) => Promise<void>) {
  const key = "CODEX_CHATGPT_WEB_COMPLETED_REBIND_DIAGNOSTICS";
  const recoveryKey = "CODEX_CHATGPT_WEB_INCOMPLETE_CAPTURE_RECOVERY";
  const previousFlag = process.env[key];
  const previousRecoveryFlag = process.env[recoveryKey];
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  const calls: Array<[unknown, unknown]> = [];
  let rejectNext = false;
  const root: any = { fetch: async (input: unknown, init: unknown) => {
    calls.push([input, init]);
    if (rejectNext) { rejectNext = false; throw new Error("fixture network rejection"); }
    return new Response("untouched response", { headers: { "content-type": "text/plain" } });
  } };
  Object.defineProperty(globalThis, "window", { configurable: true, value: root });
  Object.defineProperty(globalThis, "location", { configurable: true, value: { origin: "https://chatgpt.com" } });
  process.env[key] = enabled ? "1" : "0";
  process.env[recoveryKey] = "0";
  const page = {
    url: () => "https://chatgpt.com/?temporary-chat=true",
    exposeFunction: async (name: string, fn: unknown) => { root[name] = fn; },
    removeExposedFunction: async (name: string) => { delete root[name]; },
    evaluate: async (fn: Function, arg: unknown) => fn(arg),
    context: () => ({ newCDPSession: async () => { throw new Error("no CDP in fixture"); } }),
    isClosed: () => false,
  } as unknown as Page;
  let tap: ChatGptWebStreamTap | undefined;
  try {
    tap = await ChatGptWebStreamTap.install(page, "diagnostic-fixture");
    await action({ tap, page, root, calls, failNext: () => { rejectNext = true; } });
  } finally {
    await tap?.close();
    if (previousFlag === undefined) delete process.env[key]; else process.env[key] = previousFlag;
    if (previousRecoveryFlag === undefined) delete process.env[recoveryKey]; else process.env[recoveryKey] = previousRecoveryFlag;
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow); else Reflect.deleteProperty(globalThis, "window");
    if (previousLocation) Object.defineProperty(globalThis, "location", previousLocation); else Reflect.deleteProperty(globalThis, "location");
  }
}

test("default recovery enables the same content-free fetch counter without completed-rebind diagnostics", async () => {
  const completedKey = "CODEX_CHATGPT_WEB_COMPLETED_REBIND_DIAGNOSTICS";
  const recoveryKey = "CODEX_CHATGPT_WEB_INCOMPLETE_CAPTURE_RECOVERY";
  const previousCompleted = process.env[completedKey];
  const previousRecovery = process.env[recoveryKey];
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  const root: any = { fetch: async () => new Response("ok", { headers: { "content-type": "text/plain" } }) };
  Object.defineProperty(globalThis, "window", { configurable: true, value: root });
  Object.defineProperty(globalThis, "location", { configurable: true, value: { origin: "https://chatgpt.com" } });
  process.env[completedKey] = "0";
  delete process.env[recoveryKey];
  const page = {
    url: () => "https://chatgpt.com/?temporary-chat=true",
    exposeFunction: async (name: string, fn: unknown) => { root[name] = fn; },
    removeExposedFunction: async (name: string) => { delete root[name]; },
    evaluate: async (fn: Function, arg: unknown) => fn(arg),
    context: () => ({ newCDPSession: async () => { throw new Error("no CDP in fixture"); } }),
    isClosed: () => false,
  } as unknown as Page;
  let tap: ChatGptWebStreamTap | undefined;
  try {
    tap = await ChatGptWebStreamTap.install(page, "recovery-diagnostic-fixture");
    await root.fetch("/backend-api/conversation", { method: "POST" });
    expect(await tap.readFetchSubmissionDiagnostic()).toEqual({
      available: true, wrapperCurrent: true, conversationPostAttempts: 1, saturated: false,
    });
  } finally {
    await tap?.close();
    if (previousCompleted === undefined) delete process.env[completedKey]; else process.env[completedKey] = previousCompleted;
    if (previousRecovery === undefined) delete process.env[recoveryKey]; else process.env[recoveryKey] = previousRecovery;
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow); else Reflect.deleteProperty(globalThis, "window");
    if (previousLocation) Object.defineProperty(globalThis, "location", previousLocation); else Reflect.deleteProperty(globalThis, "location");
  }
});

test("fetch submission diagnostic is absent when completed diagnostics and recovery are explicitly disabled", async () => {
  await fixture(false, async ({ tap, root }) => {
    const response = await root.fetch("/backend-api/conversation", { method: "POST" });
    expect(await response.text()).toBe("untouched response");
    expect(await tap.readFetchSubmissionDiagnostic()).toEqual({ available: false });
    expect(root.__codexWebStreamTap.requestDiagnostic).toBeUndefined();
  });
});

test("opt-in counts failed and non-SSE conversation fetch attempts without replay or request changes", async () => {
  await fixture(true, async ({ tap, root, calls, failNext }) => {
    expect(await tap.readFetchSubmissionDiagnostic()).toEqual({ available: true, wrapperCurrent: true, conversationPostAttempts: 0, saturated: false });
    const input = new URL("https://chatgpt.com/backend-api/f/conversation");
    const init = { method: "post", body: "private fixture prompt" };
    const response = await root.fetch(input, init);
    expect(await response.text()).toBe("untouched response");
    expect(calls[0]![0]).toBe(input);
    expect(calls[0]![1]).toBe(init);
    failNext();
    await expect(root.fetch("/backend-api/conversation", { method: "POST" })).rejects.toThrow("fixture network rejection");
    expect(calls).toHaveLength(2);
    const diagnostic = await tap.readFetchSubmissionDiagnostic();
    expect(diagnostic).toEqual({ available: true, wrapperCurrent: true, conversationPostAttempts: 2, saturated: false });
    expect(JSON.stringify(diagnostic)).not.toContain("private");
    expect(JSON.stringify(diagnostic)).not.toContain("https:");
  });
});

test("fetch diagnostic filters exact origin path and effective POST method", async () => {
  await fixture(true, async ({ tap, root }) => {
    for (const input of ["https://example.com/backend-api/conversation", "/backend-api/conversation/extra", "/backend-api/conversation/", "/backend-api/conversation-history"]) {
      await root.fetch(input, { method: "POST" });
    }
    await root.fetch("/backend-api/conversation");
    await root.fetch(new Request("https://chatgpt.com/backend-api/conversation", { method: "POST" }), { method: "GET" });
    await root.fetch(new Request("https://chatgpt.com/backend-api/conversation", { method: "POST" }));
    expect(await tap.readFetchSubmissionDiagnostic()).toMatchObject({ conversationPostAttempts: 1 });
  });
});

test("fresh same-document diagnostic reports replacement or missing wrapper without claiming coverage", async () => {
  await fixture(true, async ({ tap, page, root }) => {
    await root.fetch("/backend-api/conversation", { method: "POST" });
    expect(await tap.readFetchSubmissionDiagnostic(page)).toMatchObject({ available: true, wrapperCurrent: true, conversationPostAttempts: 1 });
    root.fetch = async () => new Response("replacement");
    expect(await tap.readFetchSubmissionDiagnostic(page)).toMatchObject({ available: true, wrapperCurrent: false });
    root.__codexWebStreamTap.token = "different-document-token";
    expect(await tap.readFetchSubmissionDiagnostic(page)).toEqual({ available: false });
    delete root.__codexWebStreamTap;
    expect(await tap.readFetchSubmissionDiagnostic(page)).toEqual({ available: false });
    await tap.close();
    expect(await tap.readFetchSubmissionDiagnostic(page)).toEqual({ available: false });
  });
});

test("fetch counter saturates explicitly rather than falsely reporting an exact large count", async () => {
  await fixture(true, async ({ tap, root }) => {
    for (let i = 0; i < 1_005; i++) await root.fetch("/backend-api/conversation", { method: "POST" });
    expect(await tap.readFetchSubmissionDiagnostic()).toMatchObject({ conversationPostAttempts: 1_000, saturated: true });
  });
});
