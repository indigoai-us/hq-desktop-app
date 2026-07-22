//! Detect and provision unprovisioned `cloud: true` companies.
//!
//! `provision_missing_companies` walks `$HQ/companies/*/company.yaml`, keeps
//! entries where `cloud: true`, and handles three cases:
//!   A. a manifest/config/YAML UID is present → verify that exact entity with
//!      `GET /entity/{uid}`; if it is gone, remove stale config and re-provision.
//!   B. no UID is recorded → resolve within the authenticated caller's namespace
//!      via `GET /entity/check-slug/me`, never the global by-slug route.
//!   C. caller-scoped lookup misses → delegate to `hq cloud provision company <slug>` (the
//!      canonical CLI subcommand from `@indigoai-us/hq-cli`), which performs
//!      GET-then-POST idempotency, atomic manifest patch, atomic
//!      `.hq/config.json` write, AND triggers an initial sync via `share()`.
//!
//! `company.yaml` is NEVER written back — the file is read-only from this module.
//!
//! ## Why Paths A + B stay inline (not CLI)
//!
//! Path A is a pure local-cache fast path: if `.hq/config.json` already exists
//! and the cloud entity is still alive, there is nothing to do. Spawning the
//! CLI would re-run idempotency checks the local cache already short-circuits.
//!
//! Path B is a one-shot migration from the legacy `cloudCompanyUid` field
//! that older `hq-installer` versions wrote into `company.yaml`. The CLI has
//! no equivalent of "promote a known UID into a config.json without touching
//! the entity"; it would either reuse-by-slug (different UID) or re-create
//! (also different UID). Keeping the migration inline preserves the legacy
//! UID exactly as recorded.
//!
//! Only the final provision path goes through the CLI — that is where the GET-then-POST,
//! manifest patch, config write, and initial sync all happen behind one
//! canonical implementation.

use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::commands::run_cli_provision::{
    run_cli_provision, CliProvisionError, CliProvisionResult,
};
use crate::commands::vault_client::VaultClient;
use crate::commands::workspaces::{read_manifest, ManifestLoad};

// ── Public types ──────────────────────────────────────────────────────────────

/// Per-company `.hq/config.json` schema (pinned — plan.md §Step 5).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanyConfig {
    pub company_uid: String,
    pub company_slug: String,
    pub bucket_name: String,
    pub vault_api_url: String,
}

/// Returned by `provision_missing_companies` for each newly-provisioned
/// (or legacy-migrated) company.
#[derive(Debug, Clone)]
pub struct ProvisionedCompany {
    pub slug: String,
    pub uid: String,
    pub bucket_name: String,
}

// ── Internal YAML shape ───────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct CompanyYaml {
    cloud: Option<bool>,
    name: Option<String>,
    /// Legacy field written by earlier versions of hq-installer.
    /// Present means the company was provisioned before `.hq/config.json` was
    /// introduced.  Must not be written back.
    #[serde(rename = "cloudCompanyUid")]
    cloud_company_uid: Option<String>,
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Atomic write: serialize `config` → temp file → rename.
fn write_company_config(config_path: &Path, config: &CompanyConfig) -> Result<(), String> {
    if let Some(parent) = config_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("create_dir_all {}: {e}", parent.display()))?;
    }
    let body =
        serde_json::to_string_pretty(config).map_err(|e| format!("serialize config: {e}"))?;
    let tmp = config_path.with_file_name(format!(".config.json.tmp.{}", std::process::id()));
    std::fs::write(&tmp, &body).map_err(|e| format!("write tmp config: {e}"))?;
    std::fs::rename(&tmp, config_path).map_err(|e| format!("rename config: {e}"))?;
    Ok(())
}

// ── Core logic ────────────────────────────────────────────────────────────────

/// Walk `$hq_root/companies/*/company.yaml`, detect unprovisioned `cloud: true`
/// companies, provision them, and return the list of newly-provisioned entries.
///
/// `vault_api_url` is written verbatim into each company's `.hq/config.json`.
///
/// Production wrapper: delegates Path C to the canonical `hq cloud provision`
/// CLI subprocess via [`run_cli_provision`]. Tests use
/// [`provision_missing_companies_with_provisioner`] with a mock to exercise the
/// Rust-level dispatch logic without spawning the real binary.
pub async fn provision_missing_companies(
    hq_root: &Path,
    vault: &VaultClient,
    vault_api_url: &str,
) -> Result<Vec<ProvisionedCompany>, String> {
    provision_missing_companies_with_provisioner(
        hq_root,
        vault,
        vault_api_url,
        |slug, name, root| async move { run_cli_provision(&slug, name.as_deref(), &root).await },
    )
    .await
}

/// Test seam for [`provision_missing_companies`].
///
/// `provisioner` is the Path C dispatch — in production it wraps
/// [`run_cli_provision`], which shells out to `hq cloud provision company`.
/// Tests pass closures that return canned [`CliProvisionResult`] values so the
/// Rust dispatch logic (Path A/B/C selection, error propagation, partial-result
/// handling on `CliProvisionError::Sync`) can be exercised without spawning the
/// real CLI binary.
///
/// Arguments are owned (`String`, `PathBuf`) so the closure's returned future
/// can be `'static` — keeps lifetimes simple at the cost of a few cheap clones
/// per provisioned company (sync is not a hot path).
pub async fn provision_missing_companies_with_provisioner<F, Fut>(
    hq_root: &Path,
    vault: &VaultClient,
    vault_api_url: &str,
    provisioner: F,
) -> Result<Vec<ProvisionedCompany>, String>
where
    F: Fn(String, Option<String>, PathBuf) -> Fut,
    Fut: Future<Output = Result<CliProvisionResult, CliProvisionError>>,
{
    let companies_dir = hq_root.join("companies");
    if !companies_dir.exists() {
        return Ok(vec![]);
    }

    let entries = std::fs::read_dir(&companies_dir)
        .map_err(|e| format!("read companies dir {}: {e}", companies_dir.display()))?;

    // `companies/manifest.yaml` is the canonical local binding. Keep its UID
    // ahead of the per-folder cache and legacy YAML so a same-slug entity owned
    // by someone else can never redirect this sync to the wrong company.
    // A malformed manifest is intentionally not fatal here: the caller-scoped
    // lookup below remains safe and lets a sync repair its runtime cache.
    let manifest_uids: HashMap<String, String> = match read_manifest(hq_root) {
        ManifestLoad::Present(entries) => entries
            .into_iter()
            .filter_map(|entry| entry.cloud_uid.map(|uid| (entry.slug, uid)))
            .collect(),
        ManifestLoad::Absent | ManifestLoad::Failed(_) => HashMap::new(),
    };

    let mut result: Vec<ProvisionedCompany> = Vec::new();

    for entry in entries {
        let entry = entry.map_err(|e| format!("dir entry error: {e}"))?;
        let folder_path = entry.path();
        if !folder_path.is_dir() {
            continue;
        }
        let folder_name = match entry.file_name().into_string() {
            Ok(n) => n,
            Err(_) => continue, // non-UTF-8 folder names are silently skipped
        };

        let yaml_path = folder_path.join("company.yaml");
        if !yaml_path.exists() {
            continue;
        }

        // Read YAML read-only — bytes preserved so SHA256 can be validated by callers
        let yaml_bytes =
            std::fs::read(&yaml_path).map_err(|e| format!("read {}: {e}", yaml_path.display()))?;
        let company_yaml: CompanyYaml = serde_yaml::from_slice(&yaml_bytes)
            .map_err(|e| format!("parse {}: {e}", yaml_path.display()))?;

        if !company_yaml.cloud.unwrap_or(false) {
            continue;
        }

        let hq_config_path: PathBuf = folder_path.join(".hq").join("config.json");
        let manifest_uid = manifest_uids.get(&folder_name).cloned();

        // ── Path A: config.json already present ────────────────────────────────
        if hq_config_path.exists() {
            let config_uid = std::fs::read_to_string(&hq_config_path)
                .ok()
                .and_then(|s| serde_json::from_str::<CompanyConfig>(&s).ok())
                .map(|c| c.company_uid);
            let verified = match manifest_uid.as_deref().or(config_uid.as_deref()) {
                Some(uid) => match vault.find_entity_by_uid(uid).await {
                    Ok(Some(info)) => Ok(!info.deleted),
                    Ok(None) => Ok(false),
                    Err(e) => Err(e),
                },
                // A corrupt cache must not revive the unsafe global route.
                None => vault
                    .find_my_company_by_slug(&folder_name)
                    .await
                    .map(|entity| entity.is_some_and(|entity| !entity.deleted)),
            };
            match verified {
                Ok(true) => continue, // provisioned and verified
                Ok(false) => {
                    // Stale config — entity gone; remove and fall through to re-provision
                    let _ = std::fs::remove_file(&hq_config_path);
                }
                Err(e) => {
                    return Err(format!("vault lookup for '{}': {e}", folder_name));
                }
            }
        }

        // ── Path B: manifest/legacy UID migration ──────────────────────────────
        // The manifest is authoritative when both it and legacy YAML name a
        // UID. Both are exact entity identifiers and cannot be ambiguous.
        if let Some(pinned_uid) = manifest_uid.or(company_yaml.cloud_company_uid) {
            let resolved = match vault.find_entity_by_uid(&pinned_uid).await {
                Ok(Some(info)) if !info.deleted => Ok(Some(info)),
                Ok(_) => Ok(None),
                Err(e) => Err(e),
            };
            match resolved {
                Ok(Some(info)) => {
                    // If the entity has no bucket yet, provision it now — same contract as Path C.
                    let bucket_name = match info.bucket_name {
                        Some(b) => b,
                        None => {
                            vault
                                .provision_bucket(&pinned_uid)
                                .await
                                .map_err(|e| {
                                    format!(
                                        "provision_bucket '{}' uid={pinned_uid}: {e}",
                                        folder_name
                                    )
                                })?
                                .bucket_name
                        }
                    };
                    let cfg = CompanyConfig {
                        company_uid: pinned_uid.clone(),
                        company_slug: folder_name.clone(),
                        bucket_name: bucket_name.clone(),
                        vault_api_url: vault_api_url.to_string(),
                    };
                    write_company_config(&hq_config_path, &cfg)?;
                    result.push(ProvisionedCompany {
                        slug: folder_name,
                        uid: pinned_uid,
                        bucket_name,
                    });
                    continue;
                }
                Ok(None) => {
                    // Pinned UID is gone or tombstoned — fall through to safe lookup/provision.
                }
                Err(e) => {
                    return Err(format!("vault pinned-UID lookup for '{}': {e}", folder_name));
                }
            }
        }

        // ── Path C: caller-scoped slug recovery ───────────────────────────────
        // No local UID is available. Resolve only within the signed-in caller's
        // namespace; the global `/entity/by-slug` endpoint 409s on unrelated
        // same-slug companies and must never abort a full sync.
        match vault.find_my_company_by_slug(&folder_name).await {
            Ok(Some(info)) if !info.deleted => {
                let uid = info.uid;
                let bucket_name = match info.bucket_name {
                    Some(bucket) => bucket,
                    None => {
                        vault
                            .provision_bucket(&uid)
                            .await
                            .map_err(|e| {
                                format!("provision_bucket '{}' uid={uid}: {e}", folder_name)
                            })?
                            .bucket_name
                    }
                };
                write_company_config(
                    &hq_config_path,
                    &CompanyConfig {
                        company_uid: uid.clone(),
                        company_slug: folder_name.clone(),
                        bucket_name: bucket_name.clone(),
                        vault_api_url: vault_api_url.to_string(),
                    },
                )?;
                result.push(ProvisionedCompany {
                    slug: folder_name,
                    uid,
                    bucket_name,
                });
                continue;
            }
            Ok(_) => {}
            Err(e) => {
                return Err(format!(
                    "vault caller-scoped lookup for '{}': {e}",
                    folder_name
                ))
            }
        }

        // ── Path D: unprovisioned — delegate to `hq cloud provision company` ─
        //
        // The CLI subprocess is the canonical source of truth for:
        //   * GET-then-POST entity idempotency
        //   * Atomic `companies/manifest.yaml` patch (cloud_uid + bucket_name)
        //   * Atomic `companies/<slug>/.hq/config.json` write
        //   * Initial sync via `share()` from `@indigoai-us/hq-cloud`
        //
        // We pass through a friendly display `--name` from the YAML when present
        // (the CLI defaults to slug otherwise). On exit code 3 the CLI still
        // writes the config + manifest before failing, and the partial result
        // carries the `cloud_uid` — we record the company so the caller's
        // "newly provisioned" emit fires for UI feedback, then surface the
        // sync error so the operator can investigate.
        //
        // NB: we deliberately do NOT fall back to the legacy direct-vault
        // path on CLI failure. Doing so would re-introduce the divergence
        // this refactor exists to eliminate (see
        // workspace/reports/cloud-promote-architecture-2026-04-27.md).
        let display_name = company_yaml.name.as_deref();
        match provisioner(
            folder_name.clone(),
            display_name.map(String::from),
            hq_root.to_path_buf(),
        )
        .await
        {
            Ok(cli_result) => {
                result.push(ProvisionedCompany {
                    slug: folder_name,
                    uid: cli_result.cloud_uid,
                    bucket_name: cli_result.bucket_name,
                });
            }
            Err(CliProvisionError::Sync { partial, message }) => {
                // Entity + manifest + config all succeeded — only the initial
                // sync failed. Record the provisioned company (so the UI shows
                // "ready, sync pending") and propagate the error so callers
                // surface a notice. Subsequent sync runs will retry uploads
                // through the normal `first_push` path.
                if let Some(p) = partial {
                    result.push(ProvisionedCompany {
                        slug: folder_name.clone(),
                        uid: p.cloud_uid,
                        bucket_name: p.bucket_name,
                    });
                }
                return Err(format!("provision '{folder_name}' via hq CLI: {message}"));
            }
            Err(e) => {
                return Err(format!("provision '{folder_name}' via hq CLI: {e}"));
            }
        }
    }

    Ok(result)
}

// ── Tests ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::run_cli_provision::CliInitialSync;
    use sha2::{Digest, Sha256};
    use std::sync::{Arc, Mutex};
    use tempfile::TempDir;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn vault(server: &MockServer) -> VaultClient {
        VaultClient::new(server.uri(), "test-jwt")
    }

    const VAULT_URL: &str = "https://vault.test.getindigo.ai";

    /// Build a mock `CliProvisionResult` that mimics the AppBar happy path —
    /// always `--skip-initial-sync`, so `initial_sync.ok` is None and `skipped`
    /// is Some(true). See `CliInitialSync` doc for why every field is Optional.
    fn mock_cli_result(slug: &str, uid: &str, bucket: &str) -> CliProvisionResult {
        CliProvisionResult {
            ok: true,
            company_slug: slug.to_string(),
            cloud_uid: uid.to_string(),
            bucket_name: bucket.to_string(),
            vault_api_url: VAULT_URL.to_string(),
            kms_key_id: None,
            created_entity: true,
            manifest_patched: true,
            config_written: true,
            initial_sync: CliInitialSync {
                ok: None,
                files_uploaded: None,
                bytes_uploaded: None,
                error: None,
                skipped: Some(true),
            },
        }
    }

    /// Create a company directory with an optional company.yaml and return the
    /// yaml path (if created).
    fn setup_company(root: &Path, slug: &str, yaml: Option<&str>) -> PathBuf {
        let dir = root.join("companies").join(slug);
        std::fs::create_dir_all(&dir).unwrap();
        let yaml_path = dir.join("company.yaml");
        if let Some(content) = yaml {
            std::fs::write(&yaml_path, content).unwrap();
        }
        yaml_path
    }

    fn sha256_file(path: &Path) -> String {
        let bytes = std::fs::read(path).unwrap();
        format!("{:x}", Sha256::digest(&bytes))
    }

    fn entity_json(uid: &str, slug: &str, bucket: Option<&str>) -> serde_json::Value {
        let mut v = serde_json::json!({
            "entity": {
                "uid": uid,
                "slug": slug,
                "type": "company",
                "status": "active",
                "createdAt": "2026-01-01T00:00:00Z"
            }
        });
        if let Some(b) = bucket {
            v["entity"]["bucketName"] = serde_json::Value::String(b.to_string());
        }
        v
    }

    fn bucket_json(bucket: &str) -> serde_json::Value {
        serde_json::json!({ "bucketName": bucket, "kmsKeyId": "key-1" })
    }

    // (a) cloud: false → skipped
    #[tokio::test]
    async fn test_cloud_false_skipped() {
        let tmp = TempDir::new().unwrap();
        setup_company(tmp.path(), "acme", Some("cloud: false\nname: Acme\n"));
        let server = MockServer::start().await;
        let result = provision_missing_companies(tmp.path(), &vault(&server), VAULT_URL)
            .await
            .unwrap();
        assert!(result.is_empty());
        assert!(server.received_requests().await.unwrap().is_empty());
    }

    // (b) no company.yaml → skipped
    #[tokio::test]
    async fn test_no_yaml_skipped() {
        let tmp = TempDir::new().unwrap();
        setup_company(tmp.path(), "acme", None); // directory but no yaml
        let server = MockServer::start().await;
        let result = provision_missing_companies(tmp.path(), &vault(&server), VAULT_URL)
            .await
            .unwrap();
        assert!(result.is_empty());
        assert!(server.received_requests().await.unwrap().is_empty());
    }

    // (c) .hq/config.json present + by-UID lookup returns 200 → skipped (no provisioning)
    #[tokio::test]
    async fn test_config_json_exists_and_entity_200_skipped() {
        let tmp = TempDir::new().unwrap();
        let slug = "acme";
        setup_company(tmp.path(), slug, Some("cloud: true\nname: Acme\n"));
        // Write an existing config.json
        let hq_dir = tmp.path().join("companies").join(slug).join(".hq");
        std::fs::create_dir_all(&hq_dir).unwrap();
        let cfg = CompanyConfig {
            company_uid: "cmp_existing".to_string(),
            company_slug: slug.to_string(),
            bucket_name: "hq-vault-cmp-existing".to_string(),
            vault_api_url: VAULT_URL.to_string(),
        };
        std::fs::write(
            hq_dir.join("config.json"),
            serde_json::to_string_pretty(&cfg).unwrap(),
        )
        .unwrap();

        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/entity/cmp_existing"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&entity_json(
                "cmp_existing",
                slug,
                Some("hq-vault-cmp-existing"),
            )))
            .mount(&server)
            .await;

        let result = provision_missing_companies(tmp.path(), &vault(&server), VAULT_URL)
            .await
            .unwrap();
        assert!(
            result.is_empty(),
            "already-provisioned company must be skipped"
        );
        // Only the by-UID check was called — no create_entity, no provision_bucket.
        let reqs = server.received_requests().await.unwrap();
        assert!(
            reqs.iter().all(|r| r.url.path() == "/entity/cmp_existing"),
            "only by-UID calls expected; got: {:?}",
            reqs.iter().map(|r| r.url.path()).collect::<Vec<_>>()
        );
    }

    // (d) legacy cloudCompanyUid, no .hq/config.json → migration; YAML unchanged
    #[tokio::test]
    async fn test_legacy_uid_migration_yaml_unchanged() {
        let tmp = TempDir::new().unwrap();
        let slug = "legacy-co";
        let yaml_content = "cloud: true\nname: Legacy Co\ncloudCompanyUid: cmp_legacy\n";
        let yaml_path = setup_company(tmp.path(), slug, Some(yaml_content));
        let sha_before = sha256_file(&yaml_path);

        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/entity/cmp_legacy"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&entity_json(
                "cmp_legacy",
                slug,
                Some("hq-vault-cmp-legacy"),
            )))
            .mount(&server)
            .await;

        let result = provision_missing_companies(tmp.path(), &vault(&server), VAULT_URL)
            .await
            .unwrap();

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].uid, "cmp_legacy");
        assert_eq!(result[0].bucket_name, "hq-vault-cmp-legacy");

        // config.json must have been written
        let config_path = tmp
            .path()
            .join("companies")
            .join(slug)
            .join(".hq")
            .join("config.json");
        assert!(config_path.exists());
        let written: CompanyConfig =
            serde_json::from_str(&std::fs::read_to_string(&config_path).unwrap()).unwrap();
        assert_eq!(written.company_uid, "cmp_legacy");
        assert_eq!(written.bucket_name, "hq-vault-cmp-legacy");

        // YAML must be byte-for-byte unchanged
        let sha_after = sha256_file(&yaml_path);
        assert_eq!(sha_before, sha_after, "company.yaml was modified");
    }

    // (d2) legacy cloudCompanyUid, entity found but bucket_name: None → provision_bucket called
    #[tokio::test]
    async fn test_legacy_uid_entity_without_bucket_provisions() {
        let tmp = TempDir::new().unwrap();
        let slug = "legacy-no-bucket";
        let yaml_content = "cloud: true\nname: Legacy No Bucket\ncloudCompanyUid: cmp_legacy\n";
        setup_company(tmp.path(), slug, Some(yaml_content));

        let server = MockServer::start().await;
        // by-UID lookup returns entity with NO bucket
        Mock::given(method("GET"))
            .and(path("/entity/cmp_legacy"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&entity_json(
                "cmp_legacy",
                slug,
                None,
            )))
            .mount(&server)
            .await;
        // provision_bucket called because bucket was absent
        Mock::given(method("POST"))
            .and(path("/provision/bucket"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(&bucket_json("hq-vault-cmp-legacy")),
            )
            .mount(&server)
            .await;

        let result = provision_missing_companies(tmp.path(), &vault(&server), VAULT_URL)
            .await
            .unwrap();

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].uid, "cmp_legacy");
        assert_eq!(result[0].bucket_name, "hq-vault-cmp-legacy");

        // provision_bucket must have been called exactly once with companyUid == "cmp_legacy"
        let reqs = server.received_requests().await.unwrap();
        let bucket_calls: Vec<_> = reqs
            .iter()
            .filter(|r| r.url.path() == "/provision/bucket")
            .collect();
        assert_eq!(
            bucket_calls.len(),
            1,
            "provision_bucket must be called exactly once"
        );
        let body: serde_json::Value = serde_json::from_slice(&bucket_calls[0].body).unwrap();
        assert_eq!(body["companyUid"], "cmp_legacy");

        // config.json must have non-empty bucket name
        let config_path = tmp
            .path()
            .join("companies")
            .join(slug)
            .join(".hq")
            .join("config.json");
        let written: CompanyConfig =
            serde_json::from_str(&std::fs::read_to_string(&config_path).unwrap()).unwrap();
        assert_eq!(written.bucket_name, "hq-vault-cmp-legacy");
        assert!(
            !written.bucket_name.is_empty(),
            "bucket_name must not be empty"
        );
    }

    // Regression for feedback_b8974be9-6b79-4e3c-87b5-8bc63fd3f59b: an
    // unrelated owner may hold the same slug, making the retired global route
    // return 409. The manifest's cloud_uid is the precise local binding, so
    // provision must fetch it directly and proceed without touching by-slug.
    #[tokio::test]
    async fn test_manifest_uid_ignores_globally_ambiguous_slug() {
        let tmp = TempDir::new().unwrap();
        let slug = "clean-people";
        setup_company(tmp.path(), slug, Some("cloud: true\nname: Clean People\n"));
        std::fs::write(
            tmp.path().join("companies").join("manifest.yaml"),
            "companies:\n  clean-people:\n    name: Clean People\n    cloud_uid: cmp_01KXK7SVDVRFQBCSYD5R95HAFR\n    bucket_name: hq-vault-cmp-own\n",
        )
        .unwrap();

        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/entity/cmp_01KXK7SVDVRFQBCSYD5R95HAFR"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&entity_json(
                "cmp_01KXK7SVDVRFQBCSYD5R95HAFR",
                slug,
                Some("hq-vault-cmp-own"),
            )))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path(format!("/entity/by-slug/company/{slug}")))
            .respond_with(ResponseTemplate::new(409).set_body_json(&serde_json::json!({
                "error": "Slug \\\"clean-people\\\" of type \\\"company\\\" matches 2 live entities",
                "uids": ["cmp_01KXK7SVDVRFQBCSYD5R95HAFR", "cmp_01KX6PNS53FNMGN6T4VCDJ1MK3"]
            })))
            .mount(&server)
            .await;

        let result = provision_missing_companies(tmp.path(), &vault(&server), VAULT_URL)
            .await
            .expect("ambiguous global slug must not bail provisioning");
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].uid, "cmp_01KXK7SVDVRFQBCSYD5R95HAFR");

        let requests = server.received_requests().await.unwrap();
        assert!(requests
            .iter()
            .all(|request| !request.url.path().contains("by-slug")));
    }

    #[tokio::test]
    async fn test_caller_scoped_lookup_ignores_globally_ambiguous_slug() {
        let tmp = TempDir::new().unwrap();
        let slug = "clean-people";
        setup_company(tmp.path(), slug, Some("cloud: true\nname: Clean People\n"));

        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/entity/check-slug/me"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(&serde_json::json!({
                    "available": false,
                    "conflictingCompanyUid": "cmp_01KXK7SVDVRFQBCSYD5R95HAFR"
                })),
            )
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/entity/cmp_01KXK7SVDVRFQBCSYD5R95HAFR"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&entity_json(
                "cmp_01KXK7SVDVRFQBCSYD5R95HAFR",
                slug,
                Some("hq-vault-cmp-own"),
            )))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path(format!("/entity/by-slug/company/{slug}")))
            .respond_with(ResponseTemplate::new(409))
            .mount(&server)
            .await;

        let result = provision_missing_companies(tmp.path(), &vault(&server), VAULT_URL)
            .await
            .expect("caller-scoped lookup must recover the caller's company");
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].uid, "cmp_01KXK7SVDVRFQBCSYD5R95HAFR");

        let requests = server.received_requests().await.unwrap();
        assert!(requests.iter().any(|request| {
            request.url.path() == "/entity/check-slug/me"
                && request.url.query() == Some("type=company&slug=clean-people")
        }));
        assert!(requests
            .iter()
            .all(|request| !request.url.path().contains("by-slug")));
    }

    // (e) new folder + no pinned uid → caller-scoped lookup misses, then Path D
    // dispatches to the provisioner; result recorded verbatim; YAML untouched.
    // (Pre-C3 this test also asserted on the shape of config.json, but Path D no
    // longer writes config.json from Rust — that work moved into the
    // `hq cloud provision` CLI subprocess. The mock provisioner here stands in
    // for that subprocess.)
    #[tokio::test]
    async fn test_new_folder_provisioned_yaml_unchanged() {
        let tmp = TempDir::new().unwrap();
        let slug = "new-co";
        let yaml_content = "cloud: true\nname: New Co\n";
        let yaml_path = setup_company(tmp.path(), slug, Some(yaml_content));
        let sha_before = sha256_file(&yaml_path);

        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/entity/check-slug/me"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(&serde_json::json!({ "available": true })),
            )
            .mount(&server)
            .await;
        let provisioner = |s: String, _name: Option<String>, _root: PathBuf| async move {
            Ok(mock_cli_result(&s, "cmp_new", "hq-vault-cmp-new"))
        };

        let result = provision_missing_companies_with_provisioner(
            tmp.path(),
            &vault(&server),
            VAULT_URL,
            provisioner,
        )
        .await
        .unwrap();

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].slug, slug);
        assert_eq!(result[0].uid, "cmp_new");
        assert_eq!(result[0].bucket_name, "hq-vault-cmp-new");

        // company.yaml is read-only from this module — see module-level doc
        let sha_after = sha256_file(&yaml_path);
        assert_eq!(sha_before, sha_after, "company.yaml was modified");

        let requests = server.received_requests().await.unwrap();
        assert_eq!(
            requests.len(),
            1,
            "only the caller-scoped lookup is expected"
        );
        assert_eq!(requests[0].url.path(), "/entity/check-slug/me");
        assert_eq!(requests[0].url.query(), Some("type=company&slug=new-co"));
        assert!(requests
            .iter()
            .all(|request| !request.url.path().contains("by-slug")));
    }

    // (f) manifest cloud_uid → reuse the exact entity by UID and do not invoke
    // the provisioner. A globally ambiguous slug cannot affect this binding.
    #[tokio::test]
    async fn test_find_by_slug_reuses_uid_no_create() {
        let tmp = TempDir::new().unwrap();
        let slug = "pre-existing";
        setup_company(tmp.path(), slug, Some("cloud: true\nname: Pre Co\n"));
        std::fs::write(
            tmp.path().join("companies").join("manifest.yaml"),
            "companies:\n  pre-existing:\n    name: Pre Co\n    cloud_uid: cmp_preexisting\n    bucket_name: hq-vault-cmp-preexisting\n",
        )
        .unwrap();

        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/entity/cmp_preexisting"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&entity_json(
                "cmp_preexisting",
                slug,
                Some("hq-vault-cmp-preexisting"),
            )))
            .mount(&server)
            .await;
        let provisioner_calls: Arc<Mutex<u32>> = Arc::new(Mutex::new(0));
        let provisioner_calls_clone = Arc::clone(&provisioner_calls);
        let provisioner = move |s: String, _name: Option<String>, _root: PathBuf| {
            let calls = Arc::clone(&provisioner_calls_clone);
            async move {
                *calls.lock().unwrap() += 1;
                Ok(mock_cli_result(
                    &s,
                    "cmp_unexpected",
                    "hq-vault-cmp-unexpected",
                ))
            }
        };

        let result = provision_missing_companies_with_provisioner(
            tmp.path(),
            &vault(&server),
            VAULT_URL,
            provisioner,
        )
        .await
        .unwrap();

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].uid, "cmp_preexisting");
        assert_eq!(result[0].bucket_name, "hq-vault-cmp-preexisting");

        assert_eq!(
            *provisioner_calls.lock().unwrap(),
            0,
            "manifest UID reuse must not create through the provisioner",
        );

        let requests = server.received_requests().await.unwrap();
        assert_eq!(
            requests.len(),
            1,
            "only the pinned by-UID lookup is expected"
        );
        assert_eq!(requests[0].url.path(), "/entity/cmp_preexisting");
        assert!(requests.iter().all(|request| {
            request.url.path() != "/entity/check-slug/me" && !request.url.path().contains("by-slug")
        }));
    }

    // (g) no pinned uid and caller-scoped lookup reports the slug available →
    // invoke the provisioner exactly once. The display_name from company.yaml
    // is forwarded so the CLI can stamp the entity's friendly name.
    #[tokio::test]
    async fn test_find_by_slug_null_creates_entity_once() {
        let tmp = TempDir::new().unwrap();
        let slug = "brand-new";
        setup_company(tmp.path(), slug, Some("cloud: true\nname: Brand New\n"));

        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/entity/check-slug/me"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(&serde_json::json!({
                    "available": true,
                    "conflictingCompanyUid": null
                })),
            )
            .mount(&server)
            .await;
        let call_count: Arc<Mutex<u32>> = Arc::new(Mutex::new(0));
        let forwarded_name: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let call_count_clone = Arc::clone(&call_count);
        let forwarded_name_clone = Arc::clone(&forwarded_name);
        let provisioner = move |s: String, name: Option<String>, _root: PathBuf| {
            let calls = Arc::clone(&call_count_clone);
            let name_sink = Arc::clone(&forwarded_name_clone);
            async move {
                *calls.lock().unwrap() += 1;
                *name_sink.lock().unwrap() = name;
                Ok(mock_cli_result(&s, "cmp_created", "hq-vault-cmp-created"))
            }
        };

        let result = provision_missing_companies_with_provisioner(
            tmp.path(),
            &vault(&server),
            VAULT_URL,
            provisioner,
        )
        .await
        .unwrap();

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].uid, "cmp_created");

        assert_eq!(
            *call_count.lock().unwrap(),
            1,
            "provisioner must be called exactly once",
        );
        assert_eq!(
            forwarded_name.lock().unwrap().as_deref(),
            Some("Brand New"),
            "display_name from company.yaml must be forwarded to the provisioner",
        );

        let requests = server.received_requests().await.unwrap();
        assert_eq!(requests.len(), 1, "caller-scoped lookup must happen once");
        assert_eq!(requests[0].url.path(), "/entity/check-slug/me");
        assert_eq!(requests[0].url.query(), Some("type=company&slug=brand-new"));
        assert!(requests
            .iter()
            .all(|request| !request.url.path().contains("by-slug")));
    }
}
