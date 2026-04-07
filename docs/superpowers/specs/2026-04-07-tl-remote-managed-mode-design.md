# TL Remote Managed Mode Design

Date: 2026-04-07
Branch: `feat/remote-app-server-stop-poc`
Status: approved for implementation

## Goal

TL에 `remote managed mode`를 추가해, Telegram 입력 연속성을 살아 있는 stop hook 프로세스가 아니라 `codex app-server`가 호스팅하는 remote thread를 기준으로 유지한다.

이 모드는 기존 local hook mode를 대체하지 않는다. 기본값은 그대로 local hook mode이며, remote managed mode는 명시적 opt-in 실험 기능으로 제공한다.

## Product Modes

### Local Hook Mode

- 현재 기본 동작
- Codex `SessionStart`/`Stop` hook에 의존
- Telegram reply는 살아 있는 stop hook consumer에 우선 전달
- consumer가 사라지면 late-reply fallback으로 `resume`

### Remote Managed Mode

- `codex app-server` endpoint와 remote thread를 TL daemon이 관리
- Telegram reply는 우선 `turn/start` 또는 `turn/steer`로 같은 remote thread에 전달
- 필요 시 `app-server reconnect`, `thread/resume`을 거쳐 같은 thread를 유지
- 마지막에만 local `resume` fallback 사용

## UX Surface

### Commands

- `tl remote enable --endpoint ws://127.0.0.1:PORT`
- `tl remote disable`
- `tl remote status`
- `tl remote inject <session_id> --text ...`

### Runtime Expectations

- 사용자는 `codex app-server --listen ...`와 `codex --remote ...`를 사용해 live TUI를 remote endpoint에 연결한다.
- TL은 `SessionStart` 시 해당 remote thread를 세션에 attach한다.
- Stop 이후 Telegram reply가 오면, 같은 remote thread에 새 turn을 직접 넣는다.

### Telegram Status Messages

- stop 메시지 footer에는 현재 모드가 표시된다.
- remote 전달 성공: `delivered to live remote thread`
- endpoint reconnect 중: `remote reconnecting...`
- thread recovery 중: `recovering remote thread...`
- local fallback으로 내려감: `remote recovery failed, falling back to resume`

## Canonical State Model

세션 레코드는 remote mode에서 아래 메타데이터를 가진다.

- `mode`: `local` | `remote-managed`
- `remote_endpoint`
- `remote_thread_id`
- `remote_last_turn_id`
- `remote_status`: `attached` | `idle` | `injecting` | `recovering` | `degraded`
- `remote_last_error`
- `remote_last_recovery_at`

Remote mode에서는 기존 `waiting` 상태가 핵심이 아니다. 핵심은 `thread attached`와 `remote_status`다.

- Local mode: `active -> waiting -> active/completed`
- Remote mode: `active -> idle -> injecting -> active`

## Delivery and Recovery Order

Telegram reply 처리 우선순위는 아래 순서를 따른다.

1. live inject
   - idle thread: `turn/start`
   - active turn: `turn/steer`
2. app-server reconnect + retry
3. `thread/resume` + retry
4. local resume fallback

원칙은 명확하다.

- 가능한 한 같은 remote thread를 유지한다.
- `resume`은 마지막 수단이다.
- `Stop hook completed`는 remote mode에서 실패가 아니라 turn 종료 신호일 뿐이다.

## Scope

### Included in Phase 1

- experimental `remote managed mode`
- remote-aware `SessionStart` attach
- Telegram reply의 remote delivery state machine
- Telegram 상태 메시지 개선
- 운영 surface: `tl remote enable/disable/status`
- 실패 시 기존 local resume fallback 유지

### Explicitly Excluded in Phase 1

- remote mode를 default로 전환
- multi-endpoint / multi-host routing
- active turn 중 자유 interrupt 완전 지원
- README의 기본 설치 경로를 remote mode 중심으로 변경

## Validation

### Required

- unit/integration tests for remote state machine
- real local smoke with:
  - `codex app-server --listen ...`
  - `codex --remote ...`
  - same live TUI thread injection
- fallback path validation:
  - reconnect
  - `thread/resume`
  - local resume fallback

### Success Criteria

1. remote-attached 세션에서 Telegram reply가 `resume`이 아니라 같은 remote thread로 들어간다.
2. stop hook 프로세스가 끝난 뒤에도 same-thread delivery가 가능하다.
3. recovery path가 단계별로 Telegram과 상태 저장소에 반영된다.
4. recovery가 전부 실패한 경우에만 기존 local fallback으로 내려간다.
