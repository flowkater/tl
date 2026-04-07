import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { loadConfig, getConfigDir } from './config.js';
import { SessionsStore } from './store.js';
import { ReplyQueue } from './reply-queue.js';
import { TelegramBot } from './telegram.js';
import { SessionManagerImpl } from './session-manager.js';
import { LateReplyResumer } from './late-reply-resumer.js';
import { HookOutput } from './types.js';
import { logger } from './logger.js';
import { buildStopMessageFromTranscript } from './assistant-turn-output.js';
import { AppServerClient } from './app-server-client.js';
import { AppServerRuntimeManager } from './app-server-runtime.js';
import { RemoteStopController } from './remote-stop-controller.js';
import { attachRemoteSession, clearRemoteSession, hasRemoteSessionAttachment } from './remote-mode.js';
import { RemoteWorkerRuntimeManager } from './remote-worker-runtime.js';

const startTime = Date.now();
const DEFAULT_LOCAL_CODEX_ENDPOINT = 'ws://127.0.0.1:8795';

type DaemonAppDeps = {
  store: SessionsStore;
  replyQueue: ReplyQueue;
  sessionManager: SessionManagerImpl;
  remoteStopController?: RemoteStopController;
  appServerClient?: AppServerClient;
  appServerRuntime?: AppServerRuntimeManager;
  remoteWorkerRuntime?: RemoteWorkerRuntimeManager;
  config?: Partial<ReturnType<typeof loadConfig>>;
};

function getPidPath(): string {
  return `${getConfigDir()}/daemon.pid`;
}

// ===== PID 관리 =====
function acquirePidFile(): number | null {
  const pidPath = getPidPath();
  try {
    const fd = fs.openSync(pidPath, 'wx');
    fs.writeSync(fd, process.pid.toString());
    fs.closeSync(fd);
    return null;
  } catch {
    if (!fs.existsSync(pidPath)) return null;
    const existingPid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
    try {
      process.kill(existingPid, 0);
      return existingPid;
    } catch {
      try { fs.unlinkSync(pidPath); } catch {}
      return acquirePidFile();
    }
  }
}

function releasePidFile(): void {
  try { fs.unlinkSync(getPidPath()); } catch {}
}

function runBackgroundTask(
  name: string,
  context: Record<string, unknown>,
  task: () => Promise<void>
): void {
  void (async () => {
    try {
      await task();
      logger.info(`${name} finished`, context);
    } catch (err) {
      logger.warn(`${name} failed`, {
        ...context,
        error: (err as Error).message,
      });
    }
  })();
}

export function createDaemonApp({
  store,
  replyQueue,
  sessionManager,
  remoteStopController,
  appServerClient,
  appServerRuntime,
  remoteWorkerRuntime,
  config,
}: DaemonAppDeps): Hono {
  const app = new Hono();

  const resolveLocalEndpoint = (override?: string): string => {
    if (override && override.trim().length > 0) {
      return override;
    }
    if (config?.localCodexEndpoint && config.localCodexEndpoint.trim().length > 0) {
      return config.localCodexEndpoint;
    }
    if (config?.remoteCodexEndpoint && config.remoteCodexEndpoint.trim().length > 0) {
      return config.remoteCodexEndpoint;
    }
    return DEFAULT_LOCAL_CODEX_ENDPOINT;
  };

  // ===== POST /hook/session-start =====
  app.post('/hook/session-start', async (c) => {
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    if (!body.session_id) {
      return c.json({ error: 'Missing session_id' }, 400);
    }

    const isReconnect = body.is_reconnect === true;

    try {
      await sessionManager.handleSessionStart({
        session_id: body.session_id,
        model: body.model ?? 'unknown',
        turn_id: body.turn_id ?? '',
        project: body.cwd ? body.cwd.split('/').pop() ?? body.cwd : 'unknown',
        cwd: body.cwd ?? process.cwd(),
        last_user_message: body.last_user_message ?? '',
        is_reconnect: isReconnect,
        remote_endpoint: body.remote_endpoint ?? null,
        remote_thread_id: body.remote_thread_id ?? null,
      });
      await store.save();

      const record = store.get(body.session_id);
      return c.json({
        session_id: body.session_id,
        topic_id: record?.record.topic_id ?? 0,
        status: 'ok',
      });
    } catch (err) {
      const code = (err as any).code === 'SESSION_EXISTS' ? 409 : 500;
      return c.json(
        { error: (err as Error).message },
        code
      );
    }
  });

  // ===== POST /hook/stop-and-wait =====
  app.post('/hook/stop-and-wait', async (c) => {
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    if (!body.session_id) {
      return c.json({ error: 'Missing session_id' }, 400);
    }

    const existing = store.get(body.session_id);
    if (!existing) {
      return c.json({ decision: 'continue' } as HookOutput);
    }

    try {
      const stopMessage = buildStopMessageFromTranscript(
        body.transcript_path,
        body.last_assistant_message ?? ''
      );
      const output = await sessionManager.handleStopAndWait({
        session_id: body.session_id,
        turn_id: body.turn_id ?? '',
        last_message: stopMessage,
        total_turns: existing.record.total_turns + 1,
        abort_signal: c.req.raw.signal,
      });

      // store는 sessionManager가 이미 업데이트함
      await store.save();

      if (output.decision === 'block') {
        runBackgroundTask(
          'Resume ACK background task',
          { session_id: body.session_id, source: 'stop-and-wait' },
          async () => {
            await sessionManager.handleResumeAcknowledged({
              session_id: body.session_id,
            });
            await store.save();
          }
        );

        return c.json({
          ...output,
          resume_ack_queued: true,
        });
      }

      return c.json(output);
    } catch (err) {
      const code = (err as any).code === 'SESSION_NOT_FOUND' ? 404 : 500;
      logger.warn('Stop-and-wait failed', {
        session_id: body.session_id,
        error: (err as Error).message,
      });
      return c.json({ decision: 'continue' } as HookOutput, code);
    }
  });

  // ===== POST /hook/complete =====
  app.post('/hook/complete', async (c) => {
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    if (!body.session_id) {
      return c.json({ error: 'Missing session_id' }, 400);
    }

    try {
      await sessionManager.handleComplete({
        session_id: body.session_id,
        total_turns: body.total_turns ?? 0,
        duration: body.duration ?? 'unknown',
      });
      await store.save();
      return c.json({ status: 'ok' });
    } catch (err) {
      const code = (err as any).code === 'SESSION_NOT_FOUND' ? 404 : 500;
      return c.json({ error: (err as Error).message }, code);
    }
  });

  // ===== POST /hook/resume =====
  app.post('/hook/resume', async (c) => {
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    if (!body.session_id) {
      return c.json({ error: 'Missing session_id' }, 400);
    }

    const existing = store.get(body.session_id);
    if (!existing) {
      return c.json({ error: 'Session not found' }, 404);
    }

    if (existing.record.status !== 'waiting') {
      return c.json(
        { error: `Session is ${existing.record.status}, not waiting` },
        400
      );
    }

    // ReplyQueue에 resume 신호 전달
    const delivered = replyQueue.deliver(body.session_id, '/resume', {
      queueIfMissing: false,
    });
    if (!delivered) {
      // waiting consumer가 없으면 세션만 active로 변경
      store.update(body.session_id, (record) => {
        record.status = 'active';
      });
      await store.save();
    }

    return c.json({ status: 'resumed', session_id: body.session_id });
  });

  // ===== POST /remote/attach =====
  app.post('/remote/attach', async (c) => {
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    if (!body.session_id || !body.thread_id || !body.endpoint) {
      return c.json({ error: 'Missing session_id, thread_id, or endpoint' }, 400);
    }

    const existing = store.get(body.session_id);
    if (!existing) {
      return c.json({ error: 'Session not found' }, 404);
    }

    store.update(body.session_id, (record) => {
      attachRemoteSession(record, {
        endpoint: body.endpoint,
        threadId: body.thread_id,
        lastTurnId: body.last_turn_id ?? null,
      });
    });
    await store.save();

    return c.json({
      status: 'attached',
      session_id: body.session_id,
      mode: existing.record.mode,
      remote_input_owner: existing.record.remote_input_owner,
      remote_status: existing.record.remote_status,
      endpoint: body.endpoint,
      thread_id: body.thread_id,
      remote_mode_enabled: true,
    });
  });

  app.post('/remote/start', async (c) => {
    if (!appServerClient || !appServerRuntime || !remoteWorkerRuntime || !remoteStopController) {
      return c.json({ error: 'Remote managed runtime unavailable' }, 503);
    }

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    if (!body.cwd || !body.endpoint) {
      return c.json({ error: 'Missing cwd or endpoint' }, 400);
    }

    const cwd = body.cwd;
    const model = body.model ?? 'gpt-5.4';
    const initialText = typeof body.initial_text === 'string' ? body.initial_text : '';
    const project = typeof body.project === 'string' && body.project.trim().length > 0
      ? body.project.trim()
      : path.basename(cwd);

    try {
      await appServerRuntime.ensureAvailable(body.endpoint, cwd);
      const thread = await appServerClient.createThread({
        endpoint: body.endpoint,
        cwd,
      });

      await sessionManager.handleSessionStart({
        session_id: thread.threadId,
        model,
        turn_id: '',
        project,
        cwd,
        last_user_message: initialText,
        remote_endpoint: body.endpoint,
        remote_thread_id: thread.threadId,
      });
      await store.save();
      await remoteStopController.ensureWorkerAttached(
        thread.threadId,
        body.endpoint,
        cwd
      );

      let delivery: Awaited<ReturnType<RemoteStopController['handleReply']>> | null = null;
      if (initialText.length > 0) {
        delivery = await remoteStopController.handleReply(thread.threadId, initialText);
      }

      const created = store.get(thread.threadId);
      return c.json({
        status: 'started',
        session_id: thread.threadId,
        topic_id: created?.record.topic_id ?? null,
        mode: created?.record.mode ?? 'remote-managed',
        remote_input_owner: created?.record.remote_input_owner ?? 'telegram',
        remote_status: created?.record.remote_status ?? 'attached',
        turn_id: delivery && 'turnId' in delivery ? delivery.turnId : null,
      });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.post('/local/start', async (c) => {
    if (!appServerClient || !appServerRuntime || !remoteWorkerRuntime || !remoteStopController) {
      return c.json({ error: 'Local managed runtime unavailable' }, 503);
    }

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    if (!body.cwd) {
      return c.json({ error: 'Missing cwd' }, 400);
    }

    const cwd = body.cwd;
    const model = body.model ?? 'gpt-5.4';
    const initialText = typeof body.initial_text === 'string' ? body.initial_text : '';
    const project = typeof body.project === 'string' && body.project.trim().length > 0
      ? body.project.trim()
      : path.basename(cwd);
    const endpoint = resolveLocalEndpoint(body.endpoint);

    try {
      await appServerRuntime.ensureAvailable(endpoint, cwd);
      const thread = await appServerClient.createThread({
        endpoint,
        cwd,
      });

      await sessionManager.handleSessionStart({
        session_id: thread.threadId,
        model,
        turn_id: '',
        project,
        cwd,
        last_user_message: initialText,
        remote_endpoint: endpoint,
        remote_thread_id: thread.threadId,
      });

      store.update(thread.threadId, (record) => {
        record.local_bridge_enabled = true;
        record.local_bridge_state = 'attached';
        record.local_input_queue_depth = 0;
        record.local_last_input_source = null;
        record.local_last_input_at = null;
        record.local_last_injection_error = null;
        record.local_attachment_id = thread.threadId;
      });
      await store.save();

      await remoteStopController.ensureWorkerAttached(
        thread.threadId,
        endpoint,
        cwd
      );

      if (initialText.length > 0) {
        await remoteStopController.handleReply(thread.threadId, initialText);
      }

      const created = store.get(thread.threadId);
      return c.json({
        status: 'started',
        session_id: thread.threadId,
        topic_id: created?.record.topic_id ?? null,
        mode: 'local-managed',
        endpoint,
        thread_id: thread.threadId,
      });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  // ===== POST /remote/detach =====
  app.post('/remote/detach', async (c) => {
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    if (!body.session_id) {
      return c.json({ error: 'Missing session_id' }, 400);
    }

    const existing = store.get(body.session_id);
    if (!existing) {
      return c.json({ error: 'Session not found' }, 404);
    }

    store.update(body.session_id, (record) => {
      clearRemoteSession(record);
    });
    await store.save();

    return c.json({
      status: 'detached',
      session_id: body.session_id,
      mode: existing.record.mode,
      remote_input_owner: existing.record.remote_input_owner,
      remote_status: existing.record.remote_status,
      remote_mode_enabled: false,
    });
  });

  // ===== POST /remote/inject =====
  app.post('/remote/inject', async (c) => {
    if (!remoteStopController) {
      return c.json({ error: 'Remote stop controller unavailable' }, 503);
    }

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    if (!body.session_id || !body.reply_text) {
      return c.json({ error: 'Missing session_id or reply_text' }, 400);
    }

    try {
      const result = await remoteStopController.handleReply(
        body.session_id,
        body.reply_text
      );
      return c.json(result);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  // ===== GET /remote/status =====
  app.get('/remote/status', async (c) => {
    const sessionId = c.req.query('session_id');

    if (sessionId) {
      const existing = store.get(sessionId);
      if (!existing) {
        return c.json({ error: 'Session not found' }, 404);
      }

      return c.json({
        session_id: sessionId,
        mode: existing.record.mode,
        remote_input_owner: existing.record.remote_input_owner,
        remote_mode_enabled: existing.record.remote_mode_enabled,
        remote_status: existing.record.remote_status,
        endpoint: existing.record.remote_endpoint,
        thread_id: existing.record.remote_thread_id,
        cwd: existing.record.cwd,
        last_turn_id: existing.record.remote_last_turn_id,
        last_error: existing.record.remote_last_error,
        last_recovery_at: existing.record.remote_last_recovery_at,
        last_resume_at: existing.record.remote_last_resume_at,
        last_resume_error: existing.record.remote_last_resume_error,
        worker_pid: existing.record.remote_worker_pid,
        worker_log_path: existing.record.remote_worker_log_path,
        worker_last_error: existing.record.remote_worker_last_error,
        attached: hasRemoteSessionAttachment(existing.record),
      });
    }

    const sessions = store
      .listAll()
      .filter(({ record }) => hasRemoteSessionAttachment(record))
      .map(({ id, record }) => ({
        session_id: id,
        mode: record.mode,
        remote_input_owner: record.remote_input_owner,
        remote_status: record.remote_status,
        endpoint: record.remote_endpoint,
        thread_id: record.remote_thread_id,
        cwd: record.cwd,
        last_turn_id: record.remote_last_turn_id,
        last_error: record.remote_last_error,
        last_recovery_at: record.remote_last_recovery_at,
        last_resume_at: record.remote_last_resume_at,
        last_resume_error: record.remote_last_resume_error,
        worker_pid: record.remote_worker_pid,
        worker_log_path: record.remote_worker_log_path,
        worker_last_error: record.remote_worker_last_error,
      }));

    return c.json({ sessions });
  });

  app.get('/local/status', async (c) => {
    const sessionId = c.req.query('session_id');

    if (sessionId) {
      const existing = store.get(sessionId);
      if (!existing) {
        return c.json({ error: 'Session not found' }, 404);
      }

      return c.json({
        session_id: sessionId,
        mode: 'local-managed',
        endpoint: existing.record.remote_endpoint,
        thread_id: existing.record.remote_thread_id,
        topic_id: existing.record.topic_id,
        cwd: existing.record.cwd,
        local_bridge_enabled: existing.record.local_bridge_enabled ?? false,
        local_bridge_state: existing.record.local_bridge_state ?? null,
        local_attachment_id: existing.record.local_attachment_id ?? null,
        remote_status: existing.record.remote_status,
        attached: hasRemoteSessionAttachment(existing.record),
      });
    }

    const sessions = store
      .listAll()
      .filter(({ record }) => record.local_bridge_enabled === true)
      .map(({ id, record }) => ({
        session_id: id,
        mode: 'local-managed',
        endpoint: record.remote_endpoint,
        thread_id: record.remote_thread_id,
        topic_id: record.topic_id,
        cwd: record.cwd,
        local_bridge_enabled: record.local_bridge_enabled ?? false,
        local_bridge_state: record.local_bridge_state ?? null,
        local_attachment_id: record.local_attachment_id ?? null,
        remote_status: record.remote_status,
        attached: hasRemoteSessionAttachment(record),
      }));

    return c.json({ sessions });
  });

  // ===== POST /hook/resume-ack =====
  app.post('/hook/resume-ack', async (c) => {
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    if (!body.session_id) {
      return c.json({ error: 'Missing session_id' }, 400);
    }

    const existing = store.get(body.session_id);
    if (!existing) {
      return c.json({ status: 'ignored', reason: 'session not found' });
    }

    runBackgroundTask('Resume ACK background task', { session_id: body.session_id }, async () => {
      await sessionManager.handleResumeAcknowledged({
        session_id: body.session_id,
      });
      await store.save();
    });

    return c.json({ status: 'accepted', session_id: body.session_id }, 202);
  });

  // ===== POST /hook/working =====
  app.post('/hook/working', async (c) => {
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    if (!body.session_id) {
      return c.json({ error: 'Missing session_id' }, 400);
    }

    const existing = store.get(body.session_id);
    if (!existing) {
      return c.json({ status: 'ignored', reason: 'session not found' });
    }

    runBackgroundTask('Working hook background task', { session_id: body.session_id }, async () => {
      await sessionManager.handleWorking({
        session_id: body.session_id,
      });
      await store.save();
    });

    return c.json({ status: 'accepted', session_id: body.session_id }, 202);
  });

  // ===== POST /hook/mock-reply (PoC 테스트용) =====
  app.post('/hook/mock-reply', async (c) => {
    if (process.env.TL_ENABLE_MOCK_REPLY !== 'true') {
      return c.json({ error: 'mock-reply disabled' }, 404);
    }

    const url = new URL(c.req.url);
    const sessionId = url.searchParams.get('session_id');
    if (!sessionId) {
      return c.json({ error: 'Missing session_id query param' }, 400);
    }

    let body: { replyText: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    if (!body.replyText) {
      return c.json({ error: 'Missing replyText' }, 400);
    }

    const delivered = replyQueue.deliver(sessionId, body.replyText);
    return c.json({ delivered, session_id: sessionId });
  });

  // ===== GET /status =====
  app.get('/status', (c) => {
    const sessions = store.listActive();
    const activeCount = sessions.filter((s) => s.record.status === 'active').length;
    const waitingCount = sessions.filter((s) => s.record.status === 'waiting').length;

    return c.json({
      daemon: 'running',
      active_sessions: activeCount,
      waiting_sessions: waitingCount,
      uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
    });
  });

  // ===== GET /sessions =====
  app.get('/sessions', (c) => {
    const list = store.listAll().map(({ id, record }) => ({
      session_id: id,
      status: record.status,
      project: record.project,
      topic_id: record.topic_id,
      total_turns: record.total_turns,
      started_at: record.started_at,
    }));

    return c.json({ sessions: list });
  });

  return app;
}

// ===== 메인 =====
async function main() {
  // 설정 로드
  const config = loadConfig();

  // PID 파일
  const existingPid = acquirePidFile();
  if (existingPid !== null) {
    logger.error(`Daemon already running (PID: ${existingPid})`);
    process.exit(1);
  }

  // 저장소 초기화
  const store = new SessionsStore();
  await store.load();
  logger.info('Sessions store loaded', {
    sessionCount: store.listActive().length,
  });

  // Reply 큐 초기화
  const replyQueue = new ReplyQueue();
  replyQueue.startCleanupInterval();
  await replyQueue.processFileQueue();

  // Telegram 봇 초기화
  const tg = new TelegramBot(config, store, replyQueue);
  await tg.init();

  // 세션 매니저 초기화
  const sessionManager = new SessionManagerImpl(store, replyQueue, tg, config);
  const lateReplyResumer = new LateReplyResumer(store, tg, {
    groupId: config.groupId,
  });
  const appServerClient = new AppServerClient();
  const appServerRuntime = new AppServerRuntimeManager();
  const remoteWorkerRuntime = new RemoteWorkerRuntimeManager();
  const remoteStopController = new RemoteStopController(
    store,
    appServerClient,
    lateReplyResumer,
    appServerRuntime,
    remoteWorkerRuntime,
    {
      notifyDelivered: async (sessionId) => {
        const existing = store.get(sessionId);
        if (!existing) {
          return;
        }

        await tg.sendRemoteDeliveredMessage(config.groupId, existing.record.topic_id);
        await tg.sendWorkingMessage(config.groupId, existing.record.topic_id);

        store.update(sessionId, (record) => {
          const now = new Date().toISOString();
          record.last_resume_ack_at = now;
          record.last_progress_at = now;
          record.remote_input_owner = 'telegram';
          record.remote_status = 'running';
          record.remote_last_error = null;
        });
        await store.save();
      },
      notifyRecovering: async (sessionId, phase) => {
        const existing = store.get(sessionId);
        if (!existing) {
          return;
        }

        await tg.sendRemoteRecoveryMessage(
          config.groupId,
          existing.record.topic_id,
          phase
        );
      },
      notifyFailed: async (sessionId, error) => {
        const existing = store.get(sessionId);
        if (!existing) {
          return;
        }

        store.update(sessionId, (record) => {
          record.remote_input_owner = 'telegram';
          record.remote_status = 'degraded';
          record.remote_last_error = error;
        });
        await store.save();
      },
      publishTurnOutput: async (sessionId, args) => {
        const existing = store.get(sessionId);
        if (!existing) {
          return null;
        }

        return await tg.sendStopMessage(
          config.groupId,
          existing.record.topic_id,
          args.turnId,
          args.outputText,
          args.totalTurns,
          {
            mode: 'remote-managed',
            remoteStatus: 'idle',
            remoteOwner: 'telegram',
          }
        );
      },
    }
  );
  tg.setLateReplyHandler((sessionId, replyText) => (
    lateReplyResumer.handle(sessionId, replyText)
  ));
  tg.setRemoteReplyHandler(async (sessionId, replyText) => {
    const result = await remoteStopController.handleReply(sessionId, replyText);
    return result.handled;
  });

  const app = createDaemonApp({
    store,
    replyQueue,
    sessionManager,
    remoteStopController,
    appServerClient,
    appServerRuntime,
    remoteWorkerRuntime,
    config,
  });

  // HTTP 서버 시작
  const server = serve(
    {
      fetch: app.fetch,
      port: config.hookPort,
    },
    (info) => {
      logger.info(`Daemon listening on port ${info.port}`);
    }
  );

  // Graceful shutdown
  async function gracefulShutdown(signal: string) {
    logger.info(`Received ${signal}, shutting down...`);
    replyQueue.shutdown();
    await store.save();
    remoteWorkerRuntime.stopAll();
    await tg.stop();
    releasePidFile();
    server.close();
    process.exit(0);
  }

  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
}

const isDirectExecution =
  process.argv[1] != null &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  main().catch((err) => {
    logger.error('Daemon failed to start', { error: err.message });
    releasePidFile();
    process.exit(1);
  });
}
