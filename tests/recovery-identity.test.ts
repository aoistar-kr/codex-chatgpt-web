import { expect, test } from "bun:test";

import {
  assertChatGptTurnRecoveryCandidate,
  ChatGptTurnRecoveryIdentityTracker,
} from "../src/adapters/chatgpt-web/recovery-identity";

const messageObservation = {
  messageId: "12345678-1234-4234-8234-123456789abc", documentId: "document-1",
  assistantTurnIdentity: "assistant-1", count: 1, documentMatches: 1, uuidLike: true,
};
function messageTracker(commit = true) {
  const tracker = new ChatGptTurnRecoveryIdentityTracker("surface-1");
  tracker.observeDocument("document-1");
  tracker.observeAssistantTurn("assistant-1");
  tracker.observeWireSnapshot({ conversationId: "conversation-1" });
  if (commit) tracker.commitSubmission();
  return tracker;
}

test("message provenance is post-commit only, frozen before late observations, and defensively cloned", () => {
  const tracker = messageTracker(false);
  tracker.observeCommittedMessage(messageObservation);
  expect(tracker.messageDiagnostic().hasCommittedMessage).toBe(false);
  tracker.resetAfterProvenRollback();
  tracker.observeDocument("document-1");
  tracker.observeAssistantTurn("assistant-1");
  tracker.commitSubmission();
  tracker.observeCommittedMessage(messageObservation);
  const frozen = tracker.freezeCommittedProof();
  expect(frozen.message?.observedAfterCommit).toBe(true);
  tracker.observeCommittedMessage({ ...messageObservation, messageId: "late" });
  expect(tracker.frozenSnapshot()).toEqual(frozen);
  frozen.message!.messageId = "mutated-copy";
  expect(tracker.frozenSnapshot()?.message?.messageId).toBe(messageObservation.messageId);
  expect(JSON.stringify(tracker.messageDiagnostic())).not.toContain(messageObservation.messageId);
});

test("missing, duplicate, wrong-document and wrong-assistant observations cannot establish provenance", () => {
  for (const change of [
    { messageId: undefined }, { count: 0 }, { count: 2 }, { documentMatches: 2 },
    { uuidLike: false }, { documentId: "other" }, { assistantTurnIdentity: "other" },
  ]) {
    const tracker = messageTracker();
    tracker.observeCommittedMessage({ ...messageObservation, ...change });
    expect(tracker.freezeCommittedProof().message).toBeUndefined();
  }
});

test("message conflict is sticky and never replaces first observed provenance", () => {
  for (const change of [{ messageId: "changed" }, { count: 0 }, { documentMatches: 2 }, { assistantTurnIdentity: "remounted" }]) {
    const tracker = messageTracker();
    tracker.observeCommittedMessage(messageObservation);
    tracker.observeCommittedMessage({ ...messageObservation, ...change });
    tracker.observeCommittedMessage(messageObservation);
    const frozen = tracker.freezeCommittedProof();
    expect(frozen.message?.conflicted).toBe(true);
    expect(frozen.message?.messageId).toBe(messageObservation.messageId);
  }
});

test("copied message ID cannot substitute for independent conversation proof or excuse remount", () => {
  const tracker = messageTracker();
  tracker.observeCommittedMessage(messageObservation);
  const frozen = tracker.freezeCommittedProof();
  const candidate = { surfaceId: "surface-1", documentId: "document-1", conversationId: "conversation-1",
    assistantTurnIdentity: "assistant-1", messageId: messageObservation.messageId };
  expect(() => assertChatGptTurnRecoveryCandidate(frozen, candidate)).not.toThrow();
  for (const change of [{ conversationId: "copied-into-other-conversation" }, { conversationId: "" },
    { messageId: undefined }, { messageId: "changed" }, { assistantTurnIdentity: "remount" }]) {
    expect(() => assertChatGptTurnRecoveryCandidate(frozen, { ...candidate, ...change })).toThrow();
  }
});

test("message consistency cannot backfill missing provenance and latches assistant replacement", () => {
  const tracker = messageTracker();
  const match = () => tracker.matchesCommittedMessage(messageObservation.messageId, "document-1", "assistant-1");
  expect(match()).toBe(false);
  tracker.observeCommittedMessage(messageObservation);
  expect(match()).toBe(true);
  expect(tracker.matchesCommittedMessage("changed", "document-1", "assistant-1")).toBe(false);
  expect(tracker.matchesCommittedMessage(messageObservation.messageId, "other", "assistant-1")).toBe(false);
  tracker.observeAssistantTurn("replacement");
  tracker.observeAssistantTurn("assistant-1");
  expect(match()).toBe(false);
  const proof = tracker.freezeCommittedProof();
  expect(proof.message?.conflicted).toBe(true);
});

test("message observer rejects a malformed ID even if a caller asserts UUID shape", () => {
  const tracker = messageTracker();
  tracker.observeCommittedMessage({ ...messageObservation, messageId: "not-a-uuid", uuidLike: true });
  expect(tracker.messageDiagnostic().hasCommittedMessage).toBe(false);
});

test("diagnostic per-field equalities remain visible despite sticky assistant conflict", () => {
  const tracker = messageTracker();
  expect(tracker.compareCommittedMessage(undefined, undefined, undefined).observed).toBe(false);
  tracker.observeCommittedMessage(messageObservation);
  tracker.observeAssistantTurn("remounted");
  expect(tracker.compareCommittedMessage(messageObservation.messageId, "document-1", "remounted")).toEqual({
    observed: true, messageIdEqual: true, documentIdEqual: true, assistantIdentityEqual: false, conflicted: true,
  });
  expect(tracker.matchesCommittedMessage(messageObservation.messageId, "document-1", "remounted")).toBe(false);
  expect(tracker.compareCommittedMessage("changed", "document-1", "remounted").messageIdEqual).toBe(false);
});

test("original wire mapping freezes with the proof and late observations cannot rewrite it", () => {
  const tracker = messageTracker();
  tracker.observeCommittedMessage(messageObservation);
  tracker.observeWireSnapshot({ conversationId: "conversation-1", assistantMessageId: messageObservation.messageId,
    assistantMessageConversationId: "conversation-1" });
  const proof = tracker.freezeCommittedProof();
  expect(proof.wireMessage).toEqual({ messageId: messageObservation.messageId, conversationId: "conversation-1", conflicted: false, unknown: false });
  tracker.observeWireSnapshot({ assistantMessageId: "late", assistantMessageConversationId: "other", assistantMessageIdentityConflict: true });
  expect(tracker.frozenSnapshot()).toEqual(proof);
  proof.wireMessage!.messageId = "mutated-copy";
  expect(tracker.frozenSnapshot()?.wireMessage?.messageId).toBe(messageObservation.messageId);
});

test("wire unknown, conflict and mismatched mapping cannot be repaired by an exact candidate", () => {
  for (const change of [{ assistantMessageIdentityUnknown: true }, { assistantMessageIdentityConflict: true },
    { assistantMessageId: "changed" }, { assistantMessageConversationId: "other" }]) {
    const tracker = messageTracker();
    const wire = { conversationId: "conversation-1", assistantMessageId: messageObservation.messageId,
      assistantMessageConversationId: "conversation-1" };
    tracker.observeWireSnapshot(wire);
    tracker.observeWireSnapshot({ ...wire, ...change });
    tracker.observeWireSnapshot(wire);
    expect(() => assertChatGptTurnRecoveryCandidate(tracker.freezeCommittedProof(), {
      surfaceId: "surface-1", documentId: "document-1", conversationId: "conversation-1",
      assistantTurnIdentity: "assistant-1", messageId: messageObservation.messageId,
    })).toThrow("wire message provenance");
  }
});

test("precommit rollback clears provisional wire mapping without importing a later conversation", () => {
  const tracker = messageTracker(false);
  tracker.observeWireSnapshot({ assistantMessageId: messageObservation.messageId, assistantMessageConversationId: "conversation-1" });
  tracker.resetAfterProvenRollback();
  tracker.commitSubmission();
  expect(tracker.freezeCommittedProof().wireMessage).toBeUndefined();
});

test("recovery identity collects only existing non-content turn identifiers", () => {
  const tracker = new ChatGptTurnRecoveryIdentityTracker("surface-1");
  tracker.observeDocument("document-1");
  tracker.observeAssistantTurn("conversation-turn-assistant-1");
  tracker.observeWireSnapshot({
    conversationId: "conversation-1",
    handoffTopicId: "conversation-turn-topic-1",
  });

  expect(tracker.snapshot()).toEqual({
    surfaceId: "surface-1",
    documentId: "document-1",
    conversationId: "conversation-1",
    assistantTurnIdentity: "conversation-turn-assistant-1",
    handoffTopicId: "conversation-turn-topic-1",
  });
  expect(tracker.diagnostic()).toEqual({
    hasSurfaceId: true,
    hasDocumentId: true,
    hasConversationId: true,
    hasAssistantTurnIdentity: true,
    hasHandoffTopicId: true,
    assistantTurnRebound: false,
    documentConflict: false,
    conversationConflict: false,
    handoffTopicConflict: false,
  });
});

test("wire identity keeps first provenance and records later conversation/topic disagreement", () => {
  const tracker = new ChatGptTurnRecoveryIdentityTracker();
  tracker.observeWireSnapshot({
    conversationId: "conversation-original",
    handoffTopicId: "conversation-turn-original",
  });
  tracker.observeWireSnapshot({
    conversationId: "conversation-other",
    handoffTopicId: "conversation-turn-other",
  });

  expect(tracker.snapshot()).toEqual({
    conversationId: "conversation-original",
    handoffTopicId: "conversation-turn-original",
  });
  expect(tracker.diagnostic()).toMatchObject({
    conversationConflict: true,
    handoffTopicConflict: true,
  });
});

test("a proven assistant DOM rebound updates current identity without pretending it was stable", () => {
  const tracker = new ChatGptTurnRecoveryIdentityTracker("surface-1");
  tracker.observeAssistantTurn("conversation-turn-1");
  tracker.observeAssistantTurn("conversation-turn-2");

  expect(tracker.snapshot().assistantTurnIdentity).toBe("conversation-turn-2");
  expect(tracker.diagnostic().assistantTurnRebound).toBeTrue();
});

test("privacy-safe recovery diagnostics never serialize the raw identifiers", () => {
  const tracker = new ChatGptTurnRecoveryIdentityTracker("private-surface-id");
  tracker.observeDocument("private-document-id");
  tracker.observeAssistantTurn("private-assistant-id");
  tracker.observeWireSnapshot({
    conversationId: "private-conversation-id",
    handoffTopicId: "private-handoff-topic",
  });

  const serialized = JSON.stringify(tracker.diagnostic());
  expect(serialized).not.toContain("private-surface-id");
  expect(serialized).not.toContain("private-document-id");
  expect(serialized).not.toContain("private-assistant-id");
  expect(serialized).not.toContain("private-conversation-id");
  expect(serialized).not.toContain("private-handoff-topic");
});

test("a proven pre-commit rollback clears provisional provenance but preserves the owned surface", () => {
  const tracker = new ChatGptTurnRecoveryIdentityTracker("surface-1");
  tracker.observeAssistantTurn("assistant-blocked-attempt");
  tracker.observeDocument("document-blocked-attempt");
  tracker.observeWireSnapshot({
    conversationId: "conversation-blocked-attempt",
    handoffTopicId: "topic-blocked-attempt",
  });
  tracker.observeWireSnapshot({ conversationId: "conversation-conflict" });

  tracker.resetAfterProvenRollback();

  expect(tracker.lifecycle()).toBe("provisional");
  expect(tracker.snapshot()).toEqual({ surfaceId: "surface-1" });
  expect(tracker.diagnostic()).toEqual({
    hasSurfaceId: true,
    hasDocumentId: false,
    hasConversationId: false,
    hasAssistantTurnIdentity: false,
    hasHandoffTopicId: false,
    assistantTurnRebound: false,
    documentConflict: false,
    conversationConflict: false,
    handoffTopicConflict: false,
  });
  expect(tracker.frozenSnapshot()).toBeUndefined();
});

test("incomplete committed identity freezes an immutable proof for later comparison", () => {
  const tracker = new ChatGptTurnRecoveryIdentityTracker("surface-1");
  tracker.observeDocument("document-1");
  tracker.observeAssistantTurn("assistant-1");
  tracker.commitSubmission();
  tracker.observeWireSnapshot({
    conversationId: "conversation-1",
    handoffTopicId: "topic-1",
  });

  const frozen = tracker.freezeCommittedProof();
  tracker.observeAssistantTurn("assistant-after-freeze");
  tracker.observeWireSnapshot({
    conversationId: "conversation-after-freeze",
    handoffTopicId: "topic-after-freeze",
  });

  expect(tracker.lifecycle()).toBe("frozen");
  expect(frozen.identity).toEqual({
    surfaceId: "surface-1",
    documentId: "document-1",
    conversationId: "conversation-1",
    assistantTurnIdentity: "assistant-1",
    handoffTopicId: "topic-1",
  });
  expect(tracker.snapshot()).toEqual(frozen.identity);
  expect(tracker.frozenSnapshot()).toEqual(frozen);
});

test("document identity keeps first provenance and records a later document replacement", () => {
  const tracker = new ChatGptTurnRecoveryIdentityTracker("surface-1");
  tracker.observeDocument("document-original");
  tracker.observeDocument("document-original");
  tracker.observeDocument("document-replaced");

  expect(tracker.snapshot().documentId).toBe("document-original");
  expect(tracker.diagnostic()).toMatchObject({
    hasDocumentId: true,
    documentConflict: true,
  });
});

test("recovery identity cannot roll back or freeze across the wrong submission boundary", () => {
  const provisional = new ChatGptTurnRecoveryIdentityTracker();
  expect(() => provisional.freezeCommittedProof()).toThrow("cannot freeze from phase provisional");

  const committed = new ChatGptTurnRecoveryIdentityTracker();
  committed.commitSubmission();
  expect(() => committed.resetAfterProvenRollback()).toThrow("cannot roll back from phase committed");
});

test("phase-2 recovery proof accepts only the exact committed surface, document, conversation, and assistant", () => {
  const tracker = new ChatGptTurnRecoveryIdentityTracker("surface-1");
  tracker.observeDocument("document-1");
  tracker.observeAssistantTurn("assistant-1");
  tracker.observeWireSnapshot({ conversationId: "conversation-1" });
  tracker.commitSubmission();
  const proof = tracker.freezeCommittedProof();
  const exact = {
    surfaceId: "surface-1",
    documentId: "document-1",
    conversationId: "conversation-1",
    assistantTurnIdentity: "assistant-1",
  };

  expect(() => assertChatGptTurnRecoveryCandidate(proof, exact)).not.toThrow();
  expect(() => assertChatGptTurnRecoveryCandidate(proof, { ...exact, surfaceId: "surface-2" }))
    .toThrow("surfaceId");
  expect(() => assertChatGptTurnRecoveryCandidate(proof, { ...exact, documentId: "document-2" }))
    .toThrow("documentId");
  expect(() => assertChatGptTurnRecoveryCandidate(proof, { ...exact, conversationId: "conversation-2" }))
    .toThrow("conversationId");
  expect(() => assertChatGptTurnRecoveryCandidate(proof, { ...exact, assistantTurnIdentity: "assistant-2" }))
    .toThrow("assistantTurnIdentity");
});

test("phase-2 recovery proof fails closed when core provenance is missing or conflicted", () => {
  const missingConversation = new ChatGptTurnRecoveryIdentityTracker("surface-1");
  missingConversation.observeDocument("document-1");
  missingConversation.observeAssistantTurn("assistant-1");
  missingConversation.commitSubmission();
  const missingProof = missingConversation.freezeCommittedProof();
  expect(() => assertChatGptTurnRecoveryCandidate(missingProof, {
    surfaceId: "surface-1",
    documentId: "document-1",
    conversationId: "conversation-1",
    assistantTurnIdentity: "assistant-1",
  })).toThrow("missing conversationId");

  const conflicted = new ChatGptTurnRecoveryIdentityTracker("surface-1");
  conflicted.observeDocument("document-1");
  conflicted.observeAssistantTurn("assistant-1");
  conflicted.observeWireSnapshot({ conversationId: "conversation-1" });
  conflicted.observeWireSnapshot({ conversationId: "conversation-2" });
  conflicted.commitSubmission();
  const conflictedProof = conflicted.freezeCommittedProof();
  expect(() => assertChatGptTurnRecoveryCandidate(conflictedProof, {
    surfaceId: "surface-1",
    documentId: "document-1",
    conversationId: "conversation-1",
    assistantTurnIdentity: "assistant-1",
  })).toThrow("conflicted");
});

test("a committed handoff topic becomes an exact phase-2 continuation identity", () => {
  const tracker = new ChatGptTurnRecoveryIdentityTracker("surface-1");
  tracker.observeDocument("document-1");
  tracker.observeAssistantTurn("assistant-1");
  tracker.observeWireSnapshot({
    conversationId: "conversation-1",
    handoffTopicId: "conversation-turn-topic-1",
  });
  tracker.commitSubmission();
  const proof = tracker.freezeCommittedProof();
  const exact = {
    surfaceId: "surface-1",
    documentId: "document-1",
    conversationId: "conversation-1",
    assistantTurnIdentity: "assistant-1",
    handoffTopicId: "conversation-turn-topic-1",
  };

  expect(() => assertChatGptTurnRecoveryCandidate(proof, exact)).not.toThrow();
  expect(() => assertChatGptTurnRecoveryCandidate(proof, { ...exact, handoffTopicId: undefined }))
    .toThrow("handoffTopicId");
  expect(() => assertChatGptTurnRecoveryCandidate(proof, {
    ...exact,
    handoffTopicId: "conversation-turn-topic-2",
  })).toThrow("handoffTopicId");
});
