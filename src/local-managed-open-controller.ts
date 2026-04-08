import { AppServerClient, type AppServerThreadSummary } from './app-server-client.js';
import { logger } from './logger.js';
import { hasRemoteSessionAttachment } from './remote-mode.js';
import { SessionsStore } from './store.js';
import type { SessionManager } from './types.js';

type PublishTurnOutput = (
  sessionId: string,
  args: {
    turnId: string;
    outputText: string;
    totalTurns: number;
  }
) => Promise<number | null>;

type PendingLocalOpen = {
  attachmentId: string;
  logPath: string | null;
  cwd: string;
  project: string;
  model: string;
  endpoint: string;
  knownThreadIds: Set<string>;
  registeredAtMs: number;
  inFlight: boolean;
};

type LocalManagedOpenControllerOptions = {
  pendingPollIntervalMs?: number;
  monitorPollIntervalMs?: number;
  pendingExpiryMs?: number;
};

export class LocalManagedOpenController {
  private readonly pendingPollIntervalMs: number;
  private readonly monitorPollIntervalMs: number;
  private readonly pendingExpiryMs: number;
  private readonly pendingTimers = new Map<string, NodeJS.Timeout>();
  private readonly monitorTimers = new Map<string, NodeJS.Timeout>();
  private readonly pending = new Map<string, PendingLocalOpen>();

  constructor(
    private readonly store: SessionsStore,
    private readonly sessionManager: SessionManager,
    private readonly client: AppServerClient,
    private readonly publishTurnOutput: PublishTurnOutput,
    options: LocalManagedOpenControllerOptions = {}
  ) {
    this.pendingPollIntervalMs = options.pendingPollIntervalMs ?? 1_000;
    this.monitorPollIntervalMs = options.monitorPollIntervalMs ?? 1_000;
    this.pendingExpiryMs = options.pendingExpiryMs ?? 2 * 60 * 60 * 1000;
  }

  async registerPendingOpen(args: {
    attachmentId: string;
    logPath?: string | null;
    cwd: string;
    project: string;
    model: string;
    endpoint: string;
    knownThreadIds?: string[];
  }): Promise<void> {
    const knownThreadIds = args.knownThreadIds
      ? new Set(args.knownThreadIds)
      : new Set(
          (
            await this.client.listThreads({
              endpoint: args.endpoint,
            })
          ).map((thread) => thread.id)
        );

    this.clearPending(args.attachmentId);
    this.pending.set(args.attachmentId, {
      attachmentId: args.attachmentId,
      logPath: args.logPath ?? null,
      cwd: args.cwd,
      project: args.project,
      model: args.model,
      endpoint: args.endpoint,
      knownThreadIds,
      registeredAtMs: Date.now(),
      inFlight: false,
    });
    logger.info('Registered pending local-managed open', {
      attachmentId: args.attachmentId,
      cwd: args.cwd,
      knownThreadCount: knownThreadIds.size,
    });
    this.pendingTimers.set(
      args.attachmentId,
      setInterval(() => {
        void this.pollPendingOpen(args.attachmentId);
      }, this.pendingPollIntervalMs)
    );
  }

  restoreSessionMonitors(): void {
    for (const { id, record } of this.store.listAll()) {
      if (record.local_bridge_enabled !== true || !hasRemoteSessionAttachment(record)) {
        continue;
      }
      this.ensureSessionMonitor(id);
    }
  }

  shutdown(): void {
    for (const timer of this.pendingTimers.values()) {
      clearInterval(timer);
    }
    this.pendingTimers.clear();
    this.pending.clear();

    for (const timer of this.monitorTimers.values()) {
      clearInterval(timer);
    }
    this.monitorTimers.clear();
  }

  private clearPending(attachmentId: string): void {
    const timer = this.pendingTimers.get(attachmentId);
    if (timer) {
      clearInterval(timer);
    }
    this.pendingTimers.delete(attachmentId);
    this.pending.delete(attachmentId);
  }

  private ensureSessionMonitor(sessionId: string): void {
    if (this.monitorTimers.has(sessionId)) {
      return;
    }

    this.monitorTimers.set(
      sessionId,
      setInterval(() => {
        void this.pollSession(sessionId);
      }, this.monitorPollIntervalMs)
    );
  }

  private clearSessionMonitor(sessionId: string): void {
    const timer = this.monitorTimers.get(sessionId);
    if (timer) {
      clearInterval(timer);
    }
    this.monitorTimers.delete(sessionId);
  }

  private async pollPendingOpen(attachmentId: string): Promise<void> {
    const pending = this.pending.get(attachmentId);
    if (!pending || pending.inFlight) {
      return;
    }

    if (Date.now() - pending.registeredAtMs > this.pendingExpiryMs) {
      logger.warn('Pending local open expired before thread adoption', {
        attachmentId,
        cwd: pending.cwd,
      });
      this.clearPending(attachmentId);
      return;
    }

    pending.inFlight = true;
    try {
      const threads = await this.client.listThreads({ endpoint: pending.endpoint });
      const candidate = this.findCandidateThread(pending, threads);
      if (!candidate) {
        return;
      }

      const snapshot = await this.client.readThreadSnapshot({
        endpoint: pending.endpoint,
        threadId: candidate.id,
      });
      const latestTurn = snapshot.latestTurn;
      const initialUserText = latestTurn?.userText ?? '';

      await this.sessionManager.handleSessionStart({
        session_id: candidate.id,
        model: pending.model,
        turn_id: latestTurn?.id ?? '',
        project: pending.project,
        cwd: pending.cwd,
        last_user_message: initialUserText,
        session_mode: 'local-managed',
        local_attachment_id: pending.attachmentId,
        remote_endpoint: pending.endpoint,
        remote_thread_id: candidate.id,
      });

      this.store.update(candidate.id, (record) => {
        record.local_bridge_enabled = true;
        record.local_bridge_state = 'attached';
        record.local_attachment_id = pending.attachmentId;
        record.local_input_queue_depth = 0;
        record.local_last_input_source = null;
        record.local_last_input_at = null;
        record.local_last_injection_error = null;
        record.remote_mode_enabled = true;
        record.remote_input_owner = 'tui';
        record.remote_endpoint = pending.endpoint;
        record.remote_thread_id = candidate.id;
        record.remote_worker_log_path = pending.logPath ?? record.remote_worker_log_path;
        record.last_user_message = initialUserText || record.last_user_message;

        if (!latestTurn) {
          record.remote_status = 'attached';
          return;
        }

        record.remote_last_turn_id = latestTurn.id;
        if (latestTurn.status === 'inProgress') {
          record.remote_status = 'running';
          return;
        }

        record.remote_status = 'idle';
        record.total_turns = Math.max(record.total_turns, 1);
        record.last_turn_output = latestTurn.outputText;
      });
      await this.store.save();

      if (latestTurn?.status === 'inProgress') {
        await this.sessionManager.handleWorking({ session_id: candidate.id });
      } else if (latestTurn) {
        await this.publishStopIfNeeded(candidate.id, latestTurn.id, latestTurn.outputText, 1);
      }

      logger.info('Adopted local-managed thread from blank open', {
        attachmentId,
        sessionId: candidate.id,
        cwd: pending.cwd,
      });

      this.clearPending(attachmentId);
      this.ensureSessionMonitor(candidate.id);
    } catch (err) {
      logger.warn('Failed to adopt pending local-managed open', {
        attachmentId,
        error: (err as Error).message,
      });
    } finally {
      const current = this.pending.get(attachmentId);
      if (current) {
        current.inFlight = false;
      }
    }
  }

  private findCandidateThread(
    pending: PendingLocalOpen,
    threads: AppServerThreadSummary[]
  ): AppServerThreadSummary | null {
    const claimedThreadIds = new Set(
      this.store
        .listAll()
        .map(({ record }) => record.remote_thread_id)
        .filter((value): value is string => typeof value === 'string' && value.length > 0)
    );

    const candidates = threads
      .filter((thread) => thread.cwd === pending.cwd)
      .filter((thread) => !pending.knownThreadIds.has(thread.id))
      .filter((thread) => !claimedThreadIds.has(thread.id))
      .filter((thread) => {
        const timestamp = normalizeThreadTimestampMs(thread.updatedAt ?? thread.createdAt);
        return timestamp >= pending.registeredAtMs - 5_000;
      })
      .sort(
        (left, right) =>
          normalizeThreadTimestampMs(right.updatedAt ?? right.createdAt) -
          normalizeThreadTimestampMs(left.updatedAt ?? left.createdAt)
      );

    return candidates[0] ?? null;
  }

  private async pollSession(sessionId: string): Promise<void> {
    const existing = this.store.get(sessionId);
    if (!existing) {
      this.clearSessionMonitor(sessionId);
      return;
    }

    const record = existing.record;
    if (
      record.local_bridge_enabled !== true ||
      !record.remote_endpoint ||
      !record.remote_thread_id
    ) {
      this.clearSessionMonitor(sessionId);
      return;
    }

    try {
      const snapshot = await this.client.readThreadSnapshot({
        endpoint: record.remote_endpoint,
        threadId: record.remote_thread_id,
      });
      const latestTurn = snapshot.latestTurn;
      if (!latestTurn) {
        return;
      }

      if (record.remote_last_turn_id !== latestTurn.id) {
        if (latestTurn.status === 'inProgress') {
          this.store.update(sessionId, (next) => {
            next.remote_last_turn_id = latestTurn.id;
            next.remote_status = 'running';
            next.remote_input_owner = 'tui';
            next.remote_last_error = null;
            next.last_user_message = latestTurn.userText ?? next.last_user_message;
          });
          await this.store.save();
          await this.sessionManager.handleWorking({ session_id: sessionId });
          return;
        }

        const nextTotalTurns = record.total_turns + 1;
        await this.sessionManager.handleManagedTurnSettled({
          session_id: sessionId,
          turn_id: latestTurn.id,
          last_message: latestTurn.outputText,
          total_turns: nextTotalTurns,
          last_user_message: latestTurn.userText,
          remote_input_owner: 'tui',
        });
        await this.publishStopIfNeeded(sessionId, latestTurn.id, latestTurn.outputText, nextTotalTurns);
        return;
      }

      if (record.remote_status !== 'running' && latestTurn.status === 'inProgress') {
        this.store.update(sessionId, (next) => {
          next.remote_status = 'running';
          next.remote_input_owner = 'tui';
          next.remote_last_error = null;
        });
        await this.store.save();
        await this.sessionManager.handleWorking({ session_id: sessionId });
        return;
      }

      if (record.remote_status === 'running' && latestTurn.status !== 'inProgress') {
        const nextTotalTurns = record.total_turns + 1;
        await this.sessionManager.handleManagedTurnSettled({
          session_id: sessionId,
          turn_id: latestTurn.id,
          last_message: latestTurn.outputText,
          total_turns: nextTotalTurns,
          last_user_message: latestTurn.userText,
          remote_input_owner: 'tui',
        });
        await this.publishStopIfNeeded(sessionId, latestTurn.id, latestTurn.outputText, nextTotalTurns);
      }
    } catch (err) {
      logger.warn('Failed to observe local-managed session thread', {
        sessionId,
        error: (err as Error).message,
      });
      this.store.update(sessionId, (record) => {
        record.remote_status = 'degraded';
        record.remote_last_error = `failed to observe local-managed turn: ${(err as Error).message}`;
      });
      await this.store.save();
    }
  }

  private async publishStopIfNeeded(
    sessionId: string,
    turnId: string,
    outputText: string,
    totalTurns: number
  ): Promise<void> {
    if (outputText.length === 0) {
      return;
    }

    const stopMessageId = await this.publishTurnOutput(sessionId, {
      turnId,
      outputText,
      totalTurns,
    });
    if (stopMessageId == null) {
      return;
    }

    this.store.update(sessionId, (record) => {
      record.stop_message_id = stopMessageId;
    });
    await this.store.save();
  }
}

function normalizeThreadTimestampMs(value?: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0;
  }
  return value < 1_000_000_000_000 ? value * 1_000 : value;
}
