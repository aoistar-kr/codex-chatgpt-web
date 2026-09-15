export interface RequestRewriteCanaryEvidence {
  traceId: string;
  observed: boolean;
  rewritten: boolean;
  exactValueMatches?: number;
  literalMatches?: number;
  failureCode?: string;
}

export interface DomObservationCanaryEvidence {
  domObservation?: "mutation" | "cadence";
  domFullScans?: number;
  domCacheHits?: number;
  domMutationWaits?: number;
  domMutationWakeups?: number;
  domMutationTimeouts?: number;
  initialEffortSelectionRequired?: boolean;
  exactPrewarmedMode?: boolean;
}

export interface HandoffCanaryEvidence {
  traceId: string;
  handoffObserved?: boolean;
  handoffObservedMs?: number;
  firstHandoffChunkMs?: number;
  wireCompletionMs?: number;
  comparison?: "exact" | "different" | "failed" | "incomplete" | "not-observed" | "wire-only";
  markdownEquivalence?: "exact" | "known-safe" | "different";
}

export function parseDomObservationCanary(value: string | undefined, networkPrimary: boolean): "mutation" | "cadence" | undefined {
  if (value === undefined) return undefined;
  if (value !== "mutation" && value !== "cadence") throw new Error("DOM observation canary must be mutation or cadence");
  if (networkPrimary) throw new Error("DOM observation canary requires DOM-authority shadow mode");
  return value;
}

/** Observed policy/counters are required; requested env flags are not execution evidence. */
export function domObservationCanaryAccepted(evidence: DomObservationCanaryEvidence[], expected: "mutation" | "cadence"): boolean {
  return evidence.length > 0 && evidence.every(metric => {
    const counts = [metric.domFullScans, metric.domCacheHits, metric.domMutationWaits, metric.domMutationWakeups, metric.domMutationTimeouts];
    return metric.domObservation === expected
      && counts.every(count => Number.isSafeInteger(count) && Number(count) >= 0)
      && metric.domFullScans! > 0
      && metric.domMutationWakeups! + metric.domMutationTimeouts! <= metric.domMutationWaits!
      && (expected !== "cadence" || metric.domMutationWaits === 0)
      && typeof metric.initialEffortSelectionRequired === "boolean"
      && typeof metric.exactPrewarmedMode === "boolean"
      && !(metric.exactPrewarmedMode && metric.initialEffortSelectionRequired);
  });
}

/** A correct answer alone cannot prove the requested experimental transport actually ran. */
export function requestRewriteCanaryAccepted(
  evidence: RequestRewriteCanaryEvidence[],
  streamTraceIds: string[],
): boolean {
  if (streamTraceIds.length === 0 || evidence.length !== streamTraceIds.length) return false;
  const expected = new Set(streamTraceIds);
  if (expected.size !== streamTraceIds.length || streamTraceIds.some(traceId => !traceId)) return false;
  const observed = new Set<string>();
  for (const metric of evidence) {
    if (!expected.has(metric.traceId) || observed.has(metric.traceId)
      || metric.observed !== true || metric.rewritten !== true || metric.failureCode !== undefined
      || metric.exactValueMatches !== 1 || metric.literalMatches !== 1) return false;
    observed.add(metric.traceId);
  }
  return true;
}

/**
 * Explicit P8 live-proof gate. A successful answer is insufficient: every requested stream must
 * prove an observed handoff, at least one exact-topic WS chunk after it, terminal wire completion,
 * and unchanged final Markdown. Trace cardinality is exact so unrelated handoff evidence cannot
 * make another run pass.
 */
export function handoffCanaryAccepted(
  evidence: HandoffCanaryEvidence[],
  streamTraceIds: string[],
): boolean {
  if (streamTraceIds.length === 0 || evidence.length !== streamTraceIds.length) return false;
  const expected = new Set(streamTraceIds);
  if (expected.size !== streamTraceIds.length || streamTraceIds.some(traceId => !traceId)) return false;
  const observed = new Set<string>();
  for (const metric of evidence) {
    if (!expected.has(metric.traceId) || observed.has(metric.traceId) || metric.handoffObserved !== true) return false;
    const handoffMs = metric.handoffObservedMs;
    const firstChunkMs = metric.firstHandoffChunkMs;
    const completionMs = metric.wireCompletionMs;
    if (!Number.isSafeInteger(handoffMs) || handoffMs! < 0
      || !Number.isSafeInteger(firstChunkMs) || firstChunkMs! < handoffMs!
      || !Number.isSafeInteger(completionMs) || completionMs! < firstChunkMs!) return false;
    if (metric.comparison !== "exact"
      || (metric.markdownEquivalence !== "exact" && metric.markdownEquivalence !== "known-safe")) return false;
    observed.add(metric.traceId);
  }
  return true;
}
