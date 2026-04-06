import fs from 'fs';
import path from 'path';
import os from 'os';
import { HookOutput } from './types.js';
import { logger } from './logger.js';

interface PendingEntry {
  sessionId: string;
  resolve: (output: HookOutput) => void;
  timer: NodeJS.Timeout;
  createdAt: number;
}

interface ReplyFileEntry {
  sessionId: string;
  replyText: string;
  createdAt: string;
}

interface DeliverOptions {
  queueIfMissing?: boolean;
}

interface WaitOptions {
  signal?: AbortSignal;
}

function getDataDir(): string {
  return process.env.TL_DATA_DIR || path.join(os.homedir(), '.tl');
}

function getReplyQueueDir(): string {
  return path.join(getDataDir(), 'reply-queue');
}

export class ReplyQueue {
  private pending = new Map<string, PendingEntry>();
  private fileQueueDir: string;
  private cleanupTimer?: NodeJS.Timeout;

  constructor() {
    this.fileQueueDir = getReplyQueueDir();
    if (!fs.existsSync(this.fileQueueDir)) {
      fs.mkdirSync(this.fileQueueDir, { recursive: true });
    }
  }

  async waitFor(
    sessionId: string,
    timeoutSec: number,
    options: WaitOptions = {}
  ): Promise<HookOutput> {
    return new Promise<HookOutput>((resolve) => {
      let settled = false;
      const previous = this.pending.get(sessionId);
      if (previous) {
        logger.warn('Replacing duplicate waiting consumer for session', {
          sessionId,
        });
        previous.resolve({ decision: 'continue' });
      }

      let pendingEntry!: PendingEntry;

      const finish = (output: HookOutput): void => {
        if (settled) {
          return;
        }
        settled = true;

        const pending = this.pending.get(sessionId);
        if (pending === pendingEntry) {
          clearTimeout(pendingEntry.timer);
          this.pending.delete(sessionId);
        } else {
          clearTimeout(pendingEntry.timer);
        }

        if (options.signal) {
          options.signal.removeEventListener('abort', onAbort);
        }

        resolve(output);
      };

      const timer = setTimeout(() => {
        logger.info('ReplyQueue timeout, returning continue', { sessionId });
        finish({ decision: 'continue' });
      }, timeoutSec * 1000);

      const onAbort = () => {
        logger.warn('ReplyQueue wait aborted, returning continue', { sessionId });
        finish({ decision: 'continue' });
      };

      pendingEntry = {
        sessionId,
        resolve: finish,
        timer,
        createdAt: Date.now(),
      };
      this.pending.set(sessionId, pendingEntry);

      if (options.signal?.aborted) {
        onAbort();
        return;
      }

      if (options.signal) {
        options.signal.addEventListener('abort', onAbort, { once: true });
      }

      this.processFileQueueForSession(sessionId);
    });
  }

  deliver(sessionId: string, replyText: string, options: DeliverOptions = {}): boolean {
    const entry = this.pending.get(sessionId);
    if (entry) {
      clearTimeout(entry.timer);
      this.pending.delete(sessionId);
      entry.resolve({ decision: 'block', reason: replyText });
      logger.info('Reply delivered to waiting hook', { sessionId });
      return true;
    }

    if (options.queueIfMissing !== false) {
      // pending에 없으면 파일 큐에 저장
      this.enqueueToFile(sessionId, replyText);
    } else {
      logger.warn('Reply ignored because no waiting consumer was present', {
        sessionId,
      });
    }
    return false;
  }

  private enqueueToFile(sessionId: string, replyText: string): void {
    if (!fs.existsSync(this.fileQueueDir)) {
      fs.mkdirSync(this.fileQueueDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `${sessionId}-${timestamp}.json`;
    const filePath = path.join(this.fileQueueDir, fileName);

    const entry: ReplyFileEntry = {
      sessionId,
      replyText,
      createdAt: new Date().toISOString(),
    };

    fs.writeFileSync(filePath, JSON.stringify(entry, null, 2), 'utf-8');
    logger.warn('Reply queued to file (no waiting consumer)', {
      sessionId,
      filePath,
    });
  }

  async processFileQueue(): Promise<void> {
    if (!fs.existsSync(this.fileQueueDir)) return;

    const files = fs.readdirSync(this.fileQueueDir).filter((f) => f.endsWith('.json'));
    for (const file of files) {
      const filePath = path.join(this.fileQueueDir, file);
      try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const entry: ReplyFileEntry = JSON.parse(raw);

        const pending = this.pending.get(entry.sessionId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(entry.sessionId);
          pending.resolve({ decision: 'block', reason: entry.replyText });
          logger.info('File queue reply delivered', { sessionId: entry.sessionId });
        } else {
          // consumer가 없으면 파일 유지 (다음 재시작 때 재시도)
          logger.debug('No pending consumer for file queue entry', {
            sessionId: entry.sessionId,
          });
          continue;
        }

        // 처리 완료된 파일 삭제
        fs.unlinkSync(filePath);
      } catch (err) {
        logger.error('Failed to process file queue entry', { file, error: (err as Error).message });
      }
    }
  }

  private processFileQueueForSession(sessionId: string): void {
    if (!fs.existsSync(this.fileQueueDir)) return;

    const files = fs.readdirSync(this.fileQueueDir)
      .filter((file) => file.startsWith(`${sessionId}-`) && file.endsWith('.json'))
      .sort();

    for (const file of files) {
      const filePath = path.join(this.fileQueueDir, file);

      try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const entry: ReplyFileEntry = JSON.parse(raw);
        const pending = this.pending.get(sessionId);
        if (!pending) {
          return;
        }

        clearTimeout(pending.timer);
        this.pending.delete(sessionId);
        pending.resolve({ decision: 'block', reason: entry.replyText });
        fs.unlinkSync(filePath);
        logger.info('File queue reply delivered', { sessionId });
        return;
      } catch (err) {
        logger.error('Failed to process file queue entry', {
          file,
          error: (err as Error).message,
        });
      }
    }
  }

  shutdown(): void {
    for (const [sessionId, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.resolve({ decision: 'continue' });
      logger.info('ReplyQueue shutdown: resolved pending with continue', { sessionId });
    }
    this.pending.clear();

    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
  }

  startCleanupInterval(intervalMs: number = 30_000): void {
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [sessionId, entry] of this.pending) {
        // timeout은 waitFor 내부에서 처리되므로 여기서는 orphan만 정리
        if (now - entry.createdAt > 2 * 60 * 60 * 1000) {
          // 2시간 이상 고아 entry 정리
          logger.warn('Cleaned up orphan pending entry', { sessionId });
          entry.resolve({ decision: 'continue' });
        }
      }
    }, intervalMs);
  }
}
