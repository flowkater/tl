#!/usr/bin/env node
// tl — CLI 진입점

import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';

import readline from 'readline';
import { serializeStopHookOutput } from './stop-hook-output.js';
import {
  createTlHooksTemplate,
  disableRemoteSessionStartHook,
  enableRemoteSessionStartHook,
  ensureTlHooksInstalled,
  TL_REMOTE_SESSION_START_WRAPPER_PATH,
  writeRemoteSessionStartWrapper,
} from './codex-hooks.js';
import { loadConfig, saveConfig } from './config.js';
import {
  isReconnectSessionStart,
  isSubagentSessionStart,
} from './session-start-filter.js';
import { resolveRemoteEndpoint } from './remote-endpoint-discovery.js';
import {
  HookOutput,
  SessionStartPayload,
  UserPromptSubmitPayload,
} from './types.js';
import { PluginInstaller } from './plugin-installer.js';

function getConfigDir(): string {
  return process.env.TL_CONFIG_DIR || path.join(os.homedir(), '.tl');
}

function getPidPath(): string {
  return path.join(getConfigDir(), 'daemon.pid');
}

function getProjectRoot(): string {
  // dist/cli.js → /Users/.../TL/dist/cli.js → dirname → /Users/.../TL/dist → dirname → /Users/.../TL
  const distDir = path.dirname(new URL(import.meta.url).pathname);
  return path.resolve(distDir, '..');
}

function getHooksPath(): string {
  return path.join(os.homedir(), '.codex', 'hooks.json');
}

function getHookPort(): number {
  const configPath = path.join(getConfigDir(), 'config.json');
  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      return config.hookPort || 9877;
    } catch {
      return 9877;
    }
  }
  return 9877;
}

const command = process.argv[2];
const args = process.argv.slice(3);

async function main() {
  switch (command) {
    case 'start':
      return cmdStart();
    case 'stop':
      return cmdStop();
    case 'status':
      return cmdStatus();
    case 'sessions':
      return cmdSessions(args);
    case 'resume':
      return cmdResume(args);
    case 'setup':
      return cmdSetup(args);
    case 'init':
      return cmdInit();
    case 'config':
      return cmdConfig(args);
    case 'plugin':
      return cmdPlugin(args);
    case 'remote':
      return cmdRemote(args);
    case 'hook-session-start':
      return cmdHookSessionStart();
    case 'hook-stop-and-wait':
      return cmdHookStopAndWait();
    case 'hook-working':
      return cmdHookWorking();
    case 'help':
    case undefined:
      return cmdHelp();
    default:
      process.stderr.write(`Unknown command: ${command}\n`);
      cmdHelp();
      process.exit(1);
  }
}

// ===== tl start =====
function cmdStart() {
  const pidPath = getPidPath();

  if (fs.existsSync(pidPath)) {
    const existingPid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
    try {
      process.kill(existingPid, 0);
      console.log(`Daemon already running (PID: ${existingPid})`);
      process.exit(1);
    } catch {
      fs.unlinkSync(pidPath);
    }
  }

  const configDir = getConfigDir();
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  const daemonPath = path.join(getProjectRoot(), 'dist', 'daemon.js');
  if (!fs.existsSync(daemonPath)) {
    process.stderr.write('Daemon not built. Run: npm run build\n');
    process.exit(1);
  }

  console.log('Starting tl daemon...');
  const child = spawn('node', [daemonPath], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  console.log(`Daemon started (PID: ${child.pid})`);
}

// ===== tl stop =====
function cmdStop() {
  const pidPath = getPidPath();
  if (!fs.existsSync(pidPath)) {
    console.log('Daemon is not running');
    return;
  }

  const pid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
  try {
    process.kill(pid, 'SIGTERM');
    console.log(`Sent SIGTERM to daemon (PID: ${pid})`);
  } catch {
    fs.unlinkSync(pidPath);
    console.log('Daemon was not running (stale PID file removed)');
  }
}

// ===== tl status =====
async function cmdStatus() {
  const pidPath = getPidPath();
  if (!fs.existsSync(pidPath)) {
    console.log('Daemon is not running');
    return;
  }

  const pid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
  try {
    process.kill(pid, 0);
    console.log(`Daemon is running (PID: ${pid})`);
  } catch {
    console.log('Daemon is not running (stale PID file)');
    fs.unlinkSync(pidPath);
    return;
  }

  const configPath = path.join(getConfigDir(), 'config.json');
  let port = 9877;
  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      port = config.hookPort || 9877;
    } catch {
      // ignore
    }
  }

  try {
    const res = await fetch(`http://localhost:${port}/status`);
    const status = await res.json();
    console.log(`  Uptime: ${status.uptime_seconds}s`);
    console.log(`  Active sessions: ${status.active_sessions}`);
    console.log(`  Waiting sessions: ${status.waiting_sessions}`);
  } catch {
    console.log('  (Could not reach daemon HTTP endpoint)');
  }
}

// ===== tl sessions =====
async function cmdSessions(args: string[]) {
  const port = getHookPort();

  const filter = args[0]; // 'active', 'waiting', 'completed', or undefined (all)

  try {
    const res = await fetch(`http://localhost:${port}/sessions`);
    const data = await res.json();

    if (!res.ok) {
      process.stderr.write(`HTTP ${res.status}: ${JSON.stringify(data)}\n`);
      process.exit(1);
    }

    let sessions = data.sessions || [];
    if (filter) {
      sessions = sessions.filter((s: any) => s.status === filter);
    }

    if (sessions.length === 0) {
      console.log(filter ? `No ${filter} sessions` : 'No sessions');
      return;
    }

    // 테이블 포맷
    const statusEmoji: Record<string, string> = {
      pending: '⏳',
      active: '🟢',
      waiting: '🟡',
      completed: '✅',
      failed: '🔴',
    };

    console.log('\nSessions:');
    for (const s of sessions) {
      const emoji = statusEmoji[s.status] || '❓';
      const since = s.started_at
        ? new Date(s.started_at).toLocaleString('ko-KR', {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          })
        : '-';
      console.log(
        `  ${emoji} ${s.session_id.slice(0, 12)}  ${s.status.padEnd(9)}  ${s.project || '-'}  ${since}`
      );
    }
    console.log(`\nTotal: ${sessions.length}`);
  } catch (err) {
    process.stderr.write(`Failed to connect to daemon: ${(err as Error).message}\n`);
    process.exit(1);
  }
}

// ===== tl resume =====
async function cmdResume(args: string[]) {
  const sessionId = args[0];
  if (!sessionId) {
    process.stderr.write('Usage: tl resume <session_id>\n');
    process.exit(1);
  }

  const port = getHookPort();

  try {
    const res = await fetch(`http://localhost:${port}/hook/resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId }),
    });

    const data = await res.json();

    if (!res.ok) {
      process.stderr.write(`HTTP ${res.status}: ${JSON.stringify(data)}\n`);
      process.exit(1);
    }

    console.log(`Session ${sessionId} resumed: ${data.status}`);
  } catch (err) {
    process.stderr.write(`Failed to connect to daemon: ${(err as Error).message}\n`);
    process.exit(1);
  }
}

// ===== tl setup =====

async function ask(rl: readline.Interface, prompt: string, defaultVal?: string): Promise<string> {
  const display = defaultVal !== undefined
    ? `${prompt} [${defaultVal}]: `
    : `${prompt}: `;
  const answer = await new Promise<string>((resolve) => rl.question(display, resolve));
  return answer.trim() || defaultVal || '';
}

async function cmdSetup(args: string[]) {
  const nonInteractive = args.includes('--non-interactive') || args.includes('-y');
  const configPath = path.join(getConfigDir(), 'config.json');

  // 기존 설정 로드
  let existing: Record<string, any> = {};
  if (fs.existsSync(configPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch {
      // ignore
    }
  }

  let botToken: string;
  let groupId: string;
  let hookPort: string;
  let hookBaseUrl: string;
  let stopTimeout: string;
  let emojiReaction: string;
  let liveStream: string;

  if (nonInteractive) {
    botToken = process.env.TL_BOT_TOKEN || existing.botToken || '';
    groupId = String(process.env.TL_GROUP_ID ?? existing.groupId ?? '');
    hookPort = String(process.env.TL_HOOK_PORT ?? existing.hookPort ?? 9877);
    hookBaseUrl = process.env.TL_HOOK_BASE_URL || existing.hookBaseUrl || `http://localhost:${hookPort}`;
    stopTimeout = String(process.env.TL_STOP_TIMEOUT ?? existing.stopTimeout ?? 7200);
    emojiReaction = process.env.TL_EMOJI_REACTION || existing.emojiReaction || '👍';
    liveStream = process.env.TL_LIVE_STREAM || String(existing.liveStream ?? false);
  } else {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    console.log('\\n🔧 TL — Codex ↔ Telegram Bridge Setup\\n');

    botToken = await ask(rl, 'Telegram Bot Token (@BotFather에서 발급)', existing.botToken);
    if (!botToken) {
      console.log('\\n❌ Bot Token is required. Setup cancelled.');
      rl.close();
      process.exit(1);
    }

    groupId = await ask(rl, 'Telegram Group/Channel ID (예: -1001234567890)', String(existing.groupId || ''));
    if (!groupId) {
      console.log('\\n❌ Group ID is required. Setup cancelled.');
      rl.close();
      process.exit(1);
    }

    hookPort = await ask(rl, 'Hook server port', String(existing.hookPort || 9877));
    hookBaseUrl = await ask(rl, 'Hook base URL (daemon이 접근할 주소)', existing.hookBaseUrl || `http://localhost:${hookPort}`);
    stopTimeout = await ask(rl, 'Stop timeout (초, 기본 7200=2시간)', String(existing.stopTimeout || 7200));
    emojiReaction = await ask(rl, 'Reaction emoji (세션 시작 시)', existing.emojiReaction || '👍');
    liveStream = await ask(rl, 'Live streaming? (true/false)', String(existing.liveStream || false));

    rl.close();
  }

  // 설정 저장
  const config: Record<string, any> = {
    botToken,
    groupId: Number(groupId),
    hookPort: Number(hookPort),
    hookBaseUrl,
    stopTimeout: Number(stopTimeout),
    emojiReaction,
    liveStream: liveStream === 'true',
  };

  if (!fs.existsSync(getConfigDir())) {
    fs.mkdirSync(getConfigDir(), { recursive: true });
  }
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
  console.log('\\n✅ Config saved to ~/.tl/config.json');

  // hooks.json 설치
  console.log('\\n📦 Installing Codex hooks...');
  const targetPath = path.join(os.homedir(), '.codex', 'hooks.json');
  try {
    const hookInstall = ensureTlHooksInstalled(targetPath);
    if (hookInstall.created) {
      console.log(`✅ hooks.json created at ${targetPath}`);
    } else if (hookInstall.changed) {
      console.log(`✅ hooks.json updated at ${targetPath}`);
      if (hookInstall.backupPath) {
        console.log(`   Backup: ${hookInstall.backupPath}`);
      }
    } else {
      console.log(`✅ TL hooks already installed in ${targetPath}`);
    }
  } catch (err) {
    process.stderr.write(`⚠️  Failed to install hooks.json: ${(err as Error).message}\n`);
  }

  // daemon 재시작
  console.log('\\n🚀 Restarting daemon...');
  const pidPath = getPidPath();
  if (fs.existsSync(pidPath)) {
    const existingPid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
    try {
      process.kill(existingPid, 'SIGTERM');
      console.log(`  Stopped old daemon (PID: ${existingPid})`);
      // 잠깐 대기
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } catch {
      // ignore
    }
    try { fs.unlinkSync(pidPath); } catch { /* ignore */ }
  }

  const daemonPath = path.join(getProjectRoot(), 'dist', 'daemon.js');
  if (fs.existsSync(daemonPath)) {
    const child = spawn('node', [daemonPath], { detached: true, stdio: 'ignore' });
    child.unref();
    console.log(`✅ Daemon started (PID: ${child.pid})`);
  } else {
    console.log('⚠️  Daemon not built — run `npm run build` then `tl start`');
  }

  console.log('\\n🎉 Setup complete!');
  console.log(`   Bot: ${botToken.slice(0, 10)}...`);
  console.log(`   Group: ${groupId}`);
  console.log(`   Hook: ${hookBaseUrl}`);
  console.log('\\nVerify: send /tl-status in your Telegram group, then start a new root Codex session.');
}

// ===== tl init =====
function cmdInit() {
  const targetPath = path.join(os.homedir(), '.codex', 'hooks.json');
  const force = args.includes('--force');

  if (fs.existsSync(targetPath) && !force) {
    const result = ensureTlHooksInstalled(targetPath);
    if (result.changed) {
      console.log(`hooks.json updated at ${targetPath}`);
      if (result.backupPath) {
        console.log(`Backup created at ${result.backupPath}`);
      }
    } else {
      console.log(`TL hooks already installed in ${targetPath}`);
    }
    return;
  }

  const targetDir = path.dirname(targetPath);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  fs.writeFileSync(
    targetPath,
    JSON.stringify(createTlHooksTemplate(), null, 2),
    'utf-8'
  );
  console.log(`hooks.json installed to ${targetPath}`);
}

// ===== tl config =====
function cmdConfig(args: string[]) {
  const subcommand = args[0];
  const configPath = path.join(getConfigDir(), 'config.json');

  if (subcommand === 'get') {
    const key = args[1];
    if (!fs.existsSync(configPath)) {
      console.log('No config file found');
      return;
    }
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    if (key) {
      console.log(config[key] ?? '');
    } else {
      console.log(JSON.stringify(config, null, 2));
    }
    return;
  }

  if (subcommand === 'set') {
    const parts = args.slice(1);
    let config: Record<string, any> = {};
    if (fs.existsSync(configPath)) {
      config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    }

    for (const part of parts) {
      const [key, ...valueParts] = part.split('=');
      const value = valueParts.join('=');
      if (!key || value === undefined) {
        process.stderr.write(`Invalid format: ${part}. Use KEY=VALUE\n`);
        process.exit(1);
      }

      if (value === 'true') config[key] = true;
      else if (value === 'false') config[key] = false;
      else if (!isNaN(Number(value))) config[key] = Number(value);
      else config[key] = value;
    }

    if (!fs.existsSync(getConfigDir())) {
      fs.mkdirSync(getConfigDir(), { recursive: true });
    }

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
    console.log('Config saved');
    return;
  }

  console.log('Usage: tl config get [KEY] | tl config set KEY=VALUE');
}

async function cmdPlugin(args: string[]) {
  const subcommand = args[0];
  const installer = new PluginInstaller({
    nodeBinary: process.execPath,
    cliScriptPath: path.join(getProjectRoot(), 'dist', 'cli.js'),
    mcpServerPath: path.join(getProjectRoot(), 'dist', 'tl-mcp-server.js'),
  });

  if (subcommand === 'install') {
    const result = await installer.install();
    console.log(`TL plugin installed at ${result.pluginPath}`);
    console.log(`Marketplace updated at ${result.marketplacePath}`);
    return;
  }

  if (subcommand === 'status') {
    const status = await installer.status();
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  console.log('Usage: tl plugin install | tl plugin status');
}

async function cmdRemote(args: string[]) {
  const subcommand = args[0];
  if (subcommand === 'enable') {
    return cmdRemoteEnable(args.slice(1));
  }
  if (subcommand === 'disable') {
    return cmdRemoteDisable();
  }
  if (subcommand === 'attach') {
    return cmdRemoteAttach(args.slice(1));
  }
  if (subcommand === 'detach') {
    return cmdRemoteDetach(args.slice(1));
  }
  if (subcommand === 'inject') {
    return cmdRemoteInject(args.slice(1));
  }
  if (subcommand === 'status') {
    return cmdRemoteStatus(args.slice(1));
  }

  console.log('Usage: tl remote enable --endpoint <ws-url>');
  console.log('       tl remote disable');
  console.log('       tl remote attach <session_id> --thread <thread_id> --endpoint <ws-url>');
  console.log('       tl remote detach <session_id>');
  console.log('       tl remote inject <session_id> --text <message>');
  console.log('       tl remote status [session_id]');
}

async function cmdRemoteEnable(args: string[]) {
  let endpoint = '';
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--endpoint') {
      endpoint = args[i + 1] ?? '';
      i += 1;
    }
  }

  if (!endpoint) {
    process.stderr.write('Usage: tl remote enable --endpoint <ws-url>\n');
    process.exit(1);
  }

  saveConfig({ remoteCodexEndpoint: endpoint });
  const wrapperPath = writeRemoteSessionStartWrapper(endpoint);
  const hookResult = enableRemoteSessionStartHook(getHooksPath(), wrapperPath);

  console.log(JSON.stringify({
    status: 'enabled',
    endpoint,
    wrapper_path: wrapperPath,
    hooks_path: hookResult.targetPath,
    backup_path: hookResult.backupPath ?? null,
    session_start_command: hookResult.sessionStartCommand,
  }, null, 2));
}

async function cmdRemoteDisable() {
  saveConfig({ remoteCodexEndpoint: null });
  const hookResult = disableRemoteSessionStartHook(getHooksPath());

  console.log(JSON.stringify({
    status: 'disabled',
    endpoint: null,
    wrapper_path: TL_REMOTE_SESSION_START_WRAPPER_PATH,
    hooks_path: hookResult.targetPath,
    backup_path: hookResult.backupPath ?? null,
    session_start_command: hookResult.sessionStartCommand,
  }, null, 2));
}

async function cmdRemoteAttach(args: string[]) {
  const sessionId = args[0];
  if (!sessionId) {
    process.stderr.write('Usage: tl remote attach <session_id> --thread <thread_id> --endpoint <ws-url>\n');
    process.exit(1);
  }

  let threadId = '';
  let endpoint = '';
  let lastTurnId: string | null = null;

  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--thread') {
      threadId = args[i + 1] ?? '';
      i += 1;
      continue;
    }
    if (arg === '--endpoint') {
      endpoint = args[i + 1] ?? '';
      i += 1;
      continue;
    }
    if (arg === '--turn') {
      lastTurnId = args[i + 1] ?? null;
      i += 1;
    }
  }

  if (!threadId || !endpoint) {
    process.stderr.write('Usage: tl remote attach <session_id> --thread <thread_id> --endpoint <ws-url>\n');
    process.exit(1);
  }

  const res = await fetch(`http://localhost:${getHookPort()}/remote/attach`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      session_id: sessionId,
      thread_id: threadId,
      endpoint,
      last_turn_id: lastTurnId,
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    process.stderr.write(`HTTP ${res.status}: ${JSON.stringify(data)}\n`);
    process.exit(1);
  }

  console.log(JSON.stringify(data, null, 2));
}

async function cmdRemoteDetach(args: string[]) {
  const sessionId = args[0];
  if (!sessionId) {
    process.stderr.write('Usage: tl remote detach <session_id>\n');
    process.exit(1);
  }

  const res = await fetch(`http://localhost:${getHookPort()}/remote/detach`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId }),
  });
  const data = await res.json();
  if (!res.ok) {
    process.stderr.write(`HTTP ${res.status}: ${JSON.stringify(data)}\n`);
    process.exit(1);
  }

  console.log(JSON.stringify(data, null, 2));
}

async function cmdRemoteStatus(args: string[]) {
  if (!args[0]) {
    const config = loadConfig();
    const hooksPath = getHooksPath();
    let sessionStartCommand: string | null = null;

    if (fs.existsSync(hooksPath)) {
      try {
        const hooksFile = JSON.parse(fs.readFileSync(hooksPath, 'utf-8'));
        const matcher = hooksFile?.hooks?.SessionStart?.find?.((entry: any) =>
          Array.isArray(entry?.hooks) &&
          entry.hooks.some((hook: any) => hook?.type === 'command')
        );
        const hook = matcher?.hooks?.find?.((entry: any) => entry?.type === 'command');
        sessionStartCommand = hook?.command ?? null;
      } catch {
        sessionStartCommand = null;
      }
    }

    const url = new URL(`http://localhost:${getHookPort()}/remote/status`);
    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok) {
      process.stderr.write(`HTTP ${res.status}: ${JSON.stringify(data)}\n`);
      process.exit(1);
    }

    console.log(JSON.stringify({
      configured_endpoint: config.remoteCodexEndpoint ?? null,
      wrapper_path: TL_REMOTE_SESSION_START_WRAPPER_PATH,
      session_start_command: sessionStartCommand,
      attached_sessions: data.sessions ?? [],
    }, null, 2));
    return;
  }

  const sessionId = args[0];
  const url = new URL(`http://localhost:${getHookPort()}/remote/status`);
  if (sessionId) {
    url.searchParams.set('session_id', sessionId);
  }

  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok) {
    process.stderr.write(`HTTP ${res.status}: ${JSON.stringify(data)}\n`);
    process.exit(1);
  }

  console.log(JSON.stringify(data, null, 2));
}

async function cmdRemoteInject(args: string[]) {
  const sessionId = args[0];
  if (!sessionId) {
    process.stderr.write('Usage: tl remote inject <session_id> --text <message>\n');
    process.exit(1);
  }

  let text = '';
  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--text') {
      text = args[i + 1] ?? '';
      i += 1;
    }
  }

  if (!text) {
    process.stderr.write('Usage: tl remote inject <session_id> --text <message>\n');
    process.exit(1);
  }

  const res = await fetch(`http://localhost:${getHookPort()}/remote/inject`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      session_id: sessionId,
      reply_text: text,
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    process.stderr.write(`HTTP ${res.status}: ${JSON.stringify(data)}\n`);
    process.exit(1);
  }

  console.log(JSON.stringify(data, null, 2));
}

// ===== tl hook-session-start =====
async function cmdHookSessionStart() {
  const port = getHookPort();
  const remoteEndpoint = resolveRemoteEndpoint();
  const remoteThreadId = process.env.TL_REMOTE_THREAD_ID?.trim() || null;

  const stdin = fs.readFileSync(0, 'utf-8');
  if (!stdin.trim()) {
    process.stderr.write('No input on stdin\n');
    process.exit(1);
  }

  try {
    const payload = JSON.parse(stdin) as SessionStartPayload;
    if (isSubagentSessionStart(payload)) {
      process.exit(0);
    }

    const res = await fetch(`http://localhost:${port}/hook/session-start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...payload,
        is_reconnect: isReconnectSessionStart(payload),
        remote_endpoint: remoteEndpoint,
        remote_thread_id: remoteThreadId,
      }),
    });

    const data = await res.json();
    if (!res.ok) {
      process.stderr.write(`HTTP ${res.status}: ${JSON.stringify(data)}\n`);
      process.exit(1);
    }

    process.stdout.write(`Session started: ${data.session_id} (topic: ${data.topic_id})\n`);
    process.exit(0);
  } catch (err) {
    process.stderr.write(`Failed to connect to daemon: ${(err as Error).message}\n`);
    process.exit(1);
  }
}

// ===== tl hook-stop-and-wait =====
async function cmdHookStopAndWait() {
  const configPath = path.join(getConfigDir(), 'config.json');
  let port = 9877;
  let stopTimeout = 7200;
  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      port = config.hookPort || 9877;
      stopTimeout = config.stopTimeout || 7200;
    } catch {
      // ignore
    }
  }

  const stdin = fs.readFileSync(0, 'utf-8');
  if (!stdin.trim()) {
    process.stderr.write('No input on stdin\n');
    process.exit(1);
  }

  try {
    const res = await fetch(`http://localhost:${port}/hook/stop-and-wait`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: stdin,
      signal: AbortSignal.timeout((stopTimeout + 100) * 1000),
    });

    const data = await res.json();

    if (!res.ok) {
      process.stderr.write(`Warning: HTTP ${res.status}: ${JSON.stringify(data)}\n`);
      process.exit(0);
    }

    const serialized = serializeStopHookOutput(data);
    if (serialized) {
      const payload = JSON.parse(stdin) as { session_id?: string };
      await writeStdout(serialized + '\n');
      if (payload.session_id && !resumeAckAlreadyQueued(data)) {
        await postResumeAck(payload.session_id, port);
      }
    }
    process.exit(0);
  } catch (err) {
    process.stderr.write(`Warning: Hook connection failed: ${(err as Error).message}\n`);
    process.exit(0);
  }
}

async function cmdHookWorking() {
  const port = getHookPort();

  const stdin = fs.readFileSync(0, 'utf-8');
  if (!stdin.trim()) {
    process.stderr.write('Warning: No input on stdin\n');
    process.exit(0);
  }

  try {
    const payload = JSON.parse(stdin) as UserPromptSubmitPayload;
    if (!payload.session_id) {
      process.stderr.write('Warning: Missing session_id\n');
      process.exit(0);
    }

    const res = await fetch(`http://localhost:${port}/hook/working`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5_000),
    });

    if (!res.ok) {
      const data = await res.text();
      process.stderr.write(`Warning: HTTP ${res.status}: ${data}\n`);
    }
    process.exit(0);
  } catch (err) {
    process.stderr.write(`Warning: Working hook failed: ${(err as Error).message}\n`);
    process.exit(0);
  }
}

async function writeStdout(text: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(text, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

async function postResumeAck(sessionId: string, port: number): Promise<void> {
  try {
    await fetch(`http://localhost:${port}/hook/resume-ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch (err) {
    process.stderr.write(
      `Warning: Resume ACK failed: ${(err as Error).message}\n`
    );
  }
}

type StopAndWaitResponse = HookOutput & {
  resume_ack_queued?: boolean;
};

function resumeAckAlreadyQueued(output: StopAndWaitResponse): boolean {
  return output.decision === 'block' && output.resume_ack_queued === true;
}

// ===== tl help =====
function cmdHelp() {
  console.log(`
tl — Codex ↔ Telegram Bridge

Usage:
  tl start                     Start the daemon
  tl stop                      Stop the daemon
  tl status                    Show daemon status
  tl sessions [active|waiting|completed]  List sessions
  tl resume <session_id>       Resume a waiting session
  tl setup                     Interactive setup wizard
  tl setup --non-interactive   Setup with env vars (TL_BOT_TOKEN, etc.)
  tl init [--force]            Merge TL hooks into ~/.codex/hooks.json (overwrite only with --force)
  tl config get [KEY]          Show config
  tl config set KEY=VALUE      Set config value
  tl plugin install            Install the local Codex TL plugin
  tl plugin status             Show the local Codex TL plugin status
  tl remote enable ...         Enable experimental remote app-server mode
  tl remote disable            Disable experimental remote app-server mode
  tl remote attach ...         Attach a TL session to a Codex app-server thread
  tl remote detach <session_id>  Remove remote attachment from a TL session
  tl remote inject ...         Inject a reply into a remote-attached session
  tl remote status [session_id]  Show remote attachment status
  tl help                      Show this help

Internal (used by Codex hooks):
  tl hook-session-start        Handle SessionStart hook (stdin → HTTP POST)
  tl hook-stop-and-wait        Handle Stop hook (stdin → POST → long-poll → stdout)
  tl hook-working              Handle UserPromptSubmit hook (stdin → HTTP POST)
`);
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err.message}\n`);
  process.exit(1);
});
