//! Recent meetings from `companies/{co}/sources/meetings/`.
//!
//! Real layout, as written by the HQ meeting bot (`origin: recall.ai`):
//!
//! ```text
//! companies/{co}/sources/meetings/
//!   003963f4-….md         ← YAML frontmatter + `## Transcript` body
//!   003963f4-….raw.json   ← raw word-level Recall payload (never read here)
//! ```
//!
//! The `.md` frontmatter carries `id`, `source_id`, `title`,
//! `scheduled_start_time`, `created_at`, `ingested_at`, `meeting_platform`,
//! and (post-enrichment) an `entities` list. There is **no** `participants`
//! key — speakers only exist as `**Name** · \`[mm:ss–mm:ss]\`` labels in the
//! transcript body — so participants are derived from the bounded head of the
//! transcript, never from a whole-file read. Transcripts run 20 KB+ each and a
//! single company can hold 1600+ of them.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::{
    clamp, is_skippable_entry_name, modified_or_epoch, modified_rfc3339, read_head,
    split_frontmatter,
};

/// Default `limit` when the caller passes none/0.
pub const DEFAULT_LIMIT: usize = 20;
/// Hard ceiling on meetings returned regardless of the requested `limit`.
pub const MAX_LIMIT: usize = 100;
/// Ceiling on directory entries considered before sorting.
const MAX_SCANNED: usize = 20_000;
/// How much of each transcript we read: enough for frontmatter plus the first
/// stretch of speaker labels, nowhere near the whole file.
const MEETING_HEAD_BYTES: usize = 24 * 1024;
/// Ceiling on derived participants per meeting.
const MAX_PARTICIPANTS: usize = 20;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingEntry {
    /// Frontmatter `source_id` (or `id`), falling back to the file stem.
    pub id: String,
    pub title: String,
    /// Best available timestamp: `scheduled_start_time` → `created_at` →
    /// `ingested_at` → file mtime.
    pub date: Option<String>,
    /// Absolute path to the `.md` transcript.
    pub path: String,
    pub participants: Vec<String>,
    pub summary: String,
}

#[derive(Debug, Default, Deserialize)]
struct MeetingFrontmatter {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    source_id: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    scheduled_start_time: Option<String>,
    #[serde(default)]
    created_at: Option<String>,
    #[serde(default)]
    ingested_at: Option<String>,
    /// Not present on bot-written meetings, but honoured when a hand-authored
    /// note supplies it.
    #[serde(default)]
    participants: Vec<String>,
}

/// List a company's most recent meetings, newest first.
pub fn recent_meetings(hq_root: &Path, company: &str, limit: usize) -> Vec<MeetingEntry> {
    let company = company.trim();
    if company.is_empty() {
        return Vec::new();
    }
    let limit = if limit == 0 { DEFAULT_LIMIT } else { limit }.min(MAX_LIMIT);
    let dir = hq_root
        .join("companies")
        .join(company)
        .join("sources")
        .join("meetings");
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };

    let mut candidates: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        if candidates.len() >= MAX_SCANNED {
            break;
        }
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        // `.raw.json` siblings are the word-level Recall payloads — huge, and
        // nothing here needs them.
        if is_skippable_entry_name(&name) || !name.ends_with(".md") {
            continue;
        }
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        candidates.push((modified_or_epoch(&path), path));
    }
    candidates.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    candidates.truncate(limit);

    candidates
        .into_iter()
        .filter_map(|(_, path)| read_meeting(&path))
        .collect()
}

fn read_meeting(path: &Path) -> Option<MeetingEntry> {
    let raw = read_head(path, MEETING_HEAD_BYTES)?;
    let (front_yaml, body) = split_frontmatter(&raw);
    let front = front_yaml
        .and_then(|yaml| serde_yaml::from_str::<MeetingFrontmatter>(yaml).ok())
        .unwrap_or_default();

    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_string();

    let mut participants: Vec<String> = front
        .participants
        .iter()
        .map(|p| clamp(p, 120))
        .filter(|p| !p.is_empty())
        .collect();
    if participants.is_empty() {
        participants = transcript_speakers(body);
    }
    participants.truncate(MAX_PARTICIPANTS);

    Some(MeetingEntry {
        id: front
            .source_id
            .or(front.id)
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map(|id| clamp(id, 200))
            .unwrap_or(stem.clone()),
        title: front
            .title
            .as_deref()
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .map(|t| clamp(t, 200))
            .unwrap_or(stem),
        date: front
            .scheduled_start_time
            .or(front.created_at)
            .or(front.ingested_at)
            .map(|d| clamp(&d, 64))
            .or_else(|| {
                std::fs::metadata(path)
                    .ok()
                    .and_then(|m| modified_rfc3339(&m))
            }),
        path: path.to_string_lossy().into_owned(),
        participants,
        summary: summarize(body),
    })
}

/// Distinct speaker names from `**Name** · \`[…]\`` transcript labels, in first-
/// appearance order.
fn transcript_speakers(body: &str) -> Vec<String> {
    let mut seen: Vec<String> = Vec::new();
    for line in body.lines() {
        if seen.len() >= MAX_PARTICIPANTS {
            break;
        }
        let Some(name) = speaker_label(line.trim()) else {
            continue;
        };
        if !seen.iter().any(|existing| existing == &name) {
            seen.push(name);
        }
    }
    seen
}

/// `**Stefan Johnson** · \`[00:02:34–00:02:34]\`` → `Stefan Johnson`.
fn speaker_label(line: &str) -> Option<String> {
    let rest = line.strip_prefix("**")?;
    let (name, tail) = rest.split_once("**")?;
    // A bold run only counts as a speaker label when it opens the line and is
    // followed by the timestamp separator — otherwise `**bold**` prose in a
    // hand-written note would masquerade as a participant.
    if !tail.trim_start().starts_with('·') {
        return None;
    }
    let name = clamp(name, 120);
    (!name.is_empty()).then_some(name)
}

/// First prose paragraph that is neither a heading nor a speaker label.
///
/// Bot transcripts have no summary section, so this lands on the opening
/// utterance; a hand-authored note with a `## Summary` section lands on its
/// prose. Either way it is a short, bounded preview.
fn summarize(body: &str) -> String {
    let mut collected = String::new();
    for line in body.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') || speaker_label(trimmed).is_some() {
            if collected.is_empty() {
                continue;
            }
            break;
        }
        if !collected.is_empty() {
            collected.push(' ');
        }
        collected.push_str(trimmed);
        if collected.chars().count() > 400 {
            break;
        }
    }
    clamp(&collected, 300)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn meetings_dir(root: &Path, company: &str) -> PathBuf {
        let dir = root
            .join("companies")
            .join(company)
            .join("sources")
            .join("meetings");
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Byte-for-byte modelled on a real bot-written transcript.
    const REAL_SHAPE: &str = r#"---
id: meeting:003963f4-41f1-4194-8c4f-26e2f1793840
channel: meeting
source_id: 003963f4-41f1-4194-8c4f-26e2f1793840
source_ref:
  channel: meeting
  source_id: 003963f4-41f1-4194-8c4f-26e2f1793840
  key: sources/meetings/003963f4-41f1-4194-8c4f-26e2f1793840.md
title: HQ Dev Standup
origin: recall.ai
meeting_platform: zoom
scheduled_start_time: 2026-08-05T08:30:00-07:00
created_at: 2026-07-07T21:36:00.406Z
ingested_at: 2026-08-05T15:55:52.004Z
bot_status: completed
---
## Transcript

**Stefan Johnson** · `[00:02:34–00:02:34]`

hey

**Yousuf Kalim** · `[00:02:34–00:02:43]`

son hey guys hey guys

**Stefan Johnson** · `[00:02:45–00:02:46]`

i'm on my phone so it's a little hard to see
"#;

    #[test]
    fn reads_the_real_bot_transcript_shape() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = meetings_dir(tmp.path(), "indigo");
        fs::write(
            dir.join("003963f4-41f1-4194-8c4f-26e2f1793840.md"),
            REAL_SHAPE,
        )
        .unwrap();
        // The word-level sibling must never be listed.
        fs::write(
            dir.join("003963f4-41f1-4194-8c4f-26e2f1793840.raw.json"),
            r#"[{"speaker":"Stefan Johnson","words":[]}]"#,
        )
        .unwrap();

        let meetings = recent_meetings(tmp.path(), "indigo", 20);
        assert_eq!(meetings.len(), 1, "raw.json sibling must not be listed");
        let meeting = &meetings[0];
        assert_eq!(meeting.id, "003963f4-41f1-4194-8c4f-26e2f1793840");
        assert_eq!(meeting.title, "HQ Dev Standup");
        // scheduled_start_time wins over created_at / ingested_at.
        assert_eq!(meeting.date.as_deref(), Some("2026-08-05T08:30:00-07:00"));
        // Participants are derived from speaker labels, de-duplicated, in
        // first-appearance order.
        assert_eq!(meeting.participants, vec!["Stefan Johnson", "Yousuf Kalim"]);
        assert_eq!(meeting.summary, "hey");
        assert!(meeting.path.ends_with(".md"));
    }

    #[test]
    fn hand_authored_note_layout_is_supported() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = meetings_dir(tmp.path(), "indigo");
        fs::write(
            dir.join("2026-08-01-kickoff.md"),
            "---\ntitle: Kickoff\ndate: 2026-08-01\nparticipants:\n  - Jacob Posel\n  - Corey\n---\n\n## Summary\n\nWe agreed to ship the composer first.\n",
        )
        .unwrap();
        let meetings = recent_meetings(tmp.path(), "indigo", 20);
        assert_eq!(meetings[0].participants, vec!["Jacob Posel", "Corey"]);
        assert_eq!(meetings[0].summary, "We agreed to ship the composer first.");
        // No id in frontmatter → file stem.
        assert_eq!(meetings[0].id, "2026-08-01-kickoff");
        // No recognised timestamp key → mtime fallback, never None.
        assert!(meetings[0].date.is_some());
    }

    #[test]
    fn file_without_frontmatter_still_lists() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = meetings_dir(tmp.path(), "indigo");
        fs::write(dir.join("orphan.md"), "just some notes\n").unwrap();
        let meetings = recent_meetings(tmp.path(), "indigo", 20);
        assert_eq!(meetings[0].id, "orphan");
        assert_eq!(meetings[0].title, "orphan");
        assert_eq!(meetings[0].summary, "just some notes");
        assert!(meetings[0].participants.is_empty());
    }

    #[test]
    fn listing_is_newest_first_and_respects_the_limit_and_cap() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = meetings_dir(tmp.path(), "indigo");
        for idx in 0..(MAX_LIMIT + 10) {
            let path = dir.join(format!("m{idx:03}.md"));
            fs::write(&path, format!("---\ntitle: meeting {idx}\n---\n\nbody\n")).unwrap();
            super::super::set_mtime(&path, 1_700_000_000 + idx as u64 * 60);
        }
        let capped = recent_meetings(tmp.path(), "indigo", 5);
        assert_eq!(capped.len(), 5);
        assert_eq!(capped[0].title, format!("meeting {}", MAX_LIMIT + 9));
        // A limit above the hard cap is clamped, not honoured.
        assert_eq!(
            recent_meetings(tmp.path(), "indigo", 10_000).len(),
            MAX_LIMIT
        );
        // limit 0 → the documented default.
        assert_eq!(
            recent_meetings(tmp.path(), "indigo", 0).len(),
            DEFAULT_LIMIT
        );
    }

    #[test]
    fn conflict_copies_and_missing_directories_are_handled() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = meetings_dir(tmp.path(), "indigo");
        fs::write(dir.join("real.md"), "---\ntitle: Real\n---\n\nbody\n").unwrap();
        fs::write(
            dir.join("real.conflict-2026-08-22T22-17-32Z-9aea6b.md"),
            "---\ntitle: Conflict\n---\n\nbody\n",
        )
        .unwrap();
        let titles: Vec<_> = recent_meetings(tmp.path(), "indigo", 20)
            .into_iter()
            .map(|m| m.title)
            .collect();
        assert_eq!(titles, vec!["Real"]);
        assert!(recent_meetings(tmp.path(), "no-such-company", 20).is_empty());
        assert!(recent_meetings(tmp.path(), "", 20).is_empty());
    }

    #[test]
    fn bold_prose_is_not_mistaken_for_a_speaker() {
        assert_eq!(
            speaker_label("**Stefan Johnson** · `[00:02:34–00:02:34]`").as_deref(),
            Some("Stefan Johnson")
        );
        assert_eq!(speaker_label("**important** note about the launch"), None);
        assert_eq!(speaker_label("plain line"), None);
    }
}
