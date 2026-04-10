import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
import { RemoteWorkerRuntimeManager } from '../src/remote-worker-runtime.js';

class FakeChildProcess extends EventEmitter {
  pid?: number;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  unref = vi.fn();
}

describe('remote-worker-runtime', () => {
  it('preserves approval-only launch preferences without synthesizing sandbox flags', async () => {
    const spawnImpl = vi.fn((command: string, args: string[]) => {
      expect(command).toBe('script');

      const child = new FakeChildProcess();
      child.pid = 4242;
      queueMicrotask(() => {
        child.emit('spawn');
      });
      return child as any;
    });
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === 4242 && signal === 0) {
        return true;
      }
      return true;
    }) as typeof process.kill);

    try {
      const runtime = new RemoteWorkerRuntimeManager({
        spawnImpl,
        startupDelayMs: 0,
      });

      await runtime.ensureAttached({
        sessionId: 'session-1',
        endpoint: 'ws://127.0.0.1:8795',
        cwd: '/tmp/project',
        launchPrefs: {
          'approval-policy': 'on-request',
        },
      });

      expect(spawnImpl).toHaveBeenCalledWith(
        'script',
        [
          '-q',
          expect.stringContaining('/remote-workers/session-1.log'),
          'codex',
          'resume',
          '--remote',
          'ws://127.0.0.1:8795',
          '--ask-for-approval',
          'on-request',
          '--no-alt-screen',
          '--cd',
          '/tmp/project',
          'session-1',
        ],
        expect.objectContaining({
          cwd: '/tmp/project',
          detached: true,
          stdio: 'ignore',
        })
      );
    } finally {
      killSpy.mockRestore();
    }
  });
});
