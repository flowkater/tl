import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { loadConfig, saveConfig, getConfigDir } from '../src/config.js';
import { TlError } from '../src/errors.js';

function makeTestDir(): string {
  return path.join(os.tmpdir(), `tl-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

describe('config', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = makeTestDir();
    process.env.TL_CONFIG_DIR = testDir;
  });

  afterEach(() => {
    delete process.env.TL_CONFIG_DIR;
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('loadConfig', () => {
    it('throws if botToken is missing', () => {
      fs.mkdirSync(testDir, { recursive: true });
      fs.writeFileSync(path.join(testDir, 'config.json'), JSON.stringify({}));

      expect(() => loadConfig()).toThrow(TlError);
    });

    it('throws if groupId is missing', () => {
      fs.mkdirSync(testDir, { recursive: true });
      fs.writeFileSync(
        path.join(testDir, 'config.json'),
        JSON.stringify({ botToken: 'test-123' })
      );

      expect(() => loadConfig()).toThrow(TlError);
    });

    it('loads valid config with defaults', () => {
      fs.mkdirSync(testDir, { recursive: true });
      fs.writeFileSync(
        path.join(testDir, 'config.json'),
        JSON.stringify({ botToken: 'tok', groupId: -100123 })
      );

      const config = loadConfig();
      expect(config.botToken).toBe('tok');
      expect(config.groupId).toBe(-100123);
      expect(config.hookPort).toBe(9877);
      expect(config.stopTimeout).toBe(7200);
      expect(config.liveStream).toBe(false);
      expect(config.emojiReaction).toBe('👍');
      expect(config.hookBaseUrl).toBe('http://localhost:9877');
    });

    it('overrides defaults with file values', () => {
      fs.mkdirSync(testDir, { recursive: true });
      fs.writeFileSync(
        path.join(testDir, 'config.json'),
        JSON.stringify({
          botToken: 'tok',
          groupId: -100123,
          hookPort: 8080,
          stopTimeout: 1800,
          liveStream: true,
          emojiReaction: '🔥',
          hookBaseUrl: 'http://example.com:8080',
        })
      );

      const config = loadConfig();
      expect(config.hookPort).toBe(8080);
      expect(config.stopTimeout).toBe(1800);
      expect(config.liveStream).toBe(true);
      expect(config.emojiReaction).toBe('🔥');
      expect(config.hookBaseUrl).toBe('http://example.com:8080');
    });

    it('throws on invalid JSON', () => {
      fs.mkdirSync(testDir, { recursive: true });
      fs.writeFileSync(path.join(testDir, 'config.json'), 'NOT JSON');

      expect(() => loadConfig()).toThrow(TlError);
    });

    it('throws if numeric fields are invalid', () => {
      fs.mkdirSync(testDir, { recursive: true });
      fs.writeFileSync(
        path.join(testDir, 'config.json'),
        JSON.stringify({
          botToken: 'tok',
          groupId: -100123,
          hookPort: 'bad-port',
          stopTimeout: -1,
        })
      );

      expect(() => loadConfig()).toThrow(TlError);
    });

    it('throws if boolean fields are invalid', () => {
      fs.mkdirSync(testDir, { recursive: true });
      fs.writeFileSync(
        path.join(testDir, 'config.json'),
        JSON.stringify({
          botToken: 'tok',
          groupId: -100123,
          liveStream: 'sometimes',
        })
      );

      expect(() => loadConfig()).toThrow(TlError);
    });
  });

  describe('saveConfig', () => {
    it('saves config and can be reloaded', () => {
      saveConfig({ botToken: 'tok', groupId: -100123 });

      const configPath = path.join(testDir, 'config.json');
      expect(fs.existsSync(configPath)).toBe(true);

      const saved = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      expect(saved.botToken).toBe('tok');
      expect(saved.groupId).toBe(-100123);
    });

    it('merges with existing config', () => {
      saveConfig({ botToken: 'tok', groupId: -100123, hookPort: 9999 });
      saveConfig({ liveStream: true });

      const saved = JSON.parse(
        fs.readFileSync(path.join(testDir, 'config.json'), 'utf-8')
      );
      expect(saved.hookPort).toBe(9999);
      expect(saved.liveStream).toBe(true);
      expect(saved.botToken).toBe('tok');
    });
  });

  describe('getConfigDir', () => {
    it('returns env override if set', () => {
      expect(getConfigDir()).toBe(testDir);
    });

    it('returns ~/.tl by default', () => {
      delete process.env.TL_CONFIG_DIR;
      expect(getConfigDir()).toBe(path.join(os.homedir(), '.tl'));
    });
  });
});
