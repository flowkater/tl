import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { SessionsStore } from '../src/store.js';
import { SessionRecord } from '../src/types.js';
import { TlError } from '../src/errors.js';

function makeTestDir(): string {
  return path.join(os.tmpdir(), `tl-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function makeRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  const now = new Date().toISOString();
  return {
    status: 'active',
    mode: 'local',
    project: 'test-project',
    cwd: '/tmp/test',
    model: 'gpt-4',
    topic_id: 0,
    start_message_id: 0,
    started_at: now,
    completed_at: null,
    stop_message_id: null,
    reply_message_id: null,
    total_turns: 0,
    last_user_message: '',
    last_turn_output: '',
    last_progress_at: null,
    last_heartbeat_at: null,
    last_resume_ack_at: null,
    late_reply_text: null,
    late_reply_received_at: null,
    late_reply_resume_started_at: null,
    late_reply_resume_error: null,
    remote_mode_enabled: false,
    remote_input_owner: null,
    remote_status: null,
    remote_endpoint: null,
    remote_thread_id: null,
    remote_last_turn_id: null,
    remote_last_injection_at: null,
    remote_last_injection_error: null,
    remote_last_resume_at: null,
    remote_last_resume_error: null,
    remote_last_error: null,
    remote_last_recovery_at: null,
    remote_worker_pid: null,
    remote_worker_log_path: null,
    remote_worker_started_at: null,
    remote_worker_last_error: null,
    ...overrides,
  };
}

describe('SessionsStore', () => {
  let store: SessionsStore;
  let testDir: string;

  beforeEach(() => {
    testDir = makeTestDir();
    process.env.TL_DATA_DIR = testDir;
    store = new SessionsStore();
  });

  afterEach(() => {
    delete process.env.TL_DATA_DIR;
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('load', () => {
    it('creates data directory and empty sessions file if not exists', async () => {
      await store.load();
      expect(fs.existsSync(testDir)).toBe(true);
      const data = JSON.parse(fs.readFileSync(path.join(testDir, 'sessions.json'), 'utf-8'));
      expect(data.sessions).toEqual({});
      expect(data.version).toBe(1);
    });

    it('loads existing sessions', async () => {
      fs.mkdirSync(testDir, { recursive: true });
      const sessionsPath = path.join(testDir, 'sessions.json');
      fs.writeFileSync(sessionsPath, JSON.stringify({
        sessions: { 's1': makeRecord({ status: 'active' }) },
        version: 1,
      }));

      await store.load();
      const entry = store.get('s1');
      expect(entry).toBeDefined();
      expect(entry!.record.status).toBe('active');
    });

    it('hydrates missing local bridge defaults for older records', async () => {
      fs.mkdirSync(testDir, { recursive: true });
      const sessionsPath = path.join(testDir, 'sessions.json');
      const legacy = makeRecord();
      delete (legacy as Partial<SessionRecord>).local_bridge_enabled;
      delete (legacy as Partial<SessionRecord>).local_bridge_state;
      delete (legacy as Partial<SessionRecord>).local_input_queue_depth;
      delete (legacy as Partial<SessionRecord>).local_last_input_source;
      delete (legacy as Partial<SessionRecord>).local_last_input_at;
      delete (legacy as Partial<SessionRecord>).local_last_injection_error;
      delete (legacy as Partial<SessionRecord>).local_attachment_id;

      fs.writeFileSync(sessionsPath, JSON.stringify({
        sessions: { s1: legacy },
        version: 1,
      }));

      await store.load();
      const entry = store.get('s1');
      expect(entry).toBeDefined();
      expect(entry!.record.local_bridge_enabled).toBe(false);
      expect(entry!.record.local_bridge_state).toBeNull();
      expect(entry!.record.local_input_queue_depth).toBe(0);
      expect(entry!.record.local_last_input_source).toBeNull();
      expect(entry!.record.local_last_input_at).toBeNull();
      expect(entry!.record.local_last_injection_error).toBeNull();
      expect(entry!.record.local_attachment_id).toBeNull();
    });

    it('falls back to backup if primary is corrupted', async () => {
      fs.mkdirSync(testDir, { recursive: true });
      const sessionsPath = path.join(testDir, 'sessions.json');
      const backupPath = path.join(testDir, 'sessions.json.bak');

      fs.writeFileSync(sessionsPath, 'NOT JSON');
      fs.writeFileSync(backupPath, JSON.stringify({
        sessions: { 's2': makeRecord({ status: 'waiting' }) },
        version: 1,
      }));

      await store.load();
      const entry = store.get('s2');
      expect(entry).toBeDefined();
      expect(entry!.record.status).toBe('waiting');
    });

    it('initializes fresh if both primary and backup are corrupted', async () => {
      fs.mkdirSync(testDir, { recursive: true });
      fs.writeFileSync(path.join(testDir, 'sessions.json'), 'BAD');
      fs.writeFileSync(path.join(testDir, 'sessions.json.bak'), 'ALSO BAD');

      await store.load();
      const entry = store.get('any');
      expect(entry).toBeUndefined();
    });
  });

  describe('get', () => {
    beforeEach(async () => {
      await store.load();
      store.set('s1', makeRecord({ status: 'active' }));
      await store.save();
    });

    it('returns { id, record } for existing session', () => {
      const entry = store.get('s1');
      expect(entry).toBeDefined();
      expect(entry!.id).toBe('s1');
      expect(entry!.record.status).toBe('active');
    });

    it('returns undefined for non-existing session', () => {
      expect(store.get('nonexistent')).toBeUndefined();
    });
  });

  describe('create', () => {
    beforeEach(async () => {
      await store.load();
    });

    it('creates a new session', () => {
      store.create('new-s', makeRecord());
      const entry = store.get('new-s');
      expect(entry).toBeDefined();
    });

    it('throws if session already exists', () => {
      store.create('dup', makeRecord());
      expect(() => store.create('dup', makeRecord())).toThrow(TlError);
    });
  });

  describe('update', () => {
    beforeEach(async () => {
      await store.load();
      store.set('s1', makeRecord({ status: 'active', total_turns: 5 }));
    });

    it('updates via callback function', () => {
      store.update('s1', (record) => {
        record.status = 'waiting';
        record.total_turns = 6;
      });
      const entry = store.get('s1');
      expect(entry!.record.status).toBe('waiting');
      expect(entry!.record.total_turns).toBe(6);
    });

    it('throws if session not found', () => {
      expect(() => store.update('nope', () => {})).toThrow(TlError);
    });
  });

  describe('listActive', () => {
    beforeEach(async () => {
      await store.load();
      store.set('a1', makeRecord({ status: 'active' }));
      store.set('w1', makeRecord({ status: 'waiting' }));
      store.set('c1', makeRecord({ status: 'completed' }));
    });

    it('returns active and waiting sessions', () => {
      const list = store.listActive();
      expect(list).toHaveLength(2);
      const ids = list.map((e) => e.id);
      expect(ids).toContain('a1');
      expect(ids).toContain('w1');
    });
  });

  describe('listAll', () => {
    beforeEach(async () => {
      await store.load();
      store.set('a1', makeRecord({ status: 'active' }));
      store.set('w1', makeRecord({ status: 'waiting' }));
      store.set('c1', makeRecord({ status: 'completed' }));
    });

    it('returns sessions across all statuses', () => {
      const list = store.listAll();
      expect(list).toHaveLength(3);
      const ids = list.map((e) => e.id);
      expect(ids).toContain('a1');
      expect(ids).toContain('w1');
      expect(ids).toContain('c1');
    });
  });

  describe('archiveCompleted', () => {
    beforeEach(async () => {
      await store.load();
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 35);
      store.set('old', makeRecord({
        status: 'completed',
        started_at: oldDate.toISOString(),
        completed_at: oldDate.toISOString(),
      }));
      store.set('new', makeRecord({
        status: 'completed',
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
      }));
      store.set('active', makeRecord({ status: 'active' }));
      await store.save();
    });

    it('archives old completed sessions', async () => {
      const count = await store.archiveCompleted(30);
      expect(count).toBe(1);

      expect(store.get('old')).toBeUndefined();
      expect(store.get('new')).toBeDefined();
      expect(store.get('active')).toBeDefined();

      const archivePath = path.join(testDir, 'sessions-archive.json');
      expect(fs.existsSync(archivePath)).toBe(true);
      const archive = JSON.parse(fs.readFileSync(archivePath, 'utf-8'));
      expect(archive.sessions['old']).toBeDefined();
    });
  });
});
