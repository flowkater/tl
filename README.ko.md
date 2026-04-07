# TL

TL은 Codex 세션을 Telegram topic에 연결해서, 터미널을 계속 보지 않아도 Telegram에서 작업 진행 상황을 확인하고 답장으로 다음 턴을 재개할 수 있게 해주는 로컬 bridge다.

English version: [README.md](README.md)

## 왜 TL인가

- 매번 터미널을 확인하지 않아도 turn 완료 메시지를 Telegram에서 받을 수 있다.
- 각 root Codex 세션이 Telegram topic 하나에 대응되어 대화가 섞이지 않는다.
- Telegram reply만으로 다음 Codex 턴을 바로 재개할 수 있다.
- 원래 stop 대기가 끝난 뒤에도 late reply fallback으로 다시 이어 붙일 수 있다.
- TL 상태, 세션, daemon, 설정 변경을 local Codex plugin / MCP tool로 다룰 수 있다.

## 주요 기능

- root `SessionStart`에서 Telegram topic을 새로 만들거나 기존 topic에 재연결한다.
- `Stop`에서 현재 turn의 assistant `commentary + final`을 Telegram으로 전송한다.
- `thread_id`가 있는 topic 메시지는 thread 기준으로 라우팅하고, `thread_id`가 없으면 reply 매칭으로 세션을 찾는다.
- stop hook 반환이 실제로 성공했을 때만 `reply delivered to Codex` 확인 메시지를 보낸다.
- `codex exec resume --dangerously-bypass-approvals-and-sandbox` 기반 late-reply resume fallback을 지원한다.
- subagent `SessionStart`는 무시해서 root 세션만 topic을 연다.
- 기존 Codex hook graph에는 기본적으로 safe merge로 TL hook를 붙인다.

## 모드

### Local-Managed 모드

터미널과 Telegram을 같은 Codex 세션에서 자유롭게 오가고 싶다면 이 모드를 써야 한다. `Stop -> waiting`에 묶이지 않는 권장 경로다.

- TL이 app-server를 통해 daemon-owned Codex thread를 시작한다.
- `tl local open`으로 같은 live thread를 터미널에 붙인다.
- Telegram 메시지와 터미널 입력이 같은 세션으로 들어간다.
- `tl resume`은 정상 흐름이 아니라 복구용으로만 남는다.

기본 흐름:

```bash
tl local start --cwd "$PWD" --project my-session
tl local open <session_id>
```

상태 확인:

```bash
tl local status
tl local status <session_id>
```

### Hook-Local 모드

기존 Codex hook 기반 흐름이다. 알림 중심 용도로는 여전히 쓸 수 있지만, 같은 live 세션에서 터미널과 Telegram을 자유롭게 오가는 용도로는 적합하지 않다.

- 일반 로컬 Codex 세션에 TL hook가 붙는다.
- `Stop`에서 `waiting` 상태가 걸릴 수 있다.
- Telegram reply가 다음 턴 resume을 트리거한다.
- 터미널에서 계속 입력하면 daemon-owned live bridge가 아니라 원래 로컬 세션과 상호작용하게 된다.

### Remote-Managed 모드

완전히 remote/app-server 중심으로 Codex를 운용하는 실험 경로다.

## Codex로 설치하기

Codex에게 아래처럼 말하면 된다.

```text
Follow the instructions in https://github.com/flowkater/tl/blob/main/PROMPTS.md to install and configure TL safely.
```

제품 관점의 설치 진입점은 이것 하나만 쓰면 된다. 실제 실행 프롬프트와 고급 운영 절차는 아래 문서에 분리되어 있다.

## 문서

- [English version](README.md)
- [Codex 프롬프트 가이드](PROMPTS.md)
- [고급 Codex 설정 가이드](CODEX_SETUP.md)
- [historical requirements](docs/REQUIREMENTS.md)

## 현재 범위

- TL은 로컬 전용 bridge다.
- Topics가 켜진 Telegram group 또는 supergroup이 필요하다.
- hook 기반 local session과 daemon-owned local-managed session을 모두 지원한다.
- 터미널 ↔ Telegram 자유 전환은 `tl local start` / `tl local open` 경로에서 제공된다.
- 기존에 custom router나 wrapper가 있는 복잡한 hook graph는 direct TL hook를 붙이기 전에 수동 검증이 필요할 수 있다.
