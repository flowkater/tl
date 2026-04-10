# TL Telegram Control And Codex Directives Design

> Telegram topic 안에서 TL 브리지 제어 커맨드와 Codex 스킬/커맨드/실행 선호값을 함께 지정할 수 있도록 입력 계층을 확장한다.

## Problem

지금 Telegram 입력 경로는 사실상 두 가지뿐이다.

- `/tl-status` 같은 극히 제한된 상태 커맨드
- 그 외 모든 텍스트를 그대로 session reply/prompt 로 전달하는 경로

그래서 사용자는 Telegram에서 다음을 할 수 없다.

- `resume`, `status`, 토픽 기본값 조회/설정 같은 TL 브리지 제어
- 이번 턴에 사용할 Codex skill 지정
- `/compact` 같은 Codex 커맨드 prefix 지정
- 다음에 attach/spawn 될 managed Codex 세션의 `model`, `approval-policy`, `sandbox`, `cwd` 선호값 지정

결과적으로 Telegram은 단순한 reply 입력창 역할만 하고 있고, 실제 워크플로 제어는 터미널에 남아 있다.

## Goals

- Telegram topic 안에서 TL 브리지 제어를 수행할 수 있어야 한다.
- Telegram topic 안에서 Codex turn-level directives 를 지정할 수 있어야 한다.
- 토픽별 기본값을 저장하고, 개별 메시지에서 override 할 수 있어야 한다.
- 기존 reply routing, waiting delivery, remote-managed delivery 경로를 깨지 않아야 한다.
- 지원하지 않는 지시는 조용히 무시하지 말고 topic 안에 명시적으로 오류를 돌려줘야 한다.

## Non-Goals

- Telegram에서 임의의 shell command 를 직접 실행하지 않는다.
- 실행 중인 Codex 프로세스의 `model`, `approval-policy`, `sandbox`, `cwd` 를 라이브로 변경하지 않는다.
- Telegram에서 destructive admin 명령(`topic delete`, 강제 detach, 강제 local/remote open`)까지 노출하지 않는다.
- 일반 대화 메시지 본문 중간에 있는 `@skill:` 같은 문자열까지 파싱하지 않는다. 헤더는 메시지 맨 앞에서만 해석한다.

## v1 Decisions

남은 선택지는 모두 추천안으로 확정한다.

- 입력 방식: 혼합형
  - TL 브리지 제어는 `/tl ...`
  - Codex 지시는 메시지 헤더(`@skill:`, `@cmd:` 등)
- 적용 범위: 토픽 기본값 + 메시지별 override 둘 다 지원
- 헤더 문법: 반복 라인 + 쉼표 목록 둘 다 허용
- Codex directive v1 키: `skill`, `cmd`, `model`, `approval-policy`, `sandbox`, `cwd`
- 권한 모델: topic 참여자 누구나 실행 가능
- `/tl` command v1 범위:
  - `/tl help`
  - `/tl status`
  - `/tl resume`
  - `/tl show config`
  - `/tl set <field> <value>`
  - `/tl clear <field>`
- clear 의미: 빈 값은 무시, `none` 만 clear 로 해석

## Syntax

### 1. TL Bridge Commands

브리지 커맨드는 메시지 전체가 `/tl` 로 시작할 때만 해석한다.

예시:

```text
/tl help
/tl status
/tl resume
/tl show config
/tl set skill systematic-debugging,swift-concurrency-expert
/tl set cmd /compact
/tl set model gpt-5.4
/tl set approval-policy never
/tl set sandbox danger-full-access
/tl set cwd /Users/flowkater/Projects/TL
/tl clear skill
/tl clear cmd
```

`/tl set` 은 field 값을 통째로 교체한다.
리스트 필드(`skill`, `cmd`)는 쉼표 목록으로 받고 내부적으로 배열로 정규화한다.

`/tl clear <field>` 는 토픽 기본값에서 해당 field 를 삭제한다.

### 2. Codex Message Headers

일반 메시지는 맨 앞 연속 헤더 블록만 파싱한다.
첫 번째 non-header line 이 나오면 그 뒤는 모두 사용자 본문으로 취급한다.

허용 예시:

```text
@skill: systematic-debugging
@skill: swift-concurrency-expert
@cmd: /compact
@model: gpt-5.4

이 크래시 원인부터 좁혀봐
```

```text
@skill: systematic-debugging, swift-concurrency-expert
@cmd: /compact, /no-tools

원인 분석만 먼저 해
```

clear 예시:

```text
@skill: none
@cmd: none

이번 턴은 기본 스킬 없이 그냥 답해
```

규칙:

- key 는 case-insensitive 로 받지만 내부 저장은 canonical key 로 정규화한다.
- `skill`, `cmd` 는 반복 가능하다.
- `model`, `approval-policy`, `sandbox`, `cwd` 는 마지막 값이 승리한다.
- 헤더만 있고 본문이 비어 있으면 오류 메시지를 보내고 세션에는 전달하지 않는다.
- 알 수 없는 key 가 있으면 오류 메시지를 보내고 세션에는 전달하지 않는다.

## Semantics

핵심은 `즉시 반영 가능한 지시` 와 `다음 attach/spawn 에 반영할 선호값` 을 분리하는 것이다.

### Immediate Per-Message Directives

아래 항목은 현재 turn 에 즉시 반영된다.

- `skill`
- `cmd`

처리 방식:

- `skill` 은 전달 본문 앞에 명시적 instruction block 으로 컴파일한다.
- `cmd` 는 전달 본문 맨 앞에 raw command line 으로 삽입한다.

정규화된 최종 프롬프트 예시:

```text
/compact

[TL directives]
Use these skills for this turn: systematic-debugging, swift-concurrency-expert
[/TL directives]

이 크래시 원인부터 좁혀봐
```

이 방식의 장점:

- 현재 TL bridge 는 문자열 주입만 지원하므로 구조를 크게 바꾸지 않아도 된다.
- skill 이름이 사용자 메시지 안에 명시되므로 기존 Codex skill trigger 규칙과도 잘 맞는다.

### Deferred Spawn Preferences

아래 항목은 실행 중인 세션에는 라이브 변경하지 않는다.

- `model`
- `approval-policy`
- `sandbox`
- `cwd`

이 값들은 두 곳에 쓰인다.

1. `/tl set ...` 로 저장된 토픽 기본값
2. 메시지 헤더에서 들어온 이번 턴 override

하지만 실제 적용 시점은 다음 둘 중 하나다.

- Telegram-first remote/local managed 세션을 새로 spawn 할 때
- degraded 상태 회복을 위해 worker/local console 을 다시 attach/start 할 때

이미 붙어 있는 active Codex 세션에 대해서는:

- 현재 turn 에는 informational ack 만 보낸다.
- 상태 조회 시 `pending spawn preference` 로 노출한다.
- 다음 spawn/reattach 시 반영한다.

v1 에서 이 제약을 명시적으로 유지해야 사용자가 "모델이 지금 바뀌었다"고 오해하지 않는다.

## Resolution Order

메시지 처리 시 최종 effective directives 는 아래 우선순위로 계산한다.

1. 이번 메시지 헤더 override
2. topic persisted defaults
3. 현재 session record 에 이미 저장된 attach/runtime metadata
4. 기존 글로벌 설정값

단, `skill` 과 `cmd` 는 현재 session metadata 에서 상속하지 않는다.
이 둘은 오직 `message header` 또는 `topic default` 에서만 온다.

## Storage Model

토픽 기본값은 `sessions.json` 에 섞지 않고 별도 파일로 분리한다.

새 파일:

- `~/.tl/topic-preferences.json`

구조:

```json
{
  "version": 1,
  "topics": {
    "-1001234567890:727": {
      "skill": ["systematic-debugging", "swift-concurrency-expert"],
      "cmd": ["/compact"],
      "model": "gpt-5.4",
      "approval-policy": "never",
      "sandbox": "danger-full-access",
      "cwd": "/Users/flowkater/Projects/TL",
      "updated_at": "2026-04-10T12:00:00.000Z"
    }
  }
}
```

분리 이유:

- topic defaults 는 session lifecycle 과 다르다.
- 같은 topic 에 여러 session 이 쌓여도 기본값은 하나여야 한다.
- archive/cleanup 로 session 이 지워져도 topic defaults 는 유지되어야 한다.

## Telegram Routing Changes

`src/telegram.ts` 의 `handleMessage()` 에서 입력 경로를 세 갈래로 재구성한다.

### 1. `/tl ...` command path

- trim 된 전체 메시지가 `/tl` 로 시작하면 command parser 로 보낸다.
- 성공 시 topic 안에 짧은 ack/status message 를 보낸다.
- 이 경로는 session reply routing 으로 내려가지 않는다.

### 2. directive header path

- 일반 메시지면 leading header block 을 파싱한다.
- directive parse error 면 topic 에 오류를 보내고 종료한다.
- directive parse success 면 본문을 정규화해 기존 routing 경로로 넘긴다.

### 3. legacy raw reply path

- 헤더가 없으면 기존 `replyText.trim()` 그대로 라우팅한다.

즉, waiting session delivery, late reply, remote-managed injection 흐름은 보존하고,
그 앞에 얇은 command/directive 전처리층만 추가한다.

## Bridge Command Behavior

### `/tl help`

지원 문법과 예시를 topic 에 출력한다.

### `/tl status`

현재 topic 의 다음 정보를 출력한다.

- matched session id
- session status
- mode
- remote/local attachment 상태
- topic defaults 존재 여부
- pending spawn preferences 존재 여부

### `/tl resume`

- waiting session 이 있으면 기존 `/hook/resume` equivalent 동작을 실행한다.
- waiting session 이 없으면 명시적 오류를 돌려준다.

### `/tl show config`

현재 topic 기준 persisted defaults 와 resolved effective defaults 를 출력한다.

### `/tl set <field> <value>`

- topic preferences store 에 저장한다.
- `skill`, `cmd` 는 리스트로 정규화한다.
- `model`, `approval-policy`, `sandbox`, `cwd` 는 scalar 로 저장한다.
- 성공 후 새 effective defaults 를 echo 한다.

### `/tl clear <field>`

- topic defaults 에서 해당 field 를 제거한다.
- 성공 후 새 effective defaults 를 echo 한다.

## Validation Rules

### Skill

- skill 이름은 현재 세션에서 사용 가능한 skill 목록과 정확히 매칭돼야 한다.
- unknown skill 이 하나라도 있으면 전체 메시지를 reject 한다.

### Cmd

- `cmd` 는 `/` 로 시작하는 단일 command token 이어야 한다.
- 인자 포함을 허용한다. 예: `/compact`, `/config set foo bar`
- multi-line command 는 허용하지 않는다.

### Model / Approval Policy / Sandbox

- 허용된 값 목록으로 검증한다.
- unknown value 는 저장/적용하지 않고 오류를 돌려준다.

### Cwd

- absolute path 만 허용한다.
- path 존재 여부는 검증하되, 읽기 가능 여부까지 v1 에서 강제하지는 않는다.

## User Feedback

모든 `/tl` command 와 directive parse 는 topic 에 짧은 시스템 응답을 남긴다.

예:

- `✅ topic defaults updated`
- `✅ resume delivered to waiting session`
- `⚠️ unknown skill: foo-bar`
- `⚠️ headers were parsed but prompt body is empty`
- `ℹ️ model override saved for next managed spawn; current attached session is unchanged`

응답은 append-only topic text 로 유지한다. reaction 만으로 끝내지 않는다.

## Testing

### Parser Unit Tests

- `/tl` command parser
- directive header parser
- repeated header + comma list normalization
- `none` clear semantics
- unknown key/value rejection

### Store Tests

- topic preferences load/save
- atomic write + backup fallback
- topic key serialization (`chat_id:topic_id`)

### Telegram Tests

- `/tl ...` messages가 session routing으로 내려가지 않는지
- directive headers 가 strip 되고 normalized prompt 로 전달되는지
- invalid headers 가 오류 응답만 남기고 deliver 되지 않는지

### Daemon / Controller Tests

- `/tl resume` equivalent 가 waiting session 에만 적용되는지
- deferred spawn preferences 가 status 에 노출되는지
- attach/restart 시 persisted preferences 가 runtime launch args 로 반영되는지

## Rollout

v1 은 파괴적 명령을 포함하지 않는다.
먼저 topic command + directive parsing + topic default persistence 만 넣고,
사용 패턴이 확인되면 이후에 아래를 별도 설계로 확장한다.

- destructive admin commands
- topic-level permission model
- preset bundles (`/tl preset debug-ios`)
- live session reconfiguration
