# Custom invariants

This fork must fail closed during upstream integration if any of these contracts regress.

- **Request injection and no replay:** request injection must preserve exact prompt/body proof, and once submission is committed an observation failure must never authorize prompt replay. (`tests/request-prompt-shape.test.ts`, `tests/submission-disposition.test.ts`, `tests/browser-worker-contract.test.ts`)
- **Network Primary and tool-boundary ACK:** low/medium/high network-primary eligibility, tool-batch wake/observation, completion fencing, and `tool-boundary-ack` helper capability must remain intact. (`tests/turn-plan.test.ts`, `tests/browser-worker-contract.test.ts`, `tests/chatgpt-web-harness.test.ts`)
- **Citation/content-reference propagation:** ChatGPT rich citation metadata must remain separate from assistant text and preserve stable structured annotation semantics. (`tests/web-stream-rich-fixture.test.ts`)
- **Same-turn recovery only:** incomplete-capture recovery may resume only a proven identical committed turn and must fail closed on missing/conflicting evidence. (`tests/recovery-equivalent-proof.test.ts`, `tests/recovery-request-observer.test.ts`)
- **Compaction continuity:** completed compaction continuation must re-authenticate the current Codex environment and reject mismatched rollout claims. (`tests/compaction-continuation-backport.test.ts`)
- **Native Codex passthrough:** native encrypted reasoning stays byte-for-byte intact, native compact/web-search routing remains native, and authentication failures remain fail closed. (`tests/native-passthrough.test.ts`)
- **Prompt/tool contract:** Full/browser-only modes, delegated tool capability, compaction isolation, history attribution, and rich-result Markdown fallback remain stable. (`tests/prompt-contract.test.ts`)
- **Trusted environment continuity:** cwd/sandbox/permission provenance remains bound to the trusted current Codex environment. (`tests/environment.test.ts`)
- **Launcher helper protocol:** persistent helper framing, multipart/compaction flags, ordering, and structured error contracts remain intact. (`tests/launcher-helper-client.test.ts`)
- **Interrupt-hook safety:** the narrowly managed Codex hook must preserve unrelated config and refuse unsafe removal. (`tests/codex-interrupt-hook.test.ts`)

`bun run test:custom-invariants` is a mandatory CI gate in `.github/workflows/upstream-sync.yml`. Removing the script or any listed test therefore fails upstream integration before packaging or deployment.
