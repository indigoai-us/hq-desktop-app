//! `hq-desktop-core` — product-neutral foundation primitives for the HQ desktop
//! app(s). Extracted from `apps/sync/src-tauri/src/util` in Phase 4. No Tauri,
//! no app-specific couplings.

// --- HQ-DESKTOP-6C: best-effort stdio diagnostics -------------------------
//
// Shadow the std print macros with this crate's best-effort variants so every
// `eprintln!`/`eprint!`/`println!`/`print!` below writes diagnostics without
// panicking when fd 1/2 is closed or a broken pipe (see `process_stdio`). std's
// `print_to` panics on any write error but `EBADF`; on a tokio worker thread
// that unwinds the task and silently kills it.
//
// ORDER IS LOAD-BEARING: a `macro_rules!` shadow is textually scoped, so it only
// covers modules declared *after* it. These definitions MUST stay above the
// first `mod`/`pub mod` below, or the modules above them silently revert to the
// panicking std macros. `scripts/process-stdio-contract.test.ts` fails if this
// order changes or a shadow is removed. `#[cfg(not(test))]` keeps libtest output
// capture (which hooks the std macros) unchanged under `cargo test`.
#[cfg(not(test))]
#[allow(unused_macros)]
macro_rules! eprintln {
    ($($arg:tt)*) => { $crate::best_effort_eprintln!($($arg)*) };
}
#[cfg(not(test))]
#[allow(unused_macros)]
macro_rules! eprint {
    ($($arg:tt)*) => { $crate::best_effort_eprint!($($arg)*) };
}
#[cfg(not(test))]
#[allow(unused_macros)]
macro_rules! println {
    ($($arg:tt)*) => { $crate::best_effort_println!($($arg)*) };
}
#[cfg(not(test))]
#[allow(unused_macros)]
macro_rules! print {
    ($($arg:tt)*) => { $crate::best_effort_print!($($arg)*) };
}

pub mod activity;
pub mod agency;
pub mod agent_join;
pub mod bandwidth;
pub mod banner;
pub mod claude_launch;
pub mod cli_update_lock;
pub mod client_diagnostics;
pub mod client_health;
pub mod client_info;
pub mod cognito;
pub mod config;
pub mod conflicts;
pub mod continuation_custody;
pub mod continuation_endpoints;
pub mod cpu_throttle;
pub mod daemon;
pub mod deep_link;
pub mod desktop_alt;
pub mod dm_notify;
pub mod drift_scope;
pub mod events;
pub mod feature_gate;
pub mod first_push;
pub mod first_run;
pub mod git_mirror;
pub mod hq_cli_update;
pub mod hq_cloud;
pub mod hq_context;
pub mod hq_resolver;
pub mod hq_version;
pub mod ignore;
pub mod journal;
pub mod library_local;
pub mod lifecycle;
pub mod logfile;
pub mod marketplace;
pub mod meeting_ledger;
pub mod meetings;
pub mod message_search;
pub mod messages;
pub mod native_notify;
pub mod notify_authz;
pub mod oauth;
pub mod paths;
pub mod prewarm;
pub mod process_stdio;
pub mod qmd_abi;
pub mod process_types;
pub mod projects_local;
pub mod recall_sdk;
pub mod recordings_ledger;
pub mod release_channel;
pub mod request_policy;
pub mod run_cli_provision;
pub mod runner_diagnostic_report;
pub mod runner_error_shape;
pub mod runner_target;
pub mod runtime_diagnosis;
pub mod scope_gate;
pub mod settings;
pub mod share_notify;
pub mod skill_catalog;
pub mod staging;
pub mod status;
pub mod stdio;
pub mod agent_usage_scan;
pub mod session_continuation;
pub mod sync_outcome;
pub mod sync_progress;
pub mod toolchain;
pub mod watcher_fault;
pub mod win32_path;
pub mod workspaces;

#[cfg(test)]
pub(crate) mod test_support;

