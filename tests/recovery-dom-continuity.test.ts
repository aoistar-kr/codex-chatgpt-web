import { expect, spyOn, test } from "bun:test";
import { startChatGptRecoveryDomContinuity, finishChatGptRecoveryDomContinuity } from "../src/adapters/chatgpt-web/recovery-dom-continuity";

// MutationObserver/DOM fixture, not a real browser or server-conversation proof.
async function withDom(action: (f: ReturnType<typeof fixture>) => void | Promise<void>) {
  const domDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  const observerDescriptor = Object.getOwnPropertyDescriptor(globalThis, "MutationObserver");
  const f = fixture();
  Object.defineProperty(globalThis, "document", { configurable: true, value: f.root });
  Object.defineProperty(globalThis, "MutationObserver", { configurable: true, value: f.Observer });
  try { await action(f); }
  finally {
    finishChatGptRecoveryDomContinuity("fixture-private-token");
    if (domDescriptor) Object.defineProperty(globalThis, "document", domDescriptor); else Reflect.deleteProperty(globalThis, "document");
    if (observerDescriptor) Object.defineProperty(globalThis, "MutationObserver", observerDescriptor); else Reflect.deleteProperty(globalThis, "MutationObserver");
  }
}

function fixture() {
  const element = (identity = true) => ({ nodeType: 1, identity, matches() { return this.identity; }, querySelector: () => null });
  const assistant = element(), message = element(), user = element();
  const listeners = new Map<string, () => void>();
  const view = { __CODEX_WEB_GPT_TURN_OBSERVER__: { id: "fixture-private-document" }, location: { href: "https://fixture.test/" },
    addEventListener: (name: string, listener: () => void) => listeners.set(name, listener),
    removeEventListener: (name: string) => listeners.delete(name) };
  const root = { defaultView: view, documentElement: element(false), querySelectorAll: () => [assistant, message, user] };
  let callback: ((records: MutationRecord[]) => void) | undefined;
  let records: MutationRecord[] = [];
  let disconnected = false;
  let observedOptions: MutationObserverInit | undefined;
  class Observer {
    constructor(fn: (records: MutationRecord[]) => void) { callback = fn; }
    observe(_node: unknown, options: MutationObserverInit) { observedOptions = options; }
    takeRecords() { const queued = records; records = []; return queued; }
    disconnect() { disconnected = true; }
  }
  const record = (changes: Record<string, unknown>) => ({ type: "attributes", target: message,
    attributeName: "data-message-id", oldValue: "fixture-private-A", addedNodes: [], removedNodes: [], ...changes }) as unknown as MutationRecord;
  return { root, view, Observer, assistant, message, user, element, record, listeners,
    start: (deadline = Date.now() + 10_000) => startChatGptRecoveryDomContinuity({ token: "fixture-private-token",
      documentId: "fixture-private-document", deadline, userSelector: "users", assistantSelector: "assistants" }),
    finish: () => finishChatGptRecoveryDomContinuity("fixture-private-token"),
    emit: (...values: MutationRecord[]) => callback!(values), queue: (...values: MutationRecord[]) => { records.push(...values); },
    disconnected: () => disconnected, observedOptions: () => observedOptions,
  };
}

test("clean completed DOM interval returns only content-free continuity and cleans up", () => withDom(f => {
  expect(f.start()).toBeTrue();
  expect(f.observedOptions()).toMatchObject({ subtree: true, childList: true, attributeOldValue: true });
  const result = f.finish();
  expect(result).toEqual({ available: true, sameDocument: true, expired: false, identityMutationRecords: 0, unchanged: true });
  expect(JSON.stringify(result)).not.toContain("private");
  expect(f.disconnected()).toBeTrue();
  expect(f.listeners.size).toBe(0);
  expect(f.finish().available).toBeFalse();
}));

test("identity A to B to A is rejected even when records are still pending at the final read", () => withDom(f => {
  f.start();
  f.queue(f.record({ oldValue: "fixture-A" }), f.record({ oldValue: "fixture-B" }));
  expect(f.finish()).toMatchObject({ sameDocument: true, identityMutationRecords: 2, unchanged: false });
}));

test("same-ID remount and remove-reinsert of the original node cannot pass continuity", async () => {
  for (const sameNode of [false, true]) await withDom(f => {
    f.start();
    const replacement = sameNode ? f.assistant : f.element();
    f.assistant.identity = false; // Original node remains tracked even after its attributes vanish.
    f.emit(f.record({ type: "childList", target: f.root.documentElement, removedNodes: [f.assistant], addedNodes: [replacement] }));
    expect(f.finish().unchanged).toBeFalse();
  });
});

test("identity appearance elsewhere in the document is a continuity conflict", () => withDom(f => {
  f.start();
  f.emit(f.record({ type: "childList", target: f.root.documentElement, addedNodes: [f.element()] }));
  expect(f.finish().identityMutationRecords).toBe(1);
}));

test("unrelated UI node churn does not assert an identity mutation", () => withDom(f => {
  f.start();
  f.emit(f.record({ attributeName: "data-testid", target: f.element(false), oldValue: "unrelated-ui" }),
    f.record({ type: "childList", target: f.root.documentElement, addedNodes: [f.element(false)] }));
  expect(f.finish().unchanged).toBeTrue();
}));

test("a stripped turn identity is recognized by oldValue even for a newly added node", () => withDom(f => {
  f.start();
  f.emit(f.record({ target: f.element(false), attributeName: "data-testid", oldValue: "conversation-turn-before" }));
  expect(f.finish().unchanged).toBeFalse();
}));

test("wrong token cannot consume another observer and duplicate installation fails closed", () => withDom(f => {
  f.start();
  expect(f.start()).toBeFalse();
  expect(finishChatGptRecoveryDomContinuity("other-private-token").available).toBeFalse();
  expect(f.finish().unchanged).toBeTrue();
}));

test("document replacement and observed navigation invalidate unchanged identity endpoints", async () => {
  await withDom(f => {
    f.start(); f.view.__CODEX_WEB_GPT_TURN_OBSERVER__.id = "other-document";
    expect(f.finish()).toMatchObject({ sameDocument: false, unchanged: false });
  });
  for (const name of ["pagehide", "popstate", "hashchange"]) await withDom(f => {
    f.start(); f.listeners.get(name)!();
    expect(f.finish().unchanged).toBeFalse();
  });
});

test("expired initial or final absolute deadline cannot prove continuity", () => withDom(f => {
  expect(f.start(Date.now() - 1)).toBeFalse();
  expect(f.start(NaN)).toBeFalse();
  expect(f.start(Infinity)).toBeFalse();
  const now = Date.now();
  f.start(now + 5_000);
  const clock = spyOn(Date, "now").mockReturnValue(now + 5_001);
  try { expect(f.finish()).toMatchObject({ expired: true, unchanged: false }); }
  finally { clock.mockRestore(); }
}));

test("the local fifteen-second cap is absolute even if its timer has not fired", () => withDom(f => {
  const now = Date.now();
  f.start(now + 60_000);
  const clock = spyOn(Date, "now").mockReturnValue(now + 15_001);
  try { expect(f.finish()).toMatchObject({ expired: true, unchanged: false }); }
  finally { clock.mockRestore(); }
}));

test("a final URL change without a navigation event is not document continuity", () => withDom(f => {
  f.start();
  f.view.location.href = "https://fixture.test/other";
  expect(f.finish()).toMatchObject({ sameDocument: false, unchanged: false });
}));

test("orphaned observer expires locally and leaves only a negative receipt", () => withDom(async f => {
  f.start(Date.now() + 20);
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(f.disconnected()).toBeTrue();
  expect(f.listeners.size).toBe(0);
  expect(f.finish()).toMatchObject({ available: true, expired: true, unchanged: false });
}));
