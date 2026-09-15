import type { ChatGptTurnRecoveryIdentityProof } from "./recovery-identity";
import type { ChatGptRecoveryTurnIdMutationContinuityResult } from "./recovery-turn-id-continuity";

/** Fixed, content-free reasons for the Temporary-Chat equivalent proof path. */
export type ChatGptRecoveryEquivalentEvidenceReason =
  | "PROOF_MISSING"
  | "PROOF_CORE_MISSING"
  | "PROOF_CONFLICT"
  | "PROOF_HANDOFF_UNSUPPORTED"
  | "WIRE_MAPPING_MISSING"
  | "WIRE_MAPPING_INVALID"
  | "WIRE_MAPPING_CONFLICT"
  | "WIRE_MAPPING_UNKNOWN"
  | "WIRE_CONVERSATION_MISMATCH"
  | "POST_COMMIT_MESSAGE_CONFLICT"
  | "POST_COMMIT_MESSAGE_MISMATCH"
  | "FRESH_DOM_PROOF_INVALID"
  | "FRESH_MESSAGE_MISMATCH"
  | "SURFACE_DOCUMENT_OWNERSHIP_MISMATCH"
  | "APP_CONVERSATION_BINDING_MISSING"
  | "FRESH_SERVER_REACHABILITY_MISSING"
  | "TURN_ID_CONTINUITY_MISSING"
  | "TURN_ID_CONTINUITY_EXPIRED"
  | "TURN_ID_CONTINUITY_CONFLICT"
  | "TURN_ID_CONTINUITY_INVALID"
  | "ASSISTANT_REBOUND_UNPROVEN"
  | "REQUEST_COUNT_MISMATCH"
  | "BROWSER_WIDE_REQUEST_COUNT_MISMATCH"
  | "MARKDOWN_PROOF_MISMATCH"
  | "DOM_CONTINUITY_MISMATCH";

export interface ChatGptRecoveryEquivalentEvidenceInput {
  proof?: ChatGptTurnRecoveryIdentityProof;
  atomicDomProof: boolean;
  exactMessageAcrossRebind: boolean;
  freshUuidLike: boolean;
  freshCount: number;
  wireMessageMappingPresent: boolean;
  wireMessageIdEqual: boolean;
  wireMessageMappingConflicted: boolean;
  wireMessageMappingUnknown: boolean;
  sameSurface: boolean;
  sameDocument: boolean;
  noExtraUser: boolean;
  sameAssistant: boolean;
  provenRebound: boolean;
  appConversationBindingExact: boolean;
  freshServerConversationReachable: boolean;
  generationTurnIdContinuity?: ChatGptRecoveryTurnIdMutationContinuityResult;
  requestCountsAgree: boolean;
  postRebindMarkdownExact: boolean;
  markdownIdentityFence: boolean;
  domIdentityContinuityExact: boolean;
}

export interface ChatGptRecoveryEquivalentEvidenceEvaluation {
  matched: boolean;
  reasons: ChatGptRecoveryEquivalentEvidenceReason[];
  recoveryAuthorized: false;
}

export type ChatGptRecoveryResumeEvidenceReason = ChatGptRecoveryEquivalentEvidenceReason
  | "FRESH_MARKDOWN_INCOMPATIBLE"
  | "FRESH_SNAPSHOT_FENCE_MISMATCH";

export interface ChatGptRecoveryResumeEvidenceInput {
  proof?: ChatGptTurnRecoveryIdentityProof;
  atomicDomProof: boolean;
  freshUuidLike: boolean;
  freshCount: number;
  freshMessageMatchesOriginal: boolean;
  sameSurface: boolean;
  sameDocument: boolean;
  noExtraUser: boolean;
  sameAssistant: boolean;
  provenRebound: boolean;
  appConversationBindingExact: boolean;
  freshServerConversationReachable: boolean;
  generationTurnIdContinuity?: ChatGptRecoveryTurnIdMutationContinuityResult;
  requestCountsAgree: boolean;
  browserWideRequestCountExact: boolean;
  freshMarkdownCompatible: boolean;
  freshSnapshotFenceExact: boolean;
}

export interface ChatGptRecoveryResumeEvidenceEvaluation {
  matched: boolean;
  reasons: ChatGptRecoveryResumeEvidenceReason[];
  observationResumeAuthorized: boolean;
  promptReplayAuthorized: false;
}

const present = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

/**
 * Strict diagnostic alternative for Temporary Chats whose persisted conversation-detail endpoint
 * returns 404. It joins independent page-generated+server-acknowledged conversation binding with
 * original wire (conversation,message), generation-through-rebind opaque turn continuity, and the
 * fresh unique DOM message. It never authorizes recovery and never makes the missing history-detail
 * endpoint look successful.
 */
export function evaluateChatGptRecoveryEquivalentEvidence(
  input: ChatGptRecoveryEquivalentEvidenceInput,
): ChatGptRecoveryEquivalentEvidenceEvaluation {
  const reasons = new Set<ChatGptRecoveryEquivalentEvidenceReason>();
  const proof = input.proof;
  if (!proof) {
    reasons.add("PROOF_MISSING");
    return { matched: false, reasons: [...reasons], recoveryAuthorized: false };
  }

  const { identity, diagnostic, message, wireMessage } = proof;
  if (!present(identity.surfaceId) || !present(identity.documentId) || !present(identity.conversationId)
    || !present(identity.assistantTurnIdentity)
    || diagnostic.hasSurfaceId !== true || diagnostic.hasDocumentId !== true
    || diagnostic.hasConversationId !== true || diagnostic.hasAssistantTurnIdentity !== true) {
    reasons.add("PROOF_CORE_MISSING");
  }
  if (diagnostic.documentConflict || diagnostic.conversationConflict || diagnostic.handoffTopicConflict) {
    reasons.add("PROOF_CONFLICT");
  }
  // The equivalent path has no independent fresh handoff-topic source. Never silently copy one.
  if (identity.handoffTopicId !== undefined || diagnostic.hasHandoffTopicId) reasons.add("PROOF_HANDOFF_UNSUPPORTED");

  if (!wireMessage || !input.wireMessageMappingPresent) reasons.add("WIRE_MAPPING_MISSING");
  else {
    if (!present(wireMessage.messageId) || !present(wireMessage.conversationId)
      || typeof wireMessage.conflicted !== "boolean" || typeof wireMessage.unknown !== "boolean") {
      reasons.add("WIRE_MAPPING_INVALID");
    }
    if (wireMessage.conflicted || input.wireMessageMappingConflicted) reasons.add("WIRE_MAPPING_CONFLICT");
    if (wireMessage.unknown || input.wireMessageMappingUnknown) reasons.add("WIRE_MAPPING_UNKNOWN");
    if (wireMessage.conversationId !== identity.conversationId) reasons.add("WIRE_CONVERSATION_MISMATCH");
  }

  // A post-commit UUID observation is supplemental when it exists. Missing is allowed only because
  // generation-time data-message-id is known to hydrate late; conflict/mismatch is never ignored.
  if (message?.conflicted) reasons.add("POST_COMMIT_MESSAGE_CONFLICT");
  if (message && (message.documentId !== identity.documentId
    || message.assistantTurnIdentity !== identity.assistantTurnIdentity
    || (wireMessage && message.messageId !== wireMessage.messageId))) {
    reasons.add("POST_COMMIT_MESSAGE_MISMATCH");
  }

  if (!input.atomicDomProof || !input.freshUuidLike || input.freshCount !== 1) reasons.add("FRESH_DOM_PROOF_INVALID");
  if (!input.exactMessageAcrossRebind || !input.wireMessageIdEqual) reasons.add("FRESH_MESSAGE_MISMATCH");
  if (!input.sameSurface || !input.sameDocument || !input.noExtraUser) reasons.add("SURFACE_DOCUMENT_OWNERSHIP_MISMATCH");
  if (!input.appConversationBindingExact) reasons.add("APP_CONVERSATION_BINDING_MISSING");
  if (!input.freshServerConversationReachable) reasons.add("FRESH_SERVER_REACHABILITY_MISSING");

  const continuity = input.generationTurnIdContinuity;
  if (!continuity || !continuity.available || !continuity.turnIdObserved) reasons.add("TURN_ID_CONTINUITY_MISSING");
  else {
    if (continuity.expired) reasons.add("TURN_ID_CONTINUITY_EXPIRED");
    if (continuity.turnIdConflict || continuity.turnIdAbaRecords > 0 || continuity.turnIdMutationRecords > 0) {
      reasons.add("TURN_ID_CONTINUITY_CONFLICT");
    }
    if (!continuity.sameDocument || !continuity.stable || continuity.validSnapshots < 2
      || continuity.invalidSnapshots !== 0
      || continuity.stableAssistantTransitions !== continuity.assistantTransitions) {
      reasons.add("TURN_ID_CONTINUITY_INVALID");
    }
    if ((diagnostic.assistantTurnRebound || input.provenRebound || !input.sameAssistant)
      && (continuity.assistantTransitions < 1
        || continuity.stableAssistantTransitions !== continuity.assistantTransitions)) {
      reasons.add("ASSISTANT_REBOUND_UNPROVEN");
    }
  }

  if (!input.requestCountsAgree) reasons.add("REQUEST_COUNT_MISMATCH");
  if (!input.postRebindMarkdownExact || !input.markdownIdentityFence) reasons.add("MARKDOWN_PROOF_MISMATCH");
  if (!input.domIdentityContinuityExact) reasons.add("DOM_CONTINUITY_MISMATCH");

  return { matched: reasons.size === 0, reasons: [...reasons], recoveryAuthorized: false };
}

/**
 * Production phase-2 gate for resuming observation of an already committed turn. This deliberately
 * does NOT require a persisted Temporary-chat history record (live currently returns 404), and it
 * does NOT allow prompt replay. The generation turn-id observer itself spans the failure/rebind and
 * therefore supplies the continuity proof that a post-failure DOM observer could not establish.
 */
export function evaluateChatGptRecoveryResumeEvidence(
  input: ChatGptRecoveryResumeEvidenceInput,
): ChatGptRecoveryResumeEvidenceEvaluation {
  const reasons = new Set<ChatGptRecoveryResumeEvidenceReason>();
  const proof = input.proof;
  if (!proof) {
    reasons.add("PROOF_MISSING");
    return { matched: false, reasons: [...reasons], observationResumeAuthorized: false, promptReplayAuthorized: false };
  }
  const { identity, diagnostic, message, wireMessage } = proof;
  if (!present(identity.surfaceId) || !present(identity.documentId) || !present(identity.conversationId)
    || !present(identity.assistantTurnIdentity)
    || diagnostic.hasSurfaceId !== true || diagnostic.hasDocumentId !== true
    || diagnostic.hasConversationId !== true || diagnostic.hasAssistantTurnIdentity !== true) {
    reasons.add("PROOF_CORE_MISSING");
  }
  if (diagnostic.documentConflict || diagnostic.conversationConflict || diagnostic.handoffTopicConflict) reasons.add("PROOF_CONFLICT");
  if (identity.handoffTopicId !== undefined || diagnostic.hasHandoffTopicId) reasons.add("PROOF_HANDOFF_UNSUPPORTED");
  if (!wireMessage) reasons.add("WIRE_MAPPING_MISSING");
  else {
    if (!present(wireMessage.messageId) || !present(wireMessage.conversationId)
      || typeof wireMessage.conflicted !== "boolean" || typeof wireMessage.unknown !== "boolean") reasons.add("WIRE_MAPPING_INVALID");
    if (wireMessage.conflicted) reasons.add("WIRE_MAPPING_CONFLICT");
    if (wireMessage.unknown) reasons.add("WIRE_MAPPING_UNKNOWN");
    if (wireMessage.conversationId !== identity.conversationId) reasons.add("WIRE_CONVERSATION_MISMATCH");
  }
  if (message?.conflicted) reasons.add("POST_COMMIT_MESSAGE_CONFLICT");
  if (message && (message.documentId !== identity.documentId || message.assistantTurnIdentity !== identity.assistantTurnIdentity
    || (wireMessage && message.messageId !== wireMessage.messageId))) reasons.add("POST_COMMIT_MESSAGE_MISMATCH");

  if (!input.atomicDomProof || !input.freshUuidLike || input.freshCount !== 1) reasons.add("FRESH_DOM_PROOF_INVALID");
  if (!input.freshMessageMatchesOriginal) reasons.add("FRESH_MESSAGE_MISMATCH");
  if (!input.sameSurface || !input.sameDocument || !input.noExtraUser) reasons.add("SURFACE_DOCUMENT_OWNERSHIP_MISMATCH");
  if (!input.appConversationBindingExact) reasons.add("APP_CONVERSATION_BINDING_MISSING");
  if (!input.freshServerConversationReachable) reasons.add("FRESH_SERVER_REACHABILITY_MISSING");

  const continuity = input.generationTurnIdContinuity;
  if (!continuity || !continuity.available || !continuity.turnIdObserved) reasons.add("TURN_ID_CONTINUITY_MISSING");
  else {
    if (continuity.expired) reasons.add("TURN_ID_CONTINUITY_EXPIRED");
    if (continuity.turnIdConflict || continuity.turnIdMutationRecords > 0 || continuity.turnIdAbaRecords > 0) {
      reasons.add("TURN_ID_CONTINUITY_CONFLICT");
    }
    if (!continuity.sameDocument || !continuity.stable || continuity.validSnapshots < 2 || continuity.invalidSnapshots !== 0
      || continuity.stableAssistantTransitions !== continuity.assistantTransitions) reasons.add("TURN_ID_CONTINUITY_INVALID");
    if ((diagnostic.assistantTurnRebound || input.provenRebound || !input.sameAssistant)
      && (continuity.assistantTransitions < 1 || continuity.stableAssistantTransitions !== continuity.assistantTransitions)) {
      reasons.add("ASSISTANT_REBOUND_UNPROVEN");
    }
  }
  if (!input.requestCountsAgree) reasons.add("REQUEST_COUNT_MISMATCH");
  if (!input.browserWideRequestCountExact) reasons.add("BROWSER_WIDE_REQUEST_COUNT_MISMATCH");
  if (!input.freshMarkdownCompatible) reasons.add("FRESH_MARKDOWN_INCOMPATIBLE");
  if (!input.freshSnapshotFenceExact) reasons.add("FRESH_SNAPSHOT_FENCE_MISMATCH");
  const matched = reasons.size === 0;
  return { matched, reasons: [...reasons], observationResumeAuthorized: matched, promptReplayAuthorized: false };
}
