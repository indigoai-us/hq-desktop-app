// companies/indigo/repos/hq-sync/src-tauri/src/util/journal.rs
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::PathBuf;

/// Mirrors packages/hq-cloud/src/types.ts `JournalEntry`.
///
/// Preservation invariant: this Rust mirror is read + rewritten whole whenever
/// the menubar touches a journal. Any field it does NOT model is silently
/// dropped on the round-trip. Historically `remoteEtag` and `mtimeMs` were
/// unmodeled, so every personal-vault write here stripped them from the WHOLE
/// journal — which forced the hq-cloud runner to re-download (no `remoteEtag`)
/// and re-hash (no `mtimeMs`) every personal file on every sync. They are now
/// modeled (so they round-trip), and `extra` flat-captures any field the TS
/// engine adds in the future so this can never silently strip data again.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct JournalEntry {
    pub hash: String, // hex sha256 of file contents
    pub size: u64,
    #[serde(rename = "syncedAt")]
    pub synced_at: String, // ISO-8601
    pub direction: Direction, // "up" | "down"
    /// S3 ETag of the remote object. The pull side compares it to the LIST
    /// ETag to skip unchanged downloads; absent ⇒ forced re-download. Mirror
    /// of TS `remoteEtag?`. Rust never authors it — it only preserves what the
    /// engine wrote.
    #[serde(
        rename = "remoteEtag",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub remote_etag: Option<String>,
    /// Local mtime (ms) captured by the engine at sync time. The push side
    /// skips re-hashing when `size + mtimeMs` match. Mirror of TS `mtimeMs?`.
    /// Rust never authors it (a Node-vs-Rust mtime mismatch would defeat the
    /// fast-path) — it only preserves what the engine wrote.
    #[serde(rename = "mtimeMs", skip_serializing_if = "Option::is_none", default)]
    pub mtime_ms: Option<f64>,
    /// Catch-all for any future `JournalEntry` field the TS engine adds, so a
    /// Rust round-trip never strips data it doesn't model.
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    Up,
    Down,
}

/// Mirrors packages/hq-cloud/src/types.ts `SyncJournal`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SyncJournal {
    pub version: String, // "1"
    #[serde(rename = "lastSync")]
    pub last_sync: String, // ISO-8601 (empty string if never)
    pub files: BTreeMap<String, JournalEntry>,
}

impl Default for SyncJournal {
    fn default() -> Self {
        Self {
            version: "1".into(),
            last_sync: String::new(),
            files: BTreeMap::new(),
        }
    }
}

/// Resolve HQ_STATE_DIR env first; else ~/.hq. Matches `getStateDir()` in
/// packages/hq-cloud/src/journal.ts.
pub fn state_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("HQ_STATE_DIR") {
        return PathBuf::from(dir);
    }
    dirs::home_dir().expect("home dir").join(".hq")
}

/// Lexical `path.resolve`: make `input` absolute against the current
/// directory and fold `.` and `..` without touching the filesystem.
fn resolve_lexically(input: &std::path::Path) -> std::io::Result<PathBuf> {
    use std::path::Component;
    let absolute = if input.is_absolute() {
        input.to_path_buf()
    } else {
        std::env::current_dir()?.join(input)
    };
    let mut out = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    Ok(out)
}

/// Port of hq-cloud's `canonicalProspectivePath`: resolve lexically, then
/// realpath; when the path does not exist yet, canonicalize the nearest
/// existing parent and re-append the missing tail. Errors other than "not
/// found" are returned, as in the cloud.
pub fn canonical_prospective_path(input: &std::path::Path) -> std::io::Result<PathBuf> {
    let absolute = resolve_lexically(input)?;
    canonical_prospective_absolute(&absolute)
}

fn canonical_prospective_absolute(absolute: &std::path::Path) -> std::io::Result<PathBuf> {
    match fs::canonicalize(absolute) {
        Ok(real) => Ok(real),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let (Some(parent), Some(name)) = (absolute.parent(), absolute.file_name()) else {
                return Err(error);
            };
            Ok(canonical_prospective_absolute(parent)?.join(name))
        }
        Err(error) => Err(error),
    }
}

/// The state directory exactly as hq-cloud derives it for personal projection
/// ownership: `realpath(HQ_STATE_DIR ?? ~/.hq)`, prospectively when absent.
pub fn state_dir_canonical() -> std::io::Result<PathBuf> {
    canonical_prospective_path(&state_dir())
}

/// The value passed as `HQ_STATE_DIR` to every child the Desktop spawns, so a
/// symlinked `~/.hq` or a relative override resolves to the same key in the
/// app, the runner, the CLI, and the personal-projection wrapper. Falls back
/// to the uncanonicalized value when canonicalization fails, which is what the
/// child would have inherited anyway.
pub fn state_dir_for_children() -> PathBuf {
    state_dir_canonical().unwrap_or_else(|_| state_dir())
}

/// The `HQ_STATE_DIR` value children must receive, or `None` when they
/// should derive the default themselves.
///
/// With no override, every child (hq-cloud, the hq CLI, the wrapper) already
/// derives `realpath(~/.hq)` itself, so the key matches without passing
/// anything. Passing `HQ_STATE_DIR` in that case is NOT neutral: hq-cloud's
/// `keychainTokenReadEnabled` treats any `HQ_STATE_DIR` as an isolated state
/// directory and stops reading the person session from the macOS Keychain.
/// With an override set for the app, children get its canonical absolute
/// form, so a relative or symlinked value resolves to one key everywhere.
///
/// An empty or blank value counts as unset, matching hq-cloud's Keychain
/// check (`env.HQ_STATE_DIR?.trim()`), so it never turns Keychain reads off.
pub fn state_dir_override_for_children() -> Option<PathBuf> {
    std::env::var_os("HQ_STATE_DIR")
        .filter(|value| !value.to_string_lossy().trim().is_empty())
        .map(|_| state_dir_for_children())
}

/// Pass the app's state directory override to a child explicitly, in its
/// canonical form. A no-op when the app has no override (see above).
pub fn apply_state_dir_env(command: &mut std::process::Command) {
    if let Some(dir) = state_dir_override_for_children() {
        command.env("HQ_STATE_DIR", dir);
    }
}

/// Canonicalize the app's own state directory override once at startup, so
/// children spawned without the shared command builders inherit the same
/// absolute value. Call before any thread is spawned. A no-op without an
/// override.
pub fn pin_state_dir_for_children() {
    if let Some(dir) = state_dir_override_for_children() {
        std::env::set_var("HQ_STATE_DIR", dir);
    }
}

/// True when the state directory lies inside (or is) the given root. Both
/// paths must already be canonical. hq-cloud refuses such a root, so the
/// Desktop refuses it before calling the wrapper.
pub fn root_contains_state_dir(root: &std::path::Path, state_dir: &std::path::Path) -> bool {
    state_dir.starts_with(root)
}

/// Verbatim port of `sanitizeSlug(slug)`:
///   - replace `[^a-zA-Z0-9_-]` with `_`
///   - throw if empty OR result is all `_`/`-`.
pub fn sanitize_slug(slug: &str) -> Result<String, String> {
    if slug.is_empty() {
        return Err("journal: slug is required (empty or undefined)".into());
    }
    let cleaned: String = slug
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if cleaned.is_empty() || cleaned.chars().all(|c| c == '_' || c == '-') {
        return Err(format!(
            "journal: slug \"{slug}\" sanitizes to an empty identifier"
        ));
    }
    Ok(cleaned)
}

pub fn journal_path(slug: &str) -> Result<PathBuf, String> {
    let name = format!("sync-journal.{}.json", sanitize_slug(slug)?);
    Ok(state_dir().join(name))
}

pub fn read_journal(slug: &str) -> Result<SyncJournal, String> {
    let p = journal_path(slug)?;
    if !p.exists() {
        return Ok(SyncJournal::default());
    }
    let s = fs::read_to_string(&p).map_err(|e| format!("{}: {e}", p.display()))?;
    serde_json::from_str(&s).map_err(|e| format!("{}: {e}", p.display()))
}

/// Atomic write via temp file + rename.
pub fn write_journal(slug: &str, journal: &SyncJournal) -> Result<(), String> {
    let p = journal_path(slug)?;
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = p.with_extension("json.tmp");
    let body = serde_json::to_string_pretty(journal).map_err(|e| e.to_string())?;
    let mut f = fs::File::create(&tmp).map_err(|e| e.to_string())?;
    f.write_all(body.as_bytes()).map_err(|e| e.to_string())?;
    f.sync_all().ok();
    fs::rename(&tmp, &p).map_err(|e| e.to_string())
}

// ── Tests ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn with_state_dir<F: FnOnce(&std::path::Path)>(f: F) {
        let _guard = crate::test_support::ENV_MUTEX
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::TempDir::new().unwrap();
        std::env::set_var("HQ_STATE_DIR", tmp.path().to_str().unwrap());
        f(tmp.path());
        std::env::remove_var("HQ_STATE_DIR");
    }

    #[test]
    fn entry_roundtrip_preserves_remote_etag_mtime_and_unknown_fields() {
        // REGRESSION: the menubar reads + rewrites the whole journal. When the
        // struct lacked `remoteEtag`/`mtimeMs`, every write stripped them from
        // ALL entries — forcing the hq-cloud runner to re-download (no etag) and
        // re-hash (no mtime) every personal file on every sync. A round-trip
        // MUST now preserve them, plus any field the TS engine adds later.
        let raw = r#"{
            "hash": "deadbeef",
            "size": 123,
            "syncedAt": "2026-06-17T00:00:00Z",
            "direction": "up",
            "remoteEtag": "\"abc123etag\"",
            "mtimeMs": 1718000000123.5,
            "futureFieldTheEngineMightAdd": {"nested": true}
        }"#;
        let entry: JournalEntry = serde_json::from_str(raw).unwrap();
        assert_eq!(entry.remote_etag.as_deref(), Some("\"abc123etag\""));
        assert_eq!(entry.mtime_ms, Some(1718000000123.5));
        assert!(entry.extra.contains_key("futureFieldTheEngineMightAdd"));

        // Re-serialize and confirm NOTHING was dropped.
        let out = serde_json::to_value(&entry).unwrap();
        assert_eq!(out["remoteEtag"], "\"abc123etag\"");
        assert_eq!(out["mtimeMs"], 1718000000123.5);
        assert_eq!(out["futureFieldTheEngineMightAdd"]["nested"], true);

        // An entry the engine never stamped (legacy) serializes WITHOUT the
        // optional keys — byte-shape parity with the TS engine's output.
        let thin = JournalEntry {
            hash: "x".into(),
            size: 1,
            synced_at: "t".into(),
            direction: Direction::Down,
            remote_etag: None,
            mtime_ms: None,
            extra: BTreeMap::new(),
        };
        let thin_out = serde_json::to_value(&thin).unwrap();
        assert!(thin_out.get("remoteEtag").is_none());
        assert!(thin_out.get("mtimeMs").is_none());
    }

    // (a) sanitize_slug("newco") → Ok("newco")
    #[test]
    fn sanitize_slug_happy_path() {
        assert_eq!(sanitize_slug("newco").unwrap(), "newco");
    }

    // (b) sanitize_slug("") → Err containing "required"
    #[test]
    fn sanitize_slug_empty_err() {
        let err = sanitize_slug("").unwrap_err();
        assert!(err.contains("required"), "expected 'required' in: {err}");
    }

    // (c) sanitize_slug("__") → Err containing "sanitizes to an empty identifier"
    #[test]
    fn sanitize_slug_all_underscores_err() {
        let err = sanitize_slug("__").unwrap_err();
        assert!(
            err.contains("sanitizes to an empty identifier"),
            "got: {err}"
        );
    }

    // (d) sanitize_slug("bad/slug?") → Ok("bad_slug_")
    #[test]
    fn sanitize_slug_replaces_special_chars() {
        assert_eq!(sanitize_slug("bad/slug?").unwrap(), "bad_slug_");
    }

    // (e) journal_path("newco") with HQ_STATE_DIR set ends with sync-journal.newco.json
    #[test]
    fn journal_path_uses_state_dir() {
        with_state_dir(|dir| {
            let p = journal_path("newco").unwrap();
            assert!(
                p.starts_with(dir),
                "expected path under state dir; got {}",
                p.display()
            );
            assert!(
                p.to_string_lossy().ends_with("sync-journal.newco.json"),
                "expected sync-journal.newco.json suffix; got {}",
                p.display()
            );
        });
    }

    // (f) roundtrip: write_journal → read_journal → same SyncJournal
    #[test]
    fn journal_roundtrip() {
        with_state_dir(|_dir| {
            let mut files = BTreeMap::new();
            files.insert(
                "README.md".to_string(),
                JournalEntry {
                    hash: "abc123".into(),
                    size: 42,
                    synced_at: "2026-01-01T00:00:00Z".into(),
                    direction: Direction::Up,
                    remote_etag: None,
                    mtime_ms: None,
                    extra: BTreeMap::new(),
                },
            );
            let original = SyncJournal {
                version: "1".into(),
                last_sync: "2026-01-01T00:00:00Z".into(),
                files,
            };
            write_journal("testslug", &original).unwrap();
            let read_back = read_journal("testslug").unwrap();
            assert_eq!(original, read_back);
        });
    }

    #[cfg(unix)]
    #[test]
    fn state_dir_canonical_resolves_a_symlinked_state_dir_like_hq_cloud() {
        let _guard = crate::test_support::ENV_MUTEX
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::TempDir::new().unwrap();
        let real = tmp.path().join("real-state");
        fs::create_dir_all(&real).unwrap();
        let link = tmp.path().join("link-state");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        std::env::set_var("HQ_STATE_DIR", &link);
        let canonical = state_dir_canonical().unwrap();
        let for_children = state_dir_for_children();
        let mut command = std::process::Command::new("true");
        apply_state_dir_env(&mut command);
        let passed: Vec<_> = command
            .get_envs()
            .filter(|(key, _)| *key == "HQ_STATE_DIR")
            .map(|(_, value)| value.map(PathBuf::from))
            .collect();
        std::env::remove_var("HQ_STATE_DIR");

        let expected = fs::canonicalize(&real).unwrap();
        assert_eq!(canonical, expected);
        assert_eq!(for_children, expected);
        assert_eq!(passed, vec![Some(expected)]);
    }

    #[cfg(unix)]
    #[test]
    fn an_absent_state_dir_is_canonicalized_prospectively_without_creating_it() {
        let tmp = tempfile::TempDir::new().unwrap();
        let real_parent = tmp.path().join("real-parent");
        fs::create_dir_all(&real_parent).unwrap();
        let link_parent = tmp.path().join("link-parent");
        std::os::unix::fs::symlink(&real_parent, &link_parent).unwrap();
        let prospective = link_parent.join("missing").join(".hq");

        let canonical = canonical_prospective_path(&prospective).unwrap();
        assert_eq!(
            canonical,
            fs::canonicalize(&real_parent)
                .unwrap()
                .join("missing")
                .join(".hq")
        );
        assert!(!real_parent.join("missing").exists());
    }

    /// Without an override nothing is passed: children derive the same
    /// default, and hq-cloud keeps reading the Keychain session.
    #[test]
    fn no_override_means_children_derive_the_default_themselves() {
        let _guard = crate::test_support::ENV_MUTEX
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let previous = std::env::var_os("HQ_STATE_DIR");
        std::env::remove_var("HQ_STATE_DIR");
        let mut command = std::process::Command::new("true");
        apply_state_dir_env(&mut command);
        let override_value = state_dir_override_for_children();
        if let Some(value) = previous {
            std::env::set_var("HQ_STATE_DIR", value);
        }
        assert_eq!(override_value, None);
        assert!(command.get_envs().all(|(key, _)| key != "HQ_STATE_DIR"));
    }

    /// Review #10: an empty override is treated as unset.
    #[test]
    fn an_empty_override_is_not_passed_to_children() {
        let _guard = crate::test_support::ENV_MUTEX
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let previous = std::env::var_os("HQ_STATE_DIR");
        let mut results = Vec::new();
        for blank in ["", "   "] {
            std::env::set_var("HQ_STATE_DIR", blank);
            let mut command = std::process::Command::new("true");
            apply_state_dir_env(&mut command);
            results.push((
                state_dir_override_for_children(),
                command.get_envs().any(|(key, _)| key == "HQ_STATE_DIR"),
            ));
        }
        match previous {
            Some(value) => std::env::set_var("HQ_STATE_DIR", value),
            None => std::env::remove_var("HQ_STATE_DIR"),
        }
        assert_eq!(results, vec![(None, false), (None, false)]);
    }

    #[test]
    fn dot_dot_segments_fold_before_canonicalizing() {
        let tmp = tempfile::TempDir::new().unwrap();
        let base = fs::canonicalize(tmp.path()).unwrap();
        let input = base.join("a").join("..").join("b").join(".").join("c");
        assert_eq!(
            canonical_prospective_path(&input).unwrap(),
            base.join("b").join("c")
        );
    }

    #[test]
    fn a_root_that_contains_the_state_dir_is_detected() {
        let root = std::path::Path::new("/Users/me/hq");
        assert!(root_contains_state_dir(root, root));
        assert!(root_contains_state_dir(root, &root.join(".hq")));
        assert!(!root_contains_state_dir(
            root,
            std::path::Path::new("/Users/me/.hq")
        ));
        assert!(!root_contains_state_dir(
            root,
            std::path::Path::new("/Users/me/hq2/.hq")
        ));
    }
}
