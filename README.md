# TL — Codex ↔ Telegram Bridge

> Codex 세션을 Telegram 토픽에 연결하여, 터미널 밖에서도 개발을 계속할 수 있게 하는 로컬 브릿지.

**목표**: 터미널 안 봐도 됨. Codex가 작업하는 동안 텔레그램으로 확인하고, 답장만으로 개발 계속.

---

## 🏗️ 아키텍처

```
┌──────────────────┐         ┌───────────────────────┐         ┌──────────────┐
│  Codex CLI       │         │  tl daemon            │         │  Telegram    │
│  (PTY TUI)       │ ─hook→  │  (Hono HTTP :9877)    │ ─bot→   │  Group Topic │
│                  │ ←wait── │  + grammy Bot          │ ←reply─ │              │
└──────────────────┘         └───────────────────────┘         └──────────────┘
```

1. **SessionStart 훅** → tl 데몬이 Telegram에 새 토픽 생성
2. **Stop 훅** → 작업 완료 메시지 TG 토픽으로 전송 → 답장 대기
3. **유저 답장** → tl 데몬이 훅 프로세스에 전달 → Codex가 새 프롬프트로 계속

---

## 📦 설치

### 필수 요구사항

- **Node.js** 20+
- **npm** 9+
- **OpenAI Codex CLI** 설치됨 (`npm install -g @openai/codex`)
- **Telegram Bot Token** (@BotFather에서 `/newbot`)
- **Telegram Group (Topics ON)** — 1:1 채팅 불가, 그룹 필수

### 빠른 시작

```bash
git clone https://github.com/tonyclaw/tl.git
cd tl
npm install
npm run build
```

### 설정

```bash
# 대화형 설정
npx tsx bin/tl setup

# 또는 환경변수로 (스크립트/자동화용)
export TL_BOT_TOKEN="123456:ABCdef..."
export TL_GROUP_ID="-1001234567890"
npx tsx bin/tl setup --non-interactive
```

### 데몬 시작

```bash
npx tsx bin/tl start
```

### 검증

```bash
npx tsx bin/tl status
# Telegram 그룹에서 /tl-status 전송 → 봇 응답 확인
```

---

## 🎯 사용법

### 새 세션 시작

```bash
cd my-project
codex
# SessionStart 훅이 자동으로 TG 토픽 생성
```

### 세션 관리

```bash
npx tsx bin/tl sessions          # 모든 세션
npx tsx bin/tl sessions active   # 활성 세션만
npx tsx bin/tl status            # 데몬 상태
```

### 설정 변경

```bash
npx tsx bin/tl config get              # 전체 설정
npx tsx bin/tl config get botToken     # 특정 값
npx tsx bin/tl config set hookPort=9999  # 설정 변경
```

### 데몬 관리

```bash
npx tsx bin/tl start    # 시작
npx tsx bin/tl stop     # 정지
npx tsx bin/tl status   # 상태 확인
```

## 🤖 Codex에게 설치 맡기기 (권장)

레포에 `PROMPTS.md`를 동봉해두면 Codex가 알아서 설치합니다:

**방법 1: PROMPTS.md 사용 (권장)**
```bash
cd tl
codex exec --full-auto "Follow the instructions in PROMPTS.md to install and configure TL"
```

**방법 2: 한 줄 명령어**
```bash
codex exec --full-auto "npm install && npm run build && mkdir -p ~/.codex && echo -e '[features]\ncodex_hooks = true' >> ~/.codex/config.toml && cp templates/hooks.json ~/.codex/hooks.json && npm install -g ."
```

PROMPTS.md가 하는 일:
1. `npm install` + `npm run build` — 의존성 설치 및 빌드
2. `~/.codex/config.toml`에 `codex_hooks = true` 설정
3. `templates/hooks.json` → `~/.codex/hooks.json` 복사
4. `npm install -g .` — `tl` 명령어 전역 설치
5. `npm run test` — 테스트 검증
6. 봇 토큰/그룹 ID는 건드리지 않음 (사용자 설정 영역)

---

## 📋 CLI 명령어

| 명령어 | 설명 |
|--------|------|
| `tl start` | 데몬 시작 (백그라운드) |
| `tl stop` | 데몬 정지 |
| `tl status` | 데몬 상태 + 활성 세션 |
| `tl sessions [filter]` | 세션 목록 (active/waiting/completed) |
| `tl resume <session_id>` | 세션 재개 |
| `tl setup [--non-interactive]` | Telegram 연동 설정 |
| `tl init [--force]` | Codex hooks.json 설치 |
| `tl config get [KEY]` | 설정 조회 |
| `tl config set KEY=VALUE` | 설정 변경 |

---

## 🗂️ 프로젝트 구조

```
tl/
├── src/
│   ├── daemon.ts            # 메인 서버 (HTTP + TG 봇)
│   ├── session-manager.ts   # 세션↔토픽 매핑 + 상태 추적
│   ├── telegram.ts          # grammY 봇 (토픽/메시지/답장)
│   ├── store.ts             # 파일 기반 세션 저장
│   ├── reply-queue.ts       # 답장 FIFO 큐
│   ├── config.ts            # 설정 관리
│   ├── logger.ts            # 로깅
│   ├── errors.ts            # 에러 정의
│   ├── cli.ts               # CLI 진입점
│   ├── types.ts             # 타입 정의
│   └── hooks/
│       ├── session-start.ts # SessionStart 훅 CLI
│       └── stop-and-wait.ts # Stop 훅 CLI (블로킹 대기)
├── bin/
│   └── tl                   # CLI 래퍼
├── templates/
│   └── hooks.json           # Codex hook 템플릿
├── skills/
│   └── tl-setup/
│       └── SKILL.md         # Hermes Agent 스킬
├── tests/                   # vitest 테스트
├── docs/                    # 설계 문서
├── package.json
└── tsconfig.json
```

---

## 🔧 기술 스택

| 항목 | 선택 |
|------|------|
| 런타임 | Node.js 20+ / TypeScript |
| HTTP 서버 | Hono + @hono/node-server |
| Telegram 봇 | grammY |
| 개발 서버 | tsx watch |
| 테스트 | vitest |
| 상태 저장 | JSON 파일 (`~/.tl/sessions.json`) |

---

## 🧪 개발

```bash
npm install          # 의존성 설치
npm run build        # TypeScript 컴파일
npm run dev          # 개발 모드 (watch)
npm run test         # 테스트 실행
npm run test:watch   # 테스트 watch 모드
```

---

## ⚙️ 설정 파일

### `~/.tl/config.json`

```json
{
  "botToken": "123456:ABCdef...",
  "groupId": -1001234567890,
  "hookPort": 9877,
  "hookBaseUrl": "http://localhost:9877",
  "stopTimeout": 3600,
  "emojiReaction": "👍",
  "liveStream": false
}
```

### `~/.codex/hooks.json` (자동 설치)

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "tl hook-session-start",
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
            "timeout": 3600
          }
        ]
      }
    ]
  }
}
```

> Codex에서 hooks를 사용하려면 `~/.codex/config.toml`에 `codex_hooks = true` 설정이 필요합니다.

---

## 📄 LICENSE

MIT
