/** All raw identifiers here stay in ephemeral memory. Never serialize this snapshot to metrics. */
export interface ChatGptRecoveryDomSnapshot {
  documentId?: string;
  currentConversationId?: string;
  userIdentities: string[];
  responseIdentities: string[];
  identityAmbiguous: boolean;
  assistantTurnIdentity?: string;
  /** Display-only React index, retained only for remount diagnostics; never ownership authority. */
  assistantDisplayIdentity?: string;
  messageId?: string;
  count: number;
  /** Optional content-free same-turn diagnostic candidate. Raw values stay in page/ephemeral memory. */
  turnId?: string;
  turnIdCount?: number;
  turnIdDocumentMatches?: number;
  uuidLike: boolean;
  /** Shape-only decomposition of message-id validity; no role/id values are serialized. */
  messageUuidLike?: boolean;
  messageRoleRelation?: "same-node" | "ancestor" | "descendant" | "subtree-other" | "missing" | "ambiguous" | "no-message";
  documentMatches: number;
  activity?: {
    generating: boolean; completionActionVisible: boolean; terminalVisible: boolean;
    visibleAlertCount?: number; emptyAlertCount?: number; ignoredEmptyAlertCount?: number;
    visibleDialogCount?: number; terminalTextVisible?: boolean;
    emptyAlertBlockers?: { structure: number; named: number; style: number; complex: number };
  };
}

export interface ChatGptRecoveryDomOptions {
  userSelector: string;
  assistantSelector: string;
  baselineResponseIdentities: readonly string[];
  activity?: { stopButtonSelector: string; completionActionSelector: string };
}

/** Serialized into a single synchronous page.evaluate. No cached state, awaits, or hidden state. */
export function collectChatGptRecoveryDomSnapshot(options: ChatGptRecoveryDomOptions): ChatGptRecoveryDomSnapshot {
  const root = document;
  const users = [...root.querySelectorAll(options.userSelector)];
  const assistants = [...root.querySelectorAll(options.assistantSelector)];
  const identities = (nodes: Element[], attribute: string) => nodes.map(node => node.getAttribute(attribute) ?? "");
  const containers = [...root.querySelectorAll("[data-turn-id-container]")].filter(element =>
    element.parentElement?.closest("[data-turn-id-container]")?.getAttribute("data-turn-id-container")
      !== element.getAttribute("data-turn-id-container"));
  const turnIdentities = identities(containers, "data-turn-id-container");
  const userIdentities = identities(users, "data-turn-id");
  const responseIdentities = identities(assistants, "data-turn-id");
  const invalid = (ids: string[]) => ids.some(id => !id) || new Set(ids).size !== ids.length;
  const knownTurns = new Set(turnIdentities);
  const identityAmbiguous = invalid(turnIdentities) || invalid(userIdentities) || invalid(responseIdentities)
    || [...userIdentities, ...responseIdentities].some(identity => !knownTurns.has(identity));
  const candidates = assistants.filter(node => !options.baselineResponseIdentities.includes(node.getAttribute("data-turn-id") ?? ""));
  const assistant = !identityAmbiguous && candidates.length === 1 ? candidates[0] : undefined;
  const nodes = assistant ? [assistant, ...assistant.querySelectorAll("[data-message-id]")]
    .filter(node => node.hasAttribute("data-message-id")) : [];
  const messageId = nodes.length === 1 ? nodes[0]!.getAttribute("data-message-id") ?? undefined : undefined;
  const turnNodes = assistant ? [assistant, ...assistant.querySelectorAll("[data-turn-id]")]
    .filter(node => node.hasAttribute("data-turn-id")) : [];
  const turnId = turnNodes.length === 1 ? turnNodes[0]!.getAttribute("data-turn-id") ?? undefined : undefined;
  const messageUuidLike = typeof messageId === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(messageId);
  const messageNode = nodes.length === 1 ? nodes[0] : undefined;
  const assistantRoleNodes = assistant ? [assistant, ...assistant.querySelectorAll("[data-message-author-role]")]
    .filter(node => node.getAttribute("data-message-author-role") === "assistant") : [];
  const linkedRoleNodes = messageNode ? assistantRoleNodes.filter(node => node === messageNode
    || node.contains(messageNode) || messageNode.contains(node)) : [];
  const messageRoleRelation: NonNullable<ChatGptRecoveryDomSnapshot["messageRoleRelation"]> = !messageNode
    ? "no-message"
    : messageNode.getAttribute("data-message-author-role") === "assistant"
      ? "same-node"
      : linkedRoleNodes.length > 1
        ? "ambiguous"
        : linkedRoleNodes.length === 1 && linkedRoleNodes[0]!.contains(messageNode)
          ? "ancestor"
          : linkedRoleNodes.length === 1 && messageNode.contains(linkedRoleNodes[0]!)
            ? "descendant"
            : assistantRoleNodes.length === 1
              ? "subtree-other"
              : assistantRoleNodes.length === 0 ? "missing" : "ambiguous";
  const uuidLike = messageUuidLike && messageRoleRelation === "same-node";
  const view = root.defaultView as (Window & { __CODEX_WEB_GPT_TURN_OBSERVER__?: { id: string } }) | null;
  const conversationPath = /^\/c\/([^/]+)\/?$/.exec(view?.location.pathname ?? "");
  const visible = (element: Element): boolean => {
    const bounds = element.getBoundingClientRect();
    const style = view?.getComputedStyle(element);
    return element.isConnected && !!style && style.visibility !== "hidden"
      && style.display !== "none" && (bounds.width > 0 || bounds.height > 0);
  };
  const visibleAlerts = options.activity ? [...root.querySelectorAll('[role="alert"]')].filter(visible) : [];
  const visibleDialogs = options.activity ? [...root.querySelectorAll('[role="dialog"]')].filter(visible) : [];
  const announcementShape = (node: Element): "content" | "structure" | "named" | "style" | "complex" | "empty" => {
    if (node.textContent?.trim()) return "content";
    const subtree = [node, ...node.querySelectorAll("*")];
    if (subtree.length > 32) return "complex";
    // Permit only a bounded tree of empty DIV/SPAN announcement containers. Icons, controls,
    // accessible names, open shadow content and CSS-generated content remain unknown/blocking.
    for (const part of subtree) {
      if (!["DIV", "SPAN"].includes(part.tagName) || part.shadowRoot) return "structure";
      if (part.hasAttribute("aria-label") || part.hasAttribute("aria-labelledby") || part.hasAttribute("title")
        || part.hasAttribute("tabindex") || part.hasAttribute("contenteditable")) return "named";
      const style = view?.getComputedStyle(part);
      const emptyPseudo = (pseudo: string) => ["none", "normal", '""', "''"].includes(view?.getComputedStyle(part, pseudo).content ?? "");
      if (style?.backgroundImage !== "none" || style.maskImage !== "none"
        || !emptyPseudo("::before") || !emptyPseudo("::after")) return "style";
    }
    return "empty";
  };
  const announcementShapes = visibleAlerts.map(announcementShape);
  const ignoredEmptyAlertCount = announcementShapes.filter(shape => shape === "empty").length;
  const terminalTextVisible = !!options.activity && !!assistant && [...assistant.querySelectorAll('*')].some(node => visible(node)
    && /^(?:Something went wrong(?:\..*)?|Stopped thinking)$/i.test(node.textContent?.trim() ?? ""));
  const activity = options.activity ? {
    generating: [...root.querySelectorAll(options.activity.stopButtonSelector)].filter(visible).length === 1,
    completionActionVisible: !!assistant && [...assistant.querySelectorAll(options.activity.completionActionSelector)].some(visible),
    // Nonempty/unknown alerts and every visible dialog still block evidence. No text leaves the page.
    terminalVisible: visibleAlerts.length > ignoredEmptyAlertCount || visibleDialogs.length > 0 || terminalTextVisible,
    visibleAlertCount: visibleAlerts.length,
    emptyAlertCount: visibleAlerts.filter(node => !node.textContent?.trim()).length,
    ignoredEmptyAlertCount,
    emptyAlertBlockers: {
      structure: announcementShapes.filter(shape => shape === "structure").length,
      named: announcementShapes.filter(shape => shape === "named").length,
      style: announcementShapes.filter(shape => shape === "style").length,
      complex: announcementShapes.filter(shape => shape === "complex").length,
    },
    visibleDialogCount: visibleDialogs.length,
    terminalTextVisible,
  } : undefined;
  return {
    documentId: view?.__CODEX_WEB_GPT_TURN_OBSERVER__?.id,
    currentConversationId: conversationPath?.[1],
    userIdentities, responseIdentities, identityAmbiguous,
    assistantTurnIdentity: assistant?.getAttribute("data-turn-id") ?? undefined,
    assistantDisplayIdentity: assistant?.getAttribute("data-testid") ?? undefined,
    messageId, count: nodes.length, uuidLike, messageUuidLike, messageRoleRelation,
    documentMatches: messageId === undefined ? 0 : [...root.querySelectorAll("[data-message-id]")]
      .filter(node => node.getAttribute("data-message-id") === messageId).length,
    turnId, turnIdCount: turnNodes.length,
    turnIdDocumentMatches: turnId === undefined ? 0 : [...root.querySelectorAll("[data-turn-id]")]
      .filter(node => node.getAttribute("data-turn-id") === turnId).length,
    ...(activity ? { activity } : {}),
  };
}


export interface ChatGptRecoveryTurnIdContinuityDiagnostic {
  turnIdObserved: boolean;
  turnIdValidObservations: number;
  turnIdInvalidObservations: number;
  turnIdAssistantTransitions: number;
  turnIdStableAssistantTransitions: number;
  turnIdConflict: boolean;
  turnIdStableAcrossObservedAssistantTransitions: boolean;
}

/**
 * Diagnostic-only continuity tracker for the page's `data-turn-id`. The raw identifier is retained
 * only in this ephemeral object. It never becomes a conversation ID or recovery authorization.
 */
export class ChatGptRecoveryTurnIdContinuityTracker {
  private turnId?: string;
  private firstAssistant?: string;
  private lastAssistant?: string;
  private validObservations = 0;
  private invalidObservations = 0;
  private assistantTransitions = 0;
  private stableAssistantTransitions = 0;
  private conflicted = false;

  private valid(snapshot: ChatGptRecoveryDomSnapshot): snapshot is ChatGptRecoveryDomSnapshot & {
    turnId: string; assistantTurnIdentity: string;
  } {
    return !snapshot.identityAmbiguous && typeof snapshot.turnId === "string" && snapshot.turnId.length > 0
      && snapshot.turnIdCount === 1 && snapshot.turnIdDocumentMatches === 1
      && typeof snapshot.assistantTurnIdentity === "string" && snapshot.assistantTurnIdentity.length > 0;
  }

  observe(snapshot: ChatGptRecoveryDomSnapshot): void {
    if (!this.valid(snapshot)) { this.invalidObservations += 1; return; }
    this.validObservations += 1;
    if (this.turnId === undefined) {
      this.turnId = snapshot.turnId;
      const displayIdentity = snapshot.assistantDisplayIdentity ?? snapshot.assistantTurnIdentity;
      this.firstAssistant = displayIdentity;
      this.lastAssistant = displayIdentity;
      return;
    }
    const sameTurnId = this.turnId === snapshot.turnId;
    if (!sameTurnId) this.conflicted = true;
    const displayIdentity = snapshot.assistantDisplayIdentity ?? snapshot.assistantTurnIdentity;
    if (this.lastAssistant !== undefined && this.lastAssistant !== displayIdentity) {
      this.assistantTransitions += 1;
      if (sameTurnId) this.stableAssistantTransitions += 1;
    }
    this.lastAssistant = displayIdentity;
  }

  compareFresh(snapshot: ChatGptRecoveryDomSnapshot): {
    turnIdFreshPresent: boolean;
    turnIdFreshEqual: boolean;
    turnIdAssistantChangedFromFirst: boolean;
  } {
    if (!this.valid(snapshot)) {
      return { turnIdFreshPresent: false, turnIdFreshEqual: false, turnIdAssistantChangedFromFirst: false };
    }
    return {
      turnIdFreshPresent: true,
      turnIdFreshEqual: this.turnId !== undefined && !this.conflicted && snapshot.turnId === this.turnId,
      turnIdAssistantChangedFromFirst: this.firstAssistant !== undefined
        && (snapshot.assistantDisplayIdentity ?? snapshot.assistantTurnIdentity) !== this.firstAssistant,
    };
  }

  diagnostic(): ChatGptRecoveryTurnIdContinuityDiagnostic {
    return {
      turnIdObserved: this.turnId !== undefined,
      turnIdValidObservations: this.validObservations,
      turnIdInvalidObservations: this.invalidObservations,
      turnIdAssistantTransitions: this.assistantTransitions,
      turnIdStableAssistantTransitions: this.stableAssistantTransitions,
      turnIdConflict: this.conflicted,
      turnIdStableAcrossObservedAssistantTransitions: this.assistantTransitions > 0
        && this.assistantTransitions === this.stableAssistantTransitions && !this.conflicted,
    };
  }
}


/**
 * Optional active-capture sampling only. The window never renews, reads are capped and serialized,
 * and late completions cannot record evidence after abort/terminal capture. No browser actions are
 * owned here: callers supply a read-only atomic reader and an in-memory provenance recorder.
 */
export class ChatGptRecoveryMessageSampler {
  private readonly windowStarted = Date.now();
  private readonly deadline: number;
  private attempts = 0;
  private observations = 0;
  private failures = 0;
  private wireTerminalReads = 0;
  private inactiveReads = 0;
  private completionReads = 0;
  private terminalReads = 0;
  private maxVisibleAlerts = 0;
  private maxEmptyAlerts = 0;
  private maxIgnoredEmptyAlerts = 0;
  private readonly alertBlockers = { structure: 0, named: 0, style: 0, complex: 0 };
  private maxVisibleDialogs = 0;
  private terminalTextReads = 0;
  private readonly messageShapes = { missing: 0, multiple: 0, invalidUuidOrRole: 0, nonuniqueDocument: 0, ambiguousTurns: 0, missingAssistant: 0, unique: 0 };
  private readonly messageRoleShapes = { sameNode: 0, ancestor: 0, descendant: 0, subtreeOther: 0, missing: 0, ambiguous: 0, noMessage: 0 };
  private messageUuidLikeReads = 0;
  private readonly skips = { closed: 0, aborted: 0, deadline: 0, capture: 0, wireTerminal: 0, pending: 0, limit: 0, cadence: 0 };
  private lastAttempt = -Infinity;
  private pending = false;
  private closed = false;
  private readonly stopController = new AbortController();
  private readonly signal: AbortSignal;

  constructor(private readonly options: {
    turnDeadline?: number;
    signal?: AbortSignal;
    isCapturing: () => boolean;
    wireTerminal: () => boolean;
    finalTextStarted?: () => boolean;
    read: (signal: AbortSignal) => Promise<ChatGptRecoveryDomSnapshot>;
    record: (snapshot: ChatGptRecoveryDomSnapshot) => void;
  }) {
    this.deadline = Math.min(this.windowStarted + 15_000, options.turnDeadline ?? Infinity);
    this.signal = options.signal ? AbortSignal.any([options.signal, this.stopController.signal]) : this.stopController.signal;
  }

  private eligible(): boolean {
    return !this.closed && !this.options.signal?.aborted && Date.now() < this.deadline
      && this.options.isCapturing() && !this.options.wireTerminal();
  }

  async sample(): Promise<void> {
    // Fixed categories distinguish a skipped read from an observed missing/invalid message.
    const skip = this.pending ? "pending" : this.closed ? "closed" : this.options.signal?.aborted ? "aborted"
      : Date.now() >= this.deadline ? "deadline" : !this.options.isCapturing() ? "capture"
        : this.options.wireTerminal() ? "wireTerminal" : this.attempts >= 12 ? "limit"
          : Date.now() - this.lastAttempt < 250 ? "cadence" : undefined;
    if (skip) { this.skips[skip] += 1; return; }
    this.attempts += 1;
    this.lastAttempt = Date.now();
    this.pending = true;
    const readDeadline = Math.min(this.deadline, Date.now() + 1_000);
    try {
      await withChatGptRecoveryDiagnosticBudget(readDeadline, this.signal, async signal => {
        const snapshot = await this.options.read(signal);
        if (Date.now() >= readDeadline) throw new Error("early diagnostic read budget exhausted");
        if (signal.aborted || !this.eligible()) {
          if (this.options.wireTerminal()) this.wireTerminalReads += 1;
          return;
        }
        const activity = snapshot.activity;
        this.maxVisibleAlerts = Math.max(this.maxVisibleAlerts, activity?.visibleAlertCount ?? 0);
        this.maxEmptyAlerts = Math.max(this.maxEmptyAlerts, activity?.emptyAlertCount ?? 0);
        this.maxIgnoredEmptyAlerts = Math.max(this.maxIgnoredEmptyAlerts, activity?.ignoredEmptyAlertCount ?? 0);
        for (const key of ["structure", "named", "style", "complex"] as const) {
          this.alertBlockers[key] = Math.max(this.alertBlockers[key], activity?.emptyAlertBlockers?.[key] ?? 0);
        }
        this.maxVisibleDialogs = Math.max(this.maxVisibleDialogs, activity?.visibleDialogCount ?? 0);
        if (activity?.terminalTextVisible) this.terminalTextReads += 1;
        if (!activity?.generating) this.inactiveReads += 1;
        if (activity?.completionActionVisible) this.completionReads += 1;
        if (activity?.terminalVisible) this.terminalReads += 1;
        if (activity?.completionActionVisible || activity?.terminalVisible) this.closed = true;
        if (!activity?.generating || activity.completionActionVisible || activity.terminalVisible) return;
        if (snapshot.messageUuidLike) this.messageUuidLikeReads += 1;
        const roleKey = snapshot.messageRoleRelation === "same-node" ? "sameNode"
          : snapshot.messageRoleRelation === "subtree-other" ? "subtreeOther"
            : snapshot.messageRoleRelation === "no-message" ? "noMessage" : snapshot.messageRoleRelation;
        if (roleKey && roleKey in this.messageRoleShapes) {
          const roleShapes = this.messageRoleShapes as Record<string, number>;
          roleShapes[roleKey] = (roleShapes[roleKey] ?? 0) + 1;
        }
        if (snapshot.count === 0) this.messageShapes.missing++;
        else if (snapshot.count !== 1) this.messageShapes.multiple++;
        else if (!snapshot.uuidLike) this.messageShapes.invalidUuidOrRole++;
        else if (snapshot.documentMatches !== 1) this.messageShapes.nonuniqueDocument++;
        else if (snapshot.identityAmbiguous) this.messageShapes.ambiguousTurns++;
        else if (!snapshot.assistantTurnIdentity) this.messageShapes.missingAssistant++;
        else this.messageShapes.unique++;
        this.options.record(snapshot);
        this.observations += 1;
      });
    } catch {
      // A transport failure is not an observed missing ID. Stop optional reads; never retry Send.
      if (!this.closed) this.failures += 1;
      this.closed = true;
    } finally {
      this.pending = false;
    }
  }

  /** Latch completion/terminal evidence seen by the outer capture loop, including skipped reads. */
  close(): void {
    this.closed = true;
    this.stopController.abort();
  }

  /** A single local bounded reader, independent of optional screenshot I/O. No submission work. */
  async run(): Promise<void> {
    while (this.eligible() && this.attempts < 12) {
      await this.sample();
      if (!this.eligible() || this.attempts >= 12) break;
      // Preserve some of the fixed read budget while High is still thinking. This signal only
      // controls cadence; original wire text never becomes fresh DOM/conversation evidence.
      const cadence = this.options.finalTextStarted?.() === false ? 1_000 : 250;
      await new Promise<void>(resolve => {
        const finish = () => { clearTimeout(timer); this.signal.removeEventListener("abort", finish); resolve(); };
        const timer = setTimeout(finish, Math.max(0, Math.min(cadence, this.deadline - Date.now())));
        this.signal.addEventListener("abort", finish, { once: true });
        if (this.signal.aborted) finish();
      });
    }
  }

  diagnostic() {
    return { earlySampleAttempts: this.attempts, earlyActiveObservations: this.observations, earlySampleFailures: this.failures,
      earlyWireTerminalReads: this.wireTerminalReads, earlyInactiveReads: this.inactiveReads,
      earlyCompletionReads: this.completionReads, earlyTerminalReads: this.terminalReads,
      earlyMaxVisibleAlerts: this.maxVisibleAlerts, earlyMaxEmptyAlerts: this.maxEmptyAlerts,
      earlyMaxIgnoredEmptyAlerts: this.maxIgnoredEmptyAlerts,
      earlyEmptyAlertBlockers: { ...this.alertBlockers },
      earlyMaxVisibleDialogs: this.maxVisibleDialogs, earlyTerminalTextReads: this.terminalTextReads,
      earlyMessageShapes: { ...this.messageShapes }, earlyMessageUuidLikeReads: this.messageUuidLikeReads,
      earlyMessageRoleShapes: { ...this.messageRoleShapes },
      earlySamplingSpanMs: this.attempts === 0 ? 0 : Math.max(0, this.lastAttempt - this.windowStarted),
      earlySkipReasons: { ...this.skips } };
  }
}

/** Equality fence around a separate Markdown read; does not infer conversation membership. */
export function sameChatGptRecoveryDomSnapshot(left: ChatGptRecoveryDomSnapshot, right: ChatGptRecoveryDomSnapshot): boolean {
  const sameIds = (a: string[], b: string[]) => a.length === b.length && a.every((id, index) => id === b[index]);
  return !left.identityAmbiguous && !right.identityAmbiguous
    && left.count === 1 && right.count === 1 && left.uuidLike && right.uuidLike
    && left.documentMatches === 1 && right.documentMatches === 1
    && !!left.documentId && left.documentId === right.documentId
    && !!left.messageId && left.messageId === right.messageId
    && !!left.assistantTurnIdentity && left.assistantTurnIdentity === right.assistantTurnIdentity
    && left.currentConversationId === right.currentConversationId
    && sameIds(left.userIdentities, right.userIdentities)
    && sameIds(left.responseIdentities, right.responseIdentities);
}

/** One absolute budget for the entire diagnostic, not a renewed timeout per operation. */
export async function withChatGptRecoveryDiagnosticBudget<T>(
  turnDeadline: number | undefined,
  outerSignal: AbortSignal | undefined,
  action: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const remaining = Math.min(15_000, (turnDeadline ?? Infinity) - Date.now());
  if (remaining <= 0 || outerSignal?.aborted) throw new Error("recovery diagnostic budget exhausted");
  const controller = new AbortController();
  const abort = () => controller.abort();
  outerSignal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, remaining);
  let onAbort: (() => void) | undefined;
  try {
    const expired = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error("recovery diagnostic budget exhausted"));
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    return await Promise.race([action(controller.signal), expired]);
  } finally {
    clearTimeout(timer);
    outerSignal?.removeEventListener("abort", abort);
    if (onAbort) controller.signal.removeEventListener("abort", onAbort);
    controller.abort();
  }
}
