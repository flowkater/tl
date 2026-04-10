import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { TopicPreferencesStore } from '../src/topic-preferences-store.js';

function makeTestDir(): string {
  return path.join(os.tmpdir(), `tl-topic-prefs-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

describe('TopicPreferencesStore', () => {
  let store: TopicPreferencesStore;
  let testDir: string;

  beforeEach(() => {
    testDir = makeTestDir();
    process.env.TL_DATA_DIR = testDir;
    store = new TopicPreferencesStore();
  });

  afterEach(() => {
    delete process.env.TL_DATA_DIR;
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('creates the data directory and persists topic preferences atomically', async () => {
    await store.load();
    store.set('-1001234567890:727', {
      skill: ['systematic-debugging'],
      cmd: ['/compact'],
      model: 'gpt-5.4',
      'approval-policy': 'never',
      sandbox: 'danger-full-access',
      cwd: '/Users/flowkater/Projects/TL',
      updated_at: '2026-04-10T12:00:00.000Z',
    });
    await store.save();

    expect(fs.existsSync(testDir)).toBe(true);
    const persisted = JSON.parse(fs.readFileSync(path.join(testDir, 'topic-preferences.json'), 'utf-8'));
    expect(persisted.version).toBe(1);
    expect(persisted.topics['-1001234567890:727']).toMatchObject({
      skill: ['systematic-debugging'],
      cmd: ['/compact'],
      model: 'gpt-5.4',
      'approval-policy': 'never',
      sandbox: 'danger-full-access',
      cwd: '/Users/flowkater/Projects/TL',
      updated_at: '2026-04-10T12:00:00.000Z',
    });

    const reloaded = new TopicPreferencesStore();
    await reloaded.load();
    expect(reloaded.get('-1001234567890:727')).toMatchObject({
      skill: ['systematic-debugging'],
      cmd: ['/compact'],
      model: 'gpt-5.4',
      'approval-policy': 'never',
      sandbox: 'danger-full-access',
      cwd: '/Users/flowkater/Projects/TL',
    });
  });

  it('clears fields and removes empty topic records', async () => {
    await store.load();
    store.set('-1001234567890:727', {
      skill: ['systematic-debugging'],
      cmd: ['/compact'],
      model: 'gpt-5.4',
      updated_at: '2026-04-10T12:00:00.000Z',
    });

    store.clearField('-1001234567890:727', 'skill');
    expect(store.get('-1001234567890:727')).toMatchObject({
      cmd: ['/compact'],
      model: 'gpt-5.4',
    });

    store.clearField('-1001234567890:727', 'cmd');
    store.clearField('-1001234567890:727', 'model');
    expect(store.get('-1001234567890:727')).toBeUndefined();
  });

  it('merges partial updates without dropping unrelated saved fields', async () => {
    await store.load();
    store.set('-1001234567890:727', {
      skill: ['systematic-debugging'],
      cmd: ['/compact'],
      model: 'gpt-5.4',
      'approval-policy': 'on-request',
      sandbox: 'workspace-write',
      cwd: '/Users/flowkater/Projects/TL',
      updated_at: '2026-04-10T12:00:00.000Z',
    });

    store.set('-1001234567890:727', {
      skill: ['swift-concurrency-expert'],
      updated_at: '2026-04-10T12:05:00.000Z',
    });

    expect(store.get('-1001234567890:727')).toMatchObject({
      skill: ['swift-concurrency-expert'],
      cmd: ['/compact'],
      model: 'gpt-5.4',
      'approval-policy': 'on-request',
      sandbox: 'workspace-write',
      cwd: '/Users/flowkater/Projects/TL',
      updated_at: '2026-04-10T12:05:00.000Z',
    });
  });

  it('falls back to the backup file when the primary file is corrupted', async () => {
    fs.mkdirSync(testDir, { recursive: true });
    const primaryPath = path.join(testDir, 'topic-preferences.json');
    const backupPath = `${primaryPath}.bak`;

    fs.writeFileSync(primaryPath, 'NOT JSON');
    fs.writeFileSync(backupPath, JSON.stringify({
      version: 1,
      topics: {
        '-1001234567890:727': {
          skill: ['systematic-debugging'],
          updated_at: '2026-04-10T12:00:00.000Z',
        },
      },
    }));

    await store.load();
    expect(store.get('-1001234567890:727')).toMatchObject({
      skill: ['systematic-debugging'],
    });
  });

  it('ignores invalid persisted preferences during load', async () => {
    fs.mkdirSync(testDir, { recursive: true });
    const primaryPath = path.join(testDir, 'topic-preferences.json');

    fs.writeFileSync(primaryPath, JSON.stringify({
      version: 1,
      topics: {
        '-1001234567890:727': {
          skill: ['systematic-debugging'],
          cmd: ['not-a-command'],
          'approval-policy': 'bogus',
          sandbox: 'bogus',
          updated_at: '2026-04-10T12:00:00.000Z',
        },
        '-1001234567890:727b': {
          skill: ['two words'],
          cmd: ['/compact'],
          updated_at: '2026-04-10T12:00:00.000Z',
        },
        '-1001234567890:728': {
          skill: ['systematic-debugging'],
          cmd: ['/compact'],
          model: 'gpt-5.4',
          updated_at: '2026-04-10T12:00:00.000Z',
        },
      },
    }));

    await store.load();
    expect(store.get('-1001234567890:727')).toBeUndefined();
    expect(store.get('-1001234567890:727b')).toBeUndefined();
    expect(store.get('-1001234567890:728')).toMatchObject({
      skill: ['systematic-debugging'],
      cmd: ['/compact'],
      model: 'gpt-5.4',
    });
  });

  it('returns defensive copies so caller mutations do not persist invalid values', async () => {
    await store.load();
    store.set('-1001234567890:727', {
      skill: ['systematic-debugging'],
      cmd: ['/compact'],
      model: 'gpt-5.4',
      updated_at: '2026-04-10T12:00:00.000Z',
    });

    const fromGet = store.get('-1001234567890:727');
    expect(fromGet).toBeDefined();
    fromGet!.cmd?.push('bad');
    fromGet!.skill?.push('mutated skill');

    const fromList = store.list()[0]?.preferences;
    expect(fromList).toBeDefined();
    fromList!.cmd?.push('bad');

    await store.save();

    const persisted = JSON.parse(fs.readFileSync(path.join(testDir, 'topic-preferences.json'), 'utf-8'));
    expect(persisted.topics['-1001234567890:727']).toMatchObject({
      skill: ['systematic-debugging'],
      cmd: ['/compact'],
      model: 'gpt-5.4',
    });
    expect(store.get('-1001234567890:727')).toMatchObject({
      skill: ['systematic-debugging'],
      cmd: ['/compact'],
      model: 'gpt-5.4',
    });

    const afterSave = store.get('-1001234567890:727');
    afterSave!.cmd?.push('bad');
    expect(store.get('-1001234567890:727')).toMatchObject({
      cmd: ['/compact'],
    });
  });
});
