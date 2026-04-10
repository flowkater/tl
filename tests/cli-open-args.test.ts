import { describe, expect, it } from 'vitest';
import { parseOpenArgs } from '../src/open-command-args.js';

describe('parseOpenArgs', () => {
  it('rejects a positional session id and points to the managed open commands', () => {
    expect(() =>
      parseOpenArgs(['019d6bd0-1437-7f72-88ef-24f7952a159c'], '/tmp/tl')
    ).toThrowError(/tl local open <session_id>/);
    expect(() =>
      parseOpenArgs(['019d6bd0-1437-7f72-88ef-24f7952a159c'], '/tmp/tl')
    ).toThrowError(/tl remote open <session_id>/);
  });
});
