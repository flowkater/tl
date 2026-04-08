# TL Local-Managed First-Message Bootstrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `tl open`과 `tl local start`가 fresh local-managed 세션에서도 같은 Codex thread에 안정적으로 attach되고, 즉시 Telegram topic/session을 생성하도록 고친다.

**Architecture:** blank `codex --remote`를 먼저 띄우고 나중에 thread를 채택하는 흐름을 제거한다. 대신 app-server `thread/start`로 thread를 만들고, 첫 사용자 입력으로 `turn/start`를 발생시켜 thread/session 파일을 materialize한 뒤 `codex resume --remote <thread>`로 attach한다.

**Tech Stack:** TypeScript, Vitest, Codex app-server WebSocket RPC, Telegram bot bridge

---

### Task 1: Bootstrap Contract Red Tests

**Files:**
- Modify: `tests/daemon.test.ts`
- Modify: `tests/e2e-cli-daemon.test.ts`
- Modify: `tests/local-console-runtime.test.ts`

- [ ] local `/local/start`가 `initial_text` 없는 blank bootstrap을 더 이상 허용하지 않는 테스트 추가
- [ ] local `/local/start`가 `thread/start -> turn/start -> thread loaded wait -> resume attach` 순서를 쓰는 테스트 추가
- [ ] `tl open`이 text 미지정 시 bootstrap prompt를 요구하거나 입력을 받아 daemon으로 넘기는 테스트 추가

### Task 2: App-Server Bootstrap Materialization

**Files:**
- Modify: `src/app-server-client.ts`
- Modify: `src/daemon.ts`

- [ ] `thread/start` 결과에서 thread 메타데이터를 충분히 보존하도록 client 확장
- [ ] `thread/loaded/list` 기반으로 특정 thread가 resume 가능한 상태가 될 때까지 기다리는 helper 추가
- [ ] `/local/start`에서 delayed adoption watcher를 제거하고, first-message bootstrap을 필수로 적용

### Task 3: Local Attach Flow

**Files:**
- Modify: `src/local-console-runtime.ts`
- Modify: `src/cli.ts`

- [ ] fresh local attach는 항상 `codex resume --remote <thread>`로만 붙도록 정리
- [ ] `tl open` 기본 경로에서 bootstrap text를 수집해 `/local/start`에 전달
- [ ] `tl local start`도 동일 bootstrap contract를 따르도록 CLI 에러/사용법 정리

### Task 4: Verification And Cleanup

**Files:**
- Modify: `README.md` (if behavior text changed)

- [ ] 관련 Vitest 세트 실행
- [ ] `npm run build` 실행
- [ ] 실험용 screen/session/topic 잔여물 정리
- [ ] 필요하면 문서 문구를 새 bootstrap 동작에 맞게 갱신
