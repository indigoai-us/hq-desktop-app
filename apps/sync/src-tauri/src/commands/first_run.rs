//! First-run / first-update onboarding classification + persisted flags.
//!
//! Three launch kinds, classified once at app `.setup()` time and cached in
//! Tauri managed state so the verdict is stable for the whole process:
//!
//!   - **FirstRun**       brand-new install — never run this app before.
//!   - **ExistingUpdate** a legacy user who updated to a build that has the
//!                        new onboarding flags (and so hasn't seen the
//!                        auto-sync notice yet).
//!   - **Normal**         everything after the first-run sequence completes.
//!
//! ## Why classification must run BEFORE `ensure_machine_id`
//!
//! Both FirstRun and ExistingUpdate lack the new `firstRunCompleted` flag, so
//! that flag alone can't tell them apart. The tiebreaker is `machineId`:
//! `config::ensure_machine_id` writes it to `menubar.json` on the *first ever*
//! launch, so an existing user already has it while a brand-new install does
//! not (the installer writes `hqPath` but never `machineId`). We therefore
//! snapshot the classification at the very top of `.setup()` — before
//! `ensure_machine_id` runs and populates `machineId` for everyone — and stash
//! the result in managed state.
//!
//! All writes use the same untyped-merge + atomic-rename algorithm as
//! `config::ensure_machine_id`: read `menubar.json` as an untyped `Map`, mutate
//! only the target keys, atomic-rename back. The typed `MenubarPrefs` is
//! deliberately NOT used for writes here — a typed round-trip would silently
//! drop unknown / future top-level keys.

use serde_json::Value;
use tauri::{AppHandle, Manager, State};

use crate::util::paths;

pub use hq_desktop_core::first_run::{
    classify_from_map, merge_menubar_flags, notice_shown_in_map, read_menubar_obj, LaunchKind,
};

/// Managed-state wrapper so the launch verdict survives the rest of the
/// process even after `machineId` gets written this launch.
pub struct LaunchKindState(pub LaunchKind);

/// Classify this launch and stash the verdict in managed state. MUST be called
/// at the top of `.setup()`, before `config::ensure_machine_id` populates
/// `machineId`.
pub fn classify_launch(app: &AppHandle) {
    let kind = match paths::menubar_json_path() {
        Ok(path) => classify_from_map(&read_menubar_obj(&path)),
        // No resolvable home dir → treat as a fresh, safe default. A
        // brand-new machine is the conservative assumption here.
        Err(_) => LaunchKind::FirstRun,
    };
    app.manage(LaunchKindState(kind));
}

/// True only on a brand-new install's first launch.
#[tauri::command]
pub fn is_first_run(state: State<'_, LaunchKindState>) -> bool {
    state.0 == LaunchKind::FirstRun
}

/// True when a legacy user updated to this build, hasn't seen the auto-sync
/// notice yet, AND still has auto-sync on. A user who explicitly turned
/// auto-sync off (`realtimeSync: false`) made a deliberate choice and gets no
/// "auto-sync is on" notice — notify-only, respect opt-outs.
#[tauri::command]
pub fn should_show_auto_sync_notice(state: State<'_, LaunchKindState>) -> bool {
    if state.0 != LaunchKind::ExistingUpdate {
        return false;
    }
    let notice_shown = paths::menubar_json_path()
        .map(|p| notice_shown_in_map(&read_menubar_obj(&p)))
        .unwrap_or(false);
    if notice_shown {
        return false;
    }
    // Respect an explicit opt-out (default-on when the field is absent).
    crate::commands::daemon::is_realtime_sync_enabled()
}

/// Mark the brand-new-install onboarding as finished. Persists
/// `firstRunCompleted` + `autoSyncNoticeShown` (new users got the carousel, so
/// skip the separate notice) and makes "sync is on" explicit by writing
/// `realtimeSync` + `personalSyncEnabled` true.
#[tauri::command]
pub fn mark_first_run_complete() -> Result<(), String> {
    let path = paths::menubar_json_path()?;
    merge_menubar_flags(
        &path,
        &[
            ("firstRunCompleted", Value::Bool(true)),
            ("autoSyncNoticeShown", Value::Bool(true)),
            ("realtimeSync", Value::Bool(true)),
            ("personalSyncEnabled", Value::Bool(true)),
        ],
    )
}

/// Mark the one-time auto-sync notice as shown for an updating user. Also sets
/// `firstRunCompleted` so the next launch classifies as `Normal`. Deliberately
/// does NOT touch `realtimeSync` — opt-outs are respected.
#[tauri::command]
pub fn mark_auto_sync_notice_shown() -> Result<(), String> {
    let path = paths::menubar_json_path()?;
    merge_menubar_flags(
        &path,
        &[
            ("autoSyncNoticeShown", Value::Bool(true)),
            ("firstRunCompleted", Value::Bool(true)),
        ],
    )
}
