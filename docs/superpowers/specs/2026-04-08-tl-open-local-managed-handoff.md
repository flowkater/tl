# TL `tl open` / `local-managed` 개발 handoff

작성일: 2026-04-08  
상태: 실환경 smoke 통과, 후속 정리 작업 일부 남음

## 1. 목표

이번 작업의 목표는 다음이었다.

- `hook-local` 중심의 `Stop -> waiting -> reply -> resume` 흐름에서 벗어난다.
- `tl open`을 기본 시작 경로로 삼는다.
- 사용자가 터미널에서 Codex를 쓰다가, 같은 세션을 Telegram과 자유롭게 오갈 수 있게 한다.
- `tl open`으로 연 세션은 blank 상태로 attach된 뒤, 첫 실제 사용자 입력 시 daemon이 thread를 채택하고 Telegram topic을 자동 생성해야 한다.

## 2. 최종 결론

최종적으로 확인된 결론은 다음과 같다.

- `tl open`은 단일 고정 app-server endpoint를 재사용하면 안 된다.
- local-managed blank open은 **매 open마다 독립 app-server endpoint**를 가져야 한다.
- 첫 실제 입력 이후 daemon이 해당 endpoint의 새 loaded thread를 채택하는 방식은 실환경에서 동작한다.

즉 현재 설계의 핵심은:

1. `tl open`
2. per-open app-server endpoint 할당
3. blank Codex remote attach
4. 첫 사용자 입력
5. daemon이 pending open을 새 thread로 채택
6. Telegram topic 생성 + session 시작

## 3. 실제로 겪은 원인들

### 3.1 고정 endpoint `8795` 공유 문제

가장 큰 문제는 `localCodexEndpoint=ws://127.0.0.1:8795`를 그대로 쓰던 시절이었다.

- 이 endpoint는 현재 사용 중인 Codex app-server와 공유되었다.
- 결과적으로 `tl open`이 blank attach를 하더라도, 새 세션이 아니라 **이미 살아 있는 loaded thread / 현재 대화 문맥**으로 붙는 경우가 발생했다.
- 그 상태에서는 Telegram topic이 생성되지 않거나, 전혀 다른 세션이 채택되었다.

이 문제는 screen hardcopy와 thread list를 비교하면서 확인했다.

### 3.2 `--cd` 미지정 문제

중간 단계에서는 `tl open`이 `--cwd`로 backend 디렉토리를 받았지만, 실제 remote thread는 TL 저장소 cwd로 materialize되는 문제가 있었다.

원인:

- Codex remote thread의 실제 cwd는 단순 process cwd가 아니라 `codex --remote ... --cd <cwd>`로 명시해야 안정적으로 맞았다.

조치:

- `local-console-runtime.ts`
- `interactive-codex-launcher.ts`

에서 `codex --remote` / `codex resume --remote` 모두 `--cd`를 붙이도록 수정했다.

### 3.3 seconds / milliseconds timestamp 버그

pending open 채택 로직은 새 thread 후보를 `updatedAt >= registeredAtMs - 5000`으로 골랐는데, app-server thread timestamp는 초 단위로 들어오는 경우가 있었다.

결과:

- 실제로는 새 thread가 생겨도 후보 필터에서 탈락했다.

조치:

- `local-managed-open-controller.ts`에 timestamp 정규화 로직을 넣어 seconds/ms를 모두 처리했다.

### 3.4 blank open 등록 시 baseline thread 집합 누락

`tl open` 등록 직전에 endpoint의 기존 thread 목록을 캡처하지 않으면, 나중에 새 thread와 기존 thread를 구분하기가 불안정했다.

조치:

- `cmdOpen()`에서 open 직전 `listThreads()` 결과를 수집
- `/local/open/register`에 `known_thread_ids`로 전달
- daemon 채택 로직에서 baseline 제외 후 새 thread만 후보로 취급

### 3.5 고정 `8796`도 충분하지 않았음

처음에는 `8795` 대신 `8796`을 daemon 전용 local endpoint로 분리하면 해결될 것으로 봤다.

하지만 실환경에서 다시 확인한 결과:

- `8796`에 이미 loaded thread가 하나라도 남아 있으면
- 새 `tl open`도 그 endpoint 내부에서 기존 loaded thread 재사용 문제를 다시 겪었다.

즉, **고정 전용 endpoint 하나**도 근본 해결이 아니었다.

### 3.6 per-open endpoint allocator의 trailing slash 버그

per-open endpoint 할당기로 `8797`, `8798` 등을 잡기 시작한 뒤에도 첫 시도는 실패했다.

원인:

- allocator가 `ws://127.0.0.1:8797/` 형태로 trailing slash가 붙은 URL을 반환했다.
- 이 값으로 `codex app-server --listen`을 띄우면 readyz가 올라오지 않아 `Timed out waiting for app-server readyz`로 실패했다.

조치:

- endpoint serializer를 별도로 두고 `ws://127.0.0.1:8797`처럼 path 없는 URL만 반환하도록 수정했다.

## 4. 최종 구현 상태

현재 구현 핵심은 다음 파일들에 들어 있다.

- `src/cli.ts`
  - `tl open` 실행 시
    - daemon 보장
    - base local endpoint 결정
    - **빈 포트 기반 per-open endpoint 할당**
    - 해당 endpoint에 app-server 보장
    - blank remote Codex attach
    - daemon에 pending open 등록

- `src/local-app-server-endpoint.ts`
  - `allocateAvailableLocalEndpoint()`
  - base endpoint 근처 빈 포트 탐색
  - trailing slash 없이 websocket URL 직렬화

- `src/local-managed-open-controller.ts`
  - pending blank open 감시
  - baseline thread 제외
  - cwd 일치 + 새 thread 후보 선택
  - 새 thread 채택 후 `handleSessionStart()`
  - topic 생성 / session 시작 / monitor 연결

- `src/local-console-runtime.ts`
  - `codex --remote` / `resume --remote` 실행 시 항상 `--cd` 포함

- `src/config.ts`
  - local-managed base endpoint 기본값은 현재 `ws://127.0.0.1:8796`
  - 단, 실제 open은 이 값을 **base**로 삼을 뿐, 필요하면 `8797`, `8798` 등으로 올라간다.

## 5. 실환경 smoke 결과

최종 성공한 실환경 smoke는 다음과 같다.

명령:

```bash
tl open --cwd /Users/flowkater/workspace/todait/todait/todait-backend --project tl-open-blank-smoke-20260408e
```

그 뒤 blank 세션에서 첫 실제 메시지 제출:

```text
fresh endpoint smoke after per-open allocation
```

daemon 로그 결과:

- `Registered pending local-managed open {"attachmentId":"tl-open-8f424f77-9a5",...}`
- `Forum topic created {"topic_id":705,...}`
- `Session started {"session_id":"019d6af4-7490-7682-b271-b9cae7d72e37",...}`
- `Adopted local-managed thread from blank open {"attachmentId":"tl-open-8f424f77-9a5",...}`

session 저장 결과 핵심:

- `mode: "local-managed"`
- `topic_id: 705`
- `start_message_id: 706`
- `remote_endpoint: "ws://127.0.0.1:8797"`
- `remote_thread_id: "019d6af4-7490-7682-b271-b9cae7d72e37"`

즉, 이번 smoke는 아래를 실환경에서 확인했다.

- `tl open`이 새 endpoint를 잡는다.
- blank attach가 된다.
- 첫 입력 후 daemon이 새 thread를 채택한다.
- Telegram topic이 자동 생성된다.
- session store에도 정상 반영된다.

## 6. smoke 후 정리 상태

성공한 smoke 세션은 정리 완료했다.

- topic `705` 삭제
- session `019d6af4-7490-7682-b271-b9cae7d72e37` 삭제
- `8797` app-server 종료
- 해당 `tl-open-8f424f77-9a5` screen 종료

정리 후 확인 상태:

- `tl sessions`는 기존 6개 active 세션만 남음
- `lsof -iTCP:8797` 결과 없음

## 7. 아직 남아 있는 찌꺼기 / 후속 작업

### 7.1 오래된 실패 screen 정리 필요

아래 예전 실패 세션이 아직 남아 있다.

- `30255.tl-open-41fe8e6d-dcb`

이건 이전 broken open 세션이므로 수동 정리해도 된다.

권장:

```bash
screen -S tl-open-41fe8e6d-dcb -X quit
```

### 7.2 per-open endpoint lifecycle 정리 보강

현재 smoke 정리 과정에서 `8797` app-server를 먼저 죽이면 daemon monitor가 잠깐 아래 경고를 찍는다.

- `Failed to observe local-managed session thread ... Failed to connect to app-server`

기능상 큰 문제는 아니지만, 세션 삭제 / detach 시 monitor 해제를 먼저 하고 endpoint runtime을 정리하는 순서로 개선할 수 있다.

### 7.3 문서 드리프트

현재 일부 문서에는 과거 intermediate 설계가 남아 있을 가능성이 있다.

특히 다음 내용은 다시 점검이 필요하다.

- `tl open`이 bootstrap text를 먼저 묻는다고 적혀 있는 부분
- 고정 endpoint 하나만 쓰는 것처럼 읽히는 부분

현재 실제 동작은:

- `tl open`은 blank open
- 첫 실제 입력 시 채택
- endpoint는 per-open 할당

## 8. 권장 후속 작업 순서

다음 세션에서 이어서 하면 좋은 순서는 아래와 같다.

1. 오래된 stale `screen` 세션 정리
2. README / CODEX_SETUP / PROMPTS 문구를 현재 동작 기준으로 정리
3. local-managed session delete/detach 시 endpoint cleanup 순서 개선
4. 필요하면 `tl cleanup` 같은 보조 명령 추가

## 9. 검증 기록

이번 세션에서 확인한 검증은 다음과 같다.

### 코드 검증

```bash
npx tsc --noEmit
npx vitest run
```

최종 결과:

- `26`개 테스트 파일
- `171`개 테스트 통과

### 실환경 smoke

성공 사례:

- project: `tl-open-blank-smoke-20260408e`
- topic: `705`
- session: `019d6af4-7490-7682-b271-b9cae7d72e37`
- endpoint: `ws://127.0.0.1:8797`

## 10. 핵심 한 줄 요약

`tl open`이 안정적으로 동작하려면 **blank open + 첫 입력 채택 + per-open dedicated app-server endpoint** 조합이 필요하다. 고정 shared endpoint 재사용 방식은 실환경에서 계속 꼬인다.
