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

type RemoveTlHooksResult = {
  targetPath: string;
  changed: boolean;
  backupPath?: string;
  commandsRemoved: string[];
};

export const TL_HOOK_WRAPPER_PATH = path.join(os.homedir(), '.codex', 'hooks', 'tl-hook.sh');

export const TL_SESSION_START_HOOK: HookCommand = {
  type: 'command',
  command: `${TL_HOOK_WRAPPER_PATH} hook-session-start`,
  statusMessage: 'Connecting to Telegram...',
};

export const TL_STOP_HOOK: HookCommand = {
  type: 'command',
  command: `${TL_HOOK_WRAPPER_PATH} hook-stop-and-wait`,
  timeout: 7200,
};

export const TL_REMOTE_SESSION_START_WRAPPER_PATH = path.join(
  os.homedir(),
  '.codex',
  'hooks',
  'tl-remote-session-start.sh'
);

const LEGACY_TL_SESSION_START_COMMAND = 'tl hook-session-start';
const LEGACY_TL_STOP_COMMAND = 'tl hook-stop-and-wait';

export function writeHookRunnerScript(
  cliScriptPath: string,
  wrapperPath = TL_HOOK_WRAPPER_PATH,
  nodeBinary = 'node'
): string {
  const wrapperDir = path.dirname(wrapperPath);
  if (!fs.existsSync(wrapperDir)) {
    fs.mkdirSync(wrapperDir, { recursive: true });
  }
  const safeNodeBinary = nodeBinary.replace(/"/g, '\\"');

  const script = [
    '#!/usr/bin/env sh',
    'set -eu',
    '',
    'TL_NODE_BIN="\${TL_NODE_BIN:-' + safeNodeBinary + '}"',
    `TL_CLI_PATH="${cliScriptPath}"`,
    '',
    'if [ -n "${CODEX_TL_BIN:-}" ] && command -v "${CODEX_TL_BIN}" >/dev/null 2>&1; then',
    '  if "${CODEX_TL_BIN}" --help >/dev/null 2>&1; then',
    '  exec "${CODEX_TL_BIN}" "$@"',
    '  fi',
    'fi',
    '',
    'if [ -n "${TL_CLI_PATH}" ] && [ -f "${TL_CLI_PATH}" ]; then',
    '  if "${TL_NODE_BIN}" --version >/dev/null 2>&1; then',
    '  exec "${TL_NODE_BIN}" "${TL_CLI_PATH}" "$@"',
    '  fi',
    'fi',
    '',
    'if command -v tl >/dev/null 2>&1; then',
    '  if tl --help >/dev/null 2>&1; then',
    '    exec tl "$@"',
    '  fi',
    'fi',
    '',
    'echo "tl command unavailable. Set CODEX_TL_BIN or TL_CLI_PATH." >&2',
    'exit 127',
    '',
  ].join('\n');

  fs.writeFileSync(wrapperPath, script, { mode: 0o755 });
  fs.chmodSync(wrapperPath, 0o755);
  return wrapperPath;
}

export function createRemoteSessionStartHook(
  wrapperPath = TL_REMOTE_SESSION_START_WRAPPER_PATH
): HookCommand {
  return {
    type: 'command',
    command: wrapperPath,
    statusMessage: TL_SESSION_START_HOOK.statusMessage,
  };
}

export function createTlHooksTemplate(
  cliScriptPath = '',
  nodeBinary = 'node'
): HooksFile {
  if (cliScriptPath) {
    writeHookRunnerScript(cliScriptPath, TL_HOOK_WRAPPER_PATH, nodeBinary);
  }

  return {
    hooks: {
      SessionStart: [{ hooks: [TL_SESSION_START_HOOK] }],
      Stop: [{ hooks: [TL_STOP_HOOK] }],
    },
  };
}

export function ensureTlHooksInstalled(
  targetPath: string,
  cliScriptPath = '',
  nodeBinary = 'node'
): EnsureTlHooksInstalledResult {
  if (cliScriptPath) {
    writeHookRunnerScript(cliScriptPath, TL_HOOK_WRAPPER_PATH, nodeBinary);
  }

  const targetDir = path.dirname(targetPath);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  if (!fs.existsSync(targetPath)) {
    writeJsonAtomic(targetPath, createTlHooksTemplate(cliScriptPath, nodeBinary));
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

  changed =
    ensureHookForEvent(existing, 'SessionStart', TL_SESSION_START_HOOK, commandsInstalled, commandsAlreadyPresent) ||
    changed;

  changed =
    ensureHookForEvent(existing, 'Stop', TL_STOP_HOOK, commandsInstalled, commandsAlreadyPresent) ||
    changed;

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

export function removeTlHooks(targetPath: string): RemoveTlHooksResult {
  if (!fs.existsSync(targetPath)) {
    return {
      targetPath,
      changed: false,
      commandsRemoved: [],
    };
  }

  const hooksFile = parseHooksFile(targetPath);
  const commandsRemoved: string[] = [];
  let changed = false;

  for (const eventName of ['SessionStart', 'Stop'] as const) {
    const originalMatchers = hooksFile.hooks[eventName] ?? [];
    const normalizedMatchers: HookMatcher[] = [];

    for (const matcher of originalMatchers) {
      const retainedHooks = matcher.hooks.filter((hook) => {
        if (hook.type !== 'command') {
          return true;
        }

        const shouldRemove = eventName === 'SessionStart'
          ? isTlSessionStartCommand(hook.command)
          : isTlStopHookCommand(hook.command);

        if (shouldRemove) {
          commandsRemoved.push(hook.command);
          changed = true;
          return false;
        }

        return true;
      });

      if (retainedHooks.length > 0) {
        normalizedMatchers.push({
          ...matcher,
          hooks: retainedHooks,
        });
      }
    }

    if (normalizedMatchers.length > 0) {
      hooksFile.hooks[eventName] = normalizedMatchers;
    } else {
      delete hooksFile.hooks[eventName];
    }
  }

  if (!changed) {
    return {
      targetPath,
      changed: false,
      commandsRemoved: [],
    };
  }

  const backupPath = `${targetPath}.backup-${timestampForFilename()}`;
  fs.copyFileSync(targetPath, backupPath);
  writeJsonAtomic(targetPath, hooksFile);

  return {
    targetPath,
    changed: true,
    backupPath,
    commandsRemoved: Array.from(new Set(commandsRemoved)),
  };
}

type ConfigureRemoteSessionStartResult = EnsureTlHooksInstalledResult & {
  remoteEnabled: boolean;
  sessionStartCommand: string;
};

export function enableRemoteSessionStartHook(
  targetPath: string,
  wrapperPath = TL_REMOTE_SESSION_START_WRAPPER_PATH,
  cliScriptPath = '',
  nodeBinary = 'node'
): ConfigureRemoteSessionStartResult {
  const remoteHook = createRemoteSessionStartHook(wrapperPath);
  return configureSessionStartHook(targetPath, remoteHook, true, cliScriptPath, nodeBinary);
}

export function disableRemoteSessionStartHook(
  targetPath: string,
  cliScriptPath = '',
  nodeBinary = 'node'
): ConfigureRemoteSessionStartResult {
  return configureSessionStartHook(targetPath, TL_SESSION_START_HOOK, false, cliScriptPath, nodeBinary);
}

function configureSessionStartHook(
  targetPath: string,
  sessionStartHook: HookCommand,
  remoteEnabled: boolean,
  cliScriptPath = '',
  nodeBinary = 'node'
): ConfigureRemoteSessionStartResult {
  const installResult = ensureTlHooksInstalled(targetPath, cliScriptPath, nodeBinary);
  const hooksFile = parseHooksFile(targetPath);
  const changedCommands: string[] = [];
  const expectedCommand = sessionStartHook.command;
  const originalMatchers = hooksFile.hooks.SessionStart ?? [];
  const normalizedMatchers = normalizeSessionStartMatchers(originalMatchers, sessionStartHook);
  hooksFile.hooks.SessionStart = normalizedMatchers;
  const normalized = JSON.stringify(originalMatchers) !== JSON.stringify(normalizedMatchers);
  if (normalized) {
    changedCommands.push(expectedCommand);
  }

  if (!normalized && !installResult.changed) {
    return {
      ...installResult,
      remoteEnabled,
      sessionStartCommand: expectedCommand,
    };
  }

  const backupPath =
    installResult.backupPath ?? `${targetPath}.backup-${timestampForFilename()}`;
  if (!installResult.backupPath && fs.existsSync(targetPath)) {
    fs.copyFileSync(targetPath, backupPath);
  }
  writeJsonAtomic(targetPath, hooksFile);

  return {
    targetPath,
    changed: true,
    created: installResult.created,
    backupPath,
    commandsInstalled: Array.from(new Set([...installResult.commandsInstalled, ...changedCommands])),
    commandsAlreadyPresent: installResult.commandsAlreadyPresent.filter(
      (command) =>
        command !== TL_SESSION_START_HOOK.command || expectedCommand === TL_SESSION_START_HOOK.command
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
    `exec ${shellQuote(TL_HOOK_WRAPPER_PATH)} hook-session-start`,
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
  const originalMatchers = hooksFile.hooks[eventName] ?? [];
  const originalJson = JSON.stringify(originalMatchers);
  const normalizedMatchers: HookMatcher[] = [];
  let inserted = false;
  let hadEquivalent = false;

  for (const matcher of originalMatchers) {
    const normalizedHooks: HookCommand[] = [];
    let alreadyInsertedThisMatcher = false;

    for (const candidate of matcher.hooks) {
      const isEquivalent =
        candidate.type === hook.type &&
        commandsEquivalent(eventName, candidate.command, hook.command);

      if (!isEquivalent) {
        normalizedHooks.push(candidate);
        continue;
      }

      hadEquivalent = true;
      if (alreadyInsertedThisMatcher) {
        continue;
      }
      alreadyInsertedThisMatcher = true;

      if (!inserted) {
        normalizedHooks.push({ ...hook });
        inserted = true;
      }
    }

    if (normalizedHooks.length > 0) {
      normalizedMatchers.push({ ...matcher, hooks: normalizedHooks });
    }
  }

  if (!inserted) {
    normalizedMatchers.push({ hooks: [hook] });
  }

  const changed = originalJson !== JSON.stringify(normalizedMatchers);
  if (!changed) {
    commandsAlreadyPresent.push(hook.command);
    return false;
  }

  hooksFile.hooks[eventName] = normalizedMatchers;
  commandsInstalled.push(hook.command);
  if (!hadEquivalent && eventName === 'SessionStart') {
    commandsAlreadyPresent.push(hook.command);
  }
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

  if (eventName === 'SessionStart') {
    return isTlSessionStartCommand(currentCommand) && isTlSessionStartCommand(expectedCommand);
  }

  return isTlStopHookCommand(currentCommand) && isTlStopHookCommand(expectedCommand);
}

function isTlSessionStartCommand(command: string): boolean {
  const normalized = normalizeCommandPath(command);
  return (
    normalized === TL_SESSION_START_HOOK.command ||
    normalized === `${TL_HOOK_WRAPPER_PATH} hook-session-start` ||
    normalized === TL_REMOTE_SESSION_START_WRAPPER_PATH ||
    normalized === LEGACY_TL_SESSION_START_COMMAND ||
    normalizeCommandPath(LEGACY_TL_SESSION_START_COMMAND) === normalized
  );
}

function isTlStopHookCommand(command: string): boolean {
  const normalized = normalizeCommandPath(command);
  return (
    normalized === TL_STOP_HOOK.command ||
    normalized === LEGACY_TL_STOP_COMMAND ||
    normalizeCommandPath(LEGACY_TL_STOP_COMMAND) === normalized
  );
}

function normalizeCommandPath(command: string): string {
  if (command.startsWith('~/')) {
    return `${os.homedir()}/${command.slice(2)}`;
  }
  return command;
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
