import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  ensureTlHooksInstalled,
  TL_SESSION_START_HOOK,
  TL_STOP_HOOK,
} from '../src/codex-hooks.js';

function makeTestDir(): string {
  return path.join(os.tmpdir(), `tl-hooks-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

describe('codex hooks installer', () => {
  let testDir: string;
  let hooksPath: string;

  beforeEach(() => {
    testDir = makeTestDir();
    fs.mkdirSync(testDir, { recursive: true });
    hooksPath = path.join(testDir, 'hooks.json');
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('creates a fresh TL hooks file when none exists', () => {
    const result = ensureTlHooksInstalled(hooksPath);

    expect(result.changed).toBe(true);
    expect(result.created).toBe(true);
    expect(result.backupPath).toBeUndefined();

    const saved = JSON.parse(fs.readFileSync(hooksPath, 'utf-8'));
    expect(saved.hooks.SessionStart[0].hooks[0]).toEqual(TL_SESSION_START_HOOK);
    expect(saved.hooks.Stop[0].hooks[0]).toEqual(TL_STOP_HOOK);
  });

  it('merges TL hooks into an existing hooks.json without removing existing commands', () => {
    fs.writeFileSync(
      hooksPath,
      JSON.stringify(
        {
          hooks: {
            SessionStart: [
              {
                hooks: [
                  {
                    type: 'command',
                    command: 'python ~/.codex/hooks/router.py',
                  },
                ],
              },
            ],
            Stop: [],
          },
        },
        null,
        2
      )
    );

    const result = ensureTlHooksInstalled(hooksPath);

    expect(result.changed).toBe(true);
    expect(result.created).toBe(false);
    expect(result.backupPath).toBeDefined();
    expect(fs.existsSync(result.backupPath!)).toBe(true);

    const saved = JSON.parse(fs.readFileSync(hooksPath, 'utf-8'));
    expect(saved.hooks.SessionStart).toHaveLength(2);
    expect(saved.hooks.SessionStart[0].hooks[0].command).toBe('python ~/.codex/hooks/router.py');
    expect(saved.hooks.SessionStart[1].hooks[0]).toEqual(TL_SESSION_START_HOOK);
    expect(saved.hooks.Stop[0].hooks[0]).toEqual(TL_STOP_HOOK);
  });

  it('does not duplicate TL hooks that are already installed', () => {
    fs.writeFileSync(
      hooksPath,
      JSON.stringify(
        {
          hooks: {
            SessionStart: [{ hooks: [TL_SESSION_START_HOOK] }],
            Stop: [{ hooks: [TL_STOP_HOOK] }],
          },
        },
        null,
        2
      )
    );

    const result = ensureTlHooksInstalled(hooksPath);

    expect(result.changed).toBe(false);
    expect(result.created).toBe(false);
    expect(result.commandsAlreadyPresent).toEqual([
      TL_SESSION_START_HOOK.command,
      TL_STOP_HOOK.command,
    ]);
    expect(result.commandsInstalled).toEqual([]);
  });
});
