# TL

TL is a local bridge that connects Codex sessions to Telegram topics so you can follow, reply to, and resume work from Telegram without rebuilding your workflow around a browser or chat client.

한국어 번역: [README.ko.md](README.ko.md)

## Why TL

- You get turn-complete messages in Telegram instead of watching the terminal for every stop.
- Each root Codex session is isolated into its own Telegram topic.
- A Telegram reply can resume the next Codex turn directly.
- Late replies can still trigger a fallback resume path after the original stop wait has ended.
- TL can expose local Codex plugin / MCP tools for status, sessions, daemon control, and config updates.

## What It Does

- Creates or reconnects a Telegram topic on root `SessionStart`.
- Sends the current turn's assistant `commentary + final` output on `Stop`.
- Routes topic messages by `thread_id`, and uses message reply matching when `thread_id` is missing.
- Confirms successful handoff with `reply delivered to Codex` only when the stop hook return path succeeds.
- Supports late-reply resume fallback through `codex exec resume --dangerously-bypass-approvals-and-sandbox`.
- Ignores subagent `SessionStart` traffic so only root sessions open topics.
- Safe-merges TL hooks into existing Codex hook graphs by default.

## Install With Codex

Tell Codex:

```text
Follow the instructions in https://github.com/flowkater/tl/blob/main/PROMPTS.md to install and configure TL safely.
```

If you only want the product-facing install path, start there. The detailed execution prompts and advanced setup flow live in the linked docs below.

## Docs

- [Korean translation](README.ko.md)
- [Codex prompt guide](PROMPTS.md)
- [Advanced Codex setup guide](CODEX_SETUP.md)
- [Historical requirements](docs/REQUIREMENTS.md)

## Status

- TL is a local-only bridge.
- It requires a Telegram group or supergroup with Topics enabled.
- It is built around Codex hooks and local daemon coordination.
- Advanced hook graphs that already use custom routers or wrappers may need manual verification before enabling direct TL hooks.
