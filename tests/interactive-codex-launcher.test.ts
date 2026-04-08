import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
import {
  buildCodexOpenArgs,
  buildCodexResumeArgs,
  launchInteractiveCodex,
  launchInteractiveCodexOpen,
} from '../src/interactive-codex-launcher.js';

class FakeChildProcess extends EventEmitter {}

describe('interactive-codex-launcher', () => {
  it('builds the expected remote resume arguments', () => {
    expect(buildCodexResumeArgs('session-1', 'ws://127.0.0.1:8795', '/tmp/project')).toEqual([
      'resume',
      '--remote',
      'ws://127.0.0.1:8795',
      '--dangerously-bypass-approvals-and-sandbox',
      '--cd',
      '/tmp/project',
      'session-1',
    ]);
  });

  it('builds the expected remote open arguments', () => {
    expect(
      buildCodexOpenArgs(
        'ws://127.0.0.1:8795',
        '/tmp/project',
        'hello from tl open'
      )
    ).toEqual([
      '--remote',
      'ws://127.0.0.1:8795',
      '--dangerously-bypass-approvals-and-sandbox',
      '--cd',
      '/tmp/project',
      'hello from tl open',
    ]);
  });

  it('keeps normal interactive exits untouched', async () => {
    const child = new FakeChildProcess();
    const spawnImpl = vi.fn(() => child as any);
    const env = { ...process.env, TL_MANAGED_OPEN: '1' };

    const launched = launchInteractiveCodex(
      {
        sessionId: 'session-2',
        endpoint: 'ws://127.0.0.1:8795',
        cwd: '/tmp',
        env,
      },
      {
        spawnImpl,
      }
    );

    child.emit('close', 0);

    await expect(launched).resolves.toBe(0);
    expect(spawnImpl).toHaveBeenCalledWith(
      'codex',
      [
        'resume',
        '--remote',
        'ws://127.0.0.1:8795',
        '--dangerously-bypass-approvals-and-sandbox',
        '--cd',
        '/tmp',
        'session-2',
      ],
      expect.objectContaining({
        cwd: '/tmp',
        env,
        stdio: 'inherit',
      })
    );
  });

  it('launches tl open in the current terminal with env overrides', async () => {
    const child = new FakeChildProcess();
    const spawnImpl = vi.fn(() => child as any);
    const env = {
      ...process.env,
      TL_MANAGED_OPEN: '1',
      TL_SESSION_MODE: 'local-managed',
      TL_REMOTE_ENDPOINT: 'ws://127.0.0.1:8795',
    };

    const launched = launchInteractiveCodexOpen(
      {
        endpoint: 'ws://127.0.0.1:8795',
        cwd: '/tmp/project',
        initialPrompt: 'bootstrap',
        env,
      },
      {
        spawnImpl,
      }
    );

    child.emit('close', 0);

    await expect(launched).resolves.toBe(0);
    expect(spawnImpl).toHaveBeenCalledWith(
      'codex',
      [
        '--remote',
        'ws://127.0.0.1:8795',
        '--dangerously-bypass-approvals-and-sandbox',
        '--cd',
        '/tmp/project',
        'bootstrap',
      ],
      expect.objectContaining({
        cwd: '/tmp/project',
        env,
        stdio: 'inherit',
      })
    );
  });
});
