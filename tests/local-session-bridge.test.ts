import { describe, expect, it, vi } from 'vitest';
import { LocalSessionBridge } from '../src/local-session-bridge.js';

describe('LocalSessionBridge', () => {
  it('delivers telegram and console inputs in FIFO order for the same session', async () => {
    const transport = {
      inject: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined),
    };
    const bridge = new LocalSessionBridge(transport);

    bridge.attach('s1', { attachmentId: 'a1' });
    await bridge.enqueue('s1', 'telegram', 'first');
    await bridge.enqueue('s1', 'console', 'second');

    expect(transport.inject.mock.calls).toEqual([
      ['s1', { attachmentId: 'a1' }, 'telegram', 'first'],
      ['s1', { attachmentId: 'a1' }, 'console', 'second'],
    ]);
    expect(bridge.getQueueDepth('s1')).toBe(0);
  });

  it('marks the session detached when injection fails', async () => {
    const transport = {
      inject: vi.fn().mockRejectedValue(new Error('broken pipe')),
    };
    const bridge = new LocalSessionBridge(transport);

    bridge.attach('s1', { attachmentId: 'a1' });
    await bridge.enqueue('s1', 'telegram', 'resume work');

    expect(bridge.getAttachmentState('s1')).toBe('detached');
    expect(bridge.getQueueDepth('s1')).toBe(0);
  });
});
