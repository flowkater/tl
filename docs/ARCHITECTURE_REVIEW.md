# tl 아키텍처 리뷰

> 검토자: Hermes Agent (시스템 아키텍처 리뷰어)
> 검토 대상: `docs/IMPLEMENTATION_PLAN.md` (v1)
> 기준 문서: `docs/REQUIREMENTS.md`
> 날짜: 2026-04-04

---

## 1. 아키텍처 구조: 컴포넌트 분리 타당성

### ✅ 잘 설계된 부분
- **관심사 분리**: daemon(서버), session-manager(비즈니스 로직), telegram(I/O), state-machine(상태), store(영속화)로 모듈화 잘 됨
- **SessionManager가 의존성을 조합하는 패턴**: TelegramBot + SessionsStore + StateMachine factory를 주입받아 사용하는 구조는 테스트 가능성 보장
- **CLI와 데몬 분리**: bin/tl(관리 CLI)과 hooks/*(훅 실행 바이너리)의 역할 분리 명확

### ⚠️ 문제점

**1-1. StateMachine 오버엔지니어링**
- 현재 설계: per-session StateMachine 인스턴스 + 콜백 등록(onWorking/onWaiting/onDeliver) + invalid 전이 에러
- 문제: 유효 전이 경로가 `idle→working→waiting→deliver→working(completed)`로 매우 단순함. 상태 머신 클래스를 만들 만큼 복잡하지 않음
- 제안: `SessionRecord.status` 필드 하나로 충분. 전이 검증은 `SessionManager`의 메서드 레벨에서 처리하면 됨. state-machine.ts 모듈 삭제 고려

**1-2. daemon.ts의 통합 책임 과중**
- 문서에서 "HTTP + TG 봇 + 상태 관리 통합"이라고 명시. Long-polling pendingReplies Map도 daemon.ts에 있음
- 문제: 데몬이 HTTP 라우팅, pending request 관리, 시그널 핸들링, PID 관리까지 모두 담당 → 단일 파일이 너무 커짐
- 제안: `pending-replies.ts` 별도 모듈로 분리 (resolve/reject 큐 관리 전담)

**1-3. logger.ts 구현 상세 누락**
- 프로젝트 구조에 있으나 구현 계획에 상세 설명 없음
- 제안: 최소 log level, 파일 로그 vs stdout, 로그 ロー테이션 정책 명시 필요

---

## 2. Long-polling Reply 전달 메커니즘

### ✅ 잘 설계된 부분
- session_id별 pendingReplies Map으로 동시 세션 격리
- timeout 시 `{decision: 'continue'}` 반환하여 세션 정지 방지
- 데몬 크래시 시 파일 큐(`~/.tl/reply-queue/`)로 reply 보존 (Phase 3)

### 🚨 핵심 문제점

**2-1. Hook 프로세스 크래시 시 메모리 누수 (가장 심각)**
- stop-wait 프로세스가 크래시/kill되면 `GET /hook/wait-reply`의 pending response가 데몬에 영구적으로 남음
- resolve/reject 함수와 timer가 Map에서 절대 제거되지 않음
- 시나리오:
  1. Stop 훅 실행 → POST /hook/stop → pendingReplies에 등록
  2. GET /hook/wait-reply로 long-polling 시작
  3. 유저가 답장 → pending resolve → stop-wait이 exit
  4. ✅ 정상 케이스 — 문제 없음
  5. **하지만**: 2번과 3번 사이에 stop-wait 프로세스가 크래시하면?
     - pendingReplies에 등록된 entry가 그대로 남음
     - 데몬이 resolve 해도 소비자가 없음 (stop-wait 프로세스 없음)
     - 이후 동일 session_id로 새 Stop 훅이 오면 기존 entry와 충돌
- **해결책**:
  - pendingReplies entry에 `createdAt` 타임스탬프 추가
  - 주기적 cleanup interval (예: 30초마다 timeout 지났거나 consumer가 없는 entry 정리)
  - 또는: POST /hook/stop과 GET /hook/wait-reply를 단일 엔드포인트로 통합하여 hook 프로세스가 직접 long-poll

**2-2. POST/GET 분리 아키텍처의 근본적 문제**
```
현재: POST /hook/stop  →  pendingReplies에 등록
      GET /hook/wait-reply  →  같은 pendingReplies에서 Promise 반환
```
- 문제: 두 HTTP 요청이 별개이므로, POST가 ack를 반환한 순간과 GET이 연결되는 사이에 reply가 도착하면?
  - 현재 코드를 보면 POST 시점에 이미 resolve/reject를 pendingReplies에 등록하므로, reply가 먼저 와도 resolve 호출은 GET의 Promise에 연결됨
  - 하지만 GET 요청 자체가 오지 않으면 (hook 크래시) pending이 고아 상태로 남음
- **해결책**: 단일 엔드포인트로 변경
  ```
  POST /hook/stop-and-wait?session_id=xxx&timeout=3600
  → body에 StopPayload
  → long-polling으로 응답 대기
  → reply 도착 또는 timeout 시 HookOutput 반환
  ```
  이렇게 하면 hook 프로세스와 데몬의 연결이 1:1로 명확해짐

**2-3. TG polling과 reply 감지의 타이밍 문제**
- grammY long polling은 Telegram 서버에서 update를 받아옴
- 데몬이 reply를 감지하는 시점: `waitForReply()`가 `message` 이벤트 리스너로 작동
- 문제: reply가 도착한 시점에 해당하는 pendingReplies entry가 없으면 (cleanup 되었거나 race condition) reply가 손실됨
- **해결책**: reply를 pendingReplies와 무관하게 먼저 sessions.json 또는 reply-queue에 기록한 후, consumer가 있을 때 전달하는 "publish-subscribe" 방식으로 변경

**2-4. 동시 세션 10개 이상의 확장성**
- 현재 pendingReplies는 in-memory Map. 10개 세션이면 문제없지만, 수십 개로 늘면?
- 각 세션별 timeout timer가 독립적으로 작동하므로, 타이머 객체 누적 가능
- 제안: 세션 수 제한을 config에 추가하거나, timeout cleanup을 더 적극적으로

---

## 3. Graceful Shutdown 시나리오

### ⚠️ 누락사항

**3-1. Codex 훅 프로세스에 대한 고려 없음**
- 데몬이 SIGTERM을 받으면 pending long-polling에 `{decision: 'continue'}`를 반환
- **하지만**: 현재 stop-wait 프로세스는 이미 POST /hook/stop을 완료하고 GET /hook/wait-reply에서 대기 중
- 데몬 shutdown 시 GET 연결이 끊어지면 stop-wait은 에러 응답을 받음
- stop-wait이 에러 응답을 받을 때의 동작이 명시되지 않음
  - exit 0? exit 1? 기본 decision은?
  - Codex 훅이 비정상 종료로 간주하면 세션이 멈출 수 있음
- **해결책**: 
  - stop-wait이 HTTP 에러(연결 끊김, 503 등)를 받으면 `{decision: 'continue'}`를 기본값으로 stdout 출력 후 exit 0
  - 또는: 데몬 shutdown 시 먼저 모든 active 훅 프로세스에 시그널 전송 → 정상 종료 대기 → 데몬 종료

**3-2. 진행 중인 TG API 호출 처리**
- `bot polling 정지`만 명시. 하지만 shutdown 시점에 sendStopMessage() 등 TG API 호출이 진행 중일 수 있음
- 제안: shutdown 시 "draining" 상태 진입 — 새 요청 거부, 진행 중인 작업 완료 후 종료

**3-3. sessions.json 저장 타이밍**
- "모든 활성 세션 상태 저장"은 좋으나, 저장 중 에러 발생 시 처리 없음
- atomic write를 사용하므로 파일 손상 위험은 낮으나, 저장 실패 시 로깅 및 fallback 필요

**3-4. systemd/supervisord 등 프로세스 관리자 호환성**
- PID 파일 기반 자체 관리만 기술됨
- 실제 운영에서는 systemd의 Type=simple이나 supervisord로 관리할 가능성 높음
- PID 파일 방식과 충돌하지 않도록 문서화 필요

---

## 4. sessions.json 기반 영속화의 한계

### ⚠️ 문제점

**4-1. 동시 읽기/쓰기 경쟁 조건**
- Node.js는 싱글스레드이므로 동일 프로세스 내에서는 race condition이 발생하지 않음
- **하지만**: `save()`가 async write 중일 때 다른 콜백이 `get()`을 호출하면, 아직 디스크에 기록되지 않은 stale 데이터를 읽을 수 있음
- current design: save()는 atomic write (tmp → rename)이므로 파일 레벨에서는 안전
- 메모리 vs 디스크 불일치: in-memory state와 sessions.json 간 동기화 보장이 명확하지 않음
- **해결책**: sessions.json을 single source of truth로 하고, 매 읽기 시 파일에서 로드하거나, in-memory cache + write-through 패턴 명시

**4-2. sessions.json 손상 시 복구**
- "sessions.json 파싱 실패 → 백업(.bak) 생성 후 초기화" (에러 처리 전략)
- 문제: 모든 세션 정보가 손실됨. 복구 메커니즘이 필요
- **해결책**: 
  - save() 직전에 항상 .bak 백업 유지
  - .bak도 손상되었을 경우를 대비해 ~/.tl/sessions-backup/ 디렉토리에 타임스탬프 기반 백업 유지 (최대 5개)

**4-3. 세션 수 증가 시 성능**
- sessions.json이 단일 JSON 파일. 세션이 수백 개로 늘면 전체 파일 로드가 부담
- 현재 사용 패턴에서는 completed 세션을 주기적으로 아카이브하지 않으면 파일이 계속 커짐
- **해결책**: 
  - completed 상태인 세션은 sessions-archive.json으로 이동 (또는 삭제)
  - 또는: sessions.json에 active/waiting만 저장, completed는 별도 파일

**4-4. SessionStatus vs MachineState 불일치**
- `SessionStatus`: 'active' | 'waiting' | 'completed'
- `MachineState`: 'idle' | 'working' | 'waiting' | 'deliver'
- 두 타입이 매핑되지 않음. SessionRecord에 MachineState를 저장할지 SessionStatus를 저장할지 불명확
- **해결책**: SessionRecord.status는 SessionStatus만 사용. MachineState는 런타임 메모리 전용으로 하고 영속화하지 않음 (재시작 시 working/deliver는 모두 active로 복원)

---

## 5. Phase 1→2→3 순서 논리성

### ✅ 잘 설계된 부분
- PoC(TG 없이) → TG 연동 → 멀티 세션의 점진적 접근은 합리적
- 각 Phase가 독립적으로 테스트 가능

### ⚠️ 문제점

**5-1. Reply 파일 큐가 Phase 3으로 밀린 것**
- REQUIREMENTS.md "데몬 크래시 시 reply 손실" 리스크에 대한 해결책이 파일 큐
- 이 기능은 **Phase 1이나 2에 포함되어야 함**. 데몬 크래시는 언제든지 발생할 수 있음
- Phase 3은 "멀티 세션"에 집중하고, 크래시 복구는 별도의 resilience Phase로 분리하거나 Phase 2에 포함 권장

**5-2. Graceful shutdown이 Phase 3으로 밀린 것**
- 데몬 재시작/관리는 Day-to-Day 작업에서 필수
- Phase 2가 완성되면 실제 사용 시작 → 그 시점부터 graceful shutdown 필요
- **해결책**: 최소한의 shutdown(SIGTERM → pending resolve → 저장)은 Phase 2에 포함

**5-3. Phase 2에서 멀티 세션이 아예 고려되지 않음**
- Phase 2는 TG 연동만 다루고, Phase 3에서야 멀티 세션 지원
- 하지만 TG 연동 테스트 시 자연스럽게 세션 2개가 만들어질 수 있음
- **해결책**: Phase 2에서 이미 session_id별 격리 구조를 갖추고, Phase 3은 복원/아카이브에 집중하도록 범위 조정

**5-4. Phase 1 PoC의 TG 완전 배제**
- TG 없이 PoC를 하는 것은 좋으나, stop-wait의 long-polling이 TG reply 없이는 동작을 검증하기 어려움
- 현재 계획: "데몬이 답장을 기다리는 동안 유저가 터미널에서 직접 입력"
- 이 경우 long-polling의 실제 동작(TG reply → deamon → hook)을 검증할 수 없음
- **해결책**: Phase 1에서 mock reply API 추가 (`POST /hook/mock-reply?session_id=xxx`)로 long-polling 엔드투엔드 테스트 가능하게

---

## 6. 누락된 컴포넌트 및 고려사항

### 🚨 필수 누락

**6-1. Reply 매칭 실패 시 처리**
- Reply 매칭 로직: `reply_to_message.message_id`가 Stop 메시지 ID와 일치하는지 확인
- **문제**: 유저가 Reply가 아니라 일반 메시지를 보내면? → 무시됨. 피드백 없음
- **해결책**: 
  - 해당 토픽에서 Stop 메시지以外에 대한 Reply 또는 일반 메시지 수신 시 "⚠️ 작업 완료 메시지에 Reply해주세요" 안내 메시지 전송
  - 또는: 토픽의 모든 메시지를 세션 컨텍스트로 간주하고 처리 (더 유연하지만 복잡)

**6-2. TG 봇 연결 상태 모니터링**
- long polling 연결이 끊어졌을 때 (네트워크 문제, 토큰 만료 등) 자동 복구 로직이 없음
- grammY는 내부적으로 retry를 하지만, 영구적 실패 시 알림이 필요
- **해결책**: bot.on("error") 핸들러 + TG admin에게 알림 (또는 로그)

**6-3. Reply 메시지 길이 제한**
- TG 메시지 최대 4096자. 유저가 긴 답장을 보내면?
- **해결책**: 길이 제한 및 분할 전송, 또는 잘림 경고

**6-4. 보안: HTTP 엔드포인트 인증 없음**
- `localhost:9877`이므로 로컬에서만 접근 가능하지만, 멀티유저 환경에서는 문제
- **해결책**: 최소한 `TL_HOOK_SECRET` 환경 변수 기반 simple token auth 추가 고려

**6-5. 동시 Stop 훅 호출 처리**
- Codex가 동시에 여러 turn을 완료하면 Stop 훅이 중복 호출될 수 있음
- 현재 설계: 동일 session_id에 대해 POST /hook/stop이 연속 호출되면?
  - 첫 번째: pendingReplies에 등록 + TG 메시지 전송
  - 두 번째: 기존 entry를 덮어씌움 → 첫 번째 hook의 reply가 두 번째 hook에게 전달됨
- **해결책**: 동일 session에 대해 이미 waiting 중인 경우 에러 반환 또는 큐잉

**6-6. 세션 수명 관리**
- completed 세션이 sessions.json에 영구적으로 남음
- **해결책**: 
  - `tl cleanup` 명령어: N일 이상 completed된 세션 삭제/아카이브
  - 또는: sessions.json에 active/waiting만 저장, completed는 별도 archive 파일

**6-7. hooks.json 설치 시 기존 파일 병합**
- `tl init`이 `~/.codex/hooks.json`에 설치할 때, 기존 hooks.json이 있으면?
- "이미 있으면 skip"이라고만 되어 있음
- **해결책**: 
  - 기존 파일의 다른 hook 설정은 보존하면서 tl 관련 hook만 merge
  - 또는: `tl init --force`로 덮어쓰기 옵션 제공

**6-8. Transcript 파싱 (Phase 3)**
- "수정 파일 목록은 transcript에서 파싱 (Phase 3에서 개선)"이라고만 되어 있음
- Stop 훅 payload에 transcript_path가 제공되므로, 파일 목록 추출이 가능해야 함
- **해결책**: Phase 2에서 최소한의 transcript 파싱 구현 (JSONL에서 tool_call 결과 파싱)

**6-9. 에러 시 Codex 훅 타임아웃 관리**
- Stop 훅의 timeout은 3600초 (1시간). 데몬이 이 시간 내에 reply를 전달하지 못하면 Codex가 훅을 강제 종료
- 데몬이 reply를 전달하려는 시점에 훅이 이미 timeout으로 종료되었으면?
- **해결책**: 데몬이 pending reply 처리 시 hook 프로세스存活 확인 (불가능하면 reply 큐에 저장)

---

## 요약: 우선순위별 개선 제안

### 🔴 즉시 해결 필수 (Phase 1-2에 포함)
1. **POST/GET 분리를 단일 엔드포인트로 변경** (2-2) — 아키텍처 단순화 + race condition 제거
2. **Hook 크래시 시 pending entry cleanup** (2-1) — 메모리 누수 방지
3. **Graceful shutdown 시 hook 프로세스 처리** (3-1) — 세션 정지 방지
4. **SessionStatus vs MachineState 통일** (4-4) — 타입 불일치 해결
5. **Reply 매칭 실패 시 유저 피드백** (6-1) — UX 개선

### 🟡 Phase 2에 포함 권장
6. **TG 봇 연결 상태 모니터링** (6-2)
7. **Graceful shutdown의 draining 상태** (3-2)
8. **sessions.json에 active/waiting만 저장** (4-3)
9. **Reply 파일 큐를 Phase 2로 당김** (5-1)
10. **동시 Stop 훅 호출 처리** (6-5)

### 🟢 Phase 3 또는 이후
11. **StateMachine 단순화 또는 제거** (1-1)
12. **세션 수명 관리 / cleanup 명령어** (6-6)
13. **hooks.json merge 전략** (6-7)
14. **Transcript 파싱 구현** (6-8)
15. **HTTP 엔드포인트 인증** (6-4)
