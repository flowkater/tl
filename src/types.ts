// ===== 영속화 상태 (sessions.json에 저장) =====
export type SessionStatus = 'pending' | 'active' | 'waiting' | 'completed' | 'failed';

export interface SessionRecord {
  status: SessionStatus;
  project: string;             // cwd
  cwd: string;                 // 작업 디렉토리
  model: string;               // 사용 모델
  topic_id: number;            // Telegram forum topic ID
  start_message_id: number;    // 시작 메시지 ID
  started_at: string;          // ISO 8601
  completed_at: string | null; // ISO 8601 or null
  stop_message_id: number | null;    // TG "작업 완료" 메시지 ID (reply 매칭용)
  reply_message_id: number | null;   // 마지막 답장 메시지 ID
  total_turns: number;         // 총 턴 수
  last_user_message: string;   // 마지막 사용자 메시지
  last_turn_output: string;    // 마지막 AI 출력
  last_progress_at: string | null;    // 마지막 working 메시지 전송 시각
  last_heartbeat_at: string | null;   // 마지막 heartbeat 전송 시각
  last_resume_ack_at: string | null;  // 마지막 resume ACK 전송 시각
  late_reply_text: string | null;     // waiting 이후 도착한 reply
  late_reply_received_at: string | null;
  late_reply_resume_started_at: string | null;
  late_reply_resume_error: string | null;
}

export interface SessionsFile {
  sessions: Record<string, SessionRecord>;  // key = session_id
  version: number;             // 스키마 버전 (기본 1)
}

// ===== 런타임 상태 (메모리 전용, 영속화 안 함) =====
export type RuntimeState = 'idle' | 'working' | 'waiting' | 'deliver';

// 매핑: RuntimeState → SessionStatus
// idle/working/deliver → active
// waiting → waiting
// (completed는 전이 종료 상태)

// ===== Codex 훅 페이로드 =====
export interface SessionStartPayload {
  session_id: string;
  hook_event_name: 'SessionStart';
  model: string;
  cwd: string;
  transcript_path: string;
  source: string;
}

export interface StopPayload {
  session_id: string;
  turn_id: string;
  hook_event_name: 'Stop';
  model: string;
  cwd: string;
  transcript_path: string;
  stop_hook_active: boolean;
  last_assistant_message: string;
}

export interface UserPromptSubmitPayload {
  session_id: string;
  hook_event_name: 'UserPromptSubmit';
  prompt?: string;
  cwd?: string;
}

// ===== Stop 훅 출력 (discriminated union) =====
export type HookOutput =
  | { decision: 'block'; reason: string }
  | { decision: 'continue' }
  | { decision: 'stop'; text: string };

// ===== 세션 관리자 인터페이스 =====
export interface SessionManager {
  handleSessionStart(args: {
    session_id: string;
    model: string;
    turn_id: string;
    project: string;
    cwd: string;
    last_user_message: string;
    is_reconnect?: boolean;
  }): Promise<void>;

  handleStopAndWait(args: {
    session_id: string;
    turn_id: string;
    last_message: string;
    total_turns: number;
    abort_signal?: AbortSignal;
  }): Promise<HookOutput>;

  handleComplete(args: {
    session_id: string;
    total_turns: number;
    duration: string;
  }): Promise<void>;

  handleResumeAcknowledged(args: {
    session_id: string;
  }): Promise<void>;

  handleWorking(args: {
    session_id: string;
  }): Promise<void>;
}

// ===== 데몬 설정 =====
export interface DaemonConfig {
  botToken: string;
  groupId: number;
  topicPrefix: string;         // 기본: '🔧'
  hookPort: number;            // 기본: 9877
  hookBaseUrl: string;         // 기본: 'http://localhost:9877'
  stopTimeout: number;         // 기본: 7200 (초)
  liveStream: boolean;         // 기본: false
  emojiReaction: string;       // 기본: '👍'
}

// ===== HTTP 응답 타입 =====
export interface SessionStartResponse {
  session_id: string;
  topic_id: number;
  status: 'ok';
}

export interface StopAckResponse {
  session_id: string;
  status: 'waiting';
}

export interface StatusResponse {
  daemon: 'running' | 'stopping';
  active_sessions: number;
  waiting_sessions: number;
  uptime_seconds: number;
}

export interface SessionsListResponse {
  sessions: Array<{
    session_id: string;
    status: SessionStatus;
    project: string;
    topic_id: number;
    total_turns: number;
    last_active: string;
  }>;
}
