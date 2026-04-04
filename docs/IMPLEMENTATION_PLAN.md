# tl — Codex ↔ Telegram Bridge: 구현 계획 (Phase 1~3)

> REQUIREMENTS.md 기반. 서브에이전트 3회 리뷰(1차 아키텍처, 2차 TS 구현, 3차 요구사항 커버리지) 피드백 반영 완료.
> 바로 구현에 착수할 수 있을 만큼 상세함.

---

## 프로젝트 구조 (최종)

```
tl/
├── src/
│   ├── daemon.ts              — 메인 서버 초기화 + HTTP 라우팅 + 시그널 핸들링
│   ├── session-manager.ts     — 세션 비즈니스 로직 (상태 전이 + TG 연동 조합)
│   ├── telegram.ts            — grammY 봇 래퍼 (토픽/메시지/답장/이모지)
│   ├── config.ts              — 설정 로드/검증/저장 (~/.tl/config.json)
│   ├── store.ts               — sessions.json 파일 기반 영속화 (atomic write)
│   ├── reply-queue.ts         — reply 파일 큐 + in-memory pending 관리
│   ├── types.ts               — 공유 타입 정의
│   ├── errors.ts              — TlError 커스텀 에러 타입
│   ├── logger.ts              — 로거 (stdout + 파일)
│   └── hooks/
│       ├── session-start.ts   — SessionStart 훅 CLI (stdin → HTTP POST)
│       └── stop-and-wait.ts   — Stop 훅 CLI (stdin → POST + long-poll → stdout)
├── bin/
│   └── tl                     — CLI 진입점 (start/stop/status/init/config/cleanup)
├── docs/
│   ├── REQUIREMENTS.md
│   └── IMPLEMENTATION_PLAN.md
├── templates/
│   └── hooks.json             — Codex hook 설정 템플릿
├── package.json
├── tsconfig.json
└── README.md
```

---

## 타입 정의 (types.ts)

```typescript
// ===== 영속화 상태 (sessions.json에 저장) =====
export type SessionStatus = 'active' | 'waiting' | 'completed';

export interface SessionRecord {
  topic_id: number;
  chat_id: number;
  project: string;             // cwd
  created_at: string;          // ISO 8601
  last_active: string;         // ISO 8601
  status: SessionStatus;
  last_turn_id: string;
  total_turns: number;
  stop_message_id?: number;    // TG에서 보낸 "작업 완료" 메시지 ID (reply 매칭용)
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

// ===== Stop 훅 출력 (discriminated union) =====
export type HookOutput =
  | { decision: 'block'; reason: string }
  | { decision: 'continue' };

// ===== 데몬 설정 =====
export interface DaemonConfig {
  botToken: string;
  groupId: number;
  topicPrefix: string;         // 기본: '🔧'
  hookPort: number;            // 기본: 9877
  stopTimeout: number;         // 기본: 3600 (초)
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
```

---

## 커스텀 에러 (errors.ts)

```typescript
export class TlError extends Error {
  constructor(
    message: string,
    public code: TlErrorCode,
    public cause?: Error,
  ) {
    super(message);
    this.name = 'TlError';
  }
}

export type TlErrorCode =
  | 'CONFIG_MISSING'       // 설정 파일 없음/불완전
  | 'CONFIG_INVALID'       // 설정 값 유효하지 않음
  | 'SESSION_NOT_FOUND'    // 세션 ID 없음
  | 'SESSION_EXISTS'       // 동일 세션 이미 waiting 중
  | 'TRANSITION_INVALID'   // 잘못된 상태 전이
  | 'TG_API_ERROR'         // Telegram API 호출 실패
  | 'TG_REPLY_MISMATCH'    // Reply 매칭 실패
  | 'STORE_CORRUPT'        // sessions.json 파싱 실패
  | 'DAEMON_RUNNING'       // 데몬 이미 실행 중
  | 'HOOK_TIMEOUT'         // 훅 타임아웃
  | 'REPLY_QUEUE_FULL';    // reply 큐 과부하
```

---

## 설정 관리 (config.ts)

### 파일 위치
- `~/.tl/config.json`
- `TL_CONFIG_DIR` env var로 오버라이드 가능

### 기본값
```json
{
  "botToken": "",
  "groupId": 0,
  "topicPrefix": "🔧",
  "hookPort": 9877,
  "stopTimeout": 3600,
  "liveStream": false,
  "emojiReaction": "👍"
}
```

### 구현 상세
- `loadConfig()`: 파일 읽기 → 기본값과 shallow merge → 필수 필드 검증
  - `botToken`: 빈 문자열이면 `CONFIG_MISSING`
  - `groupId`: 0이면 `CONFIG_MISSING`
- `saveConfig(partial: Partial<DaemonConfig>)`: 기존 파일에 partial merge → atomic write
- `getConfigDir()`: `TL_CONFIG_DIR` || `~/.tl`
- 검증 실패 시 `TlError` throw + process.exit(1)

---

## 세션 저장소 (store.ts)

### 파일 위치
- `~/.tl/sessions.json`
- 백업: `~/.tl/sessions.json.bak` (save 직전 복사)
- 아카이브: `~/.tl/sessions-archive.json` (completed 세션 이동)

### 구현 상세
```typescript
class SessionsStore {
  private data: SessionsFile;
  private filePath: string;

  async load(): Promise<void>
  // 파일 읽기 → JSON 파싱 → 구조 검증
  // 파일 없으면 { sessions: {}, version: 1 }로 초기화
  // 파싱 실패 시 .bak 시도 → 둘 다 실패 시 초기화 + STORE_CORRUPT 경고

  async save(): Promise<void>
  // 1. 현재 파일을 .bak으로 복사
  // 2. 임시 파일에 JSON.stringify(data, null, 2) 쓰기
  // 3. fsync 호출 (macOS 안전성)
  // 4. rename으로 atomic 교체

  get(sessionId: string): SessionRecord | undefined
  set(sessionId: string, record: SessionRecord): void  // in-memory only
  delete(sessionId: string): void
  update(sessionId: string, partial: Partial<SessionRecord>): void
  listActive(): Array<{ id: string; record: SessionRecord }>
  // status가 'active' 또는 'waiting'인 세션만 반환

  listByStatus(status: SessionStatus): Array<{ id: string; record: SessionRecord }>

  async archiveCompleted(maxAgeDays?: number): Promise<number>
  // completed 세션 중 N일 이상 된 것을 sessions-archive.json으로 이동
  // 이동한 세션 수 반환
}
```

### 동시성
- Node.js 싱글스레드이므로 동일 프로세스 내 race condition 없음
- in-memory `data`가 single source of truth, `save()`는 스냅샷 직렬화
- save() 완료 전 get()은 최신 in-memory 데이터 반환 (일관성 보장)

---

## Reply 큐 (reply-queue.ts) — ⚠️ Phase 2로 당김

### 목적
데몬 크래시 시 reply 손실 방지 + 동시 Stop 훅 race condition 해결

### 구현 상세
```typescript
interface PendingEntry {
  sessionId: string;
  resolve: (output: HookOutput) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  createdAt: number;         // Date.now() — cleanup용
}

class ReplyQueue {
  private pending = new Map<string, PendingEntry>();
  private fileQueue: string; // ~/.tl/reply-queue/ 디렉토리

  // stop-and-wait 훅이 호출될 때: Promise 반환, timeout 시 자동 resolve
  async waitFor(sessionId: string, timeoutSec: number): Promise<HookOutput>

  // TG에서 reply 도착 시 호출: pending resolve 또는 파일 큐에 저장
  deliver(sessionId: string, replyText: string): void
  // pending에 있으면 → resolve
  // pending에 없으면 → 파일 큐에 저장 (데몬 재시작 시 처리)

  // 데몬 재시작 시: 파일 큐에 쌓인 reply 처리
  async processFileQueue(): Promise<void>

  // 주기적 cleanup: timeout 지났거나 consumer가 없는 entry 정리
  startCleanupInterval(intervalMs?: number): void
  // 30초마다 실행, createdAt + timeout > now 인 entry 정리
}
```

### 파일 큐 구조
```
~/.tl/reply-queue/
├── <sessionId>-<timestamp>.json
```
```json
{
  "sessionId": "abc123",
  "replyText": "좋아, 계속해",
  "createdAt": "2026-04-04T23:30:00Z"
}
```

---

## Telegram 봇 래퍼 (telegram.ts)

### 구현 상세
```typescript
class TelegramBot {
  private bot: Bot;  // grammY
  private config: DaemonConfig;

  async init(): Promise<void>
  // Bot 인스턴스 생성, polling 시작
  // bot.catch()로 전역 에러 핸들링 (연결 끊김 감지)
  // on('message')로 모든 메시지 리스닝 → session-manager로 전달

  async createTopic(project: string): Promise<number>
  // project는 cwd의 basename
  // 토픽명: `${prefix} ${project} — ${YYYY-MM-DD HH:mm}`
  // Telegram의 createForumTopic API 사용
  // topic_id 반환

  async sendStartMessage(chatId: number, topicId: number, sessionId: string, model: string): Promise<number>
  // 메시지 ID 반환 (reply 매칭용으로 저장)

  async sendStopMessage(chatId: number, topicId: number, turnId: string, lastMessage: string, totalTurns: number): Promise<number>
  // lastMessage에서 첫 500자 추출 (초과 시 말줄임)
  // 메시지 ID 반환 (stop_message_id로 저장)

  async sendCompleteMessage(chatId: number, topicId: number, totalTurns: number, duration: string): Promise<void>

  async sendReconnectMessage(chatId: number, topicId: number, sessionId: string): Promise<void>

  async sendReplyFallbackMessage(chatId: number, topicId: number): Promise<void>
  // Reply 매칭 실패 시: "⚠️ 작업 완료 메시지에 Reply해주세요"

  async addReaction(chatId: number, messageId: number, emoji: string): Promise<void>
}
```

### Reply 매칭 로직
```typescript
// on('message') 리스너에서:
function handleMessage(message: Message) {
  // 1. message.message_thread_id가 없는 경우 → General 토픽, 무시
  // 2. message.reply_to_message가 있는 경우:
  //    - reply_to_message.message_id를 sessions.json의 stop_message_id와 매칭
  //    - 매칭 성공 → 해당 세션의 reply-queue로 deliver
  //    - 매칭 실패 → sendReplyFallbackMessage()
  // 3. message.reply_to_message가 없는 일반 메시지:
  //    - 해당 토픽에 active/waiting 세션이 있으면 → sendReplyFallbackMessage()
  //    - 없으면 무시
}
```

### 핵심: 동적 리스너 금지
- `on('message')`는 **하나만** 등록 (데몬 초기화 시)
- 메시지 핸들러 내에서 session_id lookup은 sessions.json에서 message_thread_id로 역조회
- 세션별 동적 리스너 등록 금지 (메모리 누수 + 관리 복잡)

---

## 세션 관리자 (session-manager.ts)

### 역할
상태 전이 검증 + TG 연동 조합. 별도 state-machine.ts 모듈 없음.

### 상태 전이 규칙
```
active:
  - session-start → active (이미 active면 SESSION_EXISTS 에러)
  - stop → waiting (stop_message_id 저장)
  - complete → completed

waiting:
  - reply-deliver → active (stop-and-wait에 HookOutput 전달)
  - timeout → active ({decision: 'continue'} 전달)

completed:
  - (종료 상태, 전이 없음)
```

### 구현 상세
```typescript
class SessionManager {
  private tg: TelegramBot;
  private store: SessionsStore;
  private replyQueue: ReplyQueue;
  private config: DaemonConfig;

  async startSession(payload: SessionStartPayload): Promise<SessionStartResponse>
  // 1. 동일 session_id가 active/waiting인지 확인 → 있으면 SESSION_EXISTS
  // 2. TG 토픽 생성
  // 3. 세션 레코드 생성 (status: 'active') → store.set()
  // 4. 시작 메시지 전송
  // 5. store.save()
  // 6. {session_id, topic_id, status: 'ok'} 반환

  async handleStop(payload: StopPayload): Promise<void>
  // 1. 세션 조회 → 없으면 SESSION_NOT_FOUND
  // 2. 세션이 이미 waiting이면 SESSION_EXISTS (동시 Stop 훅 방지)
  // 3. total_turns++, last_turn_id, last_active 업데이트
  // 4. Stop 메시지 전송 → stop_message_id 저장
  // 5. status를 'waiting'으로 변경
  // 6. transcript 파싱 → 수정 파일 목록 추출 (최소한: file_write tool 호출 패턴)
  // 7. store.save()
  // 8. replyQueue.waitFor() 시작 (백그라운드)

  async deliverReply(sessionId: string, replyText: string): Promise<void>
  // 1. 세션 상태 확인 (waiting이 아니면 TRANSITION_INVALID)
  // 2. status를 'active'로 변경
  // 3. replyQueue.deliver()로 pending resolve
  // 4. TG 답장 메시지에 이모지 반응
  // 5. store.save()

  async completeSession(sessionId: string): Promise<void>
  // 1. status를 'completed'로 변경
  // 2. 종료 메시지 전송
  // 3. store.save()

  async restoreSessions(): Promise<void>
  // 1. store.listActive()로 active/waiting 세션 로드
  // 2. 각 세션의 topic_id로 TG 토픽 존재 확인
  //    - 토픽 존재 → "🔌 재연결 완료" 메시지 전송
  //    - 토피 없음 → 세션을 'completed'로 마킹
  // 3. replyQueue.processFileQueue()로 크래시 중 쌓인 reply 처리
  // 4. store.save()
}
```

### Transcript 파싱 (최소한)
- `transcript_path`의 JSONL 파일에서 `tool_use`/`tool_result` 메시지 파싱
- `file_write`, `write`, `patch` 등 파일 수정 tool 호출 감지
- 수정된 파일 목록 (최대 5개) 추출 → Stop 메시지에 포함
- Phase 3에서 개선 (더 정확한 파싱)

---

## 훅 CLI

### session-start.ts
```
역할: Codex의 SessionStart 훅에서 호출
동작:
1. stdin에서 JSON 읽기 (SessionStartPayload)
2. POST http://localhost:{port}/hook/session-start
3. 응답의 session_id, topic_id를 stdout에 로그 출력
4. exit 0 (논블로킹)
```

### stop-and-wait.ts — ⚠️ POST/GET 통합
```
역할: Codex의 Stop 훅에서 호출
동작:
1. stdin에서 JSON 읽기 (StopPayload)
2. POST http://localhost:{port}/hook/stop-and-wait (body에 StopPayload)
3. HTTP 응답 대기 (long-polling, 서버 측에서 reply 도착 또는 timeout까지 연결 유지)
4. 응답으로 HookOutput JSON 받음
5. JSON을 stdout 출력
6. exit 0

에러 처리:
- HTTP 연결 끊김/503 → {decision: 'continue'} stdout 출력 후 exit 0
- 404/SESSION_NOT_FOUND → {decision: 'continue'} + stderr에 경고 후 exit 0
- 기타 에러 → stderr에 에러 출력, exit 1
```

---

## 데몬 (daemon.ts)

### 초기화 순서
1. 설정 로드 + 검증
2. SessionsStore 초기화 + load()
3. ReplyQueue 초기화 + cleanup interval 시작
4. TelegramBot 초기화 + polling 시작
5. 이전 활성 세션 복원 (restoreSessions)
6. Hono HTTP 서버 시작
7. PID 파일 기록 (`fs.open` + `wx` 플래그 — race condition 방지)
8. SIGINT/SIGTERM 핸들러 등록

### HTTP 라우트 (Hono)

| 메서드 | 경로 | 핸들러 | 설명 |
|--------|------|--------|------|
| POST | `/hook/session-start` | sessionManager.startSession() | SessionStart 훅 |
| POST | `/hook/stop-and-wait` | sessionManager.handleStop() + replyQueue.waitFor() | **단일 엔드포인트** long-polling |
| POST | `/hook/mock-reply` | replyQueue.deliver() | PoC 테스트용 (Phase 1) |
| GET | `/status` | 데몬 상태 | StatusResponse |
| GET | `/sessions` | 세션 목록 | SessionsListResponse |

### stop-and-wait 엔드포인트 상세
```typescript
app.post('/hook/stop-and-wait', async (c) => {
  const payload = await c.req.json<StopPayload>();
  const { session_id } = payload;

  // 1. 세션 처리 (TG 메시지 전송, 상태 변경)
  await sessionManager.handleStop(payload);

  // 2. Long-polling으로 reply 대기
  // AbortSignal로 클라이언트 연결 끊김 감지
  const signal = c.req.raw.signal;
  const timeoutMs = config.stopTimeout * 1000;

  try {
    const output = await replyQueue.waitFor(session_id, timeoutMs);
    return c.json(output);
  } catch (err) {
    if (signal?.aborted) {
      // 클라이언트 연결 끊김 → continue 반환 (Codex가 그냥 계속)
      return c.json({ decision: 'continue' as const });
    }
    throw err;
  }
});
```

### Graceful shutdown
```typescript
async function gracefulShutdown(signal: string) {
  console.log(`Received ${signal}, shutting down...`);

  // 1. 모든 pending long-polling에 {decision: 'continue'} 반환
  replyQueue.shutdown();

  // 2. TG 봇 polling 정지
  await tgBot.close();

  // 3. 활성 세션 상태 저장
  await store.save();

  // 4. HTTP 서버 close
  await server.close();

  // 5. PID 파일 삭제
  fs.unlinkSync(pidFile);

  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
```

### ReplyQueue.shutdown()
```typescript
shutdown() {
  for (const [sessionId, entry] of this.pending) {
    entry.resolve({ decision: 'continue' });
    clearTimeout(entry.timer);
  }
  this.pending.clear();
}
```

---

## CLI 진입점 (bin/tl)

```bash
#!/usr/bin/env node
```

### 명령어
| 명령어 | 동작 |
|--------|------|
| `tl start` | 데몬 시작 (PID 파일 exclusive create로 중복 실행 방지) |
| `tl stop` | 데몬에 SIGTERM 전송 (stale PID 확인 포함) |
| `tl status` | 데몬 상태 + 활성/대기 세션 목록 |
| `tl init` | templates/hooks.json을 `~/.codex/hooks.json`에 설치 |
| `tl config set KEY=VALUE` | 설정 저장 |
| `tl config get [KEY]` | 설정 조회 |
| `tl cleanup [--days=30]` | N일 이상 completed 세션 아카이브 |
| `tl hook-session-start` | 내부용: SessionStart 훅 CLI |
| `tl hook-stop-and-wait` | 내부용: Stop 훅 CLI (single endpoint long-poll) |

### PID 기반 데몬 관리 — race condition 방지
```typescript
// tl start:
function acquirePidFile(): number {
  const pidFile = path.join(getConfigDir(), 'daemon.pid');
  try {
    // 'wx' = exclusive create, 파일이 있으면 에러
    const fd = fs.openSync(pidFile, 'wx');
    fs.writeSync(fd, process.pid.toString());
    fs.closeSync(fd);
    return 0; // 성공
  } catch (err) {
    // 파일이 이미 있음
    const existingPid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim());
    // 프로세스存活 확인
    try {
      process.kill(existingPid, 0);
      return existingPid; // 아직 실행 중
    } catch {
      // stale PID — 삭제 후 재시도
      fs.unlinkSync(pidFile);
      return acquirePidFile(); // 재귀 호출 (1회)
    }
  }
}

// tl stop:
function stopDaemon() {
  const pidFile = path.join(getConfigDir(), 'daemon.pid');
  if (!fs.existsSync(pidFile)) {
    console.log('Daemon is not running');
    return;
  }
  const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim());
  try {
    process.kill(pid, 'SIGTERM');
    console.log(`Sent SIGTERM to daemon (PID: ${pid})`);
  } catch {
    // 프로세스 없음 — stale PID
    fs.unlinkSync(pidFile);
    console.log('Daemon was not running (stale PID file removed)');
  }
}
```

### tl init — hooks.json 설치
```
1. ~/.codex/hooks.json 읽기
2. 파일 없으면 템플릿 복사
3. 파일 있으면:
   - 기존 hooks에서 SessionStart, Stop 훅만 tl 버전으로 업데이트
   - 다른 훅 설정은 보존
   - `tl init --force`로 전체 덮어쓰기 옵션 제공
```

---

## TG 메시지 포맷 상세

### 세션 시작
```
🟢 새 세션 — {project}
session: {session_id}
모델: {model}
```

### 작업 완료 (Stop)
```
✅ Turn #{total_turns} 완료

{last_assistant_message (최대 500자)}

{수정 파일 목록 (있으면)}

다음에는 뭘 할까?
```

### 세션 종료
```
🏁 세션 종료
총 {total_turns}턴 · {소요 시간}
```

### 재연결
```
🔌 재연결 완료 — 이전 세션 복원됨
session: {session_id}
```

### Reply 매칭 실패 시
```
⚠️ 작업 완료 메시지에 Reply해주세요.
```

---

## Phase 1: PoC (단일 세션, 단일 턴)

### 목표
Codex 훅 → 데몬 → 콘솔 출력 → tl-hook-stop-and-wait 응답 → exit 0의 전체 파이프라인 검증

### 구현 항목
1. `types.ts` — 전체 타입 정의
2. `errors.ts` — TlError + 에러 코드
3. `config.ts` — 설정 로드/검증/저장
4. `store.ts` — sessions.json读写 (atomic write + fsync)
5. `logger.ts` — stdout + 파일 로그
6. `daemon.ts` — HTTP 서버 (hono + `@hono/node-server`)
7. `hooks/session-start.ts` — stdin 읽기 → POST
8. `hooks/stop-and-wait.ts` — stdin 읽기 → POST + long-poll → stdout
9. `bin/tl` — start/stop/status CLI (PID 관리 포함)
10. `package.json`, `tsconfig.json` — 프로젝트 설정
11. `POST /hook/mock-reply` — PoC 테스트용 mock reply API

### TG 연동 없음. 데몬은 훅 페이로드를 받아 콘솔에 로그만 출력.

### PoC 테스트 시나리오
```bash
# 1. 데몬 시작
tl start

# 2. SessionStart 훅 시뮬레이션
echo '{"session_id":"test-1","hook_event_name":"SessionStart","model":"gpt-5","cwd":"/tmp/test","transcript_path":"/dev/null","source":"cli"}' \
  | tl hook-session-start

# 3. Stop 훅 시뮬레이션 + long-polling (별도 터미널에서)
echo '{"session_id":"test-1","turn_id":"turn-1","hook_event_name":"Stop","model":"gpt-5","cwd":"/tmp/test","transcript_path":"/dev/null","stop_hook_active":false,"last_assistant_message":"작업 완료!"}' \
  | tl hook-stop-and-wait
# → long-polling 대기 중...

# 4. Mock reply 전송 (세 번째 터미널)
curl -X POST 'http://localhost:9877/hook/mock-reply?session_id=test-1' \
  -d '{"replyText":"좋아, 계속해"}'
# → stop-and-wait이 {"decision":"block","reason":"좋아, 계속해"} 출력 후 exit 0
```

---

## Phase 2: TG 연동

### 목표
Telegram 그룹에서 토픽 자동 생성, 메시지 전송, 답장 수신, 이모지 반응, reply 파일 큐

### 구현 항목 (Phase 1에 추가)
1. `telegram.ts` — grammY 봇 래퍼 전체 구현
2. `reply-queue.ts` — reply 파일 큐 + cleanup interval
3. `session-manager.ts` — 세션 관리 통합 (TG 연동 + 상태 전이)
4. `daemon.ts` — TG 봇 통합, restoreSessions
5. `bin/tl` — init/config/cleanup 명령어 추가
6. `templates/hooks.json` — 훅 템플릿
7. Transcript 최소 파싱 (수정 파일 목록 추출)

### 의존성 추가
```json
{
  "grammy": "^1.21.0",
  "hono": "^4.0.0",
  "@hono/node-server": "^1.8.0"
}
```

### TG 봇 설정
- BotFather에서 봇 생성 → 토픽 지원 그룹에 초대 → 어드민 권한 부여
- `tl config set BOT_TOKEN=xxx GROUP_ID=yyy`
- `tl init` → hooks.json 설치 (기존 파일 merge)

### Reply 파일 큐 (Phase 2로 당김)
- 데몬 크래시 시 reply를 `~/.tl/reply-queue/`에 파일로 저장
- 재시작 시 `processFileQueue()`로 처리
- pendingReplies cleanup interval (30초)

### 테스트 시나리오
```bash
# 1. 설정
tl config set BOT_TOKEN=123456:ABC-DEF GROUP_ID=-1001234567890

# 2. 데몬 시작
tl start

# 3. Codex에서 codex 명령 실행 → SessionStart 훅 자동 발동
# → TG에 새 토픽 생성 + 환영 메시지

# 4. Codex 작업 완료 → Stop 훅 발동
# → TG 토픽에 완료 메시지 (수정 파일 목록 포함)
# → tl-hook-stop-and-wait이 long-polling으로 대기

# 5. TG 토픽에서 완료 메시지에 Reply
# → 데몬이 reply 감지 → long-polling 응답 → hook exit 0
# → Codex가 답장을 새 입력으로 받아 계속
# → TG 답장 메시지에 👍 반응

# 6. Reply가 아닌 일반 메시지 → "⚠️ Reply해주세요" 안내

# 7. 데몬 강제 종료 → TG reply → 재시작 → 파일 큐 처리 검증
```

---

## Phase 3: 멀티 세션 + 내구성

### 목표
동시 세션 2개 이상 지원, 데몬 재시작 시 복원, graceful shutdown 완성

### 구현 항목 (Phase 2에 추가)
1. `session-manager.ts` — 멀티 세션 격리 검증 강화
2. `store.ts` — archiveCompleted() 구현
3. `daemon.ts` — restoreSessions 완성, graceful shutdown 완성
4. `bin/tl` — cleanup 명령어 완성

### 동시 세션 격리
- session_id → topic_id 엄격 매핑
- handleMessage에서 message_thread_id로 세션 역조회
- ReplyQueue는 session_id별 pending 관리
- 동일 session에 대해 이미 waiting 중인 경우 SESSION_EXISTS 에러

### 데몬 재시작 시 복원
1. sessions.json에서 active/waiting 세션 로드
2. 각 세션의 topic_id로 TG 토픽 존재 확인 (getForumTopic 시도)
3. 존재하면 "🔌 재연결 완료" 메시지 전송
4. 없으면 세션을 completed로 마킹
5. 파일 큐에 쌓인 reply 처리

### Graceful shutdown 완성
- SIGINT/SIGTERM 시:
  1. 모든 pending long-polling에 `{decision: 'continue'}` 반환
  2. TG 봇 polling 정지 (진행 중인 API 호출 완료 대기)
  3. sessions.json 저장 (atomic write)
  4. HTTP 서버 close
  5. PID 파일 삭제

### sessions.json 관리
- completed 세션은 `tl cleanup --days=30`으로 아카이브
- sessions.json에는 active/waiting만 보관 (성능 최적화)
- sessions-archive.json에 completed 세션 이동

---

## 빌드/실행 설정

### package.json
```json
{
  "name": "tl-codex-bridge",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/daemon.ts",
    "build": "tsc",
    "start": "node dist/daemon.js",
    "tl": "tsx bin/tl"
  },
  "bin": {
    "tl": "./bin/tl"
  },
  "dependencies": {
    "grammy": "^1.21.0",
    "hono": "^4.0.0",
    "@hono/node-server": "^1.8.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "tsx": "^4.7.0",
    "typescript": "^5.4.0"
  },
  "engines": {
    "node": ">=20.0.0"
  }
}
```

### tsconfig.json
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": false
  },
  "include": ["src/**/*", "bin/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

---

## 로거 (logger.ts)

### 구현 상세
- `log(level, message, meta?)`: 콘솔 + 파일 동시 출력
- 레벨: `debug`, `info`, `warn`, `error`
- 파일: `~/.tl/tl.log` (최대 5MB, 3개 회전)
- 포맷: `[YYYY-MM-DD HH:mm:ss] [LEVEL] message {meta}`
- Phase 1: 단순 console.log + 파일 append
- Phase 3: 로그ロー테이션 추가

---

## 에러 처리 전략

| 상황 | 처리 |
|------|------|
| 데몬 이미 실행 중 | "Daemon already running (PID: xxx)" + exit 1 |
| 설정 파일 없음/불완전 | `CONFIG_MISSING` + 명확한 에러 + exit 1 |
| TG 봇 토큰 무효 | 시작 시 검증 실패 + `TG_API_ERROR` |
| sessions.json 파싱 실패 | .bak 시도 → 둘 다 실패 시 초기화 + `STORE_CORRUPT` 경고 로그 |
| 토픽 생성 실패 | `TG_API_ERROR` 로그 + 훅 프로세스에 에러 전달 |
| Long-polling timeout | `{decision: 'continue'}` 반환 |
| 데몬 크래시 중 reply 도착 | 파일 큐에 저장 → 재시작 시 처리 |
| PID 파일 있으나 프로세스 없음 | stale PID 간주, 삭제 후 재시작 |
| Reply 매칭 실패 | "⚠️ Reply해주세요" 안내 메시지 전송 |
| 동시 Stop 훅 (동일 세션) | `SESSION_EXISTS` 에러 + `{decision: 'continue'}` 반환 |
| Hook 프로세스 크래시 (HTTP 연결 끊김) | AbortSignal 감지 → `{decision: 'continue'}` 반환 |
| Reply 파일 큐 과부하 (100개 초과) | `REPLY_QUEUE_FULL` + 오래된 파일부터 삭제 |

---

## REQUIREMENTS.md 시나리오 커버리지 매핑

| 시나리오 | 구현 위치 | 상태 |
|----------|-----------|------|
| 1: 새 개발 세션 시작 | session-manager.startSession() + telegram.createTopic() | ✅ Phase 2 |
| 2: 턴 종료 → TG 알림 → 답장 재개 | session-manager.handleStop() + replyQueue.waitFor() + telegram.sendStopMessage() | ✅ Phase 2 |
| 3: 여러 세션 동시 진행 | session_id별 격리 + message_thread_id 매핑 | ✅ Phase 3 |
| 4: 재접속 (데몬 재시작) | session-manager.restoreSessions() | ✅ Phase 3 |
| 5: 세션 종료 | session-manager.completeSession() | ✅ Phase 2 |

### REQUIREMENTS.md 리스크 커버리지

| 리스크 | 해결 | 구현 위치 |
|--------|------|-----------|
| Stop 훅 timeout 초과 | `{decision: 'continue'}` 반환, 세션 정지 X | reply-queue.ts |
| 데몬 크래시 시 reply 손실 | 파일 큐 (`~/.tl/reply-queue/`) | reply-queue.ts (Phase 2) |
| topic_id 변경 | chat_id + topic_id 이중 저장 | store.ts |
| Codex 훅 버전 변경 | hooks.json 버전 관리 + `tl init --force` | bin/tl init |
| 훅 프로세스가 Codex를 블로킹 | stop-and-wait은 lightweight HTTP 신호만 | hooks/stop-and-wait.ts |

### REQUIREMENTS.md 미결정 사항 답변

| 항목 | 결정 | 근거 |
|------|------|------|
| Live Stream 기본 ON/OFF | **OFF** | 시끄러울 수 있음, config에서 토글 가능 |
| 토픽명 포맷 | `{prefix} {프로젝트명} — {YYYY-MM-DD HH:mm}` | config.topicPrefix로 커스터마이징 |
| TG 봇 1개 vs 프로젝트별 | **1개** (todait 전용으로 시작) | 단순성 우선, 나중에 확장 |
| Webhook vs Polling | **Polling** | 로컬 데몬이므로 간편 |

---

## 테스트 계획

### Unit (Phase 1)
- `config.ts`: 기본값 merge, 검증, env var 오버라이드, TL_CONFIG_DIR
- `store.ts`: load/save, atomic write + fsync, 빈 파일 초기화, .bak 복구
- `errors.ts`: TlError code별 구분
- `hooks/session-start.ts`: stdin 파싱, HTTP POST
- `hooks/stop-and-wait.ts`: stdin 파싱, long-polling, stdout 출력, 에러 시 continue
- `bin/tl`: PID 획득 (wx exclusive), stale PID 처리, stop

### Integration (Phase 2)
- `telegram.ts`: mock grammY로 토픽 생성/메시지 전송/답장 감지/이모지
- `session-manager.ts`: 전체 플로우 (start → stop → reply → active)
- `reply-queue.ts`: 동시 요청, timeout, reply 도착 시 resolve, 파일 큐
- Long-polling: AbortSignal 연결 끊김 감지, cleanup interval
- Mock reply API: PoC 엔드투엔드 테스트

### Integration (Phase 3)
- `restoreSessions`: stale 세션 필터링, TG 토픽 존재 확인, 파일 큐 처리
- Graceful shutdown: pending 응답 처리, 상태 저장
- 멀티 세션 동시 동작: 2개 세션 독립 reply 매칭
- `archiveCompleted`: N일 이상 completed 세션 이동
- sessions.json 성능: completed 세션 아카이브 후文件大小 감소

---

## 개발 순서 (상세)

### Day 1: Phase 1 — PoC
| 순서 | 파일 | 내용 |
|------|------|------|
| 1 | `package.json`, `tsconfig.json` | 프로젝트 초기화 |
| 2 | `types.ts`, `errors.ts` | 타입 + 에러 정의 |
| 3 | `logger.ts` | 로거 |
| 4 | `config.ts` | 설정 로드/검증/저장 |
| 5 | `store.ts` | sessions.json读写 |
| 6 | `daemon.ts` | HTTP 서버 (mock session manager) |
| 7 | `hooks/session-start.ts` | 훅 CLI |
| 8 | `hooks/stop-and-wait.ts` | 훅 CLI (long-polling) |
| 9 | `bin/tl` | start/stop/status |
| 10 | — | PoC 테스트 (mock-reply API) |

### Day 2-3: Phase 2 — TG 연동
| 순서 | 파일 | 내용 |
|------|------|------|
| 1 | `reply-queue.ts` | reply 큐 + 파일 큐 + cleanup |
| 2 | `telegram.ts` | grammY 봇 래퍼 |
| 3 | `session-manager.ts` | 세션 관리자 (TG 연동) |
| 4 | `daemon.ts` | TG 봇 통합 + restoreSessions 스켈레톤 |
| 5 | `templates/hooks.json` | 훅 템플릿 |
| 6 | `bin/tl` | init/config/cleanup |
| 7 | Transcript 파싱 | 최소 파일 목록 추출 |
| 8 | — | TG 연동 테스트 |

### Day 4: Phase 3 — 멀티 세션 + 내구성
| 순서 | 파일 | 내용 |
|------|------|------|
| 1 | `session-manager.ts` | 멀티 세션 격리 강화 |
| 2 | `store.ts` | archiveCompleted() |
| 3 | `daemon.ts` | restoreSessions 완성, graceful shutdown 완성 |
| 4 | `bin/tl` | cleanup 명령어 완성 |
| 5 | `logger.ts` | 로그ロー테이션 |
| 6 | — | 멀티 세션 동시 테스트 + 크래시 복구 테스트 |
