import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { TlError } from './errors.js';

const PLUGIN_NAME = 'tl-tools';
const MARKETPLACE_NAME = 'local';
const MARKETPLACE_DISPLAY_NAME = 'Local Plugins';

interface PluginInstallerOptions {
  homeDir?: string;
  pluginSourceDir?: string;
  nodeBinary?: string;
  cliScriptPath?: string;
  mcpServerPath?: string;
}

export interface PluginInstallResult {
  pluginPath: string;
  marketplacePath: string;
}

export interface PluginStatus extends PluginInstallResult {
  installed: boolean;
  pluginManifestExists: boolean;
  mcpConfigExists: boolean;
  marketplaceRegistered: boolean;
}

function getProjectRoot(): string {
  const currentFile = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(currentFile), '..');
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
}

function renderTemplate(value: unknown, replacements: Record<string, string>): unknown {
  if (typeof value === 'string') {
    let rendered = value;
    for (const [needle, replacement] of Object.entries(replacements)) {
      rendered = rendered.split(needle).join(replacement);
    }
    return rendered;
  }

  if (Array.isArray(value)) {
    return value.map((item) => renderTemplate(item, replacements));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, renderTemplate(nested, replacements)])
    );
  }

  return value;
}

export class PluginInstaller {
  private readonly homeDir: string;
  private readonly pluginSourceDir: string;
  private readonly nodeBinary: string;
  private readonly cliScriptPath: string;
  private readonly mcpServerPath: string;

  constructor(options: PluginInstallerOptions = {}) {
    const projectRoot = getProjectRoot();
    this.homeDir = options.homeDir || os.homedir();
    this.pluginSourceDir =
      options.pluginSourceDir || path.join(projectRoot, 'plugins', PLUGIN_NAME);
    this.nodeBinary = options.nodeBinary || process.execPath;
    this.cliScriptPath =
      options.cliScriptPath || path.join(projectRoot, 'dist', 'cli.js');
    this.mcpServerPath =
      options.mcpServerPath || path.join(projectRoot, 'dist', 'tl-mcp-server.js');
  }

  async install(): Promise<PluginInstallResult> {
    this.validateSourceFiles();

    const pluginPath = this.getPluginPath();
    fs.mkdirSync(path.dirname(pluginPath), { recursive: true });
    fs.cpSync(this.pluginSourceDir, pluginPath, { recursive: true, force: true });

    const mcpConfig = this.renderMcpConfig();
    fs.writeFileSync(
      path.join(pluginPath, '.mcp.json'),
      JSON.stringify(mcpConfig, null, 2),
      'utf-8'
    );

    const marketplacePath = this.getMarketplacePath();
    fs.mkdirSync(path.dirname(marketplacePath), { recursive: true });
    const marketplace = this.readMarketplace();
    const entry = {
      name: PLUGIN_NAME,
      source: {
        source: 'local',
        path: `./plugins/${PLUGIN_NAME}`,
      },
      policy: {
        installation: 'AVAILABLE',
        authentication: 'ON_INSTALL',
      },
      category: 'Productivity',
    };
    const existingIndex = marketplace.plugins.findIndex((item) => item.name === PLUGIN_NAME);
    if (existingIndex >= 0) {
      marketplace.plugins[existingIndex] = entry;
    } else {
      marketplace.plugins.push(entry);
    }
    fs.writeFileSync(marketplacePath, JSON.stringify(marketplace, null, 2), 'utf-8');

    return {
      pluginPath,
      marketplacePath,
    };
  }

  async status(): Promise<PluginStatus> {
    const pluginPath = this.getPluginPath();
    const marketplacePath = this.getMarketplacePath();
    const pluginManifestExists = fs.existsSync(
      path.join(pluginPath, '.codex-plugin', 'plugin.json')
    );
    const mcpConfigExists = fs.existsSync(path.join(pluginPath, '.mcp.json'));
    const marketplaceRegistered = fs.existsSync(marketplacePath)
      ? (readJson<{ plugins?: Array<{ name?: string }> }>(marketplacePath).plugins || []).some(
          (item) => item.name === PLUGIN_NAME
        )
      : false;

    return {
      pluginPath,
      marketplacePath,
      installed: pluginManifestExists && mcpConfigExists && marketplaceRegistered,
      pluginManifestExists,
      mcpConfigExists,
      marketplaceRegistered,
    };
  }

  private getPluginPath(): string {
    return path.join(this.homeDir, 'plugins', PLUGIN_NAME);
  }

  private getMarketplacePath(): string {
    return path.join(this.homeDir, '.agents', 'plugins', 'marketplace.json');
  }

  private validateSourceFiles(): void {
    const pluginManifestPath = path.join(this.pluginSourceDir, '.codex-plugin', 'plugin.json');
    const mcpTemplatePath = path.join(this.pluginSourceDir, '.mcp.json.template');
    if (!fs.existsSync(pluginManifestPath)) {
      throw new TlError(`Plugin manifest not found: ${pluginManifestPath}`, 'CONFIG_INVALID');
    }
    if (!fs.existsSync(mcpTemplatePath)) {
      throw new TlError(`Plugin MCP template not found: ${mcpTemplatePath}`, 'CONFIG_INVALID');
    }
    if (!fs.existsSync(this.cliScriptPath)) {
      throw new TlError(`TL CLI script not found: ${this.cliScriptPath}`, 'CONFIG_INVALID');
    }
    if (!fs.existsSync(this.mcpServerPath)) {
      throw new TlError(`TL MCP server not found: ${this.mcpServerPath}`, 'CONFIG_INVALID');
    }
  }

  private renderMcpConfig(): unknown {
    const template = readJson<unknown>(path.join(this.pluginSourceDir, '.mcp.json.template'));
    return renderTemplate(template, {
      __NODE_BINARY__: this.nodeBinary,
      __MCP_SERVER_PATH__: this.mcpServerPath,
      __TL_CLI_JS__: this.cliScriptPath,
    });
  }

  private readMarketplace(): {
    name: string;
    interface: { displayName: string };
    plugins: Array<Record<string, unknown>>;
  } {
    const marketplacePath = this.getMarketplacePath();
    if (!fs.existsSync(marketplacePath)) {
      return {
        name: MARKETPLACE_NAME,
        interface: {
          displayName: MARKETPLACE_DISPLAY_NAME,
        },
        plugins: [],
      };
    }

    const marketplace = readJson<{
      name?: string;
      interface?: { displayName?: string };
      plugins?: Array<Record<string, unknown>>;
    }>(marketplacePath);

    return {
      name: marketplace.name || MARKETPLACE_NAME,
      interface: {
        displayName:
          marketplace.interface?.displayName || MARKETPLACE_DISPLAY_NAME,
      },
      plugins: marketplace.plugins || [],
    };
  }
}
