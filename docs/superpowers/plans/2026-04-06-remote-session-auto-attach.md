# TL Remote Session Auto-Attach Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `codex --remote`로 시작한 세션에서 `TL_REMOTE_ENDPOINT`만 알면 SessionStart 시점에 TL이 자동으로 같은 remote thread를 attach하도록 만든다.

**Architecture:** remote TUI 실험에서 `session_id == thread_id`가 확인됐으므로, SessionStart 훅이 `TL_REMOTE_ENDPOINT`를 daemon으로 전달하면 daemon은 `session_id`를 곧바로 `remote_thread_id`로 저장할 수 있다. 이 경로는 opt-in env 기반이며 기존 local mode를 깨지 않는다.

**Tech Stack:** TypeScript, Node, Vitest

---

### Task 1: Auto-Attach Failing Tests

**Files:**
- Modify: `tests/session-manager.test.ts`
- Modify: `tests/daemon.test.ts`
- Modify: `tests/e2e-cli-daemon.test.ts`

- [ ] SessionStart payload에 `remote_endpoint`가 들어오면 새 세션이 `remote_mode_enabled=true`, `remote_thread_id=session_id`로 생성되는 failing test 추가
- [ ] `tl hook-session-start` 경로가 `TL_REMOTE_ENDPOINT` env를 읽어 daemon POST body에 넣는 failing test 추가
- [ ] focused test를 먼저 돌려 RED 확인

### Task 2: Minimal Auto-Attach Implementation

**Files:**
- Modify: `src/types.ts`
- Modify: `src/cli.ts`
- Modify: `src/hooks/session-start.ts`
- Modify: `src/daemon.ts`
- Modify: `src/session-manager.ts`

- [ ] SessionStart hook POST body에 optional `remote_endpoint` 추가
- [ ] `cmdHookSessionStart`와 standalone `src/hooks/session-start.ts`가 `process.env.TL_REMOTE_ENDPOINT`를 읽어 body에 포함
- [ ] daemon/session-manager가 `remote_endpoint`가 있으면 `session_id`를 `remote_thread_id`로 자동 저장
- [ ] focused test를 다시 돌려 GREEN 확인

### Task 3: Real Remote Smoke + Docs

**Files:**
- Modify: `CODEX_SETUP.md`

- [ ] `codex app-server --listen ...` + `TL_REMOTE_ENDPOINT=... codex --remote ...` smoke를 돌려 auto-attach 상태 확인
- [ ] `CODEX_SETUP.md`에 remote auto-attach 사용법 추가
- [ ] 전체 `npm test`, `npm run build`로 마무리
