import type { ChatGptWireSnapshot } from "./web-stream-tap";

/**
 * Non-content identifiers that can prove which already-committed ChatGPT turn a later observer
 * belongs to. H5 phase 1 records these only for diagnostics; it does not authorize recovery.
 */
export interface ChatGptTurnRecoveryIdentity {
  surfaceId?: string;
  documentId?: string;
  conversationId?: string;
  assistantTurnIdentity?: string;
  handoffTopicId?: string;
}

export interface ChatGptTurnRecoveryIdentityDiagnostic {
  hasSurfaceId: boolean;
  hasDocumentId: boolean;
  hasConversationId: boolean;
  hasAssistantTurnIdentity: boolean;
  hasHandoffTopicId: boolean;
  assistantTurnRebound: boolean;
  documentConflict: boolean;
  conversationConflict: boolean;
  handoffTopicConflict: boolean;
}

export type ChatGptTurnRecoveryIdentityPhase = "provisional" | "committed" | "frozen";

export interface ChatGptTurnRecoveryIdentityProof {
  identity: ChatGptTurnRecoveryIdentity;
  diagnostic: ChatGptTurnRecoveryIdentityDiagnostic;
  /** Supplemental post-commit DOM provenance, never a replacement for conversation identity. */
  message?: ChatGptCommittedMessageProvenance;
  wireMessage?: { messageId: string; conversationId: string; conflicted: boolean; unknown: boolean };
}

export interface ChatGptCommittedMessageProvenance {
  messageId: string;
  documentId: string;
  assistantTurnIdentity: string;
  observedAfterCommit: true;
  conflicted: boolean;
}

export interface ChatGptTurnRecoveryCandidate {
  surfaceId: string;
  documentId: string;
  conversationId: string;
  assistantTurnIdentity: string;
  handoffTopicId?: string;
  messageId?: string;
}

/** Fixed, content-free diagnostics: never interpolate source identifiers into a reason. */
export type ChatGptTurnRecoveryEvidenceReason =
  | "PROOF_SURFACE_MISSING" | "FRESH_SURFACE_MISSING" | "SURFACE_MISMATCH"
  | "PROOF_DOCUMENT_MISSING" | "FRESH_DOCUMENT_MISSING" | "DOCUMENT_MISMATCH"
  | "PROOF_CONVERSATION_MISSING" | "FRESH_CONVERSATION_MISSING" | "CONVERSATION_MISMATCH"
  | "PROOF_ASSISTANT_MISSING" | "FRESH_ASSISTANT_MISSING" | "ASSISTANT_MISMATCH"
  | "DOCUMENT_CONFLICT" | "CONVERSATION_CONFLICT" | "HANDOFF_CONFLICT" | "ASSISTANT_REBOUND"
  | "PROOF_DIAGNOSTIC_MISMATCH"
  | "POST_COMMIT_MESSAGE_MISSING" | "POST_COMMIT_MESSAGE_INVALID" | "POST_COMMIT_MESSAGE_CONFLICT"
  | "POST_COMMIT_DOCUMENT_MISMATCH" | "POST_COMMIT_ASSISTANT_MISMATCH"
  | "ORIGINAL_WIRE_MAPPING_MISSING" | "ORIGINAL_WIRE_MAPPING_INVALID"
  | "ORIGINAL_WIRE_MAPPING_CONFLICT" | "ORIGINAL_WIRE_MAPPING_UNKNOWN"
  | "ORIGINAL_WIRE_CONVERSATION_MISMATCH" | "ORIGINAL_WIRE_MESSAGE_MISMATCH"
  | "FRESH_MESSAGE_MISSING" | "MESSAGE_MISMATCH"
  | "PROOF_HANDOFF_INVALID" | "FRESH_HANDOFF_MISSING" | "HANDOFF_MISMATCH";

export interface ChatGptTurnRecoveryEvidenceEvaluation {
  matched: boolean;
  reasons: ChatGptTurnRecoveryEvidenceReason[];
  recoveryAuthorized: false;
}

/**
 * Pure diagnostic evidence matcher. Candidate conversation identity MUST have been observed
 * independently and freshly by the caller; original wire mapping never fills that field here.
 * Even a complete match is not a production recovery authorization or a claim of freshness.
 */
export function evaluateChatGptTurnRecoveryEvidence(
  proof: ChatGptTurnRecoveryIdentityProof,
  candidate: Partial<ChatGptTurnRecoveryCandidate>,
): ChatGptTurnRecoveryEvidenceEvaluation {
  const { identity, diagnostic, message, wireMessage } = proof;
  const reasons = new Set<ChatGptTurnRecoveryEvidenceReason>();
  const present = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
  const core: Array<{
    key: "surfaceId" | "documentId" | "conversationId" | "assistantTurnIdentity";
    has: "hasSurfaceId" | "hasDocumentId" | "hasConversationId" | "hasAssistantTurnIdentity";
    missingProof: ChatGptTurnRecoveryEvidenceReason;
    missingFresh: ChatGptTurnRecoveryEvidenceReason;
    mismatch: ChatGptTurnRecoveryEvidenceReason;
  }> = [
    { key: "surfaceId", has: "hasSurfaceId", missingProof: "PROOF_SURFACE_MISSING", missingFresh: "FRESH_SURFACE_MISSING", mismatch: "SURFACE_MISMATCH" },
    { key: "documentId", has: "hasDocumentId", missingProof: "PROOF_DOCUMENT_MISSING", missingFresh: "FRESH_DOCUMENT_MISSING", mismatch: "DOCUMENT_MISMATCH" },
    { key: "conversationId", has: "hasConversationId", missingProof: "PROOF_CONVERSATION_MISSING", missingFresh: "FRESH_CONVERSATION_MISSING", mismatch: "CONVERSATION_MISMATCH" },
    { key: "assistantTurnIdentity", has: "hasAssistantTurnIdentity", missingProof: "PROOF_ASSISTANT_MISSING", missingFresh: "FRESH_ASSISTANT_MISSING", mismatch: "ASSISTANT_MISMATCH" },
  ];
  for (const field of core) {
    const expected = identity[field.key];
    const fresh = candidate[field.key];
    if (!present(expected)) reasons.add(field.missingProof);
    if (!present(fresh)) reasons.add(field.missingFresh);
    if (present(expected) && present(fresh) && expected !== fresh) reasons.add(field.mismatch);
    if (diagnostic[field.has] !== present(expected)) reasons.add("PROOF_DIAGNOSTIC_MISMATCH");
  }
  for (const [key, reason] of [
    ["documentConflict", "DOCUMENT_CONFLICT"],
    ["conversationConflict", "CONVERSATION_CONFLICT"],
    ["handoffTopicConflict", "HANDOFF_CONFLICT"],
    ["assistantTurnRebound", "ASSISTANT_REBOUND"],
  ] as const) {
    if (diagnostic[key] === true) reasons.add(reason);
    else if (diagnostic[key] !== false) reasons.add("PROOF_DIAGNOSTIC_MISMATCH");
  }
  if (diagnostic.hasHandoffTopicId !== present(identity.handoffTopicId)) reasons.add("PROOF_DIAGNOSTIC_MISMATCH");

  if (!message) reasons.add("POST_COMMIT_MESSAGE_MISSING");
  else {
    if (!present(message.messageId) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(message.messageId)
      || !present(message.documentId) || !present(message.assistantTurnIdentity)
      || message.observedAfterCommit !== true || typeof message.conflicted !== "boolean") {
      reasons.add("POST_COMMIT_MESSAGE_INVALID");
    }
    if (message.conflicted) reasons.add("POST_COMMIT_MESSAGE_CONFLICT");
    if (message.documentId !== identity.documentId) reasons.add("POST_COMMIT_DOCUMENT_MISMATCH");
    if (message.assistantTurnIdentity !== identity.assistantTurnIdentity) reasons.add("POST_COMMIT_ASSISTANT_MISMATCH");
  }
  if (!wireMessage) reasons.add("ORIGINAL_WIRE_MAPPING_MISSING");
  else {
    if (!present(wireMessage.messageId) || !present(wireMessage.conversationId)
      || typeof wireMessage.conflicted !== "boolean" || typeof wireMessage.unknown !== "boolean") {
      reasons.add("ORIGINAL_WIRE_MAPPING_INVALID");
    }
    if (wireMessage.conflicted) reasons.add("ORIGINAL_WIRE_MAPPING_CONFLICT");
    if (wireMessage.unknown) reasons.add("ORIGINAL_WIRE_MAPPING_UNKNOWN");
    if (wireMessage.conversationId !== identity.conversationId) reasons.add("ORIGINAL_WIRE_CONVERSATION_MISMATCH");
    if (message && wireMessage.messageId !== message.messageId) reasons.add("ORIGINAL_WIRE_MESSAGE_MISMATCH");
  }
  if (!present(candidate.messageId)) reasons.add("FRESH_MESSAGE_MISSING");
  else if ((message && candidate.messageId !== message.messageId)
    || (wireMessage && candidate.messageId !== wireMessage.messageId)) reasons.add("MESSAGE_MISMATCH");

  if (identity.handoffTopicId !== undefined) {
    if (!present(identity.handoffTopicId)) reasons.add("PROOF_HANDOFF_INVALID");
    if (!present(candidate.handoffTopicId)) reasons.add("FRESH_HANDOFF_MISSING");
    else if (candidate.handoffTopicId !== identity.handoffTopicId) reasons.add("HANDOFF_MISMATCH");
  }
  return { matched: reasons.size === 0, reasons: [...reasons], recoveryAuthorized: false };
}

/**
 * Compare a fresh, independently observed recovery candidate with the immutable proof captured at
 * the incomplete-after-commit boundary. This is deliberately stricter than the phase-1 collector:
 * all core surface/document/conversation/assistant identifiers must have existed before the
 * failure and must be re-proven exactly. A handoff topic is optional only when the committed turn
 * never exposed one; once present it is part of the exact continuation identity.
 *
 * This helper authorizes no browser action by itself. Phase 2 may call it only after obtaining the
 * candidate without navigation, prompt attachment, resubmission, or a fresh surface lease.
 */
export function assertChatGptTurnRecoveryCandidate(
  proof: ChatGptTurnRecoveryIdentityProof,
  candidate: ChatGptTurnRecoveryCandidate,
): void {
  const { identity, diagnostic } = proof;
  if (diagnostic.documentConflict || diagnostic.conversationConflict || diagnostic.handoffTopicConflict) {
    throw new Error("ChatGPT committed recovery proof is conflicted and cannot authorize recovery");
  }

  const required: Array<keyof Pick<
    ChatGptTurnRecoveryIdentity,
    "surfaceId" | "documentId" | "conversationId" | "assistantTurnIdentity"
  >> = ["surfaceId", "documentId", "conversationId", "assistantTurnIdentity"];
  for (const key of required) {
    const expected = identity[key];
    if (!expected) {
      throw new Error(`ChatGPT committed recovery proof is missing ${key}`);
    }
    if (candidate[key] !== expected) {
      throw new Error(`ChatGPT recovery candidate does not match committed ${key}`);
    }
  }

  if (identity.handoffTopicId !== undefined && candidate.handoffTopicId !== identity.handoffTopicId) {
    throw new Error("ChatGPT recovery candidate does not match committed handoffTopicId");
  }
  if (proof.message && (proof.message.conflicted
    || proof.message.documentId !== identity.documentId
    || proof.message.assistantTurnIdentity !== identity.assistantTurnIdentity
    || candidate.messageId !== proof.message.messageId)) {
    throw new Error("ChatGPT recovery candidate does not match committed message provenance");
  }
  if (proof.wireMessage && (proof.wireMessage.conflicted || proof.wireMessage.unknown
    || proof.wireMessage.conversationId !== identity.conversationId
    || candidate.messageId !== proof.wireMessage.messageId)) {
    throw new Error("ChatGPT recovery candidate does not match original wire message provenance");
  }
}

/**
 * Behavior-neutral phase-1 collector.
 *
 * The first exact wire conversation/topic wins. Later disagreement is retained only as a
 * content-free conflict bit rather than silently replacing the provenance that phase 2 would
 * eventually need to prove. Assistant identity may change only because browser-worker calls this
 * after its existing exact-one DOM rebound proof, so that transition is recorded separately.
 */
export class ChatGptTurnRecoveryIdentityTracker {
  private readonly value: ChatGptTurnRecoveryIdentity = {};
  private phase: ChatGptTurnRecoveryIdentityPhase = "provisional";
  private frozenProof?: ChatGptTurnRecoveryIdentityProof;
  private assistantTurnRebound = false;
  private documentConflict = false;
  private conversationConflict = false;
  private handoffTopicConflict = false;
  private message?: ChatGptCommittedMessageProvenance;
  private wireMessage?: NonNullable<ChatGptTurnRecoveryIdentityProof["wireMessage"]>;
  private wireMessageUnknown = false;
  private wireMessageConflict = false;

  /** First valid observation AFTER semantic commit; not claimed to exist at commit time. */
  observeCommittedMessage(observation: {
    messageId?: string; documentId?: string; assistantTurnIdentity: string;
    count: number; documentMatches: number; uuidLike: boolean;
  }): void {
    if (this.phase !== "committed") return;
    const valid = !!observation.messageId && !!observation.documentId
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(observation.messageId)
      && observation.count === 1 && observation.documentMatches === 1 && observation.uuidLike
      && observation.documentId === this.value.documentId
      && observation.assistantTurnIdentity === this.value.assistantTurnIdentity;
    if (this.message) {
      if (!valid || this.message.messageId !== observation.messageId
        || this.message.documentId !== observation.documentId
        || this.message.assistantTurnIdentity !== observation.assistantTurnIdentity) {
        this.message.conflicted = true;
      }
      return;
    }
    if (!valid) return;
    this.message = {
      messageId: observation.messageId!, documentId: observation.documentId!,
      assistantTurnIdentity: observation.assistantTurnIdentity,
      observedAfterCommit: true, conflicted: false,
    };
  }

  messageDiagnostic(): { hasCommittedMessage: boolean; committedMessageConflict: boolean } {
    return { hasCommittedMessage: this.message !== undefined, committedMessageConflict: this.message?.conflicted ?? false };
  }

  /** Content-free diagnostic only: this never authorizes recovery or fills missing provenance. */
  compareCommittedMessage(messageId: string | undefined, documentId: string | undefined, assistantTurnIdentity: string | undefined): {
    observed: boolean; messageIdEqual: boolean; documentIdEqual: boolean; assistantIdentityEqual: boolean; conflicted: boolean;
  } {
    return {
      observed: this.message !== undefined,
      messageIdEqual: this.message !== undefined && this.message.messageId === messageId,
      documentIdEqual: this.message !== undefined && this.message.documentId === documentId,
      assistantIdentityEqual: this.message !== undefined && this.message.assistantTurnIdentity === assistantTurnIdentity,
      conflicted: this.message?.conflicted ?? false,
    };
  }

  /** Strict consistency remains separate from the diagnostic equalities above. */
  matchesCommittedMessage(messageId: string | undefined, documentId: string | undefined, assistantTurnIdentity: string): boolean {
    return this.message !== undefined && !this.message.conflicted
      && !this.documentConflict && !this.conversationConflict && !this.handoffTopicConflict
      && this.message.messageId === messageId && this.message.documentId === documentId
      && this.message.assistantTurnIdentity === assistantTurnIdentity;
  }

  constructor(surfaceId?: string) {
    if (surfaceId) this.value.surfaceId = surfaceId;
  }

  observeAssistantTurn(identity: string): void {
    if (!identity || this.phase === "frozen") return;
    if (this.value.assistantTurnIdentity && this.value.assistantTurnIdentity !== identity) {
      this.assistantTurnRebound = true;
      if (this.message) this.message.conflicted = true;
    }
    this.value.assistantTurnIdentity = identity;
  }

  observeDocument(documentId: string): void {
    if (!documentId || this.phase === "frozen") return;
    const current = this.value.documentId;
    if (!current) {
      this.value.documentId = documentId;
      return;
    }
    if (current !== documentId) this.documentConflict = true;
  }

  observeWireSnapshot(snapshot: Pick<ChatGptWireSnapshot, "conversationId" | "handoffTopicId"
    | "assistantMessageId" | "assistantMessageConversationId" | "assistantMessageIdentityConflict" | "assistantMessageIdentityUnknown">): void {
    if (this.phase === "frozen") return;
    this.observeStableWireId("conversationId", snapshot.conversationId);
    this.observeStableWireId("handoffTopicId", snapshot.handoffTopicId);
    this.wireMessageUnknown ||= snapshot.assistantMessageIdentityUnknown === true;
    this.wireMessageConflict ||= snapshot.assistantMessageIdentityConflict === true;
    if (snapshot.assistantMessageId && snapshot.assistantMessageConversationId) {
      if (!this.wireMessage) {
        this.wireMessage = {
          messageId: snapshot.assistantMessageId, conversationId: snapshot.assistantMessageConversationId,
          conflicted: false, unknown: false,
        };
      } else if (this.wireMessage.messageId !== snapshot.assistantMessageId
        || this.wireMessage.conversationId !== snapshot.assistantMessageConversationId) {
        this.wireMessageConflict = true;
      }
    }
    if (this.wireMessage) {
      this.wireMessage.conflicted ||= this.wireMessageConflict || this.conversationConflict;
      this.wireMessage.unknown ||= this.wireMessageUnknown;
    }
  }

  /** Semantic ChatGPT submission evidence crossed the no-replay boundary. */
  commitSubmission(): void {
    if (this.phase !== "provisional") {
      throw new Error(`ChatGPT recovery identity cannot commit from phase ${this.phase}`);
    }
    this.phase = "committed";
  }

  /**
   * The request-injection path proved that its ambiguous Send activation did not commit. Any wire
   * or assistant provenance observed around that blocked attempt is therefore provisional and must
   * not leak into the fallback send. The launcher surface stays the same owned surface.
   */
  resetAfterProvenRollback(): void {
    if (this.phase !== "provisional") {
      throw new Error(`ChatGPT recovery identity cannot roll back from phase ${this.phase}`);
    }
    delete this.value.documentId;
    delete this.value.conversationId;
    delete this.value.assistantTurnIdentity;
    delete this.value.handoffTopicId;
    this.assistantTurnRebound = false;
    this.documentConflict = false;
    this.conversationConflict = false;
    this.handoffTopicConflict = false;
    this.message = undefined;
    this.wireMessage = undefined;
    this.wireMessageUnknown = false;
    this.wireMessageConflict = false;
  }

  /**
   * Capture the immutable non-content proof available when an already-committed turn becomes
   * incomplete. H5 phase 1 records this only; phase 2 may compare a fresh post-rebind candidate to
   * this proof but must never mutate it.
   */
  freezeCommittedProof(): ChatGptTurnRecoveryIdentityProof {
    if (this.phase === "frozen") return this.cloneFrozenProof();
    if (this.phase !== "committed") {
      throw new Error(`ChatGPT recovery identity cannot freeze from phase ${this.phase}`);
    }
    this.phase = "frozen";
    this.frozenProof = {
      identity: { ...this.value },
      diagnostic: this.currentDiagnostic(),
      ...(this.message ? { message: { ...this.message } } : {}),
      ...(this.wireMessage ? { wireMessage: { ...this.wireMessage } } : {}),
    };
    return this.cloneFrozenProof();
  }

  lifecycle(): ChatGptTurnRecoveryIdentityPhase {
    return this.phase;
  }

  frozenSnapshot(): ChatGptTurnRecoveryIdentityProof | undefined {
    return this.frozenProof ? this.cloneFrozenProof() : undefined;
  }

  /** Diagnostic clone only: never commits, freezes, or changes the provenance lifecycle. */
  committedSnapshot(): ChatGptTurnRecoveryIdentityProof | undefined {
    if (this.phase === "provisional") return undefined;
    if (this.phase === "frozen") return this.cloneFrozenProof();
    return {
      identity: { ...this.value },
      diagnostic: this.currentDiagnostic(),
      ...(this.message ? { message: { ...this.message } } : {}),
      ...(this.wireMessage ? { wireMessage: { ...this.wireMessage } } : {}),
    };
  }

  snapshot(): ChatGptTurnRecoveryIdentity {
    return { ...this.value };
  }

  diagnostic(): ChatGptTurnRecoveryIdentityDiagnostic {
    return this.currentDiagnostic();
  }

  private currentDiagnostic(): ChatGptTurnRecoveryIdentityDiagnostic {
    return {
      hasSurfaceId: this.value.surfaceId !== undefined,
      hasDocumentId: this.value.documentId !== undefined,
      hasConversationId: this.value.conversationId !== undefined,
      hasAssistantTurnIdentity: this.value.assistantTurnIdentity !== undefined,
      hasHandoffTopicId: this.value.handoffTopicId !== undefined,
      assistantTurnRebound: this.assistantTurnRebound,
      documentConflict: this.documentConflict,
      conversationConflict: this.conversationConflict,
      handoffTopicConflict: this.handoffTopicConflict,
    };
  }

  private cloneFrozenProof(): ChatGptTurnRecoveryIdentityProof {
    if (!this.frozenProof) throw new Error("ChatGPT recovery identity has no frozen proof");
    return {
      identity: { ...this.frozenProof.identity },
      diagnostic: { ...this.frozenProof.diagnostic },
      ...(this.frozenProof.message ? { message: { ...this.frozenProof.message } } : {}),
      ...(this.frozenProof.wireMessage ? { wireMessage: { ...this.frozenProof.wireMessage } } : {}),
    };
  }

  private observeStableWireId(
    key: "conversationId" | "handoffTopicId",
    incoming: string | undefined,
  ): void {
    if (!incoming) return;
    const current = this.value[key];
    if (!current) {
      this.value[key] = incoming;
      return;
    }
    if (current === incoming) return;
    if (key === "conversationId") this.conversationConflict = true;
    else this.handoffTopicConflict = true;
  }
}
