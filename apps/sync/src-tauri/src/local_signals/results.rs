//! signals-local-meetings-v1 US-010 — read cited local results for one
//! Meetings row from the personal observation store.
//!
//! The current version is the COMPLETE receipt for the meeting's present
//! source digest and the shipped prompt and schema versions. Every other
//! receipt for the source (superseded, or for an older transcript) is history
//! and never mixed into the current groups. Citations are checked against the
//! local transcript; an invalid one is shown but cannot be opened. Opening a
//! citation never takes a path from the UI: the command looks the citation up
//! by observation id and index and reads the transcript the eligibility gate
//! resolved from the bot id.
use serde::Serialize;

use super::eligibility::MeetingEligibility;
use super::receipt::{self, Receipt, ReceiptStatus};
use super::store::{
    company_root, observation_path, read_observation, EntityStatus, ObservationFrontmatter,
    SignalType,
};
use super::upload::{read_record, UploadStatus};
use crate::local_signals::extractor::{PROMPT_VERSION, SCHEMA_VERSION};
use std::path::Path;

pub const MAX_RESULT_CONTENT_CHARS: usize = 600;
pub const MAX_EXCERPT_LINES: usize = 6;
pub const MAX_EXCERPT_LINE_CHARS: usize = 300;

/// Upload state of one observation, as Meetings names it. Never carries the
/// server's raw reasons or what the sanitizer removed.
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum UploadBadge {
    Pending,
    Uploaded,
    Private,
    Ineligible,
    Retry,
    Off,
    Conflict,
}

impl From<Option<UploadStatus>> for UploadBadge {
    fn from(s: Option<UploadStatus>) -> Self {
        match s {
            None => UploadBadge::Pending,
            Some(UploadStatus::Created | UploadStatus::Unchanged | UploadStatus::Repaired) => {
                UploadBadge::Uploaded
            }
            Some(UploadStatus::Blocked) => UploadBadge::Private,
            Some(UploadStatus::Ineligible) => UploadBadge::Ineligible,
            Some(UploadStatus::Retryable) => UploadBadge::Retry,
            Some(UploadStatus::Disabled) => UploadBadge::Off,
            Some(UploadStatus::Conflict) => UploadBadge::Conflict,
        }
    }
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResultCitation {
    pub start_ms: u64,
    pub end_ms: u64,
    /// `m:ss` or `h:mm:ss` of the start.
    pub label: String,
    /// Resolves against the current local transcript.
    pub valid: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResultEntity {
    pub name: String,
    pub entity_id: Option<String>,
    pub provisional: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResultItem {
    pub observation_id: String,
    pub signal_type: SignalType,
    pub content: String,
    pub citations: Vec<ResultCitation>,
    pub entities: Vec<ResultEntity>,
    pub owner: Option<String>,
    pub reasoning: Option<String>,
    pub speaker: Option<String>,
    pub provider: String,
    pub model: String,
    pub projection_state: String,
    pub upload: UploadBadge,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResultGroup {
    pub signal_type: SignalType,
    pub items: Vec<ResultItem>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResultVersion {
    pub status: ReceiptStatus,
    pub prompt_version: String,
    pub schema_version: String,
    pub current_transcript: bool,
    /// All eight types, in canonical order, including empty ones.
    pub groups: Vec<ResultGroup>,
    pub missing: usize,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MeetingResults {
    pub current: Option<ResultVersion>,
    pub history: Vec<ResultVersion>,
}

pub fn time_label(ms: u64) -> String {
    let s = ms / 1000;
    let (h, m, sec) = (s / 3600, (s % 3600) / 60, s % 60);
    if h > 0 {
        format!("{h}:{m:02}:{sec:02}")
    } else {
        format!("{m}:{sec:02}")
    }
}

fn bounded(s: &str, max: usize) -> String {
    let t: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if t.chars().count() <= max {
        t
    } else {
        let mut o: String = t.chars().take(max - 1).collect();
        o.push('…');
        o
    }
}

fn citation_valid(
    fm_source_ref: &str,
    start: u64,
    end: u64,
    e: &MeetingEligibility,
    same_transcript: bool,
) -> bool {
    same_transcript && fm_source_ref == e.source_ref && start <= end && end <= e.duration_ms
}

fn item(
    company: &Path,
    fm: ObservationFrontmatter,
    e: &MeetingEligibility,
    same_transcript: bool,
) -> ResultItem {
    let upload = read_record(company, &fm.observation_id)
        .ok()
        .flatten()
        .map(|r| r.status);
    ResultItem {
        citations: fm
            .citations
            .iter()
            .map(|c| ResultCitation {
                start_ms: c.start_ms,
                end_ms: c.end_ms,
                label: time_label(c.start_ms),
                valid: citation_valid(&c.source_ref, c.start_ms, c.end_ms, e, same_transcript)
                    && fm.source_ref == e.source_ref,
            })
            .collect(),
        entities: fm
            .entities
            .iter()
            .map(|x| ResultEntity {
                name: bounded(&x.name, 120),
                entity_id: x.entity_id.clone(),
                provisional: x.status == EntityStatus::Provisional,
            })
            .collect(),
        content: bounded(&fm.content, MAX_RESULT_CONTENT_CHARS),
        owner: fm.owner.as_deref().map(|s| bounded(s, 120)),
        reasoning: fm.reasoning.as_deref().map(|s| bounded(s, 200)),
        speaker: fm.speaker.as_deref().map(|s| bounded(s, 120)),
        provider: fm.extractor_provider,
        model: fm.extractor_model,
        projection_state: fm.projection_state,
        upload: upload.into(),
        signal_type: fm.signal_type,
        observation_id: fm.observation_id,
    }
}

fn version(company: &Path, r: &Receipt, e: &MeetingEligibility) -> ResultVersion {
    let same_transcript = e.source_digest.as_deref() == Some(r.source_digest.as_str());
    let mut groups: Vec<ResultGroup> = SignalType::ALL
        .iter()
        .map(|t| ResultGroup {
            signal_type: *t,
            items: vec![],
        })
        .collect();
    let mut missing = 0;
    for id in &r.output_ids {
        let found = SignalType::ALL.iter().find_map(|t| {
            observation_path(company, &r.audience_key, *t, id)
                .ok()
                .filter(|p| p.is_file())
        });
        match found.and_then(|p| read_observation(&p).ok()) {
            Some(fm) if fm.observation_id == *id && fm.member_uid == r.member_uid => {
                let g = groups
                    .iter_mut()
                    .find(|g| g.signal_type == fm.signal_type)
                    .unwrap();
                g.items.push(item(company, fm, e, same_transcript));
            }
            _ => missing += 1,
        }
    }
    ResultVersion {
        status: r.status,
        prompt_version: r.prompt_version.clone(),
        schema_version: r.schema_version.clone(),
        current_transcript: same_transcript,
        groups,
        missing,
    }
}

/// Read the personal store for one eligible meeting.
pub fn results_for(
    hq: &Path,
    company_uid: &str,
    bot_id: &str,
    e: &MeetingEligibility,
) -> Result<MeetingResults, String> {
    let company = company_root(hq, company_uid)?;
    let mut current = None;
    let mut history = Vec::new();
    for (_, r) in receipt::list_for_source(&company, bot_id)? {
        if r.member_uid.is_empty() || r.company_uid != company_uid {
            continue;
        }
        let is_current = r.status == ReceiptStatus::Complete
            && e.source_digest.as_deref() == Some(r.source_digest.as_str())
            && r.prompt_version == PROMPT_VERSION
            && r.schema_version == SCHEMA_VERSION;
        if is_current {
            current = Some(version(&company, &r, e));
        } else if r.status != ReceiptStatus::Pending {
            history.push(version(&company, &r, e));
        }
    }
    Ok(MeetingResults { current, history })
}

/// Transcript timestamp at the start of a line (`[h:mm:ss]` or `[mm:ss]`), in ms.
fn line_ms(line: &str) -> Option<u64> {
    let open = line.find('[')?;
    let close = line[open..].find(']')? + open;
    let parts: Vec<&str> = line[open + 1..close].split(':').collect();
    if !(2..=3).contains(&parts.len())
        || parts
            .iter()
            .any(|p| p.is_empty() || p.len() > 2 || !p.bytes().all(|b| b.is_ascii_digit()))
    {
        return None;
    }
    Some(
        parts
            .iter()
            .fold(0u64, |a, p| a * 60 + p.parse::<u64>().unwrap_or(0))
            * 1000,
    )
}

/// Lines of the local transcript covering `[start, end]`: the last line that
/// starts at or before `start`, then every line up to `end`. Bounded.
pub fn citation_excerpt(body: &str, start_ms: u64, end_ms: u64) -> Vec<String> {
    let lines: Vec<(u64, &str)> = body
        .lines()
        .filter_map(|l| line_ms(l).map(|t| (t, l)))
        .collect();
    let first = lines.iter().rposition(|(t, _)| *t <= start_ms).unwrap_or(0);
    lines[first..]
        .iter()
        .take_while(|(t, _)| *t <= end_ms.max(start_ms) || *t <= lines[first].0)
        .take(MAX_EXCERPT_LINES)
        .map(|(_, l)| bounded(l, MAX_EXCERPT_LINE_CHARS))
        .collect()
}

/// Resolve citation `index` of `observation_id` in the CURRENT version only.
pub fn open_citation(
    hq: &Path,
    company_uid: &str,
    bot_id: &str,
    e: &MeetingEligibility,
    observation_id: &str,
    index: usize,
) -> Result<Vec<String>, String> {
    let results = results_for(hq, company_uid, bot_id, e)?;
    let current = results.current.ok_or("citation_invalid")?;
    let item = current
        .groups
        .iter()
        .flat_map(|g| g.items.iter())
        .find(|i| i.observation_id == observation_id)
        .ok_or("citation_invalid")?;
    let c = item.citations.get(index).ok_or("citation_invalid")?;
    if !c.valid {
        return Err("citation_invalid".into());
    }
    let lines = citation_excerpt(&e.transcript_body, c.start_ms, c.end_ms);
    if lines.is_empty() {
        return Err("citation_invalid".into());
    }
    Ok(lines)
}
