# TL Remote App-Server Stop Path PoC Design

## 문제

현재 TL의 `hook-stop-and-wait` 경로는 살아 있는 stop hook 프로세스와 HTTP 연결에 waiting을 직접 묶는다. 이 연결이 약 5~8분 내에 abort되면, `stopTimeout=7200` 설정과 무관하게 waiting consumer가 사라지고 이후 Telegram reply는 late reply로만 처리된다. 그 결과 TL은 같은 live 세션을 이어가지 못하고 `codex resume`으로 별도 resumed run을 띄운다.

이 PoC의 목적은 stop hook 경로를 Codex `app-server` remote thread 기반으로 교체해, 같은 live remote thread에 입력을 계속 주입할 수 있는지 검증하는 것이다.

## 목표

- 기존 topic 생성, Telegram 메시지 전송, session store, late-reply fallback은 유지한다.
- remote-attached 세션에 한해서 stop 이후 reply 전달 경로를 app-server 기반으로 바꾼다.
- reply가 `resume`이 아니라 `turn/start` 또는 `turn/steer`로 같은 remote thread에 들어가는지 입증한다.
- remote injection 실패 시 현재 late-reply `codex exec resume` fallback은 그대로 유지한다.

## 비목표

- TL 기본 모드를 remote로 전환하지 않는다.
- 자동 thread discovery를 하지 않는다.
- multi-app-server routing을 하지 않는다.
- README 같은 공개 사용자 문서는 이번 PoC 범위에 넣지 않는다.

## 아키텍처

### 1. Remote session attachment

TL session은 명시적으로 remote app-server thread에 attach된다.

- `tl remote attach <session_id> --thread <thread_id> --endpoint <ws-url>`
- 세션 영속 데이터에 remote metadata를 저장한다.
- 첫 버전은 global endpoint 1개 또는 세션별 endpoint 1개만 지원해도 충분하다.

### 2. AppServerClient

새 `AppServerClient`는 websocket으로 Codex app-server에 연결하고 아래 요청을 담당한다.

- `turn/start(threadId, input)`
- `turn/steer(threadId, expectedTurnId, input)`
- 필요 시 thread 상태 조회

이 클라이언트는 TL session이 remote-attached인지 확인하는 얇은 PoC 레이어다. 안정성보다 request shape 검증과 fallback 전환이 우선이다.

### 3. RemoteStopController

현재 `SessionManager.handleStopAndWait()`는 Telegram stop 메시지 전송 후 `ReplyQueue.waitFor()`를 호출한다. PoC에서는 remote-attached 세션이면 이 경로를 우선 가로채고, 다음 전략으로 reply를 처리한다.

1. stop 메시지는 기존처럼 Telegram에 보낸다.
2. stop 결과는 기존처럼 `block`을 반환해 Telegram reply를 기다리는 UX를 유지한다.
3. Telegram reply가 오면:
   - remote thread가 idle이면 `turn/start`
   - remote thread가 active이고 steerable이면 `turn/steer`
   - 위 둘이 실패하면 기존 late-reply resume fallback

핵심은 stop hook 프로세스 수명과 별개로 daemon이 remote controller를 보유하고 있다는 점이다. stop hook 요청이 abort되어도, remote attachment가 살아 있으면 daemon은 같은 thread에 다시 입력을 넣을 수 있다.

### 4. 기존 fallback 유지

PoC는 remote path가 실패해도 현재 TL 제품 동작을 깨뜨리면 안 된다.

- remote metadata가 없으면 기존 local stop path를 그대로 사용
- remote injection이 실패하면 `LateReplyResumer` 경로로 fallback
- Telegram에는 기존 resume/late-reply 시작 안내를 그대로 보낸다

## 데이터 모델

`SessionRecord`에 아래 remote metadata를 추가한다.

- `remote_mode_enabled: boolean`
- `remote_endpoint: string | null`
- `remote_thread_id: string | null`
- `remote_last_turn_id: string | null`
- `remote_last_injection_at: string | null`
- `remote_last_injection_error: string | null`

PoC에서는 이 정도면 충분하다. 더 정교한 connection state cache는 메모리 전용으로만 둔다.

## CLI/데몬 경로

### 새 CLI

- `tl remote attach <session_id> --thread <thread_id> --endpoint <ws-url>`
- `tl remote detach <session_id>`
- `tl remote status [session_id]`
- 필요 시 test/debug용 `tl remote inject`는 내부 smoke 검증 전용으로만 둔다.

### 데몬

- `/hook/stop-and-wait`는 세션이 remote-attached인지 확인한다.
- remote-attached 세션이면 `RemoteStopController` 경로를 사용한다.
- local path와 공존해야 한다.

## 검증 기준

### Contract tests

- app-server request payload가 `turn/start` 또는 `turn/steer` shape로 만들어지는지
- active turn에서는 `expectedTurnId`가 포함되는지
- injection 실패 시 fallback이 호출되는지

### E2E / smoke

- local `codex app-server --listen ws://127.0.0.1:<port>`
- remote Codex 세션 attach
- stop 이후 reply 주입
- 같은 remote thread id에 새 turn이 시작되는지 확인

## 성공 기준

1. remote-attached 세션은 late reply 시 `codex resume` 대신 app-server request를 먼저 시도한다.
2. app-server path 성공 시 TL session은 새로운 resumed CLI session 없이 같은 remote thread를 계속 사용한다.
3. remote path 실패 시 fallback으로 작업이 계속된다.
4. 기존 local mode 회귀가 없다.
