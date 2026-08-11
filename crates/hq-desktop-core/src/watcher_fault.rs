//! Content-safe *watcher fault provenance* — attribute a Windows watcher abort
//! (e.g. 0xC0000409 / STATUS_STACK_BUFFER_OVERRUN) to the executable and module
//! that actually faulted, read from the operating system's own fault record.
//!
//! Motivation (HQ-DESKTOP-4X, pipeline
//! `p-20260809-hq-desktop-watcher-fastfail-exit-unattributed-f0f`): on the
//! watcher route the app receives *no* fault-bearing stderr line at all — the
//! sticky `runner_fatal_class` stays `none` across a whole multi-hour generation
//! and every retained tail line is redacted. The classifier arms are proven to
//! fire on real input by the sibling manual-route issue (HQ-DESKTOP-50), so the
//! watcher cluster is a "no diagnostic line was produced or delivered" case, not
//! a "pattern not recognised" case. Widening the stderr vocabulary again (as
//! PR #397 did) therefore cannot converge. This module reads the OS's own record
//! instead.
//!
//! The Win32 half (querying Windows Error Reporting's Application-log
//! `Application Error` / Event ID 1000 records, and sampling the watcher
//! generation's live Job Object process-id set) lives behind `cfg(windows)` in
//! the app crate. Everything here is platform-neutral and unit-tested on the
//! Linux fix host: the closed-vocabulary allow-list mapping, the fault-record
//! parser (fed the OS-rendered event XML as an opaque string), the
//! provenance state machine, and the unmatched-stderr structural rollup.
//!
//! Content safety is absolute, exactly as the runner-error rollups already
//! establish: only fixed constants chosen *in this file*, bare integers, and
//! bounded counts of those constants may ever leave the process. No raw
//! event-log byte, filesystem path, username, product string, or stderr
//! fragment is ever emitted. An executable or module outside the allow-list
//! maps to the fixed sentinel `other`, never to a nearest guess.

use std::collections::HashSet;
use std::time::{Duration, SystemTime};

// ─────────────────────────────────────────────────────────────────────────────
// Provenance honesty token
// ─────────────────────────────────────────────────────────────────────────────

/// How strongly a Windows Error Reporting record was bound to *this* watcher
/// generation's terminated process tree. A mandatory honesty token: it is always
/// emitted so a confirmed attribution, a time-window-only coincidence, an absent
/// record, and an unreadable/disabled/timed-out log are four visibly different
/// states that can never be misread as one another. "Absence of evidence must
/// never render as evidence."
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WatcherFaultProvenance {
    /// A fault record was found whose faulting process id is a member of this
    /// generation's sampled Job Object process set AND whose timestamp fell
    /// inside the generation lifetime. The strongest available attribution.
    PidMatched,
    /// A fault record was found inside the generation lifetime, but its faulting
    /// process id was not in (or the process set was unavailable for) this
    /// generation — a time-window-only coincidence, deliberately weaker than a
    /// pid match so triage can tell them apart.
    WindowOnly,
    /// The Application log was read successfully but carried no qualifying
    /// `Application Error` record inside the generation lifetime.
    NoRecord,
    /// The Application log could not be read: not Windows, the query failed, the
    /// query timed out under its hard bound, or Windows Error Reporting is
    /// disabled. Distinct from `NoRecord` so a WER-less host is never mistaken
    /// for a fault-free one.
    Unavailable,
}

impl WatcherFaultProvenance {
    /// Every variant, so content-safety and anti-drift tests can enumerate the
    /// emitter's own token set instead of a hand-copied list.
    pub const ALL: [WatcherFaultProvenance; 4] = [
        Self::PidMatched,
        Self::WindowOnly,
        Self::NoRecord,
        Self::Unavailable,
    ];

    /// Fixed vocabulary safe for a Sentry tag. Never derived from OS input.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::PidMatched => "pid_matched",
            Self::WindowOnly => "window_only",
            Self::NoRecord => "no_record",
            Self::Unavailable => "unavailable",
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Faulting image / module allow-lists
// ─────────────────────────────────────────────────────────────────────────────

/// Closed allow-list of faulting *executable* names that may leave the process
/// as a `watcher_fault_faulting_image` tag. These are the only images that can
/// legitimately appear in the watcher's `cmd.exe` → `npx.cmd` → `node.exe`
/// process tree plus the app itself. Any other observed executable maps to the
/// fixed sentinel `other`, so a path, username, or unexpected binary name can
/// never escape.
pub const WATCHER_FAULT_IMAGE_ALLOWLIST: &[&str] =
    &["node.exe", "npx.cmd", "cmd.exe", "hq-sync-menubar.exe"];

/// Closed allow-list of faulting *module* names (loaded DLLs) that may leave the
/// process as a `watcher_fault_faulting_module` tag. A 0xC0000409 stack-buffer
/// overrun is typically charged to one of these runtime modules. Anything else
/// maps to the fixed sentinel `other`.
pub const WATCHER_FAULT_MODULE_ALLOWLIST: &[&str] =
    &["ntdll.dll", "kernelbase.dll", "ucrtbase.dll", "msvcrt.dll"];

/// The fixed sentinel for an observed image/module that is not on its allow-list.
pub const WATCHER_FAULT_OTHER: &str = "other";

/// Canonicalise an observed faulting-executable name to its allow-listed
/// spelling, or the fixed sentinel `other`. The match is case-insensitive and,
/// crucially, tolerant of a leading path: only the final `\\`/`/`-separated
/// component is considered, and the returned value is ALWAYS a code constant —
/// never the observed bytes — so no path or unexpected name can leak.
pub fn watcher_fault_image_token(candidate: &str) -> &'static str {
    allowlist_token(candidate, WATCHER_FAULT_IMAGE_ALLOWLIST)
}

/// Canonicalise an observed faulting-module name to its allow-listed spelling,
/// or the fixed sentinel `other`. Same discipline as [`watcher_fault_image_token`].
pub fn watcher_fault_module_token(candidate: &str) -> &'static str {
    allowlist_token(candidate, WATCHER_FAULT_MODULE_ALLOWLIST)
}

fn allowlist_token(candidate: &str, allowlist: &[&'static str]) -> &'static str {
    // Only ever compare the final path component so `C:\Users\<name>\node.exe`
    // still canonicalises to `node.exe` without the surrounding path ever being
    // inspected for anything but the split.
    let leaf = candidate
        .rsplit(|character: char| character == '\\' || character == '/')
        .find(|segment| !segment.is_empty())
        .unwrap_or("")
        .trim();
    allowlist
        .iter()
        .find(|known| leaf.eq_ignore_ascii_case(known))
        .copied()
        .unwrap_or(WATCHER_FAULT_OTHER)
}

// ─────────────────────────────────────────────────────────────────────────────
// Windows Error Reporting "Application Error" (Event ID 1000) record
// ─────────────────────────────────────────────────────────────────────────────

/// A parsed, content-neutral view of a Windows `Application Error` (Event ID
/// 1000) record. The raw image/module names are retained ONLY so the caller can
/// map them through the allow-list; they are never themselves emitted. The three
/// integers are bare and safe.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WerApplicationError {
    /// Raw faulting-executable name as rendered by the OS (allow-listed before
    /// emission — never emitted verbatim).
    pub faulting_image_raw: String,
    /// Raw faulting-module name as rendered by the OS (allow-listed before
    /// emission — never emitted verbatim).
    pub faulting_module_raw: String,
    /// Exception code as a bare integer (e.g. `0xC0000409` → `3221226505`).
    pub exception_code: i64,
    /// Fault offset (module-relative) as a bare integer.
    pub fault_offset: u64,
    /// Faulting process id, parsed from the record's hexadecimal field.
    pub faulting_pid: u32,
    /// The same field parsed as decimal, kept only when it differs, so a pid
    /// membership check is robust to the field's rendering (some Windows builds
    /// render "Faulting process id" in hex, some in decimal).
    pub faulting_pid_decimal: Option<u32>,
    /// Wall-clock time the record was created, when the OS rendered a parseable
    /// `TimeCreated SystemTime`. Used only for the generation-lifetime window
    /// check; never emitted.
    pub created: Option<SystemTime>,
}

impl WerApplicationError {
    /// True when either interpretation of the record's process-id field is a
    /// member of the sampled Job Object process set for this generation.
    fn pid_in_set(&self, sampled: &HashSet<u32>) -> bool {
        sampled.contains(&self.faulting_pid)
            || self
                .faulting_pid_decimal
                .is_some_and(|pid| sampled.contains(&pid))
    }

    /// The allow-listed faulting-image token for this record.
    pub fn image_token(&self) -> &'static str {
        watcher_fault_image_token(&self.faulting_image_raw)
    }

    /// The allow-listed faulting-module token for this record.
    pub fn module_token(&self) -> &'static str {
        watcher_fault_module_token(&self.faulting_module_raw)
    }
}

/// Extract the ordered `<Data>…</Data>` values from an OS-rendered event XML
/// fragment, bounded in both count and per-field length. Only the structural
/// shape of the XML is inspected; the extracted strings are handed straight back
/// to the caller, which either allow-lists them (image/module) or integer-parses
/// them (code/offset/pid) — nothing else is ever done with them.
fn extract_event_data_fields(event_xml: &str) -> Vec<String> {
    const MAX_FIELDS: usize = 24;
    const MAX_FIELD_LEN: usize = 256;
    let mut fields = Vec::new();
    let mut rest = event_xml;
    while fields.len() < MAX_FIELDS {
        let Some(open) = rest.find("<Data") else {
            break;
        };
        rest = &rest[open + "<Data".len()..];
        // Skip any attributes (e.g. `Name='…'`) up to the closing `>` of the tag.
        let Some(tag_end) = rest.find('>') else {
            break;
        };
        rest = &rest[tag_end + 1..];
        let Some(close) = rest.find("</Data>") else {
            break;
        };
        let raw = &rest[..close.min(MAX_FIELD_LEN * 4)];
        fields.push(unescape_xml_minimal(raw.trim(), MAX_FIELD_LEN));
        rest = &rest[close + "</Data>".len()..];
    }
    fields
}

/// Minimal XML entity unescape, bounded to `max_len` output bytes. Sufficient
/// for the numeric and short-name fields WER emits; anything longer is truncated
/// (the value is only ever allow-listed or integer-parsed afterwards, so a
/// truncated value degrades to the `other` sentinel or a parse failure — never a
/// leak).
fn unescape_xml_minimal(input: &str, max_len: usize) -> String {
    let mut out = String::with_capacity(input.len().min(max_len));
    let mut chars = input.chars().peekable();
    while let Some(character) = chars.next() {
        if out.len() >= max_len {
            break;
        }
        if character != '&' {
            out.push(character);
            continue;
        }
        // Read up to the ';' of an entity, bounded so a stray '&' cannot scan far.
        let mut entity = String::new();
        for _ in 0..10 {
            match chars.peek() {
                Some(';') => {
                    chars.next();
                    break;
                }
                Some(&c) => {
                    entity.push(c);
                    chars.next();
                }
                None => break,
            }
        }
        match entity.as_str() {
            "amp" => out.push('&'),
            "lt" => out.push('<'),
            "gt" => out.push('>'),
            "quot" => out.push('"'),
            "apos" => out.push('\''),
            other => {
                if let Some(code) = other
                    .strip_prefix("#x")
                    .or_else(|| other.strip_prefix("#X"))
                    .and_then(|hex| u32::from_str_radix(hex, 16).ok())
                    .or_else(|| other.strip_prefix('#').and_then(|dec| dec.parse().ok()))
                    .and_then(char::from_u32)
                {
                    out.push(code);
                }
                // An unrecognised entity is dropped: these fields are only ever
                // allow-listed or integer-parsed, so dropping cannot leak.
            }
        }
    }
    out
}

/// Parse a hexadecimal (optionally `0x`-prefixed) or, as a fallback, decimal
/// integer. WER renders the exception code and fault offset as bare hex.
fn parse_hex_or_decimal_u64(value: &str) -> Option<u64> {
    let trimmed = value.trim();
    if let Some(hex) = trimmed
        .strip_prefix("0x")
        .or_else(|| trimmed.strip_prefix("0X"))
    {
        return u64::from_str_radix(hex, 16).ok();
    }
    u64::from_str_radix(trimmed, 16)
        .ok()
        .or_else(|| trimmed.parse::<u64>().ok())
}

/// Parse a Windows `Application Error` (Event ID 1000) event, rendered by the OS
/// as XML, into a content-neutral [`WerApplicationError`]. The `EventData`
/// section of this well-known event is a fixed, ordered list of unnamed `<Data>`
/// elements:
///
/// | index | field |
/// |------:|-------|
/// | 0 | faulting application name |
/// | 3 | faulting module name |
/// | 6 | exception code (hex) |
/// | 7 | fault offset (hex) |
/// | 8 | faulting process id (hex) |
///
/// Returns `None` unless at least the image, exception code and process id could
/// be recovered — a shape that does not match this event is rejected rather than
/// guessed at.
pub fn parse_wer_application_error(event_xml: &str) -> Option<WerApplicationError> {
    let fields = extract_event_data_fields(event_xml);
    let image = fields.first()?.clone();
    if image.is_empty() {
        return None;
    }
    let module = fields.get(3).cloned().unwrap_or_default();
    let exception_code = parse_hex_or_decimal_u64(fields.get(6)?)? as i64;
    let fault_offset = fields.get(7).and_then(|v| parse_hex_or_decimal_u64(v));
    let pid_field = fields.get(8)?;
    let faulting_pid =
        parse_hex_or_decimal_u64(pid_field).and_then(|pid| u32::try_from(pid).ok())?;
    // Some Windows builds render the process id in decimal; keep that reading too
    // so a pid membership check is robust to either.
    let faulting_pid_decimal = pid_field
        .trim()
        .parse::<u32>()
        .ok()
        .filter(|dec| *dec != faulting_pid);
    Some(WerApplicationError {
        faulting_image_raw: image,
        faulting_module_raw: module,
        exception_code,
        fault_offset: fault_offset.unwrap_or(0),
        faulting_pid,
        faulting_pid_decimal,
        created: parse_time_created(event_xml),
    })
}

/// Extract and parse the `System/TimeCreated SystemTime='…'` attribute as a
/// `SystemTime`, when present and parseable. Returns `None` otherwise — an
/// unparseable timestamp simply means the window check falls back to accepting
/// the record (the Win32 layer already scoped the query), never a leak.
fn parse_time_created(event_xml: &str) -> Option<SystemTime> {
    let anchor = event_xml.find("TimeCreated")?;
    let rest = &event_xml[anchor..];
    let key = rest.find("SystemTime=")?;
    let after = &rest[key + "SystemTime=".len()..];
    let quote = after.chars().next()?;
    if quote != '\'' && quote != '"' {
        return None;
    }
    let after = &after[1..];
    let end = after.find(quote)?;
    parse_iso8601_utc(&after[..end])
}

/// Minimal ISO-8601 UTC parser for the `YYYY-MM-DDTHH:MM:SS(.fff…)?Z` shape the
/// Windows event renderer emits. Returns a `SystemTime`; only used for the
/// coarse generation-lifetime window, so sub-second precision is discarded.
fn parse_iso8601_utc(value: &str) -> Option<SystemTime> {
    let value = value.trim();
    let (date, time) = value.split_once('T')?;
    let time = time.trim_end_matches('Z');
    let time = time.split('.').next().unwrap_or(time);
    let mut date_parts = date.split('-');
    let year: i64 = date_parts.next()?.parse().ok()?;
    let month: i64 = date_parts.next()?.parse().ok()?;
    let day: i64 = date_parts.next()?.parse().ok()?;
    let mut time_parts = time.split(':');
    let hour: i64 = time_parts.next()?.parse().ok()?;
    let minute: i64 = time_parts.next()?.parse().ok()?;
    let second: i64 = time_parts.next().unwrap_or("0").parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    // Days since the Unix epoch via a civil-calendar algorithm (Howard Hinnant's
    // `days_from_civil`), valid for the whole proleptic Gregorian range.
    let year_adj = if month <= 2 { year - 1 } else { year };
    let era = if year_adj >= 0 {
        year_adj
    } else {
        year_adj - 399
    } / 400;
    let yoe = year_adj - era * 400;
    let doy = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    let total_secs = days * 86400 + hour * 3600 + minute * 60 + second;
    if total_secs < 0 {
        return None;
    }
    Some(SystemTime::UNIX_EPOCH + Duration::from_secs(total_secs as u64))
}

/// True when a record's creation time falls inside the generation lifetime
/// window `[now - lifetime, now]`, with a small forward tolerance for clock
/// jitter. A record with no parseable timestamp is accepted (the Win32 query is
/// already channel- and event-scoped); the window only excludes records that are
/// provably older than the generation.
pub fn wer_record_in_window(
    created: Option<SystemTime>,
    now: SystemTime,
    lifetime: Duration,
) -> bool {
    let Some(created) = created else {
        return true;
    };
    // Reject anything meaningfully in the future (a different, later event).
    if created > now + Duration::from_secs(60) {
        return false;
    }
    match now.duration_since(created) {
        Ok(age) => age <= lifetime + Duration::from_secs(60),
        // `created` is (slightly) after `now`: within tolerance, accept.
        Err(_) => true,
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Provenance state machine
// ─────────────────────────────────────────────────────────────────────────────

/// The fully-resolved, content-safe attribution attached to a watcher exit: the
/// mandatory provenance token plus, only when a record bound, the allow-listed
/// image/module tokens and the bare integer exception code and fault offset.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WatcherFaultAttribution {
    pub provenance: WatcherFaultProvenance,
    pub faulting_image: Option<&'static str>,
    pub faulting_module: Option<&'static str>,
    pub exception_code: Option<i64>,
    pub fault_offset: Option<u64>,
}

impl WatcherFaultAttribution {
    /// The degraded attribution used on non-Windows, on a failed/timed-out query,
    /// and when WER is disabled: provenance is `unavailable` and no image, module,
    /// or integer is attached.
    pub const fn unavailable() -> Self {
        Self {
            provenance: WatcherFaultProvenance::Unavailable,
            faulting_image: None,
            faulting_module: None,
            exception_code: None,
            fault_offset: None,
        }
    }
}

/// Resolve the final attribution from the query outcome. This is the single
/// decision seam and is fully platform-neutral, so the pid-match / window-only /
/// no-record / unavailable logic is unit-tested on the Linux fix host even though
/// only Windows can produce the inputs.
///
/// * `query_ok` — the Application log was read (not Windows / failed / timed-out /
///   disabled all pass `false`).
/// * `record` — the best qualifying in-window `Application Error` record, if any.
/// * `sampled_pids` — this generation's last sampled Job Object process set, or
///   `None` when sampling was unavailable.
pub fn resolve_watcher_fault_attribution(
    query_ok: bool,
    record: Option<&WerApplicationError>,
    sampled_pids: Option<&HashSet<u32>>,
) -> WatcherFaultAttribution {
    if !query_ok {
        return WatcherFaultAttribution::unavailable();
    }
    let Some(record) = record else {
        return WatcherFaultAttribution {
            provenance: WatcherFaultProvenance::NoRecord,
            faulting_image: None,
            faulting_module: None,
            exception_code: None,
            fault_offset: None,
        };
    };
    let provenance = match sampled_pids {
        Some(pids) if record.pid_in_set(pids) => WatcherFaultProvenance::PidMatched,
        _ => WatcherFaultProvenance::WindowOnly,
    };
    WatcherFaultAttribution {
        provenance,
        faulting_image: Some(record.image_token()),
        faulting_module: Some(record.module_token()),
        exception_code: Some(record.exception_code),
        fault_offset: Some(record.fault_offset),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Unmatched-stderr structural rollup
// ─────────────────────────────────────────────────────────────────────────────

/// Content-safe *structural* shape of a single stderr line whose
/// `classify_runner_fatal_class` result is `None`. Derived only from the line's
/// coarse structure — a leading brace, a stack-frame prefix, a `key:` head —
/// never from its bytes, so accumulating these across occurrences yields a
/// recurring, comparable descriptor of the unknown line family without ever
/// emitting a runner byte.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunnerStderrShape {
    /// Whitespace-only or empty.
    Empty,
    /// Trimmed line begins with `{` — an ndjson object / JSON record.
    JsonObject,
    /// Trimmed line begins with `[` — a JSON array or a `[tag]` prefix.
    Bracketed,
    /// A JavaScript stack frame: trimmed line begins with `at `.
    StackFrameAt,
    /// A Node abort/diagnostic frame: trimmed line begins with `#`.
    HashFrame,
    /// A `<identifier>:` head followed by more text (e.g. `Error: …`,
    /// `ReadDirectoryChangesW: …`).
    KeyColon,
    /// Free prose: contains a space but matches none of the above.
    Prose,
    /// A single whitespace-free token (a bare word, number, or path-like blob).
    Token,
}

impl RunnerStderrShape {
    /// Every variant, so anti-drift and content-safety tests can enumerate the
    /// emitter's own vocabulary.
    pub const ALL: [RunnerStderrShape; 8] = [
        Self::Empty,
        Self::JsonObject,
        Self::Bracketed,
        Self::StackFrameAt,
        Self::HashFrame,
        Self::KeyColon,
        Self::Prose,
        Self::Token,
    ];

    /// Fixed vocabulary safe for a Sentry tag. Never derived from the line bytes.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Empty => "empty",
            Self::JsonObject => "json_object",
            Self::Bracketed => "bracketed",
            Self::StackFrameAt => "stack_frame_at",
            Self::HashFrame => "hash_frame",
            Self::KeyColon => "key_colon",
            Self::Prose => "prose",
            Self::Token => "token",
        }
    }
}

/// Classify one unmatched stderr line into a fixed structural shape. Inspects
/// only the line's leading token and whitespace structure; retains nothing.
pub fn classify_runner_stderr_shape(line: &str) -> RunnerStderrShape {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return RunnerStderrShape::Empty;
    }
    let first = trimmed.as_bytes()[0];
    match first {
        b'{' => return RunnerStderrShape::JsonObject,
        b'[' => return RunnerStderrShape::Bracketed,
        b'#' => return RunnerStderrShape::HashFrame,
        _ => {}
    }
    if trimmed.len() >= 3 && trimmed[..3].eq_ignore_ascii_case("at ") {
        return RunnerStderrShape::StackFrameAt;
    }
    let has_space = trimmed.chars().any(|c| c.is_whitespace());
    // A leading `<identifier>:` head, e.g. `Error:` / `ReadDirectoryChangesW:`.
    if let Some((head, _)) = trimmed.split_once(':') {
        if !head.is_empty()
            && head
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'.')
        {
            return RunnerStderrShape::KeyColon;
        }
    }
    if has_space {
        RunnerStderrShape::Prose
    } else {
        RunnerStderrShape::Token
    }
}

/// Cap on how many shapes the rollup renders into a single tag value, highest
/// count first — mirrors the runner-error rollups so the tag stays well under
/// Sentry's tag-value limit while surfacing the dominant shapes.
const UNMATCHED_SHAPE_TOP_N: usize = 3;

/// Saturating per-generation counts of the closed unmatched-stderr shape
/// vocabulary, plus a total count of unmatched lines. Renders a bounded tag such
/// as `json_object:5,key_colon:2,prose:1`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RunnerStderrShapeRollup {
    empty: u32,
    json_object: u32,
    bracketed: u32,
    stack_frame_at: u32,
    hash_frame: u32,
    key_colon: u32,
    prose: u32,
    token: u32,
    unmatched_lines: u32,
}

impl RunnerStderrShapeRollup {
    /// Classify one unmatched stderr line and increment its shape count and the
    /// total unmatched-line count. Callers pass ONLY lines whose
    /// `classify_runner_fatal_class` result was `None`.
    pub fn record(&mut self, line: &str) {
        let count = match classify_runner_stderr_shape(line) {
            RunnerStderrShape::Empty => &mut self.empty,
            RunnerStderrShape::JsonObject => &mut self.json_object,
            RunnerStderrShape::Bracketed => &mut self.bracketed,
            RunnerStderrShape::StackFrameAt => &mut self.stack_frame_at,
            RunnerStderrShape::HashFrame => &mut self.hash_frame,
            RunnerStderrShape::KeyColon => &mut self.key_colon,
            RunnerStderrShape::Prose => &mut self.prose,
            RunnerStderrShape::Token => &mut self.token,
        };
        *count = count.saturating_add(1);
        self.unmatched_lines = self.unmatched_lines.saturating_add(1);
    }

    /// Total unmatched lines recorded this generation.
    pub fn unmatched_line_count(&self) -> u32 {
        self.unmatched_lines
    }

    fn counts(&self) -> [(&'static str, u32); 8] {
        [
            (RunnerStderrShape::Empty.as_str(), self.empty),
            (RunnerStderrShape::JsonObject.as_str(), self.json_object),
            (RunnerStderrShape::Bracketed.as_str(), self.bracketed),
            (
                RunnerStderrShape::StackFrameAt.as_str(),
                self.stack_frame_at,
            ),
            (RunnerStderrShape::HashFrame.as_str(), self.hash_frame),
            (RunnerStderrShape::KeyColon.as_str(), self.key_colon),
            (RunnerStderrShape::Prose.as_str(), self.prose),
            (RunnerStderrShape::Token.as_str(), self.token),
        ]
    }

    /// Render the top-N shapes by count as a bounded Sentry tag. `None` when no
    /// unmatched line was recorded, so no tag should be sent.
    pub fn tag_value(&self) -> Option<String> {
        let mut nonzero: Vec<(&'static str, u32)> = self
            .counts()
            .into_iter()
            .filter(|(_, count)| *count > 0)
            .collect();
        // Stable sort keeps declaration order as the tie-break so the tag never
        // flaps for the same multiset.
        nonzero.sort_by(|left, right| right.1.cmp(&left.1));
        let rendered: Vec<String> = nonzero
            .into_iter()
            .take(UNMATCHED_SHAPE_TOP_N)
            .map(|(token, count)| format!("{token}:{count}"))
            .collect();
        (!rendered.is_empty()).then(|| rendered.join(","))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── allow-list mapping ────────────────────────────────────────────────────

    #[test]
    fn image_and_module_tokens_are_fixed_vocabulary_and_strip_paths() {
        assert_eq!(watcher_fault_image_token("node.exe"), "node.exe");
        assert_eq!(watcher_fault_image_token("NODE.EXE"), "node.exe");
        assert_eq!(
            watcher_fault_image_token(r"C:\Users\Ada\node.exe"),
            "node.exe"
        );
        assert_eq!(watcher_fault_image_token("npx.cmd"), "npx.cmd");
        assert_eq!(watcher_fault_image_token("cmd.exe"), "cmd.exe");
        assert_eq!(
            watcher_fault_image_token("hq-sync-menubar.exe"),
            "hq-sync-menubar.exe"
        );
        // Anything else — including something that embeds a username — collapses
        // to the fixed sentinel, never to a nearest guess or a leaked path.
        assert_eq!(
            watcher_fault_image_token(r"C:\Users\secret\evil.exe"),
            "other"
        );
        assert_eq!(watcher_fault_image_token("Ada's app.exe"), "other");
        assert_eq!(watcher_fault_module_token("ntdll.dll"), "ntdll.dll");
        assert_eq!(
            watcher_fault_module_token("KERNELBASE.dll"),
            "kernelbase.dll"
        );
        assert_eq!(
            watcher_fault_module_token(r"C:\Windows\System32\ucrtbase.dll"),
            "ucrtbase.dll"
        );
        assert_eq!(watcher_fault_module_token("msvcrt.dll"), "msvcrt.dll");
        assert_eq!(watcher_fault_module_token("some-vendor.dll"), "other");
        assert_eq!(watcher_fault_module_token(""), "other");
    }

    #[test]
    fn every_emitted_token_is_a_bounded_ascii_slug_with_no_leaky_bytes() {
        // No token an emitter can produce may carry a space, drive letter,
        // path separator, or anything other than a small allow-listed slug.
        let mut vocab: Vec<&'static str> = Vec::new();
        vocab.extend(WATCHER_FAULT_IMAGE_ALLOWLIST.iter().copied());
        vocab.extend(WATCHER_FAULT_MODULE_ALLOWLIST.iter().copied());
        vocab.push(WATCHER_FAULT_OTHER);
        vocab.extend(WatcherFaultProvenance::ALL.iter().map(|p| p.as_str()));
        vocab.extend(RunnerStderrShape::ALL.iter().map(|s| s.as_str()));
        for token in vocab {
            assert!(!token.is_empty());
            assert!(token.len() <= 32, "token too long: {token:?}");
            assert!(
                token.bytes().all(|b| b.is_ascii_lowercase()
                    || b.is_ascii_digit()
                    || b == b'.'
                    || b == b'-'
                    || b == b'_'),
                "token has an unexpected byte: {token:?}"
            );
            assert!(!token.contains(' '));
            assert!(!token.contains('\\'));
            assert!(!token.contains('/'));
        }
    }

    // ── WER parse ─────────────────────────────────────────────────────────────

    const WER_1000_XML: &str = r#"<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'>
<System><Provider Name='Application Error'/><EventID>1000</EventID>
<TimeCreated SystemTime='2026-08-11T10:37:41.1234567Z'/></System>
<EventData>
<Data>node.exe</Data>
<Data>20.11.1.0</Data>
<Data>65a1b2c3</Data>
<Data>ntdll.dll</Data>
<Data>10.0.22621.1</Data>
<Data>abcd1234</Data>
<Data>c0000409</Data>
<Data>000000000004a1b2</Data>
<Data>1abc</Data>
<Data>01d2...</Data>
<Data>C:\Users\Ada\AppData\Local\HQ\node.exe</Data>
<Data>C:\WINDOWS\SYSTEM32\ntdll.dll</Data>
<Data>{4b1e2c3d-0000-0000-0000-000000000000}</Data>
</EventData></Event>"#;

    #[test]
    fn parses_a_real_shape_wer_application_error_and_never_keeps_paths() {
        let record = parse_wer_application_error(WER_1000_XML).expect("parses");
        assert_eq!(record.image_token(), "node.exe");
        assert_eq!(record.module_token(), "ntdll.dll");
        assert_eq!(record.exception_code, 0xC000_0409_i64);
        assert_eq!(record.fault_offset, 0x0004_a1b2_u64);
        assert_eq!(record.faulting_pid, 0x1abc_u32);
        // The raw fields retained for allow-listing are the bare names, not the
        // full paths that appear later in the record.
        assert_eq!(record.faulting_image_raw, "node.exe");
        assert_eq!(record.faulting_module_raw, "ntdll.dll");
        assert!(record.created.is_some());
    }

    #[test]
    fn rejects_non_matching_event_shapes() {
        assert!(parse_wer_application_error("<Event/>").is_none());
        assert!(parse_wer_application_error("not xml at all").is_none());
        // Missing the exception code field.
        let short = "<EventData><Data>node.exe</Data><Data>x</Data></EventData>";
        assert!(parse_wer_application_error(short).is_none());
    }

    #[test]
    fn parses_process_id_rendered_in_decimal() {
        let xml = "<EventData><Data>cmd.exe</Data><Data>a</Data><Data>b</Data>\
                   <Data>kernelbase.dll</Data><Data>c</Data><Data>d</Data>\
                   <Data>c0000409</Data><Data>1000</Data><Data>4660</Data></EventData>";
        let record = parse_wer_application_error(xml).expect("parses");
        // 4660 hex is 0x4660; its decimal reading 4660 is kept as the alt so a
        // decimal-rendered pid still matches a decimal Job Object pid.
        assert_eq!(record.faulting_pid, 0x4660);
        assert_eq!(record.faulting_pid_decimal, Some(4660));
    }

    // ── provenance state machine ──────────────────────────────────────────────

    fn record_with_pid(pid: u32) -> WerApplicationError {
        WerApplicationError {
            faulting_image_raw: "node.exe".to_string(),
            faulting_module_raw: "ntdll.dll".to_string(),
            exception_code: 0xC000_0409,
            fault_offset: 0x1234,
            faulting_pid: pid,
            faulting_pid_decimal: None,
            created: None,
        }
    }

    #[test]
    fn pid_in_generation_set_yields_pid_matched() {
        let record = record_with_pid(4242);
        let pids: HashSet<u32> = [1, 4242, 99].into_iter().collect();
        let attribution = resolve_watcher_fault_attribution(true, Some(&record), Some(&pids));
        assert_eq!(attribution.provenance, WatcherFaultProvenance::PidMatched);
        assert_eq!(attribution.faulting_image, Some("node.exe"));
        assert_eq!(attribution.faulting_module, Some("ntdll.dll"));
        assert_eq!(attribution.exception_code, Some(0xC000_0409));
        assert_eq!(attribution.fault_offset, Some(0x1234));
    }

    #[test]
    fn pid_absent_from_set_degrades_to_window_only() {
        let record = record_with_pid(4242);
        let pids: HashSet<u32> = [1, 2, 3].into_iter().collect();
        let attribution = resolve_watcher_fault_attribution(true, Some(&record), Some(&pids));
        assert_eq!(attribution.provenance, WatcherFaultProvenance::WindowOnly);
        // The image/module are still reported — window_only is weaker attribution,
        // not absent evidence.
        assert_eq!(attribution.faulting_image, Some("node.exe"));
    }

    #[test]
    fn no_sampled_set_is_window_only_not_pid_matched() {
        let record = record_with_pid(4242);
        let attribution = resolve_watcher_fault_attribution(true, Some(&record), None);
        assert_eq!(attribution.provenance, WatcherFaultProvenance::WindowOnly);
    }

    #[test]
    fn no_record_and_unavailable_are_distinct_and_emit_no_integers() {
        let no_record = resolve_watcher_fault_attribution(true, None, None);
        assert_eq!(no_record.provenance, WatcherFaultProvenance::NoRecord);
        assert_eq!(no_record.faulting_image, None);
        assert_eq!(no_record.exception_code, None);

        let record = record_with_pid(1);
        let pids: HashSet<u32> = [1].into_iter().collect();
        let unavailable = resolve_watcher_fault_attribution(false, Some(&record), Some(&pids));
        assert_eq!(unavailable.provenance, WatcherFaultProvenance::Unavailable);
        // A failed query never reports a fault even if a record was somehow passed.
        assert_eq!(unavailable.faulting_image, None);
        assert_eq!(unavailable.exception_code, None);
        assert_eq!(WatcherFaultAttribution::unavailable(), unavailable);
    }

    // ── time window ───────────────────────────────────────────────────────────

    #[test]
    fn window_check_rejects_records_outside_the_generation_lifetime() {
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
        let lifetime = Duration::from_secs(600);
        // Inside the window.
        assert!(wer_record_in_window(
            Some(now - Duration::from_secs(120)),
            now,
            lifetime
        ));
        // Provably older than the generation → rejected.
        assert!(!wer_record_in_window(
            Some(now - Duration::from_secs(5_000)),
            now,
            lifetime
        ));
        // Far in the future → rejected (a later, different event).
        assert!(!wer_record_in_window(
            Some(now + Duration::from_secs(3_600)),
            now,
            lifetime
        ));
        // No timestamp → accepted (the query was already scoped).
        assert!(wer_record_in_window(None, now, lifetime));
    }

    // ── unmatched-stderr rollup ───────────────────────────────────────────────

    #[test]
    fn stderr_shape_classifier_is_structural_and_content_free() {
        assert_eq!(classify_runner_stderr_shape(""), RunnerStderrShape::Empty);
        assert_eq!(
            classify_runner_stderr_shape("   "),
            RunnerStderrShape::Empty
        );
        assert_eq!(
            classify_runner_stderr_shape(r#"{"type":"error","path":"/Users/Ada/secret.md"}"#),
            RunnerStderrShape::JsonObject
        );
        assert_eq!(
            classify_runner_stderr_shape("[chokidar] watching"),
            RunnerStderrShape::Bracketed
        );
        assert_eq!(
            classify_runner_stderr_shape("    at Object.<anonymous> (node:fs:1:1)"),
            RunnerStderrShape::StackFrameAt
        );
        assert_eq!(
            classify_runner_stderr_shape("#1 0x00 in abort"),
            RunnerStderrShape::HashFrame
        );
        assert_eq!(
            classify_runner_stderr_shape("ReadDirectoryChangesW: (5) Access is denied."),
            RunnerStderrShape::KeyColon
        );
        assert_eq!(
            classify_runner_stderr_shape("some free form message here"),
            RunnerStderrShape::Prose
        );
        assert_eq!(
            classify_runner_stderr_shape("bareword"),
            RunnerStderrShape::Token
        );
    }

    #[test]
    fn unmatched_rollup_renders_bounded_top_n_and_counts_every_line() {
        let mut rollup = RunnerStderrShapeRollup::default();
        for _ in 0..5 {
            rollup.record(r#"{"type":"error"}"#);
        }
        rollup.record("Error: boom");
        rollup.record("Error: bang");
        rollup.record("at f (x:1:1)");
        // Four distinct shapes seen, but only the top 3 render. The two shapes
        // tied at count 1 (bracketed, stack_frame_at) break the tie by
        // declaration order, so `bracketed` takes the third slot.
        rollup.record("[tag] line");
        let tag = rollup.tag_value().expect("nonzero");
        assert_eq!(tag, "json_object:5,key_colon:2,bracketed:1");
        assert_eq!(rollup.unmatched_line_count(), 9);
        // Stable across repeated identical input.
        let mut other = RunnerStderrShapeRollup::default();
        for _ in 0..5 {
            other.record(r#"{"type":"error"}"#);
        }
        other.record("Error: boom");
        other.record("Error: bang");
        other.record("at f (x:1:1)");
        other.record("[tag] line");
        assert_eq!(other.tag_value(), rollup.tag_value());
    }

    #[test]
    fn empty_unmatched_rollup_emits_no_tag() {
        let rollup = RunnerStderrShapeRollup::default();
        assert_eq!(rollup.tag_value(), None);
        assert_eq!(rollup.unmatched_line_count(), 0);
    }
}
