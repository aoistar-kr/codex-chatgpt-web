import { expect, test } from "bun:test";

import { ChatGptMarkdownBuffer, type ChatGptMarkdownSegment } from "../src/adapters/chatgpt-web/markdown";
import {
  assertChatGptTurnRecoveryCandidate,
  ChatGptTurnRecoveryIdentityTracker,
  evaluateChatGptTurnRecoveryEvidence,
  type ChatGptTurnRecoveryCandidate,
  type ChatGptTurnRecoveryEvidenceEvaluation,
} from "../src/adapters/chatgpt-web/recovery-identity";
import { ChatGptWireCapture } from "../src/adapters/chatgpt-web/web-stream-tap";
import {
  ChatGptCaptureDispositionTracker,
  ChatGptSubmissionDispositionTracker,
} from "../src/adapters/chatgpt-web/submission-disposition";

// Synthetic I/O only: this composes production state machines and the Markdown ledger, NOT the
// browser worker, CDP transport, live DOM extractor, live network I/O, or automatic recovery branch.
const MESSAGE_ID = "12345678-1234-4234-8234-123456789abc";
const FINAL_DOM_MARKDOWN = "First block.\n\nSecond block.";
function independentFixtureCandidate(): ChatGptTurnRecoveryCandidate {
  // Intentionally supplied by the fixture observer, never copied from the frozen proof.
  return { surfaceId: "surface-1", documentId: "document-1", conversationId: "conversation-1",
    assistantTurnIdentity: "assistant-1", messageId: MESSAGE_ID };
}
function segments(): ChatGptMarkdownSegment[] {
  return ["First block.", "Second block."].map((text, index) => ({
    key: `block-${index}`, tag: "p", text, html: `<p>${text}</p>`,
    sourceStart: index * 20, sourceEnd: index * 20 + 12, streamable: true,
  }));
}
const messageObservation = {
  messageId: MESSAGE_ID, documentId: "document-1", assistantTurnIdentity: "assistant-1",
  count: 1, documentMatches: 1, uuidLike: true,
};
type Missing = "document" | "conversation" | "assistant" | "message";
function fixture(options: { missing?: Missing; conflict?: Missing } = {}) {
  const submission = new ChatGptSubmissionDispositionTracker();
  const capture = new ChatGptCaptureDispositionTracker();
  const identity = new ChatGptTurnRecoveryIdentityTracker("surface-1");
  const buffer = new ChatGptMarkdownBuffer(undefined, 0);
  const counters = { submit: 0, reconnect: 0, resume: 0, observerRead: 0 };
  const clock = { now: 0, deadline: 100, aborted: false };
  const emitted: string[] = [];
  const events: string[] = [];
  const submit = () => {
    submission.sendActivated();
    counters.submit += 1;
    submission.submitted();
  };
  submit();
  identity.commitSubmission();
  if (options.missing !== "document") identity.observeDocument("document-1");
  if (options.missing !== "assistant") identity.observeAssistantTurn("assistant-1");
  if (options.missing !== "conversation") identity.observeWireSnapshot({ conversationId: "conversation-1" });
  if (options.missing !== "message") identity.observeCommittedMessage(messageObservation);
  capture.beginAfterCommit(submission.snapshot());
  emitted.push(buffer.observe(segments().slice(0, 1), 0));
  if (options.conflict === "document") identity.observeDocument("document-other");
  if (options.conflict === "conversation") identity.observeWireSnapshot({ conversationId: "conversation-other" });
  if (options.conflict === "assistant") {
    identity.observeAssistantTurn("assistant-other");
    identity.observeAssistantTurn("assistant-1");
  }
  if (options.conflict === "message") identity.observeCommittedMessage({ ...messageObservation, count: 2 });
  events.push("terminal-disconnect");
  capture.failAfterCommit(submission.snapshot());
  identity.freezeCommittedProof();
  events.push("proof-frozen");

  const checkBudget = () => {
    if (clock.aborted || clock.now >= clock.deadline) throw new Error("fixture recovery budget exhausted");
  };
  const resume = (readCandidate = independentFixtureCandidate, duringReconnect?: () => void) => {
    checkBudget();
    if (counters.reconnect !== 0) throw new Error("fixture reconnect budget exhausted");
    counters.reconnect += 1;
    events.push("fixture-reconnect");
    duringReconnect?.();
    checkBudget();
    counters.observerRead += 1;
    const candidate = readCandidate();
    checkBudget();
    const proof = identity.frozenSnapshot()!;
    // Fixture policy requires message evidence. Production's legacy matcher permits absent
    // optional message provenance; this test does not claim otherwise or enable that policy.
    if (!proof.message) throw new Error("fixture requires pre-failure message provenance");
    assertChatGptTurnRecoveryCandidate(proof, candidate);
    capture.resumeAfterExactRecovery(submission.snapshot());
    counters.resume += 1;
    events.push("same-buffer-resume");
    emitted.push(buffer.observe(segments(), 1));
    const final = buffer.finish();
    emitted.push(final.delta);
    if (final.markdown !== FINAL_DOM_MARKDOWN) throw new Error("fixture final DOM mismatch");
    capture.complete();
    return final.markdown;
  };
  return { submission, capture, identity, buffer, counters, clock, emitted, events, resume, submit };
}

function expectBlocked(f: ReturnType<typeof fixture>, action: () => unknown, reconnects = 1) {
  const prefix = f.emitted.join("");
  expect(action).toThrow();
  expect(f.capture.snapshot()).toBe("incomplete-after-commit");
  expect(f.submission.snapshot()).toBe("committed");
  expect(f.counters).toMatchObject({ submit: 1, reconnect: reconnects, resume: 0 });
  expect(f.emitted.join("")).toBe(prefix);
  expect(() => f.submit()).toThrow();
  expect(f.counters.submit).toBe(1);
}

test("synthetic terminal disconnect resumes the same Markdown buffer once with exact fixture proof", () => {
  const f = fixture();
  const originalBuffer = f.buffer;
  expect(f.emitted.join("")).toBe("First block.");
  expect(f.capture.snapshot()).toBe("incomplete-after-commit");
  expect(f.resume()).toBe(FINAL_DOM_MARKDOWN);
  expect(f.buffer).toBe(originalBuffer);
  expect(f.emitted.join("")).toBe(FINAL_DOM_MARKDOWN);
  expect(f.counters).toEqual({ submit: 1, reconnect: 1, resume: 1, observerRead: 1 });
  expect(f.events).toEqual(["terminal-disconnect", "proof-frozen", "fixture-reconnect", "same-buffer-resume"]);
  expect(f.capture.snapshot()).toBe("complete");
  expect(() => f.resume()).toThrow("reconnect budget");
  expect(() => f.submit()).toThrow();
  expect(f.counters.submit).toBe(1);
});

for (const field of ["surfaceId", "documentId", "conversationId", "assistantTurnIdentity", "messageId"] as const) {
  for (const value of ["wrong", ""]) {
    test(`synthetic ${field} ${value || "missing"} candidate blocks resume and replay`, () => {
      const f = fixture();
      expectBlocked(f, () => f.resume(() => ({ ...independentFixtureCandidate(), [field]: value })));
    });
  }
}
for (const field of ["document", "conversation", "assistant", "message"] as const) {
  test(`synthetic missing committed ${field} cannot be filled from a fresh candidate`, () => {
    const f = fixture({ missing: field });
    expectBlocked(f, () => f.resume());
  });
  test(`synthetic conflicted committed ${field} blocks exact-candidate resume`, () => {
    const f = fixture({ conflict: field });
    expectBlocked(f, () => f.resume());
  });
}
for (const abort of [true, false]) {
  for (const stage of ["before", "reconnect", "proof"] as const) {
    test(`synthetic ${abort ? "abort" : "deadline"} at ${stage} prevents resume and replay`, () => {
      const f = fixture();
      const exhaust = () => { if (abort) f.clock.aborted = true; else f.clock.now = f.clock.deadline; };
      if (stage === "before") exhaust();
      expectBlocked(f, () => f.resume(() => {
        if (stage === "proof") exhaust();
        return independentFixtureCandidate();
      }, stage === "reconnect" ? exhaust : undefined), stage === "before" ? 0 : 1);
    });
  }
}
test("synthetic late tracker observations and mutated proof copies cannot authorize a changed candidate", () => {
  const f = fixture();
  const original = f.identity.frozenSnapshot();
  const copy = f.identity.frozenSnapshot()!;
  copy.identity.conversationId = "late-conversation";
  copy.message!.messageId = "late-message";
  f.identity.observeWireSnapshot({ conversationId: "late-conversation" });
  f.identity.observeCommittedMessage({ ...messageObservation, messageId: "late-message" });
  expect(f.identity.frozenSnapshot()).toEqual(original);
  expectBlocked(f, () => f.resume(() => ({ ...independentFixtureCandidate(),
    conversationId: "late-conversation", messageId: "late-message" })));
});

/**
 * This second fixture adds the mandatory diagnostic evidence gate to the synthetic continuation.
 * ChatGptWireCapture runs its real SSE accumulator on supplied fixture events, not network I/O.
 * The post-disconnect DOM observer and reconnect remain fixture callbacks. A diagnostic match
 * is a test precondition only; recoveryAuthorized:false never becomes production authorization.
 */
function evidenceGatedFixture(options: {
  wireUnknown?: boolean;
  wireConflict?: boolean;
  missingPostCommitMessage?: boolean;
  assistantRebound?: boolean;
} = {}) {
  const submission = new ChatGptSubmissionDispositionTracker();
  const capture = new ChatGptCaptureDispositionTracker();
  const identity = new ChatGptTurnRecoveryIdentityTracker("surface-1");
  const wire = new ChatGptWireCapture(true);
  const buffer = new ChatGptMarkdownBuffer(undefined, 0);
  const counters = { submit: 0, reconnect: 0, resume: 0, observerRead: 0 };
  const clock = { now: 0, deadline: 100, aborted: false };
  const events: string[] = [];
  const emitted: string[] = [];
  const evidence: { latest?: ChatGptTurnRecoveryEvidenceEvaluation } = {};
  const submit = () => {
    submission.sendActivated();
    counters.submit += 1;
    submission.submitted();
  };
  submit();
  identity.commitSubmission();
  identity.observeDocument("document-1");
  identity.observeAssistantTurn("assistant-1");
  wire.subscribe(snapshot => identity.observeWireSnapshot(snapshot));
  wire.accept({ type: "start", streamId: "fixture-stream", url: "https://chatgpt.com/backend-api/conversation",
    status: 200, contentType: "text/event-stream" });
  const feed = (value: unknown) => wire.accept({ type: "chunk", streamId: "fixture-stream",
    chunk: `data: ${JSON.stringify(value)}\n\n` });
  const fullMessage = (id: string) => ({ conversation_id: "conversation-1", message: {
    id, author: { role: "assistant" }, channel: "final", recipient: "all",
    content: { content_type: "text", parts: ["First block."] }, status: "in_progress",
  } });
  feed(fullMessage(MESSAGE_ID));
  if (!options.missingPostCommitMessage) identity.observeCommittedMessage(messageObservation);
  capture.beginAfterCommit(submission.snapshot());
  emitted.push(buffer.observe(segments().slice(0, 1), 0));
  if (options.wireUnknown) feed({ p: "/message/id", o: "replace", v: "fixture-unsupported-id-patch" });
  if (options.wireConflict) feed(fullMessage("87654321-4321-4321-8321-123456789abc"));
  if (options.assistantRebound) {
    identity.observeAssistantTurn("assistant-replacement");
    identity.observeAssistantTurn("assistant-1");
  }
  wire.accept({ type: "error", streamId: "fixture-stream", message: "fixture transport disconnect" });
  events.push("terminal-disconnect");
  capture.failAfterCommit(submission.snapshot());
  const frozen = identity.freezeCommittedProof();
  events.push("proof-frozen");

  const checkBudget = () => {
    if (clock.aborted || clock.now >= clock.deadline) throw new Error("fixture recovery budget exhausted");
  };
  const resume = (
    readCandidate: () => Partial<ChatGptTurnRecoveryCandidate> = independentFixtureCandidate,
    afterEvidence?: () => void,
  ) => {
    checkBudget();
    if (counters.reconnect !== 0) throw new Error("fixture reconnect budget exhausted");
    counters.reconnect += 1;
    events.push("fixture-reconnect");
    counters.observerRead += 1;
    const candidate = readCandidate();
    checkBudget();
    evidence.latest = evaluateChatGptTurnRecoveryEvidence(identity.frozenSnapshot()!, candidate);
    events.push("diagnostic-evidence-evaluated");
    if (!evidence.latest.matched) throw new Error("fixture evidence gate denied");
    afterEvidence?.();
    checkBudget(); // An exact proof never waives cancellation or the absolute budget.
    capture.resumeAfterExactRecovery(submission.snapshot());
    counters.resume += 1;
    events.push("same-buffer-resume");
    emitted.push(buffer.observe(segments(), 1)); // Fixture fresh DOM, not resumed live wire text.
    const final = buffer.finish();
    if (final.markdown !== FINAL_DOM_MARKDOWN) throw new Error("fixture final DOM mismatch");
    emitted.push(final.delta);
    capture.complete();
    return final.markdown;
  };
  return { submission, capture, identity, wire, buffer, counters, clock, emitted, events, evidence, frozen, resume, submit };
}

function expectEvidenceBlocked(f: ReturnType<typeof evidenceGatedFixture>, action: () => unknown) {
  const prefix = f.emitted.join("");
  expect(action).toThrow();
  expect(f.capture.snapshot()).toBe("incomplete-after-commit");
  expect(f.submission.snapshot()).toBe("committed");
  expect(f.identity.lifecycle()).toBe("frozen");
  expect(f.counters).toEqual({ submit: 1, reconnect: 1, resume: 0, observerRead: 1 });
  expect(f.emitted.join("")).toBe(prefix);
  expect(f.evidence.latest?.recoveryAuthorized).toBeFalse();
  expect(() => f.submit()).toThrow();
  expect(f.counters.submit).toBe(1); // Synthetic invocation count only, never a network measurement.
}

test("synthetic mandatory evidence gate joins parsed wire provenance frozen DOM evidence and same Markdown buffer", () => {
  const f = evidenceGatedFixture();
  const originalBuffer = f.buffer;
  expect(f.wire.snapshot().assistantMessageId).toBe(MESSAGE_ID);
  expect(f.frozen.wireMessage).toEqual({ messageId: MESSAGE_ID, conversationId: "conversation-1", conflicted: false, unknown: false });
  expect(f.frozen.message?.observedAfterCommit).toBeTrue();
  expect(f.wire.snapshot().complete).toBeFalse();
  expect(f.wire.snapshot().failed).toBeTrue();
  expect(f.resume()).toBe(FINAL_DOM_MARKDOWN);
  expect(f.evidence.latest).toEqual({ matched: true, reasons: [], recoveryAuthorized: false });
  expect(f.buffer).toBe(originalBuffer);
  expect(f.emitted.join("")).toBe(FINAL_DOM_MARKDOWN);
  expect(f.events).toEqual(["terminal-disconnect", "proof-frozen", "fixture-reconnect", "diagnostic-evidence-evaluated", "same-buffer-resume"]);
  expect(f.counters).toEqual({ submit: 1, reconnect: 1, resume: 1, observerRead: 1 });
  expect(f.capture.snapshot()).toBe("complete");
  expect(f.wire.snapshot().failed).toBeTrue(); // No claim that the disconnected transport was repaired.
  expect(() => f.resume()).toThrow("reconnect budget");
});

test("synthetic Temporary-root candidate cannot borrow a conversation from exact original wire mapping", () => {
  const f = evidenceGatedFixture();
  const candidate: Partial<ChatGptTurnRecoveryCandidate> = independentFixtureCandidate();
  delete candidate.conversationId;
  expectEvidenceBlocked(f, () => f.resume(() => candidate));
  expect(f.evidence.latest?.reasons).toEqual(["FRESH_CONVERSATION_MISSING"]);
  expect(candidate.conversationId).toBeUndefined();
});

test("synthetic copied message in another fresh conversation cannot pass the mandatory evidence gate", () => {
  const f = evidenceGatedFixture();
  expectEvidenceBlocked(f, () => f.resume(() => ({ ...independentFixtureCandidate(), conversationId: "fixture-copied-conversation" })));
  expect(f.evidence.latest?.reasons).toEqual(["CONVERSATION_MISMATCH"]);
});

for (const [options, reason] of [
  [{ wireUnknown: true }, "ORIGINAL_WIRE_MAPPING_UNKNOWN"],
  [{ wireConflict: true }, "ORIGINAL_WIRE_MAPPING_CONFLICT"],
  [{ missingPostCommitMessage: true }, "POST_COMMIT_MESSAGE_MISSING"],
  [{ assistantRebound: true }, "ASSISTANT_REBOUND"],
] as const) {
  test(`synthetic mandatory evidence gate rejects ${reason} despite an exact fresh candidate`, () => {
    const f = evidenceGatedFixture(options);
    expectEvidenceBlocked(f, () => f.resume());
    expect(f.evidence.latest?.matched).toBeFalse();
    expect(f.evidence.latest?.reasons).toContain(reason);
  });
}

for (const abort of [true, false]) {
  test(`synthetic ${abort ? "abort" : "deadline"} after matched mandatory evidence still denies resume`, () => {
    const f = evidenceGatedFixture();
    expectEvidenceBlocked(f, () => f.resume(independentFixtureCandidate, () => {
      if (abort) f.clock.aborted = true;
      else f.clock.now = f.clock.deadline;
    }));
    expect(f.evidence.latest).toEqual({ matched: true, reasons: [], recoveryAuthorized: false });
  });
}

test("synthetic frozen wire mapping cannot be rewritten by late parsed messages or modified proof copies", () => {
  const f = evidenceGatedFixture();
  const original = f.identity.frozenSnapshot();
  const copy = f.identity.frozenSnapshot()!;
  copy.wireMessage!.messageId = "fixture-tampered-message";
  copy.wireMessage!.conversationId = "fixture-tampered-conversation";
  f.wire.accept({ type: "chunk", streamId: "fixture-stream", chunk: `data: ${JSON.stringify({
    conversation_id: "fixture-late-conversation", message: {
      id: "fixture-late-message", author: { role: "assistant" }, channel: "final", recipient: "all",
      content: { content_type: "text", parts: ["fixture late text"] },
    },
  })}\n\n` });
  expect(f.identity.frozenSnapshot()).toEqual(original);
  expectEvidenceBlocked(f, () => f.resume(() => ({ ...independentFixtureCandidate(),
    conversationId: "fixture-late-conversation", messageId: "fixture-late-message" })));
  expect(f.evidence.latest?.reasons).toContain("CONVERSATION_MISMATCH");
  expect(f.evidence.latest?.reasons).toContain("MESSAGE_MISMATCH");
});
