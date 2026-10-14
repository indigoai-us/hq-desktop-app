//! signals-local-meetings-v1 US-007 — deterministic sanitize-up.
//!
//! Builds a `sanitized-contribution.v1` candidate from a local observation.
//! The candidate is an allow-list: only bounded evidence fields are copied.
//! Transcript excerpts, raw source bodies, personal notes, local ranking,
//! local dismissals, device paths and IDs, and unrelated context never appear.
use serde::{Deserialize, Serialize};

use super::store::{EntityStatus, ObservationFrontmatter, SignalType};

pub const SANITIZED_SCHEMA: &str = "sanitized-contribution.v1";
pub const SANITIZER_VERSION: &str = "local-sanitizer/v1";
pub const MAX_SANITIZED_CONTENT_CHARS: usize = 600;
pub const MAX_SANITIZED_CITATIONS: usize = 8;
pub const MAX_SANITIZED_ENTITIES: usize = 16;

/// Local-only state that sits beside an observation on this device.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LocalExtras {
    pub transcript_excerpt: Option<String>,
    pub source_body: Option<String>,
    pub personal_note: Option<String>,
    pub local_rank: Option<i64>,
    pub dismissed: bool,
    pub device_path: Option<String>,
    pub related_context: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SanitizedCitation {
    pub start_ms: u64,
    pub end_ms: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SanitizedContribution {
    pub schema: String,
    pub sanitizer_version: String,
    pub observation_id: String,
    pub signal_type: SignalType,
    pub content: String,
    pub citations: Vec<SanitizedCitation>,
    pub source_ref: String,
    pub source_digest: String,
    pub entity_refs: Vec<String>,
    pub provisional_entities: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speaker: Option<String>,
    pub company_uid: String,
    pub member_uid: String,
    pub audience_key: String,
    pub audience_version: u32,
    pub audience_receipt_ref: String,
    pub prompt_version: String,
    pub schema_version: String,
    pub classification: String,
    pub projection_state: String,
    pub projection_watermark: String,
}

fn bounded(s: &str, max: usize) -> String {
    let t: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if t.chars().count() <= max {
        return t;
    }
    let mut out: String = t.chars().take(max - 1).collect();
    out.push('…');
    out
}

/// Remove every occurrence of `needle` (whitespace-insensitive) from `text`.
fn strip(text: &str, needle: Option<&str>) -> String {
    let Some(n) = needle.map(|n| n.split_whitespace().collect::<Vec<_>>().join(" ")) else {
        return text.to_string();
    };
    if n.chars().count() < 8 {
        return text.to_string();
    }
    let t = text.split_whitespace().collect::<Vec<_>>().join(" ");
    t.replace(&n, " ")
}

/// Drop tokens that look like device file paths.
fn strip_paths(text: &str) -> String {
    text.split_whitespace()
        .filter(|w| {
            let w = w.trim_matches(|c: char| matches!(c, '(' | ')' | '"' | '\'' | ',' | '.' | ';'));
            !(w.starts_with('/') && w[1..].contains('/')
                || w.starts_with("~/")
                || w.contains(":\\")
                || w.starts_with("file:")
                || w.contains("/Users/")
                || w.contains("/home/"))
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Deterministic: the same observation and extras always give the same candidate.
pub fn sanitize_up(
    fm: &ObservationFrontmatter,
    extras: &LocalExtras,
) -> Result<SanitizedContribution, String> {
    if fm.classification != "company-eligible" {
        return Err("Observation is not eligible for company contribution".into());
    }
    let mut content = fm.content.clone();
    for n in [
        extras.transcript_excerpt.as_deref(),
        extras.source_body.as_deref(),
        extras.personal_note.as_deref(),
        extras.related_context.as_deref(),
        extras.device_path.as_deref(),
    ] {
        content = strip(&content, n);
    }
    let content = bounded(&strip_paths(&content), MAX_SANITIZED_CONTENT_CHARS);
    if content.is_empty() {
        return Err("Nothing left to contribute after sanitizing".into());
    }
    let clean = |v: &Option<String>| {
        v.as_deref()
            .map(|s| bounded(&strip_paths(s), 200))
            .filter(|s| !s.is_empty())
    };
    Ok(SanitizedContribution {
        schema: SANITIZED_SCHEMA.into(),
        sanitizer_version: SANITIZER_VERSION.into(),
        observation_id: fm.observation_id.clone(),
        signal_type: fm.signal_type,
        content,
        citations: fm
            .citations
            .iter()
            .take(MAX_SANITIZED_CITATIONS)
            .map(|c| SanitizedCitation {
                start_ms: c.start_ms,
                end_ms: c.end_ms,
            })
            .collect(),
        source_ref: fm.source_ref.clone(),
        source_digest: fm.source_digest.clone(),
        entity_refs: fm
            .entities
            .iter()
            .filter(|e| e.status == EntityStatus::Resolved)
            .filter_map(|e| e.entity_id.clone())
            .take(MAX_SANITIZED_ENTITIES)
            .collect(),
        provisional_entities: fm
            .entities
            .iter()
            .filter(|e| e.status == EntityStatus::Provisional)
            .map(|e| bounded(&e.name, 120))
            .take(MAX_SANITIZED_ENTITIES)
            .collect(),
        owner: clean(&fm.owner),
        reasoning: clean(&fm.reasoning),
        speaker: clean(&fm.speaker),
        company_uid: fm.company_uid.clone(),
        member_uid: fm.member_uid.clone(),
        audience_key: fm.audience_key.clone(),
        audience_version: fm.audience_version,
        audience_receipt_ref: fm.audience_receipt_ref.clone(),
        prompt_version: fm.prompt_version.clone(),
        schema_version: fm.schema_version.clone(),
        classification: fm.classification.clone(),
        projection_state: fm.projection_state.clone(),
        projection_watermark: fm.projection_watermark.clone(),
    })
}
