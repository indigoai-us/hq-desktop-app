# docs

Architecture and operational documentation for hq-desktop-app.

The authoritative consolidation plan — recommended architecture, shared-crate
boundaries, the sync fork reunification, unified build/release/signing/updater, the
phased migration with verifiable done-criteria, and open questions — is
[`../MIGRATION.md`](../MIGRATION.md).

Current operational docs:

- [`RELEASE.md`](RELEASE.md) — the unified, channel-isolated, atomic release
  workflow.
- [`hq-work-handoff-qa.md`](hq-work-handoff-qa.md) — HQ Work handoff smoke
  checklist (canonical: [`apps/sync/docs/hq-work-handoff-qa.md`](../apps/sync/docs/hq-work-handoff-qa.md)).

Planned dedicated docs (to be extracted from `MIGRATION.md` as the work lands):

- `architecture.md`
- `signing.md` — macOS notarization + Windows Azure Trusted Signing.
- `updater.md` — channel manifests, `.sig` regeneration after Authenticode.
- `sync-fork-reunification.md` — the macOS/Windows sync merge and its `cfg(target_os)` seam.
