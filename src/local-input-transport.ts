import type { LocalInputSource } from './types.js';
import { AppServerClient } from './app-server-client.js';

export interface LocalInputTransport {
  inject(
    sessionId: string,
    attachment: { attachmentId: string; endpoint: string },
    source: LocalInputSource,
    text: string
  ): Promise<void>;
}

export class AppServerLocalInputTransport implements LocalInputTransport {
  constructor(private client: AppServerClient) {}

  async inject(
    _sessionId: string,
    attachment: { attachmentId: string; endpoint: string },
    _source: LocalInputSource,
    text: string
  ): Promise<void> {
    await this.client.injectLocalInput({
      endpoint: attachment.endpoint,
      threadId: attachment.attachmentId,
      text,
    });
  }
}
