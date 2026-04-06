---
name: tl-setup
description: "Codex ↔ Telegram Bridge(TL) 설치와 설정. repo가 없어도 clone부터 시작하고, safe hooks merge와 daemon 재시작까지 포함해 안전하게 연동한다."
category: devops
---

# TL Setup

## Trigger

- "tl setup"
- "tl-setup"
- "TL 연동"
- "Codex Telegram bridge"
- "setup tl"

## Principles

- repo가 없으면 clone부터 시작한다.
- 기존 `~/.codex/hooks.json`은 보존한다.
- TL hook는 최종 graph에서 `SessionStart` 1회, `Stop` 1회만 존재해야 한다.
- router/wrapper가 TL을 이미 내부에서 호출하면 direct TL hook를 또 추가하지 않는다.
- `tl init --force`는 마지막 수단이다.

## Bootstrap

### repo가 없는 경우

설치만 필요하면:

```bash
npm install -g github:tonyclaw/tl
tl help
```

source가 필요하면:

```bash
git clone https://github.com/tonyclaw/tl.git ~/Projects/TL
cd ~/Projects/TL
npm install
npm run build
npm run test
npm install -g .
```

### repo가 이미 있는 경우

```bash
cd ~/Projects/TL
npm install
npm run build
npm run test
npm install -g .
```

## Setup Process

### 1. Codex hooks 기능 확인

`~/.codex/config.toml`에서 아래를 보장한다.

```toml
[features]
codex_hooks = true
```

### 2. hooks 설치 전략

기본:

```bash
tl init
```

확인할 것:

- `~/.codex/hooks.json` 존재 여부
- TL direct hook 중복 여부
- 기존 router/wrapper가 TL을 내부에서 호출하는지 여부

### 3. Telegram 자격증명 수집

필요한 값:

1. `TL_BOT_TOKEN`
2. `TL_GROUP_ID`

추가로 필요한 환경:

- Topics-enabled Telegram group/supergroup
- 봇이 그 group에 들어가 있어야 함

### 4. 실제 설정

자격증명이 있으면:

```bash
TL_BOT_TOKEN="..." TL_GROUP_ID="-100..." tl setup --non-interactive
```

자격증명이 없으면:

- `tl init`까지만 수행
- 다음 명령만 남긴다:

```bash
tl config set botToken="..." groupId=-100...
tl stop
tl start
tl status
```

### 5. 검증

로컬:

```bash
tl help
tl status
cat ~/.codex/hooks.json
cat ~/.tl/config.json
```

Telegram:

1. `/tl-status`
2. 새 root Codex 세션 시작
3. topic 생성 확인
4. Stop 메시지 reply
5. resume 확인

## Notes

- TL은 channel이 아니라 forum topic이 있는 group/supergroup을 전제로 한다.
- `🛠️ resumed, working...`와 heartbeat는 `UserPromptSubmit -> tl hook-working`이 추가돼 있을 때만 동작한다.
- topic 안에서는 일반 메시지도 같은 `thread_id` 기준으로 세션에 들어간다.
- `All` 뷰처럼 `thread_id`가 없으면 `Reply`가 필요하다.
- late reply는 `codex exec resume --dangerously-bypass-approvals-and-sandbox ...` fallback으로 이어질 수 있다.
