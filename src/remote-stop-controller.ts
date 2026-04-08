import { AppServerClient, type RemoteInjectResult } from './app-server-client.js';
import { AppServerRuntimeManager } from './app-server-runtime.js';
import {
  hasRemoteSessionAttachment,
  resolveManagedMode,
} from './remote-mode.js';
import { SessionsStore } from './store.js';
import { logger } from './logger.js';
import { RemoteWorkerRuntimeManager } from './remote-worker-runtime.js';
import { LocalConsoleRuntimeManager } from './local-console-runtime.js';

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
  }

  async handleReply(
    sessionId: string,
    replyText: string
  ): Promise<RemoteReplyHandleResult> {
    const existing = this.store.get(sessionId);
    if (!existing || !hasRemoteSessionAttachment(existing.record)) {
      return { handled: false, mode: 'not-remote' };
    }

    try {
      if (existing.record.local_bridge_enabled === true && this.localConsoleRuntime) {
        await this.ensureLocalConsoleAttached(
          sessionId,
          existing.record.remote_endpoint!,
          existing.record.cwd,
          existing.record.local_attachment_id,
          existing.record.remote_worker_log_path
        );
      } else {
        await this.ensureWorkerAttached(
          sessionId,
          existing.record.remote_endpoint!,
          existing.record.cwd,
          existing.record.remote_worker_pid,
          existing.record.remote_worker_log_path
        );
      }

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
        existing.record.cwd,
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
        existing.record.cwd,
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
    knownLogPath?: string | null
  ): Promise<void> {
    const worker = await this.workerRuntime.ensureAttached({
      sessionId,
      endpoint,
      cwd,
      knownPid,
      knownLogPath,
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
    knownLogPath?: string | null
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
    try {
      await this.runtime.ensureAvailable(endpoint, cwd);
      const current = this.store.get(sessionId);
      await this.ensureWorkerAttached(
        sessionId,
        endpoint,
        cwd,
        current?.record.remote_worker_pid,
        current?.record.remote_worker_log_path
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
    try {
      const resumedAt = new Date().toISOString();
      const resumed = await this.client.resumeThread({
        endpoint,
        threadId,
        cwd,
      });
      resumedThreadId = resumed.threadId;

      const current = this.store.get(sessionId);
      await this.ensureWorkerAttached(
        sessionId,
        endpoint,
        cwd,
        current?.record.remote_worker_pid,
        current?.record.remote_worker_log_path
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
      await this.notifyDelivered(sessionId);
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

        const nextTotalTurns = existing.record.total_turns + 1;

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
}
