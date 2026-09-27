import type { Locator, Page } from "playwright-core";
import type { ChatGptWebAccountCapabilities } from "./chatgpt-web-models";

export const CHATGPT_TEMPORARY_CHAT_URL = "https://chatgpt.com/?temporary-chat=true";
export const CHATGPT_COMPOSER_SELECTOR = [
  '[data-testid="prompt-textarea"]',
  "#prompt-textarea",
  '[contenteditable="true"][data-lexical-editor="true"]',
  '[contenteditable="true"][data-composer-markdown][role="textbox"]',
].join(", ");
export const CHATGPT_EFFORT_CONTROL_SELECTOR = [
  'button[aria-haspopup="menu"][data-tone="neutral"]',
  'button[data-testid="model-switcher-dropdown-button"][aria-haspopup="menu"]',
  'button[data-codex-intelligence-trigger="true"][aria-haspopup="menu"]',
].join(", ");
export const CHATGPT_EFFORT_MENU_SELECTOR = [
  '[data-testid="composer-intelligence-picker-content"]:has([role="menuitemradio"], [data-model-reasoning-effort-slider], [data-model-picker-power-slider], [data-reasoning-slider])',
  '[role="menu"]:has([role="menuitemradio"], [data-model-reasoning-effort-slider], [data-model-picker-power-slider], [data-reasoning-slider])',
  '[role="group"]:has([role="menuitemradio"], [data-model-reasoning-effort-slider], [data-model-picker-power-slider], [data-reasoning-slider])',
].join(", ");
export const CHATGPT_EFFORT_ITEM_SELECTOR = '[role="menuitemradio"]';
export const CHATGPT_EFFORT_SLIDER_CONTAINER_SELECTOR = [
  '[data-model-reasoning-effort-slider]',
  '[data-model-picker-power-slider]',
  '[data-reasoning-slider="true"]',
].join(", ");
export const CHATGPT_EFFORT_SLIDER_SELECTOR = [
  '[data-model-reasoning-effort-slider] [role="slider"]',
  '[data-model-picker-power-slider] [role="slider"]',
  '[data-reasoning-slider="true"] [role="slider"]',
].join(", ");

function effortMenuSelectorForId(menuId: string): string {
  return `[id=${JSON.stringify(menuId)}]`;
}

/** Resolve the effort surface owned by this exact control instead of an unrelated/closing menu. */
export async function chatGptEffortMenuForControl(page: Page, control: Locator): Promise<Locator> {
  const menuId = await control.getAttribute("aria-controls").catch(() => null);
  if (menuId) return page.locator(effortMenuSelectorForId(menuId));
  return page.locator(CHATGPT_EFFORT_MENU_SELECTOR).last();
}

/** Radix keeps a closing slider visible briefly; owner state outranks that exit animation. */
export async function chatGptEffortSurfaceIsOpen(control: Locator): Promise<boolean> {
  const expanded = await control.getAttribute("aria-expanded").catch(() => null);
  const state = await control.getAttribute("data-state").catch(() => null);
  return expanded !== "false" && state !== "closed";
}
export const CHATGPT_EFFORT_SLIDER_MAX_OPTIONS = 5;
export const CHATGPT_STOP_BUTTON_SELECTOR = '[data-testid="stop-button"]';
export const CHATGPT_COMPLETION_ACTION_SELECTOR = 'button[data-testid="copy-turn-action-button"], [data-turn-key] .turn-action-controls button';
export const CHATGPT_ASSISTANT_TURN_SELECTOR = [
  '[data-testid^="conversation-turn-"][data-turn="assistant"]:not([data-turn-key] *)',
  '[data-testid^="conversation-turn-"][data-message-author-role="assistant"]:not([data-turn-key] *)',
  '[data-testid^="conversation-turn-"]:has([data-message-author-role="assistant"]):not([data-turn-key] *)',
  '[data-turn-key]:has([data-conversation-role="assistant"], [data-chatgpt-agent-turn-start])',
].join(", ");
export const CHATGPT_USER_TURN_SELECTOR = [
  '[data-testid^="conversation-turn-"][data-turn="user"]:not([data-turn-key] *)',
  '[data-testid^="conversation-turn-"][data-message-author-role="user"]:not([data-turn-key] *)',
  '[data-testid^="conversation-turn-"]:has([data-message-author-role="user"]):not([data-turn-key] *)',
  '[data-turn-key]:has([data-user-message-bubble])',
].join(", ");

export function chatGptTurnLocatorSelector(identity: string): string {
  const assistantPrefix = "group:assistant:";
  if (identity.startsWith(assistantPrefix)) {
    return `[data-turn-key=${JSON.stringify(identity.slice(assistantPrefix.length))}]:has([data-conversation-role="assistant"], [data-chatgpt-agent-turn-start])`;
  }
  const userPrefix = "group:user:";
  if (identity.startsWith(userPrefix)) {
    return `[data-turn-key=${JSON.stringify(identity.slice(userPrefix.length))}]:has([data-user-message-bubble])`;
  }
  return `[data-turn-id=${JSON.stringify(identity)}]`;
}

export interface ChatGptEffortSliderState {
  min: number;
  max: number;
  value: number;
}

function safeIntegerAttribute(value: string | null): number | undefined {
  if (value === null || !/^-?\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export function parseChatGptEffortSliderState(
  rawMin: string | null,
  rawMax: string | null,
  rawValue: string | null,
): ChatGptEffortSliderState | undefined {
  const min = safeIntegerAttribute(rawMin);
  const max = safeIntegerAttribute(rawMax);
  const value = safeIntegerAttribute(rawValue);
  if (min === undefined || max === undefined || value === undefined) return undefined;
  const optionCount = max - min + 1;
  if (optionCount < 1 || optionCount > CHATGPT_EFFORT_SLIDER_MAX_OPTIONS) return undefined;
  if (value < min || value > max) return undefined;
  return { min, max, value };
}

export async function readChatGptEffortSnapshot(
  slider: Locator,
  timeoutMs = 1_000,
): Promise<ChatGptEffortSliderState & { available: boolean[] }> {
  const deadline = Date.now() + timeoutMs;
  do {
    // Range, selection and lock ticks must come from one DOM revision. Separate reads can
    // straddle hydration and combine the old range with the new picker's ticks.
    const snapshot = await slider.evaluate(element => {
      const container = element.closest(
        '[data-model-reasoning-effort-slider], [data-model-picker-power-slider], [data-reasoning-slider="true"]',
      );
      const power = container?.hasAttribute("data-model-picker-power-slider") === true
        && Boolean(container.querySelector('[data-orientation="horizontal"][aria-disabled="false"]'));
      return {
        min: element.getAttribute("aria-valuemin"),
        max: element.getAttribute("aria-valuemax"),
        value: element.getAttribute("aria-valuenow"),
        power,
        locks: container
          ? Array.from(container.querySelectorAll("[data-selected]"), tick =>
              tick.getAttribute("data-locked") ?? (power ? "false" : null))
          : [],
      };
    });
    const state = parseChatGptEffortSliderState(snapshot.min, snapshot.max, snapshot.value);
    if (!state) throw new Error("ChatGPT effort slider exposed an invalid ARIA range");
    const optionCount = state.max - state.min + 1;
    const locksValid = snapshot.locks.every(lock => lock === "true" || lock === "false");
    if (locksValid && snapshot.locks.length === optionCount) {
      return { ...state, available: snapshot.locks.map(lock => lock === "false") };
    }
    // The local custom slider predates per-tick locks. Preserve its established range semantics;
    // the new power slider, however, must prove every option so a locked Pro tier is never sent.
    if (!snapshot.power && snapshot.locks.length === 0) {
      return { ...state, available: Array.from({ length: optionCount }, () => true) };
    }
    if (Date.now() >= deadline) break;
    await new Promise(resolveSleep => setTimeout(resolveSleep, 50));
  } while (true);
  throw new Error("ChatGPT effort availability could not be verified from its slider ticks");
}

async function anyVisible(locator: Locator): Promise<boolean> {
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    if (await locator.nth(index).isVisible().catch(() => false)) return true;
  }
  return false;
}

export async function assertAuthenticatedChatGptPage(page: Page): Promise<void> {
  const composer = page.locator(
    CHATGPT_COMPOSER_SELECTOR,
  );
  if (!await anyVisible(composer)) {
    throw new Error("ChatGPT authentication could not be verified: no visible composer is present");
  }
}

export async function assertTemporaryChatPage(page: Page): Promise<void> {
  const url = new URL(page.url());
  const expected = new URL(CHATGPT_TEMPORARY_CHAT_URL);
  if (url.origin !== expected.origin || url.pathname !== expected.pathname || url.searchParams.get("temporary-chat") !== "true") {
    throw new Error(`ChatGPT left the isolated Temporary Chat surface (${page.url()})`);
  }
}

export async function detectChatGptAccountCapabilities(
  page: Page,
  options: { selectorTimeoutMs?: number; stableAbsenceMs?: number } = {},
): Promise<ChatGptWebAccountCapabilities> {
  const composers = page.locator(CHATGPT_COMPOSER_SELECTOR).filter({ visible: true });
  const composer = composers.last();
  const composerForm = composer.locator("xpath=ancestor::form[1]");
  const effortButton = composerForm.locator(CHATGPT_EFFORT_CONTROL_SELECTOR).last();
  const deadline = Date.now() + (options.selectorTimeoutMs ?? 30_000);
  const stableAbsenceMs = options.stableAbsenceMs ?? 3_000;
  let absenceSince: number | undefined;
  let presenceObservations = 0;
  while (true) {
    const effortVisible = await effortButton.isVisible().catch(() => false);
    if (effortVisible) {
      presenceObservations += 1;
      absenceSince = undefined;
      if (presenceObservations >= 2) break;
      await new Promise(resolveSleep => setTimeout(resolveSleep, 100));
      continue;
    }
    presenceObservations = 0;
    const composerReady = await composers.count().then(count => count === 1).catch(() => false);
    const formReady = await composerForm.count().then(count => count === 1).catch(() => false);
    const documentReady = await page.evaluate(() => document.readyState === "complete").catch(() => false);
    if (composerReady && formReady && documentReady) {
      absenceSince ??= Date.now();
      if (Date.now() - absenceSince >= stableAbsenceMs) {
        return { solAvailable: false, proAvailable: false };
      }
    } else {
      absenceSince = undefined;
    }
    if (Date.now() >= deadline) {
      throw new Error("ChatGPT account capability probe did not reach a stable composer state");
    }
    await new Promise(resolveSleep => setTimeout(resolveSleep, 100));
  }
  const menu = await chatGptEffortMenuForControl(page, effortButton);
  const ownerOpen = await chatGptEffortSurfaceIsOpen(effortButton);
  const menuVisible = ownerOpen && await menu.isVisible().catch(() => false);
  const menuExpanded = await effortButton.getAttribute("aria-expanded").catch(() => null);
  if (!menuVisible && menuExpanded !== "true") await effortButton.press("Enter");
  try {
    const efforts = menu.locator(CHATGPT_EFFORT_ITEM_SELECTOR);
    const ownedSliders = menu.locator(CHATGPT_EFFORT_SLIDER_SELECTOR);
    const slider = await ownedSliders.count().catch(() => 0) === 1
      ? ownedSliders
      : page.locator(CHATGPT_EFFORT_SLIDER_SELECTOR).filter({ visible: true }).last();
    const waitAbort = new AbortController();
    try {
      const ready = await Promise.race([
        efforts.first().waitFor({ state: "visible", timeout: 70_000, signal: waitAbort.signal })
          .then(() => "items" as const),
        slider.waitFor({ state: "visible", timeout: 70_000, signal: waitAbort.signal })
          .then(() => "slider" as const),
      ]);
      const sliderVisible = ready === "slider" || await slider.isVisible().catch(() => false);
      if (!sliderVisible) {
        return { solAvailable: true, proAvailable: await efforts.count() >= 5 };
      }
      const state = await readChatGptEffortSnapshot(slider);
      return { solAvailable: true, proAvailable: state.available[4] === true };
    } finally {
      waitAbort.abort();
    }
  } finally {
    await page.keyboard.press("Escape").catch(() => {});
  }
}
