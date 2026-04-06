import fs from 'fs';
import { SessionStartPayload } from './types.js';

const READ_CHUNK_SIZE = 64 * 1024;
const MAX_FIRST_LINE_BYTES = 1024 * 1024;

function readFirstLine(filePath: string): string | null {
  const fd = fs.openSync(filePath, 'r');
  try {
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    while (totalBytes < MAX_FIRST_LINE_BYTES) {
      const buffer = Buffer.alloc(READ_CHUNK_SIZE);
      const bytesRead = fs.readSync(fd, buffer, 0, READ_CHUNK_SIZE, null);
      if (bytesRead <= 0) {
        break;
      }

      const slice = buffer.subarray(0, bytesRead);
      const newlineIndex = slice.indexOf(0x0a);
      if (newlineIndex >= 0) {
        chunks.push(slice.subarray(0, newlineIndex));
        return Buffer.concat(chunks).toString('utf-8');
      }

      chunks.push(slice);
      totalBytes += bytesRead;
    }

    if (chunks.length === 0) {
      return null;
    }

    return Buffer.concat(chunks).toString('utf-8');
  } finally {
    fs.closeSync(fd);
  }
}

export function isSubagentSessionStart(
  payload: Pick<SessionStartPayload, 'transcript_path'>
): boolean {
  if (!payload.transcript_path || !fs.existsSync(payload.transcript_path)) {
    return false;
  }

  try {
    const firstLine = readFirstLine(payload.transcript_path);
    if (!firstLine) {
      return false;
    }

    const parsed = JSON.parse(firstLine);
    const sessionMeta = parsed?.type === 'session_meta' ? parsed.payload : null;
    if (!sessionMeta || typeof sessionMeta !== 'object') {
      return false;
    }

    const source = (sessionMeta as any).source;
    if (source && typeof source === 'object' && 'subagent' in source) {
      return true;
    }

    return typeof (sessionMeta as any).forked_from_id === 'string';
  } catch {
    return false;
  }
}

export function isReconnectSessionStart(
  payload: Pick<SessionStartPayload, 'source'>
): boolean {
  return payload.source === 'resume';
}
