import { describe, expect, it } from 'vitest';
import { serializeStopHookOutput } from '../src/stop-hook-output.js';

describe('serializeStopHookOutput', () => {
  it('emits block JSON when a Telegram reply should continue Codex', () => {
    expect(
      serializeStopHookOutput({ decision: 'block', reason: 'keep going' })
    ).toBe('{"decision":"block","reason":"keep going"}');
  });

  it('emits no stdout for normal completion paths', () => {
    expect(serializeStopHookOutput({ decision: 'continue' })).toBeNull();
  });

  it('maps explicit stop to Codex stop fields', () => {
    expect(
      serializeStopHookOutput({ decision: 'stop', text: 'stop here' })
    ).toBe('{"continue":false,"stopReason":"stop here"}');
  });
});
