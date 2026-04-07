# TL Remote Mode Telegram-First Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remote mode를 daemon-owned Telegram-first runtime으로 바꿔서, TL이 remote session을 직접 시작하고 same-thread turn 완료 결과를 Telegram에 직접 게시하도록 만든다.

**Architecture:** 기존 local hook mode는 유지한다. remote mode에서는 TL daemon이 app-server lifecycle, remote thread/session bootstrap, turn settlement 관찰, Telegram stop 메시지 게시를 맡고, Codex TUI는 optional attached client로만 취급한다.

**Tech Stack:** TypeScript, Hono, grammY, Codex app-server WebSocket API, Vitest

---

### Task 1: Remote Runtime Bootstrap Surface

**Files:**
- Modify: `src/app-server-client.ts`
- Modify: `src/daemon.ts`
- Modify: `src/cli.ts`
- Modify: `src/types.ts`
- Test: `tests/app-server-client.test.ts`
- Test: `tests/daemon.test.ts`

- [ ] Add app-server client helpers for daemon-owned thread bootstrap and turn result reading.
- [ ] Add daemon endpoints for starting a remote-managed session and opening a remote-attached TUI client.
- [ ] Add CLI commands for `tl remote start ...` and `tl remote open ...`.

### Task 2: Remote Turn Observer And Telegram Publishing

**Files:**
- Modify: `src/remote-stop-controller.ts`
- Modify: `src/session-manager.ts`
- Modify: `src/telegram.ts`
- Modify: `src/assistant-turn-output.ts`
- Test: `tests/remote-stop-controller.test.ts`
- Test: `tests/session-manager.test.ts`
- Test: `tests/telegram.test.ts`

- [ ] Change remote delivery flow to observe turn settlement and extract assistant output from app-server thread data.
- [ ] Publish stop-style Telegram messages from daemon-owned remote turns without relying on TUI Stop hook output.
- [ ] Suppress duplicate remote Stop/Working hook side effects when TUI is only an attached client.

### Task 3: Remote Session State Model Hardening

**Files:**
- Modify: `src/remote-mode.ts`
- Modify: `src/store.ts`
- Modify: `src/session-manager.ts`
- Modify: `src/daemon.ts`
- Test: `tests/remote-mode.test.ts`
- Test: `tests/store.test.ts`

- [ ] Canonicalize daemon-owned remote session state (`running`, `idle`, `recovering`, `degraded`) around remote thread lifecycle instead of local waiting semantics.
- [ ] Ensure remote-created sessions use `threadId` as canonical `session_id` so attached TUI resumes the same thread.
- [ ] Persist remote stop message ids and latest output so topic-thread messaging remains coherent.

### Task 4: Verification And Real Smoke

**Files:**
- Modify: `CODEX_SETUP.md`
- Test: `tests/e2e-cli-daemon.test.ts`

- [ ] Add focused tests for remote bootstrap, remote turn completion publishing, and TUI hook suppression.
- [ ] Run `npm run build` and `npm test`.
- [ ] Run a real smoke with `tl remote start`, `tl remote open`, same-thread Telegram-first delivery, and environment rollback.
