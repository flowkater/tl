// telegram.ts — grammY 봇 래퍼 (토픽/메시지/답장)
import https from 'node:https';
import path from 'path';
import { Bot, Context } from 'grammy';
import {
  DaemonConfig,
  RemoteInputOwner,
  RemoteSessionStatus,
  SessionMode,
  SessionRecord,
} from './types.js';
import { ReplyQueue } from './reply-queue.js';
import { SessionsStore } from './store.js';
import { logger } from './logger.js';

type LateReplyHandler = (sessionId: string, replyText: string) => Promise<boolean>;
type RemoteReplyHandler = (sessionId: string, replyText: string) => Promise<boolean>;

export class TelegramBot {
  private static readonly SEND_RETRY_COUNT = 3;
  private static readonly SEND_RETRY_DELAY_MS = 400;
  private static readonly STOP_MESSAGE_CHUNK_LIMIT = 3000;
  private static readonly IPV4_AGENT = new https.Agent({ family: 4 });
  private bot: Bot | null = null;
  private config: DaemonConfig;
  private store: SessionsStore;
  private replyQueue: ReplyQueue;
  private lateReplyHandler: LateReplyHandler | null = null;
  private remoteReplyHandler: RemoteReplyHandler | null = null;

  constructor(config: DaemonConfig, store: SessionsStore, replyQueue: ReplyQueue) {
    this.config = config;
    this.store = store;
    this.replyQueue = replyQueue;
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
    if (this.isStatusCommand(replyText.trim())) {
      await this.sendStatusMessage(ctx.chat.id, message.message_thread_id);
      return;
    }

    // 1. reply가 있으면 먼저 stop_message_id로 전역 매칭한다.
    const replyTo = message.reply_to_message;
    if (replyTo) {
      const matched = this.matchReplyToSession(replyTo.message_id);
      if (matched) {
        await this.routeMatchedMessage(
          matched,
          replyText.trim(),
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
      const session = this.getLatestSessionByTopic(message.message_thread_id);
      if (session) {
        await this.routeMatchedMessage(
          session,
          replyText.trim(),
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

  private async routeMatchedMessage(
    matched: { id: string; record: SessionRecord },
    replyText: string,
    chatId: number,
    messageId: number,
    allowLateReplyFromActive: boolean,
    sourceThreadId?: number
  ): Promise<void> {
    if (this.isTelegramFirstRemoteSession(matched.record)) {
      const handled = await this.routeRemoteManagedMessage(
        matched,
        replyText,
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
          await this.addReaction(
            chatId,
            messageId,
            this.config.emojiReaction
          );
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
        await this.addReaction(
          chatId,
          messageId,
          this.config.emojiReaction
        );
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
          await this.addReaction(
            chatId,
            messageId,
            this.config.emojiReaction
          );
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
        await this.addReaction(chatId, messageId, this.config.emojiReaction);
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

        logger.warn('Telegram sendMessage failed, retrying', {
          chatId,
          topicId: options.message_thread_id,
          attempt,
          error: lastError.message,
        });
        await this.delay(TelegramBot.SEND_RETRY_DELAY_MS);
      }
    }

    throw lastError ?? new Error('sendMessage failed');
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
