import { mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, type AppConfig } from "../src/config";
import { createLauncherDevAdapter, DevChatDriver } from "../src/dev-chat/driver";
import { DevChatStore, type DevChatModel } from "../src/dev-chat/session";
import { inspectRichMarkdownFixture, richMarkdownExpected, richMarkdownPrompt } from "./lib/stream-canary-fixtures";
import type { ChatGptRequestPromptShape } from "../src/adapters/chatgpt-web/web-stream/request-injection";
import { handoffCanaryAccepted, requestRewriteCanaryAccepted, parseDomObservationCanary, domObservationCanaryAccepted, type DomObservationCanaryEvidence } from "./lib/stream-canary-acceptance";

const METRIC_MARKER = "[chatgpt-web-metric] ";
const EXPECTED = "STREAMCANARYOK";

type CanaryCase = "plain" | "markdown";

interface StreamMetric extends DomObservationCanaryEvidence {
  version: number;
  traceId: string;
  mode: "shadow" | "primary";
  comparison: "exact" | "different" | "failed" | "incomplete" | "not-observed" | "wire-only";
  status?: number;
  wireChars: number;
  domChars?: number;
  fixtureWireSourceExact?: boolean;
  fixtureDomSourceExact?: boolean;
  markdownEquivalence?: "exact" | "known-safe" | "different";
  markdownNormalizations?: string[];
  markdownDifference?: {
    firstDifferenceOffset: number;
    commonSuffixChars: number;
    wireCharClass: string;
    domCharClass: string;
    wireLines: number;
    domLines: number;
    wireBlankLines: number;
    domBlankLines: number;
    wireTrailingSpaceLines: number;
    domTrailingSpaceLines: number;
    wireFenceLines: number;
    domFenceLines: number;
    wirePipeChars: number;
    domPipeChars: number;
    wireListMarkerLines: number;
    domListMarkerLines: number;
    wireBlockquoteLines: number;
    domBlockquoteLines: number;
    wireBackslashes: number;
    domBackslashes: number;
  };
  protocolTrace?: Array<Record<string, unknown>>;
  protocolTraceDropped?: number;
  protocolSummary?: Record<string, number>;
  handoffObserved?: boolean;
  sendAcceptanceMs?: number;
  responseStartMs?: number;
  firstTextMs?: number;
  handoffObservedMs?: number;
  firstHandoffChunkMs?: number;
  wireCompletionMs?: number;
  domCompletionMs?: number;
}

function canaryCase(): CanaryCase {
  const value = process.env.CODEX_CHATGPT_WEB_STREAM_CANARY_CASE?.trim().toLowerCase();
  if (!value || value === "plain") return "plain";
  if (value === "markdown") return "markdown";
  throw new Error("CODEX_CHATGPT_WEB_STREAM_CANARY_CASE must be plain or markdown");
}

interface RequestInjectionShadowMetric {
  version: number;
  traceId: string;
  mode: "request-injection-shadow";
  observed: boolean;
  supportedBody?: boolean;
  bodyTransport?: "init-string" | "request-clone" | "unsupported";
  jsonObject?: boolean;
  exactValueMatches?: number;
  bodyChars?: number;
  promptShape?: ChatGptRequestPromptShape;
}

interface RequestInjectionPrimaryMetric {
  version: number;
  traceId: string;
  mode: "request-injection-primary";
  observed: boolean;
  rewritten: boolean;
  failureCode?: string;
  exactValueMatches?: number;
  literalMatches?: number;
  originalBodyChars?: number;
  rewrittenBodyChars?: number;
}

interface RequestInjectionCdpShadowMetric {
  version: number;
  traceId: string;
  mode: "request-injection-cdp-shadow";
  observed: boolean;
  supportedBody?: boolean;
  bodyTransport?: "post-data" | "missing-post-data";
  jsonObject?: boolean;
  wouldRewrite?: boolean;
  failureCode?: string;
  exactValueMatches?: number;
  literalMatches?: number;
  bodyChars?: number;
}

interface RequestInjectionCdpPrimaryMetric {
  version: number;
  traceId: string;
  mode: "request-injection-cdp-primary";
  observed: boolean;
  rewritten: boolean;
  failureCode?: string;
  exactValueMatches?: number;
  literalMatches?: number;
  originalBodyChars?: number;
  rewrittenBodyChars?: number;
}

interface IncompleteCaptureRecoveryMetric {
  version: number;
  traceId: string;
  mode: "incomplete-capture-recovery";
  attempted: boolean;
  authorized: boolean;
  reasons: string[];
  promptReplayAuthorized: false;
  submissionDisposition: string;
  captureDisposition: string;
  appConversationBindingExact: boolean;
  freshServerReachable: boolean;
  generationTurnIdStable: boolean;
  fetchConversationPostAttempts: number;
  independentConversationPostEvents: number;
  independentDistinctRequestIds: number;
  browserWideRequestObservationExact: boolean;
  browserWideConversationPostEvents: number;
  browserWideContextCount: number;
  requestCountsAgree: boolean;
  freshMarkdownCompatible: boolean;
  freshSnapshotFenceExact: boolean;
  freshMessageExact: boolean;
  sameDocument: boolean;
  noExtraUser: boolean;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 10) {
    throw new Error("CODEX_CHATGPT_WEB_STREAM_CANARY_RUNS must be an integer from 1 to 10");
  }
  return parsed;
}

function model(config: AppConfig): DevChatModel {
  const requested = process.env.CODEX_CHATGPT_WEB_STREAM_CANARY_MODEL?.trim();
  if (requested) return requested as DevChatModel;
  return config.solAvailable ? "chatgpt-web/light" : "chatgpt-web/luna";
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function summary(metrics: StreamMetric[]): Record<string, unknown> {
  const values = (key: keyof StreamMetric): number[] => metrics
    .map(metric => metric[key])
    .filter((value): value is number => typeof value === "number");
  return {
    runs: metrics.length,
    exactComparisons: metrics.filter(metric => metric.comparison === "exact").length,
    knownSafeComparisons: metrics.filter(metric => metric.markdownEquivalence === "known-safe").length,
    structuralDifferences: metrics.filter(metric => metric.markdownEquivalence === "different").length,
    handoffRuns: metrics.filter(metric => metric.handoffObserved === true).length,
    medianResponseStartMs: median(values("responseStartMs")),
    medianFirstTextMs: median(values("firstTextMs")),
    medianHandoffObservedMs: median(values("handoffObservedMs")),
    medianFirstHandoffChunkMs: median(values("firstHandoffChunkMs")),
    medianWireCompletionMs: median(values("wireCompletionMs")),
    medianDomCompletionMs: median(values("domCompletionMs")),
  };
}

const config = loadConfig();
if (config.browserHost !== "launcher") {
  throw new Error("Live stream canary requires the authenticated embedded launcher browser");
}

const runs = positiveInteger(process.env.CODEX_CHATGPT_WEB_STREAM_CANARY_RUNS, 1);
const selectedModel = model(config);
const selectedCase = canaryCase();
const primary = process.env.CODEX_CHATGPT_WEB_STREAM_CANARY_PRIMARY === "1";
const requireHandoff = process.env.CODEX_CHATGPT_WEB_STREAM_CANARY_REQUIRE_HANDOFF === "1";
const domObservationCanary = parseDomObservationCanary(process.env.CODEX_CHATGPT_WEB_STREAM_CANARY_DOM_OBSERVATION, primary);
const allowMarkdownPrimary = process.env.CODEX_CHATGPT_WEB_STREAM_CANARY_ALLOW_MARKDOWN_PRIMARY === "1";
if (selectedCase === "markdown" && primary && !allowMarkdownPrimary) {
  throw new Error(
    "Markdown primary canary requires explicit diagnostic opt-in with "
    + "CODEX_CHATGPT_WEB_STREAM_CANARY_ALLOW_MARKDOWN_PRIMARY=1",
  );
}
const scratch = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-stream-canary-"));
const metrics: StreamMetric[] = [];
const rebindDiagnostics: Array<{ mode: "completed-rebind-proof"; traceId: string; passed: boolean }> = [];
const richDomCodeShapes: Array<{ mode: "rich-dom-code-shape"; traceId: string; preBlocks?: number; preShapes?: string[] }> = [];
const requestInjectionShadows: RequestInjectionShadowMetric[] = [];
const requestInjectionPrimaries: RequestInjectionPrimaryMetric[] = [];
const requestInjectionCdpShadows: RequestInjectionCdpShadowMetric[] = [];
const requestInjectionCdpPrimaries: RequestInjectionCdpPrimaryMetric[] = [];
const incompleteCaptureRecoveries: IncompleteCaptureRecoveryMetric[] = [];
const originalInfo = console.info;
console.info = (...args: unknown[]) => {
  originalInfo(...args);
  const line = args.map(String).join(" ");
  const marker = line.indexOf(METRIC_MARKER);
  if (marker < 0) return;
  try {
    const decoded = JSON.parse(line.slice(marker + METRIC_MARKER.length)) as
      | StreamMetric
      | typeof rebindDiagnostics[number]
      | typeof richDomCodeShapes[number]
      | RequestInjectionShadowMetric
      | RequestInjectionPrimaryMetric
      | RequestInjectionCdpShadowMetric
      | RequestInjectionCdpPrimaryMetric
      | IncompleteCaptureRecoveryMetric;
    if (decoded.mode === "completed-rebind-proof") rebindDiagnostics.push(decoded);
    else if (decoded.mode === "rich-dom-code-shape") richDomCodeShapes.push(decoded);
    else if (decoded.mode === "request-injection-shadow") requestInjectionShadows.push(decoded);
    else if (decoded.mode === "request-injection-primary") requestInjectionPrimaries.push(decoded);
    else if (decoded.mode === "request-injection-cdp-shadow") requestInjectionCdpShadows.push(decoded);
    else if (decoded.mode === "request-injection-cdp-primary") requestInjectionCdpPrimaries.push(decoded);
    else if (decoded.mode === "incomplete-capture-recovery") incompleteCaptureRecoveries.push(decoded);
    else if (decoded.mode === "shadow" || decoded.mode === "primary") metrics.push(decoded);
    // Other privacy-safe diagnostics (for example H5 recovery-identity) intentionally share the
    // metric marker but are not stream comparison samples and must not change canary run counts.
  } catch {
    // Preserve the diagnostic line; the missing metric fails the canary below.
  }
};

process.env.CODEX_CHATGPT_WEB_NETWORK_STREAM_SHADOW = "1";
process.env.CODEX_CHATGPT_WEB_STREAM_CANARY_EXPECTED_SHA256 = createHash("sha256")
  .update(selectedCase === "plain" ? EXPECTED : richMarkdownExpected()).digest("hex");
const completedRebind = process.env.CODEX_CHATGPT_WEB_STREAM_CANARY_COMPLETED_REBIND === "1";
process.env.CODEX_CHATGPT_WEB_COMPLETED_REBIND_DIAGNOSTICS = completedRebind ? "1" : "0";
const recoveryCanary = process.env.CODEX_CHATGPT_WEB_STREAM_CANARY_INCOMPLETE_RECOVERY === "1";
if (recoveryCanary && primary) {
  throw new Error("Incomplete-capture recovery canary requires DOM-authoritative shadow mode");
}
process.env.CODEX_CHATGPT_WEB_INCOMPLETE_CAPTURE_RECOVERY = recoveryCanary ? "1" : "0";
process.env.CODEX_CHATGPT_WEB_INCOMPLETE_CAPTURE_RECOVERY_CANARY = recoveryCanary ? "1" : "0";
process.env.CODEX_CHATGPT_WEB_NETWORK_STREAM_PRIMARY = primary ? "1" : "0";
process.env.CODEX_CHATGPT_WEB_DOM_CADENCE_CANARY = domObservationCanary === "cadence" ? "1" : "0";
const canaryProtocolDiagnostics = process.env.CODEX_CHATGPT_WEB_STREAM_CANARY_PROTOCOL_DIAGNOSTICS === "1";
process.env.CODEX_CHATGPT_WEB_STREAM_PROTOCOL_DIAGNOSTICS = selectedCase === "markdown" || canaryProtocolDiagnostics || requireHandoff
  ? "1"
  : "0";
if (process.env.CODEX_CHATGPT_WEB_STREAM_CANARY_RECOVERY_PROOF_DIAGNOSTICS === "1") {
  process.env.CODEX_CHATGPT_WEB_RECOVERY_PROOF_DIAGNOSTICS = "1";
}
const requestPrimary = process.env.CODEX_CHATGPT_WEB_STREAM_CANARY_REQUEST_PRIMARY === "1";
const requestCdpShadow = process.env.CODEX_CHATGPT_WEB_STREAM_CANARY_REQUEST_CDP_SHADOW === "1";
const requestCdpPrimary = process.env.CODEX_CHATGPT_WEB_STREAM_CANARY_REQUEST_CDP_PRIMARY === "1";
if (requestPrimary && requestCdpPrimary) {
  throw new Error("Request page-primary and CDP-primary canaries must not be enabled together");
}
process.env.CODEX_CHATGPT_WEB_REQUEST_INJECTION_PRIMARY = requestPrimary ? "1" : "0";
process.env.CODEX_CHATGPT_WEB_REQUEST_INJECTION_SHADOW = requestPrimary
  ? "0"
  : process.env.CODEX_CHATGPT_WEB_STREAM_CANARY_REQUEST_SHADOW === "0" ? "0" : "1";
process.env.CODEX_CHATGPT_WEB_REQUEST_INJECTION_CDP_SHADOW = requestCdpShadow ? "1" : "0";
process.env.CODEX_CHATGPT_WEB_REQUEST_INJECTION_CDP_PRIMARY = requestCdpPrimary ? "1" : "0";

const runtimeConfig: AppConfig = { ...config, mode: "browser-only" };
const runtime = createLauncherDevAdapter(runtimeConfig, scratch);
const store = new DevChatStore(join(scratch, "chats"));
const driver = new DevChatDriver(runtimeConfig, store, runtime.adapterFactory, process.cwd());
const results: Array<{
  accepted: boolean;
  answerExact?: boolean;
  fixtureComplete?: boolean;
  fixtureDiagnostics?: ReturnType<typeof inspectRichMarkdownFixture>;
  answer?: string;
  answerChars: number;
  elapsedMs: number;
}> = [];

try {
  for (let index = 0; index < runs; index += 1) {
    const opened = driver.open(`stream-canary-${index}-${Date.now()}`, selectedModel);
    const startedAt = Date.now();
    const prompt = selectedCase === "plain"
      ? `Reply with exactly ${EXPECTED}. Do not use tools or add punctuation.`
      : richMarkdownPrompt();
    const result = await driver.send(
      opened.state,
      prompt,
    );
    if (selectedCase === "plain") {
      const answerExact = result.text.trim() === EXPECTED;
      results.push({
        accepted: answerExact,
        answerExact,
        answer: result.text,
        answerChars: result.text.length,
        elapsedMs: Date.now() - startedAt,
      });
    } else {
      const fixtureDiagnostics = inspectRichMarkdownFixture(result.text);
      const fixtureComplete = fixtureDiagnostics.sourceExact;
      results.push({
        accepted: fixtureComplete,
        fixtureComplete,
        fixtureDiagnostics,
        answerChars: result.text.length,
        elapsedMs: Date.now() - startedAt,
      });
    }
  }
} finally {
  console.info = originalInfo;
  await driver.close().catch(() => {});
  rmSync(scratch, { recursive: true, force: true });
}

const report = {
  ok: results.length === runs
    && results.every(result => result.accepted)
    && metrics.length === runs
    && (domObservationCanary === undefined || domObservationCanaryAccepted(metrics, domObservationCanary))
    && (!completedRebind || (rebindDiagnostics.length === runs
      && rebindDiagnostics.every(metric => metric.passed)
      && new Set(rebindDiagnostics.map(metric => metric.traceId)).size === runs
      && metrics.every(metric => rebindDiagnostics.some(proof => proof.traceId === metric.traceId))))
    && (!requestCdpShadow || (
      requestInjectionCdpShadows.length === runs
      && requestInjectionCdpShadows.every(metric => metric.observed && metric.supportedBody && metric.wouldRewrite)
    ))
    && (!requestPrimary || requestRewriteCanaryAccepted(requestInjectionPrimaries, metrics.map(metric => metric.traceId)))
    && (!requestCdpPrimary || requestRewriteCanaryAccepted(requestInjectionCdpPrimaries, metrics.map(metric => metric.traceId)))
    && (!requireHandoff || handoffCanaryAccepted(metrics, metrics.map(metric => metric.traceId)))
    && (!recoveryCanary || (incompleteCaptureRecoveries.length === runs
      && incompleteCaptureRecoveries.every(metric => metric.attempted && metric.authorized
        && metric.reasons.length === 0 && metric.promptReplayAuthorized === false
        && metric.submissionDisposition === "committed" && metric.captureDisposition === "capturing"
        && metric.appConversationBindingExact && metric.freshServerReachable && metric.generationTurnIdStable
        && metric.fetchConversationPostAttempts === 1 && metric.independentConversationPostEvents === 1
        && metric.independentDistinctRequestIds === 1 && metric.browserWideRequestObservationExact
        && metric.browserWideConversationPostEvents === 1 && metric.browserWideContextCount === 1
        && metric.requestCountsAgree
        && metric.freshMarkdownCompatible && metric.freshSnapshotFenceExact && metric.freshMessageExact
        && metric.sameDocument && metric.noExtraUser)
      && new Set(incompleteCaptureRecoveries.map(metric => metric.traceId)).size === runs))
    && metrics.every(metric => {
      if (primary) return metric.mode === "primary" && metric.comparison === "wire-only";
      if (selectedCase === "plain") {
        return metric.mode === "shadow"
          && (metric.markdownEquivalence === "exact" || metric.markdownEquivalence === "known-safe");
      }
      return metric.mode === "shadow" && metric.markdownEquivalence === "exact";
    }),
  model: selectedModel,
  mode: primary ? "primary" : "shadow",
  case: selectedCase,
  requireHandoff,
  handoffAcceptance: requireHandoff
    ? handoffCanaryAccepted(metrics, metrics.map(metric => metric.traceId))
    : undefined,
  domObservationCanary,
  temporaryChat: true,
  persistedCanaryState: false,
  results,
  metrics,
  rebindDiagnostics,
  richDomCodeShapes,
  requestInjectionShadows,
  requestInjectionPrimaries,
  requestInjectionCdpShadows,
  requestInjectionCdpPrimaries,
  incompleteCaptureRecoveries,
  summary: summary(metrics),
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.ok) process.exitCode = 1;
