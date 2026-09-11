//! US-011 — qmd indexing sidecar (`capture.md`) and the agent citation counter.
//!
//! Scope notes, stated up front so nothing here reads as more proof than it is:
//!
//! * **`qmd` is an external boundary.** These tests never spawn the real
//!   binary. The production code puts it behind `QmdIndexer`; `FakeQmd` below
//!   is an honest stand-in for `qmd update` + `qmd search -c indigo` (it walks
//!   the company collection root for `*.md` and matches phrases), and
//!   `QmdCli::command_args()` pins what the real invocation would be.
//! * **The Tauri command is covered one layer down.** `apps/sync/src-tauri`
//!   has no `lib` target (`src/main.rs` only, and `tests/` holds fixtures), so
//!   `ideas_mark_cited` cannot be linked from an integration test. Its whole
//!   persistence behaviour is `hq_desktop_core::ideas::mark_cited`, which is
//!   what is exercised here; the Tauri/CLI *wiring* contract is asserted from
//!   disk in `apps/sync/__tests__/stories/hq-idea-board-US-011.test.ts`.
//! * **"the card shows 'Cited 2× by agents'"** — the board card itself is
//!   US-009 and is not built yet. The honest testable contract today is the
//!   sidecar's own citation line (asserted here) plus the `citedLabel` helper
//!   (asserted in the TS story test).

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use chrono::{TimeZone, Utc};
use hq_desktop_core::ideas::{
    create_record, load_record, mark_cited, move_record, parse_sidecar_frontmatter,
    record_dir, reindex_after_write, save_record, sidecar_path, write_sidecar, CaptureImage,
    CaptureRecord, CaptureStatus, IdeasError, NewCapture, Provenance, QmdCli, QmdIndexer,
    SIDECAR_FILE,
};
use image::{DynamicImage, Rgba, RgbaImage};

// ── helpers ───────────────────────────────────────────────────────────────────

fn provenance() -> Provenance {
    Provenance {
        app: "Safari".to_string(),
        window_title: "X".to_string(),
        url: Some("https://x.com/someone/status/1".to_string()),
        captured_at: Utc.with_ymd_and_hms(2026, 9, 10, 12, 0, 0).unwrap(),
        display_id: 1,
    }
}

/// A tiny real image so `create_record` runs its true decode/encode path.
fn tiny_image() -> CaptureImage {
    CaptureImage::Decoded(DynamicImage::ImageRgba8(RgbaImage::from_pixel(
        8,
        8,
        Rgba([10, 20, 30, 255]),
    )))
}

fn capture_with_ocr(hq_root: &Path, ocr: &str) -> CaptureRecord {
    let mut new = NewCapture::pending("indigo", tiny_image(), provenance());
    new.ocr_text = Some(ocr.to_string());
    new.extracted = Some(serde_json::json!({
        "title": "A distinctive thought",
        "author": "@someone",
        "likes": 12
    }));
    new.tags = vec!["design".to_string()];
    new.note = Some("worth revisiting".to_string());
    create_record(hq_root, new).expect("create_record")
}

fn read_sidecar(hq_root: &Path, record: &CaptureRecord) -> String {
    std::fs::read_to_string(sidecar_path(hq_root, &record.company_slug, &record.id))
        .expect("capture.md should exist")
}

/// Stand-in for `qmd update` + `qmd search <phrase> -c indigo`: on `update` it
/// walks a collection root for `*.md` (sorted, deterministic) and caches their
/// text; `search` returns the paths whose text contains the phrase.
struct FakeQmd {
    root: PathBuf,
    index: Mutex<Vec<(PathBuf, String)>>,
    fail: bool,
}

impl FakeQmd {
    fn new(root: impl Into<PathBuf>) -> Self {
        FakeQmd {
            root: root.into(),
            index: Mutex::new(Vec::new()),
            fail: false,
        }
    }

    fn failing() -> Self {
        FakeQmd {
            root: PathBuf::from("/nonexistent"),
            index: Mutex::new(Vec::new()),
            fail: true,
        }
    }

    fn search(&self, phrase: &str) -> Vec<PathBuf> {
        self.index
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, text)| text.contains(phrase))
            .map(|(p, _)| p.clone())
            .collect()
    }

    fn walk(dir: &Path, out: &mut Vec<(PathBuf, String)>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        let mut paths: Vec<PathBuf> = entries.filter_map(|e| e.ok().map(|e| e.path())).collect();
        paths.sort();
        for path in paths {
            if path.is_dir() {
                FakeQmd::walk(&path, out);
            } else if path.extension().and_then(|e| e.to_str()) == Some("md") {
                if let Ok(text) = std::fs::read_to_string(&path) {
                    out.push((path, text));
                }
            }
        }
    }
}

impl QmdIndexer for FakeQmd {
    fn update(&self) -> Result<(), IdeasError> {
        if self.fail {
            return Err(IdeasError::Index("qmd update exited with 1".into()));
        }
        let mut found = Vec::new();
        FakeQmd::walk(&self.root, &mut found);
        *self.index.lock().unwrap() = found;
        Ok(())
    }
}

// ── e2eTests statement 1 ──────────────────────────────────────────────────────

/// Given a capture whose OCR text contains "zebra quartz manifold", when
/// `qmd update` runs, then searching that phrase in the company collection
/// returns the sidecar.
#[test]
fn hq_idea_board_qmd_update_makes_a_capture_findable_by_its_ocr_phrase() {
    let root = tempfile::tempdir().unwrap();

    // Decoy first, so a match on the target cannot be an artifact of ordering.
    let decoy = capture_with_ocr(root.path(), "totally unrelated signage text");
    let target = capture_with_ocr(root.path(), "zebra quartz manifold\nsecond line");

    // The collection root a company's qmd collection covers.
    let collection = root.path().join("companies").join("indigo");
    let qmd = FakeQmd::new(&collection);
    reindex_after_write(&qmd, &target.id);

    let hits = qmd.search("zebra quartz manifold");
    assert_eq!(
        hits,
        vec![sidecar_path(root.path(), "indigo", &target.id)],
        "exactly the target capture's sidecar should match; decoy={}",
        decoy.id
    );

    // Both sidecars were indexed — the search narrowed, the walk did not.
    assert_eq!(qmd.search("Capture ").len(), 2);

    // And pin what the real indexer would have run, since we did not spawn it.
    assert_eq!(
        QmdCli::new("/usr/local/bin/qmd").command_args(),
        vec!["update".to_string()]
    );
}

// ── e2eTests statement 2 ──────────────────────────────────────────────────────

/// Given a record with `cited_count` 0, when `mark_cited` is called twice,
/// then the count is 2 in `record.json` *and* `capture.md`, and the label the
/// card renders is "Cited 2× by agents".
#[test]
fn hq_idea_board_mark_cited_twice_reaches_two_in_record_and_sidecar() {
    let root = tempfile::tempdir().unwrap();
    let record = capture_with_ocr(root.path(), "zebra quartz manifold");
    assert_eq!(record.cited_count, 0);
    assert_eq!(
        parse_sidecar_frontmatter(&read_sidecar(root.path(), &record))
            .unwrap()
            .cited_count,
        0
    );

    let first = mark_cited(root.path(), "indigo", &record.id).unwrap();
    assert_eq!(first.cited_count, 1);
    let second = mark_cited(root.path(), "indigo", &record.id).unwrap();
    assert_eq!(second.cited_count, 2);

    // record.json
    assert_eq!(
        load_record(root.path(), "indigo", &record.id)
            .unwrap()
            .cited_count,
        2
    );

    // capture.md — frontmatter and the human-readable line the card mirrors.
    let markdown = read_sidecar(root.path(), &record);
    assert_eq!(
        parse_sidecar_frontmatter(&markdown).unwrap().cited_count,
        2
    );
    assert!(
        markdown.contains("Cited 2\u{00d7} by agents"),
        "sidecar should carry the citation line: {markdown}"
    );
    // U+00D7, not the ASCII letter x.
    assert!(!markdown.contains("Cited 2x by agents"), "{markdown}");
}

// ── acceptance criteria ───────────────────────────────────────────────────────

/// AC: the sidecar carries the frontmatter contract, the extracted fields and
/// the OCR text — and never the image binary.
#[test]
fn hq_idea_board_sidecar_carries_the_record_contract_and_no_image_bytes() {
    let root = tempfile::tempdir().unwrap();
    let record = capture_with_ocr(root.path(), "zebra quartz manifold");
    let markdown = read_sidecar(root.path(), &record);

    let fm = parse_sidecar_frontmatter(&markdown).unwrap();
    assert_eq!(fm.id, record.id);
    assert_eq!(fm.kind, record.kind);
    assert_eq!(fm.status, record.status);
    assert_eq!(fm.confidence, record.confidence);
    assert_eq!(fm.company, "indigo");
    assert_eq!(fm.tags, vec!["design".to_string()]);
    assert_eq!(fm.captured_at, record.provenance.captured_at);
    assert_eq!(fm.provenance, record.provenance);
    assert_eq!(fm.source_url, record.provenance.url);
    assert_eq!(fm.image_path, record.image_path);

    // Body: extracted fields + OCR text, as prose.
    assert!(markdown.contains("zebra quartz manifold"), "{markdown}");
    assert!(markdown.contains("A distinctive thought"), "{markdown}");
    assert!(markdown.contains("@someone"), "{markdown}");
    assert!(markdown.contains("worth revisiting"), "{markdown}");

    // Never the image binary: the PNG signature and its first chunk name.
    let bytes = std::fs::read(sidecar_path(root.path(), "indigo", &record.id)).unwrap();
    assert!(
        !bytes.windows(4).any(|w| w == b"\x89PNG"),
        "capture.md must not embed the image"
    );
    assert!(!bytes.windows(4).any(|w| w == b"IHDR"));
    // And it stays small — the image on disk is orders of magnitude larger in
    // kind, not a substring of this file.
    let image = root
        .path()
        .join("companies/indigo/ideas")
        .join(&record.id)
        .join("image.png");
    assert!(image.is_file(), "the image lives beside the sidecar");
    let image_bytes = std::fs::read(&image).unwrap();
    assert!(
        bytes.len() < image_bytes.len()
            || !bytes
                .windows(image_bytes.len())
                .any(|w| w == image_bytes.as_slice()),
        "the sidecar must not contain the image bytes"
    );
}

/// AC: sidecar writes are idempotent — identical bytes *and* an untouched
/// mtime, so a sync watcher sees no spurious change.
#[test]
fn hq_idea_board_rewriting_an_unchanged_sidecar_touches_nothing() {
    let root = tempfile::tempdir().unwrap();
    let record = capture_with_ocr(root.path(), "zebra quartz manifold");
    let target = sidecar_path(root.path(), "indigo", &record.id);
    let dir = record_dir(root.path(), "indigo", &record.id);

    let first_bytes = std::fs::read(&target).unwrap();
    let first_mtime = std::fs::metadata(&target).unwrap().modified().unwrap();

    // Deterministic separation without racing the clock: a rewrite is detected
    // by content equality, so any change would be visible immediately. The
    // sleep only guards against a coincidentally-equal coarse mtime, and is
    // bounded and unconditional (no polling).
    std::thread::sleep(std::time::Duration::from_millis(20));
    write_sidecar(&dir, &record).unwrap();

    assert_eq!(std::fs::read(&target).unwrap(), first_bytes);
    assert_eq!(
        std::fs::metadata(&target).unwrap().modified().unwrap(),
        first_mtime,
        "an unchanged record must not rewrite capture.md"
    );

    // A real change does rewrite it.
    let mut changed = record.clone();
    changed.cited_count = 7;
    write_sidecar(&dir, &changed).unwrap();
    let after = std::fs::read_to_string(&target).unwrap();
    assert_ne!(after.as_bytes(), first_bytes.as_slice());
    assert!(after.contains("Cited 7\u{00d7} by agents"), "{after}");
}

/// AC: the sidecar is *kept in sync* — every persistence path refreshes it.
#[test]
fn hq_idea_board_sidecar_follows_the_record_through_save_and_move() {
    let root = tempfile::tempdir().unwrap();
    let mut record = capture_with_ocr(root.path(), "zebra quartz manifold");

    // save_record with edited OCR text + status
    record.ocr_text = Some("revised ocr: cobalt lattice".to_string());
    record.status = CaptureStatus::Extracted;
    save_record(root.path(), &mut record).unwrap();

    let markdown = read_sidecar(root.path(), &record);
    assert!(markdown.contains("cobalt lattice"), "{markdown}");
    assert!(!markdown.contains("zebra quartz manifold"), "{markdown}");
    assert_eq!(
        parse_sidecar_frontmatter(&markdown).unwrap().status,
        CaptureStatus::Extracted
    );

    // move_record to another company rewrites `company` and leaves nothing behind.
    let moved = move_record(root.path(), &record.id, "indigo", "acme").unwrap();
    assert_eq!(moved.company_slug, "acme");

    let moved_markdown = read_sidecar(root.path(), &moved);
    assert_eq!(
        parse_sidecar_frontmatter(&moved_markdown).unwrap().company,
        "acme"
    );
    assert!(
        !record_dir(root.path(), "indigo", &record.id)
            .join(SIDECAR_FILE)
            .exists(),
        "no capture.md may be left in the source company"
    );
}

// ── failure paths ─────────────────────────────────────────────────────────────

#[test]
fn hq_idea_board_mark_cited_on_a_missing_record_is_not_found() {
    let root = tempfile::tempdir().unwrap();
    let err = mark_cited(root.path(), "indigo", "01J000000000000000000000ZZ").unwrap_err();
    assert!(
        matches!(err, IdeasError::NotFound { ref id, ref company_slug }
            if id == "01J000000000000000000000ZZ" && company_slug == "indigo"),
        "{err:?}"
    );
}

#[test]
fn hq_idea_board_mark_cited_rejects_a_traversal_id_and_writes_nothing() {
    let root = tempfile::tempdir().unwrap();
    let outside = root.path().parent().unwrap().join("escaped-capture.md");

    for bad in ["../x", "..", "/etc/passwd", "a/b"] {
        let err = mark_cited(root.path(), "indigo", bad).unwrap_err();
        assert!(matches!(err, IdeasError::Invalid(_)), "{bad}: {err:?}");
    }
    // And a traversal company slug is screened the same way.
    let err = mark_cited(root.path(), "../elsewhere", "01J000000000000000000000AA").unwrap_err();
    assert!(matches!(err, IdeasError::Invalid(_)), "{err:?}");

    assert!(!outside.exists(), "nothing may be written outside the root");
}

#[test]
fn hq_idea_board_a_failing_indexer_never_breaks_the_capture_path() {
    let root = tempfile::tempdir().unwrap();
    let record = capture_with_ocr(root.path(), "zebra quartz manifold");

    // Must not panic or unwind: indexing is best effort.
    reindex_after_write(&FakeQmd::failing(), &record.id);

    // The capture itself is intact regardless.
    assert_eq!(
        load_record(root.path(), "indigo", &record.id)
            .unwrap()
            .cited_count,
        0
    );
    assert!(sidecar_path(root.path(), "indigo", &record.id).is_file());
}
