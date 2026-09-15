import { expect, test } from "bun:test";

import {
  assertChatGptTurnRecoveryCandidate,
  ChatGptTurnRecoveryIdentityTracker,
  evaluateChatGptTurnRecoveryEvidence,
  type ChatGptTurnRecoveryCandidate,
  type ChatGptTurnRecoveryEvidenceReason,
  type ChatGptTurnRecoveryIdentityProof,
} from "../src/adapters/chatgpt-web/recovery-identity";

const messageId = "12345678-1234-4234-8234-123456789abc";
function fixture(): { proof: ChatGptTurnRecoveryIdentityProof; candidate: ChatGptTurnRecoveryCandidate } {
  return {
    proof: {
      identity: { surfaceId: "surface-private", documentId: "document-private", conversationId: "conversation-private", assistantTurnIdentity: "assistant-private" },
      diagnostic: {
        hasSurfaceId: true, hasDocumentId: true, hasConversationId: true, hasAssistantTurnIdentity: true,
        hasHandoffTopicId: false, assistantTurnRebound: false, documentConflict: false,
        conversationConflict: false, handoffTopicConflict: false,
      },
      message: { messageId, documentId: "document-private", assistantTurnIdentity: "assistant-private", observedAfterCommit: true, conflicted: false },
      wireMessage: { messageId, conversationId: "conversation-private", conflicted: false, unknown: false },
    },
    candidate: { surfaceId: "surface-private", documentId: "document-private", conversationId: "conversation-private", assistantTurnIdentity: "assistant-private", messageId },
  };
}

function expectReason(proof: ChatGptTurnRecoveryIdentityProof, candidate: Partial<ChatGptTurnRecoveryCandidate>, reason: ChatGptTurnRecoveryEvidenceReason) {
  const result = evaluateChatGptTurnRecoveryEvidence(proof, candidate);
  expect(result.matched).toBeFalse();
  expect(result.recoveryAuthorized).toBeFalse();
  expect(result.reasons).toContain(reason);
  expect(new Set(result.reasons).size).toBe(result.reasons.length);
}

test("complete exact evidence matches diagnostically but never authorizes recovery", () => {
  const { proof, candidate } = fixture();
  expect(evaluateChatGptTurnRecoveryEvidence(proof, candidate)).toEqual({ matched: true, reasons: [], recoveryAuthorized: false });
});

test("every core identity has independent missing-proof missing-fresh and mismatch reasons", () => {
  const cases = [
    ["surfaceId", "hasSurfaceId", "PROOF_SURFACE_MISSING", "FRESH_SURFACE_MISSING", "SURFACE_MISMATCH"],
    ["documentId", "hasDocumentId", "PROOF_DOCUMENT_MISSING", "FRESH_DOCUMENT_MISSING", "DOCUMENT_MISMATCH"],
    ["conversationId", "hasConversationId", "PROOF_CONVERSATION_MISSING", "FRESH_CONVERSATION_MISSING", "CONVERSATION_MISMATCH"],
    ["assistantTurnIdentity", "hasAssistantTurnIdentity", "PROOF_ASSISTANT_MISSING", "FRESH_ASSISTANT_MISSING", "ASSISTANT_MISMATCH"],
  ] as const;
  for (const [key, has, missingProof, missingFresh, mismatch] of cases) {
    const missing = fixture();
    delete missing.proof.identity[key];
    missing.proof.diagnostic[has] = false;
    expectReason(missing.proof, missing.candidate, missingProof);
    for (const value of [undefined, "", "   "]) {
      const fresh = fixture();
      expectReason(fresh.proof, { ...fresh.candidate, [key]: value }, missingFresh);
    }
    const wrong = fixture();
    expectReason(wrong.proof, { ...wrong.candidate, [key]: "other-private-value" }, mismatch);
  }
});

test("all sticky conflicts and assistant rebound reject even exact present identifiers", () => {
  for (const [flag, reason] of [
    ["documentConflict", "DOCUMENT_CONFLICT"], ["conversationConflict", "CONVERSATION_CONFLICT"],
    ["handoffTopicConflict", "HANDOFF_CONFLICT"], ["assistantTurnRebound", "ASSISTANT_REBOUND"],
  ] as const) {
    const { proof, candidate } = fixture();
    proof.diagnostic[flag] = true;
    expectReason(proof, candidate, reason);
  }
});

test("diagnostic presence flags and malformed conflict flags cannot contradict the proof", () => {
  for (const flag of ["hasSurfaceId", "hasDocumentId", "hasConversationId", "hasAssistantTurnIdentity", "hasHandoffTopicId"] as const) {
    const { proof, candidate } = fixture();
    proof.diagnostic[flag] = !proof.diagnostic[flag];
    expectReason(proof, candidate, "PROOF_DIAGNOSTIC_MISMATCH");
  }
  const { proof, candidate } = fixture();
  delete (proof.diagnostic as Partial<typeof proof.diagnostic>).documentConflict;
  expectReason(proof, candidate, "PROOF_DIAGNOSTIC_MISMATCH");
});

test("postcommit DOM provenance is required qualified and internally consistent", () => {
  const missing = fixture();
  delete missing.proof.message;
  expectReason(missing.proof, missing.candidate, "POST_COMMIT_MESSAGE_MISSING");
  for (const change of [
    { messageId: "" }, { messageId: "not-a-uuid" }, { documentId: "" }, { assistantTurnIdentity: "" },
    { observedAfterCommit: false }, { conflicted: undefined },
  ]) {
    const { proof, candidate } = fixture();
    Object.assign(proof.message!, change);
    expectReason(proof, candidate, "POST_COMMIT_MESSAGE_INVALID");
  }
  for (const [change, reason] of [
    [{ conflicted: true }, "POST_COMMIT_MESSAGE_CONFLICT"],
    [{ documentId: "other-private" }, "POST_COMMIT_DOCUMENT_MISMATCH"],
    [{ assistantTurnIdentity: "other-private" }, "POST_COMMIT_ASSISTANT_MISMATCH"],
  ] as const) {
    const { proof, candidate } = fixture();
    Object.assign(proof.message!, change);
    expectReason(proof, candidate, reason);
  }
});

test("original wire mapping is required complete unambiguous and consistent with both original sources", () => {
  const missing = fixture();
  delete missing.proof.wireMessage;
  expectReason(missing.proof, missing.candidate, "ORIGINAL_WIRE_MAPPING_MISSING");
  for (const change of [{ messageId: "" }, { conversationId: "" }, { conflicted: undefined }, { unknown: undefined }]) {
    const { proof, candidate } = fixture();
    Object.assign(proof.wireMessage!, change);
    expectReason(proof, candidate, "ORIGINAL_WIRE_MAPPING_INVALID");
  }
  for (const [change, reason] of [
    [{ conflicted: true }, "ORIGINAL_WIRE_MAPPING_CONFLICT"],
    [{ unknown: true }, "ORIGINAL_WIRE_MAPPING_UNKNOWN"],
    [{ conversationId: "other-private" }, "ORIGINAL_WIRE_CONVERSATION_MISMATCH"],
    [{ messageId: "other-private" }, "ORIGINAL_WIRE_MESSAGE_MISMATCH"],
  ] as const) {
    const { proof, candidate } = fixture();
    Object.assign(proof.wireMessage!, change);
    expectReason(proof, candidate, reason);
  }
});

test("fresh message must exist and match both original DOM and wire messages", () => {
  const { proof, candidate } = fixture();
  for (const value of [undefined, "", "   "]) expectReason(proof, { ...candidate, messageId: value }, "FRESH_MESSAGE_MISSING");
  expectReason(proof, { ...candidate, messageId: "other-private" }, "MESSAGE_MISMATCH");
  proof.wireMessage!.messageId = "other-private";
  expectReason(proof, candidate, "MESSAGE_MISMATCH");
  expectReason(proof, { ...candidate, messageId: "other-private" }, "MESSAGE_MISMATCH");
});

test("optional original handoff becomes mandatory exact evidence only when originally present", () => {
  const { proof, candidate } = fixture();
  expect(evaluateChatGptTurnRecoveryEvidence(proof, { ...candidate, handoffTopicId: "not-original" }).matched).toBeTrue();
  proof.identity.handoffTopicId = "handoff-private";
  proof.diagnostic.hasHandoffTopicId = true;
  expectReason(proof, candidate, "FRESH_HANDOFF_MISSING");
  expectReason(proof, { ...candidate, handoffTopicId: "wrong-private" }, "HANDOFF_MISMATCH");
  expect(evaluateChatGptTurnRecoveryEvidence(proof, { ...candidate, handoffTopicId: "handoff-private" }).matched).toBeTrue();
  proof.identity.handoffTopicId = "";
  expectReason(proof, candidate, "PROOF_HANDOFF_INVALID");
});

test("original wire conversation never fills a missing fresh conversation or excuses a copied message", () => {
  const { proof, candidate } = fixture();
  const partial: Partial<ChatGptTurnRecoveryCandidate> = { ...candidate };
  delete partial.conversationId;
  const result = evaluateChatGptTurnRecoveryEvidence(proof, partial);
  expect(result.reasons).toEqual(["FRESH_CONVERSATION_MISSING"]);
  expect(partial.conversationId).toBeUndefined();
  expectReason(proof, { ...candidate, conversationId: "copy-in-another-conversation" }, "CONVERSATION_MISMATCH");
});

test("pure evidence result has fixed content-free reasons and does not mutate frozen inputs", () => {
  const { proof, candidate } = fixture();
  for (const value of [proof.identity, proof.diagnostic, proof.message!, proof.wireMessage!, proof, candidate]) Object.freeze(value);
  const before = JSON.stringify({ proof, candidate });
  expect(evaluateChatGptTurnRecoveryEvidence(proof, candidate).matched).toBeTrue();
  const wrong = Object.freeze({ ...candidate, surfaceId: "secret-replacement" });
  const first = evaluateChatGptTurnRecoveryEvidence(proof, wrong);
  const second = evaluateChatGptTurnRecoveryEvidence(proof, wrong);
  expect(first).toEqual(second);
  first.reasons.length = 0;
  expect(second.reasons).toEqual(["SURFACE_MISMATCH"]);
  expect(JSON.stringify({ proof, candidate })).toBe(before);
  expect(JSON.stringify(second)).not.toMatch(/private|secret|12345678/);
});

test("diagnostic evaluator is stricter without changing legacy assertion semantics", () => {
  const { proof, candidate } = fixture();
  delete proof.message;
  delete proof.wireMessage;
  expect(() => assertChatGptTurnRecoveryCandidate(proof, candidate)).not.toThrow();
  expect(evaluateChatGptTurnRecoveryEvidence(proof, candidate)).toEqual({
    matched: false, reasons: ["POST_COMMIT_MESSAGE_MISSING", "ORIGINAL_WIRE_MAPPING_MISSING"], recoveryAuthorized: false,
  });
});

function committedTracker() {
  const tracker = new ChatGptTurnRecoveryIdentityTracker("surface-private");
  tracker.observeDocument("document-private");
  tracker.observeAssistantTurn("assistant-private");
  tracker.observeWireSnapshot({ conversationId: "conversation-private", assistantMessageId: messageId,
    assistantMessageConversationId: "conversation-private" });
  return tracker;
}

test("committedSnapshot does not commit or freeze and returns fresh deep-enough defensive copies", () => {
  const tracker = committedTracker();
  expect(tracker.committedSnapshot()).toBeUndefined();
  expect(tracker.lifecycle()).toBe("provisional");
  tracker.commitSubmission();
  tracker.observeCommittedMessage({ messageId, documentId: "document-private", assistantTurnIdentity: "assistant-private",
    count: 1, documentMatches: 1, uuidLike: true });
  const first = tracker.committedSnapshot()!;
  const original = structuredClone(first);
  expect(tracker.lifecycle()).toBe("committed");
  expect(tracker.frozenSnapshot()).toBeUndefined();
  first.identity.conversationId = "mutated";
  first.diagnostic.conversationConflict = true;
  first.message!.messageId = "mutated";
  first.wireMessage!.unknown = true;
  expect(tracker.committedSnapshot()).toEqual(original);
  expect(evaluateChatGptTurnRecoveryEvidence(tracker.committedSnapshot()!, fixture().candidate).matched).toBeTrue();
  tracker.observeWireSnapshot({ conversationId: "different-later" });
  expect(tracker.committedSnapshot()!.diagnostic.conversationConflict).toBeTrue();
  expect(original.diagnostic.conversationConflict).toBeFalse();
});

test("committedSnapshot of frozen tracker preserves frozen provenance and ignores late observations", () => {
  const tracker = committedTracker();
  tracker.commitSubmission();
  const frozen = tracker.freezeCommittedProof();
  const copy = tracker.committedSnapshot()!;
  copy.identity.conversationId = "mutated";
  copy.diagnostic.documentConflict = true;
  copy.wireMessage!.messageId = "mutated";
  tracker.observeDocument("late-document");
  tracker.observeWireSnapshot({ conversationId: "late-conversation" });
  expect(tracker.committedSnapshot()).toEqual(frozen);
  expect(tracker.lifecycle()).toBe("frozen");
});
