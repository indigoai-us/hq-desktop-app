//! Async extraction pipeline stages that revise a stored [`CaptureRecord`]
//! in place (US-006: the OCR stage).
//!
//! This module is deliberately **platform-neutral**: `hq-platform` depends on
//! `hq-desktop-core`, never the reverse, so the OCR backend is injected as a
//! closure rather than imported. `hq-platform::ocr` supplies the real Vision /
//! `Windows.Media.Ocr` recognizer; tests supply a stub.
//!
//! Failure policy (PRD): OCR is best-effort enrichment. A failed, empty, or
//! panicking recognizer degrades the record to `status = plain` with
//! `ocr_text = None`. A capture is **never** deleted and never gets a failure
//! status — the image is the artifact, the text is a bonus.
//!
//! Security: recognized text is never logged, at any level. Only the error
//! string and the record id reach the logfile.

use std::path::Path;

use crate::logfile;

use super::record::{CaptureRecord, CaptureStatus, IdeasError};
use super::storage::{load_record, save_record};

const LOG_TAG: &str = "ideas-ocr";

/// What a recognizer produced: the recognized text, or a human-readable
/// failure reason. `Ok("")` (nothing legible) is treated exactly like a
/// failure for the purposes of `ocr_text`, minus the error log.
pub type OcrOutcome = Result<String, String>;

/// Apply an OCR outcome to a stored record.
///
/// - success with non-blank text → `ocr_text = Some(text)`
/// - success with blank text, or any failure → `ocr_text = None`
/// - `status` moves `pending` → `plain`; any later status is left alone so a
///   slow OCR completion can never clobber a finished extraction.
pub fn apply_ocr_outcome(
    hq_root: &Path,
    company_slug: &str,
    id: &str,
    outcome: OcrOutcome,
) -> Result<CaptureRecord, IdeasError> {
    let mut record = load_record(hq_root, company_slug, id)?;

    match outcome {
        Ok(text) if !text.trim().is_empty() => {
            record.ocr_text = Some(text);
        }
        Ok(_) => {
            record.ocr_text = None;
            logfile::log(LOG_TAG, &format!("ocr found no text for record {id}"));
        }
        Err(err) => {
            record.ocr_text = None;
            logfile::log(LOG_TAG, &format!("ocr failed for record {id}: {err}"));
        }
    }

    if record.status == CaptureStatus::Pending {
        record.status = CaptureStatus::Plain;
    }

    save_record(hq_root, &mut record)?;
    Ok(record)
}

/// Run `recognize` off the calling thread and apply the result.
///
/// The recognizer is blocking native work (Vision / WinRT), so it runs on
/// `tokio`'s blocking pool — the capture thread only has to
/// `tokio::spawn(run_ocr_stage(..))` and walk away. A panic inside the
/// recognizer is caught by the join handle and degraded like any other
/// failure.
pub async fn run_ocr_stage<F>(
    hq_root: &Path,
    company_slug: &str,
    id: &str,
    recognize: F,
) -> Result<CaptureRecord, IdeasError>
where
    F: FnOnce(&Path) -> Result<String, String> + Send + 'static,
{
    // Load first so the recognizer gets the record's own image path rather
    // than a caller-guessed one (and so a missing record fails fast).
    let record = load_record(hq_root, company_slug, id)?;
    let image_path = hq_root.join(&record.image_path);

    let outcome = match tokio::task::spawn_blocking(move || recognize(&image_path)).await {
        Ok(outcome) => outcome,
        Err(join_err) if join_err.is_panic() => Err("ocr recognizer panicked".to_string()),
        Err(_) => Err("ocr recognizer was cancelled".to_string()),
    };

    apply_ocr_outcome(hq_root, company_slug, id, outcome)
}
