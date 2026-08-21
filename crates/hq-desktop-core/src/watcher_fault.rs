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

    /// This variant's stable position in [`Self::ALL`], for compact bookkeeping
    /// in the job-image rollup. Kept in lockstep with `ALL` by
    /// `binary_index_round_trips_all` so a reordering cannot silently mis-index.
    pub fn index(self) -> usize {
        match self {
            Self::NodeExe => 0,
            Self::NpxCmd => 1,
            Self::CmdExe => 2,
            Self::HqSyncMenubarExe => 3,
            Self::NtdllDll => 4,
            Self::KernelbaseDll => 5,
            Self::UcrtbaseDll => 6,
            Self::MsvcrtDll => 7,
            Self::Other => 8,
        }
    }

    /// True for the batch-shim interpreters the runner is dispatched through
    /// (`cmd.exe`, `npx.cmd`) and for the app's own binary. None of these is the
    /// runner whose crash we are trying to name, so the last observed NON-shim
    /// image is the culprit candidate the job-image descriptor surfaces.
    pub fn is_shim_or_self(self) -> bool {
        matches!(self, Self::CmdExe | Self::NpxCmd | Self::HqSyncMenubarExe)
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

// ─────────────────────────────────────────────────────────────────────────────
// Provenance honesty token
// ─────────────────────────────────────────────────────────────────────────────

/// How confidently a read WER record is bound to *this* watcher generation, and
/// — when nothing bound — exactly WHY. HQ-DESKTOP-4X reopened because the prior
/// fix collapsed three distinct failure states (WER wrote nothing, WER wrote
/// records that failed window/code binding, WER had not published yet when the
/// budget expired) into the single `no_record` token, so the field data could
/// not say which one occurred. This resolved, mutually-exclusive vocabulary
/// separates every one of them, so the very next occurrence is actionable
/// instead of ambiguous. Only `PidMatched`/`WindowOnly` are attributions; every
/// other value is an honest "no attribution, and here is the reason", and none
/// of them may ever render a named image.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WatcherFaultProvenance {
    /// The record's faulting PID is a member of the generation's sampled Job
    /// Object process set AND its timestamp falls inside the generation lifetime.
    PidMatched,
    /// The record's timestamp falls inside the generation lifetime (and matches
    /// the observed exception code), but its PID is not in the sampled set — a
    /// weaker, coincidence-possible binding.
    WindowOnly,
    /// In-window record(s) existed but every one carried a DIFFERENT exception
    /// code than the abort this exit observed — a real crash, but not this one.
    RejectedCodeMismatch,
    /// Parsed record(s) existed but every one fell OUTSIDE the generation window
    /// (a stale earlier crash, or a coincidental unrelated one).
    RejectedOutOfWindow,
    /// Record(s) were present but none carried a bindable timestamp, so none
    /// could be time-bound to this generation at all.
    RejectedUnparsable,
    /// The query ran and the Application log yielded ZERO Application Error 1000
    /// records at all — WER wrote nothing (yet). Distinct from a deadline that
    /// expired on the deferred read (`DeadlineExpired`).
    NoRecords,
    /// The deferred read exhausted its whole bounded horizon and WER still never
    /// published any record — the actionable "we waited and it never came"
    /// signal that a blind 4s retry could never distinguish from `no_records`.
    DeadlineExpired,
    /// The query could not run (disabled/unreadable WER, or an `EvtQuery` that
    /// never opened the log). Absence of a reader, not absence of a fault.
    Unavailable,
    /// No read was warranted at all: a non-Windows exit, or a non-fault exit, so
    /// a macOS/Linux exit stops masquerading as a failed Windows read.
    NotApplicable,
}

impl WatcherFaultProvenance {
    pub const ALL: [WatcherFaultProvenance; 9] = [
        Self::PidMatched,
        Self::WindowOnly,
        Self::RejectedCodeMismatch,
        Self::RejectedOutOfWindow,
        Self::RejectedUnparsable,
        Self::NoRecords,
        Self::DeadlineExpired,
        Self::Unavailable,
        Self::NotApplicable,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::PidMatched => "pid_matched",
            Self::WindowOnly => "window_only",
            Self::RejectedCodeMismatch => "rejected_code_mismatch",
            Self::RejectedOutOfWindow => "rejected_out_of_window",
            Self::RejectedUnparsable => "rejected_unparsable",
            Self::NoRecords => "no_records",
            Self::DeadlineExpired => "deadline_expired",
            Self::Unavailable => "unavailable",
            Self::NotApplicable => "not_applicable",
        }
    }

    /// True only for the two provenances that actually name a faulting image.
    /// The deferred read loop polls until one of these is reached or its horizon
    /// expires; the egress layer relies on it to keep an unresolved read unnamed.
    pub fn is_attribution(self) -> bool {
        matches!(self, Self::PidMatched | Self::WindowOnly)
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

/// Bounded, saturating per-read counters that make a SECOND attribution failure
/// actionable instead of another blind `no_record`. Every field is a fixed
/// integer that renders as a bare number — never an input byte. The pure
/// attribution fills the parse/rejection tallies; the Win32 read loop stamps the
/// runtime counters it alone owns (`records_seen`, `sweeps`, `ms_to_verdict`)
/// via [`WatcherFaultOutcome::with_runtime_counters`].
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct WatcherFaultCounters {
    /// Raw Application Error 1000 XML fragments the query returned (caller-owned).
    pub records_seen: u32,
    /// How many of those parsed into a usable [`WerApplicationError`].
    pub records_parsed: u32,
    /// Parsed records rejected because their timestamp fell outside the window.
    pub rejected_out_of_window: u32,
    /// Parsed records rejected because their exception code disagreed in-window.
    pub rejected_code_mismatch: u32,
    /// Parsed records rejected because they carried no bindable timestamp.
    pub rejected_unparsable: u32,
    /// Query sweeps the deferred read performed (caller-owned).
    pub sweeps: u32,
    /// Milliseconds from the watcher exit to this verdict (caller-owned).
    pub ms_to_verdict: u32,
}

impl WatcherFaultCounters {
    /// The counters as fixed-key bare integers, for the caller to emit as Sentry
    /// extras. Keys are code constants; values are bounded `u32`s.
    pub fn as_extras(&self) -> [(&'static str, u32); 7] {
        [
            ("watcher_fault_records_seen", self.records_seen),
            ("watcher_fault_records_parsed", self.records_parsed),
            ("watcher_fault_rejected_out_of_window", self.rejected_out_of_window),
            ("watcher_fault_rejected_code_mismatch", self.rejected_code_mismatch),
            ("watcher_fault_rejected_unparsable", self.rejected_unparsable),
            ("watcher_fault_sweeps", self.sweeps),
            ("watcher_fault_ms_to_verdict", self.ms_to_verdict),
        ]
    }
}

/// The content-safe result of attributing a fault to this watcher generation.
/// Every field is a fixed token or a bare integer. `image`/`module` are `None`
/// (rendered as [`WATCHER_FAULT_UNAVAILABLE`]) whenever the provenance is not an
/// attribution, so absence can never masquerade as evidence.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WatcherFaultOutcome {
    pub provenance: WatcherFaultProvenance,
    pub image: Option<WatcherFaultBinary>,
    pub module: Option<WatcherFaultBinary>,
    pub exception_code: Option<u32>,
    pub fault_offset: Option<u64>,
    pub counters: WatcherFaultCounters,
}

impl WatcherFaultOutcome {
    fn unresolved(provenance: WatcherFaultProvenance, counters: WatcherFaultCounters) -> Self {
        Self {
            provenance,
            image: None,
            module: None,
            exception_code: None,
            fault_offset: None,
            counters,
        }
    }

    /// The query could not run at all (unreadable WER / failed `EvtQuery`).
    pub fn unavailable() -> Self {
        Self::unresolved(WatcherFaultProvenance::Unavailable, WatcherFaultCounters::default())
    }

    /// No read was warranted: a non-Windows exit, or a non-fault exit. Keeps a
    /// macOS/Linux watcher exit from masquerading as a failed Windows read.
    pub fn not_applicable() -> Self {
        Self::unresolved(WatcherFaultProvenance::NotApplicable, WatcherFaultCounters::default())
    }

    /// The query ran but the Application log held zero Application Error 1000
    /// records. Carries the counters observed so far.
    pub fn no_records(counters: WatcherFaultCounters) -> Self {
        Self::unresolved(WatcherFaultProvenance::NoRecords, counters)
    }

    fn from_record(
        record: &WerApplicationError,
        provenance: WatcherFaultProvenance,
        counters: WatcherFaultCounters,
    ) -> Self {
        Self {
            provenance,
            image: Some(record.image),
            module: Some(record.module),
            exception_code: record.exception_code,
            fault_offset: record.fault_offset,
            counters,
        }
    }

    /// Stamp the runtime counters the Win32 read loop owns, leaving the
    /// parse/rejection tallies and the binding untouched.
    pub fn with_runtime_counters(mut self, records_seen: u32, sweeps: u32, ms_to_verdict: u32) -> Self {
        self.counters.records_seen = records_seen;
        self.counters.sweeps = sweeps;
        self.counters.ms_to_verdict = ms_to_verdict;
        self
    }

    /// Map a still-empty `NoRecords` verdict to `DeadlineExpired` once the
    /// deferred read has exhausted its whole horizon. ONLY `NoRecords` is
    /// remapped: a rejection or a real binding keeps its more-informative token,
    /// so "we waited and WER never wrote anything" stays distinct from "records
    /// existed but none bound".
    pub fn into_deadline_expired(mut self) -> Self {
        if self.provenance == WatcherFaultProvenance::NoRecords {
            self.provenance = WatcherFaultProvenance::DeadlineExpired;
        }
        self
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
}

/// Bind zero or more read WER Application Error records to this watcher
/// generation and choose the single most-confident provenance — or, when
/// nothing binds, the most-informative reason WHY.
///
/// `records` are the parsed candidates (newest first is preferred but not
/// required — the strongest binding wins regardless of order). `sampled_pids` is
/// the union of live Job Object process ids sampled across the generation's
/// lifetime; `[gen_start_ms, gen_end_ms]` is that lifetime as a closed unix-ms
/// window. `observed_exception_code`, when known, is the fault status the exit
/// itself carried, used to reject an in-window record for an unrelated fault.
///
/// Precedence, strongest first:
///  1. `PidMatched` — faulting PID ∈ `sampled_pids` AND time ∈ window (code ok).
///  2. `WindowOnly` — time ∈ window AND (no observed code, or codes agree).
///  3. When nothing binds, the dominant rejection reason, most-informative
///     first: `RejectedCodeMismatch` (a real in-window crash, wrong code) beats
///     `RejectedOutOfWindow` (a stale/coincidental crash) beats
///     `RejectedUnparsable` (no bindable timestamp); `NoRecords` when the set is
///     empty.
///
/// A weaker binding is never upgraded, and a record outside the window is never
/// reported, so PID reuse or a coincidental unrelated crash on the same machine
/// downgrades to `window_only` or is rejected outright rather than producing a
/// false `pid_matched`. The returned counters record parse/rejection tallies so
/// a second failure states exactly which cause occurred.
pub fn attribute_watcher_fault(
    records: &[WerApplicationError],
    sampled_pids: &[u32],
    gen_start_ms: i64,
    gen_end_ms: i64,
    observed_exception_code: Option<u32>,
) -> WatcherFaultOutcome {
    let mut counters = WatcherFaultCounters {
        records_parsed: records.len().min(u32::MAX as usize) as u32,
        ..WatcherFaultCounters::default()
    };
    if records.is_empty() {
        return WatcherFaultOutcome::no_records(counters);
    }
    let has_timestamp = |record: &WerApplicationError| record.event_time_unix_ms.is_some();
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
        return WatcherFaultOutcome::from_record(record, WatcherFaultProvenance::PidMatched, counters);
    }

    // Weaker: in-window and code-consistent, but PID not confirmed.
    if let Some(record) = records
        .iter()
        .find(|record| in_window(record) && code_agrees(record))
    {
        return WatcherFaultOutcome::from_record(record, WatcherFaultProvenance::WindowOnly, counters);
    }

    // Nothing bound — tally WHY each parsed record was rejected. Every record
    // falls in exactly one bucket: an in-window, code-agreeing record would have
    // bound above, so an in-window survivor here can only be a code mismatch.
    for record in records {
        if !has_timestamp(record) {
            counters.rejected_unparsable = counters.rejected_unparsable.saturating_add(1);
        } else if !in_window(record) {
            counters.rejected_out_of_window = counters.rejected_out_of_window.saturating_add(1);
        } else {
            counters.rejected_code_mismatch = counters.rejected_code_mismatch.saturating_add(1);
        }
    }
    let provenance = if counters.rejected_code_mismatch > 0 {
        WatcherFaultProvenance::RejectedCodeMismatch
    } else if counters.rejected_out_of_window > 0 {
        WatcherFaultProvenance::RejectedOutOfWindow
    } else {
        WatcherFaultProvenance::RejectedUnparsable
    };
    WatcherFaultOutcome::unresolved(provenance, counters)
}

// ─────────────────────────────────────────────────────────────────────────────
// WER-independent job-image descriptor
// ─────────────────────────────────────────────────────────────────────────────

/// Provenance token for the job-image descriptor. It marks the descriptor as a
/// process-TREE OBSERVATION (the app's own Job Object PID sampling) and NOT a WER
/// fault attribution, so a named image here can never be misread as "this is what
/// faulted" — only "this ran in the generation's tree". Absence renders
/// [`WATCHER_FAULT_UNAVAILABLE`].
pub const WATCHER_JOB_IMAGE_TREE_SAMPLED: &str = "tree_sampled";

/// Cap on how many image tokens the descriptor renders. The watcher tree is a
/// handful of processes and the allow-list is nine tokens, so this only guards a
/// pathological producer; the render is bounded well under Sentry's tag limit.
const JOB_IMAGE_SET_TAG_MAX: usize = WatcherFaultBinary::ALL.len();

/// A bounded, content-safe rollup of the allow-listed IMAGE basenames observed
/// alive in a watcher generation's Job Object across the sampling cadence.
///
/// This is the WER-INDEPENDENT half of the fix: even when WER never publishes a
/// fault record (a `__fastfail`/0xC0000409 abort may simply not be reported), the
/// descriptor still supplies a named culprit CANDIDATE from the app's own
/// process-tree enumeration — without ever letting absence masquerade as
/// evidence, and carrying its own tree-observation provenance so it is never
/// confused with a fault attribution. Only fixed allow-list tokens are retained;
/// an image outside the list folds to `other`, exactly like the WER image
/// position, so no path, product string, or username can leak.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WatcherJobImageRollup {
    seen: [bool; WatcherFaultBinary::ALL.len()],
    last_nonshim: Option<WatcherFaultBinary>,
}

impl WatcherJobImageRollup {
    /// Fold one observed image name through the SAME closed allow-list the WER
    /// image position uses. The name is inspected only to select a fixed token;
    /// nothing is retained. Updates the "last non-shim image" candidate when the
    /// observed binary is not a shim or the app itself.
    pub fn record_image_name(&mut self, name: &str) {
        self.record_binary(classify_watcher_fault_binary(name));
    }

    /// Fold an already-classified binary in — the unit-test seam for
    /// [`Self::record_image_name`], and what the Win32 sampler calls after
    /// classifying a `QueryFullProcessImageNameW` basename.
    pub fn record_binary(&mut self, binary: WatcherFaultBinary) {
        self.seen[binary.index()] = true;
        if !binary.is_shim_or_self() {
            self.last_nonshim = Some(binary);
        }
    }

    pub fn is_empty(&self) -> bool {
        !self.seen.iter().any(|seen| *seen)
    }

    /// The distinct allow-listed image tokens observed, in `ALL` declaration
    /// order, comma-joined and bounded. `None` when nothing was observed, so no
    /// tag is sent.
    pub fn image_set_tag(&self) -> Option<String> {
        let rendered: Vec<&'static str> = WatcherFaultBinary::ALL
            .iter()
            .filter(|binary| self.seen[binary.index()])
            .take(JOB_IMAGE_SET_TAG_MAX)
            .map(|binary| binary.as_str())
            .collect();
        (!rendered.is_empty()).then(|| rendered.join(","))
    }

    /// The last observed non-shim image — the culprit candidate — as a fixed
    /// token, or [`WATCHER_FAULT_UNAVAILABLE`] when none was seen.
    pub fn last_nonshim_token(&self) -> &'static str {
        self.last_nonshim
            .map(WatcherFaultBinary::as_str)
            .unwrap_or(WATCHER_FAULT_UNAVAILABLE)
    }

    /// The descriptor's own provenance: a tree observation when anything was
    /// sampled, else the unavailable sentinel. Never a fault-attribution token.
    pub fn provenance_token(&self) -> &'static str {
        if self.is_empty() {
            WATCHER_FAULT_UNAVAILABLE
        } else {
            WATCHER_JOB_IMAGE_TREE_SAMPLED
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
        let count = match classify_unmatched_stderr_shape(line) {
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
    fn attribute_prefers_pid_match_then_window_then_rejection() {
        let base = WerApplicationError {
            image: WatcherFaultBinary::NodeExe,
            module: WatcherFaultBinary::NtdllDll,
            exception_code: Some(0xC000_0409),
            fault_offset: Some(0x2a1b3),
            faulting_pid: Some(6700),
            event_time_unix_ms: Some(1_000_500),
        };
        let window = (1_000_000_i64, 1_001_000_i64);

        // PID in the sampled set + in window → pid_matched, fields populated,
        // and the parsed-record counter reflects the one candidate.
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

        // Record timestamped OUTSIDE the window → distinct rejected token, unnamed,
        // and the per-reason counter says exactly why.
        let stale = WerApplicationError {
            event_time_unix_ms: Some(999_000),
            ..base
        };
        let outcome = attribute_watcher_fault(&[stale], &[6700], window.0, window.1, Some(0xC000_0409));
        assert_eq!(outcome.provenance, WatcherFaultProvenance::RejectedOutOfWindow);
        assert_eq!(outcome.image_token(), WATCHER_FAULT_UNAVAILABLE);
        assert_eq!(outcome.module_token(), WATCHER_FAULT_UNAVAILABLE);
        assert_eq!(outcome.exception_code, None);
        assert_eq!(outcome.counters.rejected_out_of_window, 1);
        assert_eq!(outcome.counters.rejected_code_mismatch, 0);

        // No records at all → no_records (distinct from a rejected set).
        let empty = attribute_watcher_fault(&[], &[6700], window.0, window.1, None);
        assert_eq!(empty.provenance, WatcherFaultProvenance::NoRecords);
        assert_eq!(empty.counters.records_parsed, 0);
    }

    #[test]
    fn attribute_distinguishes_every_rejection_reason_and_tallies_it() {
        let window = (1_000_000_i64, 1_001_000_i64);
        let good = WerApplicationError {
            image: WatcherFaultBinary::NodeExe,
            module: WatcherFaultBinary::NtdllDll,
            exception_code: Some(0xC000_0409),
            fault_offset: Some(0x2a1b3),
            faulting_pid: Some(6700),
            event_time_unix_ms: Some(1_000_500),
        };

        // In-window but a DIFFERENT code → rejected_code_mismatch, the most
        // informative reason (a real crash at the right time, wrong code).
        let mismatch = WerApplicationError { exception_code: Some(0xC000_0005), ..good };
        let outcome = attribute_watcher_fault(&[mismatch], &[6700], window.0, window.1, Some(0xC000_0409));
        assert_eq!(outcome.provenance, WatcherFaultProvenance::RejectedCodeMismatch);
        assert_eq!(outcome.counters.rejected_code_mismatch, 1);
        assert_eq!(outcome.image_token(), WATCHER_FAULT_UNAVAILABLE, "a rejection never names an image");

        // No bindable timestamp → rejected_unparsable.
        let no_time = WerApplicationError { event_time_unix_ms: None, ..good };
        let outcome = attribute_watcher_fault(&[no_time], &[6700], window.0, window.1, Some(0xC000_0409));
        assert_eq!(outcome.provenance, WatcherFaultProvenance::RejectedUnparsable);
        assert_eq!(outcome.counters.rejected_unparsable, 1);

        // Mixed set with no binding: code-mismatch outranks out-of-window, and both
        // per-reason counters are recorded.
        let stale = WerApplicationError { event_time_unix_ms: Some(500), ..good };
        let outcome = attribute_watcher_fault(&[mismatch, stale], &[6700], window.0, window.1, Some(0xC000_0409));
        assert_eq!(outcome.provenance, WatcherFaultProvenance::RejectedCodeMismatch);
        assert_eq!(outcome.counters.rejected_code_mismatch, 1);
        assert_eq!(outcome.counters.rejected_out_of_window, 1);
        assert_eq!(outcome.counters.records_parsed, 2);
    }

    #[test]
    fn runtime_counters_and_deadline_mapping_are_honest() {
        // A no-records verdict maps to deadline_expired only after the full horizon.
        let empty = attribute_watcher_fault(&[], &[], 0, 10, None)
            .with_runtime_counters(0, 4, 61_000);
        assert_eq!(empty.provenance, WatcherFaultProvenance::NoRecords);
        assert_eq!(empty.counters.records_seen, 0);
        assert_eq!(empty.counters.sweeps, 4);
        assert_eq!(empty.counters.ms_to_verdict, 61_000);
        let expired = empty.into_deadline_expired();
        assert_eq!(expired.provenance, WatcherFaultProvenance::DeadlineExpired);
        assert_eq!(expired.image_token(), WATCHER_FAULT_UNAVAILABLE, "deadline_expired is never named");

        // into_deadline_expired NEVER upgrades a real binding or a rejection.
        let base = WerApplicationError {
            image: WatcherFaultBinary::NodeExe,
            module: WatcherFaultBinary::NtdllDll,
            exception_code: Some(0xC000_0409),
            fault_offset: Some(0x2a1b3),
            faulting_pid: Some(6700),
            event_time_unix_ms: Some(5),
        };
        let bound = attribute_watcher_fault(&[base], &[6700], 0, 10, Some(0xC000_0409));
        assert_eq!(bound.into_deadline_expired().provenance, WatcherFaultProvenance::PidMatched);
        let stale = WerApplicationError { event_time_unix_ms: Some(100), ..base };
        let rejected = attribute_watcher_fault(&[stale], &[6700], 0, 10, Some(0xC000_0409));
        assert_eq!(
            rejected.into_deadline_expired().provenance,
            WatcherFaultProvenance::RejectedOutOfWindow
        );
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
        // fault → the distinct rejected token rather than a confident wrong one.
        let outcome =
            attribute_watcher_fault(&[other_fault], &[6700], 1_000_000, 1_001_000, Some(0xC000_0409));
        assert_eq!(outcome.provenance, WatcherFaultProvenance::RejectedCodeMismatch);
        assert_eq!(outcome.counters.rejected_code_mismatch, 1);
    }

    #[test]
    fn unresolved_constructors_are_distinct_and_never_named() {
        // The states the old two-token vocabulary collapsed are now distinct, and
        // none of them renders a named image.
        for (outcome, token) in [
            (WatcherFaultOutcome::unavailable(), "unavailable"),
            (WatcherFaultOutcome::not_applicable(), "not_applicable"),
            (WatcherFaultOutcome::no_records(WatcherFaultCounters::default()), "no_records"),
            (
                WatcherFaultOutcome::no_records(WatcherFaultCounters::default()).into_deadline_expired(),
                "deadline_expired",
            ),
        ] {
            assert_eq!(outcome.provenance_token(), token);
            assert_eq!(outcome.image_token(), WATCHER_FAULT_UNAVAILABLE, "{token} must be unnamed");
            assert_eq!(outcome.module_token(), WATCHER_FAULT_UNAVAILABLE);
            assert!(!outcome.provenance.is_attribution(), "{token} is not an attribution");
        }
        // The two real bindings are the only attributions.
        assert!(WatcherFaultProvenance::PidMatched.is_attribution());
        assert!(WatcherFaultProvenance::WindowOnly.is_attribution());
    }

    #[test]
    fn job_image_rollup_names_only_allow_listed_tokens_and_tracks_the_culprit() {
        let mut rollup = WatcherJobImageRollup::default();
        assert!(rollup.is_empty());
        assert_eq!(rollup.provenance_token(), WATCHER_FAULT_UNAVAILABLE);
        assert_eq!(rollup.last_nonshim_token(), WATCHER_FAULT_UNAVAILABLE);
        assert_eq!(rollup.image_set_tag(), None);

        // A cmd.exe shim first, then the node.exe runner: the shim is recorded in
        // the set but the non-shim runner is the culprit candidate.
        rollup.record_image_name(r"C:\Windows\System32\cmd.exe");
        rollup.record_image_name(r"C:\Users\Ada\AppData\Local\HQ\node.exe");
        assert!(!rollup.is_empty());
        assert_eq!(rollup.provenance_token(), "tree_sampled");
        assert_eq!(rollup.last_nonshim_token(), "node_exe");
        let set = rollup.image_set_tag().expect("a nonempty rollup renders a tag");
        // Declaration order (node before cmd), deduped, comma-joined.
        assert_eq!(set, "node_exe,cmd_exe");

        // An unknown private binary folds to `other` — never a path or raw name.
        let mut leaky = WatcherJobImageRollup::default();
        leaky.record_image_name(r"C:\Users\cognito-token-abc123\secret-loader.exe");
        assert_eq!(leaky.last_nonshim_token(), "other");
        let set = leaky.image_set_tag().expect("nonempty");
        assert!(!set.contains("cognito") && !set.contains("abc123") && !set.contains("secret"));
        assert_eq!(set, "other");
    }

    #[test]
    fn binary_index_round_trips_all() {
        // The compact index the job-image rollup uses must stay in lockstep with
        // ALL, or a reordering would silently mis-bucket an observed image.
        for (position, binary) in WatcherFaultBinary::ALL.iter().enumerate() {
            assert_eq!(binary.index(), position, "index drift for {:?}", binary);
        }
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
        for token in binary
            .into_iter()
            .chain(provenance)
            .chain(shapes)
            .chain(std::iter::once(WATCHER_FAULT_UNAVAILABLE))
            .chain(std::iter::once(WATCHER_JOB_IMAGE_TREE_SAMPLED))
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
}
