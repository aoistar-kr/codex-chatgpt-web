# 업스트림 동기화 감사 (2026-09-19)

## 0. 기준

| 항목 | 값 |
|---|---|
| 우리 HEAD (custom) | `c1f9265d9b58` |
| 업스트림 HEAD (upstream/main) | `eaf4f09ae92d` |
| 공통 조상 (merge-base) | `bd535d8359cf` |
| 우리만 앞선 커밋 | 12 |
| 업스트림만 앞선 커밋 | 29 |
| 백업 | branch `backup/custom-pre-upstream-sync-20260919`, tag `pre-upstream-sync-2026-09-19`, dir `..\_codex-chatgpt-web-backup-20260919` |

기준선(병합 전): typecheck exit 0, test:custom-invariants 476 pass / 0 fail.

## 1. 요약

| 분류 | 파일 수 | 병합 정책 |
|---|---|---|
| 업스트림이 추가 (우리 없음) | 26 | 그대로 채택 |
| 우리가 추가 (업스트림 없음) | 54 | 보존 (독자 기능) |
| 양쪽이 추가 | 4 | 수동 검토 (중복 구현 위험) |
| 양쪽이 수정 | 67 | hunk 단위 3-way 병합 |
| 업스트림만 수정 | 59 | 채택 (충돌 없음) |
| 우리만 수정 | 8 | 우리 유지 |
| 삭제 | 1 | 확인 필요 |

## 2. 업스트림이 추가한 파일 -> 채택

- `README.ko.md` (+206/-0)
- `assets/readme/download-linux.svg` (+10/-0)
- `assets/readme/download-macos.svg` (+11/-0)
- `assets/readme/download-windows.svg` (+10/-0)
- `assets/readme/hero.svg` (+20/-0)
- `assets/readme/persona-voice.svg` (+12/-0)
- `launcher/electron/languages.json` (+27/-0)
- `launcher/src/assets/mcp-connect-connector.mp4` (+-/--)
- `launcher/src/assets/mcp-create-tunnel.mp4` (+-/--)
- `scripts/smoke-codex-environment.ts` (+185/-0)
- `scripts/smoke-codex-interrupt.ts` (+276/-0)
- `src/adapters/chatgpt-web/mcp-observation.ts` (+63/-0)
- `src/adapters/chatgpt-web/skill-attachments.ts` (+47/-0)
- `src/adapters/chatgpt-web/ui-labels.ts` (+66/-0)
- `src/native-network.ts` (+47/-0)
- `tests/browser-response-dom.test.ts` (+110/-0)
- `tests/compaction-browser-recovery.test.ts` (+110/-0)
- `tests/fixtures/chatgpt-dil-smoke.html` (+20/-0)
- `tests/launcher-localization.test.ts` (+24/-0)
- `tests/mcp-observation.test.ts` (+75/-0)
- `tests/native-network.test.ts` (+102/-0)
- `tests/skill-attachments.test.ts` (+110/-0)
- `tests/subagent-environment-history.test.ts` (+117/-0)
- `tests/zero-risk-adapter.test.ts` (+595/-0)
- `tests/zero-risk-mcp-lifecycle.test.ts` (+412/-0)
- `tests/zero-risk-prompt-contract.test.ts` (+81/-0)

## 3. 우리가 추가한 파일 -> 보존

- `.github/workflows/upstream-sync.yml` (+261/-0)
- `CUSTOM_INVARIANTS.md` (+20/-0)
- `docs/active-turn-control-e2e-plan.md` (+871/-0)
- `docs/active-turn-control-live-receipt-2026-09-17.md` (+88/-0)
- `docs/active-turn-control-next-session-handoff.md` (+596/-0)
- `launcher/electron/runtime-install-worker.cjs` (+47/-0)
- `scripts/cicd/deploy-local-windows.ps1` (+88/-0)
- `scripts/lib/stream-canary-acceptance.ts` (+98/-0)
- `scripts/lib/stream-canary-fixtures.ts` (+57/-0)
- `scripts/live-active-turn-control.ts` (+464/-0)
- `scripts/smoke-chatgpt-web-stream.ts` (+397/-0)
- `src/adapters/chatgpt-web/codex-rollout-control.ts` (+313/-0)
- `src/adapters/chatgpt-web/native-parallel-batch-control.ts` (+3/-0)
- `src/adapters/chatgpt-web/recovery-dom-continuity.ts` (+86/-0)
- `src/adapters/chatgpt-web/recovery-dom-proof.ts` (+416/-0)
- `src/adapters/chatgpt-web/recovery-equivalent-proof.ts` (+239/-0)
- `src/adapters/chatgpt-web/recovery-identity.ts` (+439/-0)
- `src/adapters/chatgpt-web/recovery-request-observer.ts` (+313/-0)
- `src/adapters/chatgpt-web/recovery-server-proof.ts` (+191/-0)
- `src/adapters/chatgpt-web/recovery-turn-id-continuity.ts` (+155/-0)
- `src/adapters/chatgpt-web/submission-disposition.ts` (+94/-0)
- `src/adapters/chatgpt-web/turn-plan.ts` (+128/-0)
- `src/adapters/chatgpt-web/web-stream-tap.ts` (+5/-0)
- `src/adapters/chatgpt-web/web-stream/conversation-sse.ts` (+922/-0)
- `src/adapters/chatgpt-web/web-stream/flags.ts` (+66/-0)
- `src/adapters/chatgpt-web/web-stream/network-observer.ts` (+359/-0)
- `src/adapters/chatgpt-web/web-stream/request-injection.ts` (+1302/-0)
- `src/adapters/chatgpt-web/web-stream/websocket-handoff.ts` (+52/-0)
- `src/codex-cli-resolver.ts` (+133/-0)
- `src/codex-desktop-proxy.ts` (+268/-0)
- `src/codex-stdio-proxy.ts` (+173/-0)
- `tests/codex-desktop-proxy.test.ts` (+143/-0)
- `tests/codex-rollout-control.test.ts` (+157/-0)
- `tests/codex-stdio-proxy.test.ts` (+144/-0)
- `tests/compaction-continuation-backport.test.ts` (+88/-0)
- `tests/completed-rebind-diagnostic.test.ts` (+244/-0)
- `tests/recovery-dom-continuity.test.ts` (+143/-0)
- `tests/recovery-equivalent-proof.test.ts` (+182/-0)
- `tests/recovery-evidence.test.ts` (+228/-0)
- `tests/recovery-identity.test.ts` (+378/-0)
- `tests/recovery-message-sampler.test.ts` (+325/-0)
- `tests/recovery-request-observer.test.ts` (+223/-0)
- `tests/recovery-resume-synthetic.test.ts` (+350/-0)
- `tests/recovery-server-proof.test.ts` (+121/-0)
- `tests/recovery-turn-id-continuity.test.ts` (+82/-0)
- `tests/remote-compaction-environment.test.ts` (+138/-0)
- `tests/request-prompt-shape.test.ts` (+93/-0)
- `tests/stream-canary-acceptance.test.ts` (+83/-0)
- `tests/stream-canary-fixtures.test.ts` (+42/-0)
- `tests/submission-disposition.test.ts` (+104/-0)
- `tests/turn-plan.test.ts` (+342/-0)
- `tests/web-stream-rich-fixture.test.ts` (+96/-0)
- `tests/web-stream-submission-diagnostic.test.ts` (+142/-0)
- `tests/web-stream-tap.test.ts` (+1360/-0)

## 4. 양쪽이 추가 -> 중복 구현 검토

| 파일 | 업스트림 | 우리 |
|---|---|---|
| `src/adapters/chatgpt-web/codex-rollout-environment.ts` | +666/-0 | +723/-0 |
| `src/adapters/chatgpt-web/compaction-continuation.ts` | +76/-0 | +76/-0 |
| `src/codex-interrupt-hook.ts` | +256/-0 | +240/-0 |
| `tests/codex-interrupt-hook.test.ts` | +219/-0 | +163/-0 |

## 5. 양쪽이 수정 -> 충돌 위험 (hunk 단위 병합)

| 파일 | 업스트림 | 우리 |
|---|---|---|
| `tests/browser-worker-contract.test.ts` | +1438/-431 | +657/-25 |
| `src/adapters/chatgpt-web/browser-worker.ts` | +1004/-380 | +2513/-146 |
| `launcher/tests/browser-host.test.cjs` | +962/-26 | +1145/-131 |
| `launcher/electron/browser-host.cjs` | +953/-64 | +509/-42 |
| `tests/environment.test.ts` | +936/-7 | +385/-3 |
| `tests/chatgpt-web-harness.test.ts` | +675/-181 | +587/-8 |
| `tests/server-lifecycle.test.ts` | +647/-10 | +120/-4 |
| `launcher/src/i18n.ts` | +616/-21 | +8/-8 |
| `src/adapters/chatgpt-web/index.ts` | +571/-127 | +508/-56 |
| `tests/codex-integration.test.ts` | +489/-7 | +537/-7 |
| `src/adapters/chatgpt-web/turn-broker.ts` | +482/-19 | +5/-0 |
| `tests/retained-compaction.test.ts` | +453/-19 | +4/-1 |
| `src/adapters/chatgpt-web/mcp-server.ts` | +318/-151 | +104/-1 |
| `src/server.ts` | +314/-29 | +252/-22 |
| `launcher/electron/main.cjs` | +304/-34 | +94/-97 |
| `src/adapters/chatgpt-web/environment.ts` | +303/-44 | +558/-54 |
| `src/launcher-browser-host.ts` | +290/-15 | +77/-17 |
| `launcher/tests/runtime-host.test.cjs` | +288/-27 | +2/-5 |
| `launcher/tests/control-server.test.cjs` | +287/-0 | +30/-1 |
| `launcher/electron/runtime.cjs` | +262/-38 | +3/-6 |
| `src/codex-integration-document.ts` | +247/-20 | +247/-20 |
| `tests/cli.test.ts` | +244/-8 | +4/-2 |
| `tests/launcher-browser-host.test.ts` | +241/-14 | +109/-27 |
| `src/adapters/chatgpt-web/compaction-handoff.ts` | +229/-10 | +133/-10 |
| `src/adapters/chatgpt-web/prompt.ts` | +229/-70 | +75/-9 |
| `tests/chatgpt-session.test.ts` | +223/-52 | +2/-1 |
| `src/setup.ts` | +208/-52 | +7/-10 |
| `launcher/tests/renderer-wiring.test.cjs` | +196/-26 | +12/-7 |
| `tests/launcher-helper-client.test.ts` | +175/-39 | +91/-2 |
| `src/config.ts` | +169/-45 | +10/-4 |
| `launcher/electron/control-server.cjs` | +160/-10 | +38/-4 |
| `src/codex-integration-route.ts` | +137/-27 | +137/-27 |
| `src/codex-integration.ts` | +137/-51 | +180/-51 |
| `tests/prompt-contract.test.ts` | +132/-34 | +67/-0 |
| `src/adapters/chatgpt-web/turn-execution.ts` | +124/-10 | +622/-24 |
| `src/chatgpt-session.ts` | +110/-24 | +25/-3 |
| `README.md` | +102/-142 | +84/-13 |
| `src/codex-integration-shared.ts` | +97/-8 | +97/-8 |
| `src/adapters/chatgpt-web/markdown.ts` | +95/-9 | +273/-0 |
| `src/cli.ts` | +85/-12 | +95/-2 |
| `src/adapters/chatgpt-web/thread-environment.ts` | +60/-1 | +90/-1 |
| `src/codex-integration-journal.ts` | +57/-1 | +57/-1 |
| `src/adapters/chatgpt-web/launcher-helper-client.ts` | +46/-4 | +173/-6 |
| `docs/architecture.md` | +44/-6 | +23/-0 |
| `tests/native-passthrough.test.ts` | +38/-1 | +40/-0 |
| `launcher/tests/browser-helper-verifier.test.cjs` | +37/-0 | +4/-4 |
| `src/native-passthrough.ts` | +36/-6 | +34/-5 |
| `src/service.ts` | +34/-0 | +54/-0 |
| `src/adapters/chatgpt-web/turn-progress.ts` | +33/-3 | +7/-1 |
| `src/adapters/chatgpt-web/browser-helper-main.ts` | +27/-17 | +83/-11 |
| `tests/chatgpt-web-markdown.test.ts` | +23/-4 | +157/-1 |
| `src/adapters/chatgpt-web/adapter-error.ts` | +22/-5 | +45/-0 |
| `launcher/electron/state.cjs` | +14/-1 | +5/-0 |
| `src/doctor.ts` | +14/-4 | +12/-3 |
| `docs/release-validation.md` | +13/-5 | +18/-1 |
| `docs/security-model.md` | +9/-3 | +25/-1 |
| `launcher/electron/browser-helper-verifier.cjs` | +9/-2 | +7/-3 |
| `tests/model-contract.test.ts` | +9/-9 | +22/-1 |
| `package.json` | +8/-5 | +5/-2 |
| `launcher/bun.lock` | +7/-3 | +6/-2 |
| `bun.lock` | +6/-5 | +4/-3 |
| `src/types.ts` | +6/-0 | +13/-0 |
| `launcher/package.json` | +5/-1 | +4/-0 |
| `src/adapters/chatgpt-web/model.ts` | +2/-1 | +26/-0 |
| `src/bridge.ts` | +2/-2 | +21/-5 |
| `src/dev-chat/profile.ts` | +2/-1 | +3/-1 |
| `tests/composer-insert.test.ts` | +1/-1 | +68/-9 |

## 6. 업스트림만 수정 -> 그대로 채택

| 파일 | 업스트림 |
|---|---|
| `launcher/src/App.tsx` | +614/-159 |
| `launcher/src/styles.css` | +406/-2 |
| `tests/server-compaction.test.ts` | +225/-5 |
| `launcher/tests/runtime-supervisor.test.cjs` | +176/-11 |
| `src/chatgpt-web-models.ts` | +171/-15 |
| `launcher/tests/localization.test.cjs` | +155/-39 |
| `tests/runtime-layout.test.ts` | +142/-16 |
| `tests/setup-lifecycle.test.ts` | +137/-7 |
| `launcher/electron/runtime-supervisor.cjs` | +100/-33 |
| `tests/chatgpt-web-models.test.ts` | +97/-8 |
| `README.ja.md` | +90/-125 |
| `README.zh-CN.md` | +88/-114 |
| `tests/chatgpt-web-usage.test.ts` | +86/-2 |
| `src/adapters/chatgpt-web/usage.ts` | +63/-12 |
| `tests/dev-chat.test.ts` | +63/-4 |
| `launcher/tests/state.test.cjs` | +55/-4 |
| `tests/model-catalog.test.ts` | +53/-4 |
| `tests/server-models.test.ts` | +53/-1 |
| `tests/turn-broker-lifecycle.test.ts` | +49/-0 |
| `src/tunnel.ts` | +47/-32 |
| `TROUBLESHOOTING.md` | +45/-4 |
| `.github/workflows/release.yml` | +39/-1 |
| `src/dev-chat/cli.ts` | +33/-14 |
| `tests/personalization-connector-preflight.test.ts` | +28/-11 |
| `tests/dev-profile.test.ts` | +27/-1 |
| `src/browser-login.ts` | +26/-5 |
| `launcher/src/types.ts` | +24/-2 |
| `docs/dev-chat.md` | +22/-4 |
| `src/adapters/chatgpt-web/native-compaction-control.ts` | +21/-2 |
| `tests/tunnel.test.ts` | +20/-28 |
| `src/adapters/chatgpt-web/input-tokens.ts` | +14/-14 |
| `src/responses/parser.ts` | +12/-5 |
| `src/responses/compaction.ts` | +11/-0 |
| `launcher/electron/preload.cjs` | +10/-1 |
| `src/adapters/chatgpt-web/mcp-main.ts` | +9/-2 |
| `scripts/check-version.ts` | +7/-0 |
| `src/dev-chat/driver.ts` | +7/-0 |
| `launcher/electron/atomic-file.cjs` | +6/-4 |
| `tests/tunnel-service.test.ts` | +6/-1 |
| `.github/ISSUE_TEMPLATE/config.yml` | +4/-1 |
| `CONTRIBUTING.md` | +4/-2 |
| `launcher/src/icons.tsx` | +4/-0 |
| `tests/rolling-checkpoint.test.ts` | +4/-4 |
| `.gitignore` | +3/-0 |
| `src/responses/schema.ts` | +3/-0 |
| `tests/responses-text-controls.test.ts` | +3/-9 |
| `.github/ISSUE_TEMPLATE/bug-report.yml` | +2/-1 |
| `launcher/electron/browser-state.cjs` | +2/-2 |
| `launcher/electron/turn-suspension.cjs` | +2/-3 |
| `launcher/tests/turn-suspension.test.cjs` | +2/-3 |
| `tests/browser-login.test.ts` | +2/-0 |
| `scripts/install.sh` | +1/-1 |
| `src/adapters/chatgpt-web/retry-policy.ts` | +1/-1 |
| `src/dev-chat/session.ts` | +1/-0 |
| `src/model-catalog.ts` | +1/-1 |
| `src/version.ts` | +1/-1 |
| `tests/prompt-history-metadata.test.ts` | +1/-1 |
| `tests/responses-agent-message.test.ts` | +1/-1 |
| `tests/responses-lite-tools.test.ts` | +1/-1 |

## 7. 우리만 수정 -> 우리 유지

- `scripts/smoke-release.ts` (+309/-149)
- `launcher/electron/runtime-install.cjs` (+236/-14)
- `launcher/tests/runtime-install.test.cjs` (+187/-0)
- `launcher/scripts/smoke-package.cjs` (+26/-21)
- `scripts/build-runtime-bundle.ts` (+16/-0)
- `tests/token-estimate.test.ts` (+15/-0)
- `src/lib/token-estimate.ts` (+11/-1)
- `launcher/tests/packaging-contract.test.cjs` (+5/-2)

## 8. 삭제

- `.github/ISSUE_TEMPLATE/feature-request.yml` (upstream=D, ours=-)

## 9. 병합 계획

1. Tier A: 2절(업스트림 신규) 채택. 충돌 없음.
2. Tier B: 6절(업스트림만 수정) 업스트림 채택. 충돌 없음.
3. Tier C: 7절(우리만 수정) 유지.
4. Tier D: 4/5절은 hunk 단위 3-way 병합. 우리 독자 기능(request-injection, network-primary, 직접 스티어링, stdio 프록시) 포함 파일은 통째 대체 금지. 업스트림이 같은 기능을 이미 구현했으면 업스트림만 남기고 우리 중복을 제거.
5. 게이트: typecheck -> test:custom-invariants -> git diff --check.

