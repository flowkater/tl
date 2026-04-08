// session-manager.ts — 세션 상태 전이 + TG 연동 조합
import { SessionManager, HookOutput, DaemonConfig, type RemoteInputOwner } from './types.js';
import { SessionsStore } from './store.js';
import { ReplyQueue } from './reply-queue.js';
import { TelegramBot } from './telegram.js';
import { TlError } from './errors.js';
import { logger } from './logger.js';
import {
  hasRemoteSessionAttachment,
  isLocalManagedSession,
  resolveManagedMode,
} from './remote-mode.js';

export class SessionManagerImpl implements SessionManager {
  private static readonly FIRST_HEARTBEAT_DELAY_MS = 2 * 60 * 1000;
  private static readonly HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
  private static readonly TYPING_INTERVAL_MS = 4 * 1000;
  private store: SessionsStore;
  private replyQueue: ReplyQueue;
  private tg: TelegramBot;
  private config: DaemonConfig;
  private heartbeatTimers = new Map<
    string,
    { initial?: NodeJS.Timeout; repeat?: NodeJS.Timeout }
  >();
  private typingTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    store: SessionsStore,
    replyQueue: ReplyQueue,
    tg: TelegramBot,
    config: DaemonConfig
  ) {
    this.store = store;
    this.replyQueue = replyQueue;
    this.tg = tg;
    this.config = config;
  }

  // ===== session-start =====

  async handleSessionStart(args: {
    session_id: string;
    model: string;
    turn_id: string;
    project: string;
    cwd: string;
    last_user_message: string;
    is_reconnect?: boolean;
    session_mode?: 'local' | 'local-managed' | 'remote-managed';
    local_attachment_id?: string | null;
    remote_endpoint?: string | null;
    remote_thread_id?: string | null;
  }): Promise<void> {
    const {
      session_id,
      model,
      project,
      is_reconnect,
      session_mode,
      local_attachment_id,
      remote_endpoint,
      remote_thread_id,
    } = args;
    const existingSession = this.store.get(session_id);
    const remoteEnabled = typeof remote_endpoint === 'string' && remote_endpoint.length > 0;
    const reusedRemote = is_reconnect && existingSession
      ? hasRemoteSessionAttachment(existingSession.record)
      : false;
    const effectiveRemoteEnabled = remoteEnabled || reusedRemote;
    const effectiveRemoteEndpoint = remoteEnabled
      ? remote_endpoint
      : reusedRemote
        ? existingSession?.record.remote_endpoint ?? null
        : null;
    const resolvedRemoteThreadId = remoteEnabled
      ? (remote_thread_id && remote_thread_id.length > 0 ? remote_thread_id : session_id)
      : reusedRemote
        ? existingSession?.record.remote_thread_id ?? session_id
        : null;
    const effectiveMode = session_mode
      ? session_mode
      : effectiveRemoteEnabled
        ? 'remote-managed'
        : 'local';
    const localManaged = effectiveMode === 'local-managed';

    // 상태 검증
    if (existingSession && !is_reconnect) {
      throw new TlError('Session already exists', 'SESSION_EXISTS');
    }

    let topic_id: number;

    if (is_reconnect && existingSession) {
      // 재연결: 기존 topic_id 재사용
      topic_id = existingSession.record.topic_id;
      this.clearHeartbeat(session_id);
      this.clearTyping(session_id);

      await this.tg.sendReconnectMessage(
        this.config.groupId,
        topic_id,
        session_id
      );

      this.store.update(session_id, (record) => {
        record.status = 'active';
        record.mode = effectiveMode;
        record.chat_id = this.config.groupId;
        record.started_at = new Date().toISOString();
        record.model = model;
        record.total_turns = existingSession.record.total_turns;
        record.reply_message_id = null;
        record.stop_message_id = null;
        record.last_user_message = args.last_user_message;
        record.last_turn_output = '';
        record.last_progress_at = null;
        record.last_heartbeat_at = null;
        record.last_resume_ack_at = null;
        record.late_reply_text = null;
        record.late_reply_received_at = null;
        record.late_reply_resume_started_at = null;
        record.late_reply_resume_error = null;
        record.local_bridge_enabled = localManaged;
        record.local_bridge_state = localManaged ? 'attached' : null;
        record.local_attachment_id = localManaged ? (local_attachment_id ?? null) : null;
        record.remote_mode_enabled = effectiveRemoteEnabled;
        record.remote_input_owner = effectiveRemoteEnabled
          ? (localManaged ? 'tui' : 'telegram')
          : null;
        record.remote_status = effectiveRemoteEnabled ? 'attached' : null;
        record.remote_endpoint = effectiveRemoteEnabled
          ? effectiveRemoteEndpoint
          : null;
        record.remote_thread_id = effectiveRemoteEnabled
          ? resolvedRemoteThreadId
          : null;
        record.remote_last_error = null;
        record.remote_last_recovery_at = null;
        record.remote_last_injection_error = null;
        record.remote_last_resume_at = null;
        record.remote_last_resume_error = null;
        record.remote_worker_pid = null;
        record.remote_worker_log_path = null;
        record.remote_worker_started_at = null;
        record.remote_worker_last_error = null;
      });
    } else {
      // 새 세션: 토픽 생성
      topic_id = await this.tg.createTopic(project);
      const startMessageId = await this.tg.sendStartMessage(
        this.config.groupId,
        topic_id,
        session_id,
        model
      );

      this.store.create(session_id, {
        status: 'active',
        mode: effectiveMode,
        chat_id: this.config.groupId,
        project,
        cwd: args.cwd,
        model,
        topic_id,
        start_message_id: startMessageId,
        started_at: new Date().toISOString(),
        completed_at: null,
        stop_message_id: null,
        reply_message_id: null,
        total_turns: 0,
        last_user_message: args.last_user_message,
        last_turn_output: '',
        last_progress_at: null,
        last_heartbeat_at: null,
        last_resume_ack_at: null,
        late_reply_text: null,
        late_reply_received_at: null,
        late_reply_resume_started_at: null,
        late_reply_resume_error: null,
        local_bridge_enabled: localManaged,
        local_bridge_state: localManaged ? 'attached' : null,
        local_input_queue_depth: 0,
        local_last_input_source: null,
        local_last_input_at: null,
        local_last_injection_error: null,
        local_attachment_id: localManaged ? (local_attachment_id ?? null) : null,
        remote_mode_enabled: effectiveRemoteEnabled,
        remote_input_owner: effectiveRemoteEnabled
          ? (localManaged ? 'tui' : 'telegram')
          : null,
        remote_status: effectiveRemoteEnabled ? 'attached' : null,
        remote_endpoint: effectiveRemoteEnabled ? effectiveRemoteEndpoint : null,
        remote_thread_id: resolvedRemoteThreadId,
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
      });
    }

    logger.info('Session started', {
      session_id,
      topic_id,
      is_reconnect: !!is_reconnect,
    });
  }

  // ===== stop-and-wait (long-polling) =====

  async handleStopAndWait(args: {
    session_id: string;
    turn_id: string;
    last_message: string;
    total_turns: number;
    abort_signal?: AbortSignal;
  }): Promise<HookOutput> {
    const { session_id, last_message, total_turns } = args;

    const existing = this.store.get(session_id);
    if (!existing) {
      throw new TlError('Session not found', 'SESSION_NOT_FOUND');
    }
    if (existing.record.status !== 'active') {
      throw new TlError(
        `Expected active but was ${existing.record.status}`,
        'TRANSITION_INVALID'
      );
    }

    const previousState = {
      status: existing.record.status,
      total_turns: existing.record.total_turns,
      last_turn_output: existing.record.last_turn_output,
      stop_message_id: existing.record.stop_message_id,
      last_progress_at: existing.record.last_progress_at,
      last_heartbeat_at: existing.record.last_heartbeat_at,
    };

    if (isLocalManagedSession(existing.record)) {
      const stopMessageId = await this.tg.sendStopMessage(
        this.config.groupId,
        existing.record.topic_id,
        args.turn_id,
        last_message,
        total_turns,
        {
          mode: 'local-managed',
          remoteStatus: existing.record.remote_status,
          remoteOwner: existing.record.remote_input_owner,
        }
      );

      await this.handleManagedTurnSettled({
        session_id,
        turn_id: args.turn_id,
        last_message,
        total_turns,
        remote_input_owner: 'tui',
      });
      this.store.update(session_id, (record) => {
        record.mode = 'local-managed';
        record.stop_message_id = stopMessageId;
      });
      await this.store.save();

      return { decision: 'continue' as const };
    }

    if (hasRemoteSessionAttachment(existing.record)) {
      const remoteInputOwner: RemoteInputOwner | null | undefined =
        existing.record.mode === 'local-managed'
          ? 'tui'
          : existing.record.remote_input_owner;
      await this.handleManagedTurnSettled({
        session_id,
        turn_id: args.turn_id,
        last_message,
        total_turns,
        remote_input_owner: remoteInputOwner,
      });
      this.store.update(session_id, (record) => {
        record.mode = resolveManagedMode(record);
      });
      await this.store.save();

      return { decision: 'continue' as const };
    }

    // 1. 세션을 waiting으로 전이
    this.store.update(session_id, (record) => {
      record.status = 'waiting';
      record.mode = 'local';
      record.total_turns = total_turns;
      record.last_turn_output = last_message;
      record.stop_message_id = null;
      record.last_progress_at = null;
      record.last_heartbeat_at = null;
      record.remote_input_owner = 'telegram';
    });
    this.clearHeartbeat(session_id);
    this.clearTyping(session_id);

    let stopMessageId: number;
    try {
      // 2. Telegram에 stop 메시지 전송 (답장 대기용)
      stopMessageId = await this.tg.sendStopMessage(
        this.config.groupId,
        existing.record.topic_id,
        args.turn_id,
        last_message,
        total_turns,
        {
          mode: 'local',
        }
      );
    } catch (err) {
      this.store.update(session_id, (record) => {
        record.status = previousState.status;
        record.total_turns = previousState.total_turns;
        record.last_turn_output = previousState.last_turn_output;
        record.stop_message_id = previousState.stop_message_id;
        record.last_progress_at = previousState.last_progress_at;
        record.last_heartbeat_at = previousState.last_heartbeat_at;
      });
      throw err;
    }

    this.store.update(session_id, (record) => {
      record.stop_message_id = stopMessageId;
    });

    // 3. Reply 대기 (long-polling)
    const reply = await this.replyQueue.waitFor(session_id, this.config.stopTimeout, {
      signal: args.abort_signal,
    });

    if (reply.decision === 'continue') {
      // 타임아웃 → active 복귀 (에이전트 계속 진행)
      this.store.update(session_id, (record) => {
        record.status = 'active';
        record.stop_message_id = stopMessageId;
      });
      return { decision: 'continue' as const };
    }

    // 4. 사용자 답장 받음 → active 복귀
    const replyText = reply.decision === 'block' ? reply.reason : 'reply';
    this.store.update(session_id, (record) => {
      record.status = 'active';
      record.stop_message_id = stopMessageId;
      record.last_user_message = replyText;
    });

    return reply;
  }

  async handleResumeAcknowledged(args: {
    session_id: string;
  }): Promise<void> {
    const existing = this.store.get(args.session_id);
    if (!existing) {
      throw new TlError('Session not found', 'SESSION_NOT_FOUND');
    }
    if (existing.record.status !== 'active') {
      throw new TlError(
        `Expected active but was ${existing.record.status}`,
        'TRANSITION_INVALID'
      );
    }

    await this.tg.sendResumeAckMessage(
      this.config.groupId,
      existing.record.topic_id
    );

    this.store.update(args.session_id, (record) => {
      record.last_resume_ack_at = new Date().toISOString();
    });
  }

  async handleWorking(args: {
    session_id: string;
    prompt?: string;
  }): Promise<void> {
    const existing = this.store.get(args.session_id);
    if (!existing) {
      throw new TlError('Session not found', 'SESSION_NOT_FOUND');
    }
    if (existing.record.status !== 'active') {
      throw new TlError(
        `Expected active but was ${existing.record.status}`,
        'TRANSITION_INVALID'
      );
    }

    if (hasRemoteSessionAttachment(existing.record) && !isLocalManagedSession(existing.record)) {
      this.store.update(args.session_id, (record) => {
        record.remote_input_owner = 'telegram';
      });
      return;
    }

    const prompt = typeof args.prompt === 'string' && args.prompt.trim().length > 0
      ? args.prompt
      : null;
    if (prompt) {
      await this.tg.sendTopicText(
        this.config.groupId,
        existing.record.topic_id,
        prompt
      );
    }

    await this.tg.sendWorkingMessage(
      this.config.groupId,
      existing.record.topic_id
    );

    this.store.update(args.session_id, (record) => {
      record.last_progress_at = new Date().toISOString();
      record.last_heartbeat_at = null;
      if (hasRemoteSessionAttachment(record)) {
        record.remote_status = 'running';
        record.remote_last_error = null;
        record.remote_input_owner = record.mode === 'local-managed' ? 'tui' : 'telegram';
      }
    });

    this.scheduleHeartbeat(args.session_id);
    this.scheduleTyping(args.session_id);
  }

  async handleManagedTurnSettled(args: {
    session_id: string;
    turn_id: string;
    last_message: string;
    total_turns: number;
    last_user_message?: string | null;
    remote_input_owner?: RemoteInputOwner | null;
  }): Promise<void> {
    const existing = this.store.get(args.session_id);
    if (!existing) {
      throw new TlError('Session not found', 'SESSION_NOT_FOUND');
    }
    if (existing.record.status !== 'active') {
      throw new TlError(
        `Expected active but was ${existing.record.status}`,
        'TRANSITION_INVALID'
      );
    }

    this.store.update(args.session_id, (record) => {
      record.status = 'active';
      record.total_turns = args.total_turns;
      record.last_turn_output = args.last_message;
      record.last_progress_at = null;
      record.last_heartbeat_at = null;
      record.remote_last_turn_id = args.turn_id;
      if (args.last_user_message != null) {
        record.last_user_message = args.last_user_message;
      }
      if (args.remote_input_owner !== undefined) {
        record.remote_input_owner = args.remote_input_owner;
      }
      if (hasRemoteSessionAttachment(record)) {
        if (record.remote_status !== null) {
          record.remote_status = 'idle';
        }
        record.remote_last_error = null;
      }
    });
    this.clearHeartbeat(args.session_id);
    this.clearTyping(args.session_id);
    await this.store.save();
  }

  // ===== complete =====

  async handleComplete(args: {
    session_id: string;
    total_turns: number;
    duration: string;
  }): Promise<void> {
    const { session_id, total_turns, duration } = args;
    this.clearHeartbeat(session_id);
    this.clearTyping(session_id);

    const existing = this.store.get(session_id);
    if (!existing) {
      throw new TlError('Session not found', 'SESSION_NOT_FOUND');
    }
    if (existing.record.status !== 'active') {
      throw new TlError(
        `Expected active but was ${existing.record.status}`,
        'TRANSITION_INVALID'
      );
    }

    await this.tg.sendCompleteMessage(
      this.config.groupId,
      existing.record.topic_id,
      total_turns,
      duration
    );

    this.store.update(session_id, (record) => {
      record.status = 'completed';
      record.completed_at = new Date().toISOString();
    });

    logger.info('Session completed', { session_id, total_turns, duration });
  }

  private scheduleHeartbeat(sessionId: string): void {
    this.clearHeartbeat(sessionId);

    const initial = setTimeout(() => {
      void this.sendHeartbeat(sessionId);

      const repeat = setInterval(() => {
        void this.sendHeartbeat(sessionId);
      }, SessionManagerImpl.HEARTBEAT_INTERVAL_MS);

      const entry = this.heartbeatTimers.get(sessionId) ?? {};
      entry.repeat = repeat;
      this.heartbeatTimers.set(sessionId, entry);
    }, SessionManagerImpl.FIRST_HEARTBEAT_DELAY_MS);

    this.heartbeatTimers.set(sessionId, { initial });
  }

  private scheduleTyping(sessionId: string): void {
    this.clearTyping(sessionId);
    void this.sendTyping(sessionId);

    const repeat = setInterval(() => {
      void this.sendTyping(sessionId);
    }, SessionManagerImpl.TYPING_INTERVAL_MS);

    this.typingTimers.set(sessionId, repeat);
  }

  private clearHeartbeat(sessionId: string): void {
    const timers = this.heartbeatTimers.get(sessionId);
    if (!timers) {
      return;
    }
    if (timers.initial) {
      clearTimeout(timers.initial);
    }
    if (timers.repeat) {
      clearInterval(timers.repeat);
    }
    this.heartbeatTimers.delete(sessionId);
  }

  private clearTyping(sessionId: string): void {
    const timer = this.typingTimers.get(sessionId);
    if (!timer) {
      return;
    }
    clearInterval(timer);
    this.typingTimers.delete(sessionId);
  }

  private async sendHeartbeat(sessionId: string): Promise<void> {
    const existing = this.store.get(sessionId);
    if (!existing || existing.record.status !== 'active') {
      this.clearHeartbeat(sessionId);
      return;
    }

    const now = Date.now();
    const lastProgressAt = existing.record.last_progress_at
      ? Date.parse(existing.record.last_progress_at)
      : NaN;
    const lastHeartbeatAt = existing.record.last_heartbeat_at
      ? Date.parse(existing.record.last_heartbeat_at)
      : NaN;

    const hasHeartbeat = !Number.isNaN(lastHeartbeatAt);
    const requiredGap = hasHeartbeat
      ? SessionManagerImpl.HEARTBEAT_INTERVAL_MS
      : SessionManagerImpl.FIRST_HEARTBEAT_DELAY_MS;
    const baseline = hasHeartbeat ? lastHeartbeatAt : lastProgressAt;

    if (Number.isNaN(baseline) || now - baseline < requiredGap) {
      return;
    }

    try {
      await this.tg.sendHeartbeatMessage(
        this.config.groupId,
        existing.record.topic_id
      );
      this.store.update(sessionId, (record) => {
        record.last_heartbeat_at = new Date().toISOString();
      });
      await this.store.save();
    } catch (err) {
      logger.warn('Failed to send heartbeat message', {
        session_id: sessionId,
        error: (err as Error).message,
      });
    }
  }

  private async sendTyping(sessionId: string): Promise<void> {
    const existing = this.store.get(sessionId);
    if (
      !existing ||
      existing.record.status !== 'active' ||
      !existing.record.last_progress_at
    ) {
      this.clearTyping(sessionId);
      return;
    }

    try {
      await this.tg.sendTypingAction(
        this.config.groupId,
        existing.record.topic_id
      );
    } catch (err) {
      logger.warn('Failed to send typing action', {
        session_id: sessionId,
        error: (err as Error).message,
      });
    }
  }
}
