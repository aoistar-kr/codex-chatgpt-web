# Active-turn control live receipt — 2026-09-17

## Scope

This receipt covers the Windows 11 installation and active-turn feature gate only. It does not
replace the unrelated cross-platform and upgrade checks in `docs/release-validation.md`.
Validation used commands and protocol evidence only, as requested; no computer-use automation or
synthetic UI click was used.

## Installed topology

The running Desktop process tree proved this exact route after a full restart:

```text
Codex Desktop ChatGPT.exe
  -> C:\Users\qkrgu\.codex-chatgpt-web\bin\codex-webgpt-proxy.exe
  -> C:\Users\qkrgu\AppData\Local\OpenAI\Codex\bin\12219cbfbcbddde7\codex.exe
  -> codex-code-mode-host.exe
```

`desktop-proxy doctor` passed with the user override active. The stable proxy SHA256 was
`85B31E0C5A866F75236EFDEA111859E52D37076653C97AE6C99A9D61664B7F86`; the selected original CLI
SHA256 was `960C111D47AFD61669954B9DF9E56083E302EDBFA3EF6962D81DCC14A30051DC`; the code-mode host SHA256
was `B6AEECB477CFF2F8E5AA5A607C1F8174BB56D9FE2B66A76EF7AA0D58BE496F1B`. All required sibling
executables existed and no `codex.real.exe` existed. No Codex application-owned file was replaced.

The installed route remained OpenCodex-owned: `openai_base_url` and realtime base URL were both
`http://127.0.0.1:10100/v1`; WebGPT remained the downstream provider on loopback port 17841.

## Controlled live result

The final installed production-route run used one Codex app-server task and returned:

```json
{
  "status": "LIVE_PASS",
  "route": "production-provider-route",
  "realToolCalls": 1,
  "realToolOutputs": 1,
  "sameLogicalTurn": true,
  "commentaryItems": 4,
  "fakeToolCalls": 0,
  "exactAbortEvents": 1,
  "finalHealth": {
    "activeHttpTurns": 0,
    "activeBrowserTurns": 0
  }
}
```

The current real Desktop task then received one diagnostic message while its turn was running.
The rollout retained the same turn identity, created no new `task_started` boundary, and emitted
the requested commentary marker exactly once. This is direct Desktop evidence that the installed
proxy receives immediate same-logical-turn steering rather than waiting for another provider turn.

The exact Stop path was exercised by the same native `turn/interrupt` app-server frame emitted by
the square Stop control. The installed proxy mirrored it to the authenticated exact-turn endpoint,
the rollout contained one matching `turn_aborted`, no successor epoch started, and the daemon
settled to zero active HTTP and browser turns. The UI was not clicked by automation because the
requested validation mode was command-only.

## Failures found and corrected during validation

1. A direct-original-CLI negative control bypassed the proxy and reproduced the delayed provider
   request plus missing trusted `cwd`; the installed proxy path passed. This confirmed why the
   thin stdio control bridge is required.
2. The live script had a removed version-directory default. Its default now uses the stable proxy.
3. A Markdown-escaped marker caused a false negative; the marker was changed to an escape-free
   token.
4. Rollout evidence could be read before terminal flush. The verifier now polls the same rollout
   briefly instead of restarting or replaying a turn.
5. The WebGPT launcher was not running after the controlled Desktop restart. The installed launcher
   was started in hidden mode, health reached ready/idle, and the same test was rerun to `LIVE_PASS`.

## Source and package evidence

- focused stdio/Desktop-proxy tests: 13 pass, 0 fail;
- required source gate: 354 pass, 2 Windows platform skips, 0 fail;
- custom invariants: 465 pass, 0 fail;
- repository-wide suite: 894 pass, 2 Windows platform skips, 0 fail;
- TypeScript and `git diff --check`: pass;
- relocatable runtime and packaged launcher smoke: pass;
- installer SHA256: `F95D125ED40FA98FC8756C988D60FBA0BABE5700D8A35E4C2692183D93D47A9E`;
- installed durable CLI SHA256: `5DDBCE63524A2FE7C910F25A5A7C168691F8AB3FB795B0E55A7BC437EFCBC7B4`.

The official OpenAI documentation does not document `CODEX_CLI_PATH` as a public Desktop contract.
Accordingly, every update remains guarded by doctor, canonical-path and sibling validation, hashes,
post-restart process proof, a prior-value journal, and conditional rollback.
