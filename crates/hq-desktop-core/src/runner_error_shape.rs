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

/// Sentinel `path` the runner uses for a pre-fanout discovery-phase error
/// (`company` is absent), before any company or per-file work exists. Kept
/// distinct so a discovery failure is never miscounted as a per-file error.
pub const DISCOVERY_ERROR_PATH_SENTINEL: &str = "(discovery)";

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

/// Flat mirror of the [`RunnerErrorShape`] vocabulary. The `runner_error_shapes`
/// tag shipped with no egress guard; exposing the closed vocabulary lets the
/// hq-telemetry validator mirror it and a cross-crate parity test prove no drift.
/// `shape_tokens_match_enum_vocabulary` pins it to the enum within this crate.
pub const RUNNER_ERROR_SHAPE_TOKENS: &[&str] = &[
    "containment_escape",
    "dangling_symlink_parent",
    "conflict_probe_failed",
    "conflict_index_write_failed",
    "tombstone_head_verify_failed",
    "tombstone_unlink_failed",
    "content_length_mismatch",
    "presigned_get_failed",
    "presigned_head_failed",
    "presign_no_row",
    "unknown",
];

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
    } else if msg.contains("presign") && msg.contains("returned no row") {
        // Require the `presign` context: the documented source is specifically
        // `presign <op> returned no row for <key>`. Matching the bare phrase
        // would mislabel an unrelated "returned no row" (e.g. a DB lookup),
        // violating the fail-to-`unknown` policy.
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

/// Flat mirror of the [`RunnerPathRoot`] vocabulary. Same previously-unguarded
/// egress seam as [`RUNNER_ERROR_SHAPE_TOKENS`]; `path_root_tokens_match_enum_vocabulary`
/// pins it to the enum within this crate.
pub const RUNNER_PATH_ROOT_TOKENS: &[&str] = &[
    "knowledge",
    "projects",
    "repos",
    "sources",
    "signals",
    "data",
    "settings",
    "workers",
    "registry",
    "clients",
    "core",
    "companies",
    "personal",
    "workspace",
    "other",
];

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

// ─────────────────────────────────────────────────────────────────────────────
// HTTP-status axis (HQ-DESKTOP-4T)
// ─────────────────────────────────────────────────────────────────────────────
//
// The class/op/shape axes above collapse every hq-cloud company-leg
// `describeError` rendering and every presigned-HTTP failure to
// `OTHER`/`other`/`unknown`, discarding the single most discriminating fact the
// message carries verbatim: the HTTP status. This axis recovers it, and only it,
// from two narrow anchored grammars — never from an arbitrary number in prose.

/// Fixed, content-safe HTTP-status tokens. Common statuses get their own token;
/// anything else in range collapses to a bucket (`http_4xx`/`http_5xx`) or, for a
/// non-4xx/5xx status, `http_other`. Every value is chosen in code, never copied
/// from a runner message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunnerErrorHttpStatus {
    Http400,
    Http401,
    Http403,
    Http404,
    Http409,
    Http412,
    Http429,
    Http4xx,
    Http500,
    Http502,
    Http503,
    Http504,
    Http5xx,
    HttpOther,
}

impl RunnerErrorHttpStatus {
    /// Fixed vocabulary safe for Sentry tags. Never derived from runner input.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Http400 => "http_400",
            Self::Http401 => "http_401",
            Self::Http403 => "http_403",
            Self::Http404 => "http_404",
            Self::Http409 => "http_409",
            Self::Http412 => "http_412",
            Self::Http429 => "http_429",
            Self::Http4xx => "http_4xx",
            Self::Http500 => "http_500",
            Self::Http502 => "http_502",
            Self::Http503 => "http_503",
            Self::Http504 => "http_504",
            Self::Http5xx => "http_5xx",
            Self::HttpOther => "http_other",
        }
    }

    /// Bucket a validated status code (already confirmed to be in `100..=599`)
    /// into a fixed token. Common codes map exactly; other 4xx/5xx collapse to the
    /// class bucket; a non-4xx/5xx status collapses to `http_other`.
    fn from_code(code: u16) -> Self {
        match code {
            400 => Self::Http400,
            401 => Self::Http401,
            403 => Self::Http403,
            404 => Self::Http404,
            409 => Self::Http409,
            412 => Self::Http412,
            429 => Self::Http429,
            500 => Self::Http500,
            502 => Self::Http502,
            503 => Self::Http503,
            504 => Self::Http504,
            400..=499 => Self::Http4xx,
            500..=599 => Self::Http5xx,
            _ => Self::HttpOther,
        }
    }
}

/// Flat mirror of the [`RunnerErrorHttpStatus`] vocabulary, exposed so the
/// `hq-telemetry` egress validator can hold an independent copy and a cross-crate
/// parity test can prove the two never drift (a drift would silently `[Filtered]`
/// the very attribution this axis adds). `http_tokens_match_enum_vocabulary`
/// pins it to the enum within this crate.
pub const RUNNER_ERROR_HTTP_TOKENS: &[&str] = &[
    "http_400",
    "http_401",
    "http_403",
    "http_404",
    "http_409",
    "http_412",
    "http_429",
    "http_4xx",
    "http_500",
    "http_502",
    "http_503",
    "http_504",
    "http_5xx",
    "http_other",
];

/// Require `rest` to START with exactly three ASCII digits (a fourth adjacent
/// digit disqualifies it — a 4+ digit run is not a status) forming a value in the
/// `100..=599` HTTP range. Returns the parsed code or `None`.
fn parse_exactly_three_digit_status(rest: &str) -> Option<u16> {
    let bytes = rest.as_bytes();
    if bytes.len() < 3 || !bytes[..3].iter().all(u8::is_ascii_digit) {
        return None;
    }
    if bytes.get(3).is_some_and(u8::is_ascii_digit) {
        return None;
    }
    let code: u16 = rest[..3].parse().ok()?;
    (100..=599).contains(&code).then_some(code)
}

/// Grammar (a): the describeError ` http=` key followed by exactly three digits
/// (hq-cloud `src/lib/describe-error.ts`). The leading space is the space-join
/// separator describeError always emits before the key, so it can never be read
/// out of the middle of another token.
fn http_status_after_key(message: &str) -> Option<u16> {
    parse_exactly_three_digit_status(message.split(" http=").nth(1)?)
}

/// Grammar (b): the three digits immediately after the FINAL `: ` (hq-cloud
/// `src/object-io.ts` presigned/HEAD-verify sites, shape `… <key>: <status> …`).
/// Only ever consulted for a message already resolved to one of those shapes.
fn http_status_after_final_colon_space(message: &str) -> Option<u16> {
    parse_exactly_three_digit_status(message.rsplit_once(": ")?.1)
}

/// Parse an HTTP status from an untrusted runner error message using exactly two
/// anchored grammars and nothing else:
///
/// * (a) the describeError ` http=` key + exactly three ASCII digits, and
/// * (b) for a message [`classify_runner_error_shape`] already resolved to
///   `PresignedGetFailed`, `PresignedHeadFailed`, or `TombstoneHeadVerifyFailed`,
///   the three ASCII digits immediately after the final `: `.
///
/// Anchoring on the shape for grammar (b) is what prevents an arbitrary
/// three-digit number in free prose (`downloaded 404 files`, `retry after 500
/// ms`) from being misread as a status. Returns `None` when nothing parses, so an
/// absent status can never render as evidence. The message is inspected only to
/// *choose* a fixed token; no byte of it is ever retained.
pub fn classify_runner_error_http_status(message: &str) -> Option<RunnerErrorHttpStatus> {
    if let Some(code) = http_status_after_key(message) {
        return Some(RunnerErrorHttpStatus::from_code(code));
    }
    if matches!(
        classify_runner_error_shape(message),
        RunnerErrorShape::PresignedGetFailed
            | RunnerErrorShape::PresignedHeadFailed
            | RunnerErrorShape::TombstoneHeadVerifyFailed
    ) {
        if let Some(code) = http_status_after_final_colon_space(message) {
            return Some(RunnerErrorHttpStatus::from_code(code));
        }
    }
    None
}

/// Saturating per-pass counts of the closed HTTP-status vocabulary. Renders a
/// compact Sentry tag such as `http_500:40,http_403:8`. A message with no
/// parseable status contributes nothing, so an absent status never becomes a tag.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RunnerErrorHttpRollup {
    http_400: u32,
    http_401: u32,
    http_403: u32,
    http_404: u32,
    http_409: u32,
    http_412: u32,
    http_429: u32,
    http_4xx: u32,
    http_500: u32,
    http_502: u32,
    http_503: u32,
    http_504: u32,
    http_5xx: u32,
    http_other: u32,
}

impl RunnerErrorHttpRollup {
    /// Classify one message and, when a status parses, increment its bucket.
    pub fn record(&mut self, message: &str) {
        let Some(status) = classify_runner_error_http_status(message) else {
            return;
        };
        let count = match status {
            RunnerErrorHttpStatus::Http400 => &mut self.http_400,
            RunnerErrorHttpStatus::Http401 => &mut self.http_401,
            RunnerErrorHttpStatus::Http403 => &mut self.http_403,
            RunnerErrorHttpStatus::Http404 => &mut self.http_404,
            RunnerErrorHttpStatus::Http409 => &mut self.http_409,
            RunnerErrorHttpStatus::Http412 => &mut self.http_412,
            RunnerErrorHttpStatus::Http429 => &mut self.http_429,
            RunnerErrorHttpStatus::Http4xx => &mut self.http_4xx,
            RunnerErrorHttpStatus::Http500 => &mut self.http_500,
            RunnerErrorHttpStatus::Http502 => &mut self.http_502,
            RunnerErrorHttpStatus::Http503 => &mut self.http_503,
            RunnerErrorHttpStatus::Http504 => &mut self.http_504,
            RunnerErrorHttpStatus::Http5xx => &mut self.http_5xx,
            RunnerErrorHttpStatus::HttpOther => &mut self.http_other,
        };
        *count = count.saturating_add(1);
    }

    /// Declaration-ordered `(token, count)` pairs; the order is the stable
    /// tie-break `render_top_n` relies on for equal counts.
    fn counts(&self) -> [(&'static str, u32); 14] {
        [
            (RunnerErrorHttpStatus::Http400.as_str(), self.http_400),
            (RunnerErrorHttpStatus::Http401.as_str(), self.http_401),
            (RunnerErrorHttpStatus::Http403.as_str(), self.http_403),
            (RunnerErrorHttpStatus::Http404.as_str(), self.http_404),
            (RunnerErrorHttpStatus::Http409.as_str(), self.http_409),
            (RunnerErrorHttpStatus::Http412.as_str(), self.http_412),
            (RunnerErrorHttpStatus::Http429.as_str(), self.http_429),
            (RunnerErrorHttpStatus::Http4xx.as_str(), self.http_4xx),
            (RunnerErrorHttpStatus::Http500.as_str(), self.http_500),
            (RunnerErrorHttpStatus::Http502.as_str(), self.http_502),
            (RunnerErrorHttpStatus::Http503.as_str(), self.http_503),
            (RunnerErrorHttpStatus::Http504.as_str(), self.http_504),
            (RunnerErrorHttpStatus::Http5xx.as_str(), self.http_5xx),
            (RunnerErrorHttpStatus::HttpOther.as_str(), self.http_other),
        ]
    }

    /// Render the top-N statuses by count as a bounded Sentry tag. `None` means no
    /// message carried a parseable status, so no tag should be sent.
    pub fn tag_value(&self) -> Option<String> {
        render_top_n(&self.counts(), ROLLUP_TAG_TOP_N)
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Cause-identity axis (HQ-DESKTOP-4T)
// ─────────────────────────────────────────────────────────────────────────────
//
// The HTTP-status axis says *how* a request failed; this axis says *what*
// failed. hq-cloud renders every company-leg error through `describeError`, which
// emits `<ErrorName> code=<CODE> …` — and each hq-cloud fault subclass sets its
// own `this.name`, while AWS SDK faults surface their S3/STS code. Both are the
// error's identity, and both collapse to `OTHER` on the class axis (which only
// substring-matches a handful of errnos and auth words). This axis names them.
//
// It reads ONLY the name-bearing positions — the leading `ErrorName` token and
// the `code=`/`cause=` values — each looked up in a closed allow-list. It never
// reads `host=` or any free prose. The failing *operation* (`syscall=`) is the
// `runner_error_ops` axis and a filesystem *errno* is the `runner_error_class`
// axis, so this axis carries neither; its vocabulary is named identities only.

/// Fixed, content-safe cause-identity tokens. The first block is the hq-cloud
/// fault subclasses (each sets `this.name`, rendered first by describeError); the
/// second is the AWS S3/STS error codes. Identity-only tokens are spelled to
/// avoid the Sentry default `@password:filter` denylist — hence `expired_identity`
/// and `vault_identity`, never any `*token`/`*auth`/`*credential` form. An
/// unrecognised identity maps to [`RunnerErrorCause::Unknown`], never a guess.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunnerErrorCause {
    EntityNotFound,
    EntityPermission,
    EntityResolution,
    OperationLocked,
    OperationLockUnwritable,
    ScopeShrinkBlocked,
    ScopeShrinkLargePrune,
    DeltaGap,
    MultipartSourceChanged,
    MultipartAbort,
    RealtimeConflict,
    UnreachablePushPaths,
    PushEventDecode,
    LocalSnapshotChanged,
    RescuePathChanged,
    VaultIdentity,
    AccessDenied,
    NoSuchKey,
    NoSuchBucket,
    SlowDown,
    InternalError,
    RequestTimeout,
    ExpiredIdentity,
    InvalidIdentity,
    UnknownError,
    Unknown,
}

impl RunnerErrorCause {
    /// Fixed vocabulary safe for Sentry tags. Never derived from runner input.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::EntityNotFound => "entity_not_found",
            Self::EntityPermission => "entity_permission",
            Self::EntityResolution => "entity_resolution",
            Self::OperationLocked => "operation_locked",
            Self::OperationLockUnwritable => "operation_lock_unwritable",
            Self::ScopeShrinkBlocked => "scope_shrink_blocked",
            Self::ScopeShrinkLargePrune => "scope_shrink_large_prune",
            Self::DeltaGap => "delta_gap",
            Self::MultipartSourceChanged => "multipart_source_changed",
            Self::MultipartAbort => "multipart_abort",
            Self::RealtimeConflict => "realtime_conflict",
            Self::UnreachablePushPaths => "unreachable_push_paths",
            Self::PushEventDecode => "push_event_decode",
            Self::LocalSnapshotChanged => "local_snapshot_changed",
            Self::RescuePathChanged => "rescue_path_changed",
            Self::VaultIdentity => "vault_identity",
            Self::AccessDenied => "access_denied",
            Self::NoSuchKey => "no_such_key",
            Self::NoSuchBucket => "no_such_bucket",
            Self::SlowDown => "slow_down",
            Self::InternalError => "internal_error",
            Self::RequestTimeout => "request_timeout",
            Self::ExpiredIdentity => "expired_identity",
            Self::InvalidIdentity => "invalid_identity",
            Self::UnknownError => "unknown_error",
            Self::Unknown => "unknown",
        }
    }
}

/// Flat mirror of the [`RunnerErrorCause`] vocabulary, exposed for the same
/// cross-crate egress-parity reason as [`RUNNER_ERROR_HTTP_TOKENS`].
/// `cause_tokens_match_enum_vocabulary` pins it to the enum within this crate.
pub const RUNNER_ERROR_CAUSE_TOKENS: &[&str] = &[
    "entity_not_found",
    "entity_permission",
    "entity_resolution",
    "operation_locked",
    "operation_lock_unwritable",
    "scope_shrink_blocked",
    "scope_shrink_large_prune",
    "delta_gap",
    "multipart_source_changed",
    "multipart_abort",
    "realtime_conflict",
    "unreachable_push_paths",
    "push_event_decode",
    "local_snapshot_changed",
    "rescue_path_changed",
    "vault_identity",
    "access_denied",
    "no_such_key",
    "no_such_bucket",
    "slow_down",
    "internal_error",
    "request_timeout",
    "expired_identity",
    "invalid_identity",
    "unknown_error",
    "unknown",
];

/// Map a single identifier — a leading `ErrorName` token or a `code=`/`cause=`
/// value — to a cause token via an exact match against the closed allow-list of
/// hq-cloud subclass names and AWS S3/STS codes. `None` for anything else, so a
/// filesystem errno, a syscall, a hostname, or free prose never yields a guess.
fn cause_from_identifier(identifier: &str) -> Option<RunnerErrorCause> {
    let cause = match identifier {
        "EntityNotFoundError" => RunnerErrorCause::EntityNotFound,
        "EntityPermissionError" => RunnerErrorCause::EntityPermission,
        "EntityResolutionError" => RunnerErrorCause::EntityResolution,
        "OperationLockedError" => RunnerErrorCause::OperationLocked,
        "OperationLockUnwritableError" => RunnerErrorCause::OperationLockUnwritable,
        "ScopeShrinkBlockedError" => RunnerErrorCause::ScopeShrinkBlocked,
        "ScopeShrinkLargePruneError" => RunnerErrorCause::ScopeShrinkLargePrune,
        "DeltaGapError" => RunnerErrorCause::DeltaGap,
        "MultipartSourceChangedError" => RunnerErrorCause::MultipartSourceChanged,
        "MultipartAbortError" => RunnerErrorCause::MultipartAbort,
        "RealtimeConflictError" => RunnerErrorCause::RealtimeConflict,
        "UnreachablePushPathsError" => RunnerErrorCause::UnreachablePushPaths,
        "PushEventDecodeError" => RunnerErrorCause::PushEventDecode,
        "LocalSnapshotChangedError" => RunnerErrorCause::LocalSnapshotChanged,
        "RescuePathChangedError" => RunnerErrorCause::RescuePathChanged,
        "VaultIdentityError" => RunnerErrorCause::VaultIdentity,
        "AccessDenied" => RunnerErrorCause::AccessDenied,
        "NoSuchKey" => RunnerErrorCause::NoSuchKey,
        "NoSuchBucket" => RunnerErrorCause::NoSuchBucket,
        "SlowDown" => RunnerErrorCause::SlowDown,
        "InternalError" => RunnerErrorCause::InternalError,
        "RequestTimeout" | "RequestTimeoutException" => RunnerErrorCause::RequestTimeout,
        "ExpiredToken" | "ExpiredTokenException" => RunnerErrorCause::ExpiredIdentity,
        "InvalidAccessKeyId" | "InvalidToken" | "SignatureDoesNotMatch" => {
            RunnerErrorCause::InvalidIdentity
        }
        "UnknownError" => RunnerErrorCause::UnknownError,
        _ => return None,
    };
    Some(cause)
}

/// The value of a describeError `key=` pair: the substring from just after the
/// first occurrence of `key` up to the next ASCII whitespace. `None` if absent.
/// Only used to *select* a fixed token; the slice itself is never retained.
fn value_after_key<'a>(message: &'a str, key: &str) -> Option<&'a str> {
    let rest = message.split(key).nth(1)?;
    let end = rest
        .find(|character: char| character.is_ascii_whitespace())
        .unwrap_or(rest.len());
    Some(&rest[..end])
}

/// Map an untrusted runner error message to a fixed cause-identity token, reading
/// ONLY the leading `ErrorName` token and the `code=`/`cause=` values — each
/// looked up in [`cause_from_identifier`]. It never reads `host=` or free prose,
/// and returns [`RunnerErrorCause::Unknown`] rather than a nearest guess. See the
/// module comment for why `syscall=` and errno codes are deliberately not read.
pub fn classify_runner_error_cause(message: &str) -> RunnerErrorCause {
    if let Some(cause) = message
        .split_whitespace()
        .next()
        .and_then(cause_from_identifier)
    {
        return cause;
    }
    for key in ["code=", "cause="] {
        if let Some(cause) = value_after_key(message, key).and_then(cause_from_identifier) {
            return cause;
        }
    }
    RunnerErrorCause::Unknown
}

/// Saturating per-pass counts of the closed cause vocabulary. Renders a compact
/// Sentry tag such as `access_denied:8,unknown:160`. Unlike the HTTP rollup, an
/// unrecognised message is counted as `unknown`, so the tag is present whenever
/// any error was seen and the `unknown` count itself signals a missing token.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RunnerErrorCauseRollup {
    entity_not_found: u32,
    entity_permission: u32,
    entity_resolution: u32,
    operation_locked: u32,
    operation_lock_unwritable: u32,
    scope_shrink_blocked: u32,
    scope_shrink_large_prune: u32,
    delta_gap: u32,
    multipart_source_changed: u32,
    multipart_abort: u32,
    realtime_conflict: u32,
    unreachable_push_paths: u32,
    push_event_decode: u32,
    local_snapshot_changed: u32,
    rescue_path_changed: u32,
    vault_identity: u32,
    access_denied: u32,
    no_such_key: u32,
    no_such_bucket: u32,
    slow_down: u32,
    internal_error: u32,
    request_timeout: u32,
    expired_identity: u32,
    invalid_identity: u32,
    unknown_error: u32,
    unknown: u32,
}

impl RunnerErrorCauseRollup {
    /// Classify one runner error message and increment its cause count.
    pub fn record(&mut self, message: &str) {
        let count = match classify_runner_error_cause(message) {
            RunnerErrorCause::EntityNotFound => &mut self.entity_not_found,
            RunnerErrorCause::EntityPermission => &mut self.entity_permission,
            RunnerErrorCause::EntityResolution => &mut self.entity_resolution,
            RunnerErrorCause::OperationLocked => &mut self.operation_locked,
            RunnerErrorCause::OperationLockUnwritable => &mut self.operation_lock_unwritable,
            RunnerErrorCause::ScopeShrinkBlocked => &mut self.scope_shrink_blocked,
            RunnerErrorCause::ScopeShrinkLargePrune => &mut self.scope_shrink_large_prune,
            RunnerErrorCause::DeltaGap => &mut self.delta_gap,
            RunnerErrorCause::MultipartSourceChanged => &mut self.multipart_source_changed,
            RunnerErrorCause::MultipartAbort => &mut self.multipart_abort,
            RunnerErrorCause::RealtimeConflict => &mut self.realtime_conflict,
            RunnerErrorCause::UnreachablePushPaths => &mut self.unreachable_push_paths,
            RunnerErrorCause::PushEventDecode => &mut self.push_event_decode,
            RunnerErrorCause::LocalSnapshotChanged => &mut self.local_snapshot_changed,
            RunnerErrorCause::RescuePathChanged => &mut self.rescue_path_changed,
            RunnerErrorCause::VaultIdentity => &mut self.vault_identity,
            RunnerErrorCause::AccessDenied => &mut self.access_denied,
            RunnerErrorCause::NoSuchKey => &mut self.no_such_key,
            RunnerErrorCause::NoSuchBucket => &mut self.no_such_bucket,
            RunnerErrorCause::SlowDown => &mut self.slow_down,
            RunnerErrorCause::InternalError => &mut self.internal_error,
            RunnerErrorCause::RequestTimeout => &mut self.request_timeout,
            RunnerErrorCause::ExpiredIdentity => &mut self.expired_identity,
            RunnerErrorCause::InvalidIdentity => &mut self.invalid_identity,
            RunnerErrorCause::UnknownError => &mut self.unknown_error,
            RunnerErrorCause::Unknown => &mut self.unknown,
        };
        *count = count.saturating_add(1);
    }

    /// Declaration-ordered `(token, count)` pairs; the order is the stable
    /// tie-break `render_top_n` relies on for equal counts.
    fn counts(&self) -> [(&'static str, u32); 26] {
        [
            (
                RunnerErrorCause::EntityNotFound.as_str(),
                self.entity_not_found,
            ),
            (
                RunnerErrorCause::EntityPermission.as_str(),
                self.entity_permission,
            ),
            (
                RunnerErrorCause::EntityResolution.as_str(),
                self.entity_resolution,
            ),
            (
                RunnerErrorCause::OperationLocked.as_str(),
                self.operation_locked,
            ),
            (
                RunnerErrorCause::OperationLockUnwritable.as_str(),
                self.operation_lock_unwritable,
            ),
            (
                RunnerErrorCause::ScopeShrinkBlocked.as_str(),
                self.scope_shrink_blocked,
            ),
            (
                RunnerErrorCause::ScopeShrinkLargePrune.as_str(),
                self.scope_shrink_large_prune,
            ),
            (RunnerErrorCause::DeltaGap.as_str(), self.delta_gap),
            (
                RunnerErrorCause::MultipartSourceChanged.as_str(),
                self.multipart_source_changed,
            ),
            (
                RunnerErrorCause::MultipartAbort.as_str(),
                self.multipart_abort,
            ),
            (
                RunnerErrorCause::RealtimeConflict.as_str(),
                self.realtime_conflict,
            ),
            (
                RunnerErrorCause::UnreachablePushPaths.as_str(),
                self.unreachable_push_paths,
            ),
            (
                RunnerErrorCause::PushEventDecode.as_str(),
                self.push_event_decode,
            ),
            (
                RunnerErrorCause::LocalSnapshotChanged.as_str(),
                self.local_snapshot_changed,
            ),
            (
                RunnerErrorCause::RescuePathChanged.as_str(),
                self.rescue_path_changed,
            ),
            (
                RunnerErrorCause::VaultIdentity.as_str(),
                self.vault_identity,
            ),
            (RunnerErrorCause::AccessDenied.as_str(), self.access_denied),
            (RunnerErrorCause::NoSuchKey.as_str(), self.no_such_key),
            (RunnerErrorCause::NoSuchBucket.as_str(), self.no_such_bucket),
            (RunnerErrorCause::SlowDown.as_str(), self.slow_down),
            (
                RunnerErrorCause::InternalError.as_str(),
                self.internal_error,
            ),
            (
                RunnerErrorCause::RequestTimeout.as_str(),
                self.request_timeout,
            ),
            (
                RunnerErrorCause::ExpiredIdentity.as_str(),
                self.expired_identity,
            ),
            (
                RunnerErrorCause::InvalidIdentity.as_str(),
                self.invalid_identity,
            ),
            (RunnerErrorCause::UnknownError.as_str(), self.unknown_error),
            (RunnerErrorCause::Unknown.as_str(), self.unknown),
        ]
    }

    /// Render the top-N causes by count as a bounded Sentry tag. `None` means no
    /// runner error records were seen, so no tag should be sent.
    pub fn tag_value(&self) -> Option<String> {
        render_top_n(&self.counts(), ROLLUP_TAG_TOP_N)
    }
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
            "entity lookup returned no row for cmp_x", // "returned no row" without the presign context
            "journal query returned no row",
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
    fn every_runner_axis_token_is_denylist_free() {
        // The shared machine-checked guard: no token any of these axes can emit
        // may contain a Sentry default-scrubber denylist substring, or the
        // server-side @password:filter would silently delete the very attribution
        // this module exists to add (the HQ-DESKTOP-4T failure mode). The HTTP and
        // cause axes are enumerated through their exported token lists, which
        // `*_tokens_match_enum_vocabulary` pins to the emitter enums.
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
            .chain(RUNNER_ERROR_HTTP_TOKENS.iter().copied())
            .chain(RUNNER_ERROR_CAUSE_TOKENS.iter().copied())
        {
            for denied in DENYLIST {
                assert!(
                    !token.contains(denied),
                    "token {token:?} contains Sentry denylist substring {denied:?}"
                );
            }
        }
    }

    // ── HTTP-status axis (HQ-DESKTOP-4T) ─────────────────────────────────────────

    #[test]
    fn classify_http_status_reads_both_anchored_grammars() {
        // Grammar (a): the describeError ` http=` key. Verbatim producer strings.
        for (message, expected) in [
            (
                "AccessDenied http=403 The provided credentials could not be validated",
                RunnerErrorHttpStatus::Http403,
            ),
            (
                "NoSuchKey http=404 The specified key does not exist",
                RunnerErrorHttpStatus::Http404,
            ),
            (
                "InternalError http=500 We encountered an internal error",
                RunnerErrorHttpStatus::Http500,
            ),
            (
                "SlowDown http=503 Please reduce your request rate",
                RunnerErrorHttpStatus::Http503,
            ),
            (
                "Error http=409 journal write conflict",
                RunnerErrorHttpStatus::Http409,
            ),
            // Unmodelled but in-range statuses collapse to their class bucket.
            (
                "TeapotError http=418 short and stout",
                RunnerErrorHttpStatus::Http4xx,
            ),
            (
                "GatewaySad http=599 network read timeout",
                RunnerErrorHttpStatus::Http5xx,
            ),
            // A non-4xx/5xx in-range status collapses to `http_other`.
            (
                "RedirectError http=301 moved permanently",
                RunnerErrorHttpStatus::HttpOther,
            ),
        ] {
            assert_eq!(
                classify_runner_error_http_status(message),
                Some(expected),
                "grammar (a) drifted for: {message:?}"
            );
        }

        // Grammar (b): the digits after the final `: `, only when the shape is a
        // presigned/HEAD-verify shape (so the status colon is the anchor).
        for (message, expected) in [
            (
                "presigned GET failed for k/a.md: 403 Forbidden",
                RunnerErrorHttpStatus::Http403,
            ),
            (
                "presigned HEAD failed for k/a.md: 404 ",
                RunnerErrorHttpStatus::Http404,
            ),
            (
                "presigned GET failed for repos/b: 500",
                RunnerErrorHttpStatus::Http500,
            ),
            (
                "tombstone HEAD verify failed (deferring): 412 Precondition Failed",
                RunnerErrorHttpStatus::Http412,
            ),
        ] {
            assert_eq!(
                classify_runner_error_http_status(message),
                Some(expected),
                "grammar (b) drifted for: {message:?}"
            );
        }
    }

    #[test]
    fn classify_http_status_returns_none_for_prose_and_missing_status() {
        // A three-digit number in free prose, or after a colon on a NON-presigned
        // shape, is never read as a status — a confident wrong label is worse than
        // no label. And a message with no status at all yields nothing.
        for message in [
            "downloaded 404 files",
            "retry after 500 ms",
            "tombstone unlink failed: EPERM",
            "403",                                        // bare, no recognised shape
            "presigned GET succeeded for k/a.md: 200 ",   // "succeeded" ⇒ shape unknown
            "conflict mirror index write failed: EACCES", // shape present, no status digits
            "download skipped: local parent escaped the sync root",
            " http=40 too short",               // fewer than three digits
            "GET failed http=4030 four digits", // more than three digits
        ] {
            assert_eq!(
                classify_runner_error_http_status(message),
                None,
                "message should have no HTTP status: {message:?}"
            );
        }
    }

    #[test]
    fn http_rollup_renders_top_three_by_count_and_is_empty_without_status() {
        let mut rollup = RunnerErrorHttpRollup::default();
        for _ in 0..40 {
            rollup.record("presigned GET failed for repos/b: 500");
        }
        for _ in 0..8 {
            rollup.record("AccessDenied http=403 forbidden");
        }
        for _ in 0..2 {
            rollup.record("NoSuchKey http=404 missing");
        }
        // Statusless messages contribute nothing.
        for _ in 0..100 {
            rollup.record("download skipped: local parent escaped the sync root");
        }
        let value = rollup.tag_value().expect("nonzero rollup renders a tag");
        assert_eq!(value, "http_500:40,http_403:8,http_404:2");
        assert!(value.split(',').count() <= ROLLUP_TAG_TOP_N);

        // No parseable status anywhere ⇒ no tag.
        let mut statusless = RunnerErrorHttpRollup::default();
        statusless.record("download skipped: local parent escaped the sync root");
        assert_eq!(statusless.tag_value(), None);
        assert_eq!(RunnerErrorHttpRollup::default().tag_value(), None);
    }

    // ── Cause-identity axis (HQ-DESKTOP-4T) ──────────────────────────────────────

    #[test]
    fn classify_cause_reads_leading_name_then_code_and_cause_values() {
        for (message, expected) in [
            // Leading hq-cloud subclass name (describeError renders `this.name` first).
            (
                "EntityPermissionError code=EACCES cannot read companies/x/knowledge/a.md",
                RunnerErrorCause::EntityPermission,
            ),
            (
                "OperationLockedError host=vault another writer holds the lock",
                RunnerErrorCause::OperationLocked,
            ),
            (
                "DeltaGapError the delta cursor moved",
                RunnerErrorCause::DeltaGap,
            ),
            (
                "RealtimeConflictError concurrent push",
                RunnerErrorCause::RealtimeConflict,
            ),
            (
                "VaultIdentityError could not resolve identity",
                RunnerErrorCause::VaultIdentity,
            ),
            // Leading AWS name.
            (
                "AccessDenied http=403 forbidden",
                RunnerErrorCause::AccessDenied,
            ),
            ("NoSuchKey http=404 missing", RunnerErrorCause::NoSuchKey),
            ("SlowDown http=503 throttled", RunnerErrorCause::SlowDown),
            // Generic leading name falls through to the `code=` value …
            (
                "Error code=NoSuchBucket http=404 gone",
                RunnerErrorCause::NoSuchBucket,
            ),
            // … then to the `cause=` value.
            (
                "Error code=Weird cause=InternalError http=500",
                RunnerErrorCause::InternalError,
            ),
            // STS identity codes map to identity-safe tokens (never `*token`).
            (
                "ExpiredTokenException the security token expired",
                RunnerErrorCause::ExpiredIdentity,
            ),
            (
                "SignatureDoesNotMatch check your key",
                RunnerErrorCause::InvalidIdentity,
            ),
        ] {
            assert_eq!(
                classify_runner_error_cause(message),
                expected,
                "cause drifted for: {message:?}"
            );
        }
    }

    #[test]
    fn classify_cause_is_unknown_for_unmodelled_input_and_never_reads_host() {
        for message in [
            "download skipped: local parent escaped the sync root",
            "presigned GET failed for repos/b: 500",
            "EPERM: operation not permitted, unlink '/x/y'",
            "SomeBrandNewError code=WHAT never seen before",
        ] {
            assert_eq!(
                classify_runner_error_cause(message),
                RunnerErrorCause::Unknown,
                "message should be Unknown cause: {message:?}"
            );
        }
        // The `host=` value is never inspected: a hostname carrying a secret-looking
        // company id must never influence or leak into the rendered token.
        let message =
            "AccessDenied http=403 host=hq-vault-cmp-SECRET9z.s3.us-east-1.amazonaws.com denied";
        let token = classify_runner_error_cause(message).as_str();
        assert_eq!(token, "access_denied");
        assert!(
            !token.contains("SECRET9z") && !token.contains("hq-vault") && !token.contains("s3")
        );
    }

    #[test]
    fn cause_rollup_renders_top_three_by_count_and_counts_unknown() {
        let mut rollup = RunnerErrorCauseRollup::default();
        for _ in 0..160 {
            rollup.record("download skipped: local parent escaped the sync root");
        }
        for _ in 0..8 {
            rollup.record("AccessDenied http=403 forbidden");
        }
        for _ in 0..3 {
            rollup.record("NoSuchKey http=404 missing");
        }
        let value = rollup.tag_value().expect("nonzero rollup renders a tag");
        assert_eq!(value, "unknown:160,access_denied:8,no_such_key:3");
        assert!(value.split(',').count() <= ROLLUP_TAG_TOP_N);
        assert_eq!(RunnerErrorCauseRollup::default().tag_value(), None);
    }

    #[test]
    fn new_rollups_are_order_independent_for_the_same_multiset() {
        let forward = [
            "AccessDenied http=403 a",
            "NoSuchKey http=404 b",
            "presigned GET failed for k: 500",
        ];
        let mut http_a = RunnerErrorHttpRollup::default();
        let mut cause_a = RunnerErrorCauseRollup::default();
        for message in forward {
            http_a.record(message);
            cause_a.record(message);
        }
        let mut http_b = RunnerErrorHttpRollup::default();
        let mut cause_b = RunnerErrorCauseRollup::default();
        for message in forward.iter().rev() {
            http_b.record(message);
            cause_b.record(message);
        }
        assert_eq!(http_a, http_b);
        assert_eq!(cause_a, cause_b);
    }

    #[test]
    fn http_tokens_match_enum_vocabulary() {
        let enum_tokens = [
            RunnerErrorHttpStatus::Http400,
            RunnerErrorHttpStatus::Http401,
            RunnerErrorHttpStatus::Http403,
            RunnerErrorHttpStatus::Http404,
            RunnerErrorHttpStatus::Http409,
            RunnerErrorHttpStatus::Http412,
            RunnerErrorHttpStatus::Http429,
            RunnerErrorHttpStatus::Http4xx,
            RunnerErrorHttpStatus::Http500,
            RunnerErrorHttpStatus::Http502,
            RunnerErrorHttpStatus::Http503,
            RunnerErrorHttpStatus::Http504,
            RunnerErrorHttpStatus::Http5xx,
            RunnerErrorHttpStatus::HttpOther,
        ]
        .map(RunnerErrorHttpStatus::as_str);
        assert_eq!(RUNNER_ERROR_HTTP_TOKENS, &enum_tokens);
    }

    #[test]
    fn cause_tokens_match_enum_vocabulary() {
        let enum_tokens = [
            RunnerErrorCause::EntityNotFound,
            RunnerErrorCause::EntityPermission,
            RunnerErrorCause::EntityResolution,
            RunnerErrorCause::OperationLocked,
            RunnerErrorCause::OperationLockUnwritable,
            RunnerErrorCause::ScopeShrinkBlocked,
            RunnerErrorCause::ScopeShrinkLargePrune,
            RunnerErrorCause::DeltaGap,
            RunnerErrorCause::MultipartSourceChanged,
            RunnerErrorCause::MultipartAbort,
            RunnerErrorCause::RealtimeConflict,
            RunnerErrorCause::UnreachablePushPaths,
            RunnerErrorCause::PushEventDecode,
            RunnerErrorCause::LocalSnapshotChanged,
            RunnerErrorCause::RescuePathChanged,
            RunnerErrorCause::VaultIdentity,
            RunnerErrorCause::AccessDenied,
            RunnerErrorCause::NoSuchKey,
            RunnerErrorCause::NoSuchBucket,
            RunnerErrorCause::SlowDown,
            RunnerErrorCause::InternalError,
            RunnerErrorCause::RequestTimeout,
            RunnerErrorCause::ExpiredIdentity,
            RunnerErrorCause::InvalidIdentity,
            RunnerErrorCause::UnknownError,
            RunnerErrorCause::Unknown,
        ]
        .map(RunnerErrorCause::as_str);
        assert_eq!(RUNNER_ERROR_CAUSE_TOKENS, &enum_tokens);
    }

    #[test]
    fn shape_tokens_match_enum_vocabulary() {
        let enum_tokens = [
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
        assert_eq!(RUNNER_ERROR_SHAPE_TOKENS, &enum_tokens);
    }

    #[test]
    fn path_root_tokens_match_enum_vocabulary() {
        let enum_tokens = [
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
        assert_eq!(RUNNER_PATH_ROOT_TOKENS, &enum_tokens);
    }
}
