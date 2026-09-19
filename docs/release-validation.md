# Release validation

CI proves that the runtime builds, the launcher starts, and native packages pass their smoke
contract on macOS, Windows, and Linux. It does not prove an authenticated ChatGPT session, a live
MCP connector, or a complete Codex turn. A release candidate is not ready until those account-bound
flows are exercised manually on the platforms below.

## Required evidence

Record the release version, operating-system version, install path (`clean` or `upgrade`), ChatGPT
plan, Codex version, result of each check, and a redacted Activity log for every failure. Never
capture cookies, tunnel IDs, API keys, bearer tokens, or prompt contents.

## Windows 11 gate

Run this list on a maintained Windows 11 x64 machine with a real ChatGPT account:

1. Install the packaged launcher on a clean profile and prove that the embedded Bun runtime starts.
2. Sign in inside the embedded browser and prove that Temporary Chat reaches a usable composer.
3. Install the Codex model route, restart Codex, and prove that every account-available ChatGPT Web
   effort appears exactly once without removing native models.
   Before and after restart, run `desktop-proxy doctor`; prove the new Desktop app-server is the
   stable external proxy, its child is a validated original versioned Codex CLI, all recorded Codex
   application-file hashes are unchanged, and no `codex.real.exe` exists. Treat any failure as a
   blocked activation and restore the journaled user override without modifying app files.
4. Complete one Browser-only turn and verify streamed Working/reasoning summaries, commentary, and the final answer.
   While it runs, verify visible status/activity appears through the native Working/reasoning-summary
   surface, stable public prose remains commentary, and neither becomes a synthetic tool call. Enter two steering messages and prove they update the same logical task in
   order without replaying the original prompt; then repeat and use the Codex square Stop button to
   prove the exact ChatGPT generation stops even after the provider observer has detached.
5. Configure the `Codex Native2` connector, run **Verify runtime**, and complete one Full-mode local
   tool turn. Repeat with Pro when the account exposes Pro.
6. Drive a chat past the compaction threshold and prove that it continues after compaction without
   a duplicate or orphaned browser turn.
7. On a clean install, prove that setup installs the automatic interaction mode and that Codex
   shows the expected Web model rows after restart, a retained chat receives only the next prompt,
   and compaction completes through MCP before the compacted continuation opens a fresh chat.
   Switch back to Automatic and prove that the account-visible catalog is restored.
8. Cancel a running turn by closing its launcher tab, then cancel another with the launcher action;
   prove that neither turn recreates a tab or keeps the runtime busy.
9. Quit the launcher during an active turn, confirm the explicit cancellation path, reopen it, and
   prove that the saved ChatGPT session and Codex route are still valid.
10. Prove Codex Voice can create a WebRTC call while Responses use the local bridge. Disconnect the
   bridge and prove that both exact previous route assignments are restored; reconnect it and prove
   that the existing private MCP credentials are reused rather than replaced.
11. Upgrade from the previous public release and prove that launcher state, browser state, Codex
    settings, and MCP configuration survive the updater transaction.

Any failed or unexecuted item blocks a stable release. An alpha may ship with a named failed item
only when the release notes describe the limitation and recovery path explicitly.

### v4.0.8 active-turn feature result

The Windows active-turn feature subset passed on 2026-09-17 using command and protocol evidence,
including installed Desktop proxy activation, unchanged Codex application hashes, one real tool
call/result, live commentary, immediate same-turn Desktop steering, zero synthetic tool calls, and
one exact native interrupt with zero leaked active turns. See
[active-turn-control-live-receipt-2026-09-17.md](active-turn-control-live-receipt-2026-09-17.md).
This feature receipt does not claim that the unrelated items 1–10 above all ran for v4.0.8.

### v3.0.0 result

Maintainer validation passed on Windows 11 x64 on 2026-08-22 using the published v3.0.0-alpha
upgrade package and a real ChatGPT Pro account. The authenticated launcher, Codex model catalog,
Full-mode MCP tools, Pro turns, compaction, cancellation, session reuse, and preserved connector
configuration were exercised successfully. The direct installer completed successfully but gave no
clear completion action; v3.0.0 changes it to an assisted installer with a final launch option.

## macOS gate

Repeat items 2 through 10 on the oldest supported macOS version or the closest maintained machine.
Packaging smoke and code-signing verification remain separate gates; neither substitutes for the
interactive account flow.

## Linux gate

CI packaging smoke is required. Before claiming interactive Linux support for a release, repeat
items 2 through 7 under a supported desktop session and record the display server and packaging
format used.
