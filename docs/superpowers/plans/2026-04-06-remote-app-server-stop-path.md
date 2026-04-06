# TL Remote App-Server Stop Path PoC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 기존 local stop hook wait 경로를 유지하면서, remote-attached 세션에 한해 app-server thread injection으로 같은 live session을 이어가는 PoC를 만든다.

**Architecture:** `SessionRecord`에 remote metadata를 저장하고, `RemoteStopController`가 stop/reply 경로를 remote 또는 local로 분기한다. remote path는 `AppServerClient`로 `turn/start`/`turn/steer`를 시도하고, 실패하면 현재 late-reply resume fallback으로 내려간다.

**Tech Stack:** TypeScript, Hono, Vitest, WebSocket client, existing TL daemon/CLI

---

### Task 1: Remote metadata와 CLI surface 추가

**Files:**
- Create: `src/remote-mode.ts`
- Modify: `src/types.ts`
- Modify: `src/store.ts`
- Modify: `src/cli.ts`
- Test: `tests/remote-mode.test.ts`

- [ ] **Step 1: Remote metadata failing tests 추가**

```ts
it('persists remote attachment metadata on a session record', async () => {
  const store = new SessionsStore();
  store.create('s1', makeRecord());
  store.update('s1', (record) => {
    record.remote_mode_enabled = true;
    record.remote_endpoint = 'ws://127.0.0.1:4321';
    record.remote_thread_id = 'thread-1';
  });

  await store.save();
  await store.load();

  expect(store.get('s1')?.record.remote_mode_enabled).toBe(true);
  expect(store.get('s1')?.record.remote_thread_id).toBe('thread-1');
});
```

- [ ] **Step 2: 테스트를 실행해 실패 확인**

Run: `npm test -- tests/remote-mode.test.ts`
Expected: FAIL because remote metadata fields and helpers do not exist

- [ ] **Step 3: remote metadata 타입과 helper 추가**

```ts
export interface RemoteSessionAttachment {
  enabled: boolean;
  endpoint: string | null;
  threadId: string | null;
  lastTurnId: string | null;
}

export function attachRemoteSession(
  record: SessionRecord,
  attachment: RemoteSessionAttachment
): void {
  record.remote_mode_enabled = attachment.enabled;
  record.remote_endpoint = attachment.endpoint;
  record.remote_thread_id = attachment.threadId;
  record.remote_last_turn_id = attachment.lastTurnId;
}
```

- [ ] **Step 4: `tl remote attach|detach|status` CLI surface 추가**

```ts
case 'remote':
  return cmdRemote(args);
```

```ts
async function cmdRemote(args: string[]) {
  const sub = args[0];
  if (sub === 'attach') return cmdRemoteAttach(args.slice(1));
  if (sub === 'detach') return cmdRemoteDetach(args.slice(1));
  if (sub === 'status') return cmdRemoteStatus(args.slice(1));
  process.stderr.write('Usage: tl remote <attach|detach|status> ...\\n');
  process.exit(1);
}
```

- [ ] **Step 5: 테스트 재실행**

Run: `npm test -- tests/remote-mode.test.ts`
Expected: PASS

- [ ] **Step 6: 커밋**

```bash
git add src/types.ts src/store.ts src/cli.ts src/remote-mode.ts tests/remote-mode.test.ts
git commit -m "feat: add remote session attachment metadata"
```

### Task 2: AppServerClient와 remote stop controller 추가

**Files:**
- Create: `src/app-server-client.ts`
- Create: `src/remote-stop-controller.ts`
- Modify: `src/session-manager.ts`
- Modify: `src/daemon.ts`
- Test: `tests/app-server-client.test.ts`
- Test: `tests/remote-stop-controller.test.ts`

- [ ] **Step 1: app-server payload contract failing tests 추가**

```ts
it('sends turn/start for idle remote threads', async () => {
  const transport = new FakeAppServerTransport();
  const client = new AppServerClient(transport);

  await client.startTurn({
    endpoint: 'ws://127.0.0.1:4321',
    threadId: 'thread-1',
    input: 'reply from telegram',
  });

  expect(transport.requests).toContainEqual({
    method: 'turn/start',
    params: { threadId: 'thread-1', input: 'reply from telegram' },
  });
});
```

```ts
it('sends turn/steer when active turn id is known', async () => {
  const transport = new FakeAppServerTransport();
  const client = new AppServerClient(transport);

  await client.steerTurn({
    endpoint: 'ws://127.0.0.1:4321',
    threadId: 'thread-1',
    expectedTurnId: 'turn-7',
    input: 'interrupt with new instruction',
  });

  expect(transport.requests).toContainEqual({
    method: 'turn/steer',
    params: {
      threadId: 'thread-1',
      expectedTurnId: 'turn-7',
      input: 'interrupt with new instruction',
    },
  });
});
```

- [ ] **Step 2: remote stop controller failing tests 추가**

```ts
it('injects into app-server instead of using reply queue for remote-attached sessions', async () => {
  const controller = makeRemoteController({ remoteThreadId: 'thread-1' });

  const output = await controller.handleReply('s1', 'continue here');

  expect(output).toEqual({ delivered: 'remote' });
  expect(controller.client.startTurn).toHaveBeenCalled();
  expect(controller.fallback.handle).not.toHaveBeenCalled();
});
```

- [ ] **Step 3: 테스트를 실행해 실패 확인**

Run: `npm test -- tests/app-server-client.test.ts tests/remote-stop-controller.test.ts`
Expected: FAIL because client/controller implementations do not exist

- [ ] **Step 4: 최소 구현 추가**

```ts
export class AppServerClient {
  constructor(private transport = new WebSocketAppServerTransport()) {}

  async startTurn(args: { endpoint: string; threadId: string; input: string }) {
    return this.transport.request(args.endpoint, 'turn/start', {
      threadId: args.threadId,
      input: args.input,
    });
  }

  async steerTurn(args: {
    endpoint: string;
    threadId: string;
    expectedTurnId: string;
    input: string;
  }) {
    return this.transport.request(args.endpoint, 'turn/steer', {
      threadId: args.threadId,
      expectedTurnId: args.expectedTurnId,
      input: args.input,
    });
  }
}
```

```ts
export class RemoteStopController {
  async handleReply(sessionId: string, reply: string) {
    const session = this.store.get(sessionId);
    if (!session?.record.remote_mode_enabled || !session.record.remote_thread_id) {
      return { delivered: 'local' as const };
    }

    try {
      await this.client.startTurn({
        endpoint: session.record.remote_endpoint!,
        threadId: session.record.remote_thread_id,
        input: reply,
      });
      return { delivered: 'remote' as const };
    } catch {
      await this.fallback.handle(sessionId, reply);
      return { delivered: 'fallback' as const };
    }
  }
}
```

- [ ] **Step 5: daemon/session-manager 분기 추가**

```ts
const remoteResult = await remoteStopController.tryHandleStopReply(sessionId, replyText);
if (remoteResult?.delivered === 'remote') {
  return { decision: 'block', reason: replyText, resume_ack_queued: true };
}
```

- [ ] **Step 6: 테스트 재실행**

Run: `npm test -- tests/app-server-client.test.ts tests/remote-stop-controller.test.ts`
Expected: PASS

- [ ] **Step 7: 커밋**

```bash
git add src/app-server-client.ts src/remote-stop-controller.ts src/session-manager.ts src/daemon.ts tests/app-server-client.test.ts tests/remote-stop-controller.test.ts
git commit -m "feat: add remote app-server stop controller"
```

### Task 3: Telegram reply / late-reply 경로를 remote-aware로 연결

**Files:**
- Modify: `src/telegram.ts`
- Modify: `src/late-reply-resumer.ts`
- Modify: `src/session-manager.ts`
- Test: `tests/telegram.test.ts`
- Test: `tests/late-reply-resumer.test.ts`

- [ ] **Step 1: remote-attached completed session reply failing tests 추가**

```ts
it('routes completed topic messages to remote stop controller before late-reply resume', async () => {
  const remoteController = { handleReply: vi.fn().mockResolvedValue({ delivered: 'remote' }) };
  const bot = makeTelegramBot({ remoteController });

  await bot.handleTestMessage({
    chat: { id: -1001234567890 },
    message_id: 88,
    message_thread_id: 42,
    text: 'continue remotely',
  });

  expect(remoteController.handleReply).toHaveBeenCalledWith('s1', 'continue remotely');
  expect(lateReplyHandler).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -- tests/telegram.test.ts tests/late-reply-resumer.test.ts`
Expected: FAIL because Telegram path is not remote-aware

- [ ] **Step 3: reply routing 우선순위 수정**

```ts
if (matched.record.remote_mode_enabled) {
  const result = await this.remoteStopController.handleReply(matched.id, message.text ?? '');
  if (result.delivered === 'remote') {
    return;
  }
}

await this.lateReplyHandler(matched.id, message.text ?? '');
```

- [ ] **Step 4: fallback 경로 유지**

```ts
if (remoteResult.delivered === 'fallback') {
  await this.sendLateReplyResumeStartedMessage(chatId, topicId);
}
```

- [ ] **Step 5: 테스트 재실행**

Run: `npm test -- tests/telegram.test.ts tests/late-reply-resumer.test.ts`
Expected: PASS

- [ ] **Step 6: 커밋**

```bash
git add src/telegram.ts src/late-reply-resumer.ts src/session-manager.ts tests/telegram.test.ts tests/late-reply-resumer.test.ts
git commit -m "feat: route remote replies through app-server path"
```

### Task 4: PoC E2E와 smoke 검증 추가

**Files:**
- Create: `tests/app-server-poc.e2e.test.ts`
- Create: `tests/helpers/fake-app-server.ts`
- Modify: `tests/helpers/e2e-harness.ts`
- Modify: `package.json`

- [ ] **Step 1: fake app-server E2E failing test 추가**

```ts
it('keeps the same remote thread when a stop reply arrives after the hook path detached', async () => {
  const fakeServer = await startFakeAppServer();
  const harness = await TlE2EHarness.createRemote({ endpoint: fakeServer.endpoint });

  await harness.attachRemoteSession('s1', 'thread-1');
  await harness.runStop('s1');
  await harness.simulateDetachedStopHook('s1');
  await harness.sendTelegramReply('s1', 'continue in same thread');

  expect(fakeServer.requests).toContainEqual({
    method: 'turn/start',
    params: { threadId: 'thread-1', input: 'continue in same thread' },
  });
  expect(harness.spawnedResumeCommands()).toHaveLength(0);
});
```

- [ ] **Step 2: 테스트 실행으로 실패 확인**

Run: `npm test -- tests/app-server-poc.e2e.test.ts`
Expected: FAIL because remote harness and fake app-server are missing

- [ ] **Step 3: fake app-server와 harness 확장**

```ts
export function startFakeAppServer() {
  const requests: Array<{ method: string; params: unknown }> = [];
  return {
    endpoint,
    requests,
    onRequest(method: string, params: unknown) {
      requests.push({ method, params });
      return { ok: true };
    },
  };
}
```

- [ ] **Step 4: optional real smoke command 추가**

```json
"scripts": {
  "test:remote-poc": "vitest run tests/app-server-poc.e2e.test.ts"
}
```

- [ ] **Step 5: 전체 검증**

Run: `npm run build`
Expected: exit 0

Run: `npm test`
Expected: PASS with all existing tests + new PoC tests

Run: `npm run test:remote-poc`
Expected: PASS

- [ ] **Step 6: 커밋**

```bash
git add tests/app-server-poc.e2e.test.ts tests/helpers/fake-app-server.ts tests/helpers/e2e-harness.ts package.json
git commit -m "test: add remote app-server stop path poc coverage"
```

### Task 5: 문서와 PoC 운영 메모 정리

**Files:**
- Modify: `docs/superpowers/specs/2026-04-06-remote-app-server-stop-path-design.md`
- Modify: `CODEX_SETUP.md`
- Modify: `PROMPTS.md`

- [ ] **Step 1: PoC 한계와 사용법 문서화**

```md
## Remote stop path PoC

- Experimental only
- Requires `codex app-server --listen ws://127.0.0.1:<port>`
- Requires Codex TUI started with `--remote`
- Falls back to late-reply resume on failure
```

- [ ] **Step 2: 문서 링크 정리**

Run: `rg -n "remote stop path|app-server --listen|--remote" CODEX_SETUP.md PROMPTS.md docs/superpowers/specs/2026-04-06-remote-app-server-stop-path-design.md`
Expected: matches in all three files

- [ ] **Step 3: 커밋**

```bash
git add docs/superpowers/specs/2026-04-06-remote-app-server-stop-path-design.md CODEX_SETUP.md PROMPTS.md
git commit -m "docs: document remote app-server stop path poc"
```
