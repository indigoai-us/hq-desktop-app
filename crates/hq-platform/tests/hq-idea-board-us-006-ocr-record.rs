//! US-006 end-to-end on the host platform: a pending capture goes through
//! `ocr_record` and comes back with recognized text and `status = plain`.

#![cfg(target_os = "macos")]

use std::path::{Path, PathBuf};

use hq_desktop_core::ideas::{
    create_record, load_record, CaptureImage, CaptureStatus, NewCapture, Provenance,
};
use hq_platform::ocr::ocr_record;

fn fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/idea-board-fixture-text.png")
}

fn provenance() -> Provenance {
    Provenance {
        app: "Safari".to_string(),
        window_title: "Fixture".to_string(),
        url: None,
        captured_at: chrono::Utc::now(),
        display_id: 1,
    }
}

#[tokio::test]
async fn hq_idea_board_ocr_record_fills_text_and_marks_the_capture_plain() {
    let root = tempfile::tempdir().unwrap();
    let png = std::fs::read(fixture()).unwrap();
    let record = create_record(
        root.path(),
        NewCapture::pending("indigo", CaptureImage::Png(png), provenance()),
    )
    .unwrap();
    assert_eq!(record.status, CaptureStatus::Pending);
    assert_eq!(record.ocr_text, None);

    let updated = ocr_record(root.path(), "indigo", &record.id)
        .await
        .expect("ocr_record must not fail the capture");

    let text = updated
        .ocr_text
        .expect("expected recognized text")
        .to_lowercase();
    for word in ["idea", "board", "fixture", "text"] {
        assert!(text.contains(word), "missing {word:?} in {text:?}");
    }
    assert_eq!(updated.status, CaptureStatus::Plain);

    let reloaded = load_record(root.path(), "indigo", &record.id).unwrap();
    assert_eq!(reloaded.status, CaptureStatus::Plain);
    assert!(reloaded.ocr_text.is_some());
}

/// e2eTest 2: "Given an unreadable image, when OCR runs, then status is
/// plain, ocr_text is null, and the record still exists."
///
/// Storage decodes the PNG on `create_record`, so to get an unreadable image
/// on disk we overwrite `image.png` with garbage bytes *after* the record is
/// created, then run the real macOS backend through `ocr_record`.
#[tokio::test]
async fn hq_idea_board_us_006_ocr_record_unreadable_image_keeps_record_plain_no_text() {
    let root = tempfile::tempdir().unwrap();
    let png = std::fs::read(fixture()).unwrap();
    let record = create_record(
        root.path(),
        NewCapture::pending("indigo", CaptureImage::Png(png), provenance()),
    )
    .unwrap();
    assert_eq!(record.status, CaptureStatus::Pending);

    let image_path = root.path().join(&record.image_path);
    std::fs::write(&image_path, b"not a png, just garbage bytes").unwrap();

    let updated = ocr_record(root.path(), "indigo", &record.id)
        .await
        .expect("ocr_record must degrade gracefully, never fail the capture");

    assert_eq!(updated.status, CaptureStatus::Plain);
    assert_eq!(updated.ocr_text, None);

    let record_json = root.path().join(&record.image_path).with_file_name("record.json");
    assert!(record_json.is_file(), "record.json must still exist");
    assert!(image_path.is_file(), "image.png must still exist");

    let reloaded = load_record(root.path(), "indigo", &record.id).unwrap();
    assert_eq!(reloaded.status, CaptureStatus::Plain);
    assert_eq!(reloaded.ocr_text, None);
}
