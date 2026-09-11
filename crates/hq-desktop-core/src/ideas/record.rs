//! The `CaptureRecord` schema — the one well-defined record every later Idea
//! Board stage (toast, extraction, board, indexing) reads and revises.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// Longest-edge bound applied to every stored capture image, in pixels.
/// Images larger than this are downsampled on write; smaller images are never
/// upscaled. The pre-downsample bytes are never persisted.
pub const MAX_IMAGE_EDGE: u32 = 2000;

/// Errors raised while building, validating, storing, or moving a record.
#[derive(Debug, thiserror::Error)]
pub enum IdeasError {
    #[error("io error at {path}: {source}")]
    Io {
        path: String,
        #[source]
        source: std::io::Error,
    },
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    /// Frontmatter (de)serialization for the `capture.md` sidecar.
    #[error("yaml error: {0}")]
    Yaml(#[from] serde_yaml::Error),
    /// The search index could not be refreshed. Always best-effort at the
    /// call site — a capture is never lost because indexing failed.
    #[error("index error: {0}")]
    Index(String),
    #[error("image error: {0}")]
    Image(String),
    #[error("invalid record: {0}")]
    Invalid(String),
    #[error("record {id} not found for company {company_slug}")]
    NotFound { id: String, company_slug: String },
    #[error("destination already exists: {0}")]
    DestinationExists(String),
}

impl IdeasError {
    pub(crate) fn io(path: impl AsRef<std::path::Path>, source: std::io::Error) -> Self {
        IdeasError::Io {
            path: path.as_ref().display().to_string(),
            source,
        }
    }
}

/// Reject any string that must not be able to escape, redirect, or truncate a
/// vault path when joined into one.
///
/// Company slugs and record ids are attacker-influenceable in principle (an id
/// can arrive from a synced record, a slug from user input), and
/// `Path::join` happily accepts `..` or an absolute path — the latter
/// *replaces* the whole path built so far. Everything that becomes a path
/// component is screened here before any filesystem call.
pub(crate) fn validate_path_component(label: &str, value: &str) -> Result<(), IdeasError> {
    if value.is_empty() {
        return Err(IdeasError::Invalid(format!("{label} must not be empty")));
    }
    if value == "." || value == ".." {
        return Err(IdeasError::Invalid(format!(
            "{label} must not be a relative path segment, got {value:?}"
        )));
    }
    if value.contains('/')
        || value.contains('\\')
        || value.contains(std::path::MAIN_SEPARATOR)
        || value.contains('\0')
    {
        return Err(IdeasError::Invalid(format!(
            "{label} must be a single path component without separators, got {value:?}"
        )));
    }
    Ok(())
}

/// What the capture appears to be. `Unknown` is the pre-extraction default.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CaptureKind {
    #[default]
    Unknown,
    XPost,
    Article,
    Image,
    Quote,
    Product,
    Color,
}

/// Where the record sits in the extraction lifecycle.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CaptureStatus {
    /// Written, extraction not yet run.
    #[default]
    Pending,
    /// Extraction succeeded with usable confidence.
    Extracted,
    /// Extraction ran but the result is below the trust bar.
    LowConfidence,
    /// Deliberately kept as a plain image — no extraction wanted.
    Plain,
}

/// Which extractor produced the record's current `extracted` fields.
///
/// Absent until an extraction has run. `Model` is only ever written when the
/// user opted into `ideas.extraction_mode = model` AND the model was strictly
/// more confident than the local classifier.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExtractionSource {
    Local,
    Model,
}

/// Where the capture came from on screen.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Provenance {
    /// Frontmost application name at capture time.
    pub app: String,
    /// Title of the captured window.
    pub window_title: String,
    /// Source URL when the app exposed one (browsers).
    #[serde(default)]
    pub url: Option<String>,
    pub captured_at: DateTime<Utc>,
    /// Display the capture came from.
    pub display_id: u32,
}

/// One captured idea.
///
/// JSON keys are snake_case and enum spellings are snake_case (`x_post`,
/// `low_confidence`, …). Timestamps serialize as RFC 3339.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CaptureRecord {
    /// ULID — lexicographically sortable by creation time.
    pub id: String,
    pub company_slug: String,
    pub kind: CaptureKind,
    pub status: CaptureStatus,
    /// Extraction confidence in `0.0..=1.0`; `None` before extraction runs.
    #[serde(default)]
    pub confidence: Option<f32>,
    /// Path to the stored PNG, relative to the HQ root:
    /// `companies/{slug}/ideas/{id}/image.png`. Stored relative so a record
    /// stays valid across machines with different HQ roots.
    pub image_path: String,
    #[serde(default)]
    pub ocr_text: Option<String>,
    /// Structured extraction output. Must be a JSON object when present.
    #[serde(default)]
    pub extracted: Option<serde_json::Value>,
    #[serde(default)]
    pub tags: Vec<String>,
    /// Which extractor produced `extracted`; `None` before extraction runs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extraction_source: Option<ExtractionSource>,
    pub provenance: Provenance,
    #[serde(default)]
    pub note: Option<String>,
    /// How many times this capture has been cited downstream.
    #[serde(default)]
    pub cited_count: u32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl CaptureRecord {
    /// The HQ-root-relative path of this record's image.
    pub fn relative_image_path(company_slug: &str, id: &str) -> String {
        format!("companies/{company_slug}/ideas/{id}/image.png")
    }

    /// Validate the invariants that are not encoded in the type system.
    pub fn validate(&self) -> Result<(), IdeasError> {
        // id and company_slug are joined into vault paths; screen them here so
        // an invalid record can never be persisted, wherever it came from.
        validate_path_component("id", &self.id)?;
        validate_path_component("company_slug", &self.company_slug)?;
        if let Some(c) = self.confidence {
            // `RangeInclusive::contains` uses PartialOrd, so NaN already fails
            // every comparison and is rejected here — no separate is_nan check.
            if !(0.0..=1.0).contains(&c) {
                return Err(IdeasError::Invalid(format!(
                    "confidence must be within 0.0..=1.0, got {c}"
                )));
            }
        }
        if let Some(extracted) = &self.extracted {
            if !extracted.is_object() {
                return Err(IdeasError::Invalid(
                    "extracted must be a JSON object when present".into(),
                ));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn sample() -> CaptureRecord {
        let ts = Utc.with_ymd_and_hms(2026, 9, 10, 12, 0, 0).unwrap();
        CaptureRecord {
            id: "01J000000000000000000000AA".to_string(),
            company_slug: "indigo".to_string(),
            kind: CaptureKind::XPost,
            status: CaptureStatus::LowConfidence,
            confidence: Some(0.42),
            image_path: CaptureRecord::relative_image_path("indigo", "01J000000000000000000000AA"),
            ocr_text: Some("hello world".to_string()),
            extracted: Some(serde_json::json!({ "author": "@someone" })),
            tags: vec!["design".to_string(), "ai".to_string()],
            extraction_source: Some(ExtractionSource::Model),
            provenance: Provenance {
                app: "Safari".to_string(),
                window_title: "X".to_string(),
                url: Some("https://x.com/someone/status/1".to_string()),
                captured_at: ts,
                display_id: 1,
            },
            note: Some("worth revisiting".to_string()),
            cited_count: 3,
            created_at: ts,
            updated_at: ts,
        }
    }

    #[test]
    fn serde_round_trip_preserves_every_field_and_enum_spelling() {
        let record = sample();
        let json = serde_json::to_string_pretty(&record).unwrap();

        // Enum spellings and key casing are part of the on-disk contract.
        assert!(json.contains("\"kind\": \"x_post\""), "{json}");
        assert!(json.contains("\"status\": \"low_confidence\""), "{json}");
        assert!(json.contains("\"company_slug\""), "{json}");
        assert!(json.contains("\"cited_count\": 3"), "{json}");
        assert!(json.contains("\"window_title\""), "{json}");
        assert!(json.contains("\"extraction_source\": \"model\""), "{json}");
        assert!(json.contains("2026-09-10T12:00:00Z"), "{json}");

        let back: CaptureRecord = serde_json::from_str(&json).unwrap();
        assert_eq!(back, record);
    }

    #[test]
    fn optional_fields_default_when_absent() {
        let json = serde_json::json!({
            "id": "01J000000000000000000000AA",
            "company_slug": "indigo",
            "kind": "unknown",
            "status": "pending",
            "image_path": "companies/indigo/ideas/01J000000000000000000000AA/image.png",
            "provenance": {
                "app": "Safari",
                "window_title": "X",
                "captured_at": "2026-09-10T12:00:00Z",
                "display_id": 1
            },
            "created_at": "2026-09-10T12:00:00Z",
            "updated_at": "2026-09-10T12:00:00Z"
        });
        let record: CaptureRecord = serde_json::from_value(json).unwrap();
        assert_eq!(record.confidence, None);
        assert_eq!(record.ocr_text, None);
        assert_eq!(record.extracted, None);
        assert!(record.tags.is_empty());
        assert_eq!(record.cited_count, 0);
        assert_eq!(record.extraction_source, None);
        assert_eq!(record.provenance.url, None);
        record.validate().unwrap();
    }

    #[test]
    fn confidence_above_one_is_rejected() {
        let mut record = sample();
        record.confidence = Some(1.2);
        let err = record.validate().unwrap_err();
        assert!(
            matches!(err, IdeasError::Invalid(ref m) if m.contains("confidence")),
            "unexpected error: {err}"
        );

        record.confidence = Some(-0.1);
        assert!(matches!(record.validate(), Err(IdeasError::Invalid(_))));

        record.confidence = Some(1.0);
        record.validate().unwrap();
    }

    #[test]
    fn extracted_must_be_an_object() {
        let mut record = sample();
        record.extracted = Some(serde_json::json!(["not", "an", "object"]));
        assert!(matches!(record.validate(), Err(IdeasError::Invalid(_))));
    }
}
