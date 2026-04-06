# TL — Codex ↔ Telegram Bridge

TL은 Codex 세션을 Telegram forum topic에 연결하는 로컬 bridge다.  
root 세션 시작 시 topic을 만들고, `Stop` 시점의 assistant 출력(`commentary + final`)을 Telegram으로 보내며, Telegram reply로 다음 턴을 다시 이어갈 수 있다.

## Start Here

### 아직 repo를 clone하지 않았다

가장 빠른 설치:

```bash
npm install -g github:tonyclaw/tl
tl help
```

이 경로는 source checkout 없이 설치만 필요할 때 적합하다.

### source도 같이 받고 싶다

```bash
git clone https://github.com/tonyclaw/tl.git ~/Projects/TL
cd ~/Projects/TL
npm install
npm run build
npm run test
npm install -g .
tl help
```

### 이미 TL이 설치되어 있다

업데이트만 하면 된다.

```bash
cd ~/Projects/TL
git pull
npm install
npm run build
npm run test
npm install -g .
```

## 설치에 필요한 것

- Node.js 20+
- npm 9+
- OpenAI Codex CLI

## 설정에 필요한 것

- Telegram Bot Token
- Topics가 켜진 Telegram group/supergroup
- TL이 쓸 Telegram `groupId` (`-100...`)
- 가능하면 봇 admin 권한

채널(channel) 기준 문서는 아니다. TL은 forum topic이 있는 group/supergroup을 전제로 한다.

## 빠른 설정

### 1. Codex hooks 기능 활성화

`~/.codex/config.toml`에 아래가 있어야 한다.

```toml
[features]
codex_hooks = true
```

### 2. TL 설정

자격증명이 있으면 가장 간단한 경로는 `tl setup`이다.  
현재 구현 기준으로 `tl setup`과 `tl init`은 기본적으로 `~/.codex/hooks.json`을 안전 병합한다.

```bash
export TL_BOT_TOKEN="123456:ABCdef..."
export TL_GROUP_ID="-1001234567890"
tl setup --non-interactive
```

interactive로 직접 진행해도 된다.

```bash
tl setup
```

자격증명이 아직 없으면 hooks만 먼저 설치한다.

```bash
tl init
```

그 다음 나중에 설정만 넣으면 된다.

```bash
tl config set \
  botToken="123456:ABCdef..." \
  groupId=-1001234567890 \
  hookPort=9877 \
  stopTimeout=7200 \
  emojiReaction="👍"

tl stop
tl start
tl status
```

## hooks 전략

### 기본 원칙

- TL hook는 최종 graph에서 `SessionStart` 1회, `Stop` 1회만 존재해야 한다.
- `tl setup`과 `tl init`은 direct TL hook를 병합한다.
- `tl init --force`만 명시적 overwrite다.
- 기존 router/wrapper가 내부적으로 TL을 이미 호출한다면 direct TL hook를 또 추가하면 안 된다.

### TL 기본 hook

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

### optional: working / heartbeat 알림

`🛠️ resumed, working...`와 `⏳ still working...`는 `UserPromptSubmit -> tl hook-working`이 연결되어 있을 때만 동작한다.  
기본 템플릿에는 포함되지 않는다.

필요하면 아래처럼 추가한다.

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

### 기존 custom hook가 있는 환경

자동 merge 전에 아래를 먼저 본다.

1. `~/.codex/hooks.json`이 이미 있는지
2. `SessionStart`/`Stop`에 TL direct hook가 이미 있는지
3. 기존 router/wrapper script가 TL을 내부에서 호출하는지

운영 원칙:

- TL이 이미 설치돼 있으면 no-op이어야 한다.
- router/wrapper가 TL을 호출하면 direct TL hook는 추가하지 않는다.
- backup 없이 `--force`를 쓰지 않는다.

## 검증

로컬:

```bash
tl help
tl status
cat ~/.codex/config.toml
cat ~/.codex/hooks.json
cat ~/.tl/config.json
```

Telegram:

1. 그룹에서 `/tl-status` 전송
2. 봇 응답 확인
3. 새 root Codex 세션 시작
4. topic 생성 확인
5. `Stop` 메시지에 reply
6. `✅ reply delivered to Codex, resuming...`와 resume 결과 확인

## 운영 메모

- TL은 root 세션 기준으로 topic을 관리한다.
- subagent `SessionStart`는 무시된다.
- `resume`된 세션은 기존 topic에 재연결된다.
- Stop 메시지 본문은 현재 turn의 assistant `commentary + final`을 transcript에서 합쳐서 만든다.
- 긴 Stop 메시지는 chunk로 나뉘어 전송될 수 있다.
- reply reaction은 TL이 Telegram reply를 수신했다는 의미다.
- `✅ reply delivered to Codex, resuming...`는 Stop hook 성공 경계까지 도달했을 때만 전송된다.
- topic 안에서는 일반 메시지도 같은 `thread_id` 기준으로 현재 topic의 최신 세션으로 라우팅된다.
- `All` 뷰처럼 `thread_id`가 없으면 `Reply`가 필요하다.
- `waiting`이 이미 끝난 뒤에도 같은 Stop 메시지에 reply가 오면 TL은 late reply를 기록하고 `codex exec resume --dangerously-bypass-approvals-and-sandbox ...` fallback을 시도한다.

## 업데이트 / 재설치

기본 경로:

```bash
cd ~/Projects/TL
git pull
npm install
npm run build
npm run test
npm install -g .
tl stop
tl start
tl status
```

원칙:

- 보통은 `~/.tl/config.json`을 유지한다.
- 이미 병합된 `~/.codex/hooks.json`도 유지한다.
- hook shape가 바뀐 릴리스에서만 `tl init` 또는 `tl setup`을 다시 검토한다.
- `tl init --force`는 마지막 수단이다.

## 문제 해결

### Telegram 메시지가 안 온다

1. `tl status`
2. `~/.tl/config.json`의 `botToken`, `groupId`
3. 봇이 올바른 group에 들어가 있는지
4. Topics가 켜져 있는지
5. `/tl-status`가 응답하는지

### 훅이 두 번 실행된다

대부분 아래 둘 중 하나다.

- TL direct hook와 router/wrapper 내부 TL 호출이 동시에 있음
- 같은 이벤트에 TL hook가 중복 병합됨

최종 graph에서 TL은 `SessionStart` 1회, `Stop` 1회만 남겨야 한다.

### rollback이 필요하다

1. `~/.codex/hooks.json.backup-*` 중 최근 백업 복원
2. `tl stop`
3. `tl start`
4. `tl status`

## Codex에게 설치 맡기기

repo가 이미 있으면:

```bash
cd ~/Projects/TL
codex exec --full-auto "Follow the instructions in https://github.com/tonyclaw/tl/blob/main/PROMPTS.md to install and configure TL safely"
```

repo가 아직 없으면:

```bash
codex exec --full-auto "Follow the instructions in https://github.com/tonyclaw/tl/blob/main/PROMPTS.md to install and configure TL safely. If https://github.com/tonyclaw/tl is not cloned locally yet, clone it first."
```

자격증명을 같이 넘길 수도 있다.

```bash
TL_BOT_TOKEN="123456:ABC..." TL_GROUP_ID="-1001234567890" \
  codex exec --full-auto "Follow the instructions in https://github.com/tonyclaw/tl/blob/main/PROMPTS.md to install and configure TL safely"
```

## LICENSE

MIT
