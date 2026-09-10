//! US-002 acceptance tests — capture record schema, vault storage, and image
//! downsampling for the HQ Idea Board.
//!
//! These exercise the real `hq_desktop_core::ideas` implementation against a
//! temporary HQ root; no mocks, no network, no shared process state.
//!
//! 1. A 4000×3000 capture is stored downsampled to a 2000px longest edge and
//!    its `record.json` satisfies the full on-disk schema contract (keys,
//!    JSON types, enum spellings, ULID id, bounded confidence, RFC 3339
//!    timestamps, canonical relative image path) — and nothing but
//!    `image.png` + `record.json` is left behind, proving the pre-downsample
//!    original is never retained.
//! 2. Moving a record from company A to company B leaves the files only under
//!    B, rewrites `company_slug` / `image_path`, and preserves the image bytes.

use std::collections::BTreeSet;

use chrono::DateTime;
use hq_desktop_core::ideas::{
    create_record, load_record, move_record, record_dir, CaptureImage, CaptureKind, CaptureRecord,
    CaptureStatus, NewCapture, Provenance,
};
use image::{DynamicImage, RgbaImage};
use serde_json::Value;

const KINDS: [&str; 7] = [
    "unknown", "x_post", "article", "image", "quote", "product", "color",
];
const STATUSES: [&str; 4] = ["pending", "extracted", "low_confidence", "plain"];

fn provenance() -> Provenance {
    Provenance {
        app: "Safari".to_string(),
        window_title: "A 4K article".to_string(),
        url: Some("https://example.com/post".to_string()),
        captured_at: DateTime::parse_from_rfc3339("2026-09-10T12:00:00Z")
            .unwrap()
            .into(),
        display_id: 2,
    }
}

/// Deterministic non-uniform fixture so downsampling has real work to do.
fn fixture(w: u32, h: u32) -> DynamicImage {
    DynamicImage::ImageRgba8(RgbaImage::from_fn(w, h, |x, y| {
        image::Rgba([(x % 256) as u8, (y % 256) as u8, ((x ^ y) % 256) as u8, 255])
    }))
}

fn entry_names(dir: &std::path::Path) -> BTreeSet<String> {
    std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
        .collect()
}

#[test]
fn us_002_fixture_4000x3000_is_downsampled_to_2000_and_record_json_matches_schema() {
    let root = tempfile::tempdir().unwrap();
    let record = create_record(
        root.path(),
        NewCapture::pending(
            "indigo",
            CaptureImage::Decoded(fixture(4000, 3000)),
            provenance(),
        ),
    )
    .expect("create_record should succeed for a 4000x3000 capture");

    let dir = record_dir(root.path(), "indigo", &record.id);

    // ── stored image is downsampled, PNG, aspect-preserving ────────────────
    let stored = image::open(dir.join("image.png")).expect("image.png should be a readable PNG");
    assert_eq!(
        (stored.width(), stored.height()),
        (2000, 1500),
        "4000x3000 must be bounded to a 2000px longest edge with aspect preserved"
    );

    // ── the original is never retained separately ──────────────────────────
    let entries = entry_names(&dir);
    let expected: BTreeSet<String> = ["image.png".to_string(), "record.json".to_string()]
        .into_iter()
        .collect();
    assert_eq!(
        entries, expected,
        "record dir must hold exactly image.png + record.json (no original, no leftover tmp)"
    );

    // ── record.json schema ─────────────────────────────────────────────────
    let raw = std::fs::read(dir.join("record.json")).unwrap();
    let json: Value = serde_json::from_slice(&raw).expect("record.json must be valid JSON");
    let obj = json.as_object().expect("record.json must be a JSON object");

    for key in [
        "id",
        "company_slug",
        "kind",
        "status",
        "image_path",
        "tags",
        "provenance",
        "cited_count",
        "created_at",
        "updated_at",
    ] {
        assert!(obj.contains_key(key), "record.json missing required key {key}");
    }

    let id = obj["id"].as_str().expect("id must be a string");
    assert_eq!(id.len(), 26, "id must be a 26-char ULID, got {id:?}");
    ulid::Ulid::from_string(id).expect("id must parse as a Crockford-base32 ULID");
    assert_eq!(id, record.id);

    assert_eq!(obj["company_slug"].as_str(), Some("indigo"));

    let kind = obj["kind"].as_str().expect("kind must be a string");
    assert!(KINDS.contains(&kind), "kind {kind:?} not in {KINDS:?}");
    assert_eq!(kind, "unknown", "a fresh capture is unclassified");

    let status = obj["status"].as_str().expect("status must be a string");
    assert!(
        STATUSES.contains(&status),
        "status {status:?} not in {STATUSES:?}"
    );
    assert_eq!(status, "pending", "a fresh capture is pending extraction");

    match obj.get("confidence") {
        None | Some(Value::Null) => {}
        Some(v) => {
            let c = v.as_f64().expect("confidence must be null or a number");
            assert!(
                (0.0..=1.0).contains(&c),
                "confidence {c} outside 0..=1"
            );
        }
    }

    assert_eq!(
        obj["image_path"].as_str(),
        Some(format!("companies/indigo/ideas/{id}/image.png").as_str()),
        "image_path must be the canonical HQ-root-relative path"
    );
    assert_eq!(
        obj["image_path"].as_str().unwrap(),
        CaptureRecord::relative_image_path("indigo", id)
    );

    if let Some(v) = obj.get("ocr_text") {
        assert!(v.is_null() || v.is_string(), "ocr_text must be null or string");
    }
    if let Some(v) = obj.get("extracted") {
        assert!(
            v.is_null() || v.is_object(),
            "extracted must be null or a JSON object"
        );
    }
    if let Some(v) = obj.get("note") {
        assert!(v.is_null() || v.is_string(), "note must be null or string");
    }

    let tags = obj["tags"].as_array().expect("tags must be an array");
    assert!(
        tags.iter().all(|t| t.is_string()),
        "tags must contain only strings"
    );

    let cited = &obj["cited_count"];
    assert!(
        cited.is_u64(),
        "cited_count must be an unsigned integer, got {cited}"
    );
    assert_eq!(cited.as_u64(), Some(0));

    for key in ["created_at", "updated_at"] {
        let ts = obj[key].as_str().unwrap_or_else(|| panic!("{key} must be a string"));
        DateTime::parse_from_rfc3339(ts)
            .unwrap_or_else(|e| panic!("{key} {ts:?} must be RFC 3339: {e}"));
    }

    let prov = obj["provenance"]
        .as_object()
        .expect("provenance must be a JSON object");
    for key in ["app", "window_title", "url", "captured_at", "display_id"] {
        assert!(prov.contains_key(key), "provenance missing key {key}");
    }
    assert_eq!(prov["app"].as_str(), Some("Safari"));
    assert_eq!(prov["window_title"].as_str(), Some("A 4K article"));
    assert!(
        prov["url"].is_null() || prov["url"].is_string(),
        "provenance.url must be null or string"
    );
    assert!(
        prov["display_id"].is_u64(),
        "provenance.display_id must be an unsigned integer"
    );
    DateTime::parse_from_rfc3339(prov["captured_at"].as_str().unwrap())
        .expect("provenance.captured_at must be RFC 3339");

    // ── typed round-trip: the file deserializes back to the returned record ─
    let from_disk: CaptureRecord =
        serde_json::from_slice(&raw).expect("record.json must deserialize into CaptureRecord");
    assert_eq!(from_disk, record);
    assert_eq!(from_disk.kind, CaptureKind::Unknown);
    assert_eq!(from_disk.status, CaptureStatus::Pending);
    from_disk.validate().expect("stored record must validate");
    assert_eq!(load_record(root.path(), "indigo", id).unwrap(), record);
}

#[test]
fn us_002_move_record_relocates_files_to_company_b_and_rewrites_attribution() {
    let root = tempfile::tempdir().unwrap();
    let record = create_record(
        root.path(),
        NewCapture::pending("a", CaptureImage::Decoded(fixture(1200, 900)), provenance()),
    )
    .expect("create_record should succeed under company a");

    let src = record_dir(root.path(), "a", &record.id);
    let image_before = std::fs::read(src.join("image.png")).unwrap();

    let moved = move_record(root.path(), &record.id, "a", "b").expect("move_record should succeed");

    // ── files exist only under company b ───────────────────────────────────
    assert!(
        !src.exists(),
        "the record dir under company a must be gone after the move"
    );
    let dest = record_dir(root.path(), "b", &record.id);
    assert_eq!(
        entry_names(&dest),
        ["image.png".to_string(), "record.json".to_string()]
            .into_iter()
            .collect::<BTreeSet<String>>(),
        "company b must hold exactly record.json + image.png"
    );

    // ── attribution follows the files ──────────────────────────────────────
    assert_eq!(moved.company_slug, "b");
    assert_eq!(
        moved.image_path,
        format!("companies/b/ideas/{}/image.png", record.id)
    );

    let reloaded = load_record(root.path(), "b", &record.id).expect("record must load under b");
    assert_eq!(reloaded.company_slug, "b", "company_slug must read b");
    assert_eq!(
        reloaded.image_path,
        CaptureRecord::relative_image_path("b", &record.id),
        "image_path must point under company b"
    );
    assert_eq!(reloaded, moved);
    assert_eq!(reloaded.id, record.id, "the move preserves the record id");
    assert!(
        load_record(root.path(), "a", &record.id).is_err(),
        "the record must no longer be loadable from company a"
    );

    // ── the image bytes are carried across untouched ───────────────────────
    let image_after = std::fs::read(dest.join("image.png")).unwrap();
    assert_eq!(
        image_after, image_before,
        "moving must not re-encode or alter the stored image"
    );
    let decoded = image::open(dest.join("image.png")).unwrap();
    assert_eq!((decoded.width(), decoded.height()), (1200, 900));
}
