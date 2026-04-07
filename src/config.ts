import fs from 'fs';
import path from 'path';
import os from 'os';
import { DaemonConfig } from './types.js';
import { TlError } from './errors.js';

const DEFAULT_CONFIG: DaemonConfig = {
  botToken: '',
  groupId: 0,
  topicPrefix: '🔧',
  hookPort: 9877,
  hookBaseUrl: 'http://localhost:9877',
  stopTimeout: 7200,
  liveStream: false,
  emojiReaction: '👍',
  localCodexEndpoint: 'ws://127.0.0.1:8795',
  remoteCodexEndpoint: null,
};

export function getConfigDir(): string {
  return process.env.TL_CONFIG_DIR || path.join(os.homedir(), '.tl');
}

function getConfigPath(): string {
  return path.join(getConfigDir(), 'config.json');
}

export function loadConfig(): DaemonConfig {
  const configPath = getConfigPath();
  let fileConfig: Partial<DaemonConfig> = {};

  if (fs.existsSync(configPath)) {
    try {
      const raw = fs.readFileSync(configPath, 'utf-8');
      fileConfig = JSON.parse(raw);
    } catch (err) {
      throw new TlError(
        `Failed to parse config at ${configPath}: ${(err as Error).message}`,
        'CONFIG_INVALID',
        err instanceof Error ? err : undefined
      );
    }
  }

  const config: DaemonConfig = { ...DEFAULT_CONFIG, ...fileConfig };

  // 필수 필드 검증
  if (!config.botToken || config.botToken.trim() === '') {
    throw new TlError(
      'botToken is required. Run: tl config set BOT_TOKEN=***',
      'CONFIG_MISSING'
    );
  }
  if (!config.groupId || config.groupId === 0) {
    throw new TlError(
      'groupId is required. Run: tl config set GROUP_ID=xxx',
      'CONFIG_MISSING'
    );
  }
  if (!Number.isInteger(config.hookPort) || config.hookPort <= 0 || config.hookPort > 65535) {
    throw new TlError('hookPort must be an integer between 1 and 65535', 'CONFIG_INVALID');
  }
  if (!Number.isInteger(config.stopTimeout) || config.stopTimeout <= 0) {
    throw new TlError('stopTimeout must be a positive integer', 'CONFIG_INVALID');
  }
  if (typeof config.liveStream !== 'boolean') {
    throw new TlError('liveStream must be a boolean', 'CONFIG_INVALID');
  }
  if (typeof config.topicPrefix !== 'string' || config.topicPrefix.trim() === '') {
    throw new TlError('topicPrefix must be a non-empty string', 'CONFIG_INVALID');
  }
  if (typeof config.hookBaseUrl !== 'string' || config.hookBaseUrl.trim() === '') {
    throw new TlError('hookBaseUrl must be a non-empty string', 'CONFIG_INVALID');
  }
  if (typeof config.emojiReaction !== 'string' || config.emojiReaction.trim() === '') {
    throw new TlError('emojiReaction must be a non-empty string', 'CONFIG_INVALID');
  }
  if (
    config.localCodexEndpoint !== null &&
    config.localCodexEndpoint !== undefined &&
    (typeof config.localCodexEndpoint !== 'string' || config.localCodexEndpoint.trim() === '')
  ) {
    throw new TlError(
      'localCodexEndpoint must be null or a non-empty string',
      'CONFIG_INVALID'
    );
  }
  if (
    config.remoteCodexEndpoint !== null &&
    config.remoteCodexEndpoint !== undefined &&
    (typeof config.remoteCodexEndpoint !== 'string' || config.remoteCodexEndpoint.trim() === '')
  ) {
    throw new TlError(
      'remoteCodexEndpoint must be null or a non-empty string',
      'CONFIG_INVALID'
    );
  }

  return config;
}

export function saveConfig(partial: Partial<DaemonConfig>): void {
  const configDir = getConfigDir();
  const configPath = getConfigPath();

  // 기존 설정 읽기
  let existing: Partial<DaemonConfig> = {};
  if (fs.existsSync(configPath)) {
    existing = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  }

  // 병합
  const merged = { ...existing, ...partial };

  // 디렉토리 확인
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  // Atomic write
  const tmpPath = configPath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(merged, null, 2), 'utf-8');
  fs.renameSync(tmpPath, configPath);
}
