import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RemoteStopController } from '../src/remote-stop-controller.js';
import type { SessionRecord } from '../src/types.js';

function makeRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  const now = new Date().toISOString();
  return {
    status: 'active',
    project: 'test',
    cwd: '/tmp/test',
    model: 'gpt-4.1',
    topic_id: 42,
    start_message_id: 100,
    started_at: now,
    completed_at: null,
    stop_message_id: 500,
    reply_message_id: null,
    total_turns: 1,
    last_user_message: '',
    last_turn_output: 'done',
    last_progress_at: null,
    last_heartbeat_at: null,
    last_resume_ack_at: null,
    late_reply_text: null,
    late_reply_received_at: null,
    late_reply_resume_started_at: null,
    late_reply_resume_error: null,
    remote_mode_enabled: true,
    remote_endpoint: 'ws://127.0.0.1:4321',
    remote_thread_id: 'thread-1',
    remote_last_turn_id: null,
    remote_last_injection_at: null,
    remote_last_injection_error: null,
    ...overrides,
  };
}

describe('RemoteStopController', () => {
  let store: any;
  let client: any;
  let fallback: any;
  let runtime: any;
  let notifyDelivered: any;
  let notifyFailed: any;

  beforeEach(() => {
    const sessions: Record<string, SessionRecord> = {
      s1: makeRecord(),
    };
    store = {
      get: vi.fn((id: string) => {
        const record = sessions[id];
        return record ? { id, record } : undefined;
      }),
      update: vi.fn((id: string, fn: (record: SessionRecord) => void) => {
        fn(sessions[id]);
      }),
      save: vi.fn().mockResolvedValue(undefined),
      _sessions: sessions,
    };
    client = {
      injectReply: vi.fn().mockResolvedValue({
        mode: 'start',
        turnId: 'turn-2',
      }),
    };
    fallback = {
      handle: vi.fn().mockResolvedValue(true),
    };
    runtime = {
      ensureAvailable: vi.fn().mockResolvedValue(true),
    };
    notifyDelivered = vi.fn().mockResolvedValue(undefined);
    notifyFailed = vi.fn().mockResolvedValue(undefined);
  });

  it('injects into app-server instead of launching late-reply resume for remote sessions', async () => {
    const controller = new RemoteStopController(store, client, fallback, runtime, {
      notifyDelivered,
      notifyFailed,
    });

    const result = await controller.handleReply('s1', 'continue here');

    expect(result).toEqual({
      handled: true,
      mode: 'remote',
      turnId: 'turn-2',
    });
    expect(client.injectReply).toHaveBeenCalledWith({
      endpoint: 'ws://127.0.0.1:4321',
      threadId: 'thread-1',
      replyText: 'continue here',
    });
    expect(fallback.handle).not.toHaveBeenCalled();
    expect(notifyDelivered).toHaveBeenCalledWith('s1');
    expect(store._sessions.s1.remote_last_turn_id).toBe('turn-2');
  });

  it('falls back to late-reply resume when remote injection fails', async () => {
    client.injectReply.mockRejectedValueOnce(new Error('socket closed'));
    runtime.ensureAvailable.mockRejectedValueOnce(new Error('restart failed'));
    const controller = new RemoteStopController(store, client, fallback, runtime, {
      notifyDelivered,
      notifyFailed,
    });

    const result = await controller.handleReply('s1', 'continue here');

    expect(result).toEqual({
      handled: true,
      mode: 'fallback',
    });
    expect(fallback.handle).toHaveBeenCalledWith('s1', 'continue here');
    expect(notifyDelivered).not.toHaveBeenCalled();
    expect(notifyFailed).toHaveBeenCalledWith('s1', 'socket closed');
    expect(store._sessions.s1.remote_last_injection_error).toBe('socket closed');
  });

  it('restarts app-server and retries remote injection before falling back', async () => {
    client.injectReply
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED'))
      .mockResolvedValueOnce({
        mode: 'start',
        turnId: 'turn-3',
      });

    const controller = new RemoteStopController(store, client, fallback, runtime, {
      notifyDelivered,
      notifyFailed,
    });

    const result = await controller.handleReply('s1', 'continue after restart');

    expect(result).toEqual({
      handled: true,
      mode: 'remote',
      turnId: 'turn-3',
    });
    expect(runtime.ensureAvailable).toHaveBeenCalledWith(
      'ws://127.0.0.1:4321',
      '/tmp/test'
    );
    expect(client.injectReply).toHaveBeenCalledTimes(2);
    expect(fallback.handle).not.toHaveBeenCalled();
    expect(notifyDelivered).toHaveBeenCalledWith('s1');
    expect(store._sessions.s1.remote_last_turn_id).toBe('turn-3');
    expect(store._sessions.s1.remote_last_injection_error).toBeNull();
  });
});
