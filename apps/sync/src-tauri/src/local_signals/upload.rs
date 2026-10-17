//! signals-local-meetings-v1 US-009 (desktop half of US-008 AC5/AC6) —
//! upload sanitized contributions after a local run completes.
//!
//! Source of truth for what to upload is the COMPLETE local receipt (US-006)
//! and the observation files it lists; extraction never re-runs. Each
//! observation keeps its own upload record under
//! `personal/signals/{companyUid}/meetings/_uploads/{observationId}.json`, so a
//! retry only resends what is not settled. hq-pro answers a duplicate with
//! `unchanged`, a missing server receipt with `repaired`, and different bytes
//! with 409, which is surfaced and never retried.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::future::Future;
use std::path::{Path, PathBuf};

use super::receipt::{Receipt, ReceiptStatus};
use super::sanitize::{sanitize_up, LocalExtras, SanitizedContribution};
use super::store::{
    audience_segment, normalize_content, observation_path, read_observation, valid_segment,
    write_atomic,
};

pub const UPLOAD_RECORD_SCHEMA: &str = "hq-local-contribution-upload/v1";
pub const MAX_UPLOADS_PER_PASS: usize = 64;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum UploadStatus {
    Created,
    Unchanged,
    Repaired,
    /// Different bytes already exist at the key. Surfaced, never retried.
    Conflict,
    /// The server refused the source or contribution (422 with reasons).
    Ineligible,
    /// Not allowed for this member, or sanitizing changed the content.
    Blocked,
    /// The company kill switch is off. Retried when the member taps retry.
    Disabled,
    /// Network, auth, rate limit, or server error. Retried with backoff.
    Retryable,
}

impl UploadStatus {
    pub fn settled(self) -> bool {
        matches!(
            self,
            UploadStatus::Created
                | UploadStatus::Unchanged
                | UploadStatus::Repaired
                | UploadStatus::Conflict
                | UploadStatus::Ineligible
                | UploadStatus::Blocked
        )
    }
    pub fn uploaded(self) -> bool {
        matches!(
            self,
            UploadStatus::Created | UploadStatus::Unchanged | UploadStatus::Repaired
        )
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UploadRecord {
    pub schema: String,
    pub observation_id: String,
    pub status: UploadStatus,
    #[serde(default)]
    pub object_key: Option<String>,
    #[serde(default)]
    pub receipt_key: Option<String>,
    #[serde(default)]
    pub reasons: Vec<String>,
    pub attempts: u32,
    pub at: String,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UploadSummary {
    pub total: usize,
    pub uploaded: usize,
    pub created: usize,
    pub unchanged: usize,
    pub repaired: usize,
    pub conflict: usize,
    pub ineligible: usize,
    pub blocked: usize,
    pub disabled: usize,
    pub retryable: usize,
    /// Server reason codes (bounded, de-duplicated). Diagnostics only.
    pub reasons: Vec<String>,
    /// How many were sent to the server on this pass.
    pub sent: usize,
}

pub fn upload_record_path(company_root: &Path, observation_id: &str) -> Result<PathBuf, String> {
    if !valid_segment(observation_id) {
        return Err("Invalid observation id".into());
    }
    Ok(company_root
        .join("meetings")
        .join("_uploads")
        .join(format!("{observation_id}.json")))
}

pub fn read_record(
    company_root: &Path,
    observation_id: &str,
) -> Result<Option<UploadRecord>, String> {
    match std::fs::read(upload_record_path(company_root, observation_id)?) {
        Ok(b) => serde_json::from_slice(&b)
            .map(Some)
            .map_err(|_| "Corrupt upload record".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("Cannot read upload record".into()),
    }
}

/// Map an hq-pro response to an upload status. `status == 0` is a transport failure.
pub fn classify(status: u16, body: &Value) -> (UploadStatus, Vec<String>) {
    let code = body.get("code").and_then(Value::as_str).unwrap_or("");
    let reasons: Vec<String> = body
        .get("reasons")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|r| r.as_str().map(|s| s.chars().take(64).collect()))
                .take(16)
                .collect()
        })
        .unwrap_or_default();
    let st = match status {
        200 => match body.get("status").and_then(Value::as_str) {
            Some("created") => UploadStatus::Created,
            Some("unchanged") => UploadStatus::Unchanged,
            Some("repaired") => UploadStatus::Repaired,
            _ => UploadStatus::Retryable,
        },
        409 => UploadStatus::Conflict,
        422 => UploadStatus::Ineligible,
        403 if code == "CONTRIBUTION_DISABLED" => UploadStatus::Disabled,
        403 | 402 => UploadStatus::Blocked,
        400 => UploadStatus::Ineligible,
        _ => UploadStatus::Retryable,
    };
    let reasons = if reasons.is_empty() && !code.is_empty() {
        vec![code.chars().take(64).collect()]
    } else {
        reasons
    };
    (st, reasons)
}

/// One observation ready to send, or the reason it cannot be.
pub enum Candidate {
    Send {
        observation_id: String,
        destination: String,
        contribution: SanitizedContribution,
    },
    Blocked {
        observation_id: String,
        reason: &'static str,
    },
}

/// Build upload candidates from a COMPLETE local receipt. Never calls the model.
pub fn candidates(company_root: &Path, receipt: &Receipt) -> Result<Vec<Candidate>, String> {
    if receipt.status != ReceiptStatus::Complete {
        return Err("Local run is not complete".into());
    }
    let mut out = Vec::new();
    for id in &receipt.output_ids {
        let found = super::store::SignalType::ALL.iter().find_map(|t| {
            observation_path(company_root, &receipt.audience_key, *t, id)
                .ok()
                .filter(|p| p.is_file())
        });
        let Some(path) = found else {
            out.push(Candidate::Blocked {
                observation_id: id.clone(),
                reason: "local_observation_missing",
            });
            continue;
        };
        let fm = read_observation(&path)?;
        let sanitized = match sanitize_up(&fm, &LocalExtras::default()) {
            Ok(s) => s,
            Err(_) => {
                out.push(Candidate::Blocked {
                    observation_id: id.clone(),
                    reason: "not_company_eligible",
                });
                continue;
            }
        };
        // The server recomputes the id from the uploaded content. If sanitizing
        // changed the words, the id would not match: keep it local only.
        if normalize_content(&sanitized.content) != normalize_content(&fm.content) {
            out.push(Candidate::Blocked {
                observation_id: id.clone(),
                reason: "sanitized_content_changed",
            });
            continue;
        }
        let destination = format!(
            "member-signals/{}/observations/meetings/@{}/{}/{}.md",
            fm.member_uid,
            audience_segment(&fm.audience_key),
            fm.signal_type.as_str(),
            fm.observation_id
        );
        out.push(Candidate::Send {
            observation_id: id.clone(),
            destination,
            contribution: sanitized,
        });
    }
    Ok(out)
}

fn save(company_root: &Path, rec: &UploadRecord) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(rec).map_err(|_| "Cannot encode upload record")?;
    write_atomic(
        &upload_record_path(company_root, &rec.observation_id)?,
        &bytes,
    )
}

fn record(
    company_root: &Path,
    observation_id: &str,
    status: UploadStatus,
    reasons: Vec<String>,
    body: &Value,
    prior_attempts: u32,
) -> Result<UploadRecord, String> {
    let rec = UploadRecord {
        schema: UPLOAD_RECORD_SCHEMA.into(),
        observation_id: observation_id.into(),
        status,
        object_key: body
            .get("objectKey")
            .and_then(Value::as_str)
            .map(String::from),
        receipt_key: body
            .get("receiptKey")
            .and_then(Value::as_str)
            .map(String::from),
        reasons,
        attempts: prior_attempts.saturating_add(1),
        at: chrono::Utc::now().to_rfc3339(),
    };
    save(company_root, &rec)?;
    Ok(rec)
}

/// Settled state of every observation in a receipt, without sending anything.
pub fn summarize(company_root: &Path, receipt: &Receipt) -> Result<UploadSummary, String> {
    let mut s = UploadSummary {
        total: receipt.output_ids.len(),
        ..Default::default()
    };
    for id in &receipt.output_ids {
        if let Some(r) = read_record(company_root, id)? {
            tally(&mut s, &r);
        }
    }
    Ok(s)
}

fn tally(s: &mut UploadSummary, r: &UploadRecord) {
    match r.status {
        UploadStatus::Created => s.created += 1,
        UploadStatus::Unchanged => s.unchanged += 1,
        UploadStatus::Repaired => s.repaired += 1,
        UploadStatus::Conflict => s.conflict += 1,
        UploadStatus::Ineligible => s.ineligible += 1,
        UploadStatus::Blocked => s.blocked += 1,
        UploadStatus::Disabled => s.disabled += 1,
        UploadStatus::Retryable => s.retryable += 1,
    }
    if r.status.uploaded() {
        s.uploaded += 1;
    }
    for reason in &r.reasons {
        if s.reasons.len() < 16 && !s.reasons.contains(reason) {
            s.reasons.push(reason.clone());
        }
    }
}

/// Send every unsettled observation once. `send` posts `{destination,
/// contribution}` and returns `(httpStatus, body)`; `Err` is a transport
/// failure. Raw transport text is only logged by the caller.
pub async fn upload_pending<F, Fut>(
    company_root: &Path,
    receipt: &Receipt,
    send: F,
) -> Result<UploadSummary, String>
where
    F: Fn(Value) -> Fut,
    Fut: Future<Output = Result<(u16, Value), String>>,
{
    let mut summary = UploadSummary {
        total: receipt.output_ids.len(),
        ..Default::default()
    };
    for c in candidates(company_root, receipt)?
        .into_iter()
        .take(MAX_UPLOADS_PER_PASS)
    {
        let id = match &c {
            Candidate::Send { observation_id, .. } | Candidate::Blocked { observation_id, .. } => {
                observation_id.clone()
            }
        };
        let prior = read_record(company_root, &id)?;
        if let Some(p) = prior.as_ref().filter(|p| p.status.settled()) {
            tally(&mut summary, p); // already settled locally: nothing to send
            continue;
        }
        let attempts = prior.map(|p| p.attempts).unwrap_or(0);
        let rec = match c {
            Candidate::Blocked { reason, .. } => record(
                company_root,
                &id,
                UploadStatus::Blocked,
                vec![reason.into()],
                &Value::Null,
                attempts,
            )?,
            Candidate::Send {
                destination,
                contribution,
                ..
            } => {
                summary.sent += 1;
                let body =
                    serde_json::json!({ "destination": destination, "contribution": contribution });
                match send(body).await {
                    Ok((status, resp)) => {
                        let (st, reasons) = classify(status, &resp);
                        record(company_root, &id, st, reasons, &resp, attempts)?
                    }
                    Err(_) => record(
                        company_root,
                        &id,
                        UploadStatus::Retryable,
                        vec!["transport".into()],
                        &Value::Null,
                        attempts,
                    )?,
                }
            }
        };
        tally(&mut summary, &rec);
    }
    Ok(summary)
}
