# Local-Managed Heartbeat Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `local-managed` 세션이 turn 완료 후 stale heartbeat 때문에 `idle -> running`으로 되돌아가는 현상을 막는다.

**Architecture:** turn settlement cleanup을 `SessionManager`의 단일 경로로 모으고, `LocalManagedOpenController`는 polling 결과를 그 경로에 위임한다. 이렇게 하면 heartbeat timer, progress timestamps, remote status 전이를 같은 규칙으로 정리할 수 있다.

**Tech Stack:** TypeScript, Vitest, TL daemon/session lifecycle

---

### Task 1: Reproduce With Tests

**Files:**
- Modify: `tests/local-managed-open-controller.test.ts`
- Modify: `tests/session-manager.test.ts`

- [ ] Step 1: local-managed turn settlement가 progress/heartbeat state를 비워야 한다는 failing test를 추가한다.
- [ ] Step 2: 해당 테스트만 실행해 현재 구현이 stale state를 남기는지 확인한다.

### Task 2: Route Settlement Through SessionManager

**Files:**
- Modify: `src/types.ts`
- Modify: `src/session-manager.ts`
- Modify: `src/local-managed-open-controller.ts`

- [ ] Step 1: `SessionManager`에 managed turn settlement cleanup 메서드를 추가한다.
- [ ] Step 2: `LocalManagedOpenController`가 direct mutation 대신 해당 메서드를 호출하도록 바꾼다.
- [ ] Step 3: stop message id 기록은 기존 controller 책임으로 유지한다.

### Task 3: Verify

**Files:**
- Test: `tests/local-managed-open-controller.test.ts`
- Test: `tests/session-manager.test.ts`

- [ ] Step 1: targeted tests를 실행한다.
- [ ] Step 2: 실패가 없으면 bugfix가 idle 이후 재-running으로 되돌아가는 경로를 막는지 확인한다.
