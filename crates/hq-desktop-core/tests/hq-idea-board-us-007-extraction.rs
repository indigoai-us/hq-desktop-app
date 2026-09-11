//! US-007: local extraction bake-off over the real-world-shaped fixture set,
//! plus the pipeline stage end-to-end on a real temp record.
//!
//! The number that matters most is `confident_wrong == 0`: a capture with
//! `status = extracted` and the wrong kind is the one failure the design
//! forbids. Kind accuracy must clear 70% on the same set.

use std::io::Cursor;
use std::path::{Path, PathBuf};

use chrono::{TimeZone, Utc};
use hq_desktop_core::ideas::{
    classify, create_record, load_record, record_dir, run_extraction_stage, sample_palette,
    status_for, CaptureImage, CaptureKind, CaptureRecord, CaptureStatus, ExtractLine,
    ExtractionInput, LineBox, NewCapture, Provenance,
};
use image::{DynamicImage, ImageFormat, Rgba, RgbaImage};
use serde::Deserialize;

#[derive(Deserialize)]
struct Manifest {
    fixtures: Vec<ManifestEntry>,
}

#[derive(Deserialize)]
struct ManifestEntry {
    path: String,
    expected_kind: CaptureKind,
    #[serde(default)]
    ambiguous: bool,
}

#[derive(Deserialize)]
struct FixtureProvenance {
    app: String,
    window_title: String,
    #[serde(default)]
    url: Option<String>,
}

#[derive(Deserialize)]
struct FixtureLine {
    text: String,
    bbox: FixtureBox,
    confidence: f32,
}

#[derive(Deserialize)]
struct FixtureBox {
    x: f32,
    y: f32,
    width: f32,
    height: f32,
}

#[derive(Deserialize)]
struct FlatColor {
    hex: String,
    fraction: f32,
}

#[derive(Deserialize)]
struct Fixture {
    name: String,
    expected_kind: CaptureKind,
    provenance: FixtureProvenance,
    lines: Vec<FixtureLine>,
    #[serde(default)]
    flat_colors: Vec<FlatColor>,
}

fn fixtures_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../apps/sync/e2e/idea-board/fixtures")
}

fn provenance(p: &FixtureProvenance) -> Provenance {
    Provenance {
        app: p.app.clone(),
        window_title: p.window_title.clone(),
        url: p.url.clone(),
        captured_at: Utc.with_ymd_and_hms(2026, 9, 10, 12, 0, 0).unwrap(),
        display_id: 1,
    }
}

fn to_lines(lines: &[FixtureLine]) -> Vec<ExtractLine> {
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

fn parse_hex(hex: &str) -> Rgba<u8> {
    let digits: Vec<char> = hex.trim_start_matches('#').chars().collect();
    let channel = |i: usize| {
        let s: String = digits[i..i + 2].iter().collect();
        u8::from_str_radix(&s, 16).unwrap()
    };
    Rgba([channel(0), channel(2), channel(4), 255])
}

/// Render `flat_colors` as vertical stripes sized by fraction — the shape of
/// a swatch row — so the real palette sampler runs over real pixels.
fn render_flat_png(colors: &[FlatColor]) -> Vec<u8> {
    let width = 200u32;
    let height = 40u32;
    let mut img = RgbaImage::from_pixel(width, height, Rgba([255, 255, 255, 255]));
    let mut x0 = 0u32;
    for c in colors {
        let w = ((c.fraction * width as f32).round() as u32).min(width - x0);
        for x in x0..x0 + w {
            for y in 0..height {
                img.put_pixel(x, y, parse_hex(&c.hex));
            }
        }
        x0 += w;
    }
    let mut png = Vec::new();
    DynamicImage::ImageRgba8(img)
        .write_to(&mut Cursor::new(&mut png), ImageFormat::Png)
        .unwrap();
    png
}

fn load_fixture(entry: &ManifestEntry) -> Fixture {
    let path = fixtures_dir().join(&entry.path);
    let raw = std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    serde_json::from_slice(&raw).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

fn load_manifest() -> Manifest {
    let path = fixtures_dir().join("manifest.json");
    let raw = std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    serde_json::from_slice(&raw).unwrap()
}

fn input_for(fixture: &Fixture) -> ExtractionInput {
    let mut input =
        ExtractionInput::from_lines(to_lines(&fixture.lines), &provenance(&fixture.provenance));
    if !fixture.flat_colors.is_empty() {
        let png = render_flat_png(&fixture.flat_colors);
        let img = image::load_from_memory(&png).unwrap();
        input = input.with_palette(sample_palette(&img));
    }
    input
}

fn kind_name(k: CaptureKind) -> String {
    serde_json::to_value(k)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default()
}

#[test]
fn hq_idea_board_fixture_bake_off_is_accurate_and_never_confidently_wrong() {
    let manifest = load_manifest();
    assert!(
        manifest.fixtures.len() >= 20,
        "fixture set must hold at least 20 captures, has {}",
        manifest.fixtures.len()
    );

    let mut correct = 0usize;
    let mut confident_wrong: Vec<String> = Vec::new();
    let mut rows: Vec<String> = Vec::new();

    for entry in &manifest.fixtures {
        let fixture = load_fixture(entry);
        assert_eq!(fixture.expected_kind, entry.expected_kind, "{}", entry.path);
        let out = classify(&input_for(&fixture));
        let status = status_for(out.confidence);
        assert!(
            out.extracted.is_object(),
            "{}: extracted must be an object",
            fixture.name
        );
        assert!(out.tags.len() <= 5, "{}: too many tags", fixture.name);
        assert!(
            (0.0..=1.0).contains(&out.confidence),
            "{}: confidence out of range",
            fixture.name
        );
        if status == CaptureStatus::Plain {
            assert_eq!(
                out.kind,
                CaptureKind::Unknown,
                "{}: plain must be unknown",
                fixture.name
            );
        }

        let hit = out.kind == fixture.expected_kind;
        if hit {
            correct += 1;
        }
        if status == CaptureStatus::Extracted && !hit {
            confident_wrong.push(fixture.name.clone());
        }
        rows.push(format!(
            "{:<36} expected={:<8} got={:<8} conf={:.2} status={:<14} {}{}",
            fixture.name,
            kind_name(fixture.expected_kind),
            kind_name(out.kind),
            out.confidence,
            format!("{:?}", status).to_lowercase(),
            if hit { "ok" } else { "MISS" },
            if entry.ambiguous { " (ambiguous)" } else { "" }
        ));
    }

    let total = manifest.fixtures.len();
    let accuracy = correct as f32 / total as f32;
    eprintln!("\n== US-007 bake-off ==");
    for r in &rows {
        eprintln!("{r}");
    }
    eprintln!(
        "MEASURED kind_accuracy={accuracy:.3} ({correct}/{total}) confident_wrong={} fixtures={total}",
        confident_wrong.len()
    );

    assert!(
        confident_wrong.is_empty(),
        "confidently wrong fixtures (status extracted, wrong kind): {confident_wrong:?}"
    );
    assert!(accuracy >= 0.70, "kind accuracy {accuracy:.3} below 0.70");
}

fn pending_record_with_png(root: &Path, png: Vec<u8>, prov: Provenance) -> CaptureRecord {
    create_record(
        root,
        NewCapture::pending("indigo", CaptureImage::Png(png), prov),
    )
    .unwrap()
}

fn white_png() -> Vec<u8> {
    let image = DynamicImage::ImageRgba8(RgbaImage::from_pixel(32, 32, Rgba([255, 255, 255, 255])));
    let mut png = Vec::new();
    image
        .write_to(&mut Cursor::new(&mut png), ImageFormat::Png)
        .unwrap();
    png
}

fn assert_files_intact(root: &Path, id: &str) {
    let dir = record_dir(root, "indigo", id);
    assert!(
        dir.join("record.json").is_file(),
        "record.json must survive"
    );
    assert!(dir.join("image.png").is_file(), "image.png must survive");
}

#[tokio::test]
async fn hq_idea_board_x_post_fixture_through_pipeline_is_extracted_with_handle() {
    let manifest = load_manifest();
    let entry = manifest
        .fixtures
        .iter()
        .find(|e| e.path.ends_with("x-post-karpathy-safari.json"))
        .expect("x post fixture present");
    let fixture = load_fixture(entry);

    let root = tempfile::tempdir().unwrap();
    let record = pending_record_with_png(root.path(), white_png(), provenance(&fixture.provenance));
    assert_eq!(record.status, CaptureStatus::Pending);

    let updated = run_extraction_stage(root.path(), "indigo", &record.id, to_lines(&fixture.lines))
        .await
        .unwrap();

    assert_eq!(updated.kind, CaptureKind::XPost);
    assert_eq!(updated.status, CaptureStatus::Extracted);
    let confidence = updated.confidence.expect("confidence stored");
    assert!(confidence >= 0.75, "confidence {confidence}");
    let extracted = updated.extracted.as_ref().expect("extracted stored");
    let handle = extracted["handle"].as_str().expect("handle string");
    assert!(handle.starts_with('@'), "handle {handle:?}");
    assert_eq!(handle, "@karpathy");
    assert!(extracted["body"].as_str().unwrap().contains("English"));
    assert!(
        updated.tags.contains(&"x".to_string()),
        "{:?}",
        updated.tags
    );
    assert!(updated.updated_at >= record.updated_at);

    let reloaded = load_record(root.path(), "indigo", &record.id).unwrap();
    assert_eq!(reloaded, updated);
    assert_files_intact(root.path(), &record.id);
}

#[tokio::test]
async fn hq_idea_board_garbage_lines_leave_record_plain_and_unknown() {
    let root = tempfile::tempdir().unwrap();
    let prov = Provenance {
        app: "Unknown".into(),
        window_title: String::new(),
        url: None,
        captured_at: Utc.with_ymd_and_hms(2026, 9, 10, 12, 0, 0).unwrap(),
        display_id: 1,
    };
    let record = pending_record_with_png(root.path(), white_png(), prov);
    let garbage: Vec<ExtractLine> = ["|||", "l1 ll", "~~~ ~~"]
        .iter()
        .enumerate()
        .map(|(i, t)| ExtractLine {
            text: (*t).to_string(),
            bbox: LineBox {
                x: 0.1,
                y: 0.1 * i as f32,
                width: 0.2,
                height: 0.03,
            },
            confidence: 0.2,
        })
        .collect();

    let updated = run_extraction_stage(root.path(), "indigo", &record.id, garbage)
        .await
        .unwrap();

    assert_eq!(updated.kind, CaptureKind::Unknown);
    assert_eq!(updated.status, CaptureStatus::Plain);
    assert!(updated.confidence.unwrap_or(1.0) < 0.4);
    assert_eq!(updated.extracted, None);
    assert_files_intact(root.path(), &record.id);
}

#[tokio::test]
async fn hq_idea_board_extraction_falls_back_to_ocr_text_when_no_lines() {
    let root = tempfile::tempdir().unwrap();
    let prov = Provenance {
        app: "Safari".into(),
        window_title: "Quote by Alan Kay".into(),
        url: Some("https://www.goodreads.com/quotes/1".into()),
        captured_at: Utc.with_ymd_and_hms(2026, 9, 10, 12, 0, 0).unwrap(),
        display_id: 1,
    };
    let mut record = pending_record_with_png(root.path(), white_png(), prov);
    record.ocr_text =
        Some("“The best way to predict the future is to invent it.”\n― Alan Kay".to_string());
    record.status = CaptureStatus::Plain;
    hq_desktop_core::ideas::save_record(root.path(), &mut record).unwrap();

    let updated = run_extraction_stage(root.path(), "indigo", &record.id, Vec::new())
        .await
        .unwrap();
    assert_eq!(updated.kind, CaptureKind::Quote);
    assert_ne!(updated.status, CaptureStatus::Pending);
    assert_eq!(
        updated.extracted.as_ref().unwrap()["attribution"],
        "Alan Kay"
    );
    assert_files_intact(root.path(), &record.id);
}

#[tokio::test]
async fn hq_idea_board_extraction_on_missing_record_errors_without_panicking() {
    let root = tempfile::tempdir().unwrap();
    let err = run_extraction_stage(
        root.path(),
        "indigo",
        "01JNOPE000000000000000000",
        Vec::new(),
    )
    .await
    .unwrap_err();
    assert!(
        matches!(err, hq_desktop_core::ideas::IdeasError::NotFound { .. }),
        "{err}"
    );
}
