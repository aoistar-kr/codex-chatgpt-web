import type { ChatGptWebModelMode } from "./model";

export type ChatGptTurnTransportMode = "off" | "shadow" | "primary";
export type ChatGptDomObservationMode = "mutation" | "cadence";

export interface ChatGptTurnPlanFeatureFlags {
  requestInjectionPrimary: boolean;
  requestInjectionShadow: boolean;
  requestInjectionCdpShadow: boolean;
  requestInjectionCdpPrimary: boolean;
  networkStreamPrimary: boolean;
  networkStreamShadow: boolean;
  incompleteCaptureRecovery: boolean;
  /** Explicit measurement-only fallback to the pre-P9 cadence. Never enables mutation mode. */
  domObservationCadenceCanary?: boolean;
}

export interface ChatGptTurnPlanInput {
  features: ChatGptTurnPlanFeatureFlags;
  multipart: boolean;
  imageCount: number;
  localTools: boolean;
  reuseConversation: boolean;
  compaction: boolean;
  captureLunaCheckpoint: boolean;
  requestedEffort: ChatGptWebModelMode["effort"];
  stagingEffort: ChatGptWebModelMode["effort"];
  prewarmedMode: boolean;
  externalProgress: boolean;
  completionFence: boolean;
  launcherOwnedSurface: boolean;
}

export interface ChatGptTurnPlan {
  requestInjection: ChatGptTurnTransportMode;
  requestInjectionCdpShadow: boolean;
  requestInjectionCdpPrimary: boolean;
  networkStream: ChatGptTurnTransportMode;
  initialEffortSelectionRequired: boolean;
  domObservation: ChatGptDomObservationMode;
  incompleteCaptureRecovery: boolean;
}

export function chatGptEffortSelectionRequired(
  reuseConversation: boolean,
  requestedEffort: string,
  stagingEffort: string,
): boolean {
  return !reuseConversation || requestedEffort !== stagingEffort;
}

/**
 * Resolve per-turn browser policy from already-observed facts only.
 *
 * This function deliberately knows nothing about process.env, Playwright, launcher I/O, or DOM
 * state. It centralizes eligibility without changing when the selected transports are installed or
 * how their fail-closed fallbacks execute.
 */
export function resolveChatGptTurnPlan(input: ChatGptTurnPlanInput): ChatGptTurnPlan {
  const requestPrimaryEligible = !input.multipart
    && input.imageCount === 0
    && !input.compaction;
  const requestPrimary = input.features.requestInjectionPrimary && requestPrimaryEligible;
  const requestCdpPrimaryEligible = requestPrimaryEligible && !input.reuseConversation;
  // The proven page-fetch writer wins if both experimental flags are accidentally enabled.
  // A turn never has two request-body writers.
  const requestCdpPrimary = !requestPrimary
    && input.features.requestInjectionCdpPrimary
    && requestCdpPrimaryEligible
    && !input.localTools;
  const requestShadow = !requestCdpPrimary
    && input.features.requestInjectionShadow
    && !input.multipart
    && !input.localTools
    && !input.reuseConversation;
  const requestCdpShadow = !requestCdpPrimary
    && input.features.requestInjectionCdpShadow
    && !input.multipart
    && !input.localTools
    && !input.reuseConversation;

  const networkPrimary = input.features.networkStreamPrimary
    && (input.requestedEffort === "low"
      || input.requestedEffort === "medium"
      || input.requestedEffort === "high"
      || input.requestedEffort === "xhigh"
      || input.requestedEffort === "max")
    && !input.captureLunaCheckpoint;

  // H5 recovery is intentionally narrower than ordinary DOM observation because it must stay on
  // one launcher-owned surface and may never compete with network-primary output or any turn mode
  // whose state is externally mutable.
  const incompleteCaptureRecovery = input.features.incompleteCaptureRecovery
    && input.launcherOwnedSurface
    && input.features.networkStreamShadow
    && !networkPrimary
    && !input.multipart
    && !input.localTools
    && !input.reuseConversation
    && !input.compaction
    && !input.captureLunaCheckpoint
    && !input.externalProgress
    && !input.completionFence;

  const exactPrewarmedInitialMode = input.prewarmedMode
    && input.stagingEffort === input.requestedEffort;
  const cadenceCanary = input.features.domObservationCadenceCanary === true
    && input.launcherOwnedSurface && requestCdpPrimaryEligible && !networkPrimary
    && !input.captureLunaCheckpoint && !input.externalProgress && !input.completionFence;

  return {
    requestInjection: requestPrimary ? "primary" : requestShadow ? "shadow" : "off",
    requestInjectionCdpShadow: requestCdpShadow,
    requestInjectionCdpPrimary: requestCdpPrimary,
    networkStream: networkPrimary
      ? "primary"
      : input.features.networkStreamShadow ? "shadow" : "off",
    initialEffortSelectionRequired: !exactPrewarmedInitialMode && chatGptEffortSelectionRequired(
      input.reuseConversation,
      input.requestedEffort,
      input.stagingEffort,
    ),
    domObservation: input.localTools || input.externalProgress || input.completionFence || cadenceCanary
      ? "cadence"
      : "mutation",
    incompleteCaptureRecovery,
  };
}
