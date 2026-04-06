import { describe, expect, it } from 'vitest';
import {
  discoverRemoteEndpointFromProcessTree,
  extractRemoteEndpointFromCommand,
  parsePsOutput,
} from '../src/remote-endpoint-discovery.js';

describe('remote endpoint discovery', () => {
  it('extracts a remote endpoint from separated CLI args', () => {
    expect(
      extractRemoteEndpointFromCommand(
        'codex --remote ws://127.0.0.1:8795 --dangerously-bypass-approvals-and-sandbox'
      )
    ).toBe('ws://127.0.0.1:8795');
  });

  it('extracts a remote endpoint from inline CLI args', () => {
    expect(
      extractRemoteEndpointFromCommand(
        'codex --remote=ws://127.0.0.1:8795 --dangerously-bypass-approvals-and-sandbox'
      )
    ).toBe('ws://127.0.0.1:8795');
  });

  it('walks parent processes to discover the codex remote endpoint', () => {
    const psOutput = [
      '4109 87286 tl hook-session-start',
      '87286 87642 /Users/flowkater/.bun/install/global/node_modules/@openai/codex/codex --remote ws://127.0.0.1:8795 --dangerously-bypass-approvals-and-sandbox',
      '87642 1 node /Users/flowkater/.bun/bin/codex --remote ws://127.0.0.1:8795 --dangerously-bypass-approvals-and-sandbox',
    ].join('\n');

    expect(
      discoverRemoteEndpointFromProcessTree({
        startPid: 4109,
        psOutput,
      })
    ).toBe('ws://127.0.0.1:8795');
  });

  it('parses ps output into a pid table', () => {
    const table = parsePsOutput('10 1 codex --remote ws://127.0.0.1:8795');
    expect(table.get(10)).toMatchObject({
      pid: 10,
      ppid: 1,
      command: 'codex --remote ws://127.0.0.1:8795',
    });
  });
});
