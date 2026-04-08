import { describe, expect, it } from 'vitest';
import net from 'net';
import { allocateAvailableLocalEndpoint } from '../src/local-app-server-endpoint.js';

describe('allocateAvailableLocalEndpoint', () => {
  it('returns the base endpoint when the port is free', async () => {
    const endpoint = await allocateAvailableLocalEndpoint('ws://127.0.0.1:8896');
    expect(endpoint).toBe('ws://127.0.0.1:8896');
  });

  it('skips ports that are already in use', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(8897, '127.0.0.1', () => resolve());
    });

    try {
      const endpoint = await allocateAvailableLocalEndpoint('ws://127.0.0.1:8897');
      expect(endpoint).toBe('ws://127.0.0.1:8898');
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});
