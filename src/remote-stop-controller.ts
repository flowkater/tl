import { AppServerClient, type RemoteInjectResult } from './app-server-client.js';
import { AppServerRuntimeManager } from './app-server-runtime.js';
import { hasRemoteSessionAttachment } from './remote-mode.js';
import { SessionsStore } from './store.js';

type LateReplyFallback = {
  handle(sessionId: string, replyText: string): Promise<boolean>;
};

type RemoteStopControllerOptions = {
  notifyDelivered?: (sessionId: string) => Promise<void>;
  notifyFailed?: (sessionId: string, error: string) => Promise<void>;
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

  constructor(
    private store: SessionsStore,
    private client: AppServerClient,
    private fallback: LateReplyFallback,
    private runtime: AppServerRuntimeManager,
    options: RemoteStopControllerOptions = {}
  ) {
    this.notifyDelivered = options.notifyDelivered;
    this.notifyFailed = options.notifyFailed;
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
      const result = await this.client.injectReply({
        endpoint: existing.record.remote_endpoint!,
        threadId: existing.record.remote_thread_id!,
        replyText,
      });

      await this.persistRemoteSuccess(sessionId, replyText, result);

      return {
        handled: true,
        mode: 'remote',
        turnId: result.turnId,
      };
    } catch (err) {
      const message = (err as Error).message;
      this.store.update(sessionId, (record) => {
        record.remote_last_injection_error = message;
      });
      await this.store.save();

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

  private async tryRestartAndRetry(
    sessionId: string,
    endpoint: string,
    threadId: string,
    cwd: string,
    replyText: string
  ): Promise<RemoteAttemptResult> {
    try {
      await this.runtime.ensureAvailable(endpoint, cwd);
      const retried = await this.client.injectReply({
        endpoint,
        threadId,
        replyText,
      });
      await this.persistRemoteSuccess(sessionId, replyText, retried);
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
        record.remote_last_injection_error = message;
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

      this.store.update(sessionId, (record) => {
        record.remote_thread_id = resumedThreadId;
        record.remote_last_resume_at = resumedAt;
        record.remote_last_resume_error = null;
      });
      await this.store.save();

      try {
        const retried = await this.client.injectReply({
          endpoint,
          threadId: resumedThreadId,
          replyText,
        });
        await this.persistRemoteSuccess(sessionId, replyText, retried, resumedThreadId);
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
          record.remote_last_injection_error = message;
          record.remote_last_resume_error = null;
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
        record.remote_last_resume_error = message;
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
    replyText: string,
    result: RemoteInjectResult,
    threadId?: string
  ): Promise<void> {
    this.store.update(sessionId, (record) => {
      record.status = 'active';
      record.last_user_message = replyText;
      record.remote_thread_id = threadId ?? record.remote_thread_id;
      record.remote_last_turn_id = result.turnId;
      record.remote_last_injection_at = new Date().toISOString();
      record.remote_last_injection_error = null;
      record.remote_last_resume_error = null;
    });
    await this.store.save();

    if (this.notifyDelivered) {
      await this.notifyDelivered(sessionId);
    }
  }
}
