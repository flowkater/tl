import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
import {
  buildLocalAttachmentId,
  LocalConsoleRuntimeManager,
} from '../src/local-console-runtime.js';

class FakeChildProcess extends EventEmitter {
  pid?: number;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
}

describe('local-console-runtime', () => {
  it('builds a stable screen attachment id', () => {
    expect(buildLocalAttachmentId('session-1')).toBe('tl-local-session-1');
  });

  it('starts a screen-backed Codex session when missing', async () => {
    const screenCalls: Array<{ args: string[]; stdio?: string }> = [];
    let hasSessionChecks = 0;
    const spawnImpl = vi.fn((command: string, args: string[], options?: { stdio?: string }) => {
      expect(command).toBe('screen');
      screenCalls.push({ args, stdio: options?.stdio });

      const child = new FakeChildProcess();
      child.pid = 4242;

      queueMicrotask(() => {
        if (args[0] === '-dmS') {
          child.emit('spawn');
          child.emit('close', 0);
          return;
        }

        if (args[0] === '-ls') {
          hasSessionChecks += 1;
          child.stdout.emit(
            'data',
            Buffer.from(hasSessionChecks >= 2 ? 'tl-local-session-1' : '')
          );
          child.emit('close', hasSessionChecks >= 2 ? 0 : 1);
          return;
        }

        child.emit('close', 0);
      });

      return child as any;
    });

    const runtime = new LocalConsoleRuntimeManager({
      spawnImpl,
      startupDelayMs: 0,
    });

    const result = await runtime.ensureAttached({
      sessionId: 'session-1',
      endpoint: 'ws://127.0.0.1:8795',
      cwd: '/tmp/project',
    });

    expect(result).toMatchObject({
      started: true,
      attachmentId: 'tl-local-session-1',
    });
    expect(screenCalls[1]?.args).toEqual([
      '-dmS',
      'tl-local-session-1',
      '-L',
      'bash',
      '-lc',
      "cd '/tmp/project' && exec codex 'resume' '--remote' 'ws://127.0.0.1:8795' '--dangerously-bypass-approvals-and-sandbox' '--no-alt-screen' '--cd' '/tmp/project' 'session-1'",
    ]);
    expect(result.logPath).toContain('/local-consoles/session-1/screenlog.0');
  });

  it('starts a blank tl-open session without additional exports', async () => {
    const screenCalls: Array<{ args: string[]; stdio?: string }> = [];
    let sessionStarted = false;
    const spawnImpl = vi.fn((command: string, args: string[], options?: { stdio?: string }) => {
      expect(command).toBe('screen');
      screenCalls.push({ args, stdio: options?.stdio });

      const child = new FakeChildProcess();
      child.pid = 5151;

      queueMicrotask(() => {
        if (args[0] === '-dmS') {
          sessionStarted = true;
          child.emit('spawn');
          child.emit('close', 0);
          return;
        }

        if (args[0] === '-ls') {
          child.stdout.emit(
            'data',
            Buffer.from(sessionStarted ? 'tl-open-session-1' : '')
          );
          child.emit('close', sessionStarted ? 0 : 1);
          return;
        }

        child.emit('close', 0);
      });

      return child as any;
    });

    const runtime = new LocalConsoleRuntimeManager({
      spawnImpl,
      startupDelayMs: 0,
    });

    const result = await runtime.startFresh({
      attachmentId: 'tl-open-session-1',
      endpoint: 'ws://127.0.0.1:8795',
      cwd: '/tmp/project',
    });

    expect(result).toMatchObject({
      started: true,
      attachmentId: 'tl-open-session-1',
    });
    expect(screenCalls[0]?.args).toEqual([
      '-dmS',
      'tl-open-session-1',
      '-L',
      'bash',
      '-lc',
      "cd '/tmp/project' && exec codex '--remote' 'ws://127.0.0.1:8795' '--dangerously-bypass-approvals-and-sandbox' '--no-alt-screen' '--cd' '/tmp/project'",
    ]);
  });

  it('attaches to the existing screen session', async () => {
    const child = new FakeChildProcess();
    const spawnImpl = vi.fn(() => child as any);
    const runtime = new LocalConsoleRuntimeManager({ spawnImpl });

    const launched = runtime.attach('tl-local-session-1', '/tmp/project');
    child.emit('close', 0);

    await expect(launched).resolves.toBe(0);
    expect(spawnImpl).toHaveBeenCalledWith(
      'screen',
      ['-D', '-r', 'tl-local-session-1'],
      expect.objectContaining({
        cwd: '/tmp/project',
        stdio: 'inherit',
      })
    );
  });
});
