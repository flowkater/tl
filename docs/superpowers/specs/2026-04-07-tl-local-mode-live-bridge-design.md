# TL Local Mode Live Bridge Design

Date: 2026-04-07
Branch: `main`
Status: approved for implementation

## Goal

TL의 local mode를 `stop-and-wait` 중심 모델에서 `live bridge` 중심 모델로 재설계해, 같은 Codex 로컬 콘솔 세션을 유지한 채 Telegram과 콘솔 입력을 자유롭게 오갈 수 있게 만든다.

핵심 목표는 하나다.

- 사용자가 콘솔에서 계속 작업하다가 Telegram으로 메시지를 보내도 같은 세션으로 즉시 들어가야 한다.
- 반대로 Telegram으로 이어서 대화하다가 다시 콘솔에서 입력해도 `esc -> daemon 종료 -> tl resume` 같은 복구 절차가 필요 없어야 한다.

## Problem Statement

현재 local mode는 아래 흐름에 묶여 있다.

1. Codex가 turn을 끝내면 Stop hook이 실행된다.
2. TL daemon은 세션을 `waiting`으로 바꾸고 Telegram stop 메시지를 보낸다.
3. Telegram reply는 살아 있는 `ReplyQueue.waitFor()` consumer에만 들어간다.
4. 사용자가 콘솔로 돌아오려면 stop hook을 `esc`로 끊어야 한다.
5. stop hook이 끝나면 Telegram 입력 연속성은 사라지고, 다시 연결하려면 `tl resume`이 필요하다.

이 구조에서는 local mode가 사실상 Telegram-only blocking mode가 된다. 즉, "로컬 콘솔 세션 + Telegram 보조 입력"이라는 원래 목적을 만족하지 못한다.

## Desired User Experience

### Canonical UX

- local mode에서 Codex 콘솔 세션은 계속 살아 있다.
- Telegram 메시지는 `waiting` 여부와 무관하게 같은 세션으로 들어간다.
- 콘솔 입력과 Telegram 입력은 동일 세션의 단일 FIFO 입력 스트림으로 처리된다.
- `Stop hook completed`는 연결 종료 의미가 아니라 "이번 assistant turn이 끝났다"는 알림일 뿐이다.
- `tl resume`은 기본 사용 흐름이 아니라 예외 복구 도구다.

### Example

1. 사용자가 콘솔에서 Codex와 작업한다.
2. turn 종료 후 TL이 Telegram에 stop/summary 메시지를 보낸다.
3. 사용자가 Telegram topic에서 reply 없이 새 메시지를 보낸다.
4. TL은 이 입력을 같은 로컬 Codex 세션에 즉시 주입한다.
5. 이후 사용자가 다시 콘솔에서 입력해도 세션을 바꿀 필요가 없다.

## Non-Goals

- remote mode를 대체하지 않는다.
- Codex 프로세스 자체를 TL이 완전히 호스팅하지 않는다.
- 다중 사용자 동시 편집 충돌 해결까지는 하지 않는다.
- Telegram 입력과 콘솔 입력의 의미 충돌을 semantic merge하지 않는다.
- app-server 기반 remote runtime을 local mode 기본값으로 바꾸지 않는다.

## Approaches Considered

### 1. Existing stop-and-wait 보강

- stop hook 장시간 대기를 유지하면서 console 복귀 흐름만 조금 완화
- 장점: 변경 범위가 작다.
- 단점: 입력 소유권이 여전히 stop hook에 묶인다.

이 방식은 문제를 완화할 뿐 제거하지 못한다.

### 2. Local Live Bridge

- local mode에 별도 세션 브리지 런타임을 추가
- Stop hook은 완료 알림만 담당
- Telegram 입력은 bridge가 세션에 직접 주입

이 방식이 권장안이다. 콘솔/Telegram 왕복을 가장 직접적으로 해결한다.

### 3. Local mode 전체를 remote/app-server 기반으로 치환

- 장기적으로는 유연하지만 현재 문제 대비 범위가 과하다.
- local mode와 remote mode의 책임 경계가 흐려진다.

## Selected Design

local mode는 `console first + telegram live injection` 모델로 재구성한다.

구성 요소는 아래 세 가지다.

1. `Stop hook notifier`
   - 더 이상 blocking consumer가 아니다.
   - turn 완료 요약, 마지막 메시지, topic continuity 안내만 전송한다.

2. `LocalSessionBridge`
   - local session별 FIFO 입력 큐를 가진다.
   - Telegram 입력을 세션별로 적재하고, live attach가 가능한 세션에는 즉시 주입한다.

3. `Local session attachment registry`
   - 어떤 TL session이 어떤 live local Codex session/endpoint와 연결되어 있는지 추적한다.
   - bridge는 이 registry를 통해 현재 살아 있는 입력 경로를 찾는다.

## Runtime Model

### Session Ownership

local mode의 진짜 기준 상태는 `waiting`이 아니라 `attached`다.

- 세션이 `active`이고 live attachment가 있으면 Telegram/콘솔 양쪽 입력 모두 허용
- attachment가 끊기면 Telegram 입력은 fallback 경로로 내려감
- fallback 시에만 late reply / `tl resume` 사용

### Input Path

모든 입력은 아래 순서를 따른다.

1. 입력 도착
   - source: `console` 또는 `telegram`
2. session lookup
   - topic/thread 기반으로 local session 식별
3. enqueue
   - 세션별 FIFO 큐에 저장
4. inject
   - live attachment가 있으면 즉시 주입
5. settle
   - 성공 시 queue pop, `last_input_source` 갱신
   - 실패 시 재시도 또는 fallback

### Ordering Policy

- 콘솔 입력과 Telegram 입력은 동일 FIFO 정책을 따른다.
- 입력 source별 우선순위는 두지 않는다.
- 먼저 도착한 입력이 먼저 처리된다.

## State Model Changes

현재 local mode에서 `waiting`은 정상 흐름 중심 상태다. 이를 바꾼다.

### Existing

- `active`
- `waiting`
- `completed`

### New Semantics

- `active`
  - local mode 정상 상태
  - console/telegram 둘 다 입력 가능
- `waiting`
  - legacy path 또는 explicit fallback에서만 사용
  - 기본 local mode UX에서는 핵심 상태가 아님
- `completed`
  - 세션 종료
  - 이후 Telegram 메시지는 late reply or resume fallback 대상으로 처리 가능

### New Local Runtime Metadata

Session record에 아래 metadata를 추가한다.

- `local_bridge_enabled: boolean`
- `local_bridge_state: 'attached' | 'detached' | 'recovering'`
- `local_input_queue_depth: number`
- `local_last_input_source: 'console' | 'telegram' | null`
- `local_last_input_at: string | null`
- `local_last_injection_error: string | null`
- `local_attachment_id: string | null`

필요 시 daemon runtime 메모리에도 아래 registry를 둔다.

- `session_id -> local attachment handle`
- `session_id -> pending input queue`

## Telegram Behavior Changes

### Current

- Telegram reply는 `waiting`일 때만 정상 처리
- topic 비-reply 메시지는 대부분 late reply or fallback

### New

- topic 내 메시지는 local live bridge가 켜진 active session으로 즉시 라우팅
- reply 여부는 보조 힌트일 뿐, 필수 조건이 아니다
- Telegram은 "같은 topic에 쓰면 같은 세션으로 들어간다"가 기본 UX가 된다

### Telegram Status Messages

stop 메시지 footer를 local live bridge 기준으로 바꾼다.

- `mode: local-live`
- `telegram input: attached`
- `console input: attached`

오류 메시지 예시는 아래 수준이면 충분하다.

- `delivered to live local session`
- `local bridge recovering...`
- `local bridge unavailable, falling back to resume`

## Stop Hook Changes

Stop hook은 local mode에서 더 이상 long-poll blocking consumer가 아니다.

### New Responsibility

- latest assistant output 전송
- turn 완료 알림 전송
- 필요 시 "Telegram에서도 이어서 입력 가능" 안내

### Removed Responsibility

- `ReplyQueue.waitFor()` lifecycle ownership
- local mode의 입력 소유권 장악
- 2시간 blocking hold

### Backward Compatibility

아래 경우에는 기존 stop-and-wait path를 한동안 유지할 수 있다.

- bridge 미설정 환경
- attachment registry 초기화 실패
- explicit compatibility mode

단, 사용자 기본 UX는 live bridge가 되어야 한다.

## Console Side Changes

local mode가 진짜로 왕복 가능해지려면 TL이 살아 있는 Codex 로컬 세션에 입력을 넣을 수 있어야 한다.

이를 위해 먼저 다음 두 구현 중 하나를 채택한다.

### Preferred

- existing Codex app-server / attachable thread 경로를 local live bridge에도 재사용

### Fallback

- TL daemon이 관리하는 lightweight local stdin bridge 프로세스 도입

설계 원칙은 동일하다.

- Telegram 입력은 stop hook consumer가 아니라 live session attachment로 보낸다.
- attachment가 유효한 동안 `tl resume`은 호출하지 않는다.

## Failure Handling

### Injection Failure

1. local attachment health check
2. same attachment retry
3. attachment reconnect
4. late reply fallback (`tl resume`)

### Daemon Restart

daemon restart 후에도 아래 상태는 복구 가능해야 한다.

- session/topic mapping
- recent pending Telegram input
- attachment metadata

단, live attachment 자체는 메모리 리소스이므로 재확인이 필요할 수 있다.

### Console Exit

콘솔 세션이 실제로 종료되면 bridge는 `detached` 상태로 내려간다.
그 시점부터 Telegram 입력은 late reply fallback 또는 explicit resume로 전환된다.

## Commands And Operator Surface

기존 surface 외에 아래 정도가 필요하다.

- `tl local status [session_id]`
- `tl local attach <session_id> ...`
- `tl local detach <session_id>`
- `tl local inject <session_id> --text ...`

최소 1차 구현에서는 operator용 진단 surface만 제공해도 된다.

## Validation

### Required Tests

- unit tests
  - FIFO input ordering
  - active local session Telegram injection
  - detached local session fallback
  - stop hook non-blocking behavior
- e2e tests
  - 콘솔 active 중 Telegram 메시지 주입
  - Telegram 후 콘솔 입력 연속 처리
  - bridge failure 후 resume fallback

### Manual Smoke

1. local mode로 Codex 세션 시작
2. turn 완료 후 stop hook이 즉시 끝나는지 확인
3. Telegram topic에서 비-reply 메시지 전송
4. same session이 계속 진행되는지 확인
5. 다시 콘솔에서 입력
6. `esc`, `tl resume` 없이 이어지는지 확인

## Success Criteria

1. local mode에서 stop hook이 끝난 뒤에도 Telegram 입력이 같은 세션으로 들어간다.
2. Telegram과 콘솔 입력을 번갈아 사용해도 세션을 재시작하거나 `tl resume` 할 필요가 없다.
3. local mode의 기본 흐름에서 `waiting`은 핵심 상태가 아니다.
4. live bridge가 실패했을 때만 late reply fallback이 실행된다.
5. 사용자는 topic 안에서 reply 강제 없이 자연스럽게 대화할 수 있다.

## Open Questions

현재 구현 전에 반드시 확인해야 할 것은 하나다.

- 살아 있는 local Codex 세션에 대한 안정적인 input injection 경로를 existing app-server 재사용으로 해결할 수 있는가

이 질문의 답이 yes면 local live bridge는 기존 remote 인프라 일부를 재사용하는 얇은 orchestration layer가 된다.
no면 local 전용 lightweight bridge 프로세스를 별도로 둬야 한다.
