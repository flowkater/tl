import { spawn, type ChildProcess } from 'child_process';

type FetchLike = typeof fetch;
type SpawnLike = typeof spawn;

type RuntimeManagerOptions = {
  fetchImpl?: FetchLike;
  spawnImpl?: SpawnLike;
  readinessTimeoutMs?: number;
  pollIntervalMs?: number;
};

function toReadyzUrl(endpoint: string): string {
  const url = new URL(endpoint);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = '/readyz';
  url.search = '';
  url.hash = '';
  return url.toString();
}

export class AppServerRuntimeManager {
  private readonly fetchImpl: FetchLike;
  private readonly spawnImpl: SpawnLike;
  private readonly readinessTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly inflight = new Map<string, Promise<boolean>>();

  constructor(options: RuntimeManagerOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.spawnImpl = options.spawnImpl ?? spawn;
    this.readinessTimeoutMs = options.readinessTimeoutMs ?? 5_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 200;
  }

  async ensureAvailable(endpoint: string, cwd: string): Promise<boolean> {
    const existing = this.inflight.get(endpoint);
    if (existing) {
      return existing;
    }

    const promise = this.ensureAvailableInternal(endpoint, cwd);
    this.inflight.set(endpoint, promise);
    try {
      return await promise;
    } finally {
      this.inflight.delete(endpoint);
    }
  }

  async isReady(endpoint: string): Promise<boolean> {
    try {
      const response = await this.fetchImpl(toReadyzUrl(endpoint), {
        signal: AbortSignal.timeout(1_000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  private async ensureAvailableInternal(endpoint: string, cwd: string): Promise<boolean> {
    if (await this.isReady(endpoint)) {
      return false;
    }

    const child = this.spawnImpl('codex', ['app-server', '--listen', endpoint], {
      cwd,
      detached: true,
      stdio: 'ignore',
    });
    child.unref();

    await this.waitUntilReady(endpoint);
    return true;
  }

  private async waitUntilReady(endpoint: string): Promise<void> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < this.readinessTimeoutMs) {
      if (await this.isReady(endpoint)) {
        return;
      }
      await delay(this.pollIntervalMs);
    }
    throw new Error(`Timed out waiting for app-server readyz: ${endpoint}`);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createFakeChildProcess(): ChildProcess {
  return {
    unref() {},
  } as ChildProcess;
}

