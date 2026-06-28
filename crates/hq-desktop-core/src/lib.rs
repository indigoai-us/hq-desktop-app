//! `hq-desktop-core` — product-neutral foundation primitives for the HQ desktop
//! app(s). Extracted from `apps/sync/src-tauri/src/util` in Phase 4. No Tauri,
//! no app-specific couplings.

pub mod client_info;
pub mod conflicts;
pub mod cognito;
pub mod feature_gate;
pub mod hq_resolver;
pub mod ignore;
pub mod journal;
pub mod logfile;
pub mod meeting_ledger;
pub mod oauth;
pub mod paths;
pub mod recordings_ledger;
pub mod release_channel;
