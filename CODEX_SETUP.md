# Codex에서 TL 설치 & 설정 가이드

이 문서는 Codex CLI 환경에서 TL을 안전하게 붙이는 절차를 설명한다.
핵심은 "작동"과 "기존 hook 보존"을 동시에 만족시키는 것이다.

## 1. TL 설치

```bash
git clone https://github.com/tonyclaw/tl.git ~/Projects/TL
cd ~/Projects/TL
npm install
npm run build
npm run test
npm install -g .
tl help
```

## 2. Codex hook 기능 활성화

`~/.codex/config.toml`에 아래가 필요하다.

```toml
[features]
codex_hooks = true
```

파일이 없으면 생성하고, 있으면 기존 내용을 유지한 채 `codex_hooks = true`만 보강한다.

## 3. Telegram 준비

### 봇 토큰

1. [@BotFather](https://t.me/botfather)에서 `/newbot`
2. 토큰 발급

### 그룹

1. Topics가 켜진 Telegram 그룹 준비
2. 봇 초대
3. 가능하면 admin 권한 부여
4. group ID 확보
   - 보통 `-100...` 형태

## 4. hooks 설치 방식 선택

### A. Clean 환경

`~/.codex/hooks.json`이 아직 없다면:

```bash
tl init
```

또는

```bash
cp ~/Projects/TL/templates/hooks.json ~/.codex/hooks.json
```

### B. 기존 hooks.json이 있는 환경

이 경우가 더 중요하다.

주의:

- `tl setup`은 현재 `~/.codex/hooks.json`을 TL 템플릿으로 덮어쓴다.
- `tl init --force`도 overwrite다.
- 기존 wrapper/router가 있으면 TL hook를 direct로 또 추가하면 중복 호출된다.

권장 절차:

1. 기존 `~/.codex/hooks.json` 백업
2. 기존 구조 유지
3. TL hook 두 개만 중복 없이 병합

필요한 TL command:

`SessionStart`

```json
{
  "type": "command",
  "command": "tl hook-session-start",
  "statusMessage": "Connecting to Telegram..."
}
```

`Stop`

```json
{
  "type": "command",
  "command": "tl hook-stop-and-wait",
  "timeout": 7200
}
```

최종 조건:

- `tl hook-session-start`는 전체 hook graph에서 한 번만
- `tl hook-stop-and-wait`도 전체 hook graph에서 한 번만

## 5. TL 설정 저장

### Clean 환경에서 간단히

```bash
export TL_BOT_TOKEN="123456:ABCdef..."
export TL_GROUP_ID="-1001234567890"
tl setup --non-interactive
```

이 방식은 hooks overwrite를 동반할 수 있으므로 clean 환경에서만 권장한다.

### 기존 custom hook가 있으면 안전하게

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

그 다음 daemon 재시작:

```bash
tl stop
tl start
```

## 6. 검증

```bash
tl status
cat ~/.codex/config.toml
cat ~/.codex/hooks.json
cat ~/.tl/config.json
```

Telegram 검증:

1. 그룹에서 `/tl-status@<bot_username>` 전송
2. 봇 응답 확인
3. 새 root Codex 세션 시작
4. topic 생성 확인

## 7. 운영 시 알아둘 점

- TL은 root 세션 기준으로 topic을 관리한다.
- subagent `SessionStart`는 무시된다.
- `resume`은 기존 topic에 다시 붙는다.
- Stop hook는 Telegram reply를 기다릴 수 있다.
- Stop 메시지 본문은 현재 turn의 assistant `commentary + final`을 transcript에서 합쳐서 만든다.
- 긴 Stop 메시지는 여러 조각으로 나뉘어 전송될 수 있다.
- `waiting` 중 reply가 consumer보다 먼저 와도 queue에 저장됐다가 같은 wait에서 소비된다.
- reply reaction은 TL 수신만 의미한다.
- `✅ reply delivered to Codex, resuming...` 메시지는 `hook-stop-and-wait`가 성공 경로를 끝낸 뒤에만 전송된다.
- 재개 후 root 세션에는 `🛠️ resumed, working...` 메시지가 1회 전송되고, 장시간 작업에서만 `⏳ still working...` heartbeat가 추가된다.
- 같은 topic 안에서는 일반 메시지도 `thread_id` 기준으로 해당 topic의 최신 세션으로 라우팅된다. `All` 뷰처럼 `thread_id`가 없을 때만 `Reply`가 필요하다.
- `waiting`이 이미 끝난 뒤에도 같은 Stop 메시지에 reply가 오면 TL은 `completed` 세션까지 `stop_message_id`로 매칭하고, late reply를 기록한 뒤 `codex exec resume --dangerously-bypass-approvals-and-sandbox <session_id> <reply>` fallback을 시도한다.

## 8. 문제 해결

### 훅이 두 번 실행됨

원인:

- TL direct hook와 wrapper/router 내부 TL 호출이 동시에 존재

해결:

- TL 훅 경로를 하나로 정리한다.

### Telegram 메시지가 안 옴

체크:

1. `tl status`
2. `~/.tl/config.json`
3. bot admin 여부
4. Topics 활성화 여부
5. `/tl-status@<bot_username>` 응답 여부

참고:

- TL은 일부 macOS/Node 환경에서 Telegram HTTPS 타임아웃을 피하려고 IPv4 agent를 사용한다.

### Stop hook가 오래 걸림

이유는 둘 중 하나다.

- 실제로 Telegram reply를 기다리는 정상 동작
- 전송 실패 후 재시도 또는 session mapping 문제

## 9. Codex에게 설치 맡기기

가장 안전한 방식은 `PROMPTS.md`를 그대로 쓰는 것이다.

```bash
cd ~/Projects/TL
codex exec --full-auto "Follow the instructions in PROMPTS.md to install and configure TL safely"
```

자격증명을 같이 넘길 수도 있다.

```bash
cd ~/Projects/TL
TL_BOT_TOKEN="123456:ABC..." TL_GROUP_ID="-1001234567890" \
  codex exec --full-auto "Follow the instructions in PROMPTS.md to install and configure TL safely"
```
