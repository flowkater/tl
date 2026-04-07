# TL Remote Managed Mode Implementation Plan

Date: 2026-04-07
Branch: `feat/remote-app-server-stop-poc`
Spec: `docs/superpowers/specs/2026-04-07-tl-remote-managed-mode-design.md`

## Goal

기존 stop-path PoC를 `remote managed mode`로 승격해, TL이 local hook mode와 remote managed mode를 명확히 구분해 운영하고, Telegram/daemon/session 상태가 remote thread 중심 semantics를 반영하도록 정리한다.

## Phase 1: State Model and CLI Surface

- [ ] `SessionRecord`에 canonical remote-managed fields를 추가한다.
  - [ ] `mode`
  - [ ] `remote_status`
  - [ ] `remote_last_error`
  - [ ] `remote_last_recovery_at`
- [ ] 기존 remote 관련 필드를 새 canonical fields에 맞게 정리한다.
- [ ] `tl remote status` 출력이 mode/status/recovery 정보를 명확히 노출하게 한다.
- [ ] `tl remote enable/disable` 경로가 세션 모드 semantics와 일관되게 동작하는지 정리한다.

## Phase 2: Delivery State Machine

- [ ] remote delivery 흐름을 별도 state machine으로 정리한다.
  - [ ] live inject
  - [ ] reconnect + retry
  - [ ] `thread/resume` + retry
  - [ ] local fallback
- [ ] 각 단계에서 세션 저장소의 `remote_status`, `remote_last_error`, `remote_last_recovery_at`를 업데이트한다.
- [ ] 성공/실패 후 stale error가 남지 않도록 cleanup을 정리한다.

## Phase 3: Telegram UX

- [ ] stop 메시지 footer에 현재 mode를 반영한다.
- [ ] remote delivery 성공/복구/fallback 메시지를 단계별로 구분한다.
- [ ] local mode와 remote mode의 안내 문구를 분리한다.
- [ ] 실제 사용자가 현재 세션이 local인지 remote인지 topic에서 바로 식별할 수 있게 한다.

## Phase 4: Tests

- [ ] 세션 상태 전이 테스트 추가
- [ ] remote state machine 테스트 추가
- [ ] Telegram 메시지/표시 검증 테스트 추가
- [ ] 기존 remote smoke path와 충돌하지 않는지 전체 테스트로 검증

## Phase 5: Validation

- [ ] `npm run build`
- [ ] `npm test`
- [ ] real smoke:
  - [ ] `tl remote enable --endpoint ...`
  - [ ] `codex app-server --listen ...`
  - [ ] `codex --remote ...`
  - [ ] same-thread inject
  - [ ] recovery/fallback visibility 확인

## Notes

- Phase 1에서는 experimental remote managed mode를 local mode와 병행 유지한다.
- README 기본 설치 surface는 이번 단계에서 바꾸지 않는다.
- Telegram human-client UX는 마지막 수동 검증 항목으로 남긴다.
