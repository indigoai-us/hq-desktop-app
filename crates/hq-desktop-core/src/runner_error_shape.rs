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
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

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

/// The hq-cloud version whose `this.name` identity set the [`RunnerErrorCause`]
/// vocabulary below was derived from. Pinned equal to
/// [`crate::hq_cloud::HQ_CLOUD_VERSION`] by
/// `cause_vocabulary_source_version_is_pinned_to_the_runner`, so editing the
/// runner pin without re-deriving the identity list from the new hq-cloud source
/// fails the build. This is the guard against a silent vocabulary-drift reopen:
/// the prior fix pinned its vocabulary to a 16-name *sample* of hq-cloud's
/// identities and collapsed every out-of-sample company-scope fault back to
/// `unknown`, which is exactly the recurrence this change closes.
///
/// Scope, deliberately two-layered. This static equality catches a *maintainer*
/// editing the runner pin (e.g. to `~6.16.0`) without re-deriving. It does NOT —
/// and statically cannot — catch WITHIN-range drift: `~6.15.37` lets npx resolve
/// any later `6.15.x` at runtime, so `6.15.38` adding a new class does not change
/// either constant. That residual drift is covered at runtime by the second
/// layer: a new class arrives as an `unknown_named` cause plus a stable
/// `runner_error_cause_signature`, so it surfaces as a decodable correlator
/// rather than silently collapsing to a flat `unknown`. The pin forces
/// re-derivation on a coarse bump; the signature axis absorbs the fine drift in
/// between.
pub const CAUSE_VOCABULARY_SOURCE_VERSION: &str = "~6.15.79";

/// Compile-time byte-equality for two `&str`, used only by the vocabulary-drift
/// guard below. A stable-Rust `const fn` (a `while` byte loop, no new
/// dependency) so the guard can fire during `cargo build`/`cargo check` rather
/// than only under `cargo test`.
const fn const_str_eq(left: &str, right: &str) -> bool {
    let (left, right) = (left.as_bytes(), right.as_bytes());
    if left.len() != right.len() {
        return false;
    }
    let mut index = 0;
    while index < left.len() {
        if left[index] != right[index] {
            return false;
        }
        index += 1;
    }
    true
}

/// The vocabulary-drift guard, moved EARLIER than the prior `#[test]`: a
/// compile-time assertion that [`CAUSE_VOCABULARY_SOURCE_VERSION`] still equals
/// [`crate::hq_cloud::HQ_CLOUD_VERSION`]. The prior fix relied only on the
/// `#[test]` (kept below as the message-carrying layer), but a branch cut before
/// that test existed — PR #533 — bumped the runner pin and merged a combination
/// its CI never ran, silently disarming the guard on `main`. A `const`
/// assertion instead fails `cargo build`/`cargo check` on EVERY branch and
/// target (including the required Windows `cargo check` job), so a runner-pin
/// bump can no longer reach `main` without the cause vocabulary re-derived here.
const _: () = assert!(
    const_str_eq(
        CAUSE_VOCABULARY_SOURCE_VERSION,
        crate::hq_cloud::HQ_CLOUD_VERSION
    ),
    "hq-cloud runner pin changed: re-derive the RunnerErrorCause vocabulary and \
     the test's HQ_CLOUD_IDENTITIES from the new hq-cloud source, then set \
     CAUSE_VOCABULARY_SOURCE_VERSION equal to HQ_CLOUD_VERSION",
);

/// Length of a `runner_error_cause_signature` token: the first 12 lowercase hex
/// chars of the SHA-256 of a gated leading identity. Long enough that a collision
/// between two real error-class names is negligible, short enough to keep the
/// bounded tag well under Sentry's limit and to stay offline-decodable by hashing
/// candidate class names.
const SIGNATURE_HEX_LEN: usize = 12;

/// Hard cap on how many DISTINCT signatures the per-pass signature accumulator
/// retains. Unlike the fixed-array rollups, the signature map is keyed by an
/// open-ended digest, so a faulty or hostile runner emitting many distinct
/// uppercase-CamelCase identifiers could otherwise grow it without bound and
/// exhaust process memory. Comfortably above the rendered top-3 and any realistic
/// per-pass identity count (a real recurrence carries one or two distinct
/// identities), so genuine correlators are always retained; a pathological flood
/// past the cap simply stops inserting NEW keys.
const SIGNATURE_ROLLUP_CAP: usize = 64;

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
    // ── hq-cloud error classes (this.name) ────────────────────────────────────
    // Derived mechanically from the complete `this.name = "…"` set across the
    // pinned hq-cloud source (see `CAUSE_VOCABULARY_SOURCE_VERSION`), so this is
    // the producer's ACTUAL identity set — not the 16-name sample the prior fix
    // took, whose out-of-sample faults collapsed to `unknown` and reopened this
    // lane. Each subclass sets `this.name`, which `describeError` emits as the
    // leading token.
    EntityNotFound,
    EntityPermission,
    EntityResolution,
    SourceNotFound,
    OperationLocked,
    OperationLockUnwritable,
    ScopeShrinkBlocked,
    ScopeShrinkLargePrune,
    DeltaGap,
    MultipartSourceChanged,
    MultipartAbort,
    RealtimeConflict,
    RealtimeEnrollmentUnavailable,
    SyncMutationNotEnrolled,
    UnreachablePushPaths,
    ServerOwnedPushPaths,
    PushEventDecode,
    // Retained from the prior vocabulary though the class is absent from the
    // current pinned source: a within-range older runner may still emit it, and a
    // token that never fires is harmless, whereas dropping it could lose a real
    // identity mid-rollout.
    LocalSnapshotChanged,
    RescuePathChanged,
    CursorRetired,
    BaseVersionUnavailable,
    DurableApply,
    DurableApplyRecovery,
    JournalCheckpoint,
    PrematureJournalEntry,
    SnapshotClient,
    StateStoreCorruption,
    StateStoreLock,
    StateStoreReducer,
    VaultIdentity,
    VaultClient,
    VaultConflict,
    VaultNotFound,
    VaultPermissionDenied,
    VendDenied,
    RateLimited,
    PresignPreconditionMissing,
    OutpostHttp,
    TombstoneFetch,
    UnregisteredCompanySkill,
    RefreshLockTimeout,
    // Cognito identity classes, spelled `cognito_identity[_refresh]` so the
    // server-side `@password:filter` cannot eat them (never `*_auth`/`*_token`).
    CognitoIdentity,
    CognitoIdentityRefresh,
    DanglingSymlinkParent,
    WindowsSymlinkPrivilege,
    // Added when the runner pin moved to ~6.15.79: hq-cloud 6.15.79 introduced
    // `ChildProcessSyncWorkerError` (src/sync/child-process-sync-worker.ts), the
    // one identity the prior vocabulary was missing at the new pin.
    ChildProcessSyncWorker,
    // ── AWS S3/STS error names ────────────────────────────────────────────────
    AccessDenied,
    NoSuchKey,
    NoSuchBucket,
    SlowDown,
    InternalError,
    RequestTimeout,
    ExpiredIdentity,
    InvalidIdentity,
    UnknownError,
    // ── ECMAScript / Node built-in error identities ───────────────────────────
    // `describeError` emits `e.name` verbatim as the leading token for any
    // non-`Error` name, so a JS built-in is a first-class producer input. This
    // family is defined by the language and Node — NOT by hq-cloud — so it is
    // pinned by its own enumerating test, not by CAUSE_VOCABULARY_SOURCE_VERSION.
    // `RangeError` is the production recurrence that reopened this cluster
    // (sha256("RangeError")[..12] == "93c5a7a535cb", the observed tag value).
    RangeError,
    TypeError,
    SyntaxError,
    ReferenceError,
    EvalError,
    UriError,
    AggregateError,
    AbortError,
    SystemError,
    // ── Node/libuv errno codes ────────────────────────────────────────────────
    // A plain Node system error renders `code=<ERRNO> <ERRNO>: <text>, <op>
    // <path>`; the errno is read from the `code=` value or a leading bare
    // `ERRNO:` token, never from free prose. Closed allow-list, so an errno
    // mentioned inside a message can never leak. Includes the four the class axis
    // already knows (EPERM/EACCES/ENOSPC/EBUSY) so the cause and class axes agree
    // on the same message.
    Enoent,
    Eexist,
    Enotempty,
    Exdev,
    Eisdir,
    Enotdir,
    Eloop,
    Enametoolong,
    Emfile,
    Enfile,
    Erofs,
    Eio,
    Eagain,
    Epipe,
    Etimedout,
    Econnreset,
    Econnrefused,
    Enotfound,
    Ehostunreach,
    Enetunreach,
    EaiAgain,
    Eperm,
    Eacces,
    Enospc,
    Ebusy,
    // ── Residual (never a nearest guess) ──────────────────────────────────────
    // A leading, uppercase-initial identity token was present but matched nothing
    // in the vocabulary above: a class hq-cloud added since the pin, or a
    // non-hq-cloud (Node/undici/AWS) error name. Self-describing — correlatable
    // across machines through the `runner_error_cause_signature` axis and
    // offline-decodable by hashing candidate class names.
    UnknownNamed,
    // `describeError` emitted no leading identity token at all: a plain `Error`
    // whose name was suppressed, a leading `key=value`, or lower-cased pull-leg
    // prose. There is no identity to name, so no signature is attached.
    UnknownUnnamed,
}

impl RunnerErrorCause {
    /// Declaration order is the render tie-break for equal counts and lets tests
    /// enumerate the emitter's own token set.
    pub const ALL: [RunnerErrorCause; 91] = [
        Self::EntityNotFound,
        Self::EntityPermission,
        Self::EntityResolution,
        Self::SourceNotFound,
        Self::OperationLocked,
        Self::OperationLockUnwritable,
        Self::ScopeShrinkBlocked,
        Self::ScopeShrinkLargePrune,
        Self::DeltaGap,
        Self::MultipartSourceChanged,
        Self::MultipartAbort,
        Self::RealtimeConflict,
        Self::RealtimeEnrollmentUnavailable,
        Self::SyncMutationNotEnrolled,
        Self::UnreachablePushPaths,
        Self::ServerOwnedPushPaths,
        Self::PushEventDecode,
        Self::LocalSnapshotChanged,
        Self::RescuePathChanged,
        Self::CursorRetired,
        Self::BaseVersionUnavailable,
        Self::DurableApply,
        Self::DurableApplyRecovery,
        Self::JournalCheckpoint,
        Self::PrematureJournalEntry,
        Self::SnapshotClient,
        Self::StateStoreCorruption,
        Self::StateStoreLock,
        Self::StateStoreReducer,
        Self::VaultIdentity,
        Self::VaultClient,
        Self::VaultConflict,
        Self::VaultNotFound,
        Self::VaultPermissionDenied,
        Self::VendDenied,
        Self::RateLimited,
        Self::PresignPreconditionMissing,
        Self::OutpostHttp,
        Self::TombstoneFetch,
        Self::UnregisteredCompanySkill,
        Self::RefreshLockTimeout,
        Self::CognitoIdentity,
        Self::CognitoIdentityRefresh,
        Self::DanglingSymlinkParent,
        Self::WindowsSymlinkPrivilege,
        Self::ChildProcessSyncWorker,
        Self::AccessDenied,
        Self::NoSuchKey,
        Self::NoSuchBucket,
        Self::SlowDown,
        Self::InternalError,
        Self::RequestTimeout,
        Self::ExpiredIdentity,
        Self::InvalidIdentity,
        Self::UnknownError,
        Self::RangeError,
        Self::TypeError,
        Self::SyntaxError,
        Self::ReferenceError,
        Self::EvalError,
        Self::UriError,
        Self::AggregateError,
        Self::AbortError,
        Self::SystemError,
        Self::Enoent,
        Self::Eexist,
        Self::Enotempty,
        Self::Exdev,
        Self::Eisdir,
        Self::Enotdir,
        Self::Eloop,
        Self::Enametoolong,
        Self::Emfile,
        Self::Enfile,
        Self::Erofs,
        Self::Eio,
        Self::Eagain,
        Self::Epipe,
        Self::Etimedout,
        Self::Econnreset,
        Self::Econnrefused,
        Self::Enotfound,
        Self::Ehostunreach,
        Self::Enetunreach,
        Self::EaiAgain,
        Self::Eperm,
        Self::Eacces,
        Self::Enospc,
        Self::Ebusy,
        Self::UnknownNamed,
        Self::UnknownUnnamed,
    ];

    /// Fixed vocabulary safe for Sentry tags. Never derived from runner input.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::EntityNotFound => "entity_not_found",
            Self::EntityPermission => "entity_permission",
            Self::EntityResolution => "entity_resolution",
            Self::SourceNotFound => "source_not_found",
            Self::OperationLocked => "operation_locked",
            Self::OperationLockUnwritable => "operation_lock_unwritable",
            Self::ScopeShrinkBlocked => "scope_shrink_blocked",
            Self::ScopeShrinkLargePrune => "scope_shrink_large_prune",
            Self::DeltaGap => "delta_gap",
            Self::MultipartSourceChanged => "multipart_source_changed",
            Self::MultipartAbort => "multipart_abort",
            Self::RealtimeConflict => "realtime_conflict",
            Self::RealtimeEnrollmentUnavailable => "realtime_enrollment_unavailable",
            Self::SyncMutationNotEnrolled => "sync_mutation_not_enrolled",
            Self::UnreachablePushPaths => "unreachable_push_paths",
            Self::ServerOwnedPushPaths => "server_owned_push_paths",
            Self::PushEventDecode => "push_event_decode",
            Self::LocalSnapshotChanged => "local_snapshot_changed",
            Self::RescuePathChanged => "rescue_path_changed",
            Self::CursorRetired => "cursor_retired",
            Self::BaseVersionUnavailable => "base_version_unavailable",
            Self::DurableApply => "durable_apply",
            Self::DurableApplyRecovery => "durable_apply_recovery",
            Self::JournalCheckpoint => "journal_checkpoint",
            Self::PrematureJournalEntry => "premature_journal_entry",
            Self::SnapshotClient => "snapshot_client",
            Self::StateStoreCorruption => "state_store_corruption",
            Self::StateStoreLock => "state_store_lock",
            Self::StateStoreReducer => "state_store_reducer",
            Self::VaultIdentity => "vault_identity",
            Self::VaultClient => "vault_client",
            Self::VaultConflict => "vault_conflict",
            Self::VaultNotFound => "vault_not_found",
            Self::VaultPermissionDenied => "vault_permission_denied",
            Self::VendDenied => "vend_denied",
            Self::RateLimited => "rate_limited",
            Self::PresignPreconditionMissing => "presign_precondition_missing",
            Self::OutpostHttp => "outpost_http",
            Self::TombstoneFetch => "tombstone_fetch",
            Self::UnregisteredCompanySkill => "unregistered_company_skill",
            Self::RefreshLockTimeout => "refresh_lock_timeout",
            Self::CognitoIdentity => "cognito_identity",
            Self::CognitoIdentityRefresh => "cognito_identity_refresh",
            Self::DanglingSymlinkParent => "dangling_symlink_parent",
            Self::WindowsSymlinkPrivilege => "windows_symlink_privilege",
            Self::ChildProcessSyncWorker => "child_process_sync_worker",
            Self::AccessDenied => "access_denied",
            Self::NoSuchKey => "no_such_key",
            Self::NoSuchBucket => "no_such_bucket",
            Self::SlowDown => "slow_down",
            Self::InternalError => "internal_error",
            Self::RequestTimeout => "request_timeout",
            Self::ExpiredIdentity => "expired_identity",
            Self::InvalidIdentity => "invalid_identity",
            Self::UnknownError => "unknown_error",
            Self::RangeError => "range_error",
            Self::TypeError => "type_error",
            Self::SyntaxError => "syntax_error",
            Self::ReferenceError => "reference_error",
            Self::EvalError => "eval_error",
            Self::UriError => "uri_error",
            Self::AggregateError => "aggregate_error",
            Self::AbortError => "abort_error",
            Self::SystemError => "system_error",
            Self::Enoent => "enoent",
            Self::Eexist => "eexist",
            Self::Enotempty => "enotempty",
            Self::Exdev => "exdev",
            Self::Eisdir => "eisdir",
            Self::Enotdir => "enotdir",
            Self::Eloop => "eloop",
            Self::Enametoolong => "enametoolong",
            Self::Emfile => "emfile",
            Self::Enfile => "enfile",
            Self::Erofs => "erofs",
            Self::Eio => "eio",
            Self::Eagain => "eagain",
            Self::Epipe => "epipe",
            Self::Etimedout => "etimedout",
            Self::Econnreset => "econnreset",
            Self::Econnrefused => "econnrefused",
            Self::Enotfound => "enotfound",
            Self::Ehostunreach => "ehostunreach",
            Self::Enetunreach => "enetunreach",
            Self::EaiAgain => "eai_again",
            Self::Eperm => "eperm",
            Self::Eacces => "eacces",
            Self::Enospc => "enospc",
            Self::Ebusy => "ebusy",
            Self::UnknownNamed => "unknown_named",
            Self::UnknownUnnamed => "unknown_unnamed",
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
        // hq-cloud custom error class names (this.name). The complete set derived
        // from the pinned hq-cloud source; every name here corresponds to a
        // `this.name = "…"` site at `CAUSE_VOCABULARY_SOURCE_VERSION`.
        "EntityNotFoundError" => RunnerErrorCause::EntityNotFound,
        "EntityPermissionError" => RunnerErrorCause::EntityPermission,
        "EntityResolutionError" => RunnerErrorCause::EntityResolution,
        "SourceNotFoundError" => RunnerErrorCause::SourceNotFound,
        "OperationLockedError" => RunnerErrorCause::OperationLocked,
        "OperationLockUnwritableError" => RunnerErrorCause::OperationLockUnwritable,
        "ScopeShrinkBlockedError" => RunnerErrorCause::ScopeShrinkBlocked,
        "ScopeShrinkLargePruneError" => RunnerErrorCause::ScopeShrinkLargePrune,
        "DeltaGapError" => RunnerErrorCause::DeltaGap,
        "MultipartSourceChangedError" => RunnerErrorCause::MultipartSourceChanged,
        "MultipartAbortError" => RunnerErrorCause::MultipartAbort,
        "RealtimeConflictError" => RunnerErrorCause::RealtimeConflict,
        "RealtimeEnrollmentUnavailableError" => RunnerErrorCause::RealtimeEnrollmentUnavailable,
        "SyncMutationNotEnrolledError" => RunnerErrorCause::SyncMutationNotEnrolled,
        "UnreachablePushPathsError" => RunnerErrorCause::UnreachablePushPaths,
        "ServerOwnedPushPathsError" => RunnerErrorCause::ServerOwnedPushPaths,
        "PushEventDecodeError" => RunnerErrorCause::PushEventDecode,
        "LocalSnapshotChangedError" => RunnerErrorCause::LocalSnapshotChanged,
        "RescuePathChangedError" => RunnerErrorCause::RescuePathChanged,
        "CursorRetiredError" => RunnerErrorCause::CursorRetired,
        "AuthoritativeBaseVersionUnavailableError" => RunnerErrorCause::BaseVersionUnavailable,
        "DurableApplyError" => RunnerErrorCause::DurableApply,
        "DurableApplyRecoveryError" => RunnerErrorCause::DurableApplyRecovery,
        "JournalCheckpointError" => RunnerErrorCause::JournalCheckpoint,
        "PrematureJournalEntryError" => RunnerErrorCause::PrematureJournalEntry,
        "SnapshotClientError" => RunnerErrorCause::SnapshotClient,
        "StateStoreCorruptionError" => RunnerErrorCause::StateStoreCorruption,
        "StateStoreLockError" => RunnerErrorCause::StateStoreLock,
        "StateStoreReducerError" => RunnerErrorCause::StateStoreReducer,
        // The vault auth-error class, spelled safely so the scrubber cannot eat it.
        "VaultAuthError" => RunnerErrorCause::VaultIdentity,
        "VaultClientError" => RunnerErrorCause::VaultClient,
        "VaultConflictError" => RunnerErrorCause::VaultConflict,
        "VaultNotFoundError" => RunnerErrorCause::VaultNotFound,
        "VaultPermissionDeniedError" => RunnerErrorCause::VaultPermissionDenied,
        "VendDeniedError" => RunnerErrorCause::VendDenied,
        "RateLimited" => RunnerErrorCause::RateLimited,
        "PresignPreconditionMissing" => RunnerErrorCause::PresignPreconditionMissing,
        "OutpostHttpError" => RunnerErrorCause::OutpostHttp,
        "TombstoneFetchError" => RunnerErrorCause::TombstoneFetch,
        "UnregisteredCompanySkillError" => RunnerErrorCause::UnregisteredCompanySkill,
        "RefreshLockTimeoutError" => RunnerErrorCause::RefreshLockTimeout,
        // Cognito identity classes, emitted as the safe `cognito_identity` spelling.
        "CognitoAuthError" => RunnerErrorCause::CognitoIdentity,
        "CognitoRefreshError" => RunnerErrorCause::CognitoIdentityRefresh,
        "DanglingSymlinkParentError" => RunnerErrorCause::DanglingSymlinkParent,
        "WindowsSymlinkPrivilegeError" => RunnerErrorCause::WindowsSymlinkPrivilege,
        // Added at the ~6.15.79 pin (src/sync/child-process-sync-worker.ts).
        "ChildProcessSyncWorkerError" => RunnerErrorCause::ChildProcessSyncWorker,
        // AWS S3/STS error names (surfaced as `e.name` by the SDK, or as a
        // `code=`/`cause=` value by older wrappers). hq-cloud's own
        // `AccessDeniedError` class shares the `access_denied` identity.
        "AccessDenied" | "AccessDeniedError" => RunnerErrorCause::AccessDenied,
        "NoSuchKey" => RunnerErrorCause::NoSuchKey,
        "NoSuchBucket" => RunnerErrorCause::NoSuchBucket,
        "SlowDown" => RunnerErrorCause::SlowDown,
        "InternalError" => RunnerErrorCause::InternalError,
        "RequestTimeout" => RunnerErrorCause::RequestTimeout,
        "ExpiredToken" | "ExpiredTokenException" => RunnerErrorCause::ExpiredIdentity,
        "InvalidToken" | "InvalidIdentityToken" => RunnerErrorCause::InvalidIdentity,
        "UnknownError" => RunnerErrorCause::UnknownError,
        // ECMAScript / Node built-in error names, emitted verbatim as `e.name`
        // by describeError. `URIError` is spelled with the leading `URI` acronym
        // exactly as the language names it.
        "RangeError" => RunnerErrorCause::RangeError,
        "TypeError" => RunnerErrorCause::TypeError,
        "SyntaxError" => RunnerErrorCause::SyntaxError,
        "ReferenceError" => RunnerErrorCause::ReferenceError,
        "EvalError" => RunnerErrorCause::EvalError,
        "URIError" => RunnerErrorCause::UriError,
        "AggregateError" => RunnerErrorCause::AggregateError,
        "AbortError" => RunnerErrorCause::AbortError,
        "SystemError" => RunnerErrorCause::SystemError,
        // Node/libuv errno codes, read from a `code=`/`cause=`/`syscall=` value or
        // a leading bare `ERRNO:` token (never free prose). The exact producer
        // spellings are uppercase.
        "ENOENT" => RunnerErrorCause::Enoent,
        "EEXIST" => RunnerErrorCause::Eexist,
        "ENOTEMPTY" => RunnerErrorCause::Enotempty,
        "EXDEV" => RunnerErrorCause::Exdev,
        "EISDIR" => RunnerErrorCause::Eisdir,
        "ENOTDIR" => RunnerErrorCause::Enotdir,
        "ELOOP" => RunnerErrorCause::Eloop,
        "ENAMETOOLONG" => RunnerErrorCause::Enametoolong,
        "EMFILE" => RunnerErrorCause::Emfile,
        "ENFILE" => RunnerErrorCause::Enfile,
        "EROFS" => RunnerErrorCause::Erofs,
        "EIO" => RunnerErrorCause::Eio,
        "EAGAIN" => RunnerErrorCause::Eagain,
        "EPIPE" => RunnerErrorCause::Epipe,
        "ETIMEDOUT" => RunnerErrorCause::Etimedout,
        "ECONNRESET" => RunnerErrorCause::Econnreset,
        "ECONNREFUSED" => RunnerErrorCause::Econnrefused,
        "ENOTFOUND" => RunnerErrorCause::Enotfound,
        "EHOSTUNREACH" => RunnerErrorCause::Ehostunreach,
        "ENETUNREACH" => RunnerErrorCause::Enetunreach,
        "EAI_AGAIN" => RunnerErrorCause::EaiAgain,
        "EPERM" => RunnerErrorCause::Eperm,
        "EACCES" => RunnerErrorCause::Eacces,
        "ENOSPC" => RunnerErrorCause::Enospc,
        "EBUSY" => RunnerErrorCause::Ebusy,
        _ => return None,
    })
}

/// True when `token` is a bare identifier — non-empty and every byte ASCII
/// alphanumeric or `_` (so `EAI_AGAIN` qualifies). Used to gate the leading
/// `ERRNO:` lookup so only a clean errno token reaches the closed allow-list; a
/// token carrying a path, URL, quote, or `=`/`:` separator is refused.
fn is_bare_identifier_token(token: &str) -> bool {
    !token.is_empty()
        && token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

/// Map an untrusted runner error message to a fixed cause token. Reads ONLY the
/// leading name token and the values of the `code=`, `cause=`, and `syscall=`
/// keys — never the `host=` value or any free prose — each looked up in the
/// closed allow-list. An unmatched message is never a nearest guess: it splits
/// into [`RunnerErrorCause::UnknownNamed`] when a leading, uppercase-initial
/// identity token was present (still correlatable via
/// [`runner_error_cause_signature`]) and [`RunnerErrorCause::UnknownUnnamed`]
/// otherwise.
pub fn classify_runner_error_cause(message: &str) -> RunnerErrorCause {
    // 1) The leading name token, e.g. `AccessDenied` or `EntityPermissionError`.
    // Skipped when the first token is a `key=value` (`describeError` omits the
    // name for a plain `Error`), so a `code=…` is never misread as a name.
    if let Some(first) = message.split_whitespace().next() {
        if !first.contains('=') {
            if let Some(matched) = cause_from_identifier(first) {
                return matched;
            }
            // A leading bare `ERRNO:` token — `describeError`'s plain-Node
            // rendering `ENOENT: no such file …, rename …`. Trim at most ONE
            // trailing ':' and retry, but only when the trimmed token is a bare
            // identifier: a token carrying any other separator (a path, URL, or
            // already-`key=value` token) is left untouched, so nothing outside
            // the closed errno allow-list can match.
            if let Some(stripped) = first.strip_suffix(':') {
                if is_bare_identifier_token(stripped) {
                    if let Some(matched) = cause_from_identifier(stripped) {
                        return matched;
                    }
                }
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
    // 3) Unmatched residual, never a nearest guess. A leading, uppercase-initial
    // identity token makes this `UnknownNamed` — a real but unlisted class we can
    // still correlate by signature; anything else (a suppressed name, a leading
    // `key=value`, pull-leg prose, a path) is `UnknownUnnamed`.
    if leading_error_identity(message).is_some() {
        RunnerErrorCause::UnknownNamed
    } else {
        RunnerErrorCause::UnknownUnnamed
    }
}

/// The leading error-class identity of a `describeError` rendering, or `None`
/// when the message carries none. `describeError` emits `e.name` first, and only
/// when `e.name !== "Error"`, so a real fault leads with its CamelCase class name.
///
/// Gated to a bare, **multi-hump CamelCase** identifier — `[A-Z][A-Za-z0-9]{0,63}`
/// with at least one further uppercase letter. Every hq-cloud error class and
/// every AWS/Node error name is multi-hump (`AccessDenied`, `NoSuchKey`,
/// `RateLimited`, `VaultNotFoundError`), so this admits real identities while
/// refusing — and therefore never hashing into a signature — a path, URL, host,
/// quoted string, any token with a separator, lower-cased pull-leg prose, AND a
/// single-hump sentence-case word. The last point matters: a plain `Error` whose
/// message begins with an ordinary capitalized word (`"Vault unreachable"`,
/// `"Connection reset"`, a company name like `"Acme failed…"`) must NOT be
/// signed, or a customer- or company-derived first word could become an
/// offline-decodable hash. The literal `Error` is excluded because
/// `describeError` never emits it as a name.
fn leading_error_identity(message: &str) -> Option<&str> {
    let first = message.split_whitespace().next()?;
    if first == "Error" {
        return None;
    }
    let bytes = first.as_bytes();
    if bytes.is_empty() || bytes.len() > 64 || !bytes[0].is_ascii_uppercase() {
        return None;
    }
    let mut has_inner_upper = false;
    for &byte in &bytes[1..] {
        if !byte.is_ascii_alphanumeric() {
            return None;
        }
        has_inner_upper |= byte.is_ascii_uppercase();
    }
    has_inner_upper.then_some(first)
}

/// The `runner_error_cause_signature` of a runner error message: the first
/// [`SIGNATURE_HEX_LEN`] lowercase-hex chars of the SHA-256 of its gated leading
/// identity, or `None` when there is no *unlisted* leading identity to sign.
///
/// Signed exactly when the leading token is a gated identity (see
/// [`leading_error_identity`]) that is NOT already in the cause vocabulary — so an
/// identity the cause axis can already name needs no correlator. This is
/// deliberately **independent of the nested `code=`/`cause=` classification**: a
/// future unlisted class that wraps an allow-listed cause (e.g.
/// `FutureVaultError cause=AccessDenied …`) reports `access_denied` on the cause
/// axis *and* still surfaces `FutureVaultError`'s signature — the exact
/// producer-vocabulary drift this axis exists to expose would otherwise be hidden
/// behind the known nested cause.
///
/// Content-safe by construction: only a bare multi-hump CamelCase identifier is
/// ever hashed (no path, host, URL, quote, separator, or sentence-case word can
/// pass the gate), and only a fixed-length hex digest is returned — never a runner
/// byte. The digest is stable across machines, so the same unlisted class
/// correlates, and is offline-decodable by hashing candidate class names.
pub fn runner_error_cause_signature(message: &str) -> Option<String> {
    let identity = leading_error_identity(message)?;
    // A listed identity is already named by the cause axis; only an UNLISTED one
    // needs a correlator.
    if cause_from_identifier(identity).is_some() {
        return None;
    }
    let digest = format!("{:x}", Sha256::digest(identity.as_bytes()));
    Some(digest[..SIGNATURE_HEX_LEN].to_string())
}

/// Saturating per-pass counts of the closed cause vocabulary. Renders a compact
/// Sentry tag such as `access_denied:8,unknown:160`. Every error is recorded,
/// with `unknown` for an unrecognised one, so the `unknown` count itself signals
/// when the vocabulary needs one more entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunnerErrorCauseRollup {
    counts: [u32; RunnerErrorCause::ALL.len()],
}

impl Default for RunnerErrorCauseRollup {
    // `#[derive(Default)]` only covers arrays up to length 32; the completed
    // vocabulary is longer, so the zero-initialised array is spelled by hand.
    fn default() -> Self {
        Self {
            counts: [0; RunnerErrorCause::ALL.len()],
        }
    }
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

/// Saturating per-pass counts of the `runner_error_cause_signature` axis: a
/// bounded, content-safe correlator for an *unlisted* leading error identity —
/// one not yet in the cause vocabulary (see [`runner_error_cause_signature`]).
/// Each key is a fixed [`SIGNATURE_HEX_LEN`]-char lowercase-hex SHA-256 prefix of
/// a gated multi-hump CamelCase identifier (never a runner byte), so the SAME
/// unlisted identity is correlatable across machines and offline-decodable by
/// hashing candidate class names. A listed identity contributes nothing.
///
/// Bounded in BOTH dimensions: the rendered tag is capped by `render_top_n`, and
/// the retained key set is capped by [`SIGNATURE_ROLLUP_CAP`] so an error flood
/// with many distinct identifiers can never grow the map without limit.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RunnerErrorCauseSignatureRollup {
    /// Keyed by hex signature; `BTreeMap` gives a deterministic (ascending-hex)
    /// tie-break so the rendered tag never flaps for the same multiset.
    counts: BTreeMap<String, u32>,
}

impl RunnerErrorCauseSignatureRollup {
    /// Increment the signature count for one runner error message, when it has an
    /// unlisted leading identity. A message with no such identity increments
    /// nothing, so a pass with no unlisted identity renders no tag. Bounded: once
    /// [`SIGNATURE_ROLLUP_CAP`] distinct signatures are retained, an already-seen
    /// signature still increments but a NEW one is dropped, so the map cannot grow
    /// without limit under a distinct-identifier flood.
    pub fn record(&mut self, message: &str) {
        if let Some(signature) = runner_error_cause_signature(message) {
            if self.counts.len() >= SIGNATURE_ROLLUP_CAP && !self.counts.contains_key(&signature) {
                return;
            }
            let count = self.counts.entry(signature).or_insert(0);
            *count = count.saturating_add(1);
        }
    }

    /// Render the top-N signatures by count as a bounded Sentry tag such as
    /// `1a2b3c4d5e6f:9`. `None` when no unlisted identity was seen, so no tag
    /// should be sent. Ties break by signature ascending (`BTreeMap` order).
    pub fn tag_value(&self) -> Option<String> {
        let pairs: Vec<(&str, u32)> = self
            .counts
            .iter()
            .map(|(signature, count)| (signature.as_str(), *count))
            .collect();
        render_top_n(&pairs, ROLLUP_TAG_TOP_N)
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
/// count descending with a stable input-order tie-break, take the top `n`, and
/// join as `token:count`. Returns `None` when every count is zero. Generic over
/// the token's lifetime so both the fixed-vocabulary rollups (whose tokens are
/// `&'static str`) and the signature rollup (whose tokens borrow a `BTreeMap`
/// key) share one renderer; the caller supplies the tie-break order.
fn render_top_n(counts: &[(&str, u32)], n: usize) -> Option<String> {
    let mut nonzero: Vec<(&str, u32)> = counts
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
    fn classify_cause_maps_names_and_key_values_and_splits_the_residual() {
        use RunnerErrorCause::*;
        for (message, expected) in [
            // Leading hq-cloud class names — sampled across the completed vocabulary.
            ("EntityPermissionError access is denied for cmp_x", EntityPermission),
            ("OperationLockedError the operation lock is held", OperationLocked),
            ("DeltaGapError delta cursor gap detected", DeltaGap),
            ("RealtimeConflictError concurrent mutation", RealtimeConflict),
            ("VaultAuthError session is not valid", VaultIdentity),
            // Newly covered identities — the classes the prior sample missed.
            ("VaultNotFoundError vault entry not found for company", VaultNotFound),
            ("StateStoreCorruptionError reducer state is corrupt", StateStoreCorruption),
            ("RateLimited too many requests", RateLimited),
            ("CognitoAuthError identity could not be established", CognitoIdentity),
            ("AccessDeniedError company leg refused", AccessDenied),
            // Leading AWS error names.
            ("AccessDenied http=403 denied", AccessDenied),
            ("NoSuchKey http=404 missing", NoSuchKey),
            ("UnknownError cause=EAI_AGAIN host=x.example.com", UnknownError),
            // A key value when the leading name is generic/unrecognised.
            ("Error code=SlowDown request throttled", SlowDown),
            ("WrapperError cause=InternalError upstream failed", InternalError),
            ("StsError code=ExpiredToken the security token expired", ExpiredIdentity),
            // A `code=<ERRNO>` value classifies to the matching errno cause; the
            // leading sentinel `Error` is not a name and `syscall=` is ignored,
            // and `code=` wins the key-value precedence.
            ("Error syscall=unlink code=EPERM permission denied", Eperm),
            // ── Residual split (never a nearest guess) ────────────────────────
            // Unmodelled uppercase-initial leading name → named (still hashable).
            ("KaboomError the sky is falling", UnknownNamed),
            ("UndiciHeadersTimeoutError request timed out", UnknownNamed),
            // Lower-cased per-file pull-leg prose is not a class name → unnamed.
            ("presigned GET failed for knowledge/a.md: 403 Forbidden", UnknownUnnamed),
            // A leading `code=<ERRNO>` (a plain Node system error) is read from
            // the `code=` value → the matching errno cause.
            ("code=ENOENT syscall=open no such file", Enoent),
            // A leading bare `ERRNO:` token (describeError's plain-Node rendering)
            // is read by trimming one trailing ':' → the matching errno cause.
            ("ENOENT: no such file or directory, rename 'a' -> 'b'", Enoent),
            // An unrecognised `code=<value>` is still never a nearest guess.
            ("code=EWEIRD syscall=open unrecognised errno", UnknownUnnamed),
            // A leading path/quote can never be a name → unnamed (and unhashable).
            ("'/vault/secret.env' could not be read", UnknownUnnamed),
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
            rollup.record("presigned GET failed for repos/x: 500"); // unknown_unnamed
        }
        for _ in 0..8 {
            rollup.record("AccessDenied http=403 denied");
        }
        for _ in 0..8 {
            rollup.record("NoSuchKey http=404 missing");
        }
        let value = rollup.tag_value().expect("nonzero rollup renders a tag");
        // 160 unknown_unnamed wins; access_denied and no_such_key tie at 8, and
        // declaration order (access_denied precedes no_such_key) breaks it
        // deterministically.
        assert_eq!(value, "unknown_unnamed:160,access_denied:8,no_such_key:8");
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

    // ── Completed vocabulary + residual signature (this reopen) ────────────────

    /// The COMPLETE hq-cloud `this.name` identity set at
    /// `CAUSE_VOCABULARY_SOURCE_VERSION`, derived mechanically from
    /// `git grep -hoE 'this\.name = "[A-Za-z0-9]+"'` over the pinned hq-cloud
    /// source. Re-derive when the pin bumps — the
    /// `cause_vocabulary_source_version_is_pinned_to_the_runner` guard fails the
    /// build if the pin moves without this list (and the vocabulary) refreshed.
    const HQ_CLOUD_IDENTITIES: &[&str] = &[
        "AccessDeniedError",
        "AuthoritativeBaseVersionUnavailableError",
        "ChildProcessSyncWorkerError",
        "CognitoAuthError",
        "CognitoRefreshError",
        "CursorRetiredError",
        "DanglingSymlinkParentError",
        "DeltaGapError",
        "DurableApplyError",
        "DurableApplyRecoveryError",
        "EntityNotFoundError",
        "EntityPermissionError",
        "EntityResolutionError",
        "JournalCheckpointError",
        "MultipartAbortError",
        "MultipartSourceChangedError",
        "OperationLockUnwritableError",
        "OperationLockedError",
        "OutpostHttpError",
        "PrematureJournalEntryError",
        "PresignPreconditionMissing",
        "PushEventDecodeError",
        "RateLimited",
        "RealtimeConflictError",
        "RealtimeEnrollmentUnavailableError",
        "RefreshLockTimeoutError",
        "RescuePathChangedError",
        "ScopeShrinkBlockedError",
        "ScopeShrinkLargePruneError",
        "ServerOwnedPushPathsError",
        "SnapshotClientError",
        "SourceNotFoundError",
        "StateStoreCorruptionError",
        "StateStoreLockError",
        "StateStoreReducerError",
        "SyncMutationNotEnrolledError",
        "TombstoneFetchError",
        "UnreachablePushPathsError",
        "UnregisteredCompanySkillError",
        "VaultAuthError",
        "VaultClientError",
        "VaultConflictError",
        "VaultNotFoundError",
        "VaultPermissionDeniedError",
        "VendDeniedError",
        "WindowsSymlinkPrivilegeError",
    ];

    #[test]
    fn every_hq_cloud_identity_maps_to_a_distinct_named_cause() {
        // Completeness over the FULL derived identity set (not a sample): every
        // hq-cloud this.name must classify as a specific, non-residual cause, and
        // the 46 identities must map to 46 DISTINCT tokens — the exact property
        // the prior 16-name sample violated, collapsing every out-of-sample
        // company fault to the flat residual and reopening this lane. The set
        // grew from 45 to 46 when the runner pin moved to ~6.15.79, which added
        // ChildProcessSyncWorkerError.
        assert_eq!(HQ_CLOUD_IDENTITIES.len(), 46);
        let mut tokens = std::collections::BTreeSet::new();
        for name in HQ_CLOUD_IDENTITIES {
            // A realistic describeError rendering: the leading class name + prose.
            let message = format!("{name} something went wrong on the company leg");
            let cause = classify_runner_error_cause(&message);
            assert!(
                !matches!(
                    cause,
                    RunnerErrorCause::UnknownNamed | RunnerErrorCause::UnknownUnnamed
                ),
                "hq-cloud identity {name:?} collapsed to the residual {:?}",
                cause.as_str()
            );
            // A matched identity is already named, so it carries no signature.
            assert_eq!(
                runner_error_cause_signature(&message),
                None,
                "a matched identity must carry no cause signature: {name:?}"
            );
            assert!(
                tokens.insert(cause.as_str()),
                "two hq-cloud identities share a cause token at {name:?}: {:?}",
                cause.as_str()
            );
        }
        assert_eq!(tokens.len(), 46, "expected 46 distinct cause tokens");
    }

    #[test]
    fn residual_splits_named_from_unnamed_and_only_named_is_signed() {
        // A leading, uppercase-initial, unlisted identity → unknown_named + a
        // stable signature. A plain-Error / prose / key=value message → unknown
        // _unnamed + NO signature. The two residuals are never conflated.
        let named = "FreshFleetError the fleet melted down";
        assert_eq!(classify_runner_error_cause(named), RunnerErrorCause::UnknownNamed);
        let signature = runner_error_cause_signature(named).expect("named residual is signed");
        assert_eq!(signature.len(), SIGNATURE_HEX_LEN);
        let expected = format!("{:x}", Sha256::digest(b"FreshFleetError"));
        assert_eq!(
            signature,
            expected[..SIGNATURE_HEX_LEN],
            "signature must be the hex12 SHA-256 of the leading identity",
        );

        for unnamed in [
            "code=EWEIRD syscall=open unrecognised errno",  // leading key=value, unlisted errno
            "presigned GET failed for knowledge/a.md: 403", // lower-cased prose
            "Error the generic error name is suppressed",   // literal Error
            "'/vault/secret.env' unreadable",               // leading quote/path
            "",                                             // empty
        ] {
            assert_eq!(
                classify_runner_error_cause(unnamed),
                RunnerErrorCause::UnknownUnnamed,
                "message should be unnamed: {unnamed:?}"
            );
            assert_eq!(
                runner_error_cause_signature(unnamed),
                None,
                "an unnamed residual must carry no signature: {unnamed:?}"
            );
        }
    }

    #[test]
    fn cause_signature_gate_refuses_paths_hosts_quotes_and_lowercase() {
        // The gate admits only a bare [A-Z][A-Za-z0-9]{0,63} identifier, so no
        // path, host, URL, quoted string, separator, over-long token, leading
        // digit, or lower-cased word can ever be hashed into a signature.
        let overlong = format!("{} overlong", "A".repeat(65));
        for refused in [
            "knowledge/a.md failed",                // '/', '.'
            "https://x.example.com/y timed out",    // ':' '/' '.'
            "hq-vault-cmp.s3.amazonaws.com denied", // '-' '.'
            "'quoted' value",                       // leading quote
            "lowercasey not a class",               // lower-cased first byte
            "403 status only",                      // leading digit
            "code=EAI_AGAIN dns failure",           // '='
            overlong.as_str(),                      // > 64 chars
        ] {
            assert_eq!(leading_error_identity(refused), None, "gate must refuse: {refused:?}");
            assert_eq!(
                runner_error_cause_signature(refused),
                None,
                "a refused leading token must yield no signature: {refused:?}"
            );
        }
        // The boundary: exactly 64 chars is admitted, 65 is not.
        let max = "A".repeat(64);
        assert_eq!(leading_error_identity(&format!("{max} ok")), Some(max.as_str()));
        let over = "A".repeat(65);
        assert_eq!(leading_error_identity(&format!("{over} no")), None);
    }

    #[test]
    fn cause_signature_is_stable_hex12_and_distinct_per_identity() {
        let a = runner_error_cause_signature("AlphaError boom").expect("signed");
        let a_again = runner_error_cause_signature("AlphaError different prose").expect("signed");
        let b = runner_error_cause_signature("BetaError boom").expect("signed");
        // Stable for the same identity regardless of trailing prose …
        assert_eq!(a, a_again);
        // … distinct for different identities, and always 12 lowercase-hex chars.
        assert_ne!(a, b);
        for signature in [&a, &b] {
            assert_eq!(signature.len(), 12);
            assert!(signature
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()));
        }
    }

    #[test]
    fn cause_signature_rollup_is_bounded_order_independent_and_empty_when_none() {
        let mut rollup = RunnerErrorCauseSignatureRollup::default();
        for _ in 0..9 {
            rollup.record("MysteryFleetError primary fault");
        }
        for _ in 0..4 {
            rollup.record("OtherFleetError secondary fault");
        }
        // Matched causes and unnamed residuals never contribute a signature.
        for _ in 0..100 {
            rollup.record("AccessDenied http=403 denied");
            rollup.record("presigned GET failed for repos/x: 500");
        }
        let mystery_full = format!("{:x}", Sha256::digest(b"MysteryFleetError"));
        let other_full = format!("{:x}", Sha256::digest(b"OtherFleetError"));
        let expected = format!("{}:9,{}:4", &mystery_full[..12], &other_full[..12]);
        let value = rollup.tag_value().expect("nonzero rollup renders a tag");
        assert_eq!(value, expected);
        assert!(value.split(',').count() <= ROLLUP_TAG_TOP_N);

        // Order-independent for the same multiset, and empty renders no tag.
        let mut reversed = RunnerErrorCauseSignatureRollup::default();
        for _ in 0..4 {
            reversed.record("OtherFleetError secondary fault");
        }
        for _ in 0..9 {
            reversed.record("MysteryFleetError primary fault");
        }
        assert_eq!(reversed.tag_value(), Some(value));
        assert_eq!(RunnerErrorCauseSignatureRollup::default().tag_value(), None);
    }

    #[test]
    fn cause_vocabulary_source_version_is_pinned_to_the_runner() {
        // Bumping the hq-cloud runner pin WITHOUT re-deriving the identity list
        // (this test's HQ_CLOUD_IDENTITIES and the vocabulary) must fail the
        // build — the guard against a third silent vocabulary-drift reopen.
        assert_eq!(
            CAUSE_VOCABULARY_SOURCE_VERSION,
            crate::hq_cloud::HQ_CLOUD_VERSION,
            "re-derive the cause vocabulary from the new hq-cloud source, then \
             update CAUSE_VOCABULARY_SOURCE_VERSION and HQ_CLOUD_IDENTITIES",
        );
    }

    #[test]
    fn sentence_case_prose_is_unnamed_and_never_signed() {
        // A plain `Error` whose message begins with an ordinary single-hump
        // capitalized word is NOT an error-class identity: it must classify as
        // `unknown_unnamed` and attach no signature, so a customer- or
        // company-derived first word can never become a decodable hash.
        for prose in [
            "Vault unreachable",
            "Connection reset by peer",
            "Timeout while connecting to the outpost",
            "Forbidden by policy",
            "Acme failed to reach its vault",
        ] {
            assert_eq!(
                classify_runner_error_cause(prose),
                RunnerErrorCause::UnknownUnnamed,
                "single-hump sentence-case prose must be unnamed: {prose:?}"
            );
            assert_eq!(
                runner_error_cause_signature(prose),
                None,
                "sentence-case prose must never be signed: {prose:?}"
            );
        }
        // A genuine multi-hump CamelCase class name is still named + signed.
        assert_eq!(
            classify_runner_error_cause("FutureVaultError the vault vanished"),
            RunnerErrorCause::UnknownNamed
        );
        assert!(runner_error_cause_signature("FutureVaultError the vault vanished").is_some());
        // The multi-hump gate boundary: one internal uppercase is admitted, none
        // is refused.
        assert_eq!(leading_error_identity("VaultX gone"), Some("VaultX"));
        assert_eq!(leading_error_identity("Vaultx gone"), None);
    }

    #[test]
    fn unlisted_outer_identity_is_signed_even_when_a_nested_cause_matches() {
        // An unlisted leading class that WRAPS a known nested cause: the cause axis
        // reports the actionable nested cause, and the signature axis still exposes
        // the unlisted wrapper — the producer-vocabulary drift this axis exists for
        // must not be hidden behind the known cause.
        let message = "FutureVaultError cause=AccessDenied http=403 host=x.example.com denied";
        assert_eq!(classify_runner_error_cause(message), RunnerErrorCause::AccessDenied);
        let signature = runner_error_cause_signature(message).expect("unlisted wrapper is signed");
        let expected = format!("{:x}", Sha256::digest(b"FutureVaultError"));
        assert_eq!(signature, expected[..SIGNATURE_HEX_LEN]);

        // A LISTED leading identity that wraps a nested cause is already named, so
        // it carries no signature (the cause axis names it directly).
        let listed = "VaultNotFoundError cause=AccessDenied vault entry missing";
        assert_eq!(classify_runner_error_cause(listed), RunnerErrorCause::VaultNotFound);
        assert_eq!(runner_error_cause_signature(listed), None);

        // Recorded across both axes independently: one cause count, one signature.
        let mut causes = RunnerErrorCauseRollup::default();
        let mut signatures = RunnerErrorCauseSignatureRollup::default();
        causes.record(message);
        signatures.record(message);
        assert_eq!(causes.tag_value().as_deref(), Some("access_denied:1"));
        assert_eq!(
            signatures.tag_value(),
            Some(format!("{}:1", &expected[..SIGNATURE_HEX_LEN]))
        );
    }

    #[test]
    fn cause_signature_rollup_is_bounded_under_a_distinct_identity_flood() {
        // Unlike the fixed-array rollups the signature map is keyed by an
        // open-ended digest, so a flood of DISTINCT identifiers must not grow it
        // without bound. Feed far more distinct identities than the cap and assert
        // the retained key set stays capped while the tag still renders top-N.
        let mut rollup = RunnerErrorCauseSignatureRollup::default();
        for i in 0..(SIGNATURE_ROLLUP_CAP * 4) {
            // Each identifier is a distinct multi-hump CamelCase token.
            rollup.record(&format!("FloodError{i}X boom on the company leg"));
        }
        assert_eq!(
            rollup.counts.len(),
            SIGNATURE_ROLLUP_CAP,
            "the distinct-signature set must be capped"
        );
        // An already-seen signature still increments past the cap, and the tag
        // stays bounded to the top-N.
        for _ in 0..10 {
            rollup.record("FloodError0X boom on the company leg");
        }
        let value = rollup.tag_value().expect("nonzero rollup renders a tag");
        assert!(value.split(',').count() <= ROLLUP_TAG_TOP_N);
    }

    // ── Built-in JS identities, errno vocabulary, and the recurrence (r2) ──────

    #[test]
    fn built_in_javascript_error_identities_are_named_causes() {
        use RunnerErrorCause::*;
        // describeError emits `e.name` verbatim, so a JS built-in leads the
        // message. Each maps to its own distinct token, and — being listed — none
        // is signed (the signature axis is only for UNLISTED identities). This
        // family is pinned here, NOT by CAUSE_VOCABULARY_SOURCE_VERSION, because
        // it is defined by the language/Node rather than by hq-cloud.
        let cases = [
            ("RangeError", RangeError, "range_error"),
            ("TypeError", TypeError, "type_error"),
            ("SyntaxError", SyntaxError, "syntax_error"),
            ("ReferenceError", ReferenceError, "reference_error"),
            ("EvalError", EvalError, "eval_error"),
            ("URIError", UriError, "uri_error"),
            ("AggregateError", AggregateError, "aggregate_error"),
            ("AbortError", AbortError, "abort_error"),
            ("SystemError", SystemError, "system_error"),
        ];
        let mut tokens = std::collections::BTreeSet::new();
        for (name, expected, token) in cases {
            let message = format!("{name} something failed inside the runner");
            let cause = classify_runner_error_cause(&message);
            assert_eq!(cause, expected, "built-in {name:?} did not classify");
            assert_eq!(cause.as_str(), token, "wrong token for {name:?}");
            assert_eq!(
                runner_error_cause_signature(&message),
                None,
                "a listed built-in identity must carry no signature: {name:?}"
            );
            assert!(tokens.insert(token), "duplicate token for {name:?}");
        }
        assert_eq!(tokens.len(), 9, "nine distinct built-in tokens");
    }

    #[test]
    fn the_production_recurrence_signature_now_resolves_to_a_named_cause() {
        // The reopening event carried runner_error_cause_signature=93c5a7a535cb,
        // which is sha256("RangeError")[..12] — proof the unattributed recurrence
        // was a JavaScript RangeError. On the completed vocabulary it is a NAMED
        // cause and therefore no longer needs a signature.
        let digest = format!("{:x}", Sha256::digest(b"RangeError"));
        assert_eq!(&digest[..SIGNATURE_HEX_LEN], "93c5a7a535cb");
        let message = "RangeError Maximum call stack size exceeded";
        assert_eq!(
            classify_runner_error_cause(message),
            RunnerErrorCause::RangeError
        );
        assert_eq!(
            runner_error_cause_signature(message),
            None,
            "RangeError is now listed, so the recurrence no longer signs"
        );
    }

    #[test]
    fn node_errno_codes_are_named_from_both_the_code_key_and_a_leading_errno_token() {
        use RunnerErrorCause::*;
        // Every errno in the closed allow-list, in BOTH producer renderings: the
        // `code=<ERRNO>` describeError header and the leading bare `<ERRNO>:`
        // tail. A listed errno identity is named and carries no signature.
        let cases = [
            ("ENOENT", Enoent),
            ("EEXIST", Eexist),
            ("ENOTEMPTY", Enotempty),
            ("EXDEV", Exdev),
            ("EISDIR", Eisdir),
            ("ENOTDIR", Enotdir),
            ("ELOOP", Eloop),
            ("ENAMETOOLONG", Enametoolong),
            ("EMFILE", Emfile),
            ("ENFILE", Enfile),
            ("EROFS", Erofs),
            ("EIO", Eio),
            ("EAGAIN", Eagain),
            ("EPIPE", Epipe),
            ("ETIMEDOUT", Etimedout),
            ("ECONNRESET", Econnreset),
            ("ECONNREFUSED", Econnrefused),
            ("ENOTFOUND", Enotfound),
            ("EHOSTUNREACH", Ehostunreach),
            ("ENETUNREACH", Enetunreach),
            ("EAI_AGAIN", EaiAgain),
            ("EPERM", Eperm),
            ("EACCES", Eacces),
            ("ENOSPC", Enospc),
            ("EBUSY", Ebusy),
        ];
        for (errno, expected) in cases {
            let code_form =
                format!("code={errno} {errno}: some operation failed, rename 'a' -> 'b'");
            assert_eq!(
                classify_runner_error_cause(&code_form),
                expected,
                "code= form did not classify {errno:?}"
            );
            let lead_form = format!("{errno}: some operation failed, rename 'a' -> 'b'");
            assert_eq!(
                classify_runner_error_cause(&lead_form),
                expected,
                "leading token form did not classify {errno:?}"
            );
            assert_eq!(
                runner_error_cause_signature(&lead_form),
                None,
                "a listed errno identity must carry no signature: {errno:?}"
            );
        }
        assert_eq!(cases.len(), 25, "the closed errno allow-list");
    }

    #[test]
    fn errno_lookup_never_reads_free_prose_or_the_host_value() {
        // An errno mentioned only in free prose, or carried in the `host=` value
        // (which the cause classifier never reads), must NOT be read as a cause —
        // the fault stays unnamed. Only a leading bare `ERRNO:` token or a
        // `code=`/`cause=`/`syscall=` value is ever consulted.
        for prose in [
            "the download failed with ENOENT somewhere in the middle",
            "retrying after a transient ETIMEDOUT during pull",
            "Error host=enoent.internal.example.com connection dropped",
        ] {
            assert_eq!(
                classify_runner_error_cause(prose),
                RunnerErrorCause::UnknownUnnamed,
                "free-prose / host errno must not classify: {prose:?}"
            );
            assert_eq!(runner_error_cause_signature(prose), None);
        }
    }
}
