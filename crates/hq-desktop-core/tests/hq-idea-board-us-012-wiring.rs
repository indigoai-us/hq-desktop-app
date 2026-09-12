//! US-012 wiring: the capture write path honors the two stored settings.
//!
//! US-012 shipped `ideas::settings` as a pure resolution layer that nothing on
//! the write path consulted — `create_record` used the compiled-in 2000px bound
//! and always wrote into `companies/{slug}/ideas`. These tests hold the wiring:
//! the configured `imageMaxEdge` bounds the stored PNG, and the configured sync
//! posture selects the root, including the path-traversal screening US-012's
//! review added and the US-002 no-partial-record guarantee.

use hq_desktop_core::ideas::{
    create_record, ideas_root, is_local_only_root, load_record, move_record, save_record,
    sidecar_path, CaptureImage, CaptureRecord, NewCapture, Provenance, SIDECAR_FILE,
};

fn provenance() -> Provenance {
    Provenance {
        app: "Safari".to_string(),
        window_title: "Window".to_string(),
        url: None,
        captured_at: chrono::Utc::now(),
        display_id: 1,
    }
}

/// A `w`x`h` image, so the "longest edge" rule is actually exercised rather
/// than trivially satisfied by a square.
fn image(w: u32, h: u32) -> CaptureImage {
    CaptureImage::Decoded(image::DynamicImage::ImageRgba8(image::RgbaImage::new(w, h)))
}

fn seed(hq_root: &std::path::Path, max_edge: Option<u32>, local_only: bool) -> CaptureRecord {
    create_record(
        hq_root,
        NewCapture::pending("indigo", image(4000, 3000), provenance())
            .with_image_max_edge(max_edge)
            .with_local_only(local_only),
    )
    .expect("capture is stored")
}

#[test]
fn hq_idea_board_configured_image_max_edge_bounds_the_stored_png() {
    for (choice, expected) in [(1200u32, 1200u32), (2000, 2000), (4000, 4000)] {
        let root = tempfile::tempdir().unwrap();
        let record = seed(root.path(), Some(choice), false);
        let stored = image::open(root.path().join(&record.image_path)).unwrap();
        assert_eq!(
            stored.width().max(stored.height()),
            expected,
            "imageMaxEdge={choice} must bound the longest edge"
        );
        // Aspect ratio is preserved, so the shorter edge scales with it.
        assert_eq!(stored.height(), expected * 3 / 4);
    }
}

/// A hand-edited or synced `menubar.json` carrying an off-menu bound must not
/// become policy — it falls back to 2000, it does not fill the vault.
#[test]
fn hq_idea_board_off_menu_image_max_edge_falls_back_to_the_default() {
    for hostile in [None, Some(0u32), Some(1u32), Some(12000), Some(u32::MAX)] {
        let root = tempfile::tempdir().unwrap();
        let record = seed(root.path(), hostile, false);
        let stored = image::open(root.path().join(&record.image_path)).unwrap();
        assert_eq!(
            stored.width().max(stored.height()),
            2000,
            "imageMaxEdge={hostile:?} must resolve to the 2000px default"
        );
    }
}

/// Sync off means the bytes never enter the vault sync scope — and the stored
/// `image_path` says so, because the board badge is a privacy claim keyed off it.
#[test]
fn hq_idea_board_sync_off_writes_outside_the_vault_sync_scope() {
    let root = tempfile::tempdir().unwrap();
    let hq = root.path();
    let record = seed(hq, Some(1200), true);

    assert_eq!(
        record.image_path,
        format!("workspace/ideas-local/indigo/{}/image.png", record.id)
    );
    assert!(hq.join(&record.image_path).is_file());
    assert!(hq
        .join("workspace/ideas-local/indigo")
        .join(&record.id)
        .join("record.json")
        .is_file());
    // Nothing at all under the vault root.
    assert!(!hq.join("companies/indigo/ideas").exists());
    assert!(is_local_only_root(&hq.join(&record.image_path)));

    // ...and it round-trips by id without the caller knowing which root it is in.
    let reloaded = load_record(hq, "indigo", &record.id).unwrap();
    assert_eq!(reloaded.image_path, record.image_path);
}

#[test]
fn hq_idea_board_sync_on_is_byte_identical_to_the_us_002_vault_layout() {
    let root = tempfile::tempdir().unwrap();
    let hq = root.path();
    let record = seed(hq, Some(2000), false);

    assert_eq!(
        record.image_path,
        format!("companies/indigo/ideas/{}/image.png", record.id)
    );
    assert_eq!(
        record.image_path,
        CaptureRecord::relative_image_path("indigo", &record.id)
    );
    assert!(!hq.join("workspace/ideas-local").exists());
    assert!(!is_local_only_root(&hq.join(&record.image_path)));
}

/// The privacy regression: a later edit must follow the record to the
/// local-only root, not re-create it under `companies/…`.
#[test]
fn hq_idea_board_saving_a_local_only_record_never_lands_in_the_vault() {
    let root = tempfile::tempdir().unwrap();
    let hq = root.path();
    let mut record = seed(hq, Some(2000), true);

    record.note = Some("private".to_string());
    save_record(hq, &mut record).unwrap();

    assert!(
        !hq.join("companies/indigo/ideas").exists(),
        "save_record republished a local-only capture into the vault"
    );
    assert_eq!(
        load_record(hq, "indigo", &record.id).unwrap().note.as_deref(),
        Some("private")
    );
    // The sidecar (qmd's input) stays out of the vault too.
    assert!(hq
        .join("workspace/ideas-local/indigo")
        .join(&record.id)
        .join("capture.md")
        .is_file());
}

#[test]
fn hq_idea_board_moving_a_local_only_record_keeps_it_local_only() {
    let root = tempfile::tempdir().unwrap();
    let hq = root.path();
    let record = seed(hq, Some(2000), true);

    let moved = move_record(hq, &record.id, "indigo", "liverecover").unwrap();
    assert_eq!(moved.company_slug, "liverecover");
    assert_eq!(
        moved.image_path,
        format!("workspace/ideas-local/liverecover/{}/image.png", record.id)
    );
    assert!(hq.join(&moved.image_path).is_file());
    assert!(!hq.join("companies/liverecover").exists());
    // Gone from the source root, present exactly once.
    assert!(!hq
        .join("workspace/ideas-local/indigo")
        .join(&record.id)
        .exists());
}

/// A configured root is validated, never blindly joined — the hardening
/// US-012's review added, now enforced on the write path it guards.
#[test]
fn hq_idea_board_a_traversing_company_is_rejected_before_any_write() {
    let root = tempfile::tempdir().unwrap();
    let hq = root.path();
    for hostile in ["../../../../tmp/pwn", "..", ".", "", "a/b", "a\\b", "x\0y"] {
        for local_only in [false, true] {
            let attempt = create_record(
                hq,
                NewCapture::pending(hostile, image(8, 8), provenance()).with_local_only(local_only),
            );
            assert!(
                attempt.is_err(),
                "company {hostile:?} (local_only={local_only}) must be rejected"
            );
            assert!(
                ideas_root(hq, hostile, !local_only).is_err(),
                "ideas_root must reject {hostile:?} too"
            );
        }
    }
    // Nothing escaped and nothing partial was left behind.
    assert!(!hq.join("companies").exists());
    assert!(!hq.join("workspace").exists());
    assert!(!std::path::Path::new("/tmp/pwn").exists());
}

/// US-002's guarantee, re-asserted under the local-only layout: a record is
/// either fully present (image + json + sidecar) or absent.
#[test]
fn hq_idea_board_local_only_records_are_still_written_whole() {
    let root = tempfile::tempdir().unwrap();
    let hq = root.path();
    let record = seed(hq, Some(1200), true);
    let dir = hq.join("workspace/ideas-local/indigo").join(&record.id);

    for file in ["image.png", "record.json", "capture.md"] {
        assert!(dir.join(file).is_file(), "{file} missing from a stored record");
    }
    // No scratch files survived the atomic writes.
    let leftovers: Vec<String> = std::fs::read_dir(&dir)
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| n.contains(".tmp"))
        .collect();
    assert!(leftovers.is_empty(), "scratch files left behind: {leftovers:?}");
}

/// The board renders a thumbnail by handing `record.image_path` to the
/// authorized-preview command, which runs it through the desktop read-scope
/// gate. Two things have to hold at once, and an earlier draft of this test got
/// the second one backwards:
///
/// 1. a capture must stay readable for its OWN company — otherwise the board
///    shows the "local only" badge over broken images;
/// 2. moving captures out of the vault tree must NOT drop them out of the
///    cross-company gate — `workspace/ideas-local/` is still per-company data,
///    and the renderer supplies the path.
#[test]
fn hq_idea_board_local_only_image_paths_stay_company_scoped_and_readable() {
    use hq_desktop_core::scope_gate::enforce_read_scope;

    let root = tempfile::tempdir().unwrap();
    let record = seed(root.path(), Some(2000), true);

    // (1) readable for its own company.
    enforce_read_scope(&record.image_path, Some("indigo"))
        .expect("a local-only capture must be previewable for its own company");

    // (2) NOT readable from another company's session, and not from an unbound
    // one — the same rule the synced layout gets.
    let other = enforce_read_scope(&record.image_path, Some("liverecover"));
    assert!(
        other.is_err(),
        "a local-only capture leaked across companies: {other:?}"
    );
    assert!(enforce_read_scope(&record.image_path, None).is_err());

    // Sanity: the gate still polices the synced layout too, so the assertions
    // above are a property of the gate, not of a path it happens to ignore.
    let synced = CaptureRecord::relative_image_path("indigo", &record.id);
    assert!(enforce_read_scope(&synced, Some("liverecover")).is_err());
    enforce_read_scope(&synced, Some("indigo")).unwrap();
}

/// `sidecar_path` must name the file that actually exists. It is the qmd
/// sidecar — the OCR-bearing one — so a builder that always returned the vault
/// spelling would hand the next caller a path into the synced tree for a
/// capture the user asked to keep local.
#[test]
fn hq_idea_board_sidecar_path_follows_a_local_only_record() {
    let root = tempfile::tempdir().unwrap();
    let hq = root.path();

    let local = seed(hq, Some(1200), true);
    let path = sidecar_path(hq, "indigo", &local.id);
    assert!(path.is_file(), "sidecar_path named a file that does not exist: {path:?}");
    assert!(is_local_only_root(&path));
    assert_eq!(
        path,
        hq.join("workspace/ideas-local/indigo")
            .join(&local.id)
            .join(SIDECAR_FILE)
    );

    // The synced layout is unchanged, so this is resolution and not a blanket
    // redirect.
    let synced = seed(hq, Some(1200), false);
    let synced_path = sidecar_path(hq, "indigo", &synced.id);
    assert!(synced_path.is_file());
    assert!(!is_local_only_root(&synced_path));
}
