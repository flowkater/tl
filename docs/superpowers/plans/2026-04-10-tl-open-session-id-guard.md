# tl open Session ID Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent `tl open <session_id>` from silently creating a brand-new local-managed session when the user intended to reopen an existing managed session.

**Architecture:** Keep `tl open` as the blank local-managed session entrypoint, but add explicit argument validation ahead of daemon/app-server setup. Route existing-session guidance through a small parser helper so help text, error text, and the command implementation stay aligned.

**Tech Stack:** TypeScript, Node.js CLI, Vitest

---

### Task 1: Lock the regression with tests

**Files:**
- Create: `tests/cli-open-args.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { parseOpenArgs } from '../src/open-command-args.js';

describe('parseOpenArgs', () => {
  it('rejects a positional session id and points to the managed open commands', () => {
    expect(() => parseOpenArgs(['019d6bd0-1437-7f72-88ef-24f7952a159c'], '/tmp/tl')).toThrowError(
      /tl local open <session_id>/
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/cli-open-args.test.ts`
Expected: FAIL because `parseOpenArgs` does not exist yet.

### Task 2: Implement minimal CLI argument guard

**Files:**
- Create: `src/open-command-args.ts`
- Modify: `src/cli.ts`
- Test: `tests/cli-open-args.test.ts`

- [ ] **Step 1: Write minimal parser implementation**

```ts
export function parseOpenArgs(args: string[], defaultCwd: string) {
  // Parse known flags. Reject any positional argument and explain the correct commands.
}
```

- [ ] **Step 2: Wire `cmdOpen` to the parser**

```ts
const { cwd, endpoint, model, project, text } = parseOpenArgs(args, process.cwd());
```

- [ ] **Step 3: Re-run the targeted test**

Run: `npm test -- tests/cli-open-args.test.ts`
Expected: PASS

### Task 3: Verify CLI help and nearby behavior

**Files:**
- Modify: `src/cli.ts`
- Test: `tests/cli-open-args.test.ts`

- [ ] **Step 1: Assert the help text documents `tl open` correctly**

```ts
expect(source).toContain('tl open ...                  Start and attach a local-managed Codex session');
```

- [ ] **Step 2: Run targeted verification**

Run: `npm test -- tests/cli-open-args.test.ts tests/cli-timeout.test.ts`
Expected: PASS

- [ ] **Step 3: Run broader CLI regression coverage**

Run: `npm test -- tests/e2e-cli-daemon.test.ts`
Expected: PASS
