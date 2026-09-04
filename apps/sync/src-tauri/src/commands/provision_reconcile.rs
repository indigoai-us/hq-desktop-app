//! Server-first cloud activation reconcile (US-010).
//!
//! hq-pro `POST /v1/companies/{uid}/activate-cloud` stamps `cloudActivatedAt`
//! and leaves the activate_cloud card `pending`. This pass notices owned
//! companies in that state, writes the local marker/manifest/config the CLI
//! would have written, runs the initial sync via the same provisioner seam
//! as `provision_missing_companies`, then acks so the card can move to `done`.
//!
//! This is the only engine writer of `companies/{slug}/company.yaml` `cloud: true`.
//! `provision.rs` still treats yaml as read-only.

use std::future::Future;
use std::path::{Path, PathBuf};

use crate::commands::provision::{write_company_config, CompanyConfig};
use crate::commands::run_cli_provision::{
    run_cli_provision, CliProvisionError, CliProvisionResult,
};
use crate::commands::vault_client::{ActivateCloudAck, EntityInfo, VaultClient};
use crate::commands::workspaces::{
    add_manifest_entry_for_synced_company, patch_manifest_with_cloud_info,
};
use crate::util::logfile::log;

/// One company this pass reconciled (or acked).
#[derive(Debug, Clone)]
pub struct ReconciledCompany {
    pub slug: String,
    pub uid: String,
    pub bucket_name: String,
    pub wrote_local: bool,
    pub acked: bool,
}

/// Production wrapper: Path C / initial sync goes through `hq cloud provision company`.
pub async fn reconcile_server_activated_companies(
    hq_root: &Path,
    vault: &VaultClient,
    vault_api_url: &str,
) -> Result<Vec<ReconciledCompany>, String> {
    reconcile_server_activated_companies_with_provisioner(
        hq_root,
        vault,
        vault_api_url,
        |slug, name, root| async move { run_cli_provision(&slug, name.as_deref(), &root).await },
    )
    .await
}

/// Test seam. `provisioner` is invoked only when local files must be created
/// (server-activated, no local `cloud: true` + config yet).
pub async fn reconcile_server_activated_companies_with_provisioner<F, Fut>(
    hq_root: &Path,
    vault: &VaultClient,
    vault_api_url: &str,
    provisioner: F,
) -> Result<Vec<ReconciledCompany>, String>
where
    F: Fn(String, Option<String>, PathBuf) -> Fut,
    Fut: Future<Output = Result<CliProvisionResult, CliProvisionError>>,
{
    let memberships = vault
        .list_my_memberships()
        .await
        .map_err(|e| format!("list_my_memberships: {e}"))?;

    let mut out: Vec<ReconciledCompany> = Vec::new();

    for membership in memberships {
        if membership.status != "active" {
            continue;
        }
        if membership.role.as_deref() != Some("owner") {
            continue;
        }
        let uid = membership.company_uid;
        let entity = match vault.find_entity_by_uid(&uid).await {
            Ok(Some(info)) => info,
            Ok(None) => continue,
            Err(e) => {
                log(
                    "provision-reconcile",
                    &format!("GET /entity/{uid} failed: {e}"),
                );
                continue;
            }
        };
        if !should_reconcile(&entity) {
            continue;
        }
        let slug = entity.slug.clone();
        let name = entity.name.clone();
        let already_local = local_already_provisioned(hq_root, &slug);
        let mut bucket_name = entity.bucket_name.clone().unwrap_or_default();
        let mut wrote_local = false;

        if !already_local {
            // A company.yaml we cannot parse (or that is not a mapping) is
            // left untouched; that company is skipped this pass rather than
            // having its file replaced with a bare `cloud: true`.
            if let Err(e) = write_yaml_cloud_true(hq_root, &slug, name.as_deref()) {
                log(
                    "provision-reconcile",
                    &format!("skip '{slug}': {e}"),
                );
                continue;
            }
            if bucket_name.is_empty() {
                match provisioner(slug.clone(), name.clone(), hq_root.to_path_buf()).await {
                    Ok(cli) => {
                        bucket_name = cli.bucket_name;
                        wrote_local = true;
                    }
                    Err(CliProvisionError::Sync { partial, message }) => {
                        if let Some(p) = partial {
                            bucket_name = p.bucket_name;
                            wrote_local = true;
                            log(
                                "provision-reconcile",
                                &format!("provision '{slug}' sync failed (continuing): {message}"),
                            );
                        } else {
                            return Err(format!("provision '{slug}' via hq CLI: {message}"));
                        }
                    }
                    Err(e) => {
                        return Err(format!("provision '{slug}' via hq CLI: {e}"));
                    }
                }
            } else {
                let cfg = CompanyConfig {
                    company_uid: uid.clone(),
                    company_slug: slug.clone(),
                    bucket_name: bucket_name.clone(),
                    vault_api_url: vault_api_url.to_string(),
                };
                write_company_config(
                    &hq_root
                        .join("companies")
                        .join(&slug)
                        .join(".hq")
                        .join("config.json"),
                    &cfg,
                )?;
                patch_or_add_manifest(hq_root, &slug, name.as_deref(), &uid, &bucket_name);
                match provisioner(slug.clone(), name.clone(), hq_root.to_path_buf()).await {
                    Ok(_) => {}
                    Err(CliProvisionError::Sync { message, .. }) => {
                        log(
                            "provision-reconcile",
                            &format!("initial sync '{slug}' failed (local files written): {message}"),
                        );
                    }
                    Err(e) => {
                        log(
                            "provision-reconcile",
                            &format!("provisioner '{slug}' failed after local write: {e}"),
                        );
                    }
                }
                wrote_local = true;
            }
        }

        // Ack when this pass wrote local files, or when an earlier pass wrote
        // them but its ack never reached the server (marker left behind).
        // Re-acking an already-provisioned company on every sync pass
        // hammered /activate-cloud/ack for the lifetime of the install, and
        // the entity payload carries no card state, so the marker is the only
        // durable "server card may still be pending" signal.
        let ack_pending = ack_pending_marker_exists(hq_root, &slug);
        if !wrote_local && !ack_pending {
            out.push(ReconciledCompany {
                slug,
                uid,
                bucket_name,
                wrote_local,
                acked: false,
            });
            continue;
        }
        if ack_pending {
            log(
                "provision-reconcile",
                &format!("retrying pending ack for '{slug}' ({uid})"),
            );
        }

        let acked = match vault.ack_activate_cloud(&uid).await {
            Ok(ActivateCloudAck::Done) => {
                clear_ack_pending_marker(hq_root, &slug);
                true
            }
            Ok(ActivateCloudAck::Forbidden) => {
                // Terminal server answer: this machine is not the owner.
                // Retrying every pass would only repeat the 403.
                clear_ack_pending_marker(hq_root, &slug);
                log(
                    "provision-reconcile",
                    &format!("ack {uid} forbidden (not owner on this machine)"),
                );
                false
            }
            Ok(ActivateCloudAck::NotFound) => {
                // Terminal: no pending card to ack.
                clear_ack_pending_marker(hq_root, &slug);
                log(
                    "provision-reconcile",
                    &format!("ack {uid} not found"),
                );
                false
            }
            Err(e) => {
                // Transport / 5xx: local files exist but the server card is
                // still pending. Persist that so the next pass retries.
                if let Err(marker_err) = write_ack_pending_marker(hq_root, &slug) {
                    log(
                        "provision-reconcile",
                        &format!("ack {uid} failed: {e}; could not persist marker: {marker_err}"),
                    );
                } else {
                    log(
                        "provision-reconcile",
                        &format!("ack {uid} failed (will retry next pass): {e}"),
                    );
                }
                false
            }
        };

        out.push(ReconciledCompany {
            slug,
            uid,
            bucket_name,
            wrote_local,
            acked,
        });
    }

    Ok(out)
}

/// Sibling of `.hq/config.json`; present while a server-side activate_cloud
/// ack is owed for a company whose local files were already written.
const ACK_PENDING_FILE: &str = "activate-ack.pending";

fn ack_pending_marker_path(hq_root: &Path, slug: &str) -> PathBuf {
    hq_root
        .join("companies")
        .join(slug)
        .join(".hq")
        .join(ACK_PENDING_FILE)
}

fn ack_pending_marker_exists(hq_root: &Path, slug: &str) -> bool {
    ack_pending_marker_path(hq_root, slug).is_file()
}

fn write_ack_pending_marker(hq_root: &Path, slug: &str) -> Result<(), String> {
    let path = ack_pending_marker_path(hq_root, slug);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("create_dir_all {}: {e}", parent.display()))?;
    }
    std::fs::write(&path, b"activate-cloud ack pending\n")
        .map_err(|e| format!("write {}: {e}", path.display()))
}

fn clear_ack_pending_marker(hq_root: &Path, slug: &str) {
    let path = ack_pending_marker_path(hq_root, slug);
    match std::fs::remove_file(&path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => log(
            "provision-reconcile",
            &format!("remove {}: {e}", path.display()),
        ),
    }
}

fn should_reconcile(entity: &EntityInfo) -> bool {
    if entity.deleted {
        return false;
    }
    if entity.entity_type != "company" {
        return false;
    }
    entity
        .cloud_activated_at
        .as_deref()
        .map(|s| !s.is_empty())
        .unwrap_or(false)
}

fn local_already_provisioned(hq_root: &Path, slug: &str) -> bool {
    let folder = hq_root.join("companies").join(slug);
    let yaml_path = folder.join("company.yaml");
    let config_path = folder.join(".hq").join("config.json");
    yaml_cloud_true(&yaml_path) && config_path.is_file()
}

fn yaml_cloud_true(path: &Path) -> bool {
    let Ok(bytes) = std::fs::read(path) else {
        return false;
    };
    let Ok(value) = serde_yaml::from_slice::<serde_yaml::Value>(&bytes) else {
        return false;
    };
    value
        .as_mapping()
        .and_then(|m| m.get(serde_yaml::Value::String("cloud".into())))
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

/// Ensure `companies/{slug}/company.yaml` has `cloud: true` without clobbering
/// unrelated keys. Creates the file when missing. An existing file that does
/// not parse as a YAML mapping is never rewritten: this returns `Err` and the
/// caller skips the company, so a hand-edited or corrupted config is preserved
/// byte-for-byte for the user to fix.
fn write_yaml_cloud_true(hq_root: &Path, slug: &str, name: Option<&str>) -> Result<(), String> {
    let dir = hq_root.join("companies").join(slug);
    std::fs::create_dir_all(&dir).map_err(|e| format!("create_dir_all {}: {e}", dir.display()))?;
    let path = dir.join("company.yaml");
    let mut value: serde_yaml::Value = if path.exists() {
        let bytes = std::fs::read(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
        serde_yaml::from_slice(&bytes)
            .map_err(|e| format!("parse {}: {e} (left unchanged)", path.display()))?
    } else {
        serde_yaml::Value::Mapping(serde_yaml::Mapping::new())
    };
    if value.is_null() {
        // An empty file parses as null; treat it as an empty mapping.
        value = serde_yaml::Value::Mapping(serde_yaml::Mapping::new());
    }
    let mapping = value.as_mapping_mut().ok_or_else(|| {
        format!(
            "{} is not a YAML mapping (left unchanged)",
            path.display()
        )
    })?;
    mapping.insert(
        serde_yaml::Value::String("cloud".into()),
        serde_yaml::Value::Bool(true),
    );
    if let Some(n) = name {
        mapping
            .entry(serde_yaml::Value::String("name".into()))
            .or_insert(serde_yaml::Value::String(n.to_string()));
    }
    let serialized =
        serde_yaml::to_string(&value).map_err(|e| format!("serialize {}: {e}", path.display()))?;
    let tmp = path.with_extension("yaml.tmp");
    std::fs::write(&tmp, &serialized).map_err(|e| format!("write tmp yaml: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("rename yaml: {e}"))?;
    Ok(())
}

fn patch_or_add_manifest(
    hq_root: &Path,
    slug: &str,
    name: Option<&str>,
    uid: &str,
    bucket: &str,
) {
    let manifest_path = hq_root.join("companies").join("manifest.yaml");
    if !manifest_path.exists() {
        return;
    }
    if patch_manifest_with_cloud_info(&manifest_path, slug, uid, bucket).is_ok() {
        return;
    }
    let display = name.unwrap_or(slug);
    let _ = add_manifest_entry_for_synced_company(
        &manifest_path,
        slug,
        display,
        Some(uid),
        Some(bucket),
    );
    let _ = patch_manifest_with_cloud_info(&manifest_path, slug, uid, bucket);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::run_cli_provision::CliInitialSync;
    use sha2::{Digest, Sha256};
    use std::sync::{Arc, Mutex};
    use tempfile::TempDir;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    const VAULT_URL: &str = "https://vault.test.getindigo.ai";

    fn vault(server: &MockServer) -> VaultClient {
        VaultClient::new(server.uri(), "test-jwt")
    }

    fn sha256_file(path: &Path) -> String {
        let bytes = std::fs::read(path).unwrap();
        format!("{:x}", Sha256::digest(&bytes))
    }

    fn mock_cli_result(slug: &str, uid: &str, bucket: &str) -> CliProvisionResult {
        CliProvisionResult {
            ok: true,
            company_slug: slug.to_string(),
            cloud_uid: uid.to_string(),
            bucket_name: bucket.to_string(),
            vault_api_url: VAULT_URL.to_string(),
            kms_key_id: None,
            created_entity: false,
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

    fn write_manifest(root: &Path, slug: &str) {
        let companies = root.join("companies");
        std::fs::create_dir_all(&companies).unwrap();
        std::fs::write(
            companies.join("manifest.yaml"),
            format!(
                "companies:\n  {slug}:\n    name: {slug}\n    goal: \"\"\n    path: companies/{slug}\n    sources: []\n    repos: []\n    knowledge: companies/{slug}/knowledge/\n    qmd_collections:\n      - {slug}\n"
            ),
        )
        .unwrap();
    }

    fn entity_json(uid: &str, slug: &str, bucket: Option<&str>, activated: bool) -> serde_json::Value {
        let mut entity = serde_json::json!({
            "uid": uid,
            "slug": slug,
            "type": "company",
            "name": slug,
            "status": "active",
            "createdAt": "2026-01-01T00:00:00Z"
        });
        if let Some(b) = bucket {
            entity["bucketName"] = serde_json::Value::String(b.to_string());
        }
        if activated {
            entity["cloudActivatedAt"] = serde_json::Value::String("2026-09-03T00:00:00Z".into());
        }
        serde_json::json!({ "entity": entity })
    }

    async fn mount_owner_company(
        server: &MockServer,
        uid: &str,
        slug: &str,
        bucket: Option<&str>,
        activated: bool,
        ack_status: u16,
    ) {
        Mock::given(method("GET"))
            .and(path("/membership/me"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&serde_json::json!({
                "memberships": [{
                    "personUid": "prs_owner",
                    "companyUid": uid,
                    "status": "active",
                    "role": "owner"
                }]
            })))
            .mount(server)
            .await;
        Mock::given(method("GET"))
            .and(path(format!("/entity/{uid}")))
            .respond_with(ResponseTemplate::new(200).set_body_json(&entity_json(
                uid, slug, bucket, activated,
            )))
            .mount(server)
            .await;
        Mock::given(method("POST"))
            .and(path(format!("/v1/companies/{uid}/activate-cloud/ack")))
            .respond_with(ResponseTemplate::new(ack_status).set_body_json(&serde_json::json!({
                "companyUid": uid,
                "state": "done"
            })))
            .mount(server)
            .await;
    }

    #[tokio::test]
    async fn server_activated_unmarked_writes_local_and_acks() {
        let tmp = TempDir::new().unwrap();
        let slug = "acme";
        let uid = "cmp_acme";
        write_manifest(tmp.path(), slug);

        let server = MockServer::start().await;
        mount_owner_company(
            &server,
            uid,
            slug,
            Some("hq-vault-cmp-acme"),
            true,
            200,
        )
        .await;

        let calls = Arc::new(Mutex::new(Vec::<String>::new()));
        let calls_clone = calls.clone();
        let result = reconcile_server_activated_companies_with_provisioner(
            tmp.path(),
            &vault(&server),
            VAULT_URL,
            {
                let uid = uid.to_string();
                move |s, _n, _r| {
                    calls_clone.lock().unwrap().push(s.clone());
                    let uid = uid.clone();
                    async move { Ok(mock_cli_result(&s, &uid, "hq-vault-cmp-acme")) }
                }
            },
        )
        .await
        .unwrap();

        assert_eq!(result.len(), 1);
        assert!(result[0].wrote_local);
        assert!(result[0].acked);
        assert_eq!(result[0].uid, uid);
        assert_eq!(result[0].bucket_name, "hq-vault-cmp-acme");

        let yaml = tmp.path().join("companies").join(slug).join("company.yaml");
        assert!(yaml_cloud_true(&yaml));
        let cfg_path = tmp
            .path()
            .join("companies")
            .join(slug)
            .join(".hq")
            .join("config.json");
        let cfg: CompanyConfig =
            serde_json::from_str(&std::fs::read_to_string(&cfg_path).unwrap()).unwrap();
        assert_eq!(cfg.company_uid, uid);
        assert_eq!(cfg.bucket_name, "hq-vault-cmp-acme");

        let manifest = std::fs::read_to_string(tmp.path().join("companies").join("manifest.yaml"))
            .unwrap();
        assert!(manifest.contains("cmp_acme"));
        assert!(manifest.contains("hq-vault-cmp-acme"));
        assert_eq!(calls.lock().unwrap().as_slice(), &[slug.to_string()]);

        let reqs = server.received_requests().await.unwrap();
        assert!(reqs.iter().any(|r| r.url.path()
            == "/v1/companies/cmp_acme/activate-cloud/ack"));
    }

    #[tokio::test]
    async fn already_provisioned_locally_does_not_rewrite() {
        let tmp = TempDir::new().unwrap();
        let slug = "acme";
        let uid = "cmp_acme";
        write_manifest(tmp.path(), slug);
        let dir = tmp.path().join("companies").join(slug);
        std::fs::create_dir_all(dir.join(".hq")).unwrap();
        std::fs::write(dir.join("company.yaml"), "cloud: true\nname: Acme\nextra: keep-me\n")
            .unwrap();
        let cfg = CompanyConfig {
            company_uid: uid.to_string(),
            company_slug: slug.to_string(),
            bucket_name: "hq-vault-cmp-acme".to_string(),
            vault_api_url: VAULT_URL.to_string(),
        };
        std::fs::write(
            dir.join(".hq").join("config.json"),
            serde_json::to_string_pretty(&cfg).unwrap(),
        )
        .unwrap();
        let yaml_sha = sha256_file(&dir.join("company.yaml"));
        let cfg_sha = sha256_file(&dir.join(".hq").join("config.json"));

        let server = MockServer::start().await;
        mount_owner_company(
            &server,
            uid,
            slug,
            Some("hq-vault-cmp-acme"),
            true,
            200,
        )
        .await;

        let calls = Arc::new(Mutex::new(Vec::<String>::new()));
        let calls_clone = calls.clone();
        let result = reconcile_server_activated_companies_with_provisioner(
            tmp.path(),
            &vault(&server),
            VAULT_URL,
            move |s, _n, _r| {
                calls_clone.lock().unwrap().push(s.clone());
                async move { Ok(mock_cli_result("acme", "cmp_acme", "hq-vault-cmp-acme")) }
            },
        )
        .await
        .unwrap();

        assert_eq!(result.len(), 1);
        assert!(!result[0].wrote_local);
        assert!(!result[0].acked, "nothing was written, so nothing is acked");
        assert!(calls.lock().unwrap().is_empty());
        let reqs = server.received_requests().await.unwrap();
        assert!(
            !reqs.iter().any(|r| r.url.path().ends_with("/activate-cloud/ack")),
            "an already-provisioned company must not be re-acked every pass"
        );
        assert_eq!(sha256_file(&dir.join("company.yaml")), yaml_sha);
        assert_eq!(sha256_file(&dir.join(".hq").join("config.json")), cfg_sha);
        let yaml = std::fs::read_to_string(dir.join("company.yaml")).unwrap();
        assert!(yaml.contains("extra: keep-me"));
    }

    #[tokio::test]
    async fn malformed_company_yaml_is_left_intact_and_company_skipped() {
        let tmp = TempDir::new().unwrap();
        let slug = "acme";
        let uid = "cmp_acme";
        write_manifest(tmp.path(), slug);
        let dir = tmp.path().join("companies").join(slug);
        std::fs::create_dir_all(&dir).unwrap();
        // Unbalanced bracket: not parseable as YAML.
        let malformed = "name: Acme\ncloud: [true\n  extra: keep-me\n";
        std::fs::write(dir.join("company.yaml"), malformed).unwrap();
        let yaml_sha = sha256_file(&dir.join("company.yaml"));

        let server = MockServer::start().await;
        mount_owner_company(
            &server,
            uid,
            slug,
            Some("hq-vault-cmp-acme"),
            true,
            200,
        )
        .await;

        let result = reconcile_server_activated_companies_with_provisioner(
            tmp.path(),
            &vault(&server),
            VAULT_URL,
            |_s, _n, _r| async { panic!("provisioner must not run for a skipped company") },
        )
        .await
        .expect("a malformed company.yaml must not fail the whole pass");

        assert!(result.is_empty(), "skipped company must not be reported");
        assert_eq!(sha256_file(&dir.join("company.yaml")), yaml_sha);
        assert_eq!(
            std::fs::read_to_string(dir.join("company.yaml")).unwrap(),
            malformed
        );
        assert!(!dir.join(".hq").join("config.json").exists());
        assert!(!dir.join("company.yaml.tmp").exists());
        let reqs = server.received_requests().await.unwrap();
        assert!(
            !reqs.iter().any(|r| r.url.path().ends_with("/activate-cloud/ack")),
            "a skipped company must not be acked"
        );
    }

    #[tokio::test]
    async fn non_mapping_company_yaml_is_left_intact_and_company_skipped() {
        let tmp = TempDir::new().unwrap();
        let slug = "acme";
        write_manifest(tmp.path(), slug);
        let dir = tmp.path().join("companies").join(slug);
        std::fs::create_dir_all(&dir).unwrap();
        // Valid YAML, but a sequence rather than a mapping.
        let seq = "- cloud\n- true\n";
        std::fs::write(dir.join("company.yaml"), seq).unwrap();

        let server = MockServer::start().await;
        mount_owner_company(&server, "cmp_acme", slug, Some("b"), true, 200).await;

        let result = reconcile_server_activated_companies_with_provisioner(
            tmp.path(),
            &vault(&server),
            VAULT_URL,
            |_s, _n, _r| async { panic!("provisioner must not run") },
        )
        .await
        .unwrap();

        assert!(result.is_empty());
        assert_eq!(std::fs::read_to_string(dir.join("company.yaml")).unwrap(), seq);
    }

    #[test]
    fn write_yaml_cloud_true_preserves_unrelated_keys_and_creates_when_missing() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("companies").join("acme");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("company.yaml"), "name: Acme\nextra: keep-me\n").unwrap();
        write_yaml_cloud_true(tmp.path(), "acme", Some("Acme")).unwrap();
        let yaml = std::fs::read_to_string(dir.join("company.yaml")).unwrap();
        assert!(yaml.contains("extra: keep-me"));
        assert!(yaml_cloud_true(&dir.join("company.yaml")));

        write_yaml_cloud_true(tmp.path(), "fresh", Some("Fresh")).unwrap();
        let fresh = tmp.path().join("companies").join("fresh").join("company.yaml");
        assert!(yaml_cloud_true(&fresh));
        assert!(std::fs::read_to_string(&fresh).unwrap().contains("name: Fresh"));
    }

    #[tokio::test]
    async fn missing_cloud_activated_at_is_skipped() {
        let tmp = TempDir::new().unwrap();
        write_manifest(tmp.path(), "acme");
        let server = MockServer::start().await;
        mount_owner_company(&server, "cmp_acme", "acme", Some("b"), false, 200).await;
        let result = reconcile_server_activated_companies_with_provisioner(
            tmp.path(),
            &vault(&server),
            VAULT_URL,
            |_s, _n, _r| async { panic!("provisioner must not run") },
        )
        .await
        .unwrap();
        assert!(result.is_empty());
    }

    /// Lays down a fully provisioned company (cloud: true + config.json) and
    /// returns its folder.
    fn write_provisioned_company(root: &Path, slug: &str, uid: &str) -> PathBuf {
        let dir = root.join("companies").join(slug);
        std::fs::create_dir_all(dir.join(".hq")).unwrap();
        std::fs::write(dir.join("company.yaml"), "cloud: true\nname: Acme\n").unwrap();
        let cfg = CompanyConfig {
            company_uid: uid.to_string(),
            company_slug: slug.to_string(),
            bucket_name: "hq-vault-cmp-acme".to_string(),
            vault_api_url: VAULT_URL.to_string(),
        };
        std::fs::write(
            dir.join(".hq").join("config.json"),
            serde_json::to_string_pretty(&cfg).unwrap(),
        )
        .unwrap();
        dir
    }

    #[tokio::test]
    async fn ack_transport_failure_leaves_marker_and_next_pass_retries_and_clears_it() {
        let tmp = TempDir::new().unwrap();
        let slug = "acme";
        let uid = "cmp_acme";
        write_manifest(tmp.path(), slug);

        // Pass 1: ack answers 500.
        let failing = MockServer::start().await;
        mount_owner_company(&failing, uid, slug, Some("hq-vault-cmp-acme"), true, 500).await;
        let result = reconcile_server_activated_companies_with_provisioner(
            tmp.path(),
            &vault(&failing),
            VAULT_URL,
            |s, _n, _r| async move { Ok(mock_cli_result(&s, "cmp_acme", "hq-vault-cmp-acme")) },
        )
        .await
        .unwrap();
        assert_eq!(result.len(), 1);
        assert!(result[0].wrote_local);
        assert!(!result[0].acked);
        assert!(
            ack_pending_marker_exists(tmp.path(), slug),
            "failed ack must leave the pending marker"
        );
        assert!(local_already_provisioned(tmp.path(), slug));

        // Pass 2: local files exist, so nothing is rewritten, but the marker
        // forces a retry; the ack succeeds and the marker is cleared.
        let healthy = MockServer::start().await;
        mount_owner_company(&healthy, uid, slug, Some("hq-vault-cmp-acme"), true, 200).await;
        let calls = Arc::new(Mutex::new(Vec::<String>::new()));
        let calls_clone = calls.clone();
        let result = reconcile_server_activated_companies_with_provisioner(
            tmp.path(),
            &vault(&healthy),
            VAULT_URL,
            move |s, _n, _r| {
                calls_clone.lock().unwrap().push(s);
                async move { Ok(mock_cli_result("acme", "cmp_acme", "hq-vault-cmp-acme")) }
            },
        )
        .await
        .unwrap();
        assert_eq!(result.len(), 1);
        assert!(!result[0].wrote_local);
        assert!(result[0].acked, "pending marker must trigger a retry ack");
        assert!(calls.lock().unwrap().is_empty(), "no re-provision on retry");
        assert!(
            !ack_pending_marker_exists(tmp.path(), slug),
            "successful ack must clear the marker"
        );
        let reqs = healthy.received_requests().await.unwrap();
        assert_eq!(
            reqs.iter()
                .filter(|r| r.url.path() == "/v1/companies/cmp_acme/activate-cloud/ack")
                .count(),
            1
        );

        // Pass 3: no marker, already provisioned -> no ack at all.
        let quiet = MockServer::start().await;
        mount_owner_company(&quiet, uid, slug, Some("hq-vault-cmp-acme"), true, 200).await;
        let result = reconcile_server_activated_companies_with_provisioner(
            tmp.path(),
            &vault(&quiet),
            VAULT_URL,
            |_s, _n, _r| async { panic!("provisioner must not run") },
        )
        .await
        .unwrap();
        assert!(!result[0].acked);
        let reqs = quiet.received_requests().await.unwrap();
        assert!(!reqs.iter().any(|r| r.url.path().ends_with("/activate-cloud/ack")));
    }

    #[tokio::test]
    async fn pending_marker_retry_that_fails_again_keeps_marker() {
        let tmp = TempDir::new().unwrap();
        let slug = "acme";
        let uid = "cmp_acme";
        write_manifest(tmp.path(), slug);
        write_provisioned_company(tmp.path(), slug, uid);
        write_ack_pending_marker(tmp.path(), slug).unwrap();

        let failing = MockServer::start().await;
        mount_owner_company(&failing, uid, slug, Some("hq-vault-cmp-acme"), true, 503).await;
        let result = reconcile_server_activated_companies_with_provisioner(
            tmp.path(),
            &vault(&failing),
            VAULT_URL,
            |_s, _n, _r| async { panic!("provisioner must not run") },
        )
        .await
        .unwrap();
        assert_eq!(result.len(), 1);
        assert!(!result[0].wrote_local);
        assert!(!result[0].acked);
        assert!(ack_pending_marker_exists(tmp.path(), slug));
        let reqs = failing.received_requests().await.unwrap();
        assert!(reqs.iter().any(|r| r.url.path().ends_with("/activate-cloud/ack")));
    }

    #[tokio::test]
    async fn ack_forbidden_does_not_fail_the_pass() {
        let tmp = TempDir::new().unwrap();
        let slug = "acme";
        write_manifest(tmp.path(), slug);
        let server = MockServer::start().await;
        mount_owner_company(
            &server,
            "cmp_acme",
            slug,
            Some("hq-vault-cmp-acme"),
            true,
            403,
        )
        .await;
        let result = reconcile_server_activated_companies_with_provisioner(
            tmp.path(),
            &vault(&server),
            VAULT_URL,
            |s, _n, _r| async move { Ok(mock_cli_result(&s, "cmp_acme", "hq-vault-cmp-acme")) },
        )
        .await
        .unwrap();
        assert_eq!(result.len(), 1);
        assert!(result[0].wrote_local);
        assert!(!result[0].acked);
        assert!(
            !ack_pending_marker_exists(tmp.path(), slug),
            "403 is terminal; it must not schedule a retry"
        );
    }
}
