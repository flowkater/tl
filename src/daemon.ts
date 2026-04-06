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

const startTime = Date.now();

type DaemonAppDeps = {
  store: SessionsStore;
  replyQueue: ReplyQueue;
  sessionManager: SessionManagerImpl;
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
}: DaemonAppDeps): Hono {
  const app = new Hono();

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
      endpoint: body.endpoint,
      thread_id: body.thread_id,
      remote_mode_enabled: true,
    });
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
      remote_mode_enabled: false,
    });
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
        remote_mode_enabled: existing.record.remote_mode_enabled,
        endpoint: existing.record.remote_endpoint,
        thread_id: existing.record.remote_thread_id,
        last_turn_id: existing.record.remote_last_turn_id,
        attached: hasRemoteSessionAttachment(existing.record),
      });
    }

    const sessions = store
      .listAll()
      .filter(({ record }) => hasRemoteSessionAttachment(record))
      .map(({ id, record }) => ({
        session_id: id,
        endpoint: record.remote_endpoint,
        thread_id: record.remote_thread_id,
        last_turn_id: record.remote_last_turn_id,
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
  const remoteStopController = new RemoteStopController(
    store,
    new AppServerClient(),
    lateReplyResumer,
    new AppServerRuntimeManager(),
    {
      notifyDelivered: async (sessionId) => {
        const existing = store.get(sessionId);
        if (!existing) {
          return;
        }

        await tg.sendResumeAckMessage(config.groupId, existing.record.topic_id);
        await tg.sendWorkingMessage(config.groupId, existing.record.topic_id);

        store.update(sessionId, (record) => {
          const now = new Date().toISOString();
          record.last_resume_ack_at = now;
          record.last_progress_at = now;
        });
        await store.save();
      },
      notifyFailed: async () => {},
    }
  );
  tg.setLateReplyHandler((sessionId, replyText) => (
    lateReplyResumer.handle(sessionId, replyText)
  ));
  tg.setRemoteReplyHandler(async (sessionId, replyText) => {
    const result = await remoteStopController.handleReply(sessionId, replyText);
    return result.handled;
  });

  const app = createDaemonApp({ store, replyQueue, sessionManager });

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
