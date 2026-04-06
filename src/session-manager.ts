// session-manager.ts — 세션 상태 전이 + TG 연동 조합
import { SessionManager, HookOutput, DaemonConfig } from './types.js';
import { SessionsStore } from './store.js';
import { ReplyQueue } from './reply-queue.js';
import { TelegramBot } from './telegram.js';
import { TlError } from './errors.js';
import { logger } from './logger.js';
import { hasRemoteSessionAttachment } from './remote-mode.js';

export class SessionManagerImpl implements SessionManager {
  private static readonly FIRST_HEARTBEAT_DELAY_MS = 2 * 60 * 1000;
  private static readonly HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
  private store: SessionsStore;
  private replyQueue: ReplyQueue;
  private tg: TelegramBot;
  private config: DaemonConfig;
  private heartbeatTimers = new Map<
    string,
    { initial?: NodeJS.Timeout; repeat?: NodeJS.Timeout }
  >();

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
  }): Promise<void> {
    const { session_id, model, project, is_reconnect } = args;

    // 상태 검증
    const existing = this.store.get(session_id);
    if (existing && !is_reconnect) {
      throw new TlError('Session already exists', 'SESSION_EXISTS');
    }

    let topic_id: number;

    if (is_reconnect && existing) {
      // 재연결: 기존 topic_id 재사용
      topic_id = existing.record.topic_id;
      this.clearHeartbeat(session_id);

      await this.tg.sendReconnectMessage(
        this.config.groupId,
        topic_id,
        session_id
      );

      this.store.update(session_id, (record) => {
        record.status = 'active';
        record.chat_id = this.config.groupId;
        record.started_at = new Date().toISOString();
        record.model = model;
        record.total_turns = existing.record.total_turns;
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
        record.remote_last_injection_error = null;
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
        remote_mode_enabled: false,
        remote_endpoint: null,
        remote_thread_id: null,
        remote_last_turn_id: null,
        remote_last_injection_at: null,
        remote_last_injection_error: null,
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

    if (hasRemoteSessionAttachment(existing.record)) {
      this.store.update(session_id, (record) => {
        record.status = 'active';
        record.total_turns = total_turns;
        record.last_turn_output = last_message;
        record.stop_message_id = null;
        record.last_progress_at = null;
        record.last_heartbeat_at = null;
      });
      this.clearHeartbeat(session_id);

      let stopMessageId: number;
      try {
        stopMessageId = await this.tg.sendStopMessage(
          this.config.groupId,
          existing.record.topic_id,
          args.turn_id,
          last_message,
          total_turns
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

      return { decision: 'continue' as const };
    }

    // 1. 세션을 waiting으로 전이
    this.store.update(session_id, (record) => {
      record.status = 'waiting';
      record.total_turns = total_turns;
      record.last_turn_output = last_message;
      record.stop_message_id = null;
      record.last_progress_at = null;
      record.last_heartbeat_at = null;
    });
    this.clearHeartbeat(session_id);

    let stopMessageId: number;
    try {
      // 2. Telegram에 stop 메시지 전송 (답장 대기용)
      stopMessageId = await this.tg.sendStopMessage(
        this.config.groupId,
        existing.record.topic_id,
        args.turn_id,
        last_message,
        total_turns
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

    await this.tg.sendWorkingMessage(
      this.config.groupId,
      existing.record.topic_id
    );

    this.store.update(args.session_id, (record) => {
      record.last_progress_at = new Date().toISOString();
      record.last_heartbeat_at = null;
    });

    this.scheduleHeartbeat(args.session_id);
  }

  // ===== complete =====

  async handleComplete(args: {
    session_id: string;
    total_turns: number;
    duration: string;
  }): Promise<void> {
    const { session_id, total_turns, duration } = args;
    this.clearHeartbeat(session_id);

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
}
