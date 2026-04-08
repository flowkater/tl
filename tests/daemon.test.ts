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
      body: JSON.stringify({ session_id: 's1', prompt: 'continue' }),
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      status: 'accepted',
      session_id: 's1',
    });
    expect(sessionManager.handleWorking).toHaveBeenCalledWith({
      session_id: 's1',
      prompt: 'continue',
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

  it('attaches remote thread metadata through the daemon endpoint', async () => {
    const session = {
      status: 'active',
      mode: 'local',
      chat_id: -1001234567890,
      project: 'test',
      cwd: '/tmp/test',
      model: 'gpt-4.1',
      topic_id: 42,
      start_message_id: 100,
      started_at: new Date().toISOString(),
      completed_at: null,
      stop_message_id: null,
      reply_message_id: null,
      total_turns: 1,
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
      remote_input_owner: null,
      remote_status: null,
      remote_endpoint: null,
      remote_thread_id: null,
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
    };
    const store = {
      get: vi.fn(() => ({ id: 's1', record: session })),
      update: vi.fn((_id, fn) => fn(session)),
      save: vi.fn().mockResolvedValue(undefined),
      listActive: vi.fn(() => []),
      listAll: vi.fn(() => [{ id: 's1', record: session }]),
    };

    const app = createDaemonApp({
      store: store as any,
      replyQueue: {} as any,
      sessionManager: {} as any,
    });

    const response = await app.request('http://localhost/remote/attach', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: 's1',
        endpoint: 'ws://127.0.0.1:4321',
        thread_id: 'thread-1',
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'attached',
      session_id: 's1',
      mode: 'remote-managed',
      remote_input_owner: 'telegram',
      remote_status: 'attached',
      endpoint: 'ws://127.0.0.1:4321',
      thread_id: 'thread-1',
      remote_mode_enabled: true,
    });
    expect(session.remote_mode_enabled).toBe(true);
    expect(session.remote_thread_id).toBe('thread-1');
    expect(store.save).toHaveBeenCalledTimes(1);
  });

  it('starts a daemon-owned remote session and injects the initial prompt', async () => {
    const session = {
      status: 'active',
      mode: 'remote-managed',
      chat_id: -1001234567890,
      project: 'poc',
      cwd: '/tmp/poc',
      model: 'gpt-5.4',
      topic_id: 77,
      start_message_id: 100,
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
      remote_mode_enabled: true,
      remote_input_owner: 'telegram',
      remote_status: 'attached',
      remote_endpoint: 'ws://127.0.0.1:9901',
      remote_thread_id: 'thread-1',
      remote_last_turn_id: null,
      remote_last_injection_at: null,
      remote_last_injection_error: null,
      remote_last_resume_at: null,
      remote_last_resume_error: null,
      remote_last_error: null,
      remote_last_recovery_at: null,
      remote_worker_pid: 9001,
      remote_worker_log_path: '/tmp/thread-1.log',
      remote_worker_started_at: new Date().toISOString(),
      remote_worker_last_error: null,
    };
    const store = {
      get: vi.fn((id: string) => (id === 'thread-1' ? { id, record: session } : undefined)),
      save: vi.fn().mockResolvedValue(undefined),
      listActive: vi.fn(() => []),
    };
    const sessionManager = {
      handleSessionStart: vi.fn().mockResolvedValue(undefined),
    };
    const appServerRuntime = {
      ensureAvailable: vi.fn().mockResolvedValue(true),
    };
    const appServerClient = {
      createThread: vi.fn().mockResolvedValue({ threadId: 'thread-1' }),
    };
    const remoteWorkerRuntime = {};
    const remoteStopController = {
      ensureWorkerAttached: vi.fn().mockResolvedValue(undefined),
      handleReply: vi.fn().mockResolvedValue({
        handled: true,
        mode: 'remote',
        turnId: 'turn-1',
      }),
    };

    const app = createDaemonApp({
      store: store as any,
      replyQueue: {} as any,
      sessionManager: sessionManager as any,
      remoteStopController: remoteStopController as any,
      appServerClient: appServerClient as any,
      appServerRuntime: appServerRuntime as any,
      remoteWorkerRuntime: remoteWorkerRuntime as any,
    });

    const response = await app.request('http://localhost/remote/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cwd: '/tmp/poc',
        model: 'gpt-5.4',
        initial_text: 'hello remote',
        project: 'poc',
        endpoint: 'ws://127.0.0.1:9901',
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: 'started',
      session_id: 'thread-1',
      topic_id: 77,
      mode: 'remote-managed',
      remote_input_owner: 'telegram',
      remote_status: 'attached',
      turn_id: 'turn-1',
      total_turns: 0,
      pristine: true,
    });
    expect(appServerRuntime.ensureAvailable).toHaveBeenCalledWith('ws://127.0.0.1:9901', '/tmp/poc');
    expect(appServerClient.createThread).toHaveBeenCalled();
    expect(remoteStopController.ensureWorkerAttached).toHaveBeenCalledWith(
      'thread-1',
      'ws://127.0.0.1:9901',
      '/tmp/poc'
    );
    expect(sessionManager.handleSessionStart.mock.invocationCallOrder[0]).toBeLessThan(
      remoteStopController.ensureWorkerAttached.mock.invocationCallOrder[0]
    );
    expect(sessionManager.handleSessionStart).toHaveBeenCalledWith({
      session_id: 'thread-1',
      model: 'gpt-5.4',
      turn_id: '',
      project: 'poc',
      cwd: '/tmp/poc',
      last_user_message: 'hello remote',
      remote_endpoint: 'ws://127.0.0.1:9901',
      remote_thread_id: 'thread-1',
    });
    expect(remoteStopController.handleReply).toHaveBeenCalledWith('thread-1', 'hello remote');
  });

  it('starts a daemon-owned local managed session on the configured local endpoint', async () => {
    const session = {
      status: 'active',
      mode: 'remote-managed',
      chat_id: -1001234567890,
      project: 'poc',
      cwd: '/tmp/poc',
      model: 'gpt-5.4',
      topic_id: 91,
      start_message_id: 100,
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
      local_attachment_id: 'tl-local-thread-local-1',
      remote_mode_enabled: true,
      remote_input_owner: 'telegram',
      remote_status: 'attached',
      remote_endpoint: 'ws://127.0.0.1:8795',
      remote_thread_id: 'thread-local-1',
      remote_last_turn_id: null,
      remote_last_injection_at: null,
      remote_last_injection_error: null,
      remote_last_resume_at: null,
      remote_last_resume_error: null,
      remote_last_error: null,
      remote_last_recovery_at: null,
      remote_worker_pid: 9003,
      remote_worker_log_path: '/tmp/thread-local-1.log',
      remote_worker_started_at: new Date().toISOString(),
      remote_worker_last_error: null,
    };
    const store = {
      get: vi.fn((id: string) => (id === 'thread-local-1' ? { id, record: session } : undefined)),
      update: vi.fn((_id: string, fn: (record: typeof session) => void) => fn(session)),
      save: vi.fn().mockResolvedValue(undefined),
      listActive: vi.fn(() => []),
    };
    const sessionManager = {
      handleSessionStart: vi.fn().mockResolvedValue(undefined),
    };
    const appServerRuntime = {
      ensureAvailable: vi.fn().mockResolvedValue(true),
    };
    const appServerClient = {
      createThread: vi.fn().mockResolvedValue({ threadId: 'thread-local-1' }),
      injectLocalInput: vi.fn().mockResolvedValue({ mode: 'start', turnId: 'turn-local-1' }),
      waitForThreadLoaded: vi.fn().mockResolvedValue(true),
    };
    const remoteStopController = {
      ensureWorkerAttached: vi.fn().mockResolvedValue(undefined),
      ensureLocalConsoleAttached: vi.fn().mockImplementation(async () => {
        session.local_attachment_id = 'tl-local-thread-local-1';
        session.local_bridge_state = 'attached';
        session.remote_worker_log_path = '/tmp/thread-local-1.log';
      }),
      handleReply: vi.fn().mockResolvedValue(null),
    };
    const localConsoleRuntime = {
      ensureAttached: vi.fn().mockResolvedValue({
        started: true,
        attachmentId: 'tl-local-thread-local-1',
        logPath: '/tmp/thread-local-1.log',
      }),
    };

    const app = createDaemonApp({
      store: store as any,
      replyQueue: {} as any,
      sessionManager: sessionManager as any,
      remoteStopController: remoteStopController as any,
      appServerClient: appServerClient as any,
      appServerRuntime: appServerRuntime as any,
      remoteWorkerRuntime: {} as any,
      localConsoleRuntime: localConsoleRuntime as any,
      config: {
        localCodexEndpoint: 'ws://127.0.0.1:8795',
      } as any,
    });

    const response = await app.request('http://localhost/local/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cwd: '/tmp/poc',
        model: 'gpt-5.4',
        initial_text: 'bootstrap local session',
        project: 'poc',
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: 'started',
      session_id: 'thread-local-1',
      topic_id: 91,
      mode: 'local-managed',
      endpoint: 'ws://127.0.0.1:8795',
      thread_id: 'thread-local-1',
      attachment_id: 'tl-local-thread-local-1',
      turn_id: 'turn-local-1',
      total_turns: 0,
      pristine: true,
    });
    expect(appServerRuntime.ensureAvailable).toHaveBeenCalledWith('ws://127.0.0.1:8795', '/tmp/poc');
    expect(appServerClient.createThread).toHaveBeenCalledWith({
      endpoint: 'ws://127.0.0.1:8795',
      cwd: '/tmp/poc',
    });
    expect(appServerClient.injectLocalInput).toHaveBeenCalledWith({
      endpoint: 'ws://127.0.0.1:8795',
      threadId: 'thread-local-1',
      text: 'bootstrap local session',
    });
    expect(appServerClient.waitForThreadLoaded).toHaveBeenCalledWith({
      endpoint: 'ws://127.0.0.1:8795',
      threadId: 'thread-local-1',
    });
    expect(sessionManager.handleSessionStart).toHaveBeenCalledWith({
      session_id: 'thread-local-1',
      model: 'gpt-5.4',
      turn_id: 'turn-local-1',
      project: 'poc',
      cwd: '/tmp/poc',
      last_user_message: 'bootstrap local session',
      session_mode: 'local-managed',
      local_attachment_id: 'tl-local-thread-local-1',
      remote_endpoint: 'ws://127.0.0.1:8795',
      remote_thread_id: 'thread-local-1',
    });
    expect(localConsoleRuntime.ensureAttached).toHaveBeenCalledWith({
      sessionId: 'thread-local-1',
      endpoint: 'ws://127.0.0.1:8795',
      cwd: '/tmp/poc',
      knownAttachmentId: 'tl-local-thread-local-1',
      knownLogPath: null,
    });
  });

  it('rejects local managed session start without bootstrap text', async () => {
    const app = createDaemonApp({
      store: {
        save: vi.fn().mockResolvedValue(undefined),
        listActive: vi.fn(() => []),
      } as any,
      replyQueue: {} as any,
      sessionManager: {} as any,
      appServerClient: {
        createThread: vi.fn(),
      } as any,
      appServerRuntime: {
        ensureAvailable: vi.fn(),
      } as any,
      remoteWorkerRuntime: {} as any,
      remoteStopController: {} as any,
      localConsoleRuntime: {} as any,
      config: {
        localCodexEndpoint: 'ws://127.0.0.1:8795',
      } as any,
    });

    const response = await app.request('http://localhost/local/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cwd: '/tmp/poc',
        model: 'gpt-5.4',
        initial_text: '',
        project: 'poc',
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Missing initial_text',
    });
  });

  it('registers a blank tl open for daemon-side adoption', async () => {
    const localManagedOpenController = {
      registerPendingOpen: vi.fn().mockResolvedValue(undefined),
    };

    const app = createDaemonApp({
      store: {
        save: vi.fn().mockResolvedValue(undefined),
        listActive: vi.fn(() => []),
      } as any,
      replyQueue: {} as any,
      sessionManager: {} as any,
      localManagedOpenController: localManagedOpenController as any,
      config: {
        localCodexEndpoint: 'ws://127.0.0.1:8795',
      } as any,
    });

    const response = await app.request('http://localhost/local/open/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        attachment_id: 'tl-open-session',
        log_path: '/tmp/tl-open.log',
        cwd: '/tmp/poc',
        project: 'blank-open-project',
        model: 'gpt-5.4',
        known_thread_ids: ['thread-existing-1', 'thread-existing-2'],
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'registered',
      attachment_id: 'tl-open-session',
      cwd: '/tmp/poc',
      project: 'blank-open-project',
      endpoint: 'ws://127.0.0.1:8795',
    });
    expect(localManagedOpenController.registerPendingOpen).toHaveBeenCalledWith({
      attachmentId: 'tl-open-session',
      logPath: '/tmp/tl-open.log',
      cwd: '/tmp/poc',
      project: 'blank-open-project',
      model: 'gpt-5.4',
      endpoint: 'ws://127.0.0.1:8795',
      knownThreadIds: ['thread-existing-1', 'thread-existing-2'],
    });
  });

  it('returns local managed session status with attachment metadata', async () => {
    const session = {
      status: 'active',
      mode: 'remote-managed',
      chat_id: -1001234567890,
      project: 'poc',
      cwd: '/tmp/poc',
      model: 'gpt-5.4',
      topic_id: 91,
      start_message_id: 100,
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
      local_attachment_id: 'tl-local-thread-local-1',
      remote_mode_enabled: true,
      remote_input_owner: 'telegram',
      remote_status: 'attached',
      remote_endpoint: 'ws://127.0.0.1:8795',
      remote_thread_id: 'thread-local-1',
      remote_last_turn_id: null,
      remote_last_injection_at: null,
      remote_last_injection_error: null,
      remote_last_resume_at: null,
      remote_last_resume_error: null,
      remote_last_error: null,
      remote_last_recovery_at: null,
      remote_worker_pid: 9003,
      remote_worker_log_path: '/tmp/thread-local-1.log',
      remote_worker_started_at: new Date().toISOString(),
      remote_worker_last_error: null,
    };
    const store = {
      get: vi.fn(() => ({ id: 'thread-local-1', record: session })),
      save: vi.fn().mockResolvedValue(undefined),
      listActive: vi.fn(() => []),
      listAll: vi.fn(() => [{ id: 'thread-local-1', record: session }]),
    };

    const app = createDaemonApp({
      store: store as any,
      replyQueue: {} as any,
      sessionManager: {} as any,
      config: {
        localCodexEndpoint: 'ws://127.0.0.1:8795',
      } as any,
    });

    const response = await app.request('http://localhost/local/status?session_id=thread-local-1');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      session_id: 'thread-local-1',
      mode: 'local-managed',
      endpoint: 'ws://127.0.0.1:8795',
      thread_id: 'thread-local-1',
      topic_id: 91,
      cwd: '/tmp/poc',
      local_bridge_enabled: true,
      local_bridge_state: 'attached',
      local_attachment_id: 'tl-local-thread-local-1',
      remote_status: 'attached',
      attached: true,
      total_turns: 0,
      pristine: true,
    });
  });

  it('falls back to cwd basename when remote start project is empty', async () => {
    const session = {
      status: 'active',
      mode: 'remote-managed',
      chat_id: -1001234567890,
      project: 'feat-remote-app-server-stop-poc',
      cwd: '/Users/flowkater/Projects/TL/.worktrees/feat-remote-app-server-stop-poc',
      model: 'gpt-5.4',
      topic_id: 88,
      start_message_id: 101,
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
      remote_mode_enabled: true,
      remote_input_owner: 'telegram',
      remote_status: 'attached',
      remote_endpoint: 'ws://127.0.0.1:9902',
      remote_thread_id: 'thread-2',
      remote_last_turn_id: null,
      remote_last_injection_at: null,
      remote_last_injection_error: null,
      remote_last_resume_at: null,
      remote_last_resume_error: null,
      remote_last_error: null,
      remote_last_recovery_at: null,
      remote_worker_pid: 9002,
      remote_worker_log_path: '/tmp/thread-2.log',
      remote_worker_started_at: new Date().toISOString(),
      remote_worker_last_error: null,
    };
    const store = {
      get: vi.fn((id: string) => (id === 'thread-2' ? { id, record: session } : undefined)),
      save: vi.fn().mockResolvedValue(undefined),
      listActive: vi.fn(() => []),
    };
    const sessionManager = {
      handleSessionStart: vi.fn().mockResolvedValue(undefined),
    };
    const appServerRuntime = {
      ensureAvailable: vi.fn().mockResolvedValue(true),
    };
    const appServerClient = {
      createThread: vi.fn().mockResolvedValue({ threadId: 'thread-2' }),
    };
    const remoteStopController = {
      ensureWorkerAttached: vi.fn().mockResolvedValue(undefined),
      handleReply: vi.fn().mockResolvedValue(null),
    };

    const app = createDaemonApp({
      store: store as any,
      replyQueue: {} as any,
      sessionManager: sessionManager as any,
      remoteStopController: remoteStopController as any,
      appServerClient: appServerClient as any,
      appServerRuntime: appServerRuntime as any,
      remoteWorkerRuntime: {} as any,
    });

    const response = await app.request('http://localhost/remote/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cwd: '/Users/flowkater/Projects/TL/.worktrees/feat-remote-app-server-stop-poc',
        model: 'gpt-5.4',
        initial_text: '',
        project: '',
        endpoint: 'ws://127.0.0.1:9902',
      }),
    });

    expect(response.status).toBe(200);
    expect(sessionManager.handleSessionStart).toHaveBeenCalledWith({
      session_id: 'thread-2',
      model: 'gpt-5.4',
      turn_id: '',
      project: 'feat-remote-app-server-stop-poc',
      cwd: '/Users/flowkater/Projects/TL/.worktrees/feat-remote-app-server-stop-poc',
      last_user_message: '',
      remote_endpoint: 'ws://127.0.0.1:9902',
      remote_thread_id: 'thread-2',
    });
  });

  it('returns remote resume diagnostics in remote status responses', async () => {
    const session = {
      status: 'active',
      mode: 'remote-managed',
      chat_id: -1001234567890,
      project: 'test',
      cwd: '/tmp/test',
      model: 'gpt-4.1',
      topic_id: 42,
      start_message_id: 100,
      started_at: new Date().toISOString(),
      completed_at: null,
      stop_message_id: null,
      reply_message_id: null,
      total_turns: 1,
      last_user_message: '',
      last_turn_output: '',
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
      remote_last_turn_id: 'turn-7',
      remote_last_injection_at: null,
      remote_last_injection_error: null,
      remote_last_resume_at: '2026-04-06T13:45:00.000Z',
      remote_last_resume_error: null,
      remote_last_error: null,
      remote_last_recovery_at: '2026-04-06T13:45:00.000Z',
      remote_worker_pid: 777,
      remote_worker_log_path: '/tmp/worker.log',
      remote_worker_started_at: '2026-04-06T13:44:00.000Z',
      remote_worker_last_error: null,
    };
    const store = {
      get: vi.fn(() => ({ id: 's1', record: session })),
      save: vi.fn().mockResolvedValue(undefined),
      listActive: vi.fn(() => []),
      listAll: vi.fn(() => [{ id: 's1', record: session }]),
    };

    const app = createDaemonApp({
      store: store as any,
      replyQueue: {} as any,
      sessionManager: {} as any,
    });

    const response = await app.request('http://localhost/remote/status?session_id=s1');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      session_id: 's1',
      mode: 'remote-managed',
      remote_mode_enabled: true,
      remote_input_owner: 'telegram',
      remote_status: 'attached',
      endpoint: 'ws://127.0.0.1:4321',
      thread_id: 'thread-1',
      cwd: '/tmp/test',
      last_turn_id: 'turn-7',
      last_error: null,
      last_recovery_at: '2026-04-06T13:45:00.000Z',
      last_resume_at: '2026-04-06T13:45:00.000Z',
      last_resume_error: null,
      worker_pid: 777,
      worker_log_path: '/tmp/worker.log',
      worker_last_error: null,
      attached: true,
      total_turns: 1,
      pristine: false,
    });
  });

  it('routes remote inject requests through the remote stop controller', async () => {
    const remoteStopController = {
      handleReply: vi.fn().mockResolvedValue({
        handled: true,
        mode: 'remote',
        turnId: 'turn-2',
      }),
    };

    const app = createDaemonApp({
      store: {} as any,
      replyQueue: {} as any,
      sessionManager: {} as any,
      remoteStopController: remoteStopController as any,
    });

    const response = await app.request('http://localhost/remote/inject', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: 's1',
        reply_text: 'continue remotely',
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      handled: true,
      mode: 'remote',
      turnId: 'turn-2',
    });
    expect(remoteStopController.handleReply).toHaveBeenCalledWith(
      's1',
      'continue remotely'
    );
  });
});

function makeDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
