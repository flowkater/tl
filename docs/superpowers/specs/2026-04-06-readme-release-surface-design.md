# TL README / Release Surface Design

## 목표

- GitHub 첫 화면에서 TL이 무엇인지 즉시 이해되게 만든다.
- 설치 진입점은 `Codex` 한 경로만 남긴다.
- 영어 `README.md`를 canonical 문서로 두고, 한국어 번역은 별도 파일로 분리한다.
- 제품 소개, 실행 프롬프트, 운영 매뉴얼, historical 문서를 역할별로 분리한다.

## 설계 요약

- `README.md`
  - 영어 canonical entrypoint
  - 제품 설명, 핵심 기능, Codex 설치 진입점, 관련 문서 링크만 포함
  - 세부 명령, 수동 설정, 예외 운영 가이드는 포함하지 않음
- `README.ko.md`
  - `README.md`와 같은 구조의 한국어 번역본
  - 설치 경로도 영어판과 동일하게 Codex 진입점만 유지
- `PROMPTS.md`
  - Codex에게 그대로 전달할 실행 프롬프트 모음
  - 설치-only, install+configure, recovery 등 실제 실행 프롬프트 중심
- `CODEX_SETUP.md`
  - 운영자용 상세 매뉴얼
  - hook merge, plugin install, custom router/wrapper, rollback, verification 담당
- `docs/REQUIREMENTS.md`
  - historical requirements로 유지
  - 현재 source of truth가 아님을 계속 명시

## README 정보 구조

### 1. Hero

- TL의 포지션을 한 줄로 정의한다.
- `Codex ↔ Telegram bridge` 성격을 가장 앞에서 드러낸다.

### 2. Why TL

- TL이 해결하는 사용자 문제를 짧은 bullet로 설명한다.
- 예:
  - turn 완료 메시지를 Telegram으로 받음
  - topic 단위로 세션이 분리됨
  - Telegram reply로 다음 턴 재개
  - late reply fallback 지원
  - local plugin/MCP tool로 TL 제어 가능

### 3. What It Does

- 구현 세부보다 사용자 관점 기능을 설명한다.
- 세션 시작, stop/reply, late reply resume, working heartbeat, plugin tools를 제품 기능으로 요약한다.

### 4. Install With Codex

- 설치 경로는 이 섹션 하나만 둔다.
- `PROMPTS.md` GitHub URL을 따라 Codex에게 설치를 맡기라는 방식만 제공한다.
- `npm install -g ...`, `tl plugin install` 같은 명령은 README 본문에 직접 쓰지 않는다.

### 5. Docs

- 아래 문서 링크만 제공한다.
  - `README.ko.md`
  - `PROMPTS.md`
  - `CODEX_SETUP.md`
  - `docs/REQUIREMENTS.md`

### 6. Status / Scope

- TL이 로컬 전용 bridge라는 점
- Telegram Topics 필요
- advanced hook graph 환경은 별도 검증이 필요하다는 점만 짧게 적는다.

## 번역 운영 정책

- `README.ko.md`는 영어판의 직역보다 구조 일치가 더 중요하다.
- 섹션 순서와 링크 구조는 영어판과 동일하게 유지한다.
- 한쪽에서 구조가 바뀌면 다른 쪽도 같은 commit에서 같이 맞춘다.

## 이번 작업 범위

- `README.md`를 영어 canonical README로 재작성
- `README.ko.md` 신규 작성
- `PROMPTS.md`를 README에서 링크하는 실행 문서 역할에 맞게 정리
- `CODEX_SETUP.md`를 운영자 매뉴얼 역할에 맞게 정리
- `docs/REQUIREMENTS.md` historical 링크 위치만 유지

## 이번 작업 비범위

- GitHub Actions 추가
- CHANGELOG 도입
- npm registry publish 자동화
- 버전 정책 정립

이 항목들은 이후 release/publish 정리 단계에서 별도 작업으로 다룬다.
