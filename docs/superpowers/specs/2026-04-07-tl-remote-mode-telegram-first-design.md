# TL Remote Mode Telegram-First Design

## Goal

`local hook mode`는 유지하고, `remote managed mode`는 Telegram-first 실행 모델로 재정의한다.

이 모드에서 TL daemon은 다음을 owner로 가진다.

- Telegram topic input
- Codex app-server endpoint lifecycle
- remote thread attachment / recovery state

Codex TUI는 owner가 아니라 attached client로 본다.

## Product Modes

### Local Hook Mode

- 현재 TL의 기본 모드
- `SessionStart` / `Stop` hook, `waiting`, `late reply`, `resume` 흐름 유지

### Remote Managed Mode

- experimental opt-in 모드
- Telegram topic 메시지가 canonical input
- `Stop hook completed`는 turn 종료일 뿐, 연속성의 기준이 아님
- 같은 remote thread 유지가 최우선

## Ownership Rules

- canonical writer: Telegram
- attached client: Codex TUI
- reply requirement:
  - All view: reply 기반
  - topic view: thread 기반, reply 불필요

## State Model

`SessionRecord`는 다음 remote canonical state를 가진다.

- `mode`: `local` | `remote-managed`
- `remote_input_owner`: `telegram` | `tui` | null
- `remote_status`: `attached` | `running` | `idle` | `injecting` | `recovering` | `degraded`
- `remote_last_error`
- `remote_last_recovery_at`

해석:

- `running`: remote thread가 현재 turn 처리 중
- `idle`: turn 종료, 다음 Telegram input 주입 가능
- `recovering`: reconnect / thread resume 진행 중
- `degraded`: remote delivery 실패, fallback이 필요한 상태

## Delivery Order

Telegram-first remote mode의 메시지 전달 우선순위:

1. `turn/start` or `turn/steer`
2. app-server reconnect
3. `thread/resume`
4. local `resume` fallback

## Telegram UX

stop footer에는 remote mode ownership을 표시한다.

- `mode: remote-managed · owner: telegram · state: idle`

delivery/recovery 상태 메시지:

- `✅ delivered to live remote thread`
- `⚠️ remote reconnecting...`
- `⚠️ recovering remote thread...`
- `⚠️ remote recovery failed, falling back to resume`

## Scope

이 단계에서는 다음까지 구현한다.

- remote mode canonical state 반영
- topic message -> remote delivery 우선 라우팅
- remote mode에서 local waiting semantics 분리
- daemon status payload에 ownership/state 노출

다음 단계 과제:

- true Telegram-owned runtime supervision
- multi-endpoint routing
- TUI-owned writer arbitration
