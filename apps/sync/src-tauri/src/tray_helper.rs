//! Spawns + talks to the native menu-bar helper process (`hq-tray-helper`).
//!
//! On macOS Tahoe the main app's Tauri/tao runtime parks any NSStatusItem
//! off-screen (verified on-device across every app version + a native item; a
//! clean AppKit process places its item correctly). So the visible "HQ" menu-bar
//! item lives in a tiny separate AppKit helper. The helper writes one-word
//! commands to `~/.hq/.tray-cmd`; we poll that file and act on them. The app
//! publishes its aggregate unread snapshot in `~/.hq/.tray-badge` for the
//! helper to render beside the HQ mark. Trivial, robust IPC — no
//! sockets/signals/entitlements and no second message poller.

#[cfg(target_os = "macos")]
use std::io::Write;
#[cfg(target_os = "macos")]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
#[cfg(target_os = "macos")]
use std::path::{Path, PathBuf};
#[cfg(target_os = "macos")]
use std::sync::{Mutex, OnceLock};
#[cfg(target_os = "macos")]
use std::time::Duration;

#[cfg(target_os = "macos")]
use tauri::{AppHandle, Emitter};

#[cfg(target_os = "macos")]
use crate::util::logfile::log;

#[cfg(target_os = "macos")]
fn cmd_file() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(PathBuf::from(home).join(".hq").join(".tray-cmd"))
}

#[cfg(target_os = "macos")]
fn badge_file() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(PathBuf::from(home).join(".hq").join(".tray-badge"))
}

#[cfg(target_os = "macos")]
fn badge_write_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

#[cfg(target_os = "macos")]
fn write_badge_file(path: &Path, count: u32) -> std::io::Result<()> {
    // Tauri may dispatch commands from more than one webview/thread. Keep the
    // single atomic temp path and final rename ordered at the native boundary,
    // even if a renderer reload overlaps the main publisher.
    let _write_guard = badge_write_lock()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp_path = path.with_file_name(format!(".tray-badge.{}.tmp", std::process::id()));
    let _ = std::fs::remove_file(&tmp_path);
    let mut options = std::fs::OpenOptions::new();
    options.create(true).truncate(true).write(true).mode(0o600);
    let mut file = options.open(&tmp_path)?;
    write!(file, "{count}")?;
    file.sync_all()?;
    std::fs::set_permissions(&tmp_path, std::fs::Permissions::from_mode(0o600))?;
    std::fs::rename(&tmp_path, path)?;
    Ok(())
}

/// Publish the authoritative aggregate message count for the native AppKit
/// helper. The frontend serializes/coalesces invokes; this command performs one
/// atomic snapshot write. Other platforms keep their native tray unchanged.
#[tauri::command]
pub fn set_tray_message_badge(count: u32) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let path = badge_file().ok_or_else(|| "Could not resolve HQ home folder".to_string())?;
        return write_badge_file(&path, count)
            .map_err(|error| format!("Could not update menu-bar message badge: {error}"));
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = count;
        Ok(())
    }
}

/// Resolve the bundled helper binary. In a packaged .app it sits in
/// `Contents/Resources/`; in a dev `tauri build` bundle it's placed alongside
/// the main executable. Check both.
#[cfg(target_os = "macos")]
fn helper_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let macos_dir = exe.parent()?; // …/Contents/MacOS
    let candidates = [
        macos_dir.join("../Resources/hq-tray-helper"),
        macos_dir.join("hq-tray-helper"),
    ];
    candidates.into_iter().find(|p| p.exists())
}

/// Spawn the helper (passing our PID so it self-exits if we die) and start the
/// command-file poller. Call once from `.setup()` on macOS.
#[cfg(target_os = "macos")]
pub fn spawn_and_poll(app: &AppHandle) {
    if let Some(path) = badge_file() {
        // Never inherit unread state from a prior process. App.svelte publishes
        // the authenticated aggregate as soon as its auth verdict resolves.
        let _ = write_badge_file(&path, 0);
    }
    let pid = std::process::id();
    match helper_path() {
        Some(hp) => match std::process::Command::new(&hp).arg(pid.to_string()).spawn() {
            Ok(_) => log(
                "tray",
                &format!("native menu-bar helper spawned: {}", hp.display()),
            ),
            Err(e) => log("tray", &format!("native helper spawn failed: {e}")),
        },
        None => log("tray", "native helper binary not found in bundle"),
    }

    let app = app.clone();
    std::thread::spawn(move || {
        let Some(cf) = cmd_file() else {
            return;
        };
        // Clear any stale command from a previous run.
        let _ = std::fs::remove_file(&cf);
        loop {
            std::thread::sleep(Duration::from_millis(250));
            let Ok(cmd) = std::fs::read_to_string(&cf) else {
                continue;
            };
            let _ = std::fs::remove_file(&cf);
            let cmd = cmd.trim();
            // Menu-bar click opens the desktop workspace (first-run onboarding
            // still keeps the installer card on `main`). Parse the icon's
            // on-screen centre ("show <x>", Cocoa points) so a leftover
            // popover still anchors under the icon if onboarding is showing.
            if let Some(rest) = cmd.strip_prefix("show") {
                if let Ok(points) = rest.trim().parse::<f64>() {
                    crate::tray::set_tray_anchor_x(points);
                }
                // Window ops MUST run on the main thread — calling them from
                // this poll thread deadlocks AppKit.
                let app_main = app.clone();
                let _ = app.run_on_main_thread(move || {
                    crate::tray::activate_primary_surface(&app_main)
                });
            } else {
                match cmd {
                    "sync" => {
                        let _ = app.emit("tray:sync-now", ());
                    }
                    // Right-click menu: "Open desktop view" / "Sign Out". Both
                    // are relayed to the frontend, which routes them through
                    // the same guarded paths the popover uses (the desktop
                    // window gate is re-checked by open_desktop_alt_window).
                    "desktop" => {
                        let _ = app.emit("tray:open-desktop", ());
                    }
                    "updates" => {
                        crate::recovery::spawn_tray_check_for_updates(app.clone());
                    }
                    "recovery" => {
                        crate::recovery::spawn_tray_open_recovery(app.clone());
                    }
                    "signout" => {
                        let _ = app.emit("tray:sign-out", ());
                    }
                    "quit" => app.exit(0),
                    other => log("tray", &format!("native helper: unknown cmd '{other}'")),
                }
            }
        }
    });
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use std::sync::{Arc, Barrier};

    #[test]
    fn writes_private_atomic_badge_snapshots() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join(".tray-badge");

        write_badge_file(&path, 7).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "7");
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );

        write_badge_file(&path, 105).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "105");
        assert!(!temp
            .path()
            .join(format!(".tray-badge.{}.tmp", std::process::id()))
            .exists());
    }

    #[test]
    fn serializes_concurrent_badge_writers() {
        let temp = tempfile::tempdir().unwrap();
        let path = Arc::new(temp.path().join(".tray-badge"));
        let barrier = Arc::new(Barrier::new(9));
        let mut workers = Vec::new();

        for count in 1..=8u32 {
            let path = path.clone();
            let barrier = barrier.clone();
            workers.push(std::thread::spawn(move || {
                barrier.wait();
                write_badge_file(path.as_path(), count).unwrap();
            }));
        }
        barrier.wait();
        for worker in workers {
            worker.join().unwrap();
        }

        let final_count: u32 = std::fs::read_to_string(path.as_path())
            .unwrap()
            .parse()
            .unwrap();
        assert!((1..=8).contains(&final_count));
        assert_eq!(
            std::fs::metadata(path.as_path())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert!(!temp
            .path()
            .join(format!(".tray-badge.{}.tmp", std::process::id()))
            .exists());
    }
}
