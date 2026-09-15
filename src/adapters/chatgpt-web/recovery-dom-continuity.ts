export interface ChatGptRecoveryDomContinuityResult {
  available: boolean;
  sameDocument: boolean;
  expired: boolean;
  identityMutationRecords: number;
  unchanged: boolean;
}

/**
 * Page-local, self-expiring diagnostic for identity mutations DURING a completed-turn reconnect.
 * It catches remount and identity A->B->A records even when endpoint snapshots are equal.
 * It is not a server conversation proof, a content-history proof or a production recovery gate.
 * Serialized as one page.evaluate; all ownership IDs/tokens remain in memory.
 */
export function startChatGptRecoveryDomContinuity(options: {
  token: string; documentId: string; deadline: number; userSelector: string; assistantSelector: string;
}): boolean {
  const root = document;
  const view = root.defaultView as (Window & {
    __CODEX_WEB_GPT_TURN_OBSERVER__?: { id: string };
    __CODEX_WEB_GPT_RECOVERY_CONTINUITY__?: { token: string; finish(): ChatGptRecoveryDomContinuityResult };
  }) | null;
  if (!view || !options.token || !options.documentId || !Number.isFinite(options.deadline) || view.__CODEX_WEB_GPT_RECOVERY_CONTINUITY__
    || view.__CODEX_WEB_GPT_TURN_OBSERVER__?.id !== options.documentId || Date.now() >= options.deadline) return false;
  const expiresAt = Math.min(options.deadline, Date.now() + 15_000);
  const initialUrl = view.location.href;
  const selector = `${options.userSelector}, ${options.assistantSelector}, [data-message-id]`;
  const tracked = new WeakSet<Element>(root.querySelectorAll(selector));
  let mutations = 0;
  let expired = false;
  let navigated = false;
  const relevantNode = (node: Node): boolean => node.nodeType === 1 && (tracked.has(node as Element)
    || (node as Element).matches(selector) || (node as Element).querySelector(selector) !== null);
  const consume = (records: MutationRecord[]): void => {
    for (const record of records) {
      const relevant = record.type === "attributes"
        ? record.attributeName === "data-message-id" || tracked.has(record.target as Element)
          || relevantNode(record.target) || (record.attributeName === "data-testid" && record.oldValue?.startsWith("conversation-turn-") === true)
        : record.type === "childList" && [...record.addedNodes, ...record.removedNodes].some(relevantNode);
      if (relevant) mutations = Math.min(1_000, mutations + 1); // Saturating diagnostic counter.
    }
  };
  const observer = new MutationObserver(consume);
  observer.observe(root.documentElement, { subtree: true, childList: true, attributes: true, attributeOldValue: true,
    attributeFilter: ["data-testid", "data-message-id", "data-message-author-role", "data-turn", "data-turn-id", "data-turn-id-container"] });
  const onNavigation = () => { navigated = true; };
  for (const event of ["pagehide", "popstate", "hashchange"]) view.addEventListener(event, onNavigation);
  const removeListeners = () => {
    for (const event of ["pagehide", "popstate", "hashchange"]) view.removeEventListener(event, onNavigation);
  };
  const timer = setTimeout(() => {
    expired = true;
    observer.disconnect();
    removeListeners();
    // Leave only a small expiry receipt; release the observer/DOM closure if the caller vanished.
    if (view.__CODEX_WEB_GPT_RECOVERY_CONTINUITY__?.token === options.token) {
      view.__CODEX_WEB_GPT_RECOVERY_CONTINUITY__ = { token: options.token,
        finish: () => ({ available: true, sameDocument: false, expired: true, identityMutationRecords: 0, unchanged: false }) };
    }
  }, Math.max(0, expiresAt - Date.now()));
  view.__CODEX_WEB_GPT_RECOVERY_CONTINUITY__ = { token: options.token, finish: () => {
    consume(observer.takeRecords()); // Drain same-task A->B->A before disconnect loses its records.
    observer.disconnect();
    clearTimeout(timer);
    removeListeners();
    const sameDocument = document === root && view.__CODEX_WEB_GPT_TURN_OBSERVER__?.id === options.documentId
      && view.location.href === initialUrl && !navigated;
    const timedOut = expired || Date.now() >= expiresAt;
    return { available: true, sameDocument, expired: timedOut, identityMutationRecords: mutations,
      unchanged: sameDocument && !timedOut && mutations === 0 };
  } };
  return true;
}

/** Fresh page-side read + cleanup; a missing/wrong-token receipt cannot prove continuity. */
export function finishChatGptRecoveryDomContinuity(token: string): ChatGptRecoveryDomContinuityResult {
  const view = document.defaultView as (Window & {
    __CODEX_WEB_GPT_RECOVERY_CONTINUITY__?: { token: string; finish(): ChatGptRecoveryDomContinuityResult };
  }) | null;
  const state = view?.__CODEX_WEB_GPT_RECOVERY_CONTINUITY__;
  if (!view || !state || state.token !== token) {
    return { available: false, sameDocument: false, expired: false, identityMutationRecords: 0, unchanged: false };
  }
  try { return state.finish(); }
  finally { delete view.__CODEX_WEB_GPT_RECOVERY_CONTINUITY__; }
}
