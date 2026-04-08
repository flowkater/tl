# TL Telegram Prompt Mirroring And Typing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Codex 콘솔에서 입력한 root prompt를 Telegram topic에 그대로 보여주고, 작업 중에는 기존 텍스트 heartbeat와 함께 짧은 주기의 `typing` 상태를 유지한다.

**Architecture:** `hook-working -> daemon -> SessionManager.handleWorking()` 경로에 prompt 전달을 추가하고, Telegram 전송 책임은 `SessionManager`와 `TelegramBot`에 둔다. progress timer는 heartbeat와 typing으로 분리하되, cleanup은 settlement/completion 경로에서 함께 수행한다.

**Tech Stack:** TypeScript, Vitest, Hono daemon routes, Telegram Bot API

---

### Task 1: Lock The Behavior With Tests

**Files:**
- Modify: `tests/daemon.test.ts`
- Modify: `tests/session-manager.test.ts`
- Modify: `tests/telegram.test.ts`
- Modify: `tests/helpers/e2e-harness.ts`

- [ ] Step 1: `/hook/working`가 `prompt`를 `SessionManager.handleWorking()`로 넘기는 failing test를 추가한다.
- [ ] Step 2: `handleWorking()`가 local/root와 `local-managed` 세션에서 prompt 원문을 Telegram으로 보내고 typing timer를 시작하는 failing test를 추가한다.
- [ ] Step 3: `remote-managed` 세션에서는 prompt/working/typing이 모두 생략되는 failing test를 추가한다.
- [ ] Step 4: `sendTypingAction()` Telegram wrapper test를 추가한다.

### Task 2: Thread Prompt Through Working Hook

**Files:**
- Modify: `src/types.ts`
- Modify: `src/daemon.ts`
- Modify: `src/session-manager.ts`

- [ ] Step 1: `SessionManager.handleWorking()` 시그니처에 optional `prompt`를 추가한다.
- [ ] Step 2: daemon `/hook/working`가 JSON body의 `prompt`를 background task로 전달하게 바꾼다.
- [ ] Step 3: `SessionManager.handleWorking()`에서 trimmed prompt가 비어있지 않을 때 topic에 1회 전송한다.

### Task 3: Add Telegram Typing Actions

**Files:**
- Modify: `src/telegram.ts`
- Modify: `src/session-manager.ts`
- Modify: `src/types.ts`

- [ ] Step 1: `TelegramBot`에 `sendTypingAction(chatId, topicId)`를 추가한다.
- [ ] Step 2: `SessionManager`에 typing timer map, schedule, clear 로직을 추가한다.
- [ ] Step 3: working 시작 시 즉시 typing action을 보내고 4초 반복 timer를 등록한다.
- [ ] Step 4: settlement, completion, inactive-session cleanup에서 typing timer를 같이 해제한다.

### Task 4: Verify Targeted Paths

**Files:**
- Test: `tests/daemon.test.ts`
- Test: `tests/session-manager.test.ts`
- Test: `tests/telegram.test.ts`

- [ ] Step 1: `npx vitest run tests/daemon.test.ts tests/session-manager.test.ts tests/telegram.test.ts`를 실행한다.
- [ ] Step 2: 필요하면 `npm run build`로 타입/번들 회귀를 한 번 더 확인한다.
