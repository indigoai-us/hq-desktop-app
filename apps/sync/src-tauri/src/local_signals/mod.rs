//! signals-local-meetings-v1 — personal, on-device meeting signal storage.
pub mod eligibility;
pub mod extractor;
pub mod ontology_tools;
pub mod receipt;
pub mod results;
pub mod sanitize;
pub mod store;
pub mod upload;

#[cfg(test)]
#[path = "signals_local_meetings_v1_us006_acceptance.rs"]
mod us006_acceptance;

#[cfg(test)]
#[path = "signals_local_meetings_v1_us007_acceptance.rs"]
mod us007_acceptance;

#[cfg(test)]
#[path = "signals_local_meetings_v1_us009_acceptance.rs"]
mod us009_acceptance;

#[cfg(test)]
#[path = "signals_local_meetings_v1_us010_acceptance.rs"]
mod us010_acceptance;
