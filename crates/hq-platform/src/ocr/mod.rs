//! On-device text recognition behind one interface (US-006).
//!
//! macOS uses Apple Vision (`VNRecognizeTextRequest`, accurate level), Windows
//! uses `Windows.Media.Ocr`, and every other platform returns a typed
//! [`OcrError::Unsupported`]. Both real backends are fully on-device: no
//! network call, no per-capture cost.
//!
//! ## Bounding-box contract
//!
//! [`BBox`] is **normalized to `0.0..=1.0`** of the image's width/height with
//! the origin at the **top-left** and y growing downward — the convention the
//! UI layer draws in. Vision reports bottom-left-origin normalized rects, so
//! the macOS backend flips y; `Windows.Media.Ocr` reports top-left-origin
//! pixel rects, so the Windows backend divides by the bitmap dimensions.
//! Neither backend passes its native convention through.

use std::path::Path;
use std::sync::{Arc, Mutex};

use hq_desktop_core::ideas::pipeline::{run_extraction_stage, run_ocr_stage};
use hq_desktop_core::ideas::{CaptureRecord, ExtractLine, IdeasError, LineBox};

#[cfg(target_os = "macos")]
pub mod macos;
#[cfg(target_os = "windows")]
pub mod windows;

/// Everything that can go wrong recognizing text in an image.
#[derive(Debug, thiserror::Error)]
pub enum OcrError {
    /// No on-device OCR engine exists for this platform.
    #[error("ocr is not supported on {platform}")]
    Unsupported { platform: &'static str },
    #[error("io error at {path}: {source}")]
    Io {
        path: String,
        #[source]
        source: std::io::Error,
    },
    /// The platform engine refused the image or failed internally.
    #[error("ocr backend error: {0}")]
    Backend(String),
}

impl OcrError {
    pub(crate) fn io(path: impl AsRef<Path>, source: std::io::Error) -> Self {
        OcrError::Io {
            path: path.as_ref().display().to_string(),
            source,
        }
    }
}

/// A normalized rectangle in `0.0..=1.0` image space, origin top-left.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct BBox {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

/// One recognized line of text.
#[derive(Debug, Clone, PartialEq)]
pub struct OcrLine {
    pub text: String,
    pub bbox: BBox,
    /// Engine confidence in `0.0..=1.0`.
    pub confidence: f32,
}

/// The result of recognizing one image.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct OcrResult {
    /// All lines joined with `\n`, in the order the engine reported them.
    pub text: String,
    pub lines: Vec<OcrLine>,
}

impl OcrResult {
    /// Build a result from its lines, deriving [`OcrResult::text`].
    pub fn from_lines(lines: Vec<OcrLine>) -> Self {
        let text = lines
            .iter()
            .map(|l| l.text.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        OcrResult { text, lines }
    }
}

/// One on-device text recognizer.
pub trait OcrBackend {
    /// Stable backend name for diagnostics (`"vision"`, `"windows-media-ocr"`, …).
    fn name(&self) -> &'static str;

    /// Recognize text in the image at `image_path`.
    ///
    /// Blocking: run it off any latency-sensitive thread (see
    /// [`ocr_record`], which does this for you).
    fn recognize(&self, image_path: &Path) -> Result<OcrResult, OcrError>;
}

/// The backend used on platforms with no on-device OCR engine.
pub struct UnsupportedOcr;

impl OcrBackend for UnsupportedOcr {
    fn name(&self) -> &'static str {
        "unsupported"
    }

    fn recognize(&self, _image_path: &Path) -> Result<OcrResult, OcrError> {
        Err(OcrError::Unsupported {
            platform: std::env::consts::OS,
        })
    }
}

/// The OCR backend for the platform this binary was built for.
pub fn platform_backend() -> Box<dyn OcrBackend + Send + Sync> {
    #[cfg(target_os = "macos")]
    {
        Box::new(macos::VisionOcr)
    }
    #[cfg(target_os = "windows")]
    {
        Box::new(windows::WindowsOcr)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Box::new(UnsupportedOcr)
    }
}

/// Map engine lines onto the platform-neutral extraction input (US-007).
pub fn to_extract_lines(lines: &[OcrLine]) -> Vec<ExtractLine> {
    lines
        .iter()
        .map(|l| ExtractLine {
            text: l.text.clone(),
            bbox: LineBox {
                x: l.bbox.x,
                y: l.bbox.y,
                width: l.bbox.width,
                height: l.bbox.height,
            },
            confidence: l.confidence,
        })
        .collect()
}

/// Step 1 of the post-capture pipeline: OCR only.
///
/// Folds the recognized text into the record (first in-place update the
/// toast sees) and returns the recognized lines with geometry so the caller
/// can feed [`extract_record`]. On OCR failure the line list is empty; the
/// record still lands at `status = plain` with `ocr_text = None`.
pub async fn ocr_only_record(
    hq_root: &Path,
    company_slug: &str,
    id: &str,
) -> Result<(CaptureRecord, Vec<ExtractLine>), IdeasError> {
    let captured: Arc<Mutex<Vec<ExtractLine>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&captured);
    let record = run_ocr_stage(hq_root, company_slug, id, move |image_path| {
        let result = platform_backend()
            .recognize(image_path)
            .map_err(|e| e.to_string())?;
        if let Ok(mut slot) = sink.lock() {
            *slot = to_extract_lines(&result.lines);
        }
        Ok(result.text)
    })
    .await?;
    let lines = captured.lock().map(|slot| slot.clone()).unwrap_or_default();
    Ok((record, lines))
}

/// Step 2 of the post-capture pipeline: local extraction over the OCR lines
/// (second in-place update the toast sees). Falls back to the record's
/// `ocr_text` when `lines` is empty; never deletes, never fails the capture.
pub async fn extract_record(
    hq_root: &Path,
    company_slug: &str,
    id: &str,
    lines: Vec<ExtractLine>,
) -> Result<CaptureRecord, IdeasError> {
    run_extraction_stage(hq_root, company_slug, id, lines).await
}

/// Run OCR for a stored capture and fold the result into its record, then run
/// local extraction over the recognized lines (US-006 + US-007).
///
/// Recognition happens on the blocking pool (see
/// [`hq_desktop_core::ideas::pipeline::run_ocr_stage`]), so the capture path
/// can fire this and forget:
///
/// ```ignore
/// tokio::spawn(async move { let _ = ocr_record(&root, &slug, &id).await; });
/// ```
///
/// The record is saved twice — once after OCR, once after extraction — so a
/// live toast (US-005) sees text arrive, then the typed card. On any failure
/// the record still lands at `status = plain`; it is never deleted.
pub async fn ocr_record(
    hq_root: &Path,
    company_slug: &str,
    id: &str,
) -> Result<CaptureRecord, IdeasError> {
    let (_after_ocr, lines) = ocr_only_record(hq_root, company_slug, id).await?;
    extract_record(hq_root, company_slug, id, lines).await
}
