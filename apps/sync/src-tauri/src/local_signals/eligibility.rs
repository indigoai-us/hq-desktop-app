//! signals-local-meetings-v1 US-009 — is this completed meeting eligible for
//! local signal generation?
//!
//! Reads the synced company copy of the meeting source
//! (`companies/{slug}/sources/meetings/{botId}.md`) and its frozen audience
//! receipt, and mirrors the hq-pro US-005 gate (`evaluateCompanyUploadEligibility`)
//! closely enough to decide whether to show Generate signals. hq-pro re-checks
//! everything on upload; this check only decides what the Meetings row offers.
//! Every unreadable or mismatched input is ineligible.
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

use super::store::valid_segment;

/// Why the row does not offer Generate signals. Never shown raw to the member.
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum IneligibleReason {
    MissingSource,
    PrivateSource,
    MissingReceipt,
    WrongCompany,
    NotBotCapture,
    AudienceMismatch,
    DigestMismatch,
    NotOnRoster,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MeetingEligibility {
    pub eligible: bool,
    pub reason: Option<IneligibleReason>,
    pub company_slug: Option<String>,
    pub source_ref: String,
    pub source_digest: Option<String>,
    pub audience_receipt_ref: Option<String>,
    pub audience_key: Option<String>,
    pub audience_version: Option<u32>,
    /// Last transcript timestamp plus one minute, for citation bounds.
    pub duration_ms: u64,
    #[serde(skip)]
    pub transcript_body: String,
}

impl MeetingEligibility {
    fn no(source_ref: String, reason: IneligibleReason) -> Self {
        MeetingEligibility {
            eligible: false,
            reason: Some(reason),
            company_slug: None,
            source_ref,
            source_digest: None,
            audience_receipt_ref: None,
            audience_key: None,
            audience_version: None,
            duration_ms: 0,
            transcript_body: String::new(),
        }
    }
}

/// Same split as hq-pro `sources/markdown.ts`: frontmatter, then the body.
pub fn split_frontmatter(text: &str) -> Option<(&str, &str)> {
    let rest = text
        .strip_prefix("---\n")
        .or_else(|| text.strip_prefix("---\r\n"))?;
    let mut search = 0;
    while let Some(i) = rest[search..].find("\n---") {
        let at = search + i;
        let yaml_end = if rest[..at].ends_with('\r') {
            at - 1
        } else {
            at
        };
        let after = &rest[at + 4..];
        if after.is_empty() || after.starts_with('\n') || after.starts_with("\r\n") {
            let body = after
                .strip_prefix("\r\n")
                .or_else(|| after.strip_prefix('\n'))
                .unwrap_or(after);
            return Some((&rest[..yaml_end], body));
        }
        search = at + 4;
    }
    None
}

/// `sha256:<hex>` of the transcript body, as hq-pro `sha256Digest`.
pub fn sha256_digest(text: &str) -> String {
    let h = Sha256::digest(text.as_bytes());
    format!(
        "sha256:{}",
        h.iter().map(|b| format!("{b:02x}")).collect::<String>()
    )
}

/// Largest `[HH:MM:SS]` / `[MM:SS]` timestamp in the transcript plus one minute.
pub fn transcript_duration_ms(body: &str) -> u64 {
    let mut max = 0u64;
    let bytes = body.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'[' {
            if let Some(end) = body[i + 1..].find(']') {
                let inner = &body[i + 1..i + 1 + end];
                let parts: Vec<&str> = inner.split(':').collect();
                if (2..=3).contains(&parts.len())
                    && parts.iter().all(|p| {
                        !p.is_empty() && p.len() <= 2 && p.bytes().all(|b| b.is_ascii_digit())
                    })
                {
                    let nums: Vec<u64> = parts.iter().map(|p| p.parse().unwrap_or(0)).collect();
                    let secs = nums.iter().fold(0, |acc, n| acc * 60 + n);
                    max = max.max(secs * 1000);
                }
            }
        }
        i += 1;
    }
    max + 60_000
}

/// The synced company folder holding `sources/meetings/{botId}.md`.
pub fn find_meeting_source(hq_root: &Path, bot_id: &str) -> Option<(String, PathBuf)> {
    if !valid_segment(bot_id) {
        return None;
    }
    let companies = hq_root.join("companies");
    let mut dirs: Vec<_> = std::fs::read_dir(&companies).ok()?.flatten().collect();
    dirs.sort_by_key(|e| e.file_name());
    for entry in dirs.into_iter().take(512) {
        let slug = entry.file_name().to_string_lossy().to_string();
        if !valid_segment(&slug) {
            continue;
        }
        let path = entry
            .path()
            .join("sources/meetings")
            .join(format!("{bot_id}.md"));
        if path.is_file() {
            return Some((slug, path));
        }
    }
    None
}

fn s<'a>(v: &'a serde_yaml::Value, k: &str) -> Option<&'a str> {
    v.get(k).and_then(|x| x.as_str())
}

pub fn evaluate(
    hq_root: &Path,
    company_uid: &str,
    member_uid: &str,
    bot_id: &str,
) -> MeetingEligibility {
    let source_ref = format!("sources/meetings/{bot_id}.md");
    let Some((slug, path)) = find_meeting_source(hq_root, bot_id) else {
        return MeetingEligibility::no(source_ref, IneligibleReason::MissingSource);
    };
    let Ok(text) = std::fs::read_to_string(&path) else {
        return MeetingEligibility::no(source_ref, IneligibleReason::MissingSource);
    };
    let Some((yaml, body)) = split_frontmatter(&text) else {
        return MeetingEligibility::no(source_ref, IneligibleReason::MissingSource);
    };
    let Ok(fm) = serde_yaml::from_str::<serde_yaml::Value>(yaml) else {
        return MeetingEligibility::no(source_ref, IneligibleReason::MissingSource);
    };
    let private = matches!(s(&fm, "visibility"), Some("private"))
        || matches!(s(&fm, "classification"), Some("private"));
    if private {
        return MeetingEligibility::no(source_ref, IneligibleReason::PrivateSource);
    }
    if s(&fm, "company_id") != Some(company_uid) {
        return MeetingEligibility::no(source_ref, IneligibleReason::WrongCompany);
    }
    let sdk = s(&fm, "capture_source").is_some() || fm.get("recall_recording_id").is_some();
    if sdk || s(&fm, "origin") != Some("recall.ai") || s(&fm, "recall_bot_id") != Some(bot_id) {
        return MeetingEligibility::no(source_ref, IneligibleReason::NotBotCapture);
    }
    let Some(receipt_ref) = s(&fm, "audience_receipt_ref").map(String::from) else {
        return MeetingEligibility::no(source_ref, IneligibleReason::MissingReceipt);
    };
    let ref_ok = receipt_ref.starts_with(&format!("sources/meetings/{bot_id}.audience"))
        && receipt_ref.ends_with(".json")
        && !receipt_ref.contains("..");
    let receipt: Option<serde_json::Value> = ref_ok
        .then(|| {
            std::fs::read_to_string(hq_root.join("companies").join(&slug).join(&receipt_ref)).ok()
        })
        .flatten()
        .and_then(|t| serde_json::from_str(&t).ok());
    let Some(r) = receipt.filter(|r| r["schema"] == "meeting-audience.v1") else {
        return MeetingEligibility::no(source_ref, IneligibleReason::MissingReceipt);
    };
    if r["companyUid"].as_str() != Some(company_uid) {
        return MeetingEligibility::no(source_ref, IneligibleReason::WrongCompany);
    }
    if r["botCaptureId"].as_str() != Some(bot_id) {
        return MeetingEligibility::no(source_ref, IneligibleReason::NotBotCapture);
    }
    let audience_key = r["audienceKey"].as_str().map(String::from);
    let audience_version = r["audienceVersion"].as_u64().map(|v| v as u32);
    let fm_version = fm
        .get("audience_version")
        .and_then(|v| v.as_u64())
        .map(|v| v as u32);
    if audience_key.is_none()
        || s(&fm, "audience_key") != audience_key.as_deref()
        || fm_version != audience_version
    {
        return MeetingEligibility::no(source_ref, IneligibleReason::AudienceMismatch);
    }
    let digest = sha256_digest(body);
    if r["sourceDigest"].as_str() != Some(digest.as_str()) {
        return MeetingEligibility::no(source_ref, IneligibleReason::DigestMismatch);
    }
    let on_roster = r["invitedMemberUids"]
        .as_array()
        .is_some_and(|a| a.iter().any(|m| m.as_str() == Some(member_uid)));
    if !on_roster {
        return MeetingEligibility::no(source_ref, IneligibleReason::NotOnRoster);
    }
    MeetingEligibility {
        eligible: true,
        reason: None,
        company_slug: Some(slug),
        source_ref,
        source_digest: Some(digest),
        audience_receipt_ref: Some(receipt_ref),
        audience_key,
        audience_version,
        duration_ms: transcript_duration_ms(body),
        transcript_body: body.to_string(),
    }
}
