# tl — Codex ↔ Telegram Bridge

> [!WARNING]
> 이 문서는 초기 설계와 구현 전제 일부를 보존한 historical requirements다.
> 현재 설치/운영 기준의 source of truth는 [README.md](../README.md), [CODEX_SETUP.md](../CODEX_SETUP.md), [PROMPTS.md](../PROMPTS.md)다.
> 현재 구현과 다른 대표 차이:
> - 기본 설치는 `npm install -g github:flowkater/tl`
> - 기본 Stop timeout은 `7200`초
> - local Codex plugin(`tl plugin install`)이 존재함
> - Stop 메시지는 현재 turn의 `commentary + final`을 함께 전송함
> - late reply resume fallback, resume ACK, working heartbeat가 구현돼 있음
> - custom prompts / slash command 비교는 역사적 배경 설명일 뿐 현재 권장 경로가 아님

> Codex 세션을 Telegram 토픽에 연결하여, 터미널과 텔레그램을 오가는 마찰을 없애는 로컬 개발 브릿지.
>
> **목표**: 터미널 안 봐도 됨. Codex가 작업하는 동안 텔레그램으로 확인하고, 답장만으로 개발 계속.

---

## 1. 핵심 컨셉

**1 프로젝트 = 1 Telegram 봇 = 1 Group (Topics ON)**

- Codex 세션 시작 → Telegram Group에 새 토픽 자동 생성
- 각 세션 = 독립 토픽 (message_thread_id 기반 격리)
- 세션-토픽 매핑은 파일로 영구 저장 (데몬 재시작 시 복원)
- **연결은 유지**: 한 연결된 세션은 Codex가 종료될 때까지 끊기지 않음

---

## 2. 사용자 시나리오

### 시나리오 1: 새 개발 세션 시작

```
1. 터미널에서: codex (또는 tl start)
2. Codex SessionStart 훅 발동 → tl 데몬에게 HTTP 콜백
3. tl 데몬이 Telegram Group에 새 토픽 생성
   - 토픽명: "todait-ios — 2026-04-04 23:30"
   - session_id ↔ topic_id 매핑을 ~/.tl/sessions.json에 저장
4. TG 토픽에 환영 메시지:
   "🟢 세션 시작 — todait-ios (session: abc123)"
5. Codex TUI에서 개발 시작 (기존대로)
```

### 시나리오 2: 턴 종료 → Telegram 알림 → 답장 재개

```
1. Codex가 작업 완료 → Stop 훅 발동
2. Stop 훅 명령어(`tl hook-stop-and-wait`)가 tl 데몬에게 신호
   - session_id, turn_id, 마지막 assistant 메시지, cwd 전달
3. tl 데몬이 TG 토픽으로 메시지 전송:
   ┌─────────────────────────────────────┐
   │ ✅ 작업 완료                        │
   │                                     │
   │ "commentary + final 요약 본문"      │
   └─────────────────────────────────────┘
4. `tl hook-stop-and-wait`는 TG 답장 올 때까지 블로킹 대기 (현재 기본 timeout 2시간)
5. 유저가 TG 토픽에서 답장 (Reply)
6. tl 데몬이 reply를 `tl hook-stop-and-wait`에게 전달 → 후크 exit 0
7. Codex가 답장을 새 입력으로 받아 개발 계속
8. tl 데몬이 TG 답장 메시지에 👍 이모지 반응
```

### 시나리오 3: 여러 세션 동시 진행

```
TG Group (Topics ON)
├── 📌 General
├── 🔧 todait-ios — auth-feature    ← 세션 A Live Stream
├── 🔧 todait-ios — api-fix         ← 세션 B Live Stream
└── 🔧 todait-ios — ui-redesign     ← 세션 C Live Stream

각 토픽에서 독립적인 Codex 대화 흐름. 서로 섞이지 않음.
```

### 시나리오 4: 재접속 (데몬 재시작 / Codex 재개)

```
1. tl start (데몬 재시작)
2. ~/.tl/sessions.json에서 active 세션 로드
3. tg 토픽에 "🔌 재연결 완료 — 이전 세션 복원됨" 알림
4. codex resume --last 로 이전 컨텍스트 그대로 이어짐
```

### 시나리오 5: 세션 종료

```
1. Codex에서 /exit 또는 Ctrl+C
2. Session 종료 이벤트 감지 (또는 Stop 훅 마지막 실행)
3. TG 토픽에 "🏁 세션 종료 — 총 N턴, X파일 수정" 요약
4. sessions.json에서 상태 completed로 변경
```

---

## 3. Codex Hook 스펙 (확인됨 ✅)

### 설정 활성화

```toml
# ~/.codex/config.toml
[features]
codex_hooks = true
```

### hooks.json

```jsonc
// ~/.codex/hooks.json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "curl -s -X POST http://localhost:9877/hook/session-start -H 'Content-Type: application/json' -d @-",
            "statusMessage": "Connecting to Telegram..."
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "tl hook-stop-and-wait",
            "timeout": 7200
          }
        ]
      }
    ]
  }
}
```

### 지원 이벤트

| 이벤트 | 타이밍 | matcher | tl 용도 |
|--------|--------|---------|---------|
| **SessionStart** | 세션 시작 (startup/resume) | source | TG 토픽 생성 + 연결 |
| **Stop** | 턴 종료, 입력 대기 | — | 마지막 메시지 전송 + 답장 대기 |
| PreToolUse | Bash 실행 전 | tool name | (선택) 명령 승인 |
| PostToolUse | Bash 실행 후 | tool name | (선택) 결과 검증 |
| UserPromptSubmit | 프롬프트 전송 전 | — | (선택) 프롬프트 가공 |

### Stop Hook 입력 (stdin)

```json
{
  "session_id": "abc123",
  "turn_id": "turn-42",
  "hook_event_name": "Stop",
  "model": "gpt-5.4",
  "cwd": "/Users/flowkater/Projects/todait-ios",
  "transcript_path": "/Users/flowkater/.codex/sessions/abc123.jsonl",
  "stop_hook_active": false,
  "last_assistant_message": "auth 모듈에 에러 핸들링 추가했어..."
}
```

### Stop Hook 출력 (stdout, JSON)

```json
{
  "decision": "block",
  "reason": "에러 핸들링 좋네. 이제 로그인 API도 수정해줘"
}
```

- `decision: "block"` + `reason` → Codex가 reason을 새 프롬프트로 계속
- `continue: false` → 세션 정지
- exit 2 + stderr → reason 대체 방식

---

## 4. 기술 요구사항

### 4.1 기술 스택

| 항목 | 선택 | 이유 |
|------|------|------|
| 런타임 | Node.js + TypeScript | 토니 익숙, npm 생태계 |
| PTY | `node-pty` | WezTerm 기반 portable-pty |
| TG 봇 | `grammY` | 타입 안전, 토픽 네이티브 지원 |
| HTTP 서버 | `hono` + `node:http` | 경량, fast |
| 상태 저장 | JSON 파일 (`~/.tl/sessions.json`) | 단순, 재시작 복원 |
| 빌드 | `tsx` | 개발 시 컴파일 없이 실행 |

### 4.2 아키텍처

```
┌─────────────────────────────────────────────────┐
│  tl daemon (Node.js, localhost:9877)             │
│                                                  │
│  ┌──────────────┐  ┌──────────────────────────┐  │
│  │ SessionMgr   │  │  Telegram Bot (grammY)   │  │
│  │              │  │  - 토픽 생성/관리         │  │
│  │ session_id ↔│  │  - 메시지 전송            │  │
│  │ topic_id    │  │  - Reply → session 매핑   │  │
│  │ reply FIFO  │  │  - 👍 반응                │  │
│  │ state       │  │  - Live Stream (선택)     │  │
│  └──────┬───────┘  └────────────┬─────────────┘  │
│         │                       │                 │
│  ┌──────▼───────────────────────▼─────────────┐  │
│  │  State Machine                             │  │
│  │                                            │  │
│  │  idle → working → waiting → deliver →      │  │
│  │                                            │  │
│  │  waiting: TG 메시지 발송 → reply 대기       │  │
│  │  deliver: reply → hook에 전달              │  │
│  └────────────────────────────────────────────┘  │
│                                                  │
│  ┌────────────────────────────────────────────┐  │
│  │  HTTP Endpoints                            │  │
│  │  POST /hook/session-start                  │  │
│  │  POST /hook/stop                           │  │
│  │  GET  /status                              │  │
│  │  GET  /sessions                            │  │
│  └────────────────────────────────────────────┘  │
└──────────────────┬───────────────────────────────┘
                   │
              ┌────▼─────┐    ┌──────────────────┐
              │  Codex    │    │ ~/.codex/        │
              │  TUI (PTY)│    │ hooks.json       │
              └──────────┘    └──────────────────┘
```

### 4.3 프로젝트 구조

```
tl/
├── src/
│   ├── daemon.ts            — 메인 서버 (HTTP + TG 봇 초기화)
│   ├── session-manager.ts   — 세션↔토픽 매핑 + 상태 추적
│   ├── telegram.ts          — grammY 봇 (토픽/메시지/답장)
│   ├── store.ts             — sessions.json读写 (파일 기반)
│   ├── state-machine.ts     — idle/working/waiting/deliver
│   └── hooks/
│       ├── session-start.ts — SessionStart 후크 CLI
│       └── stop-wait.ts     — Stop 후크 CLI (블로킹 대기)
├── bin/
│   └── tl                   — CLI 진입점
├── hooks.json               — Codex hook 설정 템플릿
├── package.json
└── tsconfig.json
```

### 4.4 CLI 명령어

```bash
tl start              # 데몬 시작
tl stop               # 데몬 정지
tl status             # 활성 세션 목록
tl init               # hooks.json을 ~/.codex/에 설치
tl config set BOT_TOKEN=<token>  # 봇 토큰 설정
tl config set GROUP_ID=<id>      # TG Group ID 설정
```

### 4.5 세션 매핑 파일

```jsonc
// ~/.tl/sessions.json
{
  "sessions": {
    "codex-session-abc123": {
      "topic_id": 42,
      "chat_id": -1001234567890,
      "project": "/Users/flowkater/Projects/todait-ios",
      "created_at": "2026-04-04T23:00:00Z",
      "last_active": "2026-04-04T23:30:00Z",
      "status": "active",       // active | waiting | completed
      "last_turn_id": "turn-42",
      "total_turns": 15
    }
  }
}
```

### 4.6 TG 메시지 포맷

**작업 완료 알림:**
```
✅ Turn #15 완료

auth 모듈에 에러 핸들링 추가했어.
수정: AuthService.ts, AuthGuard.ts, api.test.ts
테스트: 12/12 PASS
```

**세션 시작:**
```
🟢 새 세션 — todait-ios
session: abc123
모델: gpt-5.4
```

**세션 종료:**
```
🏁 세션 종료
총 15턴 · 3파일 수정 · 1:02:34
```

### 4.7 설정

```jsonc
// ~/.tl/config.json
{
  "botToken": "123456:ABC-DEF...",
  "groupId": -1001234567890,
  "topicPrefix": "🔧",                    // 토픽명 프리픽스
  "hookPort": 9877,                       // 데몬 HTTP 포트
  "stopTimeout": 7200,                    // Stop 훅 대기 타임아웃 (초)
  "liveStream": false,                    // 실시간 로그 스트리밍 (선택)
  "emojiReaction": "👍"                   // 답장 확인 이모지
}
```

---

## 5. 핵심 설계 결정

### 5.1 커스텀 슬래시 커맨드 vs 자동 연결

이 절은 당시 비교 기준을 남긴 기록이다. 현재 권장 경로는 훅 기반 자동 연결 + optional local plugin이다.

**결정: 자동 연결 (SessionStart 훅)**

- 당시 Codex의 커스텀 프롬프트(deprecated) + 스킬은 `/prompts:tl` 형식이었고, 유저가 매번 입력해야 했음
- `SessionStart` 훅이 세션 시작 시 **자동 발동** → `/tl` 입력 불필요
- Codex 켜는 것만으로 TG 연결 완료 = 마찰 0

### 5.2 Stop Hook에서 답장 주입

**방식: `{"decision": "block", "reason": "<유저 답장>"}`**

- `decision: "block"`이 이 이벤트에서는 "거부"가 아니라 **"reason을 새 프롬프트로 계속"**
- exit 2 + stderr 대안도 지원
- Codex가 reason을 developer context로 받아 자연스러운 이어짐

### 5.3 동시 세션 격리

**방식: Telegram Topics (message_thread_id)**

- Group + Topics ON 필요 (1:1 채팅 불가)
- 각 세션 = 독립 토픽 → 메시지 충돌 0
- topic_id로 세션 엄격 매핑

### 5.4 연결 유지

**원칙: Codex 프로세스가 살아있는 한 연결 유지**

- Stop 훅은 매 턴 종료 시 발동 → `tl hook-stop-and-wait`가 블로킹 대기
- 답장 받으면 exit 0 → Codex 계속 → 다음 턴 → 다시 Stop 훅
- 무한 루프 구조 (현재 기본 timeout 2시간 안전장치)

---

## 6. 초기 개발 단계 기록

### Phase 1: PoC (1일)
- [ ] 단일 세션, 단일 턹
- [ ] SessionStart 훅 → 콘솔 로그
- [ ] Stop 훅 → 콘솔에 마지막 메시지 출력
- [ ] `tl hook-stop-and-wait`가 stdin으로 답장 받아 exit 0

### Phase 2: TG 연동 (1-2일)
- [ ] grammY 봇 설정
- [ ] TG Group 토픽 자동 생성
- [ ] Stop 훅 → TG 메시지 전송
- [ ] TG Reply → stdin 전달 → 👍 반응

### Phase 3: 멀티 세션 (1일)
- [ ] 동시 세션 2개 이상 지원
- [ ] topic_id ↔ session_id 매핑
- [ ] sessions.json 영구 저장
- [ ] 데몬 재시작 시 세션 복원

### Phase 4: Live Stream (선택, 1-2일)
- [ ] 각 토픽으로 실시간 stdout 스트리밍
- [ ] 청크 기반 전송 (5초 버퍼)
- [ ] 중요 이벤트 강조 (에러/테스트 실패/파일 수정)

### Phase 5: polish
- [ ] tl CLI 명령어 완성
- [ ] 설정 파일 관리
- [ ] 에러 핸들링/로깅
- [ ] README

---

## 7. 리스크 & 해결책

| 리스크 | 영향 | 해결 |
|--------|------|------|
| Stop 훅 timeout 초과 (2시간 무응답) | 세션 정지 | `continue: false`로 graceful stop + TG 알림 |
| 데몬 크래 시 reply 손실 | 답장 유실 | reply를 파일 큐에 저장 → 데몬 재시작 시 처리 |
| topic_id 변경 (TG 그룹 설정 변경) | 매핑 깨짐 | sessions.json에 chat_id + topic_id 이중 저장 |
| Codex 훅 버전 변경 | 훅 스키마 변경 | hooks.json 버전 관리 + 마이그레이션 스크립트 |
| 훅 프로세스가 Codex를 블로킹 | 개발 지연 | `tl hook-stop-and-wait`는 lightweight, HTTP 신호만 보내고 poll |

---

## 8. 미결정 사항

| 항목 | 옵션 | 비고 |
|------|------|------|
| Live Stream 기본 ON/OFF | OFF 권장 | 시끄러울 수 있음 |
| 토픽명 포맷 | `{prefix} {프로젝트명} — {시간}` | 설정 가능하게 |
| TG 봇 1개 vs 프로젝트별 | 1개 | todait 전용으로 시작 |
| Webhook vs Polling | Polling | 로컬 데몬이므로 polling 간편 |

---

## 9. 참고

- [Codex Hooks 공식 문서](https://developers.openai.com/codex/hooks)
- [Codex CLI Slash Commands](https://developers.openai.com/codex/cli/slash-commands) - 당시 비교 배경
- [Codex Custom Prompts (deprecated)](https://developers.openai.com/codex/custom-prompts) - 역사적 배경
- [Codex Skills (후속)](https://developers.openai.com/codex/skills)
- [Codex Config Reference](https://developers.openai.com/codex/config-reference)

---

*작성일: 2026-04-04*
*작성자: MUSE 💡*
