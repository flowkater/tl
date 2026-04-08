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

- Starts daemon-owned Codex threads and maps each root session to its own Telegram topic.
- Opens the same live session in the terminal and Telegram through a single managed thread.
- Routes topic messages by `thread_id`, and uses message reply matching when `thread_id` is missing.
- Uses `codex resume --remote --dangerously-bypass-approvals-and-sandbox` to attach the terminal to the managed session.
- Supports late-reply recovery for already-completed stop messages.
- Ignores subagent traffic for Telegram topic creation and delivery.

## Modes

### Local-Managed Mode (default)

Use this when you want the same Codex session to stay reachable from both the terminal and Telegram without getting stuck in `Stop -> waiting`.

- TL starts a daemon-owned Codex thread through the app-server.
- You enter the same live thread in your current terminal with `tl open`.
- `tl open` keeps the terminal environment intact, so `cmux` and normal scroll/alt-screen behavior stay under Codex control.
- If you omit `--text`, `tl open` opens a blank Codex session first and TL adopts the thread when the first real prompt is submitted.
- Telegram messages and terminal input land in the same live session.
- `tl resume` becomes a recovery tool instead of the normal workflow.

Basic flow:

```bash
tl open --cwd "$PWD" --project my-session
```

Inspect the managed session:

```bash
tl local status
tl local status <session_id>
```

### Hook-Local Mode (deprecated)

This is the old Codex hook flow. TL no longer installs it by default.

- Existing legacy hook-local setups may still be present on a machine.
- `tl init` now removes deprecated TL `SessionStart` / `Stop` hooks instead of installing them.
- Free switching is no longer built around `Stop -> waiting`.

### Remote-Managed Mode (experimental)

This is the app-server-first remote path for users who want a fully remote-managed Codex runtime.

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
- It supports daemon-owned local-managed sessions as the default path.
- Free terminal ↔ Telegram switching is provided by `tl open`.
- Advanced hook graphs that already use custom routers or wrappers may need manual verification before enabling direct TL hooks.
