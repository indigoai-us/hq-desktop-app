//! npx-cache prewarm — implementation lives in hq-desktop-core (Phase 4 extraction).
//! Thin facade so existing `crate::commands::prewarm::*` call sites are unchanged.
pub use hq_desktop_core::prewarm::*;
