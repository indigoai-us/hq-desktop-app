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
    /// Every variant, so content-safety and cross-crate parity tests can
    /// enumerate the emitter's own token set instead of a hand-copied list.
    pub const ALL: [RunnerErrorShape; 11] = [
        Self::ContainmentEscape,
        Self::DanglingSymlinkParent,
        Self::ConflictProbeFailed,
        Self::ConflictIndexWriteFailed,
        Self::TombstoneHeadVerifyFailed,
        Self::TombstoneUnlinkFailed,
        Self::ContentLengthMismatch,
        Self::PresignedGetFailed,
        Self::PresignedHeadFailed,
        Self::PresignNoRow,
        Self::Unknown,
    ];

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
    /// Every variant, so content-safety and cross-crate parity tests can
    /// enumerate the emitter's own token set instead of a hand-copied list.
    pub const ALL: [RunnerPathRoot; 15] = [
        Self::Knowledge,
        Self::Projects,
        Self::Repos,
        Self::Sources,
        Self::Signals,
        Self::Data,
        Self::Settings,
        Self::Workers,
        Self::Registry,
        Self::Clients,
        Self::Core,
        Self::Companies,
        Self::Personal,
        Self::Workspace,
        Self::Other,
    ];

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

// ─────────────────────────────────────────────────────────────────────────────
// HTTP-status axis (HQ-DESKTOP-4T)
// ─────────────────────────────────────────────────────────────────────────────

/// Fixed, content-safe HTTP-status tokens for runner errors.
///
/// The HTTP status is the single most discriminating fact about the failures
/// that actually terminate these runs, yet the class/op/shape axes all discard
/// it: a company-scope `describeError` rendering carries it as ` http=<status>`
/// (hq-cloud `src/lib/describe-error.ts`), and a per-file presigned failure
/// carries it verbatim after the `: ` (hq-cloud `src/object-io.ts`). This axis
/// parses only those two anchored grammars, maps the integer to a token *in
/// code*, and then drops it — so no runner byte is ever emitted, and an
/// unparseable message yields no token rather than a guess.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunnerErrorHttpStatus {
    Http400,
    Http401,
    Http403,
    Http404,
    Http409,
    Http412,
    Http429,
    /// Any other 4xx not called out above.
    Http4xx,
    Http500,
    Http502,
    Http503,
    Http504,
    /// Any other 5xx not called out above.
    Http5xx,
    /// A valid but unfamiliar 1xx/2xx/3xx status. A non-status (outside 100..=599)
    /// never reaches this axis at all — it classifies to `None`.
    HttpOther,
}

impl RunnerErrorHttpStatus {
    /// Every variant, so content-safety and cross-crate parity tests can
    /// enumerate the emitter's own token set instead of a hand-copied list. The
    /// order matches the enum's discriminants, so `variant as usize` indexes the
    /// rollup's count array.
    pub const ALL: [RunnerErrorHttpStatus; 14] = [
        Self::Http400,
        Self::Http401,
        Self::Http403,
        Self::Http404,
        Self::Http409,
        Self::Http412,
        Self::Http429,
        Self::Http4xx,
        Self::Http500,
        Self::Http502,
        Self::Http503,
        Self::Http504,
        Self::Http5xx,
        Self::HttpOther,
    ];

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
}

/// Map a status integer to its fixed token. Familiar codes get their own token;
/// other 4xx/5xx collapse to the family token; a valid but unfamiliar 1xx/2xx/3xx
/// becomes `http_other`. Anything outside 100..=599 is not an HTTP status and
/// returns `None`.
fn http_status_token(status: u16) -> Option<RunnerErrorHttpStatus> {
    let token = match status {
        400 => RunnerErrorHttpStatus::Http400,
        401 => RunnerErrorHttpStatus::Http401,
        403 => RunnerErrorHttpStatus::Http403,
        404 => RunnerErrorHttpStatus::Http404,
        409 => RunnerErrorHttpStatus::Http409,
        412 => RunnerErrorHttpStatus::Http412,
        429 => RunnerErrorHttpStatus::Http429,
        500 => RunnerErrorHttpStatus::Http500,
        502 => RunnerErrorHttpStatus::Http502,
        503 => RunnerErrorHttpStatus::Http503,
        504 => RunnerErrorHttpStatus::Http504,
        // Overlapping ranges: the familiar codes above win by first-match, so
        // these arms stay reachable for every other 4xx / 5xx.
        400..=499 => RunnerErrorHttpStatus::Http4xx,
        500..=599 => RunnerErrorHttpStatus::Http5xx,
        100..=399 => RunnerErrorHttpStatus::HttpOther,
        _ => return None,
    };
    Some(token)
}

/// Read exactly three ASCII digits of an HTTP status at `bytes[from..]`, bounded
/// by a non-digit (or end of input) so a four-digit run such as `4030` is never
/// misread as `403`. Returns the parsed status only when it is a valid HTTP
/// status (100..=599).
fn three_digit_http_status_at(bytes: &[u8], from: usize) -> Option<u16> {
    let digits = bytes.get(from..from + 3)?;
    if !digits.iter().all(u8::is_ascii_digit) {
        return None;
    }
    // A fourth digit means this is not a three-digit status.
    if bytes
        .get(from + 3)
        .copied()
        .is_some_and(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    let status = u16::from(digits[0] - b'0') * 100
        + u16::from(digits[1] - b'0') * 10
        + u16::from(digits[2] - b'0');
    (100..=599).contains(&status).then_some(status)
}

/// Grammar (a): the `describeError` ` http=<status>` key. Anchored on a `http=`
/// at the start of input or preceded by ASCII whitespace, so `xhttp=500` in free
/// prose never matches.
fn parse_http_key_status(message: &str) -> Option<RunnerErrorHttpStatus> {
    let bytes = message.as_bytes();
    for (idx, _) in message.match_indices("http=") {
        let boundary_ok = idx == 0 || bytes[idx - 1].is_ascii_whitespace();
        if !boundary_ok {
            continue;
        }
        if let Some(status) = three_digit_http_status_at(bytes, idx + "http=".len()) {
            return http_status_token(status);
        }
    }
    None
}

/// Grammar (b): the `<key>: <status> <detail>` tail of a presigned/HEAD/verify
/// failure. Scans `": "` boundaries and takes the first one immediately followed
/// by a valid three-digit status — the key/status separator. Taking the first
/// valid match (rather than any single fixed occurrence) is robust to a `": "`
/// inside the free-text detail, while the caller's shape gate is what prevents an
/// arbitrary three-digit number in unrelated prose from being read as a status.
fn parse_presigned_tail_status(message: &str) -> Option<RunnerErrorHttpStatus> {
    let bytes = message.as_bytes();
    for (idx, _) in message.match_indices(": ") {
        if let Some(status) = three_digit_http_status_at(bytes, idx + ": ".len()) {
            return http_status_token(status);
        }
    }
    None
}

/// Map an untrusted runner error message to a fixed HTTP-status token, or `None`
/// when no anchored grammar parses. Only two grammars are read, and nothing else:
/// the `describeError` ` http=` key, and the `: <status>` tail of a message the
/// shape classifier already resolved to a presigned/HEAD/tombstone-verify form.
/// The shape anchor on grammar (b) is deliberate: it keeps an arbitrary
/// three-digit number in free prose from ever being mislabelled as a status.
pub fn classify_runner_error_http_status(message: &str) -> Option<RunnerErrorHttpStatus> {
    if let Some(token) = parse_http_key_status(message) {
        return Some(token);
    }
    match classify_runner_error_shape(message) {
        RunnerErrorShape::PresignedGetFailed
        | RunnerErrorShape::PresignedHeadFailed
        | RunnerErrorShape::TombstoneHeadVerifyFailed => parse_presigned_tail_status(message),
        _ => None,
    }
}

/// Saturating per-pass counts of the closed HTTP-status vocabulary, indexed by
/// [`RunnerErrorHttpStatus`] discriminant. Renders a bounded Sentry tag such as
/// `http_500:40,http_403:8`. A message that carries no parseable status
/// contributes nothing, so absence never renders as evidence.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RunnerErrorHttpRollup {
    counts: [u32; RunnerErrorHttpStatus::ALL.len()],
}

impl RunnerErrorHttpRollup {
    /// Classify one runner error message and, when a status parses, increment it.
    pub fn record(&mut self, message: &str) {
        if let Some(status) = classify_runner_error_http_status(message) {
            let index = status as usize;
            self.counts[index] = self.counts[index].saturating_add(1);
        }
    }

    /// Declaration-ordered `(token, count)` pairs — the tie-break for equal counts.
    fn counts(&self) -> Vec<(&'static str, u32)> {
        RunnerErrorHttpStatus::ALL
            .iter()
            .map(|&status| (status.as_str(), self.counts[status as usize]))
            .collect()
    }

    /// Render the top-N statuses by count as a bounded Sentry tag. `None` when no
    /// status was recorded, so no tag should be sent.
    pub fn tag_value(&self) -> Option<String> {
        render_top_n(&self.counts(), ROLLUP_TAG_TOP_N)
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Error-cause axis (HQ-DESKTOP-4T)
// ─────────────────────────────────────────────────────────────────────────────

/// Fixed, content-safe error-cause tokens for runner errors.
///
/// The vocabulary is grounded in the producers that actually reach the desktop's
/// error channel: the hq-cloud error classes whose constructors set `this.name`
/// (so `describeError` emits the name first), the AWS S3/STS error names
/// `describeError` surfaces, and the filesystem errno codes the class axis
/// already distinguishes. Every token is spelled to avoid Sentry's default
/// `@password:filter` denylist — hence `expired_identity` and `vault_identity`,
/// never `expired_token` or `vault_auth`, which is the exact HQ-DESKTOP-4T
/// scrubber failure mode this module guards against. `Unknown` is the honest
/// fallback (never a nearest guess); its count is itself the signal that the
/// vocabulary needs one more entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunnerErrorCause {
    // hq-cloud error classes (`this.name` set in the constructor).
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
    // AWS S3 / STS error names.
    AccessDenied,
    NoSuchKey,
    NoSuchBucket,
    SlowDown,
    InternalError,
    RequestTimeout,
    ExpiredIdentity,
    InvalidIdentity,
    UnknownError,
    // Filesystem errno codes the class axis already knows.
    Eperm,
    Eacces,
    Enospc,
    Ebusy,
    /// Nothing in the closed vocabulary matched.
    Unknown,
}

impl RunnerErrorCause {
    /// Every variant, in discriminant order, so content-safety and cross-crate
    /// parity tests enumerate the emitter's own token set and `variant as usize`
    /// indexes the rollup's count array.
    pub const ALL: [RunnerErrorCause; 30] = [
        Self::EntityNotFound,
        Self::EntityPermission,
        Self::EntityResolution,
        Self::OperationLocked,
        Self::OperationLockUnwritable,
        Self::ScopeShrinkBlocked,
        Self::ScopeShrinkLargePrune,
        Self::DeltaGap,
        Self::MultipartSourceChanged,
        Self::MultipartAbort,
        Self::RealtimeConflict,
        Self::UnreachablePushPaths,
        Self::PushEventDecode,
        Self::LocalSnapshotChanged,
        Self::RescuePathChanged,
        Self::VaultIdentity,
        Self::AccessDenied,
        Self::NoSuchKey,
        Self::NoSuchBucket,
        Self::SlowDown,
        Self::InternalError,
        Self::RequestTimeout,
        Self::ExpiredIdentity,
        Self::InvalidIdentity,
        Self::UnknownError,
        Self::Eperm,
        Self::Eacces,
        Self::Enospc,
        Self::Ebusy,
        Self::Unknown,
    ];

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
            Self::Eperm => "eperm",
            Self::Eacces => "eacces",
            Self::Enospc => "enospc",
            Self::Ebusy => "ebusy",
            Self::Unknown => "unknown",
        }
    }
}

/// Lower-case an identifier and drop every non-alphanumeric byte, bounded so a
/// pathological token can never allocate without limit. Never emitted — used only
/// to select a fixed token, so `AccessDenied`, `access_denied` and `access-denied`
/// all resolve identically.
fn canonical_identifier(identifier: &str) -> String {
    identifier
        .bytes()
        .take(64)
        .filter(u8::is_ascii_alphanumeric)
        .map(|byte| byte.to_ascii_lowercase() as char)
        .collect()
}

/// Resolve a raw identifier — an error `name`, or a `code=`/`cause=`/`syscall=`
/// value — against the closed cause vocabulary, or `None` when nothing matches.
fn cause_from_identifier(identifier: &str) -> Option<RunnerErrorCause> {
    let cause = match canonical_identifier(identifier).as_str() {
        // hq-cloud error class names, with the `Error` suffix the constructors set.
        "entitynotfounderror" => RunnerErrorCause::EntityNotFound,
        "entitypermissionerror" => RunnerErrorCause::EntityPermission,
        "entityresolutionerror" => RunnerErrorCause::EntityResolution,
        "operationlockederror" => RunnerErrorCause::OperationLocked,
        "operationlockunwritableerror" => RunnerErrorCause::OperationLockUnwritable,
        "scopeshrinkblockederror" => RunnerErrorCause::ScopeShrinkBlocked,
        "scopeshrinklargepruneerror" => RunnerErrorCause::ScopeShrinkLargePrune,
        "deltagaperror" => RunnerErrorCause::DeltaGap,
        "multipartsourcechangederror" => RunnerErrorCause::MultipartSourceChanged,
        "multipartaborterror" => RunnerErrorCause::MultipartAbort,
        "realtimeconflicterror" => RunnerErrorCause::RealtimeConflict,
        "unreachablepushpathserror" => RunnerErrorCause::UnreachablePushPaths,
        "pusheventdecodeerror" => RunnerErrorCause::PushEventDecode,
        "localsnapshotchangederror" => RunnerErrorCause::LocalSnapshotChanged,
        "rescuepathchangederror" => RunnerErrorCause::RescuePathChanged,
        // The vault identity family. The canonicalised class name is only ever a
        // lookup key here, never an emitted token, so the emitted `vault_identity`
        // stays denylist-free while the real class name still resolves.
        "vaultautherror" | "vaultidentityerror" => RunnerErrorCause::VaultIdentity,
        // AWS S3 / STS error names.
        "accessdenied" => RunnerErrorCause::AccessDenied,
        "nosuchkey" => RunnerErrorCause::NoSuchKey,
        "nosuchbucket" => RunnerErrorCause::NoSuchBucket,
        "slowdown" => RunnerErrorCause::SlowDown,
        "internalerror" => RunnerErrorCause::InternalError,
        "requesttimeout" => RunnerErrorCause::RequestTimeout,
        "expiredtoken" | "expiredtokenexception" => RunnerErrorCause::ExpiredIdentity,
        "invalidaccesskeyid" | "invalididentitytoken" | "invalidclienttokenid" => {
            RunnerErrorCause::InvalidIdentity
        }
        "unknownerror" => RunnerErrorCause::UnknownError,
        // Filesystem errno codes (a leading `EPERM:` token, or a `code=`/`cause=`
        // value). The class axis already distinguishes exactly these four.
        "eperm" => RunnerErrorCause::Eperm,
        "eacces" => RunnerErrorCause::Eacces,
        "enospc" => RunnerErrorCause::Enospc,
        "ebusy" => RunnerErrorCause::Ebusy,
        _ => return None,
    };
    Some(cause)
}

/// Read the whitespace-delimited value of a `describeError` `key=` (`code=EPERM`,
/// `syscall=unlink`), or `None` when the key is absent. Anchored on a key at the
/// start of input or preceded by ASCII whitespace, so `xcode=…` never matches.
/// Only the value up to the next ASCII whitespace is inspected; nothing is kept.
fn describe_error_key_value<'a>(message: &'a str, key: &str) -> Option<&'a str> {
    let bytes = message.as_bytes();
    for (idx, _) in message.match_indices(key) {
        let boundary_ok = idx == 0 || bytes[idx - 1].is_ascii_whitespace();
        if !boundary_ok {
            continue;
        }
        let value = message[idx + key.len()..]
            .split(|character: char| character.is_ascii_whitespace())
            .next()
            .unwrap_or("");
        if !value.is_empty() {
            return Some(value);
        }
    }
    None
}

/// Map an untrusted runner error message to a fixed cause token. Reads ONLY the
/// leading name token and the values of the `code=`, `cause=` and `syscall=`
/// `describeError` keys — never the `host=` value (the vault hostname) or any
/// free prose — each looked up in the closed allow-list. Returns `Unknown` rather
/// than a nearest guess, so the axis can only ever add information.
pub fn classify_runner_error_cause(message: &str) -> RunnerErrorCause {
    // 1. The leading name token — `describeError` pushes `e.name` first. A real
    //    name never contains `=`, so a `key=value` leading token (name === "Error"
    //    was skipped) falls through to the key scan below.
    if let Some(token) = message.split_whitespace().next() {
        if !token.contains('=') {
            if let Some(cause) = cause_from_identifier(token) {
                return cause;
            }
        }
    }
    // 2. The `code=`, `cause=` and `syscall=` key values, in that order. `host=`
    //    is deliberately never read.
    for key in ["code=", "cause=", "syscall="] {
        if let Some(value) = describe_error_key_value(message, key) {
            if let Some(cause) = cause_from_identifier(value) {
                return cause;
            }
        }
    }
    RunnerErrorCause::Unknown
}

/// Saturating per-pass counts of the closed cause vocabulary, indexed by
/// [`RunnerErrorCause`] discriminant. Renders a bounded Sentry tag such as
/// `access_denied:8,unknown:160`. Unlike the HTTP axis, every recorded error
/// contributes (an unrecognised message increments `unknown`), so the tag is
/// present whenever any runner error was recorded.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RunnerErrorCauseRollup {
    counts: [u32; RunnerErrorCause::ALL.len()],
}

impl RunnerErrorCauseRollup {
    /// Classify one runner error message and increment its cause count.
    pub fn record(&mut self, message: &str) {
        let index = classify_runner_error_cause(message) as usize;
        self.counts[index] = self.counts[index].saturating_add(1);
    }

    /// Declaration-ordered `(token, count)` pairs — the tie-break for equal counts.
    fn counts(&self) -> Vec<(&'static str, u32)> {
        RunnerErrorCause::ALL
            .iter()
            .map(|&cause| (cause.as_str(), self.counts[cause as usize]))
            .collect()
    }

    /// Render the top-N causes by count as a bounded Sentry tag. `None` when no
    /// runner error was recorded, so no tag should be sent.
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
        let shape_tokens = RunnerErrorShape::ALL.map(RunnerErrorShape::as_str);
        let path_tokens = RunnerPathRoot::ALL.map(RunnerPathRoot::as_str);
        let http_tokens = RunnerErrorHttpStatus::ALL.map(RunnerErrorHttpStatus::as_str);
        let cause_tokens = RunnerErrorCause::ALL.map(RunnerErrorCause::as_str);
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
            .chain(http_tokens)
            .chain(cause_tokens)
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

    #[test]
    fn http_and_cause_all_arrays_are_in_discriminant_order() {
        // The rollups index their count arrays by `variant as usize`, so `ALL`
        // must stay in discriminant order or a rollup would count the wrong token.
        for (index, status) in RunnerErrorHttpStatus::ALL.into_iter().enumerate() {
            assert_eq!(status as usize, index, "http ALL out of discriminant order");
        }
        for (index, cause) in RunnerErrorCause::ALL.into_iter().enumerate() {
            assert_eq!(cause as usize, index, "cause ALL out of discriminant order");
        }
    }

    #[test]
    fn classify_runner_error_http_status_maps_verbatim_producer_strings() {
        // describeError ` http=` grammar (company scope) and the presigned/HEAD
        // `: <status>` tail (per-file), taken verbatim from the cited hq-cloud
        // sources, plus the family fallbacks.
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
            (
                "presigned GET failed for knowledge/a.md: 403 Forbidden",
                RunnerErrorHttpStatus::Http403,
            ),
            (
                "presigned HEAD failed for knowledge/a.md: 404 ",
                RunnerErrorHttpStatus::Http404,
            ),
            (
                "tombstone HEAD verify failed (deferring): 500 Internal Server Error",
                RunnerErrorHttpStatus::Http500,
            ),
            // Unmodelled but valid statuses collapse to the family token.
            ("Error http=418 teapot", RunnerErrorHttpStatus::Http4xx),
            (
                "Error http=599 network read timeout",
                RunnerErrorHttpStatus::Http5xx,
            ),
        ] {
            assert_eq!(
                classify_runner_error_http_status(message),
                Some(expected),
                "message did not classify as expected: {message:?}"
            );
        }
    }

    #[test]
    fn classify_runner_error_http_status_never_reads_a_number_from_free_prose() {
        // A three-digit number that is not an anchored HTTP status must never be
        // mislabelled — a confident wrong status is worse than none.
        for message in [
            "downloaded 404 files",
            "retry after 500 ms",
            "tombstone unlink failed: EPERM",
            "403",
            "presigned GET succeeded for knowledge/a.md: 200 ",
            "conflict convergence probe failed: ETIMEDOUT",
            "download skipped: local parent escaped the sync root",
            // A four-digit run after the key is not a three-digit status.
            "Error http=4030 malformed",
            // Out of the 100..=599 HTTP range.
            "Error http=099 nonsense",
        ] {
            assert_eq!(
                classify_runner_error_http_status(message),
                None,
                "message should not yield a status: {message:?}"
            );
        }
    }

    #[test]
    fn http_rollup_renders_top_three_by_count_and_is_empty_when_no_status() {
        let mut rollup = RunnerErrorHttpRollup::default();
        for _ in 0..40 {
            rollup.record("presigned GET failed for repos/x: 500 ");
        }
        for _ in 0..8 {
            rollup.record("AccessDenied http=403 denied");
        }
        for _ in 0..2 {
            rollup.record("Error http=404 missing");
        }
        // A statusless message contributes nothing — absence never renders.
        for _ in 0..7205 {
            rollup.record("download skipped: local parent escaped the sync root");
        }
        let value = rollup.tag_value().expect("nonzero rollup renders a tag");
        assert_eq!(value, "http_500:40,http_403:8,http_404:2");
        assert!(value.split(',').count() <= ROLLUP_TAG_TOP_N);
        assert_eq!(RunnerErrorHttpRollup::default().tag_value(), None);
    }

    #[test]
    fn classify_runner_error_cause_maps_names_codes_and_defaults_to_unknown() {
        for (message, expected) in [
            // hq-cloud class names (describeError emits `this.name` first).
            (
                "EntityNotFoundError Entity 'acme' not found. Available: personal",
                RunnerErrorCause::EntityNotFound,
            ),
            (
                "OperationLockedError operation is locked",
                RunnerErrorCause::OperationLocked,
            ),
            (
                "DeltaGapError cursor gap detected",
                RunnerErrorCause::DeltaGap,
            ),
            (
                "RealtimeConflictError realtime convergence failed",
                RunnerErrorCause::RealtimeConflict,
            ),
            // AWS S3 / STS names and the opaque wrapper.
            (
                "AccessDenied http=403 denied",
                RunnerErrorCause::AccessDenied,
            ),
            ("NoSuchKey http=404 missing", RunnerErrorCause::NoSuchKey),
            (
                "UnknownError cause=EAI_AGAIN syscall=getaddrinfo host=vault.example",
                RunnerErrorCause::UnknownError,
            ),
            // Node fs errno via a leading token and via `code=`.
            (
                "EPERM: operation not permitted, unlink 'k/a.md'",
                RunnerErrorCause::Eperm,
            ),
            (
                "Error code=EACCES syscall=open host=irrelevant",
                RunnerErrorCause::Eacces,
            ),
            // Unmodelled name → Unknown, never a nearest guess.
            (
                "WidgetExplodedError the widget exploded",
                RunnerErrorCause::Unknown,
            ),
            (
                "presigned GET failed for k/a.md: 403 Forbidden",
                RunnerErrorCause::Unknown,
            ),
        ] {
            assert_eq!(
                classify_runner_error_cause(message),
                expected,
                "message did not classify as expected: {message:?}"
            );
        }
    }

    #[test]
    fn classify_runner_error_cause_never_reads_the_host_value() {
        // The vault hostname carries a company identifier and must never be read.
        let message =
            "AccessDenied http=403 host=hq-vault-cmp-abc123.s3.us-east-1.amazonaws.com denied";
        let cause = classify_runner_error_cause(message);
        assert_eq!(cause, RunnerErrorCause::AccessDenied);
        assert!(
            !cause.as_str().contains("hq-vault")
                && !cause.as_str().contains("amazonaws")
                && !cause.as_str().contains("abc123"),
            "cause token leaked a host fragment: {}",
            cause.as_str()
        );
    }

    #[test]
    fn cause_rollup_counts_unknown_and_renders_top_three() {
        let mut rollup = RunnerErrorCauseRollup::default();
        for _ in 0..160 {
            rollup.record("download skipped: local parent escaped the sync root");
        }
        for _ in 0..8 {
            rollup.record("AccessDenied http=403 denied");
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
    fn http_and_cause_rollups_are_order_independent_for_the_same_multiset() {
        let messages = [
            "AccessDenied http=403 denied",
            "presigned GET failed for repos/x: 500 ",
            "NoSuchKey http=404 missing",
            "download skipped: local parent escaped the sync root",
            "presigned GET failed for repos/y: 500 ",
        ];
        let mut forward_http = RunnerErrorHttpRollup::default();
        let mut forward_cause = RunnerErrorCauseRollup::default();
        for message in messages {
            forward_http.record(message);
            forward_cause.record(message);
        }
        let mut reverse_http = RunnerErrorHttpRollup::default();
        let mut reverse_cause = RunnerErrorCauseRollup::default();
        for message in messages.iter().rev() {
            reverse_http.record(message);
            reverse_cause.record(message);
        }
        assert_eq!(forward_http.tag_value(), reverse_http.tag_value());
        assert_eq!(forward_cause.tag_value(), reverse_cause.tag_value());
    }
}
