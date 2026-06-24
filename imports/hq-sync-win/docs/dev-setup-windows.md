# Windows Dev Setup — hq-sync-win

End-to-end environment setup for building HQ Sync on Windows 11. Tested on Windows 11 ARM64; notes flag where x64 differs.

This guide is the canonical bring-up for Windows Tauri 2 + Svelte 5 work at Indigo. The sibling project [`hq-installer-win`](https://github.com/indigoai-us/hq-installer-win) uses the same playbook; if anything below drifts, treat that repo's `docs/dev-setup-windows.md` as the second source of truth.

## 1. Visual Studio Build Tools 2022

The MSVC linker (`link.exe`) is required by every Rust target ending in `-msvc`, and by every Tauri build.

1. Download **Visual Studio Build Tools 2022** from <https://visualstudio.microsoft.com/downloads/#build-tools-for-visual-studio-2022>.
2. In the installer, select the **"Desktop development with C++"** workload. This pulls in:
   - MSVC v143 C++ compiler + linker
   - Windows 11 SDK
   - C++ CMake tools
3. Finish the install. No reboot needed in most cases.

Quick verification (from a Developer PowerShell):

```powershell
where.exe link.exe
# C:\Program Files\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC\<ver>\bin\Hostarm64\arm64\link.exe
```

## 2. Rust

Install Rust via the official Windows installer: <https://rustup.rs/> (download `rustup-init.exe`, run it, accept defaults).

### Targets

```powershell
rustup target add x86_64-pc-windows-msvc
rustup target add aarch64-pc-windows-msvc
```

Both are required so CI can cross-build x64 + ARM64 installers from a single matrix job.

### ARM64 host override

On an **ARM64 Windows host** (Stefan's dev box; Surface Pro 11; Snapdragon Dev Kits), the default toolchain after `rustup` install is `stable-aarch64-pc-windows-msvc`. Tauri 2 + several deps (notably `aws-lc-rs`, `ring`) still produce more predictable artifacts when the host toolchain is x64 emulated. **Pin the toolchain inside `src-tauri/`:**

```powershell
cd src-tauri
rustup override set stable-x86_64-pc-windows-msvc
```

This writes `src-tauri/rust-toolchain.toml` (or rustup's per-directory override database). Both `hq-docs-windows` and `hq-installer-win` use this same override — keep them in lockstep.

> On a pure **x64 host**, skip the override. The default `stable-x86_64-pc-windows-msvc` is already correct.

## 3. Node + npm

Install **Node 22 LTS** (or newer): <https://nodejs.org/en/download>. npm 10+ ships with it.

```powershell
node --version   # v22.x or later
npm --version    # 10.x or later
```

If you use multiple Node versions, [`nvm-windows`](https://github.com/coreybutler/nvm-windows) is the lightest manager. Avoid running `nvm` from Git Bash — its `use` command writes to the registry and Git Bash doesn't propagate the change to the parent shell. Use a Windows shell.

## 4. WebView2 Runtime

Windows 11 ships with the **WebView2 Evergreen Runtime** preinstalled. Verify:

```powershell
Get-AppxPackage Microsoft.WebView2Runtime | Select-Object Name,Version
```

If absent (rare; some custom OS images strip it), install from <https://developer.microsoft.com/en-us/microsoft-edge/webview2/>.

## 5. The Git Bash `link.exe` shadow

**This trips everyone the first time.** Symptom — your `cargo build` fails with:

```
LINK : fatal error LNK1561: entry point must be defined
```

or:

```
error: linking with `link.exe` failed: exit code: 1
```

…even though `where.exe link.exe` shows the correct MSVC linker.

**Cause.** Git for Windows ships `/usr/bin/link` (the GNU coreutils `link` utility — creates a hard link to a file). When you run `cargo` from inside a **Git Bash** shell, `PATH` puts `/usr/bin` ahead of the MSVC tools, so Cargo finds the coreutils `link` first and calls it with MSVC linker arguments. Garbage out.

**Fixes (pick one):**

1. **Recommended — use PowerShell** (regular or Developer) for all `cargo`/`npm run tauri` invocations. Git Bash is fine for git itself, just not for builds.
2. **Shadow the GNU `link` inside the build session** (Git Bash users):
   ```bash
   alias link='/c/Program\ Files/Microsoft\ Visual\ Studio/2022/BuildTools/VC/Tools/MSVC/<ver>/bin/Hostarm64/arm64/link.exe'
   ```
   This is fragile (version-specific). Prefer option 1.
3. **Delete `/usr/bin/link.exe`** from Git for Windows. Works but it's a global change that breaks any tool that legitimately wants GNU `link`. Not recommended.

## 6. Developer PowerShell vs plain PowerShell

The committed `.cargo/config.toml` ([`.cargo/config.toml`](../.cargo/config.toml)) wraps `link.exe` invocations through a small `link-msvc.bat` shim that sources `vcvarsall.bat` first. This means **plain PowerShell works** for `cargo build` — you don't need to launch a Developer PowerShell every time.

If you ever bypass that config (e.g. running `rustc` directly) or you see fresh-environment linker errors, fall back to a Developer PowerShell:

- Start menu → **"Developer PowerShell for VS 2022"** (`x64 Native Tools Command Prompt` works the same way on x64 hosts; on ARM64 launch `arm64_x86 Cross Tools Command Prompt`).

Inside that prompt, `vcvarsall` has already been sourced — `link.exe` resolves to MSVC and stays in scope for the session.

## 7. Verifying the environment

End-to-end smoke from a fresh checkout in a plain PowerShell:

```powershell
cd C:\repos\hq-sync-win
npm install
cd src-tauri
cargo check
```

> **Expected during US-001/US-002 transition:** `cargo check` will currently FAIL with `unresolved import nix::sys::signal` and friends. The fork copy still contains macOS-only code that US-002, US-004, US-006, and US-008 strip and replace with Windows equivalents. Once those land, `cargo check` (and `cargo build`) succeed cleanly on Windows.

## 8. Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `error[E0432]: unresolved import 'nix::sys::signal'` | Fork still contains POSIX-only code | Land US-002 + US-004 |
| `error: Microsoft Visual C++ 14.0 or greater is required` | VS Build Tools 2022 missing | Re-install with "Desktop development with C++" workload |
| `link.exe failed: exit code: 1` | Git Bash GNU `link` shadow | Use PowerShell (see §5) |
| `cargo: error: no override for directory` after rustup install | Per-dir override missing on ARM64 | `cd src-tauri && rustup override set stable-x86_64-pc-windows-msvc` |
| `WebView2Loader.dll not found` at runtime | WebView2 Runtime missing | Install evergreen runtime (see §4) |
| `npm ERR! code EPERM` | OneDrive sync on the checkout dir | Move repo out of `~/OneDrive`, or pause OneDrive during install |

## 9. Cross-references

- [`hq-installer-win`](https://github.com/indigoai-us/hq-installer-win) — installer that drops the `hq` CLI and managed toolchain dir this app depends on
- [`hq-docs-windows`](https://github.com/indigoai-us/hq-docs-windows) — Windows port of the HQ docs Tauri app; same toolchain notes apply
- [`indigoai-us/hq-sync`](https://github.com/indigoai-us/hq-sync) — the upstream macOS app this fork derives from
