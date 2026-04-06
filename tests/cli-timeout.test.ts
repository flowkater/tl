import { describe, it, expect } from 'vitest';
import fs from 'fs';

describe('cli timeout defaults', () => {
  it('uses 7200 seconds as the stop timeout default in setup and stop hook paths', () => {
    const source = fs.readFileSync(
      new URL('../src/cli.ts', import.meta.url),
      'utf-8'
    );
    const hookTemplate = fs.readFileSync(
      new URL('../templates/hooks.json', import.meta.url),
      'utf-8'
    );

    expect(source).toContain('existing.stopTimeout ?? 7200');
    expect(source).toContain('기본 7200=2시간');
    expect(source).toContain('let stopTimeout = 7200;');
    expect(source).toContain('config.stopTimeout || 7200');
    expect(hookTemplate).toContain('"timeout": 7200');
  });
});
