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

The three pre-change tests that still expected no Rust-side lookup were updated
without weakening their behavioral coverage:

- `test_find_by_slug_reuses_uid_no_create` pins a manifest `cloud_uid`, expects
  exactly `GET /entity/cmp_preexisting`, and proves the provisioner is not
  called.
- `test_find_by_slug_null_creates_entity_once` returns an available slug with a
  null caller-scoped UID, proves the provisioner is called exactly once, and
  checks the forwarded display name.
- `test_new_folder_provisioned_yaml_unchanged` exercises the same caller-scoped
  miss before provisioning and retains its byte-for-byte YAML hash assertion.

All three assert that the global `/entity/by-slug` route is not called. The
macOS Rust job passed with the full app test suite after these changes.

## Delivery

- PR: https://github.com/indigoai-us/hq-desktop-app/pull/248
- Squash merge commit: `e6c956f8e194565e055031b4f87c17360a6e2cef`
- Release tag: `v0.10.30`
- Tag includes fix verification: PASS —
  `git merge-base --is-ancestor e6c956f8e194565e055031b4f87c17360a6e2cef v0.10.30`
  exited 0 after the tag was pushed.

Local Linux compilation progressed through GLib and GTK after installing their
development packages, then stopped at `javascriptcoregtk-4.1`, which is not
available in the Amazon Linux 2023 repositories. The required macOS Rust test
job passed in PR CI.
