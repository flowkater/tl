import { execFileSync } from 'child_process';

interface ProcessEntry {
  pid: number;
  ppid: number;
  command: string;
}

export function extractRemoteEndpointFromCommand(command: string): string | null {
  const inlineMatch = command.match(/(?:^|\s)--remote=(\S+)/);
  if (inlineMatch?.[1]) {
    return inlineMatch[1];
  }

  const separatedMatch = command.match(/(?:^|\s)--remote\s+(\S+)/);
  if (separatedMatch?.[1]) {
    return separatedMatch[1];
  }

  return null;
}

export function parsePsOutput(psOutput: string): Map<number, ProcessEntry> {
  const table = new Map<number, ProcessEntry>();

  for (const rawLine of psOutput.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    const match = line.match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;

    const [, pidText, ppidText, command] = match;
    table.set(Number(pidText), {
      pid: Number(pidText),
      ppid: Number(ppidText),
      command,
    });
  }

  return table;
}

export function discoverRemoteEndpointFromProcessTree(args?: {
  startPid?: number;
  psOutput?: string;
  maxDepth?: number;
}): string | null {
  const startPid = args?.startPid ?? process.pid;
  const maxDepth = args?.maxDepth ?? 8;
  const psOutput =
    args?.psOutput ??
    execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf-8' });

  const table = parsePsOutput(psOutput);
  let currentPid = startPid;

  for (let depth = 0; depth < maxDepth; depth += 1) {
    const entry = table.get(currentPid);
    if (!entry) break;

    const endpoint = extractRemoteEndpointFromCommand(entry.command);
    if (endpoint) {
      return endpoint;
    }

    if (!entry.ppid || entry.ppid === currentPid) {
      break;
    }
    currentPid = entry.ppid;
  }

  return null;
}

export function resolveRemoteEndpoint(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.TL_REMOTE_ENDPOINT?.trim();
  if (explicit) {
    return explicit;
  }

  return discoverRemoteEndpointFromProcessTree();
}
