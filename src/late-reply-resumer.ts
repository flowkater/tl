import { ChildProcess, spawn } from 'child_process';
import { SessionsStore } from './store.js';
import { TelegramBot } from './telegram.js';
import { logger } from './logger.js';

type LaunchResumeArgs = {
  sessionId: string;
  replyText: string;
  cwd: string;
};

type LaunchResumeFn = (args: LaunchResumeArgs) => Promise<ChildProcess>;

type LateReplyResumerOptions = {
  groupId: number;
  launchResume?: LaunchResumeFn;
};

export function buildResumeCommandArgs(sessionId: string, replyText: string): string[] {
  return [
    'exec',
    'resume',
    '--dangerously-bypass-approvals-and-sandbox',
    sessionId,
    replyText,
  ];
}

export class LateReplyResumer {
  private store: SessionsStore;
  private tg: TelegramBot;
  private groupId: number;
  private launchResume: LaunchResumeFn;

  constructor(
    store: SessionsStore,
    tg: TelegramBot,
    options: LateReplyResumerOptions
  ) {
    this.store = store;
    this.tg = tg;
    this.groupId = options.groupId;
    this.launchResume = options.launchResume ?? defaultLaunchResume;
  }

  async handle(sessionId: string, replyText: string): Promise<boolean> {
    const existing = this.store.get(sessionId);
    if (!existing) {
      return false;
    }

    if (existing.record.late_reply_resume_started_at) {
      return false;
    }

    const receivedAt = new Date().toISOString();
    this.store.update(sessionId, (record) => {
      record.late_reply_text = replyText;
      record.late_reply_received_at = receivedAt;
      record.late_reply_resume_started_at = receivedAt;
      record.late_reply_resume_error = null;
    });
    await this.store.save();

    try {
      const child = await this.launchResume({
        sessionId,
        replyText,
        cwd: existing.record.cwd,
      });

      this.attachExitHandler(sessionId, existing.record.topic_id, receivedAt, child);
      child.unref();
      try {
        await this.tg.sendLateReplyResumeStartedMessage(
          this.groupId,
          existing.record.topic_id
        );
      } catch (err) {
        logger.warn('Late reply resume start notice failed', {
          sessionId,
          error: (err as Error).message,
        });
      }
      return true;
    } catch (err) {
      await this.markLaunchFailed(
        sessionId,
        existing.record.topic_id,
        receivedAt,
        (err as Error).message
      );
      return true;
    }
  }

  private attachExitHandler(
    sessionId: string,
    topicId: number,
    startedAt: string,
    child: ChildProcess
  ): void {
    child.once('exit', (code, signal) => {
      if (code === 0) {
        void this.clearLaunchState(sessionId, startedAt);
        return;
      }

      const error = signal
        ? `resume exited with signal ${signal}`
        : `resume exited with code ${code ?? 'unknown'}`;
      void this.markLaunchFailed(sessionId, topicId, startedAt, error);
    });
  }

  private async clearLaunchState(sessionId: string, startedAt: string): Promise<void> {
    const existing = this.store.get(sessionId);
    if (!existing || existing.record.late_reply_resume_started_at !== startedAt) {
      return;
    }

    this.store.update(sessionId, (record) => {
      record.late_reply_resume_started_at = null;
      record.late_reply_resume_error = null;
    });
    await this.store.save();
  }

  private async markLaunchFailed(
    sessionId: string,
    topicId: number,
    startedAt: string,
    error: string
  ): Promise<void> {
    const existing = this.store.get(sessionId);
    if (
      existing &&
      existing.record.late_reply_resume_started_at === startedAt
    ) {
      this.store.update(sessionId, (record) => {
        record.late_reply_resume_started_at = null;
        record.late_reply_resume_error = error;
      });
      await this.store.save();
    }

    logger.warn('Late reply resume failed', { sessionId, error });
    try {
      await this.tg.sendLateReplyResumeFailedMessage(this.groupId, topicId, error);
    } catch (err) {
      logger.warn('Late reply resume failure notice failed', {
        sessionId,
        error: (err as Error).message,
      });
    }
  }
}

async function defaultLaunchResume(args: LaunchResumeArgs): Promise<ChildProcess> {
  return new Promise<ChildProcess>((resolve, reject) => {
    const child = spawn(
      'codex',
      buildResumeCommandArgs(args.sessionId, args.replyText),
      {
        cwd: args.cwd,
        detached: true,
        stdio: 'ignore',
      }
    );

    child.once('spawn', () => {
      resolve(child);
    });
    child.once('error', reject);
  });
}
