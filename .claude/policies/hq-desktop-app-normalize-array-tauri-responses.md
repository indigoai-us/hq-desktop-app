---
id: hq-desktop-app-normalize-array-tauri-responses
title: Normalize array-shaped Tauri responses at frontend adapter boundaries
scope: repo
trigger: assigning Tauri response payloads to reactive frontend collections
when: tauri && (response || payload || array || reactive)
on: [PreToolUse, PostToolUse, UserPromptSubmit, AssistantIntent]
enforcement: soft
public: false
version: 1
created: 2026-07-26
updated: 2026-07-26
source: session-learning
---

## Rule

ALWAYS: Treat array-shaped Tauri responses as untrusted at frontend adapter boundaries; normalize non-array preview or backend payloads before assigning them to reactive collections.

## Rationale

Preview harnesses and backend responses can violate an expected array shape, causing reactive UI surfaces to fail before they can render a recoverable state.
