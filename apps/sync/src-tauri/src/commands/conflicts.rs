//! Conflict resolution commands — resolve file conflicts and open in editor.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::commands::config::MenubarPrefs;
use crate::util::paths;
use hq_desktop_core::conflicts::{build_resolve_args, validate_strategy};
use hq_desktop_core::desktop_alt::{
    canonical_hq_relative_path, company_slug_for_hq_path, validate_hq_relative_path,
    workspace_grants_company_file_access,
};
use hq_desktop_core::workspaces::Workspace;

/// CLI command timeout (10 seconds).
const RESOLVE_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EditorPlatform {
    MacOs,
    Windows,
    Freedesktop,
}

#[derive(Debug, PartialEq, Eq)]
struct EditorLaunchSpec {
    program: &'static str,
    args: Vec<OsString>,
    dispatch_mode: EditorDispatchMode,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EditorDispatchMode {
    WaitForSuccessfulExit,
    SpawnOnly,
}

fn editor_launch_spec_for(platform: EditorPlatform, path: &Path) -> EditorLaunchSpec {
    let (program, dispatch_mode) = match platform {
        EditorPlatform::MacOs => ("open", EditorDispatchMode::WaitForSuccessfulExit),
        EditorPlatform::Windows => ("explorer", EditorDispatchMode::SpawnOnly),
        EditorPlatform::Freedesktop => ("xdg-open", EditorDispatchMode::WaitForSuccessfulExit),
    };
    EditorLaunchSpec {
        program,
        args: vec![path.as_os_str().to_owned()],
        dispatch_mode,
    }
}

fn current_editor_platform() -> EditorPlatform {
    #[cfg(target_os = "macos")]
    {
        EditorPlatform::MacOs
    }
    #[cfg(target_os = "windows")]
    {
        EditorPlatform::Windows
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        EditorPlatform::Freedesktop
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Config resolution (same pattern as sync.rs / status.rs)
// ─────────────────────────────────────────────────────────────────────────────

/// Resolve the HQ folder path by reading config.json and menubar.json directly.
fn resolve_hq_folder_path() -> Result<String, String> {
    let menubar_path = paths::menubar_json_path()?;

    let menubar_prefs: Option<MenubarPrefs> = if menubar_path.exists() {
        std::fs::read_to_string(&menubar_path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
    } else {
        None
    };

    // Shared lenient reader: parse failures fall through to menubar/discovery,
    // but real IO errors still propagate as Err. Uniform across all four
    // `resolve_hq_folder_path` duplicates.
    let config = crate::commands::config::read_hq_config_lenient()?;

    let hq_folder = paths::resolve_hq_folder(
        config.as_ref().and_then(|c| c.hq_folder_path.as_deref()),
        menubar_prefs.as_ref().and_then(|p| p.hq_path.as_deref()),
    );

    Ok(hq_folder.to_string_lossy().to_string())
}

// ─────────────────────────────────────────────────────────────────────────────
// Tauri commands
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug)]
struct ResolvedConflictTarget {
    hq_root: PathBuf,
    absolute_path: PathBuf,
    relative_path: String,
    company_slug: Option<String>,
}

fn resolve_conflict_target(hq_root: &Path, path: &str) -> Result<ResolvedConflictTarget, String> {
    let normalized = validate_hq_relative_path(path, false)?;
    let canonical = canonical_hq_relative_path(hq_root, &normalized, false)?;
    let lexical_company = company_slug_for_hq_path(&normalized)?;
    let canonical_company = company_slug_for_hq_path(&canonical)?;

    if lexical_company != canonical_company || normalized != canonical {
        return Err("conflict path resolves outside its authorized HQ scope".to_string());
    }

    let canonical_root =
        std::fs::canonicalize(hq_root).map_err(|e| format!("Invalid HQ folder: {e}"))?;
    let absolute_path = canonical_root.join(&canonical);
    if !absolute_path.is_file() {
        return Err(format!("conflict path is not a file: {path:?}"));
    }

    Ok(ResolvedConflictTarget {
        hq_root: canonical_root,
        absolute_path,
        relative_path: canonical,
        company_slug: canonical_company,
    })
}

fn authorize_conflict_target(
    target: ResolvedConflictTarget,
    workspaces: &[Workspace],
) -> Result<ResolvedConflictTarget, String> {
    if let Some(slug) = target.company_slug.as_deref() {
        if !workspace_grants_company_file_access(workspaces, slug) {
            return Err(format!("company conflict is not authorized: {slug:?}"));
        }
    }
    Ok(target)
}

async fn resolve_authorized_conflict_target(path: &str) -> Result<ResolvedConflictTarget, String> {
    let hq_root = PathBuf::from(resolve_hq_folder_path()?);
    let target = resolve_conflict_target(&hq_root, path)?;
    let workspaces = if target.company_slug.is_some() {
        crate::commands::workspaces::list_syncable_workspaces()
            .await?
            .workspaces
    } else {
        Vec::new()
    };
    authorize_conflict_target(target, &workspaces)
}

fn revalidate_conflict_target(
    target: &ResolvedConflictTarget,
) -> Result<ResolvedConflictTarget, String> {
    let refreshed = resolve_conflict_target(&target.hq_root, &target.relative_path)?;
    if refreshed.absolute_path != target.absolute_path
        || refreshed.relative_path != target.relative_path
        || refreshed.company_slug != target.company_slug
    {
        return Err("conflict target changed during authorization".to_string());
    }
    Ok(refreshed)
}

async fn revalidate_authorized_conflict_target(
    target: &ResolvedConflictTarget,
) -> Result<ResolvedConflictTarget, String> {
    // Hydration can await network/cache work. Do it before the final canonical
    // path check so a renderer cannot swap a previously authorized path during
    // that await and hand the changed target to the CLI/editor.
    let workspaces = if target.company_slug.is_some() {
        crate::commands::workspaces::list_syncable_workspaces()
            .await?
            .workspaces
    } else {
        Vec::new()
    };
    let refreshed = revalidate_conflict_target(target)?;
    authorize_conflict_target(refreshed, &workspaces)
}

/// Resolve a file conflict using the specified strategy.
///
/// - `strategy` must be `"keep-local"` or `"keep-remote"`.
/// - Runs `hq sync resolve --strategy {strategy} --path {path} --hq-path {hq_folder}`.
/// - Times out after 10 seconds; the child process is killed if it exceeds this.
#[tauri::command]
pub async fn resolve_conflict(path: String, strategy: String) -> Result<(), String> {
    validate_strategy(&strategy)?;

    let target = resolve_authorized_conflict_target(&path).await?;
    let target = revalidate_authorized_conflict_target(&target).await?;
    #[cfg(debug_assertions)]
    eprintln!(
        "[conflicts] resolving {} with strategy {}",
        target.relative_path, strategy
    );

    tauri::async_runtime::spawn_blocking(move || {
        // Keep the last filesystem resolution adjacent to the process sink.
        // Only the revalidated canonical relative path reaches the HQ CLI.
        let target = revalidate_conflict_target(&target)?;
        let hq_folder = target.hq_root.to_string_lossy().to_string();
        let relative_path = target.relative_path;
        let args = build_resolve_args(&strategy, &relative_path, &hq_folder);
        let hq = paths::resolve_bin("hq");
        let mut child = paths::spawn_command(&hq, &[])
            .args(&args)
            .env("HQ_ROOT", &hq_folder)
            .env("PATH", paths::child_path())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to spawn hq CLI: {}", e))?;

        // Wait with timeout — kill the process if it takes too long.
        let start = std::time::Instant::now();
        let exit_status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) => {
                    if start.elapsed() >= RESOLVE_TIMEOUT {
                        let _ = child.kill();
                        let _ = child.wait(); // reap zombie
                        return Err("hq sync resolve timed out".to_string());
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(e) => return Err(format!("Failed to wait for hq CLI: {}", e)),
            }
        };

        if !exit_status.success() {
            let mut stderr_buf = String::new();
            if let Some(mut stderr) = child.stderr.take() {
                use std::io::Read;
                let _ = stderr.read_to_string(&mut stderr_buf);
            }
            return Err(format!(
                "hq sync resolve exited with code {}: {}",
                exit_status
                    .code()
                    .map(|c| c.to_string())
                    .unwrap_or_else(|| "unknown".to_string()),
                stderr_buf.trim()
            ));
        }

        Ok(())
    })
    .await
    .map_err(|e| format!("conflict resolver task failed: {e}"))?
}

/// Open a file in the system default editor.
///
/// Resolves the HQ folder path, constructs the full path as `{hq_folder}/{path}`,
/// and uses the platform shell (`open`, `explorer`, or `xdg-open`) to launch
/// the default application.
#[tauri::command]
pub async fn open_in_editor(path: String) -> Result<(), String> {
    let target = resolve_authorized_conflict_target(&path).await?;
    let target = revalidate_authorized_conflict_target(&target).await?;
    #[cfg(debug_assertions)]
    eprintln!(
        "[conflicts] opening in editor: {}",
        target.absolute_path.display()
    );

    tauri::async_runtime::spawn_blocking(move || {
        // Re-resolve at the OS boundary so the editor never receives a path
        // changed while membership hydration or task scheduling was pending.
        let target = revalidate_conflict_target(&target)?;
        let full_path = target.absolute_path;
        let launch = editor_launch_spec_for(current_editor_platform(), &full_path);
        match launch.dispatch_mode {
            EditorDispatchMode::SpawnOnly => std::process::Command::new(launch.program)
                .args(&launch.args)
                .spawn()
                .map(|_| ())
                .map_err(|e| format!("Failed to dispatch {} command: {}", launch.program, e)),
            EditorDispatchMode::WaitForSuccessfulExit => {
                let output = std::process::Command::new(launch.program)
                    .args(&launch.args)
                    .output()
                    .map_err(|e| format!("Failed to run {} command: {}", launch.program, e))?;

                if !output.status.success() {
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    return Err(format!(
                        "{} command failed with code {}: {}",
                        launch.program,
                        output
                            .status
                            .code()
                            .map(|c| c.to_string())
                            .unwrap_or_else(|| "unknown".to_string()),
                        stderr.trim()
                    ));
                }

                Ok(())
            }
        }
    })
    .await
    .map_err(|e| format!("editor task failed: {e}"))?
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use hq_desktop_core::workspaces::{WorkspaceKind, WorkspaceState};

    fn workspace(
        slug: &str,
        state: WorkspaceState,
        membership_status: Option<&str>,
        cloud_uid: Option<&str>,
    ) -> Workspace {
        Workspace {
            slug: slug.to_string(),
            display_name: slug.to_string(),
            kind: WorkspaceKind::Company,
            state,
            cloud_uid: cloud_uid.map(str::to_string),
            bucket_name: cloud_uid.map(|_| format!("{slug}-bucket")),
            has_local_folder: true,
            local_path: Some(format!("/tmp/HQ/companies/{slug}")),
            membership_status: membership_status.map(str::to_string),
            role: Some("member".to_string()),
            sync_enabled: true,
            last_synced_at: None,
            broken_reason: None,
            invited_by: None,
            invited_at: None,
        }
    }

    // ── Timeout constant ────────────────────────────────────────────────

    #[test]
    fn test_resolve_timeout_value() {
        assert_eq!(RESOLVE_TIMEOUT, Duration::from_secs(10));
    }

    #[test]
    fn editor_launcher_dispatches_for_every_desktop_platform() {
        let path = Path::new("companies/indigo/conflict.md");

        let macos = editor_launch_spec_for(EditorPlatform::MacOs, path);
        assert_eq!(macos.program, "open");
        assert_eq!(macos.args, vec![path.as_os_str().to_owned()]);
        assert_eq!(
            macos.dispatch_mode,
            EditorDispatchMode::WaitForSuccessfulExit
        );

        let windows = editor_launch_spec_for(EditorPlatform::Windows, path);
        assert_eq!(windows.program, "explorer");
        assert_eq!(windows.args, vec![path.as_os_str().to_owned()]);
        assert_eq!(windows.dispatch_mode, EditorDispatchMode::SpawnOnly);

        let freedesktop = editor_launch_spec_for(EditorPlatform::Freedesktop, path);
        assert_eq!(freedesktop.program, "xdg-open");
        assert_eq!(freedesktop.args, vec![path.as_os_str().to_owned()]);
        assert_eq!(
            freedesktop.dispatch_mode,
            EditorDispatchMode::WaitForSuccessfulExit
        );
    }

    #[test]
    fn conflict_targets_require_live_company_access() {
        let temp = tempfile::tempdir().unwrap();
        for slug in [
            "active",
            "pending",
            "paused",
            "revoked",
            "unknown-status",
            "local",
            "local-cloud-bound",
            "cloud-bound",
            "cloud-only",
        ] {
            let company = temp.path().join("companies").join(slug);
            std::fs::create_dir_all(&company).unwrap();
            std::fs::write(company.join("conflict.md"), slug).unwrap();
        }
        let workspaces = vec![
            workspace(
                "active",
                WorkspaceState::Synced,
                Some("active"),
                Some("cmp_active"),
            ),
            workspace(
                "pending",
                WorkspaceState::Synced,
                Some("pending"),
                Some("cmp_pending"),
            ),
            workspace(
                "paused",
                WorkspaceState::Synced,
                Some("paused"),
                Some("cmp_paused"),
            ),
            workspace(
                "revoked",
                WorkspaceState::Synced,
                Some("revoked"),
                Some("cmp_revoked"),
            ),
            workspace(
                "unknown-status",
                WorkspaceState::Synced,
                Some("future-status"),
                Some("cmp_unknown"),
            ),
            workspace("local", WorkspaceState::LocalOnly, None, None),
            workspace(
                "local-cloud-bound",
                WorkspaceState::LocalOnly,
                None,
                Some("cmp_local_cloud"),
            ),
            workspace(
                "cloud-bound",
                WorkspaceState::Synced,
                None,
                Some("cmp_cloud"),
            ),
            Workspace {
                has_local_folder: false,
                ..workspace(
                    "cloud-only",
                    WorkspaceState::CloudOnly,
                    Some("active"),
                    Some("cmp_cloud_only"),
                )
            },
        ];

        let active = resolve_conflict_target(temp.path(), "companies/active/conflict.md").unwrap();
        assert!(authorize_conflict_target(active, &workspaces).is_ok());
        let initially_active =
            resolve_conflict_target(temp.path(), "companies/active/conflict.md").unwrap();
        let revalidated = revalidate_conflict_target(&initially_active).unwrap();
        let revoked_after_resolution = vec![workspace(
            "active",
            WorkspaceState::Synced,
            Some("revoked"),
            Some("cmp_active"),
        )];
        assert!(authorize_conflict_target(revalidated, &revoked_after_resolution).is_err());
        let local = resolve_conflict_target(temp.path(), "companies/local/conflict.md").unwrap();
        assert!(authorize_conflict_target(local, &workspaces).is_ok());
        let pending =
            resolve_conflict_target(temp.path(), "companies/pending/conflict.md").unwrap();
        assert!(authorize_conflict_target(pending, &workspaces).is_err());
        for slug in [
            "paused",
            "revoked",
            "unknown-status",
            "local-cloud-bound",
            "cloud-bound",
            "cloud-only",
        ] {
            let denied =
                resolve_conflict_target(temp.path(), &format!("companies/{slug}/conflict.md"))
                    .unwrap();
            assert!(
                authorize_conflict_target(denied, &workspaces).is_err(),
                "{slug} must not authorize a conflict target"
            );
        }

        std::fs::create_dir_all(temp.path().join("personal")).unwrap();
        std::fs::write(temp.path().join("personal/conflict.md"), "personal").unwrap();
        let personal = resolve_conflict_target(temp.path(), "personal/conflict.md").unwrap();
        assert!(authorize_conflict_target(personal, &[]).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn conflict_targets_reject_symlink_aliases_and_hq_escape() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let active = temp.path().join("companies/active");
        let other = temp.path().join("companies/other");
        let personal = temp.path().join("personal");
        std::fs::create_dir_all(&active).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        std::fs::create_dir_all(&personal).unwrap();
        std::fs::write(active.join("real.md"), "active").unwrap();
        std::fs::write(other.join("conflict.md"), "other").unwrap();
        symlink(
            other.join("conflict.md"),
            active.join("cross-company-conflict.md"),
        )
        .unwrap();

        let outside = tempfile::NamedTempFile::new().unwrap();
        symlink(outside.path(), active.join("outside-conflict.md")).unwrap();
        symlink(active.join("real.md"), active.join("same-company-alias.md")).unwrap();
        symlink(other.join("conflict.md"), personal.join("company-alias.md")).unwrap();

        assert!(
            resolve_conflict_target(temp.path(), "companies/active/cross-company-conflict.md")
                .is_err()
        );
        assert!(
            resolve_conflict_target(temp.path(), "companies/active/outside-conflict.md").is_err()
        );
        assert!(
            resolve_conflict_target(temp.path(), "companies/active/same-company-alias.md").is_err()
        );
        assert!(resolve_conflict_target(temp.path(), "personal/company-alias.md").is_err());
        assert!(resolve_conflict_target(temp.path(), "../outside.md").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn conflict_target_revalidation_rejects_post_authorization_symlink_swap() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let active = temp.path().join("companies/active");
        let pending = temp.path().join("companies/pending");
        std::fs::create_dir_all(&active).unwrap();
        std::fs::create_dir_all(&pending).unwrap();
        std::fs::write(active.join("conflict.md"), "active").unwrap();
        std::fs::write(pending.join("secret.md"), "pending").unwrap();

        let original =
            resolve_conflict_target(temp.path(), "companies/active/conflict.md").unwrap();
        std::fs::remove_file(active.join("conflict.md")).unwrap();
        symlink(pending.join("secret.md"), active.join("conflict.md")).unwrap();

        assert!(revalidate_conflict_target(&original).is_err());
    }
}
