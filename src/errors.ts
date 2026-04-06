// ===== 에러 타입 정의 =====
export type TlErrorCode =
  | 'CONFIG_MISSING'
  | 'CONFIG_INVALID'
  | 'HOOKS_INVALID'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_EXISTS'
  | 'TRANSITION_INVALID'
  | 'TG_API_ERROR'
  | 'TG_REPLY_MISMATCH'
  | 'STORE_CORRUPT'
  | 'DAEMON_RUNNING'
  | 'HOOK_TIMEOUT'
  | 'REPLY_QUEUE_FULL';

export class TlError extends Error {
  code: TlErrorCode;
  cause?: Error;

  constructor(message: string, code: TlErrorCode, cause?: Error) {
    super(message);
    this.name = 'TlError';
    this.code = code;
    this.cause = cause;
  }
}
