import { expect, test } from "bun:test";

import {
  resolveChatGptTurnPlan,
  type ChatGptTurnPlanInput,
} from "../src/adapters/chatgpt-web/turn-plan";

const base: ChatGptTurnPlanInput = {
  features: {
    requestInjectionPrimary: false,
    requestInjectionShadow: false,
    requestInjectionCdpShadow: false,
    requestInjectionCdpPrimary: false,
    networkStreamPrimary: false,
    networkStreamShadow: false,
    incompleteCaptureRecovery: false,
  },
  multipart: false,
  imageCount: 0,
  localTools: false,
  reuseConversation: false,
  compaction: false,
  captureLunaCheckpoint: false,
  requestedEffort: "medium",
  stagingEffort: "medium",
  prewarmedMode: false,
  externalProgress: false,
  completionFence: false,
  launcherOwnedSurface: false,
};

function plan(
  overrides: Partial<Omit<ChatGptTurnPlanInput, "features">> & {
    features?: Partial<ChatGptTurnPlanInput["features"]>;
  } = {},
) {
  return resolveChatGptTurnPlan({
    ...base,
    ...overrides,
    features: { ...base.features, ...overrides.features },
  });
}

test("request-injection plan preserves the existing primary/shadow eligibility boundaries", () => {
  const cases: Array<{
    name: string;
    input: Parameters<typeof plan>[0];
    expected: "off" | "shadow" | "primary";
  }> = [
    {
      name: "eligible primary wins over shadow",
      input: { features: { requestInjectionPrimary: true, requestInjectionShadow: true } },
      expected: "primary",
    },
    {
      name: "shadow-only fresh turn",
      input: { features: { requestInjectionShadow: true } },
      expected: "shadow",
    },
    {
      name: "image blocks primary but not compatibility shadow",
      input: {
        imageCount: 1,
        features: { requestInjectionPrimary: true, requestInjectionShadow: true },
      },
      expected: "shadow",
    },
    {
      name: "compaction blocks primary but not compatibility shadow",
      input: {
        compaction: true,
        features: { requestInjectionPrimary: true, requestInjectionShadow: true },
      },
      expected: "shadow",
    },
    {
      name: "multipart blocks both request paths",
      input: {
        multipart: true,
        features: { requestInjectionPrimary: true, requestInjectionShadow: true },
      },
      expected: "off",
    },
    {
      name: "local tools stay on request-injection primary",
      input: {
        localTools: true,
        features: { requestInjectionPrimary: true, requestInjectionShadow: true },
      },
      expected: "primary",
    },
    {
      name: "retained conversation keeps the proven page request writer but not compatibility shadow",
      input: {
        reuseConversation: true,
        features: { requestInjectionPrimary: true, requestInjectionShadow: true },
      },
      expected: "primary",
    },
    {
      name: "retained local-tools conversation can rewrite only its exact generated prompt value",
      input: {
        reuseConversation: true,
        localTools: true,
        features: { requestInjectionPrimary: true, requestInjectionShadow: true },
      },
      expected: "primary",
    },
    {
      name: "ineligible primary does not invent shadow when shadow is disabled",
      input: { imageCount: 1, features: { requestInjectionPrimary: true } },
      expected: "off",
    },
  ];

  for (const entry of cases) {
    expect(plan(entry.input).requestInjection, entry.name).toBe(entry.expected);
  }
});

test("CDP request-injection shadow is default-off and keeps the compatibility-shadow eligibility boundary", () => {
  expect(plan().requestInjectionCdpShadow).toBeFalse();
  expect(plan({ features: { requestInjectionCdpShadow: true } }).requestInjectionCdpShadow).toBeTrue();
  expect(plan({ imageCount: 1, features: { requestInjectionCdpShadow: true } }).requestInjectionCdpShadow).toBeTrue();
  expect(plan({ compaction: true, features: { requestInjectionCdpShadow: true } }).requestInjectionCdpShadow).toBeTrue();
  expect(plan({ multipart: true, features: { requestInjectionCdpShadow: true } }).requestInjectionCdpShadow).toBeFalse();
  expect(plan({ localTools: true, features: { requestInjectionCdpShadow: true } }).requestInjectionCdpShadow).toBeFalse();
  expect(plan({ reuseConversation: true, features: { requestInjectionCdpShadow: true } }).requestInjectionCdpShadow).toBeFalse();
});

test("CDP request-injection primary is a dedicated canary and never competes with the proven page writer", () => {
  expect(plan().requestInjectionCdpPrimary).toBeFalse();
  expect(plan({ features: { requestInjectionCdpPrimary: true } })).toMatchObject({
    requestInjection: "off",
    requestInjectionCdpPrimary: true,
    requestInjectionCdpShadow: false,
  });
  expect(plan({
    features: {
      requestInjectionPrimary: true,
      requestInjectionCdpPrimary: true,
      requestInjectionShadow: true,
      requestInjectionCdpShadow: true,
    },
  })).toMatchObject({
    requestInjection: "primary",
    requestInjectionCdpPrimary: false,
    requestInjectionCdpShadow: true,
  });
  expect(plan({ imageCount: 1, features: { requestInjectionCdpPrimary: true } }).requestInjectionCdpPrimary).toBeFalse();
  expect(plan({ compaction: true, features: { requestInjectionCdpPrimary: true } }).requestInjectionCdpPrimary).toBeFalse();
  expect(plan({ multipart: true, features: { requestInjectionCdpPrimary: true } }).requestInjectionCdpPrimary).toBeFalse();
  expect(plan({ localTools: true, features: { requestInjectionCdpPrimary: true } }).requestInjectionCdpPrimary).toBeFalse();
  expect(plan({ reuseConversation: true, features: { requestInjectionCdpPrimary: true } }).requestInjectionCdpPrimary).toBeFalse();
});

test("network plan keeps primary low/medium/high while passive shadow remains independently available", () => {
  const cases: Array<{
    name: string;
    input: Parameters<typeof plan>[0];
    expected: "off" | "shadow" | "primary";
  }> = [
    {
      name: "low primary",
      input: { requestedEffort: "low", features: { networkStreamPrimary: true } },
      expected: "primary",
    },
    {
      name: "medium primary",
      input: { requestedEffort: "medium", features: { networkStreamPrimary: true } },
      expected: "primary",
    },
    {
      name: "high primary wins over enabled shadow",
      input: {
        requestedEffort: "high",
        features: { networkStreamPrimary: true, networkStreamShadow: true },
      },
      expected: "primary",
    },
    {
      name: "high primary without shadow",
      input: { requestedEffort: "high", features: { networkStreamPrimary: true } },
      expected: "primary",
    },
    {
      name: "extra-high is off without shadow",
      input: { requestedEffort: "xhigh", features: { networkStreamPrimary: true } },
      expected: "off",
    },
    {
      name: "max is off without shadow",
      input: { requestedEffort: "max", features: { networkStreamPrimary: true } },
      expected: "off",
    },
    {
      name: "multipart does not block medium primary",
      input: { multipart: true, features: { networkStreamPrimary: true } },
      expected: "primary",
    },
    {
      name: "images do not block medium primary",
      input: { imageCount: 1, features: { networkStreamPrimary: true } },
      expected: "primary",
    },
    {
      name: "retained conversation does not block medium primary",
      input: { reuseConversation: true, features: { networkStreamPrimary: true } },
      expected: "primary",
    },
    {
      name: "compaction does not block medium primary",
      input: { compaction: true, features: { networkStreamPrimary: true } },
      expected: "primary",
    },
    {
      name: "local tools stay on network primary",
      input: {
        localTools: true,
        features: { networkStreamPrimary: true, networkStreamShadow: true },
      },
      expected: "primary",
    },
    {
      name: "Luna checkpoint blocks primary but preserves passive shadow",
      input: {
        captureLunaCheckpoint: true,
        features: { networkStreamPrimary: true, networkStreamShadow: true },
      },
      expected: "shadow",
    },
    {
      name: "shadow alone is available regardless of primary eligibility",
      input: { requestedEffort: "max", features: { networkStreamShadow: true } },
      expected: "shadow",
    },
  ];

  for (const entry of cases) {
    expect(plan(entry.input).networkStream, entry.name).toBe(entry.expected);
  }
});

test("initial effort selection is skipped only by retained-mode reuse or exact hot prewarm proof", () => {
  const cases: Array<{
    name: string;
    input: Parameters<typeof plan>[0];
    required: boolean;
  }> = [
    { name: "fresh matching mode still selects", input: {}, required: true },
    {
      name: "retained matching mode preserves existing effort",
      input: { reuseConversation: true },
      required: false,
    },
    {
      name: "retained staging mismatch still selects",
      input: { reuseConversation: true, stagingEffort: "low" },
      required: true,
    },
    {
      name: "exact prewarm proof skips fresh selection",
      input: { prewarmedMode: true },
      required: false,
    },
    {
      name: "prewarm proof cannot skip a staging mismatch",
      input: { prewarmedMode: true, stagingEffort: "low" },
      required: true,
    },
  ];

  for (const entry of cases) {
    expect(plan(entry.input).initialEffortSelectionRequired, entry.name).toBe(entry.required);
  }
});

test("DOM observation keeps tool and external completion signals on the legacy cadence", () => {
  expect(plan().domObservation).toBe("mutation");
  expect(plan({ localTools: true }).domObservation).toBe("cadence");
  expect(plan({ externalProgress: true }).domObservation).toBe("cadence");
  expect(plan({ completionFence: true }).domObservation).toBe("cadence");
});

test("cadence A/B canary is opt-in and changes only a simple launcher DOM-authority policy", () => {
  const input = { launcherOwnedSurface: true, features: { domObservationCadenceCanary: true } };
  const expected = plan({ launcherOwnedSurface: true });
  expect(plan(input)).toEqual({ ...expected, domObservation: "cadence" });
  expect(plan({ ...input, features: { domObservationCadenceCanary: false } })).toEqual(expected);
  for (const changed of [
    { launcherOwnedSurface: false }, { multipart: true }, { imageCount: 1 },
    { reuseConversation: true }, { compaction: true }, { captureLunaCheckpoint: true },
  ]) expect(plan({ ...input, ...changed }).domObservation).toBe("mutation");
  expect(plan({ ...input, features: { domObservationCadenceCanary: true, networkStreamPrimary: true } }).domObservation).toBe("mutation");
  for (const changed of [{ localTools: true }, { externalProgress: true }, { completionFence: true }]) {
    expect(plan({ ...input, ...changed }).domObservation).toBe("cadence");
  }
});

test("incomplete-capture recovery is admitted only for one passive launcher-owned simple turn", () => {
  expect(plan().incompleteCaptureRecovery).toBeFalse();
  expect(plan({
    launcherOwnedSurface: true,
    features: { networkStreamShadow: true, incompleteCaptureRecovery: true },
  }).incompleteCaptureRecovery).toBeTrue();

  const blocked: Array<Parameters<typeof plan>[0]> = [
    { features: { networkStreamShadow: true, incompleteCaptureRecovery: true } },
    { launcherOwnedSurface: true, features: { incompleteCaptureRecovery: true } },
    {
      launcherOwnedSurface: true,
      requestedEffort: "medium",
      features: { networkStreamShadow: true, networkStreamPrimary: true, incompleteCaptureRecovery: true },
    },
    {
      launcherOwnedSurface: true,
      requestedEffort: "high",
      features: { networkStreamShadow: true, networkStreamPrimary: true, incompleteCaptureRecovery: true },
    },
    { launcherOwnedSurface: true, multipart: true, features: { networkStreamShadow: true, incompleteCaptureRecovery: true } },
    { launcherOwnedSurface: true, localTools: true, features: { networkStreamShadow: true, incompleteCaptureRecovery: true } },
    { launcherOwnedSurface: true, reuseConversation: true, features: { networkStreamShadow: true, incompleteCaptureRecovery: true } },
    { launcherOwnedSurface: true, compaction: true, features: { networkStreamShadow: true, incompleteCaptureRecovery: true } },
    { launcherOwnedSurface: true, captureLunaCheckpoint: true, features: { networkStreamShadow: true, incompleteCaptureRecovery: true } },
    { launcherOwnedSurface: true, externalProgress: true, features: { networkStreamShadow: true, incompleteCaptureRecovery: true } },
    { launcherOwnedSurface: true, completionFence: true, features: { networkStreamShadow: true, incompleteCaptureRecovery: true } },
  ];
  for (const input of blocked) expect(plan(input).incompleteCaptureRecovery).toBeFalse();

  // High now resolves network-primary too, so the same no-competing-H5 rule applies as low/medium.
  expect(plan({
    launcherOwnedSurface: true,
    requestedEffort: "high",
    features: {
      networkStreamPrimary: true,
      networkStreamShadow: true,
      incompleteCaptureRecovery: true,
    },
  })).toMatchObject({ networkStream: "primary", incompleteCaptureRecovery: false });
});
