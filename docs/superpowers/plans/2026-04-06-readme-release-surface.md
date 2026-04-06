# TL README Release Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild TL's public documentation surface around an English canonical README, a Korean translation, and a Codex-only installation entrypoint.

**Architecture:** Keep `README.md` as a thin product-facing entrypoint, add `README.ko.md` as the matching Korean translation, and push operational detail down into `PROMPTS.md` and `CODEX_SETUP.md`. Preserve historical context in `docs/REQUIREMENTS.md`, but remove it from the public onboarding path.

**Tech Stack:** Markdown documentation, GitHub repository layout, existing TL docs structure

---

### Task 1: Rewrite the English canonical README

**Files:**
- Modify: `README.md`
- Reference: `docs/superpowers/specs/2026-04-06-readme-release-surface-design.md`
- Reference: `PROMPTS.md`
- Reference: `CODEX_SETUP.md`

- [x] **Step 1: Replace the current README structure with the new product-facing outline**

Create sections in this order:

```md
# TL

One-sentence TL positioning.

## Why TL
- ...

## What It Does
- ...

## Install With Codex
Tell Codex to follow `https://github.com/flowkater/tl/blob/main/PROMPTS.md`

## Docs
- Korean translation
- Prompt guide
- Codex setup guide
- Historical requirements

## Status
- ...
```

- [x] **Step 2: Remove direct shell install commands from README**

The install section must not include:

```text
npm install -g ...
tl plugin install
tl help
```

It must keep only the Codex-driven installation path and related documentation links.

- [x] **Step 3: Keep README product-facing rather than operator-facing**

Retain product behavior descriptions such as:

```md
- Topic-per-session mapping
- Stop message delivery
- Telegram reply resume
- Late reply fallback
- Local plugin / MCP tools
```

Remove operator-heavy details such as exact hook merge procedures from the README body.

- [x] **Step 4: Review README for link integrity and consistent tone**

Check:

- links point to `README.ko.md`, `PROMPTS.md`, `CODEX_SETUP.md`, `docs/REQUIREMENTS.md`
- English is the canonical language
- no direct install command remains in the README

### Task 2: Add the Korean translation README

**Files:**
- Create: `README.ko.md`
- Reference: `README.md`

- [x] **Step 1: Create a Korean README with the same structure as the English README**

Use the same section order:

```md
# TL
## 왜 TL인가
## 주요 기능
## Codex로 설치하기
## 문서
## 현재 범위
```

- [x] **Step 2: Keep the Korean README aligned with the English README**

Mirror:

- section order
- document links
- install policy

Do not add Korean-only operational content that is missing from the English canonical version.

- [x] **Step 3: Add cross-links between English and Korean README files**

Add an English-to-Korean link in `README.md` and a Korean-to-English link in `README.ko.md`.

### Task 3: Tighten the supporting docs around the new README surface

**Files:**
- Modify: `PROMPTS.md`
- Modify: `CODEX_SETUP.md`
- Reference: `README.md`
- Reference: `README.ko.md`

- [x] **Step 1: Align PROMPTS.md with README’s Codex-only install entrypoint**

Ensure `PROMPTS.md` begins from the Codex-driven install path and does not assume the reader starts with manual shell installation from the README.

- [x] **Step 2: Align CODEX_SETUP.md with the new docs split**

Make sure `CODEX_SETUP.md` clearly acts as the operator/advanced guide, not the primary public entrypoint.

- [x] **Step 3: Add or adjust document cross-links where needed**

Ensure the docs reference each other cleanly:

- README -> PROMPTS / CODEX_SETUP / REQUIREMENTS / README.ko
- supporting docs -> README when appropriate

### Task 4: Verify the documentation surface and finalize

**Files:**
- Verify: `README.md`
- Verify: `README.ko.md`
- Verify: `PROMPTS.md`
- Verify: `CODEX_SETUP.md`

- [x] **Step 1: Run repo tests to confirm doc changes did not disturb packaging/runtime assumptions**

Run:

```bash
npm test
```

Expected: PASS, all existing TL tests remain green.

- [x] **Step 2: Search for forbidden README install commands**

Run:

```bash
rg -n "npm install -g|tl plugin install|tl help" README.md README.ko.md
```

Expected:

- `README.md` should not contain direct install commands
- `README.ko.md` should not contain direct install commands

- [x] **Step 3: Review git diff for public surface coherence**

Run:

```bash
git diff -- README.md README.ko.md PROMPTS.md CODEX_SETUP.md
```

Expected:

- README is product-facing
- Korean translation exists
- supporting docs stay detailed

- [ ] **Step 4: Commit the documentation surface update**

Run:

```bash
git add README.md README.ko.md PROMPTS.md CODEX_SETUP.md docs/superpowers/plans/2026-04-06-readme-release-surface.md
git commit -m "docs: rebuild TL README release surface"
```
