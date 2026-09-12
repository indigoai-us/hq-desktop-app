//! Vault storage for capture records.
//!
//! Layout (inside the existing `companies/…` vault sync scope):
//!
//! ```text
//! {hq_root}/companies/{slug}/ideas/{id}/record.json
//! {hq_root}/companies/{slug}/ideas/{id}/image.png
//! {hq_root}/companies/{slug}/ideas/{id}/capture.md
//! ```
//!
//! `capture.md` is the qmd-indexable sidecar (see [`super::sidecar`]). It is
//! written by the same private helper that writes `record.json`, so create /
//! save / move all keep the two in sync by construction — there is no code
//! path that persists a record without refreshing its sidecar.
//!
//! Writes are atomic: content goes to a `.tmp` sibling in the same directory
//! and is then renamed over the target, matching `config.rs` / `journal.rs`.
//! Images are downsampled to [`MAX_IMAGE_EDGE`] before the first write — the
//! caller's original bytes are never persisted anywhere.

use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use image::{DynamicImage, ImageFormat};
use ulid::Ulid;

use super::record::{
    validate_path_component, CaptureKind, CaptureRecord, CaptureStatus, IdeasError, Provenance,
    MAX_IMAGE_EDGE,
};
use super::settings;

/// Reject a string that must not escape or redirect a vault path when joined
/// into one (empty, `.`, `..`, anything with a separator or NUL).
///
/// Every public entry point runs this on `company_slug` and `id` *before* the
/// first filesystem call, so [`ideas_dir`] / [`record_dir`] only ever see
/// screened components. Those two are path builders, not I/O, and stay
/// infallible.
fn validate_component(s: &str) -> Result<(), IdeasError> {
    validate_path_component("path component", s)
}

/// `{hq_root}/companies/{slug}/ideas`
///
/// Pure path construction — callers that touch the filesystem must have run
/// [`validate_component`] on `company_slug` first.
pub fn ideas_dir(hq_root: &Path, company_slug: &str) -> PathBuf {
    hq_root
        .join("companies")
        .join(company_slug)
        .join("ideas")
}

/// `{hq_root}/companies/{slug}/ideas/{id}`
///
/// Pure path construction — see [`ideas_dir`] on component validation.
pub fn record_dir(hq_root: &Path, company_slug: &str, id: &str) -> PathBuf {
    ideas_dir(hq_root, company_slug).join(id)
}

/// `{ideas_root}/{id}` for the layout `local_only` selects — the synced vault
/// directory, or the sync-excluded local-only one.
///
/// Validating (unlike [`record_dir`]) because it routes through
/// [`settings::ideas_root`], which screens `company_slug` before joining it.
pub fn record_dir_for(
    hq_root: &Path,
    company_slug: &str,
    id: &str,
    local_only: bool,
) -> Result<PathBuf, IdeasError> {
    validate_component(id)?;
    Ok(settings::ideas_root(hq_root, company_slug, !local_only)?.join(id))
}

/// Where record `id` actually lives right now: the synced directory when that
/// exists, otherwise the local-only one when that exists.
///
/// Every *revise* path (`load`, `save`, `delete`, `move`, `mark_cited`) routes
/// through here so it follows a record to wherever it was written. Without it,
/// `save_record` on a capture taken while sync was off would re-create it under
/// `companies/…` — copying a capture the user asked to keep off the vault INTO
/// the vault on the next note edit. That is the failure this function exists to
/// prevent, and `hq_idea_board_saving_a_local_only_record_never_lands_in_the_vault`
/// holds it.
///
/// Falls back to the synced directory when neither exists, so a genuine
/// `NotFound` still names the conventional location.
///
/// [`existing_record_dir_or_vault`] is the infallible flavour for pure path
/// builders like [`super::sidecar::sidecar_path`], which have no error channel;
/// an unscreenable component there degrades to the vault spelling, which the
/// fallible I/O entry points then reject anyway.
pub(super) fn existing_record_dir_or_vault(hq_root: &Path, company_slug: &str, id: &str) -> PathBuf {
    existing_record_dir(hq_root, company_slug, id)
        .unwrap_or_else(|_| record_dir(hq_root, company_slug, id))
}

fn existing_record_dir(hq_root: &Path, company_slug: &str, id: &str) -> Result<PathBuf, IdeasError> {
    let synced = record_dir_for(hq_root, company_slug, id, false)?;
    let local = record_dir_for(hq_root, company_slug, id, true)?;
    // Resolve on `record.json`, not on the directory: an empty or half-torn-down
    // directory in the synced root would otherwise shadow a perfectly good
    // record with the same id in the local-only root, in both passes of the
    // board's two-root scan.
    if synced.join("record.json").is_file() {
        return Ok(synced);
    }
    if local.join("record.json").is_file() {
        return Ok(local);
    }
    // No readable record either side. Name whichever directory exists, so
    // `delete_record` can still clear a half-written one; synced wins the tie
    // and is also the fallback when neither exists, keeping `NotFound` on the
    // conventional location.
    if local.is_dir() && !synced.is_dir() {
        return Ok(local);
    }
    Ok(synced)
}

/// The image a caller hands to [`create_record`]. Either raw encoded bytes
/// (PNG — whatever the screen capture produced) or an already-decoded image.
pub enum CaptureImage {
    /// Encoded bytes; decoded with the PNG decoder.
    Png(Vec<u8>),
    /// Already decoded in memory.
    Decoded(DynamicImage),
}

/// Everything needed to mint a new record. The id, timestamps, and image path
/// are assigned by [`create_record`].
pub struct NewCapture {
    pub company_slug: String,
    pub image: CaptureImage,
    pub provenance: Provenance,
    pub kind: CaptureKind,
    pub status: CaptureStatus,
    pub confidence: Option<f32>,
    pub ocr_text: Option<String>,
    pub extracted: Option<serde_json::Value>,
    pub tags: Vec<String>,
    pub note: Option<String>,
    /// Longest stored edge, in pixels. `None` uses [`MAX_IMAGE_EDGE`]; a value
    /// outside [`settings::IMAGE_MAX_EDGE_CHOICES`] is ignored the same way,
    /// so a hand-edited 12000 on disk cannot become a vault-filling policy.
    pub image_max_edge: Option<u32>,
    /// Write outside the vault sync scope (the user's "Sync: off" posture).
    pub local_only: bool,
}

impl NewCapture {
    /// A pending, unclassified capture — the shape the hotkey path produces.
    pub fn pending(company_slug: impl Into<String>, image: CaptureImage, provenance: Provenance) -> Self {
        NewCapture {
            company_slug: company_slug.into(),
            image,
            provenance,
            kind: CaptureKind::Unknown,
            status: CaptureStatus::Pending,
            confidence: None,
            ocr_text: None,
            extracted: None,
            tags: Vec::new(),
            note: None,
            image_max_edge: None,
            local_only: false,
        }
    }

    /// Apply the user's Retention choice. Off-menu values fall back to the
    /// default in [`settings::resolve_image_max_edge`].
    pub fn with_image_max_edge(mut self, max_edge: Option<u32>) -> Self {
        self.image_max_edge = max_edge;
        self
    }

    /// Apply the user's Sync choice. `true` = keep this capture out of the
    /// vault sync scope.
    pub fn with_local_only(mut self, local_only: bool) -> Self {
        self.local_only = local_only;
        self
    }
}

/// Downsample so the longest edge is at most [`MAX_IMAGE_EDGE`]. Never upscales.
///
/// Uses Lanczos3: highest fidelity, slowest filter. Capture volume here is one
/// image per hotkey press, so quality wins; if the capture path ever needs to
/// be faster (US-003/US-004 latency work), this is the knob to turn.
pub fn downsample(image: DynamicImage) -> DynamicImage {
    downsample_to(image, MAX_IMAGE_EDGE)
}

/// Downsample so the longest edge is at most `max_edge`. Never upscales.
///
/// Same filter and aspect-ratio contract as [`downsample`]; the bound is the
/// user's Retention choice rather than the compiled-in default. `max_edge` of 0
/// would ask `resize` for a degenerate box, so it is treated as "unset" and
/// falls back to [`MAX_IMAGE_EDGE`].
pub fn downsample_to(image: DynamicImage, max_edge: u32) -> DynamicImage {
    let bound = if max_edge == 0 { MAX_IMAGE_EDGE } else { max_edge };
    let (w, h) = (image.width(), image.height());
    if w.max(h) <= bound {
        return image;
    }
    // `resize` preserves aspect ratio and fits inside the bounding box, so the
    // longest edge lands exactly on `bound`.
    image.resize(bound, bound, image::imageops::FilterType::Lanczos3)
}

/// Create a record: downsample + PNG-encode the image, then atomically write
/// `image.png` and `record.json` under the company's ideas directory.
///
/// Both user preferences from US-012 are honored here and nowhere else on the
/// write path: `new.image_max_edge` bounds the stored image, and
/// `new.local_only` selects the sync-excluded root. The atomic-write /
/// no-partial-record guarantee from US-002 is unchanged — the target directory
/// moves, the teardown-on-failure does not.
pub fn create_record(hq_root: &Path, new: NewCapture) -> Result<CaptureRecord, IdeasError> {
    validate_component(&new.company_slug)?;
    let decoded = match new.image {
        CaptureImage::Decoded(img) => img,
        CaptureImage::Png(bytes) => image::load_from_memory_with_format(&bytes, ImageFormat::Png)
            .map_err(|e| IdeasError::Image(e.to_string()))?,
    };
    let bounded = downsample_to(decoded, settings::resolve_image_max_edge(new.image_max_edge));

    let mut png = Vec::new();
    bounded
        .write_to(&mut Cursor::new(&mut png), ImageFormat::Png)
        .map_err(|e| IdeasError::Image(e.to_string()))?;
    // The pre-downsample image is dropped here and never written to disk.
    drop(bounded);

    let id = Ulid::new().to_string();
    let now: DateTime<Utc> = Utc::now();
    let record = CaptureRecord {
        image_path: CaptureRecord::relative_image_path_for(&new.company_slug, &id, new.local_only)?,
        id: id.clone(),
        company_slug: new.company_slug.clone(),
        kind: new.kind,
        status: new.status,
        confidence: new.confidence,
        ocr_text: new.ocr_text,
        extracted: new.extracted,
        tags: new.tags,
        extraction_source: None,
        provenance: new.provenance,
        note: new.note,
        cited_count: 0,
        created_at: now,
        updated_at: now,
    };
    record.validate()?;

    // `record_dir_for` re-screens the slug through `settings::ideas_root`, so a
    // configured root is validated rather than blindly joined — the same
    // hardening `relative_image_path_for` just applied to the stored path.
    let dir = record_dir_for(hq_root, &new.company_slug, &id, new.local_only)?;
    fs::create_dir_all(&dir).map_err(|e| IdeasError::io(&dir, e))?;
    // If either write fails the record is half-formed, so tear the whole
    // directory down rather than leave an image with no record.json (which a
    // later scan would read as a corrupt capture). Best-effort: a failed
    // cleanup must not mask the original error.
    if let Err(e) = atomic_write(&dir.join("image.png"), &png).and_then(|()| write_record_json(&dir, &record)) {
        let _ = fs::remove_dir_all(&dir);
        return Err(e);
    }
    Ok(record)
}

/// Read a record back from the vault.
pub fn load_record(hq_root: &Path, company_slug: &str, id: &str) -> Result<CaptureRecord, IdeasError> {
    validate_component(company_slug)?;
    validate_component(id)?;
    let path = existing_record_dir(hq_root, company_slug, id)?.join("record.json");
    let raw = match fs::read(&path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(IdeasError::NotFound {
                id: id.to_string(),
                company_slug: company_slug.to_string(),
            })
        }
        Err(e) => return Err(IdeasError::io(&path, e)),
    };
    let record: CaptureRecord = serde_json::from_slice(&raw)?;
    Ok(record)
}

/// Persist a revised record, bumping `updated_at`. Atomic.
pub fn save_record(hq_root: &Path, record: &mut CaptureRecord) -> Result<(), IdeasError> {
    // `validate` screens id + company_slug as path components too.
    record.validate()?;
    record.updated_at = Utc::now();
    let dir = existing_record_dir(hq_root, &record.company_slug, &record.id)?;
    fs::create_dir_all(&dir).map_err(|e| IdeasError::io(&dir, e))?;
    write_record_json(&dir, record)
}

/// Relocate a record (JSON + image) from one company to another and rewrite its
/// `company_slug` / `image_path`.
///
/// The directory move is a single `rename`, so the record is never half-present
/// in both companies. Fails if the destination already holds this id. Moving a
/// record to the company it is already in is a no-op that just reloads it.
///
/// Note the two-step: `rename` first, then rewrite `record.json` in place. In
/// the window between them the files are already under `to_company` while the
/// JSON still names `from_company`. Attribution is therefore
/// **authoritative-by-path** — a reader that disagrees with the on-disk
/// `company_slug` should trust the directory the record was found in, and
/// re-running `move_record` for the same target repairs the JSON.
///
/// Sync posture is carried across, not re-decided: a local-only record lands
/// under the destination company's local-only root.
pub fn move_record(
    hq_root: &Path,
    id: &str,
    from_company: &str,
    to_company: &str,
) -> Result<CaptureRecord, IdeasError> {
    validate_component(id)?;
    validate_component(from_company)?;
    validate_component(to_company)?;
    let src = existing_record_dir(hq_root, from_company, id)?;
    if !src.is_dir() {
        return Err(IdeasError::NotFound {
            id: id.to_string(),
            company_slug: from_company.to_string(),
        });
    }
    // Reassigning a capture between companies must not change whether it syncs.
    // A local-only capture dragged to another company stays local-only; moving
    // it into `companies/…` would publish, to a second company's vault, a
    // capture the user asked to keep on this machine.
    let local_only = settings::is_local_only_root(&src);
    // Must precede the `dest.exists()` check: for a same-company move src and
    // dest are the same directory, which would otherwise report
    // DestinationExists for what is really a no-op.
    if from_company == to_company {
        return load_record(hq_root, from_company, id);
    }
    let dest = record_dir_for(hq_root, to_company, id, local_only)?;
    if dest.exists() {
        return Err(IdeasError::DestinationExists(dest.display().to_string()));
    }

    let dest_parent = settings::ideas_root(hq_root, to_company, !local_only)?;
    fs::create_dir_all(&dest_parent).map_err(|e| IdeasError::io(&dest_parent, e))?;
    fs::rename(&src, &dest).map_err(|e| IdeasError::io(&src, e))?;

    let mut record = load_record(hq_root, to_company, id)?;
    record.company_slug = to_company.to_string();
    record.image_path = CaptureRecord::relative_image_path_for(to_company, id, local_only)?;
    record.updated_at = Utc::now();
    write_record_json(&dest, &record)?;
    Ok(record)
}

/// Remove a record entirely: `record.json`, `image.png`, and the `capture.md`
/// sidecar all go with the directory.
///
/// Deliberately irreversible and deliberately *not* a tombstone — the board's
/// delete is a user-confirmed destructive action, and leaving a stub behind
/// would keep the sidecar in the qmd index. Callers should refresh the index
/// afterwards (`qmd update` rescans the collection and prunes files that no
/// longer exist, so the capture drops out of search).
pub fn delete_record(hq_root: &Path, company_slug: &str, id: &str) -> Result<(), IdeasError> {
    validate_component(company_slug)?;
    validate_component(id)?;
    let dir = existing_record_dir(hq_root, company_slug, id)?;
    if !dir.is_dir() {
        return Err(IdeasError::NotFound {
            id: id.to_string(),
            company_slug: company_slug.to_string(),
        });
    }
    fs::remove_dir_all(&dir).map_err(|e| IdeasError::io(&dir, e))
}

/// Record that an agent cited this capture: `cited_count += 1`.
///
/// Saturating rather than wrapping — a counter that rolls over to 0 would read
/// as "never cited", which is worse than a stuck maximum.
///
/// The write goes through [`save_record`], so `record.json` and `capture.md`
/// both carry the new count and stay in whichever root the record was written
/// to — the vault one, or the local-only one when the user had sync off.
pub fn mark_cited(
    hq_root: &Path,
    company_slug: &str,
    id: &str,
) -> Result<CaptureRecord, IdeasError> {
    let mut record = load_record(hq_root, company_slug, id)?;
    record.cited_count = record.cited_count.saturating_add(1);
    save_record(hq_root, &mut record)?;
    Ok(record)
}

// ── internals ──────────────────────────────────────────────────────────────────

/// Write `record.json` **and** refresh the `capture.md` sidecar.
///
/// Every persistence path (`create_record`, `save_record`, `move_record`)
/// funnels through here, which is what guarantees the sidecar can never drift
/// from the record. `record.json` is written first: it is the source of truth,
/// and a sidecar failure must not leave the record unwritten.
fn write_record_json(dir: &Path, record: &CaptureRecord) -> Result<(), IdeasError> {
    let bytes = serde_json::to_vec_pretty(record)?;
    atomic_write(&dir.join("record.json"), &bytes)?;
    super::sidecar::write_sidecar(dir, record)
}

pub(super) fn atomic_write(target: &Path, bytes: &[u8]) -> Result<(), IdeasError> {
    let name = target
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "record".to_string());
    // Per-call unique suffix: two writers racing on the same target must not
    // share a scratch file, or one truncates the other's half-written bytes.
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = target.with_file_name(format!("{name}.{}.{nanos}.tmp", std::process::id()));
    fs::write(&tmp, bytes).map_err(|e| IdeasError::io(&tmp, e))?;
    if let Err(e) = fs::rename(&tmp, target) {
        // Don't leave scratch files behind when the rename is what failed.
        let _ = fs::remove_file(&tmp);
        return Err(IdeasError::io(target, e));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use image::RgbaImage;

    fn provenance() -> Provenance {
        Provenance {
            app: "Safari".to_string(),
            window_title: "Some article".to_string(),
            url: Some("https://example.com".to_string()),
            captured_at: Utc.with_ymd_and_hms(2026, 9, 10, 12, 0, 0).unwrap(),
            display_id: 1,
        }
    }

    fn gradient(w: u32, h: u32) -> DynamicImage {
        DynamicImage::ImageRgba8(RgbaImage::from_fn(w, h, |x, y| {
            image::Rgba([(x % 256) as u8, (y % 256) as u8, 128, 255])
        }))
    }

    #[test]
    fn create_record_downsamples_to_2000px_longest_edge() {
        let root = tempfile::tempdir().unwrap();
        let record = create_record(
            root.path(),
            NewCapture::pending(
                "indigo",
                CaptureImage::Decoded(gradient(4000, 3000)),
                provenance(),
            ),
        )
        .unwrap();

        let dir = record_dir(root.path(), "indigo", &record.id);
        assert!(dir.join("record.json").is_file());
        let stored = image::open(dir.join("image.png")).unwrap();
        assert_eq!((stored.width(), stored.height()), (2000, 1500));
        assert_eq!(
            record.image_path,
            format!("companies/indigo/ideas/{}/image.png", record.id)
        );
        assert_eq!(record.status, CaptureStatus::Pending);
        assert_eq!(record.kind, CaptureKind::Unknown);
        assert_eq!(record.cited_count, 0);

        let reloaded = load_record(root.path(), "indigo", &record.id).unwrap();
        assert_eq!(reloaded, record);
    }

    #[test]
    fn small_images_are_not_upscaled() {
        let root = tempfile::tempdir().unwrap();
        let record = create_record(
            root.path(),
            NewCapture::pending(
                "indigo",
                CaptureImage::Decoded(gradient(1200, 800)),
                provenance(),
            ),
        )
        .unwrap();
        let stored =
            image::open(record_dir(root.path(), "indigo", &record.id).join("image.png")).unwrap();
        assert_eq!((stored.width(), stored.height()), (1200, 800));
    }

    #[test]
    fn png_bytes_input_is_decoded_and_bounded() {
        let root = tempfile::tempdir().unwrap();
        let mut png = Vec::new();
        gradient(2400, 2400)
            .write_to(&mut Cursor::new(&mut png), ImageFormat::Png)
            .unwrap();
        let record = create_record(
            root.path(),
            NewCapture::pending("indigo", CaptureImage::Png(png), provenance()),
        )
        .unwrap();
        let stored =
            image::open(record_dir(root.path(), "indigo", &record.id).join("image.png")).unwrap();
        assert_eq!((stored.width(), stored.height()), (2000, 2000));
    }

    #[test]
    fn move_record_relocates_files_and_rewrites_attribution() {
        let root = tempfile::tempdir().unwrap();
        let record = create_record(
            root.path(),
            NewCapture::pending("a", CaptureImage::Decoded(gradient(800, 600)), provenance()),
        )
        .unwrap();

        let moved = move_record(root.path(), &record.id, "a", "b").unwrap();
        assert_eq!(moved.company_slug, "b");
        assert_eq!(
            moved.image_path,
            format!("companies/b/ideas/{}/image.png", record.id)
        );

        let old = record_dir(root.path(), "a", &record.id);
        let new = record_dir(root.path(), "b", &record.id);
        assert!(!old.exists(), "source dir should be gone");
        assert!(new.join("image.png").is_file());
        assert!(new.join("record.json").is_file());

        let reloaded = load_record(root.path(), "b", &record.id).unwrap();
        assert_eq!(reloaded.company_slug, "b");
        assert!(matches!(
            load_record(root.path(), "a", &record.id),
            Err(IdeasError::NotFound { .. })
        ));
    }

    #[test]
    fn move_record_errors_when_missing_or_destination_taken() {
        let root = tempfile::tempdir().unwrap();
        assert!(matches!(
            move_record(root.path(), "01JNOPE", "a", "b"),
            Err(IdeasError::NotFound { .. })
        ));

        let record = create_record(
            root.path(),
            NewCapture::pending("a", CaptureImage::Decoded(gradient(64, 64)), provenance()),
        )
        .unwrap();
        fs::create_dir_all(record_dir(root.path(), "b", &record.id)).unwrap();
        assert!(matches!(
            move_record(root.path(), &record.id, "a", "b"),
            Err(IdeasError::DestinationExists(_))
        ));
    }

    #[test]
    fn save_record_bumps_updated_at_and_rejects_bad_confidence() {
        let root = tempfile::tempdir().unwrap();
        let mut record = create_record(
            root.path(),
            NewCapture::pending("indigo", CaptureImage::Decoded(gradient(64, 64)), provenance()),
        )
        .unwrap();
        let created = record.updated_at;

        record.status = CaptureStatus::Extracted;
        record.confidence = Some(0.9);
        record.extracted = Some(serde_json::json!({ "title": "t" }));
        save_record(root.path(), &mut record).unwrap();
        assert!(record.updated_at >= created);
        let reloaded = load_record(root.path(), "indigo", &record.id).unwrap();
        assert_eq!(reloaded.status, CaptureStatus::Extracted);
        assert_eq!(reloaded.confidence, Some(0.9));

        record.confidence = Some(1.5);
        assert!(matches!(
            save_record(root.path(), &mut record),
            Err(IdeasError::Invalid(_))
        ));
    }

    #[test]
    fn traversal_components_are_rejected_and_write_nothing_outside_the_root() {
        let outer = tempfile::tempdir().unwrap();
        let root = outer.path().join("hq");
        fs::create_dir_all(&root).unwrap();

        // A slug that would escape the vault root entirely.
        assert!(matches!(
            create_record(
                &root,
                NewCapture::pending(
                    "../../evil",
                    CaptureImage::Decoded(gradient(32, 32)),
                    provenance(),
                ),
            ),
            Err(IdeasError::Invalid(_))
        ));

        let record = create_record(
            &root,
            NewCapture::pending("a", CaptureImage::Decoded(gradient(32, 32)), provenance()),
        )
        .unwrap();
        assert!(matches!(
            move_record(&root, &record.id, "a", "../b"),
            Err(IdeasError::Invalid(_))
        ));
        assert!(matches!(
            move_record(&root, "../../../etc", "a", "b"),
            Err(IdeasError::Invalid(_))
        ));
        assert!(matches!(
            load_record(&root, "..", &record.id),
            Err(IdeasError::Invalid(_))
        ));
        assert!(matches!(
            load_record(&root, "a/b", &record.id),
            Err(IdeasError::Invalid(_))
        ));
        assert!(matches!(
            create_record(
                &root,
                NewCapture::pending("", CaptureImage::Decoded(gradient(32, 32)), provenance()),
            ),
            Err(IdeasError::Invalid(_))
        ));

        // Nothing landed beside the vault root, and the escaped paths do not exist.
        let siblings: Vec<_> = fs::read_dir(outer.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(siblings, vec![std::ffi::OsString::from("hq")], "{siblings:?}");
        assert!(!outer.path().join("evil").exists());
        assert!(!root.join("companies/../../evil").exists());
        // The one legitimate record is still the only thing under the root.
        assert!(record_dir(&root, "a", &record.id).join("record.json").is_file());
    }

    #[test]
    fn same_company_move_is_a_no_op() {
        let root = tempfile::tempdir().unwrap();
        let record = create_record(
            root.path(),
            NewCapture::pending("a", CaptureImage::Decoded(gradient(64, 64)), provenance()),
        )
        .unwrap();

        let moved = move_record(root.path(), &record.id, "a", "a").unwrap();
        assert_eq!(moved.company_slug, "a");
        assert_eq!(moved, record);

        let dir = record_dir(root.path(), "a", &record.id);
        assert!(dir.join("record.json").is_file());
        assert!(dir.join("image.png").is_file());
    }

    #[test]
    fn hq_idea_board_create_record_writes_a_sidecar_without_the_image() {
        let root = tempfile::tempdir().unwrap();
        let mut new = NewCapture::pending(
            "indigo",
            CaptureImage::Decoded(gradient(800, 600)),
            provenance(),
        );
        new.ocr_text = Some("zebra quartz manifold".to_string());
        new.extracted = Some(serde_json::json!({ "title": "A thought" }));
        let record = create_record(root.path(), new).unwrap();

        let dir = record_dir(root.path(), "indigo", &record.id);
        let sidecar = dir.join(super::super::sidecar::SIDECAR_FILE);
        assert!(sidecar.is_file(), "capture.md should sit beside record.json");

        let bytes = fs::read(&sidecar).unwrap();
        let text = String::from_utf8(bytes.clone()).unwrap();
        assert!(text.contains("zebra quartz manifold"), "{text}");
        assert!(text.contains("- **title**: A thought"), "{text}");
        assert!(text.contains(&record.id), "{text}");

        // The image binary must never leak into the indexed sidecar.
        assert!(
            !bytes.windows(4).any(|w| w == b"\x89PNG"),
            "sidecar contains a PNG signature"
        );
        let image_b64_prefix = "iVBORw0KGgo"; // base64 of the PNG signature
        assert!(!text.contains(image_b64_prefix), "{text}");
        assert!(
            bytes.len() < 64 * 1024,
            "sidecar should stay small, got {} bytes",
            bytes.len()
        );
    }

    #[test]
    fn hq_idea_board_save_record_refreshes_the_sidecar_body() {
        use super::super::sidecar::{parse_sidecar_frontmatter, SIDECAR_FILE};
        let root = tempfile::tempdir().unwrap();
        let mut record = create_record(
            root.path(),
            NewCapture::pending("indigo", CaptureImage::Decoded(gradient(64, 64)), provenance()),
        )
        .unwrap();
        let sidecar = record_dir(root.path(), "indigo", &record.id).join(SIDECAR_FILE);
        assert!(!fs::read_to_string(&sidecar).unwrap().contains("## Extracted"));

        record.status = CaptureStatus::Extracted;
        record.confidence = Some(0.9);
        record.ocr_text = Some("later ocr text".to_string());
        record.extracted = Some(serde_json::json!({ "title": "after extraction" }));
        save_record(root.path(), &mut record).unwrap();

        let text = fs::read_to_string(&sidecar).unwrap();
        assert!(text.contains("- **title**: after extraction"), "{text}");
        assert!(text.contains("later ocr text"), "{text}");
        let fm = parse_sidecar_frontmatter(&text).unwrap();
        assert_eq!(fm.status, CaptureStatus::Extracted);
        assert_eq!(fm.confidence, Some(0.9));
    }

    #[test]
    fn hq_idea_board_move_record_moves_the_sidecar_and_rewrites_company() {
        use super::super::sidecar::{parse_sidecar_frontmatter, SIDECAR_FILE};
        let root = tempfile::tempdir().unwrap();
        let record = create_record(
            root.path(),
            NewCapture::pending("a", CaptureImage::Decoded(gradient(64, 64)), provenance()),
        )
        .unwrap();

        move_record(root.path(), &record.id, "a", "b").unwrap();

        assert!(!record_dir(root.path(), "a", &record.id).exists());
        let sidecar = record_dir(root.path(), "b", &record.id).join(SIDECAR_FILE);
        let fm = parse_sidecar_frontmatter(&fs::read_to_string(&sidecar).unwrap()).unwrap();
        assert_eq!(fm.company, "b");
        assert_eq!(
            fm.image_path,
            format!("companies/b/ideas/{}/image.png", record.id)
        );
    }

    #[test]
    fn hq_idea_board_mark_cited_increments_record_and_sidecar() {
        use super::super::sidecar::{parse_sidecar_frontmatter, SIDECAR_FILE};
        let root = tempfile::tempdir().unwrap();
        let record = create_record(
            root.path(),
            NewCapture::pending("indigo", CaptureImage::Decoded(gradient(64, 64)), provenance()),
        )
        .unwrap();
        assert_eq!(record.cited_count, 0);

        assert_eq!(mark_cited(root.path(), "indigo", &record.id).unwrap().cited_count, 1);
        let second = mark_cited(root.path(), "indigo", &record.id).unwrap();
        assert_eq!(second.cited_count, 2);

        assert_eq!(
            load_record(root.path(), "indigo", &record.id).unwrap().cited_count,
            2
        );
        let text =
            fs::read_to_string(record_dir(root.path(), "indigo", &record.id).join(SIDECAR_FILE))
                .unwrap();
        assert_eq!(parse_sidecar_frontmatter(&text).unwrap().cited_count, 2);
        assert!(text.contains("Cited 2× by agents"), "{text}");
    }

    #[test]
    fn hq_idea_board_mark_cited_rejects_traversal_and_missing_records() {
        let root = tempfile::tempdir().unwrap();
        assert!(matches!(
            mark_cited(root.path(), "indigo", "../../etc"),
            Err(IdeasError::Invalid(_))
        ));
        assert!(matches!(
            mark_cited(root.path(), "indigo", "01JMISSING"),
            Err(IdeasError::NotFound { .. })
        ));
    }

    #[test]
    fn ids_are_distinct_ulids() {
        let root = tempfile::tempdir().unwrap();
        let first = create_record(
            root.path(),
            NewCapture::pending("indigo", CaptureImage::Decoded(gradient(32, 32)), provenance()),
        )
        .unwrap();
        let second = create_record(
            root.path(),
            NewCapture::pending("indigo", CaptureImage::Decoded(gradient(32, 32)), provenance()),
        )
        .unwrap();
        assert_eq!(first.id.len(), 26);
        assert!(Ulid::from_string(&first.id).is_ok());
        assert!(Ulid::from_string(&second.id).is_ok());
        assert_ne!(first.id, second.id);
    }

    #[test]
    fn hq_idea_board_delete_record_removes_directory_and_sidecar() {
        let root = tempfile::tempdir().unwrap();
        let record = create_record(
            root.path(),
            NewCapture::pending("indigo", CaptureImage::Decoded(gradient(8, 8)), provenance()),
        )
        .unwrap();
        let dir = record_dir(root.path(), "indigo", &record.id);
        assert!(dir.join("record.json").is_file());
        assert!(dir.join("image.png").is_file());
        assert!(dir.join(super::super::sidecar::SIDECAR_FILE).is_file());

        delete_record(root.path(), "indigo", &record.id).unwrap();

        assert!(!dir.exists(), "record directory removed");
        // The parent ideas dir survives — deleting one capture must not take
        // the company's board with it.
        assert!(ideas_dir(root.path(), "indigo").is_dir());
    }

    #[test]
    fn hq_idea_board_delete_record_missing_id_is_not_found() {
        let root = tempfile::tempdir().unwrap();
        let err = delete_record(root.path(), "indigo", "01J000000000000000000000AA").unwrap_err();
        assert!(
            matches!(err, IdeasError::NotFound { .. }),
            "expected NotFound, got {err:?}"
        );
    }

    #[test]
    fn hq_idea_board_delete_record_validates_path_components() {
        let root = tempfile::tempdir().unwrap();
        for (slug, id) in [
            ("..", "01J000000000000000000000AA"),
            ("indigo", ".."),
            ("indigo", "a/b"),
            ("", "01J000000000000000000000AA"),
        ] {
            let err = delete_record(root.path(), slug, id).unwrap_err();
            assert!(
                matches!(err, IdeasError::Invalid(_)),
                "expected Invalid for ({slug:?}, {id:?}), got {err:?}"
            );
        }
    }
}
