# TL — Codex ↔ Telegram Bridge 설치 프롬프트

이 파일은 Codex에게 그대로 던질 수 있는 설치 프롬프트다.
핵심 목표는 두 가지다.

- TL을 실제로 동작 가능한 상태까지 설치한다.
- 기존 `~/.codex/hooks.json`과 다른 훅을 망가뜨리지 않는다.

## 권장 사용법

### 1. 설치만 먼저

```bash
cd ~/Projects/TL
codex exec --full-auto "Follow the instructions in PROMPTS.md to install TL safely"
```

### 2. Telegram 자격증명까지 같이 설정

```bash
cd ~/Projects/TL
TL_BOT_TOKEN="123456:ABC..." TL_GROUP_ID="-1001234567890" \
  codex exec --full-auto "Follow the instructions in PROMPTS.md to install and configure TL safely"
```

## Codex에게 전달할 프롬프트

```text
당신은 TL(Codex ↔ Telegram Bridge)을 설치하고 설정하는 작업을 맡았다.
설명만 하지 말고, 가능한 범위까지 실제로 수행하라.

다음 원칙을 반드시 지켜라.

원칙 1. 기존 `~/.codex/hooks.json`이 있으면 절대 바로 덮어쓰지 마라.
- 먼저 백업을 만든다.
- 기존 훅과 TL 훅을 병합한다.
- unrelated hook를 삭제하지 마라.
- 이미 TL이 들어가 있으면 중복 추가하지 마라.

원칙 2. `tl setup`과 `tl init --force`는 clean 환경이 아니면 위험하다.
- 현재 TL 구현은 `~/.codex/hooks.json`을 TL 템플릿으로 복사해 덮어쓴다.
- 기존 custom hook가 있으면 `tl setup` 대신 수동 병합 + `tl config set` 경로를 우선 사용하라.

원칙 3. 최종 hook graph에서 TL 훅은 이벤트당 정확히 한 번만 존재해야 한다.
- `SessionStart`에서 `tl hook-session-start`는 한 번만
- `Stop`에서 `tl hook-stop-and-wait`는 한 번만
- wrapper/router가 이미 TL을 호출한다면 raw TL hook를 또 추가하지 마라.

원칙 4. `TL_BOT_TOKEN`과 `TL_GROUP_ID`가 없으면 설치까지만 하고 멈춰라.
- 사용자에게 interactive 입력을 강요하지 마라.
- 필요한 다음 명령만 안내하라.

아래 순서대로 진행하라.

### 1. 의존성 설치 및 검증
- 현재 디렉토리에서 `npm install`
- `npm run build`
- `npm run test`
- `npm install -g .`
- `tl help` 확인

### 2. Codex hooks 기능 활성화
- `~/.codex/config.toml`을 확인한다.
- `[features]` 섹션에 `codex_hooks = true`가 없으면 추가한다.
- 기존 다른 설정은 유지한다.

### 3. `~/.codex/hooks.json` 안전 설치 또는 병합
- 현재 디렉토리의 `templates/hooks.json`을 기준으로 TL hook shape를 확인한다.
- `~/.codex/hooks.json`이 없으면 TL 템플릿을 설치한다.
- `~/.codex/hooks.json`이 이미 있으면:
  - timestamp가 붙은 백업 파일을 만든다.
  - `SessionStart`와 `Stop`에 TL 훅을 병합한다.
  - 기존 matcher, wrapper, 다른 command hook를 보존한다.
  - TL 훅이 이미 있으면 중복 삽입하지 않는다.
- 설치 후 `~/.codex/hooks.json`이 유효한 JSON인지 확인한다.

TL 기본 hook는 아래 두 개다.

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

### 4. TL 설정
- `TL_BOT_TOKEN`과 `TL_GROUP_ID`가 모두 있으면 실제 설정까지 완료한다.
- 기존 custom hook가 있거나 `hooks.json`을 병합해야 하는 상황이면 `tl setup`을 기본 선택지로 쓰지 마라.
- 대신 `tl config set` 또는 `~/.tl/config.json` 업데이트로 설정을 넣고, daemon을 재시작한다.
- clean 환경이고 overwrite가 문제되지 않을 때만 `tl setup --non-interactive`를 써도 된다.

설정해야 할 값:
- `botToken`
- `groupId`
- `hookPort` 기본값 `9877`
- `hookBaseUrl` 기본값 `http://localhost:9877`
- `stopTimeout` 기본값 `7200`
- `emojiReaction` 기본값 `👍`
- `liveStream` 기본값 `false`

### 5. daemon 재시작 및 검증
- 필요하면 기존 daemon을 종료한다.
- `tl start` 또는 재시작 로직으로 daemon을 올린다.
- `tl status` 확인
- `~/.codex/config.toml` 확인
- `~/.codex/hooks.json` 확인
- `~/.tl/config.json` 확인

### 6. Telegram 검증
- 자격증명이 있으면 `/tl-status` 검증 가능 여부를 확인한다.
- 사용자가 group ID를 아직 모른다면 봇을 그룹에 추가하고 메시지를 보낸 뒤 ID를 구해야 한다고 안내한다.

### 7. 사용자가 꼭 알아야 할 동작을 안내
- `tl setup`과 `tl init --force`는 현재 `~/.codex/hooks.json`을 덮어쓸 수 있다.
- TL은 root 세션 기준으로 topic을 관리한다.
- subagent `SessionStart`는 무시된다.
- `resume`은 기존 topic에 재연결된다.
- Stop hook는 Telegram reply를 기다릴 수 있다.
- Stop 메시지 본문은 현재 turn의 assistant `commentary + final`을 transcript에서 합쳐서 만든다.
- 긴 Stop 메시지는 여러 조각으로 나뉘어 전송될 수 있다.
- `waiting` 중 reply가 consumer보다 먼저 도착하면 queue에 저장됐다가 같은 wait에서 소비된다.
- 같은 topic 안에서는 일반 메시지도 `thread_id` 기준으로 해당 topic의 최신 세션으로 라우팅된다. `All` 뷰처럼 `thread_id`가 없을 때만 `Reply`가 필요하다.
- `waiting`이 이미 끝난 뒤에도 같은 Stop 메시지에 reply가 오면 TL은 `completed` 세션까지 `stop_message_id`로 매칭하고, late reply를 기록한 뒤 `codex exec resume --dangerously-bypass-approvals-and-sandbox <session_id> <reply>` fallback을 시도한다.

### 8. 최종 보고
- 실제로 실행한 명령
- 수정된 파일 경로
- 백업 파일 경로
- 검증 결과
- 아직 사용자 입력이 필요한 항목
를 짧게 요약해서 보고하라.
```

## 주의

- 이 프롬프트의 목적은 "TL 설치"뿐 아니라 "기존 Codex 환경을 망가뜨리지 않는 설치"다.
- 특히 `hooks.json`을 덮어쓰거나 TL 훅을 중복 등록하면, 훅이 두 번 실행되거나 기존 알림 체인이 깨질 수 있다.
- clean 환경이 아니면 `tl setup`보다 `hook 병합 + tl config set + daemon restart`가 더 안전하다.
