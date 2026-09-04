# HQ install matrix

Automated, unattended fresh-machine install tests. Every cell boots a disposable
Tart macOS VM from a provably-bare snapshot, shapes the machine with a profile,
runs one journey, and returns a machine-readable result. The nightly run
aggregates all cells into one report.

Why this exists: nobody had ever seen every HQ dependency install successfully
on a fresh Mac, and nothing could reproduce that unattended — the wizard's
Cognito sign-in wall meant every VM test was a human clicking. The desktop app
now has a headless mode (`HQ_HEADLESS_INSTALL_DEPS=<out.json>`) that runs the
exact `install_deps` engine the wizard runs, so the matrix drives the real code.

## Run it

```bash
# one cell (≈3–20 min)
bash workspace/e2e-mac/matrix/run-cell.sh sonoma-consumer bare full-fresh-install

# the nightly set (cells.txt), 2 VMs at a time, artifacts rebuilt first
bash workspace/e2e-mac/matrix/run-matrix.sh --nightly

# a custom subset
bash workspace/e2e-mac/matrix/run-matrix.sh --cell tahoe-consumer:bare:probe-machine --cell sonoma-consumer:path-polluted:desktop-deps-headless
```

Flags: `--headed` (visible VM window — required whenever a human must sign in),
`--keep` (leave the VM running for inspection).

Results: `runs/<run-id>/summary.md` + `summary.json`, per-cell
`runs/<run-id>/cells/<cell>/{result.json,journey.log,guest/…,inventory-before.json,inventory-after.json}`.
`runs/latest` points at the newest run. Nightly runs also copy the report to
`workspace/e2e-mac/reports/<run-id>-install-matrix/REPORT.md`.

## The three axes

| Axis | Values | Where |
|---|---|---|
| image | `sonoma-consumer` `tahoe-consumer` `sequoia-consumer` `sonoma-configured` | `lib.sh: image_snapshot` — maps to baked Tart snapshots |
| profile | `bare` `stale-toolchain` `path-polluted` `bash-default-shell` `no-github-api` `low-disk` `nonadmin-user` `readonly-install-root` `foreign-npm-global` `eacces-npm-global` `corporate-npmrc` `c-locale` `dirty-hq-dir` | `guest/profiles/<name>.sh` — runs in the guest BEFORE the journey |
| journey | `probe-machine` `desktop-deps-headless` `setup-sh` `full-fresh-install` `wizard-resume-headed` | `guest/journeys/<name>/run.sh` — runs in the guest, writes `result.json` |

A cell is `image:profile:journey`. `cells.txt` is the nightly list.

Add an image: bake a snapshot (see `../bake-consumer-mac-*.sh`; the consumer
bake strips brew/CLT/node and hard-gates bareness with a full-disk find), then
add a line to `image_snapshot`/`image_bake_hint` in `lib.sh`.
Add a profile: a guest shell script that mutates the machine; keep it idempotent.
Add a journey: a guest script that sources `common.sh`, calls `check`/`run_check`,
and ends with `result_write 0`. The host never parses stdout — only `result.json`.

## Two ways to exercise the installer, and why both run

- `desktop-deps-headless` runs the dependency engine through the hidden
  `HQ_HEADLESS_INSTALL_DEPS` mode: fast, no window, exact same engine code.
- `wizard-resume-headed` runs the **real onboarding wizard** in a headed VM:
  the app's own Svelte stage runner, install manifest, retries, settings
  wiring, git-init, packages, indexing. Sign-in is the wizard's first screen and
  hands off to Google/Microsoft in the system browser (not scriptable), so the
  journey uses the product's own resume path: it seeds a signed-in E2E test
  session (`~/.hq/cognito-tokens.json`, minted on the host from the Cognito
  E2E user, no cloud creds) and an in-progress `~/.hq/install-manifest.json`,
  and the wizard opens on the setup stage and runs everything itself. Results
  are read from the manifest the wizard writes, with screenshots every 15 s.
  The first headed run caught a bug the hidden mode could not (git-init using
  the Xcode stub git) — that is why both stay in the nightly.

## Where the profiles come from

Each profile is a real incident, not a guess (sources: `companies/indigo/knowledge/playbook-research/themes/onboarding-friction.md`,
Sentry-derived fixes in hq-desktop-app, hq-installer PRs, the July 2026 VM report):

| profile | incident |
|---|---|
| `nonadmin-user` | standard (non-admin) account hard-blocked the install (hq-installer#78) — journey runs as user `tester` |
| `readonly-install-root` | `forbidden path` dead-ends on a non-writable `~/hq` (hq-installer#93) |
| `foreign-npm-global` | half-migrated developer Macs with a self-configured npm prefix holding broken shims (Sentry HQ-DESKTOP-5B/5C/5E) |
| `eacces-npm-global` | npm prefix pointing at a root-owned dir → EACCES (Sentry HQ-DESKTOP-3Y) |
| `corporate-npmrc` | corporate npm mirror without HQ packages → E404 (Sentry HQ-DESKTOP-5Q) |
| `c-locale` | no UTF-8 locale (launchd/hooks/agent shells); setup.sh once died here |
| `dirty-hq-dir` | pre-existing `~/hq` with a stray worktree + dirty tree wedged a user (INS-0356) |
| `stale-toolchain` | HQ's own half-finished install left behind |
| `path-polluted` | old node from a version manager on PATH (hq-installer#32, Sentry HQ-DESKTOP-56) |
| `low-disk` | ENOSPC reported as a defect (Sentry HQ-DESKTOP-53, INS-0237) |
| `no-github-api` | corporate egress / rate-limit stand-in |

The `wizard-resume-headed` journey also re-checks `.claude/settings.json` 75 s after the wizard finishes, for the first-cloud-sync PATH clobber (July 2026 report).

Not representable in Tart on Apple Silicon: Intel/Rosetta, MDM/Jamf-managed Macs, iCloud Desktop sync, Windows (covered by hq-desktop-app's own Windows CI).

## Artifacts

`stage-artifacts.sh` builds and stages into `artifacts/` (pushed to every VM):

- `hq-sync-menubar` — desktop app release binary with the headless install
  mode. Built from `repos/private/hq-desktop-app` (or `--desktop-worktree`).
- `hq-tree.tar.gz` — minimal HQ tree so `core/scripts/setup.sh` can run.
- `HQ.app.tgz` — the full ad-hoc-signed app bundle for the headed wizard journey.
- `cognito-tokens.json` — a 1-hour signed-in session for the E2E test user
  (`alice-e2e@getindigo.ai`, Cognito public client, no AWS credentials needed).
  `artifacts/` is git-ignored; it only ever goes into disposable VMs.

## Concurrency, disk, cleanup

- Apple Virtualization allows **2 running macOS VMs per host**. `lib.sh`
  encodes that as slot leases (`/tmp/hq-tart-matrix-slots`); a third cell waits.
- Every cell has `trap … EXIT` teardown. If something still leaks,
  `sweep-orphans.sh` lists disposable VMs; `--yes` deletes them (base snapshots
  are never touched). Each clone is ~25 GB — sweep before you run out of disk.
- Per-run state lives under `runs/<run-id>/`; there is no global state file.

## Schedule

`schedule/install.sh` loads a LaunchAgent that runs `run-matrix.sh --nightly`
at 03:30. `schedule/install.sh --remove` unloads it. Set `HQ_MATRIX_NOTIFY_CMD`
(e.g. `hq dm …`) to get the summary pushed somewhere when a nightly finishes.
The host must be awake (`caffeinate -s` or the existing keepawake agent).

## What is deliberately out of scope here

- Anything past the wizard's sign-in (Cognito/Google) — that needs `--headed`
  and a human. The dependency engine, PATH wiring, qmd indexing, git TLS, and
  setup.sh are all covered unattended.
- TCC permission grants (microphone etc.) — `tccd` ignores edits in a VM.
- Intel Macs, Linux, Windows — Tart is Apple-Silicon only. Windows lives in the
  desktop app's own CI; Intel is covered by GitHub-hosted runners only.
