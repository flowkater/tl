import fs from 'fs';
import os from 'os';
import path from 'path';
import { TlError } from './errors.js';
import type {
  ApprovalPolicy,
  SandboxMode,
  TelegramDirectiveField,
  TopicPreferences,
  TopicPreferencesFile,
} from './types.js';

function getDataDir(): string {
  return process.env.TL_DATA_DIR || path.join(os.homedir(), '.tl');
}

function getPreferencesPath(): string {
  return path.join(getDataDir(), 'topic-preferences.json');
}

function getBackupPath(): string {
  return `${getPreferencesPath()}.bak`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function hasPreferenceFields(preferences: TopicPreferences): boolean {
  return (
    preferences.skill !== undefined ||
    preferences.cmd !== undefined ||
    preferences.model !== undefined ||
    preferences['approval-policy'] !== undefined ||
    preferences.sandbox !== undefined ||
    preferences.cwd !== undefined
  );
}

function isAllowedApprovalPolicy(value: string): boolean {
  return value === 'never' || value === 'on-request' || value === 'on-failure' || value === 'untrusted';
}

function isAllowedSandbox(value: string): boolean {
  return value === 'danger-full-access' || value === 'workspace-write' || value === 'read-only';
}

function cloneTopicPreferences(preferences: TopicPreferences): TopicPreferences {
  return {
    updated_at: preferences.updated_at,
    skill: preferences.skill ? [...preferences.skill] : undefined,
    cmd: preferences.cmd ? [...preferences.cmd] : undefined,
    model: preferences.model,
    'approval-policy': preferences['approval-policy'],
    sandbox: preferences.sandbox,
    cwd: preferences.cwd,
  };
}

function normalizeTopicPreferences(raw: unknown): TopicPreferences {
  if (!isRecord(raw)) {
    throw new TlError('Invalid topic preferences entry', 'STORE_CORRUPT');
  }

  if (!isNonEmptyString(raw.updated_at)) {
    throw new TlError('Invalid topic preferences updated_at', 'STORE_CORRUPT');
  }

  const updatedAt = raw.updated_at.trim();
  const preferences: TopicPreferences = { updated_at: updatedAt };

  if (raw.skill !== undefined) {
    if (
      !isStringArray(raw.skill) ||
      raw.skill.some((item) => {
        const trimmed = item.trim();
        return trimmed.length === 0 || /\s/.test(trimmed);
      })
    ) {
      throw new TlError('Invalid topic preferences skill list', 'STORE_CORRUPT');
    }
    if (raw.skill.length > 0) {
      preferences.skill = raw.skill.map((item) => item.trim());
    }
  }

  if (raw.cmd !== undefined) {
    if (
      !isStringArray(raw.cmd) ||
      raw.cmd.some((item) => {
        const trimmed = item.trim();
        return trimmed.length === 0 || !trimmed.startsWith('/');
      })
    ) {
      throw new TlError('Invalid topic preferences cmd list', 'STORE_CORRUPT');
    }
    if (raw.cmd.length > 0) {
      preferences.cmd = raw.cmd.map((item) => item.trim());
    }
  }

  for (const field of ['model', 'approval-policy', 'sandbox', 'cwd'] as const) {
    const value = raw[field];
    if (value !== undefined) {
      if (!isNonEmptyString(value)) {
        throw new TlError(`Invalid topic preferences field: ${field}`, 'STORE_CORRUPT');
      }
      const trimmed = value.trim();
      if (field === 'model' && /\s/.test(trimmed)) {
        throw new TlError('Invalid topic preferences field: model', 'STORE_CORRUPT');
      }
      if (field === 'approval-policy' && !isAllowedApprovalPolicy(trimmed)) {
        throw new TlError('Invalid topic preferences field: approval-policy', 'STORE_CORRUPT');
      }
      if (field === 'sandbox' && !isAllowedSandbox(trimmed)) {
        throw new TlError('Invalid topic preferences field: sandbox', 'STORE_CORRUPT');
      }
      if (field === 'model' || field === 'cwd') {
        preferences[field] = trimmed;
      } else if (field === 'approval-policy') {
        preferences['approval-policy'] = trimmed as ApprovalPolicy;
      } else {
        preferences.sandbox = trimmed as SandboxMode;
      }
    }
  }

  return preferences;
}

function validateFileShape(data: unknown): TopicPreferencesFile {
  if (!isRecord(data)) {
    throw new TlError('Invalid topic-preferences.json structure', 'STORE_CORRUPT');
  }
  if (!isRecord(data.topics)) {
    throw new TlError('Invalid topic-preferences.json topics map', 'STORE_CORRUPT');
  }

  const topics: Record<string, TopicPreferences> = {};
  for (const [topicKey, rawPreferences] of Object.entries(data.topics)) {
    try {
      const preferences = normalizeTopicPreferences(rawPreferences);
      if (hasPreferenceFields(preferences)) {
        topics[topicKey] = preferences;
      }
    } catch {
      // Ignore invalid persisted topic preferences during load.
    }
  }

  const version = typeof data.version === 'number' ? data.version : 1;
  return { version, topics };
}

function writeAtomicJson(filePath: string, content: string): void {
  const tmpPath = `${filePath}.tmp`;
  const fd = fs.openSync(tmpPath, 'w');
  try {
    fs.writeSync(fd, content, 0, 'utf-8');
    try {
      fs.fsyncSync(fd);
    } catch {
      // Ignore fsync failures on filesystems that do not support it.
    }
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, filePath);
}

export class TopicPreferencesStore {
  private data: TopicPreferencesFile;
  private readonly filePath: string;

  constructor() {
    this.data = { version: 1, topics: {} };
    this.filePath = getPreferencesPath();
  }

  async load(): Promise<void> {
    const dir = getDataDir();
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    if (!fs.existsSync(this.filePath)) {
      this.data = { version: 1, topics: {} };
      await this.save();
      return;
    }

    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      this.data = validateFileShape(JSON.parse(raw));
    } catch (primaryErr) {
      const backupPath = getBackupPath();
      if (fs.existsSync(backupPath)) {
        try {
          const raw = fs.readFileSync(backupPath, 'utf-8');
          this.data = validateFileShape(JSON.parse(raw));
          return;
        } catch {
          // Ignore backup failures and fall through to reset.
        }
      }

      // Corruption fallback mirrors SessionsStore: reset to a fresh file.
      this.data = { version: 1, topics: {} };
      await this.save();
    }
  }

  get(topicKey: string): TopicPreferences | undefined {
    const preferences = this.data.topics[topicKey];
    if (!preferences) {
      return undefined;
    }
    return cloneTopicPreferences(preferences);
  }

  set(topicKey: string, preferences: Partial<TopicPreferences>): void {
    const existing = this.data.topics[topicKey];
    const updatedAt = preferences.updated_at ?? new Date().toISOString();
    if (updatedAt.trim().length === 0) {
      throw new TlError('Invalid updated_at preference value', 'STORE_CORRUPT');
    }

    const next: TopicPreferences = {
      ...(existing ? cloneTopicPreferences(existing) : {}),
      updated_at: updatedAt,
    };

    if (preferences.skill !== undefined) {
      if (preferences.skill.length > 0) {
        next.skill = preferences.skill.map((item) => {
          const trimmed = item.trim();
          if (trimmed.length === 0 || /\s/.test(trimmed)) {
            throw new TlError('Invalid skill preference value', 'STORE_CORRUPT');
          }
          return trimmed;
        });
      } else {
        delete next.skill;
      }
    }
    if (preferences.cmd !== undefined) {
      if (preferences.cmd.length > 0) {
        next.cmd = preferences.cmd.map((item) => {
          const trimmed = item.trim();
          if (trimmed.length === 0 || !trimmed.startsWith('/')) {
            throw new TlError('Invalid cmd preference value', 'STORE_CORRUPT');
          }
          return trimmed;
        });
      } else {
        delete next.cmd;
      }
    }
    if (preferences.model !== undefined) {
      const trimmed = preferences.model.trim();
      if (trimmed.length === 0 || /\s/.test(trimmed)) {
        throw new TlError('Invalid model preference value', 'STORE_CORRUPT');
      }
      next.model = trimmed;
    }
    if (preferences['approval-policy'] !== undefined) {
      const trimmed = preferences['approval-policy'].trim();
      if (!isAllowedApprovalPolicy(trimmed)) {
        throw new TlError('Invalid approval-policy preference value', 'STORE_CORRUPT');
      }
      next['approval-policy'] = trimmed as ApprovalPolicy;
    }
    if (preferences.sandbox !== undefined) {
      const trimmed = preferences.sandbox.trim();
      if (!isAllowedSandbox(trimmed)) {
        throw new TlError('Invalid sandbox preference value', 'STORE_CORRUPT');
      }
      next.sandbox = trimmed as SandboxMode;
    }
    if (preferences.cwd !== undefined) {
      const trimmed = preferences.cwd.trim();
      if (trimmed.length === 0) {
        throw new TlError('Invalid cwd preference value', 'STORE_CORRUPT');
      }
      next.cwd = trimmed;
    }

    if (hasPreferenceFields(next)) {
      this.data.topics[topicKey] = next;
    } else {
      delete this.data.topics[topicKey];
    }
  }

  clearField(topicKey: string, field: TelegramDirectiveField): void {
    const existing = this.data.topics[topicKey];
    if (!existing) {
      return;
    }

    const next: TopicPreferences = {
      ...existing,
      updated_at: new Date().toISOString(),
    };
    delete next[field];

    if (!hasPreferenceFields(next)) {
      delete this.data.topics[topicKey];
      return;
    }

    this.data.topics[topicKey] = next;
  }

  list(): Array<{ topicKey: string; preferences: TopicPreferences }> {
    return Object.entries(this.data.topics).map(([topicKey, preferences]) => ({
      topicKey,
      preferences: cloneTopicPreferences(preferences),
    }));
  }

  async save(): Promise<void> {
    for (const [topicKey, preferences] of Object.entries(this.data.topics)) {
      const normalized = normalizeTopicPreferences(preferences);
      if (!hasPreferenceFields(normalized)) {
        delete this.data.topics[topicKey];
      } else {
        this.data.topics[topicKey] = normalized;
      }
    }

    const dir = getDataDir();
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    if (fs.existsSync(this.filePath)) {
      fs.copyFileSync(this.filePath, getBackupPath());
    }

    writeAtomicJson(this.filePath, JSON.stringify(this.data, null, 2));
  }
}
