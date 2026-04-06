import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PluginInstaller } from '../src/plugin-installer.js';

function makeTestDir(): string {
  return path.join(
    os.tmpdir(),
    `tl-plugin-installer-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

function readJson(filePath: string) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

describe('PluginInstaller', () => {
  let testDir: string;
  let pluginSourceDir: string;

  beforeEach(() => {
    testDir = makeTestDir();
    pluginSourceDir = path.join(testDir, 'plugin-source');
    const distDir = path.join(testDir, 'dist');
    fs.mkdirSync(path.join(pluginSourceDir, '.codex-plugin'), { recursive: true });
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginSourceDir, '.codex-plugin', 'plugin.json'),
      JSON.stringify({
        name: 'tl-tools',
        version: '0.1.0',
      }),
      'utf-8'
    );
    fs.writeFileSync(
      path.join(pluginSourceDir, '.mcp.json.template'),
      JSON.stringify({
        mcpServers: {
          'tl-tools': {
            type: 'stdio',
            command: '__NODE_BINARY__',
            args: ['__MCP_SERVER_PATH__'],
            env: {
              TL_PLUGIN_TL_CLI_JS: '__TL_CLI_JS__',
            },
          },
        },
      }),
      'utf-8'
    );
    fs.writeFileSync(path.join(distDir, 'cli.js'), 'console.log("cli");\n', 'utf-8');
    fs.writeFileSync(
      path.join(distDir, 'tl-mcp-server.js'),
      'console.log("mcp");\n',
      'utf-8'
    );
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('installs tl-tools plugin into ~/plugins and registers marketplace entry', async () => {
    const installer = new PluginInstaller({
      homeDir: testDir,
      pluginSourceDir,
      nodeBinary: '/usr/local/bin/node',
      cliScriptPath: path.join(testDir, 'dist', 'cli.js'),
      mcpServerPath: path.join(testDir, 'dist', 'tl-mcp-server.js'),
    });

    const result = await installer.install();

    expect(result.pluginPath).toBe(path.join(testDir, 'plugins', 'tl-tools'));
    expect(fs.existsSync(path.join(result.pluginPath, '.codex-plugin', 'plugin.json'))).toBe(true);
    expect(readJson(path.join(result.pluginPath, '.mcp.json'))).toEqual({
      mcpServers: {
        'tl-tools': {
          type: 'stdio',
          command: '/usr/local/bin/node',
          args: [path.join(testDir, 'dist', 'tl-mcp-server.js')],
          env: {
            TL_PLUGIN_TL_CLI_JS: path.join(testDir, 'dist', 'cli.js'),
          },
        },
      },
    });

    expect(readJson(path.join(testDir, '.agents/plugins/marketplace.json'))).toEqual({
      name: 'local',
      interface: {
        displayName: 'Local Plugins',
      },
      plugins: [
        {
          name: 'tl-tools',
          source: {
            source: 'local',
            path: './plugins/tl-tools',
          },
          policy: {
            installation: 'AVAILABLE',
            authentication: 'ON_INSTALL',
          },
          category: 'Productivity',
        },
      ],
    });
  });

  it('reports installed status when plugin files and marketplace entry exist', async () => {
    const installer = new PluginInstaller({
      homeDir: testDir,
      pluginSourceDir,
      nodeBinary: '/usr/local/bin/node',
      cliScriptPath: path.join(testDir, 'dist', 'cli.js'),
      mcpServerPath: path.join(testDir, 'dist', 'tl-mcp-server.js'),
    });

    await installer.install();
    const status = await installer.status();

    expect(status.installed).toBe(true);
    expect(status.pluginPath).toBe(path.join(testDir, 'plugins', 'tl-tools'));
    expect(status.marketplaceRegistered).toBe(true);
    expect(status.mcpConfigExists).toBe(true);
  });
});
