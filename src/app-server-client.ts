type JsonRpcResponse = {
  id: string | number;
  result?: unknown;
  error?: {
    message?: string;
    code?: number;
  };
};

type ThreadTurn = {
  id: string;
  status?: string;
  items?: unknown[];
};

export interface AppServerConnection {
  request(method: string, params: unknown): Promise<any>;
  close(): Promise<void>;
}

export type AppServerConnectionFactory = (
  endpoint: string
) => Promise<AppServerConnection>;

export type RemoteInjectResult = {
  mode: 'start' | 'steer';
  turnId: string;
};

export type LocalInjectResult = {
  mode: 'start' | 'steer';
  turnId: string;
};

export type RemoteResumeResult = {
  threadId: string;
};

export type RemoteTurnSettlement = {
  status: string | null;
  outputText: string;
};

type ThreadReadResult = {
  thread?: {
    turns?: ThreadTurn[];
  };
  unavailableBeforeFirstUserMessage?: boolean;
};

type PendingRequest = {
  resolve: (value: any) => void;
  reject: (reason?: unknown) => void;
  timeout: NodeJS.Timeout;
};

class WebSocketAppServerConnection implements AppServerConnection {
  private nextId = 1;
  private pending = new Map<string | number, PendingRequest>();

  private constructor(
    private ws: WebSocket,
    private timeoutMs: number
  ) {
    this.ws.addEventListener('message', (event) => {
      void this.handleMessage(event.data);
    });
    this.ws.addEventListener('close', () => {
      this.rejectAll(new Error('app-server connection closed'));
    });
    this.ws.addEventListener('error', () => {
      this.rejectAll(new Error('app-server connection error'));
    });
  }

  static async connect(
    endpoint: string,
    timeoutMs: number
  ): Promise<WebSocketAppServerConnection> {
    const ws = new WebSocket(endpoint);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timed out connecting to app-server: ${endpoint}`));
      }, timeoutMs);
      ws.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true }
      );
      ws.addEventListener(
        'error',
        () => {
          clearTimeout(timer);
          reject(new Error(`Failed to connect to app-server: ${endpoint}`));
        },
        { once: true }
      );
    });

    const connection = new WebSocketAppServerConnection(ws, timeoutMs);
    await connection.request('initialize', {
      clientInfo: {
        name: 'tl',
        version: '0.1.0',
      },
      capabilities: null,
    });
    return connection;
  }

  async request(method: string, params: unknown): Promise<any> {
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method} response`));
      }, this.timeoutMs);

      this.pending.set(id, { resolve, reject, timeout });
      this.ws.send(payload);
    });
  }

  async close(): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) {
      return;
    }

    await new Promise<void>((resolve) => {
      this.ws.addEventListener(
        'close',
        () => resolve(),
        { once: true }
      );
      this.ws.close();
    });
  }

  private async handleMessage(raw: unknown): Promise<void> {
    const text = await toText(raw);
    if (!text) {
      return;
    }

    let parsed: JsonRpcResponse;
    try {
      parsed = JSON.parse(text) as JsonRpcResponse;
    } catch {
      return;
    }

    if (parsed.id == null) {
      return;
    }

    const pending = this.pending.get(parsed.id);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pending.delete(parsed.id);

    if (parsed.error) {
      pending.reject(new Error(parsed.error.message ?? 'app-server request failed'));
      return;
    }

    pending.resolve(parsed.result);
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

async function toText(raw: unknown): Promise<string> {
  if (typeof raw === 'string') {
    return raw;
  }
  if (raw instanceof ArrayBuffer) {
    return Buffer.from(raw).toString('utf-8');
  }
  if (raw instanceof Blob) {
    return await raw.text();
  }
  return '';
}

function buildTextInput(text: string) {
  return [
    {
      type: 'text',
      text,
      text_elements: [],
    },
  ];
}

function defaultConnectionFactory(endpoint: string): Promise<AppServerConnection> {
  return WebSocketAppServerConnection.connect(endpoint, 10_000);
}

export class AppServerClient {
  constructor(
    private connectionFactory: AppServerConnectionFactory = defaultConnectionFactory
  ) {}

  async resumeThread(args: {
    endpoint: string;
    threadId: string;
    cwd?: string;
  }): Promise<RemoteResumeResult> {
    const connection = await this.connectionFactory(args.endpoint);
    try {
      const response = await connection.request('thread/resume', {
        threadId: args.threadId,
        cwd: args.cwd ?? null,
      });
      const threadId = response?.thread?.id ?? args.threadId;
      if (!threadId) {
        throw new Error('thread/resume response did not include thread.id');
      }
      return { threadId };
    } finally {
      await connection.close();
    }
  }

  async injectReply(args: {
    endpoint: string;
    threadId: string;
    replyText: string;
  }): Promise<RemoteInjectResult> {
    const connection = await this.connectionFactory(args.endpoint);
    try {
      const threadRead = await this.readThreadSafe(connection, args.threadId);

      const turns = Array.isArray(threadRead?.thread?.turns)
        ? (threadRead.thread.turns as ThreadTurn[])
        : [];
      const activeTurn = [...turns].reverse().find((turn) => turn.status === 'inProgress');

      if (activeTurn?.id) {
        const steer = await connection.request('turn/steer', {
          threadId: args.threadId,
          expectedTurnId: activeTurn.id,
          input: buildTextInput(args.replyText),
        });
        return {
          mode: 'steer',
          turnId: steer?.turnId ?? activeTurn.id,
        };
      }

      const start = await connection.request('turn/start', {
        threadId: args.threadId,
        input: buildTextInput(args.replyText),
      });
      const turnId = start?.turn?.id;
      if (!turnId) {
        throw new Error('turn/start response did not include turn.id');
      }

      return {
        mode: 'start',
        turnId,
      };
    } finally {
      await connection.close();
    }
  }

  async injectLocalInput(args: {
    endpoint: string;
    threadId: string;
    text: string;
  }): Promise<LocalInjectResult> {
    return this.injectReply({
      endpoint: args.endpoint,
      threadId: args.threadId,
      replyText: args.text,
    });
  }

  async waitForTurnToSettle(args: {
    endpoint: string;
    threadId: string;
    turnId: string;
    timeoutMs?: number;
    pollIntervalMs?: number;
  }): Promise<RemoteTurnSettlement> {
    const connection = await this.connectionFactory(args.endpoint);
    const timeoutMs = args.timeoutMs ?? 120_000;
    const pollIntervalMs = args.pollIntervalMs ?? 1_000;
    const deadline = Date.now() + timeoutMs;

    try {
      while (true) {
        const threadRead = await this.readThreadSafe(connection, args.threadId, {
          tolerateUnavailableTurns: true,
        });
        if (threadRead.unavailableBeforeFirstUserMessage) {
          if (Date.now() >= deadline) {
            throw new Error(`Timed out waiting for remote turn to materialize: ${args.turnId}`);
          }
          await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
          continue;
        }
        const turns = Array.isArray(threadRead?.thread?.turns)
          ? (threadRead.thread.turns as ThreadTurn[])
          : [];
        const matched = [...turns].reverse().find((turn) => turn.id === args.turnId);
        const outputText = matched ? extractAssistantText(matched.items) : '';
        if (matched && (matched.status !== 'inProgress' || outputText.length > 0)) {
          return {
            status: matched.status ?? null,
            outputText,
          };
        }

        const activeTurn = turns.some((turn) => turn.status === 'inProgress');
        if (!matched && !activeTurn) {
          return {
            status: null,
            outputText: '',
          };
        }

        if (Date.now() >= deadline) {
          throw new Error(`Timed out waiting for remote turn to settle: ${args.turnId}`);
        }

        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }
    } finally {
      await connection.close();
    }
  }

  async createThread(args: {
    endpoint: string;
    cwd?: string;
    approvalPolicy?: 'never' | 'on-request' | 'on-failure' | 'untrusted';
    sandbox?: 'danger-full-access' | 'workspace-write' | 'read-only';
  }): Promise<{ threadId: string }> {
    const connection = await this.connectionFactory(args.endpoint);
    try {
      const response = await connection.request('thread/start', {
        cwd: args.cwd,
        approvalPolicy: args.approvalPolicy ?? 'never',
        sandbox: args.sandbox ?? 'danger-full-access',
        experimentalRawEvents: false,
        persistExtendedHistory: false,
      });
      const threadId = response?.thread?.id;
      if (!threadId) {
        throw new Error('thread/start response did not include thread.id');
      }
      return { threadId };
    } finally {
      await connection.close();
    }
  }

  private async readThreadSafe(
    connection: AppServerConnection,
    threadId: string,
    options: {
      tolerateUnavailableTurns?: boolean;
    } = {}
  ): Promise<ThreadReadResult> {
    try {
      return await connection.request('thread/read', {
        threadId,
        includeTurns: true,
      });
    } catch (err) {
      const message = (err as Error).message;
      if (message.includes('includeTurns is unavailable before first user message')) {
        if (options.tolerateUnavailableTurns) {
          return {
            unavailableBeforeFirstUserMessage: true,
            thread: {
              turns: [],
            },
          };
        }
        return {
          thread: {
            turns: [],
          },
        };
      }
      throw err;
    }
  }
}

function extractAssistantText(items: unknown[] | undefined): string {
  if (!Array.isArray(items) || items.length === 0) {
    return '';
  }

  const texts: string[] = [];

  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item);
      }
      return;
    }

    if (!value || typeof value !== 'object') {
      return;
    }

    const record = value as Record<string, unknown>;
    if (
      record.type === 'agentMessage' &&
      typeof record.text === 'string' &&
      record.text.trim().length > 0
    ) {
      texts.push(record.text.trim());
      return;
    }

    if (
      record.type === 'output_text' &&
      typeof record.text === 'string' &&
      record.text.trim().length > 0
    ) {
      texts.push(record.text.trim());
      return;
    }

    for (const nested of Object.values(record)) {
      visit(nested);
    }
  };

  visit(items);

  return dedupePreservingOrder(texts).join('\n\n');
}

function dedupePreservingOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }

  return result;
}
