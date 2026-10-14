//! signals-local-meetings-v1 — personal, on-device meeting signal storage.
pub mod extractor;
pub mod ontology_tools;
pub mod receipt;
pub mod sanitize;
pub mod store;

#[cfg(test)]
#[path = "signals_local_meetings_v1_us006_acceptance.rs"]
mod us006_acceptance;

#[cfg(test)]
#[path = "signals_local_meetings_v1_us007_acceptance.rs"]
mod us007_acceptance;
