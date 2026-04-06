import { describe, it, expect, vi } from 'vitest';
import { AppServerRuntimeManager, createFakeChildProcess } from '../src/app-server-runtime.js';

describe('AppServerRuntimeManager', () => {
  it('does not spawn when readyz is already healthy', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true });
    const spawnImpl = vi.fn();
    const manager = new AppServerRuntimeManager({
      fetchImpl: fetchImpl as typeof fetch,
      spawnImpl: spawnImpl as any,
    });

    const restarted = await manager.ensureAvailable('ws://127.0.0.1:8791', '/tmp/test');

    expect(restarted).toBe(false);
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('spawns codex app-server and waits until readyz becomes healthy', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true });
    const spawnImpl = vi.fn().mockReturnValue(createFakeChildProcess());
    const manager = new AppServerRuntimeManager({
      fetchImpl: fetchImpl as typeof fetch,
      spawnImpl: spawnImpl as any,
      readinessTimeoutMs: 1_000,
      pollIntervalMs: 1,
    });

    const restarted = await manager.ensureAvailable('ws://127.0.0.1:8791', '/tmp/test');

    expect(restarted).toBe(true);
    expect(spawnImpl).toHaveBeenCalledWith(
      'codex',
      ['app-server', '--listen', 'ws://127.0.0.1:8791'],
      {
        cwd: '/tmp/test',
        detached: true,
        stdio: 'ignore',
      }
    );
  });
});
