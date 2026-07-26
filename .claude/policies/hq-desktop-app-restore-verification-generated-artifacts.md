---
id: hq-desktop-app-restore-verification-generated-artifacts
title: Restore verification-only generated artifacts before handoff
scope: repo
trigger: completing coverage or Tauri bundle verification
when: (coverage || tauri || bundle) && (generated || artifact || handoff || verify)
on: [PreToolUse, PostToolUse, UserPromptSubmit, AssistantIntent]
enforcement: soft
public: false
version: 1
created: 2026-07-26
updated: 2026-07-26
source: session-learning
---

## Rule

ALWAYS: After coverage or Tauri bundle verification, inspect tracked generated artifacts and restore verification-only changes before handoff.

## Rationale

Coverage and native bundle tooling can mutate tracked generated files even when production source is unchanged, creating accidental handoff drift.
