//! Post-sync git mirror — implementation lives in hq-desktop-core (Phase 4 extraction).
//! Thin facade so existing `crate::commands::git_mirror::*` call sites are unchanged.
pub use hq_desktop_core::git_mirror::*;

/// Cache the current hq-flags snapshot for mirrors launched by either sync
/// event path. A missing registry row or failed read is sent as `false`.
#[tauri::command]
pub fn set_mirror_quarantine_move_not_deletion(enabled: bool) {
    hq_desktop_core::git_mirror::set_scope_quarantine_move_not_deletion_enabled(enabled);
}
