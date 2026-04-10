import { describe, it, expect } from 'vitest';
import {
  AppServerClient,
  type AppServerConnection,
  type AppServerConnectionFactory,
} from '../src/app-server-client.js';

class FakeConnection implements AppServerConnection {
  readonly calls: Array<{ method: string; params: unknown }> = [];

  async request(method: string, params: unknown): Promise<any> {
    this.calls.push({ method, params });
    if (method === 'thread/read') {
      return {
        thread: {
          id: 'thread-1',
          turns: [],
        },
      };
    }
    if (method === 'turn/start') {
      return {
        turn: {
          id: 'turn-started',
        },
      };
    }
    if (method === 'turn/steer') {
      return {
        turnId: 'turn-steered',
      };
    }
    throw new Error(`Unexpected method: ${method}`);
  }

  async close(): Promise<void> {}
}

describe('AppServerClient', () => {
  it('sends thread/resume with the same thread id before reinjection', async () => {
    const connection = new FakeConnection();
    connection.request = async (method: string, params: unknown) => {
      connection.calls.push({ method, params });
      if (method === 'thread/resume') {
        return {
          thread: {
            id: 'thread-1',
            turns: [],
          },
        };
      }
      throw new Error(`Unexpected method: ${method}`);
    };

    const factory: AppServerConnectionFactory = async () => connection;
    const client = new AppServerClient(factory);

    const result = await client.resumeThread({
      endpoint: 'ws://127.0.0.1:4321',
      threadId: 'thread-1',
      cwd: '/tmp/test',
    });

    expect(result).toEqual({ threadId: 'thread-1' });
    expect(connection.calls).toEqual([
      {
        method: 'thread/resume',
        params: {
          threadId: 'thread-1',
          cwd: '/tmp/test',
        },
      },
    ]);
  });

  it('sends turn/start with a text input when the thread is idle', async () => {
    const connection = new FakeConnection();
    const factory: AppServerConnectionFactory = async () => connection;
    const client = new AppServerClient(factory);

    const result = await client.injectReply({
      endpoint: 'ws://127.0.0.1:4321',
      threadId: 'thread-1',
      replyText: 'reply from telegram',
    });

    expect(result).toEqual({
      mode: 'start',
      turnId: 'turn-started',
    });
    expect(connection.calls).toEqual([
      {
        method: 'thread/read',
        params: { threadId: 'thread-1', includeTurns: true },
      },
      {
        method: 'turn/start',
        params: {
          threadId: 'thread-1',
          input: [
            {
              type: 'text',
              text: 'reply from telegram',
              text_elements: [],
            },
          ],
        },
      },
    ]);
  });

  it('exposes injectLocalInput as the same text injection path for local bridge callers', async () => {
    const connection = new FakeConnection();
    const factory: AppServerConnectionFactory = async () => connection;
    const client = new AppServerClient(factory);

    const result = await client.injectLocalInput({
      endpoint: 'ws://127.0.0.1:4321',
      threadId: 'thread-1',
      text: 'reply from local bridge',
    });

    expect(result).toEqual({
      mode: 'start',
      turnId: 'turn-started',
    });
    expect(connection.calls).toEqual([
      {
        method: 'thread/read',
        params: { threadId: 'thread-1', includeTurns: true },
      },
      {
        method: 'turn/start',
        params: {
          threadId: 'thread-1',
          input: [
            {
              type: 'text',
              text: 'reply from local bridge',
              text_elements: [],
            },
          ],
        },
      },
    ]);
  });

  it('sends turn/steer when the latest thread turn is still active', async () => {
    const connection = new FakeConnection();
    connection.request = async (method: string, params: unknown) => {
      connection.calls.push({ method, params });
      if (method === 'thread/read') {
        return {
          thread: {
            id: 'thread-1',
            turns: [{ id: 'turn-7', status: 'inProgress' }],
          },
        };
      }
      if (method === 'turn/steer') {
        return { turnId: 'turn-steered' };
      }
      throw new Error(`Unexpected method: ${method}`);
    };

    const factory: AppServerConnectionFactory = async () => connection;
    const client = new AppServerClient(factory);

    const result = await client.injectReply({
      endpoint: 'ws://127.0.0.1:4321',
      threadId: 'thread-1',
      replyText: 'interrupt with new instruction',
    });

    expect(result).toEqual({
      mode: 'steer',
      turnId: 'turn-steered',
    });
    expect(connection.calls).toEqual([
      {
        method: 'thread/read',
        params: { threadId: 'thread-1', includeTurns: true },
      },
      {
        method: 'turn/steer',
        params: {
          threadId: 'thread-1',
          expectedTurnId: 'turn-7',
          input: [
            {
              type: 'text',
              text: 'interrupt with new instruction',
              text_elements: [],
            },
          ],
        },
      },
    ]);
  });

  it('retries turn/steer with the active turn id reported by app-server on mismatch', async () => {
    const connection = new FakeConnection();
    let steerAttempts = 0;
    connection.request = async (method: string, params: unknown) => {
      connection.calls.push({ method, params });
      if (method === 'thread/read') {
        return {
          thread: {
            id: 'thread-1',
            turns: [{ id: 'turn-7', status: 'inProgress' }],
          },
        };
      }
      if (method === 'turn/steer') {
        steerAttempts += 1;
        if (steerAttempts === 1) {
          throw new Error('expected active turn id `turn-7` but found `turn-6`');
        }
        return { turnId: 'turn-steered' };
      }
      throw new Error(`Unexpected method: ${method}`);
    };

    const factory: AppServerConnectionFactory = async () => connection;
    const client = new AppServerClient(factory);

    const result = await client.injectReply({
      endpoint: 'ws://127.0.0.1:4321',
      threadId: 'thread-1',
      replyText: 'interrupt with new instruction',
    });

    expect(result).toEqual({
      mode: 'steer',
      turnId: 'turn-steered',
    });
    expect(connection.calls).toEqual([
      {
        method: 'thread/read',
        params: { threadId: 'thread-1', includeTurns: true },
      },
      {
        method: 'turn/steer',
        params: {
          threadId: 'thread-1',
          expectedTurnId: 'turn-7',
          input: [
            {
              type: 'text',
              text: 'interrupt with new instruction',
              text_elements: [],
            },
          ],
        },
      },
      {
        method: 'turn/steer',
        params: {
          threadId: 'thread-1',
          expectedTurnId: 'turn-6',
          input: [
            {
              type: 'text',
              text: 'interrupt with new instruction',
              text_elements: [],
            },
          ],
        },
      },
    ]);
  });

  it('falls back to turn/start when thread/read cannot include turns before the first user message', async () => {
    const connection = new FakeConnection();
    connection.request = async (method: string, params: unknown) => {
      connection.calls.push({ method, params });
      if (method === 'thread/read') {
        throw new Error('includeTurns is unavailable before first user message');
      }
      if (method === 'turn/start') {
        return {
          turn: {
            id: 'turn-started',
          },
        };
      }
      throw new Error(`Unexpected method: ${method}`);
    };

    const factory: AppServerConnectionFactory = async () => connection;
    const client = new AppServerClient(factory);

    const result = await client.injectReply({
      endpoint: 'ws://127.0.0.1:4321',
      threadId: 'thread-1',
      replyText: 'first remote turn',
    });

    expect(result).toEqual({
      mode: 'start',
      turnId: 'turn-started',
    });
    expect(connection.calls).toEqual([
      {
        method: 'thread/read',
        params: { threadId: 'thread-1', includeTurns: true },
      },
      {
        method: 'turn/start',
        params: {
          threadId: 'thread-1',
          input: [
            {
              type: 'text',
              text: 'first remote turn',
              text_elements: [],
            },
          ],
        },
      },
    ]);
  });

  it('waits until a remote turn settles before reporting completion', async () => {
    const connection = new FakeConnection();
    let readCount = 0;
    connection.request = async (method: string, params: unknown) => {
      connection.calls.push({ method, params });
      if (method === 'thread/read') {
        readCount += 1;
        return {
          thread: {
            id: 'thread-1',
            turns: [
              {
                id: 'turn-9',
                status: readCount === 1 ? 'inProgress' : 'completed',
                items: [
                  {
                    type: 'agentMessage',
                    text: 'remote final answer',
                    phase: 'final_answer',
                  },
                ],
              },
            ],
          },
        };
      }
      throw new Error(`Unexpected method: ${method}`);
    };

    const factory: AppServerConnectionFactory = async () => connection;
    const client = new AppServerClient(factory);

    const result = await client.waitForTurnToSettle({
      endpoint: 'ws://127.0.0.1:4321',
      threadId: 'thread-1',
      turnId: 'turn-9',
      pollIntervalMs: 0,
      timeoutMs: 1_000,
    });

    expect(result).toEqual({
      status: 'completed',
      outputText: 'remote final answer',
    });
    expect(connection.calls).toEqual([
      {
        method: 'thread/read',
        params: { threadId: 'thread-1', includeTurns: true },
      },
      {
        method: 'thread/read',
        params: { threadId: 'thread-1', includeTurns: true },
      },
    ]);
  });

  it('does not treat agent final_answer output as settled before status flips', async () => {
    const connection = new FakeConnection();
    let readCount = 0;
    connection.request = async (method: string, params: unknown) => {
      connection.calls.push({ method, params });
      if (method === 'thread/read') {
        readCount += 1;
        return {
          thread: {
            id: 'thread-1',
            turns: [
              {
                id: 'turn-10',
                status: readCount < 3 ? 'inProgress' : 'completed',
                items: [
                  {
                    type: 'userMessage',
                    content: [{ type: 'text', text: 'hello', text_elements: [] }],
                  },
                  {
                    type: 'agentMessage',
                    text: 'telegram-first output',
                    phase: 'final_answer',
                  },
                ],
              },
            ],
          },
        };
      }
      throw new Error(`Unexpected method: ${method}`);
    };

    const factory: AppServerConnectionFactory = async () => connection;
    const client = new AppServerClient(factory);

    const result = await client.waitForTurnToSettle({
      endpoint: 'ws://127.0.0.1:4321',
      threadId: 'thread-1',
      turnId: 'turn-10',
      pollIntervalMs: 0,
      timeoutMs: 1_000,
    });

    expect(result).toEqual({
      status: 'completed',
      outputText: 'telegram-first output',
    });
    expect(connection.calls).toHaveLength(3);
  });

  it('returns a missing settlement status when the watched turn disappears without an active successor', async () => {
    const connection = new FakeConnection();
    connection.request = async (method: string, params: unknown) => {
      connection.calls.push({ method, params });
      if (method === 'thread/read') {
        return {
          thread: {
            id: 'thread-1',
            turns: [],
          },
        };
      }
      throw new Error(`Unexpected method: ${method}`);
    };

    const factory: AppServerConnectionFactory = async () => connection;
    const client = new AppServerClient(factory);

    const result = await client.waitForTurnToSettle({
      endpoint: 'ws://127.0.0.1:4321',
      threadId: 'thread-1',
      turnId: 'turn-missing',
      pollIntervalMs: 0,
      timeoutMs: 1_000,
    });

    expect(result).toEqual({
      status: 'missing',
      outputText: '',
    });
  });
});
