# TL — Codex ↔ Telegram Bridge

Codex 세션을 Telegram forum topic에 연결하는 로컬 bridge다.
작업 완료 메시지를 Telegram으로 받고, reply만으로 다음 턴을 이어갈 수 있다.

## 동작 개요

```text
Codex hook
  -> tl daemon (HTTP + Telegram bot)
  -> Telegram topic
  -> user reply
  -> tl daemon
  -> Codex Stop hook result
```

기본 흐름:

1. root `SessionStart`에서 topic 생성 또는 재연결
2. `Stop`에서 마지막 메시지를 Telegram으로 전송
3. Telegram reply를 받으면 Stop hook 결과를 Codex에 반환

현재 구현 기준 추가 동작:

- subagent `SessionStart`는 무시된다.
- `resume`으로 다시 열린 세션은 기존 topic에 재연결된다.
- Stop 메시지 본문은 현재 turn의 assistant `commentary + final`을 transcript에서 합쳐서 만든다.
- 긴 Stop 메시지는 잘리지 않도록 여러 조각으로 나뉘어 전송된다.
- `waiting` 중 reply가 consumer보다 먼저 도착해도 queue에 저장됐다가 같은 wait에서 소비된다.
- Stop 메시지 전송이 최종 실패하면 세션을 `waiting`에 방치하지 않고 다시 `active`로 복구한다.
- reply reaction은 TL이 reply를 수신했다는 뜻이고, 별도의 `✅ reply delivered to Codex, resuming...` 메시지는 Stop hook 성공 경로에서만 전송된다.
- 재개 후 root 세션에는 `🛠️ resumed, working...` 메시지가 추가되고, 장시간 작업일 때만 `⏳ still working...` heartbeat가 드물게 append된다.
- 같은 topic 안에서는 일반 메시지도 `thread_id` 기준으로 해당 topic의 최신 세션으로 라우팅된다. `All` 뷰처럼 `thread_id`가 없을 때만 `Reply`가 필요하다.
- `waiting`이 이미 끝난 뒤에도 같은 Stop 메시지에 reply가 오면 TL은 `completed` 세션까지 `stop_message_id`로 매칭하고, late reply를 기록한 뒤 `codex exec resume --dangerously-bypass-approvals-and-sandbox <session_id> <reply>` fallback을 시도한다.

## 요구사항

- Node.js 20+
- npm 9+
- OpenAI Codex CLI
- Telegram Bot Token
- Topics가 켜진 Telegram 그룹
- 봇이 해당 그룹에 추가되어 있고, 가능하면 admin 권한이 있는 상태

## 빠른 시작

```bash
git clone https://github.com/tonyclaw/tl.git
cd tl
npm install
npm run build
npm run test
npm install -g .
```

## Codex hooks 설치

TL 템플릿은 `templates/hooks.json`에 들어 있다.
이 템플릿은 intentionally minimal TL-only 구성이며, 아래 두 command만 포함한다.

```json
{
  "type": "command",
  "command": "tl hook-session-start",
  "statusMessage": "Connecting to Telegram..."
}
```

```json
{
  "type": "command",
  "command": "tl hook-stop-and-wait",
  "timeout": 7200
}
```

중요:

- `tl setup`은 현재 `~/.codex/hooks.json`을 TL 템플릿으로 복사한다.
- `tl init --force`도 overwrite다.
- 기존 `hooks.json`에 다른 hook가 있다면, overwrite 대신 backup 후 병합해야 한다.
- 최종 hook graph에서 TL hook는 이벤트당 정확히 한 번만 존재해야 한다.
  - `SessionStart`의 `tl hook-session-start` 한 번
  - `Stop`의 `tl hook-stop-and-wait` 한 번
- wrapper/router가 이미 TL을 호출한다면 raw TL hook를 또 추가하면 안 된다.

### Clean 환경

`~/.codex/hooks.json`이 아직 없다면 아래 중 하나를 써도 된다.

```bash
tl init
```

또는

```bash
cp templates/hooks.json ~/.codex/hooks.json
```

### 기존 hooks.json이 이미 있는 환경

권장 절차:

1. 기존 파일 백업
2. 기존 `SessionStart`와 `Stop` 구조 유지
3. TL hook command만 중복 없이 병합
4. JSON 파싱 확인

`tl setup`이나 `tl init --force`를 그대로 쓰지 않는 편이 안전하다.

## 설정

### 1. Codex hook 기능 활성화

`~/.codex/config.toml`에 아래가 필요하다.

```toml
[features]
codex_hooks = true
```

기존 파일이 있다면 다른 설정은 유지하고 `codex_hooks = true`만 추가한다.

### 2. TL 설정값 저장

설정 파일 위치:

- `~/.tl/config.json`

필수 값:

- `botToken`
- `groupId`

선택 값:

- `hookPort` 기본값 `9877`
- `hookBaseUrl` 기본값 `http://localhost:9877`
- `stopTimeout` 기본값 `7200`
- `emojiReaction` 기본값 `👍`
- `liveStream` 기본값 `false`

### Clean 환경에서 빠르게 설정

```bash
export TL_BOT_TOKEN="123456:ABCdef..."
export TL_GROUP_ID="-1001234567890"
tl setup --non-interactive
```

단, 이 경로는 `~/.codex/hooks.json` overwrite를 수반할 수 있으므로 clean 환경에서만 권장한다.

### 기존 custom hook가 있는 환경에서 안전하게 설정

```bash
tl config set \
  botToken="123456:ABCdef..." \
  groupId=-1001234567890 \
  hookPort=9877 \
  hookBaseUrl="http://localhost:9877" \
  stopTimeout=7200 \
  emojiReaction="👍" \
  liveStream=false
```

그 다음 daemon을 재시작한다.

```bash
tl stop
tl start
```

## 검증

```bash
tl help
tl status
cat ~/.codex/config.toml
cat ~/.codex/hooks.json
cat ~/.tl/config.json
```

Telegram 쪽 검증:

1. 대상 그룹에 봇 추가
2. 그룹에서 `/tl-status@<bot_username>` 전송
3. 새 root Codex 세션 시작
4. topic 생성 여부 확인

## Codex에게 설치 맡기기

`PROMPTS.md`는 아래 문제를 피하도록 업데이트되어 있다.

- 기존 `hooks.json` overwrite
- TL hook 중복 등록
- wrapper/router와 TL direct hook의 이중 호출
- 자격증명 없는 상태에서 interactive setup 강행

권장 실행:

```bash
cd tl
codex exec --full-auto "Follow the instructions in PROMPTS.md to install and configure TL safely"
```

또는 자격증명을 같이 넘길 수 있다.

```bash
cd tl
TL_BOT_TOKEN="123456:ABC..." TL_GROUP_ID="-1001234567890" \
  codex exec --full-auto "Follow the instructions in PROMPTS.md to install and configure TL safely"
```

## 세션/운영 메모

### 새 세션 시작

```bash
cd my-project
codex
```

주의:

- TL 훅 설치 전에 이미 열려 있던 Codex 세션에는 `SessionStart`가 소급 적용되지 않는다.
- 설치 후 topic 생성은 새 root 세션부터 적용된다.

### 세션 상태 확인

```bash
tl sessions
tl sessions active
tl sessions waiting
tl status
```

### TL 대기 상태만 복구

```bash
tl resume <session_id>
```

이 명령은 Codex 세션 자체를 다시 여는 명령이 아니다.
열려 있는 Codex 세션은 유지한 채 TL waiting 상태만 풀어준다.

## 문제 해결

### Telegram 메시지가 안 옴

확인 순서:

1. `tl status`
2. `~/.tl/config.json`의 `botToken`, `groupId`
3. 봇이 그룹에 있는지
4. Topics가 켜져 있는지
5. `/tl-status@<bot_username>` 응답 여부

참고:

- TL은 일부 macOS/Node 환경에서 Telegram HTTPS 타임아웃을 피하기 위해 IPv4 agent를 사용한다.
- reply reaction만 찍히고 resume ACK가 안 오면, TL 수신은 됐지만 `hook-stop-and-wait` 성공 경계까지는 가지 못한 상황으로 봐야 한다.

### 훅이 두 번 실행됨

원인:

- TL hook를 direct로 넣고
- wrapper/router 안에서도 TL을 또 호출한 경우

해결:

- TL hook path는 최종적으로 이벤트당 한 번만 남긴다.

### Stop hook이 오래 기다림

가능한 원인:

- 실제로 Telegram reply를 기다리는 정상 대기
- 전송 실패 재시도
- session mapping이 없는 Stop

현재 구현은:

- early reply queue 처리
- 전송 재시도
- 전송 실패 시 `active` 복구

를 포함한다.

## 주요 명령어

| 명령어 | 설명 |
|--------|------|
| `tl start` | daemon 시작 |
| `tl stop` | daemon 정지 |
| `tl status` | daemon 상태 |
| `tl sessions [filter]` | 세션 목록 |
| `tl resume <session_id>` | waiting 세션 복구 |
| `tl setup [--non-interactive]` | 설정 저장 + hooks 설치 + daemon 재시작 |
| `tl init [--force]` | TL hooks 템플릿 설치 |
| `tl config get [KEY]` | 설정 조회 |
| `tl config set KEY=VALUE` | 설정 변경 |

## 설정 파일 예시

### `~/.tl/config.json`

```json
{
  "botToken": "123456:ABCdef...",
  "groupId": -1001234567890,
  "hookPort": 9877,
  "hookBaseUrl": "http://localhost:9877",
  "stopTimeout": 7200,
  "emojiReaction": "👍",
  "liveStream": false
}
```

## LICENSE

MIT
