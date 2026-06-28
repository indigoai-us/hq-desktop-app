//! Sync-journal store — implementation lives in hq-desktop-core (Phase 4 extraction).
//! Thin facade so existing `crate::util::journal::*` call sites are unchanged.

pub use hq_desktop_core::journal::*;
