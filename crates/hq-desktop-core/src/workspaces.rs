//! Local workspace enumeration and manifest helpers.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::config::{HqConfig, MenubarPrefs};
use crate::journal::read_journal;
use crate::logfile::log;
use crate::paths;

// ── Public types ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum WorkspaceKind {
    Personal,
    Company,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum WorkspaceState {
    /// The user's personal vault. Always shown; local folder optional.
    Personal,
    /// Cloud entity + local folder both present, manifest matches cloud truth.
    Synced,
    /// Cloud entity exists; no local folder yet.
    CloudOnly,
    /// Local folder exists; no manifest cloud_uid AND no matching cloud membership.
    LocalOnly,
    /// Manifest declares a cloud_uid that doesn't match cloud reality.
    /// Reconnect to reconcile — only surfaced when cloud_reachable=true.
    Broken,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub slug: String,
    pub display_name: String,
    pub kind: WorkspaceKind,
    pub state: WorkspaceState,
    pub cloud_uid: Option<String>,
    pub bucket_name: Option<String>,
    pub has_local_folder: bool,
    pub local_path: Option<String>,
    pub membership_status: Option<String>,
    pub role: Option<String>,
    pub last_synced_at: Option<String>,
    /// Human-readable diagnostic when state is Broken. UI surfaces in the tooltip.
    pub broken_reason: Option<String>,
    /// Who created the membership invite (`invitedBy` on the vault membership
    /// row — a `prs_*` person uid). Only meaningful while
    /// `membership_status == "pending"`; the V4 Companies surface renders the
    /// invite row from it.
    pub invited_by: Option<String>,
    /// ISO timestamp the invite was created (`invitedAt` on the membership row).
    pub invited_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacesResult {
    pub workspaces: Vec<Workspace>,
    pub cloud_reachable: bool,
    pub error: Option<String>,
    pub hq_folder_path: String,
    /// Top-level manifest parse/IO error. Non-null means the user has a
    /// `companies/manifest.yaml` we couldn't read — UI surfaces a soft
    /// notice and falls back to folder enumeration.
    pub manifest_error: Option<String>,
}

// ── Internal: local company discovery ─────────────────────────────────────────

/// One entry from `companies/manifest.yaml`, resolved to absolute paths.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalCompanyEntry {
    pub slug: String,
    pub display_name: Option<String>,
    pub path: PathBuf,
    pub dir_exists: bool,
    /// Manifest-recorded cloud entity UID. None when the entry is local-only
    /// or when discovered via folder-enumeration fallback.
    pub cloud_uid: Option<String>,
    /// Manifest-recorded S3 bucket name. Always paired with `cloud_uid`.
    pub bucket_name: Option<String>,
}

/// Top-level shape of `companies/manifest.yaml`. Only `companies` is consumed;
/// other top-level fields are tolerated and ignored (forward compat with HQ
/// scripts that may grow new top-level keys).
#[derive(Debug, Deserialize)]
pub struct CompaniesManifest {
    #[serde(default)]
    pub companies: BTreeMap<String, CompanyManifestEntry>,
}

#[derive(Debug, Deserialize)]
pub struct CompanyManifestEntry {
    #[serde(default)]
    pub name: Option<String>,
    /// Path relative to `hq_root`. Defaults to `companies/{slug}` when absent.
    #[serde(default)]
    pub path: Option<String>,
    /// Cloud entity UID (`cmp_*`), written by `connect_workspace_to_cloud`.
    /// When present, the manifest is the canonical record of "this folder
    /// is connected to that cloud entity."
    #[serde(default)]
    pub cloud_uid: Option<String>,
    /// S3 bucket name (`hq-vault-cmp-{uid}`), written alongside `cloud_uid`.
    #[serde(default)]
    pub bucket_name: Option<String>,
}

/// Resolve hq_root from menubar.json + config.json (mirrors sync.rs without
/// the async surface so we can call it before any vault traffic).
pub fn resolve_hq_folder_path() -> Result<PathBuf, String> {
    let config_path = paths::config_json_path()?;
    let menubar_path = paths::menubar_json_path()?;

    let menubar_prefs: Option<MenubarPrefs> = if menubar_path.exists() {
        std::fs::read_to_string(&menubar_path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
    } else {
        None
    };

    let config: Option<HqConfig> = if config_path.exists() {
        std::fs::read_to_string(&config_path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
    } else {
        None
    };

    Ok(paths::resolve_hq_folder(
        config.as_ref().and_then(|c| c.hq_folder_path.as_deref()),
        menubar_prefs.as_ref().and_then(|p| p.hq_path.as_deref()),
    ))
}

/// Outcome of attempting to read the manifest. Distinguishes "no manifest
/// (use folder fallback)" from "manifest exists but is broken (surface error)".
pub enum ManifestLoad {
    Present(Vec<LocalCompanyEntry>),
    Absent,
    Failed(String),
}

/// Read the manifest into a list of LocalCompanyEntry.
///
/// Three outcomes are distinguished:
///   - `Present(entries)`  — manifest parsed cleanly
///   - `Absent`            — file doesn't exist; caller falls back to dir enumeration
///   - `Failed(reason)`    — file exists but unreadable/unparseable; caller
///     surfaces the error AND still falls back to dir enumeration
pub fn read_manifest(hq_root: &Path) -> ManifestLoad {
    let manifest_path = hq_root.join("companies").join("manifest.yaml");
    let bytes = match std::fs::read(&manifest_path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return ManifestLoad::Absent,
        Err(e) => return ManifestLoad::Failed(format!("read {}: {e}", manifest_path.display())),
    };
    let parsed: CompaniesManifest = match serde_yaml::from_slice(&bytes) {
        Ok(p) => p,
        Err(e) => {
            return ManifestLoad::Failed(format!("parse {}: {e}", manifest_path.display()));
        }
    };
    let entries = parsed
        .companies
        .into_iter()
        .map(|(slug, entry)| {
            let path = entry
                .path
                .as_deref()
                .map(|p| hq_root.join(p))
                .unwrap_or_else(|| hq_root.join("companies").join(&slug));
            LocalCompanyEntry {
                dir_exists: path.is_dir(),
                display_name: entry.name,
                cloud_uid: entry.cloud_uid,
                bucket_name: entry.bucket_name,
                slug,
                path,
            }
        })
        .collect();
    ManifestLoad::Present(entries)
}

/// Discover local companies. Manifest is canonical when present + parseable;
/// otherwise (or in addition to a parse error) we fall back to enumerating
/// `companies/*` directories.
///
/// Scaffolding entries (slug starts with `_`, e.g. `_template`) are dropped
/// from the enumeration fallback — they're an HQ convention for boilerplate,
/// not real companies. Manifest mode trusts the manifest fully.
///
/// Returns `(entries, manifest_error)` — the error is non-None only when the
/// manifest exists but couldn't be parsed.
pub fn discover_local_companies(hq_root: &Path) -> (Vec<LocalCompanyEntry>, Option<String>) {
    let raw = match read_manifest(hq_root) {
        ManifestLoad::Present(entries) => {
            // Manifest is canonical for the entries it lists, but the user can
            // also have on-disk company folders that pre-date the manifest or
            // were added by tools that don't update it. Union those in as
            // unconnected entries so they're still visible (and connectable)
            // in the UI — otherwise a folder-only company shows as Cloud Only
            // (via memberships pass) when it actually exists locally.
            let mut union = entries;
            let known: std::collections::HashSet<String> =
                union.iter().map(|e| e.slug.clone()).collect();
            for extra in folder_enumeration_fallback(hq_root) {
                if !known.contains(&extra.slug) {
                    union.push(extra);
                }
            }
            (union, None)
        }
        ManifestLoad::Absent => (folder_enumeration_fallback(hq_root), None),
        ManifestLoad::Failed(err) => {
            log(
                "workspaces",
                &format!("manifest unreadable, using folder fallback: {err}"),
            );
            (folder_enumeration_fallback(hq_root), Some(err))
        }
    };

    // Drop slug="personal" from the company list. The personal vault row
    // (assembled separately with kind=Personal, state=Personal) is the
    // canonical surface for the user's personal HQ — a manifest-declared
    // `personal` company would render as a duplicate Local Only row, and
    // its Connect button can't succeed (the Rust guard rejects slug=="personal"
    // because the personal vault auto-provisions via the person entity, not
    // the company-creation flow). Filter here so the duplicate never appears.
    let (mut entries, manifest_err) = raw;
    entries.retain(|e| e.slug != "personal");
    (entries, manifest_err)
}

pub fn folder_enumeration_fallback(hq_root: &Path) -> Vec<LocalCompanyEntry> {
    list_local_company_folders(hq_root)
        .into_iter()
        .filter(|(slug, _)| !slug.starts_with('_'))
        .map(|(slug, path)| {
            let display_name = read_local_company_name(hq_root, &slug);
            LocalCompanyEntry {
                slug,
                display_name,
                dir_exists: true,
                path,
                cloud_uid: None,
                bucket_name: None,
            }
        })
        .collect()
}

/// Walk `$hq_root/companies/*` and return (slug, abs-path) for every directory.
pub fn list_local_company_folders(hq_root: &Path) -> Vec<(String, PathBuf)> {
    let companies_dir = hq_root.join("companies");
    let entries = match std::fs::read_dir(&companies_dir) {
        Ok(e) => e,
        Err(_) => return vec![],
    };

    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = match entry.file_name().into_string() {
            Ok(n) => n,
            Err(_) => continue,
        };
        if name.starts_with('.') {
            continue;
        }
        out.push((name, path));
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

/// Try `$hq_root/companies/{slug}/company.yaml` for a friendly `name`.
pub fn read_local_company_name(hq_root: &Path, slug: &str) -> Option<String> {
    #[derive(serde::Deserialize)]
    struct YamlSlice {
        name: Option<String>,
    }
    let yaml_path = hq_root.join("companies").join(slug).join("company.yaml");
    let bytes = std::fs::read(&yaml_path).ok()?;
    let parsed: YamlSlice = serde_yaml::from_slice(&bytes).ok()?;
    parsed.name
}

pub fn last_synced_at(slug: &str) -> Option<String> {
    let j = read_journal(slug).ok()?;
    if j.last_sync.is_empty() {
        None
    } else {
        Some(j.last_sync)
    }
}

pub fn humanize_slug(slug: &str) -> String {
    slug.split('-')
        .map(|w| {
            let mut chars = w.chars();
            match chars.next() {
                Some(c) => c.to_uppercase().chain(chars).collect::<String>(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

// ── Manifest patching ─────────────────────────────────────────────────────────

/// Patch `companies/manifest.yaml` to record `cloud_uid` and `bucket_name`
/// for the given slug. Returns Err on read/parse/write failures; callers treat
/// this as non-fatal (per-folder `.hq/config.json` is the authoritative
/// runtime record).
///
/// **Comments and ordering**: serde_yaml round-trips Mapping order but does
/// NOT preserve YAML comments. The HQ-side `/newcompany` script writes a
/// header comment we'll lose on first patch — acceptable trade-off given the
/// alternative (manual text patching) is fragile across formatting variants.
#[cfg_attr(not(test), allow(dead_code))] // Only used by tests; production was C3-migrated to the CLI
pub fn patch_manifest_with_cloud_info(
    manifest_path: &Path,
    slug: &str,
    cloud_uid: &str,
    bucket_name: &str,
) -> Result<(), String> {
    let bytes = std::fs::read(manifest_path).map_err(|e| format!("read manifest: {e}"))?;
    let mut value: serde_yaml::Value =
        serde_yaml::from_slice(&bytes).map_err(|e| format!("parse manifest: {e}"))?;

    let companies_key = serde_yaml::Value::String("companies".to_string());
    let mapping = value
        .as_mapping_mut()
        .ok_or_else(|| "manifest root is not a mapping".to_string())?;
    let companies = mapping
        .get_mut(&companies_key)
        .and_then(|v| v.as_mapping_mut())
        .ok_or_else(|| "manifest has no `companies` mapping".to_string())?;

    let slug_key = serde_yaml::Value::String(slug.to_string());
    let entry = companies
        .get_mut(&slug_key)
        .and_then(|v| v.as_mapping_mut())
        .ok_or_else(|| format!("manifest has no entry for slug '{slug}'"))?;

    entry.insert(
        serde_yaml::Value::String("cloud_uid".to_string()),
        serde_yaml::Value::String(cloud_uid.to_string()),
    );
    entry.insert(
        serde_yaml::Value::String("bucket_name".to_string()),
        serde_yaml::Value::String(bucket_name.to_string()),
    );

    let serialized =
        serde_yaml::to_string(&value).map_err(|e| format!("serialize manifest: {e}"))?;

    // Atomic write: tmp → rename. Any failure leaves the original intact.
    let tmp = manifest_path.with_extension("yaml.tmp");
    std::fs::write(&tmp, &serialized).map_err(|e| format!("write tmp manifest: {e}"))?;
    std::fs::rename(&tmp, manifest_path).map_err(|e| format!("rename manifest: {e}"))?;

    Ok(())
}

/// Append a brand-new entry to `companies` for `slug`, optionally stamping it
/// with cloud info. Used when sync detects a local folder (or cloud-only
/// company that was just downloaded) without a manifest entry — the manifest
/// needs to learn about the folder so subsequent loads don't miss it.
///
/// Schema mirrors the hq-core template's per-company fields so manifests
/// produced by the installer, by `/newcompany`, and by this reconciler are
/// shape-compatible:
///
/// ```yaml
/// {slug}:
///   name: {display_name}
///   goal: ""
///   path: companies/{slug}
///   sources: []
///   repos: []
///   knowledge: companies/{slug}/knowledge/
///   qmd_collections: [{slug}]
///   # Optional — only written when both Some(...)
///   cloud_uid: {cloud_uid}
///   bucket_name: {bucket_name}
/// ```
///
/// Idempotent: if `slug` already exists, this is a no-op (caller should use
/// `patch_manifest_with_cloud_info` to add cloud info to an existing entry).
pub fn add_manifest_entry_for_synced_company(
    manifest_path: &Path,
    slug: &str,
    display_name: &str,
    cloud_uid: Option<&str>,
    bucket_name: Option<&str>,
) -> Result<(), String> {
    let bytes = std::fs::read(manifest_path).map_err(|e| format!("read manifest: {e}"))?;
    let mut value: serde_yaml::Value =
        serde_yaml::from_slice(&bytes).map_err(|e| format!("parse manifest: {e}"))?;

    let companies_key = serde_yaml::Value::String("companies".to_string());
    let mapping = value
        .as_mapping_mut()
        .ok_or_else(|| "manifest root is not a mapping".to_string())?;
    if !mapping.contains_key(&companies_key) {
        mapping.insert(
            companies_key.clone(),
            serde_yaml::Value::Mapping(serde_yaml::Mapping::new()),
        );
    }
    let companies = mapping
        .get_mut(&companies_key)
        .and_then(|v| v.as_mapping_mut())
        .ok_or_else(|| "manifest `companies` key is not a mapping".to_string())?;

    let slug_key = serde_yaml::Value::String(slug.to_string());
    if companies.contains_key(&slug_key) {
        // Caller bug — they should patch instead of add. Soft-no-op so we
        // don't regress the existing entry's other fields.
        return Ok(());
    }

    let mut entry = serde_yaml::Mapping::new();
    let s = |v: &str| serde_yaml::Value::String(v.to_string());
    entry.insert(s("name"), s(display_name));
    entry.insert(s("goal"), s(""));
    entry.insert(s("path"), s(&format!("companies/{slug}")));
    entry.insert(s("sources"), serde_yaml::Value::Sequence(Vec::new()));
    entry.insert(s("repos"), serde_yaml::Value::Sequence(Vec::new()));
    entry.insert(s("knowledge"), s(&format!("companies/{slug}/knowledge/")));
    entry.insert(
        s("qmd_collections"),
        serde_yaml::Value::Sequence(vec![s(slug)]),
    );
    if let (Some(uid), Some(bucket)) = (cloud_uid, bucket_name) {
        entry.insert(s("cloud_uid"), s(uid));
        entry.insert(s("bucket_name"), s(bucket));
    }
    companies.insert(slug_key, serde_yaml::Value::Mapping(entry));

    let serialized =
        serde_yaml::to_string(&value).map_err(|e| format!("serialize manifest: {e}"))?;

    let tmp = manifest_path.with_extension("yaml.tmp");
    std::fs::write(&tmp, &serialized).map_err(|e| format!("write tmp manifest: {e}"))?;
    std::fs::rename(&tmp, manifest_path).map_err(|e| format!("rename manifest: {e}"))?;

    Ok(())
}

/// Strip `cloud_uid` + `bucket_name` from a slug's manifest entry. Used when
/// we detect the cloud entity for that slug has been deleted (manifest had a
/// cloud_uid, cloud is reachable, no entity matches the slug). The entry stays
/// in the manifest with its other fields intact; only the cloud pointers are
/// removed so the workspace falls back to LocalOnly.
///
/// Idempotent: missing slug entries or already-clean entries are a no-op. No
/// write is performed if neither key was present.
pub fn strip_manifest_cloud_info(manifest_path: &Path, slug: &str) -> Result<(), String> {
    let bytes = std::fs::read(manifest_path).map_err(|e| format!("read manifest: {e}"))?;
    let mut value: serde_yaml::Value =
        serde_yaml::from_slice(&bytes).map_err(|e| format!("parse manifest: {e}"))?;

    let companies_key = serde_yaml::Value::String("companies".to_string());
    let mapping = value
        .as_mapping_mut()
        .ok_or_else(|| "manifest root is not a mapping".to_string())?;
    let companies = match mapping
        .get_mut(&companies_key)
        .and_then(|v| v.as_mapping_mut())
    {
        Some(c) => c,
        None => return Ok(()),
    };

    let slug_key = serde_yaml::Value::String(slug.to_string());
    let entry = match companies
        .get_mut(&slug_key)
        .and_then(|v| v.as_mapping_mut())
    {
        Some(e) => e,
        None => return Ok(()),
    };

    let cloud_uid_key = serde_yaml::Value::String("cloud_uid".to_string());
    let bucket_key = serde_yaml::Value::String("bucket_name".to_string());
    let removed_uid = entry.remove(&cloud_uid_key).is_some();
    let removed_bucket = entry.remove(&bucket_key).is_some();
    if !removed_uid && !removed_bucket {
        return Ok(());
    }

    let serialized =
        serde_yaml::to_string(&value).map_err(|e| format!("serialize manifest: {e}"))?;

    let tmp = manifest_path.with_extension("yaml.tmp");
    std::fs::write(&tmp, &serialized).map_err(|e| format!("write tmp manifest: {e}"))?;
    std::fs::rename(&tmp, manifest_path).map_err(|e| format!("rename manifest: {e}"))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn write_manifest(hq_root: &Path, contents: &str) {
        let dir = hq_root.join("companies");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("manifest.yaml"), contents).unwrap();
    }

    #[test]
    fn humanize_slug_basic() {
        assert_eq!(humanize_slug("indigo"), "Indigo");
        assert_eq!(humanize_slug("synesis-strategy"), "Synesis Strategy");
        assert_eq!(humanize_slug(""), "");
    }

    // ── assemble_workspaces (manifest-first) ──────────────────────────────

    #[test]
    fn discover_uses_manifest_when_present() {
        let tmp = TempDir::new().unwrap();
        write_manifest(
            tmp.path(),
            r#"
companies:
  alpha:
    name: "Alpha Co"
    path: "companies/alpha"
  beta:
    name: "Beta"
    path: "companies/beta"
"#,
        );
        std::fs::create_dir_all(tmp.path().join("companies/alpha")).unwrap();

        let (entries, err) = discover_local_companies(tmp.path());
        assert!(err.is_none());
        assert_eq!(entries.len(), 2);
        let alpha = entries.iter().find(|e| e.slug == "alpha").unwrap();
        assert!(alpha.dir_exists);
        let beta = entries.iter().find(|e| e.slug == "beta").unwrap();
        assert!(!beta.dir_exists);
    }

    #[test]
    fn discover_reads_manifest_cloud_fields() {
        let tmp = TempDir::new().unwrap();
        write_manifest(
            tmp.path(),
            r#"
companies:
  alpha:
    name: "Alpha"
    path: "companies/alpha"
    cloud_uid: "cmp_01ABC"
    bucket_name: "hq-vault-cmp-01ABC"
"#,
        );
        std::fs::create_dir_all(tmp.path().join("companies/alpha")).unwrap();

        let (entries, _) = discover_local_companies(tmp.path());
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].cloud_uid.as_deref(), Some("cmp_01ABC"));
        assert_eq!(
            entries[0].bucket_name.as_deref(),
            Some("hq-vault-cmp-01ABC")
        );
    }

    /// Broken manifest YAML → fall back to dir enumeration AND surface error.
    /// Uses an unclosed single-quoted scalar — YAML's parser must reject this
    /// (it's not just a missing `companies:` key, which serde_yaml would
    /// happily deserialize as an empty manifest via #[serde(default)]).
    #[test]
    fn discover_broken_manifest_falls_back_with_error() {
        let tmp = TempDir::new().unwrap();
        write_manifest(
            tmp.path(),
            "companies:\n  acme:\n    name: 'unclosed scalar\n",
        );
        std::fs::create_dir_all(tmp.path().join("companies/foo")).unwrap();

        let (entries, err) = discover_local_companies(tmp.path());
        assert!(
            err.is_some(),
            "unclosed quote must fail YAML parse, got entries={entries:?}"
        );
        assert!(err.as_ref().unwrap().contains("parse"));
        let slugs: Vec<&str> = entries.iter().map(|e| e.slug.as_str()).collect();
        assert_eq!(slugs, vec!["foo"]);
    }

    #[test]
    fn discover_no_manifest_no_error() {
        let tmp = TempDir::new().unwrap();
        let (_, err) = discover_local_companies(tmp.path());
        assert!(err.is_none());
    }

    #[test]
    fn discover_fallback_skips_underscore_scaffolding() {
        let tmp = TempDir::new().unwrap();
        std::fs::create_dir_all(tmp.path().join("companies/_template")).unwrap();
        std::fs::create_dir_all(tmp.path().join("companies/real-co")).unwrap();
        let (entries, _) = discover_local_companies(tmp.path());
        let slugs: Vec<&str> = entries.iter().map(|e| e.slug.as_str()).collect();
        assert_eq!(slugs, vec!["real-co"]);
    }

    #[test]
    fn discover_manifest_mode_keeps_underscore_entries() {
        let tmp = TempDir::new().unwrap();
        write_manifest(
            tmp.path(),
            r#"
companies:
  _archive:
    name: "Archive"
    path: "companies/_archive"
"#,
        );
        std::fs::create_dir_all(tmp.path().join("companies/_archive")).unwrap();
        let (entries, _) = discover_local_companies(tmp.path());
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].slug, "_archive");
    }

    #[test]
    fn list_local_company_folders_skips_dotfiles_and_files() {
        let tmp = TempDir::new().unwrap();
        std::fs::create_dir_all(tmp.path().join("companies/foo")).unwrap();
        std::fs::create_dir_all(tmp.path().join("companies/.hidden")).unwrap();
        std::fs::write(tmp.path().join("companies/loose-file.txt"), "x").unwrap();
        let folders = list_local_company_folders(tmp.path());
        let names: Vec<&str> = folders.iter().map(|(s, _)| s.as_str()).collect();
        assert_eq!(names, vec!["foo"]);
    }

    // ── patch_manifest_with_cloud_info ────────────────────────────────────

    #[test]
    fn patch_manifest_writes_cloud_uid_and_bucket() {
        let tmp = TempDir::new().unwrap();
        write_manifest(
            tmp.path(),
            r#"
companies:
  alpha:
    name: "Alpha"
    path: "companies/alpha"
"#,
        );
        let manifest_path = tmp.path().join("companies").join("manifest.yaml");

        patch_manifest_with_cloud_info(&manifest_path, "alpha", "cmp_NEW", "hq-vault-cmp-NEW")
            .unwrap();

        let (entries, _) = discover_local_companies(tmp.path());
        let alpha = entries.iter().find(|e| e.slug == "alpha").unwrap();
        assert_eq!(alpha.cloud_uid.as_deref(), Some("cmp_NEW"));
        assert_eq!(alpha.bucket_name.as_deref(), Some("hq-vault-cmp-NEW"));
        assert_eq!(alpha.display_name.as_deref(), Some("Alpha"));
    }

    /// Reconnect after Broken: existing cloud_uid is overwritten cleanly.
    #[test]
    fn patch_manifest_overwrites_existing_cloud_uid() {
        let tmp = TempDir::new().unwrap();
        write_manifest(
            tmp.path(),
            r#"
companies:
  alpha:
    name: "Alpha"
    path: "companies/alpha"
    cloud_uid: "cmp_OLD"
    bucket_name: "hq-vault-cmp-OLD"
"#,
        );
        let manifest_path = tmp.path().join("companies").join("manifest.yaml");

        patch_manifest_with_cloud_info(&manifest_path, "alpha", "cmp_NEW", "hq-vault-cmp-NEW")
            .unwrap();

        let (entries, _) = discover_local_companies(tmp.path());
        let alpha = entries.iter().find(|e| e.slug == "alpha").unwrap();
        assert_eq!(alpha.cloud_uid.as_deref(), Some("cmp_NEW"));
        assert_eq!(alpha.bucket_name.as_deref(), Some("hq-vault-cmp-NEW"));
    }

    // ── strip_manifest_cloud_info / prune_dangling_cloud_uids ─────────────

    #[test]
    fn strip_manifest_cloud_info_removes_keys_keeps_other_fields() {
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
        let manifest_path = tmp.path().join("companies").join("manifest.yaml");
        strip_manifest_cloud_info(&manifest_path, "alpha").unwrap();

        let (entries, _) = discover_local_companies(tmp.path());
        let alpha = entries.iter().find(|e| e.slug == "alpha").unwrap();
        assert!(alpha.cloud_uid.is_none());
        assert!(alpha.bucket_name.is_none());
        assert_eq!(alpha.display_name.as_deref(), Some("Alpha"));
    }

    #[test]
    fn strip_manifest_cloud_info_idempotent_when_no_cloud_keys() {
        let tmp = TempDir::new().unwrap();
        write_manifest(
            tmp.path(),
            "companies:\n  alpha:\n    name: \"Alpha\"\n    path: \"companies/alpha\"\n",
        );
        let manifest_path = tmp.path().join("companies").join("manifest.yaml");
        strip_manifest_cloud_info(&manifest_path, "alpha").unwrap();
        strip_manifest_cloud_info(&manifest_path, "missing-slug").unwrap();
    }

    #[test]
    fn patch_manifest_unknown_slug_errors() {
        let tmp = TempDir::new().unwrap();
        write_manifest(
            tmp.path(),
            r#"
companies:
  alpha:
    name: "Alpha"
"#,
        );
        let manifest_path = tmp.path().join("companies").join("manifest.yaml");
        let err = patch_manifest_with_cloud_info(&manifest_path, "ghost", "cmp_X", "bucket-X")
            .expect_err("missing slug must error");
        assert!(err.contains("ghost"));
    }

    #[test]
    fn patch_manifest_without_companies_key_errors() {
        let tmp = TempDir::new().unwrap();
        write_manifest(tmp.path(), "version: 1\n");
        let manifest_path = tmp.path().join("companies").join("manifest.yaml");
        let err = patch_manifest_with_cloud_info(&manifest_path, "any", "cmp_X", "bucket-X")
            .expect_err("missing companies key must error");
        assert!(err.to_lowercase().contains("companies"));
    }

    #[test]
    fn patch_manifest_cleans_up_tmp() {
        let tmp = TempDir::new().unwrap();
        write_manifest(
            tmp.path(),
            r#"
companies:
  alpha:
    name: "Alpha"
"#,
        );
        let manifest_path = tmp.path().join("companies").join("manifest.yaml");
        patch_manifest_with_cloud_info(&manifest_path, "alpha", "cmp_X", "bucket-X").unwrap();
        let tmp_path = manifest_path.with_extension("yaml.tmp");
        assert!(!tmp_path.exists());
    }

    // ── add_manifest_entry_for_synced_company ─────────────────────────────

    #[test]
    fn add_manifest_entry_writes_full_template_schema_without_cloud() {
        let tmp = TempDir::new().unwrap();
        write_manifest(tmp.path(), "companies:\n  personal:\n    name: Personal\n");
        let manifest_path = tmp.path().join("companies").join("manifest.yaml");

        add_manifest_entry_for_synced_company(&manifest_path, "voyage", "Voyage", None, None)
            .unwrap();

        let raw = std::fs::read_to_string(&manifest_path).unwrap();
        let parsed: serde_yaml::Value = serde_yaml::from_str(&raw).unwrap();
        let entry = parsed
            .get("companies")
            .and_then(|c| c.get("voyage"))
            .and_then(|e| e.as_mapping())
            .expect("voyage entry must exist");

        assert_eq!(entry.get("name").and_then(|v| v.as_str()), Some("Voyage"));
        assert_eq!(entry.get("goal").and_then(|v| v.as_str()), Some(""));
        assert_eq!(
            entry.get("path").and_then(|v| v.as_str()),
            Some("companies/voyage")
        );
        assert!(
            entry
                .get("sources")
                .and_then(|v| v.as_sequence())
                .map(|s| s.is_empty())
                .unwrap_or(false),
            "sources must be empty list"
        );
        assert!(
            entry
                .get("repos")
                .and_then(|v| v.as_sequence())
                .map(|s| s.is_empty())
                .unwrap_or(false),
            "repos must be empty list"
        );
        assert_eq!(
            entry.get("knowledge").and_then(|v| v.as_str()),
            Some("companies/voyage/knowledge/")
        );
        let qmd: Vec<&str> = entry
            .get("qmd_collections")
            .and_then(|v| v.as_sequence())
            .map(|s| s.iter().filter_map(|x| x.as_str()).collect())
            .unwrap_or_default();
        assert_eq!(qmd, vec!["voyage"]);

        // Cloud fields must NOT be present when both args are None.
        assert!(entry.get("cloud_uid").is_none());
        assert!(entry.get("bucket_name").is_none());
    }

    #[test]
    fn add_manifest_entry_includes_cloud_info_when_both_supplied() {
        let tmp = TempDir::new().unwrap();
        write_manifest(tmp.path(), "companies:\n  personal:\n    name: Personal\n");
        let manifest_path = tmp.path().join("companies").join("manifest.yaml");

        add_manifest_entry_for_synced_company(
            &manifest_path,
            "voyage",
            "Voyage",
            Some("cmp_01ABC"),
            Some("hq-vault-cmp-01abc"),
        )
        .unwrap();

        let (entries, _) = discover_local_companies(tmp.path());
        let voyage = entries
            .iter()
            .find(|e| e.slug == "voyage")
            .expect("voyage must be in manifest");
        assert_eq!(voyage.cloud_uid.as_deref(), Some("cmp_01ABC"));
        assert_eq!(voyage.bucket_name.as_deref(), Some("hq-vault-cmp-01abc"));
        assert_eq!(voyage.display_name.as_deref(), Some("Voyage"));
    }

    #[test]
    fn add_manifest_entry_omits_cloud_fields_if_only_one_supplied() {
        let tmp = TempDir::new().unwrap();
        write_manifest(tmp.path(), "companies:\n  personal:\n    name: Personal\n");
        let manifest_path = tmp.path().join("companies").join("manifest.yaml");

        // Only cloud_uid supplied (no bucket) — entry should omit both for safety.
        add_manifest_entry_for_synced_company(
            &manifest_path,
            "voyage",
            "Voyage",
            Some("cmp_01ABC"),
            None,
        )
        .unwrap();

        let raw = std::fs::read_to_string(&manifest_path).unwrap();
        let parsed: serde_yaml::Value = serde_yaml::from_str(&raw).unwrap();
        let entry = parsed
            .get("companies")
            .and_then(|c| c.get("voyage"))
            .and_then(|e| e.as_mapping())
            .expect("voyage entry must exist");
        assert!(entry.get("cloud_uid").is_none());
        assert!(entry.get("bucket_name").is_none());
    }

    #[test]
    fn add_manifest_entry_idempotent_when_slug_exists() {
        let tmp = TempDir::new().unwrap();
        write_manifest(
            tmp.path(),
            r#"
companies:
  alpha:
    name: "Original Alpha"
    custom_field: "user-edit"
"#,
        );
        let manifest_path = tmp.path().join("companies").join("manifest.yaml");

        add_manifest_entry_for_synced_company(
            &manifest_path,
            "alpha",
            "Replacement Alpha",
            Some("cmp_X"),
            Some("bucket-X"),
        )
        .unwrap();

        let raw = std::fs::read_to_string(&manifest_path).unwrap();
        let parsed: serde_yaml::Value = serde_yaml::from_str(&raw).unwrap();
        let entry = parsed
            .get("companies")
            .and_then(|c| c.get("alpha"))
            .and_then(|e| e.as_mapping())
            .expect("alpha entry must exist");
        assert_eq!(
            entry.get("name").and_then(|v| v.as_str()),
            Some("Original Alpha")
        );
        assert_eq!(
            entry.get("custom_field").and_then(|v| v.as_str()),
            Some("user-edit")
        );
        assert!(entry.get("cloud_uid").is_none());
    }

    #[test]
    fn add_manifest_entry_creates_companies_key_when_absent() {
        let tmp = TempDir::new().unwrap();
        write_manifest(tmp.path(), "version: 1\n");
        let manifest_path = tmp.path().join("companies").join("manifest.yaml");

        add_manifest_entry_for_synced_company(&manifest_path, "fresh", "Fresh", None, None)
            .unwrap();

        let (entries, _) = discover_local_companies(tmp.path());
        assert!(entries.iter().any(|e| e.slug == "fresh"));
    }
}
