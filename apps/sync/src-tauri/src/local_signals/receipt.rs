//! signals-local-meetings-v1 US-006 — local meeting run receipts.
//!
//! One receipt per (source, source digest, prompt version, schema version) at
//! `personal/signals/{companyUid}/receipts/meetings/{sourceId}/{sourceDigest}-{promptVersion}-{schemaVersion}.json`.
//! A receipt records `pending`, `complete`, or `superseded` plus the exact set
//! of observation IDs the run produces. Receipts are rewritten only to move
//! state forward; observations they list are never deleted.
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use super::store::{safe_segment, valid_segment, write_atomic};

pub const RECEIPT_SCHEMA: &str = "hq-local-meeting-receipt/v1";

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ReceiptStatus {
    Pending,
    Complete,
    Superseded,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Receipt {
    pub schema: String,
    pub status: ReceiptStatus,
    pub company_uid: String,
    pub member_uid: String,
    pub source_id: String,
    pub source_ref: String,
    pub source_digest: String,
    pub prompt_version: String,
    pub schema_version: String,
    pub audience_key: String,
    pub job_id: String,
    /// Sorted, de-duplicated observation IDs this run produces.
    pub output_ids: Vec<String>,
    /// Last citation-validation failure, if the run is pending and recoverable.
    #[serde(default)]
    pub last_error: Option<String>,
    #[serde(default)]
    pub superseded_by: Option<String>,
    pub updated_at: String,
}

/// `receipts/meetings/{sourceId}` under the company's personal signal root.
pub fn receipts_dir(company_root: &Path, source_id: &str) -> Result<PathBuf, String> {
    if !valid_segment(source_id) {
        return Err("Invalid source id".into());
    }
    Ok(company_root
        .join("receipts")
        .join("meetings")
        .join(source_id))
}

pub fn receipt_file_name(
    source_digest: &str,
    prompt_version: &str,
    schema_version: &str,
) -> String {
    format!(
        "{}-{}-{}.json",
        safe_segment(source_digest),
        safe_segment(prompt_version),
        safe_segment(schema_version)
    )
}

pub fn receipt_path(
    company_root: &Path,
    source_id: &str,
    source_digest: &str,
    prompt_version: &str,
    schema_version: &str,
) -> Result<PathBuf, String> {
    Ok(
        receipts_dir(company_root, source_id)?.join(receipt_file_name(
            source_digest,
            prompt_version,
            schema_version,
        )),
    )
}

pub fn read(path: &Path) -> Result<Option<Receipt>, String> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|_| "Corrupt meeting receipt".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("Cannot read meeting receipt".into()),
    }
}

pub fn write(path: &Path, receipt: &Receipt) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(receipt).map_err(|_| "Cannot encode receipt")?;
    write_atomic(path, &bytes)
}

/// Every receipt for one source, with its path.
pub fn list_for_source(
    company_root: &Path,
    source_id: &str,
) -> Result<Vec<(PathBuf, Receipt)>, String> {
    let dir = receipts_dir(company_root, source_id)?;
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(_) => return Err("Cannot read meeting receipts".into()),
    };
    let mut out = Vec::new();
    for entry in entries.flatten().take(4096) {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        if let Some(r) = read(&path)? {
            out.push((path, r));
        }
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(out)
}
