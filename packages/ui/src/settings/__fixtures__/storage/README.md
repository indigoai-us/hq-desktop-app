# Storage CLI fixtures

JSON the desktop parses from hq storage ... --json. The Rust storage command
tests and the TS model tests both read these files.

Captured from the real CLI (hq-cli feat/hq-storage):

- status.json, status-after-offload.json, offload-dry.json, offload-real.json, prune-dry.json: round 1.
- status-holders.json, prune-dry-holders.json, prune-dry-clean.json, prune-real-clean-backup.json,
  prune-real-holders-r2.json, offload-real-backup.json: round-2 e2e run (hq-cli fd04ac14, core 57bb1190).

Built from the round-3 contract (offload-contract.md, "Backups and reclaim"): every *-r3.json file.
Each starts from a round-2 capture above with only the round-3 fields added, because the round-3
CLI was not pushed when they were made. Replace them with real captures once hq-cli
feat/hq-storage carries reclaim, the prune refusal JSON and strip-large --no-backup.

Round 4 (hq-cli feat/hq-storage 8c616b80, shapes from src/commands/storage*.test.ts): every *-r4.json file.
status-held-r4.json adds offload.history_held; offload-dry-held-r4.json adds held_by_worktrees and
worktree_holders; offload-refused-r4.json and offload-dry-refused-r4.json are the exit-4
nothing_to_free refusal; prune-refused-worktree-r4.json has a worktree:<path> holder.
