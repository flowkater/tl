import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  isReconnectSessionStart,
  isSubagentSessionStart,
} from '../src/session-start-filter.js';

const tempPaths: string[] = [];

function writeTranscript(firstLinePayload: unknown): string {
  const filePath = path.join(
    os.tmpdir(),
    `tl-session-start-filter-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`
  );
  const firstLine = JSON.stringify(firstLinePayload);
  fs.writeFileSync(filePath, `${firstLine}\n{"timestamp":"next"}`, 'utf-8');
  tempPaths.push(filePath);
  return filePath;
}

afterEach(() => {
  for (const filePath of tempPaths.splice(0)) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      // ignore
    }
  }
});

describe('isSubagentSessionStart', () => {
  it('returns false for a root session transcript', () => {
    const transcriptPath = writeTranscript({
      type: 'session_meta',
      payload: {
        id: 'root-session',
        cwd: '/tmp/project',
        source: { cli: { source: 'startup' } },
      },
    });

    expect(isSubagentSessionStart({ transcript_path: transcriptPath })).toBe(false);
  });

  it('returns true when transcript session_meta contains subagent source', () => {
    const transcriptPath = writeTranscript({
      type: 'session_meta',
      payload: {
        id: 'child-session',
        forked_from_id: 'root-session',
        source: {
          subagent: {
            thread_spawn: {
              parent_thread_id: 'root-session',
              depth: 1,
            },
          },
        },
      },
    });

    expect(isSubagentSessionStart({ transcript_path: transcriptPath })).toBe(true);
  });

  it('returns true when forked_from_id exists even if source is missing', () => {
    const transcriptPath = writeTranscript({
      type: 'session_meta',
      payload: {
        id: 'child-session',
        forked_from_id: 'root-session',
      },
    });

    expect(isSubagentSessionStart({ transcript_path: transcriptPath })).toBe(true);
  });
});

describe('isReconnectSessionStart', () => {
  it('returns true when source is resume', () => {
    expect(
      isReconnectSessionStart({
        source: 'resume',
      })
    ).toBe(true);
  });

  it('returns false when source is startup', () => {
    expect(
      isReconnectSessionStart({
        source: 'startup',
      })
    ).toBe(false);
  });
});
