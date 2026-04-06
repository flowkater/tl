import fs from 'fs';
import os from 'os';
import path from 'path';
import { TlError } from './errors.js';

type HookCommand = {
  type: 'command';
  command: string;
  statusMessage?: string;
  timeout?: number;
};

type HookMatcher = {
  hooks: HookCommand[];
  matcher?: string;
};

type HookEventName = 'SessionStart' | 'Stop';

type HooksFile = {
  hooks: Partial<Record<HookEventName | string, HookMatcher[]>>;
};

type EnsureTlHooksInstalledResult = {
  targetPath: string;
  changed: boolean;
  created: boolean;
  backupPath?: string;
  commandsInstalled: string[];
  commandsAlreadyPresent: string[];
};

export const TL_SESSION_START_HOOK: HookCommand = {
  type: 'command',
  command: 'tl hook-session-start',
  statusMessage: 'Connecting to Telegram...',
};

export const TL_STOP_HOOK: HookCommand = {
  type: 'command',
  command: 'tl hook-stop-and-wait',
  timeout: 7200,
};

export const TL_REMOTE_SESSION_START_WRAPPER_PATH = path.join(
  os.homedir(),
  '.codex',
  'hooks',
  'tl-remote-session-start.sh'
);

export function createRemoteSessionStartHook(wrapperPath = TL_REMOTE_SESSION_START_WRAPPER_PATH): HookCommand {
  return {
    type: 'command',
    command: wrapperPath,
    statusMessage: TL_SESSION_START_HOOK.statusMessage,
  };
}

export function createTlHooksTemplate(): HooksFile {
  return {
    hooks: {
      SessionStart: [{ hooks: [TL_SESSION_START_HOOK] }],
      Stop: [{ hooks: [TL_STOP_HOOK] }],
    },
  };
}

export function ensureTlHooksInstalled(targetPath: string): EnsureTlHooksInstalledResult {
  const targetDir = path.dirname(targetPath);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  if (!fs.existsSync(targetPath)) {
    writeJsonAtomic(targetPath, createTlHooksTemplate());
    return {
      targetPath,
      changed: true,
      created: true,
      commandsInstalled: [TL_SESSION_START_HOOK.command, TL_STOP_HOOK.command],
      commandsAlreadyPresent: [],
    };
  }

  const existing = parseHooksFile(targetPath);
  const commandsInstalled: string[] = [];
  const commandsAlreadyPresent: string[] = [];
  let changed = false;

  changed = ensureHookForEvent(
    existing,
    'SessionStart',
    TL_SESSION_START_HOOK,
    commandsInstalled,
    commandsAlreadyPresent
  ) || changed;

  changed = ensureHookForEvent(
    existing,
    'Stop',
    TL_STOP_HOOK,
    commandsInstalled,
    commandsAlreadyPresent
  ) || changed;

  if (!changed) {
    return {
      targetPath,
      changed: false,
      created: false,
      commandsInstalled,
      commandsAlreadyPresent,
    };
  }

  const backupPath = `${targetPath}.backup-${timestampForFilename()}`;
  fs.copyFileSync(targetPath, backupPath);
  writeJsonAtomic(targetPath, existing);

  return {
    targetPath,
    changed: true,
    created: false,
    backupPath,
    commandsInstalled,
    commandsAlreadyPresent,
  };
}

type ConfigureRemoteSessionStartResult = EnsureTlHooksInstalledResult & {
  remoteEnabled: boolean;
  sessionStartCommand: string;
};

export function enableRemoteSessionStartHook(
  targetPath: string,
  wrapperPath = TL_REMOTE_SESSION_START_WRAPPER_PATH
): ConfigureRemoteSessionStartResult {
  const remoteHook = createRemoteSessionStartHook(wrapperPath);
  return configureSessionStartHook(targetPath, remoteHook, true);
}

export function disableRemoteSessionStartHook(
  targetPath: string
): ConfigureRemoteSessionStartResult {
  return configureSessionStartHook(targetPath, TL_SESSION_START_HOOK, false);
}

function configureSessionStartHook(
  targetPath: string,
  sessionStartHook: HookCommand,
  remoteEnabled: boolean
): ConfigureRemoteSessionStartResult {
  const installResult = ensureTlHooksInstalled(targetPath);
  const hooksFile = parseHooksFile(targetPath);
  const changedCommands: string[] = [];
  const expectedCommand = sessionStartHook.command;
  const originalMatchers = hooksFile.hooks.SessionStart ?? [];
  const normalizedMatchers = normalizeSessionStartMatchers(
    originalMatchers,
    sessionStartHook
  );
  hooksFile.hooks.SessionStart = normalizedMatchers;
  const changed =
    JSON.stringify(originalMatchers) !== JSON.stringify(normalizedMatchers);
  if (changed) {
    changedCommands.push(expectedCommand);
  }

  if (!changed && !installResult.changed) {
    return {
      ...installResult,
      remoteEnabled,
      sessionStartCommand: expectedCommand,
    };
  }

  const backupPath = installResult.backupPath ?? `${targetPath}.backup-${timestampForFilename()}`;
  if (!installResult.backupPath && fs.existsSync(targetPath)) {
    fs.copyFileSync(targetPath, backupPath);
  }
  writeJsonAtomic(targetPath, hooksFile);

  return {
    targetPath,
    changed: true,
    created: installResult.created,
    backupPath,
    commandsInstalled: Array.from(
      new Set([...installResult.commandsInstalled, ...changedCommands])
    ),
    commandsAlreadyPresent: installResult.commandsAlreadyPresent.filter(
      (command) => command !== TL_SESSION_START_HOOK.command || expectedCommand === TL_SESSION_START_HOOK.command
    ),
    remoteEnabled,
    sessionStartCommand: expectedCommand,
  };
}

export function writeRemoteSessionStartWrapper(
  endpoint: string,
  wrapperPath = TL_REMOTE_SESSION_START_WRAPPER_PATH
): string {
  const wrapperDir = path.dirname(wrapperPath);
  if (!fs.existsSync(wrapperDir)) {
    fs.mkdirSync(wrapperDir, { recursive: true });
  }

  const script = [
    '#!/bin/zsh',
    `export TL_REMOTE_ENDPOINT=${shellQuote(endpoint)}`,
    'exec tl hook-session-start',
    '',
  ].join('\n');

  fs.writeFileSync(wrapperPath, script, { mode: 0o755 });
  fs.chmodSync(wrapperPath, 0o755);
  return wrapperPath;
}

function ensureHookForEvent(
  hooksFile: HooksFile,
  eventName: HookEventName,
  hook: HookCommand,
  commandsInstalled: string[],
  commandsAlreadyPresent: string[]
): boolean {
  const matchers = hooksFile.hooks[eventName] ?? [];
  const alreadyPresent = matchers.some((matcher) =>
    matcher.hooks.some(
      (candidate) =>
        candidate.type === hook.type &&
        commandsEquivalent(eventName, candidate.command, hook.command)
    )
  );

  if (alreadyPresent) {
    commandsAlreadyPresent.push(hook.command);
    return false;
  }

  matchers.push({ hooks: [hook] });
  hooksFile.hooks[eventName] = matchers;
  commandsInstalled.push(hook.command);
  return true;
}

function parseHooksFile(targetPath: string): HooksFile {
  let parsed: unknown;

  try {
    parsed = JSON.parse(fs.readFileSync(targetPath, 'utf-8'));
  } catch (cause) {
    throw new TlError(`Invalid hooks.json: ${(cause as Error).message}`, 'HOOKS_INVALID');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TlError('Invalid hooks.json: root must be an object', 'HOOKS_INVALID');
  }

  const root = parsed as { hooks?: unknown };
  if (!root.hooks || typeof root.hooks !== 'object' || Array.isArray(root.hooks)) {
    throw new TlError('Invalid hooks.json: hooks must be an object', 'HOOKS_INVALID');
  }

  for (const [eventName, value] of Object.entries(root.hooks)) {
    if (!Array.isArray(value)) {
      throw new TlError(
        `Invalid hooks.json: ${eventName} must be an array`,
        'HOOKS_INVALID'
      );
    }

    for (const matcher of value) {
      if (!matcher || typeof matcher !== 'object' || Array.isArray(matcher)) {
        throw new TlError(
          `Invalid hooks.json: ${eventName} matcher must be an object`,
          'HOOKS_INVALID'
        );
      }

      const matcherObject = matcher as { hooks?: unknown };
      if (!Array.isArray(matcherObject.hooks)) {
        throw new TlError(
          `Invalid hooks.json: ${eventName}.hooks must be an array`,
          'HOOKS_INVALID'
        );
      }
    }
  }

  return root as HooksFile;
}

function writeJsonAtomic(targetPath: string, value: unknown): void {
  const tmpPath = `${targetPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2), 'utf-8');
  fs.renameSync(tmpPath, targetPath);
}

function timestampForFilename(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function commandsEquivalent(
  eventName: HookEventName,
  currentCommand: string,
  expectedCommand: string
): boolean {
  if (currentCommand === expectedCommand) {
    return true;
  }
  if (eventName !== 'SessionStart') {
    return false;
  }
  return isTlSessionStartCommand(currentCommand) && isTlSessionStartCommand(expectedCommand);
}

function isTlSessionStartCommand(command: string): boolean {
  return (
    command === TL_SESSION_START_HOOK.command ||
    command === TL_REMOTE_SESSION_START_WRAPPER_PATH
  );
}

function normalizeSessionStartMatchers(
  matchers: HookMatcher[],
  desiredHook: HookCommand
): HookMatcher[] {
  const normalized: HookMatcher[] = [];
  let inserted = false;

  for (const matcher of matchers) {
    const retainedHooks: HookCommand[] = [];

    for (const hook of matcher.hooks) {
      if (hook.type === 'command' && isTlSessionStartCommand(hook.command)) {
        if (!inserted) {
          retainedHooks.push({ ...desiredHook });
          inserted = true;
        }
        continue;
      }
      retainedHooks.push(hook);
    }

    if (retainedHooks.length > 0) {
      normalized.push({
        ...matcher,
        hooks: retainedHooks,
      });
    }
  }

  if (!inserted) {
    normalized.push({ hooks: [{ ...desiredHook }] });
  }

  return normalized;
}
