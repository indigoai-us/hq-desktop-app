# docs

Architecture and operational documentation for hq-desktop-app.

The authoritative consolidation plan — recommended architecture, shared-crate
boundaries, the sync fork reunification, unified build/release/signing/updater, the
phased migration with verifiable done-criteria, and open questions — is
[`../MIGRATION.md`](../MIGRATION.md).

Planned dedicated docs (extracted from `MIGRATION.md` as the work lands):

- `architecture.md`
- `signing.md` — macOS notarization + Windows Azure Trusted Signing.
- `updater.md` — channel manifests, `.sig` regeneration after Authenticode.
- [`RELEASE.md`](RELEASE.md) — the unified release workflow and standing public
  installer/updater monitor.
- `sync-fork-reunification.md` — the macOS/Windows sync merge and its `cfg(target_os)` seam.
