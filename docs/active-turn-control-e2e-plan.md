# Codex ↔ ChatGPT Web Active-Turn Control E2E Plan

## 0. Implementation outcome (2026-09-17)

This plan was implemented with one evidence-driven change to the originally proposed
control source. A transparent Codex stdio proxy has been built and validated from the
installed durable WebGPT runtime. The proxy forwards every app-server frame
byte-for-byte, but mirrors only authenticated `turn/steer` and `turn/interrupt`
frames to WebGPT's loopback admin endpoints before forwarding the original frame. It
does not launch a second app-server and does not attach to a Desktop thread from
another process. The running Codex Desktop is now activated through that proxy;
post-restart process and hash proof is recorded in
`docs/active-turn-control-live-receipt-2026-09-17.md`.

The direct app-server frames are the primary low-latency control authority. The
authenticated rollout tail remains a fail-closed recovery/lineage authority, not
the primary steering transport. This corrects the older assumption below that a
rollout watcher had to be the only provider-independent real-time source.

Implemented behavior:

- public ChatGPT progress/activity is emitted as assistant
  `phase="commentary"`; browser activity never becomes a fabricated function call;
- `turn/steer` replaces the active ChatGPT browser epoch inside the same logical
  Codex response, after exact stop/reuse proof, without replaying the original prompt;
- provisional direct-steer identities are reconciled once with the later durable
  Codex item id and content-bound environment identity;
- `turn/interrupt` cancels only the exact `(threadId, turnId)` HTTP/browser/
  compaction owner, including interrupt-before-registration tombstones;
- OpenCodex remains the route/catalog owner and the ChatGPT model/effort selection,
  Temporary Chat behavior, H5 recovery, and no-replay gates remain unchanged.

Source verification completed with 354 required-gate passes plus 2 platform skips,
465 custom-invariant passes, and 894 repository-wide passes plus 2 platform skips,
all with zero failures. TypeScript, `git diff --check`, relocatable-runtime, and
packaged-launcher gates passed. The final Windows installer SHA256 is
`F95D125ED40FA98FC8756C988D60FBA0BABE5700D8A35E4C2692183D93D47A9E`.
The installed durable CLI SHA256 is
`5DDBCE63524A2FE7C910F25A5A7C168691F8AB3FB795B0E55A7BC437EFCBC7B4`
and the stable stdio proxy SHA256 is
`85B31E0C5A866F75236EFDEA111859E52D37076653C97AE6C99A9D61664B7F86`.
The final production-route command-line live run from that installed proxy returned
`LIVE_PASS`, executed one real tool call with one real result, preserved the same
logical turn, emitted 4 commentary items, emitted zero fake tool calls, recorded one
exact abort, and left the daemon healthy with zero active HTTP/browser turns. A
message injected into the running real Desktop task was then observed once in the
same active turn with no new task boundary. The source, package, installed-runtime,
Desktop activation, and active-turn live gates are complete.

One activation incident was initially misattributed to the proxy. The activation receipt later
proved that the proxy had not been loaded: a pre-update Desktop root remained alive while its old
versioned binary directory was removed, then attempted to start the now-missing
`codex-code-mode-host.exe`. Restarting cleanly without the override selected the complete current
version directory. The resolver now also rejects incomplete version directories, but this is
defense in depth rather than the causal fix for that stale-process incident.

### Revised Desktop activation plan — no Codex app-file mutation

The earlier proposal to replace the versioned Desktop `codex.exe` and rename the
original to `codex.real.exe` is withdrawn. The versioned Codex application directory
must remain byte-for-byte untouched. The stopped deferred replacement waiter is not
part of the deployment path and must not be restarted.

The preferred topology is:

```text
Codex Desktop (unmodified)
  -> user-level CODEX_CLI_PATH
  -> stable WebGPT proxy executable
     %USERPROFILE%\.codex-chatgpt-web\bin\codex-webgpt-proxy.exe
  -> validated original Codex CLI discovered below
     %LOCALAPPDATA%\OpenAI\Codex\bin\<version>\codex.exe
  -> normal Codex app-server protocol
```

`CODEX_CLI_PATH` is an internal compatibility point observed in the installed Codex
Desktop build, not a public compatibility guarantee in official OpenAI documentation.
Therefore activation is conditional and fail-closed: a preflight doctor must prove
that the installed app still accepts the override, the stable proxy must validate the
real CLI without following arbitrary paths, and restart verification must prove that
Desktop actually launched the proxy. If any proof fails, restore the prior user
environment value and leave Codex application files untouched.

The stable proxy path is deliberately outside the versioned WebGPT runtime. WebGPT
updates may atomically replace this one managed executable after validation, while
the user environment value remains stable. The proxy discovers only immediate
`<version>\codex.exe` children of the canonical managed Codex binary root, rejects
itself, reparse/symlink escapes, `codex.real.exe`, paths outside that root, candidates
missing the same-directory code-mode/command-runner/sandbox companions, and candidates
that do not pass a bounded `--version` smoke. Candidates are ordered
deterministically by newest validated installation metadata with a stable path
tiebreaker. `CODEX_WEBGPT_REAL_CODEX` remains an explicit test/manual override only;
normal Desktop activation must not depend on it.

The installer must journal the previous user-level `CODEX_CLI_PATH` value before
changing it. It must not overwrite a pre-existing unrelated value silently. Uninstall
or rollback restores the prior value only if the current value still equals the
WebGPT-managed proxy path, so a later user change is never clobbered.

## 1. Goal

The four behaviors below are implemented and command-line-live validated in the
Codex Desktop → OpenCodex → WebGPT → ChatGPT Temporary Chat path without modifying
Codex application-owned files:

1. ChatGPT-visible progress/status text must appear in Codex while the turn is still running.
2. ChatGPT-visible internal activity rows must be surfaced in Codex without fabricating executable Codex tool calls.
3. A user message entered in Codex while the current turn is running must steer the same ChatGPT Temporary Chat immediately, without waiting for a second provider request and without replaying the original prompt.
4. The Codex square Stop button must stop the exact active ChatGPT generation even when the provider HTTP observer has already detached.

The implementation must preserve the current provider-only architecture:

```text
Codex Desktop
  -> OpenCodex :10100
  -> webgpt provider
  -> WebGPT :17841
  -> ChatGPT Temporary Chat
```

OpenCodex remains authoritative for Codex routing/catalog ownership. WebGPT remains authoritative for the browser execution and the retained Temporary Chat.

## 2. Acceptance Criteria

The change is complete only when all of the following are true in one real Codex Desktop task:

- A visible ChatGPT work/status row such as `웹 및 통화 도구 인벤토리 조회` appears in Codex as mid-turn Working/commentary before the final answer.
- Stable visible ChatGPT prose between activity rows is also streamed as Codex commentary.
- No hidden chain-of-thought is extracted or exposed. Only text that is already visible in the ChatGPT browser DOM is eligible.
- A real Codex Native tool request continues to appear as the real Codex tool call and executes exactly once.
- A ChatGPT-internal browser activity row never becomes a synthetic executable `function_call`.
- If the user types `야` while the provider response is still active, WebGPT observes that new same-turn user revision without waiting for another `/v1/responses` request.
- The active ChatGPT generation is stopped, the exact retained Temporary Chat is reused when that reuse is proven, and only the new steering delta is submitted.
- If two steering messages arrive quickly, they are delivered once and in rollout order.
- If a real Codex Native tool call is outstanding, its result is settled before the queued steering instruction is submitted.
- If retained-conversation proof is unavailable after the old generation was definitely stopped, WebGPT may start a fresh Temporary Chat using canonical full context plus the authenticated steering revision.
- If the old generation cannot be proven stopped, WebGPT must not replay the task into an ambiguous live chat.
- Clicking the Codex square Stop button causes the exact ChatGPT generation to stop even if the client/provider HTTP stream has already been cancelled.
- Interrupt wins over any queued steering and no successor browser epoch starts after an interrupt.
- When Codex later sends a canonical provider request that already contains a steering revision consumed live, WebGPT does not submit that steering to ChatGPT a second time.
- A different thread or a different native turn can never steer or stop this browser session.
- OpenCodex routing/catalog ownership remains intact; the fix must not re-install WebGPT's legacy direct routing ownership.

## 3. Current Evidence and Root Causes

### 3.1 Real rollout proves steering and stop are already written during the turn

Observed Codex rollout for native turn `01a0a7f8-9159-7db2-86bb-ec148a64e5c0`:

```text
task_started
user: 야 그냥 계속 도구호출 아무거나 하며 세션 기다려봐
function_call
function_call_output
function_call
function_call_output
user: 야
user: <turn_aborted> ...
turn_aborted
```

The same pattern was reproduced in turn `01a0a7f9-1650-7363-8218-4e0aa3829e44`.

This proves two useful facts:

- Codex persists a new user steering message into the same native turn while the provider call is still running.
- Codex persists a semantic `event_msg: turn_aborted` for the exact native turn when the user presses Stop.

The rollout is therefore a usable local control source without requiring a second provider request.

### 3.2 Current steering implementation is not true mid-turn steering

Current code in `src/adapters/chatgpt-web/turn-execution.ts` detects a newer instruction only inside `ChatGptTurnSessions.getOrCreateAfterOwnerRetirement()`.

That code runs only when another WebGPT request reaches the adapter. During a long provider sampling request, Codex records the new UI message but does not necessarily start a second WebGPT HTTP request immediately. Therefore the current implementation cannot see `야` at the time it is entered.

The existing retained-steering code is still valuable after the new control signal is detected:

- `retainedSteeringResumeRequest()` already builds a steering-only canonical delta.
- `retainedContinuation: "steering"` already suppresses original prompt replay.
- launcher retained-conversation proof and stop acknowledgement already exist.

The missing piece is an in-flight control source and an epoch controller inside the existing provider response.

### 3.3 Current Stop implementation exists below WebGPT but has no provider-only Codex entry point

The browser-side path exists:

```text
WebGPT exact turn cancellation
  -> launcher /v1/turn/stop
  -> exact browser surface
  -> ChatGPT stop button
```

`src/server.ts` also exposes `/admin/interrupt-turn` and can cancel an exact `(threadId, turnId)`.

However the live `~/.codex/config.toml` has no `[[hooks.Interrupt]]` entry.

This is not merely an installation accident. Provider-only setup deliberately calls `retireCodexIntegrationForProviderMode()`, because OpenCodex owns the Codex route and model catalog. The old direct WebGPT integration journal and its lifecycle hook are retired together.

Reclaiming the whole direct integration only to recover Stop would violate the current ownership model.

The primary provider-only Stop path will therefore use the same trusted rollout watcher as steering. The legacy/admin exact interrupt endpoint stays as a compatibility and management path.

### 3.4 Visible progress is sent on the wrong semantic channel

Current browser capture is already useful:

```text
browser-worker.ts
  responseDomSnapshot()
  -> visibleTrace.observe()
  -> onCommentary / onReasoningSummary
```

Current adapter mapping then does:

```text
commentary -> text_delta phase="commentary"
status/reasoning -> thinking_delta
```

`thinking_delta` becomes a Responses reasoning-summary item in `src/bridge.ts`.

The current OpenCodex-generated WebGPT catalog, however, advertises:

```text
supports_reasoning_summaries: false
default_reasoning_summary: "none"
```

That makes the producer and consumer contract inconsistent.

More importantly, ChatGPT's public UI work/status rows are semantically Codex commentary, not private model reasoning. Codex's own protocol defines commentary as mid-turn assistant text where more tool calls or assistant output may follow.

The fix is therefore to emit all public DOM status/activity/prose as `message phase="commentary"`, while reserving Responses reasoning items for genuine reasoning semantics.

### 3.5 Browser-internal activity is not a Codex Native tool call

Rows such as `웹 및 통화 도구 인벤토리 조회` are visible ChatGPT browser activity. They do not carry a trusted Codex tool schema/call id and must not be translated into an executable `function_call`.

The implementation will keep these categories distinct:

```text
ChatGPT visible internal activity -> passive Codex commentary
Codex Native broker tool request   -> real Codex function/custom/tool_search call
```

If a future Codex protocol exposes a non-executable structured activity item, that can replace the commentary rendering later. It is not required for this fix.

## 4. External Codex Findings That Constrain the Design

Reviewed upstream references:

- Codex app-server protocol and `turn/steer` / `turn/interrupt` examples: <https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md>
- Open issue documenting the current external-client-to-active-Desktop-thread attachment gap: <https://github.com/openai/codex/issues/25914>
- Codex core turn loop and `pending_input` sampling-boundary behavior: <https://github.com/openai/codex/blob/main/codex-rs/core/src/session/turn.rs>
- Hook event schema including `UserPromptSubmit` and `Interrupt`: <https://github.com/openai/codex/blob/main/codex-rs/hooks/src/schema.rs>
- Protocol `MessagePhase::Commentary` semantics: <https://github.com/openai/codex/blob/main/codex-rs/protocol/src/models.rs>

### 4.1 `turn/steer` exists but is not a safe external Desktop attachment mechanism

Codex app-server exposes first-class `turn/steer` and `turn/interrupt` APIs. That is useful confirmation that the product model supports these concepts.

However, a separately launched app-server process is not a proven way to attach to the already-running Codex Desktop task. Public Codex issue reports describe the current `thread not found` / live Desktop attachment gap.

Decision: do not add another app-server process merely to steer the Desktop task.

### 4.2 Codex pending input is processed at a sampling boundary

Codex core describes pending input as user input submitted through the UI while the model is running. The pending input is consumed before the next sampling request after the current sampling returns.

Decision: the provider cannot wait for a future provider request if the goal is true mid-generation steering.

### 4.3 `UserPromptSubmit` hook is not the primary steering source

Codex exposes a `UserPromptSubmit` hook carrying session/turn/prompt metadata. Its invocation is tied to pending-input processing, so it does not provide a stronger guarantee than the pending-input boundary for this use case.

Decision: keep hooks out of the primary real-time steering path.

### 4.4 Commentary is the correct public progress phase

Codex protocol explicitly defines `MessagePhase::Commentary` as mid-turn assistant output such as preamble/progress narration, where more output or tool calls may follow.

Decision: public ChatGPT status/activity is emitted as commentary.

## 5. Target Architecture

```text
                         Codex rollout JSONL
                         (trusted local authority)
                                 |
                    +------------+------------+
                    |                         |
             same-turn user              turn_aborted
                    |                         |
                 STEER                     STOP
                    |                         |
                    v                         v
Codex <- SSE <- WebGPT Logical Active Turn Controller -> Browser Epoch N
  ^                    |                         |
  |                    | stop + ACK              |
  |                    v                         v
  |             retained proof?          exact launcher surface
  |                /        \                     |
  |              yes        no                    v
  |               |          |              ChatGPT Stop
  |               v          v
  |        same Temporary   fresh Temporary
  |        Chat, delta only Chat, canonical context
  |
  +-- phase=commentary <--- visible DOM progress/activity
  +-- real function_call <-- Codex Native broker tool calls only
```

The logical Codex turn outlives individual ChatGPT browser generations. Each ChatGPT generation is one **browser epoch** inside the same outer WebGPT response.

## 6. Core State Machine

```text
STARTING
  -> ACTIVE(epoch N)

ACTIVE(epoch N)
  progress/activity -> emit commentary, remain ACTIVE
  native tool batch -> TOOL_PENDING
  steer             -> STEER_PENDING
  turn_aborted      -> INTERRUPTING
  browser final     -> COMPLETED
  hard error        -> FAILED

TOOL_PENDING
  tool results complete -> ACTIVE
  steer                 -> queue steer; stay TOOL_PENDING
  turn_aborted          -> INTERRUPTING

STEER_PENDING
  additional steer -> append/coalesce in exact rollout order
  turn_aborted     -> INTERRUPTING
  safe to steer    -> STOPPING_FOR_STEER

STOPPING_FOR_STEER
  exact stop ACK + retained proof
    -> ACTIVE(epoch N+1, same Temporary Chat, steering delta only)
  exact stop ACK + retained proof unavailable
    -> ACTIVE(epoch N+1, fresh Temporary Chat, canonical context + unconsumed steering)
  stop not proven
    -> SAFE_DEFER_OR_FAIL (never replay into ambiguous live chat)
  turn_aborted
    -> INTERRUPTING

INTERRUPTING
  -> stop exact active epoch
  -> revoke tool/broker capability
  -> close rollout watcher
  -> TERMINAL_ABORTED
```

Interrupt has higher priority than steering at every state.

## 7. Security and Authority Model for the Rollout Control Tail

The new control tail must not trust an arbitrary path or arbitrary JSONL file.

Reuse and factor the existing authority in `codex-rollout-environment.ts`:

- Resolve the exact native thread through `state_5.sqlite` when available.
- Validate `rollout_path` ownership, `agent_path`, parent-thread lineage, and open status.
- Require the path to stay under the canonical Codex sessions root.
- Reject symbolic links.
- Require the canonical rollout filename for the exact thread id.
- Validate the first `session_meta` record.
- Validate the exact current native `turn_id` boundary.
- Bound every complete JSONL record to the existing maximum line size.
- Never treat an incomplete trailing JSON fragment as an event.

Additional tail-time invariants:

- Capture the opened file identity and current byte offset after authority validation.
- Reject file truncation or replacement during an active turn rather than silently following a new file.
- A new `task_started` for another turn closes the old control scope.
- Only a `response_item` user message after the current turn's authenticated initial instruction boundary can become a steering candidate.
- The synthetic `<turn_aborted>` user message is never steering. `event_msg.type === "turn_aborted"` is the stop authority.
- Ignore duplicate records by stable rollout identity/ordinal and message id.
- Do not persist raw prompt text into new logs/state. Keep only bounded in-memory ids/hashes needed for exact-once accounting.

## 8. File-by-File Implementation Plan

### Task 1 — Factor canonical rollout authority and add a bounded control tail

**WebGPT files**

- Modify: `src/adapters/chatgpt-web/codex-rollout-environment.ts`
- Add: `src/adapters/chatgpt-web/codex-rollout-control.ts`
- Add/Test: `tests/codex-rollout-control.test.ts`

**Changes**

- Extract an internal helper that returns an authenticated canonical rollout handle/path plus immutable identity evidence, instead of duplicating path discovery.
- Preserve all existing environment-authority checks.
- Implement a bounded incremental JSONL reader that starts at the current turn boundary and waits for appends without rescanning the whole file.
- Use file-system change notification only as a wake-up hint; correctness comes from offset/size/file-identity checks. Add a bounded timer fallback because Windows notifications can coalesce.
- Parse only complete newline-terminated records.
- Produce a small typed control stream:

```ts
type CodexTurnControlEvent =
  | { type: "steer"; itemId: string; content: unknown; sequence: number }
  | { type: "interrupt"; turnId: string; sequence: number }
  | { type: "turn_complete"; turnId: string; sequence: number };
```

- Build an initial-revision baseline from the canonical provider request so the original user prompt is never re-emitted as steering.
- Close/abort the tailer when its owning logical session settles.

**Required tests later**

- Initial prompt is ignored; a later same-turn human user message emits exactly one `steer`.
- Two appended steer messages preserve order.
- Incomplete trailing JSON waits until newline/completion.
- Duplicate read/wake does not duplicate an event.
- `turn_aborted` emits interrupt and `<turn_aborted>` text never emits steer.
- Wrong thread/turn, replaced file, symlink, truncation, malformed completed record, and oversized record fail closed.
- Watcher survives provider HTTP observer detachment until logical session settlement.

### Task 2 — Move all public browser progress to Codex commentary

**WebGPT files**

- Modify: `src/adapters/chatgpt-web/browser-worker.ts`
- Modify: `src/adapters/chatgpt-web/turn-execution.ts`
- Modify: `src/adapters/chatgpt-web/index.ts`
- Modify: `src/bridge.ts`
- Test: `tests/browser-worker-contract.test.ts`
- Test: `tests/chatgpt-web-harness.test.ts`

**Changes**

- Keep the existing DOM-visible trace extraction and stable-block rules.
- Internally distinguish visible prose/commentary from visible activity/status if useful for dedupe/diagnostics, but map both to the same public Codex `phase="commentary"` channel.
- Change `emitTraceEvents()` so DOM-visible status rows no longer emit `thinking_delta`.
- Ensure the bridge emits commentary as normal Responses assistant message items with `phase:"commentary"` and streaming output-text deltas.
- Do not change real broker tool calls: `tool_call_start/delta/end` continue to map to executable Codex calls.
- Do not fabricate a tool call from visible localized ChatGPT activity text.
- Preserve append-only dedupe so transient DOM remounts cannot repeat commentary.

**OpenCodex verification**

Existing source already preserves the message phase:

- `src/responses/schema.ts`
- `src/responses/parser.ts`
- `tests/adapters/bridge.test.ts`

Add a custom invariant regression only if the cross-provider passthrough fixture does not already cover a WebGPT-style commentary message. Do not add a production rewrite unless evidence shows OpenCodex strips the phase.

### Task 3 — Refactor one-shot browser runtime into logical turn + browser epochs

**WebGPT files**

- Modify: `src/adapters/chatgpt-web/turn-execution.ts`
- Modify: `src/adapters/chatgpt-web/index.ts`

**Problem**

`ChatGptTurnSession` currently treats `runtime.browser` as a single promise that settles once. True steering must stop one ChatGPT generation and start another while the same Codex provider response remains open.

**Changes**

- Introduce a browser-epoch object representing one concrete ChatGPT generation:

```ts
interface ChatGptBrowserEpoch {
  id: number;
  browser: Promise<string>;
  physicalSettlement: Promise<void>;
  conversationKey?: string;
  submission: { phase: "prepared" | "send_activated" | "accepted" };
  cancel(reason?: Error): void;
}
```

- Move persistent logical-turn state out of the one-shot epoch:
  - native `threadId` / `turnId`
  - trace/commentary feed
  - native tool round journal
  - broker environment/capability ownership
  - rollout control watcher
  - pending steering queue
  - absorbed steering ledger
  - current active epoch
- Keep the existing outer adapter/SSE request alive while epochs change.
- Replace the current single `browserOutcome` race with a logical loop that races:
  - current epoch outcome
  - visible trace/text
  - broker tool batch
  - rollout steer event
  - rollout interrupt event
- Physical epoch settlement remains mandatory before a retained/fresh successor can acquire the browser surface.

### Task 4 — Implement true in-flight steering inside the same provider response

**WebGPT files**

- Modify: `src/adapters/chatgpt-web/index.ts`
- Modify: `src/adapters/chatgpt-web/turn-execution.ts`
- Reuse: `retainedSteeringResumeRequest()`
- Reuse: `retainedContinuation: "steering"`
- Reuse launcher stop/reuse acknowledgement in `launcher-helper-client.ts` / `browser-host.cjs`

**Steering algorithm**

1. Rollout watcher emits a new same-turn user revision.
2. Deduplicate it against the initial request and the absorbed-steering ledger.
3. Append it to `pendingSteers` in exact rollout order.
4. If a real Codex Native tool batch is outstanding, do not stop yet. Wait until every expected tool result is committed to the broker/session journal.
5. Mark the current browser epoch as superseded-for-steering.
6. Ask the launcher to stop the exact generation.
7. Wait for exact stop/physical-settlement acknowledgement.
8. If the old submission was accepted and retained-conversation reuse is proven, start the next epoch on the same Temporary Chat and compile only:
   - newly settled tool results not yet reflected in the retained chat, then
   - the pending user steering revision(s).
9. Never include the original prompt in a retained steering continuation.
10. If exact stop is proven but retained reuse cannot be proven, start a fresh Temporary Chat with canonical full context plus the unconsumed steering revisions.
11. If exact stop itself cannot be proven, do not send another prompt into the ambiguous live conversation. Leave the steering pending for a safe canonical boundary or fail the turn with a typed non-retry/retry policy chosen by the existing adapter error model.
12. Mark steering revisions absorbed only after semantic submission evidence for the successor epoch.

### Task 5 — Define the real-tool steering rendezvous

**Why**

A Codex Native tool call may already be executing when the user steers. Stopping ChatGPT before Codex returns that tool result can create an ordering gap or trigger duplicate tool execution.

**Policy**

- ChatGPT browser-only visible activity does not block steering.
- A real outstanding broker tool batch does block steering submission.
- New steering is queued while the tool runs.
- Once all matching results are committed, the successor continuation serializes those results before the newest steering instruction.
- If the user presses hard Stop while a tool is outstanding, interrupt wins and the turn is cancelled; no steering successor starts.

No tool call is replayed merely because a steering event arrived.

### Task 6 — Use rollout `turn_aborted` as provider-only hard-stop authority

**WebGPT files**

- Modify: `src/adapters/chatgpt-web/turn-execution.ts`
- Modify: `src/adapters/chatgpt-web/index.ts`
- Keep compatibility: `src/server.ts` `/admin/interrupt-turn`
- Keep launcher exact stop: `src/adapters/chatgpt-web/launcher-helper-client.ts`, `launcher/electron/browser-host.cjs`

**Changes**

- The logical session-owned rollout watcher remains alive even when `req.signal` / the HTTP observer aborts.
- On exact same-turn `event_msg: turn_aborted`:
  - latch session state as interrupted;
  - reject/clear pending steering;
  - stop the exact active browser epoch through the existing launcher direct-stop path;
  - revoke broker/tool capability;
  - prevent a successor epoch;
  - settle all logical turn waiters;
  - close the rollout watcher.
- Make cancellation idempotent so rollout interrupt, HTTP cancellation, browser error, and admin interrupt may race without double cleanup.

The existing `/admin/interrupt-turn` remains supported for direct/manual/compatibility control, but provider-only correctness no longer depends on a Codex config hook.

### Task 7 — Prevent duplicate steering when Codex later sends canonical pending input

**WebGPT files**

- Modify: `src/adapters/chatgpt-web/turn-execution.ts`
- Modify: `src/adapters/chatgpt-web/index.ts`
- Modify only if necessary: `src/adapters/chatgpt-web/environment.ts`

**Problem**

Codex will eventually drain its own pending input and may send a subsequent provider request containing a user message that WebGPT already consumed live from the rollout.

**Changes**

- Maintain a bounded in-memory absorbed-steering ledger for the logical `(threadId, turnId)`.
- Prefer stable message/item IDs from the rollout; use a content hash only as a secondary integrity check, never as cross-thread identity.
- On a later canonical WebGPT request for the same native turn:
  - classify user revisions as already absorbed vs new;
  - if all new-looking revisions were already submitted live, attach/replay the logical round journal without another ChatGPT submission;
  - if additional unabsorbed revisions exist, submit only those through the continuation policy.
- Retire the ledger with the session TTL/terminal turn. Do not persist user content.

### Task 8 — Preserve reconnect semantics without confusing disconnect with Stop

Current WebGPT intentionally keeps the browser execution alive when the provider HTTP observer disconnects so an exact native retry/reconnect does not burn another ChatGPT submission.

Keep that invariant:

- `req.signal` abort alone is observer detachment, not semantic user Stop.
- rollout `turn_aborted` is the semantic provider-only Stop authority.
- a new exact HTTP observer may reconnect to the same logical session while the rollout watcher remains attached.
- hard interrupt removes the logical session from reconnect eligibility.

### Task 9 — OpenCodex contract and catalog cleanup

**OpenCodex files (expected test/invariant-only change)**

- Review: `src/responses/schema.ts`
- Review: `src/responses/parser.ts`
- Review: passthrough relay under `src/server/responses/*`
- Extend test if needed: `tests/adapters/bridge.test.ts` or a WebGPT provider invariant fixture
- Update custom invariant documentation

**Decision**

Do not set `supports_reasoning_summaries=true` merely to make public status text visible. The implementation will stop using reasoning-summary frames for that text.

If no genuine reasoning summaries are produced by WebGPT, retaining `supports_reasoning_summaries:false` is consistent.

Verify that OpenCodex relays `message.phase="commentary"`, `response.output_item.*`, and `response.output_text.*` byte/semantically intact for the WebGPT route.

### Task 10 — Observability without prompt leakage

Add structured, content-free diagnostics around the new control state machine:

```text
control_watcher_bound          thread_hash turn_hash offset
control_steer_observed         sequence pending_count
control_steer_deferred_tool    sequence outstanding_count
control_stop_requested         reason=steer|interrupt epoch
control_stop_ack               retained=true|false epoch
control_epoch_started          epoch retained=true|false
control_steer_absorbed         sequence epoch
control_interrupt_observed     epoch
control_session_terminal       reason
```

Never log raw steering text, rollout content, tokens, connector secrets, conversation keys, or credentials.

## 9. Regression Matrix to Add

These are implementation gates to write before declaring the feature complete. They are planned tests; this plan does not execute them.

### Rollout control

- authenticated current-turn steering
- wrong-turn isolation
- wrong-thread isolation
- duplicate wake/event dedupe
- truncated line handling
- file replacement/truncation/symlink rejection
- two rapid steering messages
- `turn_aborted` classification
- watcher survives HTTP observer detach

### Progress/activity

- visible status emits commentary message
- stable visible commentary emits commentary message
- transient DOM remount does not duplicate output
- hidden/private reasoning is never emitted
- ChatGPT internal activity does not emit function call
- real broker tool call still emits executable function call

### Steering

- steer arrives before a second provider request
- same retained Temporary Chat receives delta only after proven stop/reuse
- original prompt absent from retained continuation
- fresh fallback only after proven old-epoch stop
- ambiguous stop never causes prompt replay
- rapid steering order/exact-once
- steering while tool outstanding waits for tool result
- tool result serialized before steering
- later canonical provider request does not duplicate absorbed steering

### Interrupt

- exact same-turn `turn_aborted` stops browser generation
- interrupt works after HTTP observer cancellation
- interrupt wins over queued steering
- no successor epoch after interrupt
- repeated interrupt is idempotent

### OpenCodex passthrough

- commentary phase survives WebGPT route
- final answer phase remains final answer
- real function call protocol unchanged
- provider-only route/catalog ownership unchanged

## 10. CI / Custom Invariants

Update `CUSTOM_INVARIANTS.md` so future upstream integrations must preserve:

- Codex-visible progress is emitted through `phase="commentary"`, not through unsupported reasoning-summary metadata.
- browser-internal activity is passive and cannot become executable tool input.
- active-turn rollout authority is exact thread + exact turn and fail-closed.
- steering is detected during the existing provider response, not on a hypothetical second request.
- retained steering never replays the original prompt.
- absorbed steering cannot be submitted twice when Codex later drains pending input.
- semantic Stop is exact same-turn `turn_aborted`; HTTP disconnect remains reconnectable observer detachment.
- interrupt wins over steering.
- provider-only setup does not reclaim OpenCodex route/catalog ownership.

Add the focused tests to the existing `test:custom-invariants` gate once implemented.

## 11. Deployment Sequence

After implementation and when live validation is explicitly allowed:

1. Implement the managed-root real-CLI resolver in the stdio proxy and focused unit tests.
2. Add a stable-proxy installer/update operation using atomic replacement after hash and `--version` validation.
3. Add an idempotent user-environment integration journal: record the prior `CODEX_CLI_PATH`, reject silent takeover, and implement conditional restore.
4. Add a doctor that proves the stable proxy, original CLI resolution, WebGPT control endpoint, and installed Desktop override capability before activation.
5. Run focused tests, the required source gate, custom invariants, typecheck, and `git diff --check`.
6. Build/package WebGPT and validate the relocatable and packaged runtime.
7. Install WebGPT and verify durable/stable proxy hashes. Do not modify any file below the Codex application directory.
8. Record the hashes of all installed versioned Codex `codex.exe` candidates, set the user-level override to the stable proxy, and verify the journal.
9. Fully restart Codex Desktop. A newly launched process must prove that its app-server entrypoint is the stable proxy and that the proxy selected a validated original CLI under the managed root.
10. Recheck the recorded Codex application-file hashes; any mutation is a hard failure.
11. Verify the provider-only route remains `Codex -> OpenCodex -> WebGPT` and no legacy direct WebGPT route was reintroduced.
12. Run one controlled E2E task covering live commentary -> real tool -> immediate same-turn steer -> exact hard stop, with zero synthetic tool calls.
13. Capture only event/timing/identity diagnostics, not prompt content.

Rollback clears or restores the journaled user-level override, restarts Codex Desktop,
and verifies that Desktop again launches the original CLI directly. It must not rename,
delete, or restore files in the Codex application directory because this design never
changes them. Package rollback remains available for WebGPT itself; OpenCodex routing
stays untouched unless its production code independently changed.

## 12. Explicitly Rejected Designs

### Rejected: wait for the next `/v1/responses` request to detect steering

This is the current defect. It is not mid-turn steering.

### Rejected: launch another Codex app-server and call `turn/steer` against the Desktop thread

The protocol supports steering, but external attachment to an already-running Desktop thread is not a proven stable contract. It introduces a second state owner.

### Rejected: use `UserPromptSubmit` hook as the primary real-time steering source

Its lifecycle follows Codex pending-input processing and does not prove delivery while the current provider sampling is still blocked.

### Rejected: interpret provider HTTP disconnect as user Stop

WebGPT intentionally allows exact observer reconnect while a browser execution continues. Treating every disconnect as Stop would break retry/reconnect semantics.

### Rejected: restore the complete legacy direct WebGPT Codex integration merely for `[[hooks.Interrupt]]`

Provider-only mode intentionally gives OpenCodex route/catalog ownership. Reclaiming the whole direct integration creates two owners.

### Rejected: synthesize `function_call` from ChatGPT browser status text

Visible status strings have no authenticated Codex tool schema/call id. Making them executable would be protocol corruption and could cause unintended tool execution.

### Rejected: advertise reasoning-summary support just to display public progress

Public status/activity belongs on Codex commentary. Reasoning metadata should not be overloaded as a UI transport workaround.

### Rejected: replace the versioned Codex `codex.exe`

Renaming the installed original and copying the proxy into its place couples the
integration to every Codex update, modifies application-owned files, and cannot be
safely completed by the task hosted by that process. The user-level override plus a
stable external proxy provides a reversible boundary without application-file
mutation.

### Rejected: rollout-only immediate steering

A live control run against the original CLI showed that a mid-generation steering
message was persisted only at the later sampling boundary, roughly one minute after
submission, and the provider retry then hit the trusted-context `cwd` failure. The
rollout remains useful for lineage and recovery, but cannot satisfy the immediate
steering requirement by itself.

## 13. Implementation Order

The implementation and command-only live validation were completed in this dependency order:

1. Factor canonical rollout authority.
2. Add bounded control tail + exact event classification.
3. Move public progress/activity to commentary.
4. Introduce logical-turn/browser-epoch abstraction.
5. Wire rollout steering into the same active provider response.
6. Add native-tool rendezvous and retained/fresh steering fallback.
7. Wire rollout interrupt into exact hard stop.
8. Add absorbed-steering dedupe for later canonical provider rounds.
9. Add focused WebGPT regression tests and custom invariants.
10. Add/extend OpenCodex passthrough invariant only where evidence requires it.
11. Update architecture/security/release-validation docs.
12. Implement the update-resistant stable-proxy activation, user-environment journal,
    doctor, and rollback described in section 0.
13. Only then package/deploy and perform one controlled E2E validation when testing is authorized.

## 14. Self-Evaluation History

The score below evaluates **plan completeness**, not whether the future implementation has passed live E2E validation.

### Revision 1 — 76/100

Initial concept:

- forward visible DOM progress;
- use existing provider-request steering detection;
- restore Interrupt hook;
- direct launcher stop.

Defects found:

- steering still waited for another provider request;
- provider-only setup intentionally removes the legacy integration/hook;
- progress used a reasoning-summary channel contradicted by the WebGPT catalog;
- no plan for duplicate pending input later sent by Codex;
- no tool-outstanding steering policy.

### Revision 2 — 90/100

Improvements:

- use the authenticated rollout as same-turn steering source;
- use commentary for public progress;
- distinguish passive browser activity from real Codex tools;
- use rollout `turn_aborted` for provider-only Stop.

Remaining gaps:

- control watcher lifetime still coupled too closely to the HTTP observer;
- one-shot `runtime.browser` could not support multiple generations inside one provider response;
- rapid steering and later provider-round dedupe were underspecified.

### Revision 3 — 97/100

Improvements:

- session-owned watcher survives HTTP detach;
- logical turn owns multiple browser epochs;
- exact-once absorbed-steering ledger;
- interrupt priority;
- wait for real outstanding tool results before steering;
- retained vs fresh fallback requires proven old-epoch stop.

Remaining gaps:

- rollout tail needed explicit file replacement/truncation handling;
- diagnostic privacy/rollback/deployment ownership needed to be stated explicitly.

### Revision 4 — 100/100 plan completeness

Added:

- immutable authenticated rollout identity and bounded incremental parsing;
- fail-closed file-change behavior;
- exact current-turn boundary and initial-revision baseline;
- content-free observability;
- provider-only ownership invariant;
- explicit rejected alternatives;
- complete race matrix and deployment/rollback sequence.

Score rubric:

| Area | Points | Result |
| --- | ---: | ---: |
| Fit to current WebGPT/OpenCodex architecture | 25 | 25 |
| Exact turn identity, authority, fail-closed behavior | 20 | 20 |
| Race handling, ordering, exact-once semantics | 20 | 20 |
| Codex UI/protocol semantic correctness | 15 | 15 |
| Provider ownership/backward compatibility | 10 | 10 |
| Verification, diagnostics, deployment and rollback | 10 | 10 |
| **Total** | **100** | **100** |

`100/100` means the plan closes every currently known design gap supported by the local source, real rollout evidence, and reviewed Codex protocol/source behavior. It is not a claim that the implementation is already correct; implementation completion still requires the regression matrix and the explicitly authorized controlled E2E validation.
