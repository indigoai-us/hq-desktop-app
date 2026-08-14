---
id: hq-desktop-app-tauri-dev-no-watch-tray-helper-loop
title: Run hq-desktop-app tauri dev with --no-watch to avoid tray-helper rebuild loop
when: hq-desktop-app && (tauri || "tauri dev")
on: [PreToolUse, UserPromptSubmit, AssistantIntent]
enforcement: soft
version: 1
created: 2026-08-13
updated: 2026-08-13
public: false
source: session-learning
---

## Rule

For `hq-desktop-app` (`apps/sync`), run `pnpm tauri dev --no-watch` instead of
plain `pnpm tauri dev`.

## Rationale

The tray-helper build script writes a `.hq-tray-helper.*.tmp` file inside the
watched `src-tauri/` directory. Under the default watcher, that write
retriggers the dev file-watcher, which reruns the build, which writes the temp
file again — an endless rebuild loop. `--no-watch` avoids the loop.
