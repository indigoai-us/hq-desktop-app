//! signals-local-meetings-v1 US-006 — immutable personal meeting observations.
//!
//! Everything lives under the member's personal vault, never the
//! cloud-authoritative `signals/**` tree:
//!
//! ```text
//! personal/signals/{companyUid}/meetings/_runs/{jobId}.json                     parsed result (written first)
//! personal/signals/{companyUid}/meetings/@{audienceKey}/{signalType}/{id}.md     one immutable observation
//! personal/signals/{companyUid}/receipts/meetings/{sourceId}/{digest}-{prompt}-{schema}.json
//! ```
//!
//! Commit order: run record, pending receipt, citation validation, observations,
//! supersede prior receipts, complete receipt. A citation failure keeps the run
//! record and leaves the receipt `pending` with the error, so `resume` can finish
//! the run from the stored parse without another model call.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    io::Write,
    path::{Path, PathBuf},
};

use super::receipt::{self, Receipt, ReceiptStatus, RECEIPT_SCHEMA};

pub const OBSERVATION_SCHEMA: &str = "hq-local-meeting-observation/v1";
pub const RUN_RECORD_SCHEMA: &str = "hq-local-meeting-run/v1";
const ID_DOMAIN: &str = "hq-local-meeting-observation-id/v1";

pub const MAX_CONTENT_CHARS: usize = 2000;
pub const MAX_CITATIONS: usize = 32;
pub const MAX_ENTITIES: usize = 32;
pub const MAX_OBSERVATIONS: usize = 256;
pub const MAX_FIELD_CHARS: usize = 256;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[serde(rename_all = "snake_case")]
pub enum SignalType {
    Summary,
    KeyPoint,
    Decision,
    ActionItem,
    ParticipantContribution,
    Risk,
    Commitment,
    Question,
}

impl SignalType {
    pub const ALL: [SignalType; 8] = [
        SignalType::Summary,
        SignalType::KeyPoint,
        SignalType::Decision,
        SignalType::ActionItem,
        SignalType::ParticipantContribution,
        SignalType::Risk,
        SignalType::Commitment,
        SignalType::Question,
    ];
    pub fn as_str(self) -> &'static str {
        match self {
            SignalType::Summary => "summary",
            SignalType::KeyPoint => "key_point",
            SignalType::Decision => "decision",
            SignalType::ActionItem => "action_item",
            SignalType::ParticipantContribution => "participant_contribution",
            SignalType::Risk => "risk",
            SignalType::Commitment => "commitment",
            SignalType::Question => "question",
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Citation {
    pub source_ref: String,
    pub start_ms: u64,
    pub end_ms: u64,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum EntityStatus {
    Resolved,
    Provisional,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EntityRef {
    #[serde(default)]
    pub entity_id: Option<String>,
    pub name: String,
    pub status: EntityStatus,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ParsedObservation {
    pub signal_type: SignalType,
    pub content: String,
    pub citations: Vec<Citation>,
    #[serde(default)]
    pub entities: Vec<EntityRef>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ParsedResult {
    pub observations: Vec<ParsedObservation>,
}

/// Run-level facts every observation carries.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunContext {
    pub job_id: String,
    pub company_uid: String,
    pub member_uid: String,
    pub device_id: String,
    pub source_id: String,
    pub source_ref: String,
    pub source_digest: String,
    pub audience_key: String,
    pub audience_version: u32,
    pub audience_receipt_ref: String,
    pub extractor_provider: String,
    pub extractor_model: String,
    pub prompt_version: String,
    pub schema_version: String,
    pub projection_watermark: String,
    pub projection_state: String,
    pub ontology_version: String,
    pub classification: String,
    pub extracted_at: String,
}

/// What the local transcript can resolve citations against.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalTranscript {
    pub source_ref: String,
    pub source_digest: String,
    pub duration_ms: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunRecord {
    pub schema: String,
    pub context: RunContext,
    pub parsed: ParsedResult,
}

/// v1 observation frontmatter. The markdown body repeats `content`.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ObservationFrontmatter {
    pub schema: String,
    pub observation_id: String,
    pub signal_type: SignalType,
    pub content: String,
    pub citations: Vec<Citation>,
    pub entities: Vec<EntityRef>,
    pub source_id: String,
    pub source_ref: String,
    pub source_digest: String,
    pub company_uid: String,
    pub member_uid: String,
    pub device_id: String,
    pub audience_key: String,
    pub audience_version: u32,
    pub audience_receipt_ref: String,
    pub extractor_provider: String,
    pub extractor_model: String,
    pub prompt_version: String,
    pub schema_version: String,
    pub projection_watermark: String,
    pub projection_state: String,
    pub ontology_version: String,
    pub classification: String,
    pub job_id: String,
    pub extracted_at: String,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", tag = "outcome")]
pub enum CommitOutcome {
    /// A complete receipt already exists for these versions; nothing written.
    Skipped {
        receipt_path: String,
        output_ids: Vec<String>,
    },
    Complete {
        receipt_path: String,
        output_ids: Vec<String>,
        superseded: Vec<String>,
    },
    /// Citation validation failed. The run record and pending receipt remain.
    Invalid {
        receipt_path: String,
        errors: Vec<String>,
    },
}

// ── paths ────────────────────────────────────────────────────────────────────

/// A single path segment: no separators, dots-only names, or control chars.
pub fn valid_segment(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= MAX_FIELD_CHARS
        && s != "."
        && s != ".."
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        && !s.starts_with('.')
}

/// Injective file-name encoding: keeps `[A-Za-z0-9.-]`, escapes the rest as `_XX`.
pub fn safe_segment(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b == b'-' || b == b'.' {
            out.push(b as char);
        } else {
            out.push_str(&format!("_{b:02x}"));
        }
    }
    out
}

/// `personal/signals/{companyUid}` below the HQ root.
pub fn company_root(hq_root: &Path, company_uid: &str) -> Result<PathBuf, String> {
    if !valid_segment(company_uid) {
        return Err("Invalid company".into());
    }
    Ok(hq_root.join("personal").join("signals").join(company_uid))
}

pub fn run_record_path(company_root: &Path, job_id: &str) -> Result<PathBuf, String> {
    if !valid_segment(job_id) {
        return Err("Invalid job id".into());
    }
    Ok(company_root
        .join("meetings")
        .join("_runs")
        .join(format!("{job_id}.json")))
}

pub fn observation_path(
    company_root: &Path,
    audience_key: &str,
    signal_type: SignalType,
    observation_id: &str,
) -> Result<PathBuf, String> {
    if !valid_segment(audience_key) || !valid_segment(observation_id) {
        return Err("Invalid observation path".into());
    }
    Ok(company_root
        .join("meetings")
        .join(format!("@{audience_key}"))
        .join(signal_type.as_str())
        .join(format!("{observation_id}.md")))
}

pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let dir = path.parent().ok_or("Invalid signal path")?;
    std::fs::create_dir_all(dir).map_err(|_| "Cannot create signal directory")?;
    let tmp = dir.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
    let written = (|| {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        std::fs::rename(&tmp, path)
    })();
    if written.is_err() {
        let _ = std::fs::remove_file(&tmp);
        return Err("Cannot write signal file".into());
    }
    Ok(())
}

/// Create-only write: never replaces an existing file.
fn write_new(path: &Path, bytes: &[u8]) -> Result<bool, String> {
    let dir = path.parent().ok_or("Invalid signal path")?;
    std::fs::create_dir_all(dir).map_err(|_| "Cannot create signal directory")?;
    let tmp = dir.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> std::io::Result<bool> {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        drop(f);
        // hard_link fails if the destination exists, so a prior file is never replaced.
        match std::fs::hard_link(&tmp, path) {
            Ok(()) => Ok(true),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
            Err(e) => Err(e),
        }
    })();
    let _ = std::fs::remove_file(&tmp);
    result.map_err(|_| "Cannot write observation".into())
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// ── identity ─────────────────────────────────────────────────────────────────

/// Trim, collapse whitespace, and lowercase.
pub fn normalize_content(s: &str) -> String {
    s.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// SHA-256 over member, source ref, source digest, signal type, audience key,
/// normalized content, prompt version, and schema version. Device ID and
/// extraction time are deliberately excluded.
#[allow(clippy::too_many_arguments)]
pub fn observation_id(
    member_uid: &str,
    source_ref: &str,
    source_digest: &str,
    signal_type: SignalType,
    audience_key: &str,
    content: &str,
    prompt_version: &str,
    schema_version: &str,
) -> String {
    let mut h = Sha256::new();
    let normalized = normalize_content(content);
    for part in [
        ID_DOMAIN,
        member_uid,
        source_ref,
        source_digest,
        signal_type.as_str(),
        audience_key,
        normalized.as_str(),
        prompt_version,
        schema_version,
    ] {
        h.update((part.len() as u64).to_be_bytes());
        h.update(part.as_bytes());
    }
    hex(&h.finalize())
}

fn id_for(ctx: &RunContext, o: &ParsedObservation) -> String {
    observation_id(
        &ctx.member_uid,
        &ctx.source_ref,
        &ctx.source_digest,
        o.signal_type,
        &ctx.audience_key,
        &o.content,
        &ctx.prompt_version,
        &ctx.schema_version,
    )
}

// ── validation ───────────────────────────────────────────────────────────────

fn bounded(s: &str) -> bool {
    !s.trim().is_empty()
        && s.chars().count() <= MAX_FIELD_CHARS
        && !s.chars().any(|c| c.is_control())
}

impl RunContext {
    pub fn validate(&self) -> Result<(), String> {
        for seg in [
            &self.job_id,
            &self.company_uid,
            &self.source_id,
            &self.audience_key,
        ] {
            if !valid_segment(seg) {
                return Err("Invalid run context".into());
            }
        }
        for v in [
            &self.member_uid,
            &self.device_id,
            &self.source_ref,
            &self.source_digest,
            &self.audience_receipt_ref,
            &self.extractor_provider,
            &self.extractor_model,
            &self.prompt_version,
            &self.schema_version,
            &self.projection_watermark,
            &self.projection_state,
            &self.ontology_version,
            &self.classification,
            &self.extracted_at,
        ] {
            if !bounded(v) {
                return Err("Invalid run context".into());
            }
        }
        if self.audience_version == 0 {
            return Err("Invalid run context".into());
        }
        Ok(())
    }
}

fn validate_shape(parsed: &ParsedResult) -> Result<(), String> {
    if parsed.observations.is_empty() || parsed.observations.len() > MAX_OBSERVATIONS {
        return Err("Parsed result has no observations or too many".into());
    }
    for o in &parsed.observations {
        let n = o.content.trim().chars().count();
        if n == 0 || n > MAX_CONTENT_CHARS {
            return Err("Observation content is empty or too long".into());
        }
        if o.citations.is_empty() || o.citations.len() > MAX_CITATIONS {
            return Err("Observation needs between 1 and 32 citations".into());
        }
        if o.entities.len() > MAX_ENTITIES {
            return Err("Observation has too many entities".into());
        }
        for e in &o.entities {
            if !bounded(&e.name) || e.entity_id.as_deref().is_some_and(|id| !bounded(id)) {
                return Err("Invalid entity reference".into());
            }
            if e.status == EntityStatus::Resolved && e.entity_id.is_none() {
                return Err("Resolved entity has no id".into());
            }
        }
    }
    Ok(())
}

/// Each citation must resolve against the local transcript: same source
/// reference and digest as the run, and a time range inside the transcript.
pub fn validate_citations(
    ctx: &RunContext,
    parsed: &ParsedResult,
    transcript: &LocalTranscript,
) -> Vec<String> {
    let mut errors = Vec::new();
    if transcript.source_ref != ctx.source_ref {
        errors.push("local transcript is for a different source".to_string());
    }
    if transcript.source_digest != ctx.source_digest {
        errors.push("local transcript digest does not match the run".to_string());
    }
    for (i, o) in parsed.observations.iter().enumerate() {
        for (j, c) in o.citations.iter().enumerate() {
            if c.source_ref != ctx.source_ref || c.source_ref != transcript.source_ref {
                errors.push(format!(
                    "observation {i} citation {j}: unknown source reference"
                ));
            }
            if c.start_ms > c.end_ms || c.end_ms > transcript.duration_ms {
                errors.push(format!(
                    "observation {i} citation {j}: timestamp outside the transcript"
                ));
            }
        }
    }
    errors
}

// ── commit ───────────────────────────────────────────────────────────────────

/// True when a complete receipt already covers these versions, so enqueue is a no-op.
pub fn is_complete(
    hq_root: &Path,
    company_uid: &str,
    source_id: &str,
    source_digest: &str,
    prompt_version: &str,
    schema_version: &str,
) -> Result<bool, String> {
    let root = company_root(hq_root, company_uid)?;
    let path = receipt::receipt_path(
        &root,
        source_id,
        source_digest,
        prompt_version,
        schema_version,
    )?;
    Ok(matches!(receipt::read(&path)?, Some(r) if r.status == ReceiptStatus::Complete))
}

pub fn read_run_record(
    hq_root: &Path,
    company_uid: &str,
    job_id: &str,
) -> Result<Option<RunRecord>, String> {
    let path = run_record_path(&company_root(hq_root, company_uid)?, job_id)?;
    match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|_| "Corrupt run record".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("Cannot read run record".into()),
    }
}

/// Persist the parsed result, then write observations and receipts.
pub fn commit(
    hq_root: &Path,
    ctx: RunContext,
    parsed: ParsedResult,
    transcript: &LocalTranscript,
) -> Result<CommitOutcome, String> {
    ctx.validate()?;
    validate_shape(&parsed)?;
    let root = company_root(hq_root, &ctx.company_uid)?;
    let receipt_path = receipt::receipt_path(
        &root,
        &ctx.source_id,
        &ctx.source_digest,
        &ctx.prompt_version,
        &ctx.schema_version,
    )?;
    if let Some(r) = receipt::read(&receipt_path)? {
        if r.status != ReceiptStatus::Pending {
            return Ok(CommitOutcome::Skipped {
                receipt_path: receipt_path.display().to_string(),
                output_ids: r.output_ids,
            });
        }
    }

    // 1. The parsed result is durable before any observation write.
    let run_path = run_record_path(&root, &ctx.job_id)?;
    let record = RunRecord {
        schema: RUN_RECORD_SCHEMA.into(),
        context: ctx,
        parsed,
    };
    match read_run_record(hq_root, &record.context.company_uid, &record.context.job_id)? {
        Some(existing) if existing.parsed != record.parsed => {
            return Err("A different parsed result is already stored for this job".into());
        }
        Some(_) => {}
        None => {
            let bytes =
                serde_json::to_vec_pretty(&record).map_err(|_| "Cannot encode run record")?;
            write_atomic(&run_path, &bytes)?;
        }
    }
    finish(&root, &receipt_path, &record, transcript)
}

/// Finish a stored run from its run record without calling the model again.
pub fn resume(
    hq_root: &Path,
    company_uid: &str,
    job_id: &str,
    transcript: &LocalTranscript,
) -> Result<CommitOutcome, String> {
    let record = read_run_record(hq_root, company_uid, job_id)?.ok_or("Unknown signal run")?;
    let ctx = &record.context;
    ctx.validate()?;
    let root = company_root(hq_root, company_uid)?;
    let receipt_path = receipt::receipt_path(
        &root,
        &ctx.source_id,
        &ctx.source_digest,
        &ctx.prompt_version,
        &ctx.schema_version,
    )?;
    if let Some(r) = receipt::read(&receipt_path)? {
        if r.status != ReceiptStatus::Pending {
            return Ok(CommitOutcome::Skipped {
                receipt_path: receipt_path.display().to_string(),
                output_ids: r.output_ids,
            });
        }
    }
    finish(&root, &receipt_path, &record, transcript)
}

fn finish(
    root: &Path,
    receipt_path: &Path,
    record: &RunRecord,
    transcript: &LocalTranscript,
) -> Result<CommitOutcome, String> {
    let ctx = &record.context;
    let ids: Vec<String> = record
        .parsed
        .observations
        .iter()
        .map(|o| id_for(ctx, o))
        .collect();
    let output_ids: Vec<String> = ids
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let mut rec = Receipt {
        schema: RECEIPT_SCHEMA.into(),
        status: ReceiptStatus::Pending,
        company_uid: ctx.company_uid.clone(),
        member_uid: ctx.member_uid.clone(),
        source_id: ctx.source_id.clone(),
        source_ref: ctx.source_ref.clone(),
        source_digest: ctx.source_digest.clone(),
        prompt_version: ctx.prompt_version.clone(),
        schema_version: ctx.schema_version.clone(),
        audience_key: ctx.audience_key.clone(),
        job_id: ctx.job_id.clone(),
        output_ids: output_ids.clone(),
        last_error: None,
        superseded_by: None,
        updated_at: now(),
    };

    // 2. Citations must resolve before any observation lands.
    let errors = validate_citations(ctx, &record.parsed, transcript);
    if !errors.is_empty() {
        rec.last_error = Some(errors.join("; ").chars().take(1000).collect());
        receipt::write(receipt_path, &rec)?;
        return Ok(CommitOutcome::Invalid {
            receipt_path: receipt_path.display().to_string(),
            errors,
        });
    }
    receipt::write(receipt_path, &rec)?;

    // 3. Immutable observations, create-only.
    for (o, id) in record.parsed.observations.iter().zip(&ids) {
        let path = observation_path(root, &ctx.audience_key, o.signal_type, id)?;
        let fm = ObservationFrontmatter {
            schema: OBSERVATION_SCHEMA.into(),
            observation_id: id.clone(),
            signal_type: o.signal_type,
            content: o.content.trim().to_string(),
            citations: o.citations.clone(),
            entities: o.entities.clone(),
            source_id: ctx.source_id.clone(),
            source_ref: ctx.source_ref.clone(),
            source_digest: ctx.source_digest.clone(),
            company_uid: ctx.company_uid.clone(),
            member_uid: ctx.member_uid.clone(),
            device_id: ctx.device_id.clone(),
            audience_key: ctx.audience_key.clone(),
            audience_version: ctx.audience_version,
            audience_receipt_ref: ctx.audience_receipt_ref.clone(),
            extractor_provider: ctx.extractor_provider.clone(),
            extractor_model: ctx.extractor_model.clone(),
            prompt_version: ctx.prompt_version.clone(),
            schema_version: ctx.schema_version.clone(),
            projection_watermark: ctx.projection_watermark.clone(),
            projection_state: ctx.projection_state.clone(),
            ontology_version: ctx.ontology_version.clone(),
            classification: ctx.classification.clone(),
            job_id: ctx.job_id.clone(),
            extracted_at: ctx.extracted_at.clone(),
        };
        let yaml = serde_yaml::to_string(&fm).map_err(|_| "Cannot encode observation")?;
        let doc = format!("---\n{yaml}---\n\n{}\n", fm.content);
        write_new(&path, doc.as_bytes())?;
    }

    // 4. Prior versions of this source are superseded; their files stay.
    let mut superseded = Vec::new();
    let receipt_name = receipt_path.file_name().map(|n| n.to_os_string());
    for (path, mut prior) in receipt::list_for_source(root, &ctx.source_id)? {
        if path.file_name().map(|n| n.to_os_string()) == receipt_name {
            continue;
        }
        if prior.status == ReceiptStatus::Superseded {
            continue;
        }
        prior.status = ReceiptStatus::Superseded;
        prior.superseded_by = receipt_name
            .as_ref()
            .map(|n| n.to_string_lossy().to_string());
        prior.updated_at = now();
        receipt::write(&path, &prior)?;
        superseded.push(path.display().to_string());
    }

    // 5. Complete.
    rec.status = ReceiptStatus::Complete;
    rec.updated_at = now();
    receipt::write(receipt_path, &rec)?;
    Ok(CommitOutcome::Complete {
        receipt_path: receipt_path.display().to_string(),
        output_ids,
        superseded,
    })
}

/// Parse an observation markdown file's frontmatter.
pub fn read_observation(path: &Path) -> Result<ObservationFrontmatter, String> {
    let text = std::fs::read_to_string(path).map_err(|_| "Cannot read observation")?;
    let rest = text
        .strip_prefix("---\n")
        .ok_or("Observation has no frontmatter")?;
    let end = rest
        .find("\n---\n")
        .ok_or("Observation has no frontmatter")?;
    serde_yaml::from_str(&rest[..end + 1]).map_err(|_| "Corrupt observation frontmatter".into())
}
