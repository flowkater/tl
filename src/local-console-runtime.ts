import fs from 'fs';
import path from 'path';
import { spawn, type ChildProcess, type SpawnOptions } from 'child_process';
import { getConfigDir } from './config.js';
import type { DeferredLaunchPreferences } from './types.js';

type SpawnLike = typeof spawn;

type EnsureLocalConsoleArgs = {
  sessionId: string;
  endpoint: string;
  cwd: string;
  knownAttachmentId?: string | null;
  knownLogPath?: string | null;
  launchPrefs?: DeferredLaunchPreferences;
};

type EnsureLocalConsoleResult = {
  started: boolean;
  attachmentId: string;
  logPath: string;
};

type LocalConsoleRuntimeOptions = {
  spawnImpl?: SpawnLike;
  startupDelayMs?: number;
  screenBinary?: string;
};

export class LocalConsoleRuntimeManager {
  private readonly spawnImpl: SpawnLike;
  private readonly startupDelayMs: number;
  private readonly screenBinary: string;

  constructor(options: LocalConsoleRuntimeOptions = {}) {
    this.spawnImpl = options.spawnImpl ?? spawn;
    this.startupDelayMs = options.startupDelayMs ?? 1_500;
    this.screenBinary = options.screenBinary ?? 'screen';
  }

  async ensureAttached(args: EnsureLocalConsoleArgs): Promise<EnsureLocalConsoleResult> {
    const attachmentId = args.knownAttachmentId ?? buildLocalAttachmentId(args.sessionId);
    const logPath = args.knownLogPath ?? this.getLogPath(args.sessionId);
    const effectiveCwd = args.launchPrefs?.cwd ?? args.cwd;

    if (await this.hasSession(attachmentId)) {
      return {
        started: false,
        attachmentId,
        logPath,
      };
    }

    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const child = await this.spawnScreenSession({
      attachmentId,
      cwd: effectiveCwd,
      logPath,
      command: buildCodexResumeCommand(args.sessionId, args.endpoint, effectiveCwd, args.launchPrefs),
    });

    if (!child.pid) {
      throw new Error(`Failed to launch local console session for ${args.sessionId}`);
    }

    await delay(this.startupDelayMs);

    if (!(await this.hasSession(attachmentId))) {
      const tail = this.readLogTail(logPath);
      throw new Error(
        tail
          ? `Local console session exited during startup: ${tail}`
          : 'Local console session exited during startup'
      );
    }

    return {
      started: true,
      attachmentId,
      logPath,
    };
  }

  async startFresh(args: {
    attachmentId: string;
    endpoint: string;
    cwd: string;
    initialPrompt?: string;
    env?: Record<string, string>;
    launchPrefs?: DeferredLaunchPreferences;
  }): Promise<EnsureLocalConsoleResult> {
    const logPath = this.getLogPath(args.attachmentId);
    const effectiveCwd = args.launchPrefs?.cwd ?? args.cwd;
    fs.mkdirSync(path.dirname(logPath), { recursive: true });

    const child = await this.spawnScreenSession({
      attachmentId: args.attachmentId,
      cwd: effectiveCwd,
      logPath,
      command: buildCodexRemoteOpenCommand(
        args.endpoint,
        effectiveCwd,
        args.initialPrompt,
        args.launchPrefs
      ),
      exports: args.env ?? {},
    });

    if (!child.pid) {
      throw new Error(`Failed to launch local console session for ${args.attachmentId}`);
    }

    await delay(this.startupDelayMs);

    if (!(await this.hasSession(args.attachmentId))) {
      const tail = this.readLogTail(logPath);
      throw new Error(
        tail
          ? `Local console session exited during startup: ${tail}`
          : 'Local console session exited during startup'
      );
    }

    return {
      started: true,
      attachmentId: args.attachmentId,
      logPath,
    };
  }

  async attach(attachmentId: string, cwd: string): Promise<number> {
    const commandArgs = ['-D', '-r', attachmentId];
    const spawnOptions: SpawnOptions = {
      cwd,
      stdio: 'inherit',
    };

    const child = this.spawnImpl(this.screenBinary, commandArgs, spawnOptions);

    return await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolve(code ?? 0));
    });
  }

  private async hasSession(attachmentId: string): Promise<boolean> {
    const result = await this.inspectScreen(['-ls', attachmentId]);
    return result.output.includes(attachmentId);
  }

  private async spawnScreenSession(args: {
    attachmentId: string;
    cwd: string;
    logPath: string;
    command: string;
    exports?: Record<string, string>;
  }): Promise<ChildProcess> {
    const logDir = path.dirname(args.logPath);
    const spawnOptions: SpawnOptions = {
      cwd: logDir,
      stdio: 'ignore',
    };

    const child = this.spawnImpl(
      this.screenBinary,
      [
        '-dmS',
        args.attachmentId,
        '-L',
        'bash',
        '-lc',
        buildScreenShellCommand(args.cwd, args.command, args.exports ?? {}),
      ],
      spawnOptions
    );

    await onceSpawned(child);

    return child;
  }

  private async inspectScreen(commandArgs: string[]): Promise<{
    code: number;
    output: string;
  }> {
    const child = this.spawnImpl(this.screenBinary, commandArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    child.stdout?.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      output += chunk.toString();
    });

    return await new Promise<{ code: number; output: string }>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolve({ code: code ?? 0, output }));
    });
  }

  private getLogPath(sessionId: string): string {
    return path.join(getConfigDir(), 'local-consoles', sessionId, 'screenlog.0');
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

export function buildLocalAttachmentId(sessionId: string): string {
  return `tl-local-${sessionId}`;
}

function buildCodexResumeCommand(
  sessionId: string,
  endpoint: string,
  cwd: string,
  launchPrefs?: DeferredLaunchPreferences
): string {
  return `codex ${buildCodexCommandArgs({
    action: 'resume',
    endpoint,
    cwd,
    sessionId,
    launchPrefs,
  }).map(shellQuote).join(' ')}`;
}

function buildCodexRemoteOpenCommand(
  endpoint: string,
  cwd: string,
  initialPrompt?: string,
  launchPrefs?: DeferredLaunchPreferences
): string {
  return `codex ${buildCodexCommandArgs({
    action: 'open',
    endpoint,
    cwd,
    initialPrompt,
    launchPrefs,
  }).map(shellQuote).join(' ')}`;
}

function buildCodexCommandArgs(args: {
  action: 'resume' | 'open';
  endpoint: string;
  cwd: string;
  sessionId?: string;
  initialPrompt?: string;
  launchPrefs?: DeferredLaunchPreferences;
}): string[] {
  const commandArgs: string[] = [];
  if (args.action === 'resume') {
    commandArgs.push('resume');
  }

  commandArgs.push('--remote', args.endpoint);
  appendLaunchPreferenceArgs(commandArgs, args.launchPrefs);
  commandArgs.push('--no-alt-screen', '--cd', args.cwd);

  if (args.action === 'resume' && args.sessionId) {
    commandArgs.push(args.sessionId);
  }
  if (args.action === 'open' && args.initialPrompt && args.initialPrompt.trim().length > 0) {
    commandArgs.push(args.initialPrompt);
  }

  return commandArgs;
}

function appendLaunchPreferenceArgs(
  commandArgs: string[],
  launchPrefs?: DeferredLaunchPreferences
): void {
  if (launchPrefs?.model) {
    commandArgs.push('--model', launchPrefs.model);
  }

  const approvalPolicy = launchPrefs?.['approval-policy'];
  const sandbox = launchPrefs?.sandbox;
  if (approvalPolicy) {
    commandArgs.push('--ask-for-approval', approvalPolicy);
  }
  if (sandbox) {
    commandArgs.push('--sandbox', sandbox);
  }
  if (!approvalPolicy && !sandbox) {
    commandArgs.push('--dangerously-bypass-approvals-and-sandbox');
  }
}

function buildScreenShellCommand(
  cwd: string,
  command: string,
  env: Record<string, string>
): string {
  const exportCommands = Object.entries(env).map(
    ([key, value]) => `export ${shellQuote(`${key}=${value}`)}`
  );
  const prefix = exportCommands.length > 0 ? `${exportCommands.join(' && ')} && ` : '';
  return `cd ${shellQuote(cwd)} && ${prefix}exec ${command}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function onceSpawned(child: ChildProcess): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('spawn', () => resolve());
  });
}
