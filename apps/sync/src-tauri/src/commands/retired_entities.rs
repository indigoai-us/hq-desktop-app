//! Which company and bot uids no longer have a live cloud entity.
//!
//! `hq cloud retire company` soft-tombstones a company (`DELETE /entity/{uid}`
//! stamps `deleted: true`). hq-pro then drops it from `/membership/me` and
//! answers `GET /entity/{uid}` with 404, but the channel list
//! (`/v1/notify/channels`), contacts and the bot roster keep returning rows
//! that point at it, with no retired marker. A bot whose removal stopped half
//! way can also leave rows behind after its entity is gone.
//!
//! The desktop therefore asks `GET /entity/{uid}` about uids it was handed but
//! cannot place: a manifest `cloud_uid` with no membership, a channel whose
//! `companyUid` is not in the company list, or a bot DM peer. Only a readable
//! `deleted: true` answer marks a uid retired. Entity reads are caller-scoped,
//! so a 404 can also mean the user cannot read a live cross-company entity;
//! that ambiguity stays visible. A failed read also marks nothing, and a
//! company created a moment ago stays visible while the company list refreshes.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use futures_util::{stream, StreamExt};
use serde::Serialize;

use crate::commands::sync::resolve_vault_api_url;
use crate::commands::vault_client::{EntityLiveness, VaultClient};
use crate::util::logfile::log;

/// Most uids one call will probe. The sidebar sends only uids it cannot place,
/// so a real call is a handful; the cap bounds a pathological directory.
pub(crate) const MAX_PROBE_UIDS: usize = 100;
const PROBE_CONCURRENCY: usize = 6;
/// A company can be restored by staff, so answers are cached briefly rather
/// than for the whole session.
const LIVENESS_TTL: Duration = Duration::from_secs(5 * 60);

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetiredEntities {
    /// Company uids whose entity is tombstoned or gone.
    pub retired_company_uids: Vec<String>,
    /// Bot uids whose entity is tombstoned or gone.
    pub gone_agent_uids: Vec<String>,
    /// Probed uids that still have a live entity.
    pub live_uids: Vec<String>,
    /// For each live bot that was probed, the companies its config names.
    pub agent_company_uids: BTreeMap<String, Vec<String>>,
}

fn is_probe_uid(uid: &str) -> bool {
    (uid.starts_with("cmp_") || uid.starts_with("agt_"))
        && uid.len() > 4
        && uid.len() <= 128
        && uid
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// Trim, keep only well-formed `cmp_*` / `agt_*` uids, dedupe, cap.
pub(crate) fn sanitize_probe_uids<I, S>(uids: I) -> Vec<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for uid in uids {
        let uid = uid.as_ref().trim();
        if !is_probe_uid(uid) || !seen.insert(uid.to_string()) {
            continue;
        }
        out.push(uid.to_string());
        if out.len() >= MAX_PROBE_UIDS {
            break;
        }
    }
    out
}

async fn probe_all<F, Fut>(uids: Vec<String>, probe: &F) -> Vec<(String, Option<EntityLiveness>)>
where
    F: Fn(String) -> Fut,
    Fut: std::future::Future<Output = Result<EntityLiveness, String>>,
{
    stream::iter(uids)
        .map(|uid| async move {
            let answer = probe(uid.clone()).await.ok();
            (uid, answer)
        })
        .buffer_unordered(PROBE_CONCURRENCY)
        .collect()
        .await
}

/// Classify `uids`. Live bots also have their companies probed, so a bot whose
/// every company is retired can be told apart from a bot in a live company.
/// A uid whose read failed appears in no list.
pub(crate) async fn classify_entities<F, Fut>(uids: Vec<String>, probe: F) -> RetiredEntities
where
    F: Fn(String) -> Fut,
    Fut: std::future::Future<Output = Result<EntityLiveness, String>>,
{
    let uids = sanitize_probe_uids(uids);
    let mut answers: BTreeMap<String, Option<EntityLiveness>> =
        probe_all(uids, &probe).await.into_iter().collect();

    let follow_up: Vec<String> = answers
        .iter()
        .filter(|(uid, _)| uid.starts_with("agt_"))
        .filter_map(|(_, answer)| match answer {
            Some(EntityLiveness::Live { company_uids }) => Some(company_uids.clone()),
            _ => None,
        })
        .flatten()
        .filter(|company| !answers.contains_key(company))
        .collect();
    let follow_up = sanitize_probe_uids(follow_up);
    answers.extend(probe_all(follow_up, &probe).await);

    let mut out = RetiredEntities::default();
    for (uid, answer) in answers {
        match answer {
            Some(EntityLiveness::Gone) if uid.starts_with("cmp_") => {
                out.retired_company_uids.push(uid)
            }
            Some(EntityLiveness::Gone) => out.gone_agent_uids.push(uid),
            Some(EntityLiveness::Live { company_uids }) => {
                if uid.starts_with("agt_") {
                    out.agent_company_uids.insert(uid.clone(), company_uids);
                }
                out.live_uids.push(uid);
            }
            None => {}
        }
    }
    out
}

fn liveness_cache() -> &'static Mutex<HashMap<String, (EntityLiveness, Instant)>> {
    static CACHE: OnceLock<Mutex<HashMap<String, (EntityLiveness, Instant)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// `vault.entity_liveness` behind the short process cache. Errors are not
/// cached, so the next call asks again.
pub(crate) async fn cached_entity_liveness(
    vault: &VaultClient,
    uid: String,
) -> Result<EntityLiveness, String> {
    let now = Instant::now();
    {
        let cache = liveness_cache()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some((answer, at)) = cache.get(&uid) {
            if now.duration_since(*at) < LIVENESS_TTL {
                return Ok(answer.clone());
            }
        }
    }
    let answer = vault
        .entity_liveness(&uid)
        .await
        .map_err(|e| format!("GET /entity/{uid}: {e}"))?;
    liveness_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(uid, (answer.clone(), Instant::now()));
    Ok(answer)
}

/// Tauri command: which of `uids` (company `cmp_*` and bot `agt_*` uids) no
/// longer have a live cloud entity. See the module docs.
#[tauri::command]
pub async fn resolve_retired_entities(uids: Vec<String>) -> Result<RetiredEntities, String> {
    let uids = sanitize_probe_uids(uids);
    if uids.is_empty() {
        return Ok(RetiredEntities::default());
    }
    let vault_url = resolve_vault_api_url()?;
    let tokens = hq_desktop_core::cognito::get_valid_tokens().await?;
    let vault = VaultClient::new(&vault_url, &tokens.access_token);
    let result = classify_entities(uids, |uid| cached_entity_liveness(&vault, uid)).await;
    if !result.retired_company_uids.is_empty() || !result.gone_agent_uids.is_empty() {
        log(
            "retired-entities",
            &format!(
                "retired companies={:?} gone bots={:?}",
                result.retired_company_uids, result.gone_agent_uids
            ),
        );
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn live(companies: &[&str]) -> EntityLiveness {
        EntityLiveness::Live {
            company_uids: companies.iter().map(|c| c.to_string()).collect(),
        }
    }

    fn answers(
        table: Vec<(&'static str, Result<EntityLiveness, String>)>,
    ) -> (
        impl Fn(String) -> std::future::Ready<Result<EntityLiveness, String>>,
        Arc<Mutex<Vec<String>>>,
    ) {
        let table: HashMap<String, Result<EntityLiveness, String>> = table
            .into_iter()
            .map(|(uid, answer)| (uid.to_string(), answer))
            .collect();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let seen = calls.clone();
        let probe = move |uid: String| {
            seen.lock().unwrap().push(uid.clone());
            std::future::ready(
                table
                    .get(&uid)
                    .cloned()
                    .unwrap_or_else(|| Err("unexpected uid".to_string())),
            )
        };
        (probe, calls)
    }

    #[test]
    fn sanitize_keeps_only_company_and_bot_uids() {
        let out = sanitize_probe_uids([
            " cmp_a ",
            "agt_b",
            "cmp_a",
            "prs_c",
            "cmp_",
            "cmp_x/../y",
            "",
        ]);
        assert_eq!(out, vec!["cmp_a".to_string(), "agt_b".to_string()]);
    }

    #[test]
    fn sanitize_caps_the_probe_count() {
        let many: Vec<String> = (0..500).map(|i| format!("cmp_{i}")).collect();
        assert_eq!(sanitize_probe_uids(many).len(), MAX_PROBE_UIDS);
    }

    #[tokio::test]
    async fn tombstoned_company_is_retired_and_new_company_is_live() {
        let (probe, _) = answers(vec![
            ("cmp_retired", Ok(EntityLiveness::Gone)),
            ("cmp_new", Ok(live(&[]))),
        ]);
        let out = classify_entities(vec!["cmp_retired".into(), "cmp_new".into()], probe).await;
        assert_eq!(out.retired_company_uids, vec!["cmp_retired".to_string()]);
        assert_eq!(out.live_uids, vec!["cmp_new".to_string()]);
    }

    #[tokio::test]
    async fn failed_read_marks_nothing() {
        let (probe, _) = answers(vec![("cmp_flaky", Err("HTTP 503".into()))]);
        let out = classify_entities(vec!["cmp_flaky".into()], probe).await;
        assert_eq!(out, RetiredEntities::default());
    }

    #[tokio::test]
    async fn live_bot_has_its_companies_probed() {
        let (probe, calls) = answers(vec![
            ("agt_lychee", Ok(live(&["cmp_retired"]))),
            ("agt_scout", Ok(live(&["cmp_retired", "cmp_live"]))),
            ("cmp_retired", Ok(EntityLiveness::Gone)),
            ("cmp_live", Ok(live(&[]))),
        ]);
        let out = classify_entities(vec!["agt_lychee".into(), "agt_scout".into()], probe).await;
        assert_eq!(out.retired_company_uids, vec!["cmp_retired".to_string()]);
        assert_eq!(
            out.agent_company_uids.get("agt_scout"),
            Some(&vec!["cmp_retired".to_string(), "cmp_live".to_string()])
        );
        assert!(out.live_uids.contains(&"cmp_live".to_string()));
        // Each company is read once even when two bots name it.
        let calls = calls.lock().unwrap();
        assert_eq!(calls.iter().filter(|c| *c == "cmp_retired").count(), 1);
    }

    #[test]
    fn entity_body_reads_tombstone_and_bot_companies() {
        use crate::commands::vault_client::entity_liveness_from_json;
        let tombstoned = serde_json::json!({ "uid": "cmp_a", "type": "company", "deleted": true });
        assert_eq!(entity_liveness_from_json(&tombstoned), EntityLiveness::Gone);
        let company = serde_json::json!({ "uid": "cmp_a", "type": "company", "deleted": false });
        assert_eq!(entity_liveness_from_json(&company), live(&[]));
        let bot = serde_json::json!({
            "uid": "agt_a",
            "type": "agent",
            "metadata": { "agentConfig": {
                "companyUid": "cmp_host",
                "companyMemberships": ["cmp_host", "cmp_guest", 7, "prs_x"]
            } }
        });
        assert_eq!(
            entity_liveness_from_json(&bot),
            live(&["cmp_host", "cmp_guest"])
        );
        // An unrecognized body never reads as gone.
        assert_eq!(
            entity_liveness_from_json(&serde_json::Value::Null),
            live(&[])
        );
    }

    #[tokio::test]
    async fn half_deleted_bot_is_gone() {
        let (probe, _) = answers(vec![("agt_parsnip", Ok(EntityLiveness::Gone))]);
        let out = classify_entities(vec!["agt_parsnip".into()], probe).await;
        assert_eq!(out.gone_agent_uids, vec!["agt_parsnip".to_string()]);
        assert!(out.retired_company_uids.is_empty());
    }
}
