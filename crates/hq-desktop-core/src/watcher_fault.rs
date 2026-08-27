//! Content-safe Windows **fault provenance** for the auto-sync watcher route.
//!
//! HQ-DESKTOP-4X recurs because on the watcher route no fault-bearing stderr
//! line reaches the app at all: after a 0xC0000409 (`STATUS_STACK_BUFFER_OVERRUN`)
//! abort of a Node runner spawned through a `cmd.exe` batch shim, the exit
//! capture reports `runner_fatal_class=none` and cannot name which executable or
//! module in the seven-process watcher tree actually faulted. Widening the
//! stderr pattern table (PR #397) could never converge, because there is no line
//! to classify — the sibling manual-route issue HQ-DESKTOP-50 proves the arms
//! fire when a fatal line *does* arrive.
//!
//! This module replaces enumeration-over-stderr with reading the operating
//! system's own fault record. It is the pure half of that work — everything that
//! interprets a Windows Error Reporting "Application Error" (Event ID 1000)
//! record and decides how confidently it can be bound to a specific watcher
//! generation. The thin Win32 `wevtapi` query and Job Object PID sampling live in
//! `apps/sync/src-tauri/src/commands/process.rs` behind `cfg(windows)`; they only
//! produce rendered event XML strings and a sampled PID set, both of which are
//! interpreted here so the attribution logic is unit-testable off Windows.
//!
//! Content safety is absolute and follows the same discipline as
//! [`crate::runner_error_shape`]: only fixed constants chosen in code, bare
//! integers, and bounded rollups of those may ever leave the process. A faulting
//! image or module name is mapped through a closed allow-list to a fixed token
//! (or the sentinel `other`); it is never copied out. Absence of evidence is
//! never rendered as evidence — a missing record, a coincidental time-window-only
//! match, and a confirmed PID-scoped match are three visibly different states.

use crate::sync_outcome::classify_runner_fatal_class;
use crate::sync_outcome::RunnerFatalClass;

/// Cap on how many entries the unmatched-stderr shape rollup renders into a
/// single Sentry tag value, highest count first. Mirrors
/// `runner_error_shape::ROLLUP_TAG_TOP_N`; keeps the value well under Sentry's
/// 200-char tag limit even under a flood while surfacing the dominant shapes.
const ROLLUP_TAG_TOP_N: usize = 3;

/// The fixed sentinel every fault field degrades to when there is no record to
/// read at all, or the query itself could not run (non-Windows, disabled or
/// unreadable WER, or a timed-out query). Distinct from `other`, which means a
/// record WAS read but its binary is outside the allow-list.
pub const WATCHER_FAULT_UNAVAILABLE: &str = "unavailable";

// ─────────────────────────────────────────────────────────────────────────────
// Faulting-binary allow-list
// ─────────────────────────────────────────────────────────────────────────────

/// Closed allow-list of executables and modules that can be named as the
/// faulting image or module in a watcher-tree 0xC0000409 abort. Both the
/// faulting-executable and faulting-module positions map through this same list.
///
/// Every value is chosen here, never copied from the Windows Error Reporting
/// record: an image or module outside the list collapses to [`Self::Other`] and
/// never to a nearest guess, so no filesystem path, product string, or username
/// embedded in the record can leak through this token.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WatcherFaultBinary {
    /// The Node runtime — the runner itself.
    NodeExe,
    /// `npx.cmd`, the batch shim `resolve_bin` picks up for `npx`.
    NpxCmd,
    /// `cmd.exe`, the batch-shim interpreter the runner is dispatched through.
    CmdExe,
    /// The app's own menubar binary.
    HqSyncMenubarExe,
    /// The Windows loader / native runtime, the usual host of a `__fastfail`.
    NtdllDll,
    KernelbaseDll,
    UcrtbaseDll,
    MsvcrtDll,
    /// A record was read, but its image/module is not in the allow-list. Never a
    /// nearest guess — the record's raw name is discarded.
    Other,
}

impl WatcherFaultBinary {
    /// Every variant, so content-safety and anti-drift tests enumerate the
    /// emitter's own token set rather than a hand-copied list.
    pub const ALL: [WatcherFaultBinary; 9] = [
        Self::NodeExe,
        Self::NpxCmd,
        Self::CmdExe,
        Self::HqSyncMenubarExe,
        Self::NtdllDll,
        Self::KernelbaseDll,
        Self::UcrtbaseDll,
        Self::MsvcrtDll,
        Self::Other,
    ];

    /// Fixed vocabulary safe for a Sentry tag. Never derived from the record.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NodeExe => "node_exe",
            Self::NpxCmd => "npx_cmd",
            Self::CmdExe => "cmd_exe",
            Self::HqSyncMenubarExe => "hq_sync_menubar_exe",
            Self::NtdllDll => "ntdll_dll",
            Self::KernelbaseDll => "kernelbase_dll",
            Self::UcrtbaseDll => "ucrtbase_dll",
            Self::MsvcrtDll => "msvcrt_dll",
            Self::Other => "other",
        }
    }
}

/// Map an untrusted image/module name (as WER records it) to a fixed allow-listed
/// token. Only the final path component is inspected, case-insensitively, and
/// only to *select* a closed-vocabulary value — the returned token is always a
/// code constant, so no path byte, username, or product string can leak.
pub fn classify_watcher_fault_binary(name: &str) -> WatcherFaultBinary {
    let base = name
        .rsplit(|c: char| c == '/' || c == '\\')
        .find(|segment| !segment.is_empty())
        .unwrap_or("")
        .trim();
    match base.to_ascii_lowercase().as_str() {
        "node.exe" => WatcherFaultBinary::NodeExe,
        "npx.cmd" => WatcherFaultBinary::NpxCmd,
        "cmd.exe" => WatcherFaultBinary::CmdExe,
        "hq-sync-menubar.exe" => WatcherFaultBinary::HqSyncMenubarExe,
        "ntdll.dll" => WatcherFaultBinary::NtdllDll,
        "kernelbase.dll" => WatcherFaultBinary::KernelbaseDll,
        "ucrtbase.dll" => WatcherFaultBinary::UcrtbaseDll,
        "msvcrt.dll" => WatcherFaultBinary::MsvcrtDll,
        _ => WatcherFaultBinary::Other,
    }
}

/// Merge two observations of the SAME sampled PID's image across heartbeat
/// samples, keeping the most specific. Specificity ranks `None` (image not read
/// — process gone or query failed) below `Some(Other)` (an image WAS read but is
/// not on the allow-list) below `Some(<named>)` (a recognised binary). A real
/// live-tree reading is therefore never downgraded by a later post-death sample
/// that could not resolve the image, and an unresolved reading never displaces a
/// recognised one. Ties keep `current`. Pure, so it is unit-tested off Windows.
pub fn more_specific_image(
    current: Option<WatcherFaultBinary>,
    candidate: Option<WatcherFaultBinary>,
) -> Option<WatcherFaultBinary> {
    fn rank(image: Option<WatcherFaultBinary>) -> u8 {
        match image {
            None => 0,
            Some(WatcherFaultBinary::Other) => 1,
            Some(_) => 2,
        }
    }
    if rank(candidate) > rank(current) {
        candidate
    } else {
        current
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Provenance honesty token
// ─────────────────────────────────────────────────────────────────────────────

/// How confidently a read WER record is bound to *this* watcher generation, and
/// — when nothing bound — precisely WHY. The prior fix collapsed three different
/// failure states into the single `no_record` token and four into `unavailable`,
/// so a recurrence could not say which one occurred; this resolved, allow-listed
/// vocabulary separates them so the next occurrence is self-diagnosing. Every
/// non-binding state still leaves the image/module unnamed — absence never
/// masquerades as evidence.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WatcherFaultProvenance {
    /// The record's faulting PID is a member of the generation's sampled Job
    /// Object process set AND its timestamp falls inside the generation lifetime.
    PidMatched,
    /// The record's timestamp falls inside the generation lifetime (and matches
    /// the observed exception code), but its PID is not in the sampled set — a
    /// weaker, coincidence-possible binding.
    WindowOnly,
    /// The Application channel query could not be opened at all (WER disabled,
    /// unreadable, or throttled). Absence of a reader, not absence of a fault.
    QueryUnreadable,
    /// The query ran and the Application log yielded ZERO "Application Error"
    /// (Event 1000) records for the whole read.
    NoRecords,
    /// Records were parsed, but every one fell outside the generation binding
    /// window (or carried no readable timestamp to time-bind against).
    RejectedOutOfWindow,
    /// At least one in-window record was parsed, but its exception code disagreed
    /// with the fault the exit itself carried — a coincidental unrelated crash.
    RejectedCodeMismatch,
    /// Raw event XML was returned, but none of it parsed into a valid Application
    /// Error 1000 record (wrong template, truncated, or unrecognised).
    RejectedUnparsable,
    /// The deferred read reached its bounded deadline while the log was still
    /// empty — WER had not published the Event 1000 entry in time.
    DeadlineExpired,
    /// The read has been deferred off the exit path and has not resolved yet.
    /// Emitted only when a teardown flush preempts the deferred worker before it
    /// finishes; an honest "not read yet", never an attribution.
    Deferred,
    /// No Windows fault read applies to this exit (non-Windows platform, or a
    /// clean / non-fault exit). Replaces the prior fix's overloaded `unavailable`
    /// so a macOS exit no longer masquerades as a failed Windows read.
    NotApplicable,
}

impl WatcherFaultProvenance {
    pub const ALL: [WatcherFaultProvenance; 10] = [
        Self::PidMatched,
        Self::WindowOnly,
        Self::QueryUnreadable,
        Self::NoRecords,
        Self::RejectedOutOfWindow,
        Self::RejectedCodeMismatch,
        Self::RejectedUnparsable,
        Self::DeadlineExpired,
        Self::Deferred,
        Self::NotApplicable,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::PidMatched => "pid_matched",
            Self::WindowOnly => "window_only",
            Self::QueryUnreadable => "query_unreadable",
            Self::NoRecords => "no_records",
            Self::RejectedOutOfWindow => "rejected_out_of_window",
            Self::RejectedCodeMismatch => "rejected_code_mismatch",
            Self::RejectedUnparsable => "rejected_unparsable",
            Self::DeadlineExpired => "deadline_expired",
            Self::Deferred => "deferred",
            Self::NotApplicable => "not_applicable",
        }
    }

    /// True only for the two states that bind a record to this generation and
    /// therefore name an image. Every other state must render the `unavailable`
    /// image sentinel, so a producer bug that named an image on a non-binding
    /// provenance is caught by the invariant test.
    pub fn is_bound(self) -> bool {
        matches!(self, Self::PidMatched | Self::WindowOnly)
    }

    /// Diagnostic specificity ordering among the non-binding REJECTION states, so
    /// the deferred reader can retain the MOST actionable rejection across polling
    /// sweeps instead of letting a later, vaguer sweep overwrite it. Higher is more
    /// specific: a code mismatch names an in-window record for a different fault
    /// (the strongest "records existed, none were ours" signal); an unparsable
    /// record points at a parser/template gap; an out-of-window rejection is the
    /// vaguest. Every non-rejection state returns 0.
    pub fn rejection_specificity(self) -> u8 {
        match self {
            Self::RejectedCodeMismatch => 3,
            Self::RejectedUnparsable => 2,
            Self::RejectedOutOfWindow => 1,
            _ => 0,
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Parsed WER "Application Error" (Event ID 1000) record
// ─────────────────────────────────────────────────────────────────────────────

/// A content-safe projection of a Windows Error Reporting "Application Error"
/// record. Image and module are already allow-listed to fixed tokens, so this
/// struct never retains a raw record byte; the code, offset, PID, and time are
/// bare integers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WerApplicationError {
    pub image: WatcherFaultBinary,
    pub module: WatcherFaultBinary,
    pub exception_code: Option<u32>,
    pub fault_offset: Option<u64>,
    pub faulting_pid: Option<u32>,
    pub event_time_unix_ms: Option<i64>,
}

/// Decode the ordered, unnamed `<Data>` children of a rendered WER Application
/// Error event and the `System/TimeCreated` timestamp, WITHOUT retaining any
/// raw byte. The "Application Error"/Event 1000 template records its EventData
/// positionally: `[0]`=faulting app name, `[3]`=faulting module name,
/// `[6]`=exception code (hex), `[7]`=fault offset (hex), `[8]`=faulting PID
/// (hex). Names, versions, and full paths in the other slots are never read.
///
/// Returns `None` when the fragment is not a recognisable Application Error 1000
/// record (wrong provider/id, or no EventData). The image is required; every
/// other field degrades to `None` independently so a truncated record still
/// yields whatever it safely can.
pub fn parse_application_error_event(xml: &str) -> Option<WerApplicationError> {
    // Cheap provider/id gate so an unrelated Application-channel event that
    // happens to be handed to us is rejected rather than mis-parsed.
    if !is_application_error_1000(xml) {
        return None;
    }
    let data = ordered_event_data(xml);
    let image = classify_watcher_fault_binary(data.first().map(String::as_str).unwrap_or(""));
    let module = classify_watcher_fault_binary(data.get(3).map(String::as_str).unwrap_or(""));
    let exception_code = data.get(6).and_then(|token| parse_hex_u32(token));
    let fault_offset = data.get(7).and_then(|token| parse_hex_u64(token));
    let faulting_pid = data.get(8).and_then(|token| parse_hex_u32(token));
    let event_time_unix_ms = system_time_created_ms(xml);
    Some(WerApplicationError {
        image,
        module,
        exception_code,
        fault_offset,
        faulting_pid,
        event_time_unix_ms,
    })
}

/// True when the rendered event names the `Application Error` provider and event
/// id 1000. Case-sensitive on the provider name (Windows emits it verbatim) but
/// tolerant of attribute ordering/quoting.
fn is_application_error_1000(xml: &str) -> bool {
    let has_provider = xml.contains("Name='Application Error'")
        || xml.contains("Name=\"Application Error\"");
    // The EventID element carries the bare id as text: `<EventID ...>1000</EventID>`.
    let has_event_id = xml
        .split("<EventID")
        .skip(1)
        .filter_map(|rest| rest.split_once('>'))
        .filter_map(|(_, tail)| tail.split_once("</EventID>"))
        .any(|(value, _)| value.trim() == "1000");
    has_provider && has_event_id
}

/// Collect the inner text of each `<Data ...>...</Data>` element in document
/// order, decoding only the five XML entities Windows can emit. Attributes on
/// the open tag (some templates add `Name='…'`) are skipped; only element text
/// is read, and only to be positionally matched against the closed field layout.
fn ordered_event_data(xml: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = xml;
    while let Some(start) = rest.find("<Data") {
        rest = &rest[start + "<Data".len()..];
        // Skip to the end of the open tag; a self-closing `<Data/>` yields empty.
        let Some(open_end) = rest.find('>') else {
            break;
        };
        let self_closing = rest[..open_end].ends_with('/');
        rest = &rest[open_end + 1..];
        if self_closing {
            out.push(String::new());
            continue;
        }
        let Some(close) = rest.find("</Data>") else {
            break;
        };
        out.push(decode_xml_entities(&rest[..close]));
        rest = &rest[close + "</Data>".len()..];
    }
    out
}

/// Decode only the five predefined XML entities. Never interprets numeric
/// character references, so no byte value can be reconstructed into a token here.
fn decode_xml_entities(raw: &str) -> String {
    raw.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
        .trim()
        .to_string()
}

/// Extract `System/TimeCreated SystemTime='…'` as unix milliseconds. WER writes
/// an RFC 3339 UTC instant (7-digit fractional seconds); `chrono` parses any
/// fractional precision. Returns `None` when absent or unparseable.
fn system_time_created_ms(xml: &str) -> Option<i64> {
    let after = xml.split("SystemTime=").nth(1)?;
    let quote = after.chars().next()?;
    if quote != '\'' && quote != '"' {
        return None;
    }
    let value = after[quote.len_utf8()..].split(quote).next()?;
    chrono::DateTime::parse_from_rfc3339(value.trim())
        .ok()
        .map(|dt| dt.timestamp_millis())
}

fn parse_hex_u32(token: &str) -> Option<u32> {
    let token = token.trim().trim_start_matches("0x").trim_start_matches("0X");
    (!token.is_empty() && token.bytes().all(|b| b.is_ascii_hexdigit()))
        .then(|| u32::from_str_radix(token, 16).ok())
        .flatten()
}

fn parse_hex_u64(token: &str) -> Option<u64> {
    let token = token.trim().trim_start_matches("0x").trim_start_matches("0X");
    (!token.is_empty() && token.bytes().all(|b| b.is_ascii_hexdigit()))
        .then(|| u64::from_str_radix(token, 16).ok())
        .flatten()
}

// ─────────────────────────────────────────────────────────────────────────────
// Attribution decision
// ─────────────────────────────────────────────────────────────────────────────

/// Bounded, saturating integer counters describing what the read actually saw,
/// so a second failure states exactly why attribution failed rather than
/// repeating a blind retry. Every field is a bare integer; the rendered tag is a
/// fixed `token:count` rollup, so no record byte can ride through it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct WatcherFaultReadCounters {
    /// Raw event XML fragments the query returned across the whole read.
    pub records_seen: u32,
    /// Fragments that parsed into a valid Application Error 1000 record.
    pub records_parsed: u32,
    /// Parsed records rejected because they fell outside the binding window (or
    /// carried no readable timestamp to time-bind against).
    pub rejected_out_of_window: u32,
    /// In-window parsed records rejected because their exception code disagreed
    /// with the fault the exit itself carried.
    pub rejected_code_mismatch: u32,
    /// Query sweeps performed before the verdict (the deferred poll cadence).
    pub sweeps: u32,
    /// Milliseconds from the exit instant to the verdict.
    pub ms_to_verdict: u32,
}

impl WatcherFaultReadCounters {
    /// Compact, fixed-vocabulary rollup for a Sentry tag, always rendered (even
    /// all-zero) so `seen:0` is an assertable, comparable fact. Bounded well under
    /// Sentry's 200-char limit: six `token:integer` pairs.
    pub fn tag_value(&self) -> String {
        format!(
            "seen:{},parsed:{},rej_win:{},rej_code:{},sweeps:{},ms:{}",
            self.records_seen,
            self.records_parsed,
            self.rejected_out_of_window,
            self.rejected_code_mismatch,
            self.sweeps,
            self.ms_to_verdict,
        )
    }

    /// Total rejected-record evidence across both reasons, saturating. Used only
    /// to tie-break which of two equally-specific rejections to retain across the
    /// deferred read's polling sweeps — never rendered on its own.
    pub fn total_rejected(&self) -> u32 {
        self.rejected_out_of_window
            .saturating_add(self.rejected_code_mismatch)
    }
}

/// The content-safe result of attributing a fault to this watcher generation.
/// Every field is a fixed token or a bare integer. `image`/`module` are `None`
/// (rendered as [`WATCHER_FAULT_UNAVAILABLE`]) for every provenance except
/// `PidMatched`/`WindowOnly`, so absence can never masquerade as evidence.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WatcherFaultOutcome {
    pub provenance: WatcherFaultProvenance,
    pub image: Option<WatcherFaultBinary>,
    pub module: Option<WatcherFaultBinary>,
    pub exception_code: Option<u32>,
    pub fault_offset: Option<u64>,
    pub counters: WatcherFaultReadCounters,
}

impl WatcherFaultOutcome {
    /// An unresolved outcome with the given provenance: no named image/module,
    /// no code/offset, zero counters. The one constructor for every non-binding
    /// state, so absence is uniform and a named image can never leak onto one.
    pub fn unresolved(provenance: WatcherFaultProvenance) -> Self {
        debug_assert!(
            !provenance.is_bound(),
            "unresolved outcome must not carry a bound provenance"
        );
        Self {
            provenance,
            image: None,
            module: None,
            exception_code: None,
            fault_offset: None,
            counters: WatcherFaultReadCounters::default(),
        }
    }

    /// No Windows fault read applies (non-Windows, or a clean / non-fault exit).
    pub fn not_applicable() -> Self {
        Self::unresolved(WatcherFaultProvenance::NotApplicable)
    }

    /// The read has been deferred and has not resolved yet. Emitted only when a
    /// teardown flush preempts the deferred worker.
    pub fn deferred() -> Self {
        Self::unresolved(WatcherFaultProvenance::Deferred)
    }

    /// Attach read counters (fluent). The reader folds in the seen/sweeps/latency
    /// it measured around the pure binding decision.
    pub fn with_counters(mut self, counters: WatcherFaultReadCounters) -> Self {
        self.counters = counters;
        self
    }

    fn from_record(record: &WerApplicationError, provenance: WatcherFaultProvenance) -> Self {
        Self {
            provenance,
            image: Some(record.image),
            module: Some(record.module),
            exception_code: record.exception_code,
            fault_offset: record.fault_offset,
            counters: WatcherFaultReadCounters::default(),
        }
    }

    /// Fixed token for the faulting executable, or [`WATCHER_FAULT_UNAVAILABLE`].
    pub fn image_token(&self) -> &'static str {
        self.image
            .map(WatcherFaultBinary::as_str)
            .unwrap_or(WATCHER_FAULT_UNAVAILABLE)
    }

    /// Fixed token for the faulting module, or [`WATCHER_FAULT_UNAVAILABLE`].
    pub fn module_token(&self) -> &'static str {
        self.module
            .map(WatcherFaultBinary::as_str)
            .unwrap_or(WATCHER_FAULT_UNAVAILABLE)
    }

    pub fn provenance_token(&self) -> &'static str {
        self.provenance.as_str()
    }

    /// The rendered read-counters tag.
    pub fn counters_tag(&self) -> String {
        self.counters.tag_value()
    }

    /// Between two non-binding REJECTION outcomes gathered on different polling
    /// sweeps, the one the deferred reader should retain. The more diagnostically
    /// specific provenance wins (code mismatch > unparsable > out-of-window); on a
    /// tie the outcome carrying more rejected-record evidence wins; otherwise
    /// `self`. Without this a later sweep whose newest-record set no longer
    /// contains the in-window mismatch would overwrite a `rejected_code_mismatch`
    /// verdict with a vaguer `rejected_out_of_window` one, hiding the more
    /// actionable finding. Pure and order-independent so it is unit-tested off
    /// Windows.
    pub fn stronger_rejection(self, other: Self) -> Self {
        let mine = self.provenance.rejection_specificity();
        let theirs = other.provenance.rejection_specificity();
        if theirs > mine {
            other
        } else if theirs < mine {
            self
        } else if other.counters.total_rejected() > self.counters.total_rejected() {
            other
        } else {
            self
        }
    }
}

/// Bind zero or more read WER Application Error records to this watcher
/// generation and choose the single most-confident provenance, or — when nothing
/// binds — the specific reason it did not.
///
/// `records` are the parsed candidates (newest first is preferred but not
/// required — the strongest binding wins regardless of order). `sampled_pids` is
/// the union of live Job Object process ids sampled across the generation's
/// lifetime; `[gen_start_ms, gen_end_ms]` is that lifetime as a closed unix-ms
/// window. `observed_exception_code`, when known, is the fault status the exit
/// itself carried, used to reject an in-window record for an unrelated fault.
///
/// Precedence, strongest first:
///  1. `PidMatched` — faulting PID ∈ `sampled_pids` AND time ∈ window.
///  2. `WindowOnly` — time ∈ window AND (no observed code, or codes agree).
///  3. Otherwise a distinct non-binding reason with per-reason counters:
///     `NoRecords` (empty), `RejectedCodeMismatch` (an in-window record for a
///     different fault), or `RejectedOutOfWindow` (all records outside the
///     window / untimebindable).
///
/// A weaker binding is never upgraded, and a record outside the window is never
/// reported, so PID reuse or a coincidental unrelated crash on the same machine
/// downgrades to `window_only` or is rejected outright rather than producing a
/// false `pid_matched`.
pub fn attribute_watcher_fault(
    records: &[WerApplicationError],
    sampled_pids: &[u32],
    gen_start_ms: i64,
    gen_end_ms: i64,
    observed_exception_code: Option<u32>,
) -> WatcherFaultOutcome {
    let mut counters = WatcherFaultReadCounters {
        records_parsed: records.len().min(u32::MAX as usize) as u32,
        ..Default::default()
    };
    if records.is_empty() {
        return WatcherFaultOutcome::unresolved(WatcherFaultProvenance::NoRecords)
            .with_counters(counters);
    }
    let in_window = |record: &WerApplicationError| {
        record
            .event_time_unix_ms
            .map(|ms| ms >= gen_start_ms && ms <= gen_end_ms)
            // A record with no readable timestamp cannot be time-bound; require
            // an explicit time to avoid binding a stale crash to this generation.
            .unwrap_or(false)
    };
    let code_agrees = |record: &WerApplicationError| match (observed_exception_code, record.exception_code) {
        (Some(observed), Some(found)) => observed == found,
        // No observed code to check against, or the record omitted one: do not
        // let a missing code veto a time+PID match.
        _ => true,
    };

    // Strongest: PID membership in the sampled set AND an in-window timestamp.
    if let Some(record) = records.iter().find(|record| {
        in_window(record)
            && code_agrees(record)
            && record
                .faulting_pid
                .is_some_and(|pid| sampled_pids.contains(&pid))
    }) {
        return WatcherFaultOutcome::from_record(record, WatcherFaultProvenance::PidMatched)
            .with_counters(counters);
    }

    // Weaker: in-window and code-consistent, but PID not confirmed.
    if let Some(record) = records
        .iter()
        .find(|record| in_window(record) && code_agrees(record))
    {
        return WatcherFaultOutcome::from_record(record, WatcherFaultProvenance::WindowOnly)
            .with_counters(counters);
    }

    // Nothing bound: diagnose precisely why, counting each rejection reason so
    // the next occurrence is actionable rather than a repeat of the blind retry.
    for record in records {
        if in_window(record) && !code_agrees(record) {
            counters.rejected_code_mismatch = counters.rejected_code_mismatch.saturating_add(1);
        } else {
            counters.rejected_out_of_window = counters.rejected_out_of_window.saturating_add(1);
        }
    }
    // A code mismatch on an in-window record is the more specific, more
    // actionable finding, so it wins the headline provenance when present.
    let provenance = if counters.rejected_code_mismatch > 0 {
        WatcherFaultProvenance::RejectedCodeMismatch
    } else {
        WatcherFaultProvenance::RejectedOutOfWindow
    };
    WatcherFaultOutcome::unresolved(provenance).with_counters(counters)
}

// ─────────────────────────────────────────────────────────────────────────────
// WER-independent job-image descriptor
// ─────────────────────────────────────────────────────────────────────────────

/// The honesty token for the job-image descriptor: it is a TREE OBSERVATION of
/// which images the app's own process-tree sampling saw alive, NOT a fault
/// attribution. Kept visibly distinct from every [`WatcherFaultProvenance`]
/// value so the two channels can never be confused.
pub const WATCHER_JOB_IMAGE_OBSERVED: &str = "job_tree_observed";

/// A content-safe rollup of the allow-listed images the generation's live Job
/// Object process tree was observed to contain, sampled while those processes
/// were still alive (the fault read only runs after they die). It supplies a
/// named culprit CANDIDATE even when WER never yields a record, without ever
/// letting absence masquerade as evidence: every value is a fixed allow-listed
/// token, and the provenance token marks it a tree observation, not a fault
/// attribution. A weaker signal is never upgraded to a stronger one.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct WatcherJobImageDescriptor {
    node_exe: bool,
    npx_cmd: bool,
    cmd_exe: bool,
    hq_sync_menubar_exe: bool,
    other: bool,
}

impl WatcherJobImageDescriptor {
    /// Fold one observed process image (already mapped through
    /// [`classify_watcher_fault_binary`]) into the set. Loader DLL tokens cannot
    /// arise from a process image and are intentionally ignored here.
    pub fn record(&mut self, image: WatcherFaultBinary) {
        match image {
            WatcherFaultBinary::NodeExe => self.node_exe = true,
            WatcherFaultBinary::NpxCmd => self.npx_cmd = true,
            WatcherFaultBinary::CmdExe => self.cmd_exe = true,
            WatcherFaultBinary::HqSyncMenubarExe => self.hq_sync_menubar_exe = true,
            WatcherFaultBinary::Other => self.other = true,
            // A DLL token never names a process image; ignore rather than record
            // a value the sampler could not have produced.
            WatcherFaultBinary::NtdllDll
            | WatcherFaultBinary::KernelbaseDll
            | WatcherFaultBinary::UcrtbaseDll
            | WatcherFaultBinary::MsvcrtDll => {}
        }
    }

    /// Fold an OPTIONAL observed image: a `None` (the PID's image could not be
    /// read — the process exited between the Job Object query and the image query,
    /// or the query failed) records NOTHING, so a failed lookup never masquerades
    /// as an `other` observation, is never selected as a culprit candidate, and is
    /// never labelled `job_tree_observed`. The PID is still retained for WER
    /// binding by the caller; only the image observation is omitted. Absence never
    /// masquerades as evidence.
    pub fn record_optional(&mut self, image: Option<WatcherFaultBinary>) {
        if let Some(image) = image {
            self.record(image);
        }
    }

    /// The observed set in fixed declaration order, as `(token, present)` pairs.
    fn present(&self) -> [(&'static str, bool); 5] {
        [
            (WatcherFaultBinary::NodeExe.as_str(), self.node_exe),
            (WatcherFaultBinary::NpxCmd.as_str(), self.npx_cmd),
            (WatcherFaultBinary::CmdExe.as_str(), self.cmd_exe),
            (WatcherFaultBinary::HqSyncMenubarExe.as_str(), self.hq_sync_menubar_exe),
            (WatcherFaultBinary::Other.as_str(), self.other),
        ]
    }

    /// Bounded, deduped set tag of the observed images (`cmd_exe,node_exe`), in
    /// fixed order. `None` when nothing was observed, so no tag is sent.
    pub fn images_tag(&self) -> Option<String> {
        let rendered: Vec<&'static str> = self
            .present()
            .into_iter()
            .filter_map(|(token, present)| present.then_some(token))
            .collect();
        (!rendered.is_empty()).then(|| rendered.join(","))
    }

    /// A deterministic non-shim culprit CANDIDATE from the observed set, by fixed
    /// precedence: the Node runner first, then the app's own binary, then an
    /// unknown non-shim image. The shim/dispatch layer (`cmd.exe`/`npx.cmd`) is
    /// never a candidate — it only dispatches. `None` when only shim images or
    /// nothing was observed.
    pub fn culprit_candidate(&self) -> Option<WatcherFaultBinary> {
        if self.node_exe {
            Some(WatcherFaultBinary::NodeExe)
        } else if self.hq_sync_menubar_exe {
            Some(WatcherFaultBinary::HqSyncMenubarExe)
        } else if self.other {
            Some(WatcherFaultBinary::Other)
        } else {
            None
        }
    }

    /// Fixed token for the culprit candidate, or [`WATCHER_FAULT_UNAVAILABLE`].
    pub fn culprit_candidate_token(&self) -> &'static str {
        self.culprit_candidate()
            .map(WatcherFaultBinary::as_str)
            .unwrap_or(WATCHER_FAULT_UNAVAILABLE)
    }

    /// The tree-observation provenance token when anything was observed, else the
    /// unavailable sentinel — so absence is never rendered as a named observation.
    pub fn provenance_token(&self) -> &'static str {
        if self.images_tag().is_some() {
            WATCHER_JOB_IMAGE_OBSERVED
        } else {
            WATCHER_FAULT_UNAVAILABLE
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Unmatched-stderr structural rollup
// ─────────────────────────────────────────────────────────────────────────────

/// Fixed, content-safe *coarse structural shape* of a runner stderr line that
/// [`classify_runner_fatal_class`] did not recognise. This closes the watcher
/// route's "was stderr silent or noisy-but-unrecognised?" blind spot: it yields
/// a recurring, comparable descriptor of the unknown-line family across
/// occurrences without ever emitting a runner byte. Every shape is decided from
/// cheap structural predicates on the line — never from its content.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnmatchedStderrShape {
    /// Parses as (or clearly opens as) an ndjson protocol/object record — the
    /// hq-cloud error flood the live event's tail was full of.
    NdjsonRecord,
    /// A JS/Node stack frame (`at Object.<anonymous> (...)`).
    StackFrame,
    /// A Node `--report`/CheckMacro abort frame (`#12 0x...`).
    HashFrame,
    /// A leading bare identifier followed by a colon (`Error: …`, `TypeError: …`).
    KeyColon,
    /// Carries a Windows drive-letter path or a run of forward slashes.
    PathLike,
    /// Empty or whitespace only.
    Blank,
    /// A single bare token with no interior whitespace.
    Word,
    /// None of the above.
    Other,
}

impl UnmatchedStderrShape {
    pub const ALL: [UnmatchedStderrShape; 8] = [
        Self::NdjsonRecord,
        Self::StackFrame,
        Self::HashFrame,
        Self::KeyColon,
        Self::PathLike,
        Self::Blank,
        Self::Word,
        Self::Other,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::NdjsonRecord => "ndjson_record",
            Self::StackFrame => "stack_frame",
            Self::HashFrame => "hash_frame",
            Self::KeyColon => "key_colon",
            Self::PathLike => "path_like",
            Self::Blank => "blank",
            Self::Word => "word",
            Self::Other => "other",
        }
    }
}

/// Classify one unrecognised stderr line by structure only. The line is inspected
/// solely to *select* a fixed token; nothing is retained.
pub fn classify_unmatched_stderr_shape(line: &str) -> UnmatchedStderrShape {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return UnmatchedStderrShape::Blank;
    }
    if trimmed.starts_with('{') && serde_json::from_str::<serde_json::Value>(trimmed).is_ok() {
        return UnmatchedStderrShape::NdjsonRecord;
    }
    if trimmed.starts_with("at ") {
        return UnmatchedStderrShape::StackFrame;
    }
    if trimmed.starts_with('#')
        && trimmed[1..]
            .trim_start()
            .starts_with(|c: char| c.is_ascii_digit())
    {
        return UnmatchedStderrShape::HashFrame;
    }
    if has_drive_path(trimmed) || slash_run(trimmed) {
        return UnmatchedStderrShape::PathLike;
    }
    if leading_identifier_colon(trimmed) {
        return UnmatchedStderrShape::KeyColon;
    }
    if !trimmed.contains(char::is_whitespace) {
        return UnmatchedStderrShape::Word;
    }
    UnmatchedStderrShape::Other
}

/// A Windows drive-letter path root (`C:\`), the shape most likely to smuggle a
/// user path.
fn has_drive_path(line: &str) -> bool {
    let bytes = line.as_bytes();
    line.char_indices().any(|(i, c)| {
        c == ':'
            && i >= 1
            && bytes[i - 1].is_ascii_alphabetic()
            && bytes.get(i + 1) == Some(&b'\\')
    })
}

/// A line with several forward slashes reads as a POSIX-ish path.
fn slash_run(line: &str) -> bool {
    line.bytes().filter(|b| *b == b'/').count() >= 2
}

/// A leading `[A-Za-z_][A-Za-z0-9_]*` immediately followed by `:` — the `Error:`
/// / `TypeError:` message shape. Requires the token before the colon to be a
/// bare identifier so a bare `12:34` or a drive path is not mistaken for one.
fn leading_identifier_colon(line: &str) -> bool {
    let Some((head, _)) = line.split_once(':') else {
        return false;
    };
    !head.is_empty()
        && head.bytes().next().is_some_and(|b| b.is_ascii_alphabetic() || b == b'_')
        && head.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

/// Saturating per-generation counts of the closed unmatched-shape vocabulary.
/// Renders a compact, fixed-vocabulary Sentry tag such as
/// `ndjson_record:6,stack_frame:2`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UnmatchedStderrShapeRollup {
    ndjson_record: u32,
    stack_frame: u32,
    hash_frame: u32,
    key_colon: u32,
    path_like: u32,
    blank: u32,
    word: u32,
    other: u32,
}

impl UnmatchedStderrShapeRollup {
    /// Record one stderr line ONLY if the fatal classifier did not recognise it.
    /// A recognised line already has a `runner_fatal_class` and must not also be
    /// counted here, so the rollup describes exactly the unattributed remainder.
    pub fn record_if_unmatched(&mut self, line: &str) {
        if classify_runner_fatal_class(line) != RunnerFatalClass::None {
            return;
        }
        self.bump(classify_unmatched_stderr_shape(line));
    }

    /// Record one stderr line UNCONDITIONALLY by structure. Unlike
    /// [`Self::record_if_unmatched`], this does NOT consult
    /// [`classify_runner_fatal_class`]: the install-failure route (HQ-DESKTOP-56)
    /// applies its OWN npm-marker skip predicate before feeding lines here, so the
    /// sync-runner's fatal-class filter — which is specific to that route's stderr
    /// vocabulary — must not silently drop npm/OS lines. The sync-runner path keeps
    /// using `record_if_unmatched`, whose behaviour is unchanged.
    pub fn record(&mut self, line: &str) {
        self.bump(classify_unmatched_stderr_shape(line));
    }

    /// Increment the saturating counter for one already-classified shape. Shared by
    /// both record entrypoints so their counting can never drift apart.
    fn bump(&mut self, shape: UnmatchedStderrShape) {
        let count = match shape {
            UnmatchedStderrShape::NdjsonRecord => &mut self.ndjson_record,
            UnmatchedStderrShape::StackFrame => &mut self.stack_frame,
            UnmatchedStderrShape::HashFrame => &mut self.hash_frame,
            UnmatchedStderrShape::KeyColon => &mut self.key_colon,
            UnmatchedStderrShape::PathLike => &mut self.path_like,
            UnmatchedStderrShape::Blank => &mut self.blank,
            UnmatchedStderrShape::Word => &mut self.word,
            UnmatchedStderrShape::Other => &mut self.other,
        };
        *count = count.saturating_add(1);
    }

    fn counts(&self) -> [(&'static str, u32); 8] {
        [
            (UnmatchedStderrShape::NdjsonRecord.as_str(), self.ndjson_record),
            (UnmatchedStderrShape::StackFrame.as_str(), self.stack_frame),
            (UnmatchedStderrShape::HashFrame.as_str(), self.hash_frame),
            (UnmatchedStderrShape::KeyColon.as_str(), self.key_colon),
            (UnmatchedStderrShape::PathLike.as_str(), self.path_like),
            (UnmatchedStderrShape::Blank.as_str(), self.blank),
            (UnmatchedStderrShape::Word.as_str(), self.word),
            (UnmatchedStderrShape::Other.as_str(), self.other),
        ]
    }

    /// Render the top-N shapes by count as a bounded Sentry tag. `None` means no
    /// unmatched lines were seen this generation, so no tag should be sent.
    pub fn tag_value(&self) -> Option<String> {
        render_top_n(&self.counts(), ROLLUP_TAG_TOP_N)
    }

    /// The single most-frequent shape recorded this generation, with a stable
    /// declaration-order tie-break (identical to the ordering [`render_top_n`]
    /// uses, so the dominant shape is always the first token the tag renders).
    /// `None` when nothing was recorded.
    pub fn dominant(&self) -> Option<UnmatchedStderrShape> {
        UnmatchedStderrShape::ALL
            .into_iter()
            .zip(self.counts().into_iter().map(|(_, count)| count))
            .filter(|(_, count)| *count > 0)
            .fold(
                None,
                |best: Option<(UnmatchedStderrShape, u32)>, (shape, count)| match best {
                    // Strictly-greater replaces; an equal count keeps the earlier
                    // (declaration-order) shape, matching render_top_n's stable sort.
                    Some((_, best_count)) if best_count >= count => best,
                    _ => Some((shape, count)),
                },
            )
            .map(|(shape, _)| shape)
    }
}

/// Bounded renderer: keep nonzero entries, order by count descending with a
/// stable declaration-order tie-break, take the top `n`, join as `token:count`.
/// `None` when every count is zero. (A local copy of the same discipline used by
/// `runner_error_shape::render_top_n`, kept here so the modules stay independent.)
fn render_top_n(counts: &[(&'static str, u32)], n: usize) -> Option<String> {
    let mut nonzero: Vec<(&'static str, u32)> = counts
        .iter()
        .copied()
        .filter(|(_, count)| *count > 0)
        .collect();
    nonzero.sort_by(|left, right| right.1.cmp(&left.1));
    let rendered: Vec<String> = nonzero
        .into_iter()
        .take(n)
        .map(|(token, count)| format!("{token}:{count}"))
        .collect();
    (!rendered.is_empty()).then(|| rendered.join(","))
}

// ─────────────────────────────────────────────────────────────────────────────
// macOS SIGKILL / jetsam kill provenance (HQ-DESKTOP-4D)
// ─────────────────────────────────────────────────────────────────────────────
//
// On macOS a watcher SIGKILL (`signal=9`) carries NO Windows fault surface: the
// whole `WatcherFaultProvenance` channel is `NotApplicable` for a signal death,
// so a jetsam (memory-pressure) kill and an external `kill -9` were
// indistinguishable — the exact ambiguity HQ-DESKTOP-4D records. This parallel,
// allow-listed vocabulary attributes the kill from macOS's own JetsamEvent
// reports plus live memory-pressure evidence, under the SAME content-safety
// discipline as the Windows surface above: only fixed constants, bare integers,
// and bucketed values ever leave the process. A victim name is mapped through the
// existing [`classify_watcher_fault_binary`] allow-list; absence of a record is
// never rendered as evidence.

/// The fixed sentinel every macOS kill field degrades to when no read applies or
/// nothing bound. Distinct from a bound attribution so a blind read is visibly
/// different from a real jetsam match.
pub const WATCHER_KILL_UNAVAILABLE: &str = "unavailable";

/// How confidently a macOS SIGKILL of the watcher is attributed to a jetsam kill
/// of THIS generation, and — when nothing bound — precisely why. Mirrors
/// [`WatcherFaultProvenance`] for the signal-death case the Windows surface can
/// never speak to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WatcherKillProvenance {
    /// A JetsamEvent report in the generation window names a victim PID that is a
    /// member of the generation's sampled process set — the strongest binding.
    JetsamPidMatched,
    /// A JetsamEvent report falls in the generation window but names no sampled
    /// PID — a weaker, coincidence-possible binding.
    JetsamWindowMatched,
    /// The reader ran, but no JetsamEvent report bound to this generation (none in
    /// the window, or none at all), and the live evidence did not point elsewhere.
    NoJetsamRecord,
    /// No binding jetsam report, but the generation's live memory-pressure samples
    /// reached `warn`/`critical` — a pressure kill is plausible though the OS wrote
    /// no report we could bind.
    PressureOnly,
    /// No binding jetsam report, pressure stayed `normal`, and the peak RSS was
    /// low — the kill looks external (`kill -9`), not memory-driven. The one state
    /// that positively separates an external kill from a jetsam victim.
    ExternalKillSuspected,
    /// The app's own SIGTERM→SIGKILL escalation fired for this generation, so the
    /// SIGKILL is self-inflicted teardown and can never be reported as external
    /// (defence in depth behind the HQ-DESKTOP-4P durable cancellation record).
    SelfEscalated,
    /// The DiagnosticReports directories could not be listed or opened (TCC,
    /// sandbox, or a hardened runtime). Absence of a reader, not absence of a kill.
    ReaderUnavailable,
    /// The deferred read reached its bounded deadline before a report was found.
    DeadlineExpired,
    /// The read has been deferred off the exit path and has not resolved yet.
    /// Emitted only when a teardown flush preempts the deferred worker; an honest
    /// "not read yet", never an attribution.
    Deferred,
    /// No macOS kill read applies to this exit (non-macOS platform, or a
    /// non-SIGKILL exit). Parallel to [`WatcherFaultProvenance::NotApplicable`].
    NotApplicable,
}

impl WatcherKillProvenance {
    pub const ALL: [WatcherKillProvenance; 10] = [
        Self::JetsamPidMatched,
        Self::JetsamWindowMatched,
        Self::NoJetsamRecord,
        Self::PressureOnly,
        Self::ExternalKillSuspected,
        Self::SelfEscalated,
        Self::ReaderUnavailable,
        Self::DeadlineExpired,
        Self::Deferred,
        Self::NotApplicable,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::JetsamPidMatched => "jetsam_pid_matched",
            Self::JetsamWindowMatched => "jetsam_window_matched",
            Self::NoJetsamRecord => "no_jetsam_record",
            Self::PressureOnly => "pressure_only",
            Self::ExternalKillSuspected => "external_kill_suspected",
            Self::SelfEscalated => "self_escalated",
            Self::ReaderUnavailable => "reader_unavailable",
            Self::DeadlineExpired => "deadline_expired",
            Self::Deferred => "deferred",
            Self::NotApplicable => "not_applicable",
        }
    }

    /// True only for the two states that bind a jetsam report to this generation
    /// and therefore may carry a kill reason and an rpages bucket. Every other
    /// state must render the `unavailable` sentinels, so a producer bug that named
    /// a reason on a non-binding provenance is caught by the invariant test.
    pub fn is_bound(self) -> bool {
        matches!(self, Self::JetsamPidMatched | Self::JetsamWindowMatched)
    }
}

/// Closed vocabulary for a JetsamEvent kill reason. macOS records a free-form
/// `killReason`/`reason` string; it is mapped to one of these fixed tokens and
/// the raw string is never copied out.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JetsamKillReason {
    /// The victim exceeded its per-process memory limit (`per-process-limit`).
    PerProcessLimit,
    /// The victim crossed a memory high-water mark (`highwater`).
    Highwater,
    /// System-wide page shortage forced the kill (`vm-pageshortage`).
    VmPageshortage,
    /// System-wide thrashing forced the kill (`vm-thrashing`).
    VmThrashing,
    /// A reason string was present but outside the allow-list — never a nearest
    /// guess; the raw string is discarded.
    Other,
}

impl JetsamKillReason {
    pub const ALL: [JetsamKillReason; 5] = [
        Self::PerProcessLimit,
        Self::Highwater,
        Self::VmPageshortage,
        Self::VmThrashing,
        Self::Other,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::PerProcessLimit => "per_process_limit",
            Self::Highwater => "highwater",
            Self::VmPageshortage => "vm_pageshortage",
            Self::VmThrashing => "vm_thrashing",
            Self::Other => "other",
        }
    }
}

/// Map an untrusted JetsamEvent reason string to a fixed allow-listed token. Only
/// used to SELECT a closed-vocabulary value; the returned token is always a code
/// constant, so no record byte can leak. Tolerant of the hyphen/underscore/space
/// spellings macOS has used across releases.
pub fn classify_jetsam_kill_reason(raw: &str) -> JetsamKillReason {
    let normalized: String = raw
        .trim()
        .to_ascii_lowercase()
        .chars()
        .map(|c| if c == ' ' || c == '_' { '-' } else { c })
        .collect();
    match normalized.as_str() {
        "per-process-limit" | "perprocesslimit" | "per-process" => JetsamKillReason::PerProcessLimit,
        "highwater" | "high-water" | "high-watermark" => JetsamKillReason::Highwater,
        "vm-pageshortage" | "pageshortage" | "vm-page-shortage" => JetsamKillReason::VmPageshortage,
        "vm-thrashing" | "thrashing" => JetsamKillReason::VmThrashing,
        _ => JetsamKillReason::Other,
    }
}

/// Bucket a JetsamEvent victim's resident-page count (`rpages`) into a fixed
/// vocabulary, so the victim's footprint is comparable across events without a
/// raw byte figure ever leaving the process. Bucketing is on the raw page COUNT,
/// not an inferred byte total, because the macOS page size is platform-dependent
/// (16 KiB Apple Silicon / 4 KiB Intel) and must not be assumed here.
pub fn jetsam_rpages_bucket(rpages: u64) -> &'static str {
    match rpages {
        0..=9_999 => "under_10k",
        10_000..=99_999 => "10k_to_100k",
        100_000..=499_999 => "100k_to_500k",
        500_000..=999_999 => "500k_to_1m",
        _ => "over_1m",
    }
}

/// Closed vocabulary for the live memory-pressure axis (`kern.memorystatus_vm_
/// pressure_level`). Needs no entitlement and no file access, so it still
/// separates a pressure kill from a quiet external kill even when the .ips reader
/// is blind. `Unknown` keeps "we could not read the level" distinct from a real
/// `normal`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemoryPressureLevel {
    Normal,
    Warn,
    Critical,
    Unknown,
}

impl MemoryPressureLevel {
    pub const ALL: [MemoryPressureLevel; 4] = [
        Self::Normal,
        Self::Warn,
        Self::Critical,
        Self::Unknown,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Normal => "normal",
            Self::Warn => "warn",
            Self::Critical => "critical",
            Self::Unknown => "unknown",
        }
    }

    /// Map the raw `kern.memorystatus_vm_pressure_level` sysctl value to a level.
    /// That sysctl reports Darwin's `vm_pressure_level_t` enum — 0=normal,
    /// 1=warning, 2=urgent, (3/4)=critical — NOT the `dispatch_source`
    /// memory-pressure notification bitmask (1=normal, 2=warn, 4=critical). Urgent
    /// is folded into `Warn` (elevated pressure short of critical) since this axis
    /// carries three levels; both critical encodings are accepted. Any other value
    /// is `Unknown`, so a future/garbage reading never masquerades as `normal`.
    pub fn from_sysctl_level(raw: i32) -> Self {
        match raw {
            0 => Self::Normal,
            1 | 2 => Self::Warn,
            3 | 4 => Self::Critical,
            _ => Self::Unknown,
        }
    }

    /// Severity for retaining the generation PEAK across samples. `Unknown` ranks
    /// below `Normal` so a single readable `normal` is preferred over an unreadable
    /// sample, and `Critical` always wins.
    fn severity(self) -> u8 {
        match self {
            Self::Unknown => 0,
            Self::Normal => 1,
            Self::Warn => 2,
            Self::Critical => 3,
        }
    }

    /// Fold one sample into the retained peak, keeping the more severe level. Pure,
    /// so the supervisor's per-tick peak retention is unit-testable off macOS.
    pub fn peak_with(self, sample: MemoryPressureLevel) -> MemoryPressureLevel {
        if sample.severity() > self.severity() {
            sample
        } else {
            self
        }
    }
}

/// Bind a single candidate JetsamEvent report to this watcher generation. Pure and
/// testable on every platform (the macOS .ips read that produces the inputs lives
/// behind `cfg(macos)` in `commands/process.rs`).
///
/// - `record_ms` is the report's timestamp, or `None` when the reader found no
///   report at all.
/// - `victim_pids` are the PIDs the report names as jetsam victims.
/// - `sampled_pids` is the union of live process ids sampled across the
///   generation's lifetime; `[window_start_ms, window_end_ms]` is that lifetime.
///
/// Precedence: an in-window report naming a sampled PID is `JetsamPidMatched`; an
/// in-window report naming no sampled PID is `JetsamWindowMatched`; anything else
/// (no report, or a report outside the window) does not bind and returns
/// `NoJetsamRecord`. A report outside the window is never reported, so PID reuse
/// or an unrelated jetsam kill on the same machine can never produce a false
/// `jetsam_pid_matched`.
pub fn bind_jetsam_record(
    record_ms: Option<i64>,
    victim_pids: &[u32],
    sampled_pids: &[u32],
    window_start_ms: i64,
    window_end_ms: i64,
) -> WatcherKillProvenance {
    let Some(record_ms) = record_ms else {
        return WatcherKillProvenance::NoJetsamRecord;
    };
    if record_ms < window_start_ms || record_ms > window_end_ms {
        return WatcherKillProvenance::NoJetsamRecord;
    }
    if victim_pids
        .iter()
        .any(|victim| sampled_pids.contains(victim))
    {
        WatcherKillProvenance::JetsamPidMatched
    } else {
        WatcherKillProvenance::JetsamWindowMatched
    }
}

/// When no jetsam report bound, decide the honest non-binding provenance from the
/// generation's live evidence. Warn/critical memory pressure → `PressureOnly` (a
/// pressure kill the OS did not report where we could bind it). Normal pressure
/// with a low peak RSS → `ExternalKillSuspected` (positively not memory-driven).
/// Everything else stays `NoJetsamRecord`, because an ambiguous case must not
/// claim an external kill. Pure and platform-independent.
pub fn resolve_unbound_kill_provenance(
    pressure_peak: MemoryPressureLevel,
    peak_rss_low: bool,
) -> WatcherKillProvenance {
    match pressure_peak {
        MemoryPressureLevel::Warn | MemoryPressureLevel::Critical => {
            WatcherKillProvenance::PressureOnly
        }
        MemoryPressureLevel::Normal if peak_rss_low => WatcherKillProvenance::ExternalKillSuspected,
        _ => WatcherKillProvenance::NoJetsamRecord,
    }
}

/// The content-safe result of attributing a macOS SIGKILL. Every field is a fixed
/// token or a bare bucketed string. `reason`/`rpages_bucket` are `None` (rendered
/// as [`WATCHER_KILL_UNAVAILABLE`]) for every provenance except the two bound
/// states, so absence can never masquerade as evidence.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WatcherKillOutcome {
    pub provenance: WatcherKillProvenance,
    pub reason: Option<JetsamKillReason>,
    pub rpages_bucket: Option<&'static str>,
}

impl WatcherKillOutcome {
    /// An unresolved outcome with the given non-binding provenance: no reason, no
    /// rpages bucket. The one constructor for every non-binding state, so absence
    /// is uniform and a named reason can never leak onto one.
    pub fn unresolved(provenance: WatcherKillProvenance) -> Self {
        debug_assert!(
            !provenance.is_bound(),
            "unresolved kill outcome must not carry a bound provenance"
        );
        Self {
            provenance,
            reason: None,
            rpages_bucket: None,
        }
    }

    /// No macOS kill read applies (non-macOS, or a non-SIGKILL exit).
    pub fn not_applicable() -> Self {
        Self::unresolved(WatcherKillProvenance::NotApplicable)
    }

    /// The read has been deferred and has not resolved yet.
    pub fn deferred() -> Self {
        Self::unresolved(WatcherKillProvenance::Deferred)
    }

    /// A bound jetsam attribution: the binding provenance plus the closed-vocabulary
    /// reason and bucketed rpages of the matched victim.
    pub fn bound(
        provenance: WatcherKillProvenance,
        reason: JetsamKillReason,
        rpages: u64,
    ) -> Self {
        debug_assert!(
            provenance.is_bound(),
            "bound kill outcome requires a bound provenance"
        );
        Self {
            provenance,
            reason: Some(reason),
            rpages_bucket: Some(jetsam_rpages_bucket(rpages)),
        }
    }

    pub fn provenance_token(&self) -> &'static str {
        self.provenance.as_str()
    }

    /// Fixed token for the jetsam kill reason, or [`WATCHER_KILL_UNAVAILABLE`].
    pub fn reason_token(&self) -> &'static str {
        self.reason
            .map(JetsamKillReason::as_str)
            .unwrap_or(WATCHER_KILL_UNAVAILABLE)
    }

    /// Bucketed rpages token, or [`WATCHER_KILL_UNAVAILABLE`].
    pub fn rpages_token(&self) -> &'static str {
        self.rpages_bucket.unwrap_or(WATCHER_KILL_UNAVAILABLE)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // A realistic rendered "Application Error" (Event ID 1000) event for the
    // production fault: a Node runner spawned through the cmd.exe shim aborts
    // with 0xC0000409 inside ntdll.dll. The paths, versions, and product strings
    // in the non-fault slots are exactly what WER writes and exactly what must
    // never leave the process.
    const WER_XML: &str = r#"<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'>
  <System>
    <Provider Name='Application Error'/>
    <EventID Qualifiers='0'>1000</EventID>
    <Level>2</Level>
    <TimeCreated SystemTime='2026-08-11T10:37:41.1234567Z'/>
    <Channel>Application</Channel>
    <Computer>SHTAIGA</Computer>
  </System>
  <EventData>
    <Data>node.exe</Data>
    <Data>22.5.1.0</Data>
    <Data>66b8c1a2</Data>
    <Data>ntdll.dll</Data>
    <Data>10.0.22621.4111</Data>
    <Data>abcd1234</Data>
    <Data>c0000409</Data>
    <Data>000000000002a1b3</Data>
    <Data>1a2c</Data>
    <Data>01dABCDEF0123456</Data>
    <Data>C:\Users\Ada\AppData\Local\HQ\node.exe</Data>
    <Data>C:\Windows\SYSTEM32\ntdll.dll</Data>
    <Data>c0ffee00-dead-beef-0000-000000000000</Data>
  </EventData>
</Event>"#;

    #[test]
    fn classify_watcher_fault_binary_maps_allow_list_case_insensitively_by_basename() {
        for (name, expected) in [
            ("node.exe", WatcherFaultBinary::NodeExe),
            (r"C:\Users\Ada\AppData\Local\HQ\node.exe", WatcherFaultBinary::NodeExe),
            ("NPX.CMD", WatcherFaultBinary::NpxCmd),
            ("cmd.exe", WatcherFaultBinary::CmdExe),
            ("hq-sync-menubar.exe", WatcherFaultBinary::HqSyncMenubarExe),
            (r"C:\Windows\SYSTEM32\ntdll.dll", WatcherFaultBinary::NtdllDll),
            ("KernelBase.dll", WatcherFaultBinary::KernelbaseDll),
            ("ucrtbase.dll", WatcherFaultBinary::UcrtbaseDll),
            ("msvcrt.dll", WatcherFaultBinary::MsvcrtDll),
            ("some-private-tool.exe", WatcherFaultBinary::Other),
            ("", WatcherFaultBinary::Other),
        ] {
            assert_eq!(classify_watcher_fault_binary(name), expected, "name: {name:?}");
        }
    }

    #[test]
    fn classify_watcher_fault_binary_never_emits_input_bytes() {
        // A secret-ish, never-allow-listed name must render only `other`.
        let token = classify_watcher_fault_binary(
            r"C:\Users\cognito-token-abc123\private-key-loader.exe",
        )
        .as_str();
        assert_eq!(token, "other");
        assert!(!token.contains("cognito") && !token.contains("abc123") && !token.contains("private"));
    }

    #[test]
    fn parse_application_error_event_extracts_only_content_safe_fields() {
        let record = parse_application_error_event(WER_XML).expect("valid WER 1000 event parses");
        assert_eq!(record.image, WatcherFaultBinary::NodeExe);
        assert_eq!(record.module, WatcherFaultBinary::NtdllDll);
        assert_eq!(record.exception_code, Some(0xC000_0409));
        assert_eq!(record.fault_offset, Some(0x2a1b3));
        assert_eq!(record.faulting_pid, Some(0x1a2c));
        // Compared against chrono's own parse of the same instant so the test is
        // not coupled to a hand-computed epoch; millis truncate the 100ns tail.
        let expected_ms = chrono::DateTime::parse_from_rfc3339("2026-08-11T10:37:41.1234567Z")
            .unwrap()
            .timestamp_millis();
        assert_eq!(record.event_time_unix_ms, Some(expected_ms));
        assert_eq!(expected_ms % 1000, 123);
    }

    #[test]
    fn parse_application_error_event_rejects_non_matching_events() {
        // Wrong provider.
        assert!(parse_application_error_event(
            &WER_XML.replace("Application Error", "Some Other Provider")
        )
        .is_none());
        // Wrong event id.
        assert!(parse_application_error_event(&WER_XML.replace(">1000<", ">4321<")).is_none());
        // Not an event at all.
        assert!(parse_application_error_event("not xml").is_none());
    }

    #[test]
    fn attribute_prefers_pid_match_then_window_then_resolved_rejection() {
        let base = WerApplicationError {
            image: WatcherFaultBinary::NodeExe,
            module: WatcherFaultBinary::NtdllDll,
            exception_code: Some(0xC000_0409),
            fault_offset: Some(0x2a1b3),
            faulting_pid: Some(6700),
            event_time_unix_ms: Some(1_000_500),
        };
        let window = (1_000_000_i64, 1_001_000_i64);

        // PID in the sampled set + in window → pid_matched, fields populated.
        let outcome = attribute_watcher_fault(&[base], &[6700], window.0, window.1, Some(0xC000_0409));
        assert_eq!(outcome.provenance, WatcherFaultProvenance::PidMatched);
        assert_eq!(outcome.image_token(), "node_exe");
        assert_eq!(outcome.module_token(), "ntdll_dll");
        assert_eq!(outcome.exception_code, Some(0xC000_0409));
        assert_eq!(outcome.counters.records_parsed, 1);

        // Same record, PID NOT sampled → downgrades to window_only, still named.
        let outcome = attribute_watcher_fault(&[base], &[42], window.0, window.1, Some(0xC000_0409));
        assert_eq!(outcome.provenance, WatcherFaultProvenance::WindowOnly);
        assert_eq!(outcome.image_token(), "node_exe");

        // Record timestamped OUTSIDE the window → rejected_out_of_window, unnamed,
        // with the rejection counted — no longer the ambiguous `no_record`.
        let stale = WerApplicationError {
            event_time_unix_ms: Some(999_000),
            ..base
        };
        let outcome = attribute_watcher_fault(&[stale], &[6700], window.0, window.1, Some(0xC000_0409));
        assert_eq!(outcome.provenance, WatcherFaultProvenance::RejectedOutOfWindow);
        assert_eq!(outcome.image_token(), WATCHER_FAULT_UNAVAILABLE);
        assert_eq!(outcome.module_token(), WATCHER_FAULT_UNAVAILABLE);
        assert_eq!(outcome.exception_code, None);
        assert_eq!(outcome.counters.records_parsed, 1);
        assert_eq!(outcome.counters.rejected_out_of_window, 1);
        assert_eq!(outcome.counters.rejected_code_mismatch, 0);

        // No records at all → no_records (distinct from the all-rejected case),
        // and never a named image.
        let empty = attribute_watcher_fault(&[], &[6700], window.0, window.1, None);
        assert_eq!(empty.provenance, WatcherFaultProvenance::NoRecords);
        assert_eq!(empty.image_token(), WATCHER_FAULT_UNAVAILABLE);
        assert_eq!(empty.counters.records_parsed, 0);
    }

    #[test]
    fn zero_records_and_all_rejected_are_distinct_tokens() {
        // The exact honesty gap the prior fix had: with zero records and with
        // records that all fall outside the window, base emitted the SAME
        // `no_record`. The resolved vocabulary must separate them.
        let window = (1_000_000_i64, 1_001_000_i64);
        let out_of_window = WerApplicationError {
            image: WatcherFaultBinary::NodeExe,
            module: WatcherFaultBinary::NtdllDll,
            exception_code: Some(0xC000_0409),
            fault_offset: None,
            faulting_pid: Some(6700),
            event_time_unix_ms: Some(500_000),
        };
        let zero = attribute_watcher_fault(&[], &[6700], window.0, window.1, Some(0xC000_0409));
        let rejected =
            attribute_watcher_fault(&[out_of_window], &[6700], window.0, window.1, Some(0xC000_0409));
        assert_eq!(zero.provenance, WatcherFaultProvenance::NoRecords);
        assert_eq!(rejected.provenance, WatcherFaultProvenance::RejectedOutOfWindow);
        assert_ne!(zero.provenance_token(), rejected.provenance_token());
        // Neither ever names an image.
        assert_eq!(zero.image_token(), WATCHER_FAULT_UNAVAILABLE);
        assert_eq!(rejected.image_token(), WATCHER_FAULT_UNAVAILABLE);
    }

    #[test]
    fn attribute_binds_the_newest_matching_record_not_a_stale_earlier_one() {
        // Records arrive newest-first (the reader queries reverse-direction), and
        // the attributor must bind the terminal (newest) fault rather than a stale
        // earlier one that shares the PID and code — the property the caller's
        // narrowed terminal-lookback window relies on.
        let newest = WerApplicationError {
            image: WatcherFaultBinary::NodeExe,
            module: WatcherFaultBinary::NtdllDll,
            exception_code: Some(0xC000_0409),
            fault_offset: Some(0xBEEF),
            faulting_pid: Some(6700),
            event_time_unix_ms: Some(1_000_900),
        };
        let older = WerApplicationError {
            fault_offset: Some(0x1111),
            event_time_unix_ms: Some(1_000_100),
            ..newest
        };
        let outcome =
            attribute_watcher_fault(&[newest, older], &[6700], 1_000_000, 1_001_000, Some(0xC000_0409));
        assert_eq!(outcome.provenance, WatcherFaultProvenance::PidMatched);
        assert_eq!(outcome.fault_offset, Some(0xBEEF), "the newest record must win");
    }

    #[test]
    fn attribute_rejects_in_window_record_for_a_different_fault_code() {
        let other_fault = WerApplicationError {
            image: WatcherFaultBinary::NodeExe,
            module: WatcherFaultBinary::NtdllDll,
            exception_code: Some(0xC000_0005), // ACCESS_VIOLATION, not our abort
            fault_offset: None,
            faulting_pid: Some(6700),
            event_time_unix_ms: Some(1_000_500),
        };
        // Even with the PID sampled and in-window, a mismatched code is not our
        // fault → the specific rejected_code_mismatch token (counted) rather than
        // a confident wrong attribution or the ambiguous old `no_record`.
        let outcome =
            attribute_watcher_fault(&[other_fault], &[6700], 1_000_000, 1_001_000, Some(0xC000_0409));
        assert_eq!(outcome.provenance, WatcherFaultProvenance::RejectedCodeMismatch);
        assert_eq!(outcome.counters.rejected_code_mismatch, 1);
        assert_eq!(outcome.counters.rejected_out_of_window, 0);
        assert_eq!(outcome.image_token(), WATCHER_FAULT_UNAVAILABLE);
    }

    #[test]
    fn resolved_non_binding_states_are_distinct_and_never_named() {
        // The reader-only and exit-path states each render a distinct token and
        // never a named image — absence never masquerades as evidence.
        for outcome in [
            WatcherFaultOutcome::not_applicable(),
            WatcherFaultOutcome::deferred(),
            WatcherFaultOutcome::unresolved(WatcherFaultProvenance::QueryUnreadable),
            WatcherFaultOutcome::unresolved(WatcherFaultProvenance::RejectedUnparsable),
            WatcherFaultOutcome::unresolved(WatcherFaultProvenance::DeadlineExpired),
        ] {
            assert_eq!(outcome.image_token(), WATCHER_FAULT_UNAVAILABLE);
            assert_eq!(outcome.module_token(), WATCHER_FAULT_UNAVAILABLE);
            assert_eq!(outcome.exception_code, None);
            assert!(!outcome.provenance.is_bound());
        }
        // Every resolved token is unique, so a second failure is self-diagnosing.
        let tokens: Vec<&str> = WatcherFaultProvenance::ALL
            .iter()
            .map(|p| p.as_str())
            .collect();
        let mut deduped = tokens.clone();
        deduped.sort_unstable();
        deduped.dedup();
        assert_eq!(deduped.len(), tokens.len(), "provenance tokens must be unique");
        // The exhaustive set separates every cause the prior two tokens merged.
        for expected in [
            "pid_matched",
            "window_only",
            "query_unreadable",
            "no_records",
            "rejected_out_of_window",
            "rejected_code_mismatch",
            "rejected_unparsable",
            "deadline_expired",
            "deferred",
            "not_applicable",
        ] {
            assert!(tokens.contains(&expected), "missing resolved token {expected:?}");
        }
    }

    #[test]
    fn read_counters_render_a_bounded_fixed_vocabulary_tag() {
        let counters = WatcherFaultReadCounters {
            records_seen: 3,
            records_parsed: 2,
            rejected_out_of_window: 2,
            rejected_code_mismatch: 0,
            sweeps: 5,
            ms_to_verdict: 8123,
        };
        assert_eq!(
            counters.tag_value(),
            "seen:3,parsed:2,rej_win:2,rej_code:0,sweeps:5,ms:8123"
        );
        // Always renders, even all-zero, so `seen:0` is an assertable fact.
        assert_eq!(
            WatcherFaultReadCounters::default().tag_value(),
            "seen:0,parsed:0,rej_win:0,rej_code:0,sweeps:0,ms:0"
        );
        // Bounded and denylist-free: no counter renderer can emit an input byte.
        assert!(counters.tag_value().len() <= 128);
        assert!(counters.tag_value().bytes().all(|b| b.is_ascii_lowercase()
            || b.is_ascii_digit()
            || b == b':'
            || b == b','
            || b == b'_'));
    }

    #[test]
    fn job_image_descriptor_maps_allow_list_and_names_a_non_shim_candidate() {
        let mut descriptor = WatcherJobImageDescriptor::default();
        // Sample the seven-process cmd.exe-shimmed watcher tree while alive.
        for image in [
            classify_watcher_fault_binary(r"C:\Windows\System32\cmd.exe"),
            classify_watcher_fault_binary(r"C:\Users\Ada\AppData\Local\HQ\node.exe"),
            classify_watcher_fault_binary(r"C:\Program Files\nodejs\npx.cmd"),
        ] {
            descriptor.record(image);
        }
        // Bounded, deduped, fixed-order set tag; never a path or raw name.
        assert_eq!(descriptor.images_tag().as_deref(), Some("node_exe,npx_cmd,cmd_exe"));
        // The shim/dispatch layer is never the culprit candidate — the runner is.
        assert_eq!(descriptor.culprit_candidate(), Some(WatcherFaultBinary::NodeExe));
        assert_eq!(descriptor.culprit_candidate_token(), "node_exe");
        // Its own honesty token marks it a tree observation, NOT an attribution.
        assert_eq!(descriptor.provenance_token(), "job_tree_observed");

        // A shim-only tree yields no culprit candidate (only dispatch was seen).
        let mut shim_only = WatcherJobImageDescriptor::default();
        shim_only.record(WatcherFaultBinary::CmdExe);
        assert_eq!(shim_only.culprit_candidate(), None);
        assert_eq!(shim_only.culprit_candidate_token(), WATCHER_FAULT_UNAVAILABLE);
        assert_eq!(shim_only.provenance_token(), "job_tree_observed");

        // Nothing observed → no tag, unavailable sentinel, never a named image.
        let empty = WatcherJobImageDescriptor::default();
        assert_eq!(empty.images_tag(), None);
        assert_eq!(empty.culprit_candidate_token(), WATCHER_FAULT_UNAVAILABLE);
        assert_eq!(empty.provenance_token(), WATCHER_FAULT_UNAVAILABLE);

        // A never-allow-listed image folds to `other`, never its bytes.
        let mut unknown = WatcherJobImageDescriptor::default();
        unknown.record(classify_watcher_fault_binary(
            r"C:\Users\cognito-token-abc123\private-loader.exe",
        ));
        assert_eq!(unknown.images_tag().as_deref(), Some("other"));
        assert_eq!(unknown.culprit_candidate_token(), "other");
        let tag = unknown.images_tag().unwrap();
        assert!(!tag.contains("cognito") && !tag.contains("abc123") && !tag.contains("private"));
    }

    #[test]
    fn record_optional_omits_unresolved_images_so_absence_is_never_a_candidate() {
        // A failed image lookup (`None`) must contribute NOTHING: no set entry, no
        // culprit candidate, no `job_tree_observed` label — absence never
        // masquerades as an `other` observation.
        let mut descriptor = WatcherJobImageDescriptor::default();
        descriptor.record_optional(None);
        descriptor.record_optional(None);
        assert_eq!(descriptor.images_tag(), None);
        assert_eq!(descriptor.culprit_candidate(), None);
        assert_eq!(descriptor.culprit_candidate_token(), WATCHER_FAULT_UNAVAILABLE);
        assert_eq!(descriptor.provenance_token(), WATCHER_FAULT_UNAVAILABLE);

        // A resolved reading records normally; a later `None` (a post-death sample
        // that could not resolve) does not wipe the real observation.
        descriptor.record_optional(Some(WatcherFaultBinary::NodeExe));
        descriptor.record_optional(None);
        assert_eq!(descriptor.images_tag().as_deref(), Some("node_exe"));
        assert_eq!(descriptor.culprit_candidate(), Some(WatcherFaultBinary::NodeExe));
    }

    #[test]
    fn more_specific_image_never_downgrades_a_real_reading() {
        use WatcherFaultBinary::{NodeExe, Other};
        // Rank: None < Some(Other) < Some(<named>). A better reading is adopted;
        // a worse or absent one never displaces a real live-tree observation.
        assert_eq!(more_specific_image(None, None), None);
        assert_eq!(more_specific_image(None, Some(Other)), Some(Other));
        assert_eq!(more_specific_image(None, Some(NodeExe)), Some(NodeExe));
        assert_eq!(more_specific_image(Some(Other), None), Some(Other));
        assert_eq!(more_specific_image(Some(NodeExe), None), Some(NodeExe));
        assert_eq!(more_specific_image(Some(Other), Some(NodeExe)), Some(NodeExe));
        // Never downgrade a recognised reading to `other` or to absent.
        assert_eq!(more_specific_image(Some(NodeExe), Some(Other)), Some(NodeExe));
        // A tie between two recognised images keeps the current one (stable).
        assert_eq!(
            more_specific_image(Some(NodeExe), Some(WatcherFaultBinary::CmdExe)),
            Some(NodeExe)
        );
    }

    #[test]
    fn stronger_rejection_retains_the_most_actionable_reason_across_sweeps() {
        // Specificity ordering: code mismatch > unparsable > out-of-window; every
        // binding/empty state is 0.
        assert!(
            WatcherFaultProvenance::RejectedCodeMismatch.rejection_specificity()
                > WatcherFaultProvenance::RejectedUnparsable.rejection_specificity()
        );
        assert!(
            WatcherFaultProvenance::RejectedUnparsable.rejection_specificity()
                > WatcherFaultProvenance::RejectedOutOfWindow.rejection_specificity()
        );
        assert_eq!(WatcherFaultProvenance::PidMatched.rejection_specificity(), 0);
        assert_eq!(WatcherFaultProvenance::NoRecords.rejection_specificity(), 0);

        let code_mismatch = WatcherFaultOutcome::unresolved(
            WatcherFaultProvenance::RejectedCodeMismatch,
        )
        .with_counters(WatcherFaultReadCounters {
            rejected_code_mismatch: 1,
            ..Default::default()
        });
        let out_of_window = WatcherFaultOutcome::unresolved(
            WatcherFaultProvenance::RejectedOutOfWindow,
        )
        .with_counters(WatcherFaultReadCounters {
            rejected_out_of_window: 5,
            ..Default::default()
        });
        // Order-independent: the code mismatch is retained whichever sweep saw it,
        // even though the out-of-window sweep carries more rejected records.
        assert_eq!(
            code_mismatch.stronger_rejection(out_of_window).provenance,
            WatcherFaultProvenance::RejectedCodeMismatch
        );
        assert_eq!(
            out_of_window.stronger_rejection(code_mismatch).provenance,
            WatcherFaultProvenance::RejectedCodeMismatch
        );

        // On equal specificity, the outcome with more rejected-record evidence wins.
        let sparse = WatcherFaultOutcome::unresolved(WatcherFaultProvenance::RejectedOutOfWindow)
            .with_counters(WatcherFaultReadCounters {
                rejected_out_of_window: 1,
                ..Default::default()
            });
        assert_eq!(sparse.stronger_rejection(out_of_window).counters.rejected_out_of_window, 5);
        assert_eq!(out_of_window.stronger_rejection(sparse).counters.rejected_out_of_window, 5);

        // total_rejected sums both reasons, saturating.
        let both = WatcherFaultReadCounters {
            rejected_out_of_window: 3,
            rejected_code_mismatch: 4,
            ..Default::default()
        };
        assert_eq!(both.total_rejected(), 7);
    }

    #[test]
    fn classify_unmatched_stderr_shape_reads_structure_not_content() {
        for (line, expected) in [
            (r#"{"type":"error","path":"knowledge/a.md","message":"boom"}"#, UnmatchedStderrShape::NdjsonRecord),
            ("at Object.<anonymous> (C:/x/y.js:1:1)", UnmatchedStderrShape::StackFrame),
            ("#12 0x00007ff6 node::Abort", UnmatchedStderrShape::HashFrame),
            ("Error: something went wrong", UnmatchedStderrShape::KeyColon),
            (r"C:\Users\Ada\secret\file.txt not found", UnmatchedStderrShape::PathLike),
            ("/var/log/private/thing/here", UnmatchedStderrShape::PathLike),
            ("   ", UnmatchedStderrShape::Blank),
            ("SIGSEGV", UnmatchedStderrShape::Word),
            ("just some prose without a colon token", UnmatchedStderrShape::Other),
        ] {
            assert_eq!(classify_unmatched_stderr_shape(line), expected, "line: {line:?}");
        }
    }

    #[test]
    fn unmatched_rollup_skips_recognised_lines_and_renders_top_three() {
        let mut rollup = UnmatchedStderrShapeRollup::default();
        // A recognised libuv-fatal line must NOT be counted here.
        rollup.record_if_unmatched("ReadDirectoryChangesW: (5) Access is denied.");
        assert_eq!(rollup.tag_value(), None, "a classified line must not enter the rollup");

        for _ in 0..6 {
            rollup.record_if_unmatched(r#"{"type":"error","path":"k/a.md","message":"x"}"#);
        }
        for _ in 0..2 {
            rollup.record_if_unmatched("at Object.<anonymous> (C:/x/y.js:1:1)");
        }
        rollup.record_if_unmatched("SIGSEGV");
        let value = rollup.tag_value().expect("nonzero rollup renders a tag");
        assert_eq!(value, "ndjson_record:6,stack_frame:2,word:1");
        assert!(value.split(',').count() <= ROLLUP_TAG_TOP_N);
    }

    #[test]
    fn unmatched_rollup_never_leaks_the_line() {
        let mut rollup = UnmatchedStderrShapeRollup::default();
        rollup.record_if_unmatched(r"C:\Users\cognito-token-abc123\leak.txt is bad");
        let value = rollup.tag_value().expect("nonzero rollup renders a tag");
        assert_eq!(value, "path_like:1");
        assert!(!value.contains("cognito") && !value.contains("abc123") && !value.contains("Users"));
    }

    #[test]
    fn every_emitted_token_is_denylist_free() {
        // No token any of these axes can emit may contain a Sentry default-scrubber
        // denylist substring, or the server-side @password:filter would silently
        // delete the very attribution this module exists to add.
        const DENYLIST: &[&str] = &[
            "auth", "token", "secret", "password", "passwd", "credential", "api_key", "apikey",
            "session", "private_key", "privatekey",
        ];
        let binary = WatcherFaultBinary::ALL.map(WatcherFaultBinary::as_str);
        let provenance = WatcherFaultProvenance::ALL.map(WatcherFaultProvenance::as_str);
        let shapes = UnmatchedStderrShape::ALL.map(UnmatchedStderrShape::as_str);
        // macOS kill-attribution axes (HQ-DESKTOP-4D) ride the SAME content-safety
        // proof: every provenance, kill-reason, pressure level, and rpages bucket
        // must be a bare denylist-free token or the @password:filter deletes it.
        let kill_provenance = WatcherKillProvenance::ALL.map(WatcherKillProvenance::as_str);
        let kill_reason = JetsamKillReason::ALL.map(JetsamKillReason::as_str);
        let pressure = MemoryPressureLevel::ALL.map(MemoryPressureLevel::as_str);
        let rpages = [
            jetsam_rpages_bucket(0),
            jetsam_rpages_bucket(10_000),
            jetsam_rpages_bucket(100_000),
            jetsam_rpages_bucket(500_000),
            jetsam_rpages_bucket(1_000_000),
        ];
        for token in binary
            .into_iter()
            .chain(provenance)
            .chain(shapes)
            .chain(kill_provenance)
            .chain(kill_reason)
            .chain(pressure)
            .chain(rpages)
            .chain(std::iter::once(WATCHER_FAULT_UNAVAILABLE))
            .chain(std::iter::once(WATCHER_JOB_IMAGE_OBSERVED))
            .chain(std::iter::once(WATCHER_KILL_UNAVAILABLE))
        {
            assert!(!token.is_empty() && token.len() <= 64);
            assert!(
                token.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_'),
                "token {token:?} is not a bare lowercase identifier"
            );
            for denied in DENYLIST {
                assert!(!token.contains(denied), "token {token:?} contains denylist substring {denied:?}");
            }
        }
    }

    // ── macOS SIGKILL / jetsam kill provenance (HQ-DESKTOP-4D) ──────────────────

    const GEN_START: i64 = 1_000_000;
    const GEN_END: i64 = 1_060_000; // a 60s generation window

    #[test]
    fn bind_jetsam_record_pid_match_is_strongest() {
        // In-window report naming a sampled PID → the strongest binding.
        assert_eq!(
            bind_jetsam_record(Some(1_030_000), &[4242], &[1, 4242, 7], GEN_START, GEN_END),
            WatcherKillProvenance::JetsamPidMatched
        );
    }

    #[test]
    fn bind_jetsam_record_in_window_without_pid_is_window_only() {
        // In-window report, but none of its victims are in the sampled set.
        assert_eq!(
            bind_jetsam_record(Some(1_030_000), &[9999], &[1, 4242, 7], GEN_START, GEN_END),
            WatcherKillProvenance::JetsamWindowMatched
        );
    }

    #[test]
    fn bind_jetsam_record_out_of_window_and_absent_both_do_not_bind() {
        // A report before the window, a report after it, and no report at all all
        // fail to bind — never a false attribution from PID reuse or a stale crash.
        assert_eq!(
            bind_jetsam_record(Some(GEN_START - 1), &[4242], &[4242], GEN_START, GEN_END),
            WatcherKillProvenance::NoJetsamRecord
        );
        assert_eq!(
            bind_jetsam_record(Some(GEN_END + 1), &[4242], &[4242], GEN_START, GEN_END),
            WatcherKillProvenance::NoJetsamRecord
        );
        assert_eq!(
            bind_jetsam_record(None, &[4242], &[4242], GEN_START, GEN_END),
            WatcherKillProvenance::NoJetsamRecord
        );
    }

    #[test]
    fn bind_jetsam_record_boundaries_are_inclusive() {
        assert_eq!(
            bind_jetsam_record(Some(GEN_START), &[4242], &[4242], GEN_START, GEN_END),
            WatcherKillProvenance::JetsamPidMatched
        );
        assert_eq!(
            bind_jetsam_record(Some(GEN_END), &[4242], &[4242], GEN_START, GEN_END),
            WatcherKillProvenance::JetsamPidMatched
        );
    }

    #[test]
    fn resolve_unbound_kill_provenance_separates_pressure_from_external() {
        // Warn/critical pressure → a pressure kill is plausible.
        assert_eq!(
            resolve_unbound_kill_provenance(MemoryPressureLevel::Warn, false),
            WatcherKillProvenance::PressureOnly
        );
        assert_eq!(
            resolve_unbound_kill_provenance(MemoryPressureLevel::Critical, true),
            WatcherKillProvenance::PressureOnly
        );
        // Normal pressure + low peak RSS → positively an external kill.
        assert_eq!(
            resolve_unbound_kill_provenance(MemoryPressureLevel::Normal, true),
            WatcherKillProvenance::ExternalKillSuspected
        );
        // Normal pressure but a HIGH peak RSS is ambiguous — must not claim external.
        assert_eq!(
            resolve_unbound_kill_provenance(MemoryPressureLevel::Normal, false),
            WatcherKillProvenance::NoJetsamRecord
        );
        // Unknown pressure can never assert an external kill.
        assert_eq!(
            resolve_unbound_kill_provenance(MemoryPressureLevel::Unknown, true),
            WatcherKillProvenance::NoJetsamRecord
        );
    }

    #[test]
    fn classify_jetsam_kill_reason_maps_allow_list_and_falls_back_to_other() {
        assert_eq!(
            classify_jetsam_kill_reason("per-process-limit"),
            JetsamKillReason::PerProcessLimit
        );
        assert_eq!(
            classify_jetsam_kill_reason("  Per-Process-Limit "),
            JetsamKillReason::PerProcessLimit
        );
        assert_eq!(classify_jetsam_kill_reason("highwater"), JetsamKillReason::Highwater);
        assert_eq!(
            classify_jetsam_kill_reason("vm-pageshortage"),
            JetsamKillReason::VmPageshortage
        );
        assert_eq!(
            classify_jetsam_kill_reason("vm_thrashing"),
            JetsamKillReason::VmThrashing
        );
        // Anything else — including a name-bearing string — collapses to `other`,
        // never a nearest guess and never copied through.
        assert_eq!(
            classify_jetsam_kill_reason("idle-exit /Users/someone/secret"),
            JetsamKillReason::Other
        );
    }

    #[test]
    fn jetsam_rpages_bucket_boundaries_are_monotonic() {
        assert_eq!(jetsam_rpages_bucket(0), "under_10k");
        assert_eq!(jetsam_rpages_bucket(9_999), "under_10k");
        assert_eq!(jetsam_rpages_bucket(10_000), "10k_to_100k");
        assert_eq!(jetsam_rpages_bucket(99_999), "10k_to_100k");
        assert_eq!(jetsam_rpages_bucket(100_000), "100k_to_500k");
        assert_eq!(jetsam_rpages_bucket(499_999), "100k_to_500k");
        assert_eq!(jetsam_rpages_bucket(500_000), "500k_to_1m");
        assert_eq!(jetsam_rpages_bucket(999_999), "500k_to_1m");
        assert_eq!(jetsam_rpages_bucket(1_000_000), "over_1m");
    }

    #[test]
    fn memory_pressure_level_maps_sysctl_and_retains_peak() {
        // Darwin vm_pressure_level_t: 0=normal, 1=warning, 2=urgent, 3/4=critical.
        assert_eq!(MemoryPressureLevel::from_sysctl_level(0), MemoryPressureLevel::Normal);
        assert_eq!(MemoryPressureLevel::from_sysctl_level(1), MemoryPressureLevel::Warn);
        assert_eq!(MemoryPressureLevel::from_sysctl_level(2), MemoryPressureLevel::Warn);
        assert_eq!(MemoryPressureLevel::from_sysctl_level(3), MemoryPressureLevel::Critical);
        assert_eq!(MemoryPressureLevel::from_sysctl_level(4), MemoryPressureLevel::Critical);
        // A garbage/future value never masquerades as normal.
        assert_eq!(MemoryPressureLevel::from_sysctl_level(9), MemoryPressureLevel::Unknown);
        assert_eq!(MemoryPressureLevel::from_sysctl_level(-1), MemoryPressureLevel::Unknown);
        // Peak retention keeps the most severe, and prefers a readable normal over
        // an unreadable unknown.
        assert_eq!(
            MemoryPressureLevel::Normal.peak_with(MemoryPressureLevel::Critical),
            MemoryPressureLevel::Critical
        );
        assert_eq!(
            MemoryPressureLevel::Critical.peak_with(MemoryPressureLevel::Warn),
            MemoryPressureLevel::Critical
        );
        assert_eq!(
            MemoryPressureLevel::Unknown.peak_with(MemoryPressureLevel::Normal),
            MemoryPressureLevel::Normal
        );
    }

    #[test]
    fn kill_provenance_and_reason_tokens_round_trip_without_gaps() {
        // Every variant has a distinct, non-empty as_str, and ALL enumerates them.
        let mut seen = std::collections::HashSet::new();
        for provenance in WatcherKillProvenance::ALL {
            assert!(seen.insert(provenance.as_str()), "duplicate provenance token");
        }
        assert_eq!(seen.len(), WatcherKillProvenance::ALL.len());
        let mut reasons = std::collections::HashSet::new();
        for reason in JetsamKillReason::ALL {
            assert!(reasons.insert(reason.as_str()), "duplicate reason token");
        }
        assert_eq!(reasons.len(), JetsamKillReason::ALL.len());
    }

    #[test]
    fn kill_outcome_bound_carries_reason_and_bucket_unbound_carries_sentinels() {
        let bound = WatcherKillOutcome::bound(
            WatcherKillProvenance::JetsamPidMatched,
            JetsamKillReason::PerProcessLimit,
            27_000,
        );
        assert_eq!(bound.provenance_token(), "jetsam_pid_matched");
        assert_eq!(bound.reason_token(), "per_process_limit");
        assert_eq!(bound.rpages_token(), "10k_to_100k");

        // Every non-binding outcome renders the sentinels, never a stale reason.
        for provenance in WatcherKillProvenance::ALL
            .into_iter()
            .filter(|p| !p.is_bound())
        {
            let outcome = WatcherKillOutcome::unresolved(provenance);
            assert_eq!(outcome.reason_token(), WATCHER_KILL_UNAVAILABLE);
            assert_eq!(outcome.rpages_token(), WATCHER_KILL_UNAVAILABLE);
            assert_eq!(outcome.provenance_token(), provenance.as_str());
        }
        assert_eq!(
            WatcherKillOutcome::not_applicable().provenance_token(),
            "not_applicable"
        );
        assert_eq!(WatcherKillOutcome::deferred().provenance_token(), "deferred");
    }
}
