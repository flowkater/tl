# TL 설치 프롬프트

이 문서는 Codex에게 그대로 던질 수 있는 실행 프롬프트다.  
목표는 세 가지다.

- TL을 실제로 설치한다.
- 기존 Codex hook 환경을 망가뜨리지 않는다.
- repo가 아직 로컬에 없어도 시작 지점이 분명해야 한다.

## 바로 쓰는 방법

### repo가 아직 없다

```bash
codex exec --full-auto "Follow the instructions in https://github.com/flowkater/tl/blob/main/PROMPTS.md to install and configure TL safely. If https://github.com/flowkater/tl is not cloned locally yet, clone it first."
```

### repo는 이미 있다

```bash
cd ~/Projects/TL
codex exec --full-auto "Follow the instructions in https://github.com/flowkater/tl/blob/main/PROMPTS.md to install and configure TL safely"
```

### Telegram 자격증명까지 같이 넘긴다

```bash
TL_BOT_TOKEN="123456:ABC..." TL_GROUP_ID="-1001234567890" \
  codex exec --full-auto "Follow the instructions in https://github.com/flowkater/tl/blob/main/PROMPTS.md to install and configure TL safely"
```

## Codex에게 전달할 프롬프트

```text
당신은 TL(Codex ↔ Telegram Bridge)을 설치하고 설정하는 작업을 맡았다.
설명만 하지 말고, 가능한 범위까지 실제로 수행하라.

반드시 아래 GitHub 기준으로 진행하라.
- repository URL: https://github.com/flowkater/tl
- install prompt source: https://github.com/flowkater/tl/blob/main/PROMPTS.md

다음 원칙을 지켜라.

원칙 1. repository가 로컬에 없으면 먼저 clone하고, 있으면 그 경로를 그대로 사용한다.
- 기본 clone 경로는 ~/Projects/TL 로 둔다.
- 이미 clone돼 있으면 새로 중복 clone하지 말고 기존 경로를 재사용한다.

원칙 2. 기존 Codex hook 환경을 망가뜨리지 마라.
- `~/.codex/hooks.json`이 없으면 TL hook를 설치한다.
- `~/.codex/hooks.json`이 있으면 안전 병합한다.
- TL hook가 이미 있으면 중복 추가하지 않는다.
- router/wrapper가 이미 TL을 내부에서 호출하면 direct TL hook를 또 추가하지 않는다.
- `tl init --force`는 마지막 수단이다.

원칙 3. TL hook는 최종 graph에서 이벤트당 정확히 한 번만 존재해야 한다.
- `SessionStart` -> `tl hook-session-start` 1회
- `Stop` -> `tl hook-stop-and-wait` 1회
- optional `UserPromptSubmit` -> `tl hook-working` 1회

원칙 4. `TL_BOT_TOKEN`과 `TL_GROUP_ID`가 없으면 설치까지만 하고 멈춰라.
- interactive 입력을 강요하지 마라.
- 다음 단계에 필요한 정확한 명령만 남겨라.

원칙 5. 검증 없이 성공을 주장하지 마라.

아래 순서대로 수행하라.

1. repository 준비
- TL이 설치돼 있지 않고 repo도 없으면 `git clone https://github.com/flowkater/tl.git ~/Projects/TL`
- 작업 경로를 고정한다.

2. 설치
- `npm install`
- `npm run build`
- `npm run test`
- `npm install -g .`
- `tl help`

3. Codex hook 기능 확인
- `~/.codex/config.toml`을 확인한다.
- `[features]` 아래 `codex_hooks = true`가 없으면 추가한다.
- 기존 다른 설정은 유지한다.

4. hook 전략 결정
- `~/.codex/hooks.json`이 없으면 `tl init`
- `~/.codex/hooks.json`이 있으면:
  - TL direct hook가 이미 있는지 확인
  - router/wrapper가 TL을 내부에서 호출하는지 확인
  - direct TL hook가 없고 router/wrapper 중복도 아니면 `tl init`
  - router/wrapper가 TL을 이미 호출하면 direct TL hook는 추가하지 말고, 현재 graph가 TL 1회만 포함하는지 검증만 한다
- `tl init --force`는 overwrite이므로 명시적 필요가 있을 때만 사용한다

5. TL 설정
- `TL_BOT_TOKEN`과 `TL_GROUP_ID`가 둘 다 있으면 `tl setup --non-interactive`
- 값이 없으면 `tl init`까지만 마치고, 나중에 사용할 다음 명령만 안내한다:
  - `tl config set botToken=\"...\" groupId=-100...`
  - `tl stop && tl start && tl status`

6. daemon 재시작
- `tl stop`
- `tl start`
- `tl status`

7. 검증
- `tl help`
- `tl status`
- `cat ~/.codex/config.toml`
- `cat ~/.codex/hooks.json`
- `cat ~/.tl/config.json`
- Telegram 검증:
  - `/tl-status` 응답 여부
  - 새 root Codex 세션 시작 후 topic 생성 여부
  - Stop 메시지 reply 후 resume 여부

8. 사용자에게 꼭 알려야 할 점
- TL은 Topics-enabled Telegram group/supergroup 기준이다
- subagent `SessionStart`는 무시된다
- topic 안에서는 일반 메시지도 `thread_id` 기준으로 라우팅된다
- `All` 뷰처럼 `thread_id`가 없으면 `Reply`가 필요하다
- reply reaction은 TL 수신만 의미한다
- `✅ reply delivered to Codex, resuming...`는 Stop hook 성공 경계에서만 전송된다
- `🛠️ resumed, working...`와 heartbeat는 `UserPromptSubmit -> tl hook-working`이 있을 때만 동작한다
- `waiting`이 이미 끝난 뒤에도 같은 Stop 메시지에 reply가 오면 late reply resume fallback이 시도된다

9. 최종 보고
- 실제로 실행한 명령
- 수정한 파일
- 생성한 backup 파일
- 검증 결과
- 아직 사용자 입력이 필요한 항목
를 짧게 보고하라.
```

## 메모

- 이 프롬프트는 `PROMPTS.md`라는 파일명만 말하는 대신, GitHub URL을 직접 가리키는 흐름을 전제로 쓴다.
- TL의 기본 설치는 이제 `tl init`/`tl setup` 기준 safe merge를 사용한다.
- 다만 기존 router/wrapper가 TL을 간접 호출하는 환경은 자동 병합보다 검증 우선이 더 안전하다.
