# TL Telegram ACK / Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** TL이 Telegram reply 수신과 Codex 전달 성공을 구분해 표시하고, 재개 후 working/heartbeat 메시지를 root 세션 기준으로 append 전송하도록 만든다.

**Architecture:** `tl hook-stop-and-wait` 성공 경로에서만 daemon으로 resume ACK를 후속 전송한다. `UserPromptSubmit`는 별도 TL hook command로 daemon에 전달하고, session manager가 working 메시지와 throttle된 heartbeat를 관리한다.

**Tech Stack:** Node.js, TypeScript, Hono, grammY, vitest, local Codex hook router

---

### Task 1: 테스트로 ACK / Progress 요구사항 고정

**Files:**
- Modify: `/Users/flowkater/Projects/TL/tests/session-manager.test.ts`
- Modify: `/Users/flowkater/Projects/TL/tests/telegram.test.ts`

- [ ] **Step 1: Session manager의 새 Telegram 메서드 expectation을 추가한다**

```ts
sendResumeAckMessage: vi.fn().mockResolvedValue(undefined),
sendWorkingMessage: vi.fn().mockResolvedValue(undefined),
sendHeartbeatMessage: vi.fn().mockResolvedValue(undefined),
```

- [ ] **Step 2: resume ACK 테스트를 먼저 추가한다**

```ts
it('sends resume ACK only when explicitly acknowledged after stop reply delivery', async () => {
  store._sessions['s1'] = makeRecord({ status: 'active', topic_id: 42 });

  await manager.handleResumeAcknowledged({ session_id: 's1' });

  expect(tg.sendResumeAckMessage).toHaveBeenCalledWith(defaultConfig.groupId, 42);
  expect(store._sessions['s1'].last_resume_ack_at).not.toBeNull();
});
```

- [ ] **Step 3: working / heartbeat 테스트를 먼저 추가한다**

```ts
it('sends a working message on user prompt submit for an active root session', async () => {
  store._sessions['s1'] = makeRecord({ status: 'active', topic_id: 42 });

  await manager.handleWorking({ session_id: 's1' });

  expect(tg.sendWorkingMessage).toHaveBeenCalledWith(defaultConfig.groupId, 42);
});
```

```ts
it('sends throttled heartbeat messages after working starts', async () => {
  vi.useFakeTimers();
  store._sessions['s1'] = makeRecord({ status: 'active', topic_id: 42 });

  await manager.handleWorking({ session_id: 's1' });
  await vi.advanceTimersByTimeAsync(2 * 60 * 1000);

  expect(tg.sendHeartbeatMessage).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 4: TelegramBot 메서드 테스트를 먼저 추가한다**

```ts
it('sends resume ACK through Telegram HTML mode', async () => {
  const sendMessage = vi.fn().mockResolvedValue({ message_id: 123 });
  const bot = new TelegramBot(config, { listActive: () => [] } as any, {
    deliver: () => false,
  } as any);

  (bot as any).bot = { api: { sendMessage } };

  await bot.sendResumeAckMessage(config.groupId, 42);

  expect(sendMessage).toHaveBeenCalledWith(
    config.groupId,
    '✅ reply delivered to Codex, resuming...',
    { message_thread_id: 42 }
  );
});
```

- [ ] **Step 5: 테스트를 실행해 실패를 확인한다**

Run: `cd /Users/flowkater/Projects/TL && npm test -- --run tests/session-manager.test.ts tests/telegram.test.ts`
Expected: `handleResumeAcknowledged` / `handleWorking` / 새 Telegram 메서드가 없어 FAIL

### Task 2: TL ACK 경로 구현

**Files:**
- Modify: `/Users/flowkater/Projects/TL/src/types.ts`
- Modify: `/Users/flowkater/Projects/TL/src/session-manager.ts`
- Modify: `/Users/flowkater/Projects/TL/src/daemon.ts`
- Modify: `/Users/flowkater/Projects/TL/src/cli.ts`
- Modify: `/Users/flowkater/Projects/TL/src/hooks/stop-and-wait.ts`
- Modify: `/Users/flowkater/Projects/TL/src/telegram.ts`

- [ ] **Step 1: 세션 메타데이터 필드를 추가한다**

```ts
last_progress_at: string | null;
last_heartbeat_at: string | null;
last_resume_ack_at: string | null;
```

- [ ] **Step 2: TelegramBot에 resume ACK / working / heartbeat 전송 메서드를 추가한다**

```ts
async sendResumeAckMessage(chatId: number, topicId: number): Promise<number> { ... }
async sendWorkingMessage(chatId: number, topicId: number): Promise<number> { ... }
async sendHeartbeatMessage(chatId: number, topicId: number): Promise<number> { ... }
```

- [ ] **Step 3: SessionManager에 resume ACK 처리 메서드를 추가한다**

```ts
async handleResumeAcknowledged(args: { session_id: string }): Promise<void> { ... }
```

- [ ] **Step 4: daemon에 resume ACK endpoint를 추가한다**

```ts
app.post('/hook/resume-ack', async (c) => { ... })
```

- [ ] **Step 5: stop hook 성공 경로에서만 후속 ACK를 전송한다**

```ts
const serialized = serializeStopHookOutput(data);
if (serialized) {
  await writeStdout(serialized + '\n');
  await postResumeAck(sessionId, port);
}
```

- [ ] **Step 6: 관련 테스트를 재실행한다**

Run: `cd /Users/flowkater/Projects/TL && npm test -- --run tests/session-manager.test.ts tests/telegram.test.ts`
Expected: ACK 관련 테스트 PASS, 아직 working/heartbeat 일부는 FAIL 가능

### Task 3: working / heartbeat 구현

**Files:**
- Modify: `/Users/flowkater/Projects/TL/src/types.ts`
- Modify: `/Users/flowkater/Projects/TL/src/session-manager.ts`
- Modify: `/Users/flowkater/Projects/TL/src/daemon.ts`
- Modify: `/Users/flowkater/Projects/TL/src/cli.ts`

- [ ] **Step 1: SessionManager에 working 처리 메서드와 heartbeat timer 관리 구조를 추가한다**

```ts
private heartbeatTimers = new Map<string, { initial?: NodeJS.Timeout; repeat?: NodeJS.Timeout }>();

async handleWorking(args: { session_id: string }): Promise<void> { ... }
private scheduleHeartbeat(sessionId: string): void { ... }
private clearHeartbeat(sessionId: string): void { ... }
```

- [ ] **Step 2: `handleSessionStart`, `handleStopAndWait`, `handleComplete`에서 timer 상태를 정리한다**

```ts
this.clearHeartbeat(session_id);
record.last_progress_at = null;
record.last_heartbeat_at = null;
```

- [ ] **Step 3: daemon에 working endpoint를 추가한다**

```ts
app.post('/hook/working', async (c) => { ... })
```

- [ ] **Step 4: CLI에 `hook-working` command를 추가한다**

```ts
case 'hook-working':
  return cmdHookWorking();
```

```ts
async function cmdHookWorking() {
  // progress 실패는 Codex 흐름을 깨지 않으므로 warning 후 exit 0
}
```

- [ ] **Step 5: UserPromptSubmit을 TL working hook로 연결한다**

```python
if event_name == "UserPromptSubmit":
    if not is_subagent:
        run_command([TL_BIN, "hook-working"], payload)
    result = run_command([CMUX_HOOK], payload)
    return result.returncode
```

- [ ] **Step 6: 관련 테스트를 다시 실행한다**

Run: `cd /Users/flowkater/Projects/TL && npm test -- --run tests/session-manager.test.ts tests/telegram.test.ts`
Expected: working/heartbeat 테스트 PASS

### Task 4: 전체 검증 및 문서 반영

**Files:**
- Modify: `/Users/flowkater/.codex/hooks/codex-hook-router.py`
- Modify: `/Users/flowkater/.codex/hooks/test_codex_hook_router.py`
- Modify: `/Users/flowkater/Projects/TL/README.md`
- Modify: `/Users/flowkater/Projects/TL/CODEX_SETUP.md`

- [ ] **Step 1: router 테스트를 보강한다**

```python
def test_user_prompt_submit_runs_tl_working_for_root(...): ...
def test_user_prompt_submit_skips_tl_working_for_subagent(...): ...
```

- [ ] **Step 2: TL 문서에 새 ACK / progress 동작을 추가한다**

```md
- reply reaction은 TL 수신만 뜻함
- `✅ reply delivered to Codex, resuming...`는 stop hook 성공 경로에서만 전송됨
- `🛠️ resumed, working...`와 `⏳ still working...`는 root 세션에만 전송됨
```

- [ ] **Step 3: 전체 테스트와 라우터 검증을 실행한다**

Run: `cd /Users/flowkater/Projects/TL && npm run build && npm test`
Expected: 전체 vitest PASS

Run: `python3 /Users/flowkater/.codex/hooks/test_codex_hook_router.py`
Expected: `OK`

- [ ] **Step 4: 실전 smoke test를 수행한다**

Run: root 세션에서 실제 Stop reply 후 아래 순서를 확인
- reaction
- `✅ reply delivered to Codex, resuming...`
- `🛠️ resumed, working...`

- [ ] **Step 5: 변경 사항을 요약하고 남은 리스크를 기록한다**

```md
- ACK는 Codex 내부 소비 완료가 아니라 hook 경계 전달 성공 기준
- heartbeat는 timer 기반이라 daemon 재시작 시 현재 턴의 주기성이 일부 초기화될 수 있음
```
