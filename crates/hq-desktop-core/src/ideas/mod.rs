//! Idea Board capture records (US-002).
//!
//! A capture is a single screenshot-derived record living in the active
//! company's vault:
//!
//! ```text
//! {hq_root}/companies/{company_slug}/ideas/{id}/record.json
//! {hq_root}/companies/{company_slug}/ideas/{id}/image.png
//! ```
//!
//! Both files sit inside the existing vault sync scope (`companies/…`), so a
//! capture syncs with the rest of the company without extra plumbing.
//!
//! Design deltas honored here (see `companies/indigo/projects/hq-idea-board/
//! design/design.md`): confidence + status are first-class fields; company
//! attribution is a stored slug with an explicit [`storage::move_record`]
//! operation; retention is downsample-on-write and never auto-delete.

pub mod record;
pub mod storage;

pub use record::{
    CaptureKind, CaptureRecord, CaptureStatus, IdeasError, Provenance, MAX_IMAGE_EDGE,
};
pub use storage::{
    create_record, downsample, ideas_dir, load_record, move_record, record_dir, save_record,
    CaptureImage, NewCapture,
};
