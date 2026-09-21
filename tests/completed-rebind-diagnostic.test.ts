import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { collectChatGptRecoveryDomSnapshot, sameChatGptRecoveryDomSnapshot, withChatGptRecoveryDiagnosticBudget } from "../src/adapters/chatgpt-web/recovery-dom-proof";
import { chatGptCompletedRebindDiagnosticsEnabled } from "../src/adapters/chatgpt-web/web-stream/flags";

const id = "12345678-1234-4234-8234-123456789abc";
function sample(values: string[], elsewhere: string[] = [], role = "assistant", options: {
  users?: string[]; assistants?: string[]; documentId?: string; pathname?: string;
  activity?: { stopCount?: number; completed?: boolean; alert?: boolean; dialog?: boolean; alertText?: string; terminalText?: string; hidden?: boolean;
    alertChildren?: number; emptyNested?: boolean; namedAlert?: boolean; pseudoContent?: string; backgroundImage?: string; maskImage?: string };
} = {}) {
  const visibleNode = { isConnected: true, getBoundingClientRect: () => ({ width: 10, height: 10 }), textContent: "",
    tagName: "DIV", hasAttribute: () => options.activity?.namedAlert ?? false,
    querySelectorAll: () => options.activity?.emptyNested ? [{ tagName: "SPAN", hasAttribute: () => false }]
      : Array.from({ length: options.activity?.alertChildren ?? 0 }, () => ({ tagName: "SVG", hasAttribute: () => false })) };
  const node = (value: string) => ({
    ...visibleNode,
    hasAttribute: (key: string) => key === "data-message-id" || key === "data-message-author-role",
    contains: () => false,
    getAttribute: (key: string) => key === "data-message-id" ? value
      : key === "data-message-author-role" ? role : null,
  });
  const nodes = values.map(node);
  const userIds = options.users ?? ["conversation-turn-user"];
  const assistantIds = options.assistants ?? ["conversation-turn-assistant"];
  const turn = (identity: string) => ({
    parentElement: null,
    getAttribute: (key: string) => key === "data-testid" || key === "data-turn-id" ? identity : null,
    contains: () => false,
    hasAttribute: (key: string) => key === "data-turn-id",
    querySelectorAll: (selector: string) => selector === "complete"
      ? options.activity?.completed ? [visibleNode] : []
      : selector === "*" ? [{ ...visibleNode, textContent: options.activity?.terminalText ?? "" }]
        : selector === "[data-turn-id]" ? [] : nodes,
  });
  const userTurns = userIds.map(turn);
  const assistantTurns = assistantIds.map(turn);
  const container = (identity: string) => ({
    parentElement: null,
    getAttribute: (key: string) => key === "data-turn-id-container" ? identity : null,
  });
  const root = {
    defaultView: {
      __CODEX_WEB_GPT_TURN_OBSERVER__: { id: options.documentId ?? "document-1" },
      location: { pathname: options.pathname ?? "/" },
      getComputedStyle: () => ({ visibility: options.activity?.hidden ? "hidden" : "visible", display: "block",
        content: options.activity?.pseudoContent ?? "none", backgroundImage: options.activity?.backgroundImage ?? "none",
        maskImage: options.activity?.maskImage ?? "none" }),
    },
    querySelectorAll: (selector: string) => selector === "users"
      ? userTurns
      : selector === "assistants" ? assistantTurns
        : selector === "[data-turn-id-container]" ? [...userIds, ...assistantIds].map(container)
          : selector === "[data-turn-id]" ? [...userTurns, ...assistantTurns]
            : selector === "stop" ? Array.from({ length: options.activity?.stopCount ?? 1 }, () => visibleNode)
              : selector === '[role="alert"]' ? options.activity?.alert ? [{ ...visibleNode, textContent: options.activity.alertText ?? "" }] : []
                : selector === '[role="dialog"]' ? options.activity?.dialog ? [visibleNode] : []
                  : [...nodes, ...elsewhere.map(node)],
  };
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: root });
  try {
    return collectChatGptRecoveryDomSnapshot({ userSelector: "users", assistantSelector: "assistants", baselineResponseIdentities: [],
      ...(options.activity ? { activity: { stopButtonSelector: "stop", completionActionSelector: "complete" } } : {}) });
  } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else Reflect.deleteProperty(globalThis, "document");
  }
}

test("completed rebind diagnostic is strict opt-in", () => {
  for (const value of [undefined, "0", "true", "yes"]) {
    expect(chatGptCompletedRebindDiagnosticsEnabled({ CODEX_CHATGPT_WEB_COMPLETED_REBIND_DIAGNOSTICS: value })).toBe(false);
  }
  expect(chatGptCompletedRebindDiagnosticsEnabled({ CODEX_CHATGPT_WEB_COMPLETED_REBIND_DIAGNOSTICS: "1" })).toBe(true);
});

test("message proof reads unique assistant ID only into memory", async () => {
  expect(sample([id])).toEqual({ messageId: id, documentId: "document-1", count: 1, uuidLike: true,
    messageUuidLike: true, messageRoleRelation: "same-node", documentMatches: 1,
    turnId: "conversation-turn-assistant", turnIdCount: 1, turnIdDocumentMatches: 1,
    currentConversationId: undefined, userIdentities: ["conversation-turn-user"], responseIdentities: ["conversation-turn-assistant"],
    assistantTurnIdentity: "conversation-turn-assistant", assistantDisplayIdentity: "conversation-turn-assistant", identityAmbiguous: false });
});

test("message proof exposes missing, empty, malformed, duplicate, hidden collision and wrong role", async () => {
  expect((await sample([])).count).toBe(0);
  expect((await sample([""])).uuidLike).toBe(false);
  expect((await sample(["not-an-id"])).uuidLike).toBe(false);
  expect((await sample([id, id])).count).toBe(2);
  expect((await sample([id], [id])).documentMatches).toBe(2);
  expect((await sample([id], [], "user")).uuidLike).toBe(false);
  expect((await sample([id.replace("12345678", "87654321")])).messageId).not.toBe(id);
});

test("completed diagnostic is observation-only, fresh, privacy-safe and cannot resume capture", () => {
  // The assertion below matches LF-separated source text. A Windows checkout can hand back CRLF,
  // which would fail the match for a reason that has nothing to do with the cleanup ordering.
  const source = readFileSync(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url), "utf8")
    .replaceAll("\r\n", "\n");
  const start = source.lastIndexOf("      if (chatGptCompletedRebindDiagnosticsEnabled())");
  const block = source.slice(start, source.indexOf("      return finalText;", start));
  expect(source.slice(start - 45, start)).toContain("captureDisposition.complete()");
  expect(block).toContain("readRecoveryProof(signal)");
  expect(block).toContain("validateRecoveryProof(fresh)");
  expect(block).toContain("before.messageId === after.messageId");
  expect(block).toContain("fresh.userIdentities.length !== responseTurn.acceptedUserTurnIdentities.length");
  expect(block).not.toMatch(/sendAttachedPrompt|attachPrompt|\.goto\(|resumeAfterExactRecovery|console\.error/);
  expect(block).not.toContain("...before");
  expect(block).not.toContain("...after");
  expect(block).toContain("withChatGptRecoveryDiagnosticBudget(deadline, turn.abortSignal");
  expect(block).toContain("sameChatGptRecoveryDomSnapshot(after, fence)");
  expect(block).toContain("startChatGptRecoveryDomContinuity");
  expect(block).toContain("finishChatGptRecoveryDomContinuity");
  expect(block).toContain("finishChatGptRecoveryTurnIdMutationContinuity, generationTurnIdContinuityToken");
  expect(block).toContain("&& metric.domIdentityContinuityExact");
  expect(block.indexOf("startChatGptRecoveryDomContinuity")).toBeLessThan(block.indexOf("const before = await readRecoveryProof"));
  expect(block).toContain("diagnosticBuffer.finish().markdown === finalText");
  expect(block).toContain("evaluateChatGptTurnRecoveryEvidence(originalProof");
  expect(block).toContain("collectChatGptRecoveryServerProof");
  expect(block).toContain("chatGptRecoveryServerProofExact(metric.serverConversationProof)");
  expect(block).toContain("conversationId: metric.serverConversationProofExact ? expectedServerConversationId : undefined");
  expect(block).toContain("evaluateChatGptRecoveryEquivalentEvidence({");
  expect(block).toContain("appConversationBindingExact: metric.appConversationBindingExact");
  expect(block).toContain("freshServerConversationReachable: metric.freshServerConversationReachable");
  expect(block).toContain("generationTurnIdContinuity: metric.generationTurnIdContinuity");
  expect(block).toContain("const persistedDetailStrict =");
  expect(block).toContain("metric.passed = persistedDetailStrict ||");
  expect(block).not.toContain("conversationId: after.currentConversationId");
  expect(block).not.toContain("conversationId: wire");
  expect(block).not.toContain("observeCommittedMessage");
});

test("generation turn-id observer is finished after fresh rebind fencing and cleanup targets the rebound page", () => {
  const source = readFileSync(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url), "utf8")
    .replaceAll("\r\n", "\n");
  const completed = source.lastIndexOf("      if (chatGptCompletedRebindDiagnosticsEnabled())");
  const fence = source.indexOf("sameChatGptRecoveryDomSnapshot(after, fence)", completed);
  const finish = source.indexOf("finishChatGptRecoveryTurnIdMutationContinuity, generationTurnIdContinuityToken", completed);
  expect(fence).toBeGreaterThan(completed);
  expect(finish).toBeGreaterThan(fence);
  expect(source.slice(completed, finish)).toContain("rebindLauncherPage(1");
  expect(source.slice(source.indexOf("    } finally {", finish))).toContain("diagnosticPage.evaluate(\n          finishChatGptRecoveryTurnIdMutationContinuity");
});

test("atomic early activity uses the same DOM read and fails closed for completion terminal and duplicate stops", () => {
  expect(sample([id], [], "assistant", { activity: {} }).activity).toEqual({
    generating: true, completionActionVisible: false, terminalVisible: false,
    visibleAlertCount: 0, emptyAlertCount: 0, ignoredEmptyAlertCount: 0, visibleDialogCount: 0, terminalTextVisible: false,
    emptyAlertBlockers: { structure: 0, named: 0, style: 0, complex: 0 },
  });
  for (const stopCount of [0, 2]) expect(sample([id], [], "assistant", { activity: { stopCount } }).activity?.generating).toBeFalse();
  expect(sample([id], [], "assistant", { activity: { hidden: true } }).activity?.generating).toBeFalse();
  expect(sample([id], [], "assistant", { activity: { completed: true } }).activity?.completionActionVisible).toBeTrue();
  for (const activity of [{ alert: true, alertText: "fixture error" }, { dialog: true }, { terminalText: "Stopped thinking" }, { terminalText: "Something went wrong." }]) {
    expect(sample([id], [], "assistant", { activity }).activity?.terminalVisible).toBeTrue();
  }
});

test("early sampler is opt-in active-loop-only and never backfills completion or terminal boundaries", () => {
  const source = readFileSync(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url), "utf8")
    .replaceAll("\r\n", "\n");
  expect(source).toContain("const recoveryEvidenceEnabled = completedRebindEligible");
  expect(source).toContain("chatGptCompletedRebindDiagnosticsEnabled() || turnPlan.incompleteCaptureRecovery");
  expect(source).toContain('captureDisposition.snapshot() === "capturing" && recoveryIdentity.lifecycle() === "committed"');
  expect(source).toContain("if (snapshot.completionActionVisible || snapshot.stoppedThinkingVisible) earlyMessageSampler?.close()");
  const sampleCall = source.indexOf("await earlyMessageSampler.sample()");
  expect(source.slice(sampleCall, sampleCall + 150)).toContain("earlyRecoverySampling = earlyMessageSampler.run()");
  expect(sampleCall).toBeLessThan(source.indexOf('await diagnostics.capture(page, "response-visible")', sampleCall));
  expect(source.slice(sampleCall)).not.toContain("observeCommittedMessage");
  const terminal = source.indexOf("recoveryIdentity.freezeCommittedProof()");
  expect(source.indexOf("earlyRecoverySampler?.close()", terminal)).toBeGreaterThan(terminal);
});

test("first opt-in active read precedes the send-accepted screenshot without changing default ordering", () => {
  const source = readFileSync(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url), "utf8")
    .replaceAll("\r\n", "\n");
  const defaultCapture = source.indexOf('if (!prioritizeEarlyRecoveryEvidence) await diagnostics.capture(page, "send-accepted")');
  const binding = source.indexOf("let responseTurn = await responseTurnPromise");
  const sample = source.indexOf("await earlyMessageSampler.sample()");
  const delayedCapture = source.indexOf('await diagnostics.capture(page, "send-accepted")', sample);
  expect(defaultCapture).toBeGreaterThan(0);
  expect(defaultCapture).toBeLessThan(binding);
  expect(binding).toBeLessThan(sample);
  expect(sample).toBeLessThan(delayedCapture);
  expect(source.slice(binding, sample)).toContain("const earlyMessageSampler = prioritizeEarlyRecoveryEvidence");
});

test("only proven empty announcement placeholders are ignored; named children and CSS content fail closed", () => {
  const empty = sample([id], [], "assistant", { activity: { alert: true } }).activity!;
  expect(empty).toMatchObject({ terminalVisible: false, visibleAlertCount: 1, emptyAlertCount: 1, ignoredEmptyAlertCount: 1,
    visibleDialogCount: 0, terminalTextVisible: false });
  const nonempty = sample([id], [], "assistant", { activity: { alert: true, alertText: "fixture alert" } }).activity!;
  expect(nonempty.emptyAlertCount).toBe(0);
  expect(nonempty.terminalVisible).toBeTrue();
  expect(sample([id], [], "assistant", { activity: { alert: true, emptyNested: true } }).activity?.ignoredEmptyAlertCount).toBe(1);
  for (const extra of [{ alertChildren: 1 }, { namedAlert: true }, { pseudoContent: '"error"' },
    { backgroundImage: "url(fixture-icon)" }, { maskImage: "url(fixture-mask)" }]) {
    const result = sample([id], [], "assistant", { activity: { alert: true, ...extra } }).activity!;
    expect(result.terminalVisible).toBeTrue();
    expect(result.ignoredEmptyAlertCount).toBe(0);
  }
  expect(sample([id], [], "assistant", { activity: { dialog: true } }).activity?.visibleDialogCount).toBe(1);
});

test("atomic DOM proof rejects duplicate identities and ambiguous assistant ownership", () => {
  for (const options of [
    { users: ["conversation-turn-user", "conversation-turn-user"] },
    { assistants: ["conversation-turn-a", "conversation-turn-a"] },
    { assistants: ["conversation-turn-a", "conversation-turn-b"] },
    { assistants: [""] }, { assistants: [] },
  ]) expect(sample([id], [], "assistant", options).assistantTurnIdentity).toBeUndefined();
});

test("Markdown fence rejects document, user, assistant, message and URL changes without inventing conversation identity", () => {
  const before = sample([id]);
  expect(sameChatGptRecoveryDomSnapshot(before, sample([id]))).toBe(true);
  expect(before.currentConversationId).toBeUndefined();
  for (const options of [{ documentId: "new-document" }, { users: [] },
    { users: ["conversation-turn-user", "conversation-turn-extra"] },
    { assistants: ["conversation-turn-replacement"] }, { pathname: "/c/other-conversation" }]) {
    expect(sameChatGptRecoveryDomSnapshot(before, sample([id], [], "assistant", options))).toBe(false);
  }
  expect(sameChatGptRecoveryDomSnapshot(before, sample([id], [id]))).toBe(false);
  expect(sameChatGptRecoveryDomSnapshot(before, sample([id.replace("12345678", "87654321")]))).toBe(false);
});

test("diagnostic absolute budget rejects expiry and abort before starting any action", async () => {
  let actions = 0;
  await expect(withChatGptRecoveryDiagnosticBudget(Date.now() - 1, undefined, async () => ++actions)).rejects.toThrow("budget");
  await expect(withChatGptRecoveryDiagnosticBudget(undefined, AbortSignal.abort(), async () => ++actions)).rejects.toThrow("budget");
  expect(actions).toBe(0);
});

test("one diagnostic deadline aborts an unresolved operation and outer cancellation propagates", async () => {
  let signal: AbortSignal | undefined;
  await expect(withChatGptRecoveryDiagnosticBudget(Date.now() + 20, undefined, async s => {
    signal = s;
    return new Promise<never>(() => {});
  })).rejects.toThrow("budget");
  expect(signal?.aborted).toBe(true);
  const controller = new AbortController();
  const result = withChatGptRecoveryDiagnosticBudget(undefined, controller.signal, async s => {
    signal = s;
    return new Promise<never>(() => {});
  });
  controller.abort();
  await expect(result).rejects.toThrow("budget");
  expect(signal?.aborted).toBe(true);
});
