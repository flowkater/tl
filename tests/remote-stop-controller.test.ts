import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RemoteStopController } from '../src/remote-stop-controller.js';
import type { SessionRecord } from '../src/types.js';

function makeRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  const now = new Date().toISOString();
  return {
    status: 'active',
    mode: 'remote-managed',
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
    remote_input_owner: 'telegram',
    remote_status: 'attached',
    remote_endpoint: 'ws://127.0.0.1:4321',
    remote_thread_id: 'thread-1',
    remote_last_turn_id: null,
    remote_last_injection_at: null,
    remote_last_injection_error: null,
    remote_last_resume_at: null,
    remote_last_resume_error: null,
    remote_last_error: null,
    remote_last_recovery_at: null,
    remote_worker_pid: null,
    remote_worker_log_path: null,
    remote_worker_started_at: null,
    remote_worker_last_error: null,
    ...overrides,
  };
}

describe('RemoteStopController', () => {
  let store: any;
  let client: any;
  let fallback: any;
  let runtime: any;
  let workerRuntime: any;
  let notifyDelivered: any;
  let notifyFailed: any;
  let notifyRecovering: any;
  let publishTurnOutput: any;
  let settleTurnDeferred:
    | { promise: Promise<{ status: string | null }>; resolve: (value: { status: string | null }) => void }
    | null;

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
      waitForTurnToSettle: vi.fn().mockImplementation(() => {
        if (settleTurnDeferred) {
          return settleTurnDeferred.promise;
        }
        return new Promise(() => {});
      }),
      resumeThread: vi.fn().mockResolvedValue({
        threadId: 'thread-1',
      }),
    };
    fallback = {
      handle: vi.fn().mockResolvedValue(true),
    };
    runtime = {
      ensureAvailable: vi.fn().mockResolvedValue(true),
    };
    workerRuntime = {
      ensureAttached: vi.fn().mockResolvedValue({
        started: true,
        pid: 4242,
        logPath: '/tmp/remote-worker.log',
      }),
    };
    notifyDelivered = vi.fn().mockResolvedValue(undefined);
    notifyFailed = vi.fn().mockResolvedValue(undefined);
    notifyRecovering = vi.fn().mockResolvedValue(undefined);
    publishTurnOutput = vi.fn().mockResolvedValue(900);
    settleTurnDeferred = null;
  });

  it('injects into app-server instead of launching late-reply resume for remote sessions', async () => {
    store._sessions.s1.remote_last_resume_error = 'stale resume error';
    const controller = new RemoteStopController(store, client, fallback, runtime, workerRuntime, undefined, {
      notifyDelivered,
      notifyFailed,
      notifyRecovering,
      publishTurnOutput,
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
    expect(workerRuntime.ensureAttached).toHaveBeenCalledWith({
      sessionId: 's1',
      endpoint: 'ws://127.0.0.1:4321',
      cwd: '/tmp/test',
      knownPid: null,
      knownLogPath: null,
    });
    expect(fallback.handle).not.toHaveBeenCalled();
    expect(notifyDelivered).toHaveBeenCalledWith('s1');
    expect(store._sessions.s1.remote_last_turn_id).toBe('turn-2');
    expect(store._sessions.s1.remote_last_resume_error).toBeNull();
    expect(store._sessions.s1.remote_status).toBe('running');
    expect(store._sessions.s1.remote_last_error).toBeNull();
  });

  it('falls back to late-reply resume when remote injection fails', async () => {
    client.injectReply.mockRejectedValueOnce(new Error('socket closed'));
    runtime.ensureAvailable.mockRejectedValueOnce(new Error('restart failed'));
    client.resumeThread.mockRejectedValueOnce(new Error('resume failed'));
    const controller = new RemoteStopController(store, client, fallback, runtime, workerRuntime, undefined, {
      notifyDelivered,
      notifyFailed,
      notifyRecovering,
      publishTurnOutput,
    });

    const result = await controller.handleReply('s1', 'continue here');

    expect(result).toEqual({
      handled: true,
      mode: 'fallback',
    });
    expect(fallback.handle).toHaveBeenCalledWith('s1', 'continue here');
    expect(notifyRecovering).toHaveBeenNthCalledWith(1, 's1', 'reconnect');
    expect(notifyRecovering).toHaveBeenNthCalledWith(2, 's1', 'resume');
    expect(notifyRecovering).toHaveBeenNthCalledWith(3, 's1', 'fallback');
    expect(notifyDelivered).not.toHaveBeenCalled();
    expect(notifyFailed).toHaveBeenCalledWith('s1', 'resume failed');
    expect(store._sessions.s1.remote_last_injection_error).toBe('restart failed');
    expect(store._sessions.s1.remote_last_resume_error).toBe('resume failed');
    expect(store._sessions.s1.remote_status).toBe('degraded');
    expect(store._sessions.s1.remote_last_error).toBe('resume failed');
  });

  it('restarts app-server and retries remote injection before falling back', async () => {
    client.injectReply
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED'))
      .mockResolvedValueOnce({
        mode: 'start',
        turnId: 'turn-3',
      });

    const controller = new RemoteStopController(store, client, fallback, runtime, workerRuntime, undefined, {
      notifyDelivered,
      notifyFailed,
      notifyRecovering,
      publishTurnOutput,
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
    expect(notifyRecovering).toHaveBeenCalledWith('s1', 'reconnect');
    expect(notifyDelivered).toHaveBeenCalledWith('s1');
    expect(store._sessions.s1.remote_last_turn_id).toBe('turn-3');
    expect(store._sessions.s1.remote_last_injection_error).toBeNull();
    expect(store._sessions.s1.remote_last_error).toBeNull();
    expect(store._sessions.s1.remote_last_recovery_at).not.toBeNull();
  });

  it('resumes the remote thread and retries injection before local fallback', async () => {
    client.injectReply
      .mockRejectedValueOnce(new Error('socket closed'))
      .mockRejectedValueOnce(new Error('thread missing'))
      .mockResolvedValueOnce({
        mode: 'start',
        turnId: 'turn-9',
      });

    const controller = new RemoteStopController(store, client, fallback, runtime, workerRuntime, undefined, {
      notifyDelivered,
      notifyFailed,
      notifyRecovering,
      publishTurnOutput,
    });

    const result = await controller.handleReply('s1', 'recover remotely');

    expect(result).toEqual({
      handled: true,
      mode: 'remote',
      turnId: 'turn-9',
    });
    expect(runtime.ensureAvailable).toHaveBeenCalledWith(
      'ws://127.0.0.1:4321',
      '/tmp/test'
    );
    expect(client.resumeThread).toHaveBeenCalledWith({
      endpoint: 'ws://127.0.0.1:4321',
      threadId: 'thread-1',
      cwd: '/tmp/test',
    });
    expect(client.injectReply).toHaveBeenCalledTimes(3);
    expect(fallback.handle).not.toHaveBeenCalled();
    expect(notifyRecovering).toHaveBeenNthCalledWith(1, 's1', 'reconnect');
    expect(notifyRecovering).toHaveBeenNthCalledWith(2, 's1', 'resume');
    expect(store._sessions.s1.remote_last_resume_at).not.toBeNull();
    expect(store._sessions.s1.remote_last_resume_error).toBeNull();
    expect(store._sessions.s1.remote_status).toBe('running');
    expect(store._sessions.s1.remote_last_error).toBeNull();
  });

  it('marks the remote session idle once the injected turn settles', async () => {
    let resolve!: (value: { status: string | null }) => void;
    settleTurnDeferred = {
      promise: new Promise((r) => {
        resolve = r;
      }),
      resolve,
    };
    const controller = new RemoteStopController(store, client, fallback, runtime, workerRuntime, undefined, {
      notifyDelivered,
      notifyFailed,
      notifyRecovering,
      publishTurnOutput,
    });

    const result = await controller.handleReply('s1', 'continue here');
    expect(result).toEqual({
      handled: true,
      mode: 'remote',
      turnId: 'turn-2',
    });
    expect(store._sessions.s1.remote_status).toBe('running');

    settleTurnDeferred.resolve({ status: 'completed', outputText: 'remote answer' });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(store._sessions.s1.remote_status).toBe('idle');
    expect(store._sessions.s1.remote_last_error).toBeNull();
    expect(store._sessions.s1.total_turns).toBe(2);
    expect(store._sessions.s1.last_turn_output).toBe('remote answer');
    expect(store._sessions.s1.stop_message_id).toBe(900);
    expect(publishTurnOutput).toHaveBeenCalledWith('s1', {
      turnId: 'turn-2',
      outputText: 'remote answer',
      totalTurns: 2,
    });
  });
});
