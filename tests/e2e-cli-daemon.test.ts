import { describe, expect, it, vi } from 'vitest';
import {
  TlE2EHarness,
  runStandaloneCliWithConfig,
} from './helpers/e2e-harness.js';

describe.sequential('TL CLI + daemon E2E', () => {
  it('boots an isolated harness', async () => {
    const harness = await TlE2EHarness.create({ stopTimeout: 5 });
    try {
      expect(harness.url('/status')).toContain('http://127.0.0.1:');
      expect(harness.telegram.events).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it('runs SessionStart -> Stop -> reply -> Working across real CLI and daemon', async () => {
    const harness = await TlE2EHarness.create({ stopTimeout: 5 });
    try {
      const transcriptPath = harness.writeTranscript([
        ['user', 'start work'],
        ['commentary', 'first commentary'],
        ['final', 'final answer'],
      ]);

      const start = await harness.runCli(
        ['hook-session-start'],
        harness.sessionStartPayload('s1', transcriptPath)
      );
      expect(start.code).toBe(0);
      expect(start.stdout).toContain('Session started: s1');

      await vi.waitFor(() => {
        expect(harness.store.get('s1')?.record.status).toBe('active');
      });
      expect(harness.telegram.count('topic')).toBe(1);
      expect(harness.telegram.count('start')).toBe(1);

      const stopProcess = harness.spawnCli(
        ['hook-stop-and-wait'],
        harness.stopPayload('s1', transcriptPath, 'fallback final')
      );

      await vi.waitFor(() => {
        expect(harness.store.get('s1')?.record.status).toBe('waiting');
      });
      await vi.waitFor(() => {
        expect(harness.telegram.count('stop')).toBe(1);
      });

      const stopEvent = harness.telegram.find('stop');
      expect(stopEvent && 'body' in stopEvent ? stopEvent.body : '').toBe(
        'first commentary\n\nfinal answer'
      );

      harness.replyQueue.deliver('s1', 'reply from telegram');
      const stop = await stopProcess.waitForExit();

      expect(stop.code).toBe(0);
      expect(stop.stderr.trim()).toBe('');
      expect(stop.stdout.trim()).toBe('{"decision":"block","reason":"reply from telegram"}');

      await vi.waitFor(() => {
        expect(harness.store.get('s1')?.record.status).toBe('active');
      });
      await vi.waitFor(() => {
        expect(harness.telegram.count('resume-ack')).toBe(1);
      });

      const working = await harness.runCli(['hook-working'], harness.workingPayload('s1'));
      expect(working.code).toBe(0);
      expect(working.stderr.trim()).toBe('');
      await vi.waitFor(() => {
        expect(harness.store.get('s1')?.record.last_progress_at).not.toBeNull();
      });
      expect(harness.telegram.count('working')).toBe(1);

      const statusResponse = await fetch(harness.url('/status'));
      expect(statusResponse.status).toBe(200);
      expect(await statusResponse.json()).toMatchObject({
        daemon: 'running',
        active_sessions: 1,
        waiting_sessions: 0,
      });
    } finally {
      await harness.close();
    }
  });

  it('auto-attaches remote metadata when TL_REMOTE_ENDPOINT is set for hook-session-start', async () => {
    const harness = await TlE2EHarness.create({ stopTimeout: 5 });
    try {
      const transcriptPath = harness.writeTranscript([
        ['user', 'remote auto attach'],
        ['final', 'ready'],
      ]);

      const start = await harness.runCli(
        ['hook-session-start'],
        harness.sessionStartPayload('remote-s1', transcriptPath),
        {
          TL_REMOTE_ENDPOINT: 'ws://127.0.0.1:8899',
        }
      );
      expect(start.code).toBe(0);

      await vi.waitFor(() => {
        const session = harness.store.get('remote-s1')?.record;
        expect(session?.remote_mode_enabled).toBe(true);
        expect(session?.remote_endpoint).toBe('ws://127.0.0.1:8899');
        expect(session?.remote_thread_id).toBe('remote-s1');
      });
    } finally {
      await harness.close();
    }
  });

  it('returns continue when stop wait times out and restores the session to active', async () => {
    const harness = await TlE2EHarness.create({ stopTimeout: 1 });
    try {
      const transcriptPath = harness.writeTranscript([
        ['user', 'timeout path'],
        ['commentary', 'timeout commentary'],
        ['final', 'timeout final'],
      ]);

      const start = await harness.runCli(
        ['hook-session-start'],
        harness.sessionStartPayload('s-timeout', transcriptPath)
      );
      expect(start.code).toBe(0);

      const stop = await harness.runCli(
        ['hook-stop-and-wait'],
        harness.stopPayload('s-timeout', transcriptPath, 'fallback timeout')
      );

      expect(stop.code).toBe(0);
      expect(stop.stdout.trim()).toBe('');
      expect(stop.stderr.trim()).toBe('');
      expect(harness.store.get('s-timeout')?.record.status).toBe('active');
      expect(harness.telegram.count('stop')).toBe(1);
      expect(harness.telegram.count('resume-ack')).toBe(0);
    } finally {
      await harness.close();
    }
  });

  it('gracefully exits with a warning when stop hook cannot reach the daemon', async () => {
    const result = await runStandaloneCliWithConfig({
      port: 6551,
      stopTimeout: 1,
      stdin: JSON.stringify({
        session_id: 'unreachable',
        turn_id: 'turn-1',
        hook_event_name: 'Stop',
        model: 'gpt-5.4',
        cwd: process.cwd(),
        transcript_path: '/tmp/does-not-matter.jsonl',
        stop_hook_active: true,
        last_assistant_message: 'fallback',
      }),
    });

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe('');
    expect(result.stderr).toContain('Warning: Hook connection failed');
  });

  it('starts a local managed session through the CLI and exposes local status', async () => {
    const harness = await TlE2EHarness.create({ stopTimeout: 5 });
    try {
      const start = await harness.runCli(
        ['local', 'start', '--cwd', process.cwd(), '--project', 'local-managed-poc'],
        ''
      );

      expect(start.code).toBe(0);
      const payload = JSON.parse(start.stdout);
      expect(payload).toMatchObject({
        status: 'started',
        mode: 'local-managed',
        endpoint: 'ws://127.0.0.1:8795',
      });

      const session = harness.store.get(payload.session_id)?.record;
      expect(session?.local_bridge_enabled).toBe(true);
      expect(session?.local_bridge_state).toBe('attached');
      expect(session?.local_attachment_id).toBe(payload.thread_id);
      expect(session?.remote_endpoint).toBe('ws://127.0.0.1:8795');

      const status = await harness.runCli(['local', 'status', payload.session_id], '');
      expect(status.code).toBe(0);
      expect(JSON.parse(status.stdout)).toMatchObject({
        session_id: payload.session_id,
        mode: 'local-managed',
        endpoint: 'ws://127.0.0.1:8795',
        local_bridge_enabled: true,
        local_bridge_state: 'attached',
      });
    } finally {
      await harness.close();
    }
  });
});
