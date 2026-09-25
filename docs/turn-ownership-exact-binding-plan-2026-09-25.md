# Exact ChatGPT turn ownership and compaction handoff — 2026-09-25

## Authority and status

Root owns planning/review; delegated workers implement. New workers use
`opencode-go/deepseek-v4.1-flash` with `max`, per the user's explicit instruction.
Existing launcher customizations and unrelated commits are preserved. Current base
is `6136900e010278f59971cc183beb6c8b44955ca9`.

Status: PARTIAL. Independent review rejected the previous ownership draft and its
uncommitted patch. The previous 100/100 readiness claim is withdrawn. No build,
installation, or bug-specific live success is claimed by this document.

## Objectives and constraints

Resolve the response to the submitted request using direct identities, including
reused Temporary Chat, late previous responses, multipart, and steering. Do not
abort merely because several previously unseen assistant turns become visible.
Also fix the verified native-compaction continuation metadata conflict.

Keep Request Injection, Network primary, native model/effort, Temporary Chat,
exact interruption, direct-parent lineage, current rollout authentication, and
same-buffer recovery. Never replay after semantic submission. Do not add history
fetches, broad DOM evidence collection, request-count scoring, or retry sleeps to
prove ownership. Repository downloads and full-install backups are unnecessary.

## Independent review findings and required resolution

| Counterexample in rejected patch | Required behavior |
| --- | --- |
| An old request's headers arrive first after capture begins | Identify the outgoing request before awaiting its response; carry its identity in the same fetch closure. |
| One unrelated assistant appears before the actual response | Singleton DOM cardinality is provisional, never an exact final/recovery proof. |
| SSE completes before the current DOM message hydrates | Zero matches remains pending through the bounded ownership deadline. |
| An unrelated sibling appears after binding | Keep the directly identified owner; siblings alone cannot invalidate it. |
| The bound DOM root is remounted | Rebind using its direct message identity, never the number of new roots. |
| A renderer duplicates one logical turn | Deduplicate logical identity; fail only for conflicting mappings. |
| A nested/user node carries a message ID | Scope message nodes to assistant role and their nearest logical turn. |
| Tool execution waits for ACK but final identity follows tool execution | Observe early request-owned assistant identities separately from final-message identity. Never await final to ACK tools. |
| No owned pre-tool text is available | Wait for the actual boundary; do not fabricate an empty-string observation. |
| Multipart stages precede tap installation | Install and arm direct request provenance for each stage and final commit. |
| Steering swaps capture but outer recovery still uses old capture | Advance active capture and recovery provenance together at accepted steering. |
| Every text chunk wakes a candidate scan | Wake on ownership-relevant changes, with revision-aware DOM invalidation and listener cleanup. |

## Request and response ownership contract

The proof chain is submitted request -> that request's stream -> assistant
message identity -> role-scoped DOM message -> logical turn. Arming the next POST,
choosing the first response, content similarity, or one DOM candidate does not
complete that proof.

The existing injection placeholder provides a unique request marker on the main
path. The fetch tap must bind before response headers can reorder. Its closure
must preserve this binding through delayed headers and streaming/WS handoff.
Plain DOM, multipart, CDP injection and steering need explicit supported binding
contracts; unresolved variants must be documented before their implementation.

Keep early request-owned assistant identities distinct from the existing final
`assistantMessageId`/conversation pair. The final parser's strict conflict and
unknown flags remain final-text/recovery authority. Early envelopes may support
owned pre-tool DOM observation without pretending they are final answers.

A missing direct DOM match is pending. A direct identity mapped to multiple
logical turns is a conflict. Distinct request-owned messages in a tool lifecycle
are not automatically conflicting final answers. Once selected, retain direct
message provenance through reconciliation, and do not reread ownership from
baseline cardinality.

Acceptance evidence and output ownership are different. Existing acceptance
signals still preserve no-replay even while exact output ownership is pending.
No protocol limitation may authorize resending a semantically accepted prompt.

## Latency contract

Collect proof alongside the existing request and stream. Add no sequential server
round trip or fixed ownership polling delay. Include `data-message-id` hydration
in DOM cache invalidation; read role-scoped identities with the existing cached
submission observation where possible. Capture a revision before observation and
wait only if unchanged, cleaning up the losing waiters.

This is a design constraint, not a measured end-to-end speed guarantee. Report
local timing or live timing only when actually measured, and distinguish them.

## Confirmed compaction incident

Canonical rollout evidence shows a completed compaction at 2026-09-25 13:59:42 UTC
followed immediately by the exact native turn metadata conflict. The current turn
started with `goal.internal_context`. Native replacement removed that goal item,
retained current mixed plugin/AGENTS/environment context, and ended with an older
real human `user.text` instruction plus compaction summary.

Existing registration records latest original and latest v1-projected revisions.
These can select goal or mixed context instead of the exact surviving human.
The replacement and rejection are directly observed; the specific pre-compaction
HTTP request and registered hashes were not persisted, so those hashes are not
claimed as directly observed evidence.

Introduce a separate retained-instruction extraction helper only for completed
compaction checkpoint registration. Derive the exact retained human/direct-parent
source from actual input and deterministic v1 projection, excluding context-only
metadata and internal goal wrappers. Register its exact content and source turn
alongside existing representations. Do not register every historical instruction.
Do not change ordinary goal revision extraction or rewrite source turn IDs.

Preserve exact thread/current native turn/model/effort scope, summary and source
hashes, aborted-source rejection, parent lineage and fresh environment authority.
No registry persistence subsystem, rollout scan, network call or delay is needed
for this incident's fix.

## Implementation packets and verification

One production writer at a time. First bounded packet implements compaction
registration in environment.ts/server.ts and focused behavioral tests while the
transport design remains read-only. Ownership implementation follows a concrete
reviewed request-binding interface and the counterexamples above.

Compaction tests cover the incident in v1/v2, current goal before compaction,
multiple goal continuations, later real steering, mixed-context exclusion and
changed source/summary/wrong scope/aborted/no-checkpoint rejection. Reuse existing
invariant tests rather than duplicate them.

Ownership tests must exercise delayed old headers, wrong singleton, SSE-before-
DOM, late sibling, exact remount, renderer duplication, tool-before-final ACK,
multipart and steering capture/recovery transition. Prefer executable behavior
to tests that merely search source strings.

After independent diff review, run repository-required gates:

- tests/environment.test.ts
- tests/compaction-continuation-backport.test.ts
- tests/retained-compaction.test.ts
- tests/server-lifecycle.test.ts
- tests/codex-integration.test.ts
- tests/codex-interrupt-hook.test.ts
- tests/browser-worker-contract.test.ts
- tests/web-stream-tap.test.ts
- tests/launcher-browser-host.test.ts
- relevant additional changed-module tests, TypeScript, and git diff --check

## Commit and installed delivery

Commit/push reviewed changes, preserving launcher commit 02cda54 and current
multipart commit 6136900. Package only from the clean pushed source. Verify
package sourceRevision/sourceState, packaged versus installed ASAR hashes, and
packaged/installed/durable runtime bundle identity. Verify newly running process
identity and health, preserving global configuration and provider routes. Do not
create a whole-install backup. Installed startup and bug-specific live behavior
are separate evidence; neither substitutes for the other.

Completion remains unproven until its actual gates are closed. No self-assigned
score substitutes for test, source, commit, or installed-runtime evidence.
