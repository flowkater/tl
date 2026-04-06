import type { SessionRecord } from './types.js';

export type RemoteAttachmentArgs = {
  endpoint: string;
  threadId: string;
  lastTurnId?: string | null;
};

export function ensureRemoteSessionDefaults(record: SessionRecord): void {
  record.remote_mode_enabled ??= false;
  record.remote_endpoint ??= null;
  record.remote_thread_id ??= null;
  record.remote_last_turn_id ??= null;
  record.remote_last_injection_at ??= null;
  record.remote_last_injection_error ??= null;
}

export function hasRemoteSessionAttachment(record: SessionRecord): boolean {
  return (
    record.remote_mode_enabled === true &&
    typeof record.remote_endpoint === 'string' &&
    record.remote_endpoint.length > 0 &&
    typeof record.remote_thread_id === 'string' &&
    record.remote_thread_id.length > 0
  );
}

export function attachRemoteSession(
  record: SessionRecord,
  args: RemoteAttachmentArgs
): void {
  ensureRemoteSessionDefaults(record);
  record.remote_mode_enabled = true;
  record.remote_endpoint = args.endpoint;
  record.remote_thread_id = args.threadId;
  record.remote_last_turn_id = args.lastTurnId ?? null;
  record.remote_last_injection_error = null;
}

export function clearRemoteSession(record: SessionRecord): void {
  ensureRemoteSessionDefaults(record);
  record.remote_mode_enabled = false;
  record.remote_endpoint = null;
  record.remote_thread_id = null;
  record.remote_last_turn_id = null;
  record.remote_last_injection_at = null;
  record.remote_last_injection_error = null;
}
