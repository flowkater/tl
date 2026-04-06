import fs from 'fs';
import { logger } from './logger.js';

const ASSISTANT_PHASES = new Set(['commentary', 'final_answer']);

export function buildStopMessageFromTranscript(
  transcriptPath: string | undefined,
  fallback: string
): string {
  if (!transcriptPath) {
    return fallback;
  }

  try {
    const transcript = fs.readFileSync(transcriptPath, 'utf-8');
    return collectAssistantTurnMessagesFromTranscriptText(transcript) ?? fallback;
  } catch (err) {
    logger.warn('Failed to build stop message from transcript', {
      transcriptPath,
      error: (err as Error).message,
    });
    return fallback;
  }
}

export function collectAssistantTurnMessagesFromTranscriptText(
  transcript: string
): string | null {
  const lines = transcript
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const entries = lines
    .map((line) => parseTranscriptLine(line))
    .filter((entry): entry is Record<string, any> => entry !== null);

  let lastUserIndex = -1;
  for (let index = 0; index < entries.length; index += 1) {
    if (isUserMessage(entries[index])) {
      lastUserIndex = index;
    }
  }

  const messages: string[] = [];
  for (let index = lastUserIndex + 1; index < entries.length; index += 1) {
    const message = extractAssistantMessage(entries[index]);
    if (!message) {
      continue;
    }
    if (messages[messages.length - 1] === message) {
      continue;
    }
    messages.push(message);
  }

  return messages.length > 0 ? messages.join('\n\n') : null;
}

function parseTranscriptLine(line: string): Record<string, any> | null {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function isUserMessage(entry: Record<string, any>): boolean {
  return (
    entry.type === 'response_item' &&
    entry.payload?.type === 'message' &&
    entry.payload?.role === 'user'
  );
}

function extractAssistantMessage(entry: Record<string, any>): string | null {
  if (
    entry.type === 'event_msg' &&
    entry.payload?.type === 'agent_message' &&
    ASSISTANT_PHASES.has(entry.payload?.phase) &&
    typeof entry.payload?.message === 'string'
  ) {
    return normalizeMessage(entry.payload.message);
  }

  if (
    entry.type === 'response_item' &&
    entry.payload?.type === 'message' &&
    entry.payload?.role === 'assistant' &&
    ASSISTANT_PHASES.has(entry.payload?.phase)
  ) {
    const text = (entry.payload.content ?? [])
      .filter((item: any) => item?.type === 'output_text' && typeof item?.text === 'string')
      .map((item: any) => item.text)
      .join('\n');
    return normalizeMessage(text);
  }

  return null;
}

function normalizeMessage(text: string): string | null {
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : null;
}
