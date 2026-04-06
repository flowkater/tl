---
name: tl-setup
description: "Codex ↔ Telegram Bridge (TL) 연동 설정. BotFather 토큰, 그룹 ID 등을 순차적으로 수집하고 tl setup을 실행하여 자동 연동."
category: devops
---

# TL Setup — Codex ↔ Telegram Bridge 연동

## Trigger

- "tl setup", "tl-setup", "TL 연동", "코덱스 텔레그램 연동", "Codex Telegram bridge", "setup tl"

## Prerequisites

- `~/Projects/TL` 디렉토리가 존재해야 함
- Node.js 20+ 설치되어 있어야 함
- Telegram Bot Token (@BotFather에서 발급) 필요
- Telegram Group/Channel ID 필요

## Setup Process

**1단계: 프로젝트 확인**

```bash
cd ~/Projects/TL && ls package.json
```

프로젝트가 없으면 먼저 clone/설치 필요.

**2단계: 필요한 값 수집**

사용자에게 다음 값을 **순차적으로** 하나씩 물어본다 (한 번에 모두 묻지 않음):

1. **Telegram Bot Token** — @BotFather에게 `/newbot`으로 발급받은 토큰
   - 형식: `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`
   - 만약 토큰이 없으면 @BotFather 사용법 안내

2. **Telegram Group/Channel ID** — 연동할 그룹의 ID
   - 형식: `-1001234567890` (음수, 10~14자리)
   - 그룹에 봇을 먼저 어드민으로 추가해야 함
   - ID를 모르면 `@getmyid_bot` 등으로 확인 안내

3. **Hook Port** (선택, 기본값: 9877) — 별도 지정 없으면 기본값 사용

4. **Stop Timeout** (선택, 기본값: 7200) — Codex가 멈춘 후 사용자 답장 대기 시간(초)

5. **Hook Base URL** (선택, 기본값: `http://localhost:{port}`) — 외부에서 접근 가능한 URL

**3단계: tl setup 실행**

수집한 값으로 환경변수를 설정하고 non-interactive 모드로 실행:

```bash
cd ~/Projects/TL

# 빌드 확인
npm run build

# 환경변수로 설정
export TL_BOT_TOKEN="수집한_토큰"
export TL_GROUP_ID="수집한_그룹ID"
# 선택사항:
# export TL_HOOK_PORT=9877
# export TL_STOP_TIMEOUT=7200
# export TL_HOOK_BASE_URL="http://localhost:9877"

# 자동 설치
npx tsx bin/tl setup --non-interactive
```

**4단계: 검증**

```bash
# 데몬 상태 확인
npx tsx bin/tl status

# 설정 확인
npx tsx bin/tl config get

# 세션 목록 (아직 없으면 empty)
npx tsx bin/tl sessions
```

**5단계: Telegram에서 테스트**

사용자에게 안내:
> 텔레그램 그룹에서 `/tl-status`를 보내서 봇이 응답하는지 확인하세요.

## Interactive Mode

사용자가 터미널에서 직접 실행하려면:

```bash
cd ~/Projects/TL && npx tsx bin/tl setup
```

대화형으로 각 값을 하나씩 물어본다.

## Troubleshooting

### Bot Token이 유효하지 않음
- @BotFather에서 `/mybots`로 토큰 재발급 확인
- 토큰 형식: `숫자:영문자`

### Group ID를 찾을 수 없음
- 그룹에 봇이 어드민으로 추가되어 있는지 확인
- `@RawDataBot`이나 `@getmyid_bot`으로 ID 확인

### Daemon이 시작되지 않음
- 포트 충돌 확인: `lsof -i :9877`
- 빌드 확인: `npm run build`
- 로그 확인: `~/.tl/` 디렉토리

### hooks.json이 설치되지 않음
- `~/.codex/hooks.json` 존재 확인
- 수동 설치: `npx tsx bin/tl init`
