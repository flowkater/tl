import { describe, expect, it, vi } from 'vitest';
import { LocalManagedOpenController } from '../src/local-managed-open-controller.js';
import type { SessionRecord } from '../src/types.js';

function makeSessionRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    status: 'active',
    mode: 'local-managed',
    chat_id: -1003807367724,
    project: 'poc',
    cwd: '/tmp/poc',
    model: 'gpt-5.4',
    topic_id: 701,
    start_message_id: 801,
    started_at: new Date().toISOString(),
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
    local_bridge_enabled: true,
    local_bridge_state: 'attached',
    local_input_queue_depth: 0,
    local_last_input_source: null,
    local_last_input_at: null,
    local_last_injection_error: null,
    local_attachment_id: 'tl-open-poc',
    remote_mode_enabled: true,
    remote_input_owner: 'tui',
    remote_status: 'attached',
    remote_endpoint: 'ws://127.0.0.1:8795',
    remote_thread_id: 'thread-1',
    remote_last_turn_id: null,
    remote_last_injection_at: null,
    remote_last_injection_error: null,
    remote_last_resume_at: null,
    remote_last_resume_error: null,
    remote_last_error: null,
    remote_last_recovery_at: null,
    remote_worker_pid: null,
    remote_worker_log_path: '/tmp/tl-open.log',
    remote_worker_started_at: null,
    remote_worker_last_error: null,
    ...overrides,
  };
}

describe('local-managed-open-controller', () => {
  it('adopts a blank local open when a new app-server thread appears', async () => {
    const sessions = new Map<string, SessionRecord>();
    const store = {
      get: vi.fn((id: string) => {
        const record = sessions.get(id);
        return record ? { id, record } : undefined;
      }),
      update: vi.fn((id: string, fn: (record: SessionRecord) => void) => {
        const record = sessions.get(id);
        if (!record) {
          throw new Error(`Missing session ${id}`);
        }
        fn(record);
      }),
      save: vi.fn().mockResolvedValue(undefined),
      listAll: vi.fn(() => Array.from(sessions.entries()).map(([id, record]) => ({ id, record }))),
    };

    const sessionManager = {
      handleSessionStart: vi.fn(async (args: any) => {
        sessions.set(
          args.session_id,
          makeSessionRecord({
            project: args.project,
            cwd: args.cwd,
            model: args.model,
            local_attachment_id: args.local_attachment_id,
            remote_endpoint: args.remote_endpoint,
            remote_thread_id: args.remote_thread_id,
            remote_last_turn_id: args.turn_id || null,
            last_user_message: args.last_user_message,
          })
        );
      }),
      handleWorking: vi.fn().mockResolvedValue(undefined),
      handleManagedTurnSettled: vi.fn().mockResolvedValue(undefined),
    };

    const nowSeconds = Math.floor(Date.now() / 1000);
    let listCalls = 0;
    const client = {
      listThreads: vi.fn(async () => {
        listCalls += 1;
        if (listCalls === 1) {
          return [{ id: 'existing-thread', cwd: '/tmp/poc', updatedAt: nowSeconds - 20 }];
        }
        return [
          { id: 'existing-thread', cwd: '/tmp/poc', updatedAt: nowSeconds - 20 },
          { id: 'thread-blank-open', cwd: '/tmp/poc', updatedAt: nowSeconds },
        ];
      }),
      readThreadSnapshot: vi.fn().mockResolvedValue({
        unavailableBeforeFirstUserMessage: false,
        turns: [
          {
            id: 'turn-1',
            status: 'inProgress',
            outputText: '',
            userText: 'hello from blank open',
          },
        ],
        latestTurn: {
          id: 'turn-1',
          status: 'inProgress',
          outputText: '',
          userText: 'hello from blank open',
        },
      }),
    };

    const publishTurnOutput = vi.fn().mockResolvedValue(null);

    const controller = new LocalManagedOpenController(
      store as any,
      sessionManager as any,
      client as any,
      publishTurnOutput,
      {
        pendingPollIntervalMs: 5,
        monitorPollIntervalMs: 1_000,
      }
    );

    try {
      await controller.registerPendingOpen({
        attachmentId: 'tl-open-session',
        logPath: '/tmp/tl-open.log',
        cwd: '/tmp/poc',
        project: 'blank-open-project',
        model: 'gpt-5.4',
        endpoint: 'ws://127.0.0.1:8795',
        knownThreadIds: ['existing-thread'],
      });

      await vi.waitFor(() => {
        expect(sessionManager.handleSessionStart).toHaveBeenCalledWith(
          expect.objectContaining({
            session_id: 'thread-blank-open',
            session_mode: 'local-managed',
            local_attachment_id: 'tl-open-session',
          })
        );
      });

      const adopted = sessions.get('thread-blank-open');
      expect(adopted?.local_attachment_id).toBe('tl-open-session');
      expect(adopted?.remote_status).toBe('running');
      expect(adopted?.remote_input_owner).toBe('tui');
      expect(adopted?.last_user_message).toBe('hello from blank open');
      expect(sessionManager.handleWorking).toHaveBeenCalledWith({
        session_id: 'thread-blank-open',
      });
      expect(publishTurnOutput).not.toHaveBeenCalled();
    } finally {
      controller.shutdown();
    }
  });

  it('publishes a stop message when a local-managed TUI turn settles', async () => {
    const sessions = new Map<string, SessionRecord>([
      [
        'thread-1',
        makeSessionRecord({
          remote_thread_id: 'thread-1',
          remote_last_turn_id: 'turn-1',
          remote_status: 'running',
          last_user_message: 'hello',
          last_progress_at: '2026-04-08T06:40:00.000Z',
          last_heartbeat_at: '2026-04-08T06:42:00.000Z',
        }),
      ],
    ]);

    const store = {
      get: vi.fn((id: string) => {
        const record = sessions.get(id);
        return record ? { id, record } : undefined;
      }),
      update: vi.fn((id: string, fn: (record: SessionRecord) => void) => {
        const record = sessions.get(id);
        if (!record) {
          throw new Error(`Missing session ${id}`);
        }
        fn(record);
      }),
      save: vi.fn().mockResolvedValue(undefined),
      listAll: vi.fn(() => Array.from(sessions.entries()).map(([id, record]) => ({ id, record }))),
    };

    const sessionManager = {
      handleSessionStart: vi.fn().mockResolvedValue(undefined),
      handleWorking: vi.fn().mockResolvedValue(undefined),
      handleManagedTurnSettled: vi.fn(async (args: any) => {
        const record = sessions.get(args.session_id);
        if (!record) {
          throw new Error(`Missing session ${args.session_id}`);
        }
        record.total_turns = args.total_turns;
        record.last_turn_output = args.last_message;
        record.last_progress_at = null;
        record.last_heartbeat_at = null;
        record.remote_last_turn_id = args.turn_id;
        record.remote_status = 'idle';
        record.remote_input_owner = args.remote_input_owner ?? record.remote_input_owner;
        record.remote_last_error = null;
        if (args.last_user_message != null) {
          record.last_user_message = args.last_user_message;
        }
      }),
    };

    const client = {
      readThreadSnapshot: vi.fn().mockResolvedValue({
        unavailableBeforeFirstUserMessage: false,
        turns: [
          {
            id: 'turn-1',
            status: 'completed',
            outputText: 'finished output',
            userText: 'hello',
          },
        ],
        latestTurn: {
          id: 'turn-1',
          status: 'completed',
          outputText: 'finished output',
          userText: 'hello',
        },
      }),
    };

    const publishTurnOutput = vi.fn().mockResolvedValue(9901);

    const controller = new LocalManagedOpenController(
      store as any,
      sessionManager as any,
      client as any,
      publishTurnOutput,
      {
        pendingPollIntervalMs: 1_000,
        monitorPollIntervalMs: 5,
      }
    );

    try {
      controller.restoreSessionMonitors();

      await vi.waitFor(() => {
        expect(publishTurnOutput).toHaveBeenCalledWith('thread-1', {
          turnId: 'turn-1',
          outputText: 'finished output',
          totalTurns: 1,
        });
      });

      const record = sessions.get('thread-1');
      expect(sessionManager.handleManagedTurnSettled).toHaveBeenCalledWith({
        session_id: 'thread-1',
        turn_id: 'turn-1',
        last_message: 'finished output',
        total_turns: 1,
        last_user_message: 'hello',
        remote_input_owner: 'tui',
      });
      expect(record?.remote_status).toBe('idle');
      expect(record?.total_turns).toBe(1);
      expect(record?.last_turn_output).toBe('finished output');
      expect(record?.stop_message_id).toBe(9901);
      expect(record?.last_progress_at).toBeNull();
      expect(record?.last_heartbeat_at).toBeNull();
    } finally {
      controller.shutdown();
    }
  });
});
