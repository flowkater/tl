import fs from 'fs';
import path from 'path';
import { spawn, type ChildProcess, type SpawnOptions } from 'child_process';
import { getConfigDir } from './config.js';
import type { DeferredLaunchPreferences } from './types.js';

type SpawnLike = typeof spawn;

type EnsureRemoteWorkerArgs = {
  sessionId: string;
  endpoint: string;
  cwd: string;
  knownPid?: number | null;
  knownLogPath?: string | null;
  launchPrefs?: DeferredLaunchPreferences;
};

type EnsureRemoteWorkerResult = {
  started: boolean;
  pid: number;
  logPath: string;
};

type RemoteWorkerRuntimeOptions = {
  spawnImpl?: SpawnLike;
  startupDelayMs?: number;
};

export class RemoteWorkerRuntimeManager {
  private readonly spawnImpl: SpawnLike;
  private readonly startupDelayMs: number;
  private readonly cache = new Map<string, { pid: number; logPath: string }>();

  constructor(options: RemoteWorkerRuntimeOptions = {}) {
    this.spawnImpl = options.spawnImpl ?? spawn;
    this.startupDelayMs = options.startupDelayMs ?? 1_500;
  }

  async ensureAttached(args: EnsureRemoteWorkerArgs): Promise<EnsureRemoteWorkerResult> {
    const cached = this.cache.get(args.sessionId);
    if (cached && this.isAlive(cached.pid)) {
      return {
        started: false,
        pid: cached.pid,
        logPath: cached.logPath,
      };
    }

    if (args.knownPid && this.isAlive(args.knownPid)) {
      const logPath = args.knownLogPath ?? this.getLogPath(args.sessionId);
      this.cache.set(args.sessionId, {
        pid: args.knownPid,
        logPath,
      });
      return {
        started: false,
        pid: args.knownPid,
        logPath,
      };
    }

    const logPath = args.knownLogPath ?? this.getLogPath(args.sessionId);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });

    const child = this.spawnWorker(
      args.sessionId,
      args.endpoint,
      args.launchPrefs?.cwd ?? args.cwd,
      logPath,
      args.launchPrefs
    );
    if (!child.pid) {
      throw new Error(`Failed to launch remote worker for ${args.sessionId}`);
    }
    child.unref();

    await delay(this.startupDelayMs);
    if (!this.isAlive(child.pid)) {
      const tail = this.readLogTail(logPath);
      throw new Error(
        tail
          ? `Remote worker exited during startup: ${tail}`
          : 'Remote worker exited during startup'
      );
    }

    this.cache.set(args.sessionId, {
      pid: child.pid,
      logPath,
    });
    return {
      started: true,
      pid: child.pid,
      logPath,
    };
  }

  stopAll(): void {
    for (const [sessionId, worker] of this.cache.entries()) {
      this.stop(sessionId, worker.pid);
    }
    this.cache.clear();
  }

  private spawnWorker(
    sessionId: string,
    endpoint: string,
    cwd: string,
    logPath: string,
    launchPrefs?: DeferredLaunchPreferences
  ): ChildProcess {
    const options: SpawnOptions = {
      cwd,
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        TL_REMOTE_ENDPOINT: endpoint,
        TL_REMOTE_THREAD_ID: sessionId,
      },
    };

    return this.spawnImpl(
      'script',
      [
        '-q',
        logPath,
        'codex',
        ...buildCodexResumeArgs(sessionId, endpoint, cwd, launchPrefs),
      ],
      options
    );
  }

  private stop(sessionId: string, pid: number): void {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      this.cache.delete(sessionId);
    }
  }

  private isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private getLogPath(sessionId: string): string {
    return path.join(getConfigDir(), 'remote-workers', `${sessionId}.log`);
  }

  private readLogTail(logPath: string): string {
    if (!fs.existsSync(logPath)) {
      return '';
    }
    const content = fs.readFileSync(logPath, 'utf-8').trim();
    if (!content) {
      return '';
    }
    const lines = content.split('\n');
    return lines.slice(-10).join(' | ');
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildCodexResumeArgs(
  sessionId: string,
  endpoint: string,
  cwd: string,
  launchPrefs?: DeferredLaunchPreferences
): string[] {
  const args = ['resume', '--remote', endpoint];

  if (launchPrefs?.model) {
    args.push('--model', launchPrefs.model);
  }

  const approvalPolicy = launchPrefs?.['approval-policy'];
  const sandbox = launchPrefs?.sandbox;
  if (approvalPolicy) {
    args.push('--ask-for-approval', approvalPolicy);
  }
  if (sandbox) {
    args.push('--sandbox', sandbox);
  }
  if (!approvalPolicy && !sandbox) {
    args.push('--dangerously-bypass-approvals-and-sandbox');
  }

  args.push('--no-alt-screen', '--cd', cwd, sessionId);
  return args;
}
