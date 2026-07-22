# Wave 9C — sync 409 ship note

Feedback: `b8974be9-6b79-4e3c-87b5-8bc63fd3f59b`

## Root cause

`provision_missing_companies` in the shipped `hq-sync-menubar` crate resolved
companies through the global `GET /entity/by-slug/company/<slug>` endpoint.
That endpoint now rejects a slug that is live for more than one owner with HTTP
409, even when one of those entities is the authenticated caller's company.

## Fix

- `apps/sync/src-tauri/src/commands/provision.rs` reads the canonical
  `companies/manifest.yaml` binding first and validates its `cloud_uid` through
  `GET /entity/<uid>`.
- When no UID is available, `VaultClient::find_my_company_by_slug` uses
  `GET /entity/check-slug/me?type=company&slug=<slug>`, then fetches the
  returned UID directly. The global company-by-slug route is not used by the
  sync daemon.
- The same caller-scoped resolver now serves workspace reconciliation,
  sync-mode membership resolution, and the company-admin check used by the
  attribution/admin flow. The remaining global lookup is person-only recovery;
  it does not resolve company UIDs and does not share this ambiguity class.

## Regression coverage

`provision.rs` covers both the manifest-UID and caller-scoped fallback paths
with `clean-people`, while a mocked global by-slug endpoint returns 409. Each
case proceeds with `cmp_01KXK7SVDVRFQBCSYD5R95HAFR` and asserts that by-slug was
not called.

## Delivery

- PR: https://github.com/indigoai-us/hq-desktop-app/pull/248
- Merge verification: pending merge
- Release tag: pending release cut
- Tag includes fix verification: pending release cut

Local Linux Rust execution is blocked before app compilation by the missing
system `glib-2.0` development package. The required macOS Rust test job is run
in PR CI.
