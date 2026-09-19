# 업스트림 병합 결과 (2026-09-19)

분기점 `bd535d83` 기준으로 업스트림 `main` (eaf4f09a) 을 우리 `custom` 브랜치에 수동 분석 병합했다.

## 배치 커밋

- `f25b3c8 feat: checkpoint custom WebGPT integration`
- `f615824 ci: add fail-closed upstream sync and local deploy`
- `5bf9428 ci: retry deployment until release is marked deployed`
- `a180c23 ci: pin custom invariant regression gates`
- `204b389 perf: enable network primary for extra-high and pro`
- `8cc5783 perf: generalize direct web mode injection`
- `f653e99 docs: install custom fork from source`
- `97ec1aa feat: bridge live turn control with ChatGPT`
- `b3ca55c fix(ci): clear handled merge-base status`
- `5fcf4ca fix(compaction): recover root environment from rollout`
- `ea18417 fix(compaction): trust trigger over request kind`
- `c1f9265 chore: checkpoint custom WebGPT integration before upstream sync`
- `067e515 merge(upstream): fix compaction send timeout and adopt upstream interrupt hook`
- `80f2d9d merge(upstream): adopt conflict-free upstream files (Tier A/B)`
- `1accc75 merge(upstream): wire content-free MCP tool observation into our broker`
- `ec3f07c merge(upstream): adopt upstream turn-broker with our Bun/Windows settle semantics`
- `2df4afb merge(upstream): adopt upstream prompt planner and skill attachments`
- `386cf92 merge(upstream): auto-merge the remaining conflict-free Tier D files`
- `7d429d4 merge(upstream): converge dev-chat profile formatting with upstream`
- `977fdfb merge(upstream): adopt upstream model route tables with our composer limit`
- `53a1abb merge(upstream): adopt the Zero Risk launcher/config chain`
- `b5a7efa merge(upstream): adopt the Zero Risk MCP contract with our fork additions`

## 채택한 업스트림 기능

- 컴팩션 멀티파트 전송 press 예산 수정 (20초 -> runStage 위임). 이번 장애의 직접 원인.
- 인터럽트 훅의 Windows 견고화 (다중 패턴 소유 구간, TOML 값 검증, 리터럴 trust 키).
- Tier A/B: 업스트림 신규 파일 22개 + 업스트림만 수정한 파일 47개 (responses 파서/스키마/컴팩션, retry-policy, tunnel, launcher electron 헬퍼 등).
- MCP 툴 관찰 배선 (observeMcpToolCalls, BRIDGE_TOOL_NAMES).
- turn-broker owner/safe-turn 수명주기 (registerSafe, confirmSafeTurnSent, waitForSafeCompletion, owner_completion_fence_*).
- 프롬프트 플래너 + skill attachments + CodexUserMessage.origin + Zero Risk manualControl 계약.
- 모델 라우트 테이블 + Zero Risk 프로필 (우리 컴포저 상한 유지).
- launcher/config 체인: BrowserInteractionMode, per-mode tunnel, resolveInteractionConnectorIdentities, zeroRiskProEnabled.
- Zero Risk MCP 계약: ChatGptMcpContract native/safe, codex_turn_start/codex_turn_complete, safeVisibleTools.

## 우리 것을 유지한 지점 (의도적)

- 직접 스티어링 (composer 주입, /admin/steer-turn, stdio 프록시 turn/steer 가로채기) - 업스트림에 대응 구현 없음.
- request-injection / network-primary - 업스트림에 없음.
- 예약 병렬 exec_command 배치 제어 + Windows 저오버헤드 cmd.exe fast path.
- launcher 호스트의 stop phase, model/effort prewarm, connector plugin id, unsubmitted 플래그, 취소 경계 검사.
- CHATGPT_WEB_AGENT_WAIT_POLL_MS = 10초 (업스트림 30초) - 터널 2분 데드라인 때문.
- CHATGPT_BIGGER_CONTEXT_PARTS = 3 (업스트림 6) - 아래 보류 항목 참조.
- model.ts effort 라우팅과 우리 계약 테스트.

## 보류 (이유 포함)

- **6조각 Bigger Context 플래너**: 업스트림 상수는 6. 전환하려면 `src/adapters/chatgpt-web/model.ts` 의 effort 라우팅(고정 라우트 -> 가시 모드 매핑, Pro 위임 계약)까지 함께 가져와야 하는데, 그건 우리 커스텀 라우팅(extra-high/pro network primary)과 정면으로 겹친다. 실측: 전환 시 계약 테스트 6건 실패(고정 라우트 매핑, Pro 위임, 프리플라이트 경계, 스테이징 모드, 3-part 엔벨로프 2건). model/effort 불변조건을 먼저 합의한 뒤 별도 배치로 진행해야 한다.
- **Zero Risk 어댑터 런타임**: `index.ts` 의 ChatGptZeroRiskManualControl export 와 launcher i18n 라벨(manualPromptInstruction)이 필요하다. index.ts 는 우리 스티어링/주입이 얹힌 17-hunk 파일이라 별도 배치.
- **업스트림 신규 테스트 7개**: browser-response-dom, compaction-browser-recovery, launcher-localization, skill-attachments, zero-risk-adapter, zero-risk-mcp-lifecycle, zero-risk-prompt-contract. 위 두 항목이 들어와야 실행 가능.
- **업스트림만 수정한 파일 8개**: dev-chat/driver.ts, chatgpt-web-models/usage/dev-chat/responses-text-controls/server-compaction/server-models/setup-lifecycle 테스트. 6조각/Zero Risk 런타임에 의존.
- **markdown.ts**: 업스트림 버전이 우리 Obsidian 위키링크 보존 계약을 깬다.
- **turn-progress.ts**: 업스트림이 `CHATGPT_TOOL_BOUNDARY_OBSERVATION_TIMEOUT_MS` 를 제거했는데 우리 index/테스트가 아직 import 한다.
- **README.ko.md / languages.json / i18n.ts**: 업스트림 제품 기준 문구라 우리 커스텀 기능을 설명하지 못한다.

## 남은 격차

- 업스트림 신규 미채택: 7
- 업스트림만 수정 미채택: 8
- 양쪽 수정 중 여전히 발산(대부분 의도적 유지): 58

## 검증

각 배치마다 `node node_modules/typescript/bin/tsc --noEmit` exit 0 과 `bun run test:custom-invariants` 478 pass / 0 fail 를 확인했다. 기준선(병합 전)은 476 pass 였고, +2 는 업스트림 인터럽트 훅 테스트가 더 많아서다.

