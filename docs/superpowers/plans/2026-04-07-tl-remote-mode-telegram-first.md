# TL Remote Mode Telegram-First Implementation Plan

Spec: `docs/superpowers/specs/2026-04-07-tl-remote-mode-telegram-first-design.md`

## Phase 1. Canonical Remote State

- [ ] `SessionRecord`에 `remote_input_owner`를 추가한다.
- [ ] remote-managed 세션 start/reconnect 시 `remote_input_owner=telegram`을 기본값으로 둔다.
- [ ] remote inject success 시 `remote_status=running`, stop 이후 `remote_status=idle`로 정리한다.

## Phase 2. Telegram-First Routing

- [ ] Telegram bot에 remote-managed 세션 전용 라우팅 경로를 만든다.
- [ ] remote-managed 세션은 local waiting/late-reply보다 remote delivery를 먼저 적용한다.
- [ ] remote delivery 실패 시 remote 전용 unavailable 메시지를 보낸다.
- [ ] topic 기반 recency 정렬에서 remote-managed 세션을 우선한다.

## Phase 3. Observability

- [ ] stop footer에 owner/state를 함께 노출한다.
- [ ] `/remote/status`, `/remote/attach`, `/remote/detach` 응답에 owner를 포함한다.
- [ ] notifyDelivered / notifyFailed 경로에서 canonical remote state를 갱신한다.

## Phase 4. Verification

- [ ] unit tests 갱신
- [ ] remote routing tests 추가
- [ ] `npm test`
- [ ] `npm run build`
