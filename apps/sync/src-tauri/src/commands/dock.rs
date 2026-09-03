//! macOS Dock icon presence.
//!
//! HQ shows a Dock icon by default; users can opt out from Settings and get the
//! menubar-only app back. The bundle stays `LSUIElement=true` (see
//! `Info.plist`) so the process still *launches* as an accessory and is
//! promoted from there — that keeps the login start quiet and avoids the
//! flakier Regular→Accessory demotion for opted-out users. The posture is
//! decided from the `dockIcon` preference:
//!
//!   * `dockIcon: true` (**default**, absent → true) →
//!     `ActivationPolicy::Regular`. Dock icon, Cmd-Tab entry, standard app menu
//!     bar. Promoting an `LSUIElement` process with
//!     `-[NSApplication setActivationPolicy:]` is the supported way to do this;
//!     it's the same technique every menubar app with a "Show in Dock"
//!     preference uses.
//!   * `dockIcon: false` → `ActivationPolicy::Accessory`. The classic
//!     menubar-only posture: the tray icon is the only surface.
//!
//! The Dock icon *image* is already registered at launch — `main.rs` calls
//! `set_app_icon_from_bytes` with the bundled HQ mark, so the Dock renders the
//! HQ glyph rather than a generic bundle icon.
//!
//! ## Why the widget is unaffected
//!
//! `commands/widget.rs` documents its non-activating behaviour as
//! `.focusable(false)` *paired with* `ActivationPolicy::Accessory`. The load
//! bearing half is `.focusable(false)`: it makes the NSWindow refuse key
//! status, so hover/clicks on the floating wordmark cannot steal focus no
//! matter which activation policy the app runs under. Regular policy therefore
//! does not regress the widget.
//!
//! ## Two apply paths, and why they are not interchangeable
//!
//! [`apply_at_launch`] (`&mut App`) and [`apply_at_runtime`] (`AppHandle`) look
//! like the same call but reach different tao code, and swapping them is a
//! silent no-op that only reproduces on a real Mac. The full explanation lives
//! on [`apply_at_launch`] — read it before touching either.
//!
//! ## Prefs
//!
//! Typed as `MenubarPrefs::dock_icon` so the Settings toggle round-trips
//! through `get_settings` / `save_settings` without being wiped, and read
//! straight off disk here so the toggle takes effect without a restart —
//! mirroring `autostart::start_at_login_pref`.

use crate::commands::config::MenubarPrefs;
use crate::util::logfile::log;
use crate::util::paths;

const LOG_TAG: &str = "dock";

/// Resolve the effective `dockIcon` preference.
///
/// Default-ON: `None` prefs (no menubar.json at all) and a missing `dockIcon`
/// key both mean "show the Dock icon", so a fresh install and every existing
/// install pick it up without touching Settings. Only an explicit `false` opts
/// out. Same default-on convention as `start_at_login` / `widget_enabled`.
///
/// Kept pure (takes parsed prefs) so the default contract is unit testable on
/// any platform, without a Tauri runtime or a real `~/.hq/menubar.json`.
pub fn effective_dock_icon(prefs: Option<&MenubarPrefs>) -> bool {
    prefs.and_then(|p| p.dock_icon).unwrap_or(true)
}

/// Read `dockIcon` from ~/.hq/menubar.json (best-effort), applying the
/// default-on semantics of [`effective_dock_icon`].
///
/// Any failure to locate, read, or parse the file resolves to the default
/// (Dock icon shown) rather than silently demoting the app to accessory — a
/// corrupt prefs file must not make HQ vanish from the Dock. The read failure
/// is logged so the Connect diagnostics surface still shows it.
pub fn dock_icon_pref() -> bool {
    effective_dock_icon(read_prefs().as_ref())
}

/// Best-effort parse of ~/.hq/menubar.json.
///
/// `None` covers both "no preferences yet" (fresh install — the default
/// applies) and "preferences unreadable". The unreadable cases are logged
/// rather than swallowed, so a corrupt prefs file shows up in the diagnostic
/// log instead of silently presenting as a never-configured install.
fn read_prefs() -> Option<MenubarPrefs> {
    let path = match paths::menubar_json_path() {
        Ok(path) => path,
        Err(e) => {
            log(LOG_TAG, &format!("menubar.json path unresolved: {e}"));
            return None;
        }
    };
    if !path.exists() {
        return None;
    }
    let contents = match std::fs::read_to_string(&path) {
        Ok(contents) => contents,
        Err(e) => {
            log(LOG_TAG, &format!("menubar.json read failed: {e}"));
            return None;
        }
    };
    match serde_json::from_str::<MenubarPrefs>(&contents) {
        Ok(prefs) => Some(prefs),
        Err(e) => {
            log(LOG_TAG, &format!("menubar.json parse failed: {e}"));
            None
        }
    }
}

/// Map a resolved preference to its activation policy. Pure.
#[cfg(target_os = "macos")]
pub fn policy_for(show_dock_icon: bool) -> tauri::ActivationPolicy {
    if show_dock_icon {
        tauri::ActivationPolicy::Regular
    } else {
        tauri::ActivationPolicy::Accessory
    }
}

/// LAUNCH path — apply the preference from `main.rs` `.setup()`.
///
/// **This MUST use `App::set_activation_policy` (the `&mut App` setter), not
/// the `AppHandle` one.** They are not interchangeable, and picking the wrong
/// one is a silent no-op that only shows up on a real Mac:
///
///   * `App::set_activation_policy` reaches `EventLoopExtMacOS::
///     set_activation_policy`, which *stores* the policy in tao's delegate
///     aux-state.
///   * `AppHandle::set_activation_policy` posts a runtime message that calls
///     `-[NSApp setActivationPolicy:]` *immediately*.
///
/// `.setup()` runs before the event loop starts. At
/// `applicationDidFinishLaunching`, tao's `AppState::launched` calls
/// `apply_activation_policy`, which unconditionally re-applies the **stored**
/// aux-state value — clobbering anything set imperatively beforehand. Since
/// tao's stored default is `Regular`, using the AppHandle setter here would
/// leave every launch on `Regular` no matter what the user chose — silently
/// breaking the opt-out for anyone who turned the Dock icon off. tao delays
/// the apply on purpose (their comment: the menu bar isn't interactable
/// otherwise), so storing the value is the supported path, not a workaround.
///
/// Note this is why the launch call is unconditional rather than "only when
/// opted out": tao would otherwise apply its own `Regular` default and the
/// menubar-only posture would never happen.
///
/// Returns `()` because the `&mut App` setter is infallible.
#[cfg(target_os = "macos")]
pub fn apply_at_launch(app: &mut tauri::App, show_dock_icon: bool) {
    app.set_activation_policy(policy_for(show_dock_icon));
    log(LOG_TAG, launch_log_line(show_dock_icon));
}

/// RUNTIME path — re-apply the preference after the event loop is running.
///
/// Safe to use the `AppHandle` setter here precisely because
/// `applicationDidFinishLaunching` has already been and gone, so nothing will
/// re-apply the stored aux-state over the top. The message is handled on the
/// event-loop (main) thread, so no manual `run_on_main_thread` hop is needed —
/// unlike the NSWindow work in `apply_widget_settings`.
#[cfg(target_os = "macos")]
pub fn apply_at_runtime(app: &tauri::AppHandle, show_dock_icon: bool) -> Result<(), String> {
    app.set_activation_policy(policy_for(show_dock_icon))
        .map_err(|e| format!("set_activation_policy failed: {e}"))?;
    log(LOG_TAG, runtime_log_line(show_dock_icon));
    Ok(())
}

#[cfg(target_os = "macos")]
fn launch_log_line(show_dock_icon: bool) -> &'static str {
    if show_dock_icon {
        "launch: activation policy = Regular (Dock icon shown)"
    } else {
        "launch: activation policy = Accessory (Dock icon hidden)"
    }
}

#[cfg(target_os = "macos")]
fn runtime_log_line(show_dock_icon: bool) -> &'static str {
    if show_dock_icon {
        "runtime: activation policy = Regular (Dock icon shown)"
    } else {
        "runtime: activation policy = Accessory (Dock icon hidden)"
    }
}

// ── Dock badge (unread messages) ─────────────────────────────────────────────

/// Above this, the badge renders as "99+" rather than a wide number.
///
/// The Dock tile badge is a small circle; a 4-digit count renders as an
/// unreadable smear and stretches the tile. Every mainstream Mac app caps it.
#[cfg(target_os = "macos")]
const BADGE_CAP: u32 = 99;

/// Render an unread count as a Dock badge label.
///
/// `None` means "clear the badge". Zero unread MUST map to `None`, not
/// `Some("0")` — a Dock badge reading "0" is worse than no badge, and it is
/// exactly what Tauri's own `Window::set_badge_count` produces on macOS: its
/// runtime maps `SetBadgeCount(n)` straight to `set_badge_label(n.to_string())`,
/// so `Some(0)` paints a literal "0" despite the API docs claiming 0 clears it.
/// That mismatch is why this module calls `set_badge_label` with its own
/// formatting rather than using `set_badge_count`.
///
/// Pure, so the cap and the zero case are unit-testable without a Dock.
/// macOS-only alongside its single caller: no other platform has a Dock tile,
/// and an ungated helper would be dead code on Windows/Linux.
#[cfg(target_os = "macos")]
pub fn format_badge_label(unread: u32) -> Option<String> {
    match unread {
        0 => None,
        n if n > BADGE_CAP => Some(format!("{BADGE_CAP}+")),
        n => Some(n.to_string()),
    }
}

/// Mirror the unread-message count onto the macOS Dock badge.
///
/// Called from the two places that own the unread count
/// (`dm_notify::bump_unread` and `dm_notify::reset_unread_dms`), so the badge
/// is a pure function of that state and needs no poller or frontend round-trip.
///
/// Deliberately NOT gated on the `dockIcon` preference. Two reasons: reading
/// menubar.json on every DM poll would put a file read on a hot path, and the
/// Dock tile keeps its badge across an activation-policy change — so setting it
/// unconditionally means a user who opts in mid-session sees the correct count
/// immediately instead of waiting for the next message. While the app is in
/// `Accessory` there is no Dock tile on screen, so the call is a harmless no-op.
///
/// Best-effort: a missing `main` window (shouldn't happen — it's declared in
/// tauri.conf.json) or a failed set is logged, never propagated. A wrong badge
/// must not break message delivery.
pub fn set_badge<R: tauri::Runtime>(app: &tauri::AppHandle<R>, unread: u32) {
    #[cfg(target_os = "macos")]
    {
        use tauri::Manager;

        let label = format_badge_label(unread);
        let Some(window) = app.get_webview_window("main") else {
            log(LOG_TAG, "badge: no `main` window to set the Dock badge on");
            return;
        };
        // The Dock tile is app-global on macOS; the window here is only the
        // handle Tauri routes the call through, so `main` is an arbitrary but
        // always-present choice. Marshalled to the event-loop thread by the
        // runtime, same as the activation policy — no manual hop needed.
        match window.set_badge_label(label.clone()) {
            Ok(()) => log(
                LOG_TAG,
                &match label {
                    Some(ref l) => format!("badge: set to {l} ({unread} unread)"),
                    None => "badge: cleared (0 unread)".to_string(),
                },
            ),
            Err(e) => log(LOG_TAG, &format!("badge: set_badge_label failed: {e}")),
        }
    }

    // No Dock on Windows/Linux. Windows taskbar badging would need
    // `set_overlay_icon` (an image, not a label) — out of scope here.
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, unread);
    }
}

/// Re-apply the stored `dockIcon` preference to the already-running app.
///
/// Called by the Settings toggle after `save_settings` persists the new value,
/// so flipping the switch takes effect immediately instead of at next launch.
/// Errors are returned so the Settings UI can surface a failed apply (disk is
/// already authoritative at that point).
#[tauri::command]
pub async fn apply_dock_icon(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        apply_at_runtime(&app, dock_icon_pref())
    }

    // Windows/Linux have no activation policy; the taskbar entry is owned by
    // the window manager. Accept the call so the shared Settings surface can
    // stay platform-agnostic.
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prefs_with_dock(dock_icon: Option<bool>) -> MenubarPrefs {
        MenubarPrefs {
            hq_path: None,
            cloud_paused: None,
            sync_on_launch: None,
            notifications: None,
            start_at_login: None,
            autostart_daemon: None,
            realtime_sync: None,
            personal_sync_enabled: None,
            instant_sync: None,
            sync_bandwidth_percent: None,
            drift_staging_repo: None,
            share_notifications: None,
            dm_notifications: None,
            custom_banner: None,
            cli_auto_update: None,
            auto_update: None,
            staging_channel: None,
            release_channel: None,
            meeting_detect_notify: None,
            default_recording_company_uid: None,
            telemetry_enabled: None,
            claude_projects_dir: None,
            widget_enabled: None,
            widget_display: None,
            widget_placement: None,
            widget_auto_hide_seconds: None,
            widget_show_needs_action: None,
            dock_icon,
            hq_work_handoff: None,
            system_notifications: None,
            native_notify_direct_messages: None,
            native_notify_shares: None,
            native_notify_meetings: None,
            native_notify_only_when_unfocused: None,
        }
    }

    #[test]
    fn test_effective_dock_icon_defaults_on_when_no_prefs() {
        // No menubar.json at all (fresh install) -> Dock icon shown.
        assert!(effective_dock_icon(None));
    }

    #[test]
    fn test_effective_dock_icon_defaults_on_when_field_missing() {
        // menubar.json exists but predates the pref -> Dock icon shown, so
        // existing installs pick it up on upgrade without visiting Settings.
        assert!(effective_dock_icon(Some(&prefs_with_dock(None))));
    }

    #[test]
    fn test_effective_dock_icon_explicit_true() {
        assert!(effective_dock_icon(Some(&prefs_with_dock(Some(true)))));
    }

    #[test]
    fn test_effective_dock_icon_explicit_false_opts_out() {
        // The ONLY way back to the menubar-only posture.
        assert!(!effective_dock_icon(Some(&prefs_with_dock(Some(false)))));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn test_badge_zero_clears_rather_than_showing_a_literal_zero() {
        // The whole reason this module formats its own label instead of using
        // Tauri's `set_badge_count`: that path stringifies 0 into a "0" badge.
        assert_eq!(format_badge_label(0), None);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn test_badge_shows_exact_count_up_to_the_cap() {
        assert_eq!(format_badge_label(1).as_deref(), Some("1"));
        assert_eq!(format_badge_label(9).as_deref(), Some("9"));
        assert_eq!(format_badge_label(99).as_deref(), Some("99"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn test_badge_caps_above_99() {
        assert_eq!(format_badge_label(100).as_deref(), Some("99+"));
        assert_eq!(format_badge_label(1_000).as_deref(), Some("99+"));
        assert_eq!(format_badge_label(u32::MAX).as_deref(), Some("99+"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn test_badge_label_never_exceeds_three_characters() {
        // Keeps the Dock tile circle from stretching, for every possible input
        // at the boundaries and beyond.
        for n in [0u32, 1, 9, 10, 98, 99, 100, 101, 9_999, u32::MAX] {
            if let Some(label) = format_badge_label(n) {
                assert!(
                    label.chars().count() <= 3,
                    "label {label:?} for {n} is too wide for the Dock tile"
                );
            }
        }
    }

    #[test]
    fn test_dock_icon_absent_from_serialized_prefs_when_none() {
        // `skip_serializing_if` keeps the key out of menubar.json until the
        // user actually touches the toggle, so "never chosen" stays
        // distinguishable from "explicitly enabled" on disk.
        let json = serde_json::to_string(&prefs_with_dock(None)).expect("serialize");
        assert!(!json.contains("dockIcon"), "unexpected key in {json}");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn test_policy_for_maps_the_pref_to_the_right_activation_policy() {
        // `ActivationPolicy` is #[non_exhaustive] with no PartialEq, so match
        // rather than assert_eq.
        assert!(matches!(policy_for(true), tauri::ActivationPolicy::Regular));
        assert!(matches!(
            policy_for(false),
            tauri::ActivationPolicy::Accessory
        ));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn test_launch_and_runtime_log_lines_are_distinguishable() {
        // The launch and runtime paths use different Tauri setters for a
        // load-bearing reason (see `apply_at_launch`); keeping their log lines
        // distinct is what makes a regression visible in ~/.hq's debug log.
        assert!(launch_log_line(true).starts_with("launch:"));
        assert!(launch_log_line(true).contains("Regular"));
        assert!(launch_log_line(false).contains("Accessory"));
        assert!(runtime_log_line(true).starts_with("runtime:"));
        assert!(runtime_log_line(true).contains("Regular"));
        assert!(runtime_log_line(false).contains("Accessory"));
    }

    #[test]
    fn test_dock_icon_round_trips_as_camel_case() {
        let json = serde_json::to_string(&prefs_with_dock(Some(false))).expect("serialize");
        assert!(
            json.contains("\"dockIcon\":false"),
            "unexpected shape: {json}"
        );

        let parsed: MenubarPrefs = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(parsed.dock_icon, Some(false));
        assert!(!effective_dock_icon(Some(&parsed)));
    }
}
