# TL End-to-End Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** TL의 real CLI hook subprocess와 real daemon HTTP 경로를 묶는 end-to-end 테스트를 추가해서 happy path와 주요 failure path 회귀를 통째로 고정한다.

**Architecture:** 테스트 harness가 temp config/data 디렉토리, ephemeral port, real `createDaemonApp`, real `SessionsStore`, real `ReplyQueue`, real `SessionManagerImpl`를 띄우고, Telegram은 deterministic fake transport로 대체한다. CLI는 `node + tsx + src/cli.ts` subprocess로 실행해서 `hook-session-start`, `hook-stop-and-wait`, `hook-working` 경로를 실제처럼 통과시킨다.

**Tech Stack:** TypeScript, Vitest, Node.js child_process, @hono/node-server

---

## File Structure

- Create: `tests/helpers/e2e-harness.ts`
- Create: `tests/e2e-cli-daemon.test.ts`
- Modify: `docs/superpowers/plans/2026-04-06-tl-e2e-hardening.md`

### Task 1: E2E harness 구축

**Files:**
- Create: `tests/helpers/e2e-harness.ts`

- [x] **Step 1: harness 요구사항을 고정하는 failing test 준비**

```ts
const harness = await TlE2EHarness.create({ stopTimeout: 5 });
expect(harness.url('/status')).toContain('http://127.0.0.1:');
expect(harness.telegram.events).toEqual([]);
```

- [x] **Step 2: helper가 없어서 실패하는지 확인**

Run: `npm test -- tests/e2e-cli-daemon.test.ts`
Expected: FAIL with missing `TlE2EHarness`

- [x] **Step 3: temp env + fake Telegram + real daemon helper 구현**

```ts
export class TlE2EHarness {
  static async create(options?: { stopTimeout?: number }): Promise<TlE2EHarness> {
    // temp dirs
    // config.json write
    // SessionsStore + ReplyQueue + SessionManagerImpl + createDaemonApp
    // serve(app.fetch, { port })
  }
}
```

- [x] **Step 4: helper 단위 검증**

Run: `npm test -- tests/e2e-cli-daemon.test.ts`
Expected: still FAIL at scenario assertions, but harness boot itself works

### Task 2: Happy path E2E 추가

**Files:**
- Create: `tests/e2e-cli-daemon.test.ts`
- Test: `tests/helpers/e2e-harness.ts`

- [x] **Step 1: happy path failing test 작성**

```ts
it('runs SessionStart -> Stop -> reply -> Working across real CLI and daemon', async () => {
  const harness = await TlE2EHarness.create({ stopTimeout: 5 });
  const transcriptPath = harness.writeTranscript([
    ['user', 'start work'],
    ['commentary', 'first commentary'],
    ['final', 'final answer'],
  ]);

  const start = await harness.runCli(['hook-session-start'], startPayload(transcriptPath));
  expect(start.code).toBe(0);

  const stop = harness.spawnCli(['hook-stop-and-wait'], stopPayload(transcriptPath));
  await vi.waitFor(() => expect(harness.store.get('s1')?.record.status).toBe('waiting'));
  harness.replyQueue.deliver('s1', 'reply from telegram');

  const stopResult = await stop.waitForExit();
  expect(stopResult.stdout.trim()).toBe('{"decision":"block","reason":"reply from telegram"}');
});
```

- [x] **Step 2: 실패 확인**

Run: `npm test -- tests/e2e-cli-daemon.test.ts`
Expected: FAIL because real subprocess/daemon assertions are not yet satisfied

- [x] **Step 3: scenario helper와 assertions 보강**

```ts
expect(harness.telegram.find('stop')?.body).toContain('first commentary');
expect(harness.telegram.count('resume-ack')).toBe(1);
expect(harness.telegram.count('working')).toBe(1);
```

- [x] **Step 4: happy path 통과 확인**

Run: `npm test -- tests/e2e-cli-daemon.test.ts`
Expected: happy path PASS

### Task 3: Failure path E2E 추가

**Files:**
- Modify: `tests/e2e-cli-daemon.test.ts`

- [x] **Step 1: timeout continue path 작성**

```ts
it('returns continue when stop wait times out and restores session to active', async () => {
  const harness = await TlE2EHarness.create({ stopTimeout: 1 });
  await harness.startSession('s-timeout');
  const stop = await harness.runCli(['hook-stop-and-wait'], stopPayload(harness.transcriptPath));
  expect(stop.code).toBe(0);
  expect(stop.stdout.trim()).toBe('');
  expect(harness.store.get('s-timeout')?.record.status).toBe('active');
});
```

- [x] **Step 2: unreachable daemon warning path 작성**

```ts
it('gracefully returns 0 when stop hook cannot reach the daemon', async () => {
  const result = await runStandaloneCliWithPort(unusedPort);
  expect(result.code).toBe(0);
  expect(result.stderr).toContain('Warning: Hook connection failed');
});
```

- [x] **Step 3: failure path 통과 확인**

Run: `npm test -- tests/e2e-cli-daemon.test.ts`
Expected: PASS for timeout and unreachable-daemon scenarios

### Task 4: 전체 검증 및 커밋

**Files:**
- Modify: created files from Tasks 1-3

- [x] **Step 1: 전체 빌드**

Run: `npm run build`
Expected: PASS

- [x] **Step 2: 전체 테스트**

Run: `npm test`
Expected: PASS with increased test count

- [x] **Step 3: 커밋**

```bash
git add tests/helpers/e2e-harness.ts tests/e2e-cli-daemon.test.ts docs/superpowers/plans/2026-04-06-tl-e2e-hardening.md
git commit -m "test: add end-to-end TL daemon and CLI coverage"
```

## Self-Review

- Spec coverage: happy path 1개와 failure path 2개를 task로 모두 포함했다.
- Placeholder scan: 남은 TODO/TBD 없음.
- Type consistency: `TlE2EHarness`, `runCli`, `spawnCli`, `writeTranscript` naming을 plan 전체에서 통일했다.
