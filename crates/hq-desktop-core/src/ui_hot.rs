//! UI hot updates: interface-only bundles applied to an installed app without
//! an installer, notarization, or restart (see `docs/RELEASE.md` "UI hot
//! updates").
//!
//! The installed `.app` is never modified — macOS code-signing seals
//! `Contents/Resources`, and writing into it makes the app "damaged". Hot
//! bundles live in the app's data directory instead:
//!
//! ```text
//! <app data dir>/ui/
//!   state.json            active pointer + good/bad ledger (atomic rename)
//!   bundles/<uiVersion>/
//!     manifest.json       the verified manifest (sha256 filled in)
//!     dist/               the served files (index.html at the root)
//! ```
//!
//! `ui_protocol` asks [`select_root`] which directory to serve. A hot bundle
//! is only selected when every gate passes:
//! - the `ui_hot_updates` setting is not `off`;
//! - the running shell's key (the `shell-key.txt` stamped into the bundle
//!   resources, computed by `scripts/shell-hash.mjs`) is listed in the
//!   bundle's signed manifest, so UI never runs on a shell it was not built
//!   against;
//! - the bundle's base version (the part of `uiVersion` before `+`) is not
//!   older than the running app, so a native release that ships a newer
//!   `Resources/ui` is never shadowed by an older hot bundle;
//! - `minAppVersion`, when present, is satisfied;
//! - it is not marked bad and its `dist/index.html` exists.
//!
//! Otherwise the bundle's own `Resources/ui` is served.
//!
//! Rollback: a bundle that fails to boot (the UI's health beacon does not
//! arrive in time, or the UI reports a fatal boot error) is marked bad and the
//! pointer falls back to the newest confirmed-good bundle, or to
//! `Resources/ui` when there is none. The last [`KEEP_GOOD`] confirmed-good
//! bundles are kept; older bundle directories are pruned.

use std::collections::HashSet;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Confirmed-good bundles kept on disk for rollback.
pub const KEEP_GOOD: usize = 2;
/// Bad versions remembered so a re-published bad bundle is not re-applied.
const KEEP_BAD: usize = 20;

pub const STATE_FILE: &str = "state.json";
pub const BUNDLES_DIR: &str = "bundles";
pub const MANIFEST_FILE: &str = "manifest.json";
pub const DIST_DIR: &str = "dist";

/// The `uiHotUpdates` setting in `~/.hq/menubar.json`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UiHotMode {
    Off,
    Beta,
    Stable,
}

impl UiHotMode {
    /// Absent or unknown values resolve to `Off` (opt-in first).
    pub fn from_pref(value: Option<&str>) -> Self {
        match value.map(|v| v.trim().to_ascii_lowercase()).as_deref() {
            Some("beta") => Self::Beta,
            Some("stable") => Self::Stable,
            _ => Self::Off,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Beta => "beta",
            Self::Stable => "stable",
        }
    }

    /// The publish channel this mode follows (`None` for `Off`).
    pub fn channel(self) -> Option<&'static str> {
        match self {
            Self::Off => None,
            Self::Beta => Some("beta"),
            Self::Stable => Some("stable"),
        }
    }
}

/// Manifest shipped with every UI bundle (`ui-manifest.json` next to the
/// archive, and `hq-ui-manifest.json` inside it).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiManifest {
    pub ui_version: String,
    pub shell_keys: Vec<String>,
    /// Hex sha256 of the `.tar.gz` archive. Empty inside the archive itself
    /// (an archive cannot contain its own hash); filled in on apply.
    #[serde(default)]
    pub sha256: String,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_app_version: Option<String>,
}

/// `state.json`: the active pointer plus the good/bad ledger.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiHotState {
    /// The bundle to serve. May be unconfirmed (not yet in `good`).
    #[serde(default)]
    pub active: Option<String>,
    /// Bundles whose health beacon arrived, newest first, at most
    /// [`KEEP_GOOD`].
    #[serde(default)]
    pub good: Vec<String>,
    /// Bundles that failed to boot or verify, newest first.
    #[serde(default)]
    pub bad: Vec<String>,
}

/// Which UI root to serve.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Selection {
    Hot { ui_version: String, dir: PathBuf },
    Builtin,
}

/// Why a candidate bundle was passed over (logged by the caller).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SkipReason {
    Disabled,
    NoShellKey,
    MarkedBad,
    ManifestUnreadable(String),
    ShellKeyMismatch,
    OlderThanApp,
    AppTooOld(String),
    IndexMissing,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SelectionReport {
    pub selection: Selection,
    /// Candidates considered and rejected, in order.
    pub skipped: Vec<(String, SkipReason)>,
}

pub fn bundles_dir(hot_root: &Path) -> PathBuf {
    hot_root.join(BUNDLES_DIR)
}

pub fn bundle_dir(hot_root: &Path, ui_version: &str) -> PathBuf {
    bundles_dir(hot_root).join(ui_version)
}

/// A `uiVersion` is used as a directory name, so it must be a plain token.
pub fn valid_ui_version(v: &str) -> bool {
    !v.is_empty()
        && v.len() <= 96
        && v.chars().next().is_some_and(|c| c.is_ascii_digit())
        && v.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+'))
        && !v.contains("..")
}

/// The app version a UI bundle was built from: `uiVersion` up to `+`.
pub fn base_version(ui_version: &str) -> &str {
    ui_version.split('+').next().unwrap_or(ui_version)
}

fn version_lt(a: &str, b: &str) -> bool {
    match (semver::Version::parse(a), semver::Version::parse(b)) {
        (Ok(a), Ok(b)) => a < b,
        // Unparseable versions never pass a comparison gate.
        _ => true,
    }
}

/// Read the shell key stamped into the bundle resources (`shell-key.txt`).
pub fn read_shell_key(resources_dir: &Path) -> Option<String> {
    let key = std::fs::read_to_string(resources_dir.join("shell-key.txt")).ok()?;
    let key = key.trim();
    (!key.is_empty()).then(|| key.to_string())
}

pub fn read_state(hot_root: &Path) -> UiHotState {
    std::fs::read_to_string(hot_root.join(STATE_FILE))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Write `bytes` to `path` atomically: write `<path>.tmp`, fsync, rename.
/// A reader sees either the old file or the new one, never a partial write.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut tmp_name = path.file_name().unwrap_or_default().to_os_string();
    tmp_name.push(".tmp");
    let tmp = path.with_file_name(tmp_name);
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, path)
}

pub fn write_state(hot_root: &Path, state: &UiHotState) -> std::io::Result<()> {
    let json = serde_json::to_vec_pretty(state).map_err(std::io::Error::other)?;
    write_atomic(&hot_root.join(STATE_FILE), &json)
}

pub fn read_bundle_manifest(dir: &Path) -> Result<UiManifest, String> {
    let text = std::fs::read_to_string(dir.join(MANIFEST_FILE)).map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

/// Every gate except "marked bad" for one installed bundle directory.
pub fn check_bundle(
    dir: &Path,
    shell_key: &str,
    app_version: &str,
) -> Result<UiManifest, SkipReason> {
    let manifest = read_bundle_manifest(dir).map_err(SkipReason::ManifestUnreadable)?;
    check_manifest(&manifest, shell_key, app_version)?;
    if !dir.join(DIST_DIR).join("index.html").is_file() {
        return Err(SkipReason::IndexMissing);
    }
    Ok(manifest)
}

/// The compatibility gate on a manifest alone (shared by apply and serve).
pub fn check_manifest(
    manifest: &UiManifest,
    shell_key: &str,
    app_version: &str,
) -> Result<(), SkipReason> {
    if !manifest.shell_keys.iter().any(|k| k == shell_key) {
        return Err(SkipReason::ShellKeyMismatch);
    }
    if version_lt(base_version(&manifest.ui_version), app_version) {
        return Err(SkipReason::OlderThanApp);
    }
    if let Some(min) = manifest.min_app_version.as_deref() {
        if version_lt(app_version, min) {
            return Err(SkipReason::AppTooOld(min.to_string()));
        }
    }
    Ok(())
}

/// Pick the UI root. Candidates are the active pointer, then the
/// confirmed-good bundles newest first; the first one that passes every gate
/// wins, otherwise the builtin `Resources/ui`.
pub fn select_root(
    hot_root: &Path,
    mode: UiHotMode,
    shell_key: Option<&str>,
    app_version: &str,
) -> SelectionReport {
    let mut skipped = Vec::new();
    if mode == UiHotMode::Off {
        return SelectionReport { selection: Selection::Builtin, skipped };
    }
    let state = read_state(hot_root);
    let Some(shell_key) = shell_key else {
        if let Some(active) = state.active {
            skipped.push((active, SkipReason::NoShellKey));
        }
        return SelectionReport { selection: Selection::Builtin, skipped };
    };
    let bad: HashSet<&str> = state.bad.iter().map(String::as_str).collect();
    let mut seen = HashSet::new();
    for version in state.active.iter().chain(state.good.iter()) {
        if !seen.insert(version.as_str()) {
            continue;
        }
        if !valid_ui_version(version) {
            skipped.push((version.clone(), SkipReason::ManifestUnreadable("invalid version".into())));
            continue;
        }
        if bad.contains(version.as_str()) {
            skipped.push((version.clone(), SkipReason::MarkedBad));
            continue;
        }
        let dir = bundle_dir(hot_root, version);
        match check_bundle(&dir, shell_key, app_version) {
            Ok(_) => {
                return SelectionReport {
                    selection: Selection::Hot { ui_version: version.clone(), dir: dir.join(DIST_DIR) },
                    skipped,
                }
            }
            Err(reason) => skipped.push((version.clone(), reason)),
        }
    }
    SelectionReport { selection: Selection::Builtin, skipped }
}

fn push_front_unique(list: &mut Vec<String>, v: &str, cap: usize) {
    list.retain(|x| x != v);
    list.insert(0, v.to_string());
    list.truncate(cap);
}

/// Flip the active pointer to an installed bundle. The bundle directory must
/// already be complete; this is the single atomic step that makes it live.
pub fn activate(hot_root: &Path, ui_version: &str) -> std::io::Result<UiHotState> {
    let mut state = read_state(hot_root);
    state.active = Some(ui_version.to_string());
    state.bad.retain(|b| b != ui_version);
    write_state(hot_root, &state)?;
    Ok(state)
}

/// The UI's health beacon arrived for `ui_version`: record it as good and
/// prune bundle directories no longer referenced.
pub fn confirm_good(hot_root: &Path, ui_version: &str) -> std::io::Result<UiHotState> {
    let mut state = read_state(hot_root);
    if state.bad.iter().any(|b| b == ui_version) {
        return Ok(state);
    }
    push_front_unique(&mut state.good, ui_version, KEEP_GOOD);
    write_state(hot_root, &state)?;
    prune(hot_root, &state);
    Ok(state)
}

/// Mark `ui_version` bad. When it was active, the pointer falls back to the
/// newest confirmed-good bundle (or `None` = builtin `Resources/ui`).
pub fn mark_bad(hot_root: &Path, ui_version: &str) -> std::io::Result<UiHotState> {
    let mut state = read_state(hot_root);
    push_front_unique(&mut state.bad, ui_version, KEEP_BAD);
    state.good.retain(|g| g != ui_version);
    if state.active.as_deref() == Some(ui_version) {
        state.active = rollback_target(&state);
    }
    write_state(hot_root, &state)?;
    prune(hot_root, &state);
    Ok(state)
}

/// The bundle to fall back to: the newest good bundle not marked bad.
pub fn rollback_target(state: &UiHotState) -> Option<String> {
    state.good.iter().find(|g| !state.bad.contains(g)).cloned()
}

/// Remove bundle directories that are neither active nor confirmed-good.
/// Leftover `*.partial` staging directories are removed too.
pub fn prune(hot_root: &Path, state: &UiHotState) {
    let keep: HashSet<&str> = state
        .active
        .iter()
        .chain(state.good.iter())
        .map(String::as_str)
        .collect();
    let Ok(entries) = std::fs::read_dir(bundles_dir(hot_root)) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if keep.contains(name.as_ref()) {
            continue;
        }
        if let Err(err) = std::fs::remove_dir_all(entry.path()) {
            eprintln!("[hq-ui-hot] prune {} failed: {err}", entry.path().display());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    const KEY: &str = "shellkey-aaa";
    const APP: &str = "0.10.330";

    fn root(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hq-ui-hot-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn manifest(version: &str, keys: &[&str]) -> UiManifest {
        UiManifest {
            ui_version: version.into(),
            shell_keys: keys.iter().map(|k| k.to_string()).collect(),
            sha256: "00".into(),
            created_at: "2026-09-26T00:00:00Z".into(),
            min_app_version: None,
        }
    }

    fn install(root: &Path, m: &UiManifest, with_index: bool) {
        let dir = bundle_dir(root, &m.ui_version);
        fs::create_dir_all(dir.join(DIST_DIR)).unwrap();
        fs::write(dir.join(MANIFEST_FILE), serde_json::to_vec(m).unwrap()).unwrap();
        if with_index {
            fs::write(dir.join(DIST_DIR).join("index.html"), b"<html></html>").unwrap();
        }
    }

    fn hot_version(r: &SelectionReport) -> Option<&str> {
        match &r.selection {
            Selection::Hot { ui_version, .. } => Some(ui_version),
            Selection::Builtin => None,
        }
    }

    #[test]
    fn mode_parses_and_defaults_off() {
        assert_eq!(UiHotMode::from_pref(None), UiHotMode::Off);
        assert_eq!(UiHotMode::from_pref(Some("garbage")), UiHotMode::Off);
        assert_eq!(UiHotMode::from_pref(Some("Beta")), UiHotMode::Beta);
        assert_eq!(UiHotMode::from_pref(Some("stable")), UiHotMode::Stable);
        assert_eq!(UiHotMode::Off.channel(), None);
        assert_eq!(UiHotMode::Beta.channel(), Some("beta"));
    }

    #[test]
    fn active_hot_bundle_wins_over_builtin() {
        let r = root("precedence");
        install(&r, &manifest("0.10.330+ui.1", &[KEY]), true);
        activate(&r, "0.10.330+ui.1").unwrap();
        let rep = select_root(&r, UiHotMode::Beta, Some(KEY), APP);
        assert_eq!(hot_version(&rep), Some("0.10.330+ui.1"));
        match rep.selection {
            Selection::Hot { dir, .. } => assert!(dir.ends_with("bundles/0.10.330+ui.1/dist")),
            Selection::Builtin => unreachable!(),
        }
    }

    #[test]
    fn off_mode_serves_builtin_even_with_active_bundle() {
        let r = root("off");
        install(&r, &manifest("0.10.330+ui.1", &[KEY]), true);
        activate(&r, "0.10.330+ui.1").unwrap();
        assert_eq!(select_root(&r, UiHotMode::Off, Some(KEY), APP).selection, Selection::Builtin);
    }

    #[test]
    fn no_state_serves_builtin() {
        let r = root("empty");
        let rep = select_root(&r, UiHotMode::Stable, Some(KEY), APP);
        assert_eq!(rep.selection, Selection::Builtin);
        assert!(rep.skipped.is_empty());
    }

    #[test]
    fn shell_key_gate_rejects_bundle_for_other_shell() {
        let r = root("gate");
        install(&r, &manifest("0.10.330+ui.1", &["other-shell"]), true);
        activate(&r, "0.10.330+ui.1").unwrap();
        let rep = select_root(&r, UiHotMode::Beta, Some(KEY), APP);
        assert_eq!(rep.selection, Selection::Builtin);
        assert_eq!(rep.skipped, vec![("0.10.330+ui.1".into(), SkipReason::ShellKeyMismatch)]);
    }

    #[test]
    fn missing_shell_key_serves_builtin() {
        let r = root("nokey");
        install(&r, &manifest("0.10.330+ui.1", &[KEY]), true);
        activate(&r, "0.10.330+ui.1").unwrap();
        let rep = select_root(&r, UiHotMode::Beta, None, APP);
        assert_eq!(rep.selection, Selection::Builtin);
        assert_eq!(rep.skipped[0].1, SkipReason::NoShellKey);
    }

    #[test]
    fn bundle_older_than_running_app_is_ignored() {
        // A native release that ships newer Resources/ui on the same shell key
        // must not be shadowed by a hot bundle built from an older version.
        let r = root("older");
        install(&r, &manifest("0.10.329+ui.9", &[KEY]), true);
        activate(&r, "0.10.329+ui.9").unwrap();
        let rep = select_root(&r, UiHotMode::Beta, Some(KEY), APP);
        assert_eq!(rep.selection, Selection::Builtin);
        assert_eq!(rep.skipped[0].1, SkipReason::OlderThanApp);
    }

    #[test]
    fn min_app_version_gate() {
        let mut m = manifest("0.10.330+ui.2", &[KEY]);
        m.min_app_version = Some("0.10.331".into());
        assert_eq!(check_manifest(&m, KEY, APP), Err(SkipReason::AppTooOld("0.10.331".into())));
        m.min_app_version = Some("0.10.300".into());
        assert_eq!(check_manifest(&m, KEY, APP), Ok(()));
    }

    #[test]
    fn missing_index_falls_back_to_previous_good() {
        let r = root("noindex");
        install(&r, &manifest("0.10.330+ui.1", &[KEY]), true);
        activate(&r, "0.10.330+ui.1").unwrap();
        confirm_good(&r, "0.10.330+ui.1").unwrap();
        install(&r, &manifest("0.10.330+ui.2", &[KEY]), false);
        activate(&r, "0.10.330+ui.2").unwrap();
        let rep = select_root(&r, UiHotMode::Beta, Some(KEY), APP);
        assert_eq!(hot_version(&rep), Some("0.10.330+ui.1"));
        assert_eq!(rep.skipped, vec![("0.10.330+ui.2".into(), SkipReason::IndexMissing)]);
    }

    #[test]
    fn atomic_flip_leaves_no_tmp_and_is_readable() {
        let r = root("atomic");
        activate(&r, "0.10.330+ui.1").unwrap();
        assert!(!r.join("state.json.tmp").exists());
        assert_eq!(read_state(&r).active.as_deref(), Some("0.10.330+ui.1"));
        // A stale tmp from a crash mid-write never affects the pointer.
        fs::write(r.join("state.json.tmp"), b"{garbage").unwrap();
        assert_eq!(read_state(&r).active.as_deref(), Some("0.10.330+ui.1"));
        activate(&r, "0.10.330+ui.2").unwrap();
        assert_eq!(read_state(&r).active.as_deref(), Some("0.10.330+ui.2"));
    }

    #[test]
    fn corrupt_state_reads_as_empty() {
        let r = root("corrupt");
        fs::write(r.join(STATE_FILE), b"not json").unwrap();
        assert_eq!(read_state(&r), UiHotState::default());
    }

    #[test]
    fn mark_bad_rolls_back_to_previous_good() {
        let r = root("rollback");
        for v in ["0.10.330+ui.1", "0.10.330+ui.2"] {
            install(&r, &manifest(v, &[KEY]), true);
            activate(&r, v).unwrap();
            confirm_good(&r, v).unwrap();
        }
        install(&r, &manifest("0.10.330+ui.3", &[KEY]), true);
        activate(&r, "0.10.330+ui.3").unwrap();
        let state = mark_bad(&r, "0.10.330+ui.3").unwrap();
        assert_eq!(state.active.as_deref(), Some("0.10.330+ui.2"));
        assert_eq!(state.bad, vec!["0.10.330+ui.3".to_string()]);
        assert!(!bundle_dir(&r, "0.10.330+ui.3").exists(), "bad bundle pruned");
        let rep = select_root(&r, UiHotMode::Beta, Some(KEY), APP);
        assert_eq!(hot_version(&rep), Some("0.10.330+ui.2"));
    }

    #[test]
    fn mark_bad_with_no_good_falls_back_to_builtin() {
        let r = root("rollback-builtin");
        install(&r, &manifest("0.10.330+ui.1", &[KEY]), true);
        activate(&r, "0.10.330+ui.1").unwrap();
        let state = mark_bad(&r, "0.10.330+ui.1").unwrap();
        assert_eq!(state.active, None);
        assert_eq!(select_root(&r, UiHotMode::Beta, Some(KEY), APP).selection, Selection::Builtin);
    }

    #[test]
    fn bad_bundle_is_skipped_even_if_pointer_still_names_it() {
        let r = root("bad-skip");
        install(&r, &manifest("0.10.330+ui.1", &[KEY]), true);
        let state = UiHotState {
            active: Some("0.10.330+ui.1".into()),
            good: vec![],
            bad: vec!["0.10.330+ui.1".into()],
        };
        write_state(&r, &state).unwrap();
        let rep = select_root(&r, UiHotMode::Beta, Some(KEY), APP);
        assert_eq!(rep.selection, Selection::Builtin);
        assert_eq!(rep.skipped[0].1, SkipReason::MarkedBad);
    }

    #[test]
    fn keeps_last_two_good_and_prunes_older() {
        let r = root("prune");
        for v in ["0.10.330+ui.1", "0.10.330+ui.2", "0.10.330+ui.3"] {
            install(&r, &manifest(v, &[KEY]), true);
            activate(&r, v).unwrap();
            confirm_good(&r, v).unwrap();
        }
        let state = read_state(&r);
        assert_eq!(state.good, vec!["0.10.330+ui.3".to_string(), "0.10.330+ui.2".to_string()]);
        assert!(!bundle_dir(&r, "0.10.330+ui.1").exists());
        assert!(bundle_dir(&r, "0.10.330+ui.2").exists());
        assert!(bundle_dir(&r, "0.10.330+ui.3").exists());
    }

    #[test]
    fn confirm_good_ignores_bad_versions() {
        let r = root("confirm-bad");
        install(&r, &manifest("0.10.330+ui.1", &[KEY]), true);
        activate(&r, "0.10.330+ui.1").unwrap();
        mark_bad(&r, "0.10.330+ui.1").unwrap();
        assert!(confirm_good(&r, "0.10.330+ui.1").unwrap().good.is_empty());
    }

    #[test]
    fn ui_version_validation() {
        assert!(valid_ui_version("0.10.330+ui.20260926.abc123"));
        assert!(!valid_ui_version("../etc"));
        assert!(!valid_ui_version("0.10/x"));
        assert!(!valid_ui_version(""));
        assert_eq!(base_version("0.10.330+ui.1"), "0.10.330");
    }

    #[test]
    fn reads_stamped_shell_key() {
        let r = root("shellkey");
        assert_eq!(read_shell_key(&r), None);
        fs::write(r.join("shell-key.txt"), "abc123\n").unwrap();
        assert_eq!(read_shell_key(&r).as_deref(), Some("abc123"));
    }
}
