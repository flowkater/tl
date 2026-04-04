# tl — IMPLEMENTATION_PLAN.md TypeScript/Node.js 구현 관점 리뷰

> 검토자: Hermes Agent (TypeScript/Node.js 구현 리뷰어)
> 검토 대상: docs/IMPLEMENTATION_PLAN.md
> 날짜: 2026-04-05

---

## 1. 타입 정의(types.ts) — 충분성 및 누락

### 1-1. ⚠️ SessionStatus와 MachineState의 관계 불명확

문서에 두 타입이 정의되어 있으나 매핑이 없다:
```
SessionStatus:  'active' | 'waiting' | 'completed'  (영속화용)
MachineState:   'idle' | 'working' | 'waiting' | 'deliver'  (런타임용)
```
SessionRecord.status에 MachineState를 쓸지 SessionStatus를 쓸지 명시되지 않음.
**제안**: SessionRecord.status는 SessionStatus만 사용. MachineState는 in-memory 전용으로 하고,
`SessionRecord`에 `runtime_state?: MachineState` 필드를 추가하거나 아예 분리하라.
영속화 파일에 runtime 상태를 저장하면 데몬 재시작 시 idle/working/deliver를 구분할 수 없어 의미가 없다.

### 1-2. 🔴 누락: HTTP 요청/응답 타입

Hono 라우트 핸들러에서 사용할 타입이 누락됨:
```typescript
// 누락됨 — 추가 필요
export interface SessionStartResponse {
  session_id: string;
}

export interface StopAckResponse {
  acknowledged: true;
  session_id: string;
}

export interface StatusResponse {
  running: boolean;
  pid: number;
  active_sessions: number;
  waiting_sessions: number;
}

export interface SessionsListResponse {
  sessions: Array<SessionRecord & { session_id: string }>;
}
```

### 1-3. ⚠️ HookOutput이 너무 단순

```typescript
export interface HookOutput {
  decision: 'block' | 'continue';
  reason?: string;
}
```
REQUIREMENTS.md에 `continue: false` (세션 정지) 옵션이 언급됨.
`continue` decision일 때 `reason`이 필요 없는 것은 맞으나,
`block`일 때 `reason`이 필수여야 하는지 타입으로 표현되지 않음.

**제안**:
```typescript
export type HookOutput =
  | { decision: 'block'; reason: string }
  | { decision: 'continue'; reason?: string };
```
discriminated union으로 `block`일 때 `reason`을 강제하라.

### 1-4. ⚠️ DaemonConfig에 필수/선택 구분 없음

```typescript
export interface DaemonConfig {
  botToken: string;     // 필수
  groupId: number;      // 필수
  topicPrefix: string;  // 선택 (기본값 있음)
  // ...
}
```
모든 필드가 required로 선언되어 있으나, 실제로는 일부만 필수다.
**제안**:
```typescript
export interface DaemonConfig {
  botToken: string;
  groupId: number;
  topicPrefix?: string;
  hookPort?: number;
  stopTimeout?: number;
  liveStream?: boolean;
  emojiReaction?: string;
}
// 또는 Required/Partial 조합 사용
export type DaemonConfigRequired = Required<Pick<DaemonConfig, 'botToken' | 'groupId'>>;
```

### 1-5. 🔴 누락: Telegram API 관련 타입

grammY의 타입을 직접 사용하는 것은 좋으나, 프로젝트 내 wrapper 타입이 부족함:
```typescript
// 누락됨 — 추가 필요
export interface TopicInfo {
  topic_id: number;
  name: string;
}

export interface ReplyInfo {
  text: string;
  from_user_id: number;
  message_id: number;
  reply_to_message_id: number;
}
```

### 1-6. ⚠️ StopPayload에 누락된 필드 가능성

Codex 훅 스펙이 변경될 수 있으므로, unknown 필드를 허용하는 타입이 안전함:
```typescript
export interface StopPayload {
  session_id: string;
  turn_id: string;
  hook_event_name: 'Stop';
  model: string;
  cwd: string;
  transcript_path: string;
  stop_hook_active: boolean;
  last_assistant_message: string;
  [key: string]: unknown;  // forward compatibility
}
```

### 1-7. 🔴 누락: 에러 타입 정의

프로젝트 전반에서 사용할 커스텀 에러 타입이 없음:
```typescript
export class TlError extends Error {
  constructor(
    message: string,
    public code: TlErrorCode,
    public cause?: Error
  ) {
    super(message);
    this.name = 'TlError';
  }
}

export type TlErrorCode =
  | 'CONFIG_MISSING'
  | 'CONFIG_INVALID'
  | 'STORE_CORRUPTED'
  | 'SESSION_NOT_FOUND'
  | 'INVALID_TRANSITION'
  | 'TOPIC_CREATE_FAILED'
  | 'BOT_INIT_FAILED'
  | 'DAEMON_ALREADY_RUNNING'
  | 'HOOK_TIMEOUT'
  | 'REPLY_MATCH_FAILED';
```

---

## 2. grammY 토픽 API 사용 시 주의사항

### 2-1. 🔴 createForumTopic의 반환값 처리

grammY의 `api.createForumTopic()`은 `MessageThreadInfo`를 반환하며,
`message_thread_id`는 `number` 타입이다. 하지만 Telegram API의 제약:
- **Super Group만 포럼 토픽 지원**. 일반 그룹에서 호출하면 `400 Bad Request: GROUP_MIGRATED_TO_SUPERGROUP` 에러
- **봇이 어드민이어야 함**. "Manage Topics" 권한 필요

**제안**: `init()`에서 권한 검증 + 그룹 타입 확인을 수행하고, 실패 시 명확한 에러 메시지 출력.

### 2-2. ⚠️ message_thread_id 필터링의 정확성

```typescript
// waitForReply에서 message_thread_id 필터링
```
grammY long polling에서 모든 update를 받는다. `message_thread_id` 필터링은
클라이언트 코드에서 직접 해야 한다:

```typescript
bot.on('message', (ctx) => {
  const threadId = ctx.message?.message_thread_id;
  if (threadId !== expectedTopicId) return;  // 무시
  // ...
});
```

**주의사항**:
- `message_thread_id`는 포럼 그룹의 토픽에서만 존재. 1:1 채팅이나 일반 그룹에서는 `undefined`
- `edited_message`, `channel_post` 등 다른 update 타입에도 같은 필드가 없을 수 있음
- `callback_query`, `inline_query` 등 non-message update는 필터링과 무관

**제안**: `bot.on('message:text')` 등 구체적인 필터 사용 + `message_thread_id` 체크를 조합하라.

### 2-3. ⚠️ closeForumTopic API의 제한

문서에 `closeTopic()`이 있으나, Telegram Bot API의 `closeForumTopic`은:
- 토픽을 "닫음" — 하지만 다시 열 수 있음 (`reopenForumTopic`)
- 닫힌 토픽에도 봇이 메시지를 보낼 수 있는지 API 문서 확인 필요
- 실제로는 "닫기"보다 "아카이브" 개념에 가까움

**제안**: 토픽을 완전히 삭제하는 것이 아니라 "종료 메시지 전송 + close"로 유지하는 것은 합리적이나,
유저가 토픽을 다시 열 수 있음을 문서화하라.

### 2-4. 🔴 setMessageReaction API 버전 확인

`addReaction()`이 사용하는 `setMessageReaction`은 **Bot API 7.0+** (2024년 2월)에 추가됨.
grammy v1.20은 이를 지원하지만, 봇이 사용하는 Telegram 서버 버전이 낮은 경우 실패할 수 있음.

**제안**: reaction 실패 시 로그만 남기고 세션 흐름을 중단하지 말아라 (graceful degradation).

### 2-5. ⚠️ 토픽 이름 길이 제한

Telegram 토픽 이름은 **최대 128자**. 문서의 포맷:
```
{prefix} {project명} — {YYYY-MM-DD HH:mm}
```
`🔧 my-very-long-project-name — 2026-04-04 23:30` = 약 50자 정도이므로 안전하나,
project명이 긴 경우 (예: `/Users/flowkater/Projects/some-very-long-project-name`)
basename을 사용하므로 대부분 안전. 그래도 truncate 로직을 추가하라.

---

## 3. Hono + node:http 조합의 적합성

### 3-1. ✅ 적합한 선택

Hono의 `node:http` adapter는 이 사용 사례에 잘 맞음:
- lightweight, 의존성 최소화
- ESM 네이티브 지원
- typed routing (`Hono<{ Variables: {...} }>`)

### 3-2. 🔴 Hono v4의 ESM 설정 주의

Hono v4는 ESM-first이나, `hono/adapter` 경로를 올바르게 import해야 함:
```typescript
import { Hono } from 'hono';
import { serve } from '@hono/node-server';  // 별도 패키지 필요!
```

**문제**: `@hono/node-server`가 package.json에 누락됨. Hono 자체는 HTTP 서버를 제공하지 않는다.

**제안**:
```json
{
  "dependencies": {
    "grammy": "^1.20.0",
    "hono": "^4.0.0",
    "@hono/node-server": "^1.8.0"  // 추가 필요!
  }
}
```

### 3-3. ⚠️ Long-polling과 Hono의 스트리밍

Long-polling 구현 시 Hono의 `c.req.raw.signal`을 활용하면 클라이언트 연결 끊김을 감지할 수 있음:

```typescript
app.get('/hook/wait-reply', async (c) => {
  const sessionId = c.req.query('session_id');
  const signal = c.req.raw.signal;  // AbortSignal

  return new Promise<HookOutput>((resolve, reject) => {
    signal.addEventListener('abort', () => {
      // 클라이언트가 연결 끊음 (stop-wait 프로세스 크래시 등)
      pendingReplies.delete(sessionId);
      reject(new Error('Client disconnected'));
    });
    // ...
  });
});
```

이것은 2-1에서 지적한 hook 크래시 시 메모리 누수를 자연스럽게 해결한다.

### 3-4. ⚠️ Hono 미들웨어 활용 누락

문서에 미들웨어 사용 계획이 없음. 다음을 고려하라:
- **로깅 미들웨어**: `import { logger } from 'hono/logger'`
- **CORS**: localhost 전용이므로 불필요하지만, `hono/cors`로 명시적 비활성화 권장
- **에러 핸들링**: `app.onError()` 전역 핸들러로 500 응답 표준화

---

## 4. Atomic Write (임시파일→rename)의 macOS 동작

### 4-1. ✅ 기본 접근 방식은 올바름

```
write(tmp) → fsync(tmp) → rename(tmp, target)
```
macOS (APFS/HFS+)에서 `rename()`은 **atomic** 연산이다. POSIX 표준 보장.

### 4-2. ⚠️ fsync 누락 가능성

문서에 "임시 파일 → rename"만 언급되고 `fsync`가 없다.
macOS에서 `fs.writeFileSync()`는 내부적으로 fsync를 호출하지 **않을 수 있다** (OS/buffer에 따라).

**제안**:
```typescript
import { writeFileSync, renameSync, fsyncSync, openSync, closeSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';

async function atomicWrite(filePath: string, data: string): Promise<void> {
  const dir = dirname(filePath);
  const tmpPath = join(dir, `.tmp-${process.pid}-${Date.now()}`);

  // 같은 filesystem이어야 rename이 atomic
  // tmpdir()가 filePath와 다른 디바이스일 수 있으므로, 같은 디렉토리에 임시파일 생성
  writeFileSync(tmpPath, data, { encoding: 'utf-8', mode: 0o600 });

  // 명시적 fsync
  const fd = openSync(tmpPath, 'r+');
  fsyncSync(fd);
  closeSync(fd);

  renameSync(tmpPath, filePath);
}
```

### 4.3. 🔴 macOS의 Time Machine / Spotlight 간섭

macOS에서 Time Machine 백업 중이나 Spotlight indexing 중에는 파일 연산이 지연될 수 있다.
`rename()` 자체는 atomic하지만, write 중인 임시파일이 백업되면 불완전한 파일이 백업될 수 있다.
임시파일명을 `.tmp-*` 패턴으로 하면 `.gitignore`나 백업 제외 설정으로 처리 가능하지만,
문서에 이 고려사항이 없다.

**제안**: 임시파일 접두사를 `.tl-tmp-*`로 통일하고, `~/.tl/.gitignore`에 패턴 추가.

### 4.4. ⚠️ 권한 문제

`mode: 0o600` (owner만 읽기/쓰기)으로 임시파일을 생성해야 한다.
토큰이 포함된 sessions.json이 다른 유저에게 읽히면 보안 문제.
문서에 권한 설정이 명시되지 않음.

---

## 5. bin/tl의 PID 기반 데몬 관리 — Edge Cases

### 5-1. 🔴 Stale PID 처리 — 불완전

문서: "PID 파일 확인 → 존재 + 프로세스 alive면 already running → 아니면 fork"

macOS/Linux에서 PID 재활성(check) 방법:
```bash
kill -0 $PID 2>/dev/null  # exit 0이면 alive
```

**Edge case**: PID 파일의 PID가 현재 프로세스와 다른 유저의 프로세스일 수 있다.
`kill -0`은 같은 유저의 프로세스에서만 작동하므로, 다른 유저의 프로세스면 permission denied.
이 경우 "alive인지 죽었는지"를 알 수 없다.

**제안**:
```typescript
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    if (err.code === 'ESRCH') return false;  // 프로세스 없음
    if (err.code === 'EPERM') return true;   // 권한 없음 = 살아있음 (안전측)
    return false;
  }
}
```

### 5-2. 🔴 중복 실행 방지 — Race Condition

```
Process A: PID 파일 확인 (없음)
Process B: PID 파일 확인 (없음)
Process A: PID 파일 기록 + fork
Process B: PID 파일 기록 + fork  ← 덮어씌움!
```

**해결책**: `fs.open()`의 `wx` flag (exclusive create) 사용:
```typescript
import { openSync, writeSync, closeSync, unlinkSync } from 'fs';

function acquireLock(pidFile: string): number | null {
  try {
    const fd = openSync(pidFile, 'wx', 0o600);  // exclusive create
    writeSync(fd, String(process.pid));
    closeSync(fd);
    return process.pid;
  } catch (err: any) {
    if (err.code === 'EEXIST') {
      // PID 파일 존재 — stale 체크
      const pid = parseInt(readFileSync(pidFile, 'utf-8'));
      if (!isProcessAlive(pid)) {
        unlinkSync(pidFile);
        return acquireLock(pidFile);  // retry
      }
      return null;  // 이미 실행 중
    }
    throw err;
  }
}
```

### 5-3. ⚠️ child_process.fork vs spawn

문서에 "fork"라고만 되어 있으나, `child_process.fork()`는 Node.js IPC 채널을 생성한다.
데몬은 독립 실행이어야 하므로 `spawn()` + `detached: true`가 더 적합:

```typescript
import { spawn } from 'child_process';

const child = spawn(process.execPath, ['dist/daemon.js'], {
  detached: true,
  stdio: 'ignore',  // 데몬이 터미널과 분리됨
});
child.unref();  // 부모가 자식을 기다리지 않음
```

### 5.4. ⚠️ PID 파일 위치 경쟁 조건

`~/.tl/daemon.pid`를 여러 데몬 인스턴스가 동시에 접근할 수 있다.
5-2의 `wx` flag로 해결 가능하지만, `~/.tl` 디렉토리 자체가 없으면?

**제안**: PID 파일 기록 전에 `~/.tl` 디렉토리 존재 확인 + 생성 (mkdir -p).

### 5-5. 🔴 Graceful shutdown 시 PID 파일 정리 실패

데몬이 SIGKILL (kill -9)을 받으면 PID 파일이 정리되지 않는다.
다음 `tl start` 시 stale PID로 간주되어 재시작은 되지만,
정리되지 않은 PID 파일이 디버깅을 어렵게 만든다.

**제안**: 데몬 시작 시 항상 PID 파일의 stale 체크를 수행하고,
정기적인 health check (cron 또는 launchd)로 stale PID 파일 정리 고려.

---

## 6. tsconfig.json 설정 (ESM + tsx 조합)

### 6-1. ⚠️ `"moduleResolution": "bundler"`의 문제

```json
{
  "moduleResolution": "bundler"
}
```
`bundler`는 Bun/esbuild용 resolution 전략이다. tsx는 esbuild 기반이므로 동작은 하지만,
Node.js ESM 런타임 (`node dist/daemon.js`)과 resolution이 다를 수 있다.

**제안**: `"moduleResolution": "node16"` 또는 `"nodenext"` 사용.
이것은 Node.js의 ESM resolution 알고리즘과 일치한다.

### 6-2. 🔴 `bin/tl`이 tsx로 실행되나 tsconfig의 include에 없음

```json
{
  "include": ["src/**/*"]
}
```
`bin/tl`은 src 외부에 있으므로 타입 체크를 받지 않는다.
tsx는 런타임에 타입 체크를 하지 않으므로, bin/tl의 타입 에러는 발견되지 않음.

**제안**:
```json
{
  "include": ["src/**/*", "bin/**/*"]
}
```
또는 bin/에 별도 tsconfig를 두라.

### 6-3. ⚠️ `"declaration": true`의 불필요성

라이브러리가 아닌 애플리케이션이므로 `.d.ts` 파일 생성이 불필요하다.
빌드 시간과 디스크 공간을 낭비한다.

**제안**: `"declaration": false`로 변경 또는 삭제.

### 6-4. 🔴 `rootDir`과 `outDir` 문제

```json
{
  "rootDir": "./src",
  "outDir": "./dist"
}
```
`bin/tl`이 tsx로 실행되므로 빌드 대상이 아니지만,
향후 `bin/`도 TypeScript로 전환하면 rootDir 문제가 발생한다.

현재는 문제없으나, tsconfig가 src/만 커버하므로 일관성 있다.

### 6-5. ⚠️ `tsx watch`의 파일 감지 범위

`tsx watch src/daemon.ts`는 daemon.ts가 import하는 파일만 감시한다.
`bin/tl`이나 설정 파일 변경은 감지되지 않는다.

**제안**: `tsx watch --include "src/**/*" src/daemon.ts` 또는
`nodemon`/`tsx watch`의 적절한 설정 문서화.

### 6-6. 🔴 빌드된 코드의 ESM 실행

```json
{
  "scripts": {
    "start": "node dist/daemon.js"
  }
}
```
package.json에 `"type": "module"`이 있으므로 ESM으로 실행된다.
하지만 `tsc`의 `module: "ESNext"` 출력은 `.js` 파일에 `import/export`를 생성하므로 OK.

**주의**: `node --experimental-specifier-resolution=node` 플래그가 필요할 수 있다
(Node.js 20+에서는 불필요).

---

## 7. Long-polling 구현에서 메모리 누수 가능성

### 7-1. 🔴 Hook 프로세스 크래시 시 영구 메모리 누수

가장 심각한 문제. 문서의 pendingReplies 구현:

```typescript
const pendingReplies = new Map<string, {
  resolve: (output: HookOutput) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}>();
```

**시나리오**:
1. POST /hook/stop → pendingReplies에 entry 등록
2. GET /hook/wait-reply → Promise 생성, Map에 등록
3. **stop-wait 프로세스 크래시** (OOM, SIGKILL, 네트워크)
4. pending entry가 Map에 영구적으로 남음

timer가 timeout을 처리하지만, timeout 전에 크래시하면?
`stopTimeout`이 3600초(1시간)이므로 1시간 동안 메모리 누수.

**해결책** (복합):
```typescript
// (a) AbortSignal로 클라이언트 연결 끊김 감지 (3-3에서 언급)
// (b) 주기적 stale entry 정리
const staleCheckInterval = setInterval(() => {
  for (const [sessionId, pending] of pendingReplies.entries()) {
    // consumer 없이 5분 이상된 entry 정리
    if (!pending.hasConsumer && Date.now() - pending.createdAt > 300_000) {
      pending.reject(new Error('Hook process appears to have crashed'));
      pendingReplies.delete(sessionId);
    }
  }
}, 30_000);

// (c) POST/GET을 단일 엔드포인트로 통합 (가장 근본적 해결)
```

### 7-2. ⚠️ EventEmitter 메모리 누수 (grammY)

grammY 봇이 `bot.on('message', handler)`로 리스너를 등록할 때,
세션별로 동적 리스너를 추가/제거하지 않으면 리스너가 누적된다.

**올바른 패턴**:
```typescript
// 세션별 동적 리스너 X — 단일 전역 리스너 + session 매핑 O
bot.on('message', (ctx) => {
  const replyToId = ctx.message.reply_to_message?.message_id;
  if (!replyToId) return;

  // sessions.json 또는 in-memory에서 매칭
  const session = findSessionByStopMessageId(replyToId);
  if (!session) return;

  const pending = pendingReplies.get(session.session_id);
  if (pending) {
    pending.resolve({ decision: 'block', reason: ctx.message.text });
    pendingReplies.delete(session.session_id);
  }
});
```

### 7-3. ⚠️ timer 객체 정리 누락

```typescript
const timer = setTimeout(() => {
  pending.reject(new TimeoutError());
  pendingReplies.delete(sessionId);
}, timeoutSec * 1000);
```

timeout 전에 resolve되면 `timer`가 정리되지 않음:

```typescript
// resolve 시 timer도 정리
const entry = pendingReplies.get(sessionId);
if (entry) {
  clearTimeout(entry.timer);
  entry.resolve(output);
  pendingReplies.delete(sessionId);
}
```

### 7-4. 🔴 Reply가 pending 등록 전에 도착하는 Race Condition

```
시간순:
1. POST /hook/stop (ack 반환)
2. TG에서 reply 도착 (waitForReply 리스너 작동)
3. GET /hook/wait-reply (Promise 생성)
```

2번에서 reply가 도착했는데 3번의 Promise가 아직 없으면 reply 손실.

**해결책**: reply를 먼저 큐에 저장하고, consumer가 와서 가져가는 구조:
```typescript
// reply 큐 (session_id → queue)
const replyQueue = new Map<string, Array<{ text: string; timestamp: number }>>();

// grammY 리스너에서:
const pending = replyQueue.get(sessionId) ?? [];
pending.push({ text: ctx.message.text, timestamp: Date.now() });
replyQueue.set(sessionId, pending);

// GET /hook/wait-reply에서:
const queued = replyQueue.get(sessionId);
if (queued && queued.length > 0) {
  // 바로 반환
} else {
  // pending Promise 생성
}
```

### 7-5. ⚠️ 동시 세션 10개 이상에서 Map 성능

`Map<string, ...>`은 O(1)이므로 100개 세션까지는 문제없다.
하지만 cleanup이 linear scan이라면 세션 수에 비례하는 오버헤드.

현재는 `sessionId`로 직접 access하므로 O(1).
cleanup이 필요한 경우에만 순회하므로 큰 문제는 아니다.

---

## 8. package.json 의존성 버전 적절성

### 8-1. 🔴 `@hono/node-server` 누락

3-2에서 언급. Hono v4는 HTTP 서버 어댑터를 별도 패키지로 분리했다.

### 8-2. ⚠️ `grammy: "^1.20.0"` — 최신 버전 확인

grammy의 최신 버전을 확인하라. 2026년 4월 기준으로:
- `grammy@1.x`는 stable
- `grammy@2.x`가 출시되었을 가능성 있음

**제안**: `^1.21.0` 이상으로 pin. v2가 나왔다면 마이그레이션 고려.

또한 `@grammyjs/types`는 **grammy v1.21+에 내장**되어 별도 설치가 불필요하다.
Phase 2 의존성에 `@grammyjs/types`가 있으나 제거 가능.

### 8-3. ⚠️ `@types/node: "^20.0.0"` — Node.js 버전 의존성

프로젝트가 사용하는 Node.js 버전과 맞춰야 한다.
- Node.js 20을 쓰면 `^20.0.0` OK
- Node.js 22를 쓰면 `^22.0.0` 권장

**제안**: engines 필드 추가:
```json
{
  "engines": {
    "node": ">=20.0.0"
  }
}
```

### 8-4. 🔴 누락된 의존성

| 패키지 | 용도 | 우선순위 |
|--------|------|----------|
| `@hono/node-server` | Hono HTTP 서버 | 🔴 필수 |
| `zod` 또는 `ajv` | 설정/페이로드 검증 | 🟡 권장 |
| `winston` 또는 `pino` | 로깅 (logger.ts) | 🟡 권장 |

### 8-5. ⚠️ tsx 버전

`tsx: "^4.7.0"`은 적절하다. 최신 tsx는 ESM fully 지원.
다만 `tsx`가 watch 모드에서 파일 잠금 문제가 있을 수 있으므로,
macOS에서는 `fsevents` 기반 watcher를 사용하도록 `TSX_WATCHER=fsevents` 환경변수 설정을 권장.

### 8-6. ⚠️ TypeScript 버전

`typescript: "^5.4.0"`은 적절하다.
다만 `moduleResolution: "node16"`/`"nodenext"`를 쓰려면 TypeScript 5.0+가 필요하므로 OK.

---

## 종합 요약

### 🔴 즉시 수정 필수 (구현 전 반드시 해결)

| # | 항목 | 위치 |
|---|------|------|
| 1 | `@hono/node-server` 의존성 추가 | package.json |
| 2 | HookOutput을 discriminated union으로 변경 | types.ts |
| 3 | long-polling AbortSignal 연결 끊김 감지 | daemon.ts |
| 4 | PID 파일 acquire 시 `wx` flag 사용 | bin/tl |
| 5 | timer 정리 누락 방지 (clearTimeout on resolve) | daemon.ts |
| 6 | reply 큐 구조 도입 (race condition 방지) | daemon.ts |
| 7 | bin/tl을 tsconfig include에 추가 | tsconfig.json |

### 🟡 구현 시 권장

| # | 항목 | 위치 |
|---|------|------|
| 1 | HTTP 요청/응답 타입 정의 추가 | types.ts |
| 2 | TlError 커스텀 에러 타입 정의 | types.ts |
| 3 | atomic write에 fsync 명시 | store.ts |
| 4 | moduleResolution을 "node16"으로 변경 | tsconfig.json |
| 5 | grammY 전역 리스너 + session 매핑 패턴 | telegram.ts |
| 6 | engines 필드 추가 | package.json |
| 7 | @grammyjs/types 제거 (grammy 내장) | package.json |

### 🟢 Phase 3 또는 이후 고려

| # | 항목 | 위치 |
|---|------|------|
| 1 | SessionStatus/MachineState 분리 | types.ts |
| 2 | StopPayload forward compatibility (`[key: string]: unknown`) | types.ts |
| 3 | completed 세션 아카이브 전략 | store.ts |
| 4 | declaration: false 설정 | tsconfig.json |
