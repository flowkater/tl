# TL 설치 프롬프트

이 문서는 [README.md](README.md)의 `Install With Codex` 섹션에서 이어지는 상세 실행 문서다.  
기본 경로는 항상 GitHub URL 기반 전역 설치다.

목표는 세 가지다.

- TL을 실제로 설치한다.
- TL local plugin/MCP tool까지 붙인다.
- 기존 Codex hook 환경을 망가뜨리지 않는다.
- 자유 전환이 필요하면 `local-managed` 경로까지 안내한다.
- repo가 없어도 바로 설치되고, 필요할 때만 source checkout을 받는다.

## 바로 쓰는 방법

### repo가 아직 없다

```bash
codex exec --full-auto "Follow the instructions in https://github.com/flowkater/tl/blob/main/PROMPTS.md to install and configure TL safely. Do not clone the repository unless you actually need a local checkout."
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

원칙 1. 기본 경로는 clone 없는 전역 설치다.
- 먼저 `npm install -g github:flowkater/tl`로 설치한다.
- local plugin 설치는 `tl plugin install`로 처리한다.
- source checkout이 꼭 필요할 때만 clone한다.

원칙 2. 기존 Codex hook 환경을 망가뜨리지 마라.
- TL은 더 이상 deprecated `hook-local`을 기본 설치하지 않는다.
- `tl init`은 남아 있는 TL direct hook를 제거하는 정리 명령이다.
- `cmux` router나 custom wrapper가 있으면 그것을 유지한다.

원칙 3. 기본 시작 경로는 `tl open`이다.
- `tl open`은 daemon-owned `local-managed` 세션을 만들고 곧바로 Codex에 attach한다.
- `tl open`은 현재 터미널에서 foreground Codex를 직접 실행하므로 `cmux`와 일반 터미널 동작을 유지한다.
- `--text`가 없으면 blank 세션을 먼저 열고, 첫 실제 프롬프트가 들어오면 TL이 그 thread를 채택한다.
- 자유 전환은 이 경로를 기준으로 설명하라.

원칙 4. `TL_BOT_TOKEN`과 `TL_GROUP_ID`가 없으면 설치까지만 하고 멈춰라.
- interactive 입력을 강요하지 마라.
- 다음 단계에 필요한 정확한 명령만 남겨라.

원칙 5. 검증 없이 성공을 주장하지 마라.

원칙 6. 사용자가 같은 live 세션에서 터미널과 Telegram을 자유롭게 오가길 원하면 `hook-local`이 아니라 `local-managed` 경로를 안내하라.
- `hook-local`은 deprecated다.
- 자유 전환 경로는 `tl open`이다.
- 필요하면 하위 명령으로 `tl local start` + `tl local open`을 사용할 수 있다.

아래 순서대로 수행하라.

1. 설치
- `npm install -g github:flowkater/tl`
- `tl help`

2. local plugin 설치
- `tl plugin install`
- `tl plugin status`

3. Codex hook 기능 확인
- `~/.codex/config.toml`을 확인한다.
- `[features]` 아래 `codex_hooks = true`가 없으면 추가한다.
- 기존 다른 설정은 유지한다.

4. hook 전략 결정
- `tl init`으로 deprecated TL direct hook가 남아 있으면 제거한다
- `cmux` router나 custom wrapper가 있으면 유지한다
- direct TL `SessionStart` / `Stop` hook는 다시 추가하지 않는다

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
- `tl plugin status`
- `tl status`
- `cat ~/.codex/config.toml`
- `cat ~/.codex/hooks.json`
- `cat ~/.tl/config.json`
- Telegram 검증:
  - `/tl-status` 응답 여부
  - `tl open`으로 세션 시작 후 topic 생성 여부
  - Telegram과 터미널 양쪽에서 같은 세션에 접근되는지

8. 사용자에게 꼭 알려야 할 점
- TL은 Topics-enabled Telegram group/supergroup 기준이다
- TL plugin은 `~/plugins/tl-tools`와 `~/.agents/plugins/marketplace.json`에 설치된다
- subagent `SessionStart`는 무시된다
- topic 안에서는 일반 메시지도 `thread_id` 기준으로 라우팅된다
- `All` 뷰처럼 `thread_id`가 없으면 `Reply`가 필요하다
- reply reaction은 TL 수신만 의미한다
- `✅ reply delivered to Codex, resuming...`는 Stop hook 성공 경계에서만 전송된다
- `🛠️ resumed, working...`와 heartbeat는 `UserPromptSubmit -> tl hook-working`이 있을 때만 동작한다
- `waiting`이 이미 끝난 뒤에도 같은 Stop 메시지에 reply가 오면 late reply resume fallback이 시도된다
- 자유 전환이 필요하면:
- `tl config set localCodexEndpoint=ws://127.0.0.1:8796`
- `tl stop && tl start`
- `tl open --cwd "$PWD" --project my-session`
- `hook-local`은 deprecated 상태이며 기본 경로가 아니다

9. 최종 보고
- 실제로 실행한 명령
- 수정한 파일
- 생성한 backup 파일
- 검증 결과
- 아직 사용자 입력이 필요한 항목
를 짧게 보고하라.
```

## 메모

- 공개 진입면은 `README.md`, 한국어 번역은 `README.ko.md`다.
- 이 프롬프트는 `PROMPTS.md`라는 파일명만 말하는 대신, GitHub URL을 직접 가리키는 흐름을 전제로 쓴다.
- TL의 기본 설치는 이제 `tl init`/`tl setup` 기준 safe merge를 사용한다.
- TL plugin은 repo clone 없이 `tl plugin install`로 붙일 수 있다.
- source checkout은 TL 자체를 수정하거나 테스트해야 할 때만 필요하다.
- custom router/wrapper가 TL을 간접 호출하는 고급 환경은 자동 병합보다 검증 우선이 더 안전하다.
