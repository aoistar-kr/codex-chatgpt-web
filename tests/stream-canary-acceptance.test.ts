import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { handoffCanaryAccepted, requestRewriteCanaryAccepted, parseDomObservationCanary, domObservationCanaryAccepted } from "../scripts/lib/stream-canary-acceptance";

const success = (traceId: string) => ({ traceId, observed: true, rewritten: true, exactValueMatches: 1, literalMatches: 1 });

test("DOM canary selects only explicit known modes and rejects wire-only measurement", () => {
  expect(parseDomObservationCanary(undefined, true)).toBeUndefined();
  expect(parseDomObservationCanary("mutation", false)).toBe("mutation");
  expect(parseDomObservationCanary("cadence", false)).toBe("cadence");
  for (const value of ["", "off", "Mutation", "cadence "]) expect(() => parseDomObservationCanary(value, false)).toThrow();
  expect(() => parseDomObservationCanary("cadence", true)).toThrow();
});

test("DOM A/B acceptance requires actual policy counters and consistent prewarm evidence", () => {
  const metric = { domObservation: "cadence" as const, domFullScans: 2, domCacheHits: 8, domMutationWaits: 0, domMutationWakeups: 0, domMutationTimeouts: 0, initialEffortSelectionRequired: false, exactPrewarmedMode: true };
  expect(domObservationCanaryAccepted([metric], "cadence")).toBe(true);
  expect(domObservationCanaryAccepted([], "cadence")).toBe(false);
  expect(domObservationCanaryAccepted([metric], "mutation")).toBe(false);
  for (const change of [
    { domFullScans: 0 }, { domCacheHits: -1 }, { domMutationWaits: 1 }, { domMutationWakeups: 1 },
    { exactPrewarmedMode: undefined }, { initialEffortSelectionRequired: true }, { domFullScans: Number.NaN },
  ]) expect(domObservationCanaryAccepted([{ ...metric, ...change }], "cadence")).toBe(false);
  expect(domObservationCanaryAccepted([{ ...metric, domObservation: "mutation", domMutationWaits: 3, domMutationWakeups: 2, domMutationTimeouts: 1 }], "mutation")).toBe(true);
});

test("each stream needs exactly one matching successful request rewrite", () => {
  expect(requestRewriteCanaryAccepted([success("a")], ["a"])).toBe(true);
  expect(requestRewriteCanaryAccepted([success("b"), success("a")], ["a", "b"])).toBe(true);
  expect(requestRewriteCanaryAccepted([], [])).toBe(false);
  expect(requestRewriteCanaryAccepted([], ["a"])).toBe(false);
  expect(requestRewriteCanaryAccepted([success("a")], ["a", "b"])).toBe(false);
});

test("missing failed or fallback rewrite evidence cannot pass on a correct answer", () => {
  for (const change of [
    { observed: false }, { rewritten: false }, { exactValueMatches: 0 }, { exactValueMatches: 2 },
    { literalMatches: 0 }, { literalMatches: 2 }, { exactValueMatches: undefined },
    { failureCode: "match-count" }, { failureCode: "transport" },
  ]) expect(requestRewriteCanaryAccepted([{ ...success("a"), ...change }], ["a"])).toBe(false);
});

test("duplicate unrelated and empty trace evidence fails even with correct cardinality", () => {
  expect(requestRewriteCanaryAccepted([success("a"), success("a")], ["a", "b"])).toBe(false);
  expect(requestRewriteCanaryAccepted([success("a"), success("b")], ["a", "a"])).toBe(false);
  expect(requestRewriteCanaryAccepted([success("other")], ["a"])).toBe(false);
  expect(requestRewriteCanaryAccepted([success("")], [""])).toBe(false);
});

test("live canary applies the same transport evidence gate to page and CDP writers", () => {
  const source = readFileSync(new URL("../scripts/smoke-chatgpt-web-stream.ts", import.meta.url), "utf8");
  expect(source).toContain("!requestPrimary || requestRewriteCanaryAccepted(requestInjectionPrimaries, metrics.map(metric => metric.traceId))");
  expect(source).toContain("!requestCdpPrimary || requestRewriteCanaryAccepted(requestInjectionCdpPrimaries, metrics.map(metric => metric.traceId))");
  expect(source).toContain("!requireHandoff || handoffCanaryAccepted(metrics, metrics.map(metric => metric.traceId))");
  expect(source).toContain("handoffAcceptance: requireHandoff");
});

test("P8 handoff canary requires exact-topic WS continuation and terminal wire parity per trace", () => {
  const success = (traceId: string) => ({
    traceId,
    handoffObserved: true,
    handoffObservedMs: 100,
    firstHandoffChunkMs: 125,
    wireCompletionMs: 150,
    comparison: "exact" as const,
    markdownEquivalence: "exact" as const,
  });
  expect(handoffCanaryAccepted([success("a"), success("b")], ["a", "b"])).toBe(true);
  expect(handoffCanaryAccepted([], ["a"])).toBe(false);
  expect(handoffCanaryAccepted([success("other")], ["a"])).toBe(false);
  expect(handoffCanaryAccepted([success("a"), success("a")], ["a", "b"])).toBe(false);
  for (const change of [
    { handoffObserved: false },
    { handoffObservedMs: undefined },
    { firstHandoffChunkMs: undefined },
    { firstHandoffChunkMs: 99 },
    { wireCompletionMs: undefined },
    { wireCompletionMs: 124 },
    { comparison: "incomplete" as const },
    { comparison: "different" as const },
    { markdownEquivalence: "different" as const },
  ]) expect(handoffCanaryAccepted([{ ...success("a"), ...change }], ["a"])).toBe(false);
});
