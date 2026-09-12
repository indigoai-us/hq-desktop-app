//! Idea Board user preferences (US-012): the pure resolution layer behind the
//! Ideas settings panel.
//!
//! Everything here is a **user preference**, not a feature flag (policy
//! `indigo-a-user-preference-is-not-a-feature-flag`). Nothing in this module
//! enables anything on a user's behalf; the one genuinely off-by-default
//! choice — model extraction — lives in [`crate::ideas::parse_mode`] and stays
//! opt-in there.
//!
//! The module is deliberately tauri-free so every rule is unit-testable:
//! chords are modelled as strings plus a small [`ChordSpec`], and the
//! host-side mapping to `tauri_plugin_global_shortcut::Shortcut` lives in the
//! app.

use std::path::{Path, PathBuf};

use super::record::{validate_path_component, IdeasError};
pub use crate::ignore::{LOCAL_ONLY_IDEAS_DIR as LOCAL_ONLY_DIR, LOCAL_ONLY_PARENT_DIR};

/// Maximum image edge applied when a capture is written, in pixels.
pub const DEFAULT_IMAGE_MAX_EDGE: u32 = 2000;

/// The only maximum-edge values the settings panel offers. Retention is
/// downsample-on-write; nothing is ever auto-deleted.
pub const IMAGE_MAX_EDGE_CHOICES: [u32; 3] = [1200, 2000, 4000];

/// Canonical default capture chord — ⌥⇧C.
pub const DEFAULT_CAPTURE_CHORD: &str = "Alt+Shift+KeyC";

// The local-only capture root is `{hq_root}/workspace/ideas-local/{company}`.
// Both segments come from `crate::ignore` (re-exported above as
// `LOCAL_ONLY_DIR` / `LOCAL_ONLY_PARENT_DIR`), which is also where the sync
// exclusion for that exact prefix lives. What the code guarantees, precisely:
// `IgnoreFilter::for_hq_root(root)` refuses to sync anything under
// `/workspace/ideas-local/`, because `DEFAULT_IGNORES` carries a root-anchored
// entry for it. That — not the HQ root .gitignore, which sync deliberately
// does not consult — is what makes "Sync off" mean a capture never leaves the
// machine. The pairing is asserted end-to-end in
// `local_only_root_is_excluded_from_vault_sync` below.

/// Honor only the three offered choices; anything else resolves to the
/// default. An out-of-range value on disk must not silently become a 12000px
/// vault-filling policy.
pub fn resolve_image_max_edge(raw: Option<u32>) -> u32 {
    match raw {
        Some(value) if IMAGE_MAX_EDGE_CHOICES.contains(&value) => value,
        _ => DEFAULT_IMAGE_MAX_EDGE,
    }
}

/// Captures sync to the company vault unless the user turned it off.
pub fn sync_enabled(raw: Option<bool>) -> bool {
    raw.unwrap_or(true)
}

/// A stored default company wins; absent, blank, or *unsafe as a path
/// component* falls back to the active company.
///
/// `ideasDefaultCompany` is free-form: it is written through the untyped
/// settings patch and read back out of a menubar.json that can be hand-edited
/// or arrive over sync. A slug becomes a path segment in [`ideas_root`], so a
/// value like `"../../../../tmp/pwn"` must never propagate — it would escape
/// the HQ root entirely and quietly defeat the local-only badge. Screened with
/// the same `validate_path_component` every storage entry point uses.
pub fn resolve_company(stored: Option<&str>, active: &str) -> String {
    match stored.map(str::trim) {
        Some(slug) if !slug.is_empty() && validate_path_component("company", slug).is_ok() => {
            slug.to_string()
        }
        _ => active.to_string(),
    }
}

/// A parsed global chord: modifier set plus exactly one `Code`-style key name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChordSpec {
    pub alt: bool,
    pub shift: bool,
    pub ctrl: bool,
    pub meta: bool,
    /// A `Code`-style key name: `KeyA`..`KeyZ`, `Digit0`..`Digit9`, `F1`..`F12`.
    pub code: String,
}

impl ChordSpec {
    fn has_modifier(&self) -> bool {
        self.alt || self.shift || self.ctrl || self.meta
    }
}

/// Normalize a single key token into its canonical `Code` spelling, or `None`
/// when it is not a key we accept for a global chord.
fn normalize_code(token: &str) -> Option<String> {
    let upper = token.to_ascii_uppercase();
    // KeyA..KeyZ (also accept a bare letter, e.g. "C").
    if let Some(rest) = upper.strip_prefix("KEY") {
        let mut chars = rest.chars();
        if let (Some(c), None) = (chars.next(), chars.next()) {
            if c.is_ascii_alphabetic() {
                return Some(format!("Key{c}"));
            }
        }
        return None;
    }
    if let Some(rest) = upper.strip_prefix("DIGIT") {
        let mut chars = rest.chars();
        if let (Some(c), None) = (chars.next(), chars.next()) {
            if c.is_ascii_digit() {
                return Some(format!("Digit{c}"));
            }
        }
        return None;
    }
    if let Some(rest) = upper.strip_prefix('F') {
        if !rest.is_empty() && rest.chars().all(|c| c.is_ascii_digit()) {
            if let Ok(n) = rest.parse::<u8>() {
                if (1..=12).contains(&n) {
                    return Some(format!("F{n}"));
                }
            }
        }
        return None;
    }
    let mut chars = upper.chars();
    match (chars.next(), chars.next()) {
        (Some(c), None) if c.is_ascii_alphabetic() => Some(format!("Key{c}")),
        (Some(c), None) if c.is_ascii_digit() => Some(format!("Digit{c}")),
        _ => None,
    }
}

/// Parse a chord written as `+`-separated tokens, case-insensitively.
///
/// Accepted modifier spellings: `Alt`/`Opt`/`Option`, `Shift`,
/// `Ctrl`/`Control`, `Cmd`/`Meta`/`Super`. Exactly one key token is required,
/// and at least one modifier — a bare key is not a safe global chord.
pub fn parse_chord(raw: &str) -> Result<ChordSpec, String> {
    let mut spec = ChordSpec {
        alt: false,
        shift: false,
        ctrl: false,
        meta: false,
        code: String::new(),
    };
    let mut key: Option<String> = None;

    let tokens: Vec<&str> = raw
        .split('+')
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .collect();
    if tokens.is_empty() {
        return Err("Enter a chord, for example Alt+Shift+KeyC.".to_string());
    }

    for token in tokens {
        match token.to_ascii_lowercase().as_str() {
            "alt" | "opt" | "option" | "⌥" => spec.alt = true,
            "shift" | "⇧" => spec.shift = true,
            "ctrl" | "control" | "⌃" => spec.ctrl = true,
            "cmd" | "command" | "meta" | "super" | "⌘" => spec.meta = true,
            _ => match normalize_code(token) {
                Some(code) => {
                    if let Some(existing) = &key {
                        return Err(format!(
                            "A chord can only have one key — found {existing} and {code}."
                        ));
                    }
                    key = Some(code);
                }
                None => {
                    return Err(format!(
                        "{token:?} isn't a key this chord can use. Use a letter, a digit, or F1-F12."
                    ))
                }
            },
        }
    }

    spec.code = key.ok_or_else(|| "That chord has no key — add a letter, a digit, or F1-F12.".to_string())?;
    if !spec.has_modifier() {
        return Err(
            "A global chord needs at least one modifier (Control, Option, Shift, or Command)."
                .to_string(),
        );
    }
    Ok(spec)
}

/// Canonical storage form: `Ctrl+Alt+Shift+Meta+KeyC`, modifiers in a fixed
/// order so the same chord always round-trips to the same string.
pub fn format_chord(spec: &ChordSpec) -> String {
    let mut parts: Vec<&str> = Vec::new();
    if spec.ctrl {
        parts.push("Ctrl");
    }
    if spec.alt {
        parts.push("Alt");
    }
    if spec.shift {
        parts.push("Shift");
    }
    if spec.meta {
        parts.push("Meta");
    }
    let mut out = parts.join("+");
    if !out.is_empty() {
        out.push('+');
    }
    out.push_str(&spec.code);
    out
}

/// Mac-style display form: `⌥⇧C`. Char-based throughout — never byte-slice a
/// string that can carry multi-byte modifier symbols.
pub fn chord_display(spec: &ChordSpec) -> String {
    let mut out = String::new();
    if spec.ctrl {
        out.push('⌃');
    }
    if spec.alt {
        out.push('⌥');
    }
    if spec.shift {
        out.push('⇧');
    }
    if spec.meta {
        out.push('⌘');
    }
    out.push_str(&display_key(&spec.code));
    out
}

/// The bare key label: `KeyC` → `C`, `Digit4` → `4`, `F7` → `F7`.
fn display_key(code: &str) -> String {
    if let Some(rest) = code.strip_prefix("Key") {
        return rest.to_string();
    }
    if let Some(rest) = code.strip_prefix("Digit") {
        return rest.to_string();
    }
    code.to_string()
}

/// Stored chord when it parses, otherwise the default ⌥⇧C. A garbled value on
/// disk must never leave the app with no capture chord at all.
pub fn resolve_capture_chord(raw: Option<&str>) -> ChordSpec {
    raw.and_then(|value| parse_chord(value).ok())
        .unwrap_or_else(|| {
            parse_chord(DEFAULT_CAPTURE_CHORD).expect("DEFAULT_CAPTURE_CHORD parses")
        })
}

/// The HQ-root-**relative** capture root for `company` under `sync_enabled`.
///
/// Synced → `companies/{company}/ideas`. Local-only →
/// `workspace/ideas-local/{company}`, which `crate::ignore` excludes from
/// vault sync.
///
/// This is the single place the two layouts are spelled out. Both
/// [`ideas_root`] (absolute) and
/// [`crate::ideas::record::CaptureRecord::relative_image_path_for`] (stored in
/// the record) derive from it, so a record's `image_path` and the directory it
/// was written to can never describe different roots.
///
/// Fallible because `company` becomes a path segment: this is a public entry
/// point that joins, and this module's contract (see `storage.rs`) is that
/// every such entry point screens its components *before* the join. Both
/// branches validate — the local-only branch just as much as the synced one,
/// since a traversing slug there escapes the HQ root AND makes
/// [`is_local_only_root`] report `false`, silently dropping the badge that
/// tells the user their captures are staying put.
pub fn ideas_root_relative(company: &str, sync_enabled: bool) -> Result<String, IdeasError> {
    // Whitespace-only is not a separator or a traversal, so the shared
    // validator lets it through — but as a directory name it is invisible and
    // unreachable, and nothing upstream should ever produce one. Reject it
    // here rather than loosening the shared validator that storage relies on.
    if company.trim().is_empty() {
        return Err(IdeasError::Invalid("company must not be empty".to_string()));
    }
    validate_path_component("company", company)?;
    Ok(if sync_enabled {
        format!("companies/{company}/ideas")
    } else {
        format!("{LOCAL_ONLY_PARENT_DIR}/{LOCAL_ONLY_DIR}/{company}")
    })
}

/// Where captures for `company` live under `sync_enabled`.
///
/// Synced → `{hq_root}/companies/{company}/ideas`, byte-identical to
/// [`crate::ideas::storage::ideas_dir`]. Local-only →
/// `{hq_root}/workspace/ideas-local/{company}`, which `crate::ignore` excludes
/// from vault sync.
///
/// This *does* decide where captures are written: the capture write path
/// resolves the user's sync preference through
/// [`crate::ideas::storage::create_record`], which builds its target from this
/// function. With sync off a capture is written under the local-only root and
/// is never uploaded.
///
/// Fallible for the reason given on [`ideas_root_relative`], which it delegates
/// its validation to.
pub fn ideas_root(hq_root: &Path, company: &str, sync_enabled: bool) -> Result<PathBuf, IdeasError> {
    Ok(hq_root.join(ideas_root_relative(company, sync_enabled)?))
}

/// True when `path` sits under the local-only root — the board header badge
/// and the "local only" note key off this rather than re-deriving the layout.
///
/// Reports where a path *is*. With sync off the capture write path now writes
/// under that root, so for a stored `image_path` this is also a true statement
/// that the capture never entered the vault sync scope.
pub fn is_local_only_root(path: &Path) -> bool {
    // Normalize first: a `..` segment or a symlinked HQ root would otherwise
    // let a path that does NOT resolve into the local-only tree still show the
    // "local only" badge, or (worse) hide it for one that does. Canonicalize
    // when the path exists on disk; fall back to lexical `..`/`.` folding when
    // it does not (the common case — the root is derived, not yet created).
    let resolved = std::fs::canonicalize(path).unwrap_or_else(|_| lexically_normalize(path));
    let mut previous: Option<String> = None;
    for component in resolved.components().map(|c| c.as_os_str().to_string_lossy()) {
        if component == LOCAL_ONLY_DIR && previous.as_deref() == Some(LOCAL_ONLY_PARENT_DIR) {
            return true;
        }
        previous = Some(component.into_owned());
    }
    false
}

/// Fold `.` away and resolve `..` against the preceding normal component,
/// without touching the filesystem. A leading `..` that cannot be folded is
/// kept, so the result never silently climbs above what the caller wrote.
fn lexically_normalize(path: &Path) -> PathBuf {
    use std::path::Component;
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                let popped = out
                    .components()
                    .next_back()
                    .is_some_and(|c| matches!(c, Component::Normal(_)));
                if popped {
                    out.pop();
                } else {
                    out.push("..");
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn image_max_edge_honors_only_the_offered_choices() {
        assert_eq!(resolve_image_max_edge(Some(1200)), 1200);
        assert_eq!(resolve_image_max_edge(Some(2000)), 2000);
        assert_eq!(resolve_image_max_edge(Some(4000)), 4000);
        assert_eq!(resolve_image_max_edge(None), DEFAULT_IMAGE_MAX_EDGE);
        assert_eq!(resolve_image_max_edge(Some(0)), DEFAULT_IMAGE_MAX_EDGE);
        assert_eq!(resolve_image_max_edge(Some(1)), DEFAULT_IMAGE_MAX_EDGE);
        assert_eq!(resolve_image_max_edge(Some(3000)), DEFAULT_IMAGE_MAX_EDGE);
        assert_eq!(resolve_image_max_edge(Some(u32::MAX)), DEFAULT_IMAGE_MAX_EDGE);
    }

    #[test]
    fn sync_defaults_on_and_an_explicit_false_is_preserved() {
        assert!(sync_enabled(None));
        assert!(sync_enabled(Some(true)));
        assert!(!sync_enabled(Some(false)));
    }

    #[test]
    fn company_falls_back_to_active_for_absent_or_blank() {
        assert_eq!(resolve_company(None, "indigo"), "indigo");
        assert_eq!(resolve_company(Some(""), "indigo"), "indigo");
        assert_eq!(resolve_company(Some("   "), "indigo"), "indigo");
        assert_eq!(resolve_company(Some("\t\n"), "indigo"), "indigo");
        assert_eq!(resolve_company(Some("liverecover"), "indigo"), "liverecover");
        assert_eq!(resolve_company(Some(" liverecover "), "indigo"), "liverecover");
    }

    #[test]
    fn hq_idea_board_us_012_a_traversing_stored_company_falls_back_to_active() {
        // REGRESSION: `ideasDefaultCompany` is free-form and reaches us from a
        // hand-edited or synced menubar.json. Propagating one of these would
        // put a traversal segment into `ideas_root`.
        for hostile in [
            "..",
            ".",
            "../../../../../../tmp/pwn",
            "/etc",
            "foo/bar",
            "foo\\bar",
            "a\0b",
        ] {
            assert_eq!(
                resolve_company(Some(hostile), "indigo"),
                "indigo",
                "{hostile:?} must not become the default company"
            );
        }
    }

    #[test]
    fn hq_idea_board_us_012_ideas_root_rejects_every_unsafe_company_component() {
        let root = Path::new("/tmp/HQ");
        for hostile in [
            "",
            "   ",
            "\t",
            ".",
            "..",
            "../../../../../../tmp/pwn",
            "companies/other",
            "back\\slash",
            "nul\0byte",
            "/absolute",
        ] {
            for synced in [true, false] {
                let result = ideas_root(root, hostile, synced);
                assert!(
                    matches!(result, Err(IdeasError::Invalid(_))),
                    "ideas_root({hostile:?}, sync={synced}) must be rejected, got {result:?}"
                );
            }
        }
        // And a legitimate slug still resolves on both branches.
        assert!(ideas_root(root, "indigo", true).is_ok());
        assert!(ideas_root(root, "indigo", false).is_ok());
    }

    #[test]
    fn hq_idea_board_us_012_local_only_badge_survives_dot_dot_and_symlinks() {
        // A `..` segment must not be able to make a path that resolves INTO the
        // local-only tree look like it doesn't (or vice versa).
        let root = Path::new("/tmp/HQ");
        let sneaky = root
            .join(LOCAL_ONLY_PARENT_DIR)
            .join("other")
            .join("..")
            .join(LOCAL_ONLY_DIR)
            .join("indigo");
        assert!(is_local_only_root(&sneaky), "{sneaky:?}");
        let escaped = root
            .join(LOCAL_ONLY_PARENT_DIR)
            .join(LOCAL_ONLY_DIR)
            .join("..")
            .join("..")
            .join("companies")
            .join("indigo")
            .join("ideas");
        assert!(!is_local_only_root(&escaped), "{escaped:?}");
    }

    #[test]
    fn parses_the_default_chord_and_round_trips_it() {
        let spec = parse_chord(DEFAULT_CAPTURE_CHORD).expect("default parses");
        assert_eq!(
            spec,
            ChordSpec {
                alt: true,
                shift: true,
                ctrl: false,
                meta: false,
                code: "KeyC".to_string()
            }
        );
        assert_eq!(format_chord(&spec), DEFAULT_CAPTURE_CHORD);
        assert_eq!(chord_display(&spec), "⌥⇧C");
    }

    #[test]
    fn accepts_alternate_modifier_spellings_case_insensitively() {
        let a = parse_chord("opt+shift+c").expect("lowercase opt");
        let b = parse_chord("OPTION + SHIFT + KeyC").expect("spaced option");
        let c = parse_chord("⌥+⇧+C").expect("symbols");
        assert_eq!(format_chord(&a), DEFAULT_CAPTURE_CHORD);
        assert_eq!(format_chord(&b), DEFAULT_CAPTURE_CHORD);
        assert_eq!(format_chord(&c), DEFAULT_CAPTURE_CHORD);

        let cmd = parse_chord("Cmd+Ctrl+Digit4").expect("cmd+ctrl+digit");
        assert_eq!(format_chord(&cmd), "Ctrl+Meta+Digit4");
        assert_eq!(chord_display(&cmd), "⌃⌘4");

        let f = parse_chord("control+f12").expect("function key");
        assert_eq!(format_chord(&f), "Ctrl+F12");
        assert_eq!(chord_display(&f), "⌃F12");
    }

    #[test]
    fn rejects_chords_that_are_not_usable_globally() {
        // No modifier.
        assert!(parse_chord("KeyC").unwrap_err().contains("modifier"));
        assert!(parse_chord("c").unwrap_err().contains("modifier"));
        // No key.
        assert!(parse_chord("Alt+Shift").unwrap_err().contains("no key"));
        // Two keys.
        let two = parse_chord("Alt+KeyC+KeyD").unwrap_err();
        assert!(two.contains("one key"), "{two}");
        // Garbage / unsupported keys.
        assert!(parse_chord("Alt+Escape").is_err());
        assert!(parse_chord("Alt+F13").is_err());
        assert!(parse_chord("Alt+F0").is_err());
        assert!(parse_chord("Alt+Keyed").is_err());
        assert!(parse_chord("Alt+Digit42").is_err());
        assert!(parse_chord("").is_err());
        assert!(parse_chord("+++").is_err());
    }

    #[test]
    fn unparseable_or_absent_chords_fall_back_to_the_default() {
        let default = parse_chord(DEFAULT_CAPTURE_CHORD).unwrap();
        assert_eq!(resolve_capture_chord(None), default);
        assert_eq!(resolve_capture_chord(Some("")), default);
        assert_eq!(resolve_capture_chord(Some("nonsense")), default);
        assert_eq!(resolve_capture_chord(Some("Alt+Shift")), default);
        assert_eq!(
            resolve_capture_chord(Some("ctrl+alt+k")),
            parse_chord("Ctrl+Alt+KeyK").unwrap()
        );
    }

    #[test]
    fn display_never_byte_slices_multibyte_symbols() {
        let all = ChordSpec {
            alt: true,
            shift: true,
            ctrl: true,
            meta: true,
            code: "KeyZ".to_string(),
        };
        assert_eq!(chord_display(&all), "⌃⌥⇧⌘Z");
        assert_eq!(format_chord(&all), "Ctrl+Alt+Shift+Meta+KeyZ");
        // Round-trip through the parser proves the canonical form is accepted.
        assert_eq!(parse_chord(&format_chord(&all)).unwrap(), all);
    }

    #[test]
    fn synced_root_matches_storage_ideas_dir() {
        let root = Path::new("/tmp/HQ");
        assert_eq!(
            ideas_root(root, "indigo", true).unwrap(),
            crate::ideas::storage::ideas_dir(root, "indigo")
        );
    }

    #[test]
    fn local_only_root_is_outside_the_company_vault() {
        let root = Path::new("/tmp/HQ");
        let local = ideas_root(root, "indigo", false).unwrap();
        let companies = root.join("companies");
        assert!(
            !local.starts_with(&companies),
            "local-only root {local:?} must not live under {companies:?}"
        );
        assert_eq!(local, root.join("workspace").join("ideas-local").join("indigo"));
        assert!(is_local_only_root(&local));
        assert!(!is_local_only_root(&ideas_root(root, "indigo", true).unwrap()));
        // A company literally named "ideas-local" must not fool the badge.
        assert!(!is_local_only_root(
            &crate::ideas::storage::ideas_dir(root, "ideas-local")
        ));
    }

    #[test]
    fn hq_idea_board_us_012_local_only_root_is_excluded_from_vault_sync() {
        // THE "sync off" GUARANTEE. Not "it isn't under companies/" — that is
        // true of plenty of paths sync happily uploads. The only thing that
        // makes the off switch mean anything is that the real sync filter
        // refuses these paths, so assert against a real IgnoreFilter.
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();
        let filter = crate::ignore::IgnoreFilter::for_hq_root(root).unwrap();

        let local = ideas_root(root, "indigo", false).unwrap();
        for rel in ["abc/record.json", "abc/image.png", "abc/capture.md"] {
            let path = local.join(rel);
            assert!(
                !filter.should_sync(&path),
                "local-only capture {path:?} must never sync to the vault"
            );
        }
        // The local-only root directory itself is out of scope too.
        assert!(!filter.should_sync(&local));

        // Companion: turning sync ON must actually put captures in scope —
        // otherwise the exclusion could be over-broad and "on" would be a lie.
        let synced = ideas_root(root, "indigo", true).unwrap();
        for rel in ["abc/record.json", "abc/image.png", "abc/capture.md"] {
            let path = synced.join(rel);
            assert!(
                filter.should_sync(&path),
                "synced capture {path:?} must be sync-eligible"
            );
        }

        // The exclusion is root-anchored: an unrelated nested directory that
        // happens to share the name is not silently dropped from sync.
        assert!(filter.should_sync(
            &root
                .join("companies/indigo/workspace")
                .join(LOCAL_ONLY_DIR)
                .join("notes.md")
        ));
    }
}
