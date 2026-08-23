//! Meetings & recording domain for the HQ desktop app.
//!
//! Meeting detection and the Recall Desktop SDK bridge protocol (`recall_sdk`), the
//! meetings/calendar API surface (`meetings`), and the two on-disk ledgers that track
//! detected meetings (`meeting_ledger`) and recordings (`recordings_ledger`).
//!
//! This is pure domain logic: no Tauri. The app's `commands::meetings` and
//! `commands::recall_sdk` wrap these in Tauri commands, and the sidecar
//! (`recall-sdk-bridge`) speaks the ndjson protocol defined in `recall_sdk`.

pub mod meeting_ledger;
pub mod meetings;
pub mod recall_sdk;
pub mod recordings_ledger;
