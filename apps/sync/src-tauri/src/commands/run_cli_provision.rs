//! CLI provisioning — implementation lives in hq-desktop-core (Phase 4 extraction).
//! Thin facade so existing `crate::commands::run_cli_provision::*` call sites are unchanged.
pub use hq_desktop_core::run_cli_provision::*;
