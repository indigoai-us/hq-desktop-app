---
id: hq-desktop-app-source-contract-specs-retarget-with-edits
title: Retarget source-contract e2e literals in the same commit as component edits
scope: repo
trigger: Editing or merging changes to apps/sync Svelte components covered by desktop-alt source-contract specs
when: NotificationRow || Widget.svelte || desktop-alt || svelte
on: [PreToolUse, PostToolUse, UserPromptSubmit, AssistantIntent]
enforcement: hard
public: false
version: 1
created: 2026-07-10
updated: 2026-07-10
source: back-pressure-failure
---

## Rule

The `apps/sync/e2e/desktop-alt/` suite contains SOURCE-CONTRACT specs that assert exact code literals copied from component files (e.g. `inbox-merge.spec.ts` asserts the literal `const expanded = $derived(...)` expression from `NotificationRow.svelte`; `widget-lifecycle.spec.ts` asserted the queued-superscript markup from `Widget.svelte`).

ALWAYS, when editing or merging any change to a component under `apps/sync/src/` (especially `NotificationRow.svelte` and `Widget.svelte`):

1. Grep `apps/sync/e2e/` for literals taken from the lines you changed (search for distinctive fragments such as `const expanded`, class names, or markup snippets).
2. Retarget every matching contract literal to the new code IN THE SAME COMMIT — without weakening what the spec proves.
3. Run the desktop-alt e2e suite locally and confirm 0 failures BEFORE pushing.

## Rationale

Two CI failures on 2026-07-10 (PRs #164 and #166) were caused by the same stale-literal pattern: a component refactor (unified unread badge; merged hover-expand expression) left a source-contract spec asserting the old literal. Local unit suites passed, so the breakage only surfaced in CI, costing a full round-trip each time.
