# Telegram Control And Codex Directives Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Telegram-side TL bridge commands plus topic-scoped Codex directives/defaults without breaking existing session routing.

**Architecture:** Split the work into three bounded layers. First add a dedicated topic-preferences store and parser modules for `/tl` commands and message headers. Then integrate those modules into `TelegramBot.handleMessage()` and small daemon endpoints so commands are executed explicitly and normal prompts are normalized before delivery. Finally propagate deferred spawn preferences into managed session launch/recovery/status paths so `model`, `approval-policy`, `sandbox`, and `cwd` are stored now and applied on the next attach/spawn.

**Tech Stack:** TypeScript, Node.js, grammY, Vitest

---

## File Structure

- Create: `src/topic-preferences-store.ts`
  Purpose: Persist topic defaults in `~/.tl/topic-preferences.json` with atomic save/load semantics similar to `SessionsStore`.
- Create: `src/telegram-directives.ts`
  Purpose: Parse `/tl ...` commands, parse leading header blocks, normalize values, validate supported keys, and compile immediate directives into a prompt string.
- Modify: `src/types.ts`
  Purpose: Add shared types for topic preferences, per-message directives, and deferred spawn preferences.
- Modify: `src/telegram.ts`
  Purpose: Add `/tl` command handling, header parsing, topic-default resolution, parse-error responses, and normalized prompt delivery.
- Modify: `src/daemon.ts`
  Purpose: Expose topic preference/status endpoints and apply stored spawn preferences when returning status or launching managed runtimes.
- Modify: `src/local-console-runtime.ts`
  Purpose: Accept deferred launch preferences and include them in codex launch commands.
- Modify: `src/remote-worker-runtime.ts`
  Purpose: Accept deferred launch preferences and include them in remote worker spawn commands.
- Modify: `src/remote-stop-controller.ts`
  Purpose: Pass effective deferred launch preferences into restart/reattach flows.
- Modify: `src/store.ts`
  Purpose: No persistence model change for topic defaults, but may need small helpers or imported shared types if status responses expose pending preferences.
- Create: `tests/topic-preferences-store.test.ts`
  Purpose: Persistence/validation coverage.
- Create: `tests/telegram-directives.test.ts`
  Purpose: `/tl` parser + header parser + compile behavior coverage.
- Modify: `tests/telegram.test.ts`
  Purpose: Routing tests for `/tl` commands, invalid headers, and normalized prompt delivery.
- Modify: `tests/daemon.test.ts`
  Purpose: Topic preference endpoints and deferred spawn preference status coverage.
- Modify: `tests/remote-stop-controller.test.ts`
  Purpose: Recovery flow uses deferred launch preferences.
- Modify: `tests/e2e-cli-daemon.test.ts`
  Purpose: Optional end-to-end regression for topic defaults/status if cheap to cover.

---

### Task 1: Topic Preference Store And Directive Parsers

**Files:**
- Create: `src/topic-preferences-store.ts`
- Create: `src/telegram-directives.ts`
- Modify: `src/types.ts`
- Test: `tests/topic-preferences-store.test.ts`
- Test: `tests/telegram-directives.test.ts`

- [ ] **Step 1: Write the failing parser tests**

```ts
import { describe, expect, it } from 'vitest';
import {
  parseTelegramControlCommand,
  parseTelegramDirectiveMessage,
  compileDirectivePrompt,
} from '../src/telegram-directives.js';

describe('parseTelegramControlCommand', () => {
  it('parses /tl set skill with comma-separated values', () => {
    expect(
      parseTelegramControlCommand('/tl set skill systematic-debugging, swift-concurrency-expert')
    ).toEqual({
      kind: 'set',
      field: 'skill',
      value: ['systematic-debugging', 'swift-concurrency-expert'],
    });
  });

  it('rejects unknown fields', () => {
    expect(() => parseTelegramControlCommand('/tl set foo bar')).toThrowError(/unknown field/i);
  });
});

describe('parseTelegramDirectiveMessage', () => {
  it('parses repeated and comma-separated directive headers', () => {
    expect(
      parseTelegramDirectiveMessage(
        '@skill: systematic-debugging\n@skill: swift-concurrency-expert\n@cmd: /compact, /no-tools\n\nInvestigate this crash'
      )
    ).toMatchObject({
      body: 'Investigate this crash',
      directives: {
        skill: ['systematic-debugging', 'swift-concurrency-expert'],
        cmd: ['/compact', '/no-tools'],
      },
    });
  });

  it('treats none as clear for skill and cmd', () => {
    expect(
      parseTelegramDirectiveMessage('@skill: none\n@cmd: none\n\nJust answer plainly')
    ).toMatchObject({
      directives: { skill: [], cmd: [] },
    });
  });
});

describe('compileDirectivePrompt', () => {
  it('prepends commands and skill instructions above the body', () => {
    expect(
      compileDirectivePrompt({
        body: 'Trace the root cause',
        directives: {
          skill: ['systematic-debugging'],
          cmd: ['/compact'],
        },
      })
    ).toContain('Use these skills for this turn: systematic-debugging');
  });
});
```

- [ ] **Step 2: Run parser tests to verify RED**

Run: `npm test -- tests/telegram-directives.test.ts`
Expected: FAIL because `src/telegram-directives.ts` does not exist yet.

- [ ] **Step 3: Write the failing topic-preferences store tests**

```ts
import { describe, expect, it } from 'vitest';
import { TopicPreferencesStore } from '../src/topic-preferences-store.js';

describe('TopicPreferencesStore', () => {
  it('saves and reloads topic defaults by chatId:topicId key', async () => {
    const store = new TopicPreferencesStore();
    await store.load();

    store.set('-1001234567890:727', {
      skill: ['systematic-debugging'],
      cmd: ['/compact'],
      model: 'gpt-5.4',
      updated_at: '2026-04-10T12:00:00.000Z',
    });
    await store.save();

    const reloaded = new TopicPreferencesStore();
    await reloaded.load();

    expect(reloaded.get('-1001234567890:727')).toMatchObject({
      skill: ['systematic-debugging'],
      cmd: ['/compact'],
      model: 'gpt-5.4',
    });
  });
});
```

- [ ] **Step 4: Run store tests to verify RED**

Run: `npm test -- tests/topic-preferences-store.test.ts`
Expected: FAIL because `TopicPreferencesStore` does not exist yet.

- [ ] **Step 5: Implement minimal shared types**

```ts
export type TopicPreferenceField =
  | 'skill'
  | 'cmd'
  | 'model'
  | 'approval-policy'
  | 'sandbox'
  | 'cwd';

export interface TopicPreferences {
  skill?: string[];
  cmd?: string[];
  model?: string;
  'approval-policy'?: string;
  sandbox?: string;
  cwd?: string;
  updated_at: string;
}
```

- [ ] **Step 6: Implement the topic-preferences store**

```ts
export class TopicPreferencesStore {
  async load(): Promise<void> { /* same atomic load shape as SessionsStore */ }
  get(topicKey: string): TopicPreferences | undefined { /* return saved prefs */ }
  set(topicKey: string, prefs: TopicPreferences): void { /* overwrite */ }
  clearField(topicKey: string, field: TopicPreferenceField): void { /* remove field */ }
  async save(): Promise<void> { /* write ~/.tl/topic-preferences.json atomically */ }
}
```

- [ ] **Step 7: Implement the directive parser/compiler**

```ts
export function parseTelegramControlCommand(text: string): TelegramControlCommand { /* /tl help|status|resume|show config|set|clear */ }
export function parseTelegramDirectiveMessage(text: string): ParsedTelegramDirectiveMessage { /* leading @headers only */ }
export function compileDirectivePrompt(args: {
  body: string;
  directives: ResolvedTelegramDirectives;
}): string { /* prepend cmd lines + TL directives block */ }
```

- [ ] **Step 8: Re-run Task 1 tests to verify GREEN**

Run: `npm test -- tests/topic-preferences-store.test.ts tests/telegram-directives.test.ts`
Expected: PASS

- [ ] **Step 9: Commit Task 1**

```bash
git add src/types.ts src/topic-preferences-store.ts src/telegram-directives.ts tests/topic-preferences-store.test.ts tests/telegram-directives.test.ts
git commit -m "feat: add telegram directive parsing and topic preferences store"
```

---

### Task 2: Telegram `/tl` Commands And Header-Aware Routing

**Files:**
- Modify: `src/telegram.ts`
- Modify: `src/daemon.ts`
- Modify: `tests/telegram.test.ts`
- Modify: `tests/daemon.test.ts`

- [ ] **Step 1: Write the failing Telegram routing tests**

```ts
it('handles /tl status without delivering the message to a waiting session', async () => {
  const sendMessage = vi.fn().mockResolvedValue({ message_id: 900 });
  const deliver = vi.fn().mockReturnValue(true);
  const bot = new TelegramBot(config, store as any, { deliver } as any);
  (bot as any).bot = { api: { sendMessage } };

  await (bot as any).handleMessage(makeMessageContext({
    text: '/tl status',
    threadId: 42,
  }));

  expect(deliver).not.toHaveBeenCalled();
  expect(sendMessage).toHaveBeenCalled();
});

it('normalizes directive headers before delivering a waiting reply', async () => {
  const deliver = vi.fn().mockReturnValue(true);
  const bot = new TelegramBot(config, store as any, { deliver } as any);

  await (bot as any).handleMessage(makeMessageContext({
    text: '@skill: systematic-debugging\n@cmd: /compact\n\nTrace the crash',
    threadId: 42,
  }));

  expect(deliver).toHaveBeenCalledWith(
    's1',
    expect.stringContaining('Use these skills for this turn: systematic-debugging')
  );
});
```

- [ ] **Step 2: Run Telegram tests to verify RED**

Run: `npm test -- tests/telegram.test.ts`
Expected: FAIL because `/tl` commands are not intercepted and directive headers are not compiled.

- [ ] **Step 3: Add daemon endpoints for topic preference reads/writes**

```ts
app.get('/topic-preferences', async (c) => { /* query chat_id + topic_id */ });
app.post('/topic-preferences/set', async (c) => { /* set field/value */ });
app.post('/topic-preferences/clear', async (c) => { /* clear field */ });
```

- [ ] **Step 4: Teach TelegramBot to intercept `/tl` messages**

```ts
if (trimmed.startsWith('/tl')) {
  const command = parseTelegramControlCommand(trimmed);
  await this.executeTelegramControlCommand(command, ctx.chat.id, message.message_thread_id, matchedSession);
  return;
}
```

- [ ] **Step 5: Teach TelegramBot to parse and compile leading directive headers**

```ts
const parsed = parseTelegramDirectiveMessage(replyText.trim());
const topicDefaults = await this.topicPreferences.get(topicKey);
const effective = resolveTelegramDirectives(topicDefaults, parsed.directives);
const normalizedPrompt = compileDirectivePrompt({
  body: parsed.body,
  directives: effective.immediate,
});
```

- [ ] **Step 6: Reject invalid command/header input with explicit topic feedback**

```ts
await this.sendTopicText(chatId, topicId, `⚠️ ${error.message}`);
return;
```

- [ ] **Step 7: Re-run Telegram and daemon tests to verify GREEN**

Run: `npm test -- tests/telegram.test.ts tests/daemon.test.ts`
Expected: PASS

- [ ] **Step 8: Commit Task 2**

```bash
git add src/telegram.ts src/daemon.ts tests/telegram.test.ts tests/daemon.test.ts
git commit -m "feat: add telegram tl commands and directive-aware routing"
```

---

### Task 3: Deferred Spawn Preferences In Status And Recovery Paths

**Files:**
- Modify: `src/local-console-runtime.ts`
- Modify: `src/remote-worker-runtime.ts`
- Modify: `src/remote-stop-controller.ts`
- Modify: `src/daemon.ts`
- Modify: `tests/remote-stop-controller.test.ts`
- Modify: `tests/daemon.test.ts`

- [ ] **Step 1: Write the failing deferred-preference tests**

```ts
it('includes pending spawn preferences in local status', async () => {
  const response = await app.request('http://localhost/local/status?session_id=thread-local-1');
  expect(await response.json()).toMatchObject({
    pending_spawn_preferences: {
      model: 'gpt-5.4',
      sandbox: 'danger-full-access',
    },
  });
});

it('passes deferred cwd/model preferences into local console reattach', async () => {
  await controller.handleReply('s1', 'continue from telegram');
  expect(localConsoleRuntime.ensureAttached).toHaveBeenCalledWith(
    expect.objectContaining({
      launchPreferences: expect.objectContaining({
        model: 'gpt-5.4',
        cwd: '/Users/flowkater/Projects/TL',
      }),
    })
  );
});
```

- [ ] **Step 2: Run the targeted tests to verify RED**

Run: `npm test -- tests/remote-stop-controller.test.ts tests/daemon.test.ts`
Expected: FAIL because no pending preference plumbing exists yet.

- [ ] **Step 3: Extend launch/runtime APIs to accept deferred launch preferences**

```ts
type DeferredLaunchPreferences = {
  model?: string;
  'approval-policy'?: string;
  sandbox?: string;
  cwd?: string;
};

async ensureAttached(args: {
  sessionId: string;
  endpoint: string;
  cwd: string;
  launchPreferences?: DeferredLaunchPreferences;
}) { /* include preferences when building codex command */ }
```

- [ ] **Step 4: Update codex command builders to emit supported flags**

```ts
if (prefs.model) args.push('--model', prefs.model);
if (prefs.cwd) args.push('--cd', prefs.cwd);
if (prefs['approval-policy']) args.push('--approval-mode', prefs['approval-policy']);
if (prefs.sandbox === 'danger-full-access') args.push('--dangerously-bypass-approvals-and-sandbox');
```

- [ ] **Step 5: Resolve effective deferred preferences from topic defaults in daemon/controller paths**

```ts
const pendingSpawnPreferences = topicPreferencesStore.get(topicKey);
return c.json({
  ...status,
  pending_spawn_preferences: pendingSpawnPreferences ?? null,
});
```

- [ ] **Step 6: Re-run targeted tests to verify GREEN**

Run: `npm test -- tests/remote-stop-controller.test.ts tests/daemon.test.ts`
Expected: PASS

- [ ] **Step 7: Run broader regression coverage**

Run: `npm test -- tests/topic-preferences-store.test.ts tests/telegram-directives.test.ts tests/telegram.test.ts tests/daemon.test.ts tests/remote-stop-controller.test.ts tests/e2e-cli-daemon.test.ts`
Expected: PASS

- [ ] **Step 8: Commit Task 3**

```bash
git add src/local-console-runtime.ts src/remote-worker-runtime.ts src/remote-stop-controller.ts src/daemon.ts tests/remote-stop-controller.test.ts tests/daemon.test.ts
git commit -m "feat: apply telegram spawn preferences to managed recovery"
```

---

## Self-Review

- Spec coverage:
  - `/tl` commands: Task 2
  - leading directive headers: Task 1 + Task 2
  - topic-scoped defaults persistence: Task 1
  - deferred launch preference semantics: Task 3
  - explicit error feedback: Task 2
- Placeholder scan:
  - No `TBD`, `TODO`, or implicit “test this later” steps remain.
- Type consistency:
  - Canonical keys are fixed to `skill`, `cmd`, `model`, `approval-policy`, `sandbox`, `cwd` across all tasks.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-10-telegram-control-and-directives-implementation.md`.

Execution mode is already chosen: **Subagent-Driven**.
Proceed by dispatching one fresh implementer subagent per task, followed by spec compliance review and then code quality review before moving to the next task.
