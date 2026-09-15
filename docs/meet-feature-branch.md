# HQ Meet feature branch

HQ Meet is parked on `codex/hq-meet-preserved`, based on desktop main
`a5dfcbcc` (including the desktop changes through PR828).
The separate `codex/remove-hq-meet` branch removes native offices, call windows,
local speech transcription, the calls adapter and Meet-only test tooling.
Existing Recall meetings, local bots, desktop navigation and signing fixes remain.
Legacy native transcript sync exclusions remain to protect files already saved.

The removal branch is for validation before merging. No backend rollback or
release is part of this change.

## Restoring Meet later

Git already considers the original Meet commit merged. Simply merging the
preserved branch after the removal lands will not reintroduce the removed code.
To restore it on updated main, create a new feature branch from that main and
revert the removal commit there, then resolve any intervening changes and test.
Keep the preserved branch as a reference; never merge main's removal into it
without deliberately restoring the feature afterward.
