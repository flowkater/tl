// telegram.ts — grammY 봇 래퍼 (토픽/메시지/답장)
import https from 'node:https';
import path from 'path';
import { Bot, Context } from 'grammy';
import {
  ApprovalPolicy,
  DaemonConfig,
  DeferredLaunchPreferences,
  RemoteInputOwner,
  RemoteSessionStatus,
  SandboxMode,
  SessionMode,
  SessionRecord,
  TelegramControlCommand,
  TelegramDirectiveField,
  TelegramDirectiveValues,
  TopicPreferences,
} from './types.js';
import { ReplyQueue } from './reply-queue.js';
import { SessionsStore } from './store.js';
import { logger } from './logger.js';
import {
  compileDirectivePrompt,
  parseTelegramControlCommand,
  parseTelegramDirectiveMessage,
} from './telegram-directives.js';

type LateReplyHandler = (sessionId: string, replyText: string) => Promise<boolean>;
type RemoteReplyHandler = (sessionId: string, replyText: string) => Promise<boolean>;
type TopicPreferencesAccessor = {
  get(topicKey: string): TopicPreferences | undefined;
  set(topicKey: string, preferences: Partial<TopicPreferences>): void;
  clearField(topicKey: string, field: TelegramDirectiveField): void;
  save(): Promise<void>;
};

type ResolvedTelegramDirectives = {
  immediate: Pick<TelegramDirectiveValues, 'skill' | 'cmd'>;
  deferred: DeferredLaunchPreferences;
};

type NormalizedTopicPrompt = {
  prompt: string;
  deferred: DeferredLaunchPreferences;
  hasDeferredOverride: boolean;
};

export class TelegramBot {
  private static readonly SEND_RETRY_COUNT = 3;
  private static readonly SEND_RETRY_DELAY_MS = 400;
  private static readonly STOP_MESSAGE_CHUNK_LIMIT = 3000;
  private static readonly IPV4_AGENT = new https.Agent({ family: 4 });
  private bot: Bot | null = null;
  private config: DaemonConfig;
  private store: SessionsStore;
  private replyQueue: ReplyQueue;
  private topicPreferences: TopicPreferencesAccessor | null;
  private lateReplyHandler: LateReplyHandler | null = null;
  private remoteReplyHandler: RemoteReplyHandler | null = null;

  constructor(
    config: DaemonConfig,
    store: SessionsStore,
    replyQueue: ReplyQueue,
    topicPreferences?: TopicPreferencesAccessor | null
  ) {
    this.config = config;
    this.store = store;
    this.replyQueue = replyQueue;
    this.topicPreferences = topicPreferences ?? null;
  }

  setLateReplyHandler(handler: LateReplyHandler): void {
    this.lateReplyHandler = handler;
  }

  setRemoteReplyHandler(handler: RemoteReplyHandler): void {
    this.remoteReplyHandler = handler;
  }

  async init(): Promise<void> {
    if (!this.config.botToken) {
      throw new Error('botToken is required');
    }

    this.bot = new Bot(this.config.botToken, {
      client: {
        baseFetchConfig: {
          agent: TelegramBot.IPV4_AGENT,
        },
      },
    });

    // 전역 에러 핸들링
    this.bot.catch((err) => {
      const ctx = err.ctx;
      const error = err.error as any;
      logger.error('Telegram bot error', {
        error: error?.message ?? String(err.error),
        chatId: ctx?.chat?.id,
        userId: ctx?.from?.id,
      });
    });

    // 메시지 핸들러 — 단일 리스너, 동적 등록 금지
    this.bot.on('message', (ctx) => this.handleMessage(ctx));

    // 폴링은 데몬 수명 동안 계속 유지되므로 여기서 await하면 HTTP 서버 초기화가 막힌다.
    void this.bot.start({
      allowed_updates: ['message'],
    }).catch((err) => {
      logger.error('Telegram bot polling failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    logger.info('Telegram bot started (polling)');
  }

  // ===== 토픽 관리 =====

  async createTopic(project: string): Promise<number> {
    if (!this.bot) throw new Error('Bot not initialized');

    const now = new Date();
    const timeStr = now.toISOString().replace('T', ' ').slice(0, 16); // YYYY-MM-DD HH:mm
    const topicName = `${this.config.topicPrefix} ${project} — ${timeStr}`;

    const forumTopic = await this.bot.api.createForumTopic(
      this.config.groupId,
      topicName
    );

    logger.info('Forum topic created', {
      topic_id: forumTopic.message_thread_id,
      name: topicName,
    });

    return forumTopic.message_thread_id;
  }

  async deleteTopic(topicId: number): Promise<void> {
    if (!this.bot) throw new Error('Bot not initialized');
    await this.bot.api.deleteForumTopic(this.config.groupId, topicId);

    logger.info('Forum topic deleted', {
      topic_id: topicId,
    });
  }

  // ===== 메시지 전송 =====

  async sendStartMessage(
    chatId: number,
    topicId: number,
    sessionId: string,
    model: string
  ): Promise<number> {
    if (!this.bot) throw new Error('Bot not initialized');

    const msg = await this.bot.api.sendMessage(chatId, this.escapeMarkdownV2(
      `🟢 *새 세션*\n\nproject: ${sessionId}\nmodel: ${model}`
    ), {
      parse_mode: 'MarkdownV2',
      message_thread_id: topicId,
    });

    return msg.message_id;
  }

  async sendStopMessage(
    chatId: number,
    topicId: number,
    _turnId: string,
    lastMessage: string,
    totalTurns: number,
    options?: {
      mode?: SessionMode;
      remoteStatus?: RemoteSessionStatus | null;
      remoteOwner?: RemoteInputOwner | null;
    }
  ): Promise<number> {
    if (!this.bot) throw new Error('Bot not initialized');

    const bodyChunks = this.splitStopBody(
      lastMessage,
      TelegramBot.STOP_MESSAGE_CHUNK_LIMIT
    );

    let lastMessageId = 0;
    for (const [index, chunk] of bodyChunks.entries()) {
      const rendered = this.renderStopChunk(
        chunk,
        totalTurns,
        index === 0,
        index === bodyChunks.length - 1
          ? this.renderStopFooter(
            options?.mode,
            options?.remoteStatus ?? null,
            options?.remoteOwner ?? null
          )
          : null
      );
      const msg = await this.sendMessageWithRetry(chatId, rendered, {
        message_thread_id: topicId,
        parse_mode: 'HTML',
      });
      lastMessageId = msg.message_id;
    }

    return lastMessageId;
  }

  async sendCompleteMessage(
    chatId: number,
    topicId: number,
    totalTurns: number,
    duration: string
  ): Promise<void> {
    if (!this.bot) throw new Error('Bot not initialized');

    await this.bot.api.sendMessage(chatId, this.escapeMarkdownV2(
      `🏁 *세션 종료*\n\n총 ${totalTurns}턴 · ${duration}`
    ), {
      parse_mode: 'MarkdownV2',
      message_thread_id: topicId,
    });
  }

  async sendReconnectMessage(
    chatId: number,
    topicId: number,
    sessionId: string
  ): Promise<void> {
    if (!this.bot) throw new Error('Bot not initialized');

    await this.bot.api.sendMessage(chatId, this.escapeMarkdownV2(
      `🔌 *재연결 완료*\n\nsession: ${sessionId}\n이전 세션 복원됨`
    ), {
      parse_mode: 'MarkdownV2',
      message_thread_id: topicId,
    });
  }

  async sendResumeAckMessage(
    chatId: number,
    topicId: number
  ): Promise<number> {
    if (!this.bot) throw new Error('Bot not initialized');

    const msg = await this.sendMessageWithRetry(
      chatId,
      '✅ reply delivered to Codex, resuming...',
      {
        message_thread_id: topicId,
      }
    );
    return msg.message_id;
  }

  async sendTopicText(
    chatId: number,
    topicId: number,
    text: string
  ): Promise<number> {
    if (!this.bot) throw new Error('Bot not initialized');

    const msg = await this.sendMessageWithRetry(chatId, text, {
      message_thread_id: topicId,
    });
    return msg.message_id;
  }

  async sendRemoteDeliveredMessage(
    chatId: number,
    topicId: number
  ): Promise<number> {
    if (!this.bot) throw new Error('Bot not initialized');

    const msg = await this.sendMessageWithRetry(
      chatId,
      '✅ delivered to live remote thread',
      {
        message_thread_id: topicId,
      }
    );
    return msg.message_id;
  }

  async sendRemoteRecoveryMessage(
    chatId: number,
    topicId: number,
    phase: 'reconnect' | 'resume' | 'fallback'
  ): Promise<number> {
    if (!this.bot) throw new Error('Bot not initialized');

    const text = phase === 'reconnect'
      ? '⚠️ remote reconnecting...'
      : phase === 'resume'
        ? '⚠️ recovering remote thread...'
        : '⚠️ remote recovery failed, falling back to resume';

    const msg = await this.sendMessageWithRetry(chatId, text, {
      message_thread_id: topicId,
    });
    return msg.message_id;
  }

  async sendRemoteUnavailableMessage(
    chatId: number,
    topicId: number
  ): Promise<number> {
    if (!this.bot) throw new Error('Bot not initialized');

    const msg = await this.sendMessageWithRetry(
      chatId,
      '⚠️ remote delivery unavailable. Check TL remote status or retry after recovery.',
      {
        message_thread_id: topicId,
      }
    );
    return msg.message_id;
  }

  async sendWorkingMessage(
    chatId: number,
    topicId: number
  ): Promise<number> {
    if (!this.bot) throw new Error('Bot not initialized');

    const msg = await this.sendMessageWithRetry(
      chatId,
      '🛠️ resumed, working...',
      {
        message_thread_id: topicId,
      }
    );
    return msg.message_id;
  }

  async sendHeartbeatMessage(
    chatId: number,
    topicId: number
  ): Promise<number> {
    if (!this.bot) throw new Error('Bot not initialized');

    const msg = await this.sendMessageWithRetry(
      chatId,
      '⏳ still working...',
      {
        message_thread_id: topicId,
      }
    );
    return msg.message_id;
  }

  async sendTypingAction(
    chatId: number,
    topicId: number
  ): Promise<void> {
    if (!this.bot) throw new Error('Bot not initialized');

    await this.bot.api.sendChatAction(chatId, 'typing', {
      message_thread_id: topicId,
    });
  }

  async sendReplyFallbackMessage(
    chatId: number,
    topicId: number
  ): Promise<void> {
    if (!this.bot) throw new Error('Bot not initialized');

    await this.bot.api.sendMessage(chatId, '⚠️ 작업 완료 메시지에 Reply해주세요', {
      message_thread_id: topicId,
    });
  }

  async sendNotWaitingMessage(
    chatId: number,
    topicId: number
  ): Promise<void> {
    if (!this.bot) throw new Error('Bot not initialized');

    await this.bot.api.sendMessage(
      chatId,
      '⚠️ 지금은 reply 대기 상태가 아닙니다. 다음 작업 완료 메시지에 Reply해주세요',
      {
        message_thread_id: topicId,
      }
    );
  }

  async sendLateReplyResumeStartedMessage(
    chatId: number,
    topicId: number
  ): Promise<number> {
    if (!this.bot) throw new Error('Bot not initialized');

    const msg = await this.sendMessageWithRetry(
      chatId,
      '✅ late reply received, launching Codex resume...',
      {
        message_thread_id: topicId,
      }
    );
    return msg.message_id;
  }

  async sendLateReplyResumeFailedMessage(
    chatId: number,
    topicId: number,
    error: string
  ): Promise<number> {
    if (!this.bot) throw new Error('Bot not initialized');

    const msg = await this.sendMessageWithRetry(
      chatId,
      `⚠️ late reply resume failed: ${error}`,
      {
        message_thread_id: topicId,
      }
    );
    return msg.message_id;
  }

  async addReaction(
    chatId: number,
    messageId: number,
    emoji: string
  ): Promise<void> {
    if (!this.bot) throw new Error('Bot not initialized');

    try {
      await this.bot.api.setMessageReaction(chatId, messageId, [
        { type: 'emoji', emoji } as any,
      ]);
    } catch (err) {
      logger.warn('Failed to add reaction', {
        chatId,
        messageId,
        emoji,
        error: (err as Error).message,
      });
    }
  }

  // ===== 메시지 핸들링 =====

  private async handleMessage(ctx: Context): Promise<void> {
    const message = ctx.message;
    if (!message) return;
    if (ctx.chat?.id !== this.config.groupId) {
      logger.warn('Ignoring Telegram message from unexpected chat', {
        expectedChatId: this.config.groupId,
        actualChatId: ctx.chat?.id,
        messageId: message.message_id,
      });
      return;
    }

    const replyText = message.text ?? message.caption ?? '';
    if (!replyText.trim()) {
      return;
    }
    const trimmedText = replyText.trim();
    if (this.isStatusCommand(trimmedText)) {
      await this.sendStatusMessage(ctx.chat.id, message.message_thread_id);
      return;
    }

    const matched = this.matchMessageToSession(message);

    const effectiveTopicId = message.message_thread_id ?? matched?.record.topic_id;

    if (this.isTelegramControlCommand(trimmedText)) {
      await this.handleTelegramControlCommand(
        trimmedText,
        ctx.chat.id,
        effectiveTopicId,
        matched
      );
      return;
    }

    let normalizedPrompt = trimmedText;
    let deferredLaunchPreferences: DeferredLaunchPreferences = {};
    let hasDeferredOverride = false;
    if (effectiveTopicId) {
      try {
        const normalized = this.normalizeTopicPrompt(
          ctx.chat.id,
          effectiveTopicId,
          trimmedText
        );
        normalizedPrompt = normalized.prompt;
        deferredLaunchPreferences = normalized.deferred;
        hasDeferredOverride = normalized.hasDeferredOverride;
      } catch (err) {
        await this.sendTopicFeedback(
          ctx.chat.id,
          effectiveTopicId,
          `⚠️ ${(err as Error).message}`
        );
        return;
      }
    }

    // 1. reply가 있으면 먼저 stop_message_id로 전역 매칭한다.
    const replyTo = message.reply_to_message;
    if (replyTo) {
      if (matched) {
        await this.routeMatchedMessage(
          matched,
          normalizedPrompt,
          deferredLaunchPreferences,
          hasDeferredOverride,
          ctx.chat.id,
          message.message_id,
          true,
          message.message_thread_id
        );
        return;
      }
    }

    // 2. thread_id가 있으면 해당 topic의 최신 세션으로 라우팅한다.
    if (message.message_thread_id) {
      if (matched) {
        await this.routeMatchedMessage(
          matched,
          normalizedPrompt,
          deferredLaunchPreferences,
          hasDeferredOverride,
          ctx.chat.id,
          message.message_id,
          true,
          message.message_thread_id
        );
        return;
      }
    }

    // 3. reply는 있었지만 어떤 세션에도 매칭되지 않았다.
    if (replyTo) {
      if (message.message_thread_id) {
        await this.sendReplyFallbackMessage(
          this.config.groupId,
          message.message_thread_id
        );
      } else {
        await this.sendChatLevelMessage(
          this.config.groupId,
          '⚠️ 작업 완료 메시지에 Reply해주세요'
        );
      }
      return;
    }

    // 그 외에는 무시
  }

  private matchMessageToSession(
    message: {
      message_thread_id?: number;
      reply_to_message?: { message_id: number };
    }
  ): { id: string; record: SessionRecord } | null {
    const replyTo = message.reply_to_message;
    if (replyTo) {
      const matched = this.matchReplyToSession(replyTo.message_id);
      if (matched) {
        return matched;
      }
    }

    if (message.message_thread_id) {
      return this.getLatestSessionByTopic(message.message_thread_id);
    }

    return null;
  }

  private async routeMatchedMessage(
    matched: { id: string; record: SessionRecord },
    replyText: string,
    deferredLaunchPreferences: DeferredLaunchPreferences,
    hasDeferredOverride: boolean,
    chatId: number,
    messageId: number,
    allowLateReplyFromActive: boolean,
    sourceThreadId?: number
  ): Promise<void> {
    if (this.isTelegramFirstRemoteSession(matched.record)) {
      const handled = await this.routeRemoteManagedMessage(
        matched,
        replyText,
        deferredLaunchPreferences,
        hasDeferredOverride,
        chatId,
        messageId,
        sourceThreadId
      );
      if (handled) {
        return;
      }
    }

    if (this.remoteReplyHandler) {
      try {
        const handled = await this.remoteReplyHandler(matched.id, replyText);
        if (handled) {
          await this.persistPendingSpawnPreferences(
            matched.id,
            deferredLaunchPreferences,
            hasDeferredOverride
          );
          await this.addReaction(
            chatId,
            messageId,
            this.config.emojiReaction
          );
          if (hasDeferredOverride) {
            await this.sendDeferredOverrideAck(chatId, sourceThreadId ?? matched.record.topic_id);
          }
          return;
        }
      } catch (err) {
        logger.warn('Remote reply handler failed', {
          sessionId: matched.id,
          error: (err as Error).message,
        });
      }
    }

    if (matched.record.status === 'waiting') {
      const delivered = this.replyQueue.deliver(
        matched.id,
        replyText
      );
      if (delivered) {
        await this.persistPendingSpawnPreferences(
          matched.id,
          deferredLaunchPreferences,
          hasDeferredOverride
        );
        await this.addReaction(
          chatId,
          messageId,
          this.config.emojiReaction
        );
        if (hasDeferredOverride) {
          await this.sendDeferredOverrideAck(chatId, sourceThreadId ?? matched.record.topic_id);
        }
      } else {
        await this.sendNotWaitingMessage(
          chatId,
          sourceThreadId ?? matched.record.topic_id
        );
      }
      return;
    }

    const shouldUseLateReplyHandler = matched.record.status === 'completed'
      || allowLateReplyFromActive;

    if (shouldUseLateReplyHandler && this.lateReplyHandler) {
      try {
        const handled = await this.lateReplyHandler(matched.id, replyText);
        if (handled) {
          await this.persistPendingSpawnPreferences(
            matched.id,
            deferredLaunchPreferences,
            hasDeferredOverride
          );
          await this.addReaction(
            chatId,
            messageId,
            this.config.emojiReaction
          );
          if (hasDeferredOverride) {
            await this.sendDeferredOverrideAck(chatId, sourceThreadId ?? matched.record.topic_id);
          }
          return;
        }
      } catch (err) {
        logger.warn('Late reply handler failed', {
          sessionId: matched.id,
          error: (err as Error).message,
        });
      }
    }

    await this.sendNotWaitingMessage(
      chatId,
      sourceThreadId ?? matched.record.topic_id
    );
  }

  private async routeRemoteManagedMessage(
    matched: { id: string; record: SessionRecord },
    replyText: string,
    deferredLaunchPreferences: DeferredLaunchPreferences,
    hasDeferredOverride: boolean,
    chatId: number,
    messageId: number,
    sourceThreadId?: number
  ): Promise<boolean> {
    if (!this.remoteReplyHandler) {
      await this.sendRemoteUnavailableMessage(
        chatId,
        sourceThreadId ?? matched.record.topic_id
      );
      return true;
    }

    try {
      const handled = await this.remoteReplyHandler(matched.id, replyText);
      if (handled) {
        await this.persistPendingSpawnPreferences(
          matched.id,
          deferredLaunchPreferences,
          hasDeferredOverride
        );
        await this.addReaction(chatId, messageId, this.config.emojiReaction);
        if (hasDeferredOverride) {
          await this.sendDeferredOverrideAck(chatId, sourceThreadId ?? matched.record.topic_id);
        }
        return true;
      }
    } catch (err) {
      logger.warn('Remote managed delivery failed', {
        sessionId: matched.id,
        error: (err as Error).message,
      });
    }

    await this.sendRemoteUnavailableMessage(
      chatId,
      sourceThreadId ?? matched.record.topic_id
    );
    return true;
  }

  private matchReplyToSession(
    repliedToMessageId: number
  ): { id: string; record: SessionRecord } | null {
    const sessions = this.listReplyTargetSessions();
    for (const { id, record } of sessions) {
      const recordChatId = record.chat_id ?? this.config.groupId;
      if (recordChatId !== this.config.groupId) {
        continue;
      }
      if (record.stop_message_id === repliedToMessageId) {
        return { id, record };
      }
    }
    return null;
  }

  private getLatestSessionByTopic(
    threadId: number
  ): { id: string; record: SessionRecord } | null {
    const sessions = this.listReplyTargetSessions()
      .filter(({ record }) => {
        const recordChatId = record.chat_id ?? this.config.groupId;
        return record.topic_id === threadId && recordChatId === this.config.groupId;
      })
      .sort((a, b) => this.getSessionRecencyMs(b.record) - this.getSessionRecencyMs(a.record));

    return sessions[0] ?? null;
  }

  private listReplyTargetSessions(): Array<{ id: string; record: SessionRecord }> {
    const activeSessions = this.store.listActive();
    const completedSessions = typeof this.store.listByStatus === 'function'
      ? this.store.listByStatus('completed')
      : [];
    const merged = new Map<string, SessionRecord>();

    for (const { id, record } of [...activeSessions, ...completedSessions]) {
      merged.set(id, record);
    }

    return Array.from(merged.entries()).map(([id, record]) => ({ id, record }));
  }

  private getSessionRecencyMs(record: SessionRecord): number {
    const modeRank = this.isTelegramFirstRemoteSession(record) ? 10 : 0;
    const statusRank = record.status === 'waiting'
      ? 3
      : record.status === 'active'
        ? 2
        : record.status === 'completed'
          ? 1
          : 0;
    const effectiveAt = record.status === 'completed'
      ? record.completed_at ?? record.started_at
      : record.started_at;
    const parsed = Date.parse(effectiveAt);
    const timestamp = Number.isNaN(parsed) ? 0 : parsed;
    return (timestamp * 100) + (modeRank * 10) + statusRank;
  }

  private async sendChatLevelMessage(chatId: number, text: string): Promise<void> {
    if (!this.bot) throw new Error('Bot not initialized');
    await this.bot.api.sendMessage(chatId, text);
  }

  private async sendStatusMessage(chatId: number, threadId?: number): Promise<void> {
    if (!this.bot) throw new Error('Bot not initialized');

    const text = [
      '✅ TL bridge is running',
      '',
      `chat_id: ${chatId}`,
      `thread_id: ${threadId ?? 'none'}`,
    ].join('\n');

    if (threadId) {
      await this.bot.api.sendMessage(chatId, text, {
        message_thread_id: threadId,
      });
      return;
    }

    await this.bot.api.sendMessage(chatId, text);
  }

  private isStatusCommand(text: string): boolean {
    return /^\/tl-status(?:@\w+)?$/.test(text);
  }

  private isTelegramControlCommand(text: string): boolean {
    return /^\/tl(?:@\w+)?(?:\s|$)/i.test(text);
  }

  private async handleTelegramControlCommand(
    text: string,
    chatId: number,
    topicId: number | undefined,
    matched: { id: string; record: SessionRecord } | null
  ): Promise<void> {
    let command: TelegramControlCommand;
    try {
      command = parseTelegramControlCommand(text);
    } catch (err) {
      await this.sendTopicFeedback(chatId, topicId, `⚠️ ${(err as Error).message}`);
      return;
    }

    switch (command.kind) {
      case 'help':
        await this.sendTopicFeedback(
          chatId,
          topicId,
          [
            'TL commands:',
            '/tl help',
            '/tl status',
            '/tl resume',
            '/tl show config',
            '/tl set <field> <value>',
            '/tl clear <field>',
          ].join('\n')
        );
        return;
      case 'status':
        await this.sendTopicFeedback(
          chatId,
          topicId,
          this.renderTopicStatus(chatId, topicId, matched)
        );
        return;
      case 'resume':
        await this.handleTelegramResumeCommand(chatId, topicId, matched);
        return;
      case 'showConfig':
        await this.handleShowConfigCommand(chatId, topicId);
        return;
      case 'set':
        await this.handleSetPreferenceCommand(chatId, topicId, command.field, command.value);
        return;
      case 'clear':
        await this.handleClearPreferenceCommand(chatId, topicId, command.field);
        return;
      default:
        return;
    }
  }

  private async handleTelegramResumeCommand(
    chatId: number,
    topicId: number | undefined,
    matched: { id: string; record: SessionRecord } | null
  ): Promise<void> {
    if (!topicId) {
      await this.sendTopicFeedback(chatId, topicId, '⚠️ /tl resume requires a topic thread');
      return;
    }
    if (!matched || matched.record.status !== 'waiting') {
      await this.sendTopicFeedback(chatId, topicId, '⚠️ no waiting session is attached to this topic');
      return;
    }

    const delivered = this.replyQueue.deliver(matched.id, '/resume', {
      queueIfMissing: false,
    });
    if (!delivered) {
      await this.sendTopicFeedback(
        chatId,
        topicId,
        '⚠️ resume delivery failed: no waiting consumer is attached to this topic'
      );
      return;
    }

    await this.sendTopicFeedback(chatId, topicId, '✅ resume delivered to waiting session');
  }

  private async handleShowConfigCommand(chatId: number, topicId?: number): Promise<void> {
    if (!topicId) {
      await this.sendTopicFeedback(chatId, topicId, '⚠️ /tl show config requires a topic thread');
      return;
    }

    const topicDefaults = this.getTopicDefaults(chatId, topicId);
    const resolved = this.resolveTelegramDirectives(topicDefaults, {});
    const matched = this.getLatestSessionByTopic(topicId);
    const pendingSpawnPreferences = matched?.record.pending_spawn_preferences ?? resolved.deferred;
    const lines = [
      'Current topic config',
      '',
      `topic_key: ${this.buildTopicKey(chatId, topicId)}`,
      'persisted:',
      this.formatPreferences(topicDefaults),
      '',
      'effective immediate:',
      this.formatImmediateDirectives(resolved.immediate),
      '',
      'pending spawn preferences:',
      this.formatDeferredDirectives(pendingSpawnPreferences),
    ];
    await this.sendTopicFeedback(chatId, topicId, lines.join('\n'));
  }

  private async handleSetPreferenceCommand(
    chatId: number,
    topicId: number | undefined,
    field: TelegramDirectiveField,
    value: string | string[]
  ): Promise<void> {
    if (!topicId) {
      await this.sendTopicFeedback(chatId, topicId, '⚠️ /tl set requires a topic thread');
      return;
    }
    if (!this.topicPreferences) {
      await this.sendTopicFeedback(chatId, topicId, '⚠️ topic preferences store unavailable');
      return;
    }

    this.topicPreferences.set(this.buildTopicKey(chatId, topicId), {
      [field]: value,
    } as Partial<TopicPreferences>);
    await this.topicPreferences.save();

    await this.sendTopicFeedback(
      chatId,
      topicId,
      `✅ topic defaults updated\n${this.formatPreferences(this.getTopicDefaults(chatId, topicId))}`
    );
  }

  private async handleClearPreferenceCommand(
    chatId: number,
    topicId: number | undefined,
    field: TelegramDirectiveField
  ): Promise<void> {
    if (!topicId) {
      await this.sendTopicFeedback(chatId, topicId, '⚠️ /tl clear requires a topic thread');
      return;
    }
    if (!this.topicPreferences) {
      await this.sendTopicFeedback(chatId, topicId, '⚠️ topic preferences store unavailable');
      return;
    }

    this.topicPreferences.clearField(this.buildTopicKey(chatId, topicId), field);
    await this.topicPreferences.save();

    await this.sendTopicFeedback(
      chatId,
      topicId,
      `✅ topic defaults updated\n${this.formatPreferences(this.getTopicDefaults(chatId, topicId))}`
    );
  }

  private normalizeTopicPrompt(chatId: number, topicId: number, text: string): NormalizedTopicPrompt {
    const parsed = parseTelegramDirectiveMessage(text);
    const effective = this.resolveTelegramDirectives(
      this.getTopicDefaults(chatId, topicId),
      parsed.directives
    );
    const hasDeferredOverride = (
      parsed.directives.model !== undefined
      || parsed.directives['approval-policy'] !== undefined
      || parsed.directives.sandbox !== undefined
      || parsed.directives.cwd !== undefined
    );
    return {
      prompt: compileDirectivePrompt({
        body: parsed.body.trim(),
        directives: effective.immediate,
      }),
      deferred: effective.deferred,
      hasDeferredOverride,
    };
  }

  private resolveTelegramDirectives(
    topicDefaults: TopicPreferences | undefined,
    messageDirectives: TelegramDirectiveValues
  ): ResolvedTelegramDirectives {
    const immediate: Pick<TelegramDirectiveValues, 'skill' | 'cmd'> = {};
    const deferred: Omit<TelegramDirectiveValues, 'skill' | 'cmd'> = {};

    for (const field of ['skill', 'cmd'] as const) {
      const override = messageDirectives[field];
      const fallback = topicDefaults?.[field];
      if (override !== undefined) {
        immediate[field] = override;
      } else if (fallback !== undefined) {
        immediate[field] = [...fallback];
      }
    }

    for (const field of ['model', 'approval-policy', 'sandbox', 'cwd'] as const) {
      const override = messageDirectives[field];
      const fallback = topicDefaults?.[field];
      const value = override ?? fallback;
      if (value === undefined) {
        continue;
      }
      if (field === 'model' || field === 'cwd') {
        deferred[field] = value;
      } else if (field === 'approval-policy') {
        deferred['approval-policy'] = value as ApprovalPolicy;
      } else {
        deferred.sandbox = value as SandboxMode;
      }
    }

    return { immediate, deferred };
  }

  private getTopicDefaults(chatId: number, topicId: number): TopicPreferences | undefined {
    return this.topicPreferences?.get(this.buildTopicKey(chatId, topicId));
  }

  private buildTopicKey(chatId: number, topicId: number): string {
    return `${chatId}:${topicId}`;
  }

  private async persistPendingSpawnPreferences(
    sessionId: string,
    deferred: DeferredLaunchPreferences,
    hasDeferredOverride: boolean
  ): Promise<void> {
    if (!hasDeferredOverride) {
      return;
    }
    if (
      typeof (this.store as unknown as { update?: unknown }).update !== 'function'
      || typeof (this.store as unknown as { save?: unknown }).save !== 'function'
    ) {
      return;
    }

    const hasDeferred = (
      deferred.model !== undefined
      || deferred['approval-policy'] !== undefined
      || deferred.sandbox !== undefined
      || deferred.cwd !== undefined
    );
    this.store.update(sessionId, (record) => {
      record.pending_spawn_preferences = hasDeferred
        ? { ...deferred }
        : null;
    });
    await this.store.save();
  }

  private async sendDeferredOverrideAck(chatId: number, topicId?: number): Promise<void> {
    await this.sendTopicFeedback(
      chatId,
      topicId,
      'ℹ️ deferred spawn override saved for next managed spawn or reattach; current attached session is unchanged'
    );
  }

  private async sendTopicFeedback(chatId: number, topicId: number | undefined, text: string): Promise<void> {
    if (topicId) {
      await this.sendTopicText(chatId, topicId, text);
      return;
    }

    await this.sendChatLevelMessage(chatId, text);
  }

  private renderTopicStatus(
    chatId: number,
    topicId: number | undefined,
    matched: { id: string; record: SessionRecord } | null
  ): string {
    const topicDefaults = topicId ? this.getTopicDefaults(chatId, topicId) : undefined;
    const deferred = matched?.record.pending_spawn_preferences
      ?? this.resolveTelegramDirectives(topicDefaults, {}).deferred;
    return [
      'Current topic status',
      '',
      `topic_key: ${topicId ? this.buildTopicKey(chatId, topicId) : 'none'}`,
      `matched_session_id: ${matched?.id ?? 'none'}`,
      `session_status: ${matched?.record.status ?? 'none'}`,
      `mode: ${matched?.record.mode ?? 'none'}`,
      `attachment: ${matched ? this.describeAttachment(matched.record) : 'none'}`,
      `topic_defaults: ${topicDefaults ? 'configured' : 'none'}`,
      `pending_spawn_preferences: ${this.describePendingSpawnPreferences(deferred)}`,
    ].join('\n');
  }

  private describeAttachment(record: SessionRecord): string {
    if (record.mode === 'local-managed') {
      return record.local_attachment_id ?? 'local-managed';
    }
    if (record.mode === 'remote-managed') {
      return record.remote_thread_id ?? 'remote-managed';
    }
    return 'local-hook';
  }

  private describePendingSpawnPreferences(
    deferred: Omit<TelegramDirectiveValues, 'skill' | 'cmd'>
  ): string {
    const parts = [
      deferred.model ? `model=${deferred.model}` : null,
      deferred['approval-policy'] ? `approval-policy=${deferred['approval-policy']}` : null,
      deferred.sandbox ? `sandbox=${deferred.sandbox}` : null,
      deferred.cwd ? `cwd=${deferred.cwd}` : null,
    ].filter((value): value is string => value !== null);

    return parts.length > 0 ? parts.join(', ') : 'none';
  }

  private formatPreferences(preferences: TopicPreferences | undefined): string {
    if (!preferences) {
      return 'none';
    }

    const lines: string[] = [];
    if (preferences.skill) {
      lines.push(`skill: ${preferences.skill.join(', ')}`);
    }
    if (preferences.cmd) {
      lines.push(`cmd: ${preferences.cmd.join(', ')}`);
    }
    if (preferences.model) {
      lines.push(`model: ${preferences.model}`);
    }
    if (preferences['approval-policy']) {
      lines.push(`approval-policy: ${preferences['approval-policy']}`);
    }
    if (preferences.sandbox) {
      lines.push(`sandbox: ${preferences.sandbox}`);
    }
    if (preferences.cwd) {
      lines.push(`cwd: ${preferences.cwd}`);
    }
    lines.push(`updated_at: ${preferences.updated_at}`);
    return lines.join('\n');
  }

  private formatImmediateDirectives(
    directives: Pick<TelegramDirectiveValues, 'skill' | 'cmd'>
  ): string {
    const lines: string[] = [];
    if (directives.skill && directives.skill.length > 0) {
      lines.push(`skill: ${directives.skill.join(', ')}`);
    }
    if (directives.cmd && directives.cmd.length > 0) {
      lines.push(`cmd: ${directives.cmd.join(', ')}`);
    }
    return lines.length > 0 ? lines.join('\n') : 'none';
  }

  private formatDeferredDirectives(
    directives: Omit<TelegramDirectiveValues, 'skill' | 'cmd'>
  ): string {
    const lines: string[] = [];
    if (directives.model) {
      lines.push(`model: ${directives.model}`);
    }
    if (directives['approval-policy']) {
      lines.push(`approval-policy: ${directives['approval-policy']}`);
    }
    if (directives.sandbox) {
      lines.push(`sandbox: ${directives.sandbox}`);
    }
    if (directives.cwd) {
      lines.push(`cwd: ${directives.cwd}`);
    }
    return lines.length > 0 ? lines.join('\n') : 'none';
  }

  // ===== MarkdownV2 이스케이프 =====

  private escapeMarkdownV2(text: string): string {
    const chars = ['_', '*', '[', ']', '(', ')', '~', '`', '>', '#', '+', '-', '=', '|', '{', '}', '.', '!'];
    let result = text;
    for (const char of chars) {
      result = result.replaceAll(char, `\\${char}`);
    }
    return result;
  }

  private splitStopBody(text: string, limit: number): string[] {
    if (!text) {
      return [''];
    }
    if (text.length <= limit) {
      return [text];
    }

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > limit) {
      let splitAt = remaining.lastIndexOf('\n', limit);
      if (splitAt <= 0) {
        splitAt = limit;
        chunks.push(remaining.slice(0, splitAt));
        remaining = remaining.slice(splitAt);
        continue;
      }

      chunks.push(remaining.slice(0, splitAt + 1));
      remaining = remaining.slice(splitAt + 1);
    }

    if (remaining) {
      chunks.push(remaining);
    }

    return chunks;
  }

  private async sendMessageWithRetry(
    chatId: number,
    text: string,
    options: { message_thread_id: number; parse_mode?: 'HTML' | 'MarkdownV2' }
  ): Promise<{ message_id: number }> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= TelegramBot.SEND_RETRY_COUNT; attempt++) {
      try {
        return await this.bot!.api.sendMessage(chatId, text, options);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt === TelegramBot.SEND_RETRY_COUNT) {
          break;
        }

        const retryDelayMs =
          this.parseRetryAfterMs(lastError.message) ??
          TelegramBot.SEND_RETRY_DELAY_MS;

        logger.warn('Telegram sendMessage failed, retrying', {
          chatId,
          topicId: options.message_thread_id,
          attempt,
          error: lastError.message,
        });
        await this.delay(retryDelayMs);
      }
    }

    throw lastError ?? new Error('sendMessage failed');
  }

  private parseRetryAfterMs(message: string): number | null {
    const matched = /retry after\s+(\d+)/i.exec(message);
    if (!matched) {
      return null;
    }

    const seconds = Number.parseInt(matched[1], 10);
    if (!Number.isFinite(seconds) || seconds < 0) {
      return null;
    }

    return seconds * 1_000;
  }

  private async delay(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private renderStopChunk(
    body: string,
    totalTurns: number,
    includeHeader: boolean,
    footer: string | null
  ): string {
    const parts: string[] = [];

    if (includeHeader) {
      parts.push(this.escapeHtml(`✅ Turn ${totalTurns} 완료`));
    }
    if (body) {
      parts.push(this.renderTelegramStopBody(body));
    }
    if (footer) {
      parts.push(footer);
    }

    return parts.join('\n\n');
  }

  private renderStopFooter(
    mode?: SessionMode,
    remoteStatus?: RemoteSessionStatus | null,
    remoteOwner?: RemoteInputOwner | null
  ): string | null {
    if (!mode) {
      return null;
    }

    if (mode === 'local') {
      return '<i>mode: local-hook</i>';
    }

    if (mode === 'local-managed') {
      const ownerSuffix = remoteOwner ? ` · owner: ${this.escapeHtml(remoteOwner)}` : '';
      if (remoteStatus) {
        return `<i>mode: local-managed${ownerSuffix} · state: ${this.escapeHtml(remoteStatus)}</i>`;
      }
      return `<i>mode: local-managed${ownerSuffix}</i>`;
    }

    const ownerSuffix = remoteOwner ? ` · owner: ${this.escapeHtml(remoteOwner)}` : '';
    if (remoteStatus) {
      return `<i>mode: remote-managed${ownerSuffix} · state: ${this.escapeHtml(remoteStatus)}</i>`;
    }

    return `<i>mode: remote-managed${ownerSuffix}</i>`;
  }

  private renderTelegramStopBody(text: string): string {
    const fileRefPattern = /\[[^\]]+\]\((\/[^)]+)\)/g;
    let result = '';
    let lastIndex = 0;

    for (const match of text.matchAll(fileRefPattern)) {
      const index = match.index ?? 0;
      const target = match[1];

      result += this.escapeHtml(text.slice(lastIndex, index));
      result += `<b>${this.escapeHtml(this.extractFilenameFromTarget(target))}</b>`;
      lastIndex = index + match[0].length;
    }

    result += this.escapeHtml(text.slice(lastIndex));
    return result;
  }

  private extractFilenameFromTarget(target: string): string {
    const withoutAnchor = target.split('#')[0];
    const lineIndex = withoutAnchor.indexOf(':');
    const filePath = lineIndex >= 0
      ? withoutAnchor.slice(0, lineIndex)
      : withoutAnchor;
    return path.posix.basename(filePath);
  }

  private escapeHtml(text: string): string {
    return text
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;');
  }

  private isTelegramFirstRemoteSession(record: SessionRecord): boolean {
    return record.mode === 'remote-managed' && record.remote_input_owner === 'telegram';
  }

  async stop(): Promise<void> {
    if (this.bot) {
      await this.bot.stop();
      logger.info('Telegram bot stopped');
    }
  }
}
