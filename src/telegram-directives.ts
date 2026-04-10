import type {
  ApprovalPolicy,
  ParsedTelegramDirectiveMessage,
  SandboxMode,
  TelegramControlCommand,
  TelegramDirectiveField,
  TelegramDirectiveValues,
  TelegramListDirectiveField,
  TelegramScalarDirectiveField,
} from './types.js';

const APPROVAL_POLICIES = new Set(['never', 'on-request', 'on-failure', 'untrusted']);
const SANDBOX_VALUES = new Set(['danger-full-access', 'workspace-write', 'read-only']);

function isDirectiveField(value: string): value is TelegramDirectiveField {
  return (
    value === 'skill' ||
    value === 'cmd' ||
    value === 'model' ||
    value === 'approval-policy' ||
    value === 'sandbox' ||
    value === 'cwd'
  );
}

function parseDirectiveField(value: string): TelegramDirectiveField {
  const normalized = value.trim().toLowerCase();
  if (!isDirectiveField(normalized)) {
    throw new Error(`Unknown directive field: ${value}`);
  }
  return normalized;
}

function parseListFieldValue(field: TelegramListDirectiveField, rawValue: string): string[] {
  const value = rawValue.trim();
  if (value === 'none') {
    return [];
  }
  if (value.length === 0) {
    throw new Error(`Missing value for ${field}`);
  }

  const parts = value.split(',').map((part) => part.trim());
  if (parts.some((part) => part.length === 0)) {
    throw new Error(`Invalid list value for ${field}`);
  }

  if (field === 'skill' && parts.some((part) => /\s/.test(part))) {
    throw new Error(`Invalid skill value: ${rawValue}`);
  }
  if (field === 'cmd' && parts.some((part) => !part.startsWith('/'))) {
    throw new Error(`Invalid cmd value: ${rawValue}`);
  }

  return parts;
}

function validateScalarValue(field: TelegramScalarDirectiveField, rawValue: string): string {
  const value = rawValue.trim();
  if (value.length === 0) {
    throw new Error(`Missing value for ${field}`);
  }
  if (value === 'none') {
    throw new Error(`none only clears skill and cmd`);
  }

  if (field === 'model' && /\s/.test(value)) {
    throw new Error(`Invalid model value: ${rawValue}`);
  }
  if (field === 'approval-policy' && !APPROVAL_POLICIES.has(value)) {
    throw new Error(`Unknown approval-policy value: ${rawValue}`);
  }
  if (field === 'sandbox' && !SANDBOX_VALUES.has(value)) {
    throw new Error(`Unknown sandbox value: ${rawValue}`);
  }

  return value;
}

function mergeListDirective(
  directives: TelegramDirectiveValues,
  field: TelegramListDirectiveField,
  values: string[]
): void {
  if (values.length === 0) {
    delete directives[field];
    return;
  }

  const existing = directives[field] ?? [];
  directives[field] = [...existing, ...values];
}

function assignScalarDirective(
  directives: TelegramDirectiveValues,
  field: TelegramScalarDirectiveField,
  value: string
): void {
  if (field === 'model' || field === 'cwd') {
    directives[field] = value;
    return;
  }

  if (field === 'approval-policy') {
    directives['approval-policy'] = value as ApprovalPolicy;
    return;
  }

  directives.sandbox = value as SandboxMode;
}

function parseControlSet(rest: string): TelegramControlCommand {
  const match = rest.match(/^set\s+(\S+)\s+([\s\S]+)$/i);
  if (!match) {
    throw new Error('Usage: /tl set <field> <value>');
  }

  const field = parseDirectiveField(match[1]);
  const rawValue = match[2];

  if (field === 'skill' || field === 'cmd') {
    return {
      kind: 'set',
      field,
      value: parseListFieldValue(field, rawValue),
    };
  }

  return {
    kind: 'set',
    field,
    value: validateScalarValue(field, rawValue),
  };
}

function parseControlClear(rest: string): TelegramControlCommand {
  const match = rest.match(/^clear\s+(\S+)$/i);
  if (!match) {
    throw new Error('Usage: /tl clear <field>');
  }

  return {
    kind: 'clear',
    field: parseDirectiveField(match[1]),
  };
}

export function parseTelegramControlCommand(text: string): TelegramControlCommand {
  const trimmed = text.trim();
  const match = trimmed.match(/^\/tl(?:@\w+)?(?:\s+([\s\S]+))?$/i);
  if (!match) {
    throw new Error('Not a /tl command');
  }

  const rest = (match[1] ?? '').trim();
  if (!rest) {
    throw new Error('Usage: /tl help|status|resume|show config|set <field> <value>|clear <field>');
  }

  const [command, ...parts] = rest.split(/\s+/);
  const lowerCommand = command.toLowerCase();

  if (lowerCommand === 'help' || lowerCommand === 'status' || lowerCommand === 'resume') {
    if (parts.length > 0) {
      throw new Error(`Unexpected arguments for /tl ${lowerCommand}`);
    }
    return { kind: lowerCommand };
  }

  if (lowerCommand === 'show') {
    if (parts.length !== 1 || parts[0].toLowerCase() !== 'config') {
      throw new Error('Usage: /tl show config');
    }
    return { kind: 'showConfig' };
  }

  if (lowerCommand === 'set') {
    return parseControlSet(rest);
  }

  if (lowerCommand === 'clear') {
    return parseControlClear(rest);
  }

  throw new Error(`Unknown /tl command: ${command}`);
}

function parseHeaderLine(line: string): { key: string; value: string } {
  const match = line.match(/^@([A-Za-z][A-Za-z-]*)\s*:\s*(.*)$/);
  if (!match) {
    throw new Error(`Invalid directive header: ${line}`);
  }
  return { key: match[1].toLowerCase(), value: match[2].trim() };
}

export function parseTelegramDirectiveMessage(text: string): ParsedTelegramDirectiveMessage {
  const lines = text.split(/\r?\n/);
  if (lines.length === 0) {
    return { body: '', directives: {} };
  }

  const firstLine = lines[0].trim();
  if (!/^@[A-Za-z][A-Za-z-]*\s*:/.test(firstLine)) {
    return { body: text, directives: {} };
  }

  const directives: TelegramDirectiveValues = {};
  let index = 0;
  let parsedAnyHeader = false;

  while (index < lines.length) {
    const line = lines[index];
    if (line.trim() === '') {
      index += 1;
      while (index < lines.length && lines[index].trim() === '') {
        index += 1;
      }
      break;
    }

    if (!line.trim().startsWith('@')) {
      break;
    }

    parsedAnyHeader = true;
    const { key, value } = parseHeaderLine(line);
    if (!isDirectiveField(key)) {
      throw new Error(`Unknown directive header: ${key}`);
    }

    if (key === 'skill' || key === 'cmd') {
      const values = parseListFieldValue(key, value);
      if (values.length === 0) {
        directives[key] = [];
      } else {
        mergeListDirective(directives, key, values);
      }
    } else {
      assignScalarDirective(directives, key, validateScalarValue(key, value));
    }

    index += 1;
  }

  if (!parsedAnyHeader) {
    return { body: text, directives: {} };
  }

  const body = lines.slice(index).join('\n');
  if (body.trim().length === 0) {
    throw new Error('Directive headers require a message body');
  }

  return { body, directives };
}

export function compileDirectivePrompt(args: {
  body: string;
  directives: Pick<TelegramDirectiveValues, 'skill' | 'cmd'>;
}): string {
  const sections: string[] = [];

  if (args.directives.cmd && args.directives.cmd.length > 0) {
    sections.push(args.directives.cmd.join('\n'));
  }

  if (args.directives.skill && args.directives.skill.length > 0) {
    sections.push(
      '[TL directives]',
      `Use these skills for this turn: ${args.directives.skill.join(', ')}`,
      '[/TL directives]'
    );
  }

  if (args.body.length > 0) {
    sections.push(args.body);
  }

  return sections.join('\n\n');
}
