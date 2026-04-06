#!/usr/bin/env node
// Stop 훅 CLI — stdin에서 JSON 읽어서 데몬으로 POST, long-polling으로 응답 대기

import fs from 'fs';
import path from 'path';
import os from 'os';
import { serializeStopHookOutput } from '../stop-hook-output.js';
import { HookOutput, StopPayload } from '../types.js';

function getConfigDir(): string {
  return process.env.TL_CONFIG_DIR || path.join(os.homedir(), '.tl');
}

async function main() {
  const configPath = path.join(getConfigDir(), 'config.json');
  let port = 9877;
  let stopTimeout = 7200;
  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      port = config.hookPort || 9877;
      stopTimeout = config.stopTimeout || 7200;
    } catch { /* ignore */ }
  }

  const stdin = fs.readFileSync(0, 'utf-8');
  if (!stdin.trim()) {
    process.stderr.write('No input on stdin\n');
    process.exit(1);
  }

  try {
    const res = await fetch(`http://localhost:${port}/hook/stop-and-wait`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: stdin,
      signal: AbortSignal.timeout((stopTimeout + 100) * 1000),
    });

    const data = (await res.json()) as StopAndWaitResponse;

    if (!res.ok) {
      // SESSION_NOT_FOUND 등은 continue로 처리
      process.stderr.write(`Warning: HTTP ${res.status}: ${JSON.stringify(data)}\n`);
      process.exit(0);
    }

    const serialized = serializeStopHookOutput(data);
    if (serialized) {
      const payload = JSON.parse(stdin) as StopPayload;
      await writeStdout(serialized + '\n');
      if (payload.session_id && !resumeAckAlreadyQueued(data)) {
        await postResumeAck(payload.session_id, port);
      }
    }
    process.exit(0);
  } catch (err) {
    process.stderr.write(`Warning: Hook connection failed: ${(err as Error).message}\n`);
    process.exit(0);
  }
}

async function writeStdout(text: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(text, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

async function postResumeAck(sessionId: string, port: number): Promise<void> {
  try {
    await fetch(`http://localhost:${port}/hook/resume-ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch (err) {
    process.stderr.write(`Warning: Resume ACK failed: ${(err as Error).message}\n`);
  }
}

type StopAndWaitResponse = HookOutput & {
  resume_ack_queued?: boolean;
};

function resumeAckAlreadyQueued(output: StopAndWaitResponse): boolean {
  return output.decision === 'block' && output.resume_ack_queued === true;
}

main();
