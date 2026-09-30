//! Per-company "uploads paused" state (hard-stop-readiness US-019).
//!
//! When a Starter company is over its storage limit, hq-pro refuses new file
//! uploads and the sync runner reports one `plan-limit` notice per company per
//! pass. Before this module the desktop forwarded that notice to one window
//! and otherwise counted the pass as a clean sync, so the menu bar said the
//! company was synced while its new files were not uploading.
//!
//! This registry is the single answer to "whose uploads are paused right now".
//! It is fed by runner notices, settled at the end of every pass, persisted in
//! the desktop sync journal, and read by the window, the status header, and
//! the menu bar.
//!
//! Clearing rule. hq-cloud US-012 stops re-trying a plan-paused file every
//! pass: it waits for the plan state to change or, at most, an hour. A pass
//! that does not mention the company is therefore not proof that uploads
//! resumed. A company is cleared only when a pass that completed for it
//! carried no notice AND either that pass uploaded a file for it (uploads are
//! flowing again) or the last notice is older than the runner's retry window
//! (the runner has re-tried and was not refused).

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

/// Longest gap hq-cloud leaves between re-tries of a plan-paused file
/// (hq-cloud US-012: "retry when the plan state changes or at most hourly").
pub const PLAN_PAUSE_RETRY_WINDOW_MS: i64 = 60 * 60 * 1000;

/// One company whose new files are not uploading because of a plan limit.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UploadsPaused {
    /// Company label exactly as the runner reports it.
    pub company: String,
    /// Approved upgrade link from hq-pro (see `plan_limit`), when one came.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upgrade_url: Option<String>,
    /// Epoch milliseconds of the most recent runner notice.
    pub last_notice_at_ms: i64,
}

/// What one finished sync pass said about uploads, per company.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UploadsPassObservation {
    /// Companies the runner sent a `plan-limit` notice for, with the approved
    /// upgrade link (if the link passed the allowlist).
    pub plan_limited: BTreeMap<String, Option<String>>,
    /// Companies that emitted a per-company `complete` this pass.
    pub completed: BTreeSet<String>,
    /// Companies that uploaded at least one file this pass.
    pub uploaded: BTreeSet<String>,
}

impl UploadsPassObservation {
    pub fn is_empty(&self) -> bool {
        self.plan_limited.is_empty() && self.completed.is_empty() && self.uploaded.is_empty()
    }
}

/// The paused-uploads set.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UploadsPausedRegistry {
    entries: BTreeMap<String, UploadsPaused>,
}

impl UploadsPausedRegistry {
    /// Rebuild from a persisted snapshot (the desktop sync journal).
    pub fn from_snapshot(snapshot: impl IntoIterator<Item = UploadsPaused>) -> Self {
        let entries = snapshot
            .into_iter()
            .filter(|entry| !entry.company.trim().is_empty())
            .map(|entry| (entry.company.clone(), entry))
            .collect();
        Self { entries }
    }

    /// Stable, company-ordered snapshot for the journal and the UI.
    pub fn snapshot(&self) -> Vec<UploadsPaused> {
        self.entries.values().cloned().collect()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// The upgrade link recorded for a company, if any.
    pub fn upgrade_url_for(&self, company: &str) -> Option<String> {
        self.entries
            .get(company)
            .and_then(|entry| entry.upgrade_url.clone())
    }

    /// Record a runner `plan-limit` notice. Returns true when what a person
    /// sees changed (a newly paused company, or a different link).
    pub fn record_notice(
        &mut self,
        company: &str,
        upgrade_url: Option<String>,
        now_ms: i64,
    ) -> bool {
        let company = company.trim();
        if company.is_empty() {
            return false;
        }
        match self.entries.get_mut(company) {
            Some(entry) => {
                entry.last_notice_at_ms = entry.last_notice_at_ms.max(now_ms);
                // Keep a known link when a later notice arrives without one.
                if upgrade_url.is_some() && entry.upgrade_url != upgrade_url {
                    entry.upgrade_url = upgrade_url;
                    return true;
                }
                false
            }
            None => {
                self.entries.insert(
                    company.to_string(),
                    UploadsPaused {
                        company: company.to_string(),
                        upgrade_url,
                        last_notice_at_ms: now_ms,
                    },
                );
                true
            }
        }
    }

    /// Settle a finished pass (see the module docs for the clearing rule).
    /// Returns true when what a person sees changed.
    pub fn settle_pass(&mut self, pass: &UploadsPassObservation, now_ms: i64) -> bool {
        let mut changed = false;
        for (company, upgrade_url) in &pass.plan_limited {
            changed |= self.record_notice(company, upgrade_url.clone(), now_ms);
        }
        let resumed: Vec<String> = self
            .entries
            .values()
            .filter(|entry| {
                pass.completed.contains(&entry.company)
                    && !pass.plan_limited.contains_key(&entry.company)
                    && (pass.uploaded.contains(&entry.company)
                        || now_ms.saturating_sub(entry.last_notice_at_ms)
                            >= PLAN_PAUSE_RETRY_WINDOW_MS)
            })
            .map(|entry| entry.company.clone())
            .collect();
        for company in resumed {
            self.entries.remove(&company);
            changed = true;
        }
        changed
    }

    /// Forget everything (sign-out: the next account starts clean).
    pub fn clear(&mut self) -> bool {
        let changed = !self.entries.is_empty();
        self.entries.clear();
        changed
    }
}

/// "Uploads paused for Acme" / "Uploads paused for Acme and Beta" /
/// "Uploads paused for 3 companies". `None` when nothing is paused.
pub fn uploads_paused_summary(snapshot: &[UploadsPaused]) -> Option<String> {
    match snapshot {
        [] => None,
        [one] => Some(format!("Uploads paused for {}", one.company)),
        [a, b] => Some(format!(
            "Uploads paused for {} and {}",
            a.company, b.company
        )),
        many => Some(format!("Uploads paused for {} companies", many.len())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const URL: &str = "https://hq.computer/companies/acme/billing?upgrade=1";
    const HOUR: i64 = PLAN_PAUSE_RETRY_WINDOW_MS;

    fn pass(
        plan_limited: &[(&str, Option<&str>)],
        completed: &[&str],
        uploaded: &[&str],
    ) -> UploadsPassObservation {
        UploadsPassObservation {
            plan_limited: plan_limited
                .iter()
                .map(|(c, u)| (c.to_string(), u.map(str::to_string)))
                .collect(),
            completed: completed.iter().map(|c| c.to_string()).collect(),
            uploaded: uploaded.iter().map(|c| c.to_string()).collect(),
        }
    }

    #[test]
    fn a_pass_with_plan_limit_skips_pauses_that_company_only() {
        let mut registry = UploadsPausedRegistry::default();
        let changed = registry.settle_pass(
            &pass(&[("Acme", Some(URL))], &["Acme", "Beta"], &["Beta"]),
            1_000,
        );
        assert!(changed);
        assert_eq!(
            registry.snapshot(),
            vec![UploadsPaused {
                company: "Acme".into(),
                upgrade_url: Some(URL.into()),
                last_notice_at_ms: 1_000,
            }]
        );
        assert_eq!(registry.upgrade_url_for("Acme").as_deref(), Some(URL));
        assert_eq!(registry.upgrade_url_for("Beta"), None);
    }

    #[test]
    fn a_quiet_pass_inside_the_retry_window_keeps_the_pause() {
        // hq-cloud US-012 skips paused files silently for up to an hour.
        let mut registry = UploadsPausedRegistry::default();
        registry.record_notice("Acme", Some(URL.into()), 0);
        assert!(!registry.settle_pass(&pass(&[], &["Acme"], &[]), HOUR - 1));
        assert!(!registry.is_empty());
    }

    #[test]
    fn a_pass_that_uploads_clears_the_pause_immediately() {
        let mut registry = UploadsPausedRegistry::default();
        registry.record_notice("Acme", Some(URL.into()), 0);
        assert!(registry.settle_pass(&pass(&[], &["Acme"], &["Acme"]), 10));
        assert!(registry.is_empty());
    }

    #[test]
    fn a_quiet_pass_after_the_retry_window_clears_the_pause() {
        let mut registry = UploadsPausedRegistry::default();
        registry.record_notice("Acme", Some(URL.into()), 0);
        assert!(registry.settle_pass(&pass(&[], &["Acme"], &[]), HOUR));
        assert!(registry.is_empty());
    }

    #[test]
    fn a_pass_that_did_not_reach_the_company_keeps_the_pause() {
        // A single-company "Sync Now" for Beta says nothing about Acme.
        let mut registry = UploadsPausedRegistry::default();
        registry.record_notice("Acme", Some(URL.into()), 0);
        assert!(!registry.settle_pass(&pass(&[], &["Beta"], &["Beta"]), 5 * HOUR));
        assert_eq!(registry.snapshot().len(), 1);
    }

    #[test]
    fn a_repeated_notice_refreshes_the_clock_without_a_visible_change() {
        let mut registry = UploadsPausedRegistry::default();
        assert!(registry.record_notice("Acme", Some(URL.into()), 0));
        assert!(!registry.record_notice("Acme", None, HOUR));
        assert_eq!(registry.upgrade_url_for("Acme").as_deref(), Some(URL));
        // The refreshed clock means a quiet pass shortly after keeps it.
        assert!(!registry.settle_pass(&pass(&[], &["Acme"], &[]), HOUR + 10));
        let other = "https://hq.computer/billing";
        assert!(registry.record_notice("Acme", Some(other.into()), HOUR + 20));
        assert_eq!(registry.upgrade_url_for("Acme").as_deref(), Some(other));
    }

    #[test]
    fn the_snapshot_round_trips_through_the_journal_shape() {
        let mut registry = UploadsPausedRegistry::default();
        registry.record_notice("Beta", None, 7);
        registry.record_notice("Acme", Some(URL.into()), 9);
        let json = serde_json::to_value(registry.snapshot()).unwrap();
        assert_eq!(
            json,
            serde_json::json!([
                { "company": "Acme", "upgradeUrl": URL, "lastNoticeAtMs": 9 },
                { "company": "Beta", "lastNoticeAtMs": 7 },
            ])
        );
        let restored: Vec<UploadsPaused> = serde_json::from_value(json).unwrap();
        assert_eq!(UploadsPausedRegistry::from_snapshot(restored), registry);
    }

    #[test]
    fn blank_company_labels_are_ignored() {
        let mut registry = UploadsPausedRegistry::default();
        assert!(!registry.record_notice("  ", Some(URL.into()), 0));
        assert!(registry.is_empty());
    }

    #[test]
    fn clear_forgets_every_company() {
        let mut registry = UploadsPausedRegistry::default();
        assert!(!registry.clear());
        registry.record_notice("Acme", None, 0);
        assert!(registry.clear());
        assert!(registry.is_empty());
    }

    #[test]
    fn summary_names_the_companies() {
        let one = UploadsPaused {
            company: "Acme".into(),
            upgrade_url: None,
            last_notice_at_ms: 0,
        };
        let two = UploadsPaused {
            company: "Beta".into(),
            ..one.clone()
        };
        let three = UploadsPaused {
            company: "Gamma".into(),
            ..one.clone()
        };
        assert_eq!(uploads_paused_summary(&[]), None);
        assert_eq!(
            uploads_paused_summary(std::slice::from_ref(&one)).as_deref(),
            Some("Uploads paused for Acme")
        );
        assert_eq!(
            uploads_paused_summary(&[one.clone(), two.clone()]).as_deref(),
            Some("Uploads paused for Acme and Beta")
        );
        assert_eq!(
            uploads_paused_summary(&[one, two, three]).as_deref(),
            Some("Uploads paused for 3 companies")
        );
    }
}
