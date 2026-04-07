# TL Local Mode Live Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Local mode를 `stop-and-wait` 중심 흐름에서 분리해, 같은 로컬 Codex 세션에 대해 콘솔 입력과 Telegram 입력을 자유롭게 왕복 가능한 live bridge runtime으로 바꾼다.

**Architecture:** Stop hook은 local mode에서 더 이상 long-poll consumer가 아니라 turn 완료 notifier가 된다. 새 `LocalSessionBridge`가 세션별 FIFO 입력 큐와 attachment registry를 관리하고, Telegram 입력을 live local session transport로 즉시 주입한다. transport 실패 시에만 기존 late-reply / `tl resume` fallback을 사용한다.

**Tech Stack:** TypeScript, Hono, grammY, Codex app-server client abstraction, Vitest

---

### Task 1: Local Bridge State Model And FIFO Queue

**Files:**
- Create: `src/local-session-bridge.ts`
- Modify: `src/types.ts`
- Modify: `src/store.ts`
- Test: `tests/local-session-bridge.test.ts`
- Test: `tests/store.test.ts`

- [ ] **Step 1: Write the failing bridge queue tests**

```ts
import { describe, expect, it, vi } from 'vitest';
import { LocalSessionBridge } from '../src/local-session-bridge.js';

describe('LocalSessionBridge', () => {
  it('delivers telegram inputs in FIFO order for the same session', async () => {
    const transport = {
      inject: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined),
    };
    const bridge = new LocalSessionBridge(transport as any);

    bridge.attach('s1', { attachmentId: 'a1' });
    await bridge.enqueue('s1', 'telegram', 'first');
    await bridge.enqueue('s1', 'console', 'second');

    expect(transport.inject.mock.calls).toEqual([
      ['s1', { attachmentId: 'a1' }, 'telegram', 'first'],
      ['s1', { attachmentId: 'a1' }, 'console', 'second'],
    ]);
    expect(bridge.getQueueDepth('s1')).toBe(0);
  });

  it('marks the session detached when injection fails', async () => {
    const transport = {
      inject: vi.fn().mockRejectedValue(new Error('broken pipe')),
    };
    const bridge = new LocalSessionBridge(transport as any);

    bridge.attach('s1', { attachmentId: 'a1' });
    await bridge.enqueue('s1', 'telegram', 'resume work');

    expect(bridge.getAttachmentState('s1')).toBe('detached');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/local-session-bridge.test.ts`
Expected: FAIL with `Cannot find module '../src/local-session-bridge.js'`

- [ ] **Step 3: Add the local bridge types**

```ts
export type LocalBridgeState = 'attached' | 'detached' | 'recovering';
export type LocalInputSource = 'console' | 'telegram';

export interface LocalAttachmentRecord {
  local_bridge_enabled: boolean;
  local_bridge_state: LocalBridgeState | null;
  local_input_queue_depth: number;
  local_last_input_source: LocalInputSource | null;
  local_last_input_at: string | null;
  local_last_injection_error: string | null;
  local_attachment_id: string | null;
}
```

- [ ] **Step 4: Implement the minimal bridge queue**

```ts
type BridgeTransport = {
  inject(
    sessionId: string,
    attachment: { attachmentId: string },
    source: LocalInputSource,
    text: string
  ): Promise<void>;
};

export class LocalSessionBridge {
  private attachments = new Map<string, { attachmentId: string }>();
  private queues = new Map<string, Array<{ source: LocalInputSource; text: string }>>();
  private draining = new Set<string>();
  private states = new Map<string, LocalBridgeState>();

  constructor(private transport: BridgeTransport) {}

  attach(sessionId: string, attachment: { attachmentId: string }): void {
    this.attachments.set(sessionId, attachment);
    this.states.set(sessionId, 'attached');
  }

  async enqueue(sessionId: string, source: LocalInputSource, text: string): Promise<void> {
    const queue = this.queues.get(sessionId) ?? [];
    queue.push({ source, text });
    this.queues.set(sessionId, queue);
    await this.drain(sessionId);
  }
}
```

- [ ] **Step 5: Persist the new local bridge fields in store defaults**

```ts
local_bridge_enabled: false,
local_bridge_state: null,
local_input_queue_depth: 0,
local_last_input_source: null,
local_last_input_at: null,
local_last_injection_error: null,
local_attachment_id: null,
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/local-session-bridge.test.ts tests/store.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/local-session-bridge.ts src/types.ts src/store.ts tests/local-session-bridge.test.ts tests/store.test.ts
git commit -m "feat: add local live bridge state model"
```

### Task 2: Local Attachment Transport Abstraction

**Files:**
- Create: `src/local-input-transport.ts`
- Modify: `src/app-server-client.ts`
- Modify: `src/remote-mode.ts`
- Test: `tests/app-server-client.test.ts`
- Test: `tests/local-input-transport.test.ts`

- [ ] **Step 1: Write the failing transport tests**

```ts
import { describe, expect, it, vi } from 'vitest';
import { AppServerLocalInputTransport } from '../src/local-input-transport.js';

describe('AppServerLocalInputTransport', () => {
  it('injects text into an attached local session through app-server', async () => {
    const client = {
      injectReply: vi.fn().mockResolvedValue({ mode: 'start', turnId: 'turn-1' }),
    };
    const transport = new AppServerLocalInputTransport(client as any);

    await transport.inject(
      's1',
      { attachmentId: 'thread-1', endpoint: 'ws://127.0.0.1:8899' },
      'telegram',
      'continue from telegram'
    );

    expect(client.injectReply).toHaveBeenCalledWith({
      endpoint: 'ws://127.0.0.1:8899',
      threadId: 'thread-1',
      replyText: 'continue from telegram',
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/local-input-transport.test.ts`
Expected: FAIL with `Cannot find module '../src/local-input-transport.js'`

- [ ] **Step 3: Add a transport abstraction instead of binding Telegram directly to ReplyQueue**

```ts
export interface LocalInputTransport {
  inject(
    sessionId: string,
    attachment: { attachmentId: string; endpoint: string },
    source: 'console' | 'telegram',
    text: string
  ): Promise<void>;
}

export class AppServerLocalInputTransport implements LocalInputTransport {
  constructor(private client: AppServerClient) {}

  async inject(
    _sessionId: string,
    attachment: { attachmentId: string; endpoint: string },
    _source: 'console' | 'telegram',
    text: string
  ): Promise<void> {
    await this.client.injectReply({
      endpoint: attachment.endpoint,
      threadId: attachment.attachmentId,
      replyText: text,
    });
  }
}
```

- [ ] **Step 4: Expose the minimum app-server client helper surface needed by local bridge**

```ts
export type LocalInjectResult = {
  mode: 'start' | 'steer';
  turnId: string;
};

async injectLocalInput(args: {
  endpoint: string;
  threadId: string;
  text: string;
}): Promise<LocalInjectResult> {
  const injected = await this.injectReply({
    endpoint: args.endpoint,
    threadId: args.threadId,
    replyText: args.text,
  });

  return injected;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/app-server-client.test.ts tests/local-input-transport.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/local-input-transport.ts src/app-server-client.ts src/remote-mode.ts tests/app-server-client.test.ts tests/local-input-transport.test.ts
git commit -m "feat: add local live bridge transport abstraction"
```

### Task 3: Daemon And Session Manager Integration

**Files:**
- Modify: `src/daemon.ts`
- Modify: `src/session-manager.ts`
- Modify: `src/telegram.ts`
- Modify: `src/reply-queue.ts`
- Modify: `src/hooks/stop-and-wait.ts`
- Modify: `src/hooks/session-start.ts`
- Test: `tests/daemon.test.ts`
- Test: `tests/session-manager.test.ts`
- Test: `tests/telegram.test.ts`

- [ ] **Step 1: Write the failing runtime integration tests**

```ts
it('keeps a local session active after stop hook and routes telegram input through the local bridge', async () => {
  const localBridge = {
    enqueue: vi.fn().mockResolvedValue(undefined),
  };

  const output = await sessionManager.handleStopAndWait({
    session_id: 's1',
    turn_id: 'turn-1',
    last_message: 'done',
    total_turns: 4,
  });

  expect(output).toEqual({ decision: 'continue' });
  expect(store.get('s1')?.record.status).toBe('active');

  await telegram.handleTopicMessageForTest('s1', 'continue in telegram');
  expect(localBridge.enqueue).toHaveBeenCalledWith('s1', 'telegram', 'continue in telegram');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/session-manager.test.ts tests/telegram.test.ts tests/daemon.test.ts`
Expected: FAIL because local bridge integration does not exist and stop hook still transitions to `waiting`

- [ ] **Step 3: Inject the bridge into daemon composition**

```ts
const localInputTransport = new AppServerLocalInputTransport(appServerClient);
const localSessionBridge = new LocalSessionBridge(localInputTransport);

const sessionManager = new SessionManagerImpl(
  store,
  replyQueue,
  telegram,
  config,
  localSessionBridge
);

telegram.setLocalBridgeHandler((sessionId, text) =>
  localSessionBridge.enqueue(sessionId, 'telegram', text)
);
```

- [ ] **Step 4: Remove `waiting` as the default local-mode stop path**

```ts
if (!hasRemoteSessionAttachment(existing.record)) {
  this.store.update(session_id, (record) => {
    record.status = 'active';
    record.mode = 'local';
    record.total_turns = total_turns;
    record.last_turn_output = last_message;
    record.remote_input_owner = null;
    record.local_bridge_enabled = true;
  });

  const stopMessageId = await this.tg.sendStopMessage(
    this.config.groupId,
    existing.record.topic_id,
    args.turn_id,
    last_message,
    total_turns,
    { mode: 'local' }
  );

  this.store.update(session_id, (record) => {
    record.stop_message_id = stopMessageId;
  });

  return { decision: 'continue' };
}
```

- [ ] **Step 5: Route active local topic messages to the live bridge before late-reply fallback**

```ts
if (matched.record.mode === 'local' && matched.record.local_bridge_state === 'attached') {
  await this.localBridgeHandler?.(matched.id, replyText);
  await this.addReaction(chatId, messageId, this.config.emojiReaction);
  return;
}
```

- [ ] **Step 6: Keep ReplyQueue only for compatibility / fallback paths**

```ts
if (matched.record.status === 'waiting') {
  const delivered = this.replyQueue.deliver(matched.id, replyText);
  if (delivered) {
    await this.addReaction(chatId, messageId, this.config.emojiReaction);
    return;
  }
}
```

- [ ] **Step 7: Make `hook-stop-and-wait` explicitly non-blocking for local-live sessions**

```ts
const data = await res.json();
if (data.decision === 'continue') {
  process.exit(0);
}
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx vitest run tests/session-manager.test.ts tests/telegram.test.ts tests/daemon.test.ts`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/daemon.ts src/session-manager.ts src/telegram.ts src/reply-queue.ts src/hooks/stop-and-wait.ts src/hooks/session-start.ts tests/daemon.test.ts tests/session-manager.test.ts tests/telegram.test.ts
git commit -m "feat: route local mode through live bridge"
```

### Task 4: Operator Surface And Diagnostics

**Files:**
- Modify: `src/cli.ts`
- Modify: `src/tl-mcp-tools.ts`
- Modify: `README.md`
- Modify: `CODEX_SETUP.md`
- Test: `tests/tl-mcp-tools.test.ts`

- [ ] **Step 1: Write the failing CLI surface tests**

```ts
it('prints local bridge status for a live local session', async () => {
  const result = await runCli(['local', 'status', 's1']);
  expect(result.stdout).toContain('"local_bridge_state":"attached"');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/tl-mcp-tools.test.ts`
Expected: FAIL because no local status surface exists

- [ ] **Step 3: Add operator commands for local bridge diagnostics**

```ts
case 'local':
  return cmdLocal(args);

async function cmdLocal(args: string[]) {
  switch (args[0]) {
    case 'status':
      return cmdLocalStatus(args[1]);
    default:
      throw new TlError('Unknown local subcommand', 'INVALID_ARGUMENT');
  }
}
```

- [ ] **Step 4: Document the new local-mode contract**

```md
## Local Mode

- `tl` daemon이 켜져 있어도 stop hook은 local mode에서 블로킹하지 않습니다.
- 같은 topic 안의 Telegram 메시지는 살아 있는 local session attachment로 즉시 전달됩니다.
- `tl resume`은 bridge recovery failure 시에만 필요합니다.
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/tl-mcp-tools.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts src/tl-mcp-tools.ts README.md CODEX_SETUP.md tests/tl-mcp-tools.test.ts
git commit -m "docs: expose local live bridge diagnostics"
```

### Task 5: End-To-End And Manual Smoke Coverage

**Files:**
- Modify: `tests/e2e-cli-daemon.test.ts`
- Modify: `tests/helpers/e2e-harness.ts`
- Modify: `templates/hooks.json`

- [ ] **Step 1: Write the failing end-to-end scenarios**

```ts
it('allows telegram -> console -> telegram roundtrips without tl resume in local mode', async () => {
  const stop = await harness.runCli(
    ['hook-stop-and-wait'],
    harness.stopPayload('s1', transcriptPath, 'done')
  );

  expect(stop.code).toBe(0);
  expect(harness.store.get('s1')?.record.status).toBe('active');

  await harness.telegramInboundTopic('s1', 'continue from telegram');
  expect(harness.localBridge.events).toContainEqual({
    sessionId: 's1',
    source: 'telegram',
    text: 'continue from telegram',
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/e2e-cli-daemon.test.ts`
Expected: FAIL because stop hook still assumes waiting-based control flow

- [ ] **Step 3: Update the E2E harness to simulate a live local attachment**

```ts
const localBridgeEvents: Array<{
  sessionId: string;
  source: 'console' | 'telegram';
  text: string;
}> = [];
```

- [ ] **Step 4: Update the hook template expectation for local non-blocking stop flow**

```json
{
  "type": "command",
  "command": "/Users/flowkater/.codex/hooks/tl-hook.sh hook-stop-and-wait",
  "timeout": 7200
}
```

The command stays the same; the behavioral assertion changes from "must remain waiting" to "must complete immediately for local-live sessions."

- [ ] **Step 5: Run the full verification suite**

Run: `npm run build`
Expected: `tsc` exits 0

Run: `npm test`
Expected: all Vitest suites PASS

- [ ] **Step 6: Run the manual smoke**

Run:

```bash
node dist/cli.js start
node dist/cli.js status
```

Expected:
- daemon is running
- local mode session starts normally
- stop hook returns immediately
- Telegram topic input reaches the same session without `tl resume`

- [ ] **Step 7: Commit**

```bash
git add tests/e2e-cli-daemon.test.ts tests/helpers/e2e-harness.ts templates/hooks.json
git commit -m "test: cover local live bridge roundtrip flow"
```

## Self-Review

- Spec coverage:
  - local live bridge runtime: Task 1, 2, 3
  - non-blocking local stop hook: Task 3, 5
  - console/telegram FIFO ordering: Task 1, 5
  - operator diagnostics: Task 4
  - fallback to resume only on failure: Task 3, 5
- Placeholder scan:
  - red-flag marker text is absent from the executable tasks
- Type consistency:
  - local runtime names are normalized around `LocalSessionBridge`, `LocalInputTransport`, `local_bridge_state`, `local_attachment_id`
