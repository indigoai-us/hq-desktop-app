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
