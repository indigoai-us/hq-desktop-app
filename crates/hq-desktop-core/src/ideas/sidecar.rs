//! The markdown sidecar (`capture.md`) that makes a capture retrievable
//! through qmd, plus the indexer seam used to refresh the index (US-011).
//!
//! Every record directory carries a third file beside `record.json` and
//! `image.png`:
//!
//! ```text
//! {hq_root}/companies/{slug}/ideas/{id}/capture.md
//! ```
//!
//! The sidecar is YAML frontmatter (the record's provenance and lifecycle
//! fields) followed by a plain-markdown body holding the extracted fields, the
//! note, and the OCR text. Because it is markdown inside `companies/…`, a
//! company's existing qmd collection indexes it with **no collection changes**
//! — the capture becomes searchable by any distinctive phrase its OCR picked
//! up.
//!
//! Two properties the rest of the module depends on:
//!
//! * [`render_sidecar`] is a **pure function of the record** — same record in,
//!   same bytes out. That is what makes [`write_sidecar`] idempotent: a write
//!   whose bytes match what is already on disk does not touch the file at all
//!   (no mtime churn, so a sync watcher sees no spurious change).
//! * The image binary is never part of the sidecar. Only text derived from the
//!   record is rendered, so `capture.md` stays small and diff-friendly.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::record::{CaptureKind, CaptureRecord, CaptureStatus, IdeasError, Provenance};
use super::storage::{atomic_write, record_dir};

/// Filename of the qmd-indexable sidecar inside a record directory.
pub const SIDECAR_FILE: &str = "capture.md";

/// Log tag for indexing lines. Never carries record text — ids only.
pub const INDEX_LOG_TAG: &str = "ideas.index";

/// `{hq_root}/companies/{slug}/ideas/{id}/capture.md`
///
/// Pure path construction; callers that touch the filesystem go through
/// [`super::storage`], which screens the components first.
pub fn sidecar_path(hq_root: &Path, company_slug: &str, id: &str) -> PathBuf {
    record_dir(hq_root, company_slug, id).join(SIDECAR_FILE)
}

/// The YAML frontmatter block of a sidecar.
///
/// A flattened projection of [`CaptureRecord`] — deliberately *not* the record
/// itself, so the indexed surface stays a stable, documented contract even if
/// the record grows internal fields. `source_url` is a top-level mirror of
/// `provenance.url` because that is the field a search result wants to link.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SidecarFrontmatter {
    pub id: String,
    pub kind: CaptureKind,
    pub status: CaptureStatus,
    #[serde(default)]
    pub confidence: Option<f32>,
    pub company: String,
    #[serde(default)]
    pub tags: Vec<String>,
    pub captured_at: DateTime<Utc>,
    pub provenance: Provenance,
    #[serde(default)]
    pub source_url: Option<String>,
    #[serde(default)]
    pub cited_count: u32,
    pub image_path: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl SidecarFrontmatter {
    /// Project a record onto the indexed frontmatter contract.
    pub fn of(record: &CaptureRecord) -> Self {
        SidecarFrontmatter {
            id: record.id.clone(),
            kind: record.kind,
            status: record.status,
            confidence: record.confidence,
            company: record.company_slug.clone(),
            tags: record.tags.clone(),
            captured_at: record.provenance.captured_at,
            source_url: record.provenance.url.clone(),
            provenance: record.provenance.clone(),
            cited_count: record.cited_count,
            image_path: record.image_path.clone(),
            created_at: record.created_at,
            updated_at: record.updated_at,
        }
    }
}

/// The trailing citation line. `×` is U+00D7, matching the board's label.
fn cited_line(count: u32) -> String {
    format!("Cited {count}× by agents")
}

/// Render a record as sidecar markdown.
///
/// Deterministic: the output depends only on `record`, never on the clock, the
/// filesystem, or iteration order (`extracted` is a `serde_json::Value`, whose
/// map preserves insertion/parse order under the `preserve_order` feature and
/// is sorted otherwise — either way it is a property of the record's own
/// bytes, not of this call).
///
/// The OCR text is emitted as **plain prose, not a fenced code block**: BM25
/// tokenizes plain text normally, and fencing it would bury the one thing a
/// search is most likely to match on.
pub fn render_sidecar(record: &CaptureRecord) -> Result<String, IdeasError> {
    let frontmatter = serde_yaml::to_string(&SidecarFrontmatter::of(record))?;
    let mut out = String::with_capacity(frontmatter.len() + 512);
    out.push_str("---\n");
    out.push_str(&frontmatter);
    if !frontmatter.ends_with('\n') {
        out.push('\n');
    }
    out.push_str("---\n\n");

    out.push_str(&format!("# Capture {}\n", record.id));

    if let Some(serde_json::Value::Object(fields)) = &record.extracted {
        if !fields.is_empty() {
            out.push_str("\n## Extracted\n\n");
            for (key, value) in fields {
                // Strings verbatim (no JSON quoting/escaping in the indexed
                // body); everything else through its JSON spelling.
                let rendered = match value {
                    serde_json::Value::String(s) => s.clone(),
                    other => other.to_string(),
                };
                out.push_str(&format!("- **{key}**: {rendered}\n"));
            }
        }
    }

    if let Some(note) = record.note.as_ref().filter(|n| !n.trim().is_empty()) {
        out.push_str("\n## Note\n\n");
        out.push_str(note);
        out.push('\n');
    }

    if let Some(text) = record.ocr_text.as_ref().filter(|t| !t.trim().is_empty()) {
        out.push_str("\n## OCR text\n\n");
        out.push_str(text);
        if !text.ends_with('\n') {
            out.push('\n');
        }
    }

    out.push('\n');
    out.push_str(&cited_line(record.cited_count));
    out.push('\n');
    Ok(out)
}

/// Parse the frontmatter back out of sidecar markdown.
///
/// Used by tests and by any consumer that wants the indexed contract without
/// reading `record.json` (a search hit hands back the `.md` path, not the
/// record).
pub fn parse_sidecar_frontmatter(markdown: &str) -> Result<SidecarFrontmatter, IdeasError> {
    let rest = markdown.strip_prefix("---\n").ok_or_else(|| {
        IdeasError::Invalid("sidecar does not start with a YAML frontmatter fence".into())
    })?;
    let end = rest.find("\n---\n").ok_or_else(|| {
        IdeasError::Invalid("sidecar frontmatter is not terminated by a closing fence".into())
    })?;
    Ok(serde_yaml::from_str(&rest[..end])?)
}

/// Write (or refresh) `capture.md` in `dir`.
///
/// Idempotent by content: if the file already holds exactly these bytes the
/// function returns without opening it for writing, so repeated saves of an
/// unchanged record leave mtime and inode alone.
pub fn write_sidecar(dir: &Path, record: &CaptureRecord) -> Result<(), IdeasError> {
    let rendered = render_sidecar(record)?;
    let target = dir.join(SIDECAR_FILE);
    if let Ok(existing) = std::fs::read(&target) {
        if existing == rendered.as_bytes() {
            return Ok(());
        }
    }
    atomic_write(&target, rendered.as_bytes())
}

// ── qmd indexing seam ─────────────────────────────────────────────────────────

/// Whatever refreshes the search index after a sidecar is written.
///
/// A trait rather than a direct `qmd` spawn so the capture path can be tested
/// without a real binary on PATH (and so a future in-process indexer drops in
/// without touching callers).
pub trait QmdIndexer: Send + Sync {
    fn update(&self) -> Result<(), IdeasError>;
}

/// The real indexer: the `qmd` CLI.
pub struct QmdCli {
    program: PathBuf,
}

impl QmdCli {
    /// Wrap an explicit `qmd` binary path.
    pub fn new(program: impl Into<PathBuf>) -> Self {
        QmdCli {
            program: program.into(),
        }
    }

    /// The resolved program path.
    pub fn program(&self) -> &Path {
        &self.program
    }

    /// Find `qmd` on `PATH`.
    ///
    /// Hand-rolled rather than pulling in a `which` crate: the lookup is one
    /// `PATH` split and an executable-bit check, and the capture path should
    /// not grow a dependency for it. Returns `None` when qmd is not installed,
    /// which is a normal, non-error state — indexing is best-effort.
    pub fn detect() -> Option<QmdCli> {
        let path = std::env::var_os("PATH")?;
        std::env::split_paths(&path)
            .map(|dir| dir.join("qmd"))
            .find(|candidate| is_executable_file(candidate))
            .map(QmdCli::new)
    }

    /// The argument vector this indexer runs, so a test can pin the invocation
    /// without spawning anything.
    pub fn command_args(&self) -> Vec<String> {
        vec!["update".to_string()]
    }
}

#[cfg(unix)]
fn is_executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable_file(path: &Path) -> bool {
    path.is_file()
}

impl QmdIndexer for QmdCli {
    fn update(&self) -> Result<(), IdeasError> {
        let status = Command::new(&self.program)
            .args(self.command_args())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|e| IdeasError::io(&self.program, e))?;
        if !status.success() {
            return Err(IdeasError::Index(format!(
                "qmd update exited with {status}"
            )));
        }
        Ok(())
    }
}

/// Refresh the index after a sidecar write **or a record deletion**, best
/// effort.
///
/// `qmd update` rescans the collection rather than applying a delta, so a
/// sidecar whose file no longer exists is pruned from the index by the same
/// call that picks up new and revised ones. Deletion (US-010) therefore needs
/// no separate "remove from index" path — it deletes the directory and calls
/// this.
///
/// Logs the record id and the outcome only. Record text (OCR, extracted
/// fields, note) is never logged — the log is not a capture store.
pub fn reindex_after_write(indexer: &dyn QmdIndexer, id: &str) {
    match indexer.update() {
        Ok(()) => crate::logfile::log(INDEX_LOG_TAG, &format!("qmd update ok record={id}")),
        Err(e) => crate::logfile::log(
            INDEX_LOG_TAG,
            &format!("qmd update FAILED record={id}: {e}"),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ideas::record::ExtractionSource;
    use chrono::TimeZone;

    fn ts() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 9, 10, 12, 0, 0).unwrap()
    }

    pub(crate) fn sample_record() -> CaptureRecord {
        CaptureRecord {
            id: "01J000000000000000000000AA".to_string(),
            company_slug: "indigo".to_string(),
            kind: CaptureKind::XPost,
            status: CaptureStatus::Extracted,
            confidence: Some(0.81),
            image_path: CaptureRecord::relative_image_path(
                "indigo",
                "01J000000000000000000000AA",
            ),
            ocr_text: Some("zebra quartz manifold\nsecond line".to_string()),
            extracted: Some(serde_json::json!({
                "author": "@someone",
                "title": "A thought",
                "likes": 12
            })),
            tags: vec!["design".to_string()],
            extraction_source: Some(ExtractionSource::Local),
            provenance: Provenance {
                app: "Safari".to_string(),
                window_title: "X".to_string(),
                url: Some("https://x.com/someone/status/1".to_string()),
                captured_at: ts(),
                display_id: 1,
            },
            note: Some("worth revisiting".to_string()),
            cited_count: 0,
            created_at: ts(),
            updated_at: ts(),
        }
    }

    #[test]
    fn hq_idea_board_render_sidecar_is_deterministic() {
        let record = sample_record();
        let a = render_sidecar(&record).unwrap();
        let b = render_sidecar(&record).unwrap();
        assert_eq!(a, b);
        assert!(a.starts_with("---\n"), "{a}");
        assert!(a.contains("# Capture 01J000000000000000000000AA"), "{a}");
        assert!(a.contains("## OCR text"), "{a}");
        assert!(a.contains("zebra quartz manifold"), "{a}");
        assert!(a.contains("- **author**: @someone"), "{a}");
        // Strings are rendered verbatim, without JSON quoting.
        assert!(!a.contains("\"@someone\""), "{a}");
        assert!(a.contains("- **likes**: 12"), "{a}");
        assert!(a.contains("## Note\n\nworth revisiting"), "{a}");
        assert!(a.trim_end().ends_with("Cited 0× by agents"), "{a}");
        // OCR text must not be fenced — BM25 should tokenize it as prose.
        assert!(!a.contains("```"), "{a}");
    }

    #[test]
    fn hq_idea_board_sidecar_frontmatter_round_trips() {
        let record = sample_record();
        let markdown = render_sidecar(&record).unwrap();
        let fm = parse_sidecar_frontmatter(&markdown).unwrap();

        assert_eq!(fm.id, record.id);
        assert_eq!(fm.kind, record.kind);
        assert_eq!(fm.status, record.status);
        assert_eq!(fm.confidence, record.confidence);
        assert_eq!(fm.company, record.company_slug);
        assert_eq!(fm.tags, record.tags);
        assert_eq!(fm.captured_at, record.provenance.captured_at);
        assert_eq!(fm.provenance, record.provenance);
        assert_eq!(fm.source_url, record.provenance.url);
        assert_eq!(fm.cited_count, record.cited_count);
        assert_eq!(fm.image_path, record.image_path);
        assert_eq!(fm.created_at, record.created_at);
        assert_eq!(fm.updated_at, record.updated_at);
    }

    #[test]
    fn hq_idea_board_sidecar_omits_empty_sections() {
        let mut record = sample_record();
        record.extracted = Some(serde_json::json!({}));
        record.note = None;
        record.ocr_text = None;
        let markdown = render_sidecar(&record).unwrap();
        assert!(!markdown.contains("## Extracted"), "{markdown}");
        assert!(!markdown.contains("## Note"), "{markdown}");
        assert!(!markdown.contains("## OCR text"), "{markdown}");
        assert!(markdown.contains("Cited 0× by agents"), "{markdown}");
    }

    #[test]
    fn hq_idea_board_parse_sidecar_frontmatter_rejects_unfenced_input() {
        assert!(matches!(
            parse_sidecar_frontmatter("# not a sidecar\n"),
            Err(IdeasError::Invalid(_))
        ));
        assert!(matches!(
            parse_sidecar_frontmatter("---\nid: x\n"),
            Err(IdeasError::Invalid(_))
        ));
    }

    #[test]
    fn hq_idea_board_write_sidecar_second_write_is_a_no_op() {
        let dir = tempfile::tempdir().unwrap();
        let record = sample_record();

        write_sidecar(dir.path(), &record).unwrap();
        let target = dir.path().join(SIDECAR_FILE);
        let first_bytes = std::fs::read(&target).unwrap();
        let first_meta = std::fs::metadata(&target).unwrap();

        // Enough separation that a same-content rewrite would show a different
        // mtime on any filesystem with sub-second resolution.
        std::thread::sleep(std::time::Duration::from_millis(20));
        write_sidecar(dir.path(), &record).unwrap();
        let second_bytes = std::fs::read(&target).unwrap();
        let second_meta = std::fs::metadata(&target).unwrap();

        assert_eq!(first_bytes, second_bytes);
        assert_eq!(
            first_meta.modified().unwrap(),
            second_meta.modified().unwrap(),
            "an unchanged record must not rewrite capture.md"
        );

        // A changed record does rewrite it.
        let mut changed = record.clone();
        changed.cited_count = 4;
        write_sidecar(dir.path(), &changed).unwrap();
        let changed_bytes = std::fs::read(&target).unwrap();
        assert_ne!(first_bytes, changed_bytes);
        assert!(String::from_utf8(changed_bytes)
            .unwrap()
            .contains("Cited 4× by agents"));
    }

    #[test]
    fn hq_idea_board_qmd_cli_pins_its_invocation() {
        let cli = QmdCli::new("/usr/local/bin/qmd");
        assert_eq!(cli.command_args(), vec!["update".to_string()]);
        assert_eq!(cli.program(), Path::new("/usr/local/bin/qmd"));
    }

    #[test]
    fn hq_idea_board_qmd_detect_finds_an_executable_on_path() {
        let dir = tempfile::tempdir().unwrap();
        let fake = dir.path().join("qmd");
        std::fs::write(&fake, "#!/bin/sh\nexit 0\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        }

        // Isolated PATH containing only the temp dir. Serialized implicitly by
        // being the only test that touches PATH.
        let previous = std::env::var_os("PATH");
        std::env::set_var("PATH", dir.path());
        let detected = QmdCli::detect();
        match previous {
            Some(p) => std::env::set_var("PATH", p),
            None => std::env::remove_var("PATH"),
        }

        let detected = detected.expect("qmd on PATH should be detected");
        assert_eq!(detected.program(), fake.as_path());
    }

    /// Stand-in for `qmd update` + `qmd search`: on `update` it walks a
    /// collection root for `**/*.md` and remembers their contents, so a test
    /// can assert a capture became findable by an OCR phrase without spawning
    /// the real binary.
    pub(crate) struct FakeQmd {
        root: PathBuf,
        index: std::sync::Mutex<Vec<(PathBuf, String)>>,
    }

    impl FakeQmd {
        pub(crate) fn new(root: impl Into<PathBuf>) -> Self {
            FakeQmd {
                root: root.into(),
                index: std::sync::Mutex::new(Vec::new()),
            }
        }

        /// Paths whose indexed text contains `phrase`.
        pub(crate) fn search(&self, phrase: &str) -> Vec<PathBuf> {
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
            let mut paths: Vec<_> = entries.filter_map(|e| e.ok().map(|e| e.path())).collect();
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
            let mut found = Vec::new();
            FakeQmd::walk(&self.root, &mut found);
            *self.index.lock().unwrap() = found;
            Ok(())
        }
    }

    #[test]
    fn hq_idea_board_fake_indexer_finds_a_capture_by_its_ocr_phrase() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("companies/indigo/ideas/01J000000000000000000000AA");
        std::fs::create_dir_all(&dir).unwrap();
        // A decoy capture that must NOT match the phrase.
        let other_dir = root.path().join("companies/indigo/ideas/01J000000000000000000000BB");
        std::fs::create_dir_all(&other_dir).unwrap();
        let mut other = sample_record();
        other.id = "01J000000000000000000000BB".to_string();
        other.ocr_text = Some("unrelated text".to_string());
        write_sidecar(&other_dir, &other).unwrap();
        write_sidecar(&dir, &sample_record()).unwrap();

        let fake = FakeQmd::new(root.path());
        reindex_after_write(&fake, "01J000000000000000000000AA");

        let hits = fake.search("zebra quartz manifold");
        assert_eq!(hits, vec![dir.join(SIDECAR_FILE)], "{hits:?}");
    }

    #[test]
    fn hq_idea_board_reindex_failure_is_swallowed() {
        struct Boom;
        impl QmdIndexer for Boom {
            fn update(&self) -> Result<(), IdeasError> {
                Err(IdeasError::Index("nope".into()))
            }
        }
        // The point of the test: a failing indexer must not panic or unwind
        // into the capture path.
        reindex_after_write(&Boom, "01J000000000000000000000AA");
    }
}
