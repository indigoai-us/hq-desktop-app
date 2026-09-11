//! Local extraction (US-007): turn OCR lines + provenance + colour cues into a
//! [`CaptureKind`], structured fields, auto-tags, and an *honest* confidence.
//!
//! Everything here is platform-neutral. `hq-platform` (which owns the OCR
//! engines) depends on this crate, never the reverse, so the input types are
//! defined here and the platform layer maps its own `OcrLine` into
//! [`ExtractLine`].
//!
//! Design rules honoured (see `design.md`, delta 3):
//! - confidence is user-visible: `≥ 0.75` is asserted, `0.4..0.75` is a
//!   suggestion, `< 0.4` leaves the record a plain image;
//! - a wrong-but-confident answer is the most expensive failure, so cues that
//!   disagree cap confidence below the assertion bar ([`local::classify`]).

pub mod local;

use image::DynamicImage;

use super::record::{CaptureKind, CaptureStatus, Provenance};

/// Confidence at or above which a classification is asserted as fact.
pub const EXTRACTED_THRESHOLD: f32 = 0.75;
/// Confidence at or above which a classification is offered as a suggestion.
pub const LOW_CONFIDENCE_THRESHOLD: f32 = 0.4;
/// Maximum number of auto-tags stored on a record.
pub const MAX_TAGS: usize = 5;
/// Maximum number of palette entries for a `color` capture.
pub const MAX_PALETTE: usize = 5;

/// A normalized rectangle in `0.0..=1.0` image space, origin top-left.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct LineBox {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

/// One recognized line of text with its geometry.
#[derive(Debug, Clone, PartialEq)]
pub struct ExtractLine {
    pub text: String,
    pub bbox: LineBox,
    /// Recognizer confidence in `0.0..=1.0`.
    pub confidence: f32,
}

/// One dominant colour sampled from the capture image.
#[derive(Debug, Clone, PartialEq)]
pub struct ColorSample {
    /// `#rrggbb`, lowercase.
    pub hex: String,
    /// Fraction of sampled pixels (after quantization) this colour covers.
    pub fraction: f32,
}

/// Everything the classifier looks at.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ExtractionInput {
    pub lines: Vec<ExtractLine>,
    pub app: String,
    pub window_title: String,
    pub url: Option<String>,
    /// Dominant colours, most frequent first. Empty when no image was
    /// available or decoding failed — colour cues then simply do not fire.
    pub palette: Vec<ColorSample>,
}

impl ExtractionInput {
    /// Build an input from OCR lines and record provenance.
    pub fn from_lines(lines: Vec<ExtractLine>, provenance: &Provenance) -> Self {
        ExtractionInput {
            lines,
            app: provenance.app.clone(),
            window_title: provenance.window_title.clone(),
            url: provenance.url.clone(),
            palette: Vec::new(),
        }
    }

    /// Fallback when only flat `ocr_text` is available: one line per text
    /// line with synthetic, evenly stacked boxes so layout heuristics still
    /// have a top-to-bottom order to work with.
    pub fn from_text(text: &str, provenance: &Provenance) -> Self {
        let raw: Vec<&str> = text
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .collect();
        let n = raw.len().max(1) as f32;
        let lines = raw
            .iter()
            .enumerate()
            .map(|(i, t)| ExtractLine {
                text: (*t).to_string(),
                bbox: LineBox {
                    x: 0.05,
                    y: i as f32 / n,
                    width: (t.chars().count() as f32 * 0.012).min(0.9),
                    height: 1.0 / n,
                },
                confidence: 0.5,
            })
            .collect();
        Self::from_lines(lines, provenance)
    }

    /// Attach colour cues sampled from the capture image.
    pub fn with_palette(mut self, palette: Vec<ColorSample>) -> Self {
        self.palette = palette;
        self
    }
}

/// The classifier's verdict.
#[derive(Debug, Clone, PartialEq)]
pub struct Extraction {
    pub kind: CaptureKind,
    /// `0.0..=1.0`.
    pub confidence: f32,
    /// Always a JSON object; `{}` for `Unknown`.
    pub extracted: serde_json::Value,
    /// At most [`MAX_TAGS`] lowercase tags.
    pub tags: Vec<String>,
}

/// Map a confidence onto the record status the design mandates.
///
/// `≥ 0.75` → `Extracted`; `0.4..0.75` → `LowConfidence`; `< 0.4` → `Plain`
/// (and the caller keeps `kind = Unknown`). NaN is treated as no confidence.
pub fn status_for(confidence: f32) -> CaptureStatus {
    if confidence >= EXTRACTED_THRESHOLD {
        CaptureStatus::Extracted
    } else if confidence >= LOW_CONFIDENCE_THRESHOLD {
        CaptureStatus::LowConfidence
    } else {
        CaptureStatus::Plain
    }
}

/// Sample the dominant colours of an image.
///
/// Pixels are quantized to 4 bits per channel (so anti-aliasing and JPEG-ish
/// noise collapse into one bucket), counted, and returned most-frequent
/// first with their coverage fraction. Fully transparent pixels are ignored.
/// Large images are strided so this stays cheap on the blocking pool.
pub fn sample_palette(image: &DynamicImage) -> Vec<ColorSample> {
    use std::collections::HashMap;

    let rgba = image.to_rgba8();
    let (w, h) = rgba.dimensions();
    if w == 0 || h == 0 {
        return Vec::new();
    }
    let stride = ((w as u64 * h as u64) / 40_000).max(1) as usize;
    let mut counts: HashMap<(u8, u8, u8), u64> = HashMap::new();
    let mut total: u64 = 0;
    for (i, px) in rgba.pixels().enumerate() {
        if i % stride != 0 {
            continue;
        }
        let [r, g, b, a] = px.0;
        if a < 16 {
            continue;
        }
        let key = (r >> 4, g >> 4, b >> 4);
        *counts.entry(key).or_insert(0) += 1;
        total += 1;
    }
    if total == 0 {
        return Vec::new();
    }
    let mut entries: Vec<((u8, u8, u8), u64)> = counts.into_iter().collect();
    entries.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    entries
        .into_iter()
        .take(16)
        .map(|((r, g, b), n)| ColorSample {
            // Expand each 4-bit bucket to the middle of its range.
            hex: format!(
                "#{:02x}{:02x}{:02x}",
                (r << 4) | 0x8,
                (g << 4) | 0x8,
                (b << 4) | 0x8
            ),
            fraction: n as f32 / total as f32,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{TimeZone, Utc};

    fn prov() -> Provenance {
        Provenance {
            app: "Safari".into(),
            window_title: "t".into(),
            url: None,
            captured_at: Utc.with_ymd_and_hms(2026, 9, 10, 12, 0, 0).unwrap(),
            display_id: 1,
        }
    }

    #[test]
    fn hq_idea_board_status_for_maps_thresholds_exactly() {
        assert_eq!(status_for(1.0), CaptureStatus::Extracted);
        assert_eq!(status_for(0.75), CaptureStatus::Extracted);
        assert_eq!(status_for(0.7499), CaptureStatus::LowConfidence);
        assert_eq!(status_for(0.4), CaptureStatus::LowConfidence);
        assert_eq!(status_for(0.3999), CaptureStatus::Plain);
        assert_eq!(status_for(0.0), CaptureStatus::Plain);
        assert_eq!(status_for(f32::NAN), CaptureStatus::Plain);
    }

    #[test]
    fn hq_idea_board_from_text_splits_lines_and_stacks_boxes() {
        let input = ExtractionInput::from_text("a\n\n  b  \nc", &prov());
        assert_eq!(input.lines.len(), 3);
        assert_eq!(input.lines[1].text, "b");
        assert!(input.lines[0].bbox.y < input.lines[1].bbox.y);
        assert!(input.lines[2].bbox.y < 1.0);
    }

    #[test]
    fn hq_idea_board_sample_palette_finds_flat_regions() {
        let mut img = image::RgbaImage::from_pixel(100, 10, image::Rgba([255, 0, 0, 255]));
        for x in 50..100 {
            for y in 0..10 {
                img.put_pixel(x, y, image::Rgba([0, 0, 255, 255]));
            }
        }
        let palette = sample_palette(&DynamicImage::ImageRgba8(img));
        assert_eq!(palette.len(), 2);
        assert!((palette[0].fraction - 0.5).abs() < 0.05);
        assert!(palette.iter().any(|c| c.hex == "#f80808"));
        assert!(palette.iter().any(|c| c.hex == "#0808f8"));
    }
}
