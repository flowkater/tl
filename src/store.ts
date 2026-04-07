import fs from 'fs';
import path from 'path';
import os from 'os';
import { SessionRecord, SessionsFile, SessionStatus } from './types.js';
import { TlError } from './errors.js';
import { logger } from './logger.js';
import { ensureLocalSessionDefaults } from './local-session-bridge.js';
import { ensureRemoteSessionDefaults } from './remote-mode.js';

function getDataDir(): string {
  return process.env.TL_DATA_DIR || path.join(os.homedir(), '.tl');
}

function getSessionsPath(): string {
  return path.join(getDataDir(), 'sessions.json');
}

function getBackupPath(): string {
  return path.join(getDataDir(), 'sessions.json.bak');
}

function getArchivePath(): string {
  return path.join(getDataDir(), 'sessions-archive.json');
}

export class SessionsStore {
  private data: SessionsFile;
  private filePath: string;

  constructor() {
    this.data = { sessions: {}, version: 1 };
    this.filePath = getSessionsPath();
  }

  async load(): Promise<void> {
    const dir = getDataDir();
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    if (!fs.existsSync(this.filePath)) {
      this.data = { sessions: {}, version: 1 };
      await this.save();
      return;
    }

    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      this.data = JSON.parse(raw);
      this.validate();
    } catch (primaryErr) {
      // 백업 시도
      const backupPath = getBackupPath();
      if (fs.existsSync(backupPath)) {
        try {
          const raw = fs.readFileSync(backupPath, 'utf-8');
          this.data = JSON.parse(raw);
          this.validate();
          logger.warn('Restored sessions from backup file', { backupPath });
          return;
        } catch {
          // 백업도 실패
        }
      }

      logger.warn('sessions.json corrupted, initializing fresh', {
        error: (primaryErr as Error).message,
      });
      this.data = { sessions: {}, version: 1 };
      await this.save();
    }
  }

  private validate(): void {
    if (!this.data.sessions || typeof this.data.sessions !== 'object') {
      throw new TlError('Invalid sessions.json structure', 'STORE_CORRUPT');
    }
    if (typeof this.data.version !== 'number') {
      this.data.version = 1;
    }
    for (const record of Object.values(this.data.sessions)) {
      ensureLocalSessionDefaults(record);
      ensureRemoteSessionDefaults(record);
    }
  }

  async save(): Promise<void> {
    const dir = getDataDir();
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const backupPath = getBackupPath();
    const tmpPath = this.filePath + '.tmp';

    // 현재 파일을 백업
    if (fs.existsSync(this.filePath)) {
      fs.copyFileSync(this.filePath, backupPath);
    }

    // 임시 파일에 쓰기
    const content = JSON.stringify(this.data, null, 2);
    const fd = fs.openSync(tmpPath, 'w');
    try {
      fs.writeSync(fd, content, 0, 'utf-8');
      // macOS fsync
      try {
        fs.fsyncSync(fd);
      } catch {
        // fsync unsupported — 무시
      }
      fs.closeSync(fd);
    } catch (err) {
      fs.closeSync(fd);
      throw err;
    }

    // Atomic rename
    fs.renameSync(tmpPath, this.filePath);
  }

  get(sessionId: string): { id: string; record: SessionRecord } | undefined {
    const record = this.data.sessions[sessionId];
    if (!record) return undefined;
    return { id: sessionId, record };
  }

  set(sessionId: string, record: SessionRecord): void {
    this.data.sessions[sessionId] = record;
  }

  create(sessionId: string, record: SessionRecord): void {
    if (this.data.sessions[sessionId]) {
      throw new TlError(`Session already exists: ${sessionId}`, 'SESSION_EXISTS');
    }
    this.data.sessions[sessionId] = record;
  }

  delete(sessionId: string): void {
    delete this.data.sessions[sessionId];
  }

  update(sessionId: string, fn: (record: SessionRecord) => void): void {
    const entry = this.data.sessions[sessionId];
    if (!entry) {
      throw new TlError(`Session not found: ${sessionId}`, 'SESSION_NOT_FOUND');
    }
    fn(entry);
  }

  listActive(): Array<{ id: string; record: SessionRecord }> {
    return Object.entries(this.data.sessions)
      .filter(([, r]) => r.status === 'active' || r.status === 'waiting')
      .map(([id, record]) => ({ id, record }));
  }

  listByStatus(status: SessionStatus): Array<{ id: string; record: SessionRecord }> {
    return Object.entries(this.data.sessions)
      .filter(([, r]) => r.status === status)
      .map(([id, record]) => ({ id, record }));
  }

  listAll(): Array<{ id: string; record: SessionRecord }> {
    return Object.entries(this.data.sessions)
      .map(([id, record]) => ({ id, record }));
  }

  async archiveCompleted(maxAgeDays: number = 30): Promise<number> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - maxAgeDays);

    const archived: Record<string, SessionRecord> = {};
    let count = 0;

    for (const [id, record] of Object.entries(this.data.sessions)) {
      if (record.status === 'completed') {
        const completed = new Date(record.completed_at ?? record.started_at);
        if (completed < cutoff) {
          archived[id] = record;
          delete this.data.sessions[id];
          count++;
        }
      }
    }

    if (count > 0) {
      // 아카이브 파일에 추가
      const archivePath = getArchivePath();
      let existing: { sessions: Record<string, SessionRecord> } = { sessions: {} };
      if (fs.existsSync(archivePath)) {
        existing = JSON.parse(fs.readFileSync(archivePath, 'utf-8'));
      }
      existing.sessions = { ...existing.sessions, ...archived };

      const tmpPath = archivePath + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(existing, null, 2), 'utf-8');
      fs.renameSync(tmpPath, archivePath);

      await this.save();
    }

    return count;
  }
}
