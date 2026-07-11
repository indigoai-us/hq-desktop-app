---
id: hq-desktop-app-nonactivating-window-toggle-focusable-for-input
title: Non-activating Tauri windows must toggle focusable for text input
scope: repo
trigger: Adding or debugging text inputs in a Tauri window configured with focusable=false (non-activating panel/popover)
when: focusable || (tauri && (input || focus || keyboard)) || non-activating
on: [PreToolUse, PostToolUse, UserPromptSubmit, AssistantIntent]
enforcement: soft
public: false
version: 1
created: 2026-07-10
updated: 2026-07-10
source: session-learning
---

## Rule

ALWAYS: when a Tauri window is non-activating (`focusable: false`), any text input inside it cannot receive keyboard focus — typing silently goes nowhere. For input interactions, toggle `focusable` on demand (enable before focusing the input) and restore `focusable: false` after the interaction completes so the window stays non-activating for its normal popover behavior.

## Rationale

Discovered shipping widget work in hq-desktop-app: a text field rendered in a non-activating window never received keystrokes because macOS will not give key focus to a window marked non-focusable. The fix is a temporary focusable toggle around the input interaction, not making the window permanently focusable (which breaks the menubar/popover UX).
