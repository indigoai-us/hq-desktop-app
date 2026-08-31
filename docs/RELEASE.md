# HQ Release Process

This repository releases the unified `HQ` Tauri app from `apps/sync`.

The release workflow builds a macOS universal app/DMG, Windows MSI and NSIS
installers for x64 and ARM64, Tauri updater artifacts, `latest.json`, and a
GitHub Release. Verified production runs sign, notarize, and staple the macOS
artifacts and apply Azure Trusted Signing to both Windows architectures. The
ARM64 bundle uses a checksum-verified native ARM64 Node runtime for the Recall
SEA launcher; Recall's separate x64 agent runs through Windows on ARM's x64
emulation.

The updater manifests point at version-pinned GitHub Release assets. Stable,
beta, and alpha share one trust root and artifact contract, but their release
selection is isolated so a prerelease cannot replace stable latest.

## Install Window (macOS DMG)

The disk image is styled: `apps/sync/scripts/create-dmg.sh` builds it from the
layout in `apps/sync/scripts/dmg/`.

| File | What it is |
|---|---|
| `dmg/settings.py` | Window geometry, icon size, icon coordinates, volume icon — the dmgbuild spec |
| `dmg/background.html` | Source artwork, implementing Figma "Installer" node `3133:57` |
| `dmg/background.tiff` | The committed render, `@1x` + `@2x` in one file |
| `dmg/render-background.sh` | Re-renders the TIFF from the HTML |

Change the artwork by editing `background.html`, then:

```bash
bash apps/sync/scripts/dmg/render-background.sh
```

and commit the regenerated `background.tiff`. It needs Google Chrome and a
network connection; the page pulls Fraunces and Geist from Google Fonts.

**Do not reintroduce Finder/AppleScript styling.** The usual recipe tells
Finder to open the volume and arrange the icons, which needs a logged-in GUI
session — a headless release runner has none, so it passes locally and fails in
CI. dmgbuild writes the `.DS_Store` directly and never talks to Finder.
`scripts/dmg-layout-contract.test.ts` fails the build if `osascript` or a
`tell application "Finder"` reappears in the packaging path, if the layout
drifts from the coordinates the artwork was drawn for, or if the background
loses either representation.

## Cut a Release

Push a tag. That is the whole release:

```bash
git tag -a vX.Y.Z -m "HQ vX.Y.Z"
git push origin vX.Y.Z
```

Supported tag forms are `vX.Y.Z`, `vX.Y.Z-beta.N`, and `vX.Y.Z-alpha.N`.

## Release Tag Cooldown

Because the tag *is* the release, a `git push` of a `v*` tag starts a macOS
universal build plus Windows x64 and ARM64 builds on GitHub-hosted runners.
GitHub bills macOS minutes at 10x and Windows minutes at 2x a Linux minute, so
each tag push spends a meaningful amount of money, and a burst of tags spends
it repeatedly on builds nobody installs.

A `pre-push` hook at `.githooks/pre-push` therefore enforces two rules:

- **One release at a time.** A `v*` tag is refused when another release went
  out within the last **6 hours**.
- **One release per push.** `git push origin v1.2.3 v1.2.4` is refused
  outright; git runs the hook once for the whole push, so a single cooldown
  check would otherwise clear two builds at once.

What the hook ignores: branch pushes, tag deletions, and any tag that is not
`v*` — the Release workflow triggers on `v*` alone, so a tag like `docs-2026`
starts no build and neither spends nor is blocked by the cooldown.

The hook classifies on the **destination** ref, so `git push origin
HEAD:refs/tags/v1.2.3` is paced exactly like `git push origin v1.2.3`.

"When did a release last go out" is the newer of two signals: a marker this
clone writes on each release push, and the creation date of the newest `v*` tag
it can see. The second is what protects a fresh clone, and what stops a clone
with a stale marker from releasing again right after fetching a teammate's
ten-minute-old tag.

The marker is kept **per destination**, so pushing a tag to a personal fork or
a local mirror does not spend the cooldown that protects `origin`. The tag-date
signal is deliberately not scoped that way: a release tag created minutes ago
means a billed build is probably already running, and the hook cannot tell a
harmless bare mirror from a fork that would build it, so it errs toward
blocking.

The hook installs itself: `pnpm install` runs the root `prepare` script, which
runs `scripts/install-git-hooks.mjs`. That script sets `core.hooksPath` to
`.githooks` only when no custom hooks path is already configured — if your
clone points `core.hooksPath` somewhere else, it says so and leaves your setup
alone rather than silently disabling your other hooks. In an existing clone you
can also run it by hand:

```bash
git config core.hooksPath .githooks
```

If a release is genuinely urgent and you accept the build cost, bypass the
cooldown explicitly rather than disabling hooks wholesale:

```bash
HQ_ALLOW_TAG_PUSH=1 git push origin vX.Y.Z
```

A bypassed release still resets the cooldown for the next push — it started a
real build, so the window has to move with it.

`HQ_TAG_PUSH_COOLDOWN_SECONDS` overrides the window length. Behaviour is
covered by `scripts/pre-push-tag-cooldown.test.ts`.

Where you tag depends on the channel:

- **Stable** (`vX.Y.Z`) must be cut from `main` — its commit has to be merged
  before you tag it.
- **beta / alpha** (`-beta.N` / `-alpha.N`) are testing builds and may **only**
  be cut from a non-`main` branch. Tagging a prerelease on a commit that is
  already merged into `main` is rejected; promote it to a stable `vX.Y.Z` tag
  instead. Prerelease releases never stamp their version back to `main`.

There is no version bump to make first and no release pull request. The tag is
the single source of truth for the version: the `validate` job stamps
`[product].version` in `versions.toml` and the four files generated from it —
`apps/sync/package.json`, `apps/sync/src-tauri/tauri.conf.json`,
`apps/sync/src-tauri/Cargo.toml`, and the `hq-sync-menubar` entry in
`apps/sync/src-tauri/Cargo.lock` — then publishes those exact bytes as an
artifact that both platform builds apply before bundling. After the release is
public, the `sync-version` job pushes a `chore(release)` commit with the same
stamp to `main`.

Two consequences worth knowing:

- The tag itself points at a commit whose `versions.toml` still shows the
  *previous* version. The published artifacts carry the tag's version, and
  `main` converges immediately afterwards.
- Re-running an older tag will not drag `main` backwards —
  `scripts/release-version-order.mjs` skips the sync when `main` is already at
  or ahead of the released version. Prerelease (`-beta.N` / `-alpha.N`) releases
  never run the sync at all, so they never touch `main`.

For a **stable** release the workflow requires the tag commit to be contained in
`main`; a **prerelease** requires the opposite — its commit must not be on
`main`. This branch check runs only when a tag is first pushed, so a
`workflow_dispatch` retry of an existing tag is never re-gated. Never move a
pushed tag after a failed release; fix the release path and cut a fresh SemVer
tag.

## Desktop shell guard

The V2 chat shell was developed in this repo and now lives in
`indigoai-us/hq-work-mono`. Between v0.10.106 and v0.10.116 it reached stable
users nine times (106, 108, and every release from 110 to 116), every time
because a tag was cut from a `main` tip that still carried it — the branch
policy above cannot catch that, because such a tag is legitimately contained
in `main`.

The `validate` job therefore inspects the tag's own tree and fails the release
if `apps/sync/src/desktop-alt/chat/` exists, or if any path listed in
`scripts/release-required-surfaces.txt` is absent. If you are deliberately
shipping a new desktop shell from this repo, update that step and
`scripts/release-workflow.test.ts` in the same change — do not bypass it.

### The required-surfaces manifest

Checking only for the presence of the v1 sidebars proved too narrow. The
revert that removed the V2 shell (#454) reset the whole
`apps/sync/src/desktop-alt` tree to its v0.10.109 shape and silently took the
"Finish setting up HQ" card (#432) with it. Nothing failed — a whole-tree
revert deletes a surface's tests along with the surface, so the suite stayed
green — and unfinished installs rendered a blank Home in every release from
v0.10.114 to v0.10.150 before anyone noticed (#525).

`scripts/release-required-surfaces.txt` is the fix: one repo-relative path per
line, `#` comments allowed. The release guard asserts every entry exists in
the tag's tree, and `scripts/release-workflow.test.ts` asserts every entry
exists in the working tree — so a stale line fails in an ordinary PR run
rather than at release time.

**Add a line when you ship a surface that would be silently lost if someone
reset its directory to an older tree.** Removing a surface on purpose means
deleting its line in the same change; that keeps the removal a visible
decision instead of a quiet regression.

The guard fails closed when the manifest itself is missing. A `workflow_dispatch`
retry of a tag cut before the manifest landed will therefore fail — cut a fresh
tag rather than working around the check.

Unlike the branch policy, this guard also applies to `workflow_dispatch`
retries: a retry re-publishes that tag's artifacts to stable, so retrying any
of v0.10.106–v0.10.116 would put the V2 shell back in front of users. Those
retries fail by design.

`pnpm version:app` and `pnpm version:check` remain available for local work —
`pnpm version:app --set-version X.Y.Z` is exactly what CI runs.

`workflow_dispatch` accepts an existing tag for a retry. It builds the immutable
tag contents while loading the reviewed publication helpers from the workflow
commit. If that tag is already public and healthy, the retry is read-only:
release creation/reset, asset deletion/upload, and publication are all skipped.

## Stable release lineage

A stable tag may publish only when its commit *contains* the commit of the
current public latest stable release. Two gates enforce this on the stable
channel, at both the validate step and the in-publication-lock revalidation
step:

- **Numeric order** (`release-stable-order.mjs stable-order`) rejects a tag
  whose version number is lower than public latest.
- **Commit lineage** (`release-stable-order.mjs lineage`) rejects a tag whose
  *commit* is behind or diverged from public latest even when its number is
  higher. It reads the GitHub compare status between public latest and the tag:
  `ahead` and `identical` publish exactly as before; `behind` and `diverged` are
  blocked.

The lineage gate exists because a higher version number can still carry strictly
older code. v0.10.107 and v0.10.109 were both tagged on the pre-fix v0.10.105
commit, so the numeric gate saw a normal advance while the stable fleet was
moved back onto pre-fix builds. The lineage gate closes that gap.

### Intentional rollbacks

An emergency rollback is still possible without a workflow or code change. Tag
the **older commit whose code you want back on stable**, and give the tag a
`Rollback-Of:` trailer naming the exact current public latest stable tag. Name
that commit explicitly: tagging without a commit argument tags your current
`HEAD`, which would republish current code instead of rolling back.

```text
# <rollback-commit> is the commit whose code you want back on stable.
git tag -a vX.Y.Z <rollback-commit> -m "HQ vX.Y.Z emergency rollback

Rollback-Of: vA.B.C"
git push origin vX.Y.Z
```

The `Rollback-Of: vX.Y.Z` line must sit in the tag message's trailer block (its
last paragraph) and name the current public latest stable tag exactly — a stale
or copied trailer, a `Rollback-Of:` line buried in the body, or a lightweight
tag (one with no annotated message) all fail closed. A declared rollback still
publishes, but never silently: the release log carries a warning and the job
summary enumerates the withdrawn commits. A rollback
**drops every fix the named release contains** but the rolled-back commit does
not, so confirm you intend to lose those fixes before you tag it.

## Required GitHub Secrets

### macOS Signing and Notarization

- `APPLE_CERTIFICATE`: base64-encoded Developer ID Application `.p12`.
- `APPLE_CERTIFICATE_PASSWORD`: password for the `.p12`.
- `APPLE_SIGNING_IDENTITY`: full identity string, for example `Developer ID Application: NAME (TEAMID)`.
- `APPLE_TEAM_ID`: the Apple Developer Team ID.
- `APPLE_API_KEY_ID`: App Store Connect API key ID (notarization).
- `APPLE_API_ISSUER_ID`: App Store Connect API issuer ID (notarization).
- `APPLE_API_PRIVATE_KEY`: contents of the App Store Connect API `.p8` private key.

Signing and notarization run under the **Indigo AI, Inc.** organization team
(`HWFZ2QDTMR`). The `.p12` bundles the leaf certificate, the Apple Developer ID
G2 intermediate, and the private key.

Notarization uses the **App Store Connect API-key method**
(`xcrun notarytool --key/--key-id/--issuer`). The workflow writes the `.p8` to a
`chmod 600` file under `$RUNNER_TEMP` and removes it on exit. The older Apple-ID
method (`--apple-id/--password/--team-id`) is deliberately **not** used, because
it requires an individual's Apple account and an app-specific password to sit in
the release path. `APPLE_ID` and `APPLE_PASSWORD` are no longer read by this
workflow.

Background and the full account-migration record:
`companies/indigo/knowledge/engineering/apple-account-migration.md` in HQ.

### Tauri updater channels

HQ ships one updater trust root for all platforms: a single signing key and
public key. Both `apps/sync/src-tauri/tauri.conf.json` (macOS) and
`apps/sync/src-tauri/tauri.windows.conf.json` (Windows) carry the same pubkey
(`9DE1695B…`, the existing `hq-sync` key).

- Stable polls
  `https://github.com/indigoai-us/hq-desktop-app/releases/latest/download/latest.json`.
- Beta and alpha resolve the highest eligible public release for their channel,
  then read that tag's
  `https://github.com/indigoai-us/hq-desktop-app/releases/download/<tag>/latest.json`.

- `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: the single private key matching that pubkey (the `hq-sync` macOS updater key — set it once; the macOS and Windows jobs both use it).

Each release publishes one `latest.json` covering `darwin-aarch64`,
`darwin-x86_64`, `windows-x86_64`, and `windows-aarch64`, signed with that one
key. Stable releases use `make_latest=true`; beta and alpha use
`make_latest=false`, so GitHub's `/releases/latest/` alias remains stable.

### Versionless download aliases

Alongside the version-stamped assets, each release also publishes versionless copies for stable, marketing-friendly download links (the hq-installer pattern):

- `HQ.dmg`, `HQ_x64-setup.exe`, `HQ_arm64-setup.exe` → e.g. `https://github.com/indigoai-us/hq-desktop-app/releases/latest/download/HQ.dmg`

(The auto-updater itself uses `latest.json` with the versioned URLs; these aliases are for direct human downloads.)

### Build-Time Telemetry

- `VITE_SENTRY_DSN`: Svelte/Vite Sentry DSN inlined into the web bundle.
- `HQ_SYNC_SENTRY_DSN`: Rust Sentry DSN read by `apps/sync/src-tauri/build.rs`.
- `SENTRY_AUTH_TOKEN`: an org-scoped Sentry token with `project:write` access
  to `indigo-d0/hq-desktop`. The release workflow uses it only to upload
  native debug files without source content. This token is required for
  server-side symbolication. Without it, the release still builds, but the job
  summary names the debug id that was not uploaded.

No Cognito `VITE_*` secrets are required by the current unified app. Grepping the app shows only `VITE_SENTRY_DSN` is read by frontend release code.

### Native debug-file contract

Each release build creates the native files that Sentry needs to resolve a
crash:

- macOS: the universal `HQ.app` and its adjacent `HQ.app.dSYM`.
- Windows: `hq-sync-menubar.exe` and the adjacent
  `hq_sync_menubar.pdb`, for both x64 and ARM64.

On macOS the shipped binary is stripped — `strip = "symbols"` in
`[profile.release]` plus an explicit `xcrun strip -S -x` in the release job as a
belt-and-suspenders — so it carries no debug info. Because a stripped binary can
no longer be re-processed by `dsymutil`, the workflow builds `HQ.app.dSYM` from
the packed per-arch dSYMs that `split-debuginfo = "packed"` emits at link time
(`lipo`-combining the two arch DWARFs into one universal sidecar; each packed
dSYM is a symlink into `deps/` whose inner DWARF is named after the crate, so it
is resolved by glob). The binary's `LC_UUID` debug id survives strip, so the app
binary and the sidecar dSYM still share the same debug id set.

**Size budgets.** The macOS `.app` legitimately bundles the ~150 MB Recall SDK
sidecar (`Contents/Resources/recall-sdk-bridge`) on top of the ~80 MB universal
binary, so the total bundle is ~230 MB — an earlier 15 MB total-bundle budget
was never satisfiable and blocked every release once it was added. The verify
step instead budgets the **stripped app binary** at 120 MB (a healthy universal
binary is ~80 MB; this catches native-symbol / code bloat, which is what a size
guard should catch) and keeps a coarse 300 MB total-bundle ceiling to catch
runaway resource growth.

The workflow verifies each executable and debug-file pair with `sentry-cli
difutil check` before upload. Sentry is the only retention path. The upload uses
`--no-sources`, and `.pdb` and `.dSYM` files are never published as GitHub
Release assets or GitHub Actions workflow artifacts.

If `SENTRY_AUTH_TOKEN` is missing or Sentry rejects it, the workflow adds a
warning to the log and job summary. The release still succeeds, but that build
has no recoverable symbols. After a successful upload, the workflow queries the
Sentry project's debug-file listing for every verified debug id and fails if a
matching record is missing.

To verify a release manually, list the debug files in `indigo-d0/hq-desktop`
and compare each returned debug id with the id printed by the build's debug-file
contract step.

## Required GitHub Repository Variables

`RELEASE_UNVERIFIED` controls platform trust signing. It defaults to `true`:
macOS is ad-hoc signed, Apple notarization is skipped, and Azure Authenticode is
skipped, while Tauri updater signatures are still generated. Set it to `false`
for a verified production release.

Windows signing uses Azure Trusted Signing through GitHub OIDC. Configure these repository variables:

- `AZURE_CLIENT_ID`
- `AZURE_TENANT_ID`
- `AZURE_SUBSCRIPTION_ID`

The workflow signs with:

- endpoint: `https://eus.codesigning.azure.net/`
- signing account: `indigosigning`
- certificate profile: `indigo-codesign`

## Azure Trusted Signing Setup

The Windows job is bound to the GitHub Actions `release` environment so the OIDC subject is stable for both tag pushes and manual dispatches.

Add a federated credential to the Azure identity referenced by `AZURE_CLIENT_ID` that trusts this repository and environment:

```text
repo:indigoai-us/hq-desktop-app:environment:release
```

The identity must have access to the `indigosigning` Trusted Signing account and the `indigo-codesign` certificate profile in the subscription configured by `AZURE_SUBSCRIPTION_ID`.

If `AZURE_CLIENT_ID` is not set, or `RELEASE_UNVERIFIED` is not `false`, the
Azure login and Trusted Signing steps are skipped. Verified production releases
must set `RELEASE_UNVERIFIED=false` and configure the Azure variables so the MSI
and NSIS installers are Authenticode-signed. The workflow regenerates each
Tauri updater `.sig` after Authenticode signing because signing mutates the
installer bytes.

## Windows prerelease versions

WiX/MSI `ProductVersion` accepts only three numeric fields. For
`X.Y.Z-beta.N` and `X.Y.Z-alpha.N`, `scripts/windows-msi-version.mjs` generates
a final Tauri config overlay containing numeric `X.Y.Z`. Full SemVer remains on
the app, NSIS installer, updater manifest, tag, and artifact names.

Windows Installer cannot order two prereleases that share the same `X.Y.Z`
MSI version. The SemVer-aware NSIS updater is the supported automatic update
path; a manual MSI install can replace another same-base MSI in either
direction.

## Atomic publication and retries

The publish job is globally serialized across release tags. It:

1. Rejects a stable rollback before native builds and rechecks stable order
   immediately before publication.
2. Creates or resets a hidden draft and uploads the complete 15-asset set.
3. Verifies the exact names, upload state, byte sizes, SHA-256 digests,
   updater-platform URLs, and detached signature sidecars.
4. Makes the release public with one final PATCH only after the draft passes.
5. Confirms the public asset/manifest contract and verifies that prereleases
   did not replace stable latest.

An already-published healthy tag is accepted as a read-only rerun success.
Signed, notarized, and timestamped rebuilds are not byte-deterministic, so the
rerun validates the existing public release rather than overwriting its assets.
The control-plane helpers are `scripts/release-asset-contract.mjs` and
`scripts/release-stable-order.mjs`.

## Artifact Shape

The publish job attaches these assets to the GitHub Release:

- `HQ_<version>_universal.dmg`
- `HQ_<version>_universal.app.tar.gz`
- `HQ_<version>_universal.app.tar.gz.sig`
- `HQ_<version>_x64.msi`
- `HQ_<version>_x64.msi.sig` if Tauri emits an MSI updater signature
- `HQ_<version>_x64-setup.exe`
- `HQ_<version>_x64-setup.exe.sig`
- `HQ_<version>_arm64.msi`
- `HQ_<version>_arm64.msi.sig` if Tauri emits an MSI updater signature
- `HQ_<version>_arm64-setup.exe`
- `HQ_<version>_arm64-setup.exe.sig`
- `latest.json`

`latest.json` contains four updater platform entries:

- `darwin-aarch64`
- `darwin-x86_64`
- `windows-x86_64`
- `windows-aarch64`

Both macOS entries point at the universal `HQ.app.tar.gz` updater archive.
