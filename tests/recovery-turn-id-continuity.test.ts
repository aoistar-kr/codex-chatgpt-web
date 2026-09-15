import { expect, test } from "bun:test";
import { finishChatGptRecoveryTurnIdMutationContinuity, startChatGptRecoveryTurnIdMutationContinuity } from "../src/adapters/chatgpt-web/recovery-turn-id-continuity";

async function withFixture(action: (fixture: ReturnType<typeof makeFixture>) => void | Promise<void>) {
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  const observerDescriptor = Object.getOwnPropertyDescriptor(globalThis, "MutationObserver");
  const fixture = makeFixture();
  Object.defineProperty(globalThis, "document", { configurable: true, value: fixture.root });
  Object.defineProperty(globalThis, "MutationObserver", { configurable: true, value: fixture.Observer });
  try { await action(fixture); }
  finally {
    finishChatGptRecoveryTurnIdMutationContinuity("private-token");
    if (documentDescriptor) Object.defineProperty(globalThis, "document", documentDescriptor); else Reflect.deleteProperty(globalThis, "document");
    if (observerDescriptor) Object.defineProperty(globalThis, "MutationObserver", observerDescriptor); else Reflect.deleteProperty(globalThis, "MutationObserver");
  }
}

function makeFixture() {
  const attrs = (values: Record<string, string>) => ({
    nodeType: 1,
    values,
    hasAttribute(name: string) { return this.values[name] !== undefined; },
    getAttribute(name: string) { return this.values[name] ?? null; },
    querySelectorAll(_selector: string) { return [] as any[]; },
  });
  const user = attrs({ "data-testid": "conversation-turn-user", "data-turn-id": "user-turn" });
  const assistant = attrs({ "data-testid": "conversation-turn-assistant-a", "data-turn-id": "opaque-turn" });
  const documentElement = attrs({});
  const listeners = new Map<string, () => void>();
  const view = { __CODEX_WEB_GPT_TURN_OBSERVER__: { id: "private-document" }, location: { href: "https://fixture.test/" },
    addEventListener: (name: string, fn: () => void) => listeners.set(name, fn), removeEventListener: (name: string) => listeners.delete(name) };
  const root = { defaultView: view, documentElement,
    querySelectorAll(selector: string) { if (selector === "assistants") return [assistant]; if (selector === "users") return [user];
      if (selector === "[data-turn-id]") return [user, assistant]; return []; } };
  let callback: ((records: MutationRecord[]) => void) | undefined;
  let queued: MutationRecord[] = [];
  class Observer {
    constructor(fn: (records: MutationRecord[]) => void) { callback = fn; }
    observe() {}
    disconnect() {}
    takeRecords() { const result = queued; queued = []; return result; }
  }
  const attributeRecord = (target: any, name: string, oldValue: string) => ({ type: "attributes", target, attributeName: name,
    oldValue, addedNodes: [], removedNodes: [] }) as unknown as MutationRecord;
  const start = () => startChatGptRecoveryTurnIdMutationContinuity({ token: "private-token", documentId: "private-document",
    deadline: Date.now() + 10_000, userSelector: "users", assistantSelector: "assistants", baselineResponseIdentities: [] });
  return { root, view, assistant, user, Observer, start, finish: () => finishChatGptRecoveryTurnIdMutationContinuity("private-token"),
    emit: (...records: MutationRecord[]) => callback!(records), queue: (...records: MutationRecord[]) => { queued.push(...records); }, attributeRecord };
}

test("stable turn id survives assistant identity rebound without exposing the identifier", () => withFixture(f => {
  expect(f.start()).toBeTrue();
  const old = f.assistant.values["data-testid"]!;
  f.assistant.values["data-testid"] = "conversation-turn-assistant-b";
  f.emit(f.attributeRecord(f.assistant, "data-testid", old));
  const result = f.finish();
  expect(result).toMatchObject({ available: true, sameDocument: true, expired: false, turnIdObserved: true,
    turnIdConflict: false, assistantTransitions: 1, stableAssistantTransitions: 1, stable: true });
  expect(JSON.stringify(result)).not.toContain("opaque-turn");
}));

test("same-task A-B-A turn-id mutation is detected from queued oldValue records", () => withFixture(f => {
  f.start();
  f.queue(f.attributeRecord(f.assistant, "data-turn-id", "opaque-turn"),
    f.attributeRecord(f.assistant, "data-turn-id", "intermediate-turn"));
  expect(f.finish()).toMatchObject({ turnIdConflict: true, turnIdMutationRecords: 2, turnIdAbaRecords: 1, stable: false });
}));

test("duplicate document turn id and document replacement fail closed", async () => {
  await withFixture(f => {
    f.start();
    f.root.querySelectorAll = (selector: string) => selector === "assistants" ? [f.assistant]
      : selector === "users" ? [f.user] : selector === "[data-turn-id]" ? [f.user, f.assistant, { ...f.assistant }] : [];
    f.emit(f.attributeRecord(f.assistant, "data-testid", f.assistant.values["data-testid"]!));
    expect(f.finish()).toMatchObject({ invalidSnapshots: 2, turnIdConflict: true, stable: false });
  });
  await withFixture(f => {
    f.start();
    f.view.__CODEX_WEB_GPT_TURN_OBSERVER__.id = "other-document";
    expect(f.finish()).toMatchObject({ sameDocument: false, stable: false });
  });
});
