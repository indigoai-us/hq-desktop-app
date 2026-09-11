//! US-006: on-device OCR behind `OcrBackend`, exercised against the real
//! platform engine on the host.
//!
//! The fixture at `tests/fixtures/idea-board-fixture-text.png` is a 600x200
//! white PNG rendering the black 40px string "Idea Board fixture text".

use std::path::{Path, PathBuf};

use hq_platform::ocr::{platform_backend, OcrError};

fn fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/idea-board-fixture-text.png")
}

#[test]
fn hq_idea_board_fixture_image_exists() {
    assert!(fixture().is_file(), "fixture PNG must be committed");
}

#[cfg(target_os = "macos")]
#[test]
fn hq_idea_board_vision_backend_reads_the_fixture_text() {
    let backend = platform_backend();
    assert_eq!(backend.name(), "vision");

    let result = backend.recognize(&fixture()).expect("vision must succeed");
    let lower = result.text.to_lowercase();
    for word in ["idea", "board", "fixture"] {
        assert!(
            lower.contains(word),
            "missing {word:?} in {:?}",
            result.text
        );
    }

    assert!(!result.lines.is_empty(), "expected at least one line");
    for line in &result.lines {
        assert!(!line.text.is_empty());
        assert!(
            (0.0..=1.0).contains(&line.confidence),
            "confidence out of range: {}",
            line.confidence
        );
        let b = line.bbox;
        // Normalized, top-left origin (see hq_platform::ocr docs).
        assert!(
            (0.0..=1.0).contains(&b.x) && (0.0..=1.0).contains(&b.y),
            "bbox origin out of range: {b:?}"
        );
        assert!(b.width > 0.0 && b.height > 0.0, "empty bbox: {b:?}");
        assert!(
            b.x + b.width <= 1.001 && b.y + b.height <= 1.001,
            "bbox escapes the image: {b:?}"
        );
    }

    // `text` is the lines joined, so nothing is dropped between the two views.
    assert_eq!(
        result.text,
        result
            .lines
            .iter()
            .map(|l| l.text.as_str())
            .collect::<Vec<_>>()
            .join("\n")
    );
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
#[test]
fn hq_idea_board_missing_file_is_a_typed_io_error_not_a_panic() {
    let missing = tempfile::tempdir().unwrap().path().join("nope.png");
    let err = platform_backend().recognize(&missing).unwrap_err();
    assert!(
        matches!(err, OcrError::Io { .. }),
        "unexpected error: {err}"
    );
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
#[test]
fn hq_idea_board_non_image_file_errors_without_panicking() {
    let dir = tempfile::tempdir().unwrap();
    let junk = dir.path().join("not-an-image.png");
    std::fs::write(&junk, b"this is definitely not a PNG").unwrap();
    let err = platform_backend().recognize(&junk).unwrap_err();
    assert!(
        matches!(err, OcrError::Backend(_)),
        "unexpected error: {err}"
    );
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
#[test]
fn hq_idea_board_unsupported_platforms_return_a_typed_error() {
    let err = platform_backend().recognize(&fixture()).unwrap_err();
    assert!(
        matches!(err, OcrError::Unsupported { .. }),
        "unexpected error: {err}"
    );
}
