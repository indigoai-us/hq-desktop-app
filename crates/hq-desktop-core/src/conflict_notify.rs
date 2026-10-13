//! Once-per-batch OS notification for parked conflict copies.
//!
//! hq-cloud parks a preserved copy of a file whenever a sync conflict is
//! resolved and lists the pending ones in its state folder (and in the
//! end-of-pass record the desktop polls). The desktop window shows them as a
//! "N conflict copies parked" toast. This module decides when that list is a
//! *new batch* worth one OS notification.
//!
//! Batch identity is the set of notice ids. A batch is new when it contains an
//! id that was not in the last batch this module handled. Acknowledging or
//! dropping notices only shrinks the set, so it never counts as new. The last
//! handled set is persisted next to the notice file
//! (`conflict-notice-os-notified.json`) so a relaunch does not repeat it.
//!
//! The set is recorded before the user's notification preference is applied:
//! a batch that arrived while notifications were off (or while an HQ window
//! was focused) is not announced later when the preference flips.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

/// `kind` tag for the native gate and the notification's `userInfo`. It has no
/// per-kind toggle, so the master switch and the focus rule apply.
pub const CONFLICT_NOTIFY_KIND: &str = "conflict";
/// Desktop route a notification click opens: the main window with the conflict
/// toast expanded to its Review list.
pub const CONFLICT_REVIEW_ROUTE: &str = "conflicts";
/// State file that remembers the last batch handled.
pub const CONFLICT_NOTIFY_STATE_FILE: &str = "conflict-notice-os-notified.json";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConflictNotification {
    pub title: String,
    pub body: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConflictNotifyDecision {
    /// No notice id that has not been handled already.
    NoNewBatch,
    /// New batch, but the notification preference suppressed the OS banner.
    Suppressed,
    /// New batch; deliver this notification.
    Send(ConflictNotification),
}

fn notice_id(notice: &serde_json::Value) -> Option<&str> {
    notice
        .get("id")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|id| !id.is_empty())
}

/// The batch identity: every non-empty notice id.
pub fn conflict_batch_ids(notices: &[serde_json::Value]) -> BTreeSet<String> {
    notices
        .iter()
        .filter_map(notice_id)
        .map(str::to_string)
        .collect()
}

/// Notification copy, matching the in-window toast wording.
pub fn conflict_notification_copy(notices: &[serde_json::Value]) -> Option<ConflictNotification> {
    let first_path = notices
        .iter()
        .find_map(|notice| notice.get("relativePath").and_then(|value| value.as_str()))
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .unwrap_or("A synced file");
    match notices.len() {
        0 => None,
        1 => Some(ConflictNotification {
            title: "Conflict copy parked".to_string(),
            body: format!("{first_path} has a preserved copy."),
        }),
        count => Some(ConflictNotification {
            title: format!("{count} conflict copies parked"),
            body: format!("{first_path} and {} more have preserved copies.", count - 1),
        }),
    }
}

pub fn conflict_notify_state_path(state_dir: &Path) -> PathBuf {
    state_dir.join(CONFLICT_NOTIFY_STATE_FILE)
}

#[derive(serde::Serialize, serde::Deserialize, Default)]
struct NotifiedBatch {
    #[serde(default)]
    ids: Vec<String>,
}

fn read_notified_ids(state_dir: &Path) -> BTreeSet<String> {
    std::fs::read_to_string(conflict_notify_state_path(state_dir))
        .ok()
        .and_then(|raw| serde_json::from_str::<NotifiedBatch>(&raw).ok())
        .map(|batch| batch.ids.into_iter().collect())
        .unwrap_or_default()
}

fn write_notified_ids(state_dir: &Path, ids: &BTreeSet<String>) -> std::io::Result<()> {
    let path = conflict_notify_state_path(state_dir);
    let tmp = path.with_extension("json.tmp");
    let raw = serde_json::to_string(&NotifiedBatch {
        ids: ids.iter().cloned().collect(),
    })
    .map_err(std::io::Error::other)?;
    std::fs::write(&tmp, raw)?;
    std::fs::rename(&tmp, &path)
}

/// Decide whether `notices` is a new batch and, if so, whether the preference
/// gate allows an OS notification. `native_allowed` is consulted only for a
/// new batch (it reads the user's notification settings and focus state).
///
/// A new batch is recorded before the gate runs. When the record cannot be
/// written the batch is reported as not new, so a broken state file can never
/// turn every poll into a notification.
pub fn decide_conflict_notification(
    state_dir: &Path,
    notices: &[serde_json::Value],
    native_allowed: impl FnOnce() -> bool,
) -> ConflictNotifyDecision {
    let current = conflict_batch_ids(notices);
    if current.is_empty() {
        return ConflictNotifyDecision::NoNewBatch;
    }
    let previous = read_notified_ids(state_dir);
    if current.is_subset(&previous) {
        return ConflictNotifyDecision::NoNewBatch;
    }
    if write_notified_ids(state_dir, &current).is_err() {
        return ConflictNotifyDecision::NoNewBatch;
    }
    if !native_allowed() {
        return ConflictNotifyDecision::Suppressed;
    }
    match conflict_notification_copy(notices) {
        Some(notification) => ConflictNotifyDecision::Send(notification),
        None => ConflictNotifyDecision::NoNewBatch,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::native_notify::should_native_notify_from;
    use serde_json::json;

    fn temp_state_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "hq-conflict-notify-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn notice(id: &str, path: &str) -> serde_json::Value {
        json!({
            "id": id,
            "scope": "company",
            "companySlug": "acme",
            "relativePath": path,
            "backupPath": format!(".hq/conflict-backups/{path}"),
            "winnerReason": "local-newer",
            "sideKept": "local",
            "parkedAt": "2026-10-10T12:00:00.000Z",
        })
    }

    fn allowed() -> bool {
        should_native_notify_from(Some("{}"), CONFLICT_NOTIFY_KIND, false)
    }

    #[test]
    fn sends_once_per_batch_across_polls_and_relaunches() {
        let dir = temp_state_dir("once");
        let batch = vec![notice("a", "docs/INDEX.md"), notice("b", "docs/b.md")];

        let first = decide_conflict_notification(&dir, &batch, allowed);
        assert_eq!(
            first,
            ConflictNotifyDecision::Send(ConflictNotification {
                title: "2 conflict copies parked".into(),
                body: "docs/INDEX.md and 1 more have preserved copies.".into(),
            })
        );
        // The next poll, and a relaunch reading the same state file, see the
        // same batch and stay quiet.
        assert_eq!(
            decide_conflict_notification(&dir, &batch, allowed),
            ConflictNotifyDecision::NoNewBatch
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn acknowledging_part_of_a_batch_is_not_a_new_batch() {
        let dir = temp_state_dir("shrink");
        let batch = vec![notice("a", "a.md"), notice("b", "b.md")];
        assert!(matches!(
            decide_conflict_notification(&dir, &batch, allowed),
            ConflictNotifyDecision::Send(_)
        ));
        let shrunk = vec![notice("b", "b.md")];
        assert_eq!(
            decide_conflict_notification(&dir, &shrunk, || panic!("gate must not run")),
            ConflictNotifyDecision::NoNewBatch
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_new_notice_starts_a_new_batch() {
        let dir = temp_state_dir("new");
        let batch = vec![notice("a", "a.md")];
        assert!(matches!(
            decide_conflict_notification(&dir, &batch, allowed),
            ConflictNotifyDecision::Send(_)
        ));
        let grown = vec![notice("a", "a.md"), notice("c", "c.md")];
        assert!(matches!(
            decide_conflict_notification(&dir, &grown, allowed),
            ConflictNotifyDecision::Send(_)
        ));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn notification_preference_off_suppresses_and_does_not_replay_later() {
        let dir = temp_state_dir("pref-off");
        let batch = vec![notice("a", "a.md")];
        let off = Some(r#"{"systemNotifications":false}"#);
        assert_eq!(
            decide_conflict_notification(&dir, &batch, || {
                should_native_notify_from(off, CONFLICT_NOTIFY_KIND, false)
            }),
            ConflictNotifyDecision::Suppressed
        );
        // Turning notifications back on does not announce the old batch.
        assert_eq!(
            decide_conflict_notification(&dir, &batch, allowed),
            ConflictNotifyDecision::NoNewBatch
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn focused_window_follows_the_only_when_unfocused_preference() {
        let dir = temp_state_dir("focus");
        let batch = vec![notice("a", "a.md")];
        assert_eq!(
            decide_conflict_notification(&dir, &batch, || {
                should_native_notify_from(Some("{}"), CONFLICT_NOTIFY_KIND, true)
            }),
            ConflictNotifyDecision::Suppressed
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn empty_or_id_less_lists_never_notify() {
        let dir = temp_state_dir("empty");
        assert_eq!(
            decide_conflict_notification(&dir, &[], allowed),
            ConflictNotifyDecision::NoNewBatch
        );
        assert_eq!(
            decide_conflict_notification(&dir, &[json!({"relativePath": "a.md"})], allowed),
            ConflictNotifyDecision::NoNewBatch
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn unwritable_state_never_notifies() {
        let missing = std::env::temp_dir().join(format!(
            "hq-conflict-notify-missing-{}/nested",
            std::process::id()
        ));
        assert_eq!(
            decide_conflict_notification(&missing, &[notice("a", "a.md")], allowed),
            ConflictNotifyDecision::NoNewBatch
        );
    }

    #[test]
    fn single_notice_copy_matches_the_toast() {
        assert_eq!(
            conflict_notification_copy(&[notice("a", "boards/primary.md")]),
            Some(ConflictNotification {
                title: "Conflict copy parked".into(),
                body: "boards/primary.md has a preserved copy.".into(),
            })
        );
    }
}
