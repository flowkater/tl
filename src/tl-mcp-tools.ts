import { spawn } from 'child_process';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { TlError } from './errors.js';

const ALLOWED_SESSION_FILTERS = new Set(['active', 'waiting', 'completed']);
const ALLOWED_CONFIG_KEYS = new Set([
  'botToken',
  'groupId',
  'topicPrefix',
  'hookPort',
  'hookBaseUrl',
  'stopTimeout',
  'liveStream',
  'emojiReaction',
  'localCodexEndpoint',
]);

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

type ToolResult = CallToolResult;

interface TlMcpToolDeps {
  runTlCommand: (args: string[]) => Promise<CommandResult>;
}

function toToolResult(stdout: string, stderr = ''): ToolResult {
  const text = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
  return {
    content: [
      {
        type: 'text',
        text: text || 'OK',
      },
    ],
  };
}

function validateString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TlError(`${name} must be a non-empty string`, 'CONFIG_INVALID');
  }
  return value;
}

async function runAndFormat(
  runner: TlMcpToolDeps['runTlCommand'],
  args: string[]
): Promise<ToolResult> {
  const result = await runner(args);
  if (result.code !== 0) {
    throw new Error([result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n'));
  }
  return toToolResult(result.stdout, result.stderr);
}

export function createTlMcpTools(deps: TlMcpToolDeps) {
  const definitions: ToolDefinition[] = [
    {
      name: 'tl_status',
      description: 'Show TL daemon status and active or waiting session counts.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'tl_list_sessions',
      description: 'List TL sessions, optionally filtered by status.',
      inputSchema: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['active', 'waiting', 'completed'],
          },
        },
      },
    },
    {
      name: 'tl_resume_session',
      description: 'Resume a waiting TL session by id.',
      inputSchema: {
        type: 'object',
        required: ['sessionId'],
        properties: {
          sessionId: {
            type: 'string',
          },
        },
      },
    },
    {
      name: 'tl_start_daemon',
      description: 'Start the TL daemon.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'tl_stop_daemon',
      description: 'Stop the TL daemon.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'tl_get_config',
      description: 'Read TL config.json or a single TL config key.',
      inputSchema: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
          },
        },
      },
    },
    {
      name: 'tl_set_config',
      description: 'Write allowlisted TL config keys safely.',
      inputSchema: {
        type: 'object',
        required: ['values'],
        properties: {
          values: {
            type: 'object',
            additionalProperties: true,
          },
        },
      },
    },
  ];

  return {
    definitions,
    async call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
      switch (name) {
        case 'tl_status':
          return runAndFormat(deps.runTlCommand, ['status']);
        case 'tl_list_sessions': {
          const filter = args.status;
          if (filter !== undefined) {
            const normalized = validateString(filter, 'status');
            if (!ALLOWED_SESSION_FILTERS.has(normalized)) {
              throw new TlError(
                `status must be one of: ${Array.from(ALLOWED_SESSION_FILTERS).join(', ')}`,
                'CONFIG_INVALID'
              );
            }
            return runAndFormat(deps.runTlCommand, ['sessions', normalized]);
          }
          return runAndFormat(deps.runTlCommand, ['sessions']);
        }
        case 'tl_resume_session':
          return runAndFormat(deps.runTlCommand, [
            'resume',
            validateString(args.sessionId, 'sessionId'),
          ]);
        case 'tl_start_daemon':
          return runAndFormat(deps.runTlCommand, ['start']);
        case 'tl_stop_daemon':
          return runAndFormat(deps.runTlCommand, ['stop']);
        case 'tl_get_config': {
          const key = args.key;
          if (key !== undefined) {
            return runAndFormat(deps.runTlCommand, [
              'config',
              'get',
              validateString(key, 'key'),
            ]);
          }
          return runAndFormat(deps.runTlCommand, ['config', 'get']);
        }
        case 'tl_set_config': {
          const values = args.values;
          if (!values || typeof values !== 'object' || Array.isArray(values)) {
            throw new TlError('values must be an object', 'CONFIG_INVALID');
          }

          const entries = Object.entries(values);
          if (entries.length === 0) {
            throw new TlError('values must not be empty', 'CONFIG_INVALID');
          }

          const cliArgs = ['config', 'set'];
          for (const [key, rawValue] of entries) {
            if (!ALLOWED_CONFIG_KEYS.has(key)) {
              throw new TlError(`Unsupported config key: ${key}`, 'CONFIG_INVALID');
            }
            if (rawValue === null || !['string', 'number', 'boolean'].includes(typeof rawValue)) {
              throw new TlError(
                `Unsupported value type for ${key}: ${typeof rawValue}`,
                'CONFIG_INVALID'
              );
            }
            cliArgs.push(`${key}=${String(rawValue)}`);
          }
          return runAndFormat(deps.runTlCommand, cliArgs);
        }
        default:
          throw new TlError(`Unknown TL MCP tool: ${name}`, 'CONFIG_INVALID');
      }
    },
  };
}

export function createTlCommandRunner() {
  const cliScriptPath = process.env.TL_PLUGIN_TL_CLI_JS;
  if (!cliScriptPath) {
    throw new Error('TL_PLUGIN_TL_CLI_JS is required');
  }

  return async (args: string[]): Promise<CommandResult> =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cliScriptPath, ...args], {
        env: process.env,
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      child.on('error', reject);
      child.on('close', (code) => {
        resolve({
          code: code ?? 1,
          stdout,
          stderr,
        });
      });
    });
}
