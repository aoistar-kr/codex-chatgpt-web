import { createHash } from "node:crypto";
import type { AdapterEvent, CodexOutputTextAnnotation, CodexParsedRequest } from "../../types";
import type { BrokerToolRequest } from "./turn-broker";
import { ChatGptSteeringUnavailableError, chatGptBrowserTabClosedError, chatGptTurnSupersededError } from "./adapter-error";
import {
  chatGptTurnUserRevisionHistory,
  extractChatGptCompactionSourceRevision,
  extractChatGptTurnIdentity,
  extractChatGptTurnUserRevision,
  type ChatGptTurnEnvironment,
} from "./environment";
import { MAX_CHATGPT_BROWSER_TABS } from "./concurrency";
import type { ChatGptExternalTurnProgress } from "./turn-progress";

function awaitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    // Keep the underlying retirement promise observed even when the caller arrived after abort;
    // another owner may still depend on its eventual settlement and rejection must not become an
    // unhandled process-level error.
    void promise.catch(() => {});
    return Promise.reject(new DOMException("ChatGPT web turn aborted", "AbortError"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException("ChatGPT web turn aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export type ChatGptBrowserOutcome =
  | { type: "final"; answer: string }
  | { type: "error"; error: Error };

export interface ChatGptTraceEvent {
  kind: "reasoning" | "commentary";
  text: string;
  continuation?: boolean;
}

interface TraceWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class ChatGptTraceFeed {
  private readonly queued: ChatGptTraceEvent[] = [];
  private readonly waiters = new Set<TraceWaiter>();

  push(event: ChatGptTraceEvent): void {
    const normalized = event.continuation ? event.text : event.text.trim();
    if (!normalized) return;
    const normalizedEvent = { ...event, text: normalized };
    this.queued.push(normalizedEvent);
    const waiter = this.waiters.values().next().value as TraceWaiter | undefined;
    if (!waiter) return;
    this.waiters.delete(waiter);
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
    waiter.resolve();
  }

  drain(): ChatGptTraceEvent[] {
    return this.queued.splice(0);
  }

  wait(signal?: AbortSignal): Promise<void> {
    if (this.queued.length > 0) return Promise.resolve();
    if (signal?.aborted) return Promise.reject(new DOMException("trace wait aborted", "AbortError"));
    return new Promise<void>((resolveWait, rejectWait) => {
      const waiter: TraceWaiter = { resolve: resolveWait, reject: rejectWait, ...(signal ? { signal } : {}) };
      if (signal) {
        waiter.onAbort = () => {
          this.waiters.delete(waiter);
          rejectWait(new DOMException("trace wait aborted", "AbortError"));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.add(waiter);
    });
  }
}

interface TextWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/** Append-only browser Markdown feed. Waiters are notifications; `drain` owns consumption. */
export class ChatGptTextFeed {
  private readonly queued: string[] = [];
  private readonly waiters = new Set<TextWaiter>();
  private text = "";

  push(delta: string): void {
    if (!delta) return;
    this.text += delta;
    this.queued.push(delta);
    const waiter = this.waiters.values().next().value as TextWaiter | undefined;
    if (!waiter) return;
    this.waiters.delete(waiter);
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
    waiter.resolve();
  }

  drain(): string[] {
    return this.queued.splice(0);
  }

  /**
   * Drop the accumulated answer when ChatGPT answered the steered revision in its own assistant
   * turn. The superseded prefix was already delivered, and the browser Markdown stream must be
   * reproduced from the turn that now owns the answer.
   */
  reset(): void {
    this.text = "";
    this.queued.splice(0);
  }

  value(): string {
    return this.text;
  }

  wait(signal?: AbortSignal): Promise<void> {
    if (this.queued.length > 0) return Promise.resolve();
    if (signal?.aborted) return Promise.reject(new DOMException("text wait aborted", "AbortError"));
    return new Promise<void>((resolveWait, rejectWait) => {
      const waiter: TextWaiter = { resolve: resolveWait, reject: rejectWait, ...(signal ? { signal } : {}) };
      if (signal) {
        waiter.onAbort = () => {
          this.waiters.delete(waiter);
          rejectWait(new DOMException("text wait aborted", "AbortError"));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.add(waiter);
    });
  }
}

interface ChatGptTurnRuntimeBase {
  browser: Promise<string>;
  /** Physical helper/Playwright settlement, including the launcher end/release acknowledgement. */
  physicalSettlement: Promise<void>;
  trace: ChatGptTraceFeed;
  text: ChatGptTextFeed;
  /** Final structured annotations captured from the authoritative browser response. */
  outputAnnotations?: () => readonly CodexOutputTextAnnotation[];
  usageInput?: CodexParsedRequest;
  conversationKey?: string;
  releaseRetainedConversation?: () => Promise<void>;
  /** Idempotently retire the turn-bound MCP capability after browser and observer settlement. */
  retireCapability?: () => void | Promise<void>;
  submission?: { phase: "prepared" | "send_activated" | "accepted" };
  cancel: (reason?: Error) => void;
}

export type ChatGptTurnRuntime =
  | (ChatGptTurnRuntimeBase & {
    mode: "tools";
    token: Promise<string>;
    externalProgress: ChatGptExternalTurnProgress;
  })
  | (ChatGptTurnRuntimeBase & { mode: "read-only" });

function executionKey(parsed: CodexParsedRequest, payload: unknown): string {
  return createHash("sha256").update(JSON.stringify({
    modelId: parsed.modelId,
    reasoning: parsed.options.reasoning,
    payload,
  })).digest("hex");
}

function compactionInputRevision(parsed: CodexParsedRequest): unknown[] {
  const body = parsed._rawBody;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("ChatGPT web compaction requires the complete native Codex request body");
  }
  const input = (body as { input?: unknown }).input;
  if (!Array.isArray(input)) {
    throw new Error("ChatGPT web compaction requires the complete native Codex input history");
  }
  return input;
}

export function chatGptTurnExecutionKey(parsed: CodexParsedRequest): string {
  const identity = extractChatGptTurnIdentity(parsed);
  if (!identity.turnId) throw new Error("ChatGPT web requires native Codex turn_id metadata for browser-session replay");
  return executionKey(parsed, {
    threadId: identity.threadId,
    turnId: identity.turnId,
    purpose: parsed._compactionRequest ? "compaction" : "response",
    revision: parsed._compactionRequest
      ? compactionInputRevision(parsed)
      : extractChatGptTurnUserRevision(parsed),
    ...(!parsed._compactionRequest ? { instructionId: chatGptTurnUserRevisionHistory(parsed).at(-1)?.itemId } : {}),
  });
}

export interface ChatGptInstructionLineage {
  current: string;
  predecessors: ReadonlySet<string>;
}

function normalizeSteerContentForIdentity(content: unknown): unknown {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content;
  return content.map(part => {
    if (part && typeof part === "object" && !Array.isArray(part)) {
      const obj = part as Record<string, unknown>;
      if ((obj.type === "input_text" || obj.type === "text") && typeof obj.text === "string") {
        return { type: "text", text: obj.text };
      }
    }
    return part;
  });
}

function directSteerContentIdentity(content: unknown): string {
  const normalized = normalizeSteerContentForIdentity(content);
  const serialized = JSON.stringify(normalized);
  return createHash("sha256")
    .update(serialized === undefined ? "undefined" : serialized)
    .digest("hex");
}

export function chatGptInstructionLineage(parsed: CodexParsedRequest): ChatGptInstructionLineage {
  const revisions = chatGptTurnUserRevisionHistory(parsed).map(revision => createHash("sha256")
    .update(JSON.stringify([revision.itemId ?? null, revision.content])).digest("hex"));
  const current = revisions.pop();
  if (!current) throw new Error("ChatGPT web requires a canonical user instruction");
  return { current, predecessors: new Set(revisions) };
}

/** Exact canonical Responses request identity inside one long-lived browser execution. */
export function chatGptTurnRoundKey(parsed: CodexParsedRequest): string {
  const identity = extractChatGptTurnIdentity(parsed);
  if (!identity.turnId) throw new Error("ChatGPT web requires native Codex turn_id metadata for round replay");
  const body = parsed._rawBody;
  if (!body || typeof body !== "object" || Array.isArray(body)
    || !Array.isArray((body as { input?: unknown }).input)) {
    throw new Error("ChatGPT web requires the complete native Codex input for round replay");
  }
  return executionKey(parsed, {
    threadId: identity.threadId,
    turnId: identity.turnId,
    purpose: parsed._compactionRequest ? "compaction" : "response",
    input: (body as { input: unknown[] }).input,
  });
}

/** Stable identity for limiting automatic retries of one native Codex turn. */
export function chatGptTurnRetryKey(parsed: CodexParsedRequest): string {
  const identity = extractChatGptTurnIdentity(parsed);
  if (!identity.turnId) throw new Error("ChatGPT web requires native Codex turn_id metadata for browser-turn retry budgeting");
  return createHash("sha256").update(JSON.stringify({
    threadId: identity.threadId,
    turnId: identity.turnId,
    purpose: parsed._compactionRequest ? "compaction" : "response",
  })).digest("hex");
}

/** One native Codex thread may own at most one live ChatGPT browser surface. */
export function chatGptThreadOwnershipKey(parsed: CodexParsedRequest): string {
  const identity = extractChatGptTurnIdentity(parsed);
  const owner = identity.threadId
    ? { kind: "thread", id: identity.threadId }
    : identity.promptCacheKey
      ? { kind: "prompt_cache", id: identity.promptCacheKey }
      : identity.turnId
        ? { kind: "turn", id: identity.turnId }
        : undefined;
  if (!owner) throw new Error("ChatGPT web requires native Codex turn identity metadata for browser ownership");
  return createHash("sha256").update(JSON.stringify(owner)).digest("hex");
}

/** Locate the browser response that a native mid-turn compaction replaces. */
export function chatGptCompactionSourceExecutionKey(parsed: CodexParsedRequest): string {
  const identity = extractChatGptTurnIdentity(parsed);
  if (!identity.turnId) throw new Error("ChatGPT web requires native Codex turn_id metadata for browser-session replay");
  const source = extractChatGptCompactionSourceRevision(parsed);
  return executionKey(parsed, {
    threadId: identity.threadId,
    turnId: source.turnId ?? identity.turnId,
    purpose: "response",
    revision: source.content,
    instructionId: source.itemId,
  });
}

export class ChatGptTurnSession {
  supersededError?: Error;
  readonly createdAt = Date.now();
  private lastTouchedAt = this.createdAt;
  private currentRuntime: ChatGptTurnRuntime;
  private currentBrowserOutcome: Promise<ChatGptBrowserOutcome>;
  private currentPhysicalSettlement: Promise<void>;
  private runtimeRevision = 0;
  private runtimeTransition = false;
  private readonly runtimeWaiters = new Set<() => void>();
  private controlAttached = false;
  private closeControl?: () => void;
  private pollControl?: () => void;
  private directSteer?: (itemId: string, content: unknown) => void;
  private directSteerSequence = 0;
  private controlTail: Promise<void> = Promise.resolve();
  private interrupted = false;
  private cancellationError?: Error;
  private currentInstruction?: string;
  private readonly absorbedInstructions = new Set<string>();
  private readonly pendingInstructions = new Set<string>();
  private readonly rejectedInstructions = new Map<string, ChatGptSteeringUnavailableError>();
  private readonly directSteerItems = new Set<string>();
  private readonly pendingDirectSteerContent = new Map<string, number>();
  private readonly pendingDirectContentByInstruction = new Map<string, string>();
  private readonly pendingDirectPrimaryByContent = new Map<string, string[]>();
  private readonly directAliasesByPrimary = new Map<string, Set<string>>();
  private deliveredAnswerEpoch?: number;
  private readonly outstandingById = new Map<string, BrokerToolRequest>();
  private readonly outstandingWaiters = new Set<() => void>();
  private readonly deliveredResultIds = new Set<string>();
  private outstandingReasoning: string[] = [];
  private finalReasoning: string[] = [];
  private outstandingPrelude: AdapterEvent[] = [];
  private finalPrelude: AdapterEvent[] = [];
  private settledBrowserOutcome?: ChatGptBrowserOutcome;
  private settledPhysical = false;
  private attachedConversationKey: string | undefined;
  private tail: Promise<void> = Promise.resolve();
  private capabilityRetirementScheduled = false;
  private toolBatchSequence = 0;
  private outstandingToolBatchTiming?: {
    sequence: number;
    toolCount: number;
    emittedAt: number;
  };
  private lastToolResultsSettledAt?: number;
  private readonly rounds = new Map<string, {
    events: AdapterEvent[];
    reasoning: string[];
    completed: boolean;
    failure?: Error;
  }>();

  constructor(
    runtime: ChatGptTurnRuntime,
    readonly traceId?: string,
    readonly ownerKey?: string,
    readonly nativeTurnId?: string,
    readonly nativeThreadId?: string,
    instruction?: string,
    private readonly environment?: ChatGptTurnEnvironment,
    private readonly environmentContextIdentity?: string,
  ) {
    this.currentRuntime = runtime;
    this.currentInstruction = instruction;
    this.attachedConversationKey = runtime.conversationKey;
    const epoch = this.runtimeRevision;
    this.currentPhysicalSettlement = runtime.physicalSettlement.then(
      () => { if (this.runtimeRevision === epoch) this.settledPhysical = true; },
      error => {
        if (this.runtimeRevision === epoch) this.settledPhysical = true;
        throw error;
      },
    );
    // A replacement observes the raw epoch settlement. Once the epoch advances, however, no
    // owner is guaranteed to await this obsolete derived promise; keep it observed so Bun does
    // not promote the expected supersession rejection into a process-fatal unhandled rejection.
    void this.currentPhysicalSettlement.catch(() => {});
    this.currentBrowserOutcome = runtime.browser
      .then(answer => ({ type: "final", answer }) as ChatGptBrowserOutcome)
      .catch(error => ({ type: "error", error: error instanceof Error ? error : new Error(String(error)) }) as ChatGptBrowserOutcome)
      .then(outcome => {
      if (this.runtimeRevision === epoch) {
        this.settledBrowserOutcome = outcome;
        this.closeControl?.();
      }
      return outcome;
    });
  }

  get runtime(): ChatGptTurnRuntime {
    return this.currentRuntime;
  }

  get browserOutcome(): Promise<ChatGptBrowserOutcome> {
    return this.currentBrowserOutcome;
  }

  get physicalSettlement(): Promise<void> {
    return this.currentPhysicalSettlement;
  }

  get instruction(): string | undefined {
    return this.currentInstruction;
  }

  runtimeEpoch(): number {
    return this.runtimeRevision;
  }

  isRuntimeTransitioning(): boolean {
    return this.runtimeTransition;
  }

  waitForRuntimeChange(revision: number, signal?: AbortSignal): Promise<void> {
    if (revision !== this.runtimeRevision) return Promise.resolve();
    if (signal?.aborted) return Promise.reject(new DOMException("runtime wait aborted", "AbortError"));
    return new Promise<void>((resolveWait, rejectWait) => {
      const waiter = () => {
        signal?.removeEventListener("abort", onAbort);
        this.runtimeWaiters.delete(waiter);
        resolveWait();
      };
      const onAbort = () => {
        this.runtimeWaiters.delete(waiter);
        rejectWait(new DOMException("runtime wait aborted", "AbortError"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.runtimeWaiters.add(waiter);
    });
  }

  beginRuntimeTransition(): ChatGptTurnRuntime {
    if (this.runtimeTransition) throw new Error("ChatGPT runtime transition is already active");
    if (this.outstandingById.size > 0) throw new Error("cannot steer while ChatGPT tool results are outstanding");
    this.runtimeTransition = true;
    this.settledBrowserOutcome = undefined;
    this.settledPhysical = false;
    this.bumpRuntimeRevision();
    return this.currentRuntime;
  }

  installRuntime(runtime: ChatGptTurnRuntime, instruction: string): void {
    if (!this.runtimeTransition) throw new Error("ChatGPT runtime replacement has no active transition");
    this.currentRuntime = runtime;
    this.currentInstruction = instruction;
    this.absorbedInstructions.add(instruction);
    this.attachedConversationKey = runtime.conversationKey;
    this.settledBrowserOutcome = undefined;
    this.settledPhysical = false;
    this.capabilityRetirementScheduled = false;
    const epoch = this.runtimeRevision + 1;
    this.currentPhysicalSettlement = runtime.physicalSettlement.then(
      () => { if (this.runtimeRevision === epoch) this.settledPhysical = true; },
      error => {
        if (this.runtimeRevision === epoch) this.settledPhysical = true;
        throw error;
      },
    );
    void this.currentPhysicalSettlement.catch(() => {});
    this.currentBrowserOutcome = runtime.browser
      .then(answer => ({ type: "final", answer }) as ChatGptBrowserOutcome)
      .catch(error => ({ type: "error", error: error instanceof Error ? error : new Error(String(error)) }) as ChatGptBrowserOutcome)
      .then(outcome => {
        if (this.runtimeRevision === epoch) {
          this.settledBrowserOutcome = outcome;
          this.closeControl?.();
        }
        return outcome;
      });
    this.runtimeTransition = false;
    this.runtimeRevision = epoch;
    this.notifyRuntimeWaiters();
    this.scheduleCapabilityRetirement();
  }

  failRuntimeTransition(error: Error): void {
    this.runtimeTransition = false;
    this.settledBrowserOutcome = { type: "error", error };
    this.bumpRuntimeRevision();
  }

  hasAbsorbedInstruction(instruction: string): boolean {
    return this.absorbedInstructions.has(instruction) || this.pendingInstructions.has(instruction);
  }

  hasObservedInstruction(instruction: string): boolean {
    return this.hasAbsorbedInstruction(instruction) || this.rejectedInstructions.has(instruction);
  }

  instructionFailure(instruction: string): ChatGptSteeringUnavailableError | undefined {
    return this.rejectedInstructions.get(instruction);
  }

  rejectInstruction(instruction: string, error: ChatGptSteeringUnavailableError): void {
    this.pendingInstructions.delete(instruction);
    this.rejectedInstructions.set(instruction, error);
    for (const alias of this.directAliasesByPrimary.get(instruction) ?? []) {
      this.pendingInstructions.delete(alias);
      this.rejectedInstructions.set(alias, error);
    }
    this.directAliasesByPrimary.delete(instruction);
    // Keep the single-use content binding: a late canonical replay must see this rejection,
    // not retire the still-generating browser and resend a rejected instruction as a new turn.
  }

  claimInstruction(instruction: string): void {
    this.pendingInstructions.add(instruction);
  }

  completeInstruction(instruction: string): void {
    this.pendingInstructions.delete(instruction);
    this.absorbedInstructions.add(instruction);
    const aliases = this.directAliasesByPrimary.get(instruction);
    if (aliases) {
      for (const alias of aliases) {
        this.pendingInstructions.delete(alias);
        this.absorbedInstructions.add(alias);
      }
      this.directAliasesByPrimary.delete(instruction);
    }
  }

  failInstruction(instruction: string): void {
    this.pendingInstructions.delete(instruction);
    // A revision that failed to reach ChatGPT must not stay absorbable, or the provider replay
    // would attach to a live turn that never actually received it.
    const identity = this.pendingDirectContentByInstruction.get(instruction);
    if (identity !== undefined) {
      this.pendingDirectContentByInstruction.delete(instruction);
      const remaining = (this.pendingDirectSteerContent.get(identity) ?? 1) - 1;
      if (remaining <= 0) this.pendingDirectSteerContent.delete(identity);
      else this.pendingDirectSteerContent.set(identity, remaining);
    }
    const aliases = this.directAliasesByPrimary.get(instruction);
    if (aliases) {
      for (const alias of aliases) this.pendingInstructions.delete(alias);
      this.directAliasesByPrimary.delete(instruction);
    }
  }

  /**
   * Claim the provisional revision observed on app-server stdio. Codex assigns the durable
   * response-item id only after accepting turn/steer, so the later provider replay cannot have
   * the same instruction fingerprint even though it is the same human revision.
   */
  claimDirectSteer(itemId: string, instruction: string, content: unknown): boolean {
    if (this.directSteerItems.has(itemId)) {
      console.warn(`[chatgpt-web] direct steer ${itemId.slice(0, 12)} was already claimed`);
      return false;
    }
    this.directSteerItems.add(itemId);
    this.pendingInstructions.add(instruction);
    const identity = directSteerContentIdentity(content);
    this.pendingDirectSteerContent.set(identity, (this.pendingDirectSteerContent.get(identity) ?? 0) + 1);
    this.pendingDirectContentByInstruction.set(instruction, identity);
    const primaries = this.pendingDirectPrimaryByContent.get(identity) ?? [];
    primaries.push(instruction);
    this.pendingDirectPrimaryByContent.set(identity, primaries);
    return true;
  }

  /**
   * Bind one later Codex-owned item id to one already authenticated direct steer. This is scoped
   * by the session registry's exact native (thread, turn) match and is single-use, so equal text
   * sent twice remains two distinct revisions instead of becoming a broad content-only dedupe.
   */
  absorbDirectSteerAlias(instruction: string, content: unknown): boolean {
    if (this.hasObservedInstruction(instruction)) return true;
    const identity = directSteerContentIdentity(content);
    const remaining = this.pendingDirectSteerContent.get(identity) ?? 0;
    if (remaining < 1) {
      // A same-turn continuation whose newest revision is neither claimed nor bound to a claimed
      // direct steer cannot inherit the trusted environment, so the caller needs this mismatch.
      console.warn(
        `[chatgpt-web] steering alias was not absorbed (pendingContent=${this.pendingDirectSteerContent.size}`
        + `, claimedItems=${this.directSteerItems.size}, contentIdentity=${identity.slice(0, 8)})`,
      );
      return false;
    }
    return this.bindDirectSteerAlias(instruction, identity, true);
  }

  /**
   * Read-only variant for the rollout watcher. Codex records one human revision in three shapes: the
   * stdio control frame (provisional item id), the rollout record (durable item id), and the
   * canonical provider request, which carries the steering message with no item id at all. The
   * single-use content binding therefore has to survive the watcher, or the provider request that
   * continues the same native turn can never prove that this exact revision was authenticated.
   */
  observeClaimedSteerRevision(instruction: string, content: unknown): boolean {
    if (this.hasObservedInstruction(instruction)) return true;
    const identity = directSteerContentIdentity(content);
    if ((this.pendingDirectSteerContent.get(identity) ?? 0) < 1) return false;
    return this.bindDirectSteerAlias(instruction, identity, false);
  }

  /**
   * Claim a revision that only the authenticated rollout recorded, and register its content so the
   * id-less canonical provider request Codex opens for it can still bind to this live turn.
   */
  claimRolloutSteer(instruction: string, content: unknown): void {
    this.claimInstruction(instruction);
    const identity = directSteerContentIdentity(content);
    this.pendingDirectSteerContent.set(identity, (this.pendingDirectSteerContent.get(identity) ?? 0) + 1);
    const primaries = this.pendingDirectPrimaryByContent.get(identity) ?? [];
    primaries.push(instruction);
    this.pendingDirectPrimaryByContent.set(identity, primaries);
  }

  private bindDirectSteerAlias(instruction: string, identity: string, consume: boolean): boolean {
    const primaries = this.pendingDirectPrimaryByContent.get(identity);
    const primary = consume ? primaries?.shift() : primaries?.[0];
    if (!primary) return false;
    if (consume) {
      const remaining = this.pendingDirectSteerContent.get(identity) ?? 0;
      if (remaining <= 1) this.pendingDirectSteerContent.delete(identity);
      else this.pendingDirectSteerContent.set(identity, remaining - 1);
      if (primaries?.length === 0) this.pendingDirectPrimaryByContent.delete(identity);
    }
    const rejected = this.rejectedInstructions.get(primary);
    if (rejected) this.rejectedInstructions.set(instruction, rejected);
    else if (this.absorbedInstructions.has(primary)) this.absorbedInstructions.add(instruction);
    else {
      this.pendingInstructions.add(instruction);
      const aliases = this.directAliasesByPrimary.get(primary) ?? new Set<string>();
      aliases.add(instruction);
      this.directAliasesByPrimary.set(primary, aliases);
    }
    return true;
  }

  /**
   * A canonical Codex provider request created after an authenticated direct steer may observe the
   * same browser answer as the request that already delivered it. Suppressing the duplicate is
   * decided when the answer settles, not when the revision is bound: the steered revision is
   * applied at Codex's sampling boundary, so the delivering request can already be detached (tool
   * continuation) or still attached (a superseded generation), and only the runtime epoch records
   * which answer this logical turn already received.
   */
  markAnswerDelivered(): void {
    this.deliveredAnswerEpoch = this.runtimeRevision;
  }

  answerAlreadyDelivered(): boolean {
    return this.deliveredAnswerEpoch === this.runtimeRevision;
  }

  trustedEnvironment(): ChatGptTurnEnvironment | undefined {
    return this.environment ? structuredClone(this.environment) : undefined;
  }

  matchesEnvironmentContext(identity: string | undefined): boolean {
    return identity === undefined || identity === this.environmentContextIdentity;
  }

  attachControl(close: () => void, poll?: () => void): boolean {
    if (this.controlAttached) return false;
    if (this.settledBrowserOutcome) {
      close();
      return false;
    }
    this.controlAttached = true;
    this.closeControl = close;
    this.pollControl = poll;
    return true;
  }

  pollControlNow(): void {
    this.pollControl?.();
  }

  attachDirectSteer(handler: (itemId: string, content: unknown) => void): void {
    // Exact HTTP retries/reconnects re-enter adapter setup for the same logical session. The
    // original controller owns the already-mutated canonical request and must remain authoritative.
    if (this.directSteer) return;
    this.directSteer = handler;
  }

  submitDirectSteer(itemId: string, content: unknown): boolean {
    if (this.interrupted || this.settledBrowserOutcome || !this.directSteer) {
      console.warn(
        `[chatgpt-web] direct steer ${itemId.slice(0, 12)} was not accepted (interrupted=${this.interrupted}`
        + `, settled=${this.settledBrowserOutcome !== undefined}, controller=${this.directSteer !== undefined})`,
      );
      return false;
    }
    this.touch();
    this.directSteer(itemId, content);
    return true;
  }

  /** Side-effect free counters for diagnosing a refused steering continuation. */
  steeringDiagnostics(): {
    pendingContent: number;
    claimedItems: number;
    pendingInstructions: number;
    absorbedInstructions: number;
    rejectedInstructions: number;
    fingerprints: string[];
    contentIdentities: string[];
  } {
    return {
      pendingContent: this.pendingDirectSteerContent.size,
      claimedItems: this.directSteerItems.size,
      pendingInstructions: this.pendingInstructions.size,
      absorbedInstructions: this.absorbedInstructions.size,
      rejectedInstructions: this.rejectedInstructions.size,
      fingerprints: [...this.pendingInstructions, ...this.absorbedInstructions, ...this.rejectedInstructions.keys()]
        .map(value => value.slice(0, 8)),
      contentIdentities: [...this.pendingDirectSteerContent.keys()].map(value => value.slice(0, 8)),
    };
  }

  nextDirectSteerSequence(): number {
    return ++this.directSteerSequence;
  }

  enqueueControl(task: () => Promise<void>, interrupt?: Error): void {
    if (interrupt) {
      this.interrupted = true;
      this.cancellationError = interrupt;
      this.closeControl?.();
      this.currentRuntime.cancel(interrupt);
      const outstandingWaiters = [...this.outstandingWaiters];
      this.outstandingWaiters.clear();
      for (const waiter of outstandingWaiters) waiter();
      this.bumpRuntimeRevision();
    }
    this.controlTail = this.controlTail.then(async () => {
      if (this.interrupted && !interrupt) return;
      await task();
    }).catch(error => {
      const normalized = error instanceof Error ? error : new Error(String(error));
      this.closeControl?.();
      this.currentRuntime.cancel(normalized);
      this.failRuntimeTransition(normalized);
    });
  }

  isInterrupted(): boolean {
    return this.interrupted;
  }

  cancellationReason(): Error | undefined {
    return this.cancellationError;
  }

  async waitForControlIdle(): Promise<void> {
    await this.controlTail;
  }

  closeControlTail(): void {
    this.closeControl?.();
  }

  runExclusive<T>(task: () => Promise<T>): Promise<T> {
    this.touch();
    const run = this.tail.then(task);
    this.tail = run.then(() => undefined, () => undefined);
    this.scheduleCapabilityRetirement();
    return run;
  }

  touch(): void {
    this.lastTouchedAt = Date.now();
  }

  lastUsedAt(): number {
    return this.lastTouchedAt;
  }

  outstanding(): BrokerToolRequest[] {
    return [...this.outstandingById.values()];
  }

  waitForOutstandingResults(): Promise<void> {
    if (this.outstandingById.size === 0) return Promise.resolve();
    return new Promise(resolveWait => this.outstandingWaiters.add(resolveWait));
  }

  settledOutcome(): ChatGptBrowserOutcome | undefined {
    return this.settledBrowserOutcome;
  }

  conversationKey(): string | undefined {
    return this.attachedConversationKey;
  }

  detachConversation(conversationKey: string): boolean {
    if (this.attachedConversationKey !== conversationKey) return false;
    this.attachedConversationKey = undefined;
    return true;
  }

  isActive(): boolean {
    return this.settledBrowserOutcome === undefined;
  }

  /** The client-visible browser result can settle before launcher/helper cleanup does. */
  isPhysicallySettled(): boolean {
    return this.settledPhysical;
  }

  nextToolBatchSequence(): number {
    return this.toolBatchSequence + 1;
  }

  postToolContinuationMs(now = performance.now()): number | undefined {
    return this.lastToolResultsSettledAt === undefined
      ? undefined
      : Math.max(0, now - this.lastToolResultsSettledAt);
  }

  setOutstanding(
    requests: BrokerToolRequest[],
    reasoning: string[] = [],
    prelude: AdapterEvent[] = [],
    now = performance.now(),
  ): { sequence: number; toolCount: number } {
    if (this.outstandingById.size > 0) throw new Error("cannot emit a new ChatGPT tool batch while the previous batch is unresolved");
    if (requests.length === 0) throw new Error("cannot emit an empty ChatGPT tool batch");
    if (this.outstandingToolBatchTiming) throw new Error("cannot replace active ChatGPT tool-batch timing");
    for (const request of requests) {
      if (this.deliveredResultIds.has(request.callId) || this.outstandingById.has(request.callId)) {
        throw new Error(`duplicate ChatGPT bridge tool call id: ${request.callId}`);
      }
      this.outstandingById.set(request.callId, request);
    }
    const sequence = ++this.toolBatchSequence;
    this.outstandingToolBatchTiming = { sequence, toolCount: requests.length, emittedAt: now };
    this.outstandingReasoning = [...reasoning];
    this.outstandingPrelude = [...prelude];
    return { sequence, toolCount: requests.length };
  }

  hasOutstanding(callId: string): boolean {
    return this.outstandingById.has(callId);
  }

  markResultDelivered(callId: string): void {
    if (!this.outstandingById.delete(callId)) throw new Error(`ChatGPT bridge tool result does not match an outstanding call: ${callId}`);
    this.deliveredResultIds.add(callId);
    if (this.outstandingById.size === 0) {
      this.outstandingReasoning = [];
      this.outstandingPrelude = [];
      const waiters = [...this.outstandingWaiters];
      this.outstandingWaiters.clear();
      for (const waiter of waiters) waiter();
    }
  }

  finishOutstandingToolBatch(now = performance.now()): {
    sequence: number;
    toolCount: number;
    outerToolRoundtripMs: number;
  } {
    if (this.outstandingById.size > 0) {
      throw new Error("cannot finish ChatGPT tool-batch timing while results are still outstanding");
    }
    const timing = this.outstandingToolBatchTiming;
    if (!timing) throw new Error("ChatGPT tool-batch timing is unavailable");
    this.outstandingToolBatchTiming = undefined;
    this.lastToolResultsSettledAt = now;
    return {
      sequence: timing.sequence,
      toolCount: timing.toolCount,
      outerToolRoundtripMs: Math.max(0, now - timing.emittedAt),
    };
  }

  reasoningForOutstandingReplay(): string[] {
    return [...this.outstandingReasoning];
  }

  eventsForOutstandingReplay(): AdapterEvent[] {
    return [...this.outstandingPrelude];
  }

  setFinalReasoning(reasoning: string[]): void {
    this.finalReasoning = [...reasoning];
  }

  reasoningForFinalReplay(): string[] {
    return [...this.finalReasoning];
  }

  setFinalEvents(events: AdapterEvent[]): void {
    this.finalPrelude = [...events];
  }

  eventsForFinalReplay(): AdapterEvent[] {
    return [...this.finalPrelude];
  }

  roundEvents(key: string): AdapterEvent[] {
    return [...this.round(key).events];
  }

  roundReasoning(key: string): string[] {
    return [...this.round(key).reasoning];
  }

  appendRoundEvent(key: string, event: AdapterEvent): void {
    this.appendRoundEvents(key, [event]);
  }

  appendRoundEvents(key: string, events: readonly AdapterEvent[]): void {
    if (events.length === 0) return;
    const round = this.round(key);
    if (round.completed) throw new Error("cannot append to a completed ChatGPT native round");
    round.events.push(...events);
  }

  appendRoundReasoning(key: string, values: readonly string[]): void {
    if (values.length === 0) return;
    const round = this.round(key);
    if (round.completed) throw new Error("cannot append reasoning to a completed ChatGPT native round");
    round.reasoning.push(...values);
  }

  completeRound(key: string): void {
    this.round(key).completed = true;
  }

  failRound(key: string, error: Error): void {
    const round = this.round(key);
    round.failure = error;
    round.completed = true;
  }

  roundCompleted(key: string): boolean {
    return this.rounds.get(key)?.completed === true;
  }

  roundFailure(key: string): Error | undefined {
    return this.rounds.get(key)?.failure;
  }

  roundHasTerminalEvent(key: string): boolean {
    return this.rounds.get(key)?.events.some(event => event.type === "done" || event.type === "error") === true;
  }

  cancel(reason?: Error): void {
    this.closeControl?.();
    if (reason) this.cancellationError = reason;
    this.currentRuntime.cancel(reason);
  }

  private bumpRuntimeRevision(): void {
    this.runtimeRevision += 1;
    this.notifyRuntimeWaiters();
  }

  private notifyRuntimeWaiters(): void {
    const waiters = [...this.runtimeWaiters];
    this.runtimeWaiters.clear();
    for (const waiter of waiters) waiter();
  }

  private scheduleCapabilityRetirement(): void {
    if (this.capabilityRetirementScheduled || !this.runtime.retireCapability) return;
    this.capabilityRetirementScheduled = true;
    // Register only after the first observer entered `runExclusive`. This ensures an immediately
    // completed mocked/real browser cannot revoke its token ahead of the browser-outcome branch.
    // At physical settlement, read the current tail so every tool-result/reconnect observer that
    // was already admitted finishes before the capability is retired.
    const runtime = this.currentRuntime;
    const settlement = this.currentPhysicalSettlement;
    void settlement
      .then(() => this.tail)
      .then(() => runtime.retireCapability!())
      .catch(error => {
        console.error(
          `[chatgpt-web] failed to retire settled turn capability: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }

  private round(key: string) {
    let round = this.rounds.get(key);
    if (round) return round;
    round = { events: [], reasoning: [], completed: false };
    this.rounds.set(key, round);
    while (this.rounds.size > 512) {
      const oldestCompleted = [...this.rounds].find(([, candidate]) => candidate.completed);
      if (!oldestCompleted) {
        throw new Error("ChatGPT native round journal is full (512 unfinished rounds)");
      }
      this.rounds.delete(oldestCompleted[0]);
    }
    return round;
  }
}

export class ChatGptTurnSessions {
  private readonly entries = new Map<string, ChatGptTurnSession>();
  private readonly conversationHeads = new Map<string, ChatGptTurnSession>();
  private readonly retirements = new Map<string, Promise<void>>();
  private readonly ownerRetirements = new Map<string, Promise<void>>();
  private readonly conversationRetirements = new Map<string, Promise<void>>();

  constructor(
    private readonly ttlMs = 30 * 60_000,
    private readonly maxEntries = 256,
  ) {}

  getOrCreate(
    key: string,
    start: () => ChatGptTurnRuntime,
    traceId?: string,
    ownerKey?: string,
    nativeTurnId?: string,
    nativeThreadId?: string,
    instruction?: string,
    environment?: ChatGptTurnEnvironment,
    environmentContextIdentity?: string,
  ): ChatGptTurnSession {
    this.prune();
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.supersededError) throw existing.supersededError;
      existing.touch();
      return existing;
    }
    const active = [...this.entries.values()].filter(session => session.isActive()).length;
    if (active >= MAX_CHATGPT_BROWSER_TABS) {
      throw new Error(
        `ChatGPT Web supports at most ${MAX_CHATGPT_BROWSER_TABS} simultaneous browser turns; close or finish a browser tab before starting another`,
      );
    }
    if (this.entries.size >= this.maxEntries) throw new Error(`ChatGPT web session registry is full (${this.maxEntries} entries)`);
    const session = new ChatGptTurnSession(
      start(), traceId, ownerKey, nativeTurnId, nativeThreadId, instruction, environment, environmentContextIdentity,
    );
    this.entries.set(key, session);
    const conversationKey = session.conversationKey();
    // Only conversations deliberately retained after normal completion are durable heads. Read-only
    // turns may still carry a conversation key while active so steering can preserve/reuse their
    // exact Temporary Chat, but a normally completed read-only surface is released by the launcher.
    if (conversationKey && session.runtime.releaseRetainedConversation) {
      this.conversationHeads.set(conversationKey, session);
    }
    return session;
  }

  async getOrCreateAfterOwnerRetirement(
    key: string,
    ownerKey: string,
    start: () => ChatGptTurnRuntime,
    traceId?: string,
    signal?: AbortSignal,
    nativeTurnId?: string,
    nativeThreadId?: string,
    instruction?: ChatGptInstructionLineage,
    onSteeringSource?: (session: ChatGptTurnSession) => void,
    environment?: ChatGptTurnEnvironment,
    environmentContextIdentity?: string,
  ): Promise<ChatGptTurnSession> {
    for (;;) {
      if (signal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
      const existing = this.entries.get(key);
      if (existing) {
        if (existing.supersededError) throw existing.supersededError;
        existing.touch();
        return existing;
      }
      const absorbedOwner = instruction && nativeThreadId && nativeTurnId
        ? [...this.entries].find(([, session]) => (
          session.ownerKey === ownerKey
          && session.nativeThreadId === nativeThreadId
          && session.nativeTurnId === nativeTurnId
          && session.hasObservedInstruction(instruction.current)
        ))
        : undefined;
      if (absorbedOwner) {
        const [absorbedKey, absorbedSession] = absorbedOwner;
        this.entries.delete(absorbedKey);
        this.entries.set(key, absorbedSession);
        absorbedSession.touch();
        return absorbedSession;
      }
      const pending = this.retirements.get(key) ?? this.ownerRetirements.get(ownerKey);
      if (pending) {
        await awaitWithAbort(pending, signal);
        continue;
      }
      const activeOwner = [...this.entries].find(([ownedKey, session]) => (
        ownedKey !== key && session.ownerKey === ownerKey && !session.isPhysicallySettled()
      ));
      if (activeOwner) {
        const [ownedKey, ownedSession] = activeOwner;
        const sameNativeTurn = nativeThreadId !== undefined
          && nativeTurnId !== undefined
          && ownedSession.nativeThreadId === nativeThreadId
          && ownedSession.nativeTurnId === nativeTurnId;
        const ownedInstruction = ownedSession.instruction;
        if (ownedSession.isActive() && sameNativeTurn && instruction && ownedInstruction
          && instruction.current !== ownedInstruction) {
        if (!instruction.predecessors.has(ownedInstruction)) throw chatGptTurnSupersededError();
          // A provider replay is not permission to stop the browser. Live revisions must be
          // claimed by the authenticated control path above; an unclaimed replay fails locally.
          throw new ChatGptSteeringUnavailableError();
        }
        // A completed response may still be releasing its browser surface. Sequential work
        // waits for that cleanup; preemption requires a proven newer canonical instruction.
        await awaitWithAbort(ownedSession.physicalSettlement, signal);
        continue;
      }
      if (signal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
      return this.getOrCreate(
        key, start, traceId, ownerKey, nativeTurnId, nativeThreadId,
        instruction?.current, environment, environmentContextIdentity,
      );
    }
  }

  findNativeTurn(threadId: string, turnId: string, ownerKey?: string): ChatGptTurnSession | undefined {
    const session = [...new Set(this.entries.values())].find(candidate => (
      candidate.nativeThreadId === threadId
      && candidate.nativeTurnId === turnId
      && (ownerKey === undefined || candidate.ownerKey === ownerKey)
    ));
    // Keep a normally settled exact native turn discoverable for its registry TTL. Codex's
    // turn/steer implementation can open a provider observer only after the direct replacement
    // epoch has already completed; the absorbed instruction gate at the caller then replays that
    // same session journal without another browser submission. Failed/retired sessions are
    // removed from entries and cannot use this path.
    session?.touch();
    return session;
  }

  find(key: string): ChatGptTurnSession | undefined {
    const session = this.entries.get(key);
    session?.touch();
    return session;
  }

  findConversationHead(conversationKey: string): ChatGptTurnSession | undefined {
    const session = this.conversationHeads.get(conversationKey);
    session?.touch();
    return session;
  }

  /** Wait for a retained conversation epoch that has been detached but not physically released. */
  async waitForConversationRetirement(conversationKey: string, signal?: AbortSignal): Promise<void> {
    const pending = this.conversationRetirements.get(conversationKey);
    if (pending) await awaitWithAbort(pending, signal);
  }

  async retireConversationAndWait(conversationKey: string): Promise<number> {
    return this.closeConversationAndWait(conversationKey);
  }

  /**
   * Close the physical retained-chat epoch without discarding a terminal response that won the
   * compaction race before any compaction instruction reached that response. The detached logical
   * session remains addressable by its exact Responses execution key, so the post-compaction
   * native round can consume the already-committed answer instead of opening another browser turn.
   */
  async retireConversationPreservingFinalResponse(
    conversationKey: string,
    preserved: ChatGptTurnSession,
    preservedExecutionKey: string,
  ): Promise<number> {
    if (!preservedExecutionKey) throw new Error("Preserved ChatGPT response execution key is required");
    const outcome = preserved.settledOutcome();
    if (!outcome || outcome.type !== "final") {
      throw new Error("Only a settled final ChatGPT response can survive retained-conversation retirement");
    }
    return this.closeConversationAndWait(conversationKey, {
      session: preserved,
      executionKey: preservedExecutionKey,
    });
  }

  private async closeConversationAndWait(
    conversationKey: string,
    preserved?: { session: ChatGptTurnSession; executionKey: string },
  ): Promise<number> {
    const pending = this.conversationRetirements.get(conversationKey);
    if (pending) {
      await pending;
      return 0;
    }
    const matches = [...this.entries].filter(([, session]) => (
      session.conversationKey() === conversationKey
    ));
    if (matches.length === 0) return 0;
    if (preserved && !matches.some(([, session]) => session === preserved.session)) {
      throw new Error("The final ChatGPT response does not own the retained conversation being retired");
    }
    const target = preserved ? this.entries.get(preserved.executionKey) : undefined;
    if (target && target !== preserved?.session) {
      throw new Error("The compacted ChatGPT response execution key is already owned by another session");
    }
    this.conversationHeads.delete(conversationKey);
    for (const [key, session] of matches) {
      if (this.entries.get(key) === session
        && (session !== preserved?.session || key !== preserved.executionKey)) {
        this.entries.delete(key);
      }
      if (session.isActive()) session.cancel();
      if (!session.detachConversation(conversationKey)) {
        throw new Error("ChatGPT retained-conversation ownership changed during retirement");
      }
    }
    if (preserved) this.entries.set(preserved.executionKey, preserved.session);
    const release = matches.findLast(([, session]) => (
      session.runtime.releaseRetainedConversation !== undefined
    ))?.[1].runtime.releaseRetainedConversation;
    const retirement = Promise.all(matches.map(([, session]) => session.physicalSettlement))
      .then(async () => { await release?.(); });
    this.conversationRetirements.set(conversationKey, retirement);
    try {
      await retirement;
    } finally {
      if (this.conversationRetirements.get(conversationKey) === retirement) {
        this.conversationRetirements.delete(conversationKey);
      }
    }
    return matches.length;
  }

  async waitForRetirement(key: string): Promise<void> {
    await this.retirements.get(key);
  }

  async retireAndWait(key: string, signal?: AbortSignal): Promise<boolean> {
    const pending = this.retirements.get(key);
    if (pending) {
      await awaitWithAbort(pending, signal);
      return true;
    }
    const session = this.entries.get(key);
    if (!session) return false;

    this.entries.delete(key);
    this.forgetConversationHead(session);
    await awaitWithAbort(this.beginRetirement(key, session), signal);
    return true;
  }

  retire(key: string, session: ChatGptTurnSession): boolean {
    if (this.entries.get(key) !== session) return false;
    this.entries.delete(key);
    this.forgetConversationHead(session);
    this.beginRetirement(key, session);
    return true;
  }

  /** Cancel only active responses whose exact native turn ids Codex marked as interrupted. */
  retireAbortedOwnerTurns(
    ownerKey: string,
    abortedTurnIds: ReadonlySet<string>,
    keepKey: string,
  ): number {
    const matches = [...this.entries].filter(([key, session]) => (
      key !== keepKey
      && session.ownerKey === ownerKey
      && session.nativeTurnId !== undefined
      && abortedTurnIds.has(session.nativeTurnId)
      && session.isActive()
    ));
    for (const [key, session] of matches) {
      this.entries.delete(key);
      this.forgetConversationHead(session);
      this.beginRetirement(key, session);
    }
    return matches.length;
  }

  clear(): number {
    const cancelled = this.entries.size;
    for (const [key, session] of this.entries) this.beginRetirement(key, session);
    this.entries.clear();
    this.conversationHeads.clear();
    return cancelled;
  }

  async cancelTrace(traceId: string, reason = chatGptBrowserTabClosedError()): Promise<number> {
    const sessions = [...this.entries.values()]
      .filter(session => session.traceId === traceId && session.isActive());
    for (const session of sessions) session.cancel(reason);
    await Promise.all(sessions.map(session => session.physicalSettlement));
    return sessions.length;
  }

  /**
   * Begin retiring only the browser execution owned by the exact native Codex turn.
   *
   * Codex runs Interrupt hooks synchronously with a short deadline. Ownership is removed and the
   * abort is delivered before this method returns; physical helper cleanup remains represented by
   * `settlement`, so replacement turns still serialize behind the real teardown without blocking
   * the hook acknowledgement itself.
   */
  cancelNativeTurn(
    threadId: string,
    turnId: string,
    reason: Error,
  ): { cancelled: number; settlement: Promise<void> } {
    const matches = [...this.entries].filter(([, session]) => (
      session.nativeThreadId === threadId
      && session.nativeTurnId === turnId
    ));
    for (const [key, session] of matches) {
      if (this.entries.get(key) !== session) continue;
      this.entries.delete(key);
      this.forgetConversationHead(session);
    }
    const settlement = Promise.all(
      matches.map(([key, session]) => this.beginRetirement(key, session, reason)),
    ).then(() => undefined);
    return { cancelled: matches.length, settlement };
  }

  steerNativeTurn(
    threadId: string,
    turnId: string,
    itemId: string,
    content: unknown,
  ): number {
    const matches = [...new Set(this.entries.values())].filter(session => (
      session.nativeThreadId === threadId
      && session.nativeTurnId === turnId
      && session.isActive()
    ));
    let accepted = 0;
    for (const session of matches) if (session.submitDirectSteer(itemId, content)) accepted += 1;
    if (accepted === 0) {
      console.warn(
        `[chatgpt-web] no active ChatGPT session accepted the exact native steering turn (matches=${matches.length})`,
      );
    }
    return accepted;
  }

  cancelledError(traceId: string): Error | undefined {
    for (const session of this.entries.values()) {
      if (session.traceId !== traceId) continue;
      if (session.supersededError) return session.supersededError;
      const outcome = session.settledOutcome();
      if (outcome?.type !== "error") continue;
      if ("code" in outcome.error && outcome.error.code === "client_cancelled") return outcome.error;
    }
    return undefined;
  }

  activeCount(): number {
    this.prune();
    let active = 0;
    for (const session of this.entries.values()) if (session.isActive()) active += 1;
    return active;
  }

  private prune(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [key, session] of this.entries) {
      if (session.isActive() || session.lastUsedAt() >= cutoff) continue;
      session.cancel();
      this.entries.delete(key);
      this.forgetConversationHead(session);
    }
  }

  private forgetConversationHead(session: ChatGptTurnSession): void {
    const conversationKey = session.conversationKey();
    if (conversationKey && this.conversationHeads.get(conversationKey) === session) {
      this.conversationHeads.delete(conversationKey);
    }
  }

  private beginRetirement(key: string, session: ChatGptTurnSession, reason?: Error): Promise<void> {
    const existing = this.retirements.get(key);
    if (existing) return existing;
    const conversationKey = session.conversationKey();
    session.cancel(reason);
    const retirement = session.physicalSettlement;
    this.retirements.set(key, retirement);
    void retirement.then(() => {
      if (this.retirements.get(key) === retirement) this.retirements.delete(key);
    });
    if (session.ownerKey) {
      const previous = this.ownerRetirements.get(session.ownerKey);
      const ownerRetirement = previous
        ? Promise.all([previous, retirement]).then(() => undefined)
        : retirement;
      this.ownerRetirements.set(session.ownerKey, ownerRetirement);
      void ownerRetirement.then(() => {
        if (this.ownerRetirements.get(session.ownerKey!) === ownerRetirement) {
          this.ownerRetirements.delete(session.ownerKey!);
        }
      });
    }
    if (conversationKey) {
      const previous = this.conversationRetirements.get(conversationKey);
      const conversationRetirement = previous
        ? Promise.all([previous, retirement]).then(() => undefined)
        : retirement;
      this.conversationRetirements.set(conversationKey, conversationRetirement);
      const forgetConversationRetirement = () => {
        if (this.conversationRetirements.get(conversationKey) === conversationRetirement) {
          this.conversationRetirements.delete(conversationKey);
        }
      };
      void conversationRetirement.then(
        forgetConversationRetirement,
        forgetConversationRetirement,
      );
    }
    return retirement;
  }
}

export const chatGptTurnSessions = new ChatGptTurnSessions();
