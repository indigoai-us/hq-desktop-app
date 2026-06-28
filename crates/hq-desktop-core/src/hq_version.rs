use crate::config::{read_hq_config_lenient, MenubarPrefs};
use crate::paths;

/// Resolve the locally-installed hq-core version by reading `hqVersion`
/// from `core.yaml` inside the user's HQ folder.
///
/// File location is layout-aware:
///   * **canonical (v14+):** `<HQ folder>/core/core.yaml`
///   * **legacy (pre-v14):** `<HQ folder>/core.yaml`
///
/// The v14 hq-core release moved `core.yaml` one level deeper (see
/// `apps/hq-core/MIGRATION.md` in this monorepo — "Root core.yaml;
/// canonical location is core/core.yaml"). We check the canonical
/// location first and fall back to the legacy root for any HQ folder
/// that hasn't migrated yet.
///
/// Resolution order for the HQ folder mirrors what `conflicts.rs` and
/// `daemon.rs` do: menubar.json `hqPath` → config.json `hqFolderPath` →
/// discovery via `core.yaml` signature → `~/HQ`. See `paths::resolve_hq_folder`.
///
/// Returns `None` when:
///   * the HQ folder can't be located,
///   * neither canonical nor legacy `core.yaml` exists,
///   * `core.yaml` is unparseable as YAML,
///   * `core.yaml` has no `hqVersion` field.
///
/// All four cases are silent: the banner doesn't fire for users without
/// a working HQ install — the CLI nag's "don't pester users who don't
/// have it installed" rule applies here too.
pub fn get_local_version() -> Option<String> {
    let menubar_prefs: Option<MenubarPrefs> = paths::menubar_json_path()
        .ok()
        .filter(|p| p.exists())
        .and_then(|p| std::fs::read_to_string(&p).ok())
        .and_then(|s| serde_json::from_str(&s).ok());

    let config = read_hq_config_lenient().ok().flatten();

    let hq_folder = paths::resolve_hq_folder(
        config.as_ref().and_then(|c| c.hq_folder_path.as_deref()),
        menubar_prefs.as_ref().and_then(|p| p.hq_path.as_deref()),
    );

    // Canonical first (v14+), legacy fallback (pre-v14). Two stat
    // syscalls in the miss path is fine — this runs every 6h, not on
    // a hot loop.
    let canonical = hq_folder.join("core").join("core.yaml");
    let legacy = hq_folder.join("core.yaml");
    let core_yaml = if canonical.is_file() {
        canonical
    } else {
        legacy
    };

    let bytes = std::fs::read(&core_yaml).ok()?;
    let parsed: serde_yaml::Value = serde_yaml::from_slice(&bytes).ok()?;
    let s = parsed.get("hqVersion")?.as_str()?.trim();
    if s.is_empty() {
        None
    } else {
        Some(s.to_string())
    }
}

/// Strip a single leading `v` from a tag name. GitHub release tag_names
/// come in both flavours (`v14.1.0` and `14.1.0`) depending on the repo's
/// convention; hq-core's release workflow uses the `v`-prefixed form.
pub fn strip_v_prefix(s: &str) -> &str {
    s.strip_prefix('v').unwrap_or(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_v_prefix_handles_both_conventions() {
        assert_eq!(strip_v_prefix("v14.1.0"), "14.1.0");
        assert_eq!(strip_v_prefix("14.1.0"), "14.1.0");
        // Only one leading 'v' — anything else is a pathological tag we
        // can't meaningfully repair, so pass through.
        assert_eq!(strip_v_prefix("vv1.0.0"), "v1.0.0");
        assert_eq!(strip_v_prefix(""), "");
    }

    #[test]
    fn local_version_returns_none_when_core_yaml_missing() {
        // Smoke-test: even with no HQ folder anywhere on disk in the
        // sandbox, the function must not panic — under-report rather
        // than crash, same posture as the CLI nag.
        let _ = get_local_version();
    }
}
