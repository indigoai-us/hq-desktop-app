//! Post-sync git mirror — implementation lives in hq-desktop-core (Phase 4 extraction).
//! Thin facade so existing `crate::commands::git_mirror::*` call sites are unchanged.
pub use hq_desktop_core::git_mirror::*;
