import net from 'net';

export async function allocateAvailableLocalEndpoint(
  baseEndpoint: string,
  maxAttempts = 32
): Promise<string> {
  const baseUrl = new URL(baseEndpoint);
  baseUrl.pathname = '';
  baseUrl.search = '';
  baseUrl.hash = '';
  const basePort = Number.parseInt(baseUrl.port || defaultPortForProtocol(baseUrl.protocol), 10);
  const hostname = baseUrl.hostname;

  if (!Number.isFinite(basePort) || basePort <= 0) {
    throw new Error(`Invalid local app-server endpoint port: ${baseEndpoint}`);
  }

  for (let offset = 0; offset < maxAttempts; offset += 1) {
    const candidatePort = basePort + offset;
    const available = await isPortAvailable(hostname, candidatePort);
    if (!available) {
      continue;
    }
    const candidate = new URL(baseEndpoint);
    candidate.pathname = '';
    candidate.search = '';
    candidate.hash = '';
    candidate.port = String(candidatePort);
    return serializeWebsocketUrl(candidate);
  }

  throw new Error(
    `Failed to allocate a free local app-server endpoint near ${baseEndpoint} after ${maxAttempts} attempts`
  );
}

function serializeWebsocketUrl(url: URL): string {
  const port = url.port ? `:${url.port}` : '';
  return `${url.protocol}//${url.hostname}${port}`;
}

function defaultPortForProtocol(protocol: string): string {
  if (protocol === 'wss:') {
    return '443';
  }
  return '80';
}

async function isPortAvailable(hostname: string, port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const server = net.createServer();

    const cleanup = () => {
      server.removeAllListeners();
    };

    server.once('error', () => {
      cleanup();
      resolve(false);
    });

    server.once('listening', () => {
      server.close(() => {
        cleanup();
        resolve(true);
      });
    });

    server.listen(port, hostname);
  });
}
