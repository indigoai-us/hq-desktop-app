//! `list_syncable_workspaces` + `connect_workspace_to_cloud` Tauri commands —
//! the source of truth for the menubar's main view.
//!
//! ## Mapping model (v0.1.23+)
//!
//! Local company folders map to cloud buckets via TWO redundant records:
//!
//! 1. **`companies/manifest.yaml`** — canonical, declared by the user. When
//!    `discover_local_companies` reads this file, each entry's `cloud_uid` and
//!    `bucket_name` (if present) are treated as authoritative. The runtime
//!    trusts these even when the cloud is unreachable.
//!
//! 2. **`companies/{slug}/.hq/config.json`** — per-folder runtime cache.
//!    Written by both `provision_missing_companies` (auto-flow) and
//!    `connect_workspace_to_cloud` (Connect button). Keeps the cloud UID
//!    co-located with the data it describes, so a copied/moved folder takes
//!    its mapping with it.
//!
//! ## Connect flow (dual-write)
//!
//! When the Connect button fires:
//!   1. Provision the cloud bucket (idempotent — `find_by_slug` + reuse).
//!   2. Write per-folder `.hq/config.json` (authoritative for runtime).
//!   3. **Patch the manifest entry** with `cloud_uid` + `bucket_name`. Best-effort:
//!      if the manifest is missing or unparseable, log + continue (the per-folder
//!      config is still correct).
//!
//! ## Mismatch detection (`Broken` state)
//!
//! If the manifest declares `cloud_uid: X` for a slug but the cloud (when
//! reachable) returns no membership for that slug, OR returns a different UID,
//! the workspace surfaces as `Broken`. The user can hit Connect to reconcile —
//! `connect_workspace_to_cloud` will re-find by slug and overwrite the manifest
//! `cloud_uid` with the current truth.
//!
//! ## TODO: `repair_manifest` Tauri command (deferred)
//!
//! A future repair flow should:
//!   - Walk every `companies/{slug}/.hq/config.json`, ensure each has a
//!     matching manifest entry with the same `cloud_uid` / `bucket_name`.
//!   - Cross-reference the cloud's membership list against the manifest;
//!     surface entries that exist in the cloud but have no local config
//!     (orphan memberships) and ask the user whether to write a folder skeleton.
//!   - Detect duplicate slugs, broken paths, and stale UIDs.
//!   - Surface findings in a Settings panel; do not auto-mutate without the
//!     user's confirmation per finding.
//!
//! Intentionally NOT shipped in v0.1.23 to keep scope tight. Per-row Connect
//! covers the common case (re-provision a single broken slug) without needing
//! the full repair surface.

use std::collections::BTreeMap;
use std::path::Path;

use serde::Serialize;

use crate::commands::personal::PERSONAL_VAULT_JOURNAL_SLUG;
use crate::commands::sync::{resolve_jwt, resolve_vault_api_url};
use crate::commands::vault_client::{EntityInfo, MembershipInfo, VaultClient};
use crate::util::logfile::log;

#[allow(unused_imports)]
pub use hq_desktop_core::workspaces::{
    add_manifest_entry_for_synced_company, discover_local_companies, folder_enumeration_fallback,
    humanize_slug, last_synced_at, list_local_company_folders, patch_manifest_with_cloud_info,
    read_local_company_name, read_manifest, resolve_hq_folder_path, strip_manifest_cloud_info,
    CompaniesManifest, CompanyManifestEntry, LocalCompanyEntry, ManifestLoad, Workspace,
    WorkspaceKind, WorkspaceState, WorkspacesResult,
};

/// Detect manifest entries whose `cloud_uid` points at an entity that's no
/// longer in the cloud (deleted from hq-console), and strip the cloud pointers
/// so the workspace becomes LocalOnly instead of Broken.
///
/// Only triggers when:
///   - cloud is reachable (otherwise we can't tell the entity is gone), AND
///   - no `EntityInfo` in `company_entities` has a matching slug.
///
/// The disagree-on-UID case (cloud has slug but a different UID) is left as
/// Broken so Connect can repoint the manifest in a single step.
///
/// Mutates `local_companies` in place: stripped entries have their
/// `cloud_uid` / `bucket_name` cleared so the assemble pass produces
/// LocalOnly. Best-effort: per-entry write failures are logged and the entry
/// is left untouched (it'll show as Broken until the next pass).
///
/// Returns the number of entries successfully stripped.
pub(crate) fn prune_dangling_cloud_uids(
    hq_root: &Path,
    local_companies: &mut [LocalCompanyEntry],
    company_entities: &BTreeMap<String, EntityInfo>,
    cloud_reachable: bool,
) -> usize {
    if !cloud_reachable {
        return 0;
    }
    let manifest_path = hq_root.join("companies").join("manifest.yaml");
    if !manifest_path.exists() {
        return 0;
    }

    let mut pruned = 0usize;
    for entry in local_companies.iter_mut() {
        if entry.cloud_uid.is_none() {
            continue;
        }
        let slug_in_cloud = company_entities.values().any(|e| e.slug == entry.slug);
        if slug_in_cloud {
            continue;
        }
        match strip_manifest_cloud_info(&manifest_path, &entry.slug) {
            Ok(()) => {
                log(
                    "workspaces",
                    &format!(
                        "prune: stripped manifest cloud_uid for '{}' (cloud entity gone)",
                        entry.slug
                    ),
                );
                entry.cloud_uid = None;
                entry.bucket_name = None;
                pruned += 1;
            }
            Err(e) => {
                log(
                    "workspaces",
                    &format!("prune: strip '{}' failed: {e}", entry.slug),
                );
            }
        }
    }
    pruned
}

/// Reconcile the manifest with the local `companies/*/` folder reality after a
/// sync run. For each on-disk folder NOT in the manifest, add an entry —
/// stamped with cloud_uid + bucket_name when both are available, otherwise as
/// a stub that downstream Connect can patch with cloud info later.
///
/// Adding a stub entry (even without cloud info) is safer than skipping: a
/// folder with no manifest entry is invisible to manifest-first lookups and
/// causes downstream tooling to silently drop the company. The trade-off
/// (stub entries that need a Connect to gain cloud info) is acceptable
/// because the entry is self-describing and idempotent — re-running with
/// real cloud info later is a no-op.
///
/// Best-effort: each per-folder failure is logged but doesn't abort the rest.
/// Returns the number of entries newly added to the manifest.
pub(crate) async fn reconcile_manifest_after_sync(
    hq_root: &Path,
    vault: &VaultClient,
) -> Result<usize, String> {
    let manifest_path = hq_root.join("companies").join("manifest.yaml");
    if !manifest_path.exists() {
        // No manifest at all — out of scope here. /newcompany or first-run
        // setup is responsible for creating it.
        return Ok(0);
    }

    let known_slugs: std::collections::HashSet<String> = match read_manifest(hq_root) {
        ManifestLoad::Present(entries) => entries.into_iter().map(|e| e.slug).collect(),
        // Manifest unparseable — bail; we'd risk overwriting whatever the user
        // has in there. The folder-union in discover_local_companies still
        // gives the UI a workable view in the meantime.
        ManifestLoad::Failed(err) => {
            return Err(format!("manifest unreadable, refusing to patch: {err}"));
        }
        ManifestLoad::Absent => return Ok(0),
    };

    let mut added = 0usize;
    for (slug, _path) in list_local_company_folders(hq_root) {
        if slug.starts_with('_') {
            continue; // scaffolding folders (e.g. _template)
        }
        if known_slugs.contains(&slug) {
            continue; // already in manifest
        }
        // Look up the cloud entity. We always add a manifest entry — but if
        // the cloud has matching slug + bucket, we stamp it with cloud info
        // so the next sync recognizes it as Synced rather than LocalOnly.
        let cloud_match = match vault.find_my_company_by_slug(&slug).await {
            Ok(Some(e)) => Some(e),
            Ok(None) => {
                log(
                    "workspaces",
                    &format!("reconcile: no cloud entity for '{slug}' — adding stub entry"),
                );
                None
            }
            Err(e) => {
                log(
                    "workspaces",
                    &format!(
                        "reconcile: caller-scoped lookup '{slug}' failed: {e} — adding stub entry"
                    ),
                );
                None
            }
        };

        let (display_name, cloud_uid, bucket_name) = match cloud_match {
            Some(entity) => {
                let name = entity.name.clone().unwrap_or_else(|| humanize_slug(&slug));
                let uid = entity.uid.clone();
                let bucket = entity.bucket_name.clone();
                (name, Some(uid), bucket)
            }
            None => (humanize_slug(&slug), None, None),
        };

        // Only stamp cloud info when both UID and bucket are known. A
        // half-stamped entry would surface as Broken on the next pass.
        let (uid_arg, bucket_arg) = match (cloud_uid.as_deref(), bucket_name.as_deref()) {
            (Some(u), Some(b)) => (Some(u), Some(b)),
            _ => (None, None),
        };

        if let Err(e) = add_manifest_entry_for_synced_company(
            &manifest_path,
            &slug,
            &display_name,
            uid_arg,
            bucket_arg,
        ) {
            log(
                "workspaces",
                &format!("reconcile: add manifest entry for '{slug}' failed: {e}"),
            );
            continue;
        }
        let kind = if uid_arg.is_some() { "synced" } else { "stub" };
        log(
            "workspaces",
            &format!("reconcile: added {kind} manifest entry for '{slug}'"),
        );
        added += 1;
    }
    Ok(added)
}

// ── Workspace assembly (testable, synchronous core) ───────────────────────────

/// Pure function: given resolved cloud data + local company entries, produce
/// the workspaces vec. No I/O, no async.
///
/// **Manifest-first semantics:** when a `LocalCompanyEntry` carries
/// `cloud_uid` (i.e. the manifest declares this is a connected workspace), we
/// trust it as authoritative state — even when cloud is unreachable. Cloud
/// data is for cross-reference only:
///   - cloud confirms manifest UID → Synced
///   - cloud disagrees (different UID, or no membership for slug) → Broken
///   - cloud unreachable → Synced (optimistic; trust the local cache)
pub(crate) fn assemble_workspaces<F>(
    hq_root: &Path,
    person: Option<&EntityInfo>,
    memberships: &[MembershipInfo],
    company_entities: &BTreeMap<String, EntityInfo>,
    local_companies: &[LocalCompanyEntry],
    cloud_reachable: bool,
    last_synced_lookup: F,
) -> Vec<Workspace>
where
    F: Fn(&str) -> Option<String>,
{
    // Index entities by slug for manifest cross-reference (memberships use UIDs).
    let entities_by_slug: BTreeMap<&str, &EntityInfo> = company_entities
        .values()
        .map(|e| (e.slug.as_str(), e))
        .collect();
    // Index local entries by slug for the cloud-only pass below.
    let local_by_slug: BTreeMap<&str, &LocalCompanyEntry> = local_companies
        .iter()
        .map(|e| (e.slug.as_str(), e))
        .collect();

    let mut by_slug: BTreeMap<String, Workspace> = BTreeMap::new();

    // 1. Local companies (manifest-first).
    for entry in local_companies {
        if !entry.dir_exists {
            // Phantom manifest entry — drop it (no folder = nothing to act on).
            continue;
        }

        let display_name = entry
            .display_name
            .clone()
            .unwrap_or_else(|| humanize_slug(&entry.slug));
        let local_path_str = Some(entry.path.to_string_lossy().to_string());

        let cloud_entity_for_slug = entities_by_slug.get(entry.slug.as_str()).copied();
        let membership_for_slug = cloud_entity_for_slug
            .and_then(|ent| memberships.iter().find(|m| m.company_uid == ent.uid));
        let membership_status = membership_for_slug.map(|m| m.status.clone());
        let role = membership_for_slug.and_then(|m| m.role.clone());
        let invited_by = membership_for_slug.and_then(|m| m.invited_by.clone());
        let invited_at = membership_for_slug.and_then(|m| m.invited_at.clone());

        let (state, cloud_uid, bucket_name, broken_reason) = match (&entry.cloud_uid, cloud_entity_for_slug, cloud_reachable) {
            // Manifest says connected, cloud confirms (UIDs match) → Synced.
            (Some(manifest_uid), Some(ent), true) if &ent.uid == manifest_uid => (
                WorkspaceState::Synced,
                Some(ent.uid.clone()),
                ent.bucket_name.clone().or_else(|| entry.bucket_name.clone()),
                None,
            ),
            // Manifest says connected, cloud has slug but UID differs → Broken.
            (Some(manifest_uid), Some(ent), true) => (
                WorkspaceState::Broken,
                Some(manifest_uid.clone()),
                entry.bucket_name.clone(),
                Some(format!(
                    "manifest cloud_uid {manifest_uid} does not match cloud entity {} for this slug",
                    ent.uid
                )),
            ),
            // Manifest says connected, cloud has no entry for this slug → Broken.
            (Some(manifest_uid), None, true) => (
                WorkspaceState::Broken,
                Some(manifest_uid.clone()),
                entry.bucket_name.clone(),
                Some(format!(
                    "manifest cloud_uid {manifest_uid} not found in your cloud memberships"
                )),
            ),
            // Manifest says connected, cloud unreachable → trust manifest (Synced).
            (Some(manifest_uid), _, false) => (
                WorkspaceState::Synced,
                Some(manifest_uid.clone()),
                entry.bucket_name.clone(),
                None,
            ),
            // Manifest silent, cloud has matching slug → Synced (cloud-driven).
            (None, Some(ent), true) => (
                WorkspaceState::Synced,
                Some(ent.uid.clone()),
                ent.bucket_name.clone(),
                None,
            ),
            // Manifest silent, cloud has no matching slug (or unreachable) → LocalOnly.
            (None, _, _) => (
                WorkspaceState::LocalOnly,
                None,
                None,
                None,
            ),
        };

        by_slug.insert(
            entry.slug.clone(),
            Workspace {
                slug: entry.slug.clone(),
                display_name,
                kind: WorkspaceKind::Company,
                state,
                cloud_uid,
                bucket_name,
                has_local_folder: true,
                local_path: local_path_str,
                membership_status,
                role,
                last_synced_at: last_synced_lookup(&entry.slug),
                broken_reason,
                invited_by,
                invited_at,
            },
        );
    }

    // 2. Cloud-only companies — memberships whose slug isn't represented locally.
    for mem in memberships {
        let entity = match company_entities.get(&mem.company_uid) {
            Some(e) => e,
            None => continue,
        };
        // The personal vault is assembled separately below (section 3) as the
        // canonical kind=Personal / state=Personal row, and slug="personal" is
        // dropped from the company list above. A cloud membership/entity for
        // "personal" must NOT also surface here as a CloudOnly *company* row:
        // dedupe keys by kind+slug, so a `company:personal` row survives next to
        // `personal:personal` and drove a bogus "You've been added to Personal —
        // sync to pull it" prompt. The personal vault auto-provisions; it is
        // never a joinable membership.
        if entity.slug == "personal" {
            continue;
        }
        if by_slug.contains_key(&entity.slug) {
            continue;
        }
        let display_name = entity
            .name
            .clone()
            .or_else(|| {
                local_by_slug
                    .get(entity.slug.as_str())
                    .and_then(|e| e.display_name.clone())
            })
            .unwrap_or_else(|| humanize_slug(&entity.slug));
        by_slug.insert(
            entity.slug.clone(),
            Workspace {
                slug: entity.slug.clone(),
                display_name,
                kind: WorkspaceKind::Company,
                state: WorkspaceState::CloudOnly,
                cloud_uid: Some(entity.uid.clone()),
                bucket_name: entity.bucket_name.clone(),
                has_local_folder: false,
                local_path: None,
                membership_status: Some(mem.status.clone()),
                role: mem.role.clone(),
                last_synced_at: last_synced_lookup(&entity.slug),
                broken_reason: None,
                invited_by: mem.invited_by.clone(),
                invited_at: mem.invited_at.clone(),
            },
        );
    }

    // 3. Personal — always first.
    let mut ordered: Vec<Workspace> = Vec::with_capacity(by_slug.len() + 1);
    let personal_local = hq_root.exists() && hq_root.is_dir();
    let (personal_uid, personal_bucket) = match person {
        Some(p) => (Some(p.uid.clone()), p.bucket_name.clone()),
        None => (None, None),
    };
    let personal_display = person
        .and_then(|p| p.name.clone())
        .unwrap_or_else(|| "Personal".to_string());
    ordered.push(Workspace {
        slug: "personal".to_string(),
        display_name: personal_display,
        kind: WorkspaceKind::Personal,
        state: WorkspaceState::Personal,
        cloud_uid: personal_uid,
        bucket_name: personal_bucket,
        has_local_folder: personal_local,
        local_path: personal_local.then(|| hq_root.to_string_lossy().to_string()),
        membership_status: None,
        role: None,
        // The personal vault's journal is sharded under the reserved slug
        // PERSONAL_VAULT_JOURNAL_SLUG ("__hq_personal_vault__"), NOT "personal".
        // The engine migrated off the colliding "personal" slug, so reading
        // "personal" here returns the orphaned legacy journal whose `lastSync`
        // froze at the migration date — the tile then shows an ever-growing
        // "N days ago" even though the vault syncs every cycle. Look up the
        // reserved slug so the personal tile reflects the real last sync.
        last_synced_at: last_synced_lookup(PERSONAL_VAULT_JOURNAL_SLUG),
        broken_reason: None,
        invited_by: None,
        invited_at: None,
    });

    ordered.extend(by_slug.into_values());
    ordered
}

// ── Tauri command: list_syncable_workspaces ───────────────────────────────────

/// The three things `list_syncable_workspaces` fetches from vault in parallel:
/// `(self_person, memberships, company_entities_by_uid)`. Wrapped in `Result`
/// so a partial vault outage degrades gracefully (the local-disk view still
/// renders) — see the `Err(_)` branch below.
type CloudOutcome = Result<
    (
        Option<EntityInfo>,
        Vec<MembershipInfo>,
        BTreeMap<String, EntityInfo>,
    ),
    String,
>;

#[tauri::command]
pub async fn list_syncable_workspaces() -> Result<WorkspacesResult, String> {
    let hq_root = resolve_hq_folder_path()?;
    let hq_folder_path = hq_root.to_string_lossy().to_string();
    let (mut local_companies, manifest_error) = discover_local_companies(&hq_root);

    let cloud_outcome: CloudOutcome = async {
        let vault_url = resolve_vault_api_url()?;
        let jwt = resolve_jwt().await?;
        let vault = VaultClient::new(&vault_url, &jwt);

        let mut persons = vault
            .list_entities_by_type("person")
            .await
            .map_err(|e| format!("list person entities: {e}"))?;
        persons.sort_by(|a, b| match a.created_at.cmp(&b.created_at) {
            std::cmp::Ordering::Equal => a.uid.cmp(&b.uid),
            ord => ord,
        });
        let person = persons.into_iter().next();

        let mut memberships = match &person {
            Some(p) => vault
                .list_memberships(&p.uid)
                .await
                .map_err(|e| format!("list memberships: {e}"))?,
            None => Vec::new(),
        };

        // Modern email-keyed invites only live on pending-by-email until
        // claim-by-email rewrites them onto the person. Merge as synthetic
        // pending memberships so desktop NEEDS YOU / company Accept work.
        let pending_by_email = vault
            .list_pending_invites_by_email()
            .await
            .unwrap_or_else(|e| {
                log(
                    "workspaces",
                    &format!("list pending-by-email failed (non-fatal): {e}"),
                );
                Vec::new()
            });
        let existing_company_uids: std::collections::HashSet<String> =
            memberships.iter().map(|m| m.company_uid.clone()).collect();
        let person_uid_for_synth = person
            .as_ref()
            .map(|p| p.uid.clone())
            .unwrap_or_else(|| "email-pending".to_string());
        for inv in pending_by_email {
            if existing_company_uids.contains(&inv.company_uid) {
                continue;
            }
            memberships.push(MembershipInfo {
                uid: String::new(),
                person_uid: person_uid_for_synth.clone(),
                company_uid: inv.company_uid.clone(),
                status: "pending".to_string(),
                role: inv.role.clone(),
                created_at: inv.invited_at.clone(),
                membership_key: inv.membership_key.clone(),
                company_name: None,
                invited_by: inv.invited_by.clone(),
                invited_at: inv.invited_at.clone(),
            });
        }

        let mut entities: BTreeMap<String, EntityInfo> = BTreeMap::new();
        for mem in &memberships {
            if entities.contains_key(&mem.company_uid) {
                continue;
            }
            match vault.find_entity_by_uid(&mem.company_uid).await {
                Ok(Some(e)) => {
                    // Tombstoned (DELETE /entity/{uid} via hq-console) — the
                    // vault still returns the row but the company is "gone"
                    // from the user's perspective. Drop it so downstream
                    // assembly + the prune-dangling-cloud-uids pass treat
                    // this slug as missing-from-cloud and surface LocalOnly.
                    if e.deleted {
                        log(
                            "workspaces",
                            &format!(
                                "drop tombstoned entity {} (slug='{}') from cloud view",
                                e.uid, e.slug
                            ),
                        );
                        continue;
                    }
                    entities.insert(mem.company_uid.clone(), e);
                }
                Ok(None) => {}
                Err(e) => {
                    return Err(format!(
                        "fetch entity {} for membership {}: {e}",
                        mem.company_uid,
                        mem.display_id()
                    ));
                }
            }
        }

        // Drop memberships whose entity got filtered out above (tombstoned
        // or 404). Keeps `assemble_workspaces` invariants clean — every
        // membership it sees has a live entity in `entities`.
        let memberships: Vec<MembershipInfo> = memberships
            .into_iter()
            .filter(|m| entities.contains_key(&m.company_uid))
            .collect();

        Ok((person, memberships, entities))
    }
    .await;

    let (cloud_reachable, error, person, memberships, entities) = match cloud_outcome {
        Ok((p, m, e)) => (true, None, p, m, e),
        Err(e) => {
            // Surface cloud errors to the persistent log alongside the UI
            // tooltip — the menubar's "Cloud unreachable" notice gives the
            // user a hover-tooltip with the message, but the log is the
            // canonical place to grep when reproducing or debugging without
            // a popover open. Pre-v0.1.25 schema mismatches (missing
            // membership uid) propagated as silent failures here.
            log("workspaces", &format!("cloud branch failed: {e}"));
            (false, Some(e), None, Vec::new(), BTreeMap::new())
        }
    };

    // Auto-clean manifest entries whose cloud_uid points at a cloud entity
    // that's no longer there (deleted via hq-console). Stripping the manifest
    // pointers lets the entry render as LocalOnly instead of Broken.
    prune_dangling_cloud_uids(&hq_root, &mut local_companies, &entities, cloud_reachable);

    let workspaces = assemble_workspaces(
        &hq_root,
        person.as_ref(),
        &memberships,
        &entities,
        &local_companies,
        cloud_reachable,
        last_synced_at,
    );

    Ok(WorkspacesResult {
        workspaces,
        cloud_reachable,
        error,
        hq_folder_path,
        manifest_error,
    })
}

/// Result of `claim_pending_company_invite`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimPendingInviteResult {
    pub ok: bool,
    pub claimed_slugs: Vec<String>,
    pub message: String,
}

/// Accept pending company invite(s) via `POST /membership/claim-by-email`
/// (modern tokenless path). Optional `company_slug` is advisory for messaging.
#[tauri::command]
pub async fn claim_pending_company_invite(
    company_slug: Option<String>,
) -> Result<ClaimPendingInviteResult, String> {
    let vault_url = resolve_vault_api_url()?;
    let jwt = resolve_jwt().await?;
    let vault = VaultClient::new(&vault_url, &jwt);

    let mut persons = vault
        .list_entities_by_type("person")
        .await
        .map_err(|e| format!("list person entities: {e}"))?;
    persons.sort_by(|a, b| match a.created_at.cmp(&b.created_at) {
        std::cmp::Ordering::Equal => a.uid.cmp(&b.uid),
        ord => ord,
    });
    let person = match persons.into_iter().next() {
        Some(p) => p,
        None => {
            match crate::commands::personal::create_person_entity_from_cognito(&vault).await? {
                Some(p) => p,
                None => {
                    return Err(
                        "No person entity for this account — sign out and back in, then try Accept again."
                            .into(),
                    );
                }
            }
        }
    };

    let before_pending = vault
        .list_pending_invites_by_email()
        .await
        .map_err(|e| format!("list pending invites: {e}"))?;
    if before_pending.is_empty() {
        let slug_hint = company_slug
            .as_deref()
            .map(|s| format!(" for {s}"))
            .unwrap_or_default();
        return Ok(ClaimPendingInviteResult {
            ok: true,
            claimed_slugs: Vec::new(),
            message: format!(
                "No email-keyed pending invite{slug_hint}. If you still see an invite, run Sync — or use the invite email link for a legacy token invite."
            ),
        });
    }

    let claim = vault
        .claim_pending_invites_by_email(Some(&person.uid))
        .await
        .map_err(|e| format!("claim invite failed: {e}"))?;

    let mut claimed_slugs: Vec<String> = Vec::new();
    for mem in &claim.claimed {
        if let Ok(Some(ent)) = vault.find_entity_by_uid(&mem.company_uid).await {
            if !ent.slug.is_empty() && !claimed_slugs.contains(&ent.slug) {
                claimed_slugs.push(ent.slug);
            }
        }
    }

    if claimed_slugs.is_empty() {
        let after = vault
            .list_pending_invites_by_email()
            .await
            .unwrap_or_default();
        if after.len() < before_pending.len() {
            let after_uids: std::collections::HashSet<_> =
                after.iter().map(|i| i.company_uid.clone()).collect();
            for inv in &before_pending {
                if after_uids.contains(&inv.company_uid) {
                    continue;
                }
                if let Ok(Some(ent)) = vault.find_entity_by_uid(&inv.company_uid).await {
                    if !ent.slug.is_empty() && !claimed_slugs.contains(&ent.slug) {
                        claimed_slugs.push(ent.slug);
                    }
                }
            }
        }
    }

    let message = if claimed_slugs.is_empty() {
        "Invite claim completed. Run Sync to pull any newly joined companies.".to_string()
    } else if claimed_slugs.len() == 1 {
        format!(
            "Joined {}. Run Sync to pull it onto this Mac.",
            claimed_slugs[0]
        )
    } else {
        format!(
            "Joined {}. Run Sync to pull them onto this Mac.",
            claimed_slugs.join(", ")
        )
    };

    log(
        "workspaces",
        &format!(
            "claim_pending_company_invite ok person={} slugs={:?}",
            person.uid, claimed_slugs
        ),
    );

    Ok(ClaimPendingInviteResult {
        ok: true,
        claimed_slugs,
        message,
    })
}

/// Capture a `connect_workspace_to_cloud` failure to Sentry.
///
/// CLI subprocess errors are already captured at the `run_cli_provision` layer
/// with richer context (exit code, stderr tail, invocation kind) — this helper
/// is for the local-validation paths that never reach the CLI: missing folder,
/// unresolved HQ root, empty slug, etc. Keeping the two layers distinct
/// prevents double-counting in Sentry while ensuring no Connect failure goes
/// unmonitored.
fn capture_connect_error(slug: &str, reason: &str, message: &str) {
    sentry::with_scope(
        |scope| {
            scope.set_tag("slug", slug);
            scope.set_tag("action", "connect");
            scope.set_tag("connect_reason", reason);
        },
        || {
            sentry::capture_message(
                &format!("[connect] {reason}: {message}"),
                sentry::Level::Error,
            );
        },
    );
}

// ── Tauri command: connect_workspace_to_cloud ─────────────────────────────────

/// Provision a cloud bucket for the given local company `slug` by delegating
/// to `hq cloud provision company <slug>` — the canonical CLI subcommand from
/// `@indigoai-us/hq-cli` (introduced 2026-04-27).
///
/// Single source of truth: the CLI handles GET-then-POST entity idempotency,
/// atomic `companies/manifest.yaml` patch, atomic `companies/<slug>/.hq/config.json`
/// write, and the initial sync via `share()`. We pre-validate locally so the
/// user gets a fast UI error for trivially-bad inputs (empty slug, "personal",
/// missing folder), then shell out for the real work.
///
/// Reconnect-safe: re-running on a Broken workspace re-runs the CLI, which
/// reuses the existing cloud entity by slug and overwrites both records with
/// the current truth — same behaviour as before, just executed in one place.
///
/// On exit code 3 (entity provisioned, manifest patched, config written, but
/// initial sync failed) we return Err so the UI surfaces a notice — but the
/// next sync run will pick up where the CLI left off.
///
/// `vault_client.rs` entity functions (`find_entity_by_slug`, `create_entity`,
/// `provision_bucket`) are intentionally NOT used here anymore; they remain
/// for membership lookups, telemetry, and STS vending elsewhere in the app.
#[tauri::command]
pub async fn connect_workspace_to_cloud(slug: String) -> Result<(), String> {
    log("workspaces", &format!("connect: slug='{slug}' start"));
    if slug.is_empty() {
        let err = "slug is required".to_string();
        capture_connect_error(&slug, "empty_slug", &err);
        return Err(err);
    }
    if slug == "personal" {
        let err = "the Personal vault is auto-provisioned — no manual connect needed".to_string();
        capture_connect_error(&slug, "personal_slug", &err);
        return Err(err);
    }

    let hq_root = resolve_hq_folder_path().map_err(|e| {
        log(
            "workspaces",
            &format!("connect '{slug}': hq_root resolve failed: {e}"),
        );
        capture_connect_error(&slug, "hq_root_resolve", &e);
        e
    })?;
    log(
        "workspaces",
        &format!("connect '{slug}': hq_root={}", hq_root.display()),
    );

    // Resolve the folder path. Prefer the manifest's `path` field when set
    // (custom layouts); fall back to `companies/{slug}` for default HQs. We
    // only use this to fail-fast if the user clicked Connect on a workspace
    // whose local folder has been moved or deleted — the CLI itself also
    // validates the directory exists, but the local check gives us a tighter
    // UI error before we eat the subprocess startup cost.
    let folder = match read_manifest(&hq_root) {
        ManifestLoad::Present(entries) => entries
            .into_iter()
            .find(|e| e.slug == slug)
            .map(|e| e.path)
            .unwrap_or_else(|| hq_root.join("companies").join(&slug)),
        _ => hq_root.join("companies").join(&slug),
    };
    log(
        "workspaces",
        &format!("connect '{slug}': folder={}", folder.display()),
    );

    if !folder.is_dir() {
        let err = format!(
            "no local folder at {} — cannot connect a missing directory",
            folder.display()
        );
        log("workspaces", &format!("connect '{slug}': {err}"));
        capture_connect_error(&slug, "folder_missing", &err);
        return Err(err);
    }

    // Forward the manifest/yaml-derived display name as `--name` so the CLI
    // creates a friendly entity rather than defaulting to the bare slug.
    let display_name =
        read_local_company_name(&hq_root, &slug).unwrap_or_else(|| humanize_slug(&slug));
    log(
        "workspaces",
        &format!(
            "connect '{slug}': delegating to `hq cloud provision company` (display={display_name:?})"
        ),
    );

    match crate::commands::run_cli_provision::run_cli_provision(
        &slug,
        Some(&display_name),
        &hq_root,
    )
    .await
    {
        Ok(result) => {
            log(
                "workspaces",
                &format!(
                    "connect '{slug}': complete cloud_uid={} bucket={} created_entity={} files_uploaded={:?}",
                    result.cloud_uid,
                    result.bucket_name,
                    result.created_entity,
                    result.initial_sync.files_uploaded,
                ),
            );
            Ok(())
        }
        Err(e) => {
            let msg = format!("hq CLI failed for '{slug}': {e}");
            log("workspaces", &msg);
            Err(msg)
        }
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use crate::commands::workspaces::*;
    use tempfile::TempDir;
    use PERSONAL_VAULT_JOURNAL_SLUG;

    fn person(uid: &str, bucket: Option<&str>) -> EntityInfo {
        EntityInfo {
            uid: uid.into(),
            slug: format!("{uid}-slug"),
            entity_type: "person".into(),
            name: Some("Stefan".into()),
            bucket_name: bucket.map(str::to_string),
            status: "active".into(),
            created_at: "2026-01-01T00:00:00Z".into(),
            deleted: false,
        }
    }

    fn company_entity(uid: &str, slug: &str, name: Option<&str>) -> EntityInfo {
        EntityInfo {
            uid: uid.into(),
            slug: slug.into(),
            entity_type: "company".into(),
            name: name.map(str::to_string),
            bucket_name: Some(format!("hq-vault-{}", uid.replace('_', "-"))),
            status: "active".into(),
            created_at: "2026-02-01T00:00:00Z".into(),
            deleted: false,
        }
    }

    fn membership(uid: &str, person_uid: &str, company_uid: &str, status: &str) -> MembershipInfo {
        MembershipInfo {
            uid: uid.into(),
            person_uid: person_uid.into(),
            company_uid: company_uid.into(),
            status: status.into(),
            role: Some("member".into()),
            created_at: Some("2026-03-01T00:00:00Z".into()),
            // Tests historically mocked a top-level uid; the live API
            // returns membership_key instead. Synthesize one here so the
            // struct literal is complete.
            membership_key: Some(format!("{person_uid}#{company_uid}")),
            company_name: None,
            invited_by: Some(person_uid.into()),
            invited_at: Some("2026-03-01T00:00:00Z".into()),
        }
    }

    fn local(slug: &str, hq_root: &Path, exists: bool, name: Option<&str>) -> LocalCompanyEntry {
        local_full(slug, hq_root, exists, name, None, None)
    }

    fn local_full(
        slug: &str,
        hq_root: &Path,
        exists: bool,
        name: Option<&str>,
        cloud_uid: Option<&str>,
        bucket_name: Option<&str>,
    ) -> LocalCompanyEntry {
        let path = hq_root.join("companies").join(slug);
        if exists {
            std::fs::create_dir_all(&path).unwrap();
        }
        LocalCompanyEntry {
            slug: slug.into(),
            display_name: name.map(str::to_string),
            path,
            dir_exists: exists,
            cloud_uid: cloud_uid.map(str::to_string),
            bucket_name: bucket_name.map(str::to_string),
        }
    }

    fn write_manifest(hq_root: &Path, contents: &str) {
        let dir = hq_root.join("companies");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("manifest.yaml"), contents).unwrap();
    }

    #[test]
    fn personal_always_first_zero_companies() {
        let tmp = TempDir::new().unwrap();
        let p = person("prs_x", Some("hq-vault-prs-x"));
        let result = assemble_workspaces(
            tmp.path(),
            Some(&p),
            &[],
            &BTreeMap::new(),
            &[],
            true,
            |_| None,
        );
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].slug, "personal");
        assert_eq!(result[0].kind, WorkspaceKind::Personal);
    }

    #[test]
    fn personal_present_without_person_entity() {
        let tmp = TempDir::new().unwrap();
        let result =
            assemble_workspaces(tmp.path(), None, &[], &BTreeMap::new(), &[], true, |_| None);
        assert_eq!(result.len(), 1);
        assert!(result[0].cloud_uid.is_none());
    }

    #[test]
    fn personal_cloud_membership_does_not_become_a_joinable_company_row() {
        // Regression (v0.8.3 "You've been added to Personal" prompt): an active
        // cloud membership/entity for slug "personal" must NOT surface as a
        // CloudOnly *company* row in section 2. The personal vault is assembled
        // separately as the canonical kind=Personal row; a phantom
        // `company:personal` cloud-only/active row survived dedupe (keyed by
        // kind+slug) and drove the frontend's joinableMemberships to raise a
        // bogus "sync to pull Personal" prompt.
        let tmp = TempDir::new().unwrap();
        let p = person("prs_x", Some("hq-vault-prs-x"));
        let mut entities = BTreeMap::new();
        entities.insert(
            "cmp_personal".to_string(),
            company_entity("cmp_personal", "personal", Some("Personal")),
        );
        let mems = [membership("mem_p", "prs_x", "cmp_personal", "active")];
        let result =
            assemble_workspaces(tmp.path(), Some(&p), &mems, &entities, &[], true, |_| None);
        // "personal" appears exactly once, as the canonical Personal row — never
        // a CloudOnly company row.
        let personal_rows: Vec<_> = result.iter().filter(|w| w.slug == "personal").collect();
        assert_eq!(personal_rows.len(), 1, "personal must appear exactly once");
        assert_eq!(personal_rows[0].kind, WorkspaceKind::Personal);
        assert_eq!(personal_rows[0].state, WorkspaceState::Personal);
        assert!(
            !result
                .iter()
                .any(|w| w.slug == "personal" && w.kind == WorkspaceKind::Company),
            "no phantom company:personal cloud-only row may leak into the list"
        );
    }

    #[test]
    fn manifest_uid_matches_cloud_membership_is_synced() {
        let tmp = TempDir::new().unwrap();
        let p = person("prs_x", None);
        let mem = membership("mem_1", "prs_x", "cmp_a", "active");
        let mut entities = BTreeMap::new();
        entities.insert(
            "cmp_a".to_string(),
            company_entity("cmp_a", "acme", Some("Acme")),
        );
        let entries = vec![local_full(
            "acme",
            tmp.path(),
            true,
            Some("Acme"),
            Some("cmp_a"),
            Some("hq-vault-cmp-a"),
        )];

        let result = assemble_workspaces(
            tmp.path(),
            Some(&p),
            &[mem],
            &entities,
            &entries,
            true,
            |_| None,
        );
        assert_eq!(result[1].state, WorkspaceState::Synced);
        assert_eq!(result[1].cloud_uid.as_deref(), Some("cmp_a"));
        assert_eq!(result[1].membership_status.as_deref(), Some("active"));
        assert!(result[1].broken_reason.is_none());
    }

    #[test]
    fn manifest_uid_disagrees_with_cloud_is_broken() {
        let tmp = TempDir::new().unwrap();
        let p = person("prs_x", None);
        let mem = membership("mem_1", "prs_x", "cmp_NEW", "active");
        let mut entities = BTreeMap::new();
        entities.insert(
            "cmp_NEW".to_string(),
            company_entity("cmp_NEW", "acme", Some("Acme")),
        );
        let entries = vec![local_full(
            "acme",
            tmp.path(),
            true,
            Some("Acme"),
            Some("cmp_OLD"),
            Some("hq-vault-cmp-old"),
        )];

        let result = assemble_workspaces(
            tmp.path(),
            Some(&p),
            &[mem],
            &entities,
            &entries,
            true,
            |_| None,
        );
        assert_eq!(result[1].state, WorkspaceState::Broken);
        assert_eq!(result[1].cloud_uid.as_deref(), Some("cmp_OLD"));
        let reason = result[1].broken_reason.as_ref().unwrap();
        assert!(reason.contains("cmp_OLD"));
        assert!(reason.contains("cmp_NEW"));
    }

    #[test]
    fn manifest_uid_with_no_cloud_membership_is_broken() {
        let tmp = TempDir::new().unwrap();
        let p = person("prs_x", None);
        let entries = vec![local_full(
            "acme",
            tmp.path(),
            true,
            None,
            Some("cmp_GONE"),
            Some("hq-vault-cmp-gone"),
        )];

        let result = assemble_workspaces(
            tmp.path(),
            Some(&p),
            &[],
            &BTreeMap::new(),
            &entries,
            true,
            |_| None,
        );
        assert_eq!(result[1].state, WorkspaceState::Broken);
        assert_eq!(result[1].cloud_uid.as_deref(), Some("cmp_GONE"));
    }

    /// Cloud unreachable → trust manifest optimistically (Synced, not Broken).
    #[test]
    fn manifest_uid_with_cloud_unreachable_is_synced_optimistic() {
        let tmp = TempDir::new().unwrap();
        let p = person("prs_x", None);
        let entries = vec![local_full(
            "acme",
            tmp.path(),
            true,
            None,
            Some("cmp_a"),
            Some("hq-vault-cmp-a"),
        )];

        let result = assemble_workspaces(
            tmp.path(),
            Some(&p),
            &[],
            &BTreeMap::new(),
            &entries,
            false,
            |_| None,
        );
        assert_eq!(result[1].state, WorkspaceState::Synced);
        assert!(result[1].broken_reason.is_none());
    }

    #[test]
    fn manifest_silent_with_cloud_membership_is_synced() {
        let tmp = TempDir::new().unwrap();
        let p = person("prs_x", None);
        let mem = membership("mem_1", "prs_x", "cmp_a", "active");
        let mut entities = BTreeMap::new();
        entities.insert(
            "cmp_a".to_string(),
            company_entity("cmp_a", "acme", Some("Acme")),
        );
        let entries = vec![local("acme", tmp.path(), true, Some("Acme"))];

        let result = assemble_workspaces(
            tmp.path(),
            Some(&p),
            &[mem],
            &entities,
            &entries,
            true,
            |_| None,
        );
        assert_eq!(result[1].state, WorkspaceState::Synced);
        assert_eq!(result[1].cloud_uid.as_deref(), Some("cmp_a"));
    }

    #[test]
    fn manifest_silent_with_no_cloud_membership_is_local_only() {
        let tmp = TempDir::new().unwrap();
        let p = person("prs_x", None);
        let entries = vec![local("test-co", tmp.path(), true, None)];
        let result = assemble_workspaces(
            tmp.path(),
            Some(&p),
            &[],
            &BTreeMap::new(),
            &entries,
            true,
            |_| None,
        );
        assert_eq!(result[1].state, WorkspaceState::LocalOnly);
        assert!(result[1].cloud_uid.is_none());
    }

    #[test]
    fn membership_without_local_folder_is_cloud_only() {
        let tmp = TempDir::new().unwrap();
        let p = person("prs_x", None);
        let mem = membership("mem_1", "prs_x", "cmp_b", "pending");
        let mut entities = BTreeMap::new();
        entities.insert("cmp_b".to_string(), company_entity("cmp_b", "newco", None));
        let result =
            assemble_workspaces(tmp.path(), Some(&p), &[mem], &entities, &[], true, |_| None);
        assert_eq!(result[1].state, WorkspaceState::CloudOnly);
        assert_eq!(result[1].membership_status.as_deref(), Some("pending"));
    }

    #[test]
    fn manifest_entry_without_folder_is_dropped() {
        let tmp = TempDir::new().unwrap();
        let p = person("prs_x", None);
        let entries = vec![local_full(
            "phantom",
            tmp.path(),
            false,
            Some("Phantom"),
            Some("cmp_p"),
            None,
        )];
        let result = assemble_workspaces(
            tmp.path(),
            Some(&p),
            &[],
            &BTreeMap::new(),
            &entries,
            true,
            |_| None,
        );
        assert_eq!(result.len(), 1);
    }

    #[test]
    fn stale_membership_with_missing_entity_is_dropped() {
        let tmp = TempDir::new().unwrap();
        let p = person("prs_x", None);
        let mem = membership("mem_stale", "prs_x", "cmp_gone", "active");
        let result = assemble_workspaces(
            tmp.path(),
            Some(&p),
            &[mem],
            &BTreeMap::new(),
            &[],
            true,
            |_| None,
        );
        assert_eq!(result.len(), 1);
    }

    #[test]
    fn last_synced_lookup_invoked_per_workspace() {
        let tmp = TempDir::new().unwrap();
        let p = person("prs_x", None);
        let entries = vec![local("foo", tmp.path(), true, None)];
        let result = assemble_workspaces(
            tmp.path(),
            Some(&p),
            &[],
            &BTreeMap::new(),
            &entries,
            true,
            |slug| match slug {
                // Regression lock for the frozen "personal: N days ago" tile:
                // the personal row MUST read the reserved vault slug, not the
                // orphaned legacy "personal" journal. Map the two slugs to
                // different timestamps and assert the tile picks the reserved
                // one. If a future change reverts to "personal", result[0]
                // becomes the 1999 sentinel and this fails.
                PERSONAL_VAULT_JOURNAL_SLUG => Some("2026-04-25T00:00:00Z".into()),
                "personal" => Some("1999-01-01T00:00:00Z".into()), // legacy journal — must be IGNORED
                "foo" => Some("2026-04-24T12:00:00Z".into()),
                _ => None,
            },
        );
        assert_eq!(
            result[0].last_synced_at.as_deref(),
            Some("2026-04-25T00:00:00Z")
        );
        assert_eq!(
            result[1].last_synced_at.as_deref(),
            Some("2026-04-24T12:00:00Z")
        );
    }

    #[test]
    fn companies_sorted_alphabetically() {
        let tmp = TempDir::new().unwrap();
        let p = person("prs_x", None);
        let entries = vec![
            local("zoo", tmp.path(), true, None),
            local("alpha", tmp.path(), true, None),
            local("mango", tmp.path(), true, None),
        ];
        let result = assemble_workspaces(
            tmp.path(),
            Some(&p),
            &[],
            &BTreeMap::new(),
            &entries,
            true,
            |_| None,
        );
        let slugs: Vec<&str> = result.iter().map(|w| w.slug.as_str()).collect();
        assert_eq!(slugs, vec!["personal", "alpha", "mango", "zoo"]);
    }

    #[test]
    fn display_name_fallback_chain() {
        let tmp = TempDir::new().unwrap();
        let p = person("prs_x", None);
        let entries = vec![local("acme", tmp.path(), true, Some("Acme From Manifest"))];
        let result = assemble_workspaces(
            tmp.path(),
            Some(&p),
            &[],
            &BTreeMap::new(),
            &entries,
            true,
            |_| None,
        );
        assert_eq!(result[1].display_name, "Acme From Manifest");
    }

    // ── prune_dangling_cloud_uids ───────────────────────────────────────

    #[test]
    fn prune_strips_when_cloud_has_no_entity_for_slug() {
        let tmp = TempDir::new().unwrap();
        write_manifest(
            tmp.path(),
            r#"
companies:
  alpha:
    name: "Alpha"
    path: "companies/alpha"
    cloud_uid: "cmp_GONE"
    bucket_name: "hq-vault-cmp-gone"
"#,
        );
        let mut entries = vec![local_full(
            "alpha",
            tmp.path(),
            true,
            Some("Alpha"),
            Some("cmp_GONE"),
            Some("hq-vault-cmp-gone"),
        )];

        let pruned = prune_dangling_cloud_uids(tmp.path(), &mut entries, &BTreeMap::new(), true);
        assert_eq!(pruned, 1);
        assert!(entries[0].cloud_uid.is_none());
        assert!(entries[0].bucket_name.is_none());

        let (reread, _) = discover_local_companies(tmp.path());
        let alpha = reread.iter().find(|e| e.slug == "alpha").unwrap();
        assert!(alpha.cloud_uid.is_none());
    }

    #[test]
    fn prune_skips_when_cloud_unreachable() {
        let tmp = TempDir::new().unwrap();
        write_manifest(
            tmp.path(),
            r#"
companies:
  alpha:
    name: "Alpha"
    path: "companies/alpha"
    cloud_uid: "cmp_GONE"
    bucket_name: "hq-vault-cmp-gone"
"#,
        );
        let mut entries = vec![local_full(
            "alpha",
            tmp.path(),
            true,
            None,
            Some("cmp_GONE"),
            Some("hq-vault-cmp-gone"),
        )];
        let pruned = prune_dangling_cloud_uids(tmp.path(), &mut entries, &BTreeMap::new(), false);
        assert_eq!(pruned, 0);
        assert_eq!(entries[0].cloud_uid.as_deref(), Some("cmp_GONE"));
    }

    #[test]
    fn prune_skips_when_cloud_has_slug_with_different_uid() {
        let tmp = TempDir::new().unwrap();
        write_manifest(
            tmp.path(),
            r#"
companies:
  alpha:
    name: "Alpha"
    path: "companies/alpha"
    cloud_uid: "cmp_OLD"
    bucket_name: "hq-vault-cmp-old"
"#,
        );
        let mut entities = BTreeMap::new();
        entities.insert(
            "cmp_NEW".to_string(),
            company_entity("cmp_NEW", "alpha", Some("Alpha")),
        );
        let mut entries = vec![local_full(
            "alpha",
            tmp.path(),
            true,
            None,
            Some("cmp_OLD"),
            Some("hq-vault-cmp-old"),
        )];

        let pruned = prune_dangling_cloud_uids(tmp.path(), &mut entries, &entities, true);
        assert_eq!(pruned, 0);
        assert_eq!(entries[0].cloud_uid.as_deref(), Some("cmp_OLD"));
    }
}
