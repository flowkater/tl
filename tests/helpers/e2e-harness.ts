import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { fileURLToPath } from 'url';
import { serve } from '@hono/node-server';
import { createDaemonApp } from '../../src/daemon.js';
import { ReplyQueue } from '../../src/reply-queue.js';
import { SessionManagerImpl } from '../../src/session-manager.js';
import { SessionsStore } from '../../src/store.js';
import type { DaemonConfig } from '../../src/types.js';

type TranscriptPhase = 'user' | 'commentary' | 'final';

type CliResult = {
  code: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

type TelegramEvent =
  | { type: 'topic'; project: string; topicId: number }
  | { type: 'start'; chatId: number; topicId: number; sessionId: string; model: string }
  | { type: 'stop'; chatId: number; topicId: number; body: string; totalTurns: number }
  | { type: 'resume-ack'; chatId: number; topicId: number }
  | { type: 'working'; chatId: number; topicId: number }
  | { type: 'complete'; chatId: number; topicId: number; totalTurns: number; duration: string }
  | { type: 'reconnect'; chatId: number; topicId: number; sessionId: string }
  | { type: 'heartbeat'; chatId: number; topicId: number }
  | { type: 'late-reply-started'; chatId: number; topicId: number }
  | { type: 'late-reply-failed'; chatId: number; topicId: number; error: string }
  | { type: 'bot-stop' };

class FakeTelegramTransport {
  events: TelegramEvent[] = [];
  private nextTopicId = 40;
  private nextMessageId = 500;

  async createTopic(project: string): Promise<number> {
    this.nextTopicId += 1;
    this.events.push({
      type: 'topic',
      project,
      topicId: this.nextTopicId,
    });
    return this.nextTopicId;
  }

  async sendStartMessage(
    chatId: number,
    topicId: number,
    sessionId: string,
    model: string
  ): Promise<number> {
    this.events.push({ type: 'start', chatId, topicId, sessionId, model });
    return this.nextMessageId++;
  }

  async sendStopMessage(
    chatId: number,
    topicId: number,
    _turnId: string,
    body: string,
    totalTurns: number
  ): Promise<number> {
    this.events.push({ type: 'stop', chatId, topicId, body, totalTurns });
    return this.nextMessageId++;
  }

  async sendResumeAckMessage(chatId: number, topicId: number): Promise<number> {
    this.events.push({ type: 'resume-ack', chatId, topicId });
    return this.nextMessageId++;
  }

  async sendWorkingMessage(chatId: number, topicId: number): Promise<number> {
    this.events.push({ type: 'working', chatId, topicId });
    return this.nextMessageId++;
  }

  async sendCompleteMessage(
    chatId: number,
    topicId: number,
    totalTurns: number,
    duration: string
  ): Promise<void> {
    this.events.push({ type: 'complete', chatId, topicId, totalTurns, duration });
  }

  async sendReconnectMessage(chatId: number, topicId: number, sessionId: string): Promise<void> {
    this.events.push({ type: 'reconnect', chatId, topicId, sessionId });
  }

  async sendHeartbeatMessage(chatId: number, topicId: number): Promise<number> {
    this.events.push({ type: 'heartbeat', chatId, topicId });
    return this.nextMessageId++;
  }

  async sendLateReplyResumeStartedMessage(chatId: number, topicId: number): Promise<number> {
    this.events.push({ type: 'late-reply-started', chatId, topicId });
    return this.nextMessageId++;
  }

  async sendLateReplyResumeFailedMessage(
    chatId: number,
    topicId: number,
    error: string
  ): Promise<number> {
    this.events.push({ type: 'late-reply-failed', chatId, topicId, error });
    return this.nextMessageId++;
  }

  async stop(): Promise<void> {
    this.events.push({ type: 'bot-stop' });
  }

  find(type: TelegramEvent['type']): TelegramEvent | undefined {
    return this.events.find((event) => event.type === type);
  }

  count(type: TelegramEvent['type']): number {
    return this.events.filter((event) => event.type === type).length;
  }
}

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tl-e2e-'));
}

function repoRoot(): string {
  return path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
}

function tsxCliPath(): string {
  return path.join(repoRoot(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to allocate port'));
        return;
      }
      const port = address.port;
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(port);
      });
    });
    server.on('error', reject);
  });
}

function makeTranscript(entries: Array<[TranscriptPhase, string]>): string {
  const lines: unknown[] = [
    {
      type: 'session_meta',
      payload: {
        source: {
          type: 'user',
        },
      },
    },
  ];

  for (const [phase, text] of entries) {
    if (phase === 'user') {
      lines.push({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text }],
        },
      });
      continue;
    }

    lines.push({
      type: 'event_msg',
      payload: {
        type: 'agent_message',
        phase: phase === 'final' ? 'final_answer' : 'commentary',
        message: text,
      },
    });
  }

  return lines.map((line) => JSON.stringify(line)).join('\n');
}

export class TlE2EHarness {
  readonly rootDir: string;
  readonly configDir: string;
  readonly dataDir: string;
  readonly port: number;
  readonly config: DaemonConfig;
  readonly store: SessionsStore;
  readonly replyQueue: ReplyQueue;
  readonly telegram: FakeTelegramTransport;
  readonly sessionManager: SessionManagerImpl;
  private readonly previousEnv: {
    TL_CONFIG_DIR?: string;
    TL_DATA_DIR?: string;
  };
  private server: { close: (cb?: (err?: Error) => void) => void } | null;

  private constructor(args: {
    rootDir: string;
    configDir: string;
    dataDir: string;
    port: number;
    config: DaemonConfig;
    store: SessionsStore;
    replyQueue: ReplyQueue;
    telegram: FakeTelegramTransport;
    sessionManager: SessionManagerImpl;
    server: { close: (cb?: (err?: Error) => void) => void };
    previousEnv: { TL_CONFIG_DIR?: string; TL_DATA_DIR?: string };
  }) {
    this.rootDir = args.rootDir;
    this.configDir = args.configDir;
    this.dataDir = args.dataDir;
    this.port = args.port;
    this.config = args.config;
    this.store = args.store;
    this.replyQueue = args.replyQueue;
    this.telegram = args.telegram;
    this.sessionManager = args.sessionManager;
    this.server = args.server;
    this.previousEnv = args.previousEnv;
  }

  static async create(options: { stopTimeout?: number } = {}): Promise<TlE2EHarness> {
    const rootDir = makeTempDir();
    const configDir = path.join(rootDir, 'config');
    const dataDir = path.join(rootDir, 'data');
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });

    const port = await findFreePort();
    const config: DaemonConfig = {
      botToken: 'e2e-token',
      groupId: -1001234567890,
      topicPrefix: '🔧',
      hookPort: port,
      hookBaseUrl: `http://127.0.0.1:${port}`,
      stopTimeout: options.stopTimeout ?? 5,
      liveStream: false,
      emojiReaction: '👍',
    };

    fs.writeFileSync(
      path.join(configDir, 'config.json'),
      JSON.stringify(config, null, 2),
      'utf-8'
    );

    const previousEnv = {
      TL_CONFIG_DIR: process.env.TL_CONFIG_DIR,
      TL_DATA_DIR: process.env.TL_DATA_DIR,
    };
    process.env.TL_CONFIG_DIR = configDir;
    process.env.TL_DATA_DIR = dataDir;

    const store = new SessionsStore();
    await store.load();
    const replyQueue = new ReplyQueue();
    const telegram = new FakeTelegramTransport();
    const sessionManager = new SessionManagerImpl(
      store,
      replyQueue,
      telegram as any,
      config
    );
    const app = createDaemonApp({
      store,
      replyQueue,
      sessionManager,
    });
    const server = serve({
      fetch: app.fetch,
      port,
    });

    return new TlE2EHarness({
      rootDir,
      configDir,
      dataDir,
      port,
      config,
      store,
      replyQueue,
      telegram,
      sessionManager,
      server: server as any,
      previousEnv,
    });
  }

  url(route: string): string {
    return `http://127.0.0.1:${this.port}${route}`;
  }

  writeTranscript(entries: Array<[TranscriptPhase, string]>, fileName = 'session.jsonl'): string {
    const transcriptPath = path.join(this.rootDir, fileName);
    fs.writeFileSync(transcriptPath, makeTranscript(entries), 'utf-8');
    return transcriptPath;
  }

  sessionStartPayload(sessionId: string, transcriptPath: string): string {
    return JSON.stringify({
      session_id: sessionId,
      hook_event_name: 'SessionStart',
      model: 'gpt-5.4',
      cwd: repoRoot(),
      transcript_path: transcriptPath,
      source: 'user',
    });
  }

  stopPayload(sessionId: string, transcriptPath: string, lastAssistantMessage = 'fallback'): string {
    return JSON.stringify({
      session_id: sessionId,
      turn_id: 'turn-1',
      hook_event_name: 'Stop',
      model: 'gpt-5.4',
      cwd: repoRoot(),
      transcript_path: transcriptPath,
      stop_hook_active: true,
      last_assistant_message: lastAssistantMessage,
    });
  }

  workingPayload(sessionId: string): string {
    return JSON.stringify({
      session_id: sessionId,
      hook_event_name: 'UserPromptSubmit',
      prompt: 'continue',
      cwd: repoRoot(),
    });
  }

  spawnCli(args: string[], stdin: string, extraEnv: Record<string, string> = {}) {
    const child = spawn(
      process.execPath,
      [tsxCliPath(), path.join(repoRoot(), 'src', 'cli.ts'), ...args],
      {
        cwd: repoRoot(),
        env: {
          ...process.env,
          TL_CONFIG_DIR: this.configDir,
          TL_DATA_DIR: this.dataDir,
          ...extraEnv,
        },
        stdio: 'pipe',
      }
    );

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.stdin.write(stdin);
    child.stdin.end();

    return {
      child,
      waitForExit: async (): Promise<CliResult> =>
        new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('close', (code, signal) => {
            resolve({
              code: code ?? 1,
              signal,
              stdout,
              stderr,
            });
          });
        }),
    };
  }

  async runCli(
    args: string[],
    stdin: string,
    extraEnv: Record<string, string> = {}
  ): Promise<CliResult> {
    const handle = this.spawnCli(args, stdin, extraEnv);
    return handle.waitForExit();
  }

  async stopServer(): Promise<void> {
    if (!this.server) {
      return;
    }

    const current = this.server;
    this.server = null;
    await new Promise<void>((resolve) => {
      current.close(() => resolve());
    });
  }

  async close(): Promise<void> {
    this.replyQueue.shutdown();
    await this.stopServer();

    if (this.previousEnv.TL_CONFIG_DIR === undefined) {
      delete process.env.TL_CONFIG_DIR;
    } else {
      process.env.TL_CONFIG_DIR = this.previousEnv.TL_CONFIG_DIR;
    }

    if (this.previousEnv.TL_DATA_DIR === undefined) {
      delete process.env.TL_DATA_DIR;
    } else {
      process.env.TL_DATA_DIR = this.previousEnv.TL_DATA_DIR;
    }

    fs.rmSync(this.rootDir, { recursive: true, force: true });
  }
}

export async function runStandaloneCliWithConfig(args: {
  port: number;
  stopTimeout: number;
  stdin: string;
}): Promise<CliResult> {
  const rootDir = makeTempDir();
  const configDir = path.join(rootDir, 'config');
  const dataDir = path.join(rootDir, 'data');
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'config.json'),
    JSON.stringify(
      {
        botToken: 'e2e-token',
        groupId: -1001234567890,
        topicPrefix: '🔧',
        hookPort: args.port,
        hookBaseUrl: `http://127.0.0.1:${args.port}`,
        stopTimeout: args.stopTimeout,
        liveStream: false,
        emojiReaction: '👍',
      },
      null,
      2
    ),
    'utf-8'
  );

  const child: ChildProcessWithoutNullStreams = spawn(
    process.execPath,
    [tsxCliPath(), path.join(repoRoot(), 'src', 'cli.ts'), 'hook-stop-and-wait'],
    {
      cwd: repoRoot(),
      env: {
        ...process.env,
        TL_CONFIG_DIR: configDir,
        TL_DATA_DIR: dataDir,
      },
      stdio: 'pipe',
    }
  );

  let stdout = '';
  let stderr = '';

  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  child.stdin.write(args.stdin);
  child.stdin.end();

  const result = await new Promise<CliResult>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      resolve({
        code: code ?? 1,
        signal,
        stdout,
        stderr,
      });
    });
  });

  fs.rmSync(rootDir, { recursive: true, force: true });
  return result;
}
