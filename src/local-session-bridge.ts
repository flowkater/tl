import type { LocalBridgeState, LocalInputSource, SessionRecord } from './types.js';

type LocalAttachment = {
  attachmentId: string;
};

type QueueItem = {
  source: LocalInputSource;
  text: string;
};

type BridgeTransport = {
  inject(
    sessionId: string,
    attachment: LocalAttachment,
    source: LocalInputSource,
    text: string
  ): Promise<void>;
};

export function ensureLocalSessionDefaults(record: SessionRecord): void {
  record.local_bridge_enabled ??= false;
  record.local_bridge_state ??= null;
  record.local_input_queue_depth ??= 0;
  record.local_last_input_source ??= null;
  record.local_last_input_at ??= null;
  record.local_last_injection_error ??= null;
  record.local_attachment_id ??= null;
}

export class LocalSessionBridge {
  private attachments = new Map<string, LocalAttachment>();
  private queues = new Map<string, QueueItem[]>();
  private draining = new Set<string>();
  private states = new Map<string, LocalBridgeState>();

  constructor(private transport: BridgeTransport) {}

  attach(sessionId: string, attachment: LocalAttachment): void {
    this.attachments.set(sessionId, attachment);
    this.states.set(sessionId, 'attached');
  }

  getQueueDepth(sessionId: string): number {
    return this.queues.get(sessionId)?.length ?? 0;
  }

  getAttachmentState(sessionId: string): LocalBridgeState | null {
    return this.states.get(sessionId) ?? null;
  }

  async enqueue(sessionId: string, source: LocalInputSource, text: string): Promise<void> {
    const queue = this.queues.get(sessionId) ?? [];
    queue.push({ source, text });
    this.queues.set(sessionId, queue);
    await this.drain(sessionId);
  }

  private async drain(sessionId: string): Promise<void> {
    if (this.draining.has(sessionId)) {
      return;
    }

    const attachment = this.attachments.get(sessionId);
    if (!attachment) {
      this.states.set(sessionId, 'detached');
      this.queues.set(sessionId, []);
      return;
    }

    this.draining.add(sessionId);
    try {
      const queue = this.queues.get(sessionId) ?? [];
      while (queue.length > 0) {
        const next = queue[0];
        try {
          await this.transport.inject(sessionId, attachment, next.source, next.text);
          queue.shift();
          this.states.set(sessionId, 'attached');
        } catch {
          queue.shift();
          this.states.set(sessionId, 'detached');
          break;
        }
      }
      this.queues.set(sessionId, queue);
    } finally {
      this.draining.delete(sessionId);
    }
  }
}
