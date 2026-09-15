export interface ChatGptRecoveryTurnIdMutationContinuityResult {
  available: boolean;
  sameDocument: boolean;
  expired: boolean;
  turnIdObserved: boolean;
  turnIdConflict: boolean;
  validSnapshots: number;
  invalidSnapshots: number;
  assistantTransitions: number;
  stableAssistantTransitions: number;
  turnIdMutationRecords: number;
  turnIdAbaRecords: number;
  stable: boolean;
}

/**
 * Default-off, page-local generation diagnostic. Raw `data-turn-id` and assistant identities never
 * leave the page closure. The observer only returns bounded counts/booleans and authorizes nothing.
 */
export function startChatGptRecoveryTurnIdMutationContinuity(options: {
  token: string;
  documentId: string;
  deadline: number;
  userSelector: string;
  assistantSelector: string;
  baselineResponseIdentities: readonly string[];
}): boolean {
  const root = document;
  const view = root.defaultView as (Window & {
    __CODEX_WEB_GPT_TURN_OBSERVER__?: { id: string };
    __CODEX_WEB_GPT_TURN_ID_CONTINUITY__?: {
      token: string;
      finish(): ChatGptRecoveryTurnIdMutationContinuityResult;
    };
  }) | null;
  if (!view || !options.token || !options.documentId || !Number.isFinite(options.deadline)
    || Date.now() >= options.deadline || view.__CODEX_WEB_GPT_TURN_ID_CONTINUITY__
    || view.__CODEX_WEB_GPT_TURN_OBSERVER__?.id !== options.documentId) return false;

  const expiresAt = Math.min(options.deadline, Date.now() + 15_000);
  const initialUrl = view.location.href;
  const baseline = new Set(options.baselineResponseIdentities);
  const trackedTurnNodes = new WeakSet<Element>();
  let turnId: string | undefined;
  let firstAssistant: string | undefined;
  let lastAssistant: string | undefined;
  let validSnapshots = 0;
  let invalidSnapshots = 0;
  let assistantTransitions = 0;
  let stableAssistantTransitions = 0;
  let turnIdMutationRecords = 0;
  let turnIdAbaRecords = 0;
  let conflicted = false;
  let expired = false;
  let navigated = false;

  const snapshot = (): void => {
    const assistants = [...root.querySelectorAll(options.assistantSelector)];
    const candidates = assistants.filter(node => !baseline.has(node.getAttribute("data-turn-id") ?? ""));
    if (candidates.length !== 1) { invalidSnapshots += 1; if (turnId !== undefined) conflicted = true; return; }
    const assistant = candidates[0]!;
    const identity = assistant.getAttribute("data-testid") ?? "";
    const turnNodes = [assistant, ...assistant.querySelectorAll("[data-turn-id]")]
      .filter(node => node.hasAttribute("data-turn-id"));
    if (!identity.startsWith("conversation-turn-") || turnNodes.length !== 1) {
      invalidSnapshots += 1; if (turnId !== undefined) conflicted = true; return;
    }
    const node = turnNodes[0]!;
    const nextTurnId = node.getAttribute("data-turn-id") ?? "";
    const documentMatches = nextTurnId ? [...root.querySelectorAll("[data-turn-id]")]
      .filter(candidate => candidate.getAttribute("data-turn-id") === nextTurnId).length : 0;
    if (!nextTurnId || documentMatches !== 1) {
      invalidSnapshots += 1; if (turnId !== undefined) conflicted = true; return;
    }
    trackedTurnNodes.add(node);
    validSnapshots += 1;
    if (turnId === undefined) {
      turnId = nextTurnId;
      firstAssistant = identity;
      lastAssistant = identity;
      return;
    }
    const same = turnId === nextTurnId;
    if (!same) conflicted = true;
    if (lastAssistant !== undefined && lastAssistant !== identity) {
      assistantTransitions += 1;
      if (same) stableAssistantTransitions += 1;
    }
    lastAssistant = identity;
  };

  const consume = (records: MutationRecord[]): void => {
    for (const record of records) {
      if (record.type === "attributes" && record.attributeName === "data-turn-id"
        && trackedTurnNodes.has(record.target as Element)) {
        turnIdMutationRecords = Math.min(1_000, turnIdMutationRecords + 1);
        if (turnId !== undefined && typeof record.oldValue === "string" && record.oldValue.length > 0
          && record.oldValue !== turnId) {
          turnIdAbaRecords = Math.min(1_000, turnIdAbaRecords + 1);
          conflicted = true;
        }
      }
    }
    snapshot();
  };

  snapshot();
  const observer = new MutationObserver(consume);
  observer.observe(root.documentElement, { subtree: true, childList: true, attributes: true,
    attributeOldValue: true, attributeFilter: ["data-turn-id", "data-testid"] });
  const onNavigation = () => { navigated = true; };
  for (const event of ["pagehide", "popstate", "hashchange"]) view.addEventListener(event, onNavigation);
  const removeListeners = () => {
    for (const event of ["pagehide", "popstate", "hashchange"]) view.removeEventListener(event, onNavigation);
  };
  const result = (timedOut: boolean): ChatGptRecoveryTurnIdMutationContinuityResult => {
    const sameDocument = document === root && view.__CODEX_WEB_GPT_TURN_OBSERVER__?.id === options.documentId
      && view.location.href === initialUrl && !navigated;
    const stable = turnId !== undefined && !conflicted && sameDocument && !timedOut;
    return { available: true, sameDocument, expired: timedOut, turnIdObserved: turnId !== undefined,
      turnIdConflict: conflicted, validSnapshots, invalidSnapshots, assistantTransitions, stableAssistantTransitions,
      turnIdMutationRecords, turnIdAbaRecords, stable };
  };
  const timer = setTimeout(() => {
    expired = true;
    observer.disconnect();
    removeListeners();
    if (view.__CODEX_WEB_GPT_TURN_ID_CONTINUITY__?.token === options.token) {
      const receipt = result(true);
      view.__CODEX_WEB_GPT_TURN_ID_CONTINUITY__ = { token: options.token, finish: () => receipt };
    }
  }, Math.max(0, expiresAt - Date.now()));
  view.__CODEX_WEB_GPT_TURN_ID_CONTINUITY__ = { token: options.token, finish: () => {
    consume(observer.takeRecords());
    observer.disconnect();
    clearTimeout(timer);
    removeListeners();
    return result(expired || Date.now() >= expiresAt);
  } };
  return true;
}

export function finishChatGptRecoveryTurnIdMutationContinuity(token: string): ChatGptRecoveryTurnIdMutationContinuityResult {
  const view = document.defaultView as (Window & {
    __CODEX_WEB_GPT_TURN_ID_CONTINUITY__?: { token: string; finish(): ChatGptRecoveryTurnIdMutationContinuityResult };
  }) | null;
  const state = view?.__CODEX_WEB_GPT_TURN_ID_CONTINUITY__;
  if (!view || !state || state.token !== token) {
    return { available: false, sameDocument: false, expired: false, turnIdObserved: false, turnIdConflict: false,
      validSnapshots: 0, invalidSnapshots: 0, assistantTransitions: 0, stableAssistantTransitions: 0,
      turnIdMutationRecords: 0, turnIdAbaRecords: 0, stable: false };
  }
  try { return state.finish(); }
  finally { delete view.__CODEX_WEB_GPT_TURN_ID_CONTINUITY__; }
}
