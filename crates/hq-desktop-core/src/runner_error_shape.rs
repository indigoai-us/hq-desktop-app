//! Content-safe *message-shape* and *path-root* attribution for runner errors.
//!
//! The existing runner-error rollups reduce every error to two axes — a
//! `RunnerErrorClass` (eperm/eacces/…/other) and a Node-errno
//! `RunnerErrorOp` (rename/unlink/…/other). At scale, the @indigoai-us/hq-cloud
//! pull leg emits prose that carries neither a Node errno grammar nor a
//! recognised class, so both axes collapse to `OTHER`/`other` and a
//! seven-thousand-error flood becomes indistinguishable from a dozen unrelated
//! producers. This module adds two additive, content-safe axes that discriminate
//! among those messages without ever sending a byte of runner output:
//!
//! * a **message shape** derived from narrow, case-insensitive substrings taken
//!   verbatim from the hq-cloud v6.14.x pull-leg error sites, and
//! * a **path root** derived from the fixed first path segment of the error's
//!   company-root-relative key.
//!
//! Both follow the same discipline as the existing rollups: every rendered
//! token is *selected in code* from a closed vocabulary and is never copied from
//! the untrusted runner message, path, argv, or file content. An unrecognised
//! message maps to `unknown` and an unrecognised path segment to `other` rather
//! than to a nearest guess, so the axes can only ever add information — never
//! mislabel or leak.

use crate::events::SyncEvent;

/// Sentinel `path` value the runner uses for a company-scope (non per-file)
/// error, mirroring hq-cloud's fanout error emitter. Kept as one constant so the
/// scope split and the path-root rollup agree on what "not a file path" means.
pub const COMPANY_ERROR_PATH_SENTINEL: &str = "(company)";

/// Cap on how many entries a rollup renders into a single Sentry tag value,
/// highest count first. Keeps the tag value bounded well under Sentry's 200-char
/// tag-value limit even when many distinct shapes or path roots occur in one
/// flood, while still surfacing the dominant contributors.
const ROLLUP_TAG_TOP_N: usize = 3;

/// Fixed, content-safe runner error *message shapes*.
///
/// Each variant corresponds to a narrow substring taken verbatim from an
/// hq-cloud v6.14.x pull-leg error site (see [`classify_runner_error_shape`]).
/// The values are safe for Sentry tags because they are chosen here, never
/// copied from a runner message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunnerErrorShape {
    /// "… local parent escaped the sync root" — a local path resolved outside the
    /// sync root, reported by the download, conflict-mirror, and tombstone-suppress
    /// legs alike. The actionable root cause across all three, so it is matched
    /// first.
    ContainmentEscape,
    /// "download skipped: parent directory is a dangling symlink (…)".
    DanglingSymlinkParent,
    /// "conflict convergence probe failed: …".
    ConflictProbeFailed,
    /// "conflict mirror index write failed: …".
    ConflictIndexWriteFailed,
    /// "tombstone HEAD verify failed (deferring): …".
    TombstoneHeadVerifyFailed,
    /// "tombstone unlink failed: …" and "tombstone-suppress unlink failed: …".
    TombstoneUnlinkFailed,
    /// "presigned GET content-length mismatch: …".
    ContentLengthMismatch,
    /// "presigned GET failed for <key>: <status>".
    PresignedGetFailed,
    /// "presigned HEAD failed for <key>: <status>".
    PresignedHeadFailed,
    /// "presign <op> returned no row for <key>".
    PresignNoRow,
    /// Anything the closed vocabulary does not recognise. Never a nearest guess.
    Unknown,
}

impl RunnerErrorShape {
    /// Fixed vocabulary safe for Sentry tags. Never derived from runner input.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ContainmentEscape => "containment_escape",
            Self::DanglingSymlinkParent => "dangling_symlink_parent",
            Self::ConflictProbeFailed => "conflict_probe_failed",
            Self::ConflictIndexWriteFailed => "conflict_index_write_failed",
            Self::TombstoneHeadVerifyFailed => "tombstone_head_verify_failed",
            Self::TombstoneUnlinkFailed => "tombstone_unlink_failed",
            Self::ContentLengthMismatch => "content_length_mismatch",
            Self::PresignedGetFailed => "presigned_get_failed",
            Self::PresignedHeadFailed => "presigned_head_failed",
            Self::PresignNoRow => "presign_no_row",
            Self::Unknown => "unknown",
        }
    }
}

/// Map an untrusted runner error message to a fixed shape token using narrow,
/// case-insensitive substrings taken verbatim from the cited hq-cloud sources.
///
/// The message is inspected only to *choose* a closed-vocabulary value; no part
/// of it is ever retained. Precedence is deliberate: `containment_escape` is the
/// actionable root cause and appears inside otherwise op-specific messages (e.g.
/// "tombstone-suppress unlink skipped: local parent escaped the sync root"), so
/// it is tested before the tombstone tokens. Unmatched input returns `Unknown`.
pub fn classify_runner_error_shape(message: &str) -> RunnerErrorShape {
    let msg = message.to_ascii_lowercase();
    if msg.contains("escaped the sync root") {
        RunnerErrorShape::ContainmentEscape
    } else if msg.contains("dangling symlink") {
        RunnerErrorShape::DanglingSymlinkParent
    } else if msg.contains("conflict convergence probe failed") {
        RunnerErrorShape::ConflictProbeFailed
    } else if msg.contains("conflict mirror index write failed") {
        RunnerErrorShape::ConflictIndexWriteFailed
    } else if msg.contains("tombstone head verify failed") {
        RunnerErrorShape::TombstoneHeadVerifyFailed
    } else if msg.contains("tombstone unlink failed") || msg.contains("tombstone-suppress unlink") {
        RunnerErrorShape::TombstoneUnlinkFailed
    } else if msg.contains("content-length mismatch") {
        RunnerErrorShape::ContentLengthMismatch
    } else if msg.contains("presigned get failed") {
        RunnerErrorShape::PresignedGetFailed
    } else if msg.contains("presigned head failed") {
        RunnerErrorShape::PresignedHeadFailed
    } else if msg.contains("returned no row") {
        RunnerErrorShape::PresignNoRow
    } else {
        RunnerErrorShape::Unknown
    }
}

/// Saturating per-pass counts of the closed message-shape vocabulary. Renders a
/// compact, fixed-vocabulary Sentry tag such as `containment_escape:7205,unknown:12`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RunnerErrorShapeRollup {
    containment_escape: u32,
    dangling_symlink_parent: u32,
    conflict_probe_failed: u32,
    conflict_index_write_failed: u32,
    tombstone_head_verify_failed: u32,
    tombstone_unlink_failed: u32,
    content_length_mismatch: u32,
    presigned_get_failed: u32,
    presigned_head_failed: u32,
    presign_no_row: u32,
    unknown: u32,
}

impl RunnerErrorShapeRollup {
    /// Classify one runner error message and increment its shape count.
    pub fn record(&mut self, message: &str) {
        let count = match classify_runner_error_shape(message) {
            RunnerErrorShape::ContainmentEscape => &mut self.containment_escape,
            RunnerErrorShape::DanglingSymlinkParent => &mut self.dangling_symlink_parent,
            RunnerErrorShape::ConflictProbeFailed => &mut self.conflict_probe_failed,
            RunnerErrorShape::ConflictIndexWriteFailed => &mut self.conflict_index_write_failed,
            RunnerErrorShape::TombstoneHeadVerifyFailed => &mut self.tombstone_head_verify_failed,
            RunnerErrorShape::TombstoneUnlinkFailed => &mut self.tombstone_unlink_failed,
            RunnerErrorShape::ContentLengthMismatch => &mut self.content_length_mismatch,
            RunnerErrorShape::PresignedGetFailed => &mut self.presigned_get_failed,
            RunnerErrorShape::PresignedHeadFailed => &mut self.presigned_head_failed,
            RunnerErrorShape::PresignNoRow => &mut self.presign_no_row,
            RunnerErrorShape::Unknown => &mut self.unknown,
        };
        *count = count.saturating_add(1);
    }

    /// Declaration-ordered `(token, count)` pairs. The order is the tie-break for
    /// equal counts, keeping the rendered tag stable across runs.
    fn counts(&self) -> [(&'static str, u32); 11] {
        [
            (
                RunnerErrorShape::ContainmentEscape.as_str(),
                self.containment_escape,
            ),
            (
                RunnerErrorShape::DanglingSymlinkParent.as_str(),
                self.dangling_symlink_parent,
            ),
            (
                RunnerErrorShape::ConflictProbeFailed.as_str(),
                self.conflict_probe_failed,
            ),
            (
                RunnerErrorShape::ConflictIndexWriteFailed.as_str(),
                self.conflict_index_write_failed,
            ),
            (
                RunnerErrorShape::TombstoneHeadVerifyFailed.as_str(),
                self.tombstone_head_verify_failed,
            ),
            (
                RunnerErrorShape::TombstoneUnlinkFailed.as_str(),
                self.tombstone_unlink_failed,
            ),
            (
                RunnerErrorShape::ContentLengthMismatch.as_str(),
                self.content_length_mismatch,
            ),
            (
                RunnerErrorShape::PresignedGetFailed.as_str(),
                self.presigned_get_failed,
            ),
            (
                RunnerErrorShape::PresignedHeadFailed.as_str(),
                self.presigned_head_failed,
            ),
            (RunnerErrorShape::PresignNoRow.as_str(), self.presign_no_row),
            (RunnerErrorShape::Unknown.as_str(), self.unknown),
        ]
    }

    /// Render the top-N shapes by count as a bounded Sentry tag. `None` means no
    /// runner error records were seen, so no tag should be sent.
    pub fn tag_value(&self) -> Option<String> {
        render_top_n(&self.counts(), ROLLUP_TAG_TOP_N)
    }
}

/// Fixed, content-safe first path segment of a company-root-relative error key.
///
/// These are generic HQ subtree names, carrying no company identifier or file
/// name. An unrecognised segment collapses to [`RunnerPathRoot::Other`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunnerPathRoot {
    Knowledge,
    Projects,
    Repos,
    Sources,
    Signals,
    Data,
    Settings,
    Workers,
    Registry,
    Clients,
    Core,
    Companies,
    Personal,
    Workspace,
    Other,
}

impl RunnerPathRoot {
    /// Fixed vocabulary safe for Sentry tags. Never derived from the input path.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Knowledge => "knowledge",
            Self::Projects => "projects",
            Self::Repos => "repos",
            Self::Sources => "sources",
            Self::Signals => "signals",
            Self::Data => "data",
            Self::Settings => "settings",
            Self::Workers => "workers",
            Self::Registry => "registry",
            Self::Clients => "clients",
            Self::Core => "core",
            Self::Companies => "companies",
            Self::Personal => "personal",
            Self::Workspace => "workspace",
            Self::Other => "other",
        }
    }
}

/// Map an untrusted error path to a fixed first-segment token. Only the first
/// non-empty segment is inspected, and only to select a closed-vocabulary value;
/// the returned token is always a code constant, so no path byte can leak.
pub fn classify_runner_path_root(path: &str) -> RunnerPathRoot {
    let first_segment = path
        .split(|character: char| character == '/' || character == '\\')
        .find(|segment| !segment.is_empty())
        .unwrap_or("");
    match first_segment.to_ascii_lowercase().as_str() {
        "knowledge" => RunnerPathRoot::Knowledge,
        "projects" => RunnerPathRoot::Projects,
        "repos" => RunnerPathRoot::Repos,
        "sources" => RunnerPathRoot::Sources,
        "signals" => RunnerPathRoot::Signals,
        "data" => RunnerPathRoot::Data,
        "settings" => RunnerPathRoot::Settings,
        "workers" => RunnerPathRoot::Workers,
        "registry" => RunnerPathRoot::Registry,
        "clients" => RunnerPathRoot::Clients,
        "core" => RunnerPathRoot::Core,
        "companies" => RunnerPathRoot::Companies,
        "personal" => RunnerPathRoot::Personal,
        "workspace" => RunnerPathRoot::Workspace,
        _ => RunnerPathRoot::Other,
    }
}

/// Saturating per-pass counts of the closed path-root vocabulary. Renders a
/// compact Sentry tag such as `knowledge:512,companies:11`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RunnerErrorPathRootRollup {
    knowledge: u32,
    projects: u32,
    repos: u32,
    sources: u32,
    signals: u32,
    data: u32,
    settings: u32,
    workers: u32,
    registry: u32,
    clients: u32,
    core: u32,
    companies: u32,
    personal: u32,
    workspace: u32,
    other: u32,
}

impl RunnerErrorPathRootRollup {
    /// Classify one error path and increment its path-root count.
    pub fn record(&mut self, path: &str) {
        let count = match classify_runner_path_root(path) {
            RunnerPathRoot::Knowledge => &mut self.knowledge,
            RunnerPathRoot::Projects => &mut self.projects,
            RunnerPathRoot::Repos => &mut self.repos,
            RunnerPathRoot::Sources => &mut self.sources,
            RunnerPathRoot::Signals => &mut self.signals,
            RunnerPathRoot::Data => &mut self.data,
            RunnerPathRoot::Settings => &mut self.settings,
            RunnerPathRoot::Workers => &mut self.workers,
            RunnerPathRoot::Registry => &mut self.registry,
            RunnerPathRoot::Clients => &mut self.clients,
            RunnerPathRoot::Core => &mut self.core,
            RunnerPathRoot::Companies => &mut self.companies,
            RunnerPathRoot::Personal => &mut self.personal,
            RunnerPathRoot::Workspace => &mut self.workspace,
            RunnerPathRoot::Other => &mut self.other,
        };
        *count = count.saturating_add(1);
    }

    fn counts(&self) -> [(&'static str, u32); 15] {
        [
            (RunnerPathRoot::Knowledge.as_str(), self.knowledge),
            (RunnerPathRoot::Projects.as_str(), self.projects),
            (RunnerPathRoot::Repos.as_str(), self.repos),
            (RunnerPathRoot::Sources.as_str(), self.sources),
            (RunnerPathRoot::Signals.as_str(), self.signals),
            (RunnerPathRoot::Data.as_str(), self.data),
            (RunnerPathRoot::Settings.as_str(), self.settings),
            (RunnerPathRoot::Workers.as_str(), self.workers),
            (RunnerPathRoot::Registry.as_str(), self.registry),
            (RunnerPathRoot::Clients.as_str(), self.clients),
            (RunnerPathRoot::Core.as_str(), self.core),
            (RunnerPathRoot::Companies.as_str(), self.companies),
            (RunnerPathRoot::Personal.as_str(), self.personal),
            (RunnerPathRoot::Workspace.as_str(), self.workspace),
            (RunnerPathRoot::Other.as_str(), self.other),
        ]
    }

    /// Render the top-N path roots by count as a bounded Sentry tag.
    pub fn tag_value(&self) -> Option<String> {
        render_top_n(&self.counts(), ROLLUP_TAG_TOP_N)
    }
}

/// Fixed-vocabulary description of what the bounded stderr tail actually was, so
/// a `runner_stack_shape` of `all_redacted` stops conflating "no stack was ever
/// present" (the tail was a flood of ndjson error records) with "a stack was
/// present but unrecognised".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunnerStackInput {
    /// Every tail line parsed as an ndjson `{type:"error"}` record.
    NdjsonErrorRecords,
    /// No tail line parsed as any ndjson protocol record — a plain stderr tail.
    PlainStderr,
    /// A mix of ndjson records and plain lines.
    Mixed,
    /// The tail was empty.
    Empty,
}

impl RunnerStackInput {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NdjsonErrorRecords => "ndjson_error_records",
            Self::PlainStderr => "plain_stderr",
            Self::Mixed => "mixed",
            Self::Empty => "empty",
        }
    }
}

/// Classify the bounded stderr tail without retaining any of it. Only the ndjson
/// shape of each line is inspected — never its content.
pub fn classify_runner_stack_input(tail: &[String]) -> RunnerStackInput {
    if tail.is_empty() {
        return RunnerStackInput::Empty;
    }
    let mut error_records = 0usize;
    let mut ndjson_records = 0usize;
    for line in tail {
        match serde_json::from_str::<SyncEvent>(line.trim()) {
            Ok(SyncEvent::Error(_)) => {
                error_records += 1;
                ndjson_records += 1;
            }
            Ok(_) => ndjson_records += 1,
            Err(_) => {}
        }
    }
    let len = tail.len();
    if error_records == len {
        RunnerStackInput::NdjsonErrorRecords
    } else if ndjson_records == 0 {
        RunnerStackInput::PlainStderr
    } else {
        RunnerStackInput::Mixed
    }
}

/// Shared bounded renderer for the count rollups: keep nonzero entries, order by
/// count descending with a stable declaration-order tie-break, take the top `n`,
/// and join as `token:count`. Returns `None` when every count is zero.
fn render_top_n(counts: &[(&'static str, u32)], n: usize) -> Option<String> {
    let mut nonzero: Vec<(&'static str, u32)> = counts
        .iter()
        .copied()
        .filter(|(_, count)| *count > 0)
        .collect();
    // `sort_by` is stable, so equal counts preserve the declaration order the
    // caller passed in — the rendered tag never flaps for the same multiset.
    nonzero.sort_by(|left, right| right.1.cmp(&left.1));
    let rendered: Vec<String> = nonzero
        .into_iter()
        .take(n)
        .map(|(token, count)| format!("{token}:{count}"))
        .collect();
    (!rendered.is_empty()).then(|| rendered.join(","))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Verbatim hq-cloud v6.14.x pull-leg error messages (with realistic tails),
    // each paired with the shape it must classify as. Sources are cited in the
    // module doc and the validated plan.
    const SHAPE_CASES: &[(&str, RunnerErrorShape)] = &[
        (
            "download skipped: local parent escaped the sync root",
            RunnerErrorShape::ContainmentEscape,
        ),
        (
            "conflict mirror skipped: local parent escaped the sync root",
            RunnerErrorShape::ContainmentEscape,
        ),
        (
            "tombstone-suppress unlink skipped: local parent escaped the sync root",
            RunnerErrorShape::ContainmentEscape,
        ),
        (
            "download skipped: parent directory is a dangling symlink (companies/acme/knowledge)",
            RunnerErrorShape::DanglingSymlinkParent,
        ),
        (
            "conflict convergence probe failed: ETIMEDOUT",
            RunnerErrorShape::ConflictProbeFailed,
        ),
        (
            "conflict mirror index write failed: EACCES",
            RunnerErrorShape::ConflictIndexWriteFailed,
        ),
        (
            "tombstone HEAD verify failed (deferring): 500 Internal Server Error",
            RunnerErrorShape::TombstoneHeadVerifyFailed,
        ),
        (
            "tombstone unlink failed: EPERM",
            RunnerErrorShape::TombstoneUnlinkFailed,
        ),
        (
            "tombstone-suppress unlink failed: EBUSY",
            RunnerErrorShape::TombstoneUnlinkFailed,
        ),
        (
            "presigned GET content-length mismatch: expected 42 bytes, received 7",
            RunnerErrorShape::ContentLengthMismatch,
        ),
        (
            "presigned GET failed for knowledge/a.md: 403 Forbidden",
            RunnerErrorShape::PresignedGetFailed,
        ),
        (
            "presigned HEAD failed for knowledge/a.md: 404 Not Found",
            RunnerErrorShape::PresignedHeadFailed,
        ),
        (
            "presign get returned no row for knowledge/a.md",
            RunnerErrorShape::PresignNoRow,
        ),
    ];

    #[test]
    fn classify_runner_error_shape_matches_verbatim_hq_cloud_messages() {
        for (message, expected) in SHAPE_CASES {
            assert_eq!(
                classify_runner_error_shape(message),
                *expected,
                "message did not classify as expected: {message:?}"
            );
            // Case-insensitivity: an upper-cased copy classifies identically.
            assert_eq!(
                classify_runner_error_shape(&message.to_uppercase()),
                *expected,
                "upper-cased message drifted: {message:?}"
            );
        }
    }

    #[test]
    fn classify_runner_error_shape_defaults_neighbouring_messages_to_unknown() {
        // Neighbouring messages that must NOT match any shape token — a confident
        // wrong label is worse than `unknown`.
        for message in [
            "download complete: knowledge/a.md",
            "EPERM: operation not permitted, unlink '/x/y'",
            "connection reset by peer",
            "sync finished with 0 errors",
            "the sync root was reindexed", // contains "sync root" but not "escaped the sync root"
            "unlink succeeded for tombstone", // contains tombstone+unlink but not "unlink failed"
            "presigned GET succeeded for knowledge/a.md",
        ] {
            assert_eq!(
                classify_runner_error_shape(message),
                RunnerErrorShape::Unknown,
                "message should be Unknown: {message:?}"
            );
        }
    }

    #[test]
    fn shape_rollup_renders_top_three_by_count_with_stable_order() {
        let mut rollup = RunnerErrorShapeRollup::default();
        for _ in 0..7205 {
            rollup.record("download skipped: local parent escaped the sync root");
        }
        for _ in 0..12 {
            rollup.record("some unrecognised runner message");
        }
        for _ in 0..3 {
            rollup.record("presigned GET failed for k/a.md: 403");
        }
        for _ in 0..3 {
            rollup.record("tombstone unlink failed: EPERM");
        }
        let value = rollup.tag_value().expect("nonzero rollup renders a tag");
        // Top-3 only: the two three-count shapes tie, and declaration order
        // (tombstone_unlink_failed precedes presigned_get_failed) breaks the tie
        // deterministically for the third slot.
        assert_eq!(
            value,
            "containment_escape:7205,unknown:12,tombstone_unlink_failed:3"
        );
        // Bounded: never more than three entries regardless of how many fire.
        assert!(value.split(',').count() <= ROLLUP_TAG_TOP_N);
    }

    #[test]
    fn empty_shape_rollup_renders_no_tag() {
        assert_eq!(RunnerErrorShapeRollup::default().tag_value(), None);
    }

    #[test]
    fn classify_runner_path_root_maps_first_segment_to_fixed_vocabulary() {
        for (path, expected) in [
            ("knowledge/hq-core/a.md", RunnerPathRoot::Knowledge),
            ("projects/p/prd.json", RunnerPathRoot::Projects),
            ("repos/public/x", RunnerPathRoot::Repos),
            ("companies/acme/knowledge/x.md", RunnerPathRoot::Companies),
            ("/workspace/threads/h.json", RunnerPathRoot::Workspace), // leading slash tolerated
            ("Knowledge/UPPER.md", RunnerPathRoot::Knowledge),        // case-insensitive
            ("secret-vault/creds.env", RunnerPathRoot::Other),        // unrecognised → other
            ("", RunnerPathRoot::Other),
            ("(company)", RunnerPathRoot::Other),
        ] {
            assert_eq!(classify_runner_path_root(path), expected, "path: {path:?}");
        }
    }

    #[test]
    fn path_root_rollup_never_emits_input_bytes() {
        let mut rollup = RunnerErrorPathRootRollup::default();
        // A secret-ish, never-vocabulary first segment must render only `other`.
        rollup.record("cognito-token-abc123/private.key");
        rollup.record("knowledge/a.md");
        let value = rollup.tag_value().expect("nonzero rollup renders a tag");
        assert!(value.contains("other:1"));
        assert!(value.contains("knowledge:1"));
        assert!(
            !value.contains("cognito") && !value.contains("token") && !value.contains("abc123"),
            "rendered tag leaked an input path segment: {value}"
        );
    }

    #[test]
    fn classify_runner_stack_input_distinguishes_ndjson_flood_from_a_stack() {
        let ndjson_flood: Vec<String> = (0..8)
            .map(|i| {
                format!(
                    "{{\"type\":\"error\",\"path\":\"knowledge/a{i}.md\",\"message\":\"presigned GET failed for knowledge/a{i}.md: 403\"}}"
                )
            })
            .collect();
        assert_eq!(
            classify_runner_stack_input(&ndjson_flood),
            RunnerStackInput::NdjsonErrorRecords
        );

        let plain_stack: Vec<String> = vec![
            "Error: boom".to_string(),
            "    at Object.<anonymous> (/x/y.js:1:1)".to_string(),
            "    at Module._compile (node:internal/modules/cjs/loader:1234:14)".to_string(),
        ];
        assert_eq!(
            classify_runner_stack_input(&plain_stack),
            RunnerStackInput::PlainStderr
        );

        let mixed: Vec<String> = vec![
            "{\"type\":\"error\",\"path\":\"knowledge/a.md\",\"message\":\"x\"}".to_string(),
            "    at Object.<anonymous> (/x/y.js:1:1)".to_string(),
        ];
        assert_eq!(classify_runner_stack_input(&mixed), RunnerStackInput::Mixed);

        assert_eq!(classify_runner_stack_input(&[]), RunnerStackInput::Empty);
    }

    #[test]
    fn every_shape_and_path_and_stack_token_is_denylist_free() {
        // The shared machine-checked guard: no token any of these axes can emit
        // may contain a Sentry default-scrubber denylist substring, or the
        // server-side @password:filter would silently delete the very attribution
        // this module exists to add (the HQ-DESKTOP-4T failure mode).
        const DENYLIST: &[&str] = &[
            "auth",
            "token",
            "secret",
            "password",
            "passwd",
            "credential",
            "api_key",
            "apikey",
            "session",
            "private_key",
            "privatekey",
        ];
        let shape_tokens = [
            RunnerErrorShape::ContainmentEscape,
            RunnerErrorShape::DanglingSymlinkParent,
            RunnerErrorShape::ConflictProbeFailed,
            RunnerErrorShape::ConflictIndexWriteFailed,
            RunnerErrorShape::TombstoneHeadVerifyFailed,
            RunnerErrorShape::TombstoneUnlinkFailed,
            RunnerErrorShape::ContentLengthMismatch,
            RunnerErrorShape::PresignedGetFailed,
            RunnerErrorShape::PresignedHeadFailed,
            RunnerErrorShape::PresignNoRow,
            RunnerErrorShape::Unknown,
        ]
        .map(RunnerErrorShape::as_str);
        let path_tokens = [
            RunnerPathRoot::Knowledge,
            RunnerPathRoot::Projects,
            RunnerPathRoot::Repos,
            RunnerPathRoot::Sources,
            RunnerPathRoot::Signals,
            RunnerPathRoot::Data,
            RunnerPathRoot::Settings,
            RunnerPathRoot::Workers,
            RunnerPathRoot::Registry,
            RunnerPathRoot::Clients,
            RunnerPathRoot::Core,
            RunnerPathRoot::Companies,
            RunnerPathRoot::Personal,
            RunnerPathRoot::Workspace,
            RunnerPathRoot::Other,
        ]
        .map(RunnerPathRoot::as_str);
        let stack_tokens = [
            RunnerStackInput::NdjsonErrorRecords,
            RunnerStackInput::PlainStderr,
            RunnerStackInput::Mixed,
            RunnerStackInput::Empty,
        ]
        .map(RunnerStackInput::as_str);
        for token in shape_tokens
            .into_iter()
            .chain(path_tokens)
            .chain(stack_tokens)
        {
            for denied in DENYLIST {
                assert!(
                    !token.contains(denied),
                    "token {token:?} contains Sentry denylist substring {denied:?}"
                );
            }
        }
    }
}
