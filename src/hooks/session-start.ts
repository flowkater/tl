#!/usr/bin/env node
// SessionStart 훅 CLI — stdin에서 JSON 읽어서 데몬으로 POST

import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  isReconnectSessionStart,
  isSubagentSessionStart,
} from '../session-start-filter.js';
import { resolveRemoteEndpoint } from '../remote-endpoint-discovery.js';
import { SessionStartPayload } from '../types.js';

function getConfigDir(): string {
  return process.env.TL_CONFIG_DIR || path.join(os.homedir(), '.tl');
}

async function main() {
  const configPath = path.join(getConfigDir(), 'config.json');
  const remoteEndpoint = resolveRemoteEndpoint();
  const remoteThreadId = process.env.TL_REMOTE_THREAD_ID?.trim() || null;
  let port = 9877;
  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      port = config.hookPort || 9877;
    } catch { /* ignore */ }
  }

  const stdin = fs.readFileSync(0, 'utf-8');
  if (!stdin.trim()) {
    process.stderr.write('No input on stdin\n');
    process.exit(1);
  }

  try {
    const payload = JSON.parse(stdin) as SessionStartPayload;
    if (isSubagentSessionStart(payload)) {
      process.exit(0);
    }

    const res = await fetch(`http://localhost:${port}/hook/session-start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...payload,
        is_reconnect: isReconnectSessionStart(payload),
        remote_endpoint: remoteEndpoint,
        remote_thread_id: remoteThreadId,
      }),
    });

    const data = await res.json();
    if (!res.ok) {
      process.stderr.write(`HTTP ${res.status}: ${JSON.stringify(data)}\n`);
      process.exit(1);
    }

    process.stdout.write(`Session started: ${data.session_id} (topic: ${data.topic_id})\n`);
    process.exit(0);
  } catch (err) {
    process.stderr.write(`Failed to connect to daemon: ${(err as Error).message}\n`);
    process.exit(1);
  }
}

main();
