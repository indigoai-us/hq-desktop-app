//! Cognito token domain — implementation lives in hq-desktop-core (Phase 4 extraction).
//! Thin facade so existing `crate::commands::cognito::*` / `super::cognito::*` call sites are unchanged.

pub use hq_desktop_core::cognito::*;
