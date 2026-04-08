import type { RemoteSessionStatus, SessionMode, SessionRecord } from './types.js';

export type RemoteAttachmentArgs = {
  endpoint: string;
  threadId: string;
  lastTurnId?: string | null;
};

export function ensureRemoteSessionDefaults(record: SessionRecord): void {
  record.mode ??= record.remote_mode_enabled ? 'remote-managed' : 'local';
  record.remote_mode_enabled ??= false;
  record.remote_input_owner ??= record.remote_mode_enabled ? 'telegram' : null;
  record.remote_status ??= inferRemoteStatus(record);
  record.remote_endpoint ??= null;
  record.remote_thread_id ??= null;
  record.remote_last_turn_id ??= null;
  record.remote_last_injection_at ??= null;
  record.remote_last_injection_error ??= null;
  record.remote_last_resume_at ??= null;
  record.remote_last_resume_error ??= null;
  record.remote_last_error ??=
    record.remote_last_resume_error ??
    record.remote_last_injection_error ??
    null;
  record.remote_last_recovery_at ??= record.remote_last_resume_at ?? null;
  record.remote_worker_pid ??= null;
  record.remote_worker_log_path ??= null;
  record.remote_worker_started_at ??= null;
  record.remote_worker_last_error ??= null;
}

export function isLocalManagedSession(record: SessionRecord): boolean {
  return record.mode === 'local-managed' || record.local_bridge_enabled === true;
}

export function resolveManagedMode(record: SessionRecord): SessionMode {
  return isLocalManagedSession(record) ? 'local-managed' : 'remote-managed';
}

export function hasRemoteSessionAttachment(record: SessionRecord): boolean {
  return (
    (record.mode === 'remote-managed' || record.remote_mode_enabled === true) &&
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
  record.mode = resolveManagedMode(record);
  record.remote_mode_enabled = true;
  record.remote_input_owner = isLocalManagedSession(record) ? 'tui' : 'telegram';
  record.remote_status = 'attached';
  record.remote_endpoint = args.endpoint;
  record.remote_thread_id = args.threadId;
  record.remote_last_turn_id = args.lastTurnId ?? null;
  record.remote_last_injection_error = null;
  record.remote_last_resume_at = null;
  record.remote_last_resume_error = null;
  record.remote_last_error = null;
  record.remote_last_recovery_at = null;
  record.remote_worker_pid = null;
  record.remote_worker_log_path = null;
  record.remote_worker_started_at = null;
  record.remote_worker_last_error = null;
}

export function clearRemoteSession(record: SessionRecord): void {
  ensureRemoteSessionDefaults(record);
  record.mode = 'local';
  record.remote_mode_enabled = false;
  record.remote_input_owner = null;
  record.remote_status = null;
  record.remote_endpoint = null;
  record.remote_thread_id = null;
  record.remote_last_turn_id = null;
  record.remote_last_injection_at = null;
  record.remote_last_injection_error = null;
  record.remote_last_resume_at = null;
  record.remote_last_resume_error = null;
  record.remote_last_error = null;
  record.remote_last_recovery_at = null;
  record.remote_worker_pid = null;
  record.remote_worker_log_path = null;
  record.remote_worker_started_at = null;
  record.remote_worker_last_error = null;
}

function inferRemoteStatus(record: SessionRecord): RemoteSessionStatus | null {
  if (
    typeof record.remote_thread_id === 'string' &&
    record.remote_thread_id.length > 0 &&
    typeof record.remote_endpoint === 'string' &&
    record.remote_endpoint.length > 0
  ) {
    if (record.remote_last_error) {
      return 'degraded';
    }
    return 'attached';
  }
  return null;
}
