//! `Windows.Media.Ocr` text recognition (Windows).
//!
//! Uses the OCR engine for the user's profile languages, which ships with
//! Windows 10/11 — fully on-device, no network, no key.
//!
//! Note: `Windows.Media.Ocr` reports no per-line confidence. Every line is
//! published with [`WINDOWS_DEFAULT_CONFIDENCE`] so downstream thresholds have
//! a defined value rather than a missing one; treat it as "engine accepted the
//! line", not as a measured score.

#![cfg(target_os = "windows")]

use std::path::Path;

use windows::core::HSTRING;
use windows::Graphics::Imaging::BitmapDecoder;
use windows::Media::Ocr::OcrEngine;
use windows::Storage::{FileAccessMode, StorageFile};

use super::{BBox, OcrBackend, OcrError, OcrLine, OcrResult};

/// Confidence published for every Windows line — the engine reports none.
pub const WINDOWS_DEFAULT_CONFIDENCE: f32 = 1.0;

/// `Windows.Media.Ocr` backend.
pub struct WindowsOcr;

impl OcrBackend for WindowsOcr {
    fn name(&self) -> &'static str {
        "windows-media-ocr"
    }

    fn recognize(&self, image_path: &Path) -> Result<OcrResult, OcrError> {
        let meta = std::fs::metadata(image_path).map_err(|e| OcrError::io(image_path, e))?;
        if !meta.is_file() {
            return Err(OcrError::Backend(format!(
                "{} is not a file",
                image_path.display()
            )));
        }
        // StorageFile only accepts a fully-qualified path.
        let absolute =
            std::fs::canonicalize(image_path).map_err(|e| OcrError::io(image_path, e))?;
        recognize_inner(&absolute).map_err(|e| OcrError::Backend(e.to_string()))
    }
}

fn recognize_inner(image_path: &Path) -> windows::core::Result<OcrResult> {
    let path = HSTRING::from(image_path.as_os_str());
    let file = StorageFile::GetFileFromPathAsync(&path)?.get()?;
    let stream = file.OpenAsync(FileAccessMode::Read)?.get()?;
    let decoder = BitmapDecoder::CreateAsync(&stream)?.get()?;
    let bitmap = decoder.GetSoftwareBitmapAsync()?.get()?;

    // Divisors for normalizing the engine's pixel rects; guard against a
    // degenerate bitmap so we never divide by zero.
    let width = bitmap.PixelWidth()?.max(1) as f32;
    let height = bitmap.PixelHeight()?.max(1) as f32;

    let engine = OcrEngine::TryCreateFromUserProfileLanguages()?;
    let result = engine.RecognizeAsync(&bitmap)?.get()?;

    let mut lines = Vec::new();
    for line in result.Lines()? {
        let text = line.Text()?.to_string_lossy();
        if text.trim().is_empty() {
            continue;
        }
        // Windows gives per-word rects only; union them into a line rect.
        let mut left = f32::MAX;
        let mut top = f32::MAX;
        let mut right = f32::MIN;
        let mut bottom = f32::MIN;
        let mut any_word = false;
        for word in line.Words()? {
            let rect = word.BoundingRect()?;
            any_word = true;
            left = left.min(rect.X);
            top = top.min(rect.Y);
            right = right.max(rect.X + rect.Width);
            bottom = bottom.max(rect.Y + rect.Height);
        }
        let bbox = if any_word {
            BBox {
                x: left / width,
                y: top / height,
                width: (right - left) / width,
                height: (bottom - top) / height,
            }
        } else {
            BBox::default()
        };
        lines.push(OcrLine {
            text,
            bbox,
            confidence: WINDOWS_DEFAULT_CONFIDENCE,
        });
    }
    Ok(OcrResult::from_lines(lines))
}
