//! signals-local-meetings-v1 — personal, on-device meeting signal storage.
pub mod receipt;
pub mod store;

#[cfg(test)]
#[path = "signals_local_meetings_v1_us006_acceptance.rs"]
mod us006_acceptance;
