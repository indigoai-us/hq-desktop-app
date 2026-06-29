//! `hq-desktop-core` — product-neutral foundation primitives for the HQ desktop
//! app(s). Extracted from `apps/sync/src-tauri/src/util` in Phase 4. No Tauri,
//! no app-specific couplings.

pub mod client_info;
pub mod cognito;
pub mod config;
pub mod conflicts;
pub mod drift_scope;
pub mod events;
pub mod feature_gate;
pub mod first_run;
pub mod git_mirror;
pub mod hq_cloud;
pub mod hq_resolver;
pub mod hq_version;
pub mod ignore;
pub mod journal;
pub mod library_local;
pub mod logfile;
pub mod marketplace;
pub mod meeting_ledger;
pub mod oauth;
pub mod paths;
pub mod prewarm;
pub mod projects_local;
pub mod recordings_ledger;
pub mod release_channel;
pub mod run_cli_provision;
pub mod sessions;
pub mod settings;
pub mod staging;
pub mod status;
pub mod sync_outcome;
pub mod sync_progress;
pub mod workspaces;

#[cfg(test)]
pub(crate) mod test_support;
