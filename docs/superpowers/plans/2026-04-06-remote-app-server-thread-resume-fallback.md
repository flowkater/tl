# TL Remote App-Server Thread Resume Fallback Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** remote-attached 세션의 reply 전달이 실패했을 때, app-server 재기동 후에도 복구되지 않으면 `thread/resume` 기반으로 같은 remote thread를 다시 살린 뒤 재주입을 시도한다.

**Architecture:** `AppServerClient`에 `thread/resume` 호출을 추가하고, `RemoteStopController`는 `inject -> restart -> inject -> thread/resume -> inject -> local fallback` 순서로 복구를 수행한다. 상태 저장소에는 remote resume 성공/실패 흔적을 남겨 이후 진단과 운영 검증이 가능하게 한다.

**Tech Stack:** TypeScript, Node, Vitest, Codex app-server WebSocket protocol

---

### Task 1: Failing Tests For Remote Resume Fallback

**Files:**
- Modify: `tests/app-server-client.test.ts`
- Modify: `tests/remote-stop-controller.test.ts`

- [ ] **Step 1: Add a failing client test for `thread/resume`**

```ts
it('sends thread/resume with the same thread id before reinjection', async () => {
  const connection = new FakeConnection();
  connection.request = async (method: string, params: unknown) => {
    connection.calls.push({ method, params });
    if (method === 'thread/resume') {
      return {
        thread: {
          id: 'thread-1',
          turns: [],
        },
      };
    }
    throw new Error(`Unexpected method: ${method}`);
  };

  const client = new AppServerClient(async () => connection);
  await client.resumeThread({
    endpoint: 'ws://127.0.0.1:4321',
    threadId: 'thread-1',
  });

  expect(connection.calls).toEqual([
    {
      method: 'thread/resume',
      params: {
        threadId: 'thread-1',
      },
    },
  ]);
});
```

- [ ] **Step 2: Run the focused client test to verify RED**

Run: `npm test -- tests/app-server-client.test.ts`
Expected: FAIL because `resumeThread` does not exist yet.

- [ ] **Step 3: Add a failing controller test for restart+resume+retry**

```ts
it('resumes the remote thread and retries injection before local fallback', async () => {
  client.injectReply
    .mockRejectedValueOnce(new Error('socket closed'))
    .mockRejectedValueOnce(new Error('thread missing'))
    .mockResolvedValueOnce({
      mode: 'start',
      turnId: 'turn-9',
    });
  client.resumeThread = vi.fn().mockResolvedValue({
    threadId: 'thread-1',
  });

  const controller = new RemoteStopController(store, client, fallback, runtime, {
    notifyDelivered,
    notifyFailed,
  });

  const result = await controller.handleReply('s1', 'recover remotely');

  expect(result).toEqual({
    handled: true,
    mode: 'remote',
    turnId: 'turn-9',
  });
  expect(runtime.ensureAvailable).toHaveBeenCalled();
  expect(client.resumeThread).toHaveBeenCalledWith({
    endpoint: 'ws://127.0.0.1:4321',
    threadId: 'thread-1',
    cwd: '/tmp/test',
  });
  expect(fallback.handle).not.toHaveBeenCalled();
});
```

- [ ] **Step 4: Run the focused controller test to verify RED**

Run: `npm test -- tests/remote-stop-controller.test.ts`
Expected: FAIL because the controller never calls `resumeThread`.

### Task 2: Minimal Remote Resume Implementation

**Files:**
- Modify: `src/app-server-client.ts`
- Modify: `src/remote-stop-controller.ts`
- Modify: `src/types.ts`
- Modify: `src/remote-mode.ts`
- Modify: `src/session-manager.ts`

- [ ] **Step 1: Add `resumeThread()` to `AppServerClient`**

```ts
async resumeThread(args: {
  endpoint: string;
  threadId: string;
  cwd?: string;
}): Promise<{ threadId: string }> {
  const connection = await this.connectionFactory(args.endpoint);
  try {
    const response = await connection.request('thread/resume', {
      threadId: args.threadId,
      cwd: args.cwd ?? null,
    });
    const threadId = response?.thread?.id ?? args.threadId;
    if (!threadId) {
      throw new Error('thread/resume response did not include thread.id');
    }
    return { threadId };
  } finally {
    await connection.close();
  }
}
```

- [ ] **Step 2: Extend remote session state for resume diagnostics**

```ts
remote_last_resume_at: string | null;
remote_last_resume_error: string | null;
```

- [ ] **Step 3: Update controller recovery order**

```ts
const restarted = await this.tryRestartAndRetry(...);
if (restarted) {
  return restarted;
}

const resumed = await this.tryResumeThreadAndRetry(...);
if (resumed) {
  return resumed;
}
```

- [ ] **Step 4: Persist resume success/error details**

```ts
record.remote_last_resume_at = new Date().toISOString();
record.remote_last_resume_error = null;
```

and on failure:

```ts
record.remote_last_resume_error = message;
```

- [ ] **Step 5: Run focused tests to verify GREEN**

Run: `npm test -- tests/app-server-client.test.ts tests/remote-stop-controller.test.ts`
Expected: PASS

### Task 3: Regression Coverage And Smoke Verification

**Files:**
- Modify: `tests/remote-stop-controller.test.ts`
- Modify: `tests/remote-mode.test.ts`
- Modify: `tests/session-manager.test.ts`

- [ ] **Step 1: Add regression assertions for new persisted fields**

```ts
expect(store._sessions.s1.remote_last_resume_at).not.toBeNull();
expect(store._sessions.s1.remote_last_resume_error).toBeNull();
```

- [ ] **Step 2: Add failure-path assertion when resume and fallback both fail**

```ts
expect(store._sessions.s1.remote_last_resume_error).toBe('resume failed');
expect(notifyFailed).toHaveBeenCalledWith('s1', 'socket closed');
```

- [ ] **Step 3: Run full test suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 4: Run build verification**

Run: `npm run build`
Expected: PASS

- [ ] **Step 5: Run local app-server smoke**

Run:

```bash
endpoint=ws://127.0.0.1:8792
codex app-server --listen "$endpoint" >/tmp/tl-app-server.log 2>&1 &
APP_SERVER_PID=$!
node --input-type=module - <<'EOF'
import { AppServerClient } from './dist/app-server-client.js';
const client = new AppServerClient();
const endpoint = 'ws://127.0.0.1:8792';
const { threadId } = await client.createThread({ endpoint, cwd: process.cwd() });
await client.resumeThread({ endpoint, threadId, cwd: process.cwd() });
const result = await client.injectReply({ endpoint, threadId, replyText: 'remote resume smoke' });
console.log(JSON.stringify({ threadId, result }));
EOF
kill "$APP_SERVER_PID"
wait "$APP_SERVER_PID" 2>/dev/null || true
```

Expected: JSON output with the same `threadId` and a valid `result.turnId`.
