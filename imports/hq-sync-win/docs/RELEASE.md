# Releasing hq-sync-win

End-to-end release process for the Windows fork, plus the rotation runbooks for
the two independent signing keys involved:

| Key material | Purpose | Where the secret lives | Where the public half lives |
|--------------|---------|------------------------|------------------------------|
| **Updater keypair** (minisign) | Signs `latest.json` + the `.msi.zip` so an installed app can verify an update came from us | `TAURI_SIGNING_PRIVATE_KEY` + `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (GitHub Actions secrets) | `plugins.updater.pubkey` in `src-tauri/tauri.conf.json` |
| **Code-signing cert** (Authenticode PFX) | Signs the `.exe` / `.msi` so Windows SmartScreen trusts the installer | `WINDOWS_SIGNING_CERT` (base64 PFX) + `WINDOWS_SIGNING_CERT_PASSWORD` | embedded in the signed binaries |

These are **separate** keys with separate rotation cycles. See
[`code-signing-windows.md`](./code-signing-windows.md) for cert details.

---

## 1. Cut a release

1. Bump the version triple in lockstep (owned by the version-bump story; keep
   `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json` equal).
2. Commit, then tag: `git tag v0.4.0 && git push origin v0.4.0`.
3. `.github/workflows/release.yml` runs on the tag:
   - `npm ci` → `npm run tauri build --target x86_64-pc-windows-msvc --bundles msi nsis updater`
   - the build is signed with the **updater** key (env `TAURI_SIGNING_PRIVATE_KEY`),
     producing `*.msi.zip` + `*.msi.zip.sig`
   - the **SignTool** step Authenticode-signs **both** the `.msi` and the `.exe`
     (guarded by `if: env.WINDOWS_SIGNING_CERT != ''` — unsigned dogfood builds
     skip it cleanly)
   - the `release` job publishes a GitHub release with the artifacts + `latest.json`
4. Installed apps poll `plugins.updater.endpoints`
   (`…/releases/latest/download/latest.json`), verify its signature against the
   embedded `pubkey`, download, and apply.

### Verify the updater end-to-end

- `signtool verify /pa /v <installer>.exe` → signature valid, not expired.
- Install an older build, publish a newer release, confirm the popover footer
  shows the new version after the app relaunches.
- `latest.json` must carry a `signature` field that verifies against the
  `pubkey` currently in `tauri.conf.json` (mismatched key ⇒ silent no-update).

---

## 1a. Recall SDK sidecar packaging (US-012)

The app ships the Recall Desktop SDK as a Tauri **sidecar** (the same pattern
as macOS) so it can detect meetings and record calls. This is the trickiest
part of the Windows bundle because the SDK is a **Node application with native
dependencies** — it cannot be compiled into a single self-contained exe.

### What ships, and why

`@recallai/desktop-sdk` is a Node library. At runtime our bridge
(`sidecar/recall-sdk-bridge/bridge.mjs`) `require()`s it; the SDK
(`index.js`) then spawns its native engine **`agent-windows.exe`** and loads a
full media stack sitting next to it:

- **`agent-windows.exe`** — the real PE32+ recording engine (~6.6 MB).
- **FFmpeg DLLs** — `avcodec-60`, `avformat-60`, `avutil-58`, `swresample-4`,
  `libx264-157`, …
- **GStreamer DLLs + plugins** — `gstreamer-1.0-0.dll`, `gst*-1.0-0.dll`, and
  the `gstreamer-1.0/` plugin directory (the SDK points `GST_PLUGIN_PATH` at
  it, relative to `agent-windows.exe`).
- **cairo / freetype / glib / harfbuzz / pango / pixman** and the MSVC runtime
  (`msvcp140.dll`, `vcruntime140*.dll`).

Total ≈ **98 MB**. This whole tree is the Windows analogue of macOS's
`GStreamer.framework`. It is **confirmed present**: `npm install` in
`sidecar/recall-sdk-bridge/` runs the package's `setup.js`, which — for
`process.platform === 'win32'` — downloads `desktop_sdk_win32.tar` and extracts
the runtime into `node_modules/@recallai/desktop-sdk/`. No separate framework
download or signing dance is required (contrast macOS, §"macOS-only release
fixes" below).

### The two bundle pieces

| Piece | Produced by | Wired via | Lands at (install dir) |
|-------|-------------|-----------|------------------------|
| **Launcher** `recall-desktop-sdk-<triple>.exe` | `sidecar/recall-sdk-bridge/build.mjs` → `src-tauri/binaries/` | `bundle.externalBin: ["binaries/recall-desktop-sdk"]` | next to `HQ Sync.exe` |
| **Runtime payload** (`bridge.mjs`, `recording-tracker.mjs`, `package.json`, `node_modules/**`) | `npm install` (setup.js) | `bundle.resources` → `recall-sdk-bridge/…` | `<install>/recall-sdk-bridge/…` |

**Why a launcher at all?** The Rust process manager
(`src-tauri/src/commands/process.rs`) spawns the sidecar with a **direct
`CreateProcess`** (`CREATE_NO_WINDOW`, no shell). Tauri's `externalBin` must be
a real PE executable — a `.cmd`/`.bat` shim could not be launched that way, and
macOS's bash-wrapper trick has no Windows equivalent. So the launcher is built
as a **Node Single Executable Application (SEA)**: a copy of `node.exe` with
`launcher-bootstrap.cjs` injected (via `postject`, a sidecar devDependency).
It is fully self-contained — **end users do not need Node installed**.

At runtime the launcher finds `recall-sdk-bridge/bridge.mjs` next to itself and
`import()`s it **in-process** under its own embedded Node runtime. Because
`bridge.mjs` loads from a real on-disk path, its `require("@recallai/desktop-sdk")`
resolves through the `node_modules/` tree shipped alongside it via
`bundle.resources`. The launcher name (`recall-desktop-sdk-x86_64-pc-windows-msvc.exe`)
is exactly what `recall_sdk.rs::find_sdk_binary` looks for adjacent to the app
exe; if it is missing the Rust side logs `RECALL_SDK_UNAVAILABLE` and the app
continues normally.

### Build it locally

```powershell
# from the repo root
npm ci --prefix sidecar/recall-sdk-bridge   # installs the SDK runtime + postject
node sidecar/recall-sdk-bridge/build.mjs    # produces src-tauri/binaries/recall-desktop-sdk-x86_64-pc-windows-msvc.exe
```

`build.mjs` is **idempotent** (skips an existing launcher unless you pass
`--force`) and is also chained into `tauri.conf.json`'s `beforeBuildCommand`,
so a plain `npm run tauri build` produces the launcher automatically before
bundling — the `externalBin` requirement can never fail a clean build. The
launcher is a ~80 MB build artifact and is **gitignored**
(`src-tauri/binaries/*.exe`); the runtime payload is gitignored via the
existing `node_modules/` rule. Neither is committed; both are rebuilt each
release.

### CI (release.yml)

For tagged releases, `release.yml` (Windows build job):

1. `npm ci` (app deps).
2. **Build Recall SDK sidecar** — `npm ci --prefix sidecar/recall-sdk-bridge`
   (installs `@recallai/desktop-sdk` + its win32 runtime + `postject`) then
   `node sidecar/recall-sdk-bridge/build.mjs`, with `RECALL_SIDECAR_TARGET` set
   to the matrix triple so the launcher is named to match `externalBin`.
3. **Sign Recall sidecar launcher** — SignTool-signs the launcher *before*
   `tauri build` embeds it, so the shipped copy is Authenticode-signed.
   (`build.mjs`'s idempotency means the `beforeBuildCommand` re-invocation in
   step 4 does not overwrite/strip that signature.)
4. **Tauri build** — bundles the externalBin + resources into the MSI/NSIS.
5. **Sign installers** — SignTool-signs the `.msi` / NSIS `.exe` (and re-signs
   any loose `*.exe` under the bundle, including the launcher).

All signing steps are guarded by `if: env.PFX_PATH != ''`, so unsigned dogfood
builds (no `WINDOWS_SIGNING_CERT`) skip them cleanly.

> **arm64 caveat (known TODO).** `build.mjs` copies the **host** `node.exe` to
> form the launcher. On the `windows-latest` runners that host is x64, so the
> `aarch64-pc-windows-msvc` matrix leg currently emits an **x64** launcher under
> an aarch64 name. The x64 app + x64 Recall runtime are what we actually ship
> and dogfood today; a truly-native arm64 launcher needs an arm64 `node.exe` on
> an arm64 runner (or a cross-built thin wrapper exe) and is deferred until
> arm64 is a release target. This does not affect the x64 build or the green
> back-pressure gate.

### Live-recording verification (operational, not a CI gate)

End-to-end recording requires a **Recall API key at runtime** (fetched
server-side from hq-pro `GET /v1/recall/credentials`) and an
`@getindigo.ai`-gated user (`recall_sdk.rs::meeting_detect_eligible`). CI has
no Recall credentials, so live capture is **not** a CI back-pressure gate —
it is an operational smoke test:

1. Install a signed build as an `@getindigo.ai` user with Recall provisioned.
2. Join a Zoom/Meet/Teams call → the popover surfaces the detected meeting.
3. Hit Record → confirm a `recording:started` then, after the call,
   `recording:ended` in `~/.hq/sync-debug.log` (tagged `recall-sdk`), and the
   recording appears in Recall.
4. If the launcher/runtime is absent, the log shows `RECALL_SDK_UNAVAILABLE`
   and the rest of the app is unaffected (graceful degradation).

---

## 1b. macOS-only release fixes — N/A on Windows (US-012 triage)

Three upstream macOS release fixes are **deliberately not ported**. They all
address Apple-platform code-signing/notarization mechanics that **do not exist
on Windows**:

| Upstream commit | What it fixed (macOS) | Why N/A on Windows |
|-----------------|-----------------------|--------------------|
| `edbf27a` — *sign every Mach-O in GStreamer.framework* | Apple's notary rejects any unsigned Mach-O inside the bundle; the fix signs both umbrella copies of the GStreamer framework binary. | Windows has **no Mach-O format and no notarization**. The Recall Windows runtime ships plain PE DLLs; there is no per-binary "sign every Mach-O" requirement. Authenticode signs the installer (+ launcher) and that is sufficient — SmartScreen has no per-DLL notary check. |
| `52a38df` — *strip XML comment from `Entitlements.plist`* | Apple's `AMFIUnserializeXML` entitlements parser rejects XML comments, aborting every `codesign --entitlements` call. | Windows has **no entitlements / no `Entitlements.plist`**. There is no `--entitlements` signing pass; the file does not exist in this fork. |
| `f6b8b3b` — *microphone `audio-input` entitlement under hardened runtime* | Under macOS's hardened runtime, `AVCaptureDevice` needs `com.apple.security.device.audio-input` or the mic is silently denied. | Windows has **no hardened runtime and no entitlement-gated mic**. The bridge already gates the entire macOS TCC permission dance to `process.platform === 'darwin'` and reports `permissions:all-granted` on Windows (see `bridge.mjs`). Microphone access is governed by the Windows privacy settings UI, not signing. |

In short: the entire macOS signing surface these commits touch
(Mach-O signing, `Entitlements.plist`, hardened-runtime entitlements) has **no
Windows counterpart**. The Windows equivalent — Authenticode signing of the
installer and the sidecar launcher — is already handled in `release.yml`
(see §3 and §1a).

---

## 2. Rotate the updater pubkey

Do this if the private key is lost/leaked, or on a planned rotation.

> **Caveat:** an installed base signed against the *old* pubkey can only verify
> updates signed by the *old* private key. After a rotation, already-installed
> apps stop auto-updating until they are manually reinstalled from a freshly
> built (new-key) installer. There is currently no real installed base (the
> pre-US-010 pubkey was a placeholder), so the first rotation is free.

1. Generate a fresh keypair (writes the private key outside the repo; never commit it):
   ```powershell
   pwsh scripts/generate-updater-keypair.ps1
   ```
   or directly:
   ```powershell
   npx tauri signer generate -w "$env:USERPROFILE\.hq-sync-keys\hq-sync-win-updater.key" --password ""
   ```
2. Put the **public** half into `src-tauri/tauri.conf.json` →
   `plugins.updater.pubkey`. The field is the **base64 of the `.pub` file
   contents**:
   ```powershell
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("$env:USERPROFILE\.hq-sync-keys\hq-sync-win-updater.key.pub"))
   ```
3. Push the **private** half to GitHub Actions secrets (value never printed):
   ```powershell
   gh secret set TAURI_SIGNING_PRIVATE_KEY --repo indigoai-us/hq-sync-win < "$env:USERPROFILE\.hq-sync-keys\hq-sync-win-updater.key"
   # passphrase: empty for the dogfood key
   "" | gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --repo indigoai-us/hq-sync-win
   ```
4. Commit the `tauri.conf.json` pubkey change, cut a new release (§1). All
   future installers carry the new pubkey.

---

## 3. Rotate the code-signing cert

The Authenticode cert is independent of the updater key — rotating one does not
affect the other.

1. Obtain/renew the cert (self-signed for dogfood, OV/EV for public — see
   [`code-signing-windows.md`](./code-signing-windows.md) §"V2 — real EV / OV cert").
2. Export to PFX, base64-encode, update the secrets (values never printed):
   ```powershell
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("hq-sync-win.pfx")) | gh secret set WINDOWS_SIGNING_CERT --repo indigoai-us/hq-sync-win
   "<pfx-password>" | gh secret set WINDOWS_SIGNING_CERT_PASSWORD --repo indigoai-us/hq-sync-win
   ```
3. Cut a new release. The SignTool step picks up the new PFX automatically.
4. Verify: `signtool verify /pa /v <installer>.exe` shows the new cert,
   timestamped via `http://timestamp.digicert.com` (so signatures remain valid
   after the cert expires).

---

## Current state (US-012)

- Updater `pubkey` in `tauri.conf.json` is a **real** key (the V1 placeholder
  was replaced). Its private half is set as `TAURI_SIGNING_PRIVATE_KEY`
  (passwordless dogfood key) in the repo's Actions secrets.
- `release.yml` signs both `.msi` and `.exe` and emits the updater manifest.
- **Recall SDK sidecar is bundled (US-012):** a self-contained Node SEA launcher
  (`bundle.externalBin`) plus the ~98 MB Recall Windows runtime (`bundle.resources`)
  — see §1a. The launcher is built by `sidecar/recall-sdk-bridge/build.mjs`
  (also chained into `beforeBuildCommand`, so `tauri build` can never fail the
  `externalBin` requirement) and signed pre-build in `release.yml`. Live-recording
  is verified operationally (needs runtime Recall creds), not as a CI gate.
- **macOS-only release fixes (`edbf27a`, `52a38df`, `f6b8b3b`) are N/A** on
  Windows — Mach-O signing / `Entitlements.plist` / hardened-runtime mic
  entitlements have no Windows counterpart (see §1b).
- Code-signing cert is **optional/self-signed for dogfood** — full EV/OV cert
  procurement remains a non-goal (carried forward from V1). When
  `WINDOWS_SIGNING_CERT` is unset, the SignTool steps are skipped and unsigned
  dogfood installers ship (SmartScreen will warn on first run).
