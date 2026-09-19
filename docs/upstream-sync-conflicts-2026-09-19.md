# 업스트림 병합 충돌 인벤토리 (2026-09-19)

대상: `custom` (c1f9265) <- `upstream/main` (eaf4f09a)

| 항목 | 값 |
|---|---|
| 충돌 파일 | 50 |
| 충돌 hunk 총계 | 239 |
| 자동 병합된 파일 | 101 (6519 insertions / 906 deletions) |
| 병합 작업 위치 | `C:\Users\qkrgu\Documents\GitHub\codex-chatgpt-web-upstream-sync` (worktree, branch `sync/upstream-2026-09-19`) |
| 라이브 트리 | `custom` 그대로, 병합 중단(abort) 상태로 깨끗함 |

재현/중단:

```
git -C C:\Users\qkrgu\Documents\GitHub\codex-chatgpt-web-upstream-sync merge upstream/main   # 재현
git -C C:\Users\qkrgu\Documents\GitHub\codex-chatgpt-web-upstream-sync merge --abort          # 중단
```

## 충돌 목록 (hunk 많은 순)

| # | 파일 | hunk | 분류 | 정책 |
|---|---|---|---|---|
| 1 | `src/adapters/chatgpt-web/browser-worker.ts` | 39 | 커스텀 코어 | 필수 수동 (통째 대체 금지) |
| 2 | `src/adapters/chatgpt-web/index.ts` | 17 | 커스텀 코어 | 필수 수동 (통째 대체 금지) |
| 3 | `tests/browser-worker-contract.test.ts` | 15 | 테스트 | union 후보 (양쪽 테스트 보존, 게이트로 검증) |
| 4 | `src/adapters/chatgpt-web/environment.ts` | 13 | 커스텀 코어 | 필수 수동 (통째 대체 금지) |
| 5 | `src/server.ts` | 12 | 커스텀 코어 | 필수 수동 (통째 대체 금지) |
| 6 | `src/adapters/chatgpt-web/codex-rollout-environment.ts` | 12 | 커스텀 코어 | 필수 수동 (통째 대체 금지) |
| 7 | `src/adapters/chatgpt-web/compaction-handoff.ts` | 11 | 커스텀 코어 | 필수 수동 (통째 대체 금지) |
| 8 | `launcher/electron/browser-host.cjs` | 10 | 런처 | 수동 (Electron/렌더러 경로) |
| 9 | `tests/server-lifecycle.test.ts` | 9 | 테스트 | union 후보 (양쪽 테스트 보존, 게이트로 검증) |
| 10 | `src/adapters/chatgpt-web/turn-execution.ts` | 9 | 커스텀 코어 | 필수 수동 (통째 대체 금지) |
| 11 | `tests/environment.test.ts` | 8 | 테스트 | union 후보 (양쪽 테스트 보존, 게이트로 검증) |
| 12 | `tests/chatgpt-web-harness.test.ts` | 7 | 테스트 | union 후보 (양쪽 테스트 보존, 게이트로 검증) |
| 13 | `src/adapters/chatgpt-web/launcher-helper-client.ts` | 5 | 커스텀 코어 | 필수 수동 (통째 대체 금지) |
| 14 | `src/adapters/chatgpt-web/browser-helper-main.ts` | 5 | 커스텀 코어 | 필수 수동 (통째 대체 금지) |
| 15 | `tests/launcher-browser-host.test.ts` | 4 | 테스트 | union 후보 (양쪽 테스트 보존, 게이트로 검증) |
| 16 | `src/cli.ts` | 4 | 커스텀 코어 | 필수 수동 (통째 대체 금지) |
| 17 | `README.md` | 4 | 메타 | 수동 (스크립트/락파일/문서) |
| 18 | `launcher/electron/main.cjs` | 4 | 런처 | 수동 (Electron/렌더러 경로) |
| 19 | `package.json` | 3 | 메타 | 수동 (스크립트/락파일/문서) |
| 20 | `src/native-passthrough.ts` | 3 | 커스텀 코어 | 필수 수동 (통째 대체 금지) |
| 21 | `src/adapters/chatgpt-web/thread-environment.ts` | 3 | 커스텀 코어 | 필수 수동 (통째 대체 금지) |
| 22 | `src/adapters/chatgpt-web/prompt.ts` | 3 | 커스텀 코어 | 필수 수동 (통째 대체 금지) |
| 23 | `launcher/electron/runtime.cjs` | 3 | 런처 | 수동 (Electron/렌더러 경로) |
| 24 | `src/adapters/chatgpt-web/mcp-server.ts` | 3 | 커스텀 코어 | 필수 수동 (통째 대체 금지) |
| 25 | `launcher/tests/runtime-host.test.cjs` | 2 | 런처 | 수동 (Electron/렌더러 경로) |
| 26 | `tests/launcher-helper-client.test.ts` | 2 | 테스트 | union 후보 (양쪽 테스트 보존, 게이트로 검증) |
| 27 | `src/codex-interrupt-hook.ts` | 2 | 커스텀 코어 | 필수 수동 (통째 대체 금지) |
| 28 | `tests/codex-integration.test.ts` | 2 | 테스트 | union 후보 (양쪽 테스트 보존, 게이트로 검증) |
| 29 | `launcher/tests/renderer-wiring.test.cjs` | 2 | 런처 | 수동 (Electron/렌더러 경로) |
| 30 | `tests/cli.test.ts` | 2 | 테스트 | union 후보 (양쪽 테스트 보존, 게이트로 검증) |
| 31 | `src/service.ts` | 2 | 커스텀 코어 | 필수 수동 (통째 대체 금지) |
| 32 | `tests/native-passthrough.test.ts` | 1 | 테스트 | union 후보 (양쪽 테스트 보존, 게이트로 검증) |
| 33 | `bun.lock` | 1 | 메타 | 수동 (스크립트/락파일/문서) |
| 34 | `docs/architecture.md` | 1 | 메타 | 수동 (스크립트/락파일/문서) |
| 35 | `tests/composer-insert.test.ts` | 1 | 테스트 | union 후보 (양쪽 테스트 보존, 게이트로 검증) |
| 36 | `tests/codex-interrupt-hook.test.ts` | 1 | 테스트 | union 후보 (양쪽 테스트 보존, 게이트로 검증) |
| 37 | `tests/chatgpt-web-markdown.test.ts` | 1 | 테스트 | union 후보 (양쪽 테스트 보존, 게이트로 검증) |
| 38 | `launcher/electron/control-server.cjs` | 1 | 런처 | 수동 (Electron/렌더러 경로) |
| 39 | `launcher/tests/control-server.test.cjs` | 1 | 런처 | 수동 (Electron/렌더러 경로) |
| 40 | `src/setup.ts` | 1 | 커스텀 코어 | 필수 수동 (통째 대체 금지) |
| 41 | `src/adapters/chatgpt-web/adapter-error.ts` | 1 | 커스텀 코어 | 필수 수동 (통째 대체 금지) |
| 42 | `src/launcher-browser-host.ts` | 1 | 커스텀 코어 | 필수 수동 (통째 대체 금지) |
| 43 | `src/dev-chat/profile.ts` | 1 | 기타 | 수동 |
| 44 | `launcher/src/i18n.ts` | 1 | 런처 | 수동 (Electron/렌더러 경로) |
| 45 | `src/chatgpt-session.ts` | 1 | 커스텀 코어 | 필수 수동 (통째 대체 금지) |
| 46 | `src/adapters/chatgpt-web/turn-progress.ts` | 1 | 커스텀 코어 | 필수 수동 (통째 대체 금지) |
| 47 | `launcher/tests/browser-host.test.cjs` | 1 | 런처 | 수동 (Electron/렌더러 경로) |
| 48 | `tests/retained-compaction.test.ts` | 1 | 테스트 | union 후보 (양쪽 테스트 보존, 게이트로 검증) |
| 49 | `tests/chatgpt-session.test.ts` | 1 | 테스트 | union 후보 (양쪽 테스트 보존, 게이트로 검증) |
| 50 | `src/adapters/chatgpt-web/turn-broker.ts` | 1 | 커스텀 코어 | 필수 수동 (통째 대체 금지) |

## 우선순위 (상위 10개 파일 = 148 hunk, 전체의 62%)

- 상위 10개 파일이 147 / 239 hunk.
- 1순위(커스텀 코어 수동 병합): `src/adapters/chatgpt-web/browser-worker.ts`, `src/adapters/chatgpt-web/index.ts`, `src/adapters/chatgpt-web/environment.ts`, `src/server.ts`, `src/adapters/chatgpt-web/codex-rollout-environment.ts`, `src/adapters/chatgpt-web/compaction-handoff.ts`, `src/adapters/chatgpt-web/turn-execution.ts`, `src/adapters/chatgpt-web/launcher-helper-client.ts`, `src/adapters/chatgpt-web/browser-helper-main.ts`, `src/cli.ts`, `src/native-passthrough.ts`, `src/adapters/chatgpt-web/thread-environment.ts`, `src/adapters/chatgpt-web/prompt.ts`, `src/adapters/chatgpt-web/mcp-server.ts`, `src/codex-interrupt-hook.ts`, `src/service.ts`, `src/setup.ts`, `src/adapters/chatgpt-web/adapter-error.ts`, `src/launcher-browser-host.ts`, `src/chatgpt-session.ts`, `src/adapters/chatgpt-web/turn-progress.ts`, `src/adapters/chatgpt-web/turn-broker.ts`

## 해소 절차

1. 커스텀 코어부터: 우리 hunk를 기준으로 유지하고, 겹치는 지점에서만 업스트림 semantic을 채택한다. 통째 대체 금지.
2. 테스트 충돌은 양쪽 테스트를 보존하는 union으로 해소한 뒤, 게이트 실패로 잘못된 union을 걸러낸다.
3. add/add 4건(codex-interrupt-hook.ts, tests/codex-interrupt-hook.test.ts, codex-rollout-environment.ts, compaction-continuation.ts)은 중복 구현 판정 대상이다. 업스트림 구현이 상위집합이면 업스트림만 남긴다.
4. 각 tier 후 게이트: bun run typecheck -> bun run test:custom-invariants -> git diff --check.
5. 병합 검증 전에는 `custom`에 머지 커밋을 만들지 않는다.

## 절대 규칙

- request-injection / network-primary / 직접 스티어링(composer 주입) / /admin/steer-turn / stdio+desktop proxy 는 우리 독자 기능이다. 업스트림에 대응 구현이 없으므로 어떤 충돌에서도 잃으면 안 된다.
- upstream press `timeout: 0` 수정은 채택해야 한다 (우리 포크에만 있는 20초 회귀 제거).

