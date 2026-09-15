import { expect, spyOn, test } from "bun:test";
import { ChatGptRecoveryMessageSampler, ChatGptRecoveryTurnIdContinuityTracker, type ChatGptRecoveryDomSnapshot } from "../src/adapters/chatgpt-web/recovery-dom-proof";
import { ChatGptTurnRecoveryIdentityTracker } from "../src/adapters/chatgpt-web/recovery-identity";

const messageId = "12345678-1234-4234-8234-123456789abc";
function snapshot(): ChatGptRecoveryDomSnapshot {
  return { documentId: "doc", userIdentities: ["conversation-turn-user"], responseIdentities: ["conversation-turn-assistant"],
    assistantTurnIdentity: "conversation-turn-assistant", identityAmbiguous: false, messageId,
    count: 1, uuidLike: true, messageUuidLike: true, messageRoleRelation: "same-node", documentMatches: 1,
    activity: { generating: true, completionActionVisible: false, terminalVisible: false } };
}
function setup(overrides: Partial<ConstructorParameters<typeof ChatGptRecoveryMessageSampler>[0]> = {}) {
  const tracker = new ChatGptTurnRecoveryIdentityTracker("surface");
  tracker.observeDocument("doc");
  tracker.observeAssistantTurn("conversation-turn-assistant");
  tracker.commitSubmission();
  let reads = 0;
  const samples: ChatGptRecoveryDomSnapshot[] = [];
  const sampler = new ChatGptRecoveryMessageSampler({
    isCapturing: () => tracker.lifecycle() === "committed", wireTerminal: () => false,
    read: async () => { reads += 1; return snapshot(); },
    record: observation => {
      samples.push(observation);
      tracker.observeCommittedMessage({ ...observation, assistantTurnIdentity: observation.assistantTurnIdentity ?? "" });
    }, ...overrides,
  });
  return { tracker, sampler, samples, reads: () => reads };
}

test("active atomic observation records postcommit provenance without freezing", async () => {
  const run = setup();
  await run.sampler.sample();
  expect(run.tracker.messageDiagnostic()).toEqual({ hasCommittedMessage: true, committedMessageConflict: false });
  expect(run.tracker.lifecycle()).toBe("committed");
  expect(run.sampler.diagnostic()).toMatchObject({ earlySampleAttempts: 1, earlyActiveObservations: 1, earlySampleFailures: 0,
    earlyWireTerminalReads: 0, earlyInactiveReads: 0, earlyCompletionReads: 0, earlyTerminalReads: 0,
    earlyMaxVisibleAlerts: 0, earlyMaxEmptyAlerts: 0, earlyMaxIgnoredEmptyAlerts: 0, earlyMaxVisibleDialogs: 0, earlyTerminalTextReads: 0,
    earlyEmptyAlertBlockers: { structure: 0, named: 0, style: 0, complex: 0 },
    earlyMessageShapes: { missing: 0, multiple: 0, invalidUuidOrRole: 0, nonuniqueDocument: 0, ambiguousTurns: 0, missingAssistant: 0, unique: 1 },
    earlyMessageUuidLikeReads: 1,
    earlyMessageRoleShapes: { sameNode: 1, ancestor: 0, descendant: 0, subtreeOther: 0, missing: 0, ambiguous: 0, noMessage: 0 },
    earlySkipReasons: { closed: 0, aborted: 0, deadline: 0, capture: 0, wireTerminal: 0, pending: 0, limit: 0, cadence: 0 } });
});

test("abort expiry completed capture and wire terminal prevent any read", async () => {
  for (const options of [
    { signal: AbortSignal.abort() }, { turnDeadline: Date.now() - 1 }, { isCapturing: () => false }, { wireTerminal: () => true },
  ]) {
    const run = setup(options);
    await run.sampler.sample();
    expect(run.reads()).toBe(0);
    expect(run.samples).toHaveLength(0);
  }
});

test("active message shape diagnostics distinguish missing hydration from valid identity without raw IDs", async () => {
  for (const [category, change] of [
    ["missing", { count: 0, messageId: undefined }], ["multiple", { count: 2 }],
    ["invalidUuidOrRole", { uuidLike: false }], ["nonuniqueDocument", { documentMatches: 2 }],
    ["ambiguousTurns", { identityAmbiguous: true }], ["missingAssistant", { assistantTurnIdentity: undefined }],
    ["unique", {}],
  ] as const) {
    const run = setup({ read: async () => ({ ...snapshot(), ...change }) });
    await run.sampler.sample();
    const metrics = run.sampler.diagnostic();
    expect(metrics.earlyMessageShapes[category]).toBe(1);
    expect(Object.values(metrics.earlyMessageShapes).reduce((sum, count) => sum + count, 0)).toBe(1);
    expect(JSON.stringify(metrics)).not.toContain(messageId);
    metrics.earlyMessageShapes[category] = 99;
    expect(run.sampler.diagnostic().earlyMessageShapes[category]).toBe(1);
  }
});

test("pre-text cadence preserves the attempt budget until the later DOM message can hydrate", async () => {
  let finalText = false;
  let reads = 0;
  const run = setup({
    finalTextStarted: () => finalText,
    read: async () => { reads++; return finalText ? snapshot() : { ...snapshot(), messageId: undefined, count: 0 }; },
    record: observation => { if (observation.count === 1) run.sampler.close(); },
  });
  const sampling = run.sampler.run();
  await new Promise(resolve => setTimeout(resolve, 350));
  expect(reads).toBe(1); // Fast 250ms cadence would already have spent a second attempt.
  finalText = true;
  await sampling;
  expect(reads).toBe(2);
  expect(run.sampler.diagnostic().earlyMessageShapes).toMatchObject({ missing: 1, unique: 1 });
  expect(run.sampler.diagnostic().earlySamplingSpanMs).toBeGreaterThanOrEqual(900);
});

test("missing generating proof completion and terminal DOM cannot supply first message evidence", async () => {
  for (const activity of [undefined, { generating: false, completionActionVisible: false, terminalVisible: false },
    { generating: true, completionActionVisible: true, terminalVisible: false },
    { generating: true, completionActionVisible: false, terminalVisible: true }]) {
    const run = setup({ read: async () => ({ ...snapshot(), activity }) });
    await run.sampler.sample();
    expect(run.samples).toHaveLength(0);
    expect(run.tracker.messageDiagnostic().hasCommittedMessage).toBeFalse();
  }
});

test("cadence and attempt limit bound optional reads across a long-running capture", async () => {
  let now = Date.now();
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  try {
    const run = setup();
    await run.sampler.sample();
    await run.sampler.sample();
    expect(run.reads()).toBe(1);
    for (let index = 0; index < 30; index++) { now += 250; await run.sampler.sample(); }
    expect(run.reads()).toBe(12);
  } finally { clock.mockRestore(); }
});

test("absolute sampling window never renews", async () => {
  let now = Date.now();
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  try {
    const run = setup();
    await run.sampler.sample();
    now += 15_001;
    await run.sampler.sample();
    expect(run.reads()).toBe(1);
  } finally { clock.mockRestore(); }
});

test("missing early hydration can become valid only while still actively generating", async () => {
  let now = Date.now();
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  try {
    let next: ChatGptRecoveryDomSnapshot = { ...snapshot(), messageId: undefined, count: 0 };
    const run = setup({ read: async () => next });
    await run.sampler.sample();
    expect(run.tracker.messageDiagnostic().hasCommittedMessage).toBeFalse();
    next = snapshot(); now += 250;
    await run.sampler.sample();
    expect(run.tracker.messageDiagnostic().hasCommittedMessage).toBeTrue();
  } finally { clock.mockRestore(); }
});

test("observed missing duplicate malformed or replaced message remains a sticky conflict", async () => {
  let now = Date.now();
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  try {
    for (const change of [{ messageId: undefined, count: 0 }, { count: 2 }, { documentMatches: 2 },
      { messageId: "invalid" }, { messageId: "87654321-1234-4234-8234-123456789abc" }, { documentId: "replaced" }]) {
      let next = snapshot();
      const run = setup({ read: async () => next });
      await run.sampler.sample();
      next = { ...snapshot(), ...change }; now += 250;
      await run.sampler.sample();
      next = snapshot(); now += 250;
      await run.sampler.sample();
      expect(run.tracker.messageDiagnostic()).toEqual({ hasCommittedMessage: true, committedMessageConflict: true });
    }
  } finally { clock.mockRestore(); }
});

test("transport failure stops sampling without inventing an observed missing message", async () => {
  let now = Date.now();
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  try {
    let calls = 0;
    const run = setup({ read: async () => { if (++calls > 1) throw new Error("private transport context"); return snapshot(); } });
    await run.sampler.sample(); now += 250;
    await run.sampler.sample(); now += 250;
    await run.sampler.sample();
    expect(calls).toBe(2);
    expect(run.tracker.messageDiagnostic().committedMessageConflict).toBeFalse();
    expect(run.sampler.diagnostic().earlySampleFailures).toBe(1);
    expect(JSON.stringify(run.sampler.diagnostic())).not.toContain("private");
  } finally { clock.mockRestore(); }
});

test("in-flight read is serialized and late result cannot write after capture freezes", async () => {
  let resolveRead!: (value: ChatGptRecoveryDomSnapshot) => void;
  let calls = 0;
  const run = setup({ read: () => { calls++; return new Promise(resolve => { resolveRead = resolve; }); } });
  const first = run.sampler.sample();
  await run.sampler.sample();
  expect(calls).toBe(1);
  const frozen = run.tracker.freezeCommittedProof();
  resolveRead(snapshot());
  await first;
  expect(run.samples).toHaveLength(0);
  expect(run.tracker.frozenSnapshot()).toEqual(frozen);
});

test("wire terminal arriving during read prevents first evidence backfill", async () => {
  let terminal = false;
  const run = setup({ wireTerminal: () => terminal, read: async () => { terminal = true; return snapshot(); } });
  await run.sampler.sample();
  expect(run.samples).toHaveLength(0);
  expect(run.sampler.diagnostic().earlyWireTerminalReads).toBe(1);
});

test("outer completion closes sampler even when no atomic read ran and controls later revert", async () => {
  const run = setup();
  run.sampler.close();
  await run.sampler.sample();
  expect(run.reads()).toBe(0);
  expect(run.tracker.messageDiagnostic().hasCommittedMessage).toBeFalse();
});

test("outer terminal closing during a pending read makes the late result inert", async () => {
  let resolveRead!: (value: ChatGptRecoveryDomSnapshot) => void;
  const run = setup({ read: () => new Promise(resolve => { resolveRead = resolve; }) });
  const pending = run.sampler.sample();
  run.sampler.close();
  resolveRead(snapshot());
  await pending;
  expect(run.samples).toHaveLength(0);
});

test("absolute per-read deadline blocks a late promise even before the timeout callback executes", async () => {
  let now = Date.now();
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  try {
    const run = setup({ read: async () => { now += 1_001; return snapshot(); } });
    await run.sampler.sample();
    expect(run.samples).toHaveLength(0);
    expect(run.sampler.diagnostic().earlySampleFailures).toBe(1);
  } finally { clock.mockRestore(); }
});

test("cancelled or expired pending read stays inert even if the transport resolves later", async () => {
  for (const expired of [false, true]) {
    let resolveRead!: (value: ChatGptRecoveryDomSnapshot) => void;
    const controller = new AbortController();
    const run = setup({ signal: controller.signal, turnDeadline: expired ? Date.now() + 25 : undefined,
      read: () => new Promise(resolve => { resolveRead = resolve; }) });
    const pending = run.sampler.sample();
    if (!expired) controller.abort();
    await pending;
    resolveRead(snapshot());
    await Promise.resolve(); await Promise.resolve();
    expect(run.samples).toHaveLength(0);
    expect(run.sampler.diagnostic().earlySampleFailures).toBe(1);
  }
});

test("bounded local reader captures later hydration without waiting for caller screenshot work", async () => {
  let capturing = true;
  let reads = 0;
  let run!: ReturnType<typeof setup>;
  run = setup({ isCapturing: () => capturing,
    read: async () => ++reads === 1 ? { ...snapshot(), messageId: undefined, count: 0 } : snapshot(),
    record: observation => {
      run.tracker.observeCommittedMessage({ ...observation, assistantTurnIdentity: observation.assistantTurnIdentity ?? "" });
      if (observation.messageId) capturing = false;
    },
  });
  await run.sampler.sample();
  expect(run.tracker.messageDiagnostic().hasCommittedMessage).toBeFalse();
  await run.sampler.run();
  expect(reads).toBe(2);
  expect(run.tracker.messageDiagnostic()).toEqual({ hasCommittedMessage: true, committedMessageConflict: false });
});

test("closing the local reader cancels its cadence wait without starting another read", async () => {
  const run = setup();
  await run.sampler.sample();
  const task = run.sampler.run();
  run.sampler.close();
  await task;
  expect(run.reads()).toBe(1);
  expect(run.sampler.diagnostic().earlySampleFailures).toBe(0);
});

test("closing the local reader aborts a pending read and its late result cannot change provenance", async () => {
  let resolveRead!: (value: ChatGptRecoveryDomSnapshot) => void;
  const run = setup({ read: () => new Promise(resolve => { resolveRead = resolve; }) });
  const task = run.sampler.run();
  run.sampler.close();
  await task;
  resolveRead(snapshot());
  await Promise.resolve(); await Promise.resolve();
  expect(run.tracker.messageDiagnostic().hasCommittedMessage).toBeFalse();
  expect(run.sampler.diagnostic().earlySampleFailures).toBe(0);
});

test("skip diagnostics are defensive copies and distinguish closed capture from wire terminal", async () => {
  for (const [options, reason] of [[{ isCapturing: () => false }, "capture"], [{ wireTerminal: () => true }, "wireTerminal"]] as const) {
    const run = setup(options);
    await run.sampler.sample();
    const result = run.sampler.diagnostic();
    expect(result.earlySkipReasons[reason]).toBe(1);
    result.earlySkipReasons[reason] = 99;
    expect(run.sampler.diagnostic().earlySkipReasons[reason]).toBe(1);
    expect(run.reads()).toBe(0);
  }
});


test("turn-id continuity can diagnose an assistant remount without exposing or authorizing the raw identifier", () => {
  const tracker = new ChatGptRecoveryTurnIdContinuityTracker();
  const first = { ...snapshot(), turnId: "opaque-turn-token", turnIdCount: 1, turnIdDocumentMatches: 1 };
  const rebound = { ...first, assistantTurnIdentity: "conversation-turn-assistant-rebound",
    responseIdentities: ["conversation-turn-assistant-rebound"] };
  tracker.observe(first);
  tracker.observe(rebound);
  expect(tracker.diagnostic()).toEqual({
    turnIdObserved: true, turnIdValidObservations: 2, turnIdInvalidObservations: 0,
    turnIdAssistantTransitions: 1, turnIdStableAssistantTransitions: 1, turnIdConflict: false,
    turnIdStableAcrossObservedAssistantTransitions: true,
  });
  expect(tracker.compareFresh(rebound)).toEqual({
    turnIdFreshPresent: true, turnIdFreshEqual: true, turnIdAssistantChangedFromFirst: true,
  });
  expect(JSON.stringify(tracker.diagnostic())).not.toContain("opaque-turn-token");
});

test("turn-id continuity fails closed on duplicate or changed values and never treats absence as proof", () => {
  const tracker = new ChatGptRecoveryTurnIdContinuityTracker();
  const first = { ...snapshot(), turnId: "opaque-turn-token", turnIdCount: 1, turnIdDocumentMatches: 1 };
  tracker.observe({ ...first, turnIdCount: 2 });
  expect(tracker.compareFresh(first).turnIdFreshEqual).toBeFalse();
  tracker.observe(first);
  tracker.observe({ ...first, turnId: "different-token", assistantTurnIdentity: "conversation-turn-assistant-rebound" });
  expect(tracker.diagnostic()).toMatchObject({ turnIdInvalidObservations: 1, turnIdConflict: true,
    turnIdAssistantTransitions: 1, turnIdStableAssistantTransitions: 0,
    turnIdStableAcrossObservedAssistantTransitions: false });
  expect(tracker.compareFresh(first).turnIdFreshEqual).toBeFalse();
});
