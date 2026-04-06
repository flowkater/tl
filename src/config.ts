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
