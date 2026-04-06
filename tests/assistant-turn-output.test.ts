import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  buildStopMessageFromTranscript,
  collectAssistantTurnMessagesFromTranscriptText,
} from '../src/assistant-turn-output.js';

function makeTranscript(lines: unknown[]): string {
  return lines.map((line) => JSON.stringify(line)).join('\n');
}

describe('assistant-turn-output', () => {
  it('collects commentary and final assistant messages after the latest user message', () => {
    const transcript = makeTranscript([
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'old prompt' }],
        },
      },
      {
        type: 'event_msg',
        payload: {
          type: 'agent_message',
          phase: 'commentary',
          message: 'old commentary',
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'new prompt' }],
        },
      },
      {
        type: 'event_msg',
        payload: {
          type: 'agent_message',
          phase: 'commentary',
          message: 'first commentary',
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          phase: 'commentary',
          content: [{ type: 'output_text', text: 'first commentary' }],
        },
      },
      {
        type: 'event_msg',
        payload: {
          type: 'agent_message',
          phase: 'commentary',
          message: 'second commentary',
        },
      },
      {
        type: 'event_msg',
        payload: {
          type: 'agent_message',
          phase: 'final_answer',
          message: 'final answer',
        },
      },
    ]);

    expect(collectAssistantTurnMessagesFromTranscriptText(transcript)).toBe(
      'first commentary\n\nsecond commentary\n\nfinal answer'
    );
  });

  it('falls back to last_assistant_message when transcript cannot provide a turn body', () => {
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-transcript-'));
    const transcriptPath = path.join(testDir, 'session.jsonl');
    fs.writeFileSync(
      transcriptPath,
      makeTranscript([
        {
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'prompt only' }],
          },
        },
      ]),
      'utf-8'
    );

    expect(
      buildStopMessageFromTranscript(transcriptPath, 'fallback final')
    ).toBe('fallback final');
  });
});
