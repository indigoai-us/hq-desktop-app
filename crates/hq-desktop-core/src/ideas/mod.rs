//! Idea Board capture records (US-002), OCR stage (US-006), and local
//! extraction (US-007).
//!
//! A capture is a single screenshot-derived record living in the active
//! company's vault:
//!
//! ```text
//! {hq_root}/companies/{company_slug}/ideas/{id}/record.json
//! {hq_root}/companies/{company_slug}/ideas/{id}/image.png
//! ```
//!
//! Both files sit inside the existing vault sync scope (`companies/…`), so a
//! capture syncs with the rest of the company without extra plumbing.
//!
//! Design deltas honored here (see `companies/indigo/projects/hq-idea-board/
//! design/design.md`): confidence + status are first-class fields; company
//! attribution is a stored slug with an explicit [`storage::move_record`]
//! operation; retention is downsample-on-write and never auto-delete.

pub mod extract;
pub mod pipeline;
pub mod record;
pub mod storage;

pub use extract::{
    local::classify,
    model::{
        merge_verdict, model_extract_url, parse_mode, ExtractionMode, HttpModelExtractor,
        ModelError, ModelExtraction, ModelExtractor, ModelRequest, TokenProvider,
        DEFAULT_MODEL_TIMEOUT, EXTRACTION_MODE_SETTING, MODEL_DISCLOSURE, MODEL_EXTRACT_PATH,
        SCHEMA_HINT,
    },
    sample_palette, status_for, ColorSample, ExtractLine, Extraction, ExtractionInput, LineBox,
    EXTRACTED_THRESHOLD, LOW_CONFIDENCE_THRESHOLD, MAX_PALETTE, MAX_TAGS,
};
pub use pipeline::{
    apply_extraction, apply_extraction_with_source, apply_ocr_outcome, run_extraction_stage,
    run_model_stage, run_ocr_stage, OcrOutcome,
};
pub use record::{
    CaptureKind, CaptureRecord, CaptureStatus, ExtractionSource, IdeasError, Provenance,
    MAX_IMAGE_EDGE,
};
pub use storage::{
    create_record, downsample, ideas_dir, load_record, move_record, record_dir, save_record,
    CaptureImage, NewCapture,
};
