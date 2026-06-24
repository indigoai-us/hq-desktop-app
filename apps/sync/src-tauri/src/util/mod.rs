// Foundation modules were extracted to the `hq-desktop-core` crate (Phase 4) and
// are re-exported here so existing `crate::util::X` call sites stay unchanged.
pub use hq_desktop_core::{hq_resolver, ignore, logfile, meeting_ledger, paths, recordings_ledger};

// Still app-local: these carry app couplings (`feature_gate` → `commands::cognito`,
// `client_info` → `env!("APP_VERSION")`) or app-only test infrastructure.
pub mod client_info;
pub mod feature_gate;
pub mod journal;
pub mod release_channel;

#[cfg(test)]
pub(crate) mod test_support;
