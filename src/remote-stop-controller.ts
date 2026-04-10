import { AppServerClient, type RemoteInjectResult } from './app-server-client.js';
import { AppServerRuntimeManager } from './app-server-runtime.js';
import {
  hasRemoteSessionAttachment,
  isLocalManagedSession,
  resolveManagedMode,
} from './remote-mode.js';
import { SessionsStore } from './store.js';
import { logger } from './logger.js';
import { RemoteWorkerRuntimeManager } from './remote-worker-runtime.js';
import { LocalConsoleRuntimeManager } from './local-console-runtime.js';
import type { DeferredLaunchPreferences, SessionRecord } from './types.js';

type LateReplyFallback = {
  handle(sessionId: string, replyText: string): Promise<boolean>;
};

type RemoteStopControllerOptions = {
  notifyDelivered?: (sessionId: string) => Promise<void>;
  notifyFailed?: (sessionId: string, error: string) => Promise<void>;
  notifyRecovering?: (
    sessionId: string,
    phase: 'reconnect' | 'resume' | 'fallback'
  ) => Promise<void>;
  publishTurnOutput?: (
    sessionId: string,
    args: {
      turnId: string;
      outputText: string;
      totalTurns: number;
    }
  ) => Promise<number | null>;
  settleManagedTurn?: (
    sessionId: string,
    args: {
      turnId: string;
      outputText: string;
      totalTurns: number;
      remoteInputOwner: 'telegram' | 'tui';
    }
  ) => Promise<void>;
  resolveDeferredLaunchPreferences?: (
    sessionId: string,
    record: SessionRecord
  ) => DeferredLaunchPreferences | undefined;
};

export type RemoteReplyHandleResult =
  | { handled: false; mode: 'not-remote' }
  | { handled: true; mode: 'remote'; turnId: string }
  | { handled: true; mode: 'fallback' };

type RemoteAttemptFailure = {
  error: string;
  kind: 'inject' | 'resume';
};

type RemoteAttemptResult = {
  result: RemoteReplyHandleResult | null;
  failure?: RemoteAttemptFailure;
};

export class RemoteStopController {
  private notifyDelivered?: RemoteStopControllerOptions['notifyDelivered'];
  private notifyFailed?: RemoteStopControllerOptions['notifyFailed'];
  private notifyRecovering?: RemoteStopControllerOptions['notifyRecovering'];
  private publishTurnOutput?: RemoteStopControllerOptions['publishTurnOutput'];
  private settleManagedTurn?: RemoteStopControllerOptions['settleManagedTurn'];
  private resolveDeferredLaunchPreferences?: RemoteStopControllerOptions['resolveDeferredLaunchPreferences'];

  constructor(
    private store: SessionsStore,
    private client: AppServerClient,
    private fallback: LateReplyFallback,
    private runtime: AppServerRuntimeManager,
    private workerRuntime: RemoteWorkerRuntimeManager,
    private localConsoleRuntime?: LocalConsoleRuntimeManager,
    options: RemoteStopControllerOptions = {}
    ) {
    this.notifyDelivered = options.notifyDelivered;
    this.notifyFailed = options.notifyFailed;
    this.notifyRecovering = options.notifyRecovering;
    this.publishTurnOutput = options.publishTurnOutput;
    this.settleManagedTurn = options.settleManagedTurn;
    this.resolveDeferredLaunchPreferences = options.resolveDeferredLaunchPreferences;
  }

  async handleReply(
    sessionId: string,
    replyText: string
  ): Promise<RemoteReplyHandleResult> {
    const existing = this.store.get(sessionId);
    if (!existing || !hasRemoteSessionAttachment(existing.record)) {
      return { handled: false, mode: 'not-remote' };
    }

    const launchPrefs = this.getDeferredLaunchPreferences(sessionId, existing.record);
    const effectiveCwd = launchPrefs?.cwd ?? existing.record.cwd;

    try {
      await this.ensureManagedAttachment(
        sessionId,
        existing.record,
        existing.record.remote_endpoint!,
        effectiveCwd,
        launchPrefs
      );

      this.store.update(sessionId, (record) => {
        record.mode = resolveManagedMode(record);
        record.remote_input_owner = 'telegram';
        record.remote_status = 'injecting';
        record.remote_last_error = null;
      });
      await this.store.save();

      const result = await this.client.injectReply({
        endpoint: existing.record.remote_endpoint!,
        threadId: existing.record.remote_thread_id!,
        replyText,
      });

      await this.persistRemoteSuccess(
        sessionId,
        existing.record.remote_endpoint!,
        existing.record.remote_thread_id!,
        replyText,
        result
      );

      return {
        handled: true,
        mode: 'remote',
        turnId: result.turnId,
      };
    } catch (err) {
      const message = (err as Error).message;
      this.store.update(sessionId, (record) => {
        record.mode = resolveManagedMode(record);
        record.remote_input_owner = 'telegram';
        record.remote_status = 'recovering';
        record.remote_last_injection_error = message;
        record.remote_last_error = message;
      });
      await this.store.save();

      if (this.notifyRecovering) {
        await this.notifyRecovering(sessionId, 'reconnect');
      }
      const restarted = await this.tryRestartAndRetry(
        sessionId,
        existing.record.remote_endpoint!,
        existing.record.remote_thread_id!,
        effectiveCwd,
        replyText
      );
      if (restarted.result) {
        return restarted.result;
      }

      if (this.notifyRecovering) {
        await this.notifyRecovering(sessionId, 'resume');
      }
      const resumed = await this.tryResumeThreadAndRetry(
        sessionId,
        existing.record.remote_endpoint!,
        existing.record.remote_thread_id!,
        effectiveCwd,
        replyText
      );
      if (resumed.result) {
        return resumed.result;
      }

      if (this.notifyRecovering) {
        await this.notifyRecovering(sessionId, 'fallback');
      }

      this.store.update(sessionId, (record) => {
        const currentError =
          record.remote_last_resume_error ??
          record.remote_last_injection_error ??
          message;
        record.mode = resolveManagedMode(record);
        record.remote_input_owner = 'telegram';
        record.remote_status = 'degraded';
        record.remote_last_error = currentError;
      });
      await this.store.save();

      if (this.notifyFailed) {
        const current = this.store.get(sessionId);
        const error =
          current?.record.remote_last_resume_error ??
          current?.record.remote_last_injection_error ??
          message;
        await this.notifyFailed(sessionId, error);
      }

      const handled = await this.fallback.handle(sessionId, replyText);
      if (handled) {
        return { handled: true, mode: 'fallback' };
      }

      return { handled: false, mode: 'not-remote' };
    }
  }

  async ensureWorkerAttached(
    sessionId: string,
    endpoint: string,
    cwd: string,
    knownPid?: number | null,
    knownLogPath?: string | null,
    launchPrefs?: DeferredLaunchPreferences
  ): Promise<void> {
    const worker = await this.workerRuntime.ensureAttached({
      sessionId,
      endpoint,
      cwd,
      knownPid,
      knownLogPath,
      launchPrefs,
    });

    this.store.update(sessionId, (record) => {
      record.remote_mode_enabled = true;
      record.mode = resolveManagedMode(record);
      record.remote_input_owner = 'telegram';
      record.remote_worker_pid = worker.pid;
      record.remote_worker_log_path = worker.logPath;
      record.remote_worker_started_at = new Date().toISOString();
      record.remote_worker_last_error = null;
    });
    await this.store.save();
  }

  async ensureLocalConsoleAttached(
    sessionId: string,
    endpoint: string,
    cwd: string,
    knownAttachmentId?: string | null,
    knownLogPath?: string | null,
    launchPrefs?: DeferredLaunchPreferences
  ): Promise<void> {
    if (!this.localConsoleRuntime) {
      throw new Error('Local console runtime unavailable');
    }

    const consoleSession = await this.localConsoleRuntime.ensureAttached({
      sessionId,
      endpoint,
      cwd,
      knownAttachmentId,
      knownLogPath,
      launchPrefs,
    });

    this.store.update(sessionId, (record) => {
      record.remote_mode_enabled = true;
      record.mode = resolveManagedMode(record);
      record.remote_input_owner = 'telegram';
      record.local_bridge_enabled = true;
      record.local_bridge_state = 'attached';
      record.local_attachment_id = consoleSession.attachmentId;
      record.remote_worker_log_path = consoleSession.logPath;
      record.remote_worker_last_error = null;
    });
    await this.store.save();
  }

  private async tryRestartAndRetry(
    sessionId: string,
    endpoint: string,
    threadId: string,
    cwd: string,
    replyText: string
  ): Promise<RemoteAttemptResult> {
    const current = this.store.get(sessionId);
    const launchPrefs = current
      ? this.getDeferredLaunchPreferences(sessionId, current.record)
      : undefined;
    const effectiveCwd = launchPrefs?.cwd ?? cwd;
    try {
      await this.runtime.ensureAvailable(endpoint, effectiveCwd);
      const currentAfterRestart = this.store.get(sessionId);
      await this.ensureManagedAttachment(
        sessionId,
        currentAfterRestart?.record,
        endpoint,
        effectiveCwd,
        launchPrefs
      );
      const retried = await this.client.injectReply({
        endpoint,
        threadId,
        replyText,
      });
      await this.persistRemoteSuccess(
        sessionId,
        endpoint,
        threadId,
        replyText,
        retried,
        true
      );
      return {
        result: {
          handled: true,
          mode: 'remote',
          turnId: retried.turnId,
        },
      };
    } catch (err) {
      const message = (err as Error).message;
      this.store.update(sessionId, (record) => {
        record.mode = resolveManagedMode(record);
        record.remote_input_owner = 'telegram';
        record.remote_status = 'recovering';
      record.remote_last_injection_error = message;
      record.remote_last_error = message;
      record.remote_worker_last_error = message;
      });
      await this.store.save();
      return {
        result: null,
        failure: {
          error: message,
          kind: 'inject',
        },
      };
    }
  }

  private async tryResumeThreadAndRetry(
    sessionId: string,
    endpoint: string,
    threadId: string,
    cwd: string,
    replyText: string
  ): Promise<RemoteAttemptResult> {
    let resumedThreadId = threadId;
    const current = this.store.get(sessionId);
    const launchPrefs = current
      ? this.getDeferredLaunchPreferences(sessionId, current.record)
      : undefined;
    const effectiveCwd = launchPrefs?.cwd ?? cwd;
    try {
      const resumedAt = new Date().toISOString();
      const resumed = await this.client.resumeThread({
        endpoint,
        threadId,
        cwd: effectiveCwd,
      });
      resumedThreadId = resumed.threadId;

      const currentAfterResume = this.store.get(sessionId);
      await this.ensureManagedAttachment(
        sessionId,
        currentAfterResume?.record,
        endpoint,
        effectiveCwd,
        launchPrefs
      );

      this.store.update(sessionId, (record) => {
        record.remote_thread_id = resumedThreadId;
        record.remote_input_owner = 'telegram';
        record.remote_last_resume_at = resumedAt;
        record.remote_last_resume_error = null;
        record.remote_last_recovery_at = resumedAt;
        record.remote_last_error = null;
        record.remote_status = 'recovering';
      });
      await this.store.save();

      try {
        const retried = await this.client.injectReply({
          endpoint,
          threadId: resumedThreadId,
          replyText,
        });
        await this.persistRemoteSuccess(
          sessionId,
          endpoint,
          resumedThreadId,
          replyText,
          retried,
          true
        );
        return {
          result: {
            handled: true,
            mode: 'remote',
            turnId: retried.turnId,
          },
        };
      } catch (err) {
        const message = (err as Error).message;
        this.store.update(sessionId, (record) => {
          record.remote_thread_id = resumedThreadId;
          record.remote_input_owner = 'telegram';
          record.remote_last_injection_error = message;
          record.remote_last_resume_error = null;
          record.remote_last_error = message;
          record.remote_status = 'recovering';
        });
        await this.store.save();
        return {
          result: null,
          failure: {
            error: message,
            kind: 'inject',
          },
        };
      }
    } catch (err) {
      const message = (err as Error).message;
      this.store.update(sessionId, (record) => {
        record.remote_thread_id = resumedThreadId;
        record.remote_input_owner = 'telegram';
        record.remote_last_resume_error = message;
        record.remote_last_error = message;
        record.remote_status = 'recovering';
        record.remote_worker_last_error = message;
      });
      await this.store.save();
      return {
        result: null,
        failure: {
          error: message,
          kind: 'resume',
        },
      };
    }
  }

  private async persistRemoteSuccess(
    sessionId: string,
    endpoint: string,
    threadId: string,
    replyText: string,
    result: RemoteInjectResult,
    recovered: boolean = false
  ): Promise<void> {
    this.store.update(sessionId, (record) => {
      record.status = 'active';
      record.mode = resolveManagedMode(record);
      record.remote_input_owner = 'telegram';
      record.last_user_message = replyText;
      record.remote_thread_id = threadId;
      record.remote_last_turn_id = result.turnId;
      record.remote_last_injection_at = new Date().toISOString();
      record.remote_last_injection_error = null;
      record.remote_last_resume_error = null;
      record.remote_last_error = null;
      record.remote_worker_last_error = null;
      record.remote_status = 'running';
      if (recovered) {
        record.remote_last_recovery_at = new Date().toISOString();
      }
    });
    await this.store.save();

    if (this.notifyDelivered) {
      try {
        await this.notifyDelivered(sessionId);
      } catch (err) {
        logger.warn('Remote delivery notification failed after inject success', {
          sessionId,
          threadId,
          turnId: result.turnId,
          error: (err as Error).message,
        });
      }
    }

    this.watchTurnCompletion(sessionId, endpoint, threadId, result.turnId);
  }

  private watchTurnCompletion(
    sessionId: string,
    endpoint: string,
    threadId: string,
    turnId: string
  ): void {
    void (async () => {
      try {
        const settlement = await this.client.waitForTurnToSettle({
          endpoint,
          threadId,
          turnId,
        });

        const existing = this.store.get(sessionId);
        if (!existing || existing.record.remote_mode_enabled !== true) {
          return;
        }
        if (existing.record.remote_last_turn_id !== turnId) {
          return;
        }

        const isLocalManaged = isLocalManagedSession(existing.record);
        if (isLocalManaged && existing.record.remote_status !== 'running') {
          return;
        }

        const nextTotalTurns = existing.record.total_turns + 1;

        if (isLocalManaged && this.settleManagedTurn) {
          await this.settleManagedTurn(sessionId, {
            turnId,
            outputText: settlement.outputText,
            totalTurns: nextTotalTurns,
            remoteInputOwner: 'telegram',
          });

          if (
            settlement.outputText.length > 0 &&
            this.publishTurnOutput
          ) {
            const stopMessageId = await this.publishTurnOutput(sessionId, {
              turnId,
              outputText: settlement.outputText,
              totalTurns: nextTotalTurns,
            });
            if (stopMessageId != null) {
              this.store.update(sessionId, (record) => {
                if (record.remote_mode_enabled !== true) {
                  return;
                }
                if (record.remote_last_turn_id !== turnId) {
                  return;
                }
                record.stop_message_id = stopMessageId;
              });
              await this.store.save();
            }
          }
          return;
        }

        this.store.update(sessionId, (record) => {
          if (record.remote_mode_enabled !== true) {
            return;
          }
          if (record.remote_last_turn_id !== turnId) {
            return;
          }
          record.remote_input_owner = 'telegram';
          if (
            settlement.status &&
            settlement.status !== 'completed' &&
            settlement.outputText.length === 0
          ) {
            record.remote_status = 'degraded';
            record.remote_last_error = `remote turn ended with status ${settlement.status}`;
            return;
          }
          record.total_turns = nextTotalTurns;
          record.last_turn_output = settlement.outputText;
          record.remote_status = 'idle';
          record.remote_last_error = null;
        });
        await this.store.save();

        if (
          settlement.outputText.length > 0 &&
          this.publishTurnOutput
        ) {
          const stopMessageId = await this.publishTurnOutput(sessionId, {
            turnId,
            outputText: settlement.outputText,
            totalTurns: nextTotalTurns,
          });
          if (stopMessageId != null) {
            this.store.update(sessionId, (record) => {
              if (record.remote_mode_enabled !== true) {
                return;
              }
              if (record.remote_last_turn_id !== turnId) {
                return;
              }
              record.stop_message_id = stopMessageId;
            });
            await this.store.save();
          }
        }
      } catch (err) {
        logger.warn('Remote turn completion watch failed', {
          sessionId,
          threadId,
          turnId,
          error: (err as Error).message,
        });
        this.store.update(sessionId, (record) => {
          if (record.remote_mode_enabled !== true) {
            return;
          }
          if (record.remote_last_turn_id !== turnId) {
            return;
          }
          record.remote_status = 'degraded';
          record.remote_last_error = `failed to observe remote turn completion: ${(err as Error).message}`;
          record.remote_worker_last_error = (err as Error).message;
        });
        await this.store.save();
      }
    })();
  }

  private getDeferredLaunchPreferences(
    sessionId: string,
    record: SessionRecord
  ): DeferredLaunchPreferences | undefined {
    const resolved = record.pending_spawn_preferences
      ?? this.resolveDeferredLaunchPreferences?.(sessionId, record);
    if (!resolved) {
      return undefined;
    }
    if (
      resolved.model === undefined
      && resolved['approval-policy'] === undefined
      && resolved.sandbox === undefined
      && resolved.cwd === undefined
    ) {
      return undefined;
    }
    return resolved;
  }

  private async ensureManagedAttachment(
    sessionId: string,
    record: SessionRecord | undefined,
    endpoint: string,
    cwd: string,
    launchPrefs?: DeferredLaunchPreferences
  ): Promise<void> {
    if (record && isLocalManagedSession(record) && this.localConsoleRuntime) {
      await this.ensureLocalConsoleAttached(
        sessionId,
        endpoint,
        cwd,
        record.local_attachment_id,
        record.remote_worker_log_path,
        launchPrefs
      );
      return;
    }

    await this.ensureWorkerAttached(
      sessionId,
      endpoint,
      cwd,
      record?.remote_worker_pid,
      record?.remote_worker_log_path,
      launchPrefs
    );
  }
}
