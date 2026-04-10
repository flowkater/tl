export type OpenCommandArgs = {
  cwd: string;
  model: string;
  text: string;
  project: string;
  endpoint: string;
};

export const OPEN_COMMAND_USAGE =
  'Usage: tl open [--cwd <dir>] [--model <model>] [--text <message>] [--project <name>] [--endpoint <ws-url>]';

function buildExistingSessionGuidance(arg: string): string {
  return [
    `Unexpected positional argument for tl open: ${arg}`,
    '`tl open` starts a new local-managed session.',
    'To reopen an existing session, use `tl local open <session_id>` or `tl remote open <session_id>`.',
  ].join('\n');
}

export function parseOpenArgs(args: string[], defaultCwd: string): OpenCommandArgs {
  const parsed: OpenCommandArgs = {
    cwd: defaultCwd,
    model: 'gpt-5.4',
    text: '',
    project: '',
    endpoint: '',
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--cwd') {
      parsed.cwd = args[i + 1] ?? parsed.cwd;
      i += 1;
      continue;
    }
    if (arg === '--model') {
      parsed.model = args[i + 1] ?? parsed.model;
      i += 1;
      continue;
    }
    if (arg === '--text') {
      parsed.text = args[i + 1] ?? parsed.text;
      i += 1;
      continue;
    }
    if (arg === '--project') {
      parsed.project = args[i + 1] ?? parsed.project;
      i += 1;
      continue;
    }
    if (arg === '--endpoint') {
      parsed.endpoint = args[i + 1] ?? parsed.endpoint;
      i += 1;
      continue;
    }

    if (!arg.startsWith('--')) {
      throw new Error(buildExistingSessionGuidance(arg));
    }

    throw new Error(`${OPEN_COMMAND_USAGE}\nUnknown option: ${arg}`);
  }

  return parsed;
}
