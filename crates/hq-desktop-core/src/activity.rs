use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::events::{SyncNewFilesEvent, SyncProgressEvent};

/// One file change observed during this app session.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ActivityEntry {
    /// Company slug the change belongs to.
    pub company: String,
    /// File path, relative to the company root (as the runner reports it).
    pub path: String,
    /// Size in bytes (0 for deletions).
    pub bytes: u64,
    /// `"up"` (uploaded / synced), `"down"` (downloaded / new-or-updated), or
    /// `"deleted"` (remote delete-marker written). Derived from the runner's
    /// `direction` + `deleted` fields, defaulting to `"down"` for pre-5.29
    /// runners that don't stamp a direction.
    pub direction: String,
    /// Email of the file's author (from the runner's `progress.author`, sourced
    /// from S3 `created-by`). Only present on download rows — a downloaded file
    /// was authored by whoever uploaded it. None on uploads/deletions and on
    /// pre-5.31 runners. The activity log shows it so the user sees who authored
    /// each file they received.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub author: Option<String>,
    /// `Some(true)` if the download was a *new* file (first time this drive saw
    /// it), `Some(false)` if it was an *update* to an existing file, `None` when
    /// not yet known. Back-filled by the app when the runner's per-company
    /// `new-files` event arrives (it lands *after* the file's `progress` event,
    /// so the entry is created with `None` and reconciled later). Drives the
    /// activity log's "added" vs "updated" verb on download rows. Always `None`
    /// on uploads/deletions.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub is_new: Option<bool>,
    /// Epoch milliseconds when the menubar observed the change.
    pub at: u64,
}

pub fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Map a runner `progress` event onto an [`ActivityEntry`] direction.
pub fn direction_for(p: &SyncProgressEvent) -> String {
    if p.deleted == Some(true) {
        return "deleted".to_string();
    }
    match p.direction.as_deref() {
        Some("up") => "up",
        Some("down") => "down",
        // Pre-5.29 runners don't stamp direction; `progress` was historically
        // a download-only event, so default to "down".
        _ => "down",
    }
    .to_string()
}

/// Pure reconciliation step (extracted for testability): flip `is_new` and
/// back-fill `author` on the matching download rows. Matches newest-first within
/// each company+path so a same-session re-download attributes the latest row.
pub fn apply_new_files(log: &mut [ActivityEntry], e: &SyncNewFilesEvent) {
    for file in &e.files {
        if let Some(entry) = log.iter_mut().rev().find(|entry| {
            entry.direction == "down" && entry.company == e.company && entry.path == file.path
        }) {
            entry.is_new = Some(true);
            if entry.author.is_none() {
                entry.author = file.added_by.clone();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    const MAX_ENTRIES: usize = 2000;

    struct SessionActivity(pub Mutex<Vec<ActivityEntry>>);

    impl SessionActivity {
        pub fn new() -> Self {
            SessionActivity(Mutex::new(Vec::new()))
        }

        fn push(&self, entry: ActivityEntry) {
            let mut v = self.0.lock().unwrap_or_else(|e| e.into_inner());
            v.push(entry);
            let len = v.len();
            if len > MAX_ENTRIES {
                v.drain(0..len - MAX_ENTRIES);
            }
        }

        fn snapshot(&self) -> Vec<ActivityEntry> {
            self.0.lock().unwrap_or_else(|e| e.into_inner()).clone()
        }
    }

    fn ev(direction: Option<&str>, deleted: Option<bool>) -> SyncProgressEvent {
        ev_with_author(direction, deleted, None)
    }

    fn ev_with_author(
        direction: Option<&str>,
        deleted: Option<bool>,
        author: Option<&str>,
    ) -> SyncProgressEvent {
        SyncProgressEvent {
            company: "indigo".to_string(),
            path: "knowledge/x.md".to_string(),
            bytes: 10,
            message: None,
            direction: direction.map(|s| s.to_string()),
            deleted,
            author: author.map(|s| s.to_string()),
        }
    }

    #[test]
    fn direction_maps_up_down_deleted_and_defaults() {
        assert_eq!(direction_for(&ev(Some("up"), None)), "up");
        assert_eq!(direction_for(&ev(Some("down"), None)), "down");
        // deleted wins over direction
        assert_eq!(direction_for(&ev(Some("up"), Some(true))), "deleted");
        // pre-5.29 runner (no direction) defaults to download
        assert_eq!(direction_for(&ev(None, None)), "down");
    }

    #[test]
    fn author_flows_from_progress_event_into_entry() {
        // A download event carrying `author` (from S3 created-by) maps onto the
        // ActivityEntry so the activity log can attribute the file.
        let p = ev_with_author(Some("down"), None, Some("alice@example.com"));
        let entry = ActivityEntry {
            company: p.company.clone(),
            path: p.path.clone(),
            bytes: p.bytes,
            direction: direction_for(&p),
            author: p.author.clone(),
            is_new: None,
            at: 0,
        };
        assert_eq!(entry.author, Some("alice@example.com".to_string()));

        // An upload event has no author.
        let up = ev_with_author(Some("up"), None, None);
        assert_eq!(up.author, None);
    }

    #[test]
    fn push_trims_to_max_entries() {
        let state = SessionActivity::new();
        for i in 0..(MAX_ENTRIES + 50) {
            state.push(ActivityEntry {
                company: "c".to_string(),
                path: format!("f{i}.md"),
                bytes: 1,
                direction: "down".to_string(),
                author: None,
                is_new: None,
                at: i as u64,
            });
        }
        let snap = state.snapshot();
        assert_eq!(snap.len(), MAX_ENTRIES);
        // Oldest dropped: first retained entry is f50.md (at=50).
        assert_eq!(snap.first().unwrap().at, 50);
        assert_eq!(
            snap.last().unwrap().path,
            format!("f{}.md", MAX_ENTRIES + 49)
        );
    }

    fn down(company: &str, path: &str, author: Option<&str>) -> ActivityEntry {
        ActivityEntry {
            company: company.to_string(),
            path: path.to_string(),
            bytes: 1,
            direction: "down".to_string(),
            author: author.map(|s| s.to_string()),
            is_new: None,
            at: 0,
        }
    }

    fn new_files(
        company: &str,
        files: &[(&str, Option<&str>)],
    ) -> crate::events::SyncNewFilesEvent {
        crate::events::SyncNewFilesEvent {
            company: company.to_string(),
            files: files
                .iter()
                .map(|(path, added_by)| crate::events::SyncNewFileEntry {
                    path: path.to_string(),
                    bytes: 1,
                    added_by: added_by.map(|s| s.to_string()),
                })
                .collect(),
        }
    }

    #[test]
    fn new_files_marks_added_and_backfills_author() {
        let mut log = vec![
            down("indigo", "a.md", None),            // named new, no author yet
            down("indigo", "b.md", Some("x@e.com")), // named new, already attributed
            down("indigo", "c.md", None),            // NOT named -> stays an update
        ];
        apply_new_files(
            &mut log,
            &new_files(
                "indigo",
                &[("a.md", Some("tom@e.com")), ("b.md", Some("y@e.com"))],
            ),
        );

        // a.md: flagged new + author back-filled from addedBy
        assert_eq!(log[0].is_new, Some(true));
        assert_eq!(log[0].author.as_deref(), Some("tom@e.com"));
        // b.md: flagged new, existing author preserved (not overwritten)
        assert_eq!(log[1].is_new, Some(true));
        assert_eq!(log[1].author.as_deref(), Some("x@e.com"));
        // c.md: untouched -> renders as "updated"
        assert_eq!(log[2].is_new, None);
        assert_eq!(log[2].author, None);
    }

    #[test]
    fn new_files_only_matches_same_company_and_downloads() {
        let mut log = vec![
            ActivityEntry {
                direction: "up".to_string(),
                ..down("indigo", "a.md", None)
            }, // upload — skip
            down("acme", "a.md", None),   // other company — skip
            down("indigo", "a.md", None), // the real match
        ];
        apply_new_files(
            &mut log,
            &new_files("indigo", &[("a.md", Some("tom@e.com"))]),
        );

        assert_eq!(log[0].is_new, None, "uploads are never marked new");
        assert_eq!(log[1].is_new, None, "other-company rows are not matched");
        assert_eq!(log[2].is_new, Some(true));
        assert_eq!(log[2].author.as_deref(), Some("tom@e.com"));
    }
}
