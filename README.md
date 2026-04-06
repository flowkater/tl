# TL — Codex ↔ Telegram Bridge

TL은 Codex 세션을 Telegram topic에 연결하는 로컬 bridge다.

주요 기능:

- root `SessionStart`에서 Telegram forum topic 생성 또는 기존 topic 재연결
- `Stop`에서 현재 turn의 assistant `commentary + final`을 Telegram으로 전송
- Telegram reply로 Codex 다음 턴 재개
- `waiting`이 끝난 뒤에도 같은 Stop 메시지에 reply가 오면 late-reply resume fallback 시도
- `subagent SessionStart` 무시
- `tl init` / `tl setup` 기본 동작은 `~/.codex/hooks.json` safe merge
- `/tl-status`로 bridge 상태 확인
- optional `UserPromptSubmit -> tl hook-working` 연결 시 `🛠️ resumed, working...` / heartbeat 전송
- optional `tl plugin install`로 local Codex plugin/MCP tool 설치

## 설치

기본 사용자는 repo를 직접 받을 필요 없이 바로 설치하면 된다.

```bash
npm install -g github:flowkater/tl
tl help
```

Codex 안에서 TL 명령을 tool처럼 직접 쓰고 싶으면:

```bash
tl plugin install
tl plugin status
```

plugin이 설치되면 Codex에서 아래 TL tool을 직접 사용할 수 있다.

- `tl_status`
- `tl_list_sessions`
- `tl_resume_session`
- `tl_start_daemon`
- `tl_stop_daemon`
- `tl_get_config`
- `tl_set_config`

필요 조건:

- Node.js 20+
- OpenAI Codex CLI
- Telegram Bot Token
- Topics가 켜진 Telegram group/supergroup
- 대상 group의 `groupId` (`-100...`)

## Codex에 그대로 복사할 설치 프롬프트

아직 Telegram 자격증명이 없으면 설치만 먼저:

```text
Install TL from https://github.com/flowkater/tl without cloning the repository first unless you actually need a local checkout. Use `npm install -g github:flowkater/tl`, verify `tl help`, run `tl plugin install` and verify `tl plugin status`, enable `codex_hooks = true` in `~/.codex/config.toml`, and install TL hooks safely with `tl init`. Do not overwrite unrelated hooks in `~/.codex/hooks.json`; TL must be merged exactly once for `SessionStart` and exactly once for `Stop`. If Telegram credentials are missing, stop after installation and tell me the exact next command I should run.
```

Telegram 자격증명까지 있으면 Codex가 설치와 설정을 한 번에 끝내게 할 수 있다:

```text
Install and configure TL from https://github.com/flowkater/tl without cloning the repository first unless needed. Use `npm install -g github:flowkater/tl`, verify `tl help`, run `tl plugin install` and verify `tl plugin status`, enable `codex_hooks = true` in `~/.codex/config.toml`, and configure TL with `tl setup --non-interactive`. Never overwrite unrelated hooks in `~/.codex/hooks.json`; merge TL hooks safely so `tl hook-session-start` exists exactly once for `SessionStart` and `tl hook-stop-and-wait` exists exactly once for `Stop`. Restart the daemon, verify `tl status`, verify `/tl-status` in Telegram, then report what changed.
```

## 빠른 설정

아래처럼 Codex에게 전부 맡기면 된다.

```bash
TL_BOT_TOKEN="123456:ABC..." TL_GROUP_ID="-1001234567890" \
codex exec --full-auto "Install and configure TL from https://github.com/flowkater/tl without cloning the repository first unless needed. Use npm install -g github:flowkater/tl, verify tl help, run tl plugin install and tl plugin status, enable codex_hooks in ~/.codex/config.toml, run tl setup --non-interactive, preserve existing hooks by safe merge, restart the daemon, verify tl status, verify /tl-status in Telegram, and report the final state."
```

자격증명이 아직 없으면 설치만:

```bash
codex exec --full-auto "Install TL from https://github.com/flowkater/tl without cloning the repository first unless needed. Use npm install -g github:flowkater/tl, verify tl help, run tl plugin install and tl plugin status, enable codex_hooks in ~/.codex/config.toml, run tl init with safe hook merge, and stop after installation if Telegram credentials are missing."
```

## 검증

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

1. group에서 `/tl-status` 전송
2. 새 root Codex 세션 시작
3. topic 생성 확인
4. Stop 메시지에 reply
5. `✅ reply delivered to Codex, resuming...` 확인

## 운영 메모

- TL은 root 세션 기준으로 topic을 관리한다.
- topic 안에서는 일반 메시지도 같은 `thread_id` 기준으로 현재 topic의 최신 세션으로 라우팅된다.
- `All` 뷰처럼 `thread_id`가 없으면 `Reply`가 필요하다.
- local plugin은 `~/plugins/tl-tools`와 `~/.agents/plugins/marketplace.json`에 설치된다.
- reply reaction은 TL이 Telegram reply를 수신했다는 의미다.
- `✅ reply delivered to Codex, resuming...`는 Stop hook 성공 경계까지 도달했을 때만 전송된다.
- late reply는 `codex exec resume --dangerously-bypass-approvals-and-sandbox ...` fallback으로 이어질 수 있다.
- `tl init --force`만 명시적 overwrite다. 기본 `tl init`과 `tl setup`은 safe merge다.

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
