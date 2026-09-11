//! US-006: the OCR pipeline stage revises a stored record in place and always
//! degrades safely — the capture is never lost, whatever OCR does.

use std::io::Cursor;
use std::path::Path;

use chrono::{TimeZone, Utc};
use hq_desktop_core::ideas::pipeline::{apply_ocr_outcome, run_ocr_stage};
use hq_desktop_core::ideas::{
    create_record, load_record, record_dir, save_record, CaptureImage, CaptureRecord,
    CaptureStatus, NewCapture, Provenance,
};
use image::{DynamicImage, ImageFormat, RgbaImage};

fn provenance() -> Provenance {
    Provenance {
        app: "Safari".to_string(),
        window_title: "Some article".to_string(),
        url: None,
        captured_at: Utc.with_ymd_and_hms(2026, 9, 10, 12, 0, 0).unwrap(),
        display_id: 1,
    }
}

fn pending_record(root: &Path) -> CaptureRecord {
    let image = DynamicImage::ImageRgba8(RgbaImage::from_pixel(
        32,
        32,
        image::Rgba([255, 255, 255, 255]),
    ));
    let mut png = Vec::new();
    image
        .write_to(&mut Cursor::new(&mut png), ImageFormat::Png)
        .unwrap();
    create_record(
        root,
        NewCapture::pending("indigo", CaptureImage::Png(png), provenance()),
    )
    .unwrap()
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
async fn hq_idea_board_ocr_success_sets_text_and_moves_pending_to_plain() {
    let root = tempfile::tempdir().unwrap();
    let record = pending_record(root.path());
    assert_eq!(record.status, CaptureStatus::Pending);

    let updated = run_ocr_stage(root.path(), "indigo", &record.id, |path| {
        assert!(path.is_file(), "recognizer gets the resolved image path");
        Ok("Idea Board fixture text".to_string())
    })
    .await
    .unwrap();

    assert_eq!(updated.ocr_text.as_deref(), Some("Idea Board fixture text"));
    assert_eq!(updated.status, CaptureStatus::Plain);

    let reloaded = load_record(root.path(), "indigo", &record.id).unwrap();
    assert_eq!(
        reloaded.ocr_text.as_deref(),
        Some("Idea Board fixture text")
    );
    assert_eq!(reloaded.status, CaptureStatus::Plain);
    assert_files_intact(root.path(), &record.id);
}

#[tokio::test]
async fn hq_idea_board_ocr_failure_degrades_to_plain_without_losing_the_capture() {
    let root = tempfile::tempdir().unwrap();
    let record = pending_record(root.path());

    let updated = run_ocr_stage(root.path(), "indigo", &record.id, |_| {
        Err("vision refused the image".to_string())
    })
    .await
    .unwrap();

    assert_eq!(updated.ocr_text, None);
    assert_eq!(updated.status, CaptureStatus::Plain);
    assert_files_intact(root.path(), &record.id);
}

#[tokio::test]
async fn hq_idea_board_ocr_panic_degrades_to_plain_without_losing_the_capture() {
    let root = tempfile::tempdir().unwrap();
    let record = pending_record(root.path());

    let updated = run_ocr_stage(root.path(), "indigo", &record.id, |_| {
        panic!("backend exploded");
    })
    .await
    .unwrap();

    assert_eq!(updated.ocr_text, None);
    assert_eq!(updated.status, CaptureStatus::Plain);
    assert_files_intact(root.path(), &record.id);
}

#[tokio::test]
async fn hq_idea_board_ocr_empty_text_is_treated_as_no_text() {
    let root = tempfile::tempdir().unwrap();
    let record = pending_record(root.path());

    let updated = run_ocr_stage(root.path(), "indigo", &record.id, |_| {
        Ok("   \n ".to_string())
    })
    .await
    .unwrap();

    assert_eq!(updated.ocr_text, None);
    assert_eq!(updated.status, CaptureStatus::Plain);
}

#[tokio::test]
async fn hq_idea_board_ocr_never_clobbers_a_later_status() {
    let root = tempfile::tempdir().unwrap();
    let mut record = pending_record(root.path());
    record.status = CaptureStatus::Extracted;
    record.confidence = Some(0.9);
    save_record(root.path(), &mut record).unwrap();

    let updated = run_ocr_stage(root.path(), "indigo", &record.id, |_| {
        Ok("late ocr text".to_string())
    })
    .await
    .unwrap();

    assert_eq!(
        updated.status,
        CaptureStatus::Extracted,
        "a finished extraction must not be downgraded by a slow OCR completion"
    );
    assert_eq!(updated.ocr_text.as_deref(), Some("late ocr text"));
}

#[test]
fn hq_idea_board_apply_ocr_outcome_bumps_updated_at() {
    let root = tempfile::tempdir().unwrap();
    let record = pending_record(root.path());
    let before = record.updated_at;

    let updated = apply_ocr_outcome(
        root.path(),
        "indigo",
        &record.id,
        Ok("some text".to_string()),
    )
    .unwrap();
    assert!(updated.updated_at >= before);
    assert_eq!(updated.ocr_text.as_deref(), Some("some text"));
}

#[tokio::test]
async fn hq_idea_board_ocr_stage_on_missing_record_errors_without_panicking() {
    let root = tempfile::tempdir().unwrap();
    let err = run_ocr_stage(root.path(), "indigo", "01JNOPE000000000000000000", |_| {
        Ok("nope".to_string())
    })
    .await
    .unwrap_err();
    assert!(
        matches!(err, hq_desktop_core::ideas::IdeasError::NotFound { .. }),
        "unexpected error: {err}"
    );
}
