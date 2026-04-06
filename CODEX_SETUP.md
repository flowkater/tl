# Codex에서 TL 설치 & 설정 가이드

이 문서는 Codex CLI 환경에서 TL을 안전하게 붙이는 운영 매뉴얼이다.  
핵심은 `작동`, `기존 hook 보존`, `재설치 용이성` 세 가지다.

## 0. 시작 경로 선택

### A. 기본 설치

대부분은 source checkout 없이 여기까지만 하면 된다.

```bash
npm install -g github:flowkater/tl
tl help
tl plugin install
tl plugin status
```

### B. TL 자체를 수정하거나 테스트해야 할 때만 source checkout

```bash
git clone https://github.com/flowkater/tl.git ~/Projects/TL
cd ~/Projects/TL
npm install
npm run build
npm run test
npm install -g .
tl plugin install
tl plugin status
```

## 1. Codex hooks 기능 활성화

`~/.codex/config.toml`

```toml
[features]
codex_hooks = true
```

## 2. Telegram 준비

필수:

- BotFather 토큰
- Topics-enabled group/supergroup
- `groupId` (`-100...`)

권장:

- 봇 admin 권한

## 2.5. TL local plugin

TL은 optional local Codex plugin을 제공한다.

```bash
tl plugin install
tl plugin status
```

설치 위치:

- `~/plugins/tl-tools`
- `~/.agents/plugins/marketplace.json`

제공 tool:

- `tl_status`
- `tl_list_sessions`
- `tl_resume_session`
- `tl_start_daemon`
- `tl_stop_daemon`
- `tl_get_config`
- `tl_set_config`

## 3. hooks 설치 전략

### 기본 경로

```bash
tl init
```

현재 구현 기준:

- `tl init`은 `~/.codex/hooks.json`을 safe merge한다
- TL hook가 이미 있으면 no-op이다
- `tl init --force`만 overwrite다

### 꼭 확인할 것

1. TL hook가 이미 있는가
2. custom router/wrapper가 TL을 내부에서 호출하는가

운영 원칙:

- TL direct hook와 custom router 내부 TL 호출을 동시에 두지 않는다
- 최종 graph에서 TL은 `SessionStart` 1회, `Stop` 1회만 남긴다

### TL 기본 hook 모양

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
            "timeout": 7200
          }
        ]
      }
    ]
  }
}
```

### optional: working / heartbeat

`UserPromptSubmit`에 아래를 추가한 경우에만 working/heartbeat가 보인다.

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "tl hook-working"
          }
        ]
      }
    ]
  }
}
```

## 4. TL 설정 저장

### 자격증명이 준비된 경우

```bash
export TL_BOT_TOKEN="123456:ABCdef..."
export TL_GROUP_ID="-1001234567890"
tl setup --non-interactive
```

`tl setup`은:

- `~/.tl/config.json` 저장
- `~/.codex/hooks.json` safe merge
- daemon 재시작

까지 한 번에 처리한다.

### 자격증명이 아직 없는 경우

hooks만 먼저 설치:

```bash
tl init
```

나중에 설정만 넣기:

```bash
tl config set \
  botToken="123456:ABCdef..." \
  groupId=-1001234567890 \
  hookPort=9877 \
  stopTimeout=7200 \
  emojiReaction="👍"
```

## 5. daemon 재시작

아래 경우에는 기본적으로 재시작한다.

- `npm install -g .` 직후
- `tl config set` 직후
- `~/.tl/config.json` 수동 수정 후
- hook 구조 변경 후

명령:

```bash
tl stop
tl start
tl status
```

`tl stop`은 daemon이 없어도 치명 오류로 보지 않는다.

## 6. 검증

로컬:

```bash
tl help
tl status
tl plugin status
cat ~/.codex/config.toml
cat ~/.codex/hooks.json
cat ~/.tl/config.json
```

Telegram:

1. `/tl-status`
2. 새 root Codex 세션 시작
3. topic 생성 확인
4. Stop 메시지 reply
5. `✅ reply delivered to Codex, resuming...` 확인

## 7. 재설치 / 업데이트 규칙

기본 원칙:

- `~/.tl/config.json`은 유지한다
- 이미 병합된 `~/.codex/hooks.json`도 유지한다
- hook shape 변경이 없는 릴리스에서는 `tl init --force`를 다시 쓰지 않는다

업데이트:

```bash
npm install -g github:flowkater/tl
tl plugin install
tl stop
tl start
tl status
```

source checkout으로 TL 자체를 수정하는 경우에만 아래 경로를 사용한다.

```bash
cd ~/Projects/TL
git pull
npm install
npm run build
npm run test
npm install -g .
tl plugin install
tl stop
tl start
tl status
```

## 8. rollback

문제가 생기면:

1. `~/.codex/hooks.json.backup-*` 중 최신 백업 확인
2. 원래 `~/.codex/hooks.json`으로 복원
3. `tl stop`
4. `tl start`
5. `tl status`

## 9. 운영 메모

- TL은 root 세션 기준으로 topic을 관리한다.
- subagent `SessionStart`는 무시된다.
- topic 안에서는 일반 메시지도 `thread_id` 기준으로 현재 topic의 최신 세션으로 라우팅된다.
- `All` 뷰처럼 `thread_id`가 없으면 `Reply`가 필요하다.
- reply reaction은 Telegram 수신만 의미한다.
- `✅ reply delivered to Codex, resuming...`는 Stop hook 성공 경계에서만 전송된다.
- `waiting`이 이미 끝난 뒤에도 같은 Stop 메시지에 reply가 오면 late reply resume fallback이 시도된다.

## 10. Codex에게 맡기기

기본 경로는 항상 같다.

```bash
codex exec --full-auto "Follow the instructions in https://github.com/flowkater/tl/blob/main/PROMPTS.md to install and configure TL safely"
```

source checkout이 꼭 필요한 경우에만, 그 사실을 별도로 명시해서 Codex에게 맡긴다.
