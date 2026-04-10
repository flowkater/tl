import { describe, expect, it } from 'vitest';
import {
  compileDirectivePrompt,
  parseTelegramControlCommand,
  parseTelegramDirectiveMessage,
} from '../src/telegram-directives.js';

describe('parseTelegramControlCommand', () => {
  it('parses help, status, resume, and show config', () => {
    expect(parseTelegramControlCommand('/tl help')).toEqual({ kind: 'help' });
    expect(parseTelegramControlCommand('/tl status')).toEqual({ kind: 'status' });
    expect(parseTelegramControlCommand('/tl resume')).toEqual({ kind: 'resume' });
    expect(parseTelegramControlCommand('/tl show config')).toEqual({ kind: 'showConfig' });
  });

  it('parses list and scalar set commands with strict validation', () => {
    expect(
      parseTelegramControlCommand('/tl set skill systematic-debugging, swift-concurrency-expert')
    ).toEqual({
      kind: 'set',
      field: 'skill',
      value: ['systematic-debugging', 'swift-concurrency-expert'],
    });

    expect(parseTelegramControlCommand('/tl set cmd /compact, /no-tools')).toEqual({
      kind: 'set',
      field: 'cmd',
      value: ['/compact', '/no-tools'],
    });

    expect(parseTelegramControlCommand('/tl set model gpt-5.4')).toEqual({
      kind: 'set',
      field: 'model',
      value: 'gpt-5.4',
    });
  });

  it('treats none as clear for skill and cmd only', () => {
    expect(parseTelegramControlCommand('/tl set skill none')).toEqual({
      kind: 'set',
      field: 'skill',
      value: [],
    });
    expect(parseTelegramControlCommand('/tl set cmd none')).toEqual({
      kind: 'set',
      field: 'cmd',
      value: [],
    });
    expect(() => parseTelegramControlCommand('/tl set model none')).toThrowError(
      /none only clears skill and cmd/i
    );
  });

  it('rejects unknown fields and values', () => {
    expect(() => parseTelegramControlCommand('/tl set foo bar')).toThrowError(/unknown directive field/i);
    expect(() => parseTelegramControlCommand('/tl clear foo')).toThrowError(/unknown directive field/i);
    expect(() => parseTelegramControlCommand('/tl set sandbox totally-made-up')).toThrowError(
      /unknown sandbox value/i
    );
    expect(() => parseTelegramControlCommand('/tl set approval-policy maybe')).toThrowError(
      /unknown approval-policy value/i
    );
  });
});

describe('parseTelegramDirectiveMessage', () => {
  it('treats arbitrary @-prefixed text as plain body unless the first line is a directive header', () => {
    expect(parseTelegramDirectiveMessage('@alice please review this\nthanks')).toEqual({
      body: '@alice please review this\nthanks',
      directives: {},
    });
  });

  it('parses repeated and comma-separated directive headers', () => {
    expect(
      parseTelegramDirectiveMessage(
        '@skill: systematic-debugging\n@skill: swift-concurrency-expert\n@cmd: /compact\n@cmd: /no-tools, /trace\n@model: gpt-5.4\n@approval-policy: never\n@sandbox: danger-full-access\n@cwd: /Users/flowkater/Projects/TL\n\nInvestigate this crash'
      )
    ).toEqual({
      body: 'Investigate this crash',
      directives: {
        skill: ['systematic-debugging', 'swift-concurrency-expert'],
        cmd: ['/compact', '/no-tools', '/trace'],
        model: 'gpt-5.4',
        'approval-policy': 'never',
        sandbox: 'danger-full-access',
        cwd: '/Users/flowkater/Projects/TL',
      },
    });
  });

  it('treats none as clear for skill and cmd', () => {
    expect(
      parseTelegramDirectiveMessage('@skill: none\n@cmd: none\n\nJust answer plainly')
    ).toEqual({
      body: 'Just answer plainly',
      directives: {
        skill: [],
        cmd: [],
      },
    });
  });

  it('rejects unknown header keys and invalid scalar values', () => {
    expect(() => parseTelegramDirectiveMessage('@foo: bar\n\nBody')).toThrowError(
      /unknown directive header/i
    );
    expect(() => parseTelegramDirectiveMessage('@model: none\n\nBody')).toThrowError(
      /none only clears skill and cmd/i
    );
  });
});

describe('compileDirectivePrompt', () => {
  it('prepends cmd lines and a TL directives block for skills', () => {
    expect(
      compileDirectivePrompt({
        body: 'Investigate this crash',
        directives: {
          skill: ['systematic-debugging', 'swift-concurrency-expert'],
          cmd: ['/compact', '/no-tools', '/trace'],
        },
      })
    ).toBe(
      '/compact\n/no-tools\n/trace\n\n[TL directives]\n\nUse these skills for this turn: systematic-debugging, swift-concurrency-expert\n\n[/TL directives]\n\nInvestigate this crash'
    );
  });

  it('returns the body unchanged when no immediate directives are present', () => {
    expect(
      compileDirectivePrompt({
        body: 'Just answer plainly',
        directives: {},
      })
    ).toBe('Just answer plainly');
  });
});
