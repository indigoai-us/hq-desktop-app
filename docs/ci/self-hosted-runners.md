# Self-hosted runners

Every job in `.github/workflows/` reads its `runs-on` from a repository Actions
variable. When the variable is unset, the job runs on the GitHub-hosted label
it used before this switch existed. Setting the variable moves every job that
reads it to a self-hosted pool. Job names do not change, so required check
names do not change either.

The form used in every workflow is:

```yaml
runs-on: ${{ fromJSON(vars.HQ_DESKTOP_RUNNER_LINUX || '"ubuntu-latest"') }}
```

`fromJSON` accepts either a JSON array of labels or a single JSON string, so
the variable can hold a label set or one hosted label.

## Variables

| Variable | Value to set (self-hosted labels) | Hosted default when unset | Jobs | Status on 2026-10-19 |
|---|---|---|---|---|
| `HQ_DESKTOP_RUNNER_LINUX` | `["self-hosted","linux","X64","indigo-x64"]` | `ubuntu-latest` | 31 jobs across every workflow | Org pool deployed. hq-desktop-app is not on the webhook allowlist yet. Leave unset. |
| `HQ_DESKTOP_RUNNER_LINUX_2204` | `["self-hosted","linux","X64","indigo-x64"]` | `ubuntu-22.04` | release.yml Linux AppImage build | Same pool. The pool image is Ubuntu 24.04, so the AppImage glibc floor rises unless the build moves into a 22.04 container first. Leave unset. |
| `HQ_DESKTOP_RUNNER_LINUX_ARM` | `["self-hosted","linux","ARM64","indigo-arm64"]` | none | No job uses it today | Reserved. |
| `HQ_DESKTOP_RUNNER_WINDOWS` | `["self-hosted","Windows","X64","hq-windows"]` | `windows-latest` | 18 jobs (windows-check, release, cache-warm, windows-cold-install, meet-native-artifacts) | No runner exists. Leave unset. |
| `HQ_DESKTOP_RUNNER_MACOS` | `["self-hosted","macOS","ARM64","hq-desktop"]` | `macos-latest` / `macos-14` | ci.yml Rust tests (macOS runner), cache-warm macOS jobs | No runner exists. Leave unset. |
| `HQ_DESKTOP_RUNNER_MACOS_RELEASE` | `["self-hosted","macOS","ARM64","hq-desktop-release"]` | `macos-14` | release.yml signing and notarization jobs | No runner exists. Leave unset until the notarization gate below passes. |

Each workflow repeats the variables it reads in a comment block above `on:`.

## Switching a variable

Only a repository admin sets these. Set one variable at a time and watch the
next run of each affected workflow before setting the next.

```bash
# Move Linux jobs to the org pool
gh variable set HQ_DESKTOP_RUNNER_LINUX -R indigoai-us/hq-desktop-app \
  --body '["self-hosted","linux","X64","indigo-x64"]'

# Revert to the hosted default
gh variable delete HQ_DESKTOP_RUNNER_LINUX -R indigoai-us/hq-desktop-app
```

An empty value also means "hosted default", because `''` is falsy in the
expression. Do not set a variable to a label set that has no online runner:
jobs then queue until they time out, and required checks stay pending.

### Before setting any `HQ_DESKTOP_RUNNER_*` variable

Every `pull_request` job that reads one of these variables must refuse a
self-hosted runner when the pull request comes from a fork. hq-desktop-app is
public, so anyone can open a fork PR, and without the guard that PR's code runs
on a persistent machine that keeps state, caches, and credentials between jobs.
The guard keeps fork PRs on the hosted default, for example by only reading
the variable when
`github.event.pull_request.head.repo.full_name == github.repository`.
The workflows do not have this guard yet. Add it to every affected job, and
review it, before any variable in the table above is set. This holds for every
platform, not only Linux.

### Before setting `HQ_DESKTOP_RUNNER_LINUX`

1. hq-desktop-app has to be added to `ORG_POOL_REPOSITORIES_DEFAULT` in
   `hq-github-runners` (`src/github-app.ts`). Until Infra's allowlist PR lands,
   the webhook ignores this repo's jobs and they never get a runner.
2. The org pools only admit private repositories. hq-desktop-app is public as
   of 2026-10-19, so either the repo becomes private or the admission rule
   changes. The Default runner group also has to allow the repo.
3. The pools refuse jobs whose pull request head is a fork. Add a same-repo
   guard (`github.event.pull_request.head.repo.full_name == github.repository`)
   to fork-reachable jobs before switching, or fork PRs will queue forever on
   required checks. This is a follow-up and is not in the workflows yet.
4. The pool image is a plain Ubuntu 24.04 server AMI. Jobs install their own
   toolchains with setup actions, but steps that run `sudo apt-get install`
   (Tauri system libraries, `msitools`) need either passwordless sudo for the
   `runner` user or those packages baked into the image.

## Required software

GitHub-hosted images ship most of this preinstalled. A self-hosted machine
needs it installed for the runner user.

### All platforms

- Git 2.40 or newer and `bash` on `PATH`.
- Node.js 22. Workflows call `actions/setup-node` with `node-version: 22`, which
  downloads into the tool cache, so the runner user needs write access to
  `RUNNER_TOOL_CACHE`.
- pnpm 10.33.0, pinned by `packageManager` in `package.json` and installed by
  `pnpm/action-setup`. Corepack also works.
- Rust stable through rustup, with `rustfmt` and `clippy` (see
  `rust-toolchain.toml`). Workflows add targets with
  `dtolnay/rust-toolchain`; rustup must be writable by the runner user.

### Linux (`indigo-x64`)

- Tauri build libraries, as installed by the release Linux job:
  `build-essential`, `pkg-config`, `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`,
  `libayatana-appindicator3-dev`, `librsvg2-dev`, `libxdo-dev`, `libssl-dev`,
  `patchelf`, `libfuse2`, `desktop-file-utils`, `xdg-utils`.
- `msitools` for the release job that inspects the Windows installer.

### macOS (`hq-desktop`, `hq-desktop-release`)

- Apple silicon, macOS 14 or newer.
- Xcode with command-line tools selected (`xcode-select -p`), matching the
  version the hosted `macos-14` image uses for release builds.
- Rust targets `aarch64-apple-darwin` and `x86_64-apple-darwin`.

### Windows (`hq-windows`)

- Visual Studio 2022 Build Tools with the "Desktop development with C++"
  workload (MSVC v143, Windows 11 SDK).
- Rust targets `x86_64-pc-windows-msvc` and `aarch64-pc-windows-msvc`.
- WebView2 runtime. Tauri downloads WiX and NSIS on first bundle; allow
  outbound HTTPS to GitHub releases or pre-seed them.
- PowerShell 7 (`pwsh`). Several steps set `shell: pwsh`.

## Runner user setup

- Run the runner service as a dedicated non-admin user that exists only for CI.
  Do not run it as a person's account.
- Prefer ephemeral runners (one job, then a fresh workspace). If a machine is
  reused, configure the runner with `--ephemeral` and re-register after each
  job, or clean `_work` between jobs.
- The runner user must not have a login keychain with real credentials in it.
  release.yml creates a temporary keychain under `$RUNNER_TEMP` and removes it
  in an `if: always()` cleanup step, along with the notarytool key file.
- `hq-desktop` and `hq-desktop-release` must be different machines. The
  release machine runs only release.yml, accepts no pull request jobs, and
  sits in a runner group restricted to this repository and to tag pushes.
- Keep the `hq-desktop` label distinct from the hq-cli macOS VM labels so jobs
  from the two repos never share a machine.

## Rust build cache

`Swatinem/rust-cache` restores `target/` from the GitHub Actions cache. On a
self-hosted runner that download costs more than a local incremental build, so
every rust-cache step is guarded with
`runner.environment == 'github-hosted'`. On an ephemeral self-hosted runner the
Rust build is therefore cold every time. If that is too slow, keep a persistent
`CARGO_TARGET_DIR` per runner (non-ephemeral machines only) or add `sccache`
with a local or S3 backend. cache-warm.yml is left unguarded because its only
purpose is to fill the hosted cache.

## Release on self-hosted macOS: notarization gate

release.yml stays on hosted `macos-14` until one self-hosted release run is
green and its output is verified notarized. To verify, set
`HQ_DESKTOP_RUNNER_MACOS_RELEASE` for a single prerelease tag, download the
produced `.app` and `.dmg`, and check all three on a separate Mac:

```bash
spctl -a -vv "HQ.app"                       # must say: accepted, source=Notarized Developer ID
xcrun stapler validate "HQ.dmg"             # must say: The validate action worked!
codesign --verify --deep --strict --verbose=2 "HQ.app"
```

If any check fails, delete the variable so the next release returns to hosted
`macos-14`, and do not publish that prerelease.

## Cost

Self-hosted minutes are not billed at hosted rates, but GitHub may charge a
platform fee of about $0.002 per self-hosted minute. The instances themselves
are billed by AWS (Linux) or are owned hardware (macOS, Windows).

<!-- CI canary for #1726, throwaway, will be closed -->
