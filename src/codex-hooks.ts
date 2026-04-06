import fs from 'fs';
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
        candidate.command === hook.command
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
