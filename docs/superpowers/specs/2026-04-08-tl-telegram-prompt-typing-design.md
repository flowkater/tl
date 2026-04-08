# TL Telegram Prompt Mirroring And Typing Design

> Codex 콘솔에서 입력한 root prompt를 Telegram topic에 그대로 미러링하고, 작업 중에는 기존 텍스트 heartbeat와 별도로 짧은 주기의 `typing` action을 반복 전송한다.

## Problem

지금 `hook-working` 경로는 `UserPromptSubmitPayload.prompt`를 이미 받지만 daemon이 이를 버리고 있다.
그래서 Telegram topic에서는 `🛠️ resumed, working...` / `⏳ still working...`만 보이고, 사용자가 Codex 콘솔에 실제로 무엇을 입력했는지는 보이지 않는다.

또한 작업 중 상태는 append-only 텍스트 메시지로만 표현된다.
Telegram이 제공하는 ephemeral `typing` action을 함께 보내면, 긴 턴 동안 topic 상단에 더 자연스러운 진행 상태를 유지할 수 있다.

## Design

두 기능 모두 기존 `handleWorking()` 진입점에 붙인다.

- `cmdHookWorking`가 daemon으로 보내는 `prompt`를 `/hook/working`에서 받아 `SessionManager.handleWorking()`로 전달한다.
- `handleWorking()`는 local/root 세션과 `local-managed` 세션에서만 prompt를 Telegram에 1회 미러링한다.
- 미러링 대상은 `UserPromptSubmit`의 `prompt` 원문 그대로다. 별도 포맷팅, prefix, markdown parsing은 하지 않는다.
- 빈 문자열이나 공백-only prompt는 미러링하지 않는다.
- remote-managed 세션은 기존처럼 prompt 미러링과 working Telegram 메시지를 모두 건너뛴다.

`typing`은 heartbeat와 별도 timer로 관리한다.

- working 시작 시 즉시 `typing` action을 1회 보내고, 이후 heartbeat보다 훨씬 짧은 간격으로 반복 전송한다.
- 기본 간격은 4초로 둔다. Telegram action은 ephemeral이므로 heartbeat 간격(분 단위)과 분리한다.
- 기존 `🛠️ resumed, working...` / `⏳ still working...` 텍스트는 그대로 유지한다.
- `handleManagedTurnSettled()`, `handleComplete()`, 비활성 세션 감지 경로에서 typing timer도 heartbeat timer와 함께 정리한다.

## Boundaries

- Telegram에서 들어온 user message를 다시 Telegram에 재송신하지 않는다.
- tool 호출, subagent 프롬프트, assistant 출력은 미러링 범위가 아니다.
- 기존 stop/complete/reconnect 메시지 포맷은 바꾸지 않는다.

## Validation

- daemon test: `/hook/working`가 `prompt`를 `SessionManager.handleWorking()`로 전달하는지 확인
- session manager test: local/root와 `local-managed`에서 prompt 미러링 + working + typing schedule이 시작되는지 확인
- session manager test: `remote-managed` 세션은 prompt/working/typing을 보내지 않는지 확인
- session manager test: turn settle 후 typing timer가 정리되어 추가 action이 더 이상 전송되지 않는지 확인
- telegram test: `sendTypingAction()`가 `sendChatAction(..., 'typing')`과 `message_thread_id`를 사용하는지 확인
