import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import {
  LateReplyResumer,
  buildResumeCommandArgs,
} from '../src/late-reply-resumer.js';
import { SessionRecord } from '../src/types.js';

function makeRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  const now = new Date().toISOString();
  return {
    status: 'active',
    project: 'test',
    cwd: '/tmp/test',
    model: 'gpt-5',
    topic_id: 42,
    start_message_id: 0,
    started_at: now,
    completed_at: null,
    stop_message_id: 88,
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
    ...overrides,
  };
}

class FakeChildProcess extends EventEmitter {
  unref = vi.fn();
}

describe('LateReplyResumer', () => {
  let sessions: Record<string, SessionRecord>;
  let store: any;
  let tg: any;

  beforeEach(() => {
    sessions = {};
    store = {
      get: vi.fn((id: string) => {
        const record = sessions[id];
        return record ? { id, record } : undefined;
      }),
      update: vi.fn((id: string, fn: (record: SessionRecord) => void) => {
        fn(sessions[id]);
      }),
      save: vi.fn().mockResolvedValue(undefined),
    };
    tg = {
      sendLateReplyResumeStartedMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
      sendLateReplyResumeFailedMessage: vi.fn().mockResolvedValue({ message_id: 2 }),
    };
  });

  it('launches codex resume for a late reply and records in-flight state', async () => {
    sessions.s1 = makeRecord();
    const child = new FakeChildProcess();
    const launchResume = vi.fn().mockResolvedValue(child);
    const resumer = new LateReplyResumer(store, tg, {
      groupId: -100123,
      launchResume,
    });

    const launched = await resumer.handle('s1', 'late reply');

    expect(launched).toBe(true);
    expect(launchResume).toHaveBeenCalledWith({
      sessionId: 's1',
      replyText: 'late reply',
      cwd: '/tmp/test',
    });
    expect(sessions.s1.late_reply_text).toBe('late reply');
    expect(sessions.s1.late_reply_received_at).not.toBeNull();
    expect(sessions.s1.late_reply_resume_started_at).not.toBeNull();
    expect(sessions.s1.late_reply_resume_error).toBeNull();
    expect(tg.sendLateReplyResumeStartedMessage).toHaveBeenCalledWith(-100123, 42);
    expect(child.unref).toHaveBeenCalled();
  });

  it('does not launch a duplicate resume while one is already in progress', async () => {
    sessions.s1 = makeRecord({
      late_reply_resume_started_at: '2026-04-06T00:00:00.000Z',
    });
    const launchResume = vi.fn();
    const resumer = new LateReplyResumer(store, tg, {
      groupId: -100123,
      launchResume,
    });

    const launched = await resumer.handle('s1', 'late reply');

    expect(launched).toBe(false);
    expect(launchResume).not.toHaveBeenCalled();
  });

  it('records the failure and notifies Telegram when resume launch fails', async () => {
    sessions.s1 = makeRecord();
    const resumer = new LateReplyResumer(store, tg, {
      groupId: -100123,
      launchResume: vi.fn().mockRejectedValue(new Error('spawn failed')),
    });

    const launched = await resumer.handle('s1', 'late reply');

    expect(launched).toBe(true);
    expect(sessions.s1.late_reply_resume_started_at).toBeNull();
    expect(sessions.s1.late_reply_resume_error).toBe('spawn failed');
    expect(tg.sendLateReplyResumeFailedMessage).toHaveBeenCalledWith(
      -100123,
      42,
      'spawn failed'
    );
  });

  it('does not mark launch as failed when only the Telegram started notice fails', async () => {
    sessions.s1 = makeRecord();
    const child = new FakeChildProcess();
    tg.sendLateReplyResumeStartedMessage.mockRejectedValueOnce(new Error('telegram down'));
    const resumer = new LateReplyResumer(store, tg, {
      groupId: -100123,
      launchResume: vi.fn().mockResolvedValue(child),
    });

    const launched = await resumer.handle('s1', 'late reply');

    expect(launched).toBe(true);
    expect(sessions.s1.late_reply_resume_started_at).not.toBeNull();
    expect(sessions.s1.late_reply_resume_error).toBeNull();
    expect(tg.sendLateReplyResumeFailedMessage).not.toHaveBeenCalled();
  });

  it('builds a danger-full-access codex exec resume command for late replies', () => {
    expect(buildResumeCommandArgs('s1', 'late reply')).toEqual([
      'exec',
      'resume',
      '--dangerously-bypass-approvals-and-sandbox',
      's1',
      'late reply',
    ]);
  });
});
