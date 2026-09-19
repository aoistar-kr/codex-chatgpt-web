# Next-Session Work Specification — Codex ↔ ChatGPT Web Active-Turn Control

## 0. Purpose

This document is the handoff specification for continuing the active-turn control implementation in the next ChatGPT/Codex session without re-discovering the problem from scratch.

Primary design document:

- `docs/active-turn-control-e2e-plan.md`

Repository:

- `C:\Users\qkrgu\Documents\GitHub\codex-chatgpt-web`
- branch: `custom`
- current HEAD at handoff time: `b3ca55c fix(ci): clear handled merge-base status`

Current working tree at handoff time:

```text
## custom...origin/custom
?? docs/active-turn-control-e2e-plan.md
?? docs/active-turn-control-next-session-handoff.md
```

No implementation code for this feature has been changed yet. The E2E plan is complete; implementation has not started.

---

## 1. User Goal

Implement four behaviors in the real production path:

```text
Codex Desktop
  -> OpenCodex :10100
  -> webgpt provider
  -> WebGPT :17841
  -> ChatGPT Temporary Chat
```

Required behaviors:

1. ChatGPT-visible progress/status/activity must appear in Codex while the turn is still running.
2. ChatGPT-internal visible activity must be surfaced as non-executable Codex commentary, not fake tool calls.
3. A message typed into Codex while a turn is running must immediately steer the same logical ChatGPT task, without waiting for another provider request and without replaying the original prompt.
4. The Codex square Stop button must stop the exact active ChatGPT generation, including when the provider HTTP observer has detached.

The implementation must preserve provider-only ownership:

- OpenCodex owns Codex routing/model catalog.
- WebGPT owns browser execution and retained Temporary Chat lifecycle.
- Do not restore the legacy WebGPT direct route merely to get hooks back.

---

## 2. Final Architecture Decision

### 2.1 Control source

Use the authenticated Codex rollout JSONL as the active-turn control source.

Observed production semantics already prove:

- same-turn user steering messages are written to the rollout immediately;
- Codex Stop writes a semantic `event_msg: turn_aborted` for the exact native turn.

Therefore introduce one session-owned trusted rollout control tail that watches the exact authenticated rollout for the exact native `thread_id + turn_id`.

Classify events as:

```text
same-turn new user revision  -> STEER
turn_aborted                 -> INTERRUPT
other thread/turn            -> ignore / fail closed
```

Do not wait for a second `/v1/responses` request to detect steering.

### 2.2 Logical turn vs browser epoch

Current code mostly treats one Codex turn as one ChatGPT browser generation.

Change the abstraction to:

```text
Codex logical turn
  ├─ authenticated rollout control watcher
  ├─ progress/activity journal
  ├─ steering queue
  ├─ absorbed-steering ledger
  ├─ Browser Epoch 1
  ├─ Browser Epoch 2
  └─ Browser Epoch N
```

A steering revision can terminate the current browser epoch and start a successor browser epoch while staying inside the same logical Codex turn and, when proven safe, the same retained Temporary Chat.

### 2.3 Progress/activity transport

Public ChatGPT-visible progress belongs in Codex `commentary`, not reasoning-summary metadata.

Rules:

- visible status/activity -> assistant message with `phase: "commentary"`;
- stable visible prose between activity rows -> commentary;
- real Codex Native tool requests remain real `function_call`s;
- ChatGPT-internal browser activity must never be synthesized into executable `function_call`s;
- never expose hidden chain-of-thought.

### 2.4 Stop

Primary Stop path:

```text
Codex square Stop
  -> rollout `turn_aborted`
  -> session-owned watcher
  -> exact native thread/turn match
  -> hard-stop current browser epoch
  -> cancel/revoke turn capability and browser generation
  -> no successor epoch allowed
```

Existing `/admin/interrupt-turn` remains as a compatibility/management path; it is not the primary Desktop control source.

---

## 3. Important Existing Code to Reuse

### 3.1 Rollout authority

Primary file:

- `src/adapters/chatgpt-web/codex-rollout-environment.ts`

Existing security/authority properties to preserve and preferably factor rather than duplicate:

- `state_5.sqlite` thread ownership lookup;
- exact `rollout_path` authentication;
- sessions-root containment;
- symlink rejection;
- canonical rollout filename validation;
- `session_meta` validation;
- exact native thread/turn UUID validation;
- bounded JSONL record size;
- rollout permission/environment validation.

New active-tail code should share the same authenticated path/identity machinery.

Proposed new module from the plan:

- `src/adapters/chatgpt-web/codex-rollout-control.ts`

### 3.2 Session lifecycle / retained conversation

Primary files:

- `src/adapters/chatgpt-web/turn-session.ts` or the file containing `ChatGptTurnSession` / `ChatGptTurnSessions` in the current tree;
- `src/adapters/chatgpt-web/index.ts`;
- `src/adapters/chatgpt-web/turn-execution.ts` if still present after current refactors.

Existing useful behavior:

- `ChatGptTurnSession` tracks exact native turn identity;
- `getOrCreateAfterOwnerRetirement()` already detects successor instruction lineage, but only when another provider request arrives;
- `retainedSteeringResumeRequest()` already builds steering-only continuation input;
- `retainedContinuation: "steering"` already suppresses original prompt replay;
- `conversationKey` / retained conversation ownership already exists;
- `submission.phase` tracks `prepared -> send_activated -> accepted`;
- `cancelNativeTurn(threadId, turnId, reason)` exists;
- browser cancellation and broker capability revocation paths already exist.

Do not throw these away. Move the steering trigger earlier to the rollout watcher and evolve the session into logical-turn/browser-epoch ownership.

### 3.3 Browser callbacks / progress

Primary files:

- `src/browser/chatgpt-browser.ts` or current equivalent defining `BrowserTurn`;
- `src/adapters/chatgpt-web/index.ts`;
- response bridge code under `src/bridge` / `src/responses`.

Existing callbacks include:

- `onReasoningSummary`
- `onCommentary`
- `onTextDelta`
- `externalProgress`
- completion fence hooks

Goal is not to invent a second progress system. Normalize visible browser activity into commentary and preserve real tool events separately.

### 3.4 Server cancellation

Primary file:

- `src/server.ts`

Existing useful endpoints/objects:

- `HttpTurnCounter`
- `beginCancelTurn()` / `cancelTurn()`
- `/admin/interrupt-turn`
- `/admin/cancel-turn`
- `/admin/cancel-turns`

Remember current intentional behavior: HTTP observer cancellation is not automatically equivalent to user Stop because exact reconnect/replay semantics depend on browser work being able to survive an observer detach.

---

## 4. Required State Machine

Implement an explicit per-logical-turn controller. Suggested states:

```text
ACTIVE(epoch=N)
  ├─ visible progress -> emit commentary
  ├─ real tool batch -> TOOL_WAIT
  ├─ steering -> STEER_PENDING
  └─ interrupt -> INTERRUPTED

TOOL_WAIT
  ├─ tool results settled -> if steering pending, STEER_PENDING
  └─ interrupt -> INTERRUPTED

STEER_PENDING
  ├─ hard-stop old epoch
  ├─ await proven stop/cleanup boundary
  ├─ retained-chat reuse proven -> submit steering delta only
  ├─ retained-chat reuse unavailable but old epoch definitely stopped -> fresh-chat canonical fallback
  └─ ambiguous old epoch state -> fail closed, no replay

INTERRUPTED
  ├─ cancel browser epoch
  ├─ revoke broker capability
  ├─ stop rollout watcher
  ├─ reject queued steering
  └─ never start successor epoch
```

Priority rule:

```text
INTERRUPT > outstanding tool completion rendezvous > STEERING > ordinary progress
```

---

## 5. Exact-Once Steering Contract

This is a critical invariant.

Codex may later send another canonical provider request containing a user revision that WebGPT already consumed live from rollout tailing.

Therefore keep an absorbed-steering ledger keyed by authenticated identity, for example:

```text
(thread_id, turn_id, canonical user item id / revision hash)
```

Requirements:

- a live rollout steering revision is submitted to ChatGPT exactly once;
- later provider replay of the same canonical revision is recognized as already absorbed;
- original prompt is never replayed into an uncertain retained conversation;
- two fast steering messages preserve rollout order;
- duplicate rollout lines / rereads after tail restart do not duplicate submissions;
- interrupt clears or blocks any not-yet-submitted steering.

Do not use raw text alone as identity when a canonical item id/revision lineage is available.

---

## 6. Rollout Tail Safety Requirements

The active tail must be bounded and fail closed.

Required behaviors:

- start from an authenticated canonical rollout path;
- capture baseline file identity/size/offset at watcher creation;
- parse only complete newline-terminated JSONL records;
- obey the existing max JSON record bound;
- never reread the entire rollout on every poll;
- detect truncation;
- detect replacement/file identity change;
- reject symlink/path authority changes;
- stop at the next task/turn boundary;
- ignore records outside the exact native turn;
- never let rollout data broaden filesystem or tool authority;
- watcher lifetime belongs to logical turn/session, not to one HTTP observer;
- watcher must stop on final completion, interrupt, retirement, or fail-closed authority loss.

Diagnostics must avoid logging prompt contents. Log only IDs/hashes/event classes/timing metadata.

---

## 7. Tool-Call Rendezvous Rule

If a real Codex Native tool batch is outstanding when steering arrives:

1. queue steering;
2. do not create a second browser epoch yet;
3. let the exact outstanding tool batch settle;
4. deliver results to the current logical ChatGPT task;
5. then process queued steering;
6. if Stop arrives at any point, interrupt wins and no steering successor starts.

Reason: abandoning a real external tool request mid-round can leave ChatGPT/Codex tool state inconsistent.

Do not apply this waiting rule to passive ChatGPT-internal status rows, which are not Codex tools.

---

## 8. Retained Conversation Steering Rules

Preferred path after steering:

```text
old epoch stopped with proof
  + same retained conversation lease proven
  -> submit steering-only delta
```

Use existing retained steering compilation machinery where possible.

Fallback:

```text
retained reuse unavailable
  + old epoch definitely stopped
  -> new Temporary Chat with canonical full context + authenticated steering revision
```

Forbidden:

```text
old epoch stop state ambiguous
  -> DO NOT replay original task
  -> fail closed
```

The no-prompt-replay invariant is more important than forcing recovery.

---

## 9. Progress / Activity Semantics

Desired Codex UI behavior:

- user should see useful mid-turn work/status;
- the events should appear in the Working/commentary surface;
- final answer remains final answer;
- real tool calls keep normal Codex tool rendering;
- no hidden reasoning is surfaced.

Use the current bridge support for assistant `phase: "commentary"`.

Check the current model catalog and do not depend on `supports_reasoning_summaries=true` as a workaround.

---

## 10. Implementation Order

Follow this order unless new source evidence proves a dependency change:

1. Read `docs/active-turn-control-e2e-plan.md` completely.
2. Re-check current branch/status only; preserve unrelated dirty work.
3. Factor/reuse canonical rollout path authority from `codex-rollout-environment.ts`.
4. Add bounded `codex-rollout-control.ts` tail and exact event classification.
5. Add deterministic unit seams for incremental rollout records; no live Codex requests.
6. Move visible progress/activity output to commentary semantics.
7. Refactor `ChatGptTurnSession` into logical-turn ownership with replaceable browser epochs.
8. Wire same-turn rollout steering to current active logical turn.
9. Add tool-outstanding rendezvous.
10. Add retained-chat steering-only successor path.
11. Add proven-stop fresh-chat fallback and ambiguous-stop fail-closed behavior.
12. Wire exact rollout `turn_aborted` to hard interrupt.
13. Add absorbed-steering ledger/dedupe against later canonical provider rounds.
14. Preserve `/admin/interrupt-turn` compatibility behavior.
15. Update custom invariant tests/docs.
16. Touch OpenCodex only if static evidence shows its passthrough mutates/drops commentary/control behavior; otherwise leave it unchanged.
17. Do not deploy/restart locally unless the user explicitly asks.
18. Do not run live/E2E/model requests unless the user explicitly re-authorizes testing.

---

## 11. Verification Plan

### Allowed by default in the next session

Static/offline verification only:

- TypeScript compile/type checking if it does not trigger product traffic;
- targeted pure/unit tests with mocked/local fixtures only if the user has explicitly allowed tests again; otherwise do not run tests;
- source inspection;
- `git diff --check`;
- formatting/static lint if known not to trigger external traffic;
- fixture-based rollout parser checks without launching Codex/ChatGPT/OpenCodex/WebGPT production services.

### Explicitly prohibited until user re-authorizes

Do not run:

- live ChatGPT requests;
- Codex Desktop canaries;
- performance tests;
- UI A/B tests;
- health polling that can trigger system/model activity;
- live browser smoke tests;
- live E2E tests;
- product restart/install/deploy;
- manual CI workflow dispatch.

Reason: user explicitly said to stop testing after rate limiting.

### Final controlled E2E, only after authorization

When authorized, one controlled Desktop task must prove:

1. visible progress appears before final;
2. real tool executes exactly once;
3. passive activity is commentary, not executable tool call;
4. steering entered mid-turn is observed before another provider request;
5. steering delta is submitted exactly once;
6. retained Temporary Chat is reused when proof is available;
7. square Stop stops the exact active ChatGPT generation;
8. Stop still works after provider HTTP observer detach;
9. later canonical Codex replay does not duplicate absorbed steering;
10. a different thread/turn cannot control this session.

---

## 12. Do-Not-Do List

Do not:

- restore full legacy WebGPT Codex route ownership;
- treat any HTTP disconnect as user Stop;
- depend on a second provider request for steering;
- create a second external Codex app-server owner for the Desktop thread;
- use `UserPromptSubmit` hook as the primary mid-turn steering source;
- synthesize executable `function_call`s from visible ChatGPT browser status text;
- expose hidden chain-of-thought;
- replay the original prompt into an ambiguous live retained chat;
- swallow a `turn_aborted` event and then start a successor steering epoch;
- allow rollout file replacement/truncation to silently continue under old authority;
- log raw prompt/steering contents in diagnostics;
- alter OpenCodex routing/catalog ownership without concrete evidence it is necessary.

---

## 13. Likely Files to Modify

WebGPT, expected:

```text
src/adapters/chatgpt-web/codex-rollout-environment.ts
src/adapters/chatgpt-web/codex-rollout-control.ts       # new
src/adapters/chatgpt-web/index.ts
src/adapters/chatgpt-web/turn-session.ts                # or current session module
src/adapters/chatgpt-web/turn-execution.ts              # if still authoritative
src/browser/...                                         # visible status/activity parser if needed
src/bridge/... or src/responses/...                     # commentary emission if needed
src/server.ts                                            # only if cancellation integration needs a seam
```

Tests/fixtures, expected:

```text
tests/adapters/chatgpt-web/... rollout control parser tests
tests/adapters/chatgpt-web/... steering exact-once tests
tests/adapters/chatgpt-web/... interrupt priority tests
tests/adapters/chatgpt-web/... tool-rendezvous tests
tests/adapters/bridge.test.ts or equivalent commentary contract tests
```

Docs/invariants:

```text
docs/active-turn-control-e2e-plan.md
docs/architecture.md
docs/security-model.md
docs/release-validation.md
CUSTOM_INVARIANTS.md
package.json test:custom-invariants list, only if new focused tests are added
```

OpenCodex is not expected to need production changes unless static auditing proves commentary or cancellation is mutated/dropped in the WebGPT passthrough route.

---

## 14. Definition of Done

Implementation is not done merely because the source compiles.

Done requires all of the following:

- rollout control source is authenticated and bounded;
- steering is detected during the current provider turn, not on a later request;
- steering is exactly-once;
- same retained Temporary Chat is reused when proven safe;
- prompt replay cannot occur on an ambiguous live chat;
- Stop has higher priority than steering;
- exact `turn_aborted` stops exact native thread/turn browser work;
- watcher survives HTTP observer detach but not logical-turn retirement;
- outstanding real tool calls are handled coherently;
- public status/activity arrives as Codex commentary;
- fake executable tool calls are never generated from passive browser activity;
- provider-only ownership remains unchanged;
- diagnostics contain no raw prompt text;
- regression/invariant coverage is added;
- final E2E is performed only when the user explicitly allows live testing.

---

## 15. First Actions in the Next Session

Use this sequence immediately:

```text
1. cd C:\Users\qkrgu\Documents\GitHub\codex-chatgpt-web
2. git status --short --branch
3. read docs/active-turn-control-e2e-plan.md
4. read docs/active-turn-control-next-session-handoff.md
5. inspect current definitions of:
   - resolveCurrentCodexRolloutEnvironment
   - ChatGptTurnSession / ChatGptTurnSessions
   - getOrCreateAfterOwnerRetirement
   - retainedSteeringResumeRequest
   - startRuntime / BrowserTurn
   - cancelNativeTurn
   - bridge commentary phase handling
6. implement Task 1: shared rollout authority + bounded control tail
7. continue through the implementation order above
```

Do not restart the design from scratch unless the current source has materially changed since this handoff.

---

## 16. Copy/Paste Prompt for the Next Session

Paste the following as the first instruction in the next session:

```text
Continue the Codex ↔ ChatGPT Web active-turn control implementation from the existing repo state.

Repo:
C:\Users\qkrgu\Documents\GitHub\codex-chatgpt-web
Branch: custom

Read these two files first and treat them as the authoritative implementation specification:
- docs/active-turn-control-e2e-plan.md
- docs/active-turn-control-next-session-handoff.md

Goal:
Implement visible ChatGPT progress/activity in Codex, true same-turn mid-generation steering, and exact square-Stop behavior while preserving OpenCodex provider-only routing/catalog ownership.

Key architecture already decided:
- Use the authenticated Codex rollout JSONL as the real-time control source.
- Same-turn new user revisions => steering.
- exact turn_aborted => hard interrupt.
- One Codex logical turn may own multiple ChatGPT browser epochs.
- Public visible activity => phase: commentary, never fake function_call.
- Real Codex tool calls remain real tool calls.
- Steering must be exact-once and must not replay the original prompt into an ambiguous retained chat.
- Interrupt has priority over steering.
- If a real Codex tool batch is outstanding, settle it before queued steering unless interrupted.
- Reuse existing retainedSteeringResumeRequest / retainedContinuation steering machinery where safe.
- Keep existing /admin/interrupt-turn as compatibility path.

Important constraints:
- Preserve unrelated working-tree changes.
- Do not redesign from scratch unless source drift forces it.
- Do not perform live ChatGPT/Codex/E2E/performance tests unless I explicitly authorize testing again.
- Do not locally deploy/install/restart product processes unless I explicitly ask.
- Static/offline source work is allowed.
- Do not reclaim WebGPT legacy direct Codex route ownership from OpenCodex.

Start by checking git status and current source locations, then implement in the dependency order in the handoff document. Keep a concise running implementation log and report any source drift that invalidates a planned hook before changing architecture.
```

---

## 17. Handoff Status

At the time this file was created:

- architecture audit: complete;
- upstream Codex protocol/source review: complete;
- self-evaluated E2E implementation plan: 100/100 plan completeness;
- implementation: not started;
- live tests: not run for this plan;
- deployment: not performed;
- commit/push of these two planning documents: not performed.
