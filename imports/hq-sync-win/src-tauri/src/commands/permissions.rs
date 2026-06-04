//! Meeting permissions surface — Windows-adapted.
//!
//! The macOS build of hq-sync needs five TCC permissions for the Recall Desktop
//! SDK (accessibility, screen-capture, microphone, system-audio, full-disk-
//! access) and ships a wizard that deep-links each System Settings pane plus a
//! `meetings_permissions_state` reader that drives an "Enabled / Setup needed"
//! pill.
//!
//! **Windows has no equivalent per-app permission system.** There is no TCC, no
//! accessibility-trust gate, and no screen-recording / microphone consent prompt
//! that an app must clear before the Recall SDK can capture — the SDK runs with
//! the user's ambient rights. So on Windows every permission is reported as
//! `Granted` (`all_required_granted = true`), the wizard renders a purely
//! informational "nothing to grant" state, and the "open settings" / "trigger
//! prompts" actions are no-ops that succeed.
//!
//! The command names and serialized shapes are kept identical to the macOS build
//! so `MeetingPermissionsWindow.svelte` + the Settings permissions row render the
//! same component on both platforms — only the values differ (always-granted on
//! Windows). The macOS objc2 / AVFoundation / TCC FFI is intentionally absent;
//! see the upstream `feature/parity` history for that path.

use serde::Serialize;

use crate::util::logfile::log;

const LOG_TAG: &str = "permissions";

/// Label of the meeting-permissions wizard window. Kept in sync with the
/// `main.ts` router branch and `capabilities/meeting-permissions.json`.
const WINDOW_LABEL: &str = "meeting-permissions";

// ─────────────────────────────────────────────────────────────────────────────
// Permission status model (shape-compatible with the macOS build)
// ─────────────────────────────────────────────────────────────────────────────

/// Status of a single permission, as surfaced to the frontend.
///
/// On macOS this is the live TCC verdict (the `Denied` / `Prompt` / `Unknown`
/// variants drive the wizard's per-row CTAs). On Windows the only value ever
/// produced is `Granted` — there is no permission to be in any other state — but
/// the full enum is kept so the serialized contract matches the macOS build and
/// the same Svelte component renders unchanged.
///
/// `#[allow(dead_code)]`: the non-`Granted` variants are never *constructed* on
/// Windows (no permission can be denied/pending/unknown here), but they are part
/// of the cross-platform JSON contract the shared Svelte component decodes, and
/// the serde round-trip is asserted in tests. Dropping them would diverge the
/// wire shape from the macOS build for no benefit.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PermStatus {
    /// Granted (or, on Windows, not-required → reported as granted).
    Granted,
    /// User denied (macOS only; never produced on Windows).
    Denied,
    /// Not yet asked (macOS only; never produced on Windows).
    Prompt,
    /// No programmatic check available (macOS Full Disk Access; never on Windows).
    Unknown,
}

/// At-a-glance status of every permission the meeting-detect-notify feature
/// needs. The Settings row collapses the required permissions to a single
/// Enabled/Setup-needed pill; the wizard window renders one row per field.
///
/// On Windows every field is `Granted` and `all_required_granted` is always
/// `true` — the meeting pipeline never has to wait on a consent gate.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingPermissionsState {
    pub accessibility: PermStatus,
    pub screen_capture: PermStatus,
    pub microphone: PermStatus,
    pub system_audio: PermStatus,
    pub full_disk_access: PermStatus,
    pub all_required_granted: bool,
}

impl MeetingPermissionsState {
    /// The Windows state: everything granted / not-required.
    fn all_granted() -> Self {
        Self {
            accessibility: PermStatus::Granted,
            screen_capture: PermStatus::Granted,
            microphone: PermStatus::Granted,
            system_audio: PermStatus::Granted,
            full_disk_access: PermStatus::Granted,
            all_required_granted: true,
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────────────────────

/// Read the meeting-permission status. On Windows this is constant — every
/// permission is granted / not-required — so it returns the all-granted state
/// without touching any OS API. Idempotent and safe to call on every Settings
/// open / window focus (the frontend re-reads on both).
#[tauri::command]
pub fn meetings_permissions_state() -> Result<MeetingPermissionsState, String> {
    Ok(MeetingPermissionsState::all_granted())
}

/// Force-register the app for the native permission prompts.
///
/// On macOS this calls the TCC APIs from the menubar binary to seed the privacy
/// panes. On Windows there is nothing to register — the SDK captures with the
/// user's ambient rights — so this is a successful no-op. The return tuple
/// mirrors the macOS `(accessibility, screen_capture)` registration result, both
/// reported `true` (granted) so the wizard's "Trigger prompts" button reports
/// success rather than an error.
#[tauri::command]
pub fn permissions_force_native_register() -> Result<(bool, bool), String> {
    log(
        LOG_TAG,
        "permissions_force_native_register: no-op on Windows (no permission system)",
    );
    Ok((true, true))
}

/// Open the OS settings pane for `permission`.
///
/// On macOS this deep-links the relevant Privacy & Security pane. On Windows
/// there is no per-app permission pane to open for these capabilities, so this
/// is a successful no-op (the wizard renders an informational state and never
/// shows an "Open Settings" CTA on Windows — but the command is kept callable so
/// any shared frontend code path can invoke it without erroring).
#[tauri::command]
pub fn permissions_open_settings(permission: String) -> Result<(), String> {
    log(
        LOG_TAG,
        &format!(
            "permissions_open_settings: no-op on Windows for {permission} (no permission system)"
        ),
    );
    Ok(())
}

/// Open (or focus) the meeting-permissions wizard window. Same focus-or-build
/// handshake as `open_meetings_window` / `open_share_detail`: if the window
/// already exists, bring it to the front; otherwise build it fresh.
///
/// The wizard is a single-page Svelte view at the `meeting-permissions` window
/// label that calls `meetings_permissions_state` on mount + focus. On Windows it
/// renders the informational "nothing to grant" state. The window gets the same
/// Mica/Acrylic vibrancy as the other secondary windows.
#[tauri::command]
pub async fn open_meeting_permissions_window(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;

    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }

    // Re-use the bundled HQ app icon so the wizard has the right taskbar /
    // Alt-Tab representation (matches open_meetings_window).
    const HQ_ICON_PNG: &[u8] = include_bytes!("../../icons/128x128@2x.png");
    let icon = tauri::image::Image::from_bytes(HQ_ICON_PNG)
        .map_err(|e| format!("load window icon: {e}"))?;

    // Build hidden, apply vibrancy, then show — same ordering as
    // `drift_detail` / `activity` so the user never sees a flash of the
    // un-styled transparent frame before Mica/Acrylic lands.
    let window = tauri::WebviewWindowBuilder::new(
        &app,
        WINDOW_LABEL,
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("Meeting Permissions")
    .inner_size(560.0, 520.0)
    .min_inner_size(480.0, 420.0)
    .resizable(true)
    .decorations(true)
    .transparent(true)
    .icon(icon)
    .map_err(|e| format!("attach window icon: {e}"))?
    .visible(false)
    .build()
    .map_err(|e| e.to_string())?;

    // Apply Mica (Win 11) / Acrylic (Win 10) so the wizard matches the popover
    // and other secondary windows' liquid-glass look. Best-effort — the Svelte
    // view ships a solid-background fallback. (Reuses the crate-root helper the
    // main window + drift/activity windows use.)
    crate::apply_windows_vibrancy(&window);

    window.show().map_err(|e| e.to_string())?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_state_is_all_granted() {
        let s = MeetingPermissionsState::all_granted();
        assert_eq!(s.accessibility, PermStatus::Granted);
        assert_eq!(s.screen_capture, PermStatus::Granted);
        assert_eq!(s.microphone, PermStatus::Granted);
        assert_eq!(s.system_audio, PermStatus::Granted);
        assert_eq!(s.full_disk_access, PermStatus::Granted);
        assert!(s.all_required_granted);
    }

    #[test]
    fn perm_status_serializes_kebab_case() {
        // The Svelte component keys on these string values; lock the contract.
        assert_eq!(
            serde_json::to_string(&PermStatus::Granted).unwrap(),
            "\"granted\""
        );
        assert_eq!(
            serde_json::to_string(&PermStatus::Denied).unwrap(),
            "\"denied\""
        );
        assert_eq!(
            serde_json::to_string(&PermStatus::Prompt).unwrap(),
            "\"prompt\""
        );
        assert_eq!(
            serde_json::to_string(&PermStatus::Unknown).unwrap(),
            "\"unknown\""
        );
    }

    #[test]
    fn state_serializes_camel_case_all_required_granted() {
        let json = serde_json::to_string(&MeetingPermissionsState::all_granted()).unwrap();
        assert!(
            json.contains("\"allRequiredGranted\":true"),
            "camelCase rollup field missing: {json}"
        );
        assert!(
            json.contains("\"screenCapture\":\"granted\""),
            "got: {json}"
        );
        assert!(
            json.contains("\"fullDiskAccess\":\"granted\""),
            "got: {json}"
        );
    }
}
