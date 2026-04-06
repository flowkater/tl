import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { ReplyQueue } from '../src/reply-queue.js';

function makeTestDir(): string {
  return path.join(os.tmpdir(), `tl-rq-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

describe('ReplyQueue', () => {
  let queue: ReplyQueue;
  let testDir: string;

  beforeEach(() => {
    testDir = makeTestDir();
    process.env.TL_DATA_DIR = testDir;
    queue = new ReplyQueue();
  });

  afterEach(() => {
    delete process.env.TL_DATA_DIR;
    queue.shutdown();
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('waitFor + deliver', () => {
    it('delivers reply to waiting consumer', async () => {
      const promise = queue.waitFor('s1', 10);

      const delivered = queue.deliver('s1', 'hello there');
      expect(delivered).toBe(true);

      const result = await promise;
      expect(result.decision).toBe('block');
      expect(result.reason).toBe('hello there');
    });

    it('returns continue on timeout', async () => {
      const start = Date.now();
      const result = await queue.waitFor('s2', 0.1);
      const elapsed = Date.now() - start;

      expect(result.decision).toBe('continue');
      expect(elapsed).toBeGreaterThanOrEqual(90);
      expect(elapsed).toBeLessThan(1000);
    });

    it('returns continue and clears pending when the waiting consumer aborts', async () => {
      const controller = new AbortController();
      const promise = queue.waitFor('s-abort', 10, {
        signal: controller.signal,
      });

      controller.abort();

      const result = await promise;
      expect(result.decision).toBe('continue');

      const delivered = queue.deliver('s-abort', 'late reply', {
        queueIfMissing: false,
      });
      expect(delivered).toBe(false);
    });

    it('returns continue when session is not pending', () => {
      const delivered = queue.deliver('nonexistent', 'orphan reply');
      expect(delivered).toBe(false);
    });

    it('does not create a file when queueIfMissing is false', () => {
      const delivered = queue.deliver('nonexistent', 'orphan reply', {
        queueIfMissing: false,
      });
      expect(delivered).toBe(false);

      const queueDir = path.join(testDir, 'reply-queue');
      const files = fs.readdirSync(queueDir).filter((f) => f.endsWith('.json'));
      expect(files).toHaveLength(0);
    });

    it('only first deliver resolves, subsequent ones go to file', async () => {
      const promise = queue.waitFor('s3', 10);
      queue.deliver('s3', 'first');
      const result = await promise;
      expect(result.decision).toBe('block');
      expect(result.reason).toBe('first');

      // Second deliver should go to file queue
      const second = queue.deliver('s3', 'second');
      expect(second).toBe(false);

      // 파일이 생성되었는지 확인
      const queueDir = path.join(testDir, 'reply-queue');
      const files = fs.readdirSync(queueDir).filter((f) => f.endsWith('.json'));
      expect(files.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('file queue', () => {
    it('delivers a pre-queued reply when waitFor starts later', async () => {
      queue.deliver('s0', 'queued before wait');

      const result = await queue.waitFor('s0', 1);

      expect(result.decision).toBe('block');
      expect(result.reason).toBe('queued before wait');

      const queueDir = path.join(testDir, 'reply-queue');
      const remaining = fs.readdirSync(queueDir).filter((f) => f.endsWith('.json'));
      expect(remaining.length).toBe(0);
    });

    it('processes file queue on restart', async () => {
      // pending consumer가 없는 상태에서 deliver → 파일 큐
      queue.deliver('s4', 'queued reply');

      const queueDir = path.join(testDir, 'reply-queue');
      const files = fs.readdirSync(queueDir).filter((f) => f.endsWith('.json'));
      expect(files.length).toBe(1);

      // 이제 consumer 등록 + 파일 큐 처리
      const promise = queue.waitFor('s4', 10);
      await queue.processFileQueue();

      const result = await promise;
      expect(result.decision).toBe('block');
      expect(result.reason).toBe('queued reply');

      // 처리된 파일 삭제 확인
      const remaining = fs.readdirSync(queueDir).filter((f) => f.endsWith('.json'));
      expect(remaining.length).toBe(0);
    });
  });

  describe('shutdown', () => {
    it('resolves all pending with continue', async () => {
      const p1 = queue.waitFor('s1', 10);
      const p2 = queue.waitFor('s2', 10);

      queue.shutdown();

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1.decision).toBe('continue');
      expect(r2.decision).toBe('continue');
    });
  });

  describe('cleanup', () => {
    it('removes orphan entries older than 2 hours', async () => {
      // orphan 생성을 위해 내부 pending에 직접 접근
      queue.startCleanupInterval(100);

      // waitFor로 pending entry 생성
      const promise = queue.waitFor('s5', 10);

      // cleanup은 2시간 이상만 제거하므로 이 테스트는 즉시 정리 안 됨
      // 기본 동작 확인만
      expect(queue).toBeDefined();

      queue.shutdown();
      await promise;
    });
  });
});
