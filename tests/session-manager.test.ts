import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SessionManagerImpl } from '../src/session-manager.js';
import { SessionsStore } from '../src/store.js';
import { ReplyQueue } from '../src/reply-queue.js';
import { SessionRecord, DaemonConfig, HookOutput } from '../src/types.js';
import { TlError } from '../src/errors.js';

// ===== Mocks =====

function makeStore() {
  const sessions: Record<string, SessionRecord> = {};
  return {
    load: vi.fn().mockResolvedValue(undefined),
    save: vi.fn().mockResolvedValue(undefined),
    get: vi.fn(function (id: string) {
      const r = sessions[id];
      return r ? { id, record: r } : undefined;
    }),
    set: vi.fn(function (id: string, r: SessionRecord) { sessions[id] = r; }),
    create: vi.fn(function (id: string, r: SessionRecord) {
      if (sessions[id]) throw new TlError(`exists`, 'SESSION_EXISTS');
      sessions[id] = r;
    }),
    update: vi.fn(function (id: string, fn: (r: SessionRecord) => void) {
      if (!sessions[id]) throw new TlError(`not found`, 'SESSION_NOT_FOUND');
      fn(sessions[id]);
    }),
    delete: vi.fn(function (id: string) { delete sessions[id]; }),
    listActive: vi.fn(function () {
      return Object.entries(sessions)
        .filter(([, r]) => r.status === 'active' || r.status === 'waiting')
        .map(([id, record]) => ({ id, record }));
    }),
    listByStatus: vi.fn(function (status: string) {
      return Object.entries(sessions)
        .filter(([, r]) => r.status === status)
        .map(([id, record]) => ({ id, record }));
    }),
    archiveCompleted: vi.fn().mockResolvedValue(0),
    _sessions: sessions,
  };
}

function makeReplyQueue() {
  return {
    waitFor: vi.fn(async (_sessionId: string, _timeout: number): Promise<HookOutput> => {
      return { decision: 'continue' };
    }),
    deliver: vi.fn((_sessionId: string, _text: string): boolean => {
      return true;
    }),
    startCleanupInterval: vi.fn(),
    processFileQueue: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn(),
  };
}

function makeTelegramBot() {
  return {
    init: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    createTopic: vi.fn().mockResolvedValue(42),
    sendStartMessage: vi.fn().mockResolvedValue(100),
    sendReconnectMessage: vi.fn().mockResolvedValue(undefined),
    sendStopMessage: vi.fn().mockResolvedValue(200),
    sendCompleteMessage: vi.fn().mockResolvedValue(undefined),
    sendResumeAckMessage: vi.fn().mockResolvedValue(undefined),
    sendWorkingMessage: vi.fn().mockResolvedValue(undefined),
    sendHeartbeatMessage: vi.fn().mockResolvedValue(undefined),
    sendErrorMessage: vi.fn().mockResolvedValue(undefined),
    addReaction: vi.fn().mockResolvedValue(undefined),
    getSessionByTopic: vi.fn(),
    handleResumeCommand: vi.fn().mockResolvedValue(false),
    onReplyReceived: null as ((sessionId: string, text: string) => void) | null,
  };
}

const defaultConfig: DaemonConfig = {
  botToken: 'test-token',
  groupId: -1001234567890,
  topicPrefix: '🔧',
  hookPort: 9877,
  hookBaseUrl: 'http://localhost:9877',
  stopTimeout: 5,
  liveStream: false,
  emojiReaction: '👍',
};

function makeRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  const now = new Date().toISOString();
  return {
    status: 'active',
    project: 'test',
    cwd: '/tmp/test',
    model: 'gpt-4',
    topic_id: 0,
    start_message_id: 0,
    started_at: now,
    completed_at: null,
    stop_message_id: null,
    reply_message_id: null,
    total_turns: 0,
    last_user_message: '',
    last_turn_output: '',
    last_progress_at: null,
    last_heartbeat_at: null,
    last_resume_ack_at: null,
    late_reply_text: null,
    late_reply_received_at: null,
    late_reply_resume_started_at: null,
    late_reply_resume_error: null,
    remote_mode_enabled: false,
    remote_endpoint: null,
    remote_thread_id: null,
    remote_last_turn_id: null,
    remote_last_injection_at: null,
    remote_last_injection_error: null,
    remote_last_resume_at: null,
    remote_last_resume_error: null,
    ...overrides,
  };
}

describe('SessionManagerImpl', () => {
  let store: ReturnType<typeof makeStore>;
  let replyQueue: ReturnType<typeof makeReplyQueue>;
  let tg: ReturnType<typeof makeTelegramBot>;
  let manager: SessionManagerImpl;

  beforeEach(() => {
    store = makeStore();
    replyQueue = makeReplyQueue();
    tg = makeTelegramBot();
    manager = new SessionManagerImpl(
      store as unknown as SessionsStore,
      replyQueue as unknown as ReplyQueue,
      tg as any,
      defaultConfig
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('handleSessionStart', () => {
    it('creates a new session with Telegram topic', async () => {
      await manager.handleSessionStart({
        session_id: 's1',
        model: 'gpt-4',
        turn_id: 't1',
        project: 'myproj',
        cwd: '/tmp/myproj',
        last_user_message: 'hello',
      });

      expect(tg.createTopic).toHaveBeenCalledWith('myproj');
      expect(store.create).toHaveBeenCalledWith('s1', expect.objectContaining({
        status: 'active',
        project: 'myproj',
        topic_id: 42,
        start_message_id: 100,
        chat_id: defaultConfig.groupId,
      }));
      expect(tg.sendStartMessage).toHaveBeenCalled();
    });

    it('does not create a session record if the start message fails', async () => {
      tg.sendStartMessage.mockRejectedValueOnce(new Error('telegram down'));

      await expect(manager.handleSessionStart({
        session_id: 's1',
        model: 'gpt-4',
        turn_id: 't1',
        project: 'myproj',
        cwd: '/tmp/myproj',
        last_user_message: 'hello',
      })).rejects.toThrow('telegram down');

      expect(store.create).not.toHaveBeenCalled();
      expect(store._sessions['s1']).toBeUndefined();
    });

    it('handles reconnection without creating new topic', async () => {
      store._sessions['s1'] = makeRecord({
        status: 'active',
        topic_id: 42,
      });

      await manager.handleSessionStart({
        session_id: 's1',
        model: 'gpt-4',
        turn_id: 't1',
        project: 'myproj',
        cwd: '/tmp/myproj',
        last_user_message: 'hello',
        is_reconnect: true,
      });

      expect(tg.createTopic).not.toHaveBeenCalled();
      expect(tg.sendReconnectMessage).toHaveBeenCalled();
      expect(store._sessions['s1'].status).toBe('active');
    });

    it('throws on invalid state transition for non-reconnect', async () => {
      store._sessions['s1'] = makeRecord({ status: 'waiting' });

      await expect(manager.handleSessionStart({
        session_id: 's1',
        model: 'gpt-4',
        turn_id: 't1',
        project: 'myproj',
        cwd: '/tmp/myproj',
        last_user_message: 'hello',
      })).rejects.toThrow(TlError);

      expect(tg.createTopic).not.toHaveBeenCalled();
      expect(tg.sendStartMessage).not.toHaveBeenCalled();
    });

    it('rejects non-reconnect start attempts for completed sessions before any Telegram side effect', async () => {
      store._sessions['s1'] = makeRecord({ status: 'completed' });

      await expect(manager.handleSessionStart({
        session_id: 's1',
        model: 'gpt-4',
        turn_id: 't1',
        project: 'myproj',
        cwd: '/tmp/myproj',
        last_user_message: 'hello',
      })).rejects.toThrow(TlError);

      expect(tg.createTopic).not.toHaveBeenCalled();
      expect(tg.sendStartMessage).not.toHaveBeenCalled();
    });
  });

  describe('handleStopAndWait', () => {
    it('transitions to waiting and waits for reply', async () => {
      store._sessions['s1'] = makeRecord({
        status: 'active',
        topic_id: 42,
        total_turns: 5,
      });

      const result = await manager.handleStopAndWait({
        session_id: 's1',
        turn_id: 't1',
        last_message: 'AI output',
        total_turns: 5,
      });

      expect(store.update).toHaveBeenCalled();
      expect(tg.sendStopMessage).toHaveBeenCalled();
      expect(result.decision).toBe('continue');
    });

    it('throws if session not found', async () => {
      await expect(manager.handleStopAndWait({
        session_id: 'nope',
        turn_id: 't1',
        last_message: 'x',
        total_turns: 1,
      })).rejects.toThrow(TlError);
    });

    it('throws if session is not active', async () => {
      store._sessions['s1'] = makeRecord({ status: 'waiting' });

      await expect(manager.handleStopAndWait({
        session_id: 's1',
        turn_id: 't1',
        last_message: 'x',
        total_turns: 1,
      })).rejects.toThrow(TlError);
    });

    it('restores active state if stop message delivery fails', async () => {
      store._sessions['s1'] = makeRecord({
        status: 'active',
        topic_id: 42,
        total_turns: 3,
        last_turn_output: 'previous output',
        stop_message_id: 123,
        last_progress_at: '2026-04-06T00:00:00.000Z',
        last_heartbeat_at: '2026-04-06T00:02:00.000Z',
      });
      tg.sendStopMessage.mockRejectedValueOnce(new Error('network down'));

      await expect(manager.handleStopAndWait({
        session_id: 's1',
        turn_id: 't1',
        last_message: 'x',
        total_turns: 1,
      })).rejects.toThrow('network down');

      expect(store._sessions['s1'].status).toBe('active');
      expect(store._sessions['s1'].total_turns).toBe(3);
      expect(store._sessions['s1'].last_turn_output).toBe('previous output');
      expect(store._sessions['s1'].stop_message_id).toBe(123);
      expect(store._sessions['s1'].last_progress_at).toBe('2026-04-06T00:00:00.000Z');
      expect(store._sessions['s1'].last_heartbeat_at).toBe('2026-04-06T00:02:00.000Z');
      expect(replyQueue.waitFor).not.toHaveBeenCalled();
    });

    it('returns continue immediately for remote-attached sessions without touching ReplyQueue.waitFor', async () => {
      store._sessions['s1'] = makeRecord({
        status: 'active',
        topic_id: 42,
        total_turns: 2,
        remote_mode_enabled: true,
        remote_endpoint: 'ws://127.0.0.1:4321',
        remote_thread_id: 'thread-1',
      });

      const result = await manager.handleStopAndWait({
        session_id: 's1',
        turn_id: 't1',
        last_message: 'remote stop output',
        total_turns: 3,
      });

      expect(result).toEqual({ decision: 'continue' });
      expect(replyQueue.waitFor).not.toHaveBeenCalled();
      expect(tg.sendStopMessage).toHaveBeenCalledWith(
        defaultConfig.groupId,
        42,
        't1',
        'remote stop output',
        3
      );
      expect(store._sessions['s1'].status).toBe('active');
      expect(store._sessions['s1'].stop_message_id).toBe(200);
    });
  });

  describe('handleComplete', () => {
    it('marks session as completed', async () => {
      store._sessions['s1'] = makeRecord({
        status: 'active',
        topic_id: 42,
      });

      await manager.handleComplete({
        session_id: 's1',
        total_turns: 10,
        duration: '1h 30m',
      });

      expect(store._sessions['s1'].status).toBe('completed');
      expect(store._sessions['s1'].completed_at).not.toBeNull();
      expect(tg.sendCompleteMessage).toHaveBeenCalled();
    });

    it('keeps the session active if complete message delivery fails', async () => {
      store._sessions['s1'] = makeRecord({
        status: 'active',
        topic_id: 42,
      });
      tg.sendCompleteMessage.mockRejectedValueOnce(new Error('telegram down'));

      await expect(manager.handleComplete({
        session_id: 's1',
        total_turns: 10,
        duration: '1h 30m',
      })).rejects.toThrow('telegram down');

      expect(store._sessions['s1'].status).toBe('active');
      expect(store._sessions['s1'].completed_at).toBeNull();
    });

    it('throws if session not found', async () => {
      await expect(manager.handleComplete({
        session_id: 'nope',
        total_turns: 0,
        duration: '0m',
      })).rejects.toThrow(TlError);
    });

    it('throws if session is not active', async () => {
      store._sessions['s1'] = makeRecord({ status: 'completed' });

      await expect(manager.handleComplete({
        session_id: 's1',
        total_turns: 0,
        duration: '0m',
      })).rejects.toThrow(TlError);
    });
  });

  describe('handleResumeAcknowledged', () => {
    it('sends resume ACK only when explicitly acknowledged after stop reply delivery', async () => {
      store._sessions['s1'] = makeRecord({
        status: 'active',
        topic_id: 42,
      });

      await manager.handleResumeAcknowledged({
        session_id: 's1',
      });

      expect(tg.sendResumeAckMessage).toHaveBeenCalledWith(defaultConfig.groupId, 42);
      expect(store._sessions['s1'].last_resume_ack_at).not.toBeNull();
    });
  });

  describe('handleWorking', () => {
    it('sends a working message on user prompt submit for an active root session', async () => {
      store._sessions['s1'] = makeRecord({
        status: 'active',
        topic_id: 42,
      });

      await manager.handleWorking({
        session_id: 's1',
      });

      expect(tg.sendWorkingMessage).toHaveBeenCalledWith(defaultConfig.groupId, 42);
      expect(store._sessions['s1'].last_progress_at).not.toBeNull();
    });

    it('sends throttled heartbeat messages after working starts', async () => {
      vi.useFakeTimers();
      store._sessions['s1'] = makeRecord({
        status: 'active',
        topic_id: 42,
      });

      await manager.handleWorking({
        session_id: 's1',
      });

      await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
      expect(tg.sendHeartbeatMessage).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
      expect(tg.sendHeartbeatMessage).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1 * 60 * 1000);
      expect(tg.sendHeartbeatMessage).toHaveBeenCalledTimes(2);
    });
  });
});
