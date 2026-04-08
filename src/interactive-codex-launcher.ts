import { spawn, type SpawnOptions } from 'child_process';

type SpawnLike = typeof spawn;

type LaunchInteractiveCodexArgs = {
  sessionId: string;
  endpoint: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
};

type LaunchInteractiveCodexOpenArgs = {
  endpoint: string;
  cwd: string;
  initialPrompt?: string;
  env?: NodeJS.ProcessEnv;
};

type LaunchInteractiveCodexOptions = {
  spawnImpl?: SpawnLike;
};

export function buildCodexResumeArgs(
  sessionId: string,
  endpoint: string,
  cwd: string
): string[] {
  return [
    'resume',
    '--remote',
    endpoint,
    '--dangerously-bypass-approvals-and-sandbox',
    '--cd',
    cwd,
    sessionId,
  ];
}

export function buildCodexOpenArgs(
  endpoint: string,
  cwd: string,
  initialPrompt?: string
): string[] {
  const args = [
    '--remote',
    endpoint,
    '--dangerously-bypass-approvals-and-sandbox',
    '--cd',
    cwd,
  ];

  if (initialPrompt && initialPrompt.trim().length > 0) {
    args.push(initialPrompt);
  }

  return args;
}

export async function launchInteractiveCodex(
  args: LaunchInteractiveCodexArgs,
  options: LaunchInteractiveCodexOptions = {}
): Promise<number> {
  const spawnImpl = options.spawnImpl ?? spawn;
  const commandArgs = buildCodexResumeArgs(args.sessionId, args.endpoint, args.cwd);
  return launchInteractiveCodexCommand(commandArgs, args.cwd, args.env, spawnImpl);
}

export async function launchInteractiveCodexOpen(
  args: LaunchInteractiveCodexOpenArgs,
  options: LaunchInteractiveCodexOptions = {}
): Promise<number> {
  const spawnImpl = options.spawnImpl ?? spawn;
  const commandArgs = buildCodexOpenArgs(args.endpoint, args.cwd, args.initialPrompt);
  return launchInteractiveCodexCommand(commandArgs, args.cwd, args.env, spawnImpl);
}

async function launchInteractiveCodexCommand(
  commandArgs: string[],
  cwd: string,
  env: NodeJS.ProcessEnv | undefined,
  spawnImpl: SpawnLike
): Promise<number> {
  const spawnOptions: SpawnOptions = {
    cwd,
    env: env ?? process.env,
    stdio: 'inherit',
  };

  const child = spawnImpl('codex', commandArgs, spawnOptions);
  const removeSignalHandlers = installSignalGuards();

  return await new Promise<number>((resolve, reject) => {
    const cleanup = () => {
      removeSignalHandlers();
    };

    child.once('error', (error) => {
      cleanup();
      reject(error);
    });

    child.once('close', (code) => {
      cleanup();
      resolve(code ?? 0);
    });
  });
}

function installSignalGuards(): () => void {
  const noop = () => {
    // Let the child process receive terminal signals without tearing down the wrapper first.
  };
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];

  for (const signal of signals) {
    process.on(signal, noop);
  }

  return () => {
    for (const signal of signals) {
      process.off(signal, noop);
    }
  };
}
