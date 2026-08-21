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
    /// Every variant, so egress-drift and denylist tests can enumerate the
    /// emitter's own token set instead of a hand-copied list.
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
    /// Every variant, so egress-drift tests can enumerate the emitter's own
    /// token set instead of a hand-copied list.
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
// HTTP-status and cause axes (HQ-DESKTOP-4T follow-up)
// ─────────────────────────────────────────────────────────────────────────────
//
// The message-shape axis above discriminates hq-cloud *pull-leg* prose, but the
// errors that actually terminate a company-scope leg are `describeError`
// renderings — `<Name> code=<C> http=<S> cause=<C> syscall=<S> host=<H> <msg>`
// (hq-cloud src/lib/describe-error.ts) — and the per-file pull leg emits
// `presigned GET|HEAD failed for <key>: <status> <detail>` (src/object-io.ts).
// Neither the class, op, nor shape axis parses the HTTP status that is present
// verbatim in both, nor the error identity that names the fault. These two
// additive axes recover exactly those two facts without ever copying a runner
// byte: every rendered token is a compile-time constant, and an unparseable
// message yields no HTTP tag / an `unknown` cause rather than a guessed one.

/// Fixed, content-safe HTTP-status tokens for a runner error. Specific tokens
/// for the statuses that actually discriminate an S3/STS or HTTP fault, plus a
/// bucketed `http_4xx`/`http_5xx` for anything else in range and `http_other`
/// for a non-4xx/5xx status. Every value is chosen in code, never copied.
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
    /// Declaration order is the render tie-break for equal counts, so a tag never
    /// flaps for the same multiset. Also lets tests enumerate the emitter's own
    /// token set.
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

    /// Map a parsed status integer to a token. Specific tokens win over their
    /// class bucket; anything outside 4xx/5xx (a 1xx/2xx/3xx that still parsed)
    /// falls to `http_other`.
    fn from_status(status: u16) -> Self {
        match status {
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

/// The literal ` http=` key `describeError` emits, kept with its leading space
/// so a substring such as `?ehttp=` inside a URL can never be read as the key.
const HTTP_STATUS_KEY: &str = " http=";

/// The exactly-three-ASCII-digit status field at the start of `text`, in
/// `100..=599`. The three digits must be a standalone field: the next byte, if
/// any, must be a boundary (not an ASCII letter or digit), so a longer number
/// like `4041` (a byte length) and a glued suffix like `403ms` or `500Internal`
/// are both rejected rather than truncated to a status.
fn take_exactly_three_digit_status(text: &str) -> Option<u16> {
    let bytes = text.as_bytes();
    if bytes.len() < 3 {
        return None;
    }
    let (d0, d1, d2) = (bytes[0], bytes[1], bytes[2]);
    if !(d0.is_ascii_digit() && d1.is_ascii_digit() && d2.is_ascii_digit()) {
        return None;
    }
    // Require a field boundary after the third digit: end of input, or any byte
    // that is neither a digit (a longer number) nor a letter (a glued suffix).
    if bytes.get(3).is_some_and(|byte| byte.is_ascii_alphanumeric()) {
        return None;
    }
    let status = u16::from(d0 - b'0') * 100 + u16::from(d1 - b'0') * 10 + u16::from(d2 - b'0');
    (100..=599).contains(&status).then_some(status)
}

/// True when `prefix` — the text preceding the ` http=` key — is a `describeError`
/// header and nothing else: an optional leading bare error-name token followed by
/// an optional `code=<val>` token. Those are the only tokens `describeError`
/// emits before `http=` (src/lib/describe-error.ts:30-32), so this rejects a
/// stray `http=<n>` that appears inside free runner prose.
fn is_describe_error_header(prefix: &str) -> bool {
    let mut tokens = prefix.split_whitespace();
    let mut next = tokens.next();
    // An optional leading error name — a bare token carrying no `=`.
    if next.is_some_and(|token| !token.contains('=')) {
        next = tokens.next();
    }
    // An optional single `code=<val>` token.
    if let Some(token) = next {
        if !token.starts_with("code=") {
            return false;
        }
        next = tokens.next();
    }
    // Nothing else may precede ` http=`.
    next.is_none()
}

/// Grammar (a): the three digits after the `describeError` ` http=` key, accepted
/// only when the text before the key is a `describeError` header — so the key is
/// anchored to the structure that emits it, not to any `http=<n>` in free prose.
fn parse_http_eq_status(message: &str) -> Option<u16> {
    let index = message.find(HTTP_STATUS_KEY)?;
    if !is_describe_error_header(&message[..index]) {
        return None;
    }
    take_exactly_three_digit_status(&message[index + HTTP_STATUS_KEY.len()..])
}

/// Grammar (b): the three digits immediately after the FIRST `": "`. Only ever
/// consulted for a message whose shape is already a presigned/HEAD-verify one,
/// where the producer format is `<prefix>: <status> <detail>` and the key/prefix
/// never contains `": "`, so the first separator is the status field — a later
/// `": "` inside the detail can never be mistaken for it.
fn parse_shape_anchored_status(message: &str) -> Option<u16> {
    const SEPARATOR: &str = ": ";
    let index = message.find(SEPARATOR)?;
    take_exactly_three_digit_status(&message[index + SEPARATOR.len()..])
}

/// Map an untrusted runner error message to a fixed HTTP-status token, parsing
/// exactly two anchored grammars and nothing else. Returns `None` when no status
/// parses, so an absent axis is simply absent — never rendered as evidence.
pub fn classify_runner_error_http_status(message: &str) -> Option<RunnerErrorHttpStatus> {
    // (a) The `describeError` ` http=` key — the most reliable signal and the
    // only one present on a company-scope error, so it is tried first.
    if let Some(status) = parse_http_eq_status(message) {
        return Some(RunnerErrorHttpStatus::from_status(status));
    }
    // (b) The `: <status>` tail of a per-file presigned/HEAD-verify failure,
    // gated on the shape so an arbitrary three-digit run in free prose is never
    // read as a status.
    match classify_runner_error_shape(message) {
        RunnerErrorShape::PresignedGetFailed
        | RunnerErrorShape::PresignedHeadFailed
        | RunnerErrorShape::TombstoneHeadVerifyFailed => {
            parse_shape_anchored_status(message).map(RunnerErrorHttpStatus::from_status)
        }
        _ => None,
    }
}

/// Saturating per-pass counts of the closed HTTP-status vocabulary. Renders a
/// compact Sentry tag such as `http_403:40,http_500:9`. An unparseable message
/// increments nothing, so a run with no HTTP-shaped error sends no tag.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RunnerErrorHttpRollup {
    counts: [u32; RunnerErrorHttpStatus::ALL.len()],
}

impl RunnerErrorHttpRollup {
    /// Classify one runner error message and increment its status count, if any.
    pub fn record(&mut self, message: &str) {
        let Some(status) = classify_runner_error_http_status(message) else {
            return;
        };
        if let Some(index) = RunnerErrorHttpStatus::ALL
            .iter()
            .position(|candidate| *candidate == status)
        {
            self.counts[index] = self.counts[index].saturating_add(1);
        }
    }

    /// Declaration-ordered `(token, count)` pairs — the stable tie-break for the
    /// bounded renderer.
    fn counts(&self) -> [(&'static str, u32); RunnerErrorHttpStatus::ALL.len()] {
        core::array::from_fn(|index| (RunnerErrorHttpStatus::ALL[index].as_str(), self.counts[index]))
    }

    /// Render the top-N statuses by count as a bounded Sentry tag. `None` when no
    /// HTTP-shaped error was recorded, so no tag should be sent.
    pub fn tag_value(&self) -> Option<String> {
        render_top_n(&self.counts(), ROLLUP_TAG_TOP_N)
    }
}

/// Fixed, content-safe *cause* tokens for a runner error — the error identity
/// that names the fault. Grounded in the observed producers: the hq-cloud error
/// class names `describeError` emits first (each subclass sets `this.name`), the
/// AWS S3/STS error names, and a final `unknown` for anything unrecognised.
///
/// Every identity-adjacent token is spelled to contain NONE of the Sentry
/// default-scrubber denylist substrings — hence `expired_identity`,
/// `invalid_identity`, and `vault_identity`, never `*_token`/`*_auth` — so the
/// server-side `@password:filter` can never silently delete the attribution
/// (the original HQ-DESKTOP-4T loss). Enforced by a machine-checked test.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunnerErrorCause {
    // hq-cloud error classes (this.name), grounded in the cited source sites.
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
    // AWS S3/STS error names.
    AccessDenied,
    NoSuchKey,
    NoSuchBucket,
    SlowDown,
    InternalError,
    RequestTimeout,
    ExpiredIdentity,
    InvalidIdentity,
    UnknownError,
    // Unrecognised — never a nearest guess. Distinct from `UnknownError`, which
    // is the AWS SDK's own `UnknownError` wrapper name.
    Unknown,
}

impl RunnerErrorCause {
    /// Declaration order is the render tie-break for equal counts and lets tests
    /// enumerate the emitter's own token set.
    pub const ALL: [RunnerErrorCause; 26] = [
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
            Self::Unknown => "unknown",
        }
    }
}

/// Map one raw identifier (a leading error name, or a `code=`/`cause=`/`syscall=`
/// value) to a cause token through the closed allow-list. Matched
/// case-sensitively against the exact producer spellings so an unrelated word
/// can never collide. Returns `None` for anything not in the vocabulary — the
/// caller then falls through to `Unknown` rather than guessing.
///
/// The match *patterns* are the untrusted producer strings (e.g. `"ExpiredToken"`)
/// and are never emitted; the emitted tokens are the denylist-safe `as_str`
/// values above.
fn cause_from_identifier(raw: &str) -> Option<RunnerErrorCause> {
    Some(match raw {
        // hq-cloud custom error class names (this.name).
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
        // The vault auth-error class, spelled safely so the scrubber cannot eat it.
        "VaultAuthError" => RunnerErrorCause::VaultIdentity,
        // AWS S3/STS error names (surfaced as `e.name` by the SDK, or as a
        // `code=`/`cause=` value by older wrappers).
        "AccessDenied" => RunnerErrorCause::AccessDenied,
        "NoSuchKey" => RunnerErrorCause::NoSuchKey,
        "NoSuchBucket" => RunnerErrorCause::NoSuchBucket,
        "SlowDown" => RunnerErrorCause::SlowDown,
        "InternalError" => RunnerErrorCause::InternalError,
        "RequestTimeout" => RunnerErrorCause::RequestTimeout,
        "ExpiredToken" | "ExpiredTokenException" => RunnerErrorCause::ExpiredIdentity,
        "InvalidToken" | "InvalidIdentityToken" => RunnerErrorCause::InvalidIdentity,
        "UnknownError" => RunnerErrorCause::UnknownError,
        _ => return None,
    })
}

/// Map an untrusted runner error message to a fixed cause token. Reads ONLY the
/// leading name token and the values of the `code=`, `cause=`, and `syscall=`
/// keys — never the `host=` value or any free prose — each looked up in the
/// closed allow-list. Returns `Unknown` rather than a nearest guess.
pub fn classify_runner_error_cause(message: &str) -> RunnerErrorCause {
    // 1) The leading name token, e.g. `AccessDenied` or `EntityPermissionError`.
    // Skipped when the first token is a `key=value` (`describeError` omits the
    // name for a plain `Error`), so a `code=…` is never misread as a name.
    if let Some(first) = message.split_whitespace().next() {
        if !first.contains('=') {
            if let Some(matched) = cause_from_identifier(first) {
                return matched;
            }
        }
    }
    // 2) The `code=` / `cause=` / `syscall=` values, in that precedence. A real
    // syscall is never a cause identifier, so `syscall=` only ever contributes
    // by being read and not matched — it can never surface a runner byte.
    let (mut code_value, mut cause_value, mut syscall_value) = (None, None, None);
    for token in message.split_whitespace() {
        if let Some(value) = token.strip_prefix("code=") {
            code_value.get_or_insert(value);
        } else if let Some(value) = token.strip_prefix("cause=") {
            cause_value.get_or_insert(value);
        } else if let Some(value) = token.strip_prefix("syscall=") {
            syscall_value.get_or_insert(value);
        }
    }
    for candidate in [code_value, cause_value, syscall_value].into_iter().flatten() {
        if let Some(matched) = cause_from_identifier(candidate) {
            return matched;
        }
    }
    RunnerErrorCause::Unknown
}

/// Saturating per-pass counts of the closed cause vocabulary. Renders a compact
/// Sentry tag such as `access_denied:8,unknown:160`. Every error is recorded,
/// with `unknown` for an unrecognised one, so the `unknown` count itself signals
/// when the vocabulary needs one more entry.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RunnerErrorCauseRollup {
    counts: [u32; RunnerErrorCause::ALL.len()],
}

impl RunnerErrorCauseRollup {
    /// Classify one runner error message and increment its cause count.
    pub fn record(&mut self, message: &str) {
        let cause = classify_runner_error_cause(message);
        if let Some(index) = RunnerErrorCause::ALL
            .iter()
            .position(|candidate| *candidate == cause)
        {
            self.counts[index] = self.counts[index].saturating_add(1);
        }
    }

    /// Declaration-ordered `(token, count)` pairs — the stable tie-break for the
    /// bounded renderer.
    fn counts(&self) -> [(&'static str, u32); RunnerErrorCause::ALL.len()] {
        core::array::from_fn(|index| (RunnerErrorCause::ALL[index].as_str(), self.counts[index]))
    }

    /// Render the top-N causes by count as a bounded Sentry tag. `None` when no
    /// runner error records were seen, so no tag should be sent.
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
        // The two additive axes, enumerated from their own token sets so a future
        // variant added without a safe spelling fails here rather than shipping a
        // tag the server-side @password:filter silently deletes.
        let http_tokens = RunnerErrorHttpStatus::ALL.map(RunnerErrorHttpStatus::as_str);
        let cause_tokens = RunnerErrorCause::ALL.map(RunnerErrorCause::as_str);
        for token in shape_tokens
            .into_iter()
            .chain(path_tokens)
            .chain(stack_tokens)
            .chain(http_tokens)
            .chain(cause_tokens)
        {
            for denied in DENYLIST {
                assert!(
                    !token.contains(denied),
                    "token {token:?} contains Sentry denylist substring {denied:?}"
                );
            }
        }
    }

    // ── HTTP-status axis ──────────────────────────────────────────────────────

    #[test]
    fn classify_http_status_maps_each_producer_string_to_its_token() {
        for (message, expected) in [
            // describeError ` http=` grammar (company-scope errors).
            (
                "AccessDenied http=403 The provided identity could not be validated",
                RunnerErrorHttpStatus::Http403,
            ),
            ("NoSuchKey http=404 the specified key does not exist", RunnerErrorHttpStatus::Http404),
            ("InternalError http=500 we encountered an internal error", RunnerErrorHttpStatus::Http500),
            ("SlowDown http=503 please reduce your request rate", RunnerErrorHttpStatus::Http503),
            ("Error http=409 journal write conflict", RunnerErrorHttpStatus::Http409),
            // Presigned/HEAD-verify shape-anchored `: <status>` tail (per-file).
            (
                "presigned GET failed for knowledge/a.md: 403 Forbidden",
                RunnerErrorHttpStatus::Http403,
            ),
            ("presigned HEAD failed for knowledge/a.md: 404 ", RunnerErrorHttpStatus::Http404),
            (
                "tombstone HEAD verify failed (deferring): 500 Internal Server Error",
                RunnerErrorHttpStatus::Http500,
            ),
            // Unmodelled statuses bucket to their class.
            ("Error http=418 i am a teapot", RunnerErrorHttpStatus::Http4xx),
            ("Error http=599 network connect timeout", RunnerErrorHttpStatus::Http5xx),
            // A presigned detail that itself contains ": <n>": the FIRST separator
            // after the key is the status, never the later one in the detail.
            (
                "presigned GET failed for k/a.md: 403 proxy: 500 upstream",
                RunnerErrorHttpStatus::Http403,
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
    fn classify_http_status_returns_none_for_prose_and_unanchored_digits() {
        // A three-digit number in free prose, or a `: <n>` tail on a message whose
        // shape is NOT presigned/HEAD-verify, must never be read as a status.
        for message in [
            "downloaded 404 files",
            "retry after 500 ms",
            "tombstone unlink failed: EPERM",
            "403",
            "presigned GET succeeded for knowledge/a.md: 200 ",
            "conflict mirror index write failed: 500", // a shape, but not an anchored one
            "download skipped: local parent escaped the sync root",
            // `http=<n>` in free prose is not a describeError header → not a status.
            "download failed; retry http=500 ms",
            "connection dropped, will retry http=503 shortly",
            // Three digits glued to a suffix are not a standalone status field.
            "Error http=403ms timeout",
            "presigned GET failed for k/a.md: 500InternalError",
        ] {
            assert_eq!(
                classify_runner_error_http_status(message),
                None,
                "message should have no status: {message:?}"
            );
        }
    }

    #[test]
    fn take_exactly_three_digit_status_requires_a_bounded_in_range_field() {
        assert_eq!(take_exactly_three_digit_status("403 x"), Some(403));
        assert_eq!(take_exactly_three_digit_status("404"), Some(404));
        assert_eq!(take_exactly_three_digit_status("409:"), Some(409)); // punctuation boundary ok
        assert_eq!(take_exactly_three_digit_status("4041"), None); // four digits
        assert_eq!(take_exactly_three_digit_status("403ms"), None); // glued letters
        assert_eq!(take_exactly_three_digit_status("500InternalError"), None);
        assert_eq!(take_exactly_three_digit_status("99 x"), None); // two digits
        assert_eq!(take_exactly_three_digit_status("099"), None); // 099 < 100
        assert_eq!(take_exactly_three_digit_status("600"), None); // 600 > 599
        assert_eq!(take_exactly_three_digit_status("abc"), None);
    }

    #[test]
    fn is_describe_error_header_accepts_only_the_name_and_code_prefix() {
        // The exact set describeError emits before ` http=`.
        assert!(is_describe_error_header("AccessDenied"));
        assert!(is_describe_error_header("code=ETIMEDOUT"));
        assert!(is_describe_error_header("UnknownError code=EAI_AGAIN"));
        assert!(is_describe_error_header("")); // no prefix at all
        // Free prose is not a header — the anchor that stops a prose false positive.
        assert!(!is_describe_error_header("download failed; retry"));
        assert!(!is_describe_error_header("please wait")); // two bare words
        assert!(!is_describe_error_header("cause=ENOENT")); // cause= never precedes http=
    }

    #[test]
    fn http_rollup_renders_top_three_and_is_empty_when_nothing_parses() {
        let mut rollup = RunnerErrorHttpRollup::default();
        for _ in 0..40 {
            rollup.record("presigned GET failed for repos/x: 500");
        }
        for _ in 0..8 {
            rollup.record("AccessDenied http=403 denied");
        }
        for _ in 0..2 {
            rollup.record("SlowDown http=503 slow down");
        }
        // Unparseable messages increment nothing.
        for _ in 0..99 {
            rollup.record("download skipped: local parent escaped the sync root");
        }
        let value = rollup.tag_value().expect("nonzero rollup renders a tag");
        assert_eq!(value, "http_500:40,http_403:8,http_503:2");
        assert!(value.split(',').count() <= ROLLUP_TAG_TOP_N);

        // A rollup that only ever saw unparseable messages sends no tag.
        let mut empty = RunnerErrorHttpRollup::default();
        empty.record("download complete: knowledge/a.md");
        assert_eq!(empty.tag_value(), None);
        assert_eq!(RunnerErrorHttpRollup::default().tag_value(), None);
    }

    // ── Cause axis ────────────────────────────────────────────────────────────

    #[test]
    fn classify_cause_maps_names_and_key_values_and_defaults_to_unknown() {
        use RunnerErrorCause::*;
        for (message, expected) in [
            // Leading hq-cloud class names.
            ("EntityPermissionError access is denied for cmp_x", EntityPermission),
            ("OperationLockedError the operation lock is held", OperationLocked),
            ("DeltaGapError delta cursor gap detected", DeltaGap),
            ("RealtimeConflictError concurrent mutation", RealtimeConflict),
            ("VaultAuthError session is not valid", VaultIdentity),
            // Leading AWS error names.
            ("AccessDenied http=403 denied", AccessDenied),
            ("NoSuchKey http=404 missing", NoSuchKey),
            ("UnknownError cause=EAI_AGAIN host=x.example.com", UnknownError),
            // A key value when the leading name is generic/unrecognised.
            ("Error code=SlowDown request throttled", SlowDown),
            ("WrapperError cause=InternalError upstream failed", InternalError),
            ("StsError code=ExpiredToken the security token expired", ExpiredIdentity),
            // A syscall/errno value is never a cause identity → falls through.
            ("Error syscall=unlink code=EPERM permission denied", Unknown),
            // Unmodelled leading name → Unknown, never a nearest guess.
            ("KaboomError the sky is falling", Unknown),
            // Per-file pull-leg prose has no identity → Unknown.
            ("presigned GET failed for knowledge/a.md: 403 Forbidden", Unknown),
        ] {
            assert_eq!(
                classify_runner_error_cause(message),
                expected,
                "message did not classify as expected: {message:?}"
            );
        }
    }

    #[test]
    fn classify_cause_never_reads_the_host_value() {
        // A recognised name plus a secret-looking `host=` — the token must be the
        // name's identity and must not carry a single byte of the hostname.
        let message =
            "AccessDenied http=403 host=hq-vault-cmp-acme-9f3.s3.us-east-1.amazonaws.com denied";
        assert_eq!(classify_runner_error_cause(message), RunnerErrorCause::AccessDenied);

        let mut rollup = RunnerErrorCauseRollup::default();
        rollup.record(message);
        let value = rollup.tag_value().expect("nonzero rollup renders a tag");
        assert_eq!(value, "access_denied:1");
        for fragment in ["hq-vault", "acme", "9f3", "amazonaws", "host="] {
            assert!(
                !value.contains(fragment),
                "rendered cause tag leaked host fragment {fragment:?}: {value}"
            );
        }
    }

    #[test]
    fn cause_rollup_renders_top_three_by_count_with_stable_order() {
        let mut rollup = RunnerErrorCauseRollup::default();
        for _ in 0..160 {
            rollup.record("presigned GET failed for repos/x: 500"); // unknown
        }
        for _ in 0..8 {
            rollup.record("AccessDenied http=403 denied");
        }
        for _ in 0..8 {
            rollup.record("NoSuchKey http=404 missing");
        }
        let value = rollup.tag_value().expect("nonzero rollup renders a tag");
        // 160 unknown wins; access_denied and no_such_key tie at 8, and declaration
        // order (access_denied precedes no_such_key) breaks it deterministically.
        assert_eq!(value, "unknown:160,access_denied:8,no_such_key:8");
        assert!(value.split(',').count() <= ROLLUP_TAG_TOP_N);
        assert_eq!(RunnerErrorCauseRollup::default().tag_value(), None);
    }

    #[test]
    fn new_rollups_are_order_independent_for_the_same_multiset() {
        let messages = [
            "AccessDenied http=403 denied",
            "presigned GET failed for repos/x: 500",
            "NoSuchKey http=404 missing",
            "SlowDown http=503 slow",
            "download skipped: local parent escaped the sync root",
        ];
        let forward_http = {
            let mut rollup = RunnerErrorHttpRollup::default();
            messages.iter().for_each(|message| rollup.record(message));
            rollup
        };
        let reversed_http = {
            let mut rollup = RunnerErrorHttpRollup::default();
            messages.iter().rev().for_each(|message| rollup.record(message));
            rollup
        };
        assert_eq!(forward_http, reversed_http);

        let forward_cause = {
            let mut rollup = RunnerErrorCauseRollup::default();
            messages.iter().for_each(|message| rollup.record(message));
            rollup
        };
        let reversed_cause = {
            let mut rollup = RunnerErrorCauseRollup::default();
            messages.iter().rev().for_each(|message| rollup.record(message));
            rollup
        };
        assert_eq!(forward_cause, reversed_cause);
    }

    #[test]
    fn new_rollups_stay_bounded_and_stable_under_a_flood() {
        let mut http = RunnerErrorHttpRollup::default();
        let mut cause = RunnerErrorCauseRollup::default();
        for _ in 0..7205 {
            http.record("presigned GET failed for repos/x: 500");
            cause.record("AccessDenied http=403 denied");
        }
        let http_value = http.tag_value().expect("tag");
        let cause_value = cause.tag_value().expect("tag");
        assert_eq!(http_value, "http_500:7205");
        assert_eq!(cause_value, "access_denied:7205");
        // Both well under Sentry's 200-char tag-value limit.
        assert!(http_value.len() < 200 && cause_value.len() < 200);
    }
}
