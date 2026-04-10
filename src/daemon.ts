import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { DEFAULT_LOCAL_CODEX_ENDPOINT, getConfigDir, loadConfig } from './config.js';
import { SessionsStore } from './store.js';
import { ReplyQueue } from './reply-queue.js';
import { TelegramBot } from './telegram.js';
import { TopicPreferencesStore } from './topic-preferences-store.js';
import { SessionManagerImpl } from './session-manager.js';
import { LateReplyResumer } from './late-reply-resumer.js';
import {
  HookOutput,
  TelegramDirectiveField,
  TopicPreferences,
  type ApprovalPolicy,
  type DeferredLaunchPreferences,
  type SandboxMode,
  type SessionRecord,
} from './types.js';
import { logger } from './logger.js';
import { buildStopMessageFromTranscript } from './assistant-turn-output.js';
import { AppServerClient } from './app-server-client.js';
import { AppServerRuntimeManager } from './app-server-runtime.js';
import { RemoteStopController } from './remote-stop-controller.js';
import { attachRemoteSession, clearRemoteSession, hasRemoteSessionAttachment } from './remote-mode.js';
import { RemoteWorkerRuntimeManager } from './remote-worker-runtime.js';
import { buildLocalAttachmentId, LocalConsoleRuntimeManager } from './local-console-runtime.js';
import { LocalManagedOpenController } from './local-managed-open-controller.js';

const startTime = Date.now();
type DaemonAppDeps = {
  store: SessionsStore;
  replyQueue: ReplyQueue;
  sessionManager: SessionManagerImpl;
  tg?: TelegramBot;
  remoteStopController?: RemoteStopController;
  appServerClient?: AppServerClient;
  appServerRuntime?: AppServerRuntimeManager;
  remoteWorkerRuntime?: RemoteWorkerRuntimeManager;
  localConsoleRuntime?: LocalConsoleRuntimeManager;
  localManagedOpenController?: LocalManagedOpenController;
  topicPreferences?: {
    get(topicKey: string): TopicPreferences | undefined;
    set(topicKey: string, preferences: Partial<TopicPreferences>): void;
    clearField(topicKey: string, field: TelegramDirectiveField): void;
    save(): Promise<void>;
  };
  config?: Partial<ReturnType<typeof loadConfig>>;
};

type NotifyRemoteDeliveredArgs = {
  sessionId: string;
  groupId: number;
  store: Pick<SessionsStore, 'get' | 'update' | 'save'>;
  tg: Pick<TelegramBot, 'sendRemoteDeliveredMessage' | 'sendWorkingMessage'>;
  sessionManager: Pick<SessionManagerImpl, 'handleWorking'>;
};

function isTopicPreferenceField(value: unknown): value is TelegramDirectiveField {
  return (
    value === 'skill' ||
    value === 'cmd' ||
    value === 'model' ||
    value === 'approval-policy' ||
    value === 'sandbox' ||
    value === 'cwd'
  );
}

function isValidTopicPreferenceValue(
  field: TelegramDirectiveField,
  value: unknown
): value is string | string[] {
  if (field === 'skill') {
    return (
      Array.isArray(value) &&
      value.every((item) => {
        if (typeof item !== 'string') {
          return false;
        }
        const trimmed = item.trim();
        return trimmed.length > 0 && !/\s/.test(trimmed);
      })
    );
  }
  if (field === 'cmd') {
    return (
      Array.isArray(value) &&
      value.every((item) => {
        if (typeof item !== 'string') {
          return false;
        }
        const trimmed = item.trim();
        return trimmed.length > 0 && trimmed.startsWith('/');
      })
    );
  }
  if (typeof value !== 'string') {
    return false;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return false;
  }

  if (field === 'model') {
    return !/\s/.test(trimmed);
  }
  if (field === 'approval-policy') {
    return trimmed === 'never'
      || trimmed === 'on-request'
      || trimmed === 'on-failure'
      || trimmed === 'untrusted';
  }
  if (field === 'sandbox') {
    return trimmed === 'danger-full-access'
      || trimmed === 'workspace-write'
      || trimmed === 'read-only';
  }

  return true;
}

function normalizeTopicPreferenceValue(
  field: TelegramDirectiveField,
  value: string | string[]
): string | string[] {
  if (field === 'skill' || field === 'cmd') {
    return Array.isArray(value)
      ? value.map((item) => item.trim())
      : [value.trim()];
  }

  return Array.isArray(value) ? value[0]?.trim() ?? '' : value.trim();
}

function extractDeferredLaunchPreferences(
  source: Partial<Record<TelegramDirectiveField, unknown>> | null | undefined
): DeferredLaunchPreferences | undefined {
  if (!source) {
    return undefined;
  }

  const model = typeof source.model === 'string' ? source.model.trim() : undefined;
  const approvalPolicyRaw = source['approval-policy'];
  const sandboxRaw = source.sandbox;
  const cwd = typeof source.cwd === 'string' ? source.cwd.trim() : undefined;
  const approvalPolicy = typeof approvalPolicyRaw === 'string' && approvalPolicyRaw.trim().length > 0
    ? approvalPolicyRaw.trim() as ApprovalPolicy
    : undefined;
  const sandbox = typeof sandboxRaw === 'string' && sandboxRaw.trim().length > 0
    ? sandboxRaw.trim() as SandboxMode
    : undefined;

  if (!model && !approvalPolicy && !sandbox && !cwd) {
    return undefined;
  }

  return {
    ...(model ? { model } : {}),
    ...(approvalPolicy ? { 'approval-policy': approvalPolicy } : {}),
    ...(sandbox ? { sandbox } : {}),
    ...(cwd ? { cwd } : {}),
  };
}

function validateDeferredLaunchPreferenceOverrides(
  source: Partial<Record<TelegramDirectiveField, unknown>> | null | undefined
): { error: string | null } {
  if (!source) {
    return { error: null };
  }

  for (const field of ['model', 'approval-policy', 'sandbox', 'cwd'] as const) {
    const value = source[field];
    if (value === undefined) {
      continue;
    }
    if (!isValidTopicPreferenceValue(field, value)) {
      return { error: `Invalid value for field: ${field}` };
    }
  }

  return { error: null };
}

function mergeDeferredLaunchPreferences(
  base?: DeferredLaunchPreferences,
  override?: DeferredLaunchPreferences
): DeferredLaunchPreferences | undefined {
  const merged = {
    ...(base ?? {}),
    ...(override ?? {}),
  };

  if (
    merged.model === undefined
    && merged['approval-policy'] === undefined
    && merged.sandbox === undefined
    && merged.cwd === undefined
  ) {
    return undefined;
  }

  return merged;
}

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

export async function notifyRemoteDelivered({
  sessionId,
  groupId,
  store,
  tg,
  sessionManager,
}: NotifyRemoteDeliveredArgs): Promise<void> {
  const existing = store.get(sessionId);
  if (!existing) {
    return;
  }

  let deliveredAckSent = false;
  try {
    await tg.sendRemoteDeliveredMessage(groupId, existing.record.topic_id);
    deliveredAckSent = true;
  } catch (err) {
    logger.warn('Remote delivered ack failed', {
      sessionId,
      topicId: existing.record.topic_id,
      error: (err as Error).message,
    });
  }

  if (existing.record.mode === 'local-managed') {
    await sessionManager.handleWorking({ session_id: sessionId });

    store.update(sessionId, (record) => {
      if (deliveredAckSent) {
        record.last_resume_ack_at = new Date().toISOString();
      }
      record.remote_input_owner = 'telegram';
    });
    await store.save();
    return;
  }

  await tg.sendWorkingMessage(groupId, existing.record.topic_id);

  store.update(sessionId, (record) => {
    const now = new Date().toISOString();
    if (deliveredAckSent) {
      record.last_resume_ack_at = now;
    }
    record.last_progress_at = now;
    record.remote_input_owner = 'telegram';
    record.remote_status = 'running';
    record.remote_last_error = null;
  });
  await store.save();
}

export function createDaemonApp({
  store,
  replyQueue,
  sessionManager,
  tg,
  remoteStopController,
  appServerClient,
  appServerRuntime,
  remoteWorkerRuntime,
  localConsoleRuntime,
  localManagedOpenController,
  topicPreferences,
  config,
}: DaemonAppDeps): Hono {
  const app = new Hono();
  const buildTopicKey = (chatId: string | number, topicId: string | number): string => (
    `${chatId}:${topicId}`
  );
  const getTopicDeferredLaunchPreferences = (
    chatId: number | string | null | undefined,
    topicId: number | string | null | undefined
  ): DeferredLaunchPreferences | undefined => {
    if (!topicPreferences || chatId == null || topicId == null) {
      return undefined;
    }
    return extractDeferredLaunchPreferences(topicPreferences.get(buildTopicKey(chatId, topicId)));
  };
  const getSessionDeferredLaunchPreferences = (
    record: Pick<SessionRecord, 'chat_id' | 'topic_id' | 'pending_spawn_preferences'>
  ): DeferredLaunchPreferences | undefined => (
    record.pending_spawn_preferences ?? getTopicDeferredLaunchPreferences(record.chat_id ?? null, record.topic_id)
  );
  const getBodyDeferredLaunchPreferences = (body: Record<string, unknown>): DeferredLaunchPreferences | undefined => (
    extractDeferredLaunchPreferences({
      model: body.model,
      'approval-policy': body['approval-policy'] ?? body.approval_policy,
      sandbox: body.sandbox,
      cwd: body.cwd,
    })
  );

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
        project: body.project ?? (body.cwd ? body.cwd.split('/').pop() ?? body.cwd : 'unknown'),
        cwd: body.cwd ?? process.cwd(),
        last_user_message: body.last_user_message ?? '',
        is_reconnect: isReconnect,
        session_mode: body.session_mode ?? undefined,
        local_attachment_id: body.local_attachment_id ?? null,
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
      return c.json(
        {
          error: 'Resume delivery failed: no waiting consumer',
          session_id: body.session_id,
        },
        409
      );
    }

    return c.json({ status: 'resumed', session_id: body.session_id });
  });

  app.get('/topic-preferences', async (c) => {
    if (!topicPreferences) {
      return c.json({ error: 'topic preferences unavailable' }, 503);
    }

    const chatId = c.req.query('chat_id');
    const topicId = c.req.query('topic_id');
    if (!chatId || !topicId) {
      return c.json({ error: 'Missing chat_id or topic_id' }, 400);
    }

    const topicKey = buildTopicKey(chatId, topicId);
    return c.json({
      topic_key: topicKey,
      preferences: topicPreferences.get(topicKey) ?? null,
    });
  });

  app.post('/topic-preferences/set', async (c) => {
    if (!topicPreferences) {
      return c.json({ error: 'topic preferences unavailable' }, 503);
    }

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    if (!body.chat_id || !body.topic_id || !body.field || body.value === undefined) {
      return c.json({ error: 'Missing chat_id, topic_id, field, or value' }, 400);
    }
    if (!isTopicPreferenceField(body.field)) {
      return c.json({ error: `Unknown field: ${String(body.field)}` }, 400);
    }
    if (!isValidTopicPreferenceValue(body.field, body.value)) {
      return c.json({ error: `Invalid value for field: ${body.field}` }, 400);
    }

    const topicKey = buildTopicKey(body.chat_id, body.topic_id);
    const normalizedValue = normalizeTopicPreferenceValue(body.field, body.value);
    topicPreferences.set(topicKey, {
      [body.field]: normalizedValue,
    } as Partial<TopicPreferences>);
    await topicPreferences.save();

    return c.json({
      status: 'ok',
      topic_key: topicKey,
      preferences: topicPreferences.get(topicKey) ?? null,
    });
  });

  app.post('/topic-preferences/clear', async (c) => {
    if (!topicPreferences) {
      return c.json({ error: 'topic preferences unavailable' }, 503);
    }

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    if (!body.chat_id || !body.topic_id || !body.field) {
      return c.json({ error: 'Missing chat_id, topic_id, or field' }, 400);
    }
    if (!isTopicPreferenceField(body.field)) {
      return c.json({ error: `Unknown field: ${String(body.field)}` }, 400);
    }

    const topicKey = buildTopicKey(body.chat_id, body.topic_id);
    topicPreferences.clearField(topicKey, body.field);
    await topicPreferences.save();

    return c.json({
      status: 'ok',
      topic_key: topicKey,
      preferences: topicPreferences.get(topicKey) ?? null,
    });
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

    if (!body.endpoint) {
      return c.json({ error: 'Missing endpoint' }, 400);
    }

    const bodyLaunchSource = {
      model: body.model,
      'approval-policy': body['approval-policy'] ?? body.approval_policy,
      sandbox: body.sandbox,
      cwd: body.cwd,
    } as const;
    const bodyLaunchValidation = validateDeferredLaunchPreferenceOverrides(bodyLaunchSource);
    if (bodyLaunchValidation.error) {
      return c.json({ error: bodyLaunchValidation.error }, 400);
    }

    const launchPrefs = mergeDeferredLaunchPreferences(
      getTopicDeferredLaunchPreferences(body.chat_id ?? null, body.topic_id ?? null),
      getBodyDeferredLaunchPreferences(bodyLaunchSource as Record<string, unknown>)
    );
    const cwd = launchPrefs?.cwd ?? body.cwd;
    if (!cwd) {
      return c.json({ error: 'Missing cwd or endpoint' }, 400);
    }
    const model = launchPrefs?.model ?? 'gpt-5.4';
    const initialText = typeof body.initial_text === 'string' ? body.initial_text : '';
    const project = typeof body.project === 'string' && body.project.trim().length > 0
      ? body.project.trim()
      : path.basename(cwd);

    try {
      await appServerRuntime.ensureAvailable(body.endpoint, cwd);
      const thread = await appServerClient.createThread({
        endpoint: body.endpoint,
        cwd,
        approvalPolicy: launchPrefs?.['approval-policy'],
        sandbox: launchPrefs?.sandbox,
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
      store.update(thread.threadId, (record) => {
        record.pending_spawn_preferences = launchPrefs ?? null;
      });
      await store.save();
      await remoteStopController.ensureWorkerAttached(
        thread.threadId,
        body.endpoint,
        cwd,
        undefined,
        undefined,
        launchPrefs
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
        total_turns: created?.record.total_turns ?? 0,
        pristine: (created?.record.total_turns ?? 0) === 0,
      });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.post('/local/start', async (c) => {
    if (
      !appServerClient ||
      !appServerRuntime ||
      !remoteWorkerRuntime ||
      !remoteStopController ||
      !localConsoleRuntime
    ) {
      return c.json({ error: 'Local managed runtime unavailable' }, 503);
    }

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    const bodyLaunchSource = {
      model: body.model,
      'approval-policy': body['approval-policy'] ?? body.approval_policy,
      sandbox: body.sandbox,
      cwd: body.cwd,
    } as const;
    const bodyLaunchValidation = validateDeferredLaunchPreferenceOverrides(bodyLaunchSource);
    if (bodyLaunchValidation.error) {
      return c.json({ error: bodyLaunchValidation.error }, 400);
    }

    const launchPrefs = mergeDeferredLaunchPreferences(
      getTopicDeferredLaunchPreferences(body.chat_id ?? null, body.topic_id ?? null),
      getBodyDeferredLaunchPreferences(bodyLaunchSource as Record<string, unknown>)
    );
    const cwd = launchPrefs?.cwd ?? body.cwd;
    if (!cwd) {
      return c.json({ error: 'Missing cwd' }, 400);
    }
    const model = launchPrefs?.model ?? 'gpt-5.4';
    const initialText = typeof body.initial_text === 'string' ? body.initial_text : '';
    const project = typeof body.project === 'string' && body.project.trim().length > 0
      ? body.project.trim()
      : path.basename(cwd);
    const endpoint = resolveLocalEndpoint(body.endpoint);
    const bootstrapText = initialText.trim();

    if (bootstrapText.length === 0) {
      return c.json({ error: 'Missing initial_text' }, 400);
    }

    try {
      await appServerRuntime.ensureAvailable(endpoint, cwd);

      const thread = await appServerClient.createThread({
        endpoint,
        cwd,
        approvalPolicy: launchPrefs?.['approval-policy'],
        sandbox: launchPrefs?.sandbox,
      });

      const delivery = await appServerClient.injectLocalInput({
        endpoint,
        threadId: thread.threadId,
        text: bootstrapText,
      });

      const loaded = await appServerClient.waitForThreadLoaded({
        endpoint,
        threadId: thread.threadId,
      });
      if (!loaded) {
        throw new Error(`Timed out waiting for local thread to load: ${thread.threadId}`);
      }

      const attachmentId = buildLocalAttachmentId(thread.threadId);
      await sessionManager.handleSessionStart({
        session_id: thread.threadId,
        model,
        turn_id: delivery.turnId,
        project,
        cwd,
        last_user_message: bootstrapText,
        session_mode: 'local-managed',
        local_attachment_id: attachmentId,
        remote_endpoint: endpoint,
        remote_thread_id: thread.threadId,
      });
      store.update(thread.threadId, (record) => {
        record.pending_spawn_preferences = launchPrefs ?? null;
      });

      const consoleSession = await localConsoleRuntime.ensureAttached({
        sessionId: thread.threadId,
        endpoint,
        cwd,
        knownAttachmentId: attachmentId,
        knownLogPath: null,
        launchPrefs,
      });

      store.update(thread.threadId, (record) => {
        record.local_bridge_enabled = true;
        record.local_bridge_state = 'attached';
        record.local_input_queue_depth = 0;
        record.local_last_input_source = null;
        record.local_last_input_at = null;
        record.local_last_injection_error = null;
        record.local_attachment_id = consoleSession.attachmentId;
        record.remote_worker_log_path = consoleSession.logPath;
      });
      await store.save();
      localManagedOpenController?.monitorSession(thread.threadId);

      const created = store.get(thread.threadId);

      return c.json({
        status: 'started',
        session_id: thread.threadId,
        topic_id: created?.record.topic_id ?? null,
        mode: 'local-managed',
        endpoint,
        thread_id: thread.threadId,
        attachment_id: consoleSession.attachmentId,
        turn_id: delivery.turnId,
        total_turns: created?.record.total_turns ?? 0,
        pristine: true,
      });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.post('/local/open/register', async (c) => {
    if (!localManagedOpenController) {
      return c.json({ error: 'Local managed open controller unavailable' }, 503);
    }

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    const attachmentId = typeof body.attachment_id === 'string' ? body.attachment_id.trim() : '';
    const cwd = typeof body.cwd === 'string' ? body.cwd.trim() : '';
    const project = typeof body.project === 'string' ? body.project.trim() : '';
    const model = typeof body.model === 'string' ? body.model.trim() : 'gpt-5.4';
    const endpoint = resolveLocalEndpoint(body.endpoint);
    const logPath = typeof body.log_path === 'string' ? body.log_path.trim() : null;
    const knownThreadIds = Array.isArray(body.known_thread_ids)
      ? body.known_thread_ids.filter(
          (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
        )
      : undefined;

    if (!attachmentId || !cwd || !project) {
      return c.json({ error: 'Missing attachment_id, cwd, or project' }, 400);
    }

    await localManagedOpenController.registerPendingOpen({
      attachmentId,
      logPath,
      cwd,
      project,
      model,
      endpoint,
      knownThreadIds,
    });

    return c.json({
      status: 'registered',
      attachment_id: attachmentId,
      cwd,
      project,
      endpoint,
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
        pending_spawn_preferences: getSessionDeferredLaunchPreferences(existing.record) ?? null,
        total_turns: existing.record.total_turns,
        pristine: existing.record.total_turns === 0,
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
        pending_spawn_preferences: getSessionDeferredLaunchPreferences(record) ?? null,
        total_turns: record.total_turns,
        pristine: record.total_turns === 0,
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
        pending_spawn_preferences: getSessionDeferredLaunchPreferences(existing.record) ?? null,
        total_turns: existing.record.total_turns,
        pristine: existing.record.total_turns === 0,
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
        pending_spawn_preferences: getSessionDeferredLaunchPreferences(record) ?? null,
        total_turns: record.total_turns,
        pristine: record.total_turns === 0,
      }));

    return c.json({ sessions });
  });

  app.post('/admin/delete-topic', async (c) => {
    if (!tg) {
      return c.json({ error: 'Telegram transport unavailable' }, 503);
    }

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    const sessionId = typeof body.session_id === 'string' ? body.session_id : null;
    const deleteSession = body.delete_session === true;
    const requestedTopicId = typeof body.topic_id === 'number' ? body.topic_id : null;
    const existing = sessionId ? store.get(sessionId) : undefined;

    if (sessionId && !existing) {
      return c.json({ error: 'Session not found' }, 404);
    }

    const topicId = requestedTopicId ?? existing?.record.topic_id ?? null;
    if (!topicId) {
      return c.json({ error: 'Missing topic_id or session_id' }, 400);
    }

    try {
      await tg.deleteTopic(topicId);
      if (deleteSession && sessionId) {
        store.delete(sessionId);
        await store.save();
      }

      return c.json({
        status: 'deleted',
        topic_id: topicId,
        session_id: sessionId,
        session_deleted: deleteSession && Boolean(sessionId),
      });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
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
        prompt: typeof body.prompt === 'string' ? body.prompt : undefined,
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
  const topicPreferences = new TopicPreferencesStore();
  await topicPreferences.load();

  // Telegram 봇 초기화
  const tg = new TelegramBot(config, store, replyQueue, topicPreferences);
  await tg.init();

  // 세션 매니저 초기화
  const sessionManager = new SessionManagerImpl(store, replyQueue, tg, config);
  const lateReplyResumer = new LateReplyResumer(store, tg, {
    groupId: config.groupId,
  });
  const appServerClient = new AppServerClient();
  const appServerRuntime = new AppServerRuntimeManager();
  const remoteWorkerRuntime = new RemoteWorkerRuntimeManager();
  const localConsoleRuntime = new LocalConsoleRuntimeManager();
  const remoteStopController = new RemoteStopController(
    store,
    appServerClient,
    lateReplyResumer,
    appServerRuntime,
    remoteWorkerRuntime,
    localConsoleRuntime,
    {
      notifyDelivered: async (sessionId) => {
        await notifyRemoteDelivered({
          sessionId,
          groupId: config.groupId,
          store,
          tg,
          sessionManager,
        });
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

        const mode = existing.record.mode === 'local-managed'
          ? 'local-managed'
          : 'remote-managed';
        const remoteOwner = existing.record.remote_input_owner
          ?? (existing.record.mode === 'local-managed' ? 'tui' : 'telegram');

        return await tg.sendStopMessage(
          config.groupId,
          existing.record.topic_id,
          args.turnId,
          args.outputText,
          args.totalTurns,
          {
            mode,
            remoteStatus: 'idle',
            remoteOwner,
          }
        );
      },
      settleManagedTurn: async (sessionId, args) => {
        await sessionManager.handleManagedTurnSettled({
          session_id: sessionId,
          turn_id: args.turnId,
          last_message: args.outputText,
          total_turns: args.totalTurns,
          remote_input_owner: args.remoteInputOwner,
        });
      },
      resolveDeferredLaunchPreferences: (_sessionId, record) => {
        if (record.pending_spawn_preferences) {
          return record.pending_spawn_preferences;
        }
        if (record.chat_id == null) {
          return undefined;
        }
        return extractDeferredLaunchPreferences(
          topicPreferences.get(`${record.chat_id}:${record.topic_id}`)
        );
      },
    }
  );
  const localManagedOpenController = new LocalManagedOpenController(
    store,
    sessionManager,
    appServerClient,
    async (sessionId, args) => {
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
          mode: 'local-managed',
          remoteStatus: 'idle',
          remoteOwner: 'tui',
        }
      );
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
    tg,
    remoteStopController,
    appServerClient,
    appServerRuntime,
    remoteWorkerRuntime,
    localConsoleRuntime,
    localManagedOpenController,
    topicPreferences,
    config,
  });
  localManagedOpenController.restoreSessionMonitors();

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
    localManagedOpenController.shutdown();
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
