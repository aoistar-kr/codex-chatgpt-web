# Custom invariants

This fork must fail closed during upstream integration if any of these contracts regress.

- **Request injection and no replay:** request injection must preserve exact prompt/body proof, all five selectable Sol/Pro efforts must retain their exact direct wire-model mapping, and once submission is committed an observation failure must never authorize prompt replay. (`tests/request-prompt-shape.test.ts`, `tests/submission-disposition.test.ts`, `tests/browser-worker-contract.test.ts`, `tests/model-contract.test.ts`)
- **Network Primary and tool-boundary ACK:** every selectable Sol/Pro effort (Instant, Medium, High, Extra High, and Pro) must retain network-primary eligibility, tool-batch wake/observation, completion fencing, and the `tool-boundary-ack` helper capability. (`tests/turn-plan.test.ts`, `tests/browser-worker-contract.test.ts`, `tests/chatgpt-web-harness.test.ts`)
- **Citation/content-reference propagation:** ChatGPT rich citation metadata must remain separate from assistant text and preserve stable structured annotation semantics. (`tests/web-stream-rich-fixture.test.ts`)
- **Same-turn recovery only:** incomplete-capture recovery may resume only a proven identical committed turn and must fail closed on missing/conflicting evidence. (`tests/recovery-equivalent-proof.test.ts`, `tests/recovery-request-observer.test.ts`)
- **Compaction continuity:** completed compaction continuation must re-authenticate the current Codex environment and reject mismatched rollout claims. (`tests/compaction-continuation-backport.test.ts`)
- **Native Codex passthrough:** native encrypted reasoning stays byte-for-byte intact, native compact/web-search routing remains native, and authentication failures remain fail closed. (`tests/native-passthrough.test.ts`)
- **Prompt/tool contract:** Full/browser-only modes, delegated tool capability, compaction isolation, history attribution, and rich-result Markdown fallback remain stable. (`tests/prompt-contract.test.ts`)
- **Trusted environment continuity:** cwd/sandbox/permission provenance remains bound to the trusted current Codex environment. (`tests/environment.test.ts`)
- **Launcher helper protocol:** persistent helper framing, multipart/compaction flags, ordering, and structured error contracts remain intact. (`tests/launcher-helper-client.test.ts`)
- **Visible active-turn progress:** public ChatGPT commentary/status rows, including short-lived anchored work rows, must remain append-only Codex Working/reasoning output; real Codex Native calls remain native tool calls rather than synthesized UI events. (`tests/browser-worker-contract.test.ts`)
- **Same-chat steering:** only a newer instruction revision from the same native thread+turn may supersede an active browser response; when the launcher proves the stop and retained surface, the successor sends only the steering delta into that same Temporary Chat, never the original prompt again. (`tests/chatgpt-web-harness.test.ts`, `tests/launcher-helper-client.test.ts`)
- **Interrupt-to-browser stop:** the narrowly managed Codex interrupt hook must preserve unrelated config and refuse unsafe removal, while an active cancellation must also issue an exact launcher-surface stop command before helper teardown. (`tests/codex-interrupt-hook.test.ts`, `tests/launcher-browser-host.test.ts`, `tests/browser-worker-contract.test.ts`)

`bun run test:custom-invariants` is a mandatory CI gate in `.github/workflows/upstream-sync.yml`. Removing the script or any listed test therefore fails upstream integration before packaging or deployment.
