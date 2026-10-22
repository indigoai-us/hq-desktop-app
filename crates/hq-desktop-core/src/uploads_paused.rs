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
//!
//! Usage pause (US-024). A notice can carry a `usagePause`: the company's
//! whole cloud sync is paused until Billing is fixed. The entry then records
//! the pause, and its link is the pause's Billing link. A later notice without
//! a usage pause is a fresh plan-limit notice and drops the recorded pause.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::plan_limit::UsagePause;

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
    /// Set when the latest notice was a usage pause (US-024). `upgrade_url`
    /// is then this pause's Billing link.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage_pause: Option<UsagePause>,
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
    /// Companies whose latest notice this pass was a usage pause. Every key
    /// is also in `plan_limited`.
    pub usage_paused: BTreeMap<String, UsagePause>,
}

impl UploadsPassObservation {
    pub fn is_empty(&self) -> bool {
        self.plan_limited.is_empty()
            && self.completed.is_empty()
            && self.uploaded.is_empty()
            && self.usage_paused.is_empty()
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

    /// Record a runner `plan-limit` notice without a usage pause. Returns
    /// true when what a person sees changed (a newly paused company, a
    /// different link, or a usage pause that this notice replaces).
    pub fn record_notice(
        &mut self,
        company: &str,
        upgrade_url: Option<String>,
        now_ms: i64,
    ) -> bool {
        self.record_notice_with_usage_pause(company, upgrade_url, None, now_ms)
    }

    /// Record a runner `plan-limit` notice. With a usage pause the entry's
    /// link becomes the pause's Billing link; without one any recorded pause
    /// is dropped. Returns true when what a person sees changed.
    pub fn record_notice_with_usage_pause(
        &mut self,
        company: &str,
        upgrade_url: Option<String>,
        usage_pause: Option<UsagePause>,
        now_ms: i64,
    ) -> bool {
        let company = company.trim();
        if company.is_empty() {
            return false;
        }
        let upgrade_url = match &usage_pause {
            Some(pause) => Some(pause.action_url.clone()),
            None => upgrade_url,
        };
        match self.entries.get_mut(company) {
            Some(entry) => {
                entry.last_notice_at_ms = entry.last_notice_at_ms.max(now_ms);
                let mut changed = false;
                if entry.usage_pause != usage_pause {
                    entry.usage_pause = usage_pause;
                    changed = true;
                }
                // Keep a known link when a later notice arrives without one.
                if upgrade_url.is_some() && entry.upgrade_url != upgrade_url {
                    entry.upgrade_url = upgrade_url;
                    changed = true;
                }
                changed
            }
            None => {
                self.entries.insert(
                    company.to_string(),
                    UploadsPaused {
                        company: company.to_string(),
                        upgrade_url,
                        last_notice_at_ms: now_ms,
                        usage_pause,
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
            changed |= self.record_notice_with_usage_pause(
                company,
                upgrade_url.clone(),
                pass.usage_paused.get(company).cloned(),
                now_ms,
            );
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
/// "Uploads paused for 3 companies". When every listed company is a usage
/// pause the lead is "Cloud sync paused for" instead. `None` when nothing is
/// paused.
pub fn uploads_paused_summary(snapshot: &[UploadsPaused]) -> Option<String> {
    let lead = if !snapshot.is_empty() && snapshot.iter().all(|e| e.usage_pause.is_some()) {
        "Cloud sync paused for"
    } else {
        "Uploads paused for"
    };
    match snapshot {
        [] => None,
        [one] => Some(format!("{lead} {}", one.company)),
        [a, b] => Some(format!("{lead} {} and {}", a.company, b.company)),
        many => Some(format!("{lead} {} companies", many.len())),
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
            usage_paused: BTreeMap::new(),
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
                usage_pause: None,
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

    const BILLING: &str = "https://hq.computer/companies/acme/billing";

    fn usage_pause(reason: &str) -> UsagePause {
        UsagePause {
            code: "usage_paused".into(),
            reason: reason.into(),
            message: "Cloud sync is paused. Acme used its $10.00 monthly allowance. Add a card on the Billing page to resume. Files on this computer are not affected.".into(),
            action_url: BILLING.into(),
        }
    }

    #[test]
    fn a_usage_pause_is_recorded_with_its_billing_link() {
        let mut registry = UploadsPausedRegistry::default();
        let mut observed = pass(&[("Acme", Some(URL))], &["Acme"], &[]);
        observed
            .usage_paused
            .insert("Acme".into(), usage_pause("usage_trial_cap"));
        assert!(registry.settle_pass(&observed, 5));
        assert_eq!(
            registry.snapshot(),
            vec![UploadsPaused {
                company: "Acme".into(),
                upgrade_url: Some(BILLING.into()),
                last_notice_at_ms: 5,
                usage_pause: Some(usage_pause("usage_trial_cap")),
            }]
        );
        assert_eq!(registry.upgrade_url_for("Acme").as_deref(), Some(BILLING));
        // The same pause again is not a visible change.
        assert!(!registry.settle_pass(&observed, 6));
    }

    #[test]
    fn a_later_usage_pause_replaces_a_legacy_entry_and_a_legacy_notice_clears_it() {
        let mut registry = UploadsPausedRegistry::default();
        assert!(registry.record_notice("Acme", Some(URL.into()), 0));
        assert!(registry.record_notice_with_usage_pause(
            "Acme",
            Some(URL.into()),
            Some(usage_pause("usage_card_required")),
            1,
        ));
        assert_eq!(registry.upgrade_url_for("Acme").as_deref(), Some(BILLING));
        // A different reason is a visible change.
        assert!(registry.record_notice_with_usage_pause(
            "Acme",
            None,
            Some(usage_pause("usage_spend_limit")),
            2,
        ));
        // A fresh legacy notice drops the usage pause.
        assert!(registry.record_notice("Acme", Some(URL.into()), 3));
        let entry = &registry.snapshot()[0];
        assert_eq!(entry.usage_pause, None);
        assert_eq!(entry.upgrade_url.as_deref(), Some(URL));
        // A quiet pass leaves the entry as it is.
        assert!(!registry.settle_pass(&pass(&[], &["Acme"], &[]), 4));
    }

    #[test]
    fn a_usage_pause_round_trips_through_the_journal_shape() {
        let mut registry = UploadsPausedRegistry::default();
        registry.record_notice_with_usage_pause(
            "Acme",
            None,
            Some(usage_pause("usage_trial_cap")),
            9,
        );
        let json = serde_json::to_value(registry.snapshot()).unwrap();
        assert_eq!(json[0]["upgradeUrl"], BILLING);
        assert_eq!(json[0]["usagePause"]["code"], "usage_paused");
        assert_eq!(json[0]["usagePause"]["reason"], "usage_trial_cap");
        assert_eq!(json[0]["usagePause"]["actionUrl"], BILLING);
        let restored: Vec<UploadsPaused> = serde_json::from_value(json).unwrap();
        assert_eq!(UploadsPausedRegistry::from_snapshot(restored), registry);
    }

    #[test]
    fn summary_says_cloud_sync_when_every_company_is_a_usage_pause() {
        let usage = |company: &str| UploadsPaused {
            company: company.into(),
            upgrade_url: Some(BILLING.into()),
            last_notice_at_ms: 0,
            usage_pause: Some(usage_pause("usage_trial_cap")),
        };
        let legacy = UploadsPaused {
            usage_pause: None,
            ..usage("Gamma")
        };
        assert_eq!(
            uploads_paused_summary(&[usage("Acme")]).as_deref(),
            Some("Cloud sync paused for Acme")
        );
        assert_eq!(
            uploads_paused_summary(&[usage("Acme"), usage("Beta")]).as_deref(),
            Some("Cloud sync paused for Acme and Beta")
        );
        assert_eq!(
            uploads_paused_summary(&[usage("Acme"), usage("Beta"), usage("Delta")]).as_deref(),
            Some("Cloud sync paused for 3 companies")
        );
        assert_eq!(
            uploads_paused_summary(&[usage("Acme"), legacy.clone()]).as_deref(),
            Some("Uploads paused for Acme and Gamma")
        );
        assert_eq!(
            uploads_paused_summary(&[legacy]).as_deref(),
            Some("Uploads paused for Gamma")
        );
    }

    #[test]
    fn summary_names_the_companies() {
        let one = UploadsPaused {
            company: "Acme".into(),
            upgrade_url: None,
            last_notice_at_ms: 0,
            usage_pause: None,
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
