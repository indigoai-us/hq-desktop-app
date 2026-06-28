// Foundation modules were extracted to the `hq-desktop-core` crate (Phase 4) and
// are re-exported here so existing `crate::util::X` call sites stay unchanged.
// The former app couplings are now injected at startup in `main.rs`:
//   - client_info: `set_client_version(env!("APP_VERSION"))`
//   - feature_gate: `set_email_claim_fetcher(..)` wired to Cognito
pub use hq_desktop_core::{
    client_info, feature_gate, hq_resolver, ignore, logfile, meeting_ledger, paths,
    recordings_ledger, release_channel,
};

// Journal remains as an app-local facade; test_support stays app-local.
pub mod journal;

#[cfg(test)]
pub(crate) mod test_support;
