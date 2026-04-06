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
- Codex hooks와 로컬 daemon 협업을 전제로 한다.
- 기존에 custom router나 wrapper가 있는 복잡한 hook graph는 direct TL hook를 붙이기 전에 수동 검증이 필요할 수 있다.
