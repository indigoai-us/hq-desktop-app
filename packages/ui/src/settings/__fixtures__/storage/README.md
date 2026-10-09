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
