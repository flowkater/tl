import { describe, expect, it, vi } from 'vitest';
import { createTlMcpTools } from '../src/tl-mcp-tools.js';
import { TlError } from '../src/errors.js';

describe('createTlMcpTools', () => {
  it('lists the expected tools', () => {
    const tools = createTlMcpTools({
      runTlCommand: vi.fn(),
    });

    expect(tools.definitions.map((tool) => tool.name)).toEqual([
      'tl_status',
      'tl_list_sessions',
      'tl_resume_session',
      'tl_start_daemon',
      'tl_stop_daemon',
      'tl_get_config',
      'tl_set_config',
    ]);
  });

  it('validates tl_set_config keys and forwards allowed writes to tl config set', async () => {
    const runner = vi.fn().mockResolvedValue({
      code: 0,
      stdout: 'Config saved\n',
      stderr: '',
    });

    const tools = createTlMcpTools({ runTlCommand: runner });
    await tools.call('tl_set_config', {
      values: {
        groupId: -1001234567890,
        stopTimeout: 7200,
        liveStream: false,
        localCodexEndpoint: 'ws://127.0.0.1:8795',
      },
    });

    expect(runner).toHaveBeenCalledWith([
      'config',
      'set',
      'groupId=-1001234567890',
      'stopTimeout=7200',
      'liveStream=false',
      'localCodexEndpoint=ws://127.0.0.1:8795',
    ]);
  });

  it('rejects unknown config keys', async () => {
    const tools = createTlMcpTools({
      runTlCommand: vi.fn(),
    });

    await expect(
      tools.call('tl_set_config', {
        values: {
          unexpected: 'value',
        },
      })
    ).rejects.toThrow(TlError);
  });

  it('passes session filter to tl sessions', async () => {
    const runner = vi.fn().mockResolvedValue({
      code: 0,
      stdout: 'Sessions...\n',
      stderr: '',
    });
    const tools = createTlMcpTools({ runTlCommand: runner });

    await tools.call('tl_list_sessions', { status: 'waiting' });

    expect(runner).toHaveBeenCalledWith(['sessions', 'waiting']);
  });

  it('requires a session id for tl_resume_session', async () => {
    const tools = createTlMcpTools({
      runTlCommand: vi.fn(),
    });

    await expect(tools.call('tl_resume_session', {})).rejects.toThrow(TlError);
  });
});
