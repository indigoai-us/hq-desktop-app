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

// ----------------------------------------------------------------------------
// US-007: local extraction stage
// ----------------------------------------------------------------------------

use super::extract::{
    local::classify, sample_palette, status_for, ExtractLine, Extraction, ExtractionInput,
};
use super::record::{CaptureKind, ExtractionSource};

const EXTRACT_LOG_TAG: &str = "ideas-extract";

/// Apply a classifier verdict to a stored record.
///
/// `status` follows [`status_for`]; below the plain bar the kind is forced to
/// `Unknown` and `extracted` is cleared so a rejected guess never lingers in
/// the record. Tags are kept in every case (host / app tags are still true).
pub fn apply_extraction(
    hq_root: &Path,
    company_slug: &str,
    id: &str,
    extraction: Extraction,
) -> Result<CaptureRecord, IdeasError> {
    apply_extraction_with_source(
        hq_root,
        company_slug,
        id,
        extraction,
        ExtractionSource::Local,
    )
}

/// [`apply_extraction`], recording which extractor produced the verdict.
pub fn apply_extraction_with_source(
    hq_root: &Path,
    company_slug: &str,
    id: &str,
    extraction: Extraction,
    source: ExtractionSource,
) -> Result<CaptureRecord, IdeasError> {
    let mut record = load_record(hq_root, company_slug, id)?;
    let confidence = if extraction.confidence.is_nan() {
        0.0
    } else {
        extraction.confidence.clamp(0.0, 1.0)
    };
    let status = status_for(confidence);
    record.confidence = Some(confidence);
    record.tags = extraction.tags;
    match status {
        CaptureStatus::Plain => {
            record.kind = CaptureKind::Unknown;
            record.extracted = None;
        }
        _ => {
            record.kind = extraction.kind;
            record.extracted = Some(if extraction.extracted.is_object() {
                extraction.extracted
            } else {
                serde_json::json!({})
            });
        }
    }
    record.status = status;
    record.extraction_source = Some(source);
    save_record(hq_root, &mut record)?;
    Ok(record)
}

/// Run local extraction for a stored record and revise it in place.
///
/// `lines` are the OCR lines with geometry; when empty the record's own
/// `ocr_text` is split into synthetic lines. The capture image is decoded
/// (best-effort) for colour cues, and the classifier runs on the blocking
/// pool. Any failure or panic leaves the record exactly as it was — except a
/// still-`pending` record, which settles at `plain` so it never hangs. The
/// capture is never deleted. OCR text is never logged.
pub async fn run_extraction_stage(
    hq_root: &Path,
    company_slug: &str,
    id: &str,
    lines: Vec<ExtractLine>,
) -> Result<CaptureRecord, IdeasError> {
    let record = load_record(hq_root, company_slug, id)?;
    let input = if lines.is_empty() {
        ExtractionInput::from_text(record.ocr_text.as_deref().unwrap_or(""), &record.provenance)
    } else {
        ExtractionInput::from_lines(lines, &record.provenance)
    };
    let image_path = hq_root.join(&record.image_path);

    let verdict = tokio::task::spawn_blocking(move || {
        let palette = image::open(&image_path)
            .map(|img| sample_palette(&img))
            .unwrap_or_default();
        classify(&input.with_palette(palette))
    })
    .await;

    match verdict {
        Ok(extraction) => apply_extraction(hq_root, company_slug, id, extraction),
        Err(join_err) => {
            let why = if join_err.is_panic() {
                "classifier panicked"
            } else {
                "classifier was cancelled"
            };
            logfile::log(
                EXTRACT_LOG_TAG,
                &format!("extraction failed for record {id}: {why}"),
            );
            let mut record = load_record(hq_root, company_slug, id)?;
            if record.status == CaptureStatus::Pending {
                record.status = CaptureStatus::Plain;
                save_record(hq_root, &mut record)?;
            }
            Ok(record)
        }
    }
}

// ----------------------------------------------------------------------------
// US-008: opt-in model extraction stage
// ----------------------------------------------------------------------------

use super::extract::model::{
    merge_verdict, ExtractionMode, ModelExtractor, ModelRequest, SCHEMA_HINT,
};

const MODEL_LOG_TAG: &str = "ideas-model";

/// Opt-in model refinement of the local extraction result.
///
/// `mode == Local` (the default) returns the stored record untouched and
/// **never calls the extractor** — no image leaves the device.
///
/// `mode == Model` sends the stored (already downsampled) PNG plus the OCR
/// text and the local verdict to `extractor`. The result replaces the local
/// one only when it is strictly more confident ([`merge_verdict`]); otherwise,
/// and on every failure or timeout, the local result stays exactly as it was.
/// This is background enrichment, so a failure is `Ok(record)` with a log
/// line — never an error the user has to see.
///
/// Neither the image, the OCR text, nor extracted content is ever logged.
pub async fn run_model_stage(
    hq_root: &Path,
    company_slug: &str,
    id: &str,
    mode: ExtractionMode,
    extractor: &dyn ModelExtractor,
) -> Result<CaptureRecord, IdeasError> {
    let record = load_record(hq_root, company_slug, id)?;
    if mode == ExtractionMode::Local {
        return Ok(record);
    }

    let image_path = hq_root.join(&record.image_path);
    let bytes = match std::fs::read(&image_path) {
        Ok(b) => b,
        Err(e) => {
            logfile::log(
                MODEL_LOG_TAG,
                &format!("model extraction skipped for record {id}: image unreadable: {e}"),
            );
            return Ok(record);
        }
    };
    let (width, height) = image::load_from_memory(&bytes)
        .map(|img| {
            use image::GenericImageView;
            img.dimensions()
        })
        .unwrap_or((0, 0));

    let request = ModelRequest {
        image_png_base64: {
            use base64::Engine;
            base64::engine::general_purpose::STANDARD.encode(&bytes)
        },
        image_width: width,
        image_height: height,
        ocr_text: record.ocr_text.clone(),
        app: record.provenance.app.clone(),
        window_title: record.provenance.window_title.clone(),
        url: record.provenance.url.clone(),
        local_kind: record.kind,
        local_confidence: record.confidence.unwrap_or(0.0),
        schema_hint: SCHEMA_HINT.to_string(),
    };

    let model = match extractor.extract(&request).await {
        Ok(m) => m,
        Err(e) => {
            logfile::log(
                MODEL_LOG_TAG,
                &format!("model extraction failed for record {id}: {e}"),
            );
            return Ok(record);
        }
    };

    let extraction: Extraction = model.into();
    if !merge_verdict(record.confidence, &extraction) {
        logfile::log(
            MODEL_LOG_TAG,
            &format!("model result below local confidence for record {id}"),
        );
        return Ok(record);
    }
    apply_extraction_with_source(
        hq_root,
        company_slug,
        id,
        extraction,
        ExtractionSource::Model,
    )
}

#[cfg(test)]
mod hq_idea_board_model_stage_tests {
    use super::*;
    use crate::ideas::extract::model::{ModelError, ModelExtraction};
    use crate::ideas::record::{ExtractionSource, Provenance};
    use crate::ideas::storage::{create_record, CaptureImage, NewCapture};
    use futures_util::future::BoxFuture;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct Stub {
        result: std::sync::Mutex<Option<Result<ModelExtraction, ModelError>>>,
        calls: AtomicUsize,
    }

    impl Stub {
        fn ok(confidence: f32) -> Self {
            Stub {
                result: std::sync::Mutex::new(Some(Ok(ModelExtraction {
                    kind: CaptureKind::Article,
                    confidence,
                    extracted: serde_json::json!({ "title": "Deep Work" }),
                    tags: vec!["reading".into()],
                    input_tokens: None,
                    output_tokens: None,
                    cost_usd: None,
                }))),
                calls: AtomicUsize::new(0),
            }
        }

        fn failing() -> Self {
            Stub {
                result: std::sync::Mutex::new(Some(Err(ModelError::Timeout))),
                calls: AtomicUsize::new(0),
            }
        }
    }

    impl ModelExtractor for Stub {
        fn extract<'a>(
            &'a self,
            _req: &'a ModelRequest,
        ) -> BoxFuture<'a, Result<ModelExtraction, ModelError>> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let taken = self.result.lock().unwrap().take();
            Box::pin(async move { taken.unwrap_or(Err(ModelError::Malformed("reused".into()))) })
        }
    }

    fn seeded(root: &Path) -> CaptureRecord {
        std::fs::create_dir_all(root.join("companies/indigo/ideas")).unwrap();
        let img = image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
            8,
            6,
            image::Rgba([12, 34, 56, 255]),
        ));
        let mut record = create_record(
            root,
            NewCapture::pending(
                "indigo".to_string(),
                CaptureImage::Decoded(img),
                Provenance {
                    app: "Safari".into(),
                    window_title: "Reader".into(),
                    url: None,
                    captured_at: chrono::Utc::now(),
                    display_id: 1,
                },
            ),
        )
        .unwrap();
        record.confidence = Some(0.5);
        record.kind = CaptureKind::Quote;
        record.status = CaptureStatus::LowConfidence;
        record.extracted = Some(serde_json::json!({ "text": "local" }));
        record.extraction_source = Some(ExtractionSource::Local);
        save_record(root, &mut record).unwrap();
        record
    }

    #[tokio::test]
    async fn hq_idea_board_model_stage_never_calls_extractor_in_local_mode() {
        let tmp = tempfile::tempdir().unwrap();
        let record = seeded(tmp.path());
        let stub = Stub::ok(0.99);
        let out = run_model_stage(
            tmp.path(),
            "indigo",
            &record.id,
            ExtractionMode::Local,
            &stub,
        )
        .await
        .unwrap();
        assert_eq!(stub.calls.load(Ordering::SeqCst), 0);
        assert_eq!(out, record);
    }

    #[tokio::test]
    async fn hq_idea_board_model_stage_replaces_when_more_confident() {
        let tmp = tempfile::tempdir().unwrap();
        let record = seeded(tmp.path());
        let stub = Stub::ok(0.9);
        let out = run_model_stage(
            tmp.path(),
            "indigo",
            &record.id,
            ExtractionMode::Model,
            &stub,
        )
        .await
        .unwrap();
        assert_eq!(stub.calls.load(Ordering::SeqCst), 1);
        assert_eq!(out.kind, CaptureKind::Article);
        assert_eq!(out.confidence, Some(0.9));
        assert_eq!(out.status, CaptureStatus::Extracted);
        assert_eq!(out.extraction_source, Some(ExtractionSource::Model));
        assert_eq!(
            out.extracted,
            Some(serde_json::json!({ "title": "Deep Work" }))
        );

        let reloaded = load_record(tmp.path(), "indigo", &record.id).unwrap();
        assert_eq!(reloaded.extraction_source, Some(ExtractionSource::Model));
    }

    #[tokio::test]
    async fn hq_idea_board_model_stage_keeps_local_when_not_more_confident() {
        let tmp = tempfile::tempdir().unwrap();
        let record = seeded(tmp.path());
        // Exactly equal: strictly-greater means local wins.
        let stub = Stub::ok(0.5);
        let out = run_model_stage(
            tmp.path(),
            "indigo",
            &record.id,
            ExtractionMode::Model,
            &stub,
        )
        .await
        .unwrap();
        assert_eq!(out, record);
        assert_eq!(
            load_record(tmp.path(), "indigo", &record.id).unwrap(),
            record
        );
    }

    #[tokio::test]
    async fn hq_idea_board_model_stage_failure_leaves_record_intact() {
        let tmp = tempfile::tempdir().unwrap();
        let record = seeded(tmp.path());
        let stub = Stub::failing();
        let out = run_model_stage(
            tmp.path(),
            "indigo",
            &record.id,
            ExtractionMode::Model,
            &stub,
        )
        .await
        .expect("a background enrichment failure is never an error");
        assert_eq!(out, record);
        assert_eq!(
            load_record(tmp.path(), "indigo", &record.id).unwrap(),
            record
        );
    }
}
