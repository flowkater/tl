import { describe, expect, it, vi } from 'vitest';
import { AppServerLocalInputTransport } from '../src/local-input-transport.js';

describe('AppServerLocalInputTransport', () => {
  it('injects text into an attached local session through app-server', async () => {
    const client = {
      injectLocalInput: vi.fn().mockResolvedValue({ mode: 'start', turnId: 'turn-1' }),
    };
    const transport = new AppServerLocalInputTransport(client as any);

    await transport.inject(
      's1',
      { attachmentId: 'thread-1', endpoint: 'ws://127.0.0.1:8899' },
      'telegram',
      'continue from telegram'
    );

    expect(client.injectLocalInput).toHaveBeenCalledWith({
      endpoint: 'ws://127.0.0.1:8899',
      threadId: 'thread-1',
      text: 'continue from telegram',
    });
  });
});
