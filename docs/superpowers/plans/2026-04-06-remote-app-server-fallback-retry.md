# TL Remote App-Server Fallback Retry Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** remote-attached 세션에서 첫 app-server injection 실패 시, 바로 local resume으로 내려가지 않고 app-server healthcheck와 자동 재기동 후 같은 thread 재시도를 시도한다.

**Architecture:** `AppServerRuntimeManager`가 endpoint `/readyz`를 확인하고 필요 시 `codex app-server --listen ...`를 재기동한다. `RemoteStopController`는 첫 inject 실패 후 runtime manager를 통해 app-server를 살리고, 같은 `threadId`에 한 번 더 inject를 시도한 뒤에만 late-reply resume fallback으로 내려간다.

**Tech Stack:** TypeScript, Node child_process, fetch, Vitest

---
