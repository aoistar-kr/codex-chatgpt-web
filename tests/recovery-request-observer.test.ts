import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { Page } from "playwright-core";
import {
  ChatGptRecoveryBrowserWideRequestObserver,
  ChatGptRecoveryRequestObserver,
  recoveryRequestCountsAgree,
} from "../src/adapters/chatgpt-web/recovery-request-observer";

async function fixture(action: (observer: ChatGptRecoveryRequestObserver, session: any) => Promise<void>, duration = 5_000) {
  const session = Object.assign(new EventEmitter(), {
    commands: [] as string[],
    fail: "",
    send: async (method: string) => {
      session.commands.push(method);
      if (session.fail === method) throw new Error("fixture connection unavailable");
      return {};
    },
    detach: async () => { session.emit("close"); },
  });
  const page = { url: () => "https://chatgpt.com/?temporary-chat=true", context: () => ({ newCDPSession: async () => session }) } as unknown as Page;
  const observer = await ChatGptRecoveryRequestObserver.install(page, Date.now() + duration);
  try { await action(observer, session); }
  finally { await observer.close(); }
}

const request = (requestId = "private-id", url = "https://chatgpt.com/backend-api/f/conversation", method = "POST") => ({
  requestId, request: { url, method, postData: "private prompt", headers: { Authorization: "private token" } },
});

test("independent request diagnostic observes exact POST events without reading or changing bodies", async () => {
  await fixture(async (observer, session) => {
    session.emit("Network.requestWillBeSent", request());
    session.emit("Network.requestWillBeSent", request("second"));
    const metric = await observer.snapshot();
    expect(metric).toMatchObject({ available: true, continuous: true, conversationPostEvents: 2, distinctRequestIds: 2 });
    expect(session.commands).toEqual(["Page.enable", "Network.enable", "Page.getFrameTree"]);
    expect(JSON.stringify(metric)).not.toMatch(/private|Authorization|https:/);
  });
});

test("request diagnostic filters origin method and exact path", async () => {
  await fixture(async (observer, session) => {
    for (const url of ["https://example.com/backend-api/conversation", "http://chatgpt.com/backend-api/conversation", "https://chatgpt.com/backend-api/conversation/", "https://chatgpt.com/backend-api/conversation/extra"]) session.emit("Network.requestWillBeSent", request("irrelevant", url));
    session.emit("Network.requestWillBeSent", request("get", undefined, "GET"));
    session.emit("Network.requestWillBeSent", request("xhr", "https://chatgpt.com/backend-api/conversation"));
    expect(await observer.snapshot()).toMatchObject({ conversationPostEvents: 1, distinctRequestIds: 1, continuous: true });
  });
});

test("redirect POST events are not deduplicated by reused request IDs", async () => {
  await fixture(async (observer, session) => {
    session.emit("Network.requestWillBeSent", request());
    session.emit("Network.requestWillBeSent", { ...request(), redirectResponse: { status: 307 } });
    expect(await observer.snapshot()).toMatchObject({ conversationPostEvents: 2, distinctRequestIds: 1, redirectEvents: 1 });
  });
});

test("disconnect or failed session barrier invalidates continuous coverage", async () => {
  for (const event of ["close", "barrier"]) await fixture(async (observer, session) => {
    session.emit("Network.requestWillBeSent", request());
    if (event === "close") session.emit("close"); else session.fail = "Page.getFrameTree";
    expect(await observer.snapshot()).toMatchObject({ available: false, continuous: false, conversationPostEvents: 1 });
  });
});

test("main-document or same-document navigation invalidates coverage, unlike subframe navigation", async () => {
  await fixture(async (observer, session) => {
    session.emit("Page.frameNavigated", { frame: { parentId: "parent" } });
    expect((await observer.snapshot()).continuous).toBe(true);
    session.emit("Page.frameNavigated", { frame: {} });
    expect(await observer.snapshot()).toMatchObject({ continuous: false, navigationObserved: true });
  });
  await fixture(async (observer, session) => {
    session.emit("Page.navigatedWithinDocument", {});
    expect((await observer.snapshot()).continuous).toBe(false);
  });
});

test("malformed events and saturation cannot claim exact continuous counts", async () => {
  await fixture(async (observer, session) => {
    session.emit("Network.requestWillBeSent", request(""));
    expect(await observer.snapshot()).toMatchObject({ malformedEvents: 1, continuous: false });
  });
  await fixture(async (observer, session) => {
    for (let index = 0; index < 1_005; index++) session.emit("Network.requestWillBeSent", request(String(index)));
    expect(await observer.snapshot()).toMatchObject({ conversationPostEvents: 1_000, distinctRequestIds: 1_000, saturated: true, continuous: false });
  });
});

test("expiry and cleanup remove listeners and cannot publish a current receipt", async () => {
  await fixture(async (observer, session) => {
    await Bun.sleep(40);
    expect(await observer.snapshot()).toMatchObject({ available: false, continuous: false, expired: true });
    expect(session.listenerCount("Network.requestWillBeSent")).toBe(0);
    await observer.close();
  }, 20);
});

test("request agreement requires both live exact counts, never absence of evidence", async () => {
  await fixture(async (observer, session) => {
    session.emit("Network.requestWillBeSent", request());
    const cdp = await observer.snapshot();
    const fetch = { available: true, wrapperCurrent: true, conversationPostAttempts: 1, saturated: false };
    expect(recoveryRequestCountsAgree(cdp, fetch)).toBe(true);
    expect(recoveryRequestCountsAgree(undefined, fetch)).toBe(false);
    for (const change of [{ available: false }, { continuous: false }, { expired: true }, { navigationObserved: true },
      { conversationPostEvents: 0 }, { conversationPostEvents: 2 }, { distinctRequestIds: 0 }, { redirectEvents: 1 },
      { malformedEvents: 1 }, { saturated: true }]) expect(recoveryRequestCountsAgree({ ...cdp, ...change }, fetch)).toBe(false);
    for (const change of [{ available: false }, { wrapperCurrent: false }, { conversationPostAttempts: 0 },
      { conversationPostAttempts: 2 }, { saturated: true }, { saturated: undefined }]) {
      expect(recoveryRequestCountsAgree(cdp, { ...fetch, ...change })).toBe(false);
    }
    await observer.close();
    expect(recoveryRequestCountsAgree(await observer.snapshot(), fetch)).toBe(false);
  });
});

test("page-generated stream-status traffic proves only a content-free exact conversation binding", async () => {
  await fixture(async (observer, session) => {
    session.emit("Network.requestWillBeSent", request("status-1", "https://chatgpt.com/backend-api/conversation/expected-id/stream_status", "GET"));
    session.emit("Network.requestWillBeSent", request("status-2", "https://chatgpt.com/backend-api/conversation/expected-id/stream_status", "GET"));
    session.emit("Network.responseReceived", { requestId: "status-1", response: {
      url: "https://chatgpt.com/backend-api/conversation/expected-id/stream_status", status: 200,
    } });
    session.emit("Network.responseReceived", { requestId: "status-2", response: {
      url: "https://chatgpt.com/backend-api/conversation/expected-id/stream_status", status: 200,
    } });
    const exact = await observer.conversationBinding("expected-id");
    expect(exact).toEqual({
      available: true, streamStatusEvents: 2, exactConversationEvents: 2, otherConversationEvents: 0,
      distinctConversationIds: 1, malformedStreamStatusEvents: 0,
      exactSuccessfulResponses: 2, exactNonSuccessfulResponses: 0, otherConversationResponses: 0,
      malformedStreamStatusResponses: 0, exact: true,
    });
    expect(JSON.stringify(exact)).not.toContain("expected-id");
    session.emit("Network.requestWillBeSent", request("status-3", "https://chatgpt.com/backend-api/conversation/other-id/stream_status", "GET"));
    session.emit("Network.responseReceived", { requestId: "status-3", response: {
      url: "https://chatgpt.com/backend-api/conversation/other-id/stream_status", status: 200,
    } });
    expect(await observer.conversationBinding("expected-id")).toMatchObject({
      streamStatusEvents: 3, exactConversationEvents: 2, otherConversationEvents: 1,
      distinctConversationIds: 2, otherConversationResponses: 1, exact: false,
    });
  });
});

test("stream-status binding rejects missing non-successful and malformed server responses", async () => {
  await fixture(async (observer, session) => {
    session.emit("Network.requestWillBeSent", request("missing-response", "https://chatgpt.com/backend-api/conversation/expected-id/stream_status", "GET"));
    expect((await observer.conversationBinding("expected-id")).exact).toBeFalse();
    session.emit("Network.responseReceived", { requestId: "missing-response", response: {
      url: "https://chatgpt.com/backend-api/conversation/expected-id/stream_status", status: 404,
    } });
    expect(await observer.conversationBinding("expected-id")).toMatchObject({ exactNonSuccessfulResponses: 1, exact: false });
  });
  await fixture(async (observer, session) => {
    session.emit("Network.requestWillBeSent", request("malformed-response", "https://chatgpt.com/backend-api/conversation/expected-id/stream_status", "GET"));
    session.emit("Network.responseReceived", { requestId: "malformed-response", response: {
      url: "https://chatgpt.com/backend-api/conversation/other-id/stream_status", status: 200,
    } });
    expect(await observer.conversationBinding("expected-id")).toMatchObject({ malformedStreamStatusResponses: 1, exact: false });
  });
});

async function browserWideFixture(action: (value: {
  observer: ChatGptRecoveryBrowserWideRequestObserver;
  browser: any;
  context: any;
  emitPost(redirected?: boolean): void;
}) => Promise<void>) {
  const context = new EventEmitter() as any;
  let contexts: any[] = [context];
  let connected = true;
  const browser = Object.assign(new EventEmitter(), {
    isConnected: () => connected,
    contexts: () => contexts,
    setContexts: (value: any[]) => { contexts = value; },
    disconnect: () => { connected = false; browser.emit("disconnected"); },
  }) as any;
  const page = { url: () => "https://chatgpt.com/?temporary-chat=true" } as unknown as Page;
  const observer = await ChatGptRecoveryBrowserWideRequestObserver.install(
    browser, context, page, Date.now() + 5_000,
  );
  const emitPost = (redirected = false) => context.emit("request", {
    url: () => "https://chatgpt.com/backend-api/conversation",
    method: () => "POST",
    redirectedFrom: () => redirected ? {} : null,
    postData: () => "private prompt",
    headers: () => ({ Authorization: "private token" }),
  });
  try { await action({ observer, browser, context, emitPost }); }
  finally { await observer.close(); }
}

test("launcher-context observer is browser-wide only with one independently connected context", async () => {
  await browserWideFixture(async ({ observer, browser, context, emitPost }) => {
    emitPost();
    const exact = observer.snapshot();
    expect(exact).toEqual({
      scope: "independent-launcher-browser-context", available: true, browserWide: true, expired: false,
      browserContextCount: 1, conversationPostEvents: 1, redirectEvents: 0, malformedEvents: 0,
      saturated: false, exact: true,
    });
    expect(JSON.stringify(exact)).not.toMatch(/private|Authorization|https:/);
    browser.setContexts([context, new EventEmitter()]);
    expect(observer.snapshot()).toMatchObject({ browserWide: false, browserContextCount: 2, exact: false });
  });
});

test("launcher browser-wide duplicate redirect and disconnect receipts fail closed", async () => {
  await browserWideFixture(async ({ observer, browser, emitPost }) => {
    emitPost();
    emitPost();
    expect(observer.snapshot()).toMatchObject({ conversationPostEvents: 2, exact: false });
    browser.disconnect();
    expect(observer.snapshot()).toMatchObject({ available: false, browserWide: false, exact: false });
  });
  await browserWideFixture(async ({ observer, emitPost }) => {
    emitPost(true);
    expect(observer.snapshot()).toMatchObject({ conversationPostEvents: 1, redirectEvents: 1, exact: false });
  });
});
