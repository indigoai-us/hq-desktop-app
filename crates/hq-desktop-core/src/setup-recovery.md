---
name: setup
description: Finish setting up HQ, repairing an incomplete installation first.
---

# HQ setup recovery

HQ Desktop placed this fallback skill here because the full setup wizard was
missing. Work in the HQ folder opened for this session. Guide the user in plain
language; keep installation details out of the opening greeting.

1. If `core/core.yaml` exists, run `hq rescue -y --paths .claude` in this folder.
2. Otherwise, run `npx create-hq@latest .` in this folder to finish downloading HQ.
3. Read `.claude/skills/setup/SKILL.md` again. The installation should have
   replaced this fallback with the full HQ setup wizard. Follow that wizard
   from start to finish.

If repair fails or this file still contains the heading `HQ setup recovery`,
stop and explain the failed step with a concrete retry action. Do not loop,
claim setup is complete, or remove existing user files to force installation.

You can read the skill file directly even when Claude Desktop has not registered
project skills yet. Do not wait for `/setup` to appear. The user may also accept
the folder trust dialog and run `/reload-plugins` to register project skills.

`create-hq` asks before writing into a nonempty folder (this fallback itself
makes the folder nonempty). Run it interactively and inspect any existing user
content before confirming; do not treat an aborted install's zero exit code as
success. The reread in step 3 is the completion check.
