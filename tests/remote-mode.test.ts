import { describe, it, expect } from 'vitest';
import {
  attachRemoteSession,
  clearRemoteSession,
  ensureRemoteSessionDefaults,
  hasRemoteSessionAttachment,
} from '../src/remote-mode.js';
import type { SessionRecord } from '../src/types.js';

function makeRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  const now = new Date().toISOString();
  return {
    status: 'active',
    project: 'test',
    cwd: '/tmp/test',
    model: 'gpt-4.1',
    topic_id: 42,
    start_message_id: 100,
    started_at: now,
    completed_at: null,
    stop_message_id: null,
    reply_message_id: null,
    total_turns: 1,
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
    remote_endpoint: null,
    remote_thread_id: null,
    remote_last_turn_id: null,
    remote_last_injection_at: null,
    remote_last_injection_error: null,
    ...overrides,
  };
}

describe('remote-mode helpers', () => {
  it('applies missing remote defaults to older session records', () => {
    const legacyRecord = {
      status: 'active',
      project: 'test',
      cwd: '/tmp/test',
      model: 'gpt-4.1',
      topic_id: 42,
      start_message_id: 100,
      started_at: new Date().toISOString(),
      completed_at: null,
      stop_message_id: null,
      reply_message_id: null,
      total_turns: 1,
      last_user_message: '',
      last_turn_output: '',
      last_progress_at: null,
      last_heartbeat_at: null,
      last_resume_ack_at: null,
      late_reply_text: null,
      late_reply_received_at: null,
      late_reply_resume_started_at: null,
      late_reply_resume_error: null,
    } as SessionRecord;

    ensureRemoteSessionDefaults(legacyRecord);

    expect(legacyRecord.remote_mode_enabled).toBe(false);
    expect(legacyRecord.remote_endpoint).toBeNull();
    expect(legacyRecord.remote_thread_id).toBeNull();
    expect(legacyRecord.remote_last_turn_id).toBeNull();
  });

  it('attaches and detaches remote metadata cleanly', () => {
    const record = makeRecord();

    attachRemoteSession(record, {
      endpoint: 'ws://127.0.0.1:4321',
      threadId: 'thread-1',
      lastTurnId: 'turn-9',
    });

    expect(hasRemoteSessionAttachment(record)).toBe(true);
    expect(record.remote_endpoint).toBe('ws://127.0.0.1:4321');
    expect(record.remote_thread_id).toBe('thread-1');
    expect(record.remote_last_turn_id).toBe('turn-9');

    clearRemoteSession(record);

    expect(hasRemoteSessionAttachment(record)).toBe(false);
    expect(record.remote_endpoint).toBeNull();
    expect(record.remote_thread_id).toBeNull();
    expect(record.remote_last_turn_id).toBeNull();
  });
});
