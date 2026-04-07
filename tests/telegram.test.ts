import { describe, it, expect, beforeEach, vi } from 'vitest';

const grammyMocks = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
  on: vi.fn(),
  catch: vi.fn(),
  instances: [] as Array<{ token: string; config: any }>,
}));

vi.mock('grammy', () => ({
  Bot: class {
    api = {};

    constructor(token: string, config?: any) {
      grammyMocks.instances.push({ token, config });
    }

    catch = grammyMocks.catch;
    on = grammyMocks.on;
    start = grammyMocks.start;
    stop = grammyMocks.stop;
  },
}));

import { TelegramBot } from '../src/telegram.js';
import { DaemonConfig } from '../src/types.js';

const config: DaemonConfig = {
  botToken: 'test-token',
  groupId: -1001234567890,
  topicPrefix: '🔧',
  hookPort: 9877,
  hookBaseUrl: 'http://localhost:9877',
  stopTimeout: 3600,
  emojiReaction: '👍',
  liveStream: false,
};

describe('TelegramBot.init', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    grammyMocks.instances.length = 0;
  });

  it('returns after starting polling instead of waiting for bot shutdown', async () => {
    grammyMocks.start.mockReturnValue(new Promise(() => {}));

    const bot = new TelegramBot(config, { listActive: () => [] } as any, {
      deliver: () => false,
    } as any);

    const result = await Promise.race([
      bot.init().then(() => 'resolved'),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 50)),
    ]);

    expect(result).toBe('resolved');
    expect(grammyMocks.start).toHaveBeenCalledWith({
      allowed_updates: ['message'],
    });
  });

  it('configures grammY client to use an IPv4-only agent', async () => {
    grammyMocks.start.mockResolvedValue(undefined);

    const bot = new TelegramBot(config, { listActive: () => [] } as any, {
      deliver: () => false,
    } as any);

    await bot.init();

    expect(grammyMocks.instances).toHaveLength(1);
    const clientConfig = grammyMocks.instances[0].config?.client;
    expect(clientConfig?.baseFetchConfig?.agent).toBeDefined();
    expect(clientConfig.baseFetchConfig.agent.options.family).toBe(4);
  });

  it('renders stop messages through Telegram HTML mode', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 123 });
    const bot = new TelegramBot(config, { listActive: () => [] } as any, {
      deliver: () => false,
    } as any);

    (bot as any).bot = { api: { sendMessage } };

    await bot.sendStopMessage(config.groupId, 42, 'turn-1', 'finished', 7);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      config.groupId,
      '✅ Turn 7 완료\n\nfinished',
      {
        message_thread_id: 42,
        parse_mode: 'HTML',
      }
    );
  });

  it('renders local stop footer when local mode metadata is provided', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 123 });
    const bot = new TelegramBot(config, { listActive: () => [] } as any, {
      deliver: () => false,
    } as any);

    (bot as any).bot = { api: { sendMessage } };

    await bot.sendStopMessage(config.groupId, 42, 'turn-1', 'finished', 7, {
      mode: 'local',
    });

    expect(sendMessage).toHaveBeenCalledWith(
      config.groupId,
      '✅ Turn 7 완료\n\nfinished\n\n<i>mode: local-hook</i>',
      {
        message_thread_id: 42,
        parse_mode: 'HTML',
      }
    );
  });

  it('renders remote stop footer with mode and remote state', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 124 });
    const bot = new TelegramBot(config, { listActive: () => [] } as any, {
      deliver: () => false,
    } as any);

    (bot as any).bot = { api: { sendMessage } };

    await bot.sendStopMessage(config.groupId, 42, 'turn-1', 'finished', 7, {
      mode: 'remote-managed',
      remoteStatus: 'idle',
      remoteOwner: 'telegram',
    });

    expect(sendMessage).toHaveBeenCalledWith(
      config.groupId,
      '✅ Turn 7 완료\n\nfinished\n\n<i>mode: remote-managed · owner: telegram · state: idle</i>',
      {
        message_thread_id: 42,
        parse_mode: 'HTML',
      }
    );
  });

  it('sends the full stop message without appending the default follow-up prompt', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 123 });
    const bot = new TelegramBot(config, { listActive: () => [] } as any, {
      deliver: () => false,
    } as any);

    (bot as any).bot = { api: { sendMessage } };

    const lastMessage = 'JSON 파싱정상,~ 정도에서 잘려버렸고';

    await bot.sendStopMessage(config.groupId, 42, 'turn-1', lastMessage, 7);

    expect(sendMessage.mock.calls[0][1]).toContain(lastMessage);
    expect(sendMessage.mock.calls[0][1]).not.toContain('다음에는 뭘 할까');
  });

  it('splits long stop messages and preserves the full body across chunks', async () => {
    let nextMessageId = 500;
    const sendMessage = vi.fn().mockImplementation(async () => {
      nextMessageId += 1;
      return { message_id: nextMessageId };
    });
    const bot = new TelegramBot(config, { listActive: () => [] } as any, {
      deliver: () => false,
    } as any);

    (bot as any).bot = { api: { sendMessage } };

    const line = '긴 메시지 본문 줄입니다. ';
    const lastMessage = `${line.repeat(250)}\n${line.repeat(220)}`;

    const messageId = await bot.sendStopMessage(config.groupId, 42, 'turn-1', lastMessage, 7);

    expect(sendMessage.mock.calls.length).toBeGreaterThan(1);
    expect(messageId).toBe(nextMessageId);

    const sentTexts = sendMessage.mock.calls.map((call) => call[1] as string);
    expect(sentTexts[0].startsWith('✅ Turn 7 완료\n\n')).toBe(true);

    const reconstructed = [
      sentTexts[0].slice('✅ Turn 7 완료\n\n'.length),
      ...sentTexts.slice(1),
    ].join('');

    expect(reconstructed).toBe(lastMessage);
  });

  it('renders markdown file links as bold filenames only', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 123 });
    const bot = new TelegramBot(config, { listActive: () => [] } as any, {
      deliver: () => false,
    } as any);

    (bot as any).bot = { api: { sendMessage } };

    await bot.sendStopMessage(
      config.groupId,
      42,
      'turn-1',
      '변경 파일은 [session-start-filter.ts](/Users/flowkater/Projects/TL/src/session-start-filter.ts) 와 [cli.ts](/Users/flowkater/Projects/TL/src/cli.ts:12) 입니다.',
      7
    );

    expect(sendMessage).toHaveBeenCalledWith(
      config.groupId,
      '✅ Turn 7 완료\n\n변경 파일은 <b>session-start-filter.ts</b> 와 <b>cli.ts</b> 입니다.',
      {
        message_thread_id: 42,
        parse_mode: 'HTML',
      }
    );
  });

  it('retries stop message delivery on transient send failures', async () => {
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(new Error('Network request for sendMessage failed'))
      .mockResolvedValueOnce({ message_id: 321 });
    const bot = new TelegramBot(config, { listActive: () => [] } as any, {
      deliver: () => false,
    } as any);

    (bot as any).bot = { api: { sendMessage } };

    const messageId = await bot.sendStopMessage(config.groupId, 42, 'turn-1', 'retry body', 7);

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(messageId).toBe(321);
  });

  it('sends resume ACK as a plain topic message', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 901 });
    const bot = new TelegramBot(config, { listActive: () => [] } as any, {
      deliver: () => false,
    } as any);

    (bot as any).bot = { api: { sendMessage } };

    const messageId = await bot.sendResumeAckMessage(config.groupId, 42);

    expect(messageId).toBe(901);
    expect(sendMessage).toHaveBeenCalledWith(
      config.groupId,
      '✅ reply delivered to Codex, resuming...',
      {
        message_thread_id: 42,
      }
    );
  });

  it('sends remote delivery and recovery messages as plain topic messages', async () => {
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce({ message_id: 920 })
      .mockResolvedValueOnce({ message_id: 921 })
      .mockResolvedValueOnce({ message_id: 922 });
    const bot = new TelegramBot(config, { listActive: () => [] } as any, {
      deliver: () => false,
    } as any);

    (bot as any).bot = { api: { sendMessage } };

    const deliveredId = await bot.sendRemoteDeliveredMessage(config.groupId, 42);
    const reconnectId = await bot.sendRemoteRecoveryMessage(config.groupId, 42, 'reconnect');
    const fallbackId = await bot.sendRemoteRecoveryMessage(config.groupId, 42, 'fallback');

    expect(deliveredId).toBe(920);
    expect(reconnectId).toBe(921);
    expect(fallbackId).toBe(922);
    expect(sendMessage).toHaveBeenNthCalledWith(
      1,
      config.groupId,
      '✅ delivered to live remote thread',
      { message_thread_id: 42 }
    );
    expect(sendMessage).toHaveBeenNthCalledWith(
      2,
      config.groupId,
      '⚠️ remote reconnecting...',
      { message_thread_id: 42 }
    );
    expect(sendMessage).toHaveBeenNthCalledWith(
      3,
      config.groupId,
      '⚠️ remote recovery failed, falling back to resume',
      { message_thread_id: 42 }
    );
  });

  it('sends working and heartbeat messages as append-only topic messages', async () => {
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce({ message_id: 910 })
      .mockResolvedValueOnce({ message_id: 911 });
    const bot = new TelegramBot(config, { listActive: () => [] } as any, {
      deliver: () => false,
    } as any);

    (bot as any).bot = { api: { sendMessage } };

    const workingId = await bot.sendWorkingMessage(config.groupId, 42);
    const heartbeatId = await bot.sendHeartbeatMessage(config.groupId, 42);

    expect(workingId).toBe(910);
    expect(heartbeatId).toBe(911);
    expect(sendMessage).toHaveBeenNthCalledWith(
      1,
      config.groupId,
      '🛠️ resumed, working...',
      { message_thread_id: 42 }
    );
    expect(sendMessage).toHaveBeenNthCalledWith(
      2,
      config.groupId,
      '⏳ still working...',
      { message_thread_id: 42 }
    );
  });

  it('does not enqueue stale replies for an active session and sends a not-waiting notice', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 999 });
    const setMessageReaction = vi.fn().mockResolvedValue(undefined);
    const replyQueue = {
      deliver: vi.fn().mockReturnValue(false),
    };
    const bot = new TelegramBot(config, {
      listActive: () => [
        {
          id: 's1',
          record: {
            topic_id: 42,
            status: 'active',
            stop_message_id: 77,
          },
        },
      ],
    } as any, replyQueue as any);

    (bot as any).bot = { api: { sendMessage, setMessageReaction } };

    await (bot as any).handleMessage({
      chat: { id: config.groupId },
      message: {
        message_thread_id: 42,
        message_id: 88,
        text: 'late reply',
        reply_to_message: { message_id: 77 },
      },
    });

    expect(replyQueue.deliver).not.toHaveBeenCalled();
    expect(setMessageReaction).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      config.groupId,
      '⚠️ 지금은 reply 대기 상태가 아닙니다. 다음 작업 완료 메시지에 Reply해주세요',
      { message_thread_id: 42 }
    );
  });

  it('allows an all-view reply without thread id to use the queue-backed delivery path', async () => {
    const setMessageReaction = vi.fn().mockResolvedValue(undefined);
    const deliver = vi.fn().mockReturnValue(true);
    const bot = new TelegramBot(config, {
      listActive: () => [
        {
          id: 's1',
          record: {
            topic_id: 42,
            status: 'waiting',
            stop_message_id: 77,
          },
        },
      ],
    } as any, {
      deliver,
    } as any);

    (bot as any).bot = { api: { sendMessage: vi.fn(), setMessageReaction } };

    await (bot as any).handleMessage({
      chat: { id: config.groupId },
      message: {
        message_id: 88,
        text: 'reply while waiting',
        reply_to_message: { message_id: 77 },
      },
    });

    expect(deliver).toHaveBeenCalledWith('s1', 'reply while waiting');
  });

  it('ignores messages from chats outside the configured group', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 999 });
    const setMessageReaction = vi.fn().mockResolvedValue(undefined);
    const deliver = vi.fn().mockReturnValue(true);
    const bot = new TelegramBot(config, {
      listActive: () => [
        {
          id: 's1',
          record: {
            topic_id: 42,
            status: 'waiting',
            stop_message_id: 77,
            chat_id: config.groupId,
          },
        },
      ],
      listByStatus: () => [],
    } as any, {
      deliver,
    } as any);

    (bot as any).bot = { api: { sendMessage, setMessageReaction } };

    await (bot as any).handleMessage({
      chat: { id: -1009999999999 },
      message: {
        message_id: 88,
        message_thread_id: 42,
        text: 'wrong chat',
        reply_to_message: { message_id: 77 },
      },
    });

    expect(deliver).not.toHaveBeenCalled();
    expect(setMessageReaction).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('responds to /tl-status in the configured chat without requiring a reply target', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 777 });
    const bot = new TelegramBot(config, {
      listActive: () => [],
      listByStatus: () => [],
    } as any, {
      deliver: vi.fn(),
    } as any);

    (bot as any).bot = { api: { sendMessage, setMessageReaction: vi.fn() } };

    await (bot as any).handleMessage({
      chat: { id: config.groupId },
      message: {
        message_id: 88,
        message_thread_id: 42,
        text: '/tl-status',
      },
    });

    expect(sendMessage).toHaveBeenCalledWith(
      config.groupId,
      expect.stringContaining('TL bridge is running'),
      { message_thread_id: 42 }
    );
  });

  it('uses the late reply handler instead of the not-waiting notice for matched stop replies', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 999 });
    const setMessageReaction = vi.fn().mockResolvedValue(undefined);
    const lateReplyHandler = vi.fn().mockResolvedValue(true);
    const bot = new TelegramBot(config, {
      listActive: () => [
        {
          id: 's1',
          record: {
            topic_id: 42,
            status: 'active',
            stop_message_id: 77,
          },
        },
      ],
    } as any, {
      deliver: vi.fn().mockReturnValue(false),
    } as any);

    bot.setLateReplyHandler(lateReplyHandler);
    (bot as any).bot = { api: { sendMessage, setMessageReaction } };

    await (bot as any).handleMessage({
      chat: { id: config.groupId },
      message: {
        message_id: 88,
        message_thread_id: 42,
        text: 'late reply',
        reply_to_message: { message_id: 77 },
      },
    });

    expect(lateReplyHandler).toHaveBeenCalledWith('s1', 'late reply');
    expect(setMessageReaction).toHaveBeenCalledWith(
      config.groupId,
      88,
      [{ type: 'emoji', emoji: '👍' }]
    );
    expect(sendMessage).not.toHaveBeenCalledWith(
      config.groupId,
      '⚠️ 지금은 reply 대기 상태가 아닙니다. 다음 작업 완료 메시지에 Reply해주세요',
      expect.anything()
    );
  });

  it('routes matched active topic messages through the remote reply handler before the not-waiting branch', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 999 });
    const setMessageReaction = vi.fn().mockResolvedValue(undefined);
    const remoteReplyHandler = vi.fn().mockResolvedValue(true);
    const bot = new TelegramBot(config, {
      listActive: () => [
        {
          id: 's1',
          record: {
            topic_id: 42,
            status: 'active',
            mode: 'remote-managed',
            stop_message_id: 77,
            remote_mode_enabled: true,
            remote_input_owner: 'telegram',
            remote_status: 'idle',
            remote_endpoint: 'ws://127.0.0.1:4321',
            remote_thread_id: 'thread-1',
            remote_last_resume_at: null,
            remote_last_resume_error: null,
          },
        },
      ],
      listByStatus: () => [],
    } as any, {
      deliver: vi.fn().mockReturnValue(false),
    } as any);

    bot.setRemoteReplyHandler(remoteReplyHandler);
    (bot as any).bot = { api: { sendMessage, setMessageReaction } };

    await (bot as any).handleMessage({
      chat: { id: config.groupId },
      message: {
        message_id: 88,
        message_thread_id: 42,
        text: 'continue remotely',
      },
    });

    expect(remoteReplyHandler).toHaveBeenCalledWith('s1', 'continue remotely');
    expect(setMessageReaction).toHaveBeenCalledWith(
      config.groupId,
      88,
      [{ type: 'emoji', emoji: '👍' }]
    );
    expect(sendMessage).not.toHaveBeenCalledWith(
      config.groupId,
      '⚠️ 지금은 reply 대기 상태가 아닙니다. 다음 작업 완료 메시지에 Reply해주세요',
      expect.anything()
    );
  });

  it('routes completed all-view replies through the late reply handler', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 999 });
    const setMessageReaction = vi.fn().mockResolvedValue(undefined);
    const lateReplyHandler = vi.fn().mockResolvedValue(true);
    const bot = new TelegramBot(config, {
      listActive: () => [],
      listByStatus: (status: string) => status === 'completed'
        ? [
            {
              id: 's1',
              record: {
                topic_id: 42,
                status: 'completed',
                stop_message_id: 77,
              },
            },
          ]
        : [],
    } as any, {
      deliver: vi.fn().mockReturnValue(false),
    } as any);

    bot.setLateReplyHandler(lateReplyHandler);
    (bot as any).bot = { api: { sendMessage, setMessageReaction } };

    await (bot as any).handleMessage({
      chat: { id: config.groupId },
      message: {
        message_id: 88,
        text: 'completed late reply',
        reply_to_message: { message_id: 77 },
      },
    });

    expect(lateReplyHandler).toHaveBeenCalledWith('s1', 'completed late reply');
    expect(setMessageReaction).toHaveBeenCalledWith(
      config.groupId,
      88,
      [{ type: 'emoji', emoji: '👍' }]
    );
    expect(sendMessage).not.toHaveBeenCalledWith(
      config.groupId,
      '⚠️ 작업 완료 메시지에 Reply해주세요',
      expect.anything()
    );
  });

  it('routes a topic message without reply to the waiting session', async () => {
    const setMessageReaction = vi.fn().mockResolvedValue(undefined);
    const deliver = vi.fn().mockReturnValue(true);
    const bot = new TelegramBot(config, {
      listActive: () => [
        {
          id: 's1',
          record: {
            topic_id: 42,
            status: 'waiting',
            stop_message_id: 77,
            started_at: '2026-04-06T00:00:00.000Z',
          },
        },
      ],
      listByStatus: () => [],
    } as any, {
      deliver,
    } as any);

    (bot as any).bot = { api: { sendMessage: vi.fn(), setMessageReaction } };

    await (bot as any).handleMessage({
      chat: { id: config.groupId },
      message: {
        message_id: 88,
        message_thread_id: 42,
        text: 'topic waiting message',
      },
    });

    expect(deliver).toHaveBeenCalledWith('s1', 'topic waiting message');
  });

  it('routes a topic message without reply to the completed session late-reply handler', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 999 });
    const setMessageReaction = vi.fn().mockResolvedValue(undefined);
    const lateReplyHandler = vi.fn().mockResolvedValue(true);
    const bot = new TelegramBot(config, {
      listActive: () => [],
      listByStatus: (status: string) => status === 'completed'
        ? [
            {
              id: 's1',
              record: {
                topic_id: 42,
                status: 'completed',
                stop_message_id: 77,
                started_at: '2026-04-06T00:00:00.000Z',
                completed_at: '2026-04-06T00:05:00.000Z',
              },
            },
          ]
        : [],
    } as any, {
      deliver: vi.fn().mockReturnValue(false),
    } as any);

    bot.setLateReplyHandler(lateReplyHandler);
    (bot as any).bot = { api: { sendMessage, setMessageReaction } };

    await (bot as any).handleMessage({
      chat: { id: config.groupId },
      message: {
        message_id: 88,
        message_thread_id: 42,
        text: 'topic completed message',
      },
    });

    expect(lateReplyHandler).toHaveBeenCalledWith('s1', 'topic completed message');
    expect(setMessageReaction).toHaveBeenCalledWith(
      config.groupId,
      88,
      [{ type: 'emoji', emoji: '👍' }]
    );
  });

  it('uses the most recent session for thread-only topic routing', async () => {
    const setMessageReaction = vi.fn().mockResolvedValue(undefined);
    const deliver = vi.fn().mockReturnValue(true);
    const bot = new TelegramBot(config, {
      listActive: () => [
        {
          id: 'older-waiting',
          record: {
            topic_id: 42,
            status: 'waiting',
            stop_message_id: 70,
            started_at: '2026-04-06T00:00:00.000Z',
          },
        },
        {
          id: 'newer-waiting',
          record: {
            topic_id: 42,
            status: 'waiting',
            stop_message_id: 71,
            started_at: '2026-04-06T00:10:00.000Z',
          },
        },
      ],
      listByStatus: () => [],
    } as any, {
      deliver,
    } as any);

    (bot as any).bot = { api: { sendMessage: vi.fn(), setMessageReaction } };

    await (bot as any).handleMessage({
      chat: { id: config.groupId },
      message: {
        message_id: 88,
        message_thread_id: 42,
        text: 'latest topic message',
      },
    });

    expect(deliver).toHaveBeenCalledWith('newer-waiting', 'latest topic message');
    expect(deliver).not.toHaveBeenCalledWith('older-waiting', expect.anything());
  });

  it('sends a not-waiting notice when the waiting consumer already disappeared', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 999 });
    const setMessageReaction = vi.fn().mockResolvedValue(undefined);
    const replyQueue = {
      deliver: vi.fn().mockReturnValue(false),
    };
    const bot = new TelegramBot(config, {
      listActive: () => [
        {
          id: 's1',
          record: {
            topic_id: 42,
            status: 'waiting',
            stop_message_id: 77,
          },
        },
      ],
    } as any, replyQueue as any);

    (bot as any).bot = { api: { sendMessage, setMessageReaction } };

    await (bot as any).handleMessage({
      chat: { id: config.groupId },
      message: {
        message_thread_id: 42,
        message_id: 88,
        text: 'late reply',
        reply_to_message: { message_id: 77 },
      },
    });

    expect(replyQueue.deliver).toHaveBeenCalledWith('s1', 'late reply');
    expect(setMessageReaction).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      config.groupId,
      '⚠️ 지금은 reply 대기 상태가 아닙니다. 다음 작업 완료 메시지에 Reply해주세요',
      { message_thread_id: 42 }
    );
  });
});
