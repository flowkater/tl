import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import { createDaemonApp } from '../src/daemon.js';

describe('daemon entrypoint', () => {
  it('does not use CommonJS require in ESM runtime', () => {
    const source = fs.readFileSync(
      new URL('../src/daemon.ts', import.meta.url),
      'utf-8'
    );

    expect(source).not.toMatch(/\brequire\s*\(/);
  });

  it('returns resume-ack response before background Telegram work finishes', async () => {
    const deferred = makeDeferred();
    const store = {
      get: vi.fn(() => ({ id: 's1', record: { status: 'active' } })),
      save: vi.fn().mockResolvedValue(undefined),
      listActive: vi.fn(() => []),
      data: { sessions: {} },
    };
    const sessionManager = {
      handleResumeAcknowledged: vi.fn(() => deferred.promise),
      handleWorking: vi.fn(),
    };

    const app = createDaemonApp({
      store: store as any,
      replyQueue: { deliver: vi.fn() } as any,
      sessionManager: sessionManager as any,
    });

    const response = await app.request('http://localhost/hook/resume-ack', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 's1' }),
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      status: 'accepted',
      session_id: 's1',
    });
    expect(sessionManager.handleResumeAcknowledged).toHaveBeenCalledWith({
      session_id: 's1',
    });
    expect(store.save).not.toHaveBeenCalled();

    deferred.resolve();
    await vi.waitFor(() => {
      expect(store.save).toHaveBeenCalledTimes(1);
    });
  });

  it('returns working response before background progress work finishes', async () => {
    const deferred = makeDeferred();
    const store = {
      get: vi.fn(() => ({ id: 's1', record: { status: 'active' } })),
      save: vi.fn().mockResolvedValue(undefined),
      listActive: vi.fn(() => []),
      data: { sessions: {} },
    };
    const sessionManager = {
      handleResumeAcknowledged: vi.fn(),
      handleWorking: vi.fn(() => deferred.promise),
    };

    const app = createDaemonApp({
      store: store as any,
      replyQueue: { deliver: vi.fn() } as any,
      sessionManager: sessionManager as any,
    });

    const response = await app.request('http://localhost/hook/working', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 's1' }),
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      status: 'accepted',
      session_id: 's1',
    });
    expect(sessionManager.handleWorking).toHaveBeenCalledWith({
      session_id: 's1',
    });
    expect(store.save).not.toHaveBeenCalled();

    deferred.resolve();
    await vi.waitFor(() => {
      expect(store.save).toHaveBeenCalledTimes(1);
    });
  });

  it('queues resume-ack from stop-and-wait block responses before returning', async () => {
    const deferred = makeDeferred();
    const store = {
      get: vi.fn(() => ({ id: 's1', record: { status: 'active', total_turns: 4 } })),
      save: vi.fn().mockResolvedValue(undefined),
      listActive: vi.fn(() => []),
      data: { sessions: {} },
    };
    const sessionManager = {
      handleStopAndWait: vi.fn().mockResolvedValue({
        decision: 'block',
        reason: 'resume from telegram',
      }),
      handleResumeAcknowledged: vi.fn(() => deferred.promise),
      handleWorking: vi.fn(),
    };

    const app = createDaemonApp({
      store: store as any,
      replyQueue: { deliver: vi.fn() } as any,
      sessionManager: sessionManager as any,
    });

    const response = await app.request('http://localhost/hook/stop-and-wait', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: 's1',
        turn_id: 'turn-1',
        last_assistant_message: 'done',
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      decision: 'block',
      reason: 'resume from telegram',
      resume_ack_queued: true,
    });
    expect(sessionManager.handleStopAndWait).toHaveBeenCalled();
    expect(sessionManager.handleResumeAcknowledged).toHaveBeenCalledWith({
      session_id: 's1',
    });
    expect(store.save).toHaveBeenCalledTimes(1);

    deferred.resolve();
    await vi.waitFor(() => {
      expect(store.save).toHaveBeenCalledTimes(2);
    });
  });

  it('does not queue the /resume control signal when no waiting consumer exists', async () => {
    const store = {
      get: vi.fn(() => ({ id: 's1', record: { status: 'waiting' } })),
      update: vi.fn(),
      save: vi.fn().mockResolvedValue(undefined),
      listActive: vi.fn(() => []),
      listAll: vi.fn(() => []),
    };
    const replyQueue = {
      deliver: vi.fn().mockReturnValue(false),
    };

    const app = createDaemonApp({
      store: store as any,
      replyQueue: replyQueue as any,
      sessionManager: {} as any,
    });

    const response = await app.request('http://localhost/hook/resume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 's1' }),
    });

    expect(response.status).toBe(200);
    expect(replyQueue.deliver).toHaveBeenCalledWith('s1', '/resume', {
      queueIfMissing: false,
    });
  });

  it('disables /hook/mock-reply unless explicitly enabled', async () => {
    const previous = process.env.TL_ENABLE_MOCK_REPLY;
    delete process.env.TL_ENABLE_MOCK_REPLY;

    const app = createDaemonApp({
      store: {} as any,
      replyQueue: {} as any,
      sessionManager: {} as any,
    });

    const response = await app.request('http://localhost/hook/mock-reply?session_id=s1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ replyText: 'hello' }),
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'mock-reply disabled' });

    if (previous === undefined) {
      delete process.env.TL_ENABLE_MOCK_REPLY;
    } else {
      process.env.TL_ENABLE_MOCK_REPLY = previous;
    }
  });
});

function makeDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
