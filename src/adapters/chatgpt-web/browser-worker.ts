import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import {
  atomicWriteFile,
  CHATGPT_CONNECTOR_NAME,
  defaultChromeExecutable,
  DEV_CHATGPT_CONNECTOR_NAME,
  expandUserPath,
  getConfigDir,
  isLegacyChatGptConnectorName,
  legacyChatGptConnectorMigrationMessage,
  LEGACY_CHATGPT_CONNECTOR_NAMES,
} from "../../config";
import { estimateTokens } from "../../lib/token-estimate";
import type { CodexOutputTextAnnotation, CodexProviderConfig } from "../../types";
import { parseDataUrl } from "../image";

import {
  ChatGptMarkdownBuffer,
  ChatGptMarkdownConsistencyError,
  compareChatGptWireAndDomMarkdown,
  type ChatGptMarkdownSegment,
} from "./markdown";
import {
  CHATGPT_WEB_LUNA_MODEL_ID,
  CHATGPT_WEB_MODEL_ID,
  resolveChatGptDirectRequestMode,
  resolveChatGptWebModelMode,
  type ChatGptWebCapabilities,
  type ChatGptWebModelMode,
} from "./model";
import {
  CHATGPT_LUNA_BROWSER_INPUT_TOKEN_BUDGET,
  compiledChatGptWebMaxMessageChars,
  estimateCompiledChatGptWebMessageTokens,
} from "./input-tokens";
import {
  CHATGPT_MAX_INPUT_IMAGES,
  formatChatGptWebMultipartCommit,
  formatChatGptWebMultipartStage,
  type CompiledChatGptWebPrompt,
  type ChatGptWebPromptImage,
  type ChatGptWebMultipartStage,
  type ChatGptWebMultipartPartCount,
  isChatGptWebMultipartPartCount,
} from "./prompt";
import { estimateCompiledChatGptWebInputTokens } from "./input-tokens";
import {
  assertAuthenticatedChatGptPage,
  assertTemporaryChatPage,
  CHATGPT_ASSISTANT_TURN_SELECTOR,
  CHATGPT_COMPLETION_ACTION_SELECTOR,
  CHATGPT_COMPOSER_SELECTOR,
  CHATGPT_EFFORT_CONTROL_SELECTOR,
  CHATGPT_EFFORT_ITEM_SELECTOR,
  CHATGPT_EFFORT_MENU_SELECTOR,
  CHATGPT_EFFORT_SLIDER_SELECTOR,
  CHATGPT_STOP_BUTTON_SELECTOR,
  CHATGPT_TEMPORARY_CHAT_URL,
  CHATGPT_USER_TURN_SELECTOR,
  chatGptEffortMenuForControl,
  chatGptEffortSurfaceIsOpen,
  detectChatGptAccountCapabilities,
  parseChatGptEffortSliderState,
} from "../../chatgpt-session";
import { loginVerificationMarkerPath } from "../../browser-login";
import {
  connectLauncherBrowserHost,
  LauncherBrowserTurnCancelledError,
  LauncherRetainedConversationUnavailableError,
  LAUNCHER_TURN_HEARTBEAT_INTERVAL_MS,
  LAUNCHER_TURN_HEARTBEAT_TIMEOUT_MS,
  notifyLauncherTurn,
} from "../../launcher-browser-host";
import {
  CHATGPT_WEB_BIGGER_CONTEXT_MULTIPLIER,
  resolveChatGptWebContextLimits,
  resolveChatGptWebTransportLimits,
} from "../../chatgpt-web-models";
import { LauncherBrowserHelperClient } from "./launcher-helper-client";
import { MAX_CHATGPT_BROWSER_TABS } from "./concurrency";
import {
  ChatGptSteeringUnavailableError,
  ChatGptWebAdapterError,
  chatGptBrowserTabClosedError,
  chatGptRetainedConversationUnavailableError,
  chatGptStoppedThinkingError,
} from "./adapter-error";
import {
  ChatGptLunaCheckpointStream,
  type CapturedChatGptLunaCheckpoint,
} from "./rolling-checkpoint";
import {
  chatGptExternalProgressIsLive,
  chatGptExternalToolCallsAreInFlight,
} from "./turn-progress";
import type {
  ChatGptExternalTurnProgressSnapshot,
  ChatGptTurnProgressReader,
} from "./turn-progress";
import {
  ChatGptRequestInjectionFallbackError,
  ChatGptCdpRequestInjector,
  ChatGptCdpRequestInjectionShadow,
  ChatGptRequestInjector,
  ChatGptRequestInjectionShadow,
  ChatGptWebStreamTap,
  type ChatGptWireCapture,
  chatGptNetworkStreamPrimaryEnabled,
  chatGptNetworkStreamShadowEnabled,
  chatGptIncompleteCaptureRecoveryEnabled,
  chatGptRecoveryProofDiagnosticsEnabled,
  chatGptCompletedRebindDiagnosticsEnabled,
  chatGptRequestInjectionPrimaryEnabled,
  chatGptRequestInjectionCdpShadowEnabled,
  chatGptRequestInjectionCdpPrimaryEnabled,
  chatGptRequestInjectionShadowEnabled,
  createChatGptRequestInjectionPlaceholder,
  isChatGptRequestInjectionPlaceholder,
} from "./web-stream-tap";
import {
  resolveChatGptTurnPlan,
} from "./turn-plan";
import {
  ChatGptCaptureDispositionTracker,
  ChatGptSubmissionDispositionTracker,
} from "./submission-disposition";
import { ChatGptTurnRecoveryIdentityTracker, evaluateChatGptTurnRecoveryEvidence, type ChatGptTurnRecoveryEvidenceReason } from "./recovery-identity";
import { ChatGptRecoveryMessageSampler, ChatGptRecoveryTurnIdContinuityTracker, collectChatGptRecoveryDomSnapshot, sameChatGptRecoveryDomSnapshot, withChatGptRecoveryDiagnosticBudget, type ChatGptRecoveryDomSnapshot } from "./recovery-dom-proof";
import { startChatGptRecoveryDomContinuity, finishChatGptRecoveryDomContinuity } from "./recovery-dom-continuity";
import { startChatGptRecoveryTurnIdMutationContinuity, finishChatGptRecoveryTurnIdMutationContinuity, type ChatGptRecoveryTurnIdMutationContinuityResult } from "./recovery-turn-id-continuity";
import {
  ChatGptRecoveryBrowserWideRequestObserver,
  ChatGptRecoveryRequestObserver,
  recoveryRequestCountsAgree,
} from "./recovery-request-observer";
import { chatGptRecoveryServerProofExact, collectChatGptRecoveryServerProof, type ChatGptRecoveryServerProofResult } from "./recovery-server-proof";
import {
  evaluateChatGptRecoveryEquivalentEvidence,
  evaluateChatGptRecoveryResumeEvidence,
  type ChatGptRecoveryEquivalentEvidenceReason,
  type ChatGptRecoveryResumeEvidenceReason,
} from "./recovery-equivalent-proof";

export { chatGptEffortSelectionRequired } from "./turn-plan";

export { MAX_CHATGPT_BROWSER_TABS } from "./concurrency";

/** Optional known-fixture equality only. Neither the observed text nor either digest is logged. */
export function chatGptCanaryExpectedTextExact(
  text: string, env: Readonly<Record<string, string | undefined>> = process.env,
): boolean | undefined {
  const digest = env.CODEX_CHATGPT_WEB_STREAM_CANARY_EXPECTED_SHA256;
  if (!digest || !/^[0-9a-f]{64}$/.test(digest)) return undefined;
  return createHash("sha256").update(text).digest("hex") === digest;
}

const workers = new Map<string, ChatGptBrowserWorker>();

export async function closeChatGptBrowserWorkers(): Promise<void> {
  const active = [...workers.values()];
  workers.clear();
  const results = await Promise.allSettled(active.map(worker => worker.close()));
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map(result => result.reason);
  if (failures.length > 0) {
    throw new AggregateError(failures, `${failures.length} ChatGPT browser worker(s) failed to close`);
  }
}

export const CHATGPT_RESPONSE_DOM_GRACE_MS = 60_000;
/**
 * How long a staged Bigger Context part may take to produce its assistant turn. A staged part is two
 * orders of magnitude larger than an ordinary prompt and ChatGPT reads all of it before answering,
 * so the ordinary grace is not a budget it can be held to: acknowledgements have been observed at
 * 19s and 30s on the same payload that once took over 72s and lost the turn. There is no MCP
 * activity to vouch for liveness yet at this point, so this window is the only thing standing
 * between a slow ingest and a cancelled turn. It matches the staged send budget.
 */
export const CHATGPT_MULTIPART_RESPONSE_DOM_GRACE_MS = 180_000;
export const CHATGPT_EMPTY_RESPONSE_GRACE_MS = 10_000;
export const CHATGPT_COMPLETION_ACTION_GRACE_MS = 60_000;
export const CHATGPT_COMPLETION_SETTLE_MS = 2_000;
export const CHATGPT_TOOL_CONFIRMATION_TIMEOUT_MS = 60_000;
export const MAX_CHATGPT_CONNECTOR_TRIGGER_ATTEMPTS = 3;
const CHATGPT_CONNECTOR_MENTION_QUERY = "@codex";
const CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS = 10_000;
const CHATGPT_SMOKE_TEXT = "Reply with exactly: CODEX WEB GPT READY";
const CHATGPT_SMOKE_EXPECTED = "CODEX WEB GPT READY";
/**
 * ChatGPT applies composer state asynchronously, and a fast host can reach the next step before the
 * editor has taken the previous one. This is headroom for that, not a readiness check.
 */
export const CHATGPT_UI_SETTLE_MS = 250;
export const CHATGPT_SEND_ENABLE_GRACE_MS = 5_000;
/**
 * A retained Temporary Chat that was just stopped can still expose ChatGPT's generation control.
 * Sending then queues the revision instead of submitting it: no request reaches the injector, and the
 * placeholder stays in the composer. Wait for the surface to report idle before activating Send.
 */
export const CHATGPT_SEND_IDLE_GRACE_MS = 20_000;
const CHATGPT_RESPONSE_DOM_MIN_OBSERVATION_INTERVAL_MS = 250;
const CHATGPT_RESPONSE_DOM_IDLE_WAIT_MS = 1_000;
/** How long an in-flight steering revision may take to prove it left the composer. */
const CHATGPT_STEERING_ACCEPTANCE_MS = 10_000;
/** How long ChatGPT may take to swap its single submit control back to Send for the inserted text. */
const CHATGPT_STEERING_SEND_ARM_MS = 30_000;
/** How long the steered revision may take to open its own assistant turn. */
const CHATGPT_STEERING_REPLY_MS = 30_000;

const CHATGPT_DOM_REVISION_ATTRIBUTES = [
  "align",
  "aria-hidden",
  "aria-label",
  "aria-busy",
  "aria-disabled",
  "aria-expanded",
  "class",
  "checked",
  "data-item-anchor",
  "data-start",
  "data-end",
  "data-is-last-node",
  "data-message-author-role",
  "data-state",
  "data-streaming-response-status",
  "data-testid",
  "data-turn",
  "data-turn-id",
  "data-turn-id-container",
  "disabled",
  "hidden",
  "href",
  "inert",
  "open",
  "role",
  "start",
  "style",
  "title",
  "type",
] as const;

const settleChatGptUi = (): Promise<void> => (
  new Promise(resolveSettle => setTimeout(resolveSettle, CHATGPT_UI_SETTLE_MS))
);

class ChatGptConnectorCatalogStaleError extends Error {
  constructor(
    readonly appName: string,
    readonly triggerAttempts: number,
  ) {
    super(`ChatGPT connector catalog is missing ${JSON.stringify(appName)}`);
    this.name = "ChatGptConnectorCatalogStaleError";
  }
}

interface ChatGptConnectorAttemptBudget {
  triggerAttempts: number;
}

function chatGptConnectorUnavailableError(message: string): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(message, {
    status: 424,
    errorType: "connector_error",
    code: "connector_not_found",
    retryable: false,
  });
}

export type ChatGptPersonalizationPreflight = "already-personalized" | "enabled";

const CHATGPT_PERSONALIZATION_CONTROL_SELECTOR = [
  '[data-testid="thread-header-right-actions"] [aria-haspopup="menu"]',
  '#conversation-header-actions [aria-haspopup="menu"]',
  // Newer ChatGPT builds render the control inside a content sheet without a menu role.
  '[data-content-sheet-root] > button[aria-expanded][aria-controls]',
].join(", ");
const CHATGPT_PERSONALIZATION_CHOICE_SELECTOR = '[role="menuitemradio"], [role="radio"]';
const CHATGPT_PERSONALIZATION_PREFLIGHT_TIMEOUT_MS = 30_000;
const CHATGPT_PERSONALIZATION_CLEANUP_TIMEOUT_MS = 5_000;

class ChatGptPersonalizationDeadlineError extends Error {
  constructor() {
    super("ChatGPT personalization preflight exceeded its readiness deadline");
    this.name = "ChatGptPersonalizationDeadlineError";
  }
}

class ChatGptPersistentBrowserStateError extends AggregateError {
  constructor(errors: Iterable<unknown>, message: string) {
    super(errors, message);
    this.name = "ChatGptPersistentBrowserStateError";
  }
}

function remainingChatGptPersonalizationMs(deadline: number, signal?: AbortSignal): number {
  if (signal?.aborted) throw new DOMException("ChatGPT personalization preflight aborted", "AbortError");
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new ChatGptPersonalizationDeadlineError();
  return remaining;
}

async function runChatGptPersonalizationStep<T>(
  operation: () => Promise<T>,
  deadline: number,
  signal?: AbortSignal,
): Promise<T> {
  const timeoutMs = remainingChatGptPersonalizationMs(deadline, signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await withBrowserTurnAbort(Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ChatGptPersonalizationDeadlineError()), timeoutMs);
      }),
    ]), signal);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Mutating personalization work owns its AbortSignal and must settle its cleanup before the caller
 * can observe cancellation. Unlike observation races, returning early here could release the page
 * while a rollback or composer clear was still running against the persistent browser profile.
 */
async function runChatGptPersonalizationOwnedStep<T>(
  operation: () => Promise<T>,
  deadline: number,
  signal: AbortSignal,
): Promise<T> {
  remainingChatGptPersonalizationMs(deadline, signal);
  const result = await operation();
  remainingChatGptPersonalizationMs(deadline, signal);
  return result;
}

async function waitForChatGptPersonalizationPoll(
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (!signal) {
    await new Promise(resolve => setTimeout(resolve, timeoutMs));
    return;
  }
  if (signal.aborted) throw new DOMException("ChatGPT personalization preflight aborted", "AbortError");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, timeoutMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(new DOMException("ChatGPT personalization preflight aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function runChatGptPersonalizationCleanup<T>(
  operation: (deadline: number, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const deadline = Date.now() + CHATGPT_PERSONALIZATION_CLEANUP_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now()));
  timer.unref?.();
  try {
    return await operation(deadline, controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function pressChatGptPersonalizationEscape(
  page: Page,
  deadline: number,
  signal: AbortSignal,
): Promise<void> {
  await page.locator("body").press("Escape", {
    timeout: remainingChatGptPersonalizationMs(deadline, signal),
    signal,
  });
}

async function dismissChatGptPersonalizationMenu(page: Page): Promise<void> {
  await runChatGptPersonalizationCleanup((deadline, signal) => (
    pressChatGptPersonalizationEscape(page, deadline, signal)
  ));
}

async function waitForChatGptOwnedPersonalizationMenu(
  page: Page,
  control: Locator,
  deadline: number,
  signal?: AbortSignal,
): Promise<Locator> {
  let menuId: string | null = null;
  while (!menuId) {
    const remaining = remainingChatGptPersonalizationMs(deadline, signal);
    menuId = await control.getAttribute("aria-controls", { timeout: remaining, signal });
    if (!menuId) await waitForChatGptPersonalizationPoll(Math.min(50, remaining), signal);
  }
  const menu = page.locator(`[id=${JSON.stringify(menuId)}]`);
  try {
    await menu.waitFor({
      state: "visible",
      timeout: remainingChatGptPersonalizationMs(deadline, signal),
      signal,
    });
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "TimeoutError") throw error;
    throw chatGptConnectorUnavailableError(
      "ChatGPT personalization control did not expose its owned menu before the readiness deadline",
    );
  }
  return menu;
}

type ChatGptPersonalizationChoiceIndex = 0 | 1;

interface ChatGptPersonalizationState {
  menu: Locator;
  choices: Locator;
  checkedIndex: ChatGptPersonalizationChoiceIndex;
}

interface ChatGptPersonalizationToggleReceipt {
  originalIndex: ChatGptPersonalizationChoiceIndex;
}

async function readChatGptPersonalizationCheckedIndex(
  choices: Locator,
  deadline: number,
  signal: AbortSignal,
): Promise<ChatGptPersonalizationChoiceIndex> {
  const checked: boolean[] = [];
  for (let index = 0; index < 2; index += 1) {
    const choice = choices.nth(index);
    const ariaChecked = await choice.getAttribute("aria-checked", {
      timeout: remainingChatGptPersonalizationMs(deadline, signal),
      signal,
    });
    const dataState = await choice.getAttribute("data-state", {
      timeout: remainingChatGptPersonalizationMs(deadline, signal),
      signal,
    });
    checked.push(ariaChecked === "true" || dataState === "checked");
  }
  if (checked.filter(Boolean).length !== 1) {
    throw chatGptConnectorUnavailableError(
      "ChatGPT personalization menu did not expose one checked state",
    );
  }
  return checked[0] ? 0 : 1;
}

async function openChatGptStructuralPersonalizationState(
  page: Page,
  deadline: number,
  signal: AbortSignal,
): Promise<ChatGptPersonalizationState> {
  const controls = page.locator(CHATGPT_PERSONALIZATION_CONTROL_SELECTOR).filter({ visible: true });
  const control = controls.first();
  try {
    await control.waitFor({
      state: "visible",
      timeout: remainingChatGptPersonalizationMs(deadline, signal),
      signal,
    });
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "TimeoutError") throw error;
    throw chatGptConnectorUnavailableError(
      "ChatGPT Temporary Chat did not expose a structural personalization control before the readiness deadline",
    );
  }
  const controlCount = await runChatGptPersonalizationStep(() => controls.count(), deadline, signal);
  if (controlCount !== 1) {
    throw chatGptConnectorUnavailableError(
      `ChatGPT Temporary Chat exposed ${controlCount} structural personalization controls; expected exactly one`,
    );
  }
  await control.click({
    timeout: remainingChatGptPersonalizationMs(deadline, signal),
    signal,
  });
  const menu = await waitForChatGptOwnedPersonalizationMenu(page, control, deadline, signal);
  const choices = menu.locator(CHATGPT_PERSONALIZATION_CHOICE_SELECTOR).filter({ visible: true });
  if (await runChatGptPersonalizationStep(() => choices.count(), deadline, signal) !== 2) {
    throw chatGptConnectorUnavailableError(
      "ChatGPT personalization menu did not expose exactly two checkable states",
    );
  }
  return {
    menu,
    choices,
    checkedIndex: await readChatGptPersonalizationCheckedIndex(choices, deadline, signal),
  };
}

async function restoreChatGptPersonalizationChoice(
  page: Page,
  receipt: ChatGptPersonalizationToggleReceipt,
): Promise<void> {
  await runChatGptPersonalizationCleanup(async (deadline, signal) => {
    await pressChatGptPersonalizationEscape(page, deadline, signal);
    let state = await openChatGptStructuralPersonalizationState(page, deadline, signal);
    if (state.checkedIndex === receipt.originalIndex) {
      await pressChatGptPersonalizationEscape(page, deadline, signal);
      return;
    }
    await state.choices.nth(receipt.originalIndex).click({
      timeout: remainingChatGptPersonalizationMs(deadline, signal),
      signal,
    });
    await state.menu.waitFor({
      state: "hidden",
      timeout: remainingChatGptPersonalizationMs(deadline, signal),
      signal,
    });
    await waitForChatGptPersonalizationPoll(CHATGPT_UI_SETTLE_MS, signal);

    state = await openChatGptStructuralPersonalizationState(page, deadline, signal);
    if (state.checkedIndex !== receipt.originalIndex) {
      throw new Error("ChatGPT personalization rollback did not restore the original checked state");
    }
    await pressChatGptPersonalizationEscape(page, deadline, signal);
  });
}

async function toggleChatGptPersonalizationChoice(
  page: Page,
  deadline: number,
  signal: AbortSignal,
): Promise<ChatGptPersonalizationToggleReceipt> {
  let receipt: ChatGptPersonalizationToggleReceipt | undefined;
  try {
    const state = await openChatGptStructuralPersonalizationState(page, deadline, signal);
    receipt = { originalIndex: state.checkedIndex };
    const nextIndex: ChatGptPersonalizationChoiceIndex = state.checkedIndex === 0 ? 1 : 0;
    await state.choices.nth(nextIndex).click({
      timeout: remainingChatGptPersonalizationMs(deadline, signal),
      signal,
    });
    await state.menu.waitFor({
      state: "hidden",
      timeout: remainingChatGptPersonalizationMs(deadline, signal),
      signal,
    });
    await runChatGptPersonalizationStep(settleChatGptUi, deadline, signal);
    return receipt;
  } catch (error) {
    try {
      if (receipt) await restoreChatGptPersonalizationChoice(page, receipt);
      else await dismissChatGptPersonalizationMenu(page);
    } catch (cleanupError) {
      throw new ChatGptPersistentBrowserStateError(
        [error, cleanupError],
        "ChatGPT personalization change failed and its original state could not be restored",
      );
    }
    throw error;
  }
}

async function ensureChatGptPersonalizedConnectorAccessWithinDeadline(
  page: Page,
  deadline: number,
  abortSignal: AbortSignal,
  captureDiagnostic?: (checkpoint: string) => Promise<void>,
  proveConfiguredConnectorAccess?: (signal?: AbortSignal) => Promise<boolean>,
): Promise<ChatGptPersonalizationPreflight> {
  const capture = async (checkpoint: string): Promise<void> => {
    if (!captureDiagnostic) return;
    await runChatGptPersonalizationStep(() => captureDiagnostic(checkpoint), deadline, abortSignal);
  };
  const proveConnectorAccess = async (): Promise<boolean> => {
    if (!proveConfiguredConnectorAccess) return false;
    return runChatGptPersonalizationOwnedStep(
      () => proveConfiguredConnectorAccess(abortSignal),
      deadline,
      abortSignal,
    );
  };
  const personalized = page
    .getByRole("button", { name: /^(?:Personalized|个性化)$/, exact: true, includeHidden: true })
    .filter({ visible: true });
  const unpersonalized = page
    .getByRole("button", { name: /^(?:Unpersonalized|非个性化)$/, exact: true, includeHidden: true })
    .filter({ visible: true });
  let personalizedCount = await runChatGptPersonalizationStep(() => personalized.count(), deadline, abortSignal);
  let unpersonalizedCount = await runChatGptPersonalizationStep(() => unpersonalized.count(), deadline, abortSignal);
  if (personalizedCount === 0 && unpersonalizedCount === 0) {
    await runChatGptPersonalizationStep(settleChatGptUi, deadline, abortSignal);
    personalizedCount = await runChatGptPersonalizationStep(() => personalized.count(), deadline, abortSignal);
    unpersonalizedCount = await runChatGptPersonalizationStep(() => unpersonalized.count(), deadline, abortSignal);
    if (personalizedCount === 0 && unpersonalizedCount === 0) {
      if (!proveConfiguredConnectorAccess) {
        await capture("personalization-control-missing");
        throw chatGptConnectorUnavailableError(
          "ChatGPT Temporary Chat did not expose a verifiable personalization control",
        );
      }
      if (await proveConnectorAccess()) {
        await capture("personalization-already-enabled");
        return "already-personalized";
      }
      await capture("personalization-unpersonalized");
      const toggleReceipt = await toggleChatGptPersonalizationChoice(page, deadline, abortSignal);
      try {
        if (await proveConnectorAccess()) {
          await capture("personalization-enabled");
          return "enabled";
        }
      } catch (error) {
        try {
          await restoreChatGptPersonalizationChoice(page, toggleReceipt);
        } catch (restoreError) {
          throw new ChatGptPersistentBrowserStateError(
            [error, restoreError],
            "ChatGPT personalization proof failed and the original state could not be restored",
          );
        }
        throw error;
      }
      try {
        await restoreChatGptPersonalizationChoice(page, toggleReceipt);
      } catch (restoreError) {
        throw new ChatGptPersistentBrowserStateError(
          [restoreError],
          "ChatGPT personalization changed but connector access was not proven and the original state could not be restored",
        );
      }
      throw chatGptConnectorUnavailableError(
        "The configured ChatGPT connector remained unavailable after the structural personalization state changed",
      );
    }
  }
  if (personalizedCount === 1 && unpersonalizedCount === 0) {
    await capture("personalization-already-enabled");
    return "already-personalized";
  }
  if (personalizedCount !== 0 || unpersonalizedCount !== 1) {
    throw chatGptConnectorUnavailableError(
      `ChatGPT exposed an invalid Temporary Chat personalization state`
      + ` (personalized=${personalizedCount}, unpersonalized=${unpersonalizedCount})`,
    );
  }

  await capture("personalization-unpersonalized");
  await unpersonalized.click({
    timeout: remainingChatGptPersonalizationMs(deadline, abortSignal),
    signal: abortSignal,
  });
  try {
    const menu = await waitForChatGptOwnedPersonalizationMenu(
      page,
      unpersonalized,
      deadline,
      abortSignal,
    );
    const choice = menu
      .locator(CHATGPT_PERSONALIZATION_CHOICE_SELECTOR)
      .filter({ hasText: /^(?:Personalized|个性化)/ });
    if (await runChatGptPersonalizationStep(() => choice.count(), deadline, abortSignal) !== 1) {
      throw chatGptConnectorUnavailableError(
        "ChatGPT personalization menu did not expose one exact Personalized choice",
      );
    }
    await choice.click({
      timeout: remainingChatGptPersonalizationMs(deadline, abortSignal),
      signal: abortSignal,
    });
    await personalized.waitFor({
      state: "visible",
      timeout: remainingChatGptPersonalizationMs(deadline, abortSignal),
      signal: abortSignal,
    });
    await unpersonalized.waitFor({
      state: "hidden",
      timeout: remainingChatGptPersonalizationMs(deadline, abortSignal),
      signal: abortSignal,
    });
  } catch (error) {
    try {
      await dismissChatGptPersonalizationMenu(page);
    } catch (cleanupError) {
      throw new ChatGptPersistentBrowserStateError(
        [error, cleanupError],
        "ChatGPT labeled personalization change failed and its opened menu could not be closed",
      );
    }
    if (!(error instanceof Error) || error.name !== "TimeoutError") throw error;
    throw chatGptConnectorUnavailableError(
      "ChatGPT did not confirm Personalized connector access for this Temporary Chat",
    );
  }
  await capture("personalization-enabled");
  return "enabled";
}

/** New Temporary Chats may suppress connectors until this exact browser conversation is Personalized. */
export async function ensureChatGptPersonalizedConnectorAccess(
  page: Page,
  captureDiagnostic?: (checkpoint: string) => Promise<void>,
  proveConfiguredConnectorAccess?: (signal?: AbortSignal) => Promise<boolean>,
  abortSignal?: AbortSignal,
): Promise<ChatGptPersonalizationPreflight> {
  const deadline = Date.now() + CHATGPT_PERSONALIZATION_PREFLIGHT_TIMEOUT_MS;
  const deadlineController = new AbortController();
  const deadlineTimer = setTimeout(
    () => deadlineController.abort(new ChatGptPersonalizationDeadlineError()),
    Math.max(1, deadline - Date.now()),
  );
  deadlineTimer.unref?.();
  const operationSignal = abortSignal
    ? AbortSignal.any([abortSignal, deadlineController.signal])
    : deadlineController.signal;
  try {
    return await ensureChatGptPersonalizedConnectorAccessWithinDeadline(
      page,
      deadline,
      operationSignal,
      captureDiagnostic,
      proveConfiguredConnectorAccess,
    );
  } catch (error) {
    if (error instanceof ChatGptPersistentBrowserStateError) throw error;
    if (!abortSignal?.aborted && (
      error instanceof ChatGptPersonalizationDeadlineError
      || deadlineController.signal.aborted
      || Date.now() >= deadline
    )) {
      throw chatGptConnectorUnavailableError("ChatGPT personalization preflight exceeded its readiness deadline");
    }
    throw error;
  } finally {
    clearTimeout(deadlineTimer);
  }
}

export class ChatGptPromptAttachmentIntegrityError extends ChatGptWebAdapterError {
  constructor(message: string) {
    super(message, {
      status: 502,
      errorType: "server_error",
      code: "prompt_attachment_integrity",
      retryable: false,
    });
    this.name = "ChatGptPromptAttachmentIntegrityError";
  }
}

const chatGptRateLimitDialog = (page: Page): Locator => page.locator('[role="dialog"]')
  .filter({ hasText: /Too many requests|太多要求|太多请求|リクエストが多すぎます/i })
  .filter({ hasText: /making requests too quickly|過於頻繁|过于频繁|リクエストの頻度が高すぎます/i })
  .last();

export async function throwIfChatGptRateLimitDialog(page: Page): Promise<void> {
  const dialog = chatGptRateLimitDialog(page);
  if (!await dialog.isVisible().catch(() => false)) return;

  const acknowledge = dialog.getByRole("button", { name: /^(Got it|知道了|了解)$/ }).last();
  if (await acknowledge.isVisible().catch(() => false)) {
    try {
      await acknowledge.press("Enter");
    } catch (error) {
      throw new ChatGptWebAdapterError(
        `ChatGPT rate limit: too many requests, and the dialog could not be dismissed (${error instanceof Error ? error.message : String(error)}). Try again in a few minutes.`,
        { status: 429, errorType: "rate_limit_error", code: "rate_limit_exceeded", retryable: true },
      );
    }
  }
  throw new ChatGptWebAdapterError(
    "ChatGPT rate limit: too many requests. Try again in a few minutes.",
    { status: 429, errorType: "rate_limit_error", code: "rate_limit_exceeded", retryable: true },
  );
}

const chatGptTemporaryChatOnboardingDialog = (page: Page): Locator => page
  .locator('[role="dialog"]')
  .filter({ hasText: "Not in history" })
  .filter({ hasText: "No model training" })
  .filter({ hasText: "Memory off" })
  .last();

export async function dismissChatGptTemporaryChatOnboarding(page: Page): Promise<boolean> {
  const dialog = chatGptTemporaryChatOnboardingDialog(page);
  if (!await dialog.isVisible().catch(() => false)) return false;
  const continueButton = dialog.getByRole("button", { name: "Continue", exact: true }).last();
  if (!await continueButton.isVisible().catch(() => false)) {
    throw new Error("ChatGPT Temporary Chat onboarding is visible without its Continue action");
  }
  await continueButton.click({ force: true });
  await dialog.waitFor({ state: "hidden", timeout: 10_000 });
  return true;
}

type ChatGptTextScope = Pick<Locator, "getByText" | "getByTestId">;

const chatGptSubscriptionFailureAlert = (page: Page): Locator => page
  .locator('[role="alert"]')
  .filter({ hasText: /Failed to load subscription/i })
  .last();

const chatGptExpiredSessionAlert = (page: Page): Locator => page
  .locator('[role="alert"], [role="dialog"]')
  .filter({ hasText: /Your session has expired|你的工作階段已過期|您的工作階段已過期|你的会话已过期|您的会话已过期/i })
  .last();

export async function throwIfChatGptSessionFailureAlert(page: Page): Promise<void> {
  if (await chatGptExpiredSessionAlert(page).isVisible().catch(() => false)) {
    throw new ChatGptWebAdapterError(
      "The ChatGPT session has expired. Sign in again in Codex Web GPT.",
      { status: 401, errorType: "authentication_error", code: "chatgpt_session_expired", retryable: false },
    );
  }
  if (!await chatGptSubscriptionFailureAlert(page).isVisible().catch(() => false)) return;
  throw new ChatGptWebAdapterError(
    "ChatGPT could not load the account subscription. Reload ChatGPT inside the launcher and retry; sign out only if the error persists.",
    { status: 503, errorType: "server_error", code: "chatgpt_subscription_unavailable", retryable: true },
  );
}

const chatGptTerminalErrorAlert = (scope: ChatGptTextScope): Locator => scope
  .getByText(/Something went wrong[\s\S]*help\.openai\.com/i)
  .last();

export async function throwIfChatGptTerminalErrorAlert(scope: ChatGptTextScope): Promise<void> {
  if (await scope.getByTestId("regenerate-thread-error-button").last().isVisible().catch(() => false)) {
    throw new ChatGptWebAdapterError(
      "ChatGPT displayed an error for this response. Check the ChatGPT tab for the exact error, then retry the turn.",
      { status: 502, errorType: "server_error", code: "upstream_server_error", retryable: true },
    );
  }
  if (!await chatGptTerminalErrorAlert(scope).isVisible().catch(() => false)) return;
  throw new ChatGptWebAdapterError(
    "ChatGPT ended the turn with 'Something went wrong'. Retry the turn.",
    { status: 502, errorType: "server_error", code: "upstream_server_error", retryable: true },
  );
}

export async function resolveChatGptToolConfirmation(
  page: Page,
  appName: string,
  autoApprove: boolean,
  signal?: AbortSignal,
  timeoutMs = CHATGPT_TOOL_CONFIRMATION_TIMEOUT_MS,
  onVisible?: () => Promise<void>,
): Promise<boolean> {
  const dialog = page.locator('[role="dialog"], [data-testid="tool-approval-card"]')
    .filter({ hasText: `Allow ChatGPT to use ${appName}?` })
    .last();
  if (!await dialog.isVisible().catch(() => false)) return false;
  await onVisible?.();

  if (autoApprove) {
    // ChatGPT exposes either "Allow once" or the shorter "Allow" for the
    // current one-shot approval. Keep the matcher anchored so persistent
    // actions such as "Always allow" cannot match.
    const allowCurrentAction = dialog
      .getByRole("button", { name: /^Allow(?: once)?$/ })
      .last();
    await allowCurrentAction.waitFor({ state: "visible", timeout: 10_000 });
    await allowCurrentAction.press("Enter");
    return true;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
    if (!await dialog.isVisible().catch(() => false)) return true;
    await new Promise(resolveSleep => setTimeout(resolveSleep, Math.min(100, Math.max(1, deadline - Date.now()))));
  }

  if (!await dialog.isVisible().catch(() => false)) return true;
  const deny = dialog.getByRole("button", { name: "Deny", exact: true }).last();
  await deny.waitFor({ state: "visible", timeout: 5_000 });
  await deny.press("Enter");
  await dialog.waitFor({ state: "hidden", timeout: 10_000 });
  return true;
}

export function assertChatGptWebInputWithinLimits(
  estimatedInputTokens: number,
  estimatedMessageTokens: number,
  modelId: string,
  effort: ChatGptWebModelMode["effort"],
  capabilities: ChatGptWebCapabilities,
  promptChars?: number,
): void {
  if (modelId !== CHATGPT_WEB_MODEL_ID && modelId !== CHATGPT_WEB_LUNA_MODEL_ID) {
    throw new Error(`ChatGPT web context limit is not defined for model: ${modelId}`);
  }
  if (
    modelId === CHATGPT_WEB_LUNA_MODEL_ID
    && estimatedInputTokens > CHATGPT_LUNA_BROWSER_INPUT_TOKEN_BUDGET
  ) {
    throw new ChatGptWebAdapterError(
      `This Luna turn requires ${estimatedInputTokens.toLocaleString("en-US")} estimated input tokens, which exceeds the measured ${CHATGPT_LUNA_BROWSER_INPUT_TOKEN_BUDGET.toLocaleString("en-US")}-token ChatGPT Free browser transport budget. Completed Luna history is already replaced by its rolling checkpoint; the remaining payload is the current Codex turn and cannot be reduced by /compact.`,
      { status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false },
    );
  }
  const { contextWindow } = resolveChatGptWebContextLimits(modelId, effort, capabilities);
  const { browserMessageTokenLimit, browserComposerCharLimit } = resolveChatGptWebTransportLimits(
    modelId,
    effort,
    capabilities,
  );
  if (
    browserComposerCharLimit !== undefined
    && promptChars !== undefined
    && promptChars > browserComposerCharLimit
  ) {
    throw new ChatGptWebAdapterError(
      `This prompt contains ${promptChars.toLocaleString("en-US")} inline characters, which exceeds the measured ${browserComposerCharLimit.toLocaleString("en-US")}-character ChatGPT composer boundary for this account and effort. Run /compact, then retry this Web model.`,
      { status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false },
    );
  }
  if (browserMessageTokenLimit !== undefined && estimatedMessageTokens > browserMessageTokenLimit) {
    throw new ChatGptWebAdapterError(
      `This prompt requires ${estimatedMessageTokens.toLocaleString("en-US")} visible message tokens, which exceeds the measured ${browserMessageTokenLimit.toLocaleString("en-US")}-token ChatGPT browser message boundary for this account and effort. The model context window is ${contextWindow.toLocaleString("en-US")} tokens; run /compact to reduce the next browser message without changing that model window.`,
      { status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false },
    );
  }
  if (estimatedInputTokens < contextWindow) return;
  throw new ChatGptWebAdapterError(
    `This task is estimated at ${estimatedInputTokens.toLocaleString("en-US")} input tokens, which exceeds the ${contextWindow.toLocaleString("en-US")}-token context window for this ChatGPT Web model. Switch to a model with a larger context window, run /compact, then retry this Web model.`,
    { status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false },
  );
}

export function assertChatGptWebMultipartInputWithinLimits(
  estimatedInputTokens: number,
  estimatedMessageTokens: number,
  modelId: string,
  effort: ChatGptWebModelMode["effort"],
  capabilities: ChatGptWebCapabilities,
  maxMessageChars: number,
  partCount: number,
  transport?: {
    stagingEffort: ChatGptWebModelMode["effort"];
    maxStageMessageTokens: number;
    maxStageChars: number;
    finalMessageTokens: number;
    finalMessageChars: number;
  },
): void {
  if (!isChatGptWebMultipartPartCount(partCount)) {
    throw new Error("Bigger Context requires two or six context parts");
  }
  if (modelId === CHATGPT_WEB_LUNA_MODEL_ID) {
    throw new ChatGptWebAdapterError(
      "Bigger Context is unavailable for Luna because every later browser request includes the accumulated transcript inside the same 28,000-token transport budget.",
      { status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false },
    );
  }
  if (modelId !== CHATGPT_WEB_MODEL_ID) {
    throw new Error(`ChatGPT Bigger Context limit is not defined for model: ${modelId}`);
  }
  const { contextWindow: baseContextWindow } = resolveChatGptWebContextLimits(
    modelId,
    effort,
    { ...capabilities, experimentalBiggerContext: false },
  );
  const assertMessageBoundary = (
    label: "stage" | "final part",
    messageTokens: number,
    messageChars: number,
    messageEffort: ChatGptWebModelMode["effort"],
  ): void => {
    const { browserMessageTokenLimit, browserComposerCharLimit } = resolveChatGptWebTransportLimits(
      modelId,
      messageEffort,
      capabilities,
    );
    if (browserComposerCharLimit !== undefined && messageChars > browserComposerCharLimit) {
      throw new ChatGptWebAdapterError(
        `A Bigger Context ${label} contains ${messageChars.toLocaleString("en-US")} characters, which exceeds the measured ${browserComposerCharLimit.toLocaleString("en-US")}-character ChatGPT composer boundary. The bridge will not split an individual Codex message or JSON record; compact the task before retrying.`,
        { status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false },
      );
    }
    if (browserMessageTokenLimit !== undefined && messageTokens > browserMessageTokenLimit) {
      throw new ChatGptWebAdapterError(
        `A Bigger Context ${label} requires ${messageTokens.toLocaleString("en-US")} visible message tokens, which exceeds the measured ${browserMessageTokenLimit.toLocaleString("en-US")}-token ChatGPT message boundary. The bridge will not split an individual Codex message or JSON record; compact the task before retrying.`,
        { status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false },
      );
    }
  };
  if (transport) {
    assertMessageBoundary(
      "stage",
      transport.maxStageMessageTokens,
      transport.maxStageChars,
      transport.stagingEffort,
    );
    assertMessageBoundary(
      "final part",
      transport.finalMessageTokens,
      transport.finalMessageChars,
      effort,
    );
  } else {
    assertMessageBoundary("stage", estimatedMessageTokens, maxMessageChars, effort);
  }
  // More transport messages do not enlarge the model's advertised context window.
  const experimentalContextWindow = baseContextWindow * Math.min(partCount, CHATGPT_WEB_BIGGER_CONTEXT_MULTIPLIER);
  if (estimatedInputTokens < experimentalContextWindow) return;
  const partLabel = partCount === 2 ? "two-part" : "six-part";
  throw new ChatGptWebAdapterError(
    `This Bigger Context transaction is estimated at ${estimatedInputTokens.toLocaleString("en-US")} input tokens, which exceeds its experimental ${experimentalContextWindow.toLocaleString("en-US")}-token ${partLabel} ceiling. Run /compact, then retry.`,
    { status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false },
  );
}

/** Select the cheapest account-visible mode that can carry every inert multipart stage. */
export function resolveChatGptWebMultipartStagingMode(
  modelId: string,
  capabilities: ChatGptWebCapabilities,
  requestedEffort: ChatGptWebModelMode["effort"],
  maxStageMessageTokens: number,
  maxStageChars: number,
): ChatGptWebModelMode {
  if (modelId === CHATGPT_WEB_LUNA_MODEL_ID || !capabilities.solAvailable) {
    throw new ChatGptWebAdapterError(
      "Bigger Context staging is unavailable for a Luna-only account.",
      { status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false },
    );
  }
  if (modelId !== CHATGPT_WEB_MODEL_ID) {
    throw new Error(`ChatGPT Bigger Context staging mode is not defined for model: ${modelId}`);
  }
  const efforts: readonly ChatGptWebModelMode["effort"][] = capabilities.proAvailable
    ? ["low", "medium", "max"]
    : ["low", "medium"];
  const requestedContextWindow = resolveChatGptWebContextLimits(
    modelId,
    requestedEffort,
    capabilities,
  ).contextWindow;
  for (const effort of efforts) {
    const mode = resolveChatGptWebModelMode(modelId, effort, capabilities);
    const contextWindow = resolveChatGptWebContextLimits(modelId, effort, capabilities).contextWindow;
    if (contextWindow < requestedContextWindow) continue;
    const limits = resolveChatGptWebTransportLimits(modelId, effort, capabilities);
    const tokenFits = limits.browserMessageTokenLimit === undefined
      || maxStageMessageTokens <= limits.browserMessageTokenLimit;
    const charsFit = limits.browserComposerCharLimit === undefined
      || maxStageChars <= limits.browserComposerCharLimit;
    if (tokenFits && charsFit) return mode;
  }
  throw new ChatGptWebAdapterError(
    `No ChatGPT effort available to this account can carry a Bigger Context stage with ${maxStageMessageTokens.toLocaleString("en-US")} estimated tokens and ${maxStageChars.toLocaleString("en-US")} characters.`,
    { status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false },
  );
}

export const browserStageTimeouts = {
  browserPage: 60_000,
  temporaryChatPreparation: 150_000,
  effortSelection: 120_000,
  promptAttachment: 60_000,
  fileAttachment: 120_000,
  send: 20_000,
  // A Bigger Context stage posts a payload orders of magnitude larger than an ordinary prompt onto
  // a conversation that already holds the earlier parts, and this budget covers ChatGPT accepting
  // the submission, not just the click. The ordinary 20s send budget expired mid-acceptance and
  // destroyed the whole turn while the browser was still working.
  multipartStageSend: 180_000,
} as const;

/**
 * Detects that this process was suspended (system sleep) by watching for gaps in a steady tick.
 * On Apple Silicon the monotonic clock keeps advancing through sleep, so elapsed time alone cannot
 * distinguish "the stage really took 15 minutes" from "the machine slept for 14 of them" — and a
 * stage budget charged for slept time cancels turns that never got their budget awake.
 */
export class ChatGptSuspensionClock {
  private suspendedTotalMs = 0;
  private lastTickAt: number;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly tickIntervalMs = 1_000,
    private readonly gapThresholdMs = 5_000,
  ) {
    this.lastTickAt = Date.now();
  }

  start(): void {
    if (this.timer) return;
    this.lastTickAt = Date.now();
    this.timer = setInterval(() => this.tick(Date.now()), this.tickIntervalMs);
    this.timer.unref?.();
  }

  /** Exposed for tests; production ticks come from the interval above. */
  tick(now: number): void {
    const gap = now - this.lastTickAt;
    this.lastTickAt = now;
    if (gap >= this.gapThresholdMs) this.suspendedTotalMs += gap - this.tickIntervalMs;
  }

  suspendedMs(): number {
    return this.suspendedTotalMs;
  }
}

export const chatGptSuspensionClock = new ChatGptSuspensionClock();

/**
 * How much of a stage budget remains once slept time is refunded. Zero means the stage really
 * consumed its budget while awake and the timeout stands.
 */
export function remainingStageBudgetMs(
  timeoutMs: number,
  elapsedMs: number,
  suspendedMs: number,
): number {
  const awakeMs = elapsedMs - suspendedMs;
  if (awakeMs >= timeoutMs) return 0;
  return Math.max(250, timeoutMs - awakeMs);
}

export const CHATGPT_BROWSER_OBSERVATION_PROBE_TIMEOUT_MS = 5_000;
export const MAX_CHATGPT_BROWSER_PAGE_REBINDS = 2;

export class ChatGptBrowserObservationTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`ChatGPT browser DOM observation did not respond within ${timeoutMs}ms`);
    this.name = "ChatGptBrowserObservationTimeoutError";
  }
}

class ChatGptIncompleteCaptureCanaryError extends Error {
  constructor() {
    super("ChatGPT incomplete-capture recovery canary disconnected the observation transport");
    this.name = "ChatGptIncompleteCaptureCanaryError";
  }
}

/**
 * Narrow transport-only admission for the post-commit recovery branch. Semantic ChatGPT verdicts,
 * adapter errors, cancellation and arbitrary worker defects are never converted into reconnects.
 */
export function chatGptRecoverableIncompleteCaptureFailure(error: unknown): boolean {
  if (error instanceof ChatGptWebAdapterError) return false;
  if (error instanceof DOMException && error.name === "AbortError") return false;
  if (error instanceof ChatGptBrowserObservationTimeoutError) return true;
  if (!(error instanceof Error)) return false;
  if (error.name === "ChatGptIncompleteCaptureCanaryError") return true;
  if (error.message.startsWith("ChatGPT browser DOM remained unresponsive after ")) return true;
  return /(?:Target page, context or browser has been closed|Target closed|Connection closed|CDP session.*closed|Protocol error.*closed)/i
    .test(error.message);
}

export async function withChatGptBrowserObservationTimeout<T>(
  operation: Promise<T>,
  timeoutMs = CHATGPT_BROWSER_OBSERVATION_PROBE_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ChatGptBrowserObservationTimeoutError(timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function connectAfterClosingBrowserConnection<T>(
  previousConnection: Pick<Browser, "close"> | undefined,
  connect: () => Promise<T>,
): Promise<T> {
  if (previousConnection) await previousConnection.close();
  return connect();
}

export const CHATGPT_MIN_OPERATIONAL_VIEWPORT = Object.freeze({ width: 320, height: 240 });

async function waitForOperationalChatGptViewport(page: Page, signal?: AbortSignal): Promise<void> {
  try {
    await withBrowserTurnAbort(page.waitForFunction(
      ({ width, height }) => innerWidth >= width && innerHeight >= height,
      CHATGPT_MIN_OPERATIONAL_VIEWPORT,
      { polling: 50, timeout: 10_000 },
    ), signal);
  } catch (error) {
    if (signal?.aborted) throw new DOMException("ChatGPT browser page acquisition aborted", "AbortError");
    throw new Error(
      `ChatGPT browser surface did not expose an operational viewport: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export const CHATGPT_COMPOSER_DOCUMENT_END_KEY = process.platform === "darwin"
  ? "Meta+ArrowDown"
  : "Control+End";

function throwIfPromptAttachmentAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("ChatGPT prompt attachment aborted", "AbortError");
}

function withBrowserTurnAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new DOMException("ChatGPT web turn aborted", "AbortError"));
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const onAbort = () => rejectPromise(new DOMException("ChatGPT web turn aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolvePromise, rejectPromise).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

export interface BrowserTurn {
  traceId: string;
  modelId: string;
  reasoning?: string;
  capabilities: ChatGptWebCapabilities;
  prepare: () => Promise<CompiledChatGptWebPrompt & { release: () => void }>;
  prepareResume?: () => Promise<CompiledChatGptWebPrompt & { release: () => void }>;
  /** Select the Codex Native connector without advertising the ordinary turn tool environment. */
  nativeConnector?: boolean;
  retainConversation?: boolean;
  /** Dynamic steering preemption may preserve this exact Temporary Chat after an aborted run. */
  retainConversationOnAbort?: () => boolean;
  /**
   * ChatGPT opened a separate assistant turn for the steered revision. The answer authority moved to
   * that turn, so the superseded answer prefix must no longer be treated as part of the answer.
   */
  onSteeringReply?: (replyIdentity: string) => void;
  requireRetainedConversation?: boolean;
  conversationKey?: string;
  onPreparedSelected?: (reused: boolean) => void | Promise<void>;
  abortSignal?: AbortSignal;
  onHeartbeat?: () => void;
  /** Send activation is the ambiguity boundary after which a fresh surface must not replay this prompt. */
  onSendActivated?: () => void | Promise<void>;
  /** Semantic submission evidence proved that ChatGPT accepted the prompt. */
  onSubmitted?: () => void;
  /**
   * A request-injection rollback was proven, so the ambiguous send did not commit and replaying this
   * prompt on a fresh surface is safe again. Without this, a post-rollback failure such as a composer
   * ChatGPT refuses to clear is reported as an ambiguous terminal send and tears the turn down.
   */
  onSendRolledBack?: () => void;
  /** Visible ChatGPT reasoning-summary step titles only; never hidden chain-of-thought. */
  onReasoningSummary?: (text: string, continuation?: boolean) => void;
  /** Stable visible ChatGPT prose between status/tool rows. */
  onCommentary?: (text: string, continuation?: boolean) => void;
  /** Append-only, structurally stable Markdown chunks. */
  onTextDelta: (delta: string) => void;
  /** Final structured annotations recovered from the authoritative network response. */
  onOutputAnnotations?: (annotations: readonly CodexOutputTextAnnotation[]) => void;
  /** Proven current-turn MCP activity; never response content or completion. */
  externalProgress?: ChatGptTurnProgressReader;
  /** Atomically fences browser completion against concurrent MCP claims in the turn broker. */
  completionFence?: {
    begin(): Promise<number | undefined>;
    commit(revision: number): Promise<boolean>;
  };
  /** Allow one clean pre-submit composer retry for isolated history compaction only. */
  compaction?: boolean;
  /** Require and remove the private Luna checkpoint tail from the visible Markdown stream. */
  captureLunaCheckpoint?: boolean;
  onLunaCheckpoint?: (captured: CapturedChatGptLunaCheckpoint) => void;
  /** Ordered same-generation user revisions submitted through the active ChatGPT composer. */
  steering?: ChatGptBrowserSteeringQueue;
}

export interface ChatGptBrowserSteeringItem {
  id: string;
  prompt: CompiledChatGptWebPrompt;
}

/**
 * One logical Codex turn owns this queue.  A revision settles only after the browser proves that
 * ChatGPT accepted the extra user turn; enqueueing it is not submission evidence.
 */
export class ChatGptBrowserSteeringQueue {
  private readonly pending: Array<ChatGptBrowserSteeringItem & {
    resolve: () => void;
    reject: (error: Error) => void;
  }> = [];
  private readonly inFlight = new Set<{
    resolve: () => void;
    reject: (error: Error) => void;
    settled: boolean;
  }>();
  private readonly waiters = new Set<() => void>();
  private closed?: Error;

  submit(item: ChatGptBrowserSteeringItem): Promise<void> {
    if (this.closed) return Promise.reject(this.closed);
    if (!/^[A-Za-z0-9_-]{6,128}$/.test(item.id)) {
      return Promise.reject(new Error("ChatGPT steering item identity is invalid"));
    }
    if (!item.prompt.text.trim() || item.prompt.images.length > 0 || item.prompt.multipart) {
      return Promise.reject(new Error("In-flight ChatGPT steering supports one non-empty text message only"));
    }
    return new Promise<void>((resolve, reject) => {
      this.pending.push({ ...item, resolve, reject });
      for (const wake of [...this.waiters]) wake();
    });
  }

  take(): (ChatGptBrowserSteeringItem & { complete(error?: Error): void }) | undefined {
    const item = this.pending.shift();
    if (!item) return undefined;
    const settlement = { resolve: item.resolve, reject: item.reject, settled: false };
    this.inFlight.add(settlement);
    return {
      id: item.id,
      prompt: item.prompt,
      complete: error => {
        if (settlement.settled) return;
        settlement.settled = true;
        this.inFlight.delete(settlement);
        if (error) settlement.reject(error);
        else settlement.resolve();
      },
    };
  }

  hasPending(): boolean {
    return this.pending.length > 0;
  }

  waitForPending(signal?: AbortSignal): Promise<void> {
    if (this.pending.length > 0 || this.closed) return Promise.resolve();
    if (signal?.aborted) return Promise.reject(new DOMException("ChatGPT steering wait aborted", "AbortError"));
    return new Promise<void>((resolve, reject) => {
      const wake = () => {
        signal?.removeEventListener("abort", onAbort);
        this.waiters.delete(wake);
        resolve();
      };
      const onAbort = () => {
        this.waiters.delete(wake);
        reject(new DOMException("ChatGPT steering wait aborted", "AbortError"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.add(wake);
    });
  }

  close(error = new Error("ChatGPT browser turn ended before steering was submitted")): void {
    if (this.closed) return;
    this.closed = error;
    for (const item of this.pending.splice(0)) item.reject(error);
    for (const item of [...this.inFlight]) {
      if (item.settled) continue;
      item.settled = true;
      item.reject(error);
    }
    this.inFlight.clear();
    for (const wake of [...this.waiters]) wake();
    this.waiters.clear();
  }
}

interface ChatGptSubmissionBaseline {
  userTurns: Locator;
  responseTurns: Locator;
  initialUserTurnCount: number;
  initialResponseTurnCount: number;
  /** Stable logical turn ids from persistent outer containers; primary ownership authority. */
  initialTurnIdentities: readonly string[];
  initialUserTurnIdentities: readonly string[];
  initialResponseTurnIdentities: readonly string[];
  domCache: ChatGptSubmissionDomCache;
}

interface ChatGptAssistantTurnBinding {
  identity: string;
  documentId: string;
  locator: Locator;
  /** All logical turns accepted when this assistant binding was committed. */
  acceptedTurnIdentities: readonly string[];
  /** Kept for stronger custom recovery proofs that specifically fence user turns. */
  acceptedUserTurnIdentities: readonly string[];
}

interface ChatGptSubmissionDomState {
  documentId: string;
  userTurnCount: number;
  assistantTurnCount: number;
  visibleStopButtonCount: number;
  turnIdentities: string[];
  userIdentities: string[];
  responseIdentities: string[];
}

interface ChatGptSubmissionDomCache {
  key?: string;
  snapshot?: ChatGptSubmissionDomState;
  fullScans?: number;
  cacheHits?: number;
}

export interface ResolvedBrowserConfig {
  appName: string;
  browserHost: "managed-chrome" | "launcher";
  browserHostDescriptorPath?: string;
  browserHelperScriptPath?: string;
  browserDiagnosticsPath?: string;
  storageStatePath: string;
  chromeExecutablePath: string;
  turnTimeoutMs?: number;
  headed: boolean;
  autoApproveToolCalls: boolean;
}

export function chatGptTurnIsComplete(state: {
  responsePresent: boolean;
  running: boolean;
  currentText: string;
  currentHtml?: string;
  completionActionVisible: boolean;
}): boolean {
  return state.responsePresent
    && !state.running
    && state.currentText.length > 0
    && state.completionActionVisible;
}

export type ChatGptSubmissionEvidence = "user_turn" | "assistant_turn" | "generation_running" | "mcp_tool_call";

export function chatGptSubmissionEvidence(state: {
  initialUserTurnCount: number;
  userTurnCount: number;
  initialAssistantTurnCount: number;
  assistantTurnCount: number;
  generationRunning: boolean;
}): ChatGptSubmissionEvidence | undefined {
  if (state.userTurnCount > state.initialUserTurnCount) return "user_turn";
  if (state.assistantTurnCount > state.initialAssistantTurnCount) return "assistant_turn";
  if (state.generationRunning) return "generation_running";
  return undefined;
}

export type ChatGptConnectorAttachmentMode = "none" | "mention" | "retained";

/** A launcher lease may reuse a connector only after proving that exact retained surface is bound. */
export function chatGptConnectorAttachmentMode(
  localTools: boolean,
  reuseConversation: boolean,
): ChatGptConnectorAttachmentMode {
  if (!localTools) return "none";
  return reuseConversation ? "retained" : "mention";
}

export async function setChatGptThinkMode(
  composerForm: Locator,
  enabled: boolean,
  captureDiagnostic?: (checkpoint: string) => Promise<void>,
): Promise<void> {
  const controls = composerForm
    .getByRole("button", { name: "Think", exact: true })
    .filter({ visible: true });
  const count = await controls.count();
  if (count === 0) {
    if (enabled) throw new Error("ChatGPT Think control is not available on this Luna-only account");
    await captureDiagnostic?.("luna-default-confirmed");
    return;
  }
  if (count !== 1) throw new Error(`ChatGPT exposed ${count} visible Think controls`);
  const control = controls.first();
  let pressed = await control.getAttribute("aria-pressed");
  if (pressed !== "true" && pressed !== "false") {
    throw new Error("ChatGPT Think control has no semantic pressed state");
  }
  const target = enabled ? "true" : "false";
  if (pressed !== target) {
    await control.click();
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      pressed = await control.getAttribute("aria-pressed");
      if (pressed === target) break;
      if (pressed !== "true" && pressed !== "false") {
        throw new Error("ChatGPT Think control lost its semantic pressed state");
      }
      await new Promise(resolveSleep => setTimeout(resolveSleep, 100));
    }
    if (pressed !== target) {
      throw new Error(`ChatGPT did not ${enabled ? "enable" : "disable"} Think mode`);
    }
  }
  await captureDiagnostic?.(enabled ? "think-enabled" : "think-disabled");
}

export function chatGptNewTurnIdentity(
  initial: readonly string[],
  current: readonly string[],
): string | undefined {
  const previous = new Set(initial);
  const added = current.filter(identity => !previous.has(identity));
  if (added.length > 1) {
    throw new Error(`ChatGPT exposed ${added.length} new conversation turns for one submitted message`);
  }
  return added[0];
}

export function chatGptReboundTurnIdentity(
  initial: readonly string[],
  boundIdentity: string,
  current: readonly string[],
): string | undefined {
  if (current.includes(boundIdentity)) return boundIdentity;
  return chatGptNewTurnIdentity(initial, current);
}

/**
 * Proves that a later DOM observation still belongs to the same JS document and submitted user
 * turn before accepting the existing assistant identity or its one already-supported React
 * replacement. This is a read-only proof helper: it never authorizes navigation or submission.
 */
export function chatGptSameDocumentTurnIdentity(
  expectedDocumentId: string,
  currentDocumentId: string,
  acceptedUserTurnIdentities: readonly string[],
  currentUserTurnIdentities: readonly string[],
  initialResponseTurnIdentities: readonly string[],
  boundAssistantTurnIdentity: string,
  currentResponseTurnIdentities: readonly string[],
): string {
  if (!expectedDocumentId || currentDocumentId !== expectedDocumentId) {
    throw new Error("ChatGPT launcher surface no longer exposes the committed response document");
  }
  const acceptedUsers = new Set(acceptedUserTurnIdentities);
  if (currentUserTurnIdentities.some(identity => !acceptedUsers.has(identity))) {
    throw new Error("ChatGPT opened another user turn while proving the committed response document");
  }
  const addedIdentity = chatGptNewTurnIdentity(
    initialResponseTurnIdentities,
    currentResponseTurnIdentities,
  );
  const identity = currentResponseTurnIdentities.includes(boundAssistantTurnIdentity)
    ? boundAssistantTurnIdentity
    : addedIdentity;
  if (addedIdentity && identity !== addedIdentity) {
    throw new Error("ChatGPT exposed another assistant turn alongside the committed response turn");
  }
  if (!identity) {
    throw new Error("ChatGPT committed assistant turn disappeared from its proven response document");
  }
  return identity;
}

export class ChatGptCompletionTracker {
  private candidate?: { signature: string; since: number };
  private lastToolBatchRevision = 0;
  private postToolAnswerBaselineText?: string;
  private missingPostToolAnswerSince?: number;

  constructor(
    private readonly stableMs = CHATGPT_COMPLETION_SETTLE_MS,
    private readonly missingPostToolAnswerMs = CHATGPT_COMPLETION_ACTION_GRACE_MS,
  ) {}

  needsToolBatchObservation(revision: number): boolean {
    if (!Number.isSafeInteger(revision) || revision < this.lastToolBatchRevision) {
      throw new Error("ChatGPT completion received an invalid tool-batch revision");
    }
    return revision > this.lastToolBatchRevision;
  }

  observeToolBatch(revision: number, currentText: string): boolean {
    if (!this.needsToolBatchObservation(revision)) return false;
    // The caller acknowledges the batch only after this projection is captured. The outer Codex
    // harness therefore cannot execute the tool until this exact pre-tool answer boundary exists.
    this.postToolAnswerBaselineText = currentText;
    this.lastToolBatchRevision = revision;
    this.missingPostToolAnswerSince = undefined;
    this.candidate = undefined;
    return true;
  }

  update(
    state: Parameters<typeof chatGptTurnIsComplete>[0] & {
      externalToolCallsInFlight?: boolean;
    },
    now = Date.now(),
  ): boolean {
    const signature = `${state.currentText}\0${state.currentHtml ?? state.currentText}`;
    // An outstanding tool call proves the model has more to say, whatever the rendered message
    // currently looks like. Completing here would return a truncated answer and retire the turn
    // while its own tool calls were still in flight.
    if (state.externalToolCallsInFlight) {
      this.candidate = undefined;
      this.missingPostToolAnswerSince = undefined;
      return false;
    }
    if (this.postToolAnswerBaselineText === state.currentText) {
      this.candidate = undefined;
      if (!chatGptTurnIsComplete(state)) {
        this.missingPostToolAnswerSince = undefined;
        return false;
      }
      this.missingPostToolAnswerSince ??= now;
      if (now - this.missingPostToolAnswerSince >= this.missingPostToolAnswerMs) {
        throw new Error("ChatGPT completed without producing a final answer after its last Codex tool call");
      }
      return false;
    }
    this.missingPostToolAnswerSince = undefined;
    if (!chatGptTurnIsComplete(state)) {
      this.candidate = undefined;
      return false;
    }
    if (this.candidate?.signature !== signature) {
      this.candidate = { signature, since: now };
      return false;
    }
    return now - this.candidate.since >= this.stableMs;
  }
}

export class ChatGptTurnDomHealthTracker {
  private sawResponse = false;
  private missingResponseSince?: number;
  private emptyCompletionSince?: number;
  private missingCompletionAction?: { text: string; since: number };

  constructor(
    private readonly missingResponseMs = CHATGPT_RESPONSE_DOM_GRACE_MS,
    private readonly emptyCompletionMs = CHATGPT_EMPTY_RESPONSE_GRACE_MS,
    private readonly missingCompletionActionMs = CHATGPT_COMPLETION_ACTION_GRACE_MS,
  ) {}

  /**
   * Clears only the missing-response window, leaving `sawResponse` history intact.
   *
   * Callers use this when proven external progress suspends DOM health checks: the suspended
   * stretch must not be charged against the grace period, or the first observation after it
   * resumes would fail instantly against a timestamp recorded long before.
   */
  clearMissingResponse(): void {
    this.missingResponseSince = undefined;
  }

  update(state: {
    responsePresent: boolean;
    running: boolean;
    currentText: string;
    completionActionVisible: boolean;
    externalProgressLive?: boolean;
  }, now = Date.now()): string | undefined {
    if (state.responsePresent) this.sawResponse = true;
    if (state.externalProgressLive) {
      // Every conclusion below asserts that ChatGPT stopped producing this turn. A tool call that
      // is still completing disproves all of them, whatever the renderer is currently exposing, so
      // no window may accrue while the model is provably working.
      this.missingResponseSince = undefined;
      this.emptyCompletionSince = undefined;
      this.missingCompletionAction = undefined;
      return undefined;
    }
    if (state.responsePresent) {
      this.missingResponseSince = undefined;
    } else {
      this.missingResponseSince ??= now;
      if (now - this.missingResponseSince >= this.missingResponseMs) {
        return this.sawResponse
          ? "ChatGPT response DOM disappeared while the browser turn was active"
          : "ChatGPT did not create a response DOM after the message was sent";
      }
    }

    const emptyCompletion = state.responsePresent
      && !state.running
      && state.currentText.length === 0
      && state.completionActionVisible;
    if (!emptyCompletion) {
      this.emptyCompletionSince = undefined;
    } else {
      this.emptyCompletionSince ??= now;
      if (now - this.emptyCompletionSince >= this.emptyCompletionMs) {
        return "ChatGPT browser turn completed without a final answer";
      }
    }

    const missingCompletionAction = state.responsePresent
      && !state.running
      && state.currentText.length > 0
      && !state.completionActionVisible;
    if (!missingCompletionAction) {
      this.missingCompletionAction = undefined;
    } else if (this.missingCompletionAction?.text !== state.currentText) {
      this.missingCompletionAction = { text: state.currentText, since: now };
    } else if (now - this.missingCompletionAction.since >= this.missingCompletionActionMs) {
      return "ChatGPT stopped generating but did not expose its completed-turn action; the ChatGPT DOM may have changed";
    }
    return undefined;
  }
}

export const CHATGPT_STOPPED_THINKING_GRACE_MS = 5_000;

/**
 * Consecutive internal observation faults tolerated before a turn is abandoned.
 *
 * A `TypeError` raised while reading the page is a defect in this worker, not evidence about
 * ChatGPT. Tearing the turn down on one loses an accepted ChatGPT turn that cannot be resent, so
 * the loop re-observes instead. The budget is consecutive: any successful observation resets it,
 * and exhausting it still fails closed with the original fault as the cause.
 */
export const MAX_CHATGPT_INTERNAL_OBSERVATION_FAULTS = 8;

/**
 * How stale recorded MCP progress may be and still suppress DOM health checks.
 *
 * An outstanding tool call reports liveness regardless of age, so a call that never returns would
 * otherwise hold a turn open forever — turns carry no deadline unless a caller supplies one. This
 * bounds the silence since the last recorded activity rather than the turn's total duration, so a
 * long turn that keeps calling tools is never penalised for taking a long time.
 */
export const CHATGPT_EXTERNAL_PROGRESS_STALL_CEILING_MS = 10 * 60_000;

/** Tolerated clock difference between the recording daemon and the observing helper process. */
export const CHATGPT_EXTERNAL_PROGRESS_CLOCK_SKEW_MS = 5_000;

/** Proven MCP activity, additionally required to be recent enough to still be evidence. */
export function chatGptExternalProgressSuppressesDomHealth(
  snapshot: ChatGptExternalTurnProgressSnapshot | undefined,
  now: number,
): boolean {
  if (!chatGptExternalProgressIsLive(snapshot, now, CHATGPT_RESPONSE_DOM_GRACE_MS)) return false;
  const lastProgressAt = snapshot?.lastProgressAt;
  if (lastProgressAt === undefined) return false;
  const age = now - lastProgressAt;
  // A timestamp from the future would keep `age` below the ceiling forever. Recorded activity can
  // only precede the observation, so anything meaningfully ahead of now is not evidence at all.
  return age >= -CHATGPT_EXTERNAL_PROGRESS_CLOCK_SKEW_MS
    && age < CHATGPT_EXTERNAL_PROGRESS_STALL_CEILING_MS;
}

export class ChatGptStoppedThinkingTracker {
  private visibleSince?: number;

  /**
   * Forgets an in-progress "Stopped thinking" window.
   *
   * Suppressing only the throw let the window keep accruing while a tool call was outstanding, so
   * the first observation after progress ended cancelled the turn instantly. Proven activity must
   * reset the evidence, not merely postpone acting on it.
   */
  clear(): void {
    this.visibleSince = undefined;
  }

  constructor(private readonly graceMs = CHATGPT_STOPPED_THINKING_GRACE_MS) {
    if (!Number.isFinite(graceMs) || graceMs < 0) {
      throw new Error("ChatGPT Stopped thinking grace must be a non-negative finite number");
    }
  }

  update(visible: boolean, now = Date.now()): boolean {
    if (!visible) {
      this.visibleSince = undefined;
      return false;
    }
    this.visibleSince ??= now;
    return now - this.visibleSince >= this.graceMs;
  }
}

export interface ChatGptVisibleTraceBlock {
  kind: "answer" | "commentary" | "status";
  text: string;
  key?: string;
  complete?: boolean;
  uiControl?: boolean;
}

export interface ChatGptVisibleTraceEvent {
  kind: "reasoning" | "commentary";
  text: string;
  continuation?: boolean;
}

interface ChatGptResponseDomSnapshot {
  responsePresent: boolean;
  visibleText: string;
  fullHtml: string;
  markdownSegments: ChatGptMarkdownSegment[];
  completionActionVisible: boolean;
  stoppedThinkingVisible: boolean;
  traceBlocks: ChatGptVisibleTraceBlock[];
}

interface ChatGptResponseDomCache {
  key?: string;
  snapshot?: ChatGptResponseDomSnapshot;
  fullScans?: number;
  cacheHits?: number;
  mutationWaits?: number;
  mutationWakeups?: number;
  mutationTimeouts?: number;
}

const absentResponseDomSnapshot = (): ChatGptResponseDomSnapshot => ({
  responsePresent: false,
  visibleText: "",
  fullHtml: "",
  markdownSegments: [],
  completionActionVisible: false,
  stoppedThinkingVisible: false,
  traceBlocks: [],
});

/** Convert the public ChatGPT turn DOM into append-only Codex reasoning summaries. */
export class ChatGptVisibleTraceTracker {
  private readonly emittedTrace = new Map<string, string>();
  private readonly traceCandidates = new Map<string, { text: string; changedAt: number }>();

  constructor(private readonly traceStabilityMs = 250) {}

  observe(blocks: ChatGptVisibleTraceBlock[], completionActionVisible: boolean, now = Date.now()): ChatGptVisibleTraceEvent[] {
    const output: ChatGptVisibleTraceEvent[] = [];
    let statusSlot = 0;
    let commentarySlot = 0;
    for (const block of blocks) {
      // Final-answer roots are carried by ChatGptMarkdownBuffer. Commentary roots are identified
      // structurally by responseDomSnapshot before they reach this tracker.
      if (block.kind === "answer") continue;
      const index = block.kind === "status" ? statusSlot++ : commentarySlot++;
      const slot = block.key ? `${block.kind}:${block.key}` : `${block.kind}:${index}`;
      const stripped = block.text
        .replace(/\r\n/g, "\n")
        .split("\n")
        .map(line => line.replace(/[\t ]+/g, " ").trim())
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      const text = block.kind === "status" ? stripped.replace(/\s+/g, " ") : stripped;
      if (!text) continue;
      let candidate = this.traceCandidates.get(slot);
      if (!candidate || candidate.text !== text) {
        candidate = { text, changedAt: now };
        this.traceCandidates.set(slot, candidate);
        // An anchored status row with a following rendered sibling is already structurally closed:
        // ChatGPT has moved on to the next work/tool item. Emit it immediately so a short-lived row
        // does not vanish during the generic 250ms live-status debounce.
        const structurallyCompleteStatus = block.kind === "status" && block.complete === true;
        if (!completionActionVisible && this.traceStabilityMs > 0 && !structurallyCompleteStatus) continue;
      }
      // A commentary Markdown root remains mutable until ChatGPT appends the next reasoning item.
      // Emitting it earlier lets a tool-status boundary split one semantic paragraph into multiple
      // Codex messages. The next anchored item (or final completion evidence) is the stable boundary.
      if (block.kind === "commentary" && block.complete === false && !completionActionVisible) continue;
      const structurallyCompleteStatus = block.kind === "status" && block.complete === true;
      if (!completionActionVisible && !structurallyCompleteStatus && now - candidate.changedAt < this.traceStabilityMs) continue;

      const previous = this.emittedTrace.get(slot);
      if (previous === text) continue;
      this.emittedTrace.set(slot, text);
      const kind = block.kind === "commentary" ? "commentary" : "reasoning";

      if (previous && text.startsWith(previous)) {
        output.push({ kind, text: text.slice(previous.length), continuation: true });
      } else {
        output.push({ kind, text });
      }
    }
    return output;
  }
}

export function isChatGptTraceControl(block: ChatGptVisibleTraceBlock): boolean {
  if (block.kind !== "status") return false;
  const text = block.text.replace(/\s+/g, " ").trim();
  return block.uiControl === true || text === "Answer now" || text === "Thinking";
}

export function stripChatGptTraceControlSuffix(block: ChatGptVisibleTraceBlock): ChatGptVisibleTraceBlock {
  if (block.kind !== "status") return block;
  const text = block.text.replace(/(?:^|\s)Answer now\s*$/, "").trimEnd();
  return text === block.text ? block : { ...block, text };
}

export function redactChatGptUiDiagnostic(value: string): string {
  return value
    .replace(/<codex_context_json>[\s\S]*?<\/codex_context_json>/gi, "<codex_context_json>[redacted]</codex_context_json>")
    .replace(/\b(turn|binding|call)_[A-Za-z0-9_-]{12,}\b/g, "$1_[redacted]");
}

const CHATGPT_BROWSER_DIAGNOSTIC_TRACE_LIMIT = 10;

export function browserDiagnosticCheckpoint(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return safe || "checkpoint";
}

export function browserDiagnosticIncludesScreenshot(
  checkpoint: string,
  captureAll = process.env.CODEX_CHATGPT_WEB_BROWSER_DIAGNOSTICS === "1",
): boolean {
  return captureAll || checkpoint === "response-stalled-30s" || checkpoint === "turn-failed";
}

export function browserDiagnosticCaptureEnabled(
  checkpoint: string,
  error?: unknown,
  captureAll = process.env.CODEX_CHATGPT_WEB_BROWSER_DIAGNOSTICS === "1",
): boolean {
  return captureAll
    || error !== undefined
    || checkpoint === "response-stalled-30s"
    || checkpoint === "turn-failed";
}

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  try { chmodSync(path, 0o700); } catch { /* Windows ACLs are managed by the installer. */ }
}

function pruneBrowserDiagnostics(root: string): void {
  const traces = readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^[A-Za-z0-9_-]{6,128}$/.test(entry.name))
    .map(entry => {
      const path = join(root, entry.name);
      return { path, modifiedAt: statSync(path).mtimeMs };
    })
    .sort((left, right) => right.modifiedAt - left.modifiedAt);
  for (const trace of traces.slice(CHATGPT_BROWSER_DIAGNOSTIC_TRACE_LIMIT)) {
    rmSync(trace.path, { recursive: true, force: true });
  }
}

class ChatGptBrowserDiagnostics {
  private readonly directory: string;
  private sequence = 0;
  private initialized = false;

  constructor(private readonly traceId: string, private readonly root: string) {
    if (!/^[A-Za-z0-9_-]{6,128}$/.test(traceId)) {
      throw new Error("ChatGPT browser diagnostic trace id is invalid");
    }
    this.directory = join(this.root, `${traceId}-${randomUUID().slice(0, 8)}`);
  }

  async capture(page: Page, checkpoint: string, error?: unknown): Promise<void> {
    // Routine checkpoints used to synchronously inspect the renderer and write a JSON artifact on
    // every successful turn even when screenshots were disabled. Keep the call sites/ordering as
    // diagnostic hooks, but make the default success path scalar-log only. Full diagnostics remain
    // opt-in, while stalled/failed turns still capture bounded state for post-mortem evidence.
    if (!browserDiagnosticCaptureEnabled(checkpoint, error)) return;
    try {
      if (!this.initialized) {
        privateDirectory(this.root);
        privateDirectory(this.directory);
        pruneBrowserDiagnostics(this.root);
        this.initialized = true;
      }
      const sequence = String(++this.sequence).padStart(2, "0");
      const stem = `${sequence}-${browserDiagnosticCheckpoint(checkpoint)}`;
      const includeScreenshot = browserDiagnosticIncludesScreenshot(checkpoint);
      const [screenshotResult, stateResult] = await Promise.allSettled([
        includeScreenshot
          ? page.screenshot({ animations: "disabled", caret: "hide", timeout: 5_000, type: "png" })
          : Promise.resolve(undefined),
        withChatGptBrowserObservationTimeout(page.evaluate(({
          composerSelector,
          effortControlSelector,
          effortItemSelector,
          assistantTurnSelector,
        }) => {
          const rendered = (element: Element): boolean => {
            const candidate = element as HTMLElement;
            const style = getComputedStyle(candidate);
            return candidate.isConnected
              && style.display !== "none"
              && style.visibility !== "hidden"
              && style.opacity !== "0";
          };

          const boundedText = (element: Element): string => (
            (element.textContent || "")
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 1_000)
          );
          const rows = (selector: string, limit = 40) => [...document.querySelectorAll(selector)]
            .filter(rendered)
            .slice(-limit)
            .map(element => {
              const rect = element.getBoundingClientRect();
              return {
                tag: element.tagName.toLowerCase(),
                role: element.getAttribute("role"),
                testId: element.getAttribute("data-testid"),
                ariaExpanded: element.getAttribute("aria-expanded"),
                ariaChecked: element.getAttribute("aria-checked"),
                dataState: element.getAttribute("data-state"),
                dataHighlighted: element.getAttribute("data-highlighted"),
                rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
                text: boundedText(element),
              };
            });
          const composers = [...document.querySelectorAll(composerSelector)].filter(rendered);
          const assistantTurns = [...document.querySelectorAll(assistantTurnSelector)].filter(rendered);
          return {
            url: location.href,
            title: document.title,
            viewport: { width: innerWidth, height: innerHeight },
            surfaceId: (globalThis as typeof globalThis & { __CODEX_WEB_GPT_SURFACE_ID__?: unknown })
              .__CODEX_WEB_GPT_SURFACE_ID__ ?? null,
            // textContent avoids the synchronous layout forced by innerText on huge prompts.
            bodyTextChars: document.body?.textContent?.length ?? 0,
            composer: {
              visibleCount: composers.length,
              textChars: composers.map(element => (element.textContent ?? "").length),
              selectedConnectors: rows('[data-id^="plugin:"][data-keyword]', 20),
            },
            effortControls: rows(effortControlSelector, 10),
            effortItems: rows(effortItemSelector, 20),
            menus: rows('[role="menu"], [role="listbox"], [data-testid="composer-intelligence-picker-content"]', 20),
            connectorRows: rows('.__menu-item[tabindex="0"]', 40),
            overlays: rows('[role="dialog"], [role="alert"], [role="status"]', 30),
            turns: {
              user: document.querySelectorAll('[data-testid^="conversation-turn-"][data-message-author-role="user"]').length,
              assistant: assistantTurns.map(element => ({
                textChars: (element.textContent ?? "").length,
                htmlChars: (element as HTMLElement).innerHTML.length,
              })),
            },
          };
        }, {
          composerSelector: CHATGPT_COMPOSER_SELECTOR,
          effortControlSelector: CHATGPT_EFFORT_CONTROL_SELECTOR,
          effortItemSelector: CHATGPT_EFFORT_ITEM_SELECTOR,
          assistantTurnSelector: CHATGPT_ASSISTANT_TURN_SELECTOR,
        })),
      ]);
      const capturedAt = new Date().toISOString();
      if (screenshotResult.status === "fulfilled" && screenshotResult.value) {
        atomicWriteFile(join(this.directory, `${stem}.png`), screenshotResult.value);
      }
      const captureErrors = Object.fromEntries([
        ...(screenshotResult.status === "rejected" ? [[
          "screenshot",
          redactChatGptUiDiagnostic(
            screenshotResult.reason instanceof Error ? screenshotResult.reason.message : String(screenshotResult.reason),
          ),
        ]] : []),
        ...(stateResult.status === "rejected" ? [[
          "state",
          redactChatGptUiDiagnostic(
            stateResult.reason instanceof Error ? stateResult.reason.message : String(stateResult.reason),
          ),
        ]] : []),
      ]);
      atomicWriteFile(join(this.directory, `${stem}.json`), `${JSON.stringify({
        version: 1,
        capturedAt,
        traceId: this.traceId,
        checkpoint,
        ...(error !== undefined ? {
          error: redactChatGptUiDiagnostic(error instanceof Error ? error.message : String(error)),
        } : {}),
        ...(stateResult.status === "fulfilled" ? { state: stateResult.value } : {}),
        ...(Object.keys(captureErrors).length > 0 ? { captureErrors } : {}),
      }, null, 2)}\n`);
      if (Object.keys(captureErrors).length > 0) {
        console.warn(
          `[chatgpt-web] browser diagnostic partial capture trace=${this.traceId}`
          + ` checkpoint=${stem} failures=${Object.keys(captureErrors).join(",")}`,
        );
      }
      console.info(`[chatgpt-web] browser diagnostic trace=${this.traceId} checkpoint=${stem} path=${this.directory}`);
    } catch (captureError) {
      console.warn(
        `[chatgpt-web] browser diagnostic capture failed trace=${this.traceId}`
        + ` checkpoint=${browserDiagnosticCheckpoint(checkpoint)}:`
        + ` ${captureError instanceof Error ? captureError.message : String(captureError)}`,
      );
    }
  }
}

export function resolveBrowserConfig(provider: CodexProviderConfig): ResolvedBrowserConfig {
  const configured = provider.chatgptWeb ?? {};
  const appName = configured.appName?.trim() || CHATGPT_CONNECTOR_NAME;
  const browserHost = configured.browserHost ?? "managed-chrome";
  const browserHostDescriptorPath = configured.browserHostDescriptorPath?.trim();
  const browserHelperScriptPath = configured.browserHelperScriptPath?.trim();
  const browserDiagnosticsPath = resolve(expandUserPath(
    configured.browserDiagnosticsPath?.trim() || join(getConfigDir(), "diagnostics", "browser-turns"),
  ));
  const turnTimeoutMs = configured.turnTimeoutMs;
  if (browserHost === "launcher" && !browserHostDescriptorPath) {
    throw new Error("Launcher browser host requires chatgptWeb.browserHostDescriptorPath");
  }
  if (browserHelperScriptPath && browserHost !== "launcher") {
    throw new Error("Explicit browser helper script requires a launcher host");
  }
  const resolvedBrowserHelperScriptPath = browserHelperScriptPath
    ? resolve(expandUserPath(browserHelperScriptPath))
    : undefined;
  if (resolvedBrowserHelperScriptPath && !existsSync(resolvedBrowserHelperScriptPath)) {
    throw new Error(`Explicit browser helper script does not exist: ${resolvedBrowserHelperScriptPath}`);
  }
  if (turnTimeoutMs !== undefined
    && (!Number.isFinite(turnTimeoutMs) || turnTimeoutMs <= 0)) {
    throw new Error("ChatGPT Web turnTimeoutMs must be a positive finite number");
  }
  if (isLegacyChatGptConnectorName(appName)) {
    throw new Error(legacyChatGptConnectorMigrationMessage(appName));
  }
  return {
    appName,
    browserHost,
    ...(browserHostDescriptorPath ? { browserHostDescriptorPath: resolve(expandUserPath(browserHostDescriptorPath)) } : {}),
    ...(resolvedBrowserHelperScriptPath ? { browserHelperScriptPath: resolvedBrowserHelperScriptPath } : {}),
    browserDiagnosticsPath,
    storageStatePath: resolve(expandUserPath(configured.storageStatePath?.trim() || join(getConfigDir(), "browser", "storage-state.json"))),
    chromeExecutablePath: resolve(expandUserPath(configured.chromeExecutablePath?.trim() || defaultChromeExecutable())),
    ...(turnTimeoutMs !== undefined ? { turnTimeoutMs } : {}),
    headed: configured.headed !== false,
    autoApproveToolCalls: configured.autoApproveToolCalls === true,
  };
}

const imageExtensions = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/gif", "gif"],
  ["image/webp", "webp"],
]);

export function chatGptImageFilePayloads(images: ChatGptWebPromptImage[]): Array<{ name: string; mimeType: string; buffer: Buffer }> {
  if (images.length > CHATGPT_MAX_INPUT_IMAGES) {
    throw new Error(`ChatGPT web accepts at most ${CHATGPT_MAX_INPUT_IMAGES} input images per Codex turn`);
  }
  let totalBytes = 0;
  return images.map(image => {
    const parsed = parseDataUrl(image.imageUrl);
    if (!parsed) throw new Error(`ChatGPT web input image ${image.ref} must be an inline base64 data URL`);
    const extension = imageExtensions.get(parsed.mediaType.toLowerCase());
    if (!extension) throw new Error(`ChatGPT web input image ${image.ref} has unsupported media type: ${parsed.mediaType}`);
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(parsed.base64) || parsed.base64.length % 4 !== 0) {
      throw new Error(`ChatGPT web input image ${image.ref} contains invalid base64 data`);
    }
    const buffer = Buffer.from(parsed.base64, "base64");
    if (buffer.length === 0) throw new Error(`ChatGPT web input image ${image.ref} is empty`);
    if (buffer.length > 20_000_000) throw new Error(`ChatGPT web input image ${image.ref} exceeds 20 MB`);
    totalBytes += buffer.length;
    if (totalBytes > 50_000_000) throw new Error("ChatGPT web input images exceed the 50 MB per-turn limit");
    return { name: `${image.ref}.${extension}`, mimeType: parsed.mediaType.toLowerCase(), buffer };
  });
}

export function chatGptPromptFilePayloads(
  prompt: CompiledChatGptWebPrompt,
): Array<{ name: string; mimeType: string; buffer: Buffer }> {
  return chatGptImageFilePayloads(prompt.images);
}

/**
 * Insert `value` at the caret of an already-resolved ChatGPT composer, returning whether the edit
 * was applied. Runs inside the page, so it may reference only globals and its two arguments.
 *
 * Effort selection closes a menu immediately before a staged part is attached, and focus is still
 * settling when this runs: the composer can be the active element while the caret has not yet been
 * placed inside it, or focus can still be on the menu that just closed. Reading that as a rejected
 * edit failed whole turns roughly a tenth of a second after the effort menu closed, so the caret is
 * placed explicitly instead of assumed. An existing collapsed caret inside the composer is left
 * exactly where the user put it; only a missing or foreign one is replaced, and always with a
 * position inside this composer, so an insert can never land in another element.
 */
export async function insertPlainTextIntoComposer(
  element: HTMLElement,
  value: string,
): Promise<{ inserted: boolean; observed: string | null }> {
  if (document.activeElement !== element) element.focus();
  if (document.activeElement !== element) return { inserted: false, observed: null };
  const selection = window.getSelection();
  if (!selection) return { inserted: false, observed: null };
  const alreadyPlaced = selection.isCollapsed
    && selection.anchorNode !== null
    && element.contains(selection.anchorNode);
  if (!alreadyPlaced) {
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }
  if (
    !selection.isCollapsed
    || !selection.anchorNode
    || !element.contains(selection.anchorNode)
  ) {
    return { inserted: false, observed: null };
  }
  if (!document.execCommand("insertText", false, value)) {
    return { inserted: false, observed: null };
  }

  // Keep the successful fast path inside one renderer transaction without relying on a wall-clock
  // timer. Hidden launcher surfaces are background-throttled by Chromium, so even setTimeout(100)
  // can become a roughly half-second pause. What matters here is not 100ms of elapsed time but that
  // the input event's queued renderer work has settled. Flush microtasks, then require the exact
  // readback to remain unchanged across two independent MessageChannel task boundaries. A detached
  // or replaced composer, focus loss, or any delayed Lexical rewrite withholds the fast proof and
  // sends the caller through the existing strict attachment assertion instead.
  const readback = (): string | null => {
    if (!element.isConnected || document.activeElement !== element) return null;
    const clone = element.cloneNode(true) as HTMLElement;
    clone.querySelectorAll(
      '[data-id^="plugin:"][data-keyword], [data-inline-selection-pill-cursor-target]',
    ).forEach(part => part.remove());
    return [...clone.childNodes]
      .map(child => child.textContent ?? "")
      .join("\n")
      .trimStart();
  };
  const nextRendererTask = (): Promise<void> => new Promise(resolve => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      channel.port2.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });

  await Promise.resolve();
  const firstObserved = readback();
  if (firstObserved === null) return { inserted: true, observed: null };
  await nextRendererTask();
  const secondObserved = readback();
  if (secondObserved === null || secondObserved !== firstObserved) {
    return { inserted: true, observed: null };
  }
  await nextRendererTask();
  const finalObserved = readback();
  return {
    inserted: true,
    observed: finalObserved === secondObserved ? finalObserved : null,
  };
}

/**
 * Replace the composer content through the editor's own editing commands.
 *
 * The ordinary prompt attachment clears the editor with a DOM-level fill. On the launcher surface
 * that can leave ChatGPT's editor state and its rendered DOM out of step, and the one shared submit
 * control then never swaps back from Stop to Send even though the inserted text is visible, which is
 * exactly the state that made an in-flight steering submit unprovable. An empty value clears only.
 */
export async function writeComposerTextWithEditorCommands(
  element: HTMLElement,
  value: string,
): Promise<{ inserted: boolean; reason: string }> {
  if (document.activeElement !== element) element.focus();
  if (document.activeElement !== element) return { inserted: false, reason: "focus-refused" };
  const selection = window.getSelection();
  if (!selection) return { inserted: false, reason: "no-selection" };
  const current = element.textContent ?? "";
  if (value.length > 0 && current === value) return { inserted: true, reason: "already-inserted" };
  if (current.length > 0) {
    const all = document.createRange();
    all.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(all);
    document.execCommand("delete", false);
  }
  if (value.length === 0) return { inserted: true, reason: "cleared" };
  const collapsed = document.createRange();
  collapsed.selectNodeContents(element);
  collapsed.collapse(false);
  selection.removeAllRanges();
  selection.addRange(collapsed);
  const inserted = document.execCommand("insertText", false, value);
  return { inserted, reason: inserted ? "inserted" : "exec-refused" };
}

export class ChatGptBrowserWorker {
  static forProvider(provider: CodexProviderConfig): ChatGptBrowserWorker {
    const config = resolveBrowserConfig(provider);
    const key = JSON.stringify(config);
    let worker = workers.get(key);
    if (!worker) {
      worker = new ChatGptBrowserWorker(config);
      workers.set(key, worker);
    }
    return worker;
  }

  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private managedBrowserReady?: Promise<{ browser: Browser; context: BrowserContext }>;
  private launcherHelper?: LauncherBrowserHelperClient;
  private maintenanceTail: Promise<void> = Promise.resolve();
  private readonly activeRuns = new Map<string, Promise<string>>();

  private constructor(private readonly config: ResolvedBrowserConfig) {}

  /**
   * Lexical/contenteditable may preserve runs of ASCII spaces by exposing some of them as NBSP
   * through DOM textContent. Treat that DOM-only representation as equivalent only when the
   * expected U+0020 belongs to a multi-space run. Single spaces, tabs, newlines, intentional
   * expected NBSP characters, and every other mutation remain exact and fail closed.
   */
  private promptCodeUnitEquivalent(
    expected: string,
    observed: string,
    index: number,
  ): boolean {
    const expectedUnit = expected[index];
    const observedUnit = observed[index];

    if (expectedUnit === observedUnit) return true;
    if (expectedUnit !== " " || observedUnit !== "\u00A0") return false;

    return expected[index - 1] === " " || expected[index + 1] === " ";
  }

  private promptTextEquivalent(
    expected: string,
    observed: string,
  ): boolean {
    if (expected.length !== observed.length) return false;

    for (let index = 0; index < expected.length; index += 1) {
      if (!this.promptCodeUnitEquivalent(expected, observed, index)) {
        return false;
      }
    }

    return true;
  }

  private promptEquivalentPrefixLength(
    expected: string,
    observed: string,
  ): number {
    const length = Math.min(expected.length, observed.length);

    let index = 0;
    while (
      index < length
      && this.promptCodeUnitEquivalent(expected, observed, index)
    ) {
      index += 1;
    }

    return index;
  }

  run(turn: BrowserTurn): Promise<string> {
    if (this.activeRuns.has(turn.traceId)) {
      return Promise.reject(new Error(`Duplicate ChatGPT web browser turn: ${turn.traceId}`));
    }
    if (this.activeRuns.size >= MAX_CHATGPT_BROWSER_TABS) {
      return Promise.reject(new Error(
        `ChatGPT Web supports at most ${MAX_CHATGPT_BROWSER_TABS} simultaneous browser turns; close or finish a browser tab before starting another`,
      ));
    }
    const useHelper = this.config.browserHost === "launcher" && process.env.CODEX_CHATGPT_WEB_BROWSER_HELPER_PROCESS !== "1";
    if (useHelper) {
      this.launcherHelper ??= new LauncherBrowserHelperClient(this.config);
    }
    const run = Promise.resolve().then(() => useHelper ? this.launcherHelper!.run(turn) : this.runExclusive(turn));
    this.activeRuns.set(turn.traceId, run);
    void run.finally(() => {
      if (this.activeRuns.get(turn.traceId) === run) this.activeRuns.delete(turn.traceId);
    }).catch(() => {});
    return run;
  }

  verifyConnector(): Promise<{ appName: string; pluginId: string }> {
    return this.enqueueMaintenance("connector verification", () => this.verifyConnectorExclusive());
  }

  inspectSession(detectCapabilities: boolean): Promise<{
    authenticated: true;
    temporary: true;
    url: string;
    solAvailable?: boolean;
    proAvailable?: boolean;
  }> {
    return this.enqueueMaintenance("session inspection", () => this.inspectSessionExclusive(detectCapabilities));
  }

  smokeTest(abortSignal?: AbortSignal): Promise<{ effort: string; response: string }> {
    return this.enqueueMaintenance("smoke test", () => this.smokeTestExclusive(abortSignal));
  }

  prewarmMode(
    surfaceId: string,
    modelId: string,
    reasoning?: string,
    abortSignal?: AbortSignal,
    connectorIdentity?: string,
  ): Promise<{ modelId: string; reasoning: string | null; effort: string; connectorBound: boolean }> {
    return this.enqueueMaintenance(
      "mode prewarm",
      () => this.prewarmModeExclusive(surfaceId, modelId, reasoning, abortSignal, connectorIdentity),
    );
  }

  private enqueueMaintenance<T>(name: string, action: () => Promise<T>): Promise<T> {
    const operation = this.maintenanceTail.then(() => {
      if (this.activeRuns.size > 0) {
        throw new Error(`ChatGPT ${name} requires all browser turns to finish`);
      }
      return action();
    });
    this.maintenanceTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async close(): Promise<void> {
    if (this.launcherHelper) {
      const helper = this.launcherHelper;
      this.launcherHelper = undefined;
      await helper.close();
    }
    await Promise.allSettled([...this.activeRuns.values()]);
    await this.maintenanceTail;
    const browser = this.browser;
    this.browser = undefined;
    this.context = undefined;
    this.page = undefined;
    this.managedBrowserReady = undefined;
    // For connectOverCDP, Playwright implements Browser.close as a transport disconnect; it does
    // not close the launcher-owned Electron process. Always release that connection and its
    // artifact directory instead of leaking one per timeout/helper lifecycle.
    if (browser) await browser.close();
  }

  private async runStage<T>(
    traceId: string,
    stage: string,
    timeoutMs: number,
    action: (abortSignal: AbortSignal) => Promise<T>,
    suspensionClock: Pick<ChatGptSuspensionClock, "suspendedMs"> = chatGptSuspensionClock,
    awaitAbortedActionSettlement = false,
  ): Promise<T> {
    chatGptSuspensionClock.start();
    const startedAt = performance.now();
    const suspendedAtStart = suspensionClock.suspendedMs();
    console.info(`[chatgpt-web] browser turn ${traceId} stage=${stage} started`);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stageTimedOut = false;
    let actionPromise: Promise<T> | undefined;
    try {
      const timeout = new Promise<never>((_, rejectTimeout) => {
        const fireOrRearm = () => {
          // A stage that spans a system sleep has not consumed its budget: the browser was as
          // frozen as this process, so slept time is refunded and the timer re-armed for what the
          // stage is still owed. Observed live as effort_selection "timing out" at 901s of a 120s
          // budget, to the second of a DarkWake.
          const suspendedMs = suspensionClock.suspendedMs() - suspendedAtStart;
          const remaining = remainingStageBudgetMs(timeoutMs, performance.now() - startedAt, suspendedMs);
          if (remaining > 0) {
            timer = setTimeout(fireOrRearm, remaining);
            return;
          }
          stageTimedOut = true;
          controller.abort();
          rejectTimeout(new Error(`ChatGPT browser stage timed out: ${stage}`));
        };
        timer = setTimeout(fireOrRearm, timeoutMs);
      });
      actionPromise = action(controller.signal);
      const value = await Promise.race([actionPromise, timeout]);
      console.info(`[chatgpt-web] browser turn ${traceId} stage=${stage} completed durationMs=${Math.round(performance.now() - startedAt)}`);
      return value;
    } catch (error) {
      let surfacedError = error;
      if (stageTimedOut && awaitAbortedActionSettlement && actionPromise) {
        try {
          await actionPromise;
        } catch (settlementError) {
          if (settlementError instanceof ChatGptPersistentBrowserStateError) {
            surfacedError = settlementError;
          }
        }
      }
      console.error(`[chatgpt-web] browser turn ${traceId} stage=${stage} failed durationMs=${Math.round(performance.now() - startedAt)}: ${surfacedError instanceof Error ? surfacedError.message : String(surfacedError)}`);
      throw surfacedError;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async ensurePage(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;
    if (this.config.browserHost === "launcher") {
      const connection = await connectLauncherBrowserHost(this.config.browserHostDescriptorPath!);
      this.browser = connection.browser;
      this.context = connection.context;
      this.page = connection.page;
      return this.page;
    }
    if (!existsSync(this.config.storageStatePath) || !existsSync(loginVerificationMarkerPath(this.config.storageStatePath))) {
      throw new Error(`ChatGPT web login state is missing: ${this.config.storageStatePath}`);
    }
    if (!existsSync(this.config.chromeExecutablePath)) {
      throw new Error(`Configured Chrome executable does not exist: ${this.config.chromeExecutablePath}`);
    }
    this.browser = await chromium.launch({
      executablePath: this.config.chromeExecutablePath,
      headless: !this.config.headed,
    });
    this.context = await this.browser.newContext({ storageState: this.config.storageStatePath });
    this.page = await this.context.newPage();
    return this.page;
  }

  private async ensureManagedBrowser(): Promise<{ browser: Browser; context: BrowserContext }> {
    if (this.managedBrowserReady) return this.managedBrowserReady;
    const opening = (async () => {
      if (!existsSync(this.config.storageStatePath) || !existsSync(loginVerificationMarkerPath(this.config.storageStatePath))) {
        throw new Error(`ChatGPT web login state is missing: ${this.config.storageStatePath}`);
      }
      if (!existsSync(this.config.chromeExecutablePath)) {
        throw new Error(`Configured Chrome executable does not exist: ${this.config.chromeExecutablePath}`);
      }
      const browser = await chromium.launch({
        executablePath: this.config.chromeExecutablePath,
        headless: !this.config.headed,
      });
      const context = await browser.newContext({ storageState: this.config.storageStatePath });
      this.browser = browser;
      this.context = context;
      return { browser, context };
    })();
    this.managedBrowserReady = opening;
    try {
      return await opening;
    } catch (error) {
      if (this.managedBrowserReady === opening) this.managedBrowserReady = undefined;
      throw error;
    }
  }

  /**
   * A Codex turn owns one isolated Temporary Chat document. Reusing the same
   * ChatGPT SPA page can retain the previous transcript and autocomplete DOM,
   * so an @app lookup may select stale UI from the preceding turn.
   */
  private async pageForNewTurn(): Promise<Page> {
    if (this.config.browserHost === "launcher") {
      throw new Error("Launcher turns require an explicitly leased browser surface");
    }
    const { context } = await this.ensureManagedBrowser();
    return await context.newPage();
  }

  private async selectModelAndEffort(
    page: Page,
    modelId: string,
    reasoning: string | undefined,
    capabilities: ChatGptWebCapabilities,
    captureDiagnostic?: (checkpoint: string) => Promise<void>,
  ): Promise<ChatGptWebModelMode> {
    const mode = resolveChatGptWebModelMode(modelId, reasoning, capabilities);
    const composer = await this.activeComposer(page);
    const composerForm = composer.locator("xpath=ancestor::form[1]");
    const uiEffortIndex = mode.uiEffortIndex;
    if (uiEffortIndex === null) {
      await settleChatGptUi();
      await throwIfChatGptRateLimitDialog(page);
      const visibleControls = composerForm.locator(CHATGPT_EFFORT_CONTROL_SELECTOR).filter({ visible: true });
      if (await visibleControls.count() > 0) {
        throw new Error(
          "ChatGPT Luna was selected from a Luna-only capability probe, but the account now exposes a model selector; rerun setup",
        );
      }
      await setChatGptThinkMode(composerForm, mode.thinkEnabled, captureDiagnostic);
      return mode;
    }
    const currentEffort = composerForm.locator(CHATGPT_EFFORT_CONTROL_SELECTOR).last();
    const effortWaitAbort = new AbortController();
    try {
      const ready = await Promise.race([
        currentEffort.waitFor({ state: "visible", timeout: 70_000, signal: effortWaitAbort.signal }).then(() => "effort" as const),
        chatGptExpiredSessionAlert(page).waitFor({ state: "visible", timeout: 70_000, signal: effortWaitAbort.signal }).then(() => "session-expired" as const),
      ]);
      if (ready === "session-expired") await throwIfChatGptSessionFailureAlert(page);
    } catch (error) {
      if (error instanceof ChatGptWebAdapterError) throw error;
      await throwIfChatGptSessionFailureAlert(page);
      throw new Error("ChatGPT rendered the composer but its model/effort control did not become ready");
    } finally {
      effortWaitAbort.abort();
    }
    await settleChatGptUi();
    await throwIfChatGptRateLimitDialog(page);
    await captureDiagnostic?.("effort-control-ready");
    const effortMenu = await chatGptEffortMenuForControl(page, currentEffort);
    const menuVisible = await chatGptEffortSurfaceIsOpen(currentEffort)
      && await effortMenu.isVisible().catch(() => false);
    const menuExpanded = await currentEffort.getAttribute("aria-expanded").catch(() => null);
    if (!menuVisible && menuExpanded !== "true") {
      await throwIfChatGptRateLimitDialog(page);
      // ChatGPT's current Radix trigger no longer responds to synthetic Enter/Space on background
      // Electron surfaces. Force only the exact, visible effort control; the menu/slider state
      // below remains the authoritative postcondition, so this cannot become an unproved click.
      await currentEffort.click({ force: true });
    }
    await captureDiagnostic?.("effort-menu-open-requested");
    const effortChoices = effortMenu.locator(CHATGPT_EFFORT_ITEM_SELECTOR);
    const effortChoice = effortChoices.nth(uiEffortIndex);
    const ownedEffortSliders = effortMenu.locator(CHATGPT_EFFORT_SLIDER_SELECTOR);
    const effortSlider = await ownedEffortSliders.count().catch(() => 0) === 1
      ? ownedEffortSliders
      : page.locator(CHATGPT_EFFORT_SLIDER_SELECTOR).filter({ visible: true }).last();
    const waitAbort = new AbortController();
    let ready: "effort" | "slider" | "rate-limit" | "session-expired";
    try {
      ready = await Promise.race([
        effortChoice.waitFor({ state: "visible", timeout: 70_000, signal: waitAbort.signal }).then(() => "effort" as const),
        effortSlider.waitFor({ state: "visible", timeout: 70_000, signal: waitAbort.signal }).then(() => "slider" as const),
        chatGptRateLimitDialog(page).waitFor({ state: "visible", timeout: 70_000, signal: waitAbort.signal }).then(() => "rate-limit" as const),
        chatGptExpiredSessionAlert(page).waitFor({ state: "visible", timeout: 70_000, signal: waitAbort.signal }).then(() => "session-expired" as const),
      ]);
      if (ready === "rate-limit") await throwIfChatGptRateLimitDialog(page);
      if (ready === "session-expired") await throwIfChatGptSessionFailureAlert(page);
      // The current picker exposes model rows as menuitemradio alongside the effort slider.
      // Those rows can win the locator race even though they are not effort choices.
      if (ready !== "slider" && await effortSlider.isVisible().catch(() => false)) ready = "slider";
      await captureDiagnostic?.(ready === "slider" ? "effort-slider-visible" : "effort-choice-visible");
    } catch (error) {
      if (error instanceof ChatGptWebAdapterError) throw error;
      await throwIfChatGptRateLimitDialog(page);
      await throwIfChatGptSessionFailureAlert(page);
      throw new ChatGptWebAdapterError(
        `ChatGPT effort menu did not expose item index ${uiEffortIndex}`
        + `; item count: ${await effortChoices.count().catch(() => 0)}`,
        { status: 502, errorType: "server_error", code: "upstream_server_error", retryable: false },
      );
    } finally {
      waitAbort.abort();
    }
    if (ready === "slider") {
      let sliderState = parseChatGptEffortSliderState(
        await effortSlider.getAttribute("aria-valuemin"),
        await effortSlider.getAttribute("aria-valuemax"),
        await effortSlider.getAttribute("aria-valuenow"),
      );
      if (!sliderState) {
        throw new ChatGptWebAdapterError(
          "ChatGPT effort slider exposed an invalid ARIA range",
          { status: 502, errorType: "server_error", code: "upstream_server_error", retryable: false },
        );
      }
      const targetValue = sliderState.min + uiEffortIndex;
      if (targetValue > sliderState.max) {
        throw new ChatGptWebAdapterError(
          `ChatGPT effort slider does not expose item index ${uiEffortIndex}`
          + ` (min=${sliderState.min}; max=${sliderState.max})`,
          { status: 502, errorType: "server_error", code: "upstream_server_error", retryable: false },
        );
      }
      const sliderControl = effortSlider.locator("xpath=ancestor::*[@role='menuitem'][1]");
      while (sliderState.value !== targetValue) {
        await throwIfChatGptRateLimitDialog(page);
        const direction = targetValue > sliderState.value ? 1 : -1;
        const key = direction > 0 ? "ArrowRight" : "ArrowLeft";
        const previousValue = sliderState.value;
        await sliderControl.press(key);
        const changeDeadline = Date.now() + 5_000;
        do {
          sliderState = parseChatGptEffortSliderState(
            await effortSlider.getAttribute("aria-valuemin"),
            await effortSlider.getAttribute("aria-valuemax"),
            await effortSlider.getAttribute("aria-valuenow"),
          );
          if (!sliderState) throw new Error("ChatGPT effort slider lost its semantic ARIA state");
          if (sliderState.value !== previousValue) break;
          await new Promise(resolveSleep => setTimeout(resolveSleep, 50));
        } while (Date.now() < changeDeadline);
        if (sliderState.value !== previousValue + direction) {
          throw new Error(
            `ChatGPT effort slider did not move exactly one step with ${key}`
            + ` (before=${previousValue}; after=${sliderState.value})`,
          );
        }
      }
      await captureDiagnostic?.("effort-selected");
      await page.keyboard.press("Escape");
      return mode;
    }
    const selected = await effortChoice.getAttribute("aria-checked");
    if (selected !== "true" && selected !== "false") {
      throw new Error(`ChatGPT effort item index ${uiEffortIndex} has no semantic checked state`);
    }
    if (selected === "true") {
      await captureDiagnostic?.("effort-selected");
      await page.keyboard.press("Escape");
      return mode;
    }
    await throwIfChatGptRateLimitDialog(page);
    await effortChoice.press("Enter");
    await captureDiagnostic?.("effort-choice-activated");

    const deadline = Date.now() + 40_000;
    let confirmed: string | null = null;
    while (Date.now() < deadline) {
      if (!await effortMenu.isVisible().catch(() => false)) {
        const expanded = await currentEffort.getAttribute("aria-expanded").catch(() => null);
        if (expanded !== "true") {
          await throwIfChatGptRateLimitDialog(page);
          await currentEffort.click({ force: true });
        }
        await effortChoice.waitFor({
          state: "visible",
          timeout: Math.max(1, Math.min(5_000, deadline - Date.now())),
        });
      }
      confirmed = await effortChoice.getAttribute("aria-checked");
      if (confirmed === "true") {
        await captureDiagnostic?.("effort-selected");
        await page.keyboard.press("Escape");
        return mode;
      }
      if (confirmed !== "false") {
        throw new Error(`ChatGPT effort item index ${uiEffortIndex} lost its semantic checked state`);
      }
      await new Promise(resolveSleep => setTimeout(resolveSleep, 100));
    }
    throw new Error(
      `ChatGPT did not confirm effort item index ${uiEffortIndex}`
      + ` (aria-checked=${JSON.stringify(confirmed)})`,
    );
  }

  private async activeComposer(
    page: Page,
    timeoutMs = 30_000,
    abortSignal?: AbortSignal,
  ): Promise<Locator> {
    const composers = page.locator(CHATGPT_COMPOSER_SELECTOR).filter({ visible: true });
    const deadline = Date.now() + timeoutMs;
    let count = 0;
    while (Date.now() < deadline) {
      throwIfPromptAttachmentAborted(abortSignal);
      count = await withBrowserTurnAbort(
        withChatGptBrowserObservationTimeout(
          composers.count(),
          Math.max(1, Math.min(CHATGPT_BROWSER_OBSERVATION_PROBE_TIMEOUT_MS, deadline - Date.now())),
        ),
        abortSignal,
      );
      if (count === 1) return composers;
      await withBrowserTurnAbort(
        new Promise(resolveSleep => setTimeout(resolveSleep, 50)),
        abortSignal,
      );
    }
    throw new Error(`ChatGPT did not expose exactly one visible composer (visibleComposers=${count})`);
  }

  /** Put every browser operation on one fully hydrated Temporary Chat document. */
  private async prepareTemporaryChatSurface(
    page: Page,
    captureDiagnostic?: (checkpoint: string) => Promise<void>,
  ): Promise<Locator> {
    // Launcher verification refreshes its owned page before attaching Playwright so a newly added
    // connector is present in the catalog. Navigating again here destroys that freshly hydrated
    // document and made the first verification race a second SPA bootstrap. A leased turn starts on
    // about:blank and therefore still performs exactly one navigation through this same method.
    if (page.url() !== CHATGPT_TEMPORARY_CHAT_URL) {
      await page.goto(CHATGPT_TEMPORARY_CHAT_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await captureDiagnostic?.("temporary-chat-navigation-complete");
    }
    let composer: Locator;
    try {
      composer = await this.activeComposer(page);
    } catch {
      throw new Error("ChatGPT web login is expired or the Temporary Chat surface is unavailable");
    }
    if (await dismissChatGptTemporaryChatOnboarding(page)) {
      await captureDiagnostic?.("temporary-chat-onboarding-dismissed");
    }
    await captureDiagnostic?.("composer-ready");
    await throwIfChatGptSessionFailureAlert(page);
    await assertAuthenticatedChatGptPage(page);
    await assertTemporaryChatPage(page);
    await captureDiagnostic?.("session-verified");
    return composer;
  }

  private async waitForTurnDomMutation(page: Page, timeoutMs = 50): Promise<void> {
    await page.evaluate(({ timeout, attributeFilter }) => new Promise<void>(resolveMutation => {
      let settled = false;
      let settleTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (settled) return;
        settled = true;
        observer.disconnect();
        clearTimeout(timeoutTimer);
        if (settleTimer) clearTimeout(settleTimer);
        resolveMutation();
      };
      const observer = new MutationObserver(() => {
        if (settleTimer) return;
        // Let one React mutation batch finish before the next compact state read.
        settleTimer = setTimeout(finish, 16);
      });
      observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter,
      });
      const timeoutTimer = setTimeout(finish, timeout);
    }), { timeout: timeoutMs, attributeFilter: [...CHATGPT_DOM_REVISION_ATTRIBUTES] });
  }

  private async waitForTurnDomOrExternalProgress(
    page: Page,
    afterProgressRevision: number,
    externalProgress?: ChatGptTurnProgressReader,
    signal?: AbortSignal,
  ): Promise<void> {
    const domMutation = this.waitForTurnDomMutation(page);
    if (!externalProgress) {
      await withBrowserTurnAbort(domMutation, signal);
      return;
    }
    const progressWaitAbort = new AbortController();
    const progressSignal = signal
      ? AbortSignal.any([progressWaitAbort.signal, signal])
      : progressWaitAbort.signal;
    try {
      await withBrowserTurnAbort(Promise.race([
        domMutation,
        externalProgress.waitForChange(afterProgressRevision, progressSignal).then(() => undefined),
      ]), signal);
    } finally {
      progressWaitAbort.abort();
    }
  }

  /**
   * Wake the steady-state response loop for either a DOM mutation or daemon-recorded MCP progress.
   *
   * A tool request can be accepted by ChatGPT without changing the rendered assistant subtree. If
   * the worker waits only on MutationObserver in that state, the daemon waits for the causal
   * tool-boundary acknowledgement while this helper sleeps waiting for a DOM mutation that cannot
   * happen until Codex executes the tool. Racing the mirrored progress revision breaks that cycle;
   * the next loop iteration still has to read the DOM and capture the pre-tool answer boundary
   * before it acknowledges the batch.
   */
  private async waitForResponseDomOrExternalProgress(
    responseTurn: Locator,
    knownKey: string | undefined,
    cache: ChatGptResponseDomCache,
    afterProgressRevision: number,
    externalProgress?: ChatGptTurnProgressReader,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!externalProgress) {
      await this.waitForResponseDomMutation(responseTurn, knownKey, cache, signal);
      return;
    }
    const waitAbort = new AbortController();
    const waitSignal = signal
      ? AbortSignal.any([waitAbort.signal, signal])
      : waitAbort.signal;
    try {
      await withBrowserTurnAbort(Promise.race([
        this.waitForResponseDomMutation(responseTurn, knownKey, cache, waitSignal),
        externalProgress.waitForChange(afterProgressRevision, waitSignal).then(() => undefined),
      ]), signal);
    } finally {
      waitAbort.abort();
    }
  }

  private async waitForSubmissionAccepted(
    page: Page,
    baseline: ChatGptSubmissionBaseline,
    signal?: AbortSignal,
    externalProgress?: ChatGptTurnProgressReader,
    initialToolBatchRevision = externalProgress?.snapshot().lastToolBatchRevision ?? 0,
    completionTracker?: ChatGptCompletionTracker,
  ): Promise<ChatGptSubmissionEvidence> {
    if (signal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
    for (;;) {
      if (signal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
      const progress = externalProgress?.snapshot();
      if (progress
        && externalProgress
        && completionTracker?.needsToolBatchObservation(progress.lastToolBatchRevision)) {
        const boundaryText = await this.currentSubmissionAnswerText(page, baseline, signal);
        completionTracker.observeToolBatch(progress.lastToolBatchRevision, boundaryText);
        await externalProgress.acknowledgeToolBatch(progress.lastToolBatchRevision);
      }
      if (progress && progress.lastToolBatchRevision > initialToolBatchRevision) return "mcp_tool_call";
      await throwIfChatGptSessionFailureAlert(page);
      await throwIfChatGptTerminalErrorAlert(baseline.responseTurns.last());
      let evidence: ChatGptSubmissionEvidence | undefined;
      if (externalProgress) {
        const progressWaitAbort = new AbortController();
        const progressSignal = signal
          ? AbortSignal.any([progressWaitAbort.signal, signal])
          : progressWaitAbort.signal;
        try {
          const observed = await withBrowserTurnAbort(Promise.race([
            this.currentSubmissionEvidence(page, baseline, signal).then(value => ({ kind: "dom" as const, value })),
            externalProgress.waitForChange(progress?.revision ?? 0, progressSignal)
              .then(() => ({ kind: "external" as const })),
          ]), signal);
          if (observed.kind === "external") continue;
          evidence = observed.value;
        } finally {
          progressWaitAbort.abort();
        }
      } else {
        evidence = await this.currentSubmissionEvidence(page, baseline, signal);
      }
      if (evidence) return evidence;
      await this.waitForTurnDomOrExternalProgress(
        page,
        progress?.revision ?? 0,
        externalProgress,
        signal,
      );
    }
  }

  private async submissionDomState(
    page: Page,
    cache?: ChatGptSubmissionDomCache,
    signal?: AbortSignal,
  ): Promise<ChatGptSubmissionDomState> {
    throwIfPromptAttachmentAborted(signal);
    const observed = await withChatGptBrowserObservationTimeout(withBrowserTurnAbort(page.evaluate(options => {
      type ObserverState = { id: string; revision: number; observer: MutationObserver };
      const scope = globalThis as typeof globalThis & {
        __CODEX_WEB_GPT_TURN_OBSERVER__?: ObserverState;
      };
      const observerState = scope.__CODEX_WEB_GPT_TURN_OBSERVER__ ??= (() => {
        const state: ObserverState = {
          id: `${performance.timeOrigin}:${Math.random().toString(36).slice(2)}`,
          revision: 0,
          observer: undefined as unknown as MutationObserver,
        };
        state.observer = new MutationObserver(() => {
          state.revision += 1;
        });
        state.observer.observe(document.documentElement, {
          subtree: true,
          childList: true,
          characterData: true,
          attributes: true,
          attributeFilter: options.attributeFilter,
        });
        return state;
      })();
      const observerKey = `${observerState.id}:${observerState.revision}`;
      if (options.knownKey === observerKey) return { key: observerKey };
      const identities = (elements: Element[], attribute: string): string[] => {
        const values = elements.map(element => element.getAttribute(attribute));
        if (values.some(value => typeof value !== "string" || value.trim().length === 0)) {
          throw new Error(`ChatGPT conversation turn has no stable ${attribute} identity`);
        }
        // React may briefly keep two renderer nodes for one logical conversation turn while it
        // remounts/virtualizes the transcript. Ownership is the stable turn id, not DOM-node
        // cardinality, so collapse renderer clones before comparing the semantic transcript.
        return [...new Set(values as string[])];
      };
      const visible = (element: Element): boolean => {
        const candidate = element as HTMLElement;
        const style = getComputedStyle(candidate);
        const bounds = candidate.getBoundingClientRect();
        return candidate.isConnected
          && style.visibility !== "hidden"
          && (bounds.width > 0 || bounds.height > 0);
      };
      // data-testid is a display index and may be renumbered by React/virtualization. The outer
      // data-turn-id-container survives that remount, so logical turn ids are the ownership authority.
      const containers = [...document.querySelectorAll("[data-turn-id-container]")].filter(element =>
        element.parentElement?.closest("[data-turn-id-container]")?.getAttribute("data-turn-id-container")
          !== element.getAttribute("data-turn-id-container"));
      const turnIdentities = identities(containers, "data-turn-id-container");
      const userIdentities = identities([...document.querySelectorAll(options.userTurnSelector)], "data-turn-id");
      const responseIdentities = identities([...document.querySelectorAll(options.assistantTurnSelector)], "data-turn-id");
      const knownTurns = new Set(turnIdentities);
      if ([...userIdentities, ...responseIdentities].some(identity => !knownTurns.has(identity))) {
        throw new Error("ChatGPT conversation turn has no matching identity container");
      }
      return {
        key: observerKey,
        snapshot: {
          documentId: observerState.id,
          userTurnCount: userIdentities.length,
          assistantTurnCount: responseIdentities.length,
          visibleStopButtonCount: [...document.querySelectorAll(options.stopButtonSelector)].filter(visible).length,
          turnIdentities,
          userIdentities,
          responseIdentities,
        },
      };
    }, {
      userTurnSelector: CHATGPT_USER_TURN_SELECTOR,
      assistantTurnSelector: CHATGPT_ASSISTANT_TURN_SELECTOR,
      stopButtonSelector: CHATGPT_STOP_BUTTON_SELECTOR,
      knownKey: cache?.key,
      attributeFilter: [...CHATGPT_DOM_REVISION_ATTRIBUTES],
    }), signal));
    const snapshot = observed.snapshot ?? cache?.snapshot;
    if (!snapshot) throw new Error("ChatGPT turn DOM revision cache has no baseline snapshot");
    if (observed.snapshot && cache) {
      cache.key = observed.key;
      cache.snapshot = observed.snapshot;
      cache.fullScans = (cache.fullScans ?? 0) + 1;
    } else if (!observed.snapshot && cache?.snapshot) {
      cache.cacheHits = (cache.cacheHits ?? 0) + 1;
    }
    return snapshot;
  }

  private async currentSubmissionEvidence(
    page: Page,
    baseline: ChatGptSubmissionBaseline,
    signal?: AbortSignal,
  ): Promise<ChatGptSubmissionEvidence | undefined> {
    const state = await this.submissionDomState(page, baseline.domCache, signal);
    if (chatGptNewTurnIdentity(baseline.initialTurnIdentities, state.userIdentities)) return "user_turn";
    if (chatGptNewTurnIdentity(baseline.initialTurnIdentities, state.responseIdentities)) return "assistant_turn";
    return chatGptSubmissionEvidence({
      initialUserTurnCount: baseline.initialUserTurnCount,
      userTurnCount: state.userTurnCount,
      initialAssistantTurnCount: baseline.initialResponseTurnCount,
      assistantTurnCount: state.assistantTurnCount,
      generationRunning: state.visibleStopButtonCount > 0,
    });
  }

  private async currentSubmissionAnswerText(
    page: Page,
    baseline: ChatGptSubmissionBaseline,
    signal?: AbortSignal,
  ): Promise<string> {
    const state = await this.submissionDomState(page, baseline.domCache, signal);
    const identity = chatGptNewTurnIdentity(
      baseline.initialTurnIdentities,
      state.responseIdentities,
    );
    if (!identity) return "";
    const locator = page.locator(`[data-turn-id=${JSON.stringify(identity)}]`);
    return (await this.responseDomSnapshot(locator, {})).visibleText;
  }

  private async recoveryProofDomShape(binding: ChatGptAssistantTurnBinding): Promise<{
    urlKind: "temporary-root" | "conversation-path" | "other";
    assistantSubtreeCandidateAttributes: Record<string, number>;
    ancestorCandidateAttributes: Record<string, number>;
    documentCandidateAttributes: Record<string, number>;
    assistantMessageIdShape: { count: number; distinctCount: number; allUuidLike: boolean };
    assistantTurnIdShape: { count: number; distinctCount: number; allUuidLike: boolean };
    messageIdEqualsTurnId: boolean;
  }> {
    return withChatGptBrowserObservationTimeout(binding.locator.evaluate(element => {
      const isCandidateAttribute = (name: string): boolean => /conversation|thread|message|turn/i.test(name);
      const counts = (elements: Element[]): Record<string, number> => {
        const result: Record<string, number> = {};
        for (const candidate of elements) {
          for (const attribute of [...candidate.attributes]) {
            if (!isCandidateAttribute(attribute.name)) continue;
            result[attribute.name] = Math.min(255, (result[attribute.name] ?? 0) + 1);
          }
        }
        return Object.fromEntries(Object.entries(result)
          .sort(([left], [right]) => left.localeCompare(right))
          .slice(0, 32));
      };

      const subtree = [element, ...element.querySelectorAll("*")];
      const idShape = (attributeName: string): {
        values: string[];
        public: { count: number; distinctCount: number; allUuidLike: boolean };
      } => {
        const values = subtree
          .map(candidate => candidate.getAttribute(attributeName))
          .filter((value): value is string => typeof value === "string" && value.length > 0);
        const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
        return {
          values,
          public: {
            count: values.length,
            distinctCount: new Set(values).size,
            allUuidLike: values.length > 0 && values.every(value => uuid.test(value)),
          },
        };
      };
      const messageIds = idShape("data-message-id");
      const turnIds = idShape("data-turn-id");
      const ancestors: Element[] = [];
      let parent = element.parentElement;
      while (parent && ancestors.length < 8) {
        ancestors.push(parent);
        parent = parent.parentElement;
      }
      const pathname = globalThis.location.pathname;
      const urlKind = pathname === "/"
        ? "temporary-root"
        : /^\/c\/[^/]+\/?$/.test(pathname)
          ? "conversation-path"
          : "other";
      return {
        urlKind,
        assistantSubtreeCandidateAttributes: counts(subtree),
        ancestorCandidateAttributes: counts(ancestors),
        documentCandidateAttributes: counts([...document.querySelectorAll("*")]),
        assistantMessageIdShape: messageIds.public,
        assistantTurnIdShape: turnIds.public,
        messageIdEqualsTurnId: messageIds.values.length === 1
          && turnIds.values.length === 1
          && messageIds.values[0] === turnIds.values[0],
      };
    }));
  }

  private async assertRequestInjectionFallbackSafe(
    page: Page,
    baseline: ChatGptSubmissionBaseline,
    signal?: AbortSignal,
  ): Promise<void> {
    const initialTurns = new Set(baseline.initialTurnIdentities);
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
      const state = await this.submissionDomState(page, {}, signal);
      const newUser = state.userIdentities.some(identity => !initialTurns.has(identity));
      const newResponse = state.responseIdentities.some(identity => !initialTurns.has(identity));
      const baselineRestored = !newUser
        && !newResponse
        && state.userTurnCount === baseline.initialUserTurnCount
        && state.assistantTurnCount === baseline.initialResponseTurnCount
        && state.visibleStopButtonCount === 0;
      if (baselineRestored) return;
      await this.waitForTurnDomMutation(page, 50);
    }
    throw new ChatGptPersistentBrowserStateError(
      [new Error("blocked request left optimistic submission DOM behind")],
      "ChatGPT request injection fallback could not prove that the blocked placeholder submission was rolled back",
    );
  }

  private async captureSubmissionBaseline(page: Page): Promise<ChatGptSubmissionBaseline> {
    const userTurns = page.locator(CHATGPT_USER_TURN_SELECTOR);
    const responseTurns = page.locator(CHATGPT_ASSISTANT_TURN_SELECTOR);
    const domCache: ChatGptSubmissionDomCache = {};
    const state = await this.submissionDomState(page, domCache);
    return {
      userTurns,
      responseTurns,
      initialUserTurnCount: state.userTurnCount,
      initialResponseTurnCount: state.assistantTurnCount,
      initialTurnIdentities: state.turnIdentities,
      initialUserTurnIdentities: state.userIdentities,
      initialResponseTurnIdentities: state.responseIdentities,
      domCache,
    };
  }

  private async waitForNewAssistantTurn(
    page: Page,
    baseline: ChatGptSubmissionBaseline,
    deadline: number | undefined,
    signal?: AbortSignal,
    externalProgress?: ChatGptTurnProgressReader,
    graceMs: number = CHATGPT_RESPONSE_DOM_GRACE_MS,
    completionTracker?: ChatGptCompletionTracker,
  ): Promise<ChatGptAssistantTurnBinding> {
    let responseDeadline = Math.min(
      deadline ?? Number.POSITIVE_INFINITY,
      Date.now() + graceMs,
    );
    for (;;) {
      if (signal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
      if (page.isClosed()) throw chatGptBrowserTabClosedError();
      const progress = externalProgress?.snapshot();
      if (progress?.lastProgressAt !== undefined) {
        responseDeadline = Math.min(
          deadline ?? Number.POSITIVE_INFINITY,
          Math.max(responseDeadline, progress.lastProgressAt + graceMs),
        );
      }
      if (deadline !== undefined && Date.now() >= deadline) {
        throw new Error("ChatGPT web turn timed out");
      }
      if (Date.now() >= responseDeadline
        && !chatGptExternalProgressSuppressesDomHealth(progress, Date.now())) {
        throw new Error("ChatGPT accepted the message but did not expose its assistant turn in the DOM");
      }
      await throwIfChatGptSessionFailureAlert(page);
      await throwIfChatGptRateLimitDialog(page);
      let state: ChatGptSubmissionDomState;
      try {
        state = await this.submissionDomState(page, baseline.domCache, signal);
      } catch (error) {
        if (!chatGptExternalProgressIsLive(progress, Date.now(), graceMs)) throw error;
        await this.waitForTurnDomOrExternalProgress(
          page,
          progress?.revision ?? 0,
          externalProgress,
          signal,
        );
        continue;
      }
      const identity = chatGptNewTurnIdentity(
        baseline.initialTurnIdentities,
        state.responseIdentities,
      );
      if (progress
        && externalProgress
        && completionTracker?.needsToolBatchObservation(progress.lastToolBatchRevision)) {
        const boundaryText = identity
          ? (await this.responseDomSnapshot(
            page.locator(`[data-turn-id=${JSON.stringify(identity)}]`),
            {},
          )).visibleText
          : "";
        completionTracker.observeToolBatch(progress.lastToolBatchRevision, boundaryText);
        await externalProgress.acknowledgeToolBatch(progress.lastToolBatchRevision);
      }
      if (identity) return {
        identity,
        documentId: state.documentId,
        locator: page.locator(`[data-turn-id=${JSON.stringify(identity)}]`),
        acceptedTurnIdentities: state.turnIdentities,
        acceptedUserTurnIdentities: state.userIdentities,
      };
      await this.waitForTurnDomOrExternalProgress(
        page,
        progress?.revision ?? 0,
        externalProgress,
        signal,
      );
    }
  }

  private async reconcileAssistantTurnBinding(
    page: Page,
    baseline: ChatGptSubmissionBaseline,
    binding: ChatGptAssistantTurnBinding,
    signal?: AbortSignal,
  ): Promise<ChatGptAssistantTurnBinding> {
    const state = await this.submissionDomState(page, baseline.domCache, signal);
    const acceptedTurns = new Set(binding.acceptedTurnIdentities);
    if (state.userIdentities.some(identity => !acceptedTurns.has(identity))) {
      throw new Error("ChatGPT opened another user turn while proving the committed response document");
    }
    const identity = chatGptSameDocumentTurnIdentity(
      binding.documentId,
      state.documentId,
      binding.acceptedUserTurnIdentities,
      state.userIdentities,
      baseline.initialTurnIdentities,
      binding.identity,
      state.responseIdentities,
    );
    const boundCount = await withChatGptBrowserObservationTimeout(
      withBrowserTurnAbort(binding.locator.count(), signal),
    );
    if (boundCount === 1 && identity === binding.identity) return binding;
    if (boundCount > 1) {
      throw new Error(`ChatGPT exposed ${boundCount} DOM nodes for the bound assistant turn`);
    }
    if (identity === binding.identity) return binding;
    return {
      identity,
      documentId: state.documentId,
      locator: page.locator(`[data-turn-id=${JSON.stringify(identity)}]`),
      acceptedTurnIdentities: state.turnIdentities,
      acceptedUserTurnIdentities: state.userIdentities,
    };
  }

  private async attachedPromptText(
    page: Page,
    abortSignal?: AbortSignal,
    resolvedComposer?: Locator,
  ): Promise<string> {
    const composer = resolvedComposer ?? await this.activeComposer(page, 30_000, abortSignal);
    return composer.evaluate(element => {
      const clone = element.cloneNode(true) as HTMLElement;
      clone.querySelectorAll(
        '[data-id^="plugin:"][data-keyword], [data-inline-selection-pill-cursor-target]',
      )
        .forEach(part => part.remove());
      return [...clone.childNodes]
        .map(child => child.textContent ?? "")
        .join("\n")
        .trimStart();
    }, undefined, { timeout: 20_000, signal: abortSignal });
  }

  private async assertPromptAttached(
    page: Page,
    prompt: string,
    abortSignal?: AbortSignal,
    resolvedComposer?: Locator,
  ): Promise<void> {
    const deadline = Date.now() + 10_000;
    let observed = "";
    while (Date.now() < deadline) {
      throwIfPromptAttachmentAborted(abortSignal);
      observed = await this.attachedPromptText(page, abortSignal, resolvedComposer);
      throwIfPromptAttachmentAborted(abortSignal);
      if (this.promptTextEquivalent(prompt, observed)) return;
      await withBrowserTurnAbort(
        new Promise(resolveSleep => setTimeout(resolveSleep, 50)),
        abortSignal,
      );
    }
    throwIfPromptAttachmentAborted(abortSignal);
    const commonPrefix = this.promptEquivalentPrefixLength(prompt, observed);
    throw new ChatGptPromptAttachmentIntegrityError(
      `ChatGPT composer did not preserve the complete prompt (expectedChars=${prompt.length}, actualChars=${observed.length}, commonPrefixChars=${commonPrefix})`,
    );
  }

  private selectedConnectorControl(composer: Locator): Locator {
    return composer
      .locator('[data-id^="plugin:"][data-keyword]')
      .filter({ hasText: this.config.appName, visible: true });
  }

  private async connectorIsSelected(composer: Locator, abortSignal?: AbortSignal): Promise<boolean> {
    const selected = this.selectedConnectorControl(composer);
    const keywords = await withBrowserTurnAbort(
      withChatGptBrowserObservationTimeout(selected.evaluateAll(elements => (
        elements.map(element => element.getAttribute("data-keyword"))
      ))),
      abortSignal,
    );
    const exactMatches = keywords.filter(keyword => keyword === this.config.appName).length;
    if (exactMatches > 1) {
      throw new Error(`ChatGPT composer exposed duplicate ${JSON.stringify(this.config.appName)} connector selections`);
    }
    return exactMatches === 1;
  }

  private async connectorMentionRowTitles(
    menuRows: Locator,
    abortSignal?: AbortSignal,
  ): Promise<string[]> {
    let texts: string[];
    try {
      texts = await withBrowserTurnAbort(
        withChatGptBrowserObservationTimeout(menuRows.filter({ visible: true }).allInnerTexts()),
        abortSignal,
      );
    } catch (error) {
      if (abortSignal?.aborted) throw error;
      texts = [];
    }
    return texts
      .map(text => (text.split("\n")[0] ?? "").replace(/\s+/g, " ").trim())
      .filter(title => title.length > 0);
  }

  private async connectorMentionFailure(
    menuRows: Locator,
    triggerAttempts: number,
    abortSignal?: AbortSignal,
  ): Promise<string> {
    const titles = await this.connectorMentionRowTitles(menuRows, abortSignal);
    if (titles.length === 0) {
      return `ChatGPT connector menu did not open after ${triggerAttempts} complete mention trigger attempt(s)`;
    }
    if (this.config.appName === CHATGPT_CONNECTOR_NAME && titles.includes(DEV_CHATGPT_CONNECTOR_NAME)) {
      return `ChatGPT exposes the isolated DEV connector ${JSON.stringify(DEV_CHATGPT_CONNECTOR_NAME)},`
        + ` but production requires a separate connector named ${JSON.stringify(CHATGPT_CONNECTOR_NAME)};`
        + ` create ${JSON.stringify(CHATGPT_CONNECTOR_NAME)} against the production tunnel and leave the DEV connector unchanged`;
    }
    if (this.config.appName === CHATGPT_CONNECTOR_NAME && !titles.includes(CHATGPT_CONNECTOR_NAME)) {
      const legacyName = LEGACY_CHATGPT_CONNECTOR_NAMES.find(name => titles.includes(name));
      if (legacyName) return legacyChatGptConnectorMigrationMessage(legacyName);
    }
    return `ChatGPT connector menu opened but exposed no row named ${JSON.stringify(this.config.appName)}`
      + ` after ${triggerAttempts} complete mention trigger attempt(s)`
      + `; create a connector with that exact name before retrying`;
  }

  private async clearChatGptComposerState(page: Page): Promise<void> {
    await runChatGptPersonalizationCleanup(async (deadline, signal) => {
      await pressChatGptPersonalizationEscape(page, deadline, signal);
      const timeoutMs = Math.max(1, deadline - Date.now());
      const composer = await this.activeComposer(page, timeoutMs, signal);
      await composer.fill("", {
        signal,
        timeout: Math.max(1, Math.min(CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS, deadline - Date.now())),
      });
      await waitForChatGptPersonalizationPoll(CHATGPT_UI_SETTLE_MS, signal);
      const settledComposer = await this.activeComposer(page, Math.max(1, deadline - Date.now()), signal);
      const remainingMs = Math.max(1, deadline - Date.now());
      let remainingText = await settledComposer.evaluate(
        element => element.textContent?.trim() ?? "",
        undefined,
        { timeout: remainingMs, signal },
      );
      let connectorSelected = await this.connectorIsSelected(settledComposer, signal);
      if (remainingText.length > 0) {
        // A revision ChatGPT queued instead of consuming survives a programmatic fill(""). Clear it
        // with editor-scoped keyboard editing: the locator focuses the composer before typing, so no
        // key can reach the personalization menu or any other surface and abort its preflight.
        const focused = await settledComposer.click({
          timeout: Math.max(1, Math.min(CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS, deadline - Date.now())),
          signal,
        }).then(() => true, () => false);
        if (focused) {
          await settledComposer.press("Control+A", { timeout: Math.max(1, deadline - Date.now()) }).catch(() => {});
          await settledComposer.press("Backspace", { timeout: Math.max(1, deadline - Date.now()) }).catch(() => {});
          await waitForChatGptPersonalizationPoll(CHATGPT_UI_SETTLE_MS, signal);
          remainingText = await settledComposer.evaluate(
            element => element.textContent?.trim() ?? "",
            undefined,
            { timeout: Math.max(1, deadline - Date.now()), signal },
          );
          connectorSelected = await this.connectorIsSelected(settledComposer, signal);
        }
      }
      if (remainingText.length > 0 || connectorSelected) {
        // Structural diagnostics only: the leftover text itself is never logged.
        const queuedChips = await page.evaluate(() => document.querySelectorAll(
          '[data-testid*="queued"], [data-testid*="pending"], [aria-label*="queued" i]',
        ).length).catch(() => -1);
        // A composer ChatGPT refuses to clear poisons every later submission on this surface, so the
        // failure is retryable: the retry policy discards this browser surface and starts a fresh
        // one instead of replaying a rejected outcome on the same poisoned Temporary Chat.
        throw new ChatGptWebAdapterError(
          `ChatGPT connector cleanup did not produce an empty composer`
          + ` (visibleCharacters=${remainingText.length}, connectorSelected=${connectorSelected}, queuedChips=${queuedChips})`,
          { status: 502, errorType: "server_error", code: "browser_composer_dirty", retryable: true },
        );
      }
    });
  }

  private async selectConnector(
    page: Page,
    captureDiagnostic?: (checkpoint: string) => Promise<void>,
    catalogRefreshAvailable = false,
    attemptBudget: ChatGptConnectorAttemptBudget = { triggerAttempts: 0 },
    abortSignal?: AbortSignal,
  ): Promise<Locator> {
    const capture = async (checkpoint: string): Promise<void> => {
      throwIfPromptAttachmentAborted(abortSignal);
      await withBrowserTurnAbort(captureDiagnostic?.(checkpoint) ?? Promise.resolve(), abortSignal);
      throwIfPromptAttachmentAborted(abortSignal);
    };
    let composer: Locator;
    let preopenedConnectorComposer: Locator | undefined;
    const menuRows = page.locator('.__menu-item[tabindex="0"]');
    const appResult = menuRows.filter({
      has: page.getByText(this.config.appName, { exact: true }),
    });
    await ensureChatGptPersonalizedConnectorAccess(
      page,
      capture,
      async (personalizationSignal) => {
        let proofResult: boolean | undefined;
        let proofError: unknown;
        try {
          composer = await this.activeComposer(page, 30_000, personalizationSignal);
          await composer.fill("", {
            signal: personalizationSignal,
            timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS,
          });
          await composer.focus({
            signal: personalizationSignal,
            timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS,
          });
          await withBrowserTurnAbort(settleChatGptUi(), personalizationSignal);
          await composer.pressSequentially(CHATGPT_CONNECTOR_MENTION_QUERY, {
            delay: 25,
            signal: personalizationSignal,
            timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS,
          });
          try {
            await appResult.waitFor({ state: "visible", timeout: 7_500, signal: personalizationSignal });
            proofResult = true;
            preopenedConnectorComposer = composer;
          } catch (error) {
            if (!(error instanceof Error) || error.name !== "TimeoutError") throw error;
            proofResult = false;
          }
        } catch (error) {
          proofError = error;
        }
        if (proofResult !== true || proofError !== undefined) {
          try {
            await this.clearChatGptComposerState(page);
          } catch (cleanupError) {
            throw new ChatGptPersistentBrowserStateError(
              proofError !== undefined ? [proofError, cleanupError] : [cleanupError],
              "ChatGPT connector proof did not leave a verified empty composer",
            );
          }
        }
        if (proofError !== undefined) throw proofError;
        return proofResult === true;
      },
      abortSignal,
    );
    try {
      composer = preopenedConnectorComposer ?? await this.activeComposer(page, 30_000, abortSignal);
      let firstMenuCaptured = false;
      const preopenedMenuVisible = preopenedConnectorComposer !== undefined
        && await appResult.isVisible().catch(() => false);
      if (preopenedMenuVisible) {
        firstMenuCaptured = true;
        await capture("connector-menu-visible");
      } else {
        preopenedConnectorComposer = undefined;
        await composer.fill("", { signal: abortSignal, timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS });
        if (await this.connectorIsSelected(composer, abortSignal)) {
          await capture("connector-already-selected");
          return composer;
        }
      }

      while (!preopenedMenuVisible && attemptBudget.triggerAttempts < MAX_CHATGPT_CONNECTOR_TRIGGER_ATTEMPTS) {
        attemptBudget.triggerAttempts += 1;
        composer = await this.activeComposer(page, 30_000, abortSignal);
        await composer.fill("", { signal: abortSignal, timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS });
        await composer.focus({ signal: abortSignal, timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS });
        await withBrowserTurnAbort(settleChatGptUi(), abortSignal);
        await composer.pressSequentially(CHATGPT_CONNECTOR_MENTION_QUERY, {
          delay: 25,
          signal: abortSignal,
          timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS,
        });
        if (!firstMenuCaptured) {
          firstMenuCaptured = true;
          await capture("connector-mention-triggered");
        }
        try {
          await appResult.waitFor({
            state: "visible",
            timeout: 2_500,
            signal: abortSignal,
          });
          await capture("connector-menu-visible");
          break;
        } catch (error) {
          if (!(error instanceof Error) || error.name !== "TimeoutError") throw error;
          const visibleRows = await this.connectorMentionRowTitles(menuRows, abortSignal);
          const knownIdentityMismatch = this.config.appName === CHATGPT_CONNECTOR_NAME
            && (
              visibleRows.includes(DEV_CHATGPT_CONNECTOR_NAME)
              || LEGACY_CHATGPT_CONNECTOR_NAMES.some(name => visibleRows.includes(name))
            );
          if (knownIdentityMismatch) {
            await capture("connector-menu-missing");
            throw chatGptConnectorUnavailableError(
              await this.connectorMentionFailure(menuRows, attemptBudget.triggerAttempts, abortSignal),
            );
          }
          if (
            catalogRefreshAvailable
            && visibleRows.length > 0
            && !visibleRows.includes(this.config.appName)
            && attemptBudget.triggerAttempts < MAX_CHATGPT_CONNECTOR_TRIGGER_ATTEMPTS
          ) {
            throw new ChatGptConnectorCatalogStaleError(
              this.config.appName,
              attemptBudget.triggerAttempts,
            );
          }
          if (attemptBudget.triggerAttempts >= MAX_CHATGPT_CONNECTOR_TRIGGER_ATTEMPTS) {
            await capture("connector-menu-missing");
            throw chatGptConnectorUnavailableError(
              await this.connectorMentionFailure(menuRows, attemptBudget.triggerAttempts, abortSignal),
            );
          }
        }
      }
      const exactResultCount = await withBrowserTurnAbort(
        withChatGptBrowserObservationTimeout(appResult.count()),
        abortSignal,
      );
      if (exactResultCount !== 1) {
        throw chatGptConnectorUnavailableError(
          `ChatGPT connector menu did not expose one exact ${JSON.stringify(this.config.appName)} row`
          + ` after ${attemptBudget.triggerAttempts} complete mention trigger attempt(s)`,
        );
      }
      // Hidden launcher maintenance keeps a 1x1 Chromium viewport, so pointer activation cannot
      // reach this menu. Unlike the old unguarded composer Enter path, require the exact row to own
      // ChatGPT's keyboard highlight first; otherwise move the menu highlight until it does. Keep
      // focus on the composer, activate through the menu's real keyboard owner, then prove the exact
      // selected connector pill below.
      const rowHighlighted = async () => await appResult.getAttribute("data-highlighted", {
        signal: abortSignal,
        timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS,
      }) !== null;
      if (!await rowHighlighted()) {
        const visibleRowCount = await withBrowserTurnAbort(
          withChatGptBrowserObservationTimeout(menuRows.filter({ visible: true }).count()),
          abortSignal,
        );
        for (let step = 0; step < visibleRowCount && !await rowHighlighted(); step += 1) {
          await composer.press("ArrowDown", {
            signal: abortSignal,
            timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS,
          });
        }
      }
      if (!await rowHighlighted()) {
        throw new Error(`ChatGPT connector menu could not highlight ${JSON.stringify(this.config.appName)}`);
      }
      await composer.press("Enter", {
        signal: abortSignal,
        timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS,
      });
      await capture("connector-choice-activated");
      // Selecting a connector replaces the Lexical composer subtree. Resolve the active composer
      // again instead of returning the pre-selection locator, otherwise the real turn can focus a
      // detached/hidden editor even though verification just succeeded.
      const selectedComposer = await this.activeComposer(page, 30_000, abortSignal);
      const selectedConnector = this.selectedConnectorControl(selectedComposer);
      await selectedConnector.waitFor({
        state: "visible",
        timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS,
        signal: abortSignal,
      });
      if (!await this.connectorIsSelected(selectedComposer, abortSignal)) {
        throw new Error(`ChatGPT composer did not select ${JSON.stringify(this.config.appName)} connector`);
      }
      await capture("connector-selected");
      return selectedComposer;
    } catch (error) {
      try {
        await this.clearChatGptComposerState(page);
      } catch (cleanupError) {
        throw new ChatGptPersistentBrowserStateError(
          [error, cleanupError],
          "ChatGPT connector selection failed and its composer state could not be cleared",
        );
      }
      throw error;
    }
  }

  private async attachPrompt(
    page: Page,
    prompt: string,
    localTools: boolean,
    captureDiagnostic?: (checkpoint: string) => Promise<void>,
    abortSignal?: AbortSignal,
    catalogRefreshAvailable = false,
    connectorAttemptBudget?: ChatGptConnectorAttemptBudget,
    reuseConnector = false,
  ): Promise<void> {
    throwIfPromptAttachmentAborted(abortSignal);
    const connectorMode = chatGptConnectorAttachmentMode(localTools, reuseConnector);
    let composerMutationStarted = false;
    try {
      if (connectorMode !== "mention") {
        const timingEnabled = process.env.CODEX_CHATGPT_WEB_PROMPT_ATTACHMENT_TIMING === "1";
        let timingStepStartedAt = performance.now();
        const recordTiming = (step: string): void => {
          if (!timingEnabled) return;
          const now = performance.now();
          console.info(`[chatgpt-web] prompt_attachment_timing step=${step} durationMs=${Math.round(now - timingStepStartedAt)}`);
          timingStepStartedAt = now;
        };
        const composer = await this.activeComposer(page, 30_000, abortSignal);
        recordTiming("active_composer");
        // Playwright's multiline fill maps through an input action that ChatGPT's Lexical editor can
        // collapse to the first paragraph on the launcher-owned Electron surface. Clear separately,
        // then transport the complete text through the browser's plain-text editing command.
        composerMutationStarted = true;
        await composer.fill("", { signal: abortSignal, timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS });
        recordTiming("clear");
        if (isChatGptRequestInjectionPlaceholder(prompt)) {
          // Request injection puts only a short, single-line ASCII nonce in the editor. Unlike an
          // arbitrary Markdown prompt, Playwright fill cannot trigger Lexical's multiline/Markdown
          // input transformations here. On retained conversations this also avoids the several-
          // second Runtime.evaluate barrier observed after execCommand insertion. Keep fail-closed
          // ownership by proving the exact nonce twice with a normal host-side UI settle between
          // reads; any mismatch falls back to the existing strict attachment assertion below.
          await composer.fill(prompt, {
            signal: abortSignal,
            timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS,
          });
          recordTiming("placeholder_fill");
          const firstObserved = await this.attachedPromptText(page, abortSignal, composer);
          recordTiming("placeholder_readback_1");
          let placeholderStable = this.promptTextEquivalent(prompt, firstObserved);
          if (placeholderStable) {
            await withBrowserTurnAbort(settleChatGptUi(), abortSignal);
            recordTiming("placeholder_settle");
            const secondObserved = await this.attachedPromptText(page, abortSignal, composer);
            recordTiming("placeholder_readback_2");
            placeholderStable = this.promptTextEquivalent(prompt, secondObserved);
          }
          if (!placeholderStable) {
            await this.assertPromptAttached(page, prompt, abortSignal, composer);
          }
          recordTiming("assert");
          return;
        }
        await composer.focus({ signal: abortSignal, timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS });
        recordTiming("focus");
        const insertedReadback = await this.insertPromptText(page, prompt, abortSignal, composer);
        recordTiming("insert");
        if (insertedReadback === null || !this.promptTextEquivalent(prompt, insertedReadback)) {
          await this.assertPromptAttached(page, prompt, abortSignal, composer);
        } else {
          // The renderer proof above is event-loop based, so it is not vulnerable to Chromium's
          // hidden-page timer throttling. Keep a short host-side settle before Enter so ChatGPT's
          // SPA can publish the newly inserted editor state to its submit/request pipeline without
          // turning request-injection rewrite proof into the next latency bottleneck.
          await new Promise(resolveSettle => setTimeout(resolveSettle, 200));
          recordTiming("post_insert_settle");
        }
        recordTiming("assert");
        return;
      }
      const selectedComposer = await this.selectConnector(
        page,
        captureDiagnostic,
        catalogRefreshAvailable,
        connectorAttemptBudget,
        abortSignal,
      );
      // selectConnector owns and rolls back every mutation until it returns. From this point the
      // attachment owns the selected pill and prompt text as one transaction.
      composerMutationStarted = true;
      await selectedComposer.focus({ signal: abortSignal, timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS });
      await selectedComposer.press(CHATGPT_COMPOSER_DOCUMENT_END_KEY, {
        signal: abortSignal,
        timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS,
      });
      const insertedReadback = await this.insertPromptText(page, ` ${prompt}`, abortSignal, selectedComposer);
      if (insertedReadback === null || !this.promptTextEquivalent(prompt, insertedReadback)) {
        await this.assertPromptAttached(page, prompt, abortSignal, selectedComposer);
      }
    } catch (error) {
      if (!composerMutationStarted || error instanceof ChatGptPersistentBrowserStateError) throw error;
      try {
        await this.clearChatGptComposerState(page);
      } catch (cleanupError) {
        throw new ChatGptPersistentBrowserStateError(
          [error, cleanupError],
          "ChatGPT prompt attachment failed and its composer state could not be cleared",
        );
      }
      throw error;
    }
  }

  private async sendAttachedPrompt(
    page: Page,
    baseline: ChatGptSubmissionBaseline,
    captureDiagnostic?: (checkpoint: string) => Promise<void>,
    abortSignal?: AbortSignal,
    externalProgress?: ChatGptTurnProgressReader,
    submissionLifecycle?: Pick<BrowserTurn, "onSendActivated" | "onSubmitted">,
    completionTracker?: ChatGptCompletionTracker,
    requestRewriteProbe?: (signal?: AbortSignal) => Promise<void>,
  ): Promise<ChatGptSubmissionEvidence> {
    const timingEnabled = process.env.CODEX_CHATGPT_WEB_SEND_TIMING === "1";
    let timingStepStartedAt = performance.now();
    const recordTiming = (step: string): void => {
      if (!timingEnabled) return;
      const now = performance.now();
      console.info(`[chatgpt-web] send_timing step=${step} durationMs=${Math.round(now - timingStepStartedAt)}`);
      timingStepStartedAt = now;
    };
    const composer = await this.activeComposer(page);
    recordTiming("active_composer");
    const sendButton = composer
      .locator("xpath=ancestor::form[1]")
      .getByTestId("send-button");
    await sendButton.waitFor({ state: "visible", timeout: browserStageTimeouts.send });
    recordTiming("button_visible");
    const sendEnableDeadline = Date.now() + CHATGPT_SEND_ENABLE_GRACE_MS;
    for (;;) {
      if (abortSignal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
      if (page.isClosed()) throw chatGptBrowserTabClosedError();
      await throwIfChatGptSessionFailureAlert(page);
      await throwIfChatGptRateLimitDialog(page);
      if (await sendButton.isEnabled()) break;
      if (Date.now() >= sendEnableDeadline) {
        await captureDiagnostic?.("send-disabled");
        throw new Error("ChatGPT send button remained disabled after the complete prompt was attached");
      }
      await settleChatGptUi();
      recordTiming("disabled_settle");
    }
    recordTiming("button_enabled");
    // A reused retained surface can still expose ChatGPT's own generation control after our stop.
    // Activating Send there queues the revision instead of submitting it, so wait for idle first.
    const idleDeadline = Date.now() + CHATGPT_SEND_IDLE_GRACE_MS;
    for (;;) {
      if (abortSignal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
      if (page.isClosed()) throw chatGptBrowserTabClosedError();
      const stillGenerating = await page.locator(CHATGPT_STOP_BUTTON_SELECTOR).last()
        .isVisible().catch(() => false);
      if (!stillGenerating) break;
      if (Date.now() >= idleDeadline) {
        await captureDiagnostic?.("send-surface-busy");
        // Nothing was activated and no request was created, so this surface can be discarded and the
        // canonical prompt replayed safely on a fresh one.
        throw new ChatGptWebAdapterError(
          "ChatGPT still exposed an active generation control when the prompt was ready to send",
          { status: 502, errorType: "server_error", code: "browser_surface_busy", retryable: true },
        );
      }
      await settleChatGptUi();
      recordTiming("surface_busy_settle");
    }
    recordTiming("surface_idle");
    await captureDiagnostic?.("send-ready");
    recordTiming("send_ready_capture");
    const initialToolBatchRevision = externalProgress?.snapshot().lastToolBatchRevision ?? 0;
    await submissionLifecycle?.onSendActivated?.();
    recordTiming("send_activated");
    await sendButton.press("Enter", {
      noWaitAfter: true,
      signal: abortSignal,
      // runStage owns the operation budget. A second Locator timeout would silently collapse the
      // 180-second Bigger Context budget back to the ordinary 20 seconds after Enter has already
      // submitted the message; semantic submission evidence below remains the authority.
      timeout: 0,
    });
    recordTiming("press_enter");
    if (requestRewriteProbe) {
      // ChatGPT occasionally ignores the first Enter on a reused Temporary Chat surface. While no
      // request was observed the placeholder is still the only composer content, so pressing Send
      // again is idempotent: a submission that already left the page cleared the composer and an
      // empty second Enter is a no-op. The injection fallback stays authoritative after the retry.
      for (let attempt = 1; ; attempt += 1) {
        try {
          await requestRewriteProbe(abortSignal);
          break;
        } catch (error) {
          if (!(error instanceof ChatGptRequestInjectionFallbackError) || abortSignal?.aborted || attempt >= 2) {
            throw error;
          }
          console.info(
            "[chatgpt-web] ChatGPT ignored the first Send activation on this surface;"
            + " pressing Send again before falling back",
          );
          await settleChatGptUi();
          await sendButton.press("Enter", { noWaitAfter: true, signal: abortSignal, timeout: 0 }).catch(() => {});
        }
      }
    }
    recordTiming("rewrite_proof");
    const evidence = await this.waitForSubmissionAccepted(
      page,
      baseline,
      abortSignal,
      externalProgress,
      initialToolBatchRevision,
      completionTracker,
    );
    recordTiming("submission_evidence");
    submissionLifecycle?.onSubmitted?.();
    return evidence;
  }

  /**
   * Submit a revision through ChatGPT's composer without activating its Stop control. Acceptance
   * requires one exact new user turn in the same document while the original generation is live.
   */
  private async insertSteeringRevision(page: Page, text: string, signal?: AbortSignal): Promise<string> {
    const composer = await this.activeComposer(page, 30_000, signal);
    const result = await composer.evaluate(writeComposerTextWithEditorCommands, text, {
      timeout: 20_000,
      signal,
    });
    if (!result.inserted) return result.reason;
    const observed = await this.attachedPromptText(page, signal, composer);
    if (!this.promptTextEquivalent(text, observed)) {
      return `readback-mismatch:${observed.length}`;
    }
    return "inserted";
  }

  private async clearSteeringRevision(page: Page, signal?: AbortSignal): Promise<void> {
    const composer = await this.activeComposer(page, 10_000, signal);
    await composer.evaluate(writeComposerTextWithEditorCommands, "", { timeout: 10_000, signal });
  }

  /** The one shared submit control carries the Send identity only once ChatGPT holds a revision. */
  private async steeringSubmitControlState(page: Page, signal?: AbortSignal): Promise<{
    testid: string | null;
    disabled: boolean;
    editorChars: number;
    activeId: string | null;
    editors: number;
  }> {
    return withChatGptBrowserObservationTimeout(withBrowserTurnAbort(page.evaluate(() => {
      const editors = document.querySelectorAll(
        '[data-testid="prompt-textarea"], #prompt-textarea, [contenteditable="true"][data-lexical-editor="true"], .ProseMirror',
      );
      const editor = document.querySelector("#prompt-textarea");
      const form = editor ? editor.closest("form") : null;
      const button = document.querySelector("#composer-submit-button")
        ?? form?.querySelector('button[type="submit"]')
        ?? form?.querySelector('[data-testid="send-button"]');
      const active = document.activeElement;
      return {
        testid: button?.getAttribute("data-testid") ?? null,
        disabled: button?.getAttribute("aria-disabled") === "true"
          || (button as HTMLButtonElement | null)?.disabled === true,
        editorChars: (editor?.textContent ?? "").trim().length,
        activeId: active instanceof HTMLElement ? active.id || active.className.slice(0, 32) : null,
        editors: editors.length,
      };
    }), signal));
  }

  private async submitInFlightSteering(
    page: Page,
    item: ChatGptBrowserSteeringItem,
    binding: ChatGptAssistantTurnBinding,
    signal?: AbortSignal,
  ): Promise<{ state: ChatGptSubmissionDomState; replyIdentity?: string }> {
    const beforeCache: ChatGptSubmissionDomCache = {};
    const before = await this.submissionDomState(page, beforeCache, signal);
    if (before.documentId !== binding.documentId) {
      throw new Error("ChatGPT steering target no longer exposes the committed response document");
    }
    if (before.visibleStopButtonCount < 1) {
      // The browser can finish the response between the control bridge observing the revision and
      // this queue drain. That rejects only the late revision; it must not fail the already-owned
      // browser runtime or make Codex tear down the provider connection.
      throw new ChatGptSteeringUnavailableError();
    }
    if (before.userIdentities.length !== binding.acceptedUserTurnIdentities.length
      || binding.acceptedUserTurnIdentities.some(identity => !before.userIdentities.includes(identity))) {
      throw new Error("ChatGPT steering found an unowned user turn before submission");
    }
    const composer = await this.activeComposer(page, 30_000, signal);
    // ChatGPT owns one submit control and swaps it between Stop and Send as the composer content
    // changes, so the Send identity is only observable after the revision is inserted. Wait for that
    // exact swap instead of demanding Send before the insertion, which can only ever see Stop.
    let insertOutcome = "not-attempted";
    let lastControl: Awaited<ReturnType<ChatGptBrowserWorker["steeringSubmitControlState"]>> | undefined;
    const armSendControl = async (budgetMs: number): Promise<boolean> => {
      const armDeadline = Date.now() + budgetMs;
      let armed = false;
      while (!armed && Date.now() < armDeadline) {
        lastControl = await this.steeringSubmitControlState(page, signal).catch(() => undefined);
        armed = lastControl?.testid === "send-button"
          && lastControl.disabled !== true
          && lastControl.editorChars > 0;
        if (!armed) await this.waitForTurnDomMutation(page, 250);
      }
      return armed;
    };
    // One editor command is enough to make ChatGPT expose its queued-message Send control. Rewriting
    // the same visible text while React is applying that state can pin the shared control on Stop.
    insertOutcome = await this.insertSteeringRevision(page, item.prompt.text, signal)
      .catch(error => `error:${error instanceof Error ? error.message.slice(0, 60) : String(error).slice(0, 60)}`);
    const armed = await armSendControl(CHATGPT_STEERING_SEND_ARM_MS);
    console.info(`[chatgpt-web] in-flight steering armed=${armed} insert=${insertOutcome}`
      + ` control=${JSON.stringify(lastControl ?? null)}`);
    if (!armed) {
      await this.clearSteeringRevision(page).catch(() => {});
      throw new ChatGptSteeringUnavailableError();
    }
    // The launcher surface can be an unmeasured hidden view, ChatGPT's composer ignores a
    // synthesised Enter even with the Send control focused, and the one shared control flips back to
    // Stop between an outside check and an outside click. Re-read the identity and activate it inside
    // one evaluation so Stop can never be the control this submit presses.
    const clickArmedSteeringSend = () => withChatGptBrowserObservationTimeout(withBrowserTurnAbort(page.evaluate(() => {
      const editor = document.querySelector("#prompt-textarea");
      const form = editor ? editor.closest("form") : null;
      const button = document.querySelector("#composer-submit-button")
        ?? form?.querySelector('button[type="submit"]')
        ?? form?.querySelector('[data-testid="send-button"], [data-testid="stop-button"]');
      if (!button
        || document.querySelectorAll("[data-streaming-response-status]").length < 1
        || button.getAttribute("data-testid") !== "send-button"
        || button.getAttribute("aria-disabled") === "true"
        || (button as HTMLButtonElement).disabled === true) return false;
      (button as HTMLElement).click();
      return true;
    }), signal));
    await page.waitForTimeout(CHATGPT_UI_SETTLE_MS);
    const submitted = await clickArmedSteeringSend();
    if (!submitted) throw new ChatGptSteeringUnavailableError();

    const acceptedDeadline = Date.now() + CHATGPT_STEERING_ACCEPTANCE_MS;
    // The strongest proof is one new user turn whose content matches the revision. Some ChatGPT
    // builds do not expose user turns through the conversation-turn testid at all, so the turn can
    // also be proven by the composer draining while the exact generation is still running and no
    // new assistant turn replaced the steered answer.
    let drainedSince: number | undefined;
    let acceptedAt: number | undefined;
    let nextSubmitAttemptAt = Date.now() + CHATGPT_UI_SETTLE_MS;
    for (;;) {
      if (signal?.aborted) throw new DOMException("ChatGPT steering aborted", "AbortError");
      if (page.isClosed()) throw chatGptBrowserTabClosedError();
      const state = await this.submissionDomState(page, {}, signal);
      if (state.documentId !== binding.documentId) {
        throw new Error("ChatGPT steering navigated away from the committed response document");
      }
      const accepted = new Set(before.userIdentities);
      const added = state.userIdentities.filter(identity => !accepted.has(identity));
      if (added.length > 1) {
        throw new Error("ChatGPT steering exposed more than one new user turn");
      }
      if (added.length === 1) {
        if (before.userIdentities.some(identity => !state.userIdentities.includes(identity))) {
          throw new Error("ChatGPT steering replaced an accepted user turn");
        }
        const userTurn = page.locator(`[data-turn-id=${JSON.stringify(added[0])}]`);
        const visibleText = await withChatGptBrowserObservationTimeout(
          withBrowserTurnAbort(userTurn.innerText(), signal),
        );
        if (!this.promptTextEquivalent(item.prompt.text, visibleText)) {
          throw new Error("ChatGPT steering user-turn content did not match the submitted revision");
        }
        acceptedAt ??= Date.now();
      }
      if (before.userIdentities.length === 0) {
        const composerText = await this.attachedPromptText(page, signal, composer);
        const stillGenerating = await page.locator(CHATGPT_STOP_BUTTON_SELECTOR).last()
          .isVisible().catch(() => false);
        if (!composerText.trim() && stillGenerating) {
          // ChatGPT clears the composer only after it consumes the send, so a drained editor that
          // stays empty across one observation window is acceptance evidence, not a race.
          drainedSince ??= Date.now();
          if (Date.now() - drainedSince >= 250) acceptedAt ??= Date.now();
        } else {
          drainedSince = undefined;
        }
      }
      if (acceptedAt !== undefined) {
        // The steered revision opens its own assistant turn inside the same Temporary Chat. Bind to
        // that turn so the delivered answer is the new direction rather than the superseded prefix.
        const replies = state.responseIdentities
          .filter(identity => !binding.acceptedTurnIdentities.includes(identity));
        if (replies.length > 1) {
          throw new Error("ChatGPT steering exposed more than one new assistant turn");
        }
        if (replies.length === 1) return { state, replyIdentity: replies[0] };
        if (Date.now() - acceptedAt >= CHATGPT_STEERING_REPLY_MS) return { state };
      }
      if (added.length === 0 && Date.now() >= nextSubmitAttemptAt) {
        nextSubmitAttemptAt = Date.now() + CHATGPT_UI_SETTLE_MS;
        await clickArmedSteeringSend().catch(() => false);
      }
      if (Date.now() >= acceptedDeadline) {
        // Do not poison the live runtime when ChatGPT consumed neither (or cannot prove consuming)
        // this revision: the leftover editor text would fail the next submission's composer
        // cleanup ("connector cleanup did not produce an empty composer") and tear the turn down.
        // The single-use instruction binding prevents a later canonical replay from resubmitting
        // an uncertain revision.
        await this.clearSteeringRevision(page).catch(() => {});
        throw new ChatGptSteeringUnavailableError();
      }
      await this.waitForTurnDomMutation(page, 50);
    }
  }

  private async waitForMultipartAcknowledgement(
    page: Page,
    initialResponseTurn: ChatGptAssistantTurnBinding,
    submissionBaseline: ChatGptSubmissionBaseline,
    stage: ChatGptWebMultipartStage,
    deadline: number | undefined,
    abortSignal?: AbortSignal,
    externalProgress?: ChatGptTurnProgressReader,
    completionTracker = new ChatGptCompletionTracker(),
  ): Promise<void> {
    const domHealthTracker = new ChatGptTurnDomHealthTracker();
    const stoppedThinkingTracker = new ChatGptStoppedThinkingTracker();
    const responseDomCache: ChatGptResponseDomCache = {};
    let responseTurn = initialResponseTurn;
    for (;;) {
      if (page.isClosed()) throw chatGptBrowserTabClosedError();
      if (abortSignal?.aborted) {
        const stop = page.locator(CHATGPT_STOP_BUTTON_SELECTOR).last();
        if (await stop.isVisible().catch(() => false)) await stop.press("Enter").catch(() => {});
        throw new DOMException("ChatGPT multipart stage aborted", "AbortError");
      }
      if (deadline !== undefined && Date.now() >= deadline) {
        throw new Error("ChatGPT Bigger Context transaction timed out while awaiting a stage acknowledgement");
      }
      await throwIfChatGptSessionFailureAlert(page);
      await throwIfChatGptTerminalErrorAlert(responseTurn.locator);
      let snapshot = await this.responseDomSnapshot(responseTurn.locator, responseDomCache);
      if (!snapshot.responsePresent && await responseTurn.locator.count() !== 1) {
        const rebound = await this.reconcileAssistantTurnBinding(
          page,
          submissionBaseline,
          responseTurn,
          abortSignal,
        );
        if (rebound.identity !== responseTurn.identity) {
          responseTurn = rebound;
          responseDomCache.key = undefined;
          responseDomCache.snapshot = undefined;
          snapshot = await this.responseDomSnapshot(responseTurn.locator, responseDomCache);
        }
      }
      const externalProgressSnapshot = externalProgress?.snapshot();
      if (externalProgress
        && externalProgressSnapshot
        && completionTracker.needsToolBatchObservation(externalProgressSnapshot.lastToolBatchRevision)) {
        completionTracker.observeToolBatch(
          externalProgressSnapshot.lastToolBatchRevision,
          snapshot.visibleText,
        );
        await externalProgress.acknowledgeToolBatch(externalProgressSnapshot.lastToolBatchRevision);
      }
      const externalProgressLive = chatGptExternalProgressSuppressesDomHealth(
        externalProgressSnapshot,
        Date.now(),
      );
      const externalToolCallsInFlight = chatGptExternalToolCallsAreInFlight(externalProgressSnapshot);
      if (externalProgressLive) stoppedThinkingTracker.clear();
      else if (stoppedThinkingTracker.update(snapshot.stoppedThinkingVisible)) {
        throw chatGptStoppedThinkingError();
      }
      if (!snapshot.responsePresent && externalProgressLive) {
        // Proven MCP activity outranks a momentarily unavailable staging DOM, exactly as it does
        // in the main turn loop.
        domHealthTracker.clearMissingResponse();
        await new Promise(resolveSleep => setTimeout(resolveSleep, 250));
        continue;
      }
      const running = await page.locator(CHATGPT_STOP_BUTTON_SELECTOR).last().isVisible().catch(() => false);
      const domError = domHealthTracker.update({
        responsePresent: snapshot.responsePresent,
        running,
        currentText: snapshot.visibleText,
        completionActionVisible: snapshot.completionActionVisible,
        externalProgressLive,
      });
      if (domError) throw new Error(domError);
      if (completionTracker.update({
        responsePresent: snapshot.responsePresent,
        running,
        currentText: snapshot.visibleText,
        currentHtml: snapshot.fullHtml,
        completionActionVisible: snapshot.completionActionVisible,
        externalToolCallsInFlight,
      })) {
        const actual = snapshot.visibleText.trim();
        if (actual !== stage.acknowledgement) {
          throw new ChatGptWebAdapterError(
            `ChatGPT Bigger Context stage returned ${actual.length.toLocaleString("en-US")} characters instead of its exact acknowledgement. The staged task was not committed and will not be retried automatically.`,
            {
              status: 502,
              errorType: "server_error",
              code: "multipart_protocol_violation",
              retryable: false,
            },
          );
        }
        return;
      }
      await new Promise(resolveSleep => setTimeout(resolveSleep, 100));
    }
  }

  private async resetCompactionComposerForRetry(
    page: Page,
    baseline: ChatGptSubmissionBaseline,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    throwIfPromptAttachmentAborted(abortSignal);
    const before = await this.currentSubmissionEvidence(page, baseline, abortSignal);
    if (before) {
      throw new ChatGptPromptAttachmentIntegrityError(
        `ChatGPT exposed ${before} after compaction prompt attachment failed; refusing a duplicate submission`,
      );
    }

    const composer = await this.activeComposer(page, 30_000, abortSignal);
    await composer.fill("", { signal: abortSignal, timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS });
    await composer.focus({ signal: abortSignal, timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS });
    await withBrowserTurnAbort(settleChatGptUi(), abortSignal);
    throwIfPromptAttachmentAborted(abortSignal);

    const after = await this.currentSubmissionEvidence(page, baseline, abortSignal);
    if (after) {
      throw new ChatGptPromptAttachmentIntegrityError(
        `ChatGPT exposed ${after} while resetting a failed compaction prompt; refusing a duplicate submission`,
      );
    }
    const observed = await this.attachedPromptText(page, abortSignal);
    if (observed.length > 0) {
      throw new ChatGptPromptAttachmentIntegrityError(
        `ChatGPT composer could not reset cleanly for compaction retry (actualChars=${observed.length})`,
      );
    }
  }

  private async attachPromptWithCompactionRetry(
    page: Page,
    prompt: string,
    localTools: boolean,
    compaction: boolean,
    baseline: ChatGptSubmissionBaseline,
    captureDiagnostic?: (checkpoint: string) => Promise<void>,
    abortSignal?: AbortSignal,
    catalogRefreshAvailable = false,
    connectorAttemptBudget?: ChatGptConnectorAttemptBudget,
    reuseConnector = false,
  ): Promise<void> {
    let retryAvailable = compaction;
    for (;;) {
      try {
        await this.attachPrompt(
          page,
          prompt,
          localTools,
          captureDiagnostic,
          abortSignal,
          catalogRefreshAvailable,
          connectorAttemptBudget,
          reuseConnector,
        );
        return;
      } catch (error) {
        if (!retryAvailable || !(error instanceof ChatGptPromptAttachmentIntegrityError)) throw error;
        retryAvailable = false;
        const evidence = await this.currentSubmissionEvidence(page, baseline, abortSignal);
        if (evidence) {
          throw new ChatGptPromptAttachmentIntegrityError(
            `${error.message}; ChatGPT exposed ${evidence}, so the bridge refused to insert or send the compaction prompt again`,
          );
        }
        await captureDiagnostic?.("prompt-attachment-integrity-retry");
        await this.resetCompactionComposerForRetry(page, baseline, abortSignal);
      }
    }
  }

  private async insertPromptText(
    page: Page,
    text: string,
    abortSignal?: AbortSignal,
    resolvedComposer?: Locator,
  ): Promise<string | null> {
    throwIfPromptAttachmentAborted(abortSignal);
    const composer = resolvedComposer ?? await this.activeComposer(page, 30_000, abortSignal);
    // CDP Input.insertText is interpreted as live typing by ChatGPT's Lexical plugins. On a large
    // JSON transport it can turn literal Markdown backticks into rich code nodes, remove the
    // delimiters from textContent, and leave the next insertion outside the intended block. The
    // browser's plain-text editing command updates the same focused contenteditable atomically
    // without running those Markdown shortcuts. Exact readback below remains the authority.
    const result = await composer.evaluate(insertPlainTextIntoComposer, text, {
      timeout: 20_000,
      signal: abortSignal,
    });
    throwIfPromptAttachmentAborted(abortSignal);
    if (!result.inserted) {
      throw new ChatGptPromptAttachmentIntegrityError(
        "ChatGPT composer rejected the plain-text editing command",
      );
    }
    return result.observed;
  }

  private async verifyConnectorExclusive(): Promise<{ appName: string; pluginId: string }> {
    const page = await this.ensurePage();
    await this.prepareTemporaryChatSurface(page);
    // The launcher refreshes its owned ChatGPT document before starting this helper. A second
    // reload here can discard the first catalog's exact mismatch evidence and report a generic
    // menu failure instead of identifying the connector the account actually exposes.
    const selectedComposer = await this.selectConnector(page);
    const selectedConnector = this.selectedConnectorControl(selectedComposer);
    const [pluginId, keyword] = await Promise.all([
      selectedConnector.getAttribute("data-id"),
      selectedConnector.getAttribute("data-keyword"),
    ]);
    if (keyword !== this.config.appName
      || typeof pluginId !== "string"
      || !/^plugin:[A-Za-z0-9_-]{16,128}$/.test(pluginId)) {
      throw new Error("ChatGPT verified the connector but did not expose one valid opaque plugin identity");
    }
    return { appName: this.config.appName, pluginId };
  }

  private async inspectSessionExclusive(detectCapabilities: boolean): Promise<{
    authenticated: true;
    temporary: true;
    url: string;
    solAvailable?: boolean;
    proAvailable?: boolean;
  }> {
    const page = await this.ensurePage();
    await this.prepareTemporaryChatSurface(page);
    const url = page.url();
    if (!detectCapabilities) return { authenticated: true, temporary: true, url };
    const capabilities = await detectChatGptAccountCapabilities(page);
    return { authenticated: true, temporary: true, url, ...capabilities };
  }

  private async prewarmModeExclusive(
    surfaceId: string,
    modelId: string,
    reasoning?: string,
    abortSignal?: AbortSignal,
    connectorIdentity?: string,
  ): Promise<{ modelId: string; reasoning: string | null; effort: string; connectorBound: boolean }> {
    if (this.config.browserHost !== "launcher" || !this.config.browserHostDescriptorPath) {
      throw new Error("ChatGPT mode prewarm requires a launcher-owned browser surface");
    }
    if (!/^[A-Za-z0-9_-]{32}$/.test(surfaceId)) {
      throw new Error("ChatGPT mode prewarm surface identity is invalid");
    }
    if (typeof modelId !== "string" || !modelId.trim() || modelId.length > 128) {
      throw new Error("ChatGPT mode prewarm model is invalid");
    }
    if (reasoning !== undefined && (!reasoning.trim() || reasoning.length > 40)) {
      throw new Error("ChatGPT mode prewarm reasoning is invalid");
    }
    if (connectorIdentity !== undefined
      && (connectorIdentity !== this.config.appName || !connectorIdentity.trim() || connectorIdentity.length > 80)) {
      throw new Error("ChatGPT mode prewarm connector identity is invalid");
    }
    const connection = await connectLauncherBrowserHost(
      this.config.browserHostDescriptorPath,
      browserStageTimeouts.browserPage,
      surfaceId,
      abortSignal,
    );
    try {
      await waitForOperationalChatGptViewport(connection.page, abortSignal);
      await this.prepareTemporaryChatSurface(connection.page);
      const account = await detectChatGptAccountCapabilities(connection.page);
      const capabilities: ChatGptWebCapabilities = {
        ...account,
        localToolsEnabled: connectorIdentity !== undefined,
      };
      const mode = await this.selectModelAndEffort(
        connection.page,
        modelId,
        reasoning,
        capabilities,
      );
      if (connectorIdentity !== undefined) {
        await this.selectConnector(connection.page, undefined, false, { triggerAttempts: 0 }, abortSignal);
      }
      return {
        modelId,
        reasoning: reasoning ?? null,
        effort: mode.effort,
        connectorBound: connectorIdentity !== undefined,
      };
    } finally {
      await connection.browser.close().catch(() => {});
    }
  }

  private async smokeTestExclusive(abortSignal?: AbortSignal): Promise<{ effort: string; response: string }> {
    const page = await this.ensurePage();
    await this.prepareTemporaryChatSurface(page);
    const account = await detectChatGptAccountCapabilities(page);
    // Core smoke runs before the optional MCP connector is configured, so it must remain a
    // browser-only transport check. Connector setup has its own explicit verification operation.
    const capabilities: ChatGptWebCapabilities = { ...account, localToolsEnabled: false };
    const modelId = account.solAvailable ? CHATGPT_WEB_MODEL_ID : CHATGPT_WEB_LUNA_MODEL_ID;
    const reasoning = account.solAvailable ? "high" : "low";
    const mode = resolveChatGptWebModelMode(modelId, reasoning, capabilities);
    const traceId = `smoke_${randomUUID().replaceAll("-", "")}`;
    const response = await this.runBrowserTurn({
      traceId,
      modelId,
      reasoning,
      capabilities,
      prepare: async () => ({ text: CHATGPT_SMOKE_TEXT, images: [], release: () => {} }),
      abortSignal,
      onTextDelta: () => {},
    }, undefined, page);
    if (response.trim() !== CHATGPT_SMOKE_EXPECTED) {
      throw new Error(
        `ChatGPT smoke test returned an unexpected answer (${JSON.stringify(response.trim().slice(0, 200))})`,
      );
    }
    return { effort: mode.displayLabel, response: CHATGPT_SMOKE_EXPECTED };
  }

  private async attachFiles(page: Page, prompt: CompiledChatGptWebPrompt): Promise<void> {
    const files = chatGptPromptFilePayloads(prompt);
    if (files.length === 0) return;
    const composer = await this.activeComposer(page);
    const composerForm = composer.locator("xpath=ancestor::form[1]");
    const input = page.locator('input[data-testid="upload-photos-input"]');
    await input.waitFor({ state: "attached", timeout: 20_000 });
    await input.setInputFiles(files);
    try {
      await Promise.all(files.map(file => (
        composerForm.getByRole("group", { name: file.name, exact: true })
          .waitFor({ state: "visible", timeout: 60_000 })
      )));
    } catch {
      const alerts = (await page.locator('[role="alert"]').allInnerTexts().catch(() => []))
        .map(text => text.replace(/\s+/g, " ").trim())
        .filter(Boolean);
      throw new Error(
        `ChatGPT did not accept all prompt attachments`
        + (alerts.length > 0 ? `: ${alerts.join(" | ")}` : ""),
      );
    }
    const send = composerForm.getByTestId("send-button");
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (await send.isEnabled().catch(() => false)) return;
      await new Promise(resolveSleep => setTimeout(resolveSleep, 100));
    }
    throw new Error("ChatGPT accepted the prompt attachments but did not make the message ready to send");
  }

  private async responseDomSnapshot(
    responseTurn: Locator,
    cache?: ChatGptResponseDomCache,
  ): Promise<ChatGptResponseDomSnapshot> {
    const observed = await responseTurn.evaluate((element, options) => {
      const root = element as HTMLElement;
      type ObserverState = {
        id: number;
        revision: number;
        observer: MutationObserver;
        waiters: Set<() => void>;
        answerRoots: WeakSet<HTMLElement>;
      };
      type ObserverRegistry = { documentId: string; nextId: number; states: WeakMap<Element, ObserverState> };
      const scope = globalThis as typeof globalThis & {
        __CODEX_WEB_GPT_RESPONSE_OBSERVERS__?: ObserverRegistry;
      };
      const registry = scope.__CODEX_WEB_GPT_RESPONSE_OBSERVERS__ ??= {
        documentId: `${performance.timeOrigin}:${Math.random().toString(36).slice(2)}`,
        nextId: 0,
        states: new WeakMap<Element, ObserverState>(),
      };
      let observerState = registry.states.get(root);
      if (!observerState) {
        observerState = {
          id: ++registry.nextId,
          revision: 0,
          observer: undefined as unknown as MutationObserver,
          waiters: new Set<() => void>(),
          answerRoots: new WeakSet<HTMLElement>(),
        };
        const state = observerState;
        state.observer = new MutationObserver(() => {
          state.revision += 1;
          const waiters = [...state.waiters];
          state.waiters.clear();
          waiters.forEach(resolveWaiter => resolveWaiter());
        });
        state.observer.observe(root, {
          subtree: true,
          childList: true,
          characterData: true,
          attributes: true,
          attributeFilter: options.attributeFilter,
        });
        registry.states.set(root, state);
      }
      const observerKey = `${registry.documentId}:${observerState.id}:${observerState.revision}`;
      if (options.knownKey === observerKey) return { key: observerKey };
      // Browser turn WebContents are intentionally allowed to run while their Electron view is
      // hidden or has no measured width. Layout geometry is therefore not response visibility:
      // completed Markdown can have width=0 while remaining connected, rendered and readable.
      const renderedInDom = (candidate: HTMLElement): boolean => {
        const style = getComputedStyle(candidate);
        return candidate.isConnected
          && style.display !== "none"
          && style.visibility !== "hidden"
          && style.opacity !== "0";
      };

      // ChatGPT uses the same Markdown renderer for intermediate commentary and for the final
      // answer. Older responses nested commentary in the streaming-status container. Pro can also
      // render a completed commentary Markdown root immediately before that live status container.
      // Final-answer Markdown follows the live status instead, so DOM order remains the semantic
      // boundary without relying on localized labels such as "Pro thinking".
      const allMarkdownRoots = [...root.querySelectorAll<HTMLElement>(".markdown")]
        .filter(candidate => !candidate.parentElement?.closest(".markdown"))
        .filter(renderedInDom);
      const streamingStatusContainers = [...root.querySelectorAll<HTMLElement>("[data-streaming-response-status]")]
        .filter(renderedInDom);
      // CHATGPT_COMMENTARY_CLASSIFIER_BEGIN
      // Self-contained so the test suite can execute this exact source against a synthetic DOM;
      // it must not close over anything from the surrounding evaluate scope.
      const selectChatGptAnswerRoots = (
        markdownRoots: HTMLElement[],
        statusContainers: HTMLElement[],
        turnComplete = false,
        previouslyAnswered: HTMLElement[] = [],
      ): { commentaryRoots: HTMLElement[]; answerRoots: HTMLElement[] } => {
        const firstStatusContainer = statusContainers[0];
        const commentary = markdownRoots.filter(candidate => (
          candidate.closest("[data-streaming-response-status]") !== null
          // Chain-of-thought components carry reasoning, never the final answer, so containment is
          // a position-independent commentary signal. Position alone cannot separate "commentary
          // between two status containers" from "answer between two tool calls".
          || candidate.closest('[data-testid^="cot-v5"]') !== null
          // Only Markdown that precedes the FIRST status container is prior commentary. Keying
          // this on "some status follows me" silently reclassified answer text as commentary as
          // soon as a second tool call opened another status container below it, which both zeroed
          // the visible text and dropped every answer chunk emitted between tool calls.
          || (!previouslyAnswered.includes(candidate) && firstStatusContainer !== undefined && Boolean(
            // 4 is Node.DOCUMENT_POSITION_FOLLOWING, inlined to keep this function standalone.
            candidate.compareDocumentPosition(firstStatusContainer) & 4,
          ))
        ));
        const answerRoots = markdownRoots.filter(candidate => !commentary.includes(candidate));
        // The position arm is a live-streaming heuristic: it assumes the answer has not started
        // rendering yet. Once ChatGPT has stopped generating, a status row that rendered *below*
        // answer text strands the whole answer in the commentary channel, which surfaces it in
        // Codex's Working/commentary area and truncates the delivered answer. A completed turn with
        // no answer root at all therefore falls back to the context-derived boundary; markdown that
        // is genuinely reasoning (inside the status container or a chain-of-thought block) is still
        // refused, so this recovers stranded answers without promoting real reasoning.
        if (answerRoots.length > 0 || !turnComplete) {
          return { commentaryRoots: commentary, answerRoots };
        }
        const contextDerived = markdownRoots.filter(candidate => (
          candidate.closest("[data-streaming-response-status]") === null
          && candidate.closest('[data-testid^="cot-v5"]') === null
        ));
        if (contextDerived.length === 0) return { commentaryRoots: commentary, answerRoots };
        return {
          commentaryRoots: commentary.filter(candidate => !contextDerived.includes(candidate)),
          answerRoots: contextDerived,
        };
      };
      // CHATGPT_COMMENTARY_CLASSIFIER_END
      // A rendered copy action is ChatGPT's completed-turn marker, and it is independent of how the
      // Markdown roots are classified. Read it before classification so the completed-turn recovery
      // above can use it.
      const turnCompleted = [...root.querySelectorAll<HTMLElement>(options.completionActionSelector)]
        .some(candidate => renderedInDom(candidate));
      const classified = selectChatGptAnswerRoots(
        allMarkdownRoots, streamingStatusContainers, turnCompleted,
        allMarkdownRoots.filter(candidate => observerState.answerRoots.has(candidate)),
      );
      for (const candidate of classified.answerRoots) observerState.answerRoots.add(candidate);
      const commentaryRoots = classified.commentaryRoots;
      const renderedRoots = classified.answerRoots;
      // ChatGPT may merge adjacent `.markdown` roots or virtualize an old prefix while a streamed
      // answer is finalized. Root boundaries and visible indices therefore are not identity:
      // flatten semantic blocks and preserve ChatGPT's source ranges across that reparenting.
      const flattenedMarkdownSegments: Array<{
        tag: string;
        html: string;
        text: string;
        group?: string;
        sourceStart?: number;
        sourceEnd?: number;
      }> = [];
      const blockMarkdownTags = new Set([
        "address", "article", "aside", "blockquote", "div", "dl", "fieldset", "figcaption",
        "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr",
        "li", "main", "nav", "ol", "p", "pre", "section", "table", "ul",
      ]);
      let listGroupIndex = 0;
      const sourceRange = (candidate: Element): { sourceStart: number; sourceEnd: number } | undefined => {
        const startAttribute = candidate.getAttribute("data-start");
        const endAttribute = candidate.getAttribute("data-end");
        if (startAttribute === null || endAttribute === null) return undefined;
        if (!startAttribute.trim() || !endAttribute.trim()) return undefined;
        const sourceStart = Number(startAttribute);
        const sourceEnd = Number(endAttribute);
        return Number.isFinite(sourceStart) && Number.isFinite(sourceEnd) && sourceEnd >= sourceStart
          ? { sourceStart, sourceEnd }
          : undefined;
      };
      const appendBlockSegment = (child: HTMLElement) => {
        const tag = child.tagName.toLowerCase();
        const childRange = sourceRange(child);
        const listItems = tag === "ol" || tag === "ul"
          ? [...child.children].filter(candidate => candidate.tagName === "LI") as HTMLElement[]
          : [];
        if (listItems.length === 0) {
          flattenedMarkdownSegments.push({
            tag,
            html: child.outerHTML,
            text: child.innerText.trim(),
            ...childRange,
          });
          return;
        }

        const group = childRange
          ? `list:${childRange.sourceStart}:${tag}`
          : `list:${listGroupIndex++}:${tag}`;
        const orderedStart = tag === "ol" ? Number(child.getAttribute("start") ?? "1") : undefined;
        listItems.forEach((item, itemIndex) => {
          const shell = child.cloneNode(false) as HTMLElement;
          shell.removeAttribute("data-is-last-node");
          if (orderedStart !== undefined && Number.isFinite(orderedStart)) {
            shell.setAttribute("start", String(orderedStart + itemIndex));
          }
          shell.append(item.cloneNode(true));
          flattenedMarkdownSegments.push({
            tag: `${tag}:item`,
            html: shell.outerHTML,
            text: item.innerText.trim(),
            group,
            ...sourceRange(item),
          });
        });
      };
      renderedRoots.forEach((markdownRoot) => {
        const children = [...markdownRoot.children] as HTMLElement[];
        const hasBlockChildren = children.some(child => blockMarkdownTags.has(child.tagName.toLowerCase()));
        if (!hasBlockChildren) {
          if (markdownRoot.innerHTML.trim()) flattenedMarkdownSegments.push({
            tag: "root",
            html: markdownRoot.innerHTML,
            text: markdownRoot.innerText.trim(),
            ...sourceRange(markdownRoot),
          });
          return;
        }

        let inlineRun: Node[] = [];
        const flushInlineRun = () => {
          if (inlineRun.length === 0) return;
          const nodes = inlineRun;
          inlineRun = [];
          const shell = document.createElement("span");
          nodes.forEach(node => shell.append(node.cloneNode(true)));
          const text = shell.textContent?.trim() ?? "";
          if (text) {
            const rangedElements = nodes.flatMap(node => node instanceof Element
              ? [node, ...node.querySelectorAll<HTMLElement>("[data-start][data-end]")]
              : []);
            const ranges = rangedElements
              .map(sourceRange)
              .filter((range): range is { sourceStart: number; sourceEnd: number } => range !== undefined);
            flattenedMarkdownSegments.push({
              tag: "inline",
              html: shell.outerHTML,
              text,
              ...(ranges.length > 0 ? {
                sourceStart: Math.min(...ranges.map(range => range.sourceStart)),
                sourceEnd: Math.max(...ranges.map(range => range.sourceEnd)),
              } : {}),
            });
          }
        };

        markdownRoot.childNodes.forEach((node) => {
          if (node instanceof HTMLElement && blockMarkdownTags.has(node.tagName.toLowerCase())) {
            flushInlineRun();
            appendBlockSegment(node);
            return;
          }
          inlineRun.push(node);
        });
        flushInlineRun();
      });
      const markdownSegments = flattenedMarkdownSegments.map((segment, index, segments) => ({
        key: segment.sourceStart !== undefined
          ? `${segment.sourceStart}:${segment.tag}`
          : `${index}:${segment.tag}`,
        tag: segment.tag,
        html: segment.html,
        text: segment.text,
        ...(segment.group ? { group: segment.group } : {}),
        ...(segment.sourceStart !== undefined ? { sourceStart: segment.sourceStart } : {}),
        ...(segment.sourceEnd !== undefined ? { sourceEnd: segment.sourceEnd } : {}),
        streamable: index < segments.length - 1,
      }));
      const rendered = renderedRoots.at(-1);
      const completionAction = rendered
        ? [...root.querySelectorAll<HTMLElement>(options.completionActionSelector)]
          .filter(renderedInDom)
          .find(candidate => !rendered.contains(candidate)
            && Boolean(rendered.compareDocumentPosition(candidate) & Node.DOCUMENT_POSITION_FOLLOWING))
        : undefined;
      const completionActionSet = new Set(completionAction ? [completionAction] : []);
      const candidates = new Map<HTMLElement, ChatGptVisibleTraceBlock["kind"]>();
      renderedRoots.forEach(candidate => candidates.set(candidate, "answer"));
      commentaryRoots.forEach(candidate => candidates.set(candidate, "commentary"));
      const overlapsRenderedAnswer = (candidate: HTMLElement): boolean => renderedRoots.some(rendered => (
        candidate.contains(rendered) || rendered.contains(candidate)
      ));
      const overlapsCommentary = (candidate: HTMLElement): boolean => commentaryRoots.some(commentary => (
        candidate.contains(commentary) || commentary.contains(candidate)
      ));
      const statusSemantic = (candidate: HTMLElement): HTMLElement => {
        // Current cot-v5 action rows expose the semantic text on their item anchor while the
        // discoverable data-testid lives on a textless icon below it. Promote that descendant to
        // the owned row; otherwise every non-button action is silently filtered as empty text.
        return candidate.closest<HTMLElement>("button")
          ?? candidate.closest<HTMLElement>("[data-item-anchor]")
          ?? candidate;
      };
      const traceText = (candidate: HTMLElement): string => {
        const ariaLabel = candidate.getAttribute("aria-label")?.trim();
        if (ariaLabel) return ariaLabel;
        const descendantAriaLabel = [...candidate.querySelectorAll<HTMLElement>("[aria-label]")]
          .map(element => element.getAttribute("aria-label")?.replace(/\s+/g, " ").trim() ?? "")
          .find(Boolean);
        if (descendantAriaLabel) return descendantAriaLabel;
        // Animated ChatGPT action counters visually split a phrase around the changing number, so
        // `innerText` can become `Searching websites\n3`. The button's screen-reader label already
        // carries the stable semantic phrase (`Searching 3 websites`) without enclosing unrelated
        // commentary from the surrounding streaming-status container.
        const screenReaderText = [...candidate.querySelectorAll<HTMLElement>(".sr-only")]
          .map(element => element.textContent?.replace(/\s+/g, " ").trim() ?? "")
          .find(Boolean);
        return screenReaderText || candidate.innerText.trim();
      };
      const traceKey = (candidate: HTMLElement, kind: ChatGptVisibleTraceBlock["kind"]): string | undefined => {
        const statusContainer = candidate.closest<HTMLElement>("[data-streaming-response-status]");
        const itemAnchor = candidate.closest<HTMLElement>("[data-item-anchor]");
        if (!statusContainer || !itemAnchor) return undefined;
        const anchorIdentity = itemAnchor.getAttribute("data-item-anchor")?.trim();
        if (anchorIdentity) return `${kind}:anchor:${anchorIdentity}`;
        const anchorIndex = [...statusContainer.querySelectorAll<HTMLElement>("[data-item-anchor]")]
          .indexOf(itemAnchor);
        return anchorIndex >= 0 ? `${kind}:anchor:${anchorIndex}` : undefined;
      };
      const hasFollowingRenderedSibling = (candidate: HTMLElement): boolean => {
        const itemAnchor = candidate.closest<HTMLElement>("[data-item-anchor]");
        for (
          let sibling = itemAnchor?.nextElementSibling;
          sibling;
          sibling = sibling.nextElementSibling
        ) {
          if (sibling instanceof HTMLElement && renderedInDom(sibling) && sibling.innerText.trim()) {
            return true;
          }
        }
        return false;
      };
      root.querySelectorAll<HTMLElement>(
        'button, [role="status"], [aria-busy="true"], [data-testid*="cot"], [data-testid*="reason"], [data-testid*="thought"]',
      ).forEach(candidate => {
        if (completionActionSet.has(candidate)) return;
        if (overlapsRenderedAnswer(candidate) || overlapsCommentary(candidate)) return;
        const semantic = statusSemantic(candidate);
        // A renderer may wrap the final Markdown in a reason/status container. That wrapper and
        // its descendants still belong exclusively to the final-answer stream; assigning either
        // side to the trace stream duplicates or truncates the answer under Codex's `Working` UI.
        if (!overlapsRenderedAnswer(semantic)
          && !overlapsCommentary(semantic)
          && !candidates.has(semantic)) {
          candidates.set(semantic, "status");
        }
      });
      // Current ChatGPT work/tool rows can be bare item anchors with no button/role/testid on the
      // owned element itself. Enumerate them explicitly so short-lived visible progress is not
      // silently absent from the Codex Working timeline.
      root.querySelectorAll<HTMLElement>("[data-streaming-response-status] [data-item-anchor]").forEach(candidate => {
        if (completionActionSet.has(candidate)) return;
        if (overlapsRenderedAnswer(candidate) || overlapsCommentary(candidate)) return;
        if (!candidates.has(candidate)) candidates.set(candidate, "status");
      });
      root.querySelectorAll<HTMLElement>("[data-streaming-response-status]").forEach(container => {
        if (!overlapsRenderedAnswer(container)
          && !overlapsCommentary(container)
          && ![...candidates.keys()].some(candidate => container.contains(candidate))) {
          candidates.set(container, "status");
        }
      });
      const traceByKey = new Map<string, ChatGptVisibleTraceBlock>();
      [...candidates]
        .filter(([candidate]) => renderedInDom(candidate))
        .sort(([left], [right]) => left === right
          ? 0
          : left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)
        .map(([candidate, kind]) => ({
          kind,
          text: traceText(candidate),
          key: traceKey(candidate, kind),
          ...((kind === "commentary" || candidate.closest("[data-item-anchor]"))
            ? { complete: hasFollowingRenderedSibling(candidate) }
            : {}),
          // Footer controls such as the model picker and overflow menu are siblings of the final
          // Markdown inside the assistant turn. They are UI, not model trace. Real action buttons
          // are scoped by ChatGPT's streaming-status container.
          uiControl: candidate.matches("button")
            && candidate.closest("[data-streaming-response-status]") === null
            && candidate.closest("[data-item-anchor]") === null
            && candidate.closest('[data-testid^="cot"], [data-testid*="reason"], [data-testid*="thought"]') === null
            && candidate.getAttribute("role") !== "status"
            && candidate.getAttribute("aria-busy") !== "true",
        }))
        .filter(block => block.text.length > 0)
        .forEach((block, index) => {
          const key = block.key ?? `${block.kind}:fallback:${index}`;
          const previous = traceByKey.get(key);
          if (!previous || block.text.length > previous.text.length) traceByKey.set(key, block);
        });
      const traceBlocks = [...traceByKey.values()].map((block, index, blocks) => ({
        ...block,
        ...((block.kind === "commentary" || (block.kind === "status" && block.complete !== undefined)) ? {
          complete: block.complete === true || index < blocks.length - 1,
        } : {}),
      }));
      const stoppedThinkingVisible = (() => {
        // Only response UI status may terminate the turn. Quoted answer/reasoning text, code and
        // blockquotes containing the same phrase are ordinary model content.
        const isStatus = (candidate: HTMLElement): boolean => {
          if (overlapsRenderedAnswer(candidate) || overlapsCommentary(candidate)
            || candidate.closest("pre, code, blockquote")) return false;
          for (let element: HTMLElement | null = candidate; element; element = element.parentElement) {
            if (!renderedInDom(element)) return false;
          }
          return true;
        };
        const ariaMatch = [...root.querySelectorAll<HTMLElement>('[aria-label="Stopped thinking"]')]
          .some(isStatus);
        if (ariaMatch) return true;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (node.textContent?.replace(/\s+/g, " ").trim() !== "Stopped thinking") continue;
          const parent = node.parentElement;
          if (parent && isStatus(parent)) return true;
        }
        return false;
      })();
      return {
        key: observerKey,
        snapshot: {
          responsePresent: true,
          visibleText: renderedRoots.map(candidate => candidate.innerText.trim()).filter(Boolean).join("\n\n"),
          fullHtml: renderedRoots.map(candidate => candidate.innerHTML).join(""),
          markdownSegments,
          completionActionVisible: completionAction !== undefined,
          stoppedThinkingVisible,
          traceBlocks,
        },
      };
    }, {
      completionActionSelector: CHATGPT_COMPLETION_ACTION_SELECTOR,
      knownKey: cache?.key,
      attributeFilter: [...CHATGPT_DOM_REVISION_ATTRIBUTES],
    }, { timeout: 2_000 }).catch(() => undefined);
    if (!observed) {
      if (responseTurn.page().isClosed()) {
        throw chatGptBrowserTabClosedError();
      }
      return absentResponseDomSnapshot();
    }
    const snapshot = observed.snapshot ?? cache?.snapshot ?? absentResponseDomSnapshot();
    if (observed.snapshot && cache) {
      cache.key = observed.key;
      cache.snapshot = observed.snapshot;
      cache.fullScans = (cache.fullScans ?? 0) + 1;
    } else if (!observed.snapshot && cache?.snapshot) {
      cache.cacheHits = (cache.cacheHits ?? 0) + 1;
    }
    snapshot.traceBlocks = snapshot.traceBlocks
      .map(stripChatGptTraceControlSuffix)
      .filter(block => block.text.length > 0 && !isChatGptTraceControl(block));
    return snapshot;
  }

  private async waitForResponseDomMutation(
    responseTurn: Locator,
    knownKey: string | undefined,
    cache: ChatGptResponseDomCache,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!knownKey) {
      await withBrowserTurnAbort(
        new Promise(resolveSleep => setTimeout(resolveSleep, CHATGPT_RESPONSE_DOM_MIN_OBSERVATION_INTERVAL_MS)),
        signal,
      );
      return;
    }
    cache.mutationWaits = (cache.mutationWaits ?? 0) + 1;
    const outcome = await withBrowserTurnAbort(responseTurn.evaluate(async (element, options) => {
      type ObserverState = {
        id: number;
        revision: number;
        observer: MutationObserver;
        waiters?: Set<() => void>;
      };
      type ObserverRegistry = { documentId: string; nextId: number; states: WeakMap<Element, ObserverState> };
      const scope = globalThis as typeof globalThis & {
        __CODEX_WEB_GPT_RESPONSE_OBSERVERS__?: ObserverRegistry;
      };
      const startedAt = performance.now();
      const floorDelay = async () => {
        const remaining = options.minimumWaitMs - (performance.now() - startedAt);
        if (remaining > 0) await new Promise(resolveDelay => setTimeout(resolveDelay, remaining));
      };
      const registry = scope.__CODEX_WEB_GPT_RESPONSE_OBSERVERS__;
      const state = registry?.states.get(element);
      if (!registry || !state) {
        await floorDelay();
        return "unavailable" as const;
      }
      state.waiters ??= new Set<() => void>();
      const currentKey = () => `${registry.documentId}:${state.id}:${state.revision}`;
      if (currentKey() !== options.knownKey) {
        await floorDelay();
        return "mutation" as const;
      }
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      let wake: (() => void) | undefined;
      const outcome = await new Promise<"mutation" | "timeout">(resolveWait => {
        let settled = false;
        const finish = (value: "mutation" | "timeout") => {
          if (settled) return;
          settled = true;
          if (timeoutTimer) clearTimeout(timeoutTimer);
          if (wake) state.waiters?.delete(wake);
          resolveWait(value);
        };
        wake = () => finish("mutation");
        state.waiters?.add(wake);
        // Close the classic lost-wakeup window between the first revision read and waiter install.
        if (currentKey() !== options.knownKey) finish("mutation");
        else timeoutTimer = setTimeout(() => finish("timeout"), options.timeoutMs);
      });
      await floorDelay();
      return outcome;
    }, {
      knownKey,
      minimumWaitMs: CHATGPT_RESPONSE_DOM_MIN_OBSERVATION_INTERVAL_MS,
      timeoutMs: CHATGPT_RESPONSE_DOM_IDLE_WAIT_MS,
    }, { timeout: 2_000 }), signal).catch(error => {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      return "unavailable" as const;
    });
    if (outcome === "mutation") cache.mutationWakeups = (cache.mutationWakeups ?? 0) + 1;
    else if (outcome === "timeout") cache.mutationTimeouts = (cache.mutationTimeouts ?? 0) + 1;
    else {
      // A detached/rebound response locator can reject evaluate before the page-side floor delay is
      // installed. Keep the old observation cadence as the fallback so rebind churn cannot spin.
      await withBrowserTurnAbort(
        new Promise(resolveSleep => setTimeout(resolveSleep, CHATGPT_RESPONSE_DOM_MIN_OBSERVATION_INTERVAL_MS)),
        signal,
      );
    }
  }

  private async stalledTurnDiagnostic(page: Page, responseTurn: Locator): Promise<string> {
    const responseState = await responseTurn.count()
      ? await responseTurn.evaluate(element => {
        const root = element as HTMLElement;
        const descriptors = [...root.querySelectorAll<HTMLElement>("[role], [data-testid], button, [aria-label]")]
          .filter(candidate => {
            const style = getComputedStyle(candidate);
            return style.visibility !== "hidden" && style.display !== "none";
          })
          .slice(-80)
          .map(candidate => ({
            tag: candidate.tagName.toLowerCase(),
            role: candidate.getAttribute("role"),
            testId: candidate.getAttribute("data-testid"),
            ariaLabelChars: candidate.getAttribute("aria-label")?.length ?? 0,
            titleChars: candidate.getAttribute("title")?.length ?? 0,
            textChars: (candidate.innerText ?? candidate.textContent ?? "").trim().length,
          }));
        return {
          textChars: (root.innerText ?? root.textContent ?? "").trim().length,
          htmlChars: root.innerHTML.length,
          descriptors,
        };
      })
      : { text: "", descriptors: [] };
    const overlays = await page.locator('[role="dialog"], [role="alert"], [role="status"]').evaluateAll(elements => (
      elements
        .filter(element => {
          const candidate = element as HTMLElement;
          const style = getComputedStyle(candidate);
          return style.visibility !== "hidden" && style.display !== "none";
        })
        .slice(-30)
        .map(element => {
          const candidate = element as HTMLElement;
          return {
            role: candidate.getAttribute("role"),
            testId: candidate.getAttribute("data-testid"),
            ariaLabelChars: candidate.getAttribute("aria-label")?.length ?? 0,
            textChars: (candidate.innerText ?? candidate.textContent ?? "").trim().length,
          };
        })
    )).catch(() => [] as Array<Record<string, string | null>>);
    return redactChatGptUiDiagnostic(JSON.stringify({ response: responseState, overlays }));
  }

  private async runExclusive(turn: BrowserTurn): Promise<string> {
    if (turn.abortSignal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
    if (this.config.browserHost !== "launcher") return this.runBrowserTurn(turn);

    const lease = await notifyLauncherTurn(this.config.browserHostDescriptorPath!, {
      phase: "start",
      traceId: turn.traceId,
      helperPid: process.pid,
      ...(turn.conversationKey ? { conversationKey: turn.conversationKey } : {}),
      ...((turn.nativeConnector || turn.capabilities.localToolsEnabled || turn.requireRetainedConversation)
        ? { connectorIdentity: this.config.appName }
        : {}),
      ...(turn.requireRetainedConversation ? { requireRetainedConversation: true } : {}),
      resumeAvailable: turn.prepareResume !== undefined,
      modelId: turn.modelId,
      ...(turn.reasoning ? { reasoning: turn.reasoning } : {}),
    }).catch(error => {
      if (error instanceof LauncherBrowserTurnCancelledError) throw chatGptBrowserTabClosedError();
      if (error instanceof LauncherRetainedConversationUnavailableError) {
        throw chatGptRetainedConversationUnavailableError();
      }
      throw error;
    });
    const surfaceId = lease.surfaceId;
    const reused = lease.reused === true;
    let sendPermitted = false;
    let terminal: "completed" | "failed" | "aborted" = "completed";
    let terminalMessage: string | undefined;
    let originalError: unknown;
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    let heartbeatInFlight = false;
    let lastHeartbeatFailureAt = 0;
    const sendHeartbeat = () => {
      if (heartbeatInFlight) return;
      heartbeatInFlight = true;
      void notifyLauncherTurn(this.config.browserHostDescriptorPath!, {
        phase: "heartbeat",
        traceId: turn.traceId,
        helperPid: process.pid,
      }, LAUNCHER_TURN_HEARTBEAT_TIMEOUT_MS).catch(error => {
        const now = Date.now();
        if (now - lastHeartbeatFailureAt < 30_000) return;
        lastHeartbeatFailureAt = now;
        console.warn(
          `[chatgpt-web] launcher turn heartbeat failed for ${turn.traceId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }).finally(() => {
        heartbeatInFlight = false;
      });
    };
    try {
      if (!surfaceId) throw new Error("Launcher did not lease a browser tab for the ChatGPT turn");
      if (turn.requireRetainedConversation && !reused) {
        throw chatGptRetainedConversationUnavailableError();
      }
      if (reused && !turn.prepareResume) {
        throw new Error("Launcher reused a ChatGPT conversation without a continuation prompt");
      }
      await turn.onPreparedSelected?.(reused);
      heartbeatTimer = setInterval(sendHeartbeat, LAUNCHER_TURN_HEARTBEAT_INTERVAL_MS);
      heartbeatTimer.unref?.();
      return await this.runBrowserTurn(
        { ...turn, onSendActivated: async () => {
          await turn.onSendActivated?.();
          sendPermitted = true;
        } },
        surfaceId,
        undefined,
        reused,
        lease.effortPrepared === true,
        lease.connectorBound === true,
        lease.connectorPluginId,
      );
    } catch (error) {
      originalError = error;
      terminal = (error instanceof DOMException && error.name === "AbortError")
        || (error instanceof ChatGptWebAdapterError && error.code === "client_cancelled")
        ? "aborted"
        : "failed";
      terminalMessage = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
      throw error;
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      try {
        const retainAfterAbort = terminal === "aborted" && turn.retainConversationOnAbort?.() === true;
        const unsubmitted = retainAfterAbort && !reused && !sendPermitted;
        const release = await notifyLauncherTurn(this.config.browserHostDescriptorPath!, {
          phase: "end",
          traceId: turn.traceId,
          helperPid: process.pid,
          status: terminal,
          ...(terminalMessage ? { message: terminalMessage } : {}),
          ...((terminal === "completed" && turn.retainConversation) || retainAfterAbort ? { retain: true } : {}),
          ...(unsubmitted ? { unsubmitted: true } : {}),
          ...(!unsubmitted && (terminal === "completed" || retainAfterAbort) && (turn.nativeConnector || turn.capabilities.localToolsEnabled)
            ? { connectorBound: true }
            : {}),
        });
        if (release.cancelledByUser) throw chatGptBrowserTabClosedError();
      } catch (controlError) {
        if (controlError instanceof ChatGptWebAdapterError && controlError.code === "client_cancelled") {
          throw controlError;
        }
        if (!originalError) throw controlError;
        console.error(
          `[chatgpt-web] launcher turn-end notification failed after browser error: ${controlError instanceof Error ? controlError.message : String(controlError)}`,
        );
      }
    }
  }

  private async runBrowserTurn(
    turn: BrowserTurn,
    launcherSurfaceId?: string,
    maintenancePage?: Page,
    reuseConversation = false,
    prewarmedMode = false,
    prewarmedConnector = false,
    connectorPluginId?: string,
  ): Promise<string> {
    if (turn.abortSignal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
    if ((turn.externalProgress !== undefined) !== (turn.completionFence !== undefined)) {
      throw new Error("Tool-capable ChatGPT turns require both progress and terminal-fence transports");
    }
    if ((turn.captureLunaCheckpoint === true) !== (turn.onLunaCheckpoint !== undefined)) {
      throw new Error("ChatGPT Luna checkpoint capture requires exactly one checkpoint callback");
    }
    if (turn.captureLunaCheckpoint && turn.modelId !== CHATGPT_WEB_LUNA_MODEL_ID) {
      throw new Error("Private rolling checkpoint capture is valid only for ChatGPT Luna");
    }
    const browserCapabilities = turn.nativeConnector
      ? { ...turn.capabilities, localToolsEnabled: true }
      : turn.capabilities;
    const requestedMode = resolveChatGptWebModelMode(turn.modelId, turn.reasoning, browserCapabilities);
    const prepare = reuseConversation ? turn.prepareResume : turn.prepare;
    if (!prepare) throw new Error("The retained ChatGPT conversation has no continuation prompt");
    const prepared = await prepare();
    const diagnostics = new ChatGptBrowserDiagnostics(
      turn.traceId,
      this.config.browserDiagnosticsPath ?? join(getConfigDir(), "diagnostics", "browser-turns"),
    );
    let turnConnection: Browser | undefined;
    let requestObservationConnection: Browser | undefined;
    let requestObservation: ChatGptRecoveryRequestObserver | undefined;
    let browserWideRequestObservation: ChatGptRecoveryBrowserWideRequestObserver | undefined;
    let managedPage: Page | undefined;
    let diagnosticPage: Page | undefined;
    let webStreamTap: ChatGptWebStreamTap | undefined;
    let wireCapture: ChatGptWireCapture | undefined;
    let stopRecoveryWireObservation: (() => void) | undefined;
    let earlyRecoverySampler: ChatGptRecoveryMessageSampler | undefined;
    let earlyRecoverySampling: Promise<void> | undefined;
    let generationTurnIdContinuityToken: string | undefined;
    let generationTurnIdContinuityStarted = false;
    let generationTurnIdContinuityResult: ChatGptRecoveryTurnIdMutationContinuityResult | undefined;
    let requestInjectionShadow: ChatGptRequestInjectionShadow | undefined;
    let requestInjectionCdpShadow: ChatGptCdpRequestInjectionShadow | undefined;
    let requestInjectionCdpInjector: ChatGptCdpRequestInjector | undefined;
    let requestInjector: ChatGptRequestInjector | undefined;
    // Multipart stages rewrite their own request body so the composer never holds a payload.
    let stageRequestInjector: ChatGptRequestInjector | undefined;
    const submissionDisposition = new ChatGptSubmissionDispositionTracker();
    const captureDisposition = new ChatGptCaptureDispositionTracker();
    const recoveryIdentity = new ChatGptTurnRecoveryIdentityTracker(launcherSurfaceId);
    const trackedSubmissionLifecycle: Pick<BrowserTurn, "onSendActivated" | "onSubmitted"> = {
      onSendActivated: async () => {
        submissionDisposition.sendActivated();
        await turn.onSendActivated?.();
      },
      onSubmitted: () => {
        submissionDisposition.submitted();
        recoveryIdentity.commitSubmission();
        turn.onSubmitted?.();
      },
    };
    try {
      if (turn.abortSignal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
      const multipartTransactionId = prepared.multipart
        ? `ctx_${randomUUID().replaceAll("-", "")}`
        : undefined;
      const multipartStages = prepared.multipart && multipartTransactionId
        ? prepared.multipart.parts.slice(0, -1).map((payload, index) => formatChatGptWebMultipartStage(
          payload,
          multipartTransactionId,
          index + 1,
          prepared.multipart!.parts.length,
        ))
        : undefined;
      const multipartFinalPrompt = prepared.multipart && multipartTransactionId
        ? formatChatGptWebMultipartCommit(prepared.multipart, multipartTransactionId)
        : undefined;
      const estimatedInputTokens = estimateCompiledChatGptWebInputTokens(prepared, turn.modelId);
      const estimatedMessageTokens = estimateCompiledChatGptWebMessageTokens(prepared, turn.modelId);
      const maxMessageChars = compiledChatGptWebMaxMessageChars(prepared);
      const maxStageMessageTokens = multipartStages
        ? Math.max(...multipartStages.map(stage => estimateTokens(stage.text, turn.modelId)))
        : undefined;
      const maxStageChars = multipartStages
        ? Math.max(...multipartStages.map(stage => stage.text.length))
        : undefined;
      const stagingMode = multipartStages
        ? resolveChatGptWebMultipartStagingMode(
          turn.modelId,
          browserCapabilities,
          requestedMode.effort,
          maxStageMessageTokens!,
          maxStageChars!,
        )
        : requestedMode;
      const turnPlan = resolveChatGptTurnPlan({
        features: {
          requestInjectionPrimary: chatGptRequestInjectionPrimaryEnabled(),
          requestInjectionShadow: chatGptRequestInjectionShadowEnabled(),
          requestInjectionCdpShadow: chatGptRequestInjectionCdpShadowEnabled(),
          requestInjectionCdpPrimary: chatGptRequestInjectionCdpPrimaryEnabled(),
          networkStreamPrimary: chatGptNetworkStreamPrimaryEnabled(),
          networkStreamShadow: chatGptNetworkStreamShadowEnabled(),
          incompleteCaptureRecovery: chatGptIncompleteCaptureRecoveryEnabled(),
          domObservationCadenceCanary: process.env.CODEX_CHATGPT_WEB_DOM_CADENCE_CANARY === "1",
        },
        multipart: prepared.multipart !== undefined,
        imageCount: prepared.images.length,
        localTools: requestedMode.localTools,
        reuseConversation,
        compaction: turn.compaction === true,
        captureLunaCheckpoint: turn.captureLunaCheckpoint === true,
        requestedEffort: requestedMode.effort,
        stagingEffort: stagingMode.effort,
        prewarmedMode,
        externalProgress: turn.externalProgress !== undefined,
        completionFence: turn.completionFence !== undefined,
        launcherOwnedSurface: launcherSurfaceId !== undefined,
      });
      if (prepared.multipart) {
        assertChatGptWebMultipartInputWithinLimits(
          estimatedInputTokens,
          estimatedMessageTokens,
          turn.modelId,
          requestedMode.effort,
          browserCapabilities,
          maxMessageChars,
          prepared.multipart.parts.length,
          multipartStages
            && multipartFinalPrompt
            && maxStageMessageTokens !== undefined
            && maxStageChars !== undefined ? {
            stagingEffort: stagingMode.effort,
            maxStageMessageTokens,
            maxStageChars,
            finalMessageTokens: estimateTokens(multipartFinalPrompt, turn.modelId),
            finalMessageChars: multipartFinalPrompt.length,
          } : undefined,
        );
      } else {
        assertChatGptWebInputWithinLimits(
          estimatedInputTokens,
          estimatedMessageTokens,
          turn.modelId,
          requestedMode.effort,
          browserCapabilities,
          maxMessageChars,
        );
      }
      const deadline = this.config.turnTimeoutMs === undefined
        ? undefined
        : Date.now() + this.config.turnTimeoutMs;
      let page = await this.runStage(turn.traceId, "browser_page", browserStageTimeouts.browserPage, async (abortSignal) => {
        if (maintenancePage) return maintenancePage;
        if (!launcherSurfaceId) {
          const managed = await this.pageForNewTurn();
          if (abortSignal.aborted) {
            await managed.close().catch(() => {});
            throw new DOMException("ChatGPT browser page acquisition aborted", "AbortError");
          }
          return managed;
        }
        const connection = await connectLauncherBrowserHost(
          this.config.browserHostDescriptorPath!,
          browserStageTimeouts.browserPage,
          launcherSurfaceId,
          abortSignal,
        );
        if (abortSignal.aborted) {
          await connection.browser.close().catch(() => {});
          throw new DOMException("ChatGPT browser page acquisition aborted", "AbortError");
        }
        turnConnection = connection.browser;
        await waitForOperationalChatGptViewport(connection.page, abortSignal);
        return connection.page;
      });
      if (!maintenancePage && !launcherSurfaceId) managedPage = page;
      diagnosticPage = page;
      const rebindLauncherPage = async (attempt: number, cause: Error, diagnosticSignal?: AbortSignal): Promise<void> => {
        const completedDiagnostic = diagnosticSignal !== undefined;
        if (!launcherSurfaceId || !this.config.browserHostDescriptorPath) throw cause;
        const diagnosticBudget = (): number => {
          if (turn.abortSignal?.aborted || diagnosticSignal?.aborted) throw new Error("completed diagnostic aborted");
          const remaining = deadline === undefined ? 15_000 : Math.min(15_000, deadline - Date.now());
          if (remaining <= 0) throw new Error("completed diagnostic deadline exhausted");
          return remaining;
        };
        console.warn(
          `[chatgpt-web] browser turn ${turn.traceId} is rebinding its existing launcher page (${completedDiagnostic ? "completed-turn diagnostic" : "stalled DOM probe"}):`
          + ` ${redactChatGptUiDiagnostic(cause.message)}`,
        );
        const previousConnection = turnConnection;
        // The observation timeout races the Playwright operation but cannot cancel the underlying
        // page.evaluate by itself. A failed disconnect is terminal: opening a replacement while
        // the stale probe still owns its transport would recreate the contention this rebind is
        // meant to remove.
        const connection = await connectAfterClosingBrowserConnection(
          completedDiagnostic && previousConnection ? {
            close: () => withBrowserTurnAbort(withChatGptBrowserObservationTimeout(previousConnection.close(), diagnosticBudget()), diagnosticSignal),
          } : previousConnection,
          () => {
            if (diagnosticSignal?.aborted) throw new Error("completed diagnostic aborted");
            turnConnection = undefined;
            return this.runStage(
              turn.traceId,
              `response_page_rebind_${attempt}`,
              completedDiagnostic ? diagnosticBudget() : browserStageTimeouts.browserPage,
              async (stageSignal) => {
                try {
                const signal = AbortSignal.any([stageSignal, ...(turn.abortSignal ? [turn.abortSignal] : []),
                  ...(diagnosticSignal ? [diagnosticSignal] : [])]);
                await notifyLauncherTurn(this.config.browserHostDescriptorPath!, {
                  phase: "heartbeat",
                  traceId: turn.traceId,
                  helperPid: process.pid,
                  refreshViewport: true,
                }, undefined, diagnosticSignal);
                if (signal.aborted) throw new Error("reconnect aborted before attach");
                const rebound = await connectLauncherBrowserHost(
                  this.config.browserHostDescriptorPath!,
                  browserStageTimeouts.browserPage,
                  launcherSurfaceId,
                  signal,
                );
                try {
                  await waitForOperationalChatGptViewport(rebound.page, signal);
                  if (signal.aborted) throw new Error("reconnect aborted after attach");
                } catch (error) {
                  if (completedDiagnostic) await rebound.browser.close().catch(() => {});
                  throw error;
                }
                return rebound;
                } catch (error) {
                  // runStage logs errors; redact before crossing that boundary.
                  if (completedDiagnostic) throw new Error("completed diagnostic reconnect failed");
                  throw error;
                }
              },
            );
          },
        );
        if (diagnosticSignal?.aborted) {
          await connection.browser.close().catch(() => {});
          throw new Error("completed diagnostic aborted before page replacement");
        }
        turnConnection = connection.browser;
        page = connection.page;
        diagnosticPage = page;
        console.warn(
          `[chatgpt-web] browser turn ${turn.traceId} rebound its existing launcher page (${completedDiagnostic ? "completed-turn diagnostic" : "stalled DOM probe"})`,
        );
      };
      await diagnostics.capture(page, "browser-page-acquired");
      console.info(
        `[chatgpt-web] browser turn ${turn.traceId} opened (transport=${prepared.multipart ? `multipart-${prepared.multipart.parts.length}` : "inline"}, maxMessageChars=${maxMessageChars}, estimatedInputTokens=${estimatedInputTokens}, images=${prepared.images.length}, compactionTrimmedMessages=${prepared.trimmedCompactionMessages ?? 0})`,
      );
      if (!reuseConversation) {
        await this.runStage(
          turn.traceId,
          "temporary_chat_preparation",
          browserStageTimeouts.temporaryChatPreparation,
          () => this.prepareTemporaryChatSurface(
            page,
            checkpoint => diagnostics.capture(page, checkpoint),
          ),
        );
      }
      const directRequestMode = turnPlan.requestInjection === "primary"
        && !reuseConversation
        && turn.modelId === CHATGPT_WEB_MODEL_ID
        && prepared.images.length === 0
        ? resolveChatGptDirectRequestMode(requestedMode.effort)
        : undefined;
      const directModeRequested = directRequestMode !== undefined;
      const directConnectorRequested = directModeRequested
        && requestedMode.localTools
        && !prewarmedConnector;
      if (directConnectorRequested
        && (typeof connectorPluginId !== "string"
          || !/^plugin:[A-Za-z0-9_-]{16,128}$/.test(connectorPluginId))) {
        throw new Error("ChatGPT direct connector request requires a cached verified plugin identity");
      }
      const directConnectorMetadata = directConnectorRequested;
      let mode = requestedMode;
      if (turnPlan.initialEffortSelectionRequired && !directModeRequested) {
        mode = await this.runStage(turn.traceId, "effort_selection", browserStageTimeouts.effortSelection, () => (
          this.selectModelAndEffort(
            page,
            turn.modelId,
            stagingMode.effort,
            browserCapabilities,
            checkpoint => diagnostics.capture(page, checkpoint),
          )
        ));
      }
      await diagnostics.capture(page, "effort-selection-complete");

      let finalPrompt = prepared.text;
      if (prepared.multipart && multipartStages && multipartTransactionId && multipartFinalPrompt) {
        for (let index = 0; index < multipartStages.length; index += 1) {
          const stage = multipartStages[index]!;
          const stageBaseline = await this.captureSubmissionBaseline(page);
          // Keep each stage payload out of the composer. The request writer swaps the body after the
          // page-fetch leaves it, so the renderer never parses or lays out the raw context records.
          if (stageRequestInjector) {
            await stageRequestInjector.close().catch(() => {});
            stageRequestInjector = undefined;
          }
          let stageAttachment = stage.text;
          if (directModeRequested) {
            const stagePlaceholder = createChatGptRequestInjectionPlaceholder(stage.text);
            try {
              stageRequestInjector = await ChatGptRequestInjector.install(
                page,
                turn.traceId,
                stagePlaceholder,
                stage.text,
                { mode: resolveChatGptDirectRequestMode(stagingMode.effort) },
              );
              stageAttachment = stagePlaceholder;
            } catch (error) {
              console.warn(
                `[chatgpt-web] browser turn ${turn.traceId} could not inject multipart stage ${index + 1}; using the DOM prompt path:`
                + ` ${redactChatGptUiDiagnostic(error instanceof Error ? error.message : String(error))}`,
              );
              stageRequestInjector = undefined;
            }
          }
          await this.runStage(
            turn.traceId,
            `multipart_stage_${index + 1}_attachment`,
            browserStageTimeouts.promptAttachment,
            (stageSignal) => this.attachPrompt(
              page,
              stageAttachment,
              false,
              checkpoint => diagnostics.capture(page, `multipart-${index + 1}-${checkpoint}`),
              turn.abortSignal ? AbortSignal.any([stageSignal, turn.abortSignal]) : stageSignal,
            ),
            chatGptSuspensionClock,
            true,
          );
          await diagnostics.capture(page, `multipart-stage-${index + 1}-attachment-complete`);
          const evidence = await this.runStage(
            turn.traceId,
            `multipart_stage_${index + 1}_send`,
            browserStageTimeouts.multipartStageSend,
            (stageSignal) => this.sendAttachedPrompt(
              page,
              stageBaseline,
              checkpoint => diagnostics.capture(page, `multipart-${index + 1}-${checkpoint}`),
              turn.abortSignal ? AbortSignal.any([stageSignal, turn.abortSignal]) : stageSignal,
            ),
          );
          const responseTurn = await this.waitForNewAssistantTurn(
            page,
            stageBaseline,
            deadline,
            turn.abortSignal,
            // A part still being ingested has produced no MCP activity, so there is no progress to
            // consult here; only the wider window applies.
            undefined,
            CHATGPT_MULTIPART_RESPONSE_DOM_GRACE_MS,
          );
          console.info(
            `[chatgpt-web] browser turn ${turn.traceId} multipart part ${index + 1}/${prepared.multipart.parts.length} submission accepted evidence=${evidence}`,
          );
          await this.waitForMultipartAcknowledgement(
            page,
            responseTurn,
            stageBaseline,
            stage,
            deadline,
            turn.abortSignal,
            turn.externalProgress,
          );
          await diagnostics.capture(page, `multipart-stage-${index + 1}-acknowledged`);
          if (stageRequestInjector) {
            await stageRequestInjector.close().catch(() => {});
            stageRequestInjector = undefined;
          }
        }
        if (mode.effort !== requestedMode.effort) {
          mode = await this.runStage(
            turn.traceId,
            "final_part_effort_selection",
            browserStageTimeouts.effortSelection,
            () => this.selectModelAndEffort(
              page,
              turn.modelId,
              requestedMode.effort,
              browserCapabilities,
              checkpoint => diagnostics.capture(page, `final-part-${checkpoint}`),
            ),
          );
          await diagnostics.capture(page, "final-part-effort-selected");
        }
        finalPrompt = multipartFinalPrompt;
      }

      let promptForAttachment = finalPrompt;
      if (turnPlan.requestInjectionCdpPrimary) {
        try {
          const placeholder = createChatGptRequestInjectionPlaceholder(finalPrompt);
          requestInjectionCdpInjector = await ChatGptCdpRequestInjector.install(
            page,
            placeholder,
            finalPrompt,
          );
          promptForAttachment = placeholder;
          console.info(`[chatgpt-web] browser turn ${turn.traceId} enabled dedicated opt-in CDP request injection canary`);
        } catch (error) {
          console.warn(
            `[chatgpt-web] browser turn ${turn.traceId} could not enable CDP request injection canary; using DOM prompt path:`
            + ` ${redactChatGptUiDiagnostic(error instanceof Error ? error.message : String(error))}`,
          );
        }
      } else if (turnPlan.requestInjection === "primary") {
        try {
          const placeholder = createChatGptRequestInjectionPlaceholder(finalPrompt);
          requestInjector = await ChatGptRequestInjector.install(
            page,
            turn.traceId,
            placeholder,
            finalPrompt,
            directModeRequested ? {
              mode: directRequestMode,
              ...(directConnectorMetadata ? {
                connector: { pluginId: connectorPluginId!, appName: this.config.appName },
              } : {}),
            } : undefined,
          );
          promptForAttachment = placeholder;
          console.info(`[chatgpt-web] browser turn ${turn.traceId} enabled opt-in request injection`);
        } catch (error) {
          console.warn(
            `[chatgpt-web] browser turn ${turn.traceId} could not enable request injection; using DOM prompt path:`
            + ` ${redactChatGptUiDiagnostic(error instanceof Error ? error.message : String(error))}`,
          );
          if (directModeRequested) {
            mode = await this.runStage(turn.traceId, "effort_selection_install_fallback", browserStageTimeouts.effortSelection, () => (
              this.selectModelAndEffort(page, turn.modelId, requestedMode.effort, browserCapabilities)
            ));
          }
          if (directConnectorMetadata) {
            await this.runStage(turn.traceId, "connector_selection_install_fallback", browserStageTimeouts.promptAttachment, () => (
              this.selectConnector(page, checkpoint => diagnostics.capture(page, "request-install-fallback-" + checkpoint), false, { triggerAttempts: 0 }, turn.abortSignal)
            ));
          }
        }
      } else if (turnPlan.requestInjection === "shadow") {
        try {
          requestInjectionShadow = await ChatGptRequestInjectionShadow.install(
            page,
            turn.traceId,
            finalPrompt,
            process.env.CODEX_CHATGPT_WEB_PROMPT_SHAPE_DIAGNOSTICS === "1",
          );
          console.info(`[chatgpt-web] browser turn ${turn.traceId} enabled request-injection compatibility shadow`);
        } catch (error) {
          console.warn(
            `[chatgpt-web] browser turn ${turn.traceId} could not enable request-injection shadow:`
            + ` ${redactChatGptUiDiagnostic(error instanceof Error ? error.message : String(error))}`,
          );
        }
      }

      let submissionBaseline = await this.captureSubmissionBaseline(page);
      let catalogRefreshAvailable = mode.localTools && !reuseConversation && !prepared.multipart;
      const connectorAttemptBudget: ChatGptConnectorAttemptBudget = { triggerAttempts: 0 };
      for (;;) {
        try {
          await this.runStage(
            turn.traceId,
            "prompt_attachment",
            browserStageTimeouts.promptAttachment,
            (stageSignal) => {
              const promptAbortSignal = turn.abortSignal
                ? AbortSignal.any([stageSignal, turn.abortSignal])
                : stageSignal;
              return this.attachPromptWithCompactionRetry(
                page,
                promptForAttachment,
                mode.localTools,
                turn.compaction === true,
                submissionBaseline,
                checkpoint => diagnostics.capture(page, checkpoint),
                promptAbortSignal,
                catalogRefreshAvailable,
                connectorAttemptBudget,
                reuseConversation || prewarmedConnector || directConnectorMetadata,
              );
            },
            chatGptSuspensionClock,
            true,
          );
          break;
        } catch (error) {
          if (!(error instanceof ChatGptConnectorCatalogStaleError) || !catalogRefreshAvailable) throw error;
          catalogRefreshAvailable = false;
          await diagnostics.capture(page, "connector-catalog-stale");
          await this.runStage(
            turn.traceId,
            "connector_catalog_refresh",
            browserStageTimeouts.temporaryChatPreparation,
            async () => {
              await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
              await this.prepareTemporaryChatSurface(
                page,
                checkpoint => diagnostics.capture(page, checkpoint),
              );
              mode = await this.selectModelAndEffort(
                page,
                turn.modelId,
                turn.reasoning,
                turn.capabilities,
                checkpoint => diagnostics.capture(page, checkpoint),
              );
              submissionBaseline = await this.captureSubmissionBaseline(page);
            },
          );
          await diagnostics.capture(page, "connector-catalog-refreshed");
        }
      }
      await diagnostics.capture(page, "prompt-attachment-complete");
      await this.runStage(turn.traceId, "file_attachment", browserStageTimeouts.fileAttachment, () => (
        this.attachFiles(page, prepared)
      ));
      await diagnostics.capture(page, "file-attachment-complete");
      if (turnPlan.requestInjectionCdpShadow) {
        try {
          requestInjectionCdpShadow = await ChatGptCdpRequestInjectionShadow.install(page, finalPrompt);
          console.info(`[chatgpt-web] browser turn ${turn.traceId} enabled default-off CDP request-injection shadow`);
        } catch (error) {
          console.warn(
            `[chatgpt-web] browser turn ${turn.traceId} could not enable CDP request-injection shadow:`
            + ` ${redactChatGptUiDiagnostic(error instanceof Error ? error.message : String(error))}`,
          );
        }
      }
      // In-flight steering can create additional network requests while preserving one browser
      // answer. Until the stream tap can bind that sequence atomically, keep the DOM as the sole
      // final-text authority for steerable turns instead of silently dropping a later stream.
      const networkStreamPrimary = turnPlan.networkStream === "primary" && !turn.steering;
      const enableNetworkStreamTap = async (): Promise<void> => {
        if (turnPlan.networkStream === "off") return;
        try {
          webStreamTap = await ChatGptWebStreamTap.install(page, turn.traceId);
          wireCapture = webStreamTap.beginCapture();
          stopRecoveryWireObservation?.();
          recoveryIdentity.observeWireSnapshot(wireCapture.snapshot());
          stopRecoveryWireObservation = wireCapture.subscribe(snapshot => {
            recoveryIdentity.observeWireSnapshot(snapshot);
          });
          console.info(`[chatgpt-web] browser turn ${turn.traceId} enabled Temporary Chat network stream shadow`);
        } catch (error) {
          console.warn(
            `[chatgpt-web] browser turn ${turn.traceId} could not enable network stream shadow:`
            + ` ${redactChatGptUiDiagnostic(error instanceof Error ? error.message : String(error))}`,
          );
        }
      };
      await enableNetworkStreamTap();
      const completedRebindEligible = !!launcherSurfaceId && !prepared.multipart && prepared.images.length === 0
        && !requestedMode.localTools && !reuseConversation && !turn.compaction
        && !turn.captureLunaCheckpoint && !turn.externalProgress && !turn.completionFence
        && turnPlan.networkStream !== "primary";
      const recoveryEvidenceEnabled = completedRebindEligible
        && (chatGptCompletedRebindDiagnosticsEnabled() || turnPlan.incompleteCaptureRecovery);
      if (recoveryEvidenceEnabled) {
        try {
          await withChatGptRecoveryDiagnosticBudget(deadline, turn.abortSignal, async signal => {
            // Independent observation connection to the SAME lease, before send. It remains open
            // across the worker's rebind; no new page, navigation, lease or submission is created.
            const connection = await connectLauncherBrowserHost(this.config.browserHostDescriptorPath!, 5_000, launcherSurfaceId, signal);
            requestObservationConnection = connection.browser;
            requestObservation = await withBrowserTurnAbort(ChatGptRecoveryRequestObserver.install(
              connection.page, Math.min(deadline ?? Infinity, Date.now() + 120_000),
            ), signal);
            browserWideRequestObservation = await withBrowserTurnAbort(ChatGptRecoveryBrowserWideRequestObserver.install(
              connection.browser, connection.context, connection.page,
              Math.min(deadline ?? Infinity, Date.now() + 120_000),
            ), signal);
          });
        } catch {
          await browserWideRequestObservation?.close().catch(() => {});
          await requestObservation?.close().catch(() => {});
          await requestObservationConnection?.close().catch(() => {});
          browserWideRequestObservation = undefined;
          requestObservation = undefined;
          requestObservationConnection = undefined;
          // Optional evidence failure cannot alter send/retry semantics; receipt remains absent.
        }
      }
      let completionTracker = new ChatGptCompletionTracker();
      const sendStartedAt = Date.now();
      let finalSubmissionEvidence: ChatGptSubmissionEvidence;
      try {
        finalSubmissionEvidence = await this.runStage(
          turn.traceId,
          "send",
          // A multipart commit lands on a conversation already carrying every staged part, so it
          // needs the same acceptance headroom the stages themselves get.
          prepared.multipart ? browserStageTimeouts.multipartStageSend : browserStageTimeouts.send,
          (stageSignal) => this.sendAttachedPrompt(
            page,
            submissionBaseline,
            checkpoint => diagnostics.capture(page, checkpoint),
            turn.abortSignal ? AbortSignal.any([stageSignal, turn.abortSignal]) : stageSignal,
            turn.externalProgress,
            trackedSubmissionLifecycle,
            completionTracker,
            requestInjector || requestInjectionCdpInjector
              ? signal => (requestInjector ?? requestInjectionCdpInjector)!.assertRewriteAttempt(5_000, signal)
              : undefined,
          ),
        );
      } catch (error) {
        const activeRequestInjector = requestInjector ?? requestInjectionCdpInjector;
        if (turn.abortSignal?.aborted) {
          // A cancelled turn is not a submission failure. The probe only failed because the turn was
          // aborted while the placeholder was still in the composer, so the injection fallback must
          // not re-attach or re-send anything. Clear the composer best-effort: the retained
          // Temporary Chat has to stay usable for the next turn.
          await this.clearChatGptComposerState(page).catch(() => {});
          throw new DOMException("ChatGPT web turn aborted", "AbortError");
        }
        if (!(error instanceof ChatGptRequestInjectionFallbackError) || !activeRequestInjector) throw error;
        const injectionFailure = activeRequestInjector.snapshot();
        console.warn(`[chatgpt-web-metric] ${JSON.stringify({
          version: 1,
          traceId: turn.traceId,
          mode: "request-injection-primary-fallback",
          observed: injectionFailure.observed,
          rewritten: injectionFailure.rewritten,
          failureCode: injectionFailure.failureCode,
          exactValueMatches: injectionFailure.exactValueMatches,
          literalMatches: injectionFailure.literalMatches,
          originalBodyChars: injectionFailure.originalBodyChars,
          rewrittenBodyChars: injectionFailure.rewrittenBodyChars,
        })}`);
        await diagnostics.capture(page, `request-injection-fallback-${injectionFailure.failureCode ?? "unknown"}-e${injectionFailure.exactValueMatches ?? "x"}-l${injectionFailure.literalMatches ?? "x"}`);
        await this.assertRequestInjectionFallbackSafe(page, submissionBaseline, turn.abortSignal);
        submissionDisposition.proveRollback();
        // The rollback proof rewinds the ambiguity boundary, so every later failure of this attempt
        // is a pre-send failure again and may safely replay the canonical prompt on a fresh surface.
        turn.onSendRolledBack?.();
        recoveryIdentity.resetAfterProvenRollback();
        if (webStreamTap) {
          stopRecoveryWireObservation?.();
          stopRecoveryWireObservation = undefined;
          await webStreamTap.close().catch(() => {});
          webStreamTap = undefined;
          wireCapture = undefined;
        }
        await activeRequestInjector.close().catch(() => {});
        requestInjector = undefined;
        requestInjectionCdpInjector = undefined;
        await this.clearChatGptComposerState(page);
        if (directModeRequested) {
          mode = await this.runStage(turn.traceId, "effort_selection_fallback", browserStageTimeouts.effortSelection, () => (
            this.selectModelAndEffort(page, turn.modelId, requestedMode.effort, browserCapabilities)
          ));
        }
        if (directConnectorMetadata) {
          await this.runStage(turn.traceId, "connector_selection_fallback", browserStageTimeouts.promptAttachment, () => (
            this.selectConnector(page, checkpoint => diagnostics.capture(page, "request-fallback-" + checkpoint), false, connectorAttemptBudget, turn.abortSignal)
          ));
        }
        submissionBaseline = await this.captureSubmissionBaseline(page);
        await this.runStage(
          turn.traceId,
          "prompt_attachment_fallback",
          browserStageTimeouts.promptAttachment,
          (stageSignal) => this.attachPromptWithCompactionRetry(
            page,
            finalPrompt,
            false,
            false,
            submissionBaseline,
            checkpoint => diagnostics.capture(page, `request-fallback-${checkpoint}`),
            turn.abortSignal ? AbortSignal.any([stageSignal, turn.abortSignal]) : stageSignal,
            false,
            connectorAttemptBudget,
            false,
          ),
          chatGptSuspensionClock,
          true,
        );
        await diagnostics.capture(page, "request-injection-fallback-prompt-attached");
        await enableNetworkStreamTap();
        finalSubmissionEvidence = await this.runStage(
          turn.traceId,
          "send_fallback",
          browserStageTimeouts.send,
          (stageSignal) => this.sendAttachedPrompt(
            page,
            submissionBaseline,
            checkpoint => diagnostics.capture(page, `request-fallback-${checkpoint}`),
            turn.abortSignal ? AbortSignal.any([stageSignal, turn.abortSignal]) : stageSignal,
            turn.externalProgress,
            trackedSubmissionLifecycle,
            completionTracker,
          ),
        );
        console.warn(`[chatgpt-web] browser turn ${turn.traceId} request injection fell back to the verified DOM prompt path`);
      }
      captureDisposition.beginAfterCommit(submissionDisposition.snapshot());
      const submittedAt = Date.now();
      console.info(`[chatgpt-web] browser turn ${turn.traceId} submission accepted evidence=${finalSubmissionEvidence}`);
      const prioritizeEarlyRecoveryEvidence = recoveryEvidenceEnabled;
      // Only the opt-in diagnostic moves its screenshot after the first bounded active read.
      // Default turns retain their existing ordering and do not create an early observer.
      if (!prioritizeEarlyRecoveryEvidence) await diagnostics.capture(page, "send-accepted");
      const responseTurnPromise = this.waitForNewAssistantTurn(
        page,
        submissionBaseline,
        deadline,
        turn.abortSignal,
        turn.externalProgress,
        CHATGPT_RESPONSE_DOM_GRACE_MS,
        completionTracker,
      );
      const visibleTrace = new ChatGptVisibleTraceTracker();
      const responseDomCache: ChatGptResponseDomCache = {};
      // A new assistant DOM shell can appear as soon as ChatGPT accepts the submission, before
      // fetch() resolves the conversation response headers. That shell is liveness evidence, not
      // evidence that the network tap is unavailable. Give the owned conversation fetch one short
      // start window even if the DOM turn already exists; only a DOM failure may cut that window
      // short. Once wire text is emitted, stay committed to that stream because streamed output
      // cannot be retracted or safely merged with a differently rendered DOM answer.
      if (networkStreamPrimary && wireCapture) {
        let wireSentText = "";
        let wireInconsistent = false;
        const unsubscribe = wireCapture.subscribe(snapshot => {
          if (!snapshot.text || snapshot.text === wireSentText) return;
          if (!snapshot.text.startsWith(wireSentText)) {
            wireInconsistent = true;
            return;
          }
          const delta = snapshot.text.slice(wireSentText.length);
          wireSentText = snapshot.text;
          if (delta) turn.onTextDelta(delta);
        });
        const domFailureBeforeWire = new Promise<{ source: "dom-error"; error: unknown }>(resolve => {
          void responseTurnPromise.catch(error => resolve({ source: "dom-error", error }));
        });
        const first = await Promise.race([
          wireCapture.waitForStart(5_000, turn.abortSignal).then(snapshot => ({
            source: "wire" as const,
            snapshot,
          })),
          domFailureBeforeWire,
        ]);
        const startedWire = first.source === "wire" && first.snapshot
          ? first.snapshot
          : wireCapture.snapshot().streamId
            ? wireCapture.snapshot()
            : undefined;
        if (startedWire) {
          const waitMs = deadline === undefined
            ? 60 * 60_000
            : Math.max(0, deadline - Date.now());
          const waitDeadline = Date.now() + waitMs;
          // Start from revision zero instead of snapshotting a baseline here. A tool batch may have
          // arrived during the bounded wire-start window above; treating that current revision as
          // already seen would sleep past the very batch whose causal boundary Codex is waiting on.
          let progressRevision = 0;
          let terminal: Awaited<ReturnType<ChatGptWireCapture["waitForEnd"]>>;
          const observeExternalProgress = async (
            snapshot: ChatGptExternalTurnProgressSnapshot,
          ): Promise<void> => {
            if (snapshot.revision <= progressRevision) return;
            progressRevision = snapshot.revision;
            if (!completionTracker.needsToolBatchObservation(snapshot.lastToolBatchRevision)) return;
            // waitForNewAssistantTurn owns the same boundary while it is unresolved. Await it first
            // so both observers can never concurrently emit duplicate acknowledgements.
            await responseTurnPromise;
            if (!completionTracker.needsToolBatchObservation(snapshot.lastToolBatchRevision)) return;
            const boundaryText = await this.currentSubmissionAnswerText(
              page,
              submissionBaseline,
              turn.abortSignal,
            );
            completionTracker.observeToolBatch(snapshot.lastToolBatchRevision, boundaryText);
            await turn.externalProgress!.acknowledgeToolBatch(snapshot.lastToolBatchRevision);
          };
          // Network-primary stays authoritative for final text, but Codex still needs the public
          // ChatGPT work/status rows while the turn is running. Keep this observation deliberately
          // low-frequency: the previous 250ms loop performed expensive renderer snapshots on the
          // hot path and materially increased contention. Cached snapshots are cheap when the DOM
          // did not change; changed DOM is sampled at most once per second.
          let lastVisibleTracePoll = 0;
          let visibleTracePoll: Promise<void> | undefined;
          let networkPrimaryClosed = false;
          const scheduleVisibleTracePoll = (): void => {
            const now = Date.now();
            if (networkPrimaryClosed || visibleTracePoll || now - lastVisibleTracePoll < 1_000) return;
            lastVisibleTracePoll = now;
            visibleTracePoll = (async () => {
              try {
                const responseTurn = await Promise.race([
                  responseTurnPromise,
                  new Promise<undefined>(resolveWait => setTimeout(() => resolveWait(undefined), 75)),
                ]);
                if (!responseTurn || networkPrimaryClosed) return;
                const snapshot = await this.responseDomSnapshot(responseTurn.locator, responseDomCache);
                if (!snapshot.responsePresent || networkPrimaryClosed) return;
                for (const trace of visibleTrace.observe(snapshot.traceBlocks, snapshot.completionActionVisible)) {
                  if (networkPrimaryClosed) return;
                  if (trace.kind === "commentary") turn.onCommentary?.(trace.text, trace.continuation === true);
                  else turn.onReasoningSummary?.(trace.text, trace.continuation === true);
                }
              } catch {
                // Non-fatal: the network stream remains the final-answer authority.
              }
            })().finally(() => {
              visibleTracePoll = undefined;
            });
            void visibleTracePoll;
          };
          for (;;) {
            const remainingMs = Math.max(0, waitDeadline - Date.now());
            if (!turn.externalProgress || remainingMs === 0) {
              const observationWindowMs = Math.min(1_000, remainingMs);
              terminal = remainingMs === 0
                ? undefined
                : await wireCapture.waitForEnd(observationWindowMs, turn.abortSignal);
              if (terminal !== undefined || remainingMs <= observationWindowMs) break;
              scheduleVisibleTracePoll();
              continue;
            }
            // Process the current snapshot before arming a waiter. waitForChange then closes the
            // opposite race: an update that lands after this read is returned immediately because
            // its revision is greater than progressRevision.
            await observeExternalProgress(turn.externalProgress.snapshot());
            const waitAbort = new AbortController();
            const waitSignal = turn.abortSignal
              ? AbortSignal.any([waitAbort.signal, turn.abortSignal])
              : waitAbort.signal;
            try {
              const observationWindowMs = Math.min(1_000, remainingMs);
              const observationTick = new Promise<{ source: "trace" }>(resolveTick => {
                setTimeout(() => resolveTick({ source: "trace" }), observationWindowMs);
              });
              const observed = await withBrowserTurnAbort(Promise.race([
                wireCapture.waitForEnd(remainingMs, waitSignal).then(snapshot => ({
                  source: "wire" as const,
                  snapshot,
                })),
                turn.externalProgress.waitForChange(progressRevision, waitSignal).then(snapshot => ({
                  source: "external" as const,
                  snapshot,
                })),
                observationTick,
              ]), turn.abortSignal);
              if (observed.source === "wire") {
                terminal = observed.snapshot;
                break;
              }
              if (observed.source === "external") await observeExternalProgress(observed.snapshot);
              scheduleVisibleTracePoll();
            } finally {
              waitAbort.abort();
            }
          }
          networkPrimaryClosed = true;
          unsubscribe();
          if (wireInconsistent) {
            throw new Error("ChatGPT network stream rewrote already-emitted assistant text");
          }
          if (terminal?.failed && wireSentText) {
            throw new Error("ChatGPT network stream failed after assistant text was emitted");
          }
          if (terminal?.complete && terminal.text && !terminal.failed) {
            if (terminal.text.startsWith(wireSentText)) {
              const remainder = terminal.text.slice(wireSentText.length);
              if (remainder) turn.onTextDelta(remainder);
            }
            turn.onOutputAnnotations?.(terminal.annotations ?? []);
            if (this.context && this.config.browserHost === "managed-chrome") {
              const state = await this.context.storageState();
              atomicWriteFile(this.config.storageStatePath, `${JSON.stringify(state)}\n`);
            }
            await diagnostics.capture(page, "turn-completed-network-primary");
            console.info(
              `[chatgpt-web] browser turn ${turn.traceId} completed from Temporary Chat network stream`
              + ` (markdownChars=${terminal.text.length}`
              + ` sendAcceptanceMs=${submittedAt - sendStartedAt}`
              + ` responseStartMs=${terminal.startedAt !== undefined ? terminal.startedAt - sendStartedAt : "none"}`
              + ` firstTextMs=${terminal.firstTextAt !== undefined ? terminal.firstTextAt - sendStartedAt : "none"}`
              + ` completionMs=${terminal.completedAt !== undefined ? terminal.completedAt - sendStartedAt : "none"})`,
            );
            console.info(`[chatgpt-web-metric] ${JSON.stringify({
              version: 1,
              traceId: turn.traceId,
              mode: "primary",
              comparison: "wire-only",
              fixtureWireSourceExact: chatGptCanaryExpectedTextExact(terminal.text),
              status: terminal.status,
              wireChars: terminal.text.length,
              handoffObserved: terminal.handoffTopicId !== undefined,
              sendAcceptanceMs: submittedAt - sendStartedAt,
              responseStartMs: terminal.startedAt !== undefined ? terminal.startedAt - sendStartedAt : undefined,
              firstTextMs: terminal.firstTextAt !== undefined ? terminal.firstTextAt - sendStartedAt : undefined,
              handoffObservedMs: terminal.handoffObservedAt !== undefined ? terminal.handoffObservedAt - sendStartedAt : undefined,
              firstHandoffChunkMs: terminal.firstHandoffChunkAt !== undefined ? terminal.firstHandoffChunkAt - sendStartedAt : undefined,
              wireCompletionMs: terminal.completedAt !== undefined ? terminal.completedAt - sendStartedAt : undefined,
            })}`);
            void responseTurnPromise.catch(() => {});
            captureDisposition.complete();
            return terminal.text;
          }
          if (wireSentText) {
            throw new Error("ChatGPT network stream ended without definitive completion after assistant text was emitted");
          }
        } else {
          unsubscribe();
          if (first.source === "dom-error") throw first.error;
        }
      }
      let responseTurn = await responseTurnPromise;
      recoveryIdentity.observeDocument(responseTurn.documentId);
      recoveryIdentity.observeAssistantTurn(responseTurn.identity);
      if (prioritizeEarlyRecoveryEvidence) {
        generationTurnIdContinuityToken = randomUUID();
        generationTurnIdContinuityStarted = await withChatGptBrowserObservationTimeout(page.evaluate(
          startChatGptRecoveryTurnIdMutationContinuity, {
            token: generationTurnIdContinuityToken, documentId: responseTurn.documentId,
            deadline: Math.min(deadline ?? Infinity, Date.now() + 15_000),
            userSelector: CHATGPT_USER_TURN_SELECTOR, assistantSelector: CHATGPT_ASSISTANT_TURN_SELECTOR,
            baselineResponseIdentities: submissionBaseline.initialTurnIdentities,
          },
        )).catch(() => false);
      }
      const readRecoveryProof = (signal?: AbortSignal, activity = false): Promise<ChatGptRecoveryDomSnapshot> => {
        if (signal?.aborted) return Promise.reject(new Error("recovery diagnostic aborted"));
        return withChatGptBrowserObservationTimeout(withBrowserTurnAbort(page.evaluate(collectChatGptRecoveryDomSnapshot, {
          userSelector: CHATGPT_USER_TURN_SELECTOR,
          assistantSelector: CHATGPT_ASSISTANT_TURN_SELECTOR,
          baselineResponseIdentities: submissionBaseline.initialTurnIdentities,
          ...(activity ? { activity: {
            stopButtonSelector: CHATGPT_STOP_BUTTON_SELECTOR,
            completionActionSelector: CHATGPT_COMPLETION_ACTION_SELECTOR,
          } } : {}),
        }), signal));
      };
      const validateRecoveryProof = (proof: ChatGptRecoveryDomSnapshot): string => {
        if (proof.identityAmbiguous || !proof.documentId || !proof.assistantTurnIdentity
          || proof.count !== 1 || !proof.uuidLike || proof.documentMatches !== 1) {
          throw new Error("recovery diagnostic ambiguous DOM proof");
        }
        const identity = chatGptSameDocumentTurnIdentity(
          responseTurn.documentId, proof.documentId,
          responseTurn.acceptedUserTurnIdentities, proof.userIdentities,
          submissionBaseline.initialTurnIdentities, responseTurn.identity, proof.responseIdentities,
        );
        if (identity !== proof.assistantTurnIdentity
          || proof.userIdentities.length !== responseTurn.acceptedUserTurnIdentities.length
          || responseTurn.acceptedUserTurnIdentities.some(id => !proof.userIdentities.includes(id))) {
          throw new Error("recovery diagnostic ownership changed");
        }
        return identity;
      };
      // No sampler, timer or extra read in default-OFF turns. Missing evidence remains missing
      // unless obtained from an atomic, still-generating observation inside the active loop.
      const earlyRecordOutcomes = { invalidShape: 0, ownershipChanged: 0, assistantChanged: 0, trackerRejected: 0, recorded: 0 };
      const turnIdContinuity = prioritizeEarlyRecoveryEvidence ? new ChatGptRecoveryTurnIdContinuityTracker() : undefined;
      const earlyMessageSampler = prioritizeEarlyRecoveryEvidence
        ? new ChatGptRecoveryMessageSampler({
          turnDeadline: deadline, signal: turn.abortSignal,
          isCapturing: () => captureDisposition.snapshot() === "capturing" && recoveryIdentity.lifecycle() === "committed",
          wireTerminal: () => { const wire = wireCapture?.snapshot(); return wire?.complete === true || wire?.failed === true; },
          finalTextStarted: () => wireCapture?.snapshot().firstTextAt !== undefined,
          read: signal => readRecoveryProof(signal, true),
          record: observation => {
            turnIdContinuity?.observe(observation);
            let rejection: "invalidShape" | "ownershipChanged" | "assistantChanged" = "invalidShape";
            try {
              if (!observation.identityAmbiguous && observation.documentId && observation.assistantTurnIdentity
                && observation.count === 1 && observation.uuidLike && observation.documentMatches === 1) rejection = "ownershipChanged";
              const identity = validateRecoveryProof(observation);
              rejection = "assistantChanged";
              if (identity !== responseTurn.identity) throw new Error("early diagnostic assistant changed");
              recoveryIdentity.observeCommittedMessage({ ...observation, assistantTurnIdentity: identity });
              if (recoveryIdentity.matchesCommittedMessage(observation.messageId, observation.documentId, identity)) earlyRecordOutcomes.recorded++;
              else earlyRecordOutcomes.trackerRejected++;
            } catch {
              earlyRecordOutcomes[rejection]++;
              // A successfully read invalid DOM sample poisons existing provenance. Transport
              // timeouts never reach this recorder and are not confused with a missing ID.
              recoveryIdentity.observeCommittedMessage({ ...observation, count: 0,
                assistantTurnIdentity: observation.assistantTurnIdentity ?? "" });
            }
          },
        }) : undefined;
      if (earlyMessageSampler) {
        earlyRecoverySampler = earlyMessageSampler;
        await earlyMessageSampler.sample();
        earlyRecoverySampling = earlyMessageSampler.run();
        await diagnostics.capture(page, "send-accepted");
      }

      let lastHeartbeat = 0;
      let finalText = "";
      let sawRunning = false;
      let loggedCompletionWait = false;
      let capturedResponse = false;
      const sentAt = Date.now();
      let markdownBuffer = new ChatGptMarkdownBuffer();
      const checkpointStream = turn.captureLunaCheckpoint
        ? new ChatGptLunaCheckpointStream()
        : undefined;
      const emitMarkdownDelta = (delta: string): void => {
        const visible = checkpointStream ? checkpointStream.push(delta) : delta;
        if (visible) turn.onTextDelta(visible);
      };
      const throwMarkdownConsistencyError = (error: unknown): never => {
        if (!(error instanceof ChatGptMarkdownConsistencyError)) throw error;
        throw new ChatGptWebAdapterError(error.message, {
          status: 502,
          errorType: "server_error",
          code: "browser_stream_inconsistent",
          retryable: false,
        });
      };
      let domHealthTracker = new ChatGptTurnDomHealthTracker();
      let stoppedThinkingTracker = new ChatGptStoppedThinkingTracker();
      let consecutiveObservationRebinds = 0;
      let internalObservationFaults = 0;
      let observedThisIteration = false;
      let completionFenceRevision: number | undefined;
      const submitPendingSteering = async (): Promise<void> => {
        let item = turn.steering?.take();
        while (item) {
          try {
            const accepted = await this.submitInFlightSteering(page, item, responseTurn, turn.abortSignal);
            const replyIdentity = accepted.replyIdentity;
            responseTurn = {
              ...responseTurn,
              ...(replyIdentity ? {
                identity: replyIdentity,
                locator: page.locator(`[data-turn-id=${JSON.stringify(replyIdentity)}]`),
              } : {}),
              acceptedTurnIdentities: accepted.state.turnIdentities,
              acceptedUserTurnIdentities: accepted.state.userIdentities,
            };
            submissionBaseline = {
              ...submissionBaseline,
              initialUserTurnCount: accepted.state.userIdentities.length,
              initialResponseTurnCount: accepted.state.responseIdentities.length,
              initialTurnIdentities: accepted.state.turnIdentities,
              initialUserTurnIdentities: accepted.state.userIdentities,
              initialResponseTurnIdentities: accepted.state.responseIdentities,
              domCache: {},
            };
            responseDomCache.key = undefined;
            responseDomCache.snapshot = undefined;
            completionTracker = new ChatGptCompletionTracker();
            completionFenceRevision = undefined;
            if (replyIdentity) {
              // The steered revision owns its own assistant turn. The Markdown journal keys committed
              // segments by source range, so it must restart with that turn instead of reconciling the
              // superseded prefix against a different response root.
              markdownBuffer = new ChatGptMarkdownBuffer();
              recoveryIdentity.observeAssistantTurn(replyIdentity);
              turn.onSteeringReply?.(replyIdentity);
            }
            item.complete();
          } catch (error) {
            const normalized = error instanceof Error ? error : new Error(String(error));
            item.complete(normalized);
            if (normalized instanceof ChatGptSteeringUnavailableError) {
              item = turn.steering?.take();
              continue;
            }
            throw normalized;
          }
          item = turn.steering?.take();
        }
      };
      let incompleteCaptureRecoveryAttempted = false;
      let incompleteCaptureRecoveryCanaryInjected = false;
      const attemptIncompleteCaptureRecovery = async (cause: unknown): Promise<boolean> => {
        if (!turnPlan.incompleteCaptureRecovery || incompleteCaptureRecoveryAttempted
          || captureDisposition.snapshot() !== "capturing"
          || submissionDisposition.snapshot() !== "committed"
          || !chatGptRecoverableIncompleteCaptureFailure(cause)
          || !launcherSurfaceId || !requestObservation || !browserWideRequestObservation || !webStreamTap
          || !generationTurnIdContinuityStarted || !generationTurnIdContinuityToken
          || turn.abortSignal?.aborted || (deadline !== undefined && Date.now() >= deadline)) {
          return false;
        }
        incompleteCaptureRecoveryAttempted = true;
        const recoveryRequestObservation = requestObservation;
        const recoveryBrowserWideRequestObservation = browserWideRequestObservation;
        const recoveryWebStreamTap = webStreamTap;
        earlyMessageSampler?.close();
        if (earlyRecoverySampling) await earlyRecoverySampling.catch(() => {});
        if (wireCapture) recoveryIdentity.observeWireSnapshot(wireCapture.snapshot());
        captureDisposition.failAfterCommit(submissionDisposition.snapshot());
        const frozenProof = recoveryIdentity.freezeCommittedProof();
        let reasons: ChatGptRecoveryResumeEvidenceReason[] = [];
        let authorized = false;
        const receipt = {
          appConversationBindingExact: false,
          freshServerReachable: false,
          generationTurnIdStable: false,
          fetchConversationPostAttempts: 0,
          independentConversationPostEvents: 0,
          independentDistinctRequestIds: 0,
          browserWideRequestObservationExact: false,
          browserWideConversationPostEvents: 0,
          browserWideContextCount: 0,
          requestCountsAgree: false,
          freshMarkdownCompatible: false,
          freshSnapshotFenceExact: false,
          freshMessageExact: false,
          sameDocument: false,
          noExtraUser: false,
        };
        try {
          authorized = await withChatGptRecoveryDiagnosticBudget(deadline, turn.abortSignal, async signal => {
            await withBrowserTurnAbort(
              rebindLauncherPage(1, new Error("incomplete-capture observation recovery"), signal),
              signal,
            );
            const fresh = await readRecoveryProof(signal);
            const reboundIdentity = validateRecoveryProof(fresh);
            const expectedConversationId = frozenProof.identity.conversationId;
            const expectedMessageId = frozenProof.wireMessage?.messageId;
            if (!expectedConversationId || !expectedMessageId) return false;

            const appConversationBinding = await withBrowserTurnAbort(
              recoveryRequestObservation.conversationBinding(expectedConversationId), signal,
            );
            receipt.appConversationBindingExact = appConversationBinding.exact;
            const serverProof = await withBrowserTurnAbort(page.evaluate(
              collectChatGptRecoveryServerProof,
              {
                expectedConversationId,
                expectedMessageId,
                deadline: Math.min(deadline ?? Infinity, Date.now() + 5_000),
              },
            ), signal);
            const persistedServerExact = chatGptRecoveryServerProofExact(serverProof);
            const freshServerReachable = persistedServerExact
              || (serverProof.sessionFetchOk === true
                && serverProof.streamStatusFetchOk === true
                && serverProof.streamStatusJsonObject === true
                && serverProof.streamStatusHttpStatus !== undefined
                && serverProof.streamStatusHttpStatus >= 200
                && serverProof.streamStatusHttpStatus < 300);
            receipt.freshServerReachable = freshServerReachable;

            generationTurnIdContinuityResult = await withBrowserTurnAbort(page.evaluate(
              finishChatGptRecoveryTurnIdMutationContinuity, generationTurnIdContinuityToken!,
            ), signal);
            generationTurnIdContinuityStarted = false;
            receipt.generationTurnIdStable = generationTurnIdContinuityResult.available
              && generationTurnIdContinuityResult.stable && !generationTurnIdContinuityResult.expired
              && !generationTurnIdContinuityResult.turnIdConflict;

            const fetchDiagnostic = await withBrowserTurnAbort(
              recoveryWebStreamTap.readFetchSubmissionDiagnostic(page), signal,
            );
            const independentRequestObservation = await withBrowserTurnAbort(recoveryRequestObservation.snapshot(), signal);
            const browserWideRequestReceipt = recoveryBrowserWideRequestObservation.snapshot();
            const requestCountsAgree = recoveryRequestCountsAgree(independentRequestObservation, fetchDiagnostic);
            receipt.fetchConversationPostAttempts = fetchDiagnostic.available
              ? fetchDiagnostic.conversationPostAttempts ?? 0 : 0;
            receipt.independentConversationPostEvents = independentRequestObservation.conversationPostEvents;
            receipt.independentDistinctRequestIds = independentRequestObservation.distinctRequestIds;
            receipt.browserWideRequestObservationExact = browserWideRequestReceipt.exact;
            receipt.browserWideConversationPostEvents = browserWideRequestReceipt.conversationPostEvents;
            receipt.browserWideContextCount = browserWideRequestReceipt.browserContextCount;
            receipt.requestCountsAgree = requestCountsAgree;

            const freshLocator = page.locator(`[data-testid=${JSON.stringify(reboundIdentity)}]`);
            const freshDom = await withBrowserTurnAbort(this.responseDomSnapshot(freshLocator, {}), signal);
            const freshMarkdownCompatible = freshDom.responsePresent
              && markdownBuffer.observationIsConsistent(freshDom.markdownSegments);
            receipt.freshMarkdownCompatible = freshMarkdownCompatible;
            const fence = await readRecoveryProof(signal);
            validateRecoveryProof(fence);
            const freshSnapshotFenceExact = sameChatGptRecoveryDomSnapshot(fresh, fence);
            receipt.freshSnapshotFenceExact = freshSnapshotFenceExact;
            receipt.freshMessageExact = fresh.messageId === expectedMessageId;
            receipt.sameDocument = fresh.documentId === responseTurn.documentId;
            receipt.noExtraUser = fresh.userIdentities.length === responseTurn.acceptedUserTurnIdentities.length
              && responseTurn.acceptedUserTurnIdentities.every(id => fresh.userIdentities.includes(id));
            const evaluation = evaluateChatGptRecoveryResumeEvidence({
              proof: frozenProof,
              atomicDomProof: fresh.count === 1 && fresh.uuidLike && fresh.documentMatches === 1,
              freshUuidLike: fresh.uuidLike,
              freshCount: fresh.count,
              freshMessageMatchesOriginal: receipt.freshMessageExact,
              sameSurface: true,
              sameDocument: receipt.sameDocument,
              noExtraUser: receipt.noExtraUser,
              sameAssistant: reboundIdentity === responseTurn.identity,
              provenRebound: reboundIdentity !== responseTurn.identity,
              appConversationBindingExact: appConversationBinding.exact,
              freshServerConversationReachable: freshServerReachable,
              generationTurnIdContinuity: generationTurnIdContinuityResult,
              requestCountsAgree,
              browserWideRequestCountExact: browserWideRequestReceipt.exact,
              freshMarkdownCompatible,
              freshSnapshotFenceExact,
            });
            reasons = evaluation.reasons;
            if (!evaluation.observationResumeAuthorized || evaluation.promptReplayAuthorized) return false;
            if (turn.abortSignal?.aborted || (deadline !== undefined && Date.now() >= deadline)) return false;

            submissionBaseline = {
              ...submissionBaseline,
              userTurns: page.locator(CHATGPT_USER_TURN_SELECTOR),
              responseTurns: page.locator(CHATGPT_ASSISTANT_TURN_SELECTOR),
              domCache: {},
            };
            responseTurn = {
              ...responseTurn,
              identity: reboundIdentity,
              documentId: fresh.documentId!,
              acceptedTurnIdentities: [...new Set([...submissionBaseline.initialTurnIdentities, ...fresh.userIdentities, ...fresh.responseIdentities])],
              acceptedUserTurnIdentities: fresh.userIdentities,
              locator: freshLocator,
            };
            responseDomCache.key = undefined;
            responseDomCache.snapshot = undefined;
            completionTracker = new ChatGptCompletionTracker();
            domHealthTracker = new ChatGptTurnDomHealthTracker();
            stoppedThinkingTracker = new ChatGptStoppedThinkingTracker();
            consecutiveObservationRebinds = 0;
            internalObservationFaults = 0;
            completionFenceRevision = undefined;
            captureDisposition.resumeAfterExactRecovery(submissionDisposition.snapshot());
            return true;
          });
        } catch {
          authorized = false;
        }
        console.info(`[chatgpt-web-metric] ${JSON.stringify({
          version: 1,
          traceId: turn.traceId,
          mode: "incomplete-capture-recovery",
          attempted: true,
          authorized,
          reasons,
          promptReplayAuthorized: false,
          submissionDisposition: submissionDisposition.snapshot(),
          captureDisposition: captureDisposition.snapshot(),
          ...receipt,
        })}`);
        return authorized;
      };
      for (;;) {
       try {
        for (;;) {
        // The heartbeat is a consumer callback, so it stays outside the observation-fault region:
        // a defect in the caller must not be retried as though the page could not be read.
        if (Date.now() - lastHeartbeat >= 10_000) {
          turn.onHeartbeat?.();
          lastHeartbeat = Date.now();
        }
       try {
        observedThisIteration = false;
        if (page.isClosed()) {
          throw chatGptBrowserTabClosedError();
        }
        if (turn.abortSignal?.aborted) {
          const stop = page.locator(CHATGPT_STOP_BUTTON_SELECTOR).last();
          if (await stop.isVisible().catch(() => false)) await stop.press("Enter").catch(() => {});
          throw new DOMException("ChatGPT web turn aborted", "AbortError");
        }
        if (deadline !== undefined && Date.now() >= deadline) {
          throw new Error("ChatGPT web turn timed out");
        }
        await submitPendingSteering();
        await throwIfChatGptSessionFailureAlert(page);
        await throwIfChatGptTerminalErrorAlert(responseTurn.locator);

        if (mode.localTools && await resolveChatGptToolConfirmation(
          page,
          this.config.appName,
          this.config.autoApproveToolCalls,
          turn.abortSignal,
          CHATGPT_TOOL_CONFIRMATION_TIMEOUT_MS,
          () => diagnostics.capture(page, "tool-confirmation-visible"),
        )) {
          internalObservationFaults = 0;
          await new Promise(resolveSleep => setTimeout(resolveSleep, 250));
          continue;
        }

        let snapshot = await this.responseDomSnapshot(responseTurn.locator, responseDomCache);
        if (!snapshot.responsePresent) {
          try {
            const rebound = await withChatGptBrowserObservationTimeout(
              this.reconcileAssistantTurnBinding(
                page,
                submissionBaseline,
                responseTurn,
                turn.abortSignal,
              ),
            );
            if (rebound.identity !== responseTurn.identity) {
              responseTurn = rebound;
              recoveryIdentity.observeDocument(responseTurn.documentId);
              recoveryIdentity.observeAssistantTurn(responseTurn.identity);
              responseDomCache.key = undefined;
              responseDomCache.snapshot = undefined;
              snapshot = await this.responseDomSnapshot(responseTurn.locator, responseDomCache);
            }
          } catch (error) {
            if (!(error instanceof ChatGptBrowserObservationTimeoutError) || !launcherSurfaceId) throw error;
            consecutiveObservationRebinds += 1;
            if (consecutiveObservationRebinds > MAX_CHATGPT_BROWSER_PAGE_REBINDS) {
              throw new Error(
                `ChatGPT browser DOM remained unresponsive after ${MAX_CHATGPT_BROWSER_PAGE_REBINDS} same-page rebinds`,
                { cause: error },
              );
            }
            await rebindLauncherPage(consecutiveObservationRebinds, error);
            const reboundState = await this.submissionDomState(page, {}, turn.abortSignal);
            const reboundIdentity = chatGptSameDocumentTurnIdentity(
              responseTurn.documentId,
              reboundState.documentId,
              responseTurn.acceptedUserTurnIdentities,
              reboundState.userIdentities,
              submissionBaseline.initialTurnIdentities,
              responseTurn.identity,
              reboundState.responseIdentities,
            );
            submissionBaseline = {
              ...submissionBaseline,
              userTurns: page.locator(CHATGPT_USER_TURN_SELECTOR),
              responseTurns: page.locator(CHATGPT_ASSISTANT_TURN_SELECTOR),
              domCache: {},
            };
            responseTurn = {
              ...responseTurn,
              identity: reboundIdentity,
              documentId: reboundState.documentId,
              acceptedUserTurnIdentities: reboundState.userIdentities,
              locator: page.locator(`[data-testid=${JSON.stringify(reboundIdentity)}]`),
            };
            recoveryIdentity.observeDocument(responseTurn.documentId);
            recoveryIdentity.observeAssistantTurn(responseTurn.identity);
            responseDomCache.key = undefined;
            responseDomCache.snapshot = undefined;
            await diagnostics.capture(page, "response-page-rebound");
            continue;
          }
        }
        if (snapshot.responsePresent) consecutiveObservationRebinds = 0;
        if (snapshot.completionActionVisible || snapshot.stoppedThinkingVisible) earlyMessageSampler?.close();
        // The page was read successfully, so the fault budget is genuinely consecutive even when
        // this iteration goes on to `continue` for a rebind, confirmation, or liveness pause.
        internalObservationFaults = 0;
        observedThisIteration = true;
        // Liveness may postpone a verdict, never waive it: once activity goes stale the DOM alone
        // decides, so a tool call that never returns cannot hold an undeadlined turn open forever.
        const externalProgressSnapshot = turn.externalProgress?.snapshot();
        if (turn.externalProgress
          && externalProgressSnapshot
          && completionTracker.needsToolBatchObservation(externalProgressSnapshot.lastToolBatchRevision)) {
          completionTracker.observeToolBatch(
            externalProgressSnapshot.lastToolBatchRevision,
            snapshot.visibleText,
          );
          await turn.externalProgress.acknowledgeToolBatch(externalProgressSnapshot.lastToolBatchRevision);
        }
        const externalProgressLive = chatGptExternalProgressSuppressesDomHealth(
          externalProgressSnapshot,
          Date.now(),
        );
        const externalToolCallsInFlight = chatGptExternalToolCallsAreInFlight(externalProgressSnapshot);
        // A stale "Stopped thinking" label is not terminal while the model is still driving tool
        // calls, and the window must be forgotten rather than merely ignored.
        if (externalProgressLive) stoppedThinkingTracker.clear();
        else if (stoppedThinkingTracker.update(snapshot.stoppedThinkingVisible)) {
          throw chatGptStoppedThinkingError();
        }
        if (!snapshot.responsePresent && externalProgressLive) {
          // Current-turn MCP activity proves that ChatGPT is still executing even if its renderer
          // temporarily cannot expose the response subtree. DOM remains authoritative for text and
          // completion; this only prevents a live turn from being misclassified as vanished.
          domHealthTracker.clearMissingResponse();
          await new Promise(resolveSleep => setTimeout(resolveSleep, 250));
          continue;
        }
        const stop = page.locator(CHATGPT_STOP_BUTTON_SELECTOR).last();
        const running = await stop.isVisible().catch(() => false);
        if (running) sawRunning = true;
        if (snapshot.responsePresent) {
          // The optional sampler has its own bounded loop, so screenshots cannot starve it.
          if (!capturedResponse) {
            capturedResponse = true;
            await diagnostics.capture(page, "response-visible");
          }
          const textDelta = (() => {
            try {
              return markdownBuffer.observe(snapshot.markdownSegments);
            } catch (error) {
              return throwMarkdownConsistencyError(error);
            }
          })();
          for (const trace of visibleTrace.observe(snapshot.traceBlocks, snapshot.completionActionVisible)) {
            if (trace.kind === "commentary") turn.onCommentary?.(trace.text, trace.continuation === true);
            else turn.onReasoningSummary?.(trace.text, trace.continuation === true);
          }
          if (textDelta) emitMarkdownDelta(textDelta);
          if (turnPlan.incompleteCaptureRecovery
            && process.env.CODEX_CHATGPT_WEB_INCOMPLETE_CAPTURE_RECOVERY_CANARY === "1"
            && !incompleteCaptureRecoveryCanaryInjected
            && requestObservation && generationTurnIdContinuityStarted
            && wireCapture?.snapshot().assistantMessageId
            && wireCapture.snapshot().assistantMessageConversationId
            && turnConnection) {
            // Live H5 fault injection disconnects only this worker's observation transport after
            // semantic submission. The independent request observer remains attached to the same
            // launcher lease, and the recovery branch below is forbidden from sending anything.
            incompleteCaptureRecoveryCanaryInjected = true;
            const staleConnection = turnConnection;
            turnConnection = undefined;
            await staleConnection.close();
            throw new ChatGptIncompleteCaptureCanaryError();
          }
          const domError = domHealthTracker.update({
            responsePresent: snapshot.responsePresent,
            running,
            currentText: snapshot.visibleText,
            completionActionVisible: snapshot.completionActionVisible,
            externalProgressLive,
          });
          if (domError) throw new Error(domError);
          const completionReady = completionTracker.update({
            responsePresent: snapshot.responsePresent,
            running,
            currentText: snapshot.visibleText,
            currentHtml: snapshot.fullHtml,
            completionActionVisible: snapshot.completionActionVisible,
            externalToolCallsInFlight,
          });
          if (!completionReady) completionFenceRevision = undefined;
          if (completionReady) {
            if (turn.completionFence) {
              if (completionFenceRevision === undefined) {
                const revision = await turn.completionFence.begin();
                if (revision === undefined) {
                  await new Promise(resolveSleep => setTimeout(resolveSleep, 250));
                  continue;
                }
                completionFenceRevision = revision;
                // The fence revision is captured after this DOM projection. Force one fresh read
                // before commit so an MCP activity that just settled cannot disappear between a
                // stale cached completion and the broker's terminal decision.
                responseDomCache.key = undefined;
                responseDomCache.snapshot = undefined;
                await new Promise(resolveSleep => setTimeout(resolveSleep, 250));
                continue;
              }
              if (!await turn.completionFence.commit(completionFenceRevision)) {
                completionFenceRevision = undefined;
                responseDomCache.key = undefined;
                responseDomCache.snapshot = undefined;
                await new Promise(resolveSleep => setTimeout(resolveSleep, 250));
                continue;
              }
            }
            if (snapshot.visibleText === "api_tool unavailable") {
              throw new Error("ChatGPT selected mode rejected the Codex Native MCP tool (api_tool unavailable)");
            }
            const final = (() => {
              try {
                return markdownBuffer.finish();
              } catch (error) {
                return throwMarkdownConsistencyError(error);
              }
            })();
            if (!final.markdown && snapshot.visibleText) {
              throw new Error("ChatGPT completed with visible text that could not be serialized as Markdown");
            }
            if (final.delta) emitMarkdownDelta(final.delta);
            if (checkpointStream) {
              const completed = checkpointStream.finishOptional(snapshot.visibleText);
              if (completed.visibleRemainder) turn.onTextDelta(completed.visibleRemainder);
              if (completed.captured) turn.onLunaCheckpoint!(completed.captured);
              else console.warn(`[chatgpt-web] browser turn ${turn.traceId} completed without a Luna rolling checkpoint; preserving full native history`);
              finalText = completed.answer;
            } else {
              finalText = final.markdown;
            }
            break;
          }
          if (!loggedCompletionWait && Date.now() - sentAt >= 30_000) {
            loggedCompletionWait = true;
            await diagnostics.capture(page, "response-stalled-30s");
            const diagnostic = await this.stalledTurnDiagnostic(page, responseTurn.locator).catch(error => JSON.stringify({
              diagnosticError: error instanceof Error ? error.message : String(error),
            }));
            console.warn(
              `[chatgpt-web] waiting for completed-turn evidence (running=${running}, sawRunning=${sawRunning}, textChars=${snapshot.visibleText.length}, completionActionVisible=${snapshot.completionActionVisible}, ui=${diagnostic})`,
            );
          }
        } else {
          const domError = domHealthTracker.update({
            responsePresent: false,
            running,
            currentText: "",
            completionActionVisible: false,
            externalProgressLive,
          });
          if (domError) throw new Error(domError);
        }
        if (turnPlan.domObservation === "cadence") {
          await new Promise(resolveSleep => setTimeout(resolveSleep, CHATGPT_RESPONSE_DOM_MIN_OBSERVATION_INTERVAL_MS));
        } else {
          await this.waitForResponseDomOrExternalProgress(
            responseTurn.locator,
            responseDomCache.key,
            responseDomCache,
            externalProgressSnapshot?.revision ?? 0,
            turn.externalProgress,
            turn.abortSignal,
          );
        }
       } catch (error) {
        // Only a defect in this worker is retried here. Every deliberate signal — adapter errors,
        // aborts, closed tabs, DOM-health verdicts — still fails the turn immediately.
        // Retry only faults raised while reading the page. Once observation succeeded, a
        // TypeError belongs to a consumer - Markdown buffering, text/trace callbacks, checkpoint
        // capture - and retrying it would rerun an iteration whose side effects already happened.
        if (!(error instanceof TypeError) || observedThisIteration) throw error;
        internalObservationFaults += 1;
        if (internalObservationFaults > MAX_CHATGPT_INTERNAL_OBSERVATION_FAULTS) {
          throw new Error(
            `ChatGPT browser observation failed ${internalObservationFaults} times in a row: ${error.message}`,
            { cause: error },
          );
        }
        console.warn(
          `[chatgpt-web] browser turn ${turn.traceId} tolerated internal observation fault`
          + ` ${internalObservationFaults}/${MAX_CHATGPT_INTERNAL_OBSERVATION_FAULTS}: ${error.message}`,
        );
        await diagnostics.capture(page, "internal-observation-fault");
        responseDomCache.key = undefined;
        responseDomCache.snapshot = undefined;
        await new Promise(resolveSleep => setTimeout(resolveSleep, 250));
       }
      }
        break;
       } catch (error) {
        if (!await attemptIncompleteCaptureRecovery(error)) throw error;
       }
      }

      earlyMessageSampler?.close();
      if (earlyRecoverySampling) await earlyRecoverySampling;
      // Keep the page-local generation turn-id observer alive through the optional same-document
      // completed rebind. Its finish() performs one final snapshot, so a successful receipt can
      // prove the same opaque turn survived generation -> completion -> transport reconnect.
      if (process.env.CODEX_CHATGPT_WEB_PROMPT_SHAPE_DIAGNOSTICS === "1") {
        const codeShape = await responseTurn.locator.evaluate((_element, html) => {
          // Inspect the same final-answer snapshot used by the Markdown buffer, not commentary
          // siblings or a newer/remounted response. Template content remains detached and inert.
          const template = document.createElement("template");
          template.innerHTML = html;
          const pres = [...template.content.querySelectorAll("pre")];
          const codes = [...new Set(pres.flatMap(pre => [...pre.querySelectorAll("code")]))];
          const language = (node: Element) => node.getAttribute("class")?.match(/(?:^|\s)language-([^\s]+)/)?.[1]?.toLowerCase();
          const labels = [...template.content.querySelectorAll("*")].filter(node => (
            node.children.length === 0 && !node.closest("code,button,svg")
            && /^(ts|typescript)$/i.test(node.textContent?.trim() ?? "")
          ));
          return {
            preBlocks: pres.length,
            directCodeBlocks: pres.filter(pre => pre.firstChild?.nodeName === "CODE").length,
            nestedCodeBlocks: codes.length,
            codeLanguageClasses: codes.filter(code => language(code) !== undefined).length,
            codeLanguageTs: codes.filter(code => language(code) === "ts").length,
            codeLanguageTypeScript: codes.filter(code => language(code) === "typescript").length,
            codeDataLanguage: codes.filter(code => code.hasAttribute("data-language")).length,
            preDataLanguage: pres.filter(pre => pre.hasAttribute("data-language")).length,
            explicitTypeScriptLabels: labels.length,
            labelLocations: labels.slice(0, 4).map(node => {
              const tags: string[] = [];
              for (let current: Element | null = node; current && tags.length < 12; current = current.parentElement) {
                tags.push(/^(PRE|CODE|DIV|SPAN|BUTTON|SVG)$/.test(current.tagName) ? current.tagName.toLowerCase() : "other");
              }
              return tags.join("<");
            }),
            // Fixed tag/label vocabulary only: no code, arbitrary attributes or class values.
            preShapes: pres.slice(0, 4).map(pre => {
              const shape = (node: Element, depth: number): string => {
                const tag = /^(PRE|CODE|DIV|SPAN|BUTTON|SVG)$/.test(node.tagName) ? node.tagName.toLowerCase() : "other";
                const label = node.children.length === 0 && !node.closest("code") && /^(ts|typescript)$/i.test(node.textContent?.trim() ?? "") ? ":typescript-label" : "";
                return tag + label + (depth > 0 ? `(${[...node.children].slice(0, 8).map(child => shape(child, depth - 1)).join(",")})` : "");
              };
              return shape(pre, 4);
            }),
          };
        }, responseDomCache.snapshot?.fullHtml ?? "", { timeout: 2_000 }).catch(() => undefined);
        console.info(`[chatgpt-web-metric] ${JSON.stringify({ version: 1, traceId: turn.traceId, mode: "rich-dom-code-shape", ...codeShape })}`);
      }
      if (wireCapture) {
        const wire = wireCapture.snapshot();
        const markdownComparison = wire.streamId && !wire.failed && wire.complete
          ? compareChatGptWireAndDomMarkdown(wire.text, finalText)
          : undefined;
        const comparison = !wire.streamId
          ? "not-observed"
          : wire.failed
            ? "failed"
            : !wire.complete
              ? "incomplete"
              : wire.text === finalText
                ? "exact"
                : "different";
        const sendAcceptanceMs = submittedAt - sendStartedAt;
        const responseStartMs = wire.startedAt !== undefined ? wire.startedAt - sendStartedAt : undefined;
        const firstTextMs = wire.firstTextAt !== undefined ? wire.firstTextAt - sendStartedAt : undefined;
        const handoffObservedMs = wire.handoffObservedAt !== undefined ? wire.handoffObservedAt - sendStartedAt : undefined;
        const firstHandoffChunkMs = wire.firstHandoffChunkAt !== undefined ? wire.firstHandoffChunkAt - sendStartedAt : undefined;
        const wireCompletionMs = wire.completedAt !== undefined ? wire.completedAt - sendStartedAt : undefined;
        const domCompletionMs = Date.now() - sendStartedAt;
        console.info(
          `[chatgpt-web] browser turn ${turn.traceId} network stream shadow`
          + ` comparison=${comparison}`
          + ` handoff=${wire.handoffTopicId !== undefined ? "yes" : "no"}`
          + ` markdownEquivalence=${markdownComparison?.equivalence ?? "unavailable"}`
          + ` status=${wire.status ?? "none"}`
          + ` wireChars=${wire.text.length}`
          + ` domChars=${finalText.length}`
          + ` sendAcceptanceMs=${sendAcceptanceMs}`
          + ` responseStartMs=${responseStartMs ?? "none"}`
          + ` firstTextMs=${firstTextMs ?? "none"}`
          + ` wireCompletionMs=${wireCompletionMs ?? "none"}`
          + ` domCompletionMs=${domCompletionMs}`,
        );
        console.info(`[chatgpt-web-metric] ${JSON.stringify({
          version: 1,
          traceId: turn.traceId,
          mode: "shadow",
          comparison,
          status: wire.status,
          wireChars: wire.text.length,
          domChars: finalText.length,
          fixtureWireSourceExact: wire.complete && !wire.failed ? chatGptCanaryExpectedTextExact(wire.text) : undefined,
          fixtureDomSourceExact: chatGptCanaryExpectedTextExact(finalText),
          markdownEquivalence: markdownComparison?.equivalence,
          markdownNormalizations: markdownComparison?.normalizations,
          markdownDifference: markdownComparison?.difference,
          protocolTrace: wire.protocolTrace,
          protocolTraceDropped: wire.protocolTraceDropped,
          protocolSummary: wire.protocolSummary,
          handoffObserved: wire.handoffTopicId !== undefined,
          sendAcceptanceMs,
          responseStartMs,
          firstTextMs,
          handoffObservedMs,
          firstHandoffChunkMs,
          wireCompletionMs,
          domCompletionMs,
          domObservation: turnPlan.domObservation,
          domFullScans: responseDomCache.fullScans ?? 0,
          domCacheHits: responseDomCache.cacheHits ?? 0,
          domMutationWaits: responseDomCache.mutationWaits ?? 0,
          domMutationWakeups: responseDomCache.mutationWakeups ?? 0,
          domMutationTimeouts: responseDomCache.mutationTimeouts ?? 0,
          initialEffortSelectionRequired: turnPlan.initialEffortSelectionRequired,
          exactPrewarmedMode: prewarmedMode && stagingMode.effort === requestedMode.effort,
        })}`);
      }

      if (this.context && this.config.browserHost === "managed-chrome") {
        const state = await this.context.storageState();
        atomicWriteFile(this.config.storageStatePath, `${JSON.stringify(state)}\n`);
      }
      await diagnostics.capture(page, "turn-completed");
      console.info(
        `[chatgpt-web] browser turn ${turn.traceId} completed`
          + ` (markdownChars=${finalText.length}, domFullScans=${responseDomCache.fullScans ?? 0}, domCacheHits=${responseDomCache.cacheHits ?? 0}`
          + `, domMutationWaits=${responseDomCache.mutationWaits ?? 0}, domMutationWakeups=${responseDomCache.mutationWakeups ?? 0}`
          + `, domMutationTimeouts=${responseDomCache.mutationTimeouts ?? 0})`,
        );
      if (chatGptRecoveryProofDiagnosticsEnabled()) {
        try {
          const shape = await withChatGptRecoveryDiagnosticBudget(deadline, turn.abortSignal,
            signal => withBrowserTurnAbort(this.recoveryProofDomShape(responseTurn), signal));
          console.info(`[chatgpt-web-metric] ${JSON.stringify({
            version: 1, traceId: turn.traceId, mode: "recovery-proof-shape", available: true, ...shape,
          })}`);
        } catch {
          // Optional content-free discovery cannot invalidate a successfully completed response.
          console.info(`[chatgpt-web-metric] ${JSON.stringify({
            version: 1, traceId: turn.traceId, mode: "recovery-proof-shape", available: false,
          })}`);
        }
      }
      captureDisposition.complete();
      if (chatGptCompletedRebindDiagnosticsEnabled()) {
        // Observation-only canary after successful completion; never a recovery/replay authority.
        // Do not allow diagnostic failure to turn a completed capture into an adapter retry.
        const metric = {
          beforePresent: false, afterPresent: false, exactMatch: false, freshCount: 0,
          freshUuidLike: false, sameDocument: false, sameAssistant: false,
          postCommitMessagePresent: recoveryIdentity.messageDiagnostic().hasCommittedMessage,
          postCommitMessageExact: false,
          earlyMessageIdEqual: false, earlyDocumentIdEqual: false, earlyAssistantIdentityEqual: false,
          earlyProofConflicted: false, atomicDomProof: false, postRebindMarkdownExact: false, markdownIdentityFence: false,
          domContinuityAvailable: false, domIdentityContinuityExact: false, domIdentityMutationRecords: 0, domContinuityExpired: false,
          wireMessageMappingPresent: false, wireMessageIdEqual: false, wireMessageMappingConflicted: false,
          wireMessageMappingUnknown: false, freshConversationPresent: false, freshConversationEqual: false,
          serverConversationProof: undefined as ChatGptRecoveryServerProofResult | undefined,
          serverConversationProofExact: false,
          freshServerConversationReachable: false,
          diagnosticOnly: true, recoveryAuthorized: false, wireLinkedDomProof: false,
          evidenceScope: "completed-identity-only", evidenceEvaluated: false, evidenceMatched: false,
          evidenceReasons: [] as ChatGptTurnRecoveryEvidenceReason[],
          equivalentEvidenceScope: "temporary-turn-continuity-equivalent", equivalentEvidenceEvaluated: false,
          equivalentEvidenceMatched: false, equivalentEvidenceReasons: [] as ChatGptRecoveryEquivalentEvidenceReason[],
          ...earlyMessageSampler?.diagnostic(),
          earlyRecordOutcomes: { ...earlyRecordOutcomes },
          requestObservationScope: "page-fetch-only", fetchRequestObservationAvailable: false,
          fetchWrapperCurrent: false, observedConversationPostAttempts: 0, fetchCountSaturated: false,
          independentRequestObservation: undefined as Awaited<ReturnType<ChatGptRecoveryRequestObserver["snapshot"]>> | undefined,
          appConversationBinding: undefined as Awaited<ReturnType<ChatGptRecoveryRequestObserver["conversationBinding"]>> | undefined,
          appConversationBindingExact: false,
          requestCountsAgree: false,
          ...(turnIdContinuity?.diagnostic() ?? {
            turnIdObserved: false, turnIdValidObservations: 0, turnIdInvalidObservations: 0,
            turnIdAssistantTransitions: 0, turnIdStableAssistantTransitions: 0, turnIdConflict: false,
            turnIdStableAcrossObservedAssistantTransitions: false,
          }),
          turnIdFreshPresent: false, turnIdFreshEqual: false, turnIdAssistantChangedFromFirst: false,
          generationTurnIdContinuity: generationTurnIdContinuityResult ?? { available: false, sameDocument: false, expired: false,
            turnIdObserved: false, turnIdConflict: false, validSnapshots: 0, invalidSnapshots: 0, assistantTransitions: 0,
            stableAssistantTransitions: 0, turnIdMutationRecords: 0, turnIdAbaRecords: 0, stable: false },
          provenRebound: false, noExtraUser: false, sameSurface: false, passed: false,
        };
        const continuityToken = randomUUID();
        let continuityStarted = false;
        try {
          await withChatGptRecoveryDiagnosticBudget(deadline, turn.abortSignal, async signal => {
          if (!completedRebindEligible) throw new Error("diagnostic ineligible");
          const checkBudget = (): void => {
            if (signal.aborted || (deadline !== undefined && Date.now() >= deadline)) {
              throw new Error("diagnostic budget exhausted");
            }
          };
          checkBudget();
          continuityStarted = await withBrowserTurnAbort(page.evaluate(startChatGptRecoveryDomContinuity, {
            token: continuityToken, documentId: responseTurn.documentId,
            deadline: Math.min(deadline ?? Infinity, Date.now() + 15_000),
            userSelector: CHATGPT_USER_TURN_SELECTOR, assistantSelector: CHATGPT_ASSISTANT_TURN_SELECTOR,
          }), signal);
          if (!continuityStarted) throw new Error("diagnostic continuity observer unavailable");
          const before = await readRecoveryProof(signal);
          validateRecoveryProof(before);
          metric.beforePresent = before.count === 1 && before.uuidLike && before.documentMatches === 1
            && before.documentId === responseTurn.documentId;
          if (!metric.beforePresent) throw new Error("diagnostic missing unique message proof");
          checkBudget();
          await withBrowserTurnAbort(rebindLauncherPage(1, new Error("completed-turn observation canary"), signal), signal);
          checkBudget();
          const fresh = await readRecoveryProof(signal);
          const identity = validateRecoveryProof(fresh);
          metric.sameDocument = fresh.documentId === responseTurn.documentId;
          if (fresh.userIdentities.length !== responseTurn.acceptedUserTurnIdentities.length
            || responseTurn.acceptedUserTurnIdentities.some(id => !fresh.userIdentities.includes(id))) {
            throw new Error("diagnostic user set changed");
          }
          metric.noExtraUser = true; // Exact user-set check above, not a network submission counter.
          metric.sameSurface = true; // Reconnect helper targets the original owned surface only.
          metric.sameAssistant = identity === responseTurn.identity;
          metric.provenRebound = !metric.sameAssistant;
          const after = fresh;
          metric.atomicDomProof = true;
          if (turnIdContinuity) Object.assign(metric, turnIdContinuity.compareFresh(after));
          checkBudget();
          metric.freshCount = after.count;
          metric.freshUuidLike = after.uuidLike;
          metric.afterPresent = after.count === 1 && after.uuidLike && after.documentMatches === 1
            && after.documentId === fresh.documentId;
          metric.exactMatch = metric.afterPresent && before.messageId === after.messageId;
          const early = recoveryIdentity.compareCommittedMessage(after.messageId, after.documentId, identity);
          metric.earlyMessageIdEqual = early.messageIdEqual;
          metric.earlyDocumentIdEqual = early.documentIdEqual;
          metric.earlyAssistantIdentityEqual = early.assistantIdentityEqual;
          metric.earlyProofConflicted = early.conflicted;
          const wire = wireCapture?.snapshot();
          metric.wireMessageMappingPresent = !!wire?.assistantMessageId && !!wire?.assistantMessageConversationId;
          metric.wireMessageMappingConflicted = wire?.assistantMessageIdentityConflict === true;
          metric.wireMessageMappingUnknown = !metric.wireMessageMappingPresent || wire?.assistantMessageIdentityUnknown === true;
          metric.wireMessageIdEqual = metric.wireMessageMappingPresent && wire?.assistantMessageId === after.messageId;
          const originalProof = recoveryIdentity.committedSnapshot();
          const expectedServerConversationId = originalProof?.identity.conversationId;
          const expectedServerMessageId = originalProof?.wireMessage?.messageId;
          // Snapshot page-generated run-control traffic BEFORE issuing any diagnostic fetch so the
          // probe cannot manufacture its own "app conversation binding" evidence.
          if (requestObservation && expectedServerConversationId) {
            metric.appConversationBinding = await withBrowserTurnAbort(
              requestObservation.conversationBinding(expectedServerConversationId), signal,
            );
            metric.appConversationBindingExact = metric.appConversationBinding.exact;
          }
          if (expectedServerConversationId && expectedServerMessageId) {
            metric.serverConversationProof = await withBrowserTurnAbort(page.evaluate(
              collectChatGptRecoveryServerProof,
              {
                expectedConversationId: expectedServerConversationId,
                expectedMessageId: expectedServerMessageId,
                deadline: Math.min(deadline ?? Infinity, Date.now() + 5_000),
              },
            ), signal);
          }
          metric.serverConversationProofExact = chatGptRecoveryServerProofExact(metric.serverConversationProof);
          metric.freshServerConversationReachable = metric.serverConversationProofExact
            || (metric.serverConversationProof?.sessionFetchOk === true
              && metric.serverConversationProof.streamStatusFetchOk === true
              && metric.serverConversationProof.streamStatusJsonObject === true
              && metric.serverConversationProof.streamStatusHttpStatus !== undefined
              && metric.serverConversationProof.streamStatusHttpStatus >= 200
              && metric.serverConversationProof.streamStatusHttpStatus < 300);
          metric.freshConversationPresent = metric.serverConversationProof?.conversationFetchOk === true
            && metric.serverConversationProof.malformed === false;
          metric.freshConversationEqual = metric.serverConversationProofExact;
          if (originalProof) {
            const evaluation = evaluateChatGptTurnRecoveryEvidence(originalProof, {
              surfaceId: launcherSurfaceId, documentId: after.documentId,
              // The original wire ID is supplied only after the freshly rebound page independently
              // authenticated and proved that exact server conversation+assistant membership.
              conversationId: metric.serverConversationProofExact ? expectedServerConversationId : undefined,
              assistantTurnIdentity: identity, messageId: after.messageId,
              // No fresh handoff source here; do not copy the original wire topic into a candidate.
            });
            metric.evidenceEvaluated = true;
            metric.evidenceMatched = evaluation.matched;
            metric.evidenceReasons = evaluation.reasons;
          }
          const freshMarkdown = await withBrowserTurnAbort(this.responseDomSnapshot(
            page.locator(`[data-turn-id=${JSON.stringify(identity)}]`), {},
          ), signal);
          const diagnosticBuffer = new ChatGptMarkdownBuffer();
          diagnosticBuffer.observe(freshMarkdown.markdownSegments);
          metric.postRebindMarkdownExact = freshMarkdown.responsePresent && diagnosticBuffer.finish().markdown === finalText;
          const fence = await readRecoveryProof(signal);
          validateRecoveryProof(fence);
          metric.markdownIdentityFence = sameChatGptRecoveryDomSnapshot(after, fence);
          if (generationTurnIdContinuityStarted && generationTurnIdContinuityToken) {
            generationTurnIdContinuityResult = await withBrowserTurnAbort(page.evaluate(
              finishChatGptRecoveryTurnIdMutationContinuity, generationTurnIdContinuityToken,
            ), signal).catch(() => undefined);
            generationTurnIdContinuityStarted = false;
            if (generationTurnIdContinuityResult) {
              metric.generationTurnIdContinuity = generationTurnIdContinuityResult;
            }
          }
          const continuity = await withBrowserTurnAbort(page.evaluate(finishChatGptRecoveryDomContinuity, continuityToken), signal);
          continuityStarted = false;
          metric.domContinuityAvailable = continuity.available;
          metric.domIdentityContinuityExact = continuity.unchanged;
          metric.domIdentityMutationRecords = continuity.identityMutationRecords;
          metric.domContinuityExpired = continuity.expired;
          const fetchDiagnostic = webStreamTap
            ? await withBrowserTurnAbort(webStreamTap.readFetchSubmissionDiagnostic(page), signal)
            : { available: false as const };
          metric.fetchRequestObservationAvailable = fetchDiagnostic.available;
          if (fetchDiagnostic.available) {
            metric.fetchWrapperCurrent = fetchDiagnostic.wrapperCurrent;
            metric.observedConversationPostAttempts = fetchDiagnostic.conversationPostAttempts;
            metric.fetchCountSaturated = fetchDiagnostic.saturated;
          }
          if (requestObservation) metric.independentRequestObservation = await withBrowserTurnAbort(requestObservation.snapshot(), signal);
          metric.requestCountsAgree = recoveryRequestCountsAgree(metric.independentRequestObservation, fetchDiagnostic);
          metric.wireLinkedDomProof = metric.wireMessageMappingPresent && !metric.wireMessageMappingConflicted
            && !metric.wireMessageMappingUnknown && metric.wireMessageIdEqual && metric.markdownIdentityFence;
          checkBudget();
          metric.postCommitMessageExact = recoveryIdentity.matchesCommittedMessage(
            before.messageId, before.documentId, responseTurn.identity,
          ) && recoveryIdentity.matchesCommittedMessage(after.messageId, after.documentId, identity);
          const equivalent = evaluateChatGptRecoveryEquivalentEvidence({
            proof: originalProof,
            atomicDomProof: metric.atomicDomProof,
            exactMessageAcrossRebind: metric.exactMatch,
            freshUuidLike: metric.freshUuidLike,
            freshCount: metric.freshCount,
            wireMessageMappingPresent: metric.wireMessageMappingPresent,
            wireMessageIdEqual: metric.wireMessageIdEqual,
            wireMessageMappingConflicted: metric.wireMessageMappingConflicted,
            wireMessageMappingUnknown: metric.wireMessageMappingUnknown,
            sameSurface: metric.sameSurface,
            sameDocument: metric.sameDocument,
            noExtraUser: metric.noExtraUser,
            sameAssistant: metric.sameAssistant,
            provenRebound: metric.provenRebound,
            appConversationBindingExact: metric.appConversationBindingExact,
            freshServerConversationReachable: metric.freshServerConversationReachable,
            generationTurnIdContinuity: metric.generationTurnIdContinuity,
            requestCountsAgree: metric.requestCountsAgree,
            postRebindMarkdownExact: metric.postRebindMarkdownExact,
            markdownIdentityFence: metric.markdownIdentityFence,
            domIdentityContinuityExact: metric.domIdentityContinuityExact,
          });
          metric.equivalentEvidenceEvaluated = true;
          metric.equivalentEvidenceMatched = equivalent.matched;
          metric.equivalentEvidenceReasons = equivalent.reasons;
          const persistedDetailStrict = metric.evidenceEvaluated && metric.evidenceMatched && metric.evidenceReasons.length === 0
            && metric.exactMatch && metric.sameDocument && metric.noExtraUser && metric.sameSurface
            && metric.postCommitMessageExact && metric.postRebindMarkdownExact && metric.markdownIdentityFence
            && metric.domIdentityContinuityExact && metric.requestCountsAgree && metric.serverConversationProofExact;
          metric.passed = persistedDetailStrict || (metric.equivalentEvidenceEvaluated
            && metric.equivalentEvidenceMatched && metric.equivalentEvidenceReasons.length === 0);
          });
        } catch {
          // Never log Playwright errors here: they can include DOM attribute values.
        } finally {
          if (continuityStarted) {
            await withChatGptBrowserObservationTimeout(page.evaluate(finishChatGptRecoveryDomContinuity, continuityToken))
              .catch(() => {}); // The page-side observer also expires if transport cleanup cannot run.
          }
        }
        console.info(`[chatgpt-web-metric] ${JSON.stringify({
          version: 1, traceId: turn.traceId, mode: "completed-rebind-proof", ...metric,
        })}`);
      }
      return finalText;
    } catch (error) {
      captureDisposition.failAfterCommit(submissionDisposition.snapshot());
      if (captureDisposition.snapshot() === "incomplete-after-commit") {
        recoveryIdentity.freezeCommittedProof();
      }
      earlyRecoverySampler?.close();
      console.error(
        `[chatgpt-web] browser turn ${turn.traceId} failed:`
        + ` ${redactChatGptUiDiagnostic(error instanceof Error ? error.message : String(error))}`,
      );
      if (diagnosticPage && !diagnosticPage.isClosed()) {
        await diagnostics.capture(diagnosticPage, "turn-failed", error);
      }
      throw error;
    } finally {
      turn.steering?.close();
      earlyRecoverySampler?.close();
      if (earlyRecoverySampling) await earlyRecoverySampling.catch(() => {});
      if (generationTurnIdContinuityStarted && generationTurnIdContinuityToken && diagnosticPage && !diagnosticPage.isClosed()) {
        await withChatGptBrowserObservationTimeout(diagnosticPage.evaluate(
          finishChatGptRecoveryTurnIdMutationContinuity, generationTurnIdContinuityToken,
        )).catch(() => {});
        generationTurnIdContinuityStarted = false;
      }
      prepared.release();
      if (wireCapture) recoveryIdentity.observeWireSnapshot(wireCapture.snapshot());
      console.info(`[chatgpt-web-metric] ${JSON.stringify({
        version: 1,
        traceId: turn.traceId,
        mode: "recovery-identity",
        submissionDisposition: submissionDisposition.snapshot(),
        captureDisposition: captureDisposition.snapshot(),
        ...recoveryIdentity.diagnostic(),
        ...recoveryIdentity.messageDiagnostic(),
      })}`);
      if (requestInjectionShadow) {
        const shadow = requestInjectionShadow.snapshot();
        console.info(`[chatgpt-web-metric] ${JSON.stringify({
          version: 1,
          traceId: turn.traceId,
          mode: "request-injection-shadow",
          observed: shadow.observed,
          supportedBody: shadow.supportedBody,
          bodyTransport: shadow.bodyTransport,
          jsonObject: shadow.jsonObject,
          exactValueMatches: shadow.exactValueMatches,
          bodyChars: shadow.bodyChars,
          promptShape: shadow.promptShape,
        })}`);
      }
      if (requestInjectionCdpShadow) {
        const shadow = requestInjectionCdpShadow.snapshot();
        console.info(`[chatgpt-web-metric] ${JSON.stringify({
          version: 1,
          traceId: turn.traceId,
          mode: "request-injection-cdp-shadow",
          observed: shadow.observed,
          supportedBody: shadow.supportedBody,
          bodyTransport: shadow.bodyTransport,
          jsonObject: shadow.jsonObject,
          wouldRewrite: shadow.wouldRewrite,
          failureCode: shadow.failureCode,
          exactValueMatches: shadow.exactValueMatches,
          literalMatches: shadow.literalMatches,
          bodyChars: shadow.bodyChars,
        })}`);
      }
      if (requestInjectionCdpInjector) {
        const injection = requestInjectionCdpInjector.snapshot();
        console.info(`[chatgpt-web-metric] ${JSON.stringify({
          version: 1,
          traceId: turn.traceId,
          mode: "request-injection-cdp-primary",
          observed: injection.observed,
          rewritten: injection.rewritten,
          failureCode: injection.failureCode,
          exactValueMatches: injection.exactValueMatches,
          literalMatches: injection.literalMatches,
          originalBodyChars: injection.originalBodyChars,
          rewrittenBodyChars: injection.rewrittenBodyChars,
        })}`);
      }
      if (requestInjector) {
        const injection = requestInjector.snapshot();
        console.info(`[chatgpt-web-metric] ${JSON.stringify({
          version: 1,
          traceId: turn.traceId,
          mode: "request-injection-primary",
          observed: injection.observed,
          rewritten: injection.rewritten,
          failureCode: injection.failureCode,
          exactValueMatches: injection.exactValueMatches,
          literalMatches: injection.literalMatches,
          originalBodyChars: injection.originalBodyChars,
          rewrittenBodyChars: injection.rewrittenBodyChars,
        })}`);
      }
      stopRecoveryWireObservation?.();
      if (browserWideRequestObservation) await browserWideRequestObservation.close().catch(() => {});
      if (requestObservation) await requestObservation.close().catch(() => {});
      if (requestObservationConnection) await requestObservationConnection.close().catch(() => {});
      if (webStreamTap) await webStreamTap.close().catch(() => {});
      if (requestInjectionCdpShadow) await requestInjectionCdpShadow.close().catch(() => {});
      if (requestInjectionCdpInjector) await requestInjectionCdpInjector.close().catch(() => {});
      if (requestInjector) await requestInjector.close().catch(() => {});
      if (stageRequestInjector) await stageRequestInjector.close().catch(() => {});
      if (requestInjectionShadow) await requestInjectionShadow.close().catch(() => {});
      if (turnConnection) {
        await turnConnection.close().catch(error => {
          console.error(
            `[chatgpt-web] failed to release launcher browser connection for ${turn.traceId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      } else if (managedPage && !managedPage.isClosed()) {
        await managedPage.close().catch(error => {
          console.error(
            `[chatgpt-web] failed to close managed browser tab for ${turn.traceId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      }
    }
  }
}
