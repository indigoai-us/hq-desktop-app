//! Persisted "already bannered" set for unattributed-meeting banners.
//!
//! The unattributed poller (`poll_unattributed_once` in the app) raises an
//! "Assign" banner for each meeting that hq-pro has not filed to a company.
//! The seen set used to live only in memory, so every app restart (update,
//! relaunch, crash) re-raised the same banners: the newest scheduled
//! unattributed meeting was shown again on each launch, even when it was a
//! future meeting unrelated to the call the user was in.
//!
//! Persisted at `~/.hq/unattributed-banner-seen.json` as a map of seen key to
//! the RFC 3339 time it was first bannered. Entries older than 14 days are
//! pruned on load. Writes are atomic (temp file + rename).
//!
//! ## Keys
//! Each candidate contributes up to two keys:
//! - `bot:<bot_id>`
//! - `event:<calendar_event_id>|<scheduled_start_time>` when the bot carries a
//!   calendar event id. A rejoin or replacement bot for the same calendar
//!   occurrence gets a new `bot_id` but the same event key, so it is not
//!   bannered again. The start time is part of the key so that separate
//!   occurrences of a recurring series that share one event id still count as
//!   separate meetings.
//!
//! A candidate is new only when none of its keys has been seen.

use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Duration, Utc};

use super::meetings::ScheduledBot;
use super::paths::hq_config_dir;

/// Seen key to the RFC 3339 time it was first bannered.
pub type UnattributedSeen = HashMap<String, String>;

/// How long a seen entry is kept before pruning.
pub const UNATTRIBUTED_SEEN_RETENTION_DAYS: i64 = 14;

/// `~/.hq/unattributed-banner-seen.json`.
pub fn unattributed_seen_path() -> Result<PathBuf, String> {
    Ok(hq_config_dir()?.join("unattributed-banner-seen.json"))
}

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|s| !s.is_empty())
}

/// Dedupe keys for one bot. Empty when the bot has neither id.
pub fn seen_keys(bot: &ScheduledBot) -> Vec<String> {
    let mut keys = Vec::new();
    if let Some(id) = non_empty(Some(bot.bot_id.as_str())) {
        keys.push(format!("bot:{id}"));
    }
    if let Some(event) = non_empty(bot.calendar_event_id.as_deref()) {
        let start = non_empty(bot.scheduled_start_time.as_deref()).unwrap_or("");
        keys.push(format!("event:{event}|{start}"));
    }
    keys
}

/// Return the bot ids among `candidates` that have not been bannered yet, and
/// mark every key of each returned bot as seen at `now`.
///
/// Bots with an empty `bot_id` are skipped: the banner needs the id to assign
/// the meeting. Two candidates in the same batch that share an event key are
/// reported once.
pub fn dedupe_new_persistent(
    seen: &mut UnattributedSeen,
    candidates: &[&ScheduledBot],
    now: DateTime<Utc>,
) -> Vec<String> {
    let stamp = now.to_rfc3339();
    let mut out = Vec::new();
    for bot in candidates {
        if bot.bot_id.trim().is_empty() {
            continue;
        }
        let keys = seen_keys(bot);
        let already = keys.iter().any(|k| seen.contains_key(k));
        for key in keys {
            seen.entry(key).or_insert_with(|| stamp.clone());
        }
        if !already {
            out.push(bot.bot_id.clone());
        }
    }
    out
}

/// Drop entries older than the retention window, and entries whose timestamp
/// does not parse.
pub fn prune_seen(seen: &mut UnattributedSeen, now: DateTime<Utc>) {
    let cutoff = now - Duration::days(UNATTRIBUTED_SEEN_RETENTION_DAYS);
    seen.retain(|_, at| {
        DateTime::parse_from_rfc3339(at)
            .map(|dt| dt.with_timezone(&Utc) > cutoff)
            .unwrap_or(false)
    });
}

/// Load the seen map from `path` and prune it. A missing or unreadable file
/// yields an empty map; the cost of a corrupt file is one repeated banner.
pub fn load_seen(path: &Path, now: DateTime<Utc>) -> UnattributedSeen {
    let mut seen: UnattributedSeen = fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    prune_seen(&mut seen, now);
    seen
}

/// Write the seen map to `path` atomically (temp file + rename).
pub fn save_seen(path: &Path, seen: &UnattributedSeen) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    let body = serde_json::to_string_pretty(seen).map_err(|e| e.to_string())?;
    let mut f = fs::File::create(&tmp).map_err(|e| e.to_string())?;
    f.write_all(body.as_bytes()).map_err(|e| e.to_string())?;
    f.sync_all().ok();
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn bot(id: &str, event: Option<&str>, start: Option<&str>) -> ScheduledBot {
        ScheduledBot {
            bot_id: id.into(),
            meeting_url: "https://meet.google.com/abc-defg-hij".into(),
            platform: "google_meet".into(),
            status: "scheduled".into(),
            calendar_event_id: event.map(Into::into),
            calendar_series_id: None,
            recurring_meeting: false,
            meeting_title: Some("MLS | Discovery | Guardian Capital Partners".into()),
            scheduled_start_time: start.map(Into::into),
            created_at: None,
            updated_at: None,
            company_id: None,
            auto_scheduled: false,
            error_message: None,
            terminal_sub_code: None,
            failure_reason: None,
            source_landed: false,
        }
    }

    fn at(h: u32, m: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 9, 23, h, m, 0).unwrap()
    }

    #[test]
    fn same_meeting_is_not_rebannered_after_restart() {
        // feedback_73935996: the same "Guardian Capital Partners" banner came
        // back at 16:00Z, 16:31Z and 16:47Z. Each app launch started with an
        // empty in-memory seen set. The set now survives a reload from disk.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("unattributed-banner-seen.json");
        let guardian = bot("bot_guardian", Some("evt_guardian"), Some("2026-09-23T20:00:00Z"));

        let mut seen = load_seen(&path, at(16, 0));
        assert_eq!(
            dedupe_new_persistent(&mut seen, &[&guardian], at(16, 0)),
            vec!["bot_guardian"]
        );
        save_seen(&path, &seen).unwrap();

        // Simulated restart: fresh process, state only from disk.
        let mut seen = load_seen(&path, at(16, 31));
        assert!(dedupe_new_persistent(&mut seen, &[&guardian], at(16, 31)).is_empty());
        save_seen(&path, &seen).unwrap();

        let mut seen = load_seen(&path, at(16, 47));
        assert!(dedupe_new_persistent(&mut seen, &[&guardian], at(16, 47)).is_empty());
    }

    #[test]
    fn replacement_bot_for_same_calendar_occurrence_is_not_rebannered() {
        let mut seen = UnattributedSeen::new();
        let first = bot("bot_a", Some("evt_1"), Some("2026-09-23T20:00:00Z"));
        let rejoin = bot("bot_b", Some("evt_1"), Some("2026-09-23T20:00:00Z"));
        assert_eq!(dedupe_new_persistent(&mut seen, &[&first], at(16, 0)), vec!["bot_a"]);
        assert!(dedupe_new_persistent(&mut seen, &[&rejoin], at(16, 2)).is_empty());
        // Both bot keys are now recorded.
        assert!(seen.contains_key("bot:bot_a"));
        assert!(seen.contains_key("bot:bot_b"));
    }

    #[test]
    fn duplicate_event_within_one_batch_is_reported_once() {
        let mut seen = UnattributedSeen::new();
        let a = bot("bot_a", Some("evt_1"), Some("2026-09-23T20:00:00Z"));
        let b = bot("bot_b", Some("evt_1"), Some("2026-09-23T20:00:00Z"));
        assert_eq!(dedupe_new_persistent(&mut seen, &[&a, &b], at(16, 0)), vec!["bot_a"]);
    }

    #[test]
    fn separate_occurrences_of_a_series_are_separate_meetings() {
        let mut seen = UnattributedSeen::new();
        let monday = bot("bot_mon", Some("evt_series"), Some("2026-09-21T15:00:00Z"));
        let tuesday = bot("bot_tue", Some("evt_series"), Some("2026-09-22T15:00:00Z"));
        assert_eq!(dedupe_new_persistent(&mut seen, &[&monday], at(16, 0)), vec!["bot_mon"]);
        assert_eq!(dedupe_new_persistent(&mut seen, &[&tuesday], at(16, 2)), vec!["bot_tue"]);
    }

    #[test]
    fn bot_without_event_id_dedupes_on_bot_id() {
        let mut seen = UnattributedSeen::new();
        let a = bot("bot_a", None, None);
        let other = bot("bot_other", None, None);
        let empty = bot("", Some("evt_x"), None);
        assert_eq!(
            dedupe_new_persistent(&mut seen, &[&a, &a, &empty, &other], at(16, 0)),
            vec!["bot_a", "bot_other"]
        );
        assert!(dedupe_new_persistent(&mut seen, &[&a], at(16, 2)).is_empty());
        // An empty bot id is skipped and leaves no key behind.
        assert!(!seen.contains_key("event:evt_x|"));
    }

    #[test]
    fn entries_older_than_retention_are_pruned_on_load() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("seen.json");
        let mut seen = UnattributedSeen::new();
        seen.insert("bot:old".into(), (at(16, 0) - Duration::days(15)).to_rfc3339());
        seen.insert("bot:recent".into(), (at(16, 0) - Duration::days(2)).to_rfc3339());
        seen.insert("bot:corrupt".into(), "not a time".into());
        save_seen(&path, &seen).unwrap();

        let loaded = load_seen(&path, at(16, 0));
        assert!(loaded.contains_key("bot:recent"));
        assert!(!loaded.contains_key("bot:old"));
        assert!(!loaded.contains_key("bot:corrupt"));
    }

    #[test]
    fn missing_or_corrupt_file_loads_empty() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("missing.json");
        assert!(load_seen(&missing, at(16, 0)).is_empty());
        let corrupt = dir.path().join("corrupt.json");
        fs::write(&corrupt, "{not json").unwrap();
        assert!(load_seen(&corrupt, at(16, 0)).is_empty());
    }

    #[test]
    fn save_creates_parent_dir_and_leaves_no_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("seen.json");
        let mut seen = UnattributedSeen::new();
        seen.insert("bot:a".into(), at(16, 0).to_rfc3339());
        save_seen(&path, &seen).unwrap();
        assert!(path.exists());
        assert!(!path.with_extension("json.tmp").exists());
    }
}
