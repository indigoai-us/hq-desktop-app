# HQ Sync — Windows System Tray Agent (Tauri 2 + Svelte 5)

Windows 11 system-tray sync agent for HQ. Fork of [`indigoai-us/hq-sync`](https://github.com/indigoai-us/hq-sync) (the macOS menubar app), stripped of macOS-only code and ported to native Windows tray UX, Registry autostart, and Mica/Acrylic vibrancy.

## Status

V1 fork in progress. The bring-up sequence is tracked in the [hq-sync-win PRD](https://github.com/indigoai-us/hq/blob/main/companies/indigo/projects/hq-sync-win/prd.json):

- US-001 — fork + dev setup (this commit)
- US-002 — strip macOS-only Rust/Svelte code paths
- US-003 — Windows bundle config (MSI + NSIS)
- US-004 — Job Object process management
- US-005 — Tray + popover with Mica/Acrylic
- US-006 — Registry autostart
- US-007 — Folder picker via rfd
- US-008 — Path discovery + hq CLI resolver
- US-009 — CI + release pipeline (SignTool)
- US-010 — End-to-end smoke test

Until US-002+ land, `cargo check` will fail on Windows because the verbatim fork still contains macOS-only `nix`/`objc2` imports. This is expected and tracked in the PRD.

## Prerequisites (Windows 11)

| Tool | Version | Notes |
|------|---------|-------|
| Rust | stable | Install via [rustup](https://rustup.rs/). See `docs/dev-setup-windows.md` for ARM64 host notes. |
| Node | 22+ | Install via [nodejs.org](https://nodejs.org/) or [nvm-windows](https://github.com/coreybutler/nvm-windows). |
| npm | 10+ | Ships with Node 22. |
| Visual Studio Build Tools 2022 | latest | Workload: **"Desktop development with C++"** (a.k.a. "C++ build tools"). Required for the MSVC linker. |
| WebView2 Runtime | evergreen | Preinstalled on Windows 11. Required by Tauri for the popover WebView. |

Full step-by-step setup: [`docs/dev-setup-windows.md`](docs/dev-setup-windows.md).

## Development

Open a **Developer PowerShell for VS 2022** (so MSVC `link.exe` is on `PATH`), then:

```powershell
npm install
npm run tauri dev
```

If you prefer a plain PowerShell, the committed `.cargo/config.toml` invokes `vcvarsall` automatically so `cargo build` works without a Developer prompt.

## Build

```powershell
npm run tauri build -- --target x86_64-pc-windows-msvc
npm run tauri build -- --target aarch64-pc-windows-msvc
```

Outputs land in `src-tauri/target/<triple>/release/bundle/{msi,nsis}/`.

## Testing

> **Policy deviation:** V1 uses manual testing + smoke checklist instead of automated e2e tests. Documented exception from [`e2e-backpressure-required.md`](.claude/policies/e2e-backpressure-required.md), same justification as the macOS version: dogfood-only Windows cohort with a direct feedback channel. V2 adds Playwright (popover WebView) + Win32 UI Automation (tray) before any external rollout.

### Manual Testing

The Windows smoke checklist is at [`tests/MANUAL_TESTING.md`](tests/MANUAL_TESTING.md) (adapted from the macOS version in US-009/US-010). User journeys mirror the macOS app, adjusted for tray/Registry/MSI semantics.

### Unit Tests

```powershell
cd src-tauri
cargo test
```

### Release Testing Protocol

Before each release:

1. Run the full Windows manual checklist on a clean Win 11 ARM64 host (`tests/SMOKE_WINDOWS.md`)
2. Verify MSI installs from a fresh user account (no UAC)
3. Verify the signed installer surface in `Right-click → Properties → Digital Signatures`
4. Confirm autostart survives a log-out/log-in cycle
5. Confirm uninstall removes the `HKCU\…\Run\HQSync` registry value

## License

Internal. Not for redistribution.
