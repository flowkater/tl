# Local-Managed Heartbeat Cleanup Design

> `local-managed` 세션이 turn 완료 후 `idle`로 내려간 뒤에도 stale heartbeat timer 때문에 `still working...`과 `running` 상태로 되돌아가지 않게 한다.

## Problem

`LocalManagedOpenController`는 app-server thread를 polling하면서 local-managed turn의 시작과 종료를 감지한다.
turn 시작 시에는 `SessionManager.handleWorking()`를 호출해서 progress/heartbeat state를 세팅한다.
하지만 turn 종료 시에는 controller가 직접 `remote_status`, `total_turns`, `last_turn_output`만 갱신하고 stop 메시지를 발행한다.

이 구조는 `SessionManager` 내부 heartbeat timer와 `last_progress_at` / `last_heartbeat_at` 정리를 우회한다.
결과적으로 turn이 이미 끝나 `state: idle`이 노출된 뒤에도 이전 timer가 살아 있어 `⏳ still working...` 메시지가 다시 전송되고 상태가 `running`처럼 보일 수 있다.

## Design

turn settlement cleanup을 `SessionManager` 한 곳으로 모은다.

- `SessionManager`에 managed session turn 종료용 메서드를 추가한다.
- 이 메서드는 `local-managed`와 `remote-managed` 모두에서 공통으로 필요한 정리를 수행한다.
- 핵심 정리 항목은 `last_progress_at = null`, `last_heartbeat_at = null`, heartbeat timer clear, `remote_status = idle`, `last_turn_output`, `total_turns`, `last_user_message` 갱신이다.
- `LocalManagedOpenController`는 turn 완료를 감지하면 직접 상태를 만지지 않고 이 메서드를 호출한 뒤 stop 메시지만 기록한다.

## Validation

- failing test: local-managed turn settlement 후 progress/heartbeat 상태가 비워지고 `remote_status`가 `idle`인지 확인
- targeted tests: `session-manager`, `local-managed-open-controller`
