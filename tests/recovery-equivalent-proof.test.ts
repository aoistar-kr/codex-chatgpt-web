import { expect, test } from "bun:test";
import {
  evaluateChatGptRecoveryEquivalentEvidence,
  evaluateChatGptRecoveryResumeEvidence,
  type ChatGptRecoveryEquivalentEvidenceInput,
  type ChatGptRecoveryResumeEvidenceInput,
} from "../src/adapters/chatgpt-web/recovery-equivalent-proof";
import type { ChatGptTurnRecoveryIdentityProof } from "../src/adapters/chatgpt-web/recovery-identity";

const messageId = "12345678-1234-4234-8234-123456789abc";
const proof = (): ChatGptTurnRecoveryIdentityProof => ({
  identity: {
    surfaceId: "surface", documentId: "document", conversationId: "conversation",
    assistantTurnIdentity: "conversation-turn-assistant",
  },
  diagnostic: {
    hasSurfaceId: true, hasDocumentId: true, hasConversationId: true, hasAssistantTurnIdentity: true,
    hasHandoffTopicId: false, assistantTurnRebound: false, documentConflict: false,
    conversationConflict: false, handoffTopicConflict: false,
  },
  wireMessage: { messageId, conversationId: "conversation", conflicted: false, unknown: false },
});

const exact = (): ChatGptRecoveryEquivalentEvidenceInput => ({
  proof: proof(), atomicDomProof: true, exactMessageAcrossRebind: true, freshUuidLike: true, freshCount: 1,
  wireMessageMappingPresent: true, wireMessageIdEqual: true, wireMessageMappingConflicted: false,
  wireMessageMappingUnknown: false, sameSurface: true, sameDocument: true, noExtraUser: true,
  sameAssistant: true, provenRebound: false, appConversationBindingExact: true,
  freshServerConversationReachable: true,
  generationTurnIdContinuity: {
    available: true, sameDocument: true, expired: false, turnIdObserved: true, turnIdConflict: false,
    validSnapshots: 8, invalidSnapshots: 0, assistantTransitions: 0, stableAssistantTransitions: 0,
    turnIdMutationRecords: 0, turnIdAbaRecords: 0, stable: true,
  },
  requestCountsAgree: true, postRebindMarkdownExact: true, markdownIdentityFence: true,
  domIdentityContinuityExact: true,
});

test("Temporary equivalent proof can match without early hydrated message or persisted detail and never authorizes recovery", () => {
  const result = evaluateChatGptRecoveryEquivalentEvidence(exact());
  expect(result).toEqual({ matched: true, reasons: [], recoveryAuthorized: false });
});

test("stable opaque turn continuity may prove a real assistant rebound but not an unobserved rebound", () => {
  const input = exact();
  input.proof!.diagnostic.assistantTurnRebound = true;
  input.generationTurnIdContinuity = {
    ...input.generationTurnIdContinuity!, assistantTransitions: 1, stableAssistantTransitions: 1,
  };
  expect(evaluateChatGptRecoveryEquivalentEvidence(input).matched).toBeTrue();
  input.generationTurnIdContinuity = {
    ...input.generationTurnIdContinuity!, assistantTransitions: 0, stableAssistantTransitions: 0,
  };
  expect(evaluateChatGptRecoveryEquivalentEvidence(input).reasons).toContain("ASSISTANT_REBOUND_UNPROVEN");
});

test("every independent equivalent-proof pillar fails closed", () => {
  const cases: Array<[Partial<ChatGptRecoveryEquivalentEvidenceInput>, string]> = [
    [{ proof: undefined }, "PROOF_MISSING"],
    [{ atomicDomProof: false }, "FRESH_DOM_PROOF_INVALID"],
    [{ exactMessageAcrossRebind: false }, "FRESH_MESSAGE_MISMATCH"],
    [{ wireMessageMappingPresent: false }, "WIRE_MAPPING_MISSING"],
    [{ wireMessageIdEqual: false }, "FRESH_MESSAGE_MISMATCH"],
    [{ wireMessageMappingConflicted: true }, "WIRE_MAPPING_CONFLICT"],
    [{ wireMessageMappingUnknown: true }, "WIRE_MAPPING_UNKNOWN"],
    [{ sameSurface: false }, "SURFACE_DOCUMENT_OWNERSHIP_MISMATCH"],
    [{ sameDocument: false }, "SURFACE_DOCUMENT_OWNERSHIP_MISMATCH"],
    [{ noExtraUser: false }, "SURFACE_DOCUMENT_OWNERSHIP_MISMATCH"],
    [{ appConversationBindingExact: false }, "APP_CONVERSATION_BINDING_MISSING"],
    [{ freshServerConversationReachable: false }, "FRESH_SERVER_REACHABILITY_MISSING"],
    [{ generationTurnIdContinuity: undefined }, "TURN_ID_CONTINUITY_MISSING"],
    [{ requestCountsAgree: false }, "REQUEST_COUNT_MISMATCH"],
    [{ postRebindMarkdownExact: false }, "MARKDOWN_PROOF_MISMATCH"],
    [{ markdownIdentityFence: false }, "MARKDOWN_PROOF_MISMATCH"],
    [{ domIdentityContinuityExact: false }, "DOM_CONTINUITY_MISMATCH"],
  ];
  for (const [change, reason] of cases) {
    const result = evaluateChatGptRecoveryEquivalentEvidence({ ...exact(), ...change });
    expect(result.matched).toBeFalse();
    expect(result.reasons).toContain(reason as never);
  }
});

test("turn-id expiry conflict invalid snapshot and mutation/ABA all fail closed", () => {
  const changes = [
    { expired: true }, { turnIdConflict: true }, { sameDocument: false }, { stable: false },
    { validSnapshots: 1 }, { invalidSnapshots: 1 }, { turnIdMutationRecords: 1 }, { turnIdAbaRecords: 1 },
    { assistantTransitions: 1, stableAssistantTransitions: 0 },
  ];
  for (const change of changes) {
    const input = exact();
    input.generationTurnIdContinuity = { ...input.generationTurnIdContinuity!, ...change };
    expect(evaluateChatGptRecoveryEquivalentEvidence(input).matched).toBeFalse();
  }
});

test("wire conversation mismatch handoff and conflicting postcommit provenance cannot be waived", () => {
  const input = exact();
  input.proof!.wireMessage!.conversationId = "other";
  expect(evaluateChatGptRecoveryEquivalentEvidence(input).reasons).toContain("WIRE_CONVERSATION_MISMATCH");
  const handoff = exact();
  handoff.proof!.identity.handoffTopicId = "topic";
  handoff.proof!.diagnostic.hasHandoffTopicId = true;
  expect(evaluateChatGptRecoveryEquivalentEvidence(handoff).reasons).toContain("PROOF_HANDOFF_UNSUPPORTED");
  const postcommit = exact();
  postcommit.proof!.message = {
    messageId, documentId: "document", assistantTurnIdentity: "conversation-turn-assistant",
    observedAfterCommit: true, conflicted: true,
  };
  expect(evaluateChatGptRecoveryEquivalentEvidence(postcommit).reasons).toContain("POST_COMMIT_MESSAGE_CONFLICT");
});

test("production observation-resume gate authorizes only same-turn continuation and never prompt replay", () => {
  const base = exact();
  const result = evaluateChatGptRecoveryResumeEvidence({
    proof: base.proof,
    atomicDomProof: true, freshUuidLike: true, freshCount: 1, freshMessageMatchesOriginal: true,
    sameSurface: true, sameDocument: true, noExtraUser: true, sameAssistant: true, provenRebound: false,
    appConversationBindingExact: true, freshServerConversationReachable: true,
    generationTurnIdContinuity: base.generationTurnIdContinuity,
    requestCountsAgree: true, browserWideRequestCountExact: true,
    freshMarkdownCompatible: true, freshSnapshotFenceExact: true,
  });
  expect(result).toEqual({ matched: true, reasons: [], observationResumeAuthorized: true, promptReplayAuthorized: false });
});

test("production observation-resume gate fails each fresh continuation pillar closed", () => {
  const base = exact();
  const input: ChatGptRecoveryResumeEvidenceInput = {
    proof: base.proof,
    atomicDomProof: true, freshUuidLike: true, freshCount: 1, freshMessageMatchesOriginal: true,
    sameSurface: true, sameDocument: true, noExtraUser: true, sameAssistant: true, provenRebound: false,
    appConversationBindingExact: true, freshServerConversationReachable: true,
    generationTurnIdContinuity: base.generationTurnIdContinuity,
    requestCountsAgree: true, browserWideRequestCountExact: true,
    freshMarkdownCompatible: true, freshSnapshotFenceExact: true,
  };
  const cases = [
    ["atomicDomProof", false, "FRESH_DOM_PROOF_INVALID"],
    ["freshMessageMatchesOriginal", false, "FRESH_MESSAGE_MISMATCH"],
    ["sameSurface", false, "SURFACE_DOCUMENT_OWNERSHIP_MISMATCH"],
    ["sameDocument", false, "SURFACE_DOCUMENT_OWNERSHIP_MISMATCH"],
    ["noExtraUser", false, "SURFACE_DOCUMENT_OWNERSHIP_MISMATCH"],
    ["appConversationBindingExact", false, "APP_CONVERSATION_BINDING_MISSING"],
    ["freshServerConversationReachable", false, "FRESH_SERVER_REACHABILITY_MISSING"],
    ["requestCountsAgree", false, "REQUEST_COUNT_MISMATCH"],
    ["browserWideRequestCountExact", false, "BROWSER_WIDE_REQUEST_COUNT_MISMATCH"],
    ["freshMarkdownCompatible", false, "FRESH_MARKDOWN_INCOMPATIBLE"],
    ["freshSnapshotFenceExact", false, "FRESH_SNAPSHOT_FENCE_MISMATCH"],
  ] as const;
  for (const [key, value, reason] of cases) {
    const result = evaluateChatGptRecoveryResumeEvidence({ ...input, [key]: value });
    expect(result.observationResumeAuthorized).toBeFalse();
    expect(result.promptReplayAuthorized).toBeFalse();
    expect(result.reasons).toContain(reason);
  }
});

test("production observation-resume gate rejects missing/conflicting original wire provenance", () => {
  const base = exact();
  const input = {
    proof: base.proof,
    atomicDomProof: true, freshUuidLike: true, freshCount: 1, freshMessageMatchesOriginal: true,
    sameSurface: true, sameDocument: true, noExtraUser: true, sameAssistant: true, provenRebound: false,
    appConversationBindingExact: true, freshServerConversationReachable: true,
    generationTurnIdContinuity: base.generationTurnIdContinuity,
    requestCountsAgree: true, browserWideRequestCountExact: true,
    freshMarkdownCompatible: true, freshSnapshotFenceExact: true,
  };
  const missing: ChatGptRecoveryResumeEvidenceInput = { ...input, proof: proof() };
  delete missing.proof!.wireMessage;
  expect(evaluateChatGptRecoveryResumeEvidence(missing).reasons).toContain("WIRE_MAPPING_MISSING");

  const conflict: ChatGptRecoveryResumeEvidenceInput = { ...input, proof: proof() };
  conflict.proof!.wireMessage!.conflicted = true;
  expect(evaluateChatGptRecoveryResumeEvidence(conflict).reasons).toContain("WIRE_MAPPING_CONFLICT");

  const handoff: ChatGptRecoveryResumeEvidenceInput = { ...input, proof: proof() };
  handoff.proof!.identity.handoffTopicId = "topic";
  handoff.proof!.diagnostic.hasHandoffTopicId = true;
  expect(evaluateChatGptRecoveryResumeEvidence(handoff).reasons).toContain("PROOF_HANDOFF_UNSUPPORTED");
});
