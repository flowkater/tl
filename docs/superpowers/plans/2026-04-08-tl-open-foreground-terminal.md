# TL Open Foreground Terminal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `tl open`과 `tl local open`이 `screen`/`--no-alt-screen` 없이 현재 터미널 환경을 그대로 사용하면서 `cmux`와 Codex 훅을 정상 동작시키도록 바꾼다.

**Architecture:** `tl open`은 별도 `screen` 세션을 만들지 않고 현재 터미널에서 foreground `codex --remote`를 직접 실행한다. 로컬 managed 세션 재접속도 `screen` 재부착이 아니라 foreground `codex resume --remote`로 처리하고, 필요한 TL 훅 환경만 child env로 명시적으로 전달한다.

**Tech Stack:** TypeScript, Node.js child_process, Vitest, Codex app-server

---

### Task 1: Foreground Codex 런처 정리

**Files:**
- Modify: `src/interactive-codex-launcher.ts`
- Test: `tests/interactive-codex-launcher.test.ts`

- [ ] `codex resume --remote` 인자 생성에서 `--no-alt-screen` 제거
- [ ] foreground `codex --remote` 실행용 open 인자 빌더 추가
- [ ] child env override를 지원하도록 런처 확장
- [ ] 런처 단위 테스트를 open/resume 둘 다 검증하도록 갱신

### Task 2: `tl open` / `tl local open` foreground 전환

**Files:**
- Modify: `src/cli.ts`
- Modify: `src/types.ts`
- Test: `tests/e2e-cli-daemon.test.ts`

- [ ] `tl open`에서 `screen` 기반 `startFresh`/`attach` 호출 제거
- [ ] `TL_MANAGED_OPEN`, `TL_SESSION_MODE`, `TL_OPEN_PROJECT`, `TL_REMOTE_ENDPOINT`를 foreground Codex child env로 전달
- [ ] `tl local open`이 `local_attachment_id` 의존 없이 endpoint/session 기반 direct resume을 사용하도록 변경
- [ ] 필요 시 local status 출력/타입에서 attachment를 선택적 메타데이터로만 취급

### Task 3: 회귀 정리 및 문서 반영

**Files:**
- Modify: `src/local-console-runtime.ts`
- Modify: `README.md`
- Modify: `CODEX_SETUP.md`
- Modify: `PROMPTS.md`
- Test: `tests/local-console-runtime.test.ts`

- [ ] `tl open` 경로에서 더 이상 쓰지 않는 `screen` 기반 코드/테스트 기대값 정리
- [ ] 문서에서 `tl open`이 foreground terminal을 유지한다고 명시
- [ ] `cmux` 문맥은 현재 터미널 env를 그대로 상속받는다고 정리

### Task 4: 검증

**Files:**
- Test: `tests/interactive-codex-launcher.test.ts`
- Test: `tests/local-console-runtime.test.ts`
- Test: `tests/e2e-cli-daemon.test.ts`

- [ ] `npx vitest run tests/interactive-codex-launcher.test.ts tests/local-console-runtime.test.ts tests/e2e-cli-daemon.test.ts`
- [ ] `npx vitest run`
- [ ] 실제 `tl open` 스모크로 현재 터미널에서 스크롤/alt-screen/cmux 동작 확인

