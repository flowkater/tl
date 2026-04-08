import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  disableRemoteSessionStartHook,
  enableRemoteSessionStartHook,
  ensureTlHooksInstalled,
  TL_REMOTE_SESSION_START_WRAPPER_PATH,
  createRemoteSessionStartHook,
  TL_SESSION_START_HOOK,
  TL_STOP_HOOK,
  writeHookRunnerScript,
  writeRemoteSessionStartWrapper,
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

  it('replaces legacy tl commands in hooks.json with local wrapper commands', () => {
    fs.writeFileSync(
      hooksPath,
      JSON.stringify(
        {
          hooks: {
            SessionStart: [{ hooks: [{ type: 'command', command: 'tl hook-session-start' }] }],
            Stop: [{ hooks: [{ type: 'command', command: 'tl hook-stop-and-wait' }] }],
          },
        },
        null,
        2
      )
    );

    const wrapperPath = path.join(testDir, 'tl-hook.sh');
    const result = ensureTlHooksInstalled(
      hooksPath,
      '/app/project/dist/cli.js',
      'node',
      wrapperPath
    );

    expect(result.changed).toBe(true);
    expect(result.commandsInstalled).toContain(TL_SESSION_START_HOOK.command);
    expect(result.commandsInstalled).toContain(TL_STOP_HOOK.command);

    const saved = JSON.parse(fs.readFileSync(hooksPath, 'utf-8'));
    expect(saved.hooks.SessionStart[0].hooks[0]).toEqual(TL_SESSION_START_HOOK);
    expect(saved.hooks.Stop[0].hooks[0]).toEqual(TL_STOP_HOOK);
    expect(fs.readFileSync(wrapperPath, 'utf-8')).toContain('TL_CLI_PATH="/app/project/dist/cli.js"');
  });

  it('creates the hook runner script when cliScriptPath is provided', () => {
    const wrapperPath = path.join(testDir, 'tl-hook.sh');
    const cliPath = path.join(testDir, 'dist', 'cli.js');
    try {
      expect(fs.existsSync(wrapperPath)).toBe(false);
      writeHookRunnerScript(cliPath, wrapperPath);
      expect(fs.existsSync(wrapperPath)).toBe(true);
      const script = fs.readFileSync(wrapperPath, 'utf-8');
      expect(script).toContain('tl command unavailable');
      expect(script).toContain(`"${cliPath}"`);
    } finally {
      fs.rmSync(wrapperPath, { force: true });
    }
  });

  it('switches SessionStart to the remote wrapper command when remote mode is enabled', () => {
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

    const wrapperPath = path.join(testDir, 'tl-remote-session-start.sh');
    writeRemoteSessionStartWrapper('ws://127.0.0.1:8795', wrapperPath);
    const result = enableRemoteSessionStartHook(hooksPath, wrapperPath);

    expect(result.remoteEnabled).toBe(true);
    expect(result.sessionStartCommand).toBe(wrapperPath);
    expect(fs.readFileSync(wrapperPath, 'utf-8')).toContain("TL_REMOTE_ENDPOINT='ws://127.0.0.1:8795'");

    const saved = JSON.parse(fs.readFileSync(hooksPath, 'utf-8'));
    expect(saved.hooks.SessionStart[0].hooks[0]).toEqual(
      createRemoteSessionStartHook(wrapperPath)
    );
  });

  it('restores the plain TL SessionStart command when remote mode is disabled', () => {
    fs.writeFileSync(
      hooksPath,
      JSON.stringify(
        {
          hooks: {
            SessionStart: [{ hooks: [createRemoteSessionStartHook(TL_REMOTE_SESSION_START_WRAPPER_PATH)] }],
            Stop: [{ hooks: [TL_STOP_HOOK] }],
          },
        },
        null,
        2
      )
    );

    const result = disableRemoteSessionStartHook(hooksPath);

    expect(result.remoteEnabled).toBe(false);
    expect(result.sessionStartCommand).toBe(TL_SESSION_START_HOOK.command);

    const saved = JSON.parse(fs.readFileSync(hooksPath, 'utf-8'));
    expect(saved.hooks.SessionStart[0].hooks[0]).toEqual(TL_SESSION_START_HOOK);
  });

  it('deduplicates repeated TL SessionStart hooks while preserving one command', () => {
    fs.writeFileSync(
      hooksPath,
      JSON.stringify(
        {
          hooks: {
            SessionStart: [
              { hooks: [TL_SESSION_START_HOOK] },
              { hooks: [createRemoteSessionStartHook(TL_REMOTE_SESSION_START_WRAPPER_PATH)] },
              { hooks: [TL_SESSION_START_HOOK] },
            ],
            Stop: [{ hooks: [TL_STOP_HOOK] }],
          },
        },
        null,
        2
      )
    );

    const result = disableRemoteSessionStartHook(hooksPath);

    expect(result.changed).toBe(true);

    const saved = JSON.parse(fs.readFileSync(hooksPath, 'utf-8'));
    expect(saved.hooks.SessionStart).toHaveLength(1);
    expect(saved.hooks.SessionStart[0].hooks).toEqual([TL_SESSION_START_HOOK]);
  });
});
