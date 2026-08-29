//! `hq-telemetry` — canonical HQ Rust Sentry scrubber (PII/secret redaction).
//! Extracted from `apps/sync/src-tauri/src/sentry_scrub.rs` (Phase 4).
// Only `Event`, `Context`, and `Value` are referenced inside this module.
// The `ClientOptions` and `Arc` imports that the wiring needs (see
// `lib.rs::run()` in this step and `main.rs::main()` in Step 17) live
// at the call site, not here — keeping this module's import list
// minimal so `cargo clippy -- -D warnings` stays clean.
use sentry::protocol::{Context, Event, Value};
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};

const UI_SEAM_CATEGORY: &str = "ui.seam";
const NATIVE_PANIC_PHASE_TAG: &str = "native_panic_phase";

/// Lifecycle state recorded with native-panic reports. The state is deliberately
/// small and static because it is updated from the native event-loop thread.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativePanicPhase {
    Running = 0,
    Exiting = 1,
    Destroyed = 2,
}

impl NativePanicPhase {
    fn as_tag(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Exiting => "exiting",
            Self::Destroyed => "destroyed",
        }
    }
}

static NATIVE_PANIC_PHASE: AtomicU8 = AtomicU8::new(NativePanicPhase::Running as u8);

/// Static seam identifiers are intentionally closed over. They cannot carry
/// runtime text, so no native event-loop call site can expose a path, token, or
/// user identifier through a breadcrumb.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum NativePanicSeam {
    TrayLeftClick = 1,
    TrayBlurHide = 2,
    GlobalShortcutTogglePopover = 3,
    GlobalShortcutToggleDesktop = 4,
    WindowCloseRequestedHide = 5,
    WindowThemeChanged = 6,
    WindowForceForeground = 7,
    SingleInstanceSurfaceExisting = 8,
    AppExitRequested = 9,
    /// The Windows session-end branch of `RunEvent::Exit` was taken: no
    /// `ExitRequested` had been seen, so the exit is OS-forced rather than
    /// user-initiated.
    AppSessionEndExit = 10,
    /// The independent Windows session-end observer *also* affirmed a session
    /// end at that instant. Recorded alongside — never instead of —
    /// `AppSessionEndExit`, so a residual report shows whether the two signals
    /// agreed.
    AppSessionEndObserved = 11,
}

impl NativePanicSeam {
    fn from_id(id: u8) -> Option<Self> {
        match id {
            1 => Some(Self::TrayLeftClick),
            2 => Some(Self::TrayBlurHide),
            3 => Some(Self::GlobalShortcutTogglePopover),
            4 => Some(Self::GlobalShortcutToggleDesktop),
            5 => Some(Self::WindowCloseRequestedHide),
            6 => Some(Self::WindowThemeChanged),
            7 => Some(Self::WindowForceForeground),
            8 => Some(Self::SingleInstanceSurfaceExisting),
            9 => Some(Self::AppExitRequested),
            10 => Some(Self::AppSessionEndExit),
            11 => Some(Self::AppSessionEndObserved),
            _ => None,
        }
    }

    fn message(self) -> &'static str {
        match self {
            Self::TrayLeftClick => "tray.left-click",
            Self::TrayBlurHide => "tray.blur-hide",
            Self::GlobalShortcutTogglePopover => "global-shortcut.toggle-popover",
            Self::GlobalShortcutToggleDesktop => "global-shortcut.toggle-desktop",
            Self::WindowCloseRequestedHide => "window.close-requested-hide",
            Self::WindowThemeChanged => "window.theme-changed",
            Self::WindowForceForeground => "window-focus.force-foreground",
            Self::SingleInstanceSurfaceExisting => "single-instance.surface-existing",
            Self::AppExitRequested => "app.exit-requested",
            Self::AppSessionEndExit => "app.session-end-exit",
            Self::AppSessionEndObserved => "app.session-end-observed",
        }
    }
}

const NATIVE_PANIC_SEAM_HISTORY_CAPACITY: usize = 8;
static NATIVE_PANIC_SEAMS: AtomicU64 = AtomicU64::new(0);

#[cfg(test)]
static NATIVE_PANIC_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
fn reset_native_panic_context_for_test() {
    NATIVE_PANIC_SEAMS.store(0, Ordering::Relaxed);
    NATIVE_PANIC_PHASE.store(NativePanicPhase::Running as u8, Ordering::Relaxed);
}

/// Record a static UI seam immediately before native window/event-loop work.
///
/// This is an atomic, bounded eight-entry history. It intentionally does no
/// allocation, locking, file I/O, or network I/O on the native event-loop
/// path. `before_send` materializes the static entries as breadcrumbs only if
/// an event is captured.
pub fn record_native_panic_seam(seam: NativePanicSeam) {
    NATIVE_PANIC_SEAMS
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |history| {
            Some((history << u8::BITS) | seam as u64)
        })
        .expect("native seam history update is infallible");
}

/// Set the lifecycle tag that distinguishes normal operation from exit and
/// post-exit event-loop activity in a future native-panic report.
pub fn set_native_panic_phase(phase: NativePanicPhase) {
    NATIVE_PANIC_PHASE.store(phase as u8, Ordering::Relaxed);
}

/// Flush pending Sentry envelopes, giving up after `deadline`.
///
/// The normal flush is the `ClientInitGuard`'s `Drop`, which never runs when a
/// process calls `std::process::exit`. The Windows session-end exit path does
/// exactly that — deliberately, to stop tao's message pump before it can
/// dispatch into a destroyed event-loop runner — so it needs an explicit,
/// *bounded* flush instead.
///
/// It is called from inside a Windows window procedure while the OS is already
/// tearing the desktop session down, so two properties matter more than
/// delivery: it must never block past `deadline` (Windows force-kills at
/// `WaitToKillAppTimeout`, 5s by default), and it must never panic (a panic
/// escaping an `extern "system"` callback aborts the process). A dropped
/// report is an acceptable outcome; a missed teardown or an abort is not.
///
/// Returns `true` when there was nothing to flush or the flush completed
/// inside `deadline`, `false` when it timed out.
pub fn flush_within(deadline: std::time::Duration) -> bool {
    match sentry::Hub::current().client() {
        // No client: Sentry is disabled (empty DSN on dev/PR CI) and there is
        // nothing queued, so this is a success, not a timeout.
        None => true,
        Some(client) => client.flush(Some(deadline)),
    }
}

fn current_native_panic_phase() -> NativePanicPhase {
    match NATIVE_PANIC_PHASE.load(Ordering::Relaxed) {
        0 => NativePanicPhase::Running,
        1 => NativePanicPhase::Exiting,
        2 => NativePanicPhase::Destroyed,
        value => panic!("unexpected native panic phase: {value}"),
    }
}

fn native_panic_seams(
    mut history: u64,
) -> [Option<NativePanicSeam>; NATIVE_PANIC_SEAM_HISTORY_CAPACITY] {
    let mut seams = [None; NATIVE_PANIC_SEAM_HISTORY_CAPACITY];
    for slot in seams.iter_mut().rev() {
        *slot = NativePanicSeam::from_id((history & u64::from(u8::MAX)) as u8);
        history >>= u8::BITS;
    }
    seams
}

fn append_native_panic_context(event: &mut Event<'static>, phase: NativePanicPhase, history: u64) {
    event
        .tags
        .insert(NATIVE_PANIC_PHASE_TAG.into(), phase.as_tag().into());

    for seam in native_panic_seams(history).into_iter().flatten() {
        event.breadcrumbs.values.push(sentry::protocol::Breadcrumb {
            category: Some(UI_SEAM_CATEGORY.into()),
            message: Some(seam.message().into()),
            level: sentry::Level::Info,
            ..Default::default()
        });
    }
}

const SENSITIVE_FIELD_NAMES: &[&str] = &[
    "authorization",
    "password",
    "secret",
    "apikey",
    "api_key",
    "token",
];

/// Mirror of `hq_desktop_core::sync_outcome::RUNNER_STACK_TOKENS`. The two must
/// stay set-identical or a new producer token would be silently `[Filtered]` at
/// egress; `runner_stack_tokens_match_across_crates` enforces that.
const RUNNER_STACK_TOKENS: &[&str] = &[
    "app",
    "libuv_handle",
    "libuv_win_async",
    "libuv_unix_core",
    "node_task_queues",
    "node_cjs_loader",
    "node_esm_loader",
    "node_timers",
    "node_child_process",
    "node_events",
    "node_fs",
    "node_stream",
    "rust_core_panicking",
    "rust_std_panicking",
    // V8 heap-OOM native-frame vocabulary (HQ-DESKTOP-55).
    "node_oom_handler",
    "node_abort",
    "v8_report_oom",
    "v8_fatal_process_oom",
    "v8_heap_allocator",
    "v8_heap",
    "v8_factory",
    "v8_runtime",
    "v8_builtin",
    "v8_other",
    "node_native",
    "anon",
];

fn is_sensitive_key(k: &str) -> bool {
    SENSITIVE_FIELD_NAMES
        .iter()
        .any(|name| k.eq_ignore_ascii_case(name))
}

fn valid_runner_stack_shape(value: &str) -> bool {
    if value == "all_redacted" {
        return true;
    }
    let tokens = value.split('>').collect::<Vec<_>>();
    !tokens.is_empty()
        && tokens.len() <= 8
        && tokens
            .iter()
            .all(|token| !token.is_empty() && RUNNER_STACK_TOKENS.contains(token))
}

fn valid_runner_stack_signature(value: &str) -> bool {
    value == "unknown"
        || (value.len() == 16
            && value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)))
}

fn valid_runner_stack_pair(shape: &str, signature: &str) -> bool {
    (shape == "all_redacted" && signature == "unknown")
        || (shape != "all_redacted"
            && valid_runner_stack_shape(shape)
            && signature != "unknown"
            && valid_runner_stack_signature(signature))
}

/// A content-safe libuv syscall token: the sentinel `other`, or a bare, bounded
/// ASCII identifier (`[A-Za-z0-9_]{1,64}`). The producer only ever emits an
/// allow-listed constant or `other`; this shape check is the independent egress
/// backstop that rejects a path, space, symbol, or raw stderr fragment.
fn is_content_safe_syscall_token(value: &str) -> bool {
    value == "other"
        || (!value.is_empty()
            && value.len() <= 64
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_'))
}

/// The closed faulting-binary allow-list, mirrored from
/// `hq_desktop_core::watcher_fault::WatcherFaultBinary` plus the `unavailable`
/// sentinel. Kept in lockstep by the anti-drift test below; an independent egress
/// check so a producer bug cannot ship a path or product string here.
fn is_watcher_fault_binary_token(value: &str) -> bool {
    matches!(
        value,
        "node_exe"
            | "npx_cmd"
            | "cmd_exe"
            | "hq_sync_menubar_exe"
            | "ntdll_dll"
            | "kernelbase_dll"
            | "ucrtbase_dll"
            | "msvcrt_dll"
            | "other"
            | "unavailable"
    )
}

/// A bare unsigned decimal integer of bounded length: no sign, no separators, no
/// path bytes. Independent egress shape check for the fault code/offset.
fn is_bounded_decimal(value: &str, max_len: usize) -> bool {
    !value.is_empty() && value.len() <= max_len && value.bytes().all(|byte| byte.is_ascii_digit())
}

/// A comma-separated set of allow-listed faulting-binary tokens
/// (`node_exe,cmd_exe`), the job-image tree observation. Independent egress
/// check so a producer bug that shipped a path or raw process name degrades to
/// `[Filtered]`. Bounded well under Sentry's tag limit.
fn is_watcher_fault_binary_token_set(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.split(',').all(is_watcher_fault_binary_token)
}

/// The bounded read-counters rollup (`seen:N,parsed:N,rej_win:N,rej_code:N,
/// sweeps:N,ms:N`), mirrored from `hq_desktop_core::watcher_fault::
/// WatcherFaultReadCounters::tag_value`. Fixed tokens, bare-integer counts; the
/// independent egress check that rejects any path, symbol, or raw record byte.
fn is_watcher_fault_read_counters(value: &str) -> bool {
    const KEYS: &[&str] = &["seen", "parsed", "rej_win", "rej_code", "sweeps", "ms"];
    !value.is_empty()
        && value.len() <= 128
        && value.split(',').enumerate().all(|(index, entry)| {
            entry.split_once(':').is_some_and(|(token, count)| {
                KEYS.get(index) == Some(&token)
                    && !count.is_empty()
                    && count.len() <= 10
                    && count.bytes().all(|byte| byte.is_ascii_digit())
            })
        })
        && value.split(',').count() == KEYS.len()
}

/// A `token:count(,token:count)*` rollup whose tokens are the closed
/// unmatched-stderr shape vocabulary (mirrored from
/// `hq_desktop_core::watcher_fault::UnmatchedStderrShape`) and whose counts are
/// bare integers. Bounded so a malformed producer value can never carry a
/// runner byte through.
fn is_unmatched_stderr_shape_rollup(value: &str) -> bool {
    const SHAPES: &[&str] = &[
        "ndjson_record",
        "stack_frame",
        "hash_frame",
        "key_colon",
        "path_like",
        "blank",
        "word",
        "other",
    ];
    !value.is_empty()
        && value.len() <= 128
        && value.split(',').all(|entry| {
            entry.split_once(':').is_some_and(|(token, count)| {
                SHAPES.contains(&token)
                    && !count.is_empty()
                    && count.bytes().all(|byte| byte.is_ascii_digit())
            })
        })
}

// Closed vocabularies for the four runner-error rollup axes, mirrored from the
// `hq_desktop_core::runner_error_shape` producers exactly as
// `is_unmatched_stderr_shape_rollup` mirrors its shape set. Kept local so the
// egress guard stays independent of the producer crate; a
// `#[cfg(test)]` drift check drives every producer variant through these lists
// so a producer that adds a token without updating the mirror fails CI.
const RUNNER_ERROR_HTTP_TOKENS: &[&str] = &[
    "http_400", "http_401", "http_403", "http_404", "http_409", "http_412", "http_429", "http_4xx",
    "http_500", "http_502", "http_503", "http_504", "http_5xx", "http_other",
];
const RUNNER_ERROR_CAUSE_TOKENS: &[&str] = &[
    "entity_not_found",
    "entity_permission",
    "entity_resolution",
    "source_not_found",
    "operation_locked",
    "operation_lock_unwritable",
    "scope_shrink_blocked",
    "scope_shrink_large_prune",
    "delta_gap",
    "multipart_source_changed",
    "multipart_abort",
    "realtime_conflict",
    "realtime_enrollment_unavailable",
    "sync_mutation_not_enrolled",
    "unreachable_push_paths",
    "server_owned_push_paths",
    "push_event_decode",
    "local_snapshot_changed",
    "rescue_path_changed",
    "cursor_retired",
    "base_version_unavailable",
    "durable_apply",
    "durable_apply_recovery",
    "journal_checkpoint",
    "premature_journal_entry",
    "snapshot_client",
    "state_store_corruption",
    "state_store_lock",
    "state_store_reducer",
    "vault_identity",
    "vault_client",
    "vault_conflict",
    "vault_not_found",
    "vault_permission_denied",
    "vend_denied",
    "rate_limited",
    "presign_precondition_missing",
    "outpost_http",
    "tombstone_fetch",
    "unregistered_company_skill",
    "refresh_lock_timeout",
    "cognito_identity",
    "cognito_identity_refresh",
    "dangling_symlink_parent",
    "windows_symlink_privilege",
    "child_process_sync_worker",
    "access_denied",
    "no_such_key",
    "no_such_bucket",
    "slow_down",
    "internal_error",
    "request_timeout",
    "expired_identity",
    "invalid_identity",
    "unknown_error",
    // ECMAScript / Node built-in error identities (r2).
    "range_error",
    "type_error",
    "syntax_error",
    "reference_error",
    "eval_error",
    "uri_error",
    "aggregate_error",
    "abort_error",
    "system_error",
    // Node/libuv errno codes (r2).
    "enoent",
    "eexist",
    "enotempty",
    "exdev",
    "eisdir",
    "enotdir",
    "eloop",
    "enametoolong",
    "emfile",
    "enfile",
    "erofs",
    "eio",
    "eagain",
    "epipe",
    "etimedout",
    "econnreset",
    "econnrefused",
    "enotfound",
    "ehostunreach",
    "enetunreach",
    "eai_again",
    "eperm",
    "eacces",
    "enospc",
    "ebusy",
    "enetdown",
    "einval",
    "unknown_named",
    "unknown_unnamed",
];
const RUNNER_ERROR_SHAPE_TOKENS: &[&str] = &[
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
const RUNNER_ERROR_PATH_ROOT_TOKENS: &[&str] = &[
    "knowledge", "projects", "repos", "sources", "signals", "data", "settings", "workers",
    "registry", "clients", "core", "companies", "personal", "workspace", "other",
];
// The runner-error SITE vocabulary (HQ-DESKTOP-5M): every non-file sentinel plus
// `file`. Kept local like the other rollup mirrors so the egress guard stays
// independent of the producer crate; the `#[cfg(test)]` drift check drives every
// `RunnerErrorSite::ALL` variant through this list, so a producer that adds a site
// without updating this mirror fails CI instead of blanking a live tag.
const RUNNER_ERROR_SITE_TOKENS: &[&str] = &[
    "company",
    "discovery",
    "local_state",
    "runner",
    "scope",
    "auth",
    "file",
];

/// A `token:count(,token:count)*` rollup whose tokens are drawn from a closed
/// `vocabulary` and whose counts are bare integers. Bounded like
/// [`is_unmatched_stderr_shape_rollup`] so a malformed producer value — a raw
/// path, hostname, or message fragment — can never pass egress: it either
/// carries a non-vocabulary token or a non-digit count, or exceeds the cap.
fn is_closed_vocab_count_rollup(value: &str, vocabulary: &[&str]) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.split(',').all(|entry| {
            entry.split_once(':').is_some_and(|(token, count)| {
                vocabulary.contains(&token)
                    && !count.is_empty()
                    && count.bytes().all(|byte| byte.is_ascii_digit())
            })
        })
}

/// A `sig:count(,sig:count)*` rollup where each `sig` is a fixed 12-char
/// lowercase-hex SHA-256 prefix (the `runner_error_cause_signature` axis) and
/// each count is a bare integer. Mirrors the producer's
/// `RunnerErrorCauseSignatureRollup`; the independent egress check that refuses a
/// raw identifier, path, host, or message fragment — only `[0-9a-f]{12}` keys and
/// bare-integer counts pass, so a producer bug degrades to `[Filtered]` instead
/// of shipping a runner byte.
fn is_runner_error_cause_signature_rollup(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.split(',').all(|entry| {
            entry.split_once(':').is_some_and(|(signature, count)| {
                signature.len() == 12
                    && signature
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                    && !count.is_empty()
                    && count.bytes().all(|byte| byte.is_ascii_digit())
            })
        })
}

/// Validate the fields whose producer consumes untrusted runner output. The
/// producer already returns fixed vocabulary; this independent egress check
/// ensures a future producer bug degrades to `[Filtered]` instead of shipping
/// a path, symbol, company slug, or raw stderr fragment.
fn valid_runner_diagnostic_field(key: &str, value: &str) -> Option<bool> {
    match key {
        "runner_stack_shape" => Some(valid_runner_stack_shape(value)),
        "runner_stack_signature" => Some(valid_runner_stack_signature(value)),
        "watcher_launch_origin" => Some(matches!(
            value,
            "renderer" | "app_launch" | "supervisor_respawn"
        )),
        "sync_route" => Some(matches!(value, "manual" | "watcher")),
        "sync_scope" => Some(matches!(value, "all" | "single_company")),
        "runner_phase" => Some(matches!(
            value,
            "scan" | "push" | "pull" | "idle" | "unknown" | "pre_protocol"
        )),
        // Assertion identity (HQ-DESKTOP-50). The producer allow-lists the
        // source token and emits only a digest and integers; these independent
        // egress checks degrade a producer bug to `[Filtered]` instead of
        // shipping a path, the assertion expression, or a raw stderr fragment.
        "runner_assert_source" => Some(matches!(
            value,
            "libuv_win_async" | "libuv_unix_core" | "libuv_handle" | "other"
        )),
        // Same 16-hex-or-`unknown` shape the stack signature uses.
        "runner_assert_signature" => Some(valid_runner_stack_signature(value)),
        // Bare integers. A numeric extra reaches this check as `""` (the scrub
        // loop passes an empty string for a non-string `Value`), which is
        // type-safe by construction; a string value must parse as an integer, so
        // a producer bug that shipped raw text degrades to `[Filtered]`.
        "runner_assert_line" => Some(value.is_empty() || value.parse::<i64>().is_ok()),
        "runner_stdout_line_count" => Some(value.is_empty() || value.parse::<u32>().is_ok()),
        // The runner's Node major, or the `unknown` sentinel when the preflight
        // probe found none.
        "runner_node_major" => Some(value == "unknown" || value.parse::<u32>().is_ok()),
        // A libuv fatal-syscall identifier is only ever a fixed constant (the
        // producer allow-lists it) or the sentinel `other`; the errno is a bare
        // integer. This independent egress check requires a bare, bounded ASCII
        // identifier so a producer bug that shipped a path, space, symbol, or raw
        // stderr fragment degrades to `[Filtered]` instead.
        "runner_fatal_syscall" => Some(is_content_safe_syscall_token(value)),
        "runner_fatal_errno" => Some(value.parse::<i64>().is_ok()),
        "watcher_job_peak_commit_bucket" => Some(matches!(
            value,
            "under_128mb"
                | "128mb_to_512mb"
                | "512mb_to_1gb"
                | "1gb_to_2gb"
                | "over_2gb"
                | "unknown"
        )),
        "watcher_job_process_count" => Some(value == "unknown" || value.parse::<u32>().is_ok()),
        "watcher_child_kind" => Some(matches!(value, "cmd_shim" | "launcher" | "direct_executable")),
        // `tree` (HQ-DESKTOP-55) is the honest whole-descendant-tree RSS scope; the
        // other three remain the single-PID command-derived scopes.
        "rss_scope" => Some(matches!(value, "shim" | "launcher" | "runner" | "tree")),
        // V8 heap-OOM attribution (HQ-DESKTOP-55). The producer emits a fixed
        // banner constant and bare-integer MB/frame figures; these independent
        // egress checks degrade a producer bug that shipped raw stderr text to
        // `[Filtered]` instead. The numeric extras reach this check as `""` for a
        // non-string `Value` (type-safe by construction); a string value must
        // parse as an unsigned integer.
        "runner_oom_banner" => Some(matches!(
            value,
            "reached_heap_limit" | "ineffective_mark_compacts" | "other"
        )),
        "runner_heap_used_mb" | "runner_heap_total_mb" | "runner_oom_frame_count" => {
            Some(value.is_empty() || value.parse::<u64>().is_ok())
        }
        // Windows fault provenance (HQ-DESKTOP-4X). The producer already emits
        // fixed vocabulary and bare integers; these independent checks make a
        // future producer bug that shipped a path, product string, or raw record
        // byte degrade to `[Filtered]` instead. The resolved provenance vocabulary
        // separates the states the prior fix merged into `no_record`/`unavailable`.
        "watcher_fault_provenance" => Some(matches!(
            value,
            "pid_matched"
                | "window_only"
                | "query_unreadable"
                | "no_records"
                | "rejected_out_of_window"
                | "rejected_code_mismatch"
                | "rejected_unparsable"
                | "deadline_expired"
                | "deferred"
                | "not_applicable"
        )),
        "watcher_fault_faulting_image" | "watcher_fault_faulting_module" => {
            Some(is_watcher_fault_binary_token(value))
        }
        "watcher_fault_exception_code" => Some(is_bounded_decimal(value, 10)),
        "watcher_fault_offset" => Some(is_bounded_decimal(value, 20)),
        // Bounded read counters (`seen:N,parsed:N,...`) so a recurrence states
        // exactly why attribution failed. Fixed tokens, bare-integer counts.
        "watcher_fault_read" => Some(is_watcher_fault_read_counters(value)),
        // WER-independent job-image descriptor (HQ-DESKTOP-4X). A tree observation
        // of the images sampled alive in the watcher's Job Object, NOT a fault
        // attribution. The set and the culprit candidate are allow-listed binary
        // tokens; the provenance is the tree-observation honesty token or the
        // unavailable sentinel — so a producer bug that shipped a path or raw
        // process name degrades to `[Filtered]` here.
        "watcher_fault_job_images" => Some(is_watcher_fault_binary_token_set(value)),
        "watcher_fault_job_culprit_candidate" => Some(is_watcher_fault_binary_token(value)),
        "watcher_fault_job_image_provenance" => {
            Some(matches!(value, "job_tree_observed" | "unavailable"))
        }
        "runner_unmatched_stderr_shapes" => Some(is_unmatched_stderr_shape_rollup(value)),
        // The four runner-error rollup axes (HQ-DESKTOP-4T). The two new axes
        // (`runner_error_http`, `runner_error_causes`) plus the pre-existing
        // `runner_error_shapes` / `runner_error_path_roots`, which shipped without
        // any egress guard — the same rollup family from the same seam, so closing
        // that hole here costs four arms and stops a future producer bug in any of
        // them from shipping a raw path or message fragment.
        "runner_error_http" => Some(is_closed_vocab_count_rollup(value, RUNNER_ERROR_HTTP_TOKENS)),
        "runner_error_causes" => Some(is_closed_vocab_count_rollup(value, RUNNER_ERROR_CAUSE_TOKENS)),
        "runner_error_shapes" => Some(is_closed_vocab_count_rollup(value, RUNNER_ERROR_SHAPE_TOKENS)),
        "runner_error_path_roots" => {
            Some(is_closed_vocab_count_rollup(value, RUNNER_ERROR_PATH_ROOT_TOKENS))
        }
        // The runner-error SITE axis (HQ-DESKTOP-5M): a `token:count` rollup over the
        // closed `RunnerErrorSite` vocabulary. Same egress discipline as the axes
        // above — an off-vocabulary token or non-digit count degrades to `[Filtered]`
        // rather than shipping the runner's raw `path` sentinel or a file fragment.
        "runner_error_sites" => Some(is_closed_vocab_count_rollup(value, RUNNER_ERROR_SITE_TOKENS)),
        // The cause-signature axis (this reopen): a bounded `hex12:count` rollup
        // correlating an `unknown_named` residual across machines. The producer
        // emits only a fixed-length lowercase-hex digest of a gated identifier, so
        // this independent egress check refuses anything else — a raw identifier,
        // path, or message fragment degrades to `[Filtered]` instead of shipping.
        "runner_error_cause_signature" => Some(is_runner_error_cause_signature_rollup(value)),
        // Exec-layer target provenance (HQ-DESKTOP-52 / HQ-DESKTOP-51). The
        // producer emits fixed-vocabulary tokens from the runner-target probe;
        // these independent egress checks degrade a producer bug to `[Filtered]`
        // instead of shipping raw state. The exists/executable fields keep the
        // pre-existing `unknown` sentinel for a genuinely unprobeable cache.
        "runner_exec_resolution" => Some(matches!(value, "npx_cache" | "local_runner" | "unknown")),
        "runner_exec_target_exists" | "runner_exec_target_executable" => {
            Some(matches!(value, "true" | "false" | "unknown"))
        }
        // Emitted as a bare bool (reaches this check as `""` for a non-string
        // Value); a string value must be exactly `true`/`false`.
        "runner_target_repair_attempted" => {
            Some(value.is_empty() || matches!(value, "true" | "false"))
        }
        // Emitted as a bare integer (reaches this check as `""` for a numeric
        // Value); a string value must parse as an unsigned integer.
        "exec_not_runnable_streak" => Some(value.is_empty() || value.parse::<u32>().is_ok()),
        // Pull-based Windows teardown probe (HQ-DESKTOP-4N r2). The producer emits
        // only fixed-vocabulary tokens from the pure verdict/parser; these
        // independent egress checks degrade a producer bug that shipped raw
        // event-log XML, an initiating user, a process path, or a machine name to
        // `[Filtered]` instead of leaking it.
        "windows_teardown_probe_verdict" => Some(matches!(
            value,
            "teardown_confirmed" | "teardown_absent" | "teardown_unknown"
        )),
        "windows_teardown_probe_shuttingdown" => {
            Some(matches!(value, "yes" | "no" | "unavailable"))
        }
        "windows_teardown_probe_log" => Some(matches!(
            value,
            "user32_1074" | "kernel_general_13" | "kernel_power_109" | "none" | "unavailable"
        )),
        // Durable session-end latch (HQ-DESKTOP r3). The producer emits only the
        // three fixed tokens from `SessionEndLatchReading::class_name`; this
        // independent egress check degrades a producer bug that shipped a raw
        // timestamp, host name, or identifier to `[Filtered]` instead of leaking
        // it — the same discipline as the pull-based probe extras above.
        "session_end_latch" => Some(matches!(value, "latched" | "absent" | "unavailable")),
        _ => None,
    }
}

fn scrub_runner_diagnostic_fields(event: &mut Event<'static>) {
    for (key, value) in event.tags.iter_mut() {
        if valid_runner_diagnostic_field(key, value) == Some(false) {
            *value = "[Filtered]".to_string();
        }
    }
    for (key, value) in event.extra.iter_mut() {
        let Some(is_valid) = (match value {
            Value::String(value) => valid_runner_diagnostic_field(key, value),
            _ => valid_runner_diagnostic_field(key, ""),
        }) else {
            continue;
        };
        if !is_valid {
            *value = Value::String("[Filtered]".to_string());
        }
    }

    if event
        .tags
        .get("runner_stack_shape")
        .zip(event.tags.get("runner_stack_signature"))
        .is_some_and(|(shape, signature)| !valid_runner_stack_pair(shape, signature))
    {
        event
            .tags
            .insert("runner_stack_shape".to_string(), "[Filtered]".to_string());
        event.tags.insert(
            "runner_stack_signature".to_string(),
            "[Filtered]".to_string(),
        );
    }

    let extra_pair_is_invalid = event
        .extra
        .get("runner_stack_shape")
        .and_then(Value::as_str)
        .zip(
            event
                .extra
                .get("runner_stack_signature")
                .and_then(Value::as_str),
        )
        .is_some_and(|(shape, signature)| !valid_runner_stack_pair(shape, signature));
    if extra_pair_is_invalid {
        event.extra.insert(
            "runner_stack_shape".to_string(),
            Value::String("[Filtered]".to_string()),
        );
        event.extra.insert(
            "runner_stack_signature".to_string(),
            Value::String("[Filtered]".to_string()),
        );
    }
}

/// Raw process-output stream breadcrumbs must never retain their message at
/// telemetry egress. Match by stream shape instead of producer name so a new
/// sidecar fails closed without requiring another category allowlist entry.
fn is_raw_process_stream_category(category: Option<&str>) -> bool {
    category.is_some_and(|category| {
        matches!(category, "stderr" | "stdout")
            || category.ends_with(".stderr")
            || category.ends_with(".stdout")
    })
}

/// The manual runner replaces raw stderr with this exact fixed-vocabulary
/// grammar before adding a breadcrumb. Preserve only messages that fully match
/// that grammar; a raw process line that merely resembles the prefix still
/// fails closed at egress.
fn is_content_safe_runner_stderr_message(category: Option<&str>, message: Option<&str>) -> bool {
    if category != Some("runner.stderr") {
        return false;
    }
    let Some(body) = message.and_then(|message| message.strip_prefix("runner stderr #")) else {
        return false;
    };
    let Some((sequence, class_with_suffix)) = body.split_once(" (") else {
        return false;
    };
    if sequence.is_empty() || !sequence.bytes().all(|byte| byte.is_ascii_digit()) {
        return false;
    }
    let Some(class) = class_with_suffix.strip_suffix(')') else {
        return false;
    };
    let is_error_class = |value: &str| {
        // `identity` is the current breadcrumb spelling of the auth error class
        // (renamed off the literal `auth`, which Sentry's default @password:filter
        // scrubber deletes — the HQ-DESKTOP-4T breadcrumb loss). `auth` stays
        // accepted so in-flight older clients still emitting it remain sendable.
        matches!(
            value,
            "eperm"
                | "eacces"
                | "enospc"
                | "ebusy"
                | "enoent"
                | "eexist"
                | "enotempty"
                | "exdev"
                | "network"
                | "auth"
                | "identity"
                | "other"
        )
    };
    let is_fatal_class = |value: &str| {
        // Must accept every token `RunnerFatalClass::as_str()` can produce.
        // `node_check_abort` was missing, so our own before_send blanked a
        // node_check_abort breadcrumb before it left the machine.
        matches!(
            value,
            "libuv_assert"
                | "libuv_fatal_syscall"
                | "node_check_abort"
                | "node_fatal"
                | "heap_oom"
                | "rust_panic"
                | "exec_permission_denied"
                | "exec_not_found"
                | "node_too_old"
                | "disk_full"
                | "npm_install_relay"
                | "none"
        )
    };

    if let Some((error_class, fatal_class)) = class.split_once(';') {
        is_error_class(error_class) && is_fatal_class(fatal_class) && !fatal_class.contains(';')
    } else {
        // Keep the previously shipped exact grammar sendable while clients
        // update. New producers always include the second fatal-class token.
        is_error_class(class)
    }
}

fn scrub_sensitive_in_value(v: &mut Value) {
    match v {
        Value::Object(map) => {
            for (k, child) in map.iter_mut() {
                if is_sensitive_key(k) {
                    *child = Value::String("[Filtered]".into());
                } else {
                    scrub_sensitive_in_value(child);
                }
            }
        }
        Value::Array(items) => {
            for child in items.iter_mut() {
                scrub_sensitive_in_value(child);
            }
        }
        _ => {}
    }
}

/// Scrub a single `Context` value. Extracted as `pub(crate)` so the test
/// module can exercise the fail-closed branch directly without needing
/// to build a whole `Event`. `before_send` below calls this helper for
/// every entry in `event.contexts`, so production and tests go through
/// the SAME code path — if a future refactor tries to reintroduce
/// `if let Ok(scrubbed) = ... { *ctx = scrubbed }` (silently swallowing
/// round-trip failure), the test 6d below catches it.
///
/// FAIL CLOSED. Both `serde_json::to_value` and `serde_json::from_value`
/// are fallible. Silently swallowing a failure would leave the original
/// (unscrubbed) context on the event — exactly the silent-leak class
/// this scrubber exists to close. If the round-trip cannot complete we
/// return a marker `Context::Other` with the key `scrub_error` so the
/// failure is visible in Sentry; "Success Criterion: No auth tokens or
/// secrets appear in any Sentry event payload" takes precedence over
/// context fidelity.
pub(crate) fn scrub_context(ctx: Context) -> Context {
    match serde_json::to_value(&ctx) {
        Ok(mut val) => {
            scrub_sensitive_in_value(&mut val);
            match serde_json::from_value(val) {
                Ok(scrubbed) => scrubbed,
                Err(_) => scrub_error_marker(),
            }
        }
        Err(_) => scrub_error_marker(),
    }
}

fn scrub_error_marker() -> Context {
    let mut marker: BTreeMap<String, Value> = BTreeMap::new();
    marker.insert(
        "scrub_error".to_string(),
        Value::String("[Filtered — serde round-trip failed]".into()),
    );
    Context::Other(marker)
}

pub fn before_send(event: Event<'static>) -> Option<Event<'static>> {
    before_send_with_native_context(
        event,
        current_native_panic_phase(),
        NATIVE_PANIC_SEAMS.load(Ordering::Relaxed),
    )
}

fn before_send_with_native_context(
    mut event: Event<'static>,
    phase: NativePanicPhase,
    history: u64,
) -> Option<Event<'static>> {
    // Native event-loop call sites only update atomics. Materialize their
    // bounded, static diagnostic context here so Sentry scope mutation never
    // runs on a tray/window callback.
    append_native_panic_context(&mut event, phase, history);

    // protocol::Request.headers is a Map<String, String>; wipe sensitive
    // header values in-place. (Rust SDK's header map holds owned strings,
    // unlike JS where request.headers is a generic Record<string, unknown>.)
    if let Some(request) = event.request.as_mut() {
        let sensitive_keys: Vec<String> = request
            .headers
            .keys()
            .filter(|k| is_sensitive_key(k))
            .cloned()
            .collect();
        for k in sensitive_keys {
            request.headers.insert(k, "[Filtered]".into());
        }
    }

    // event.extra is BTreeMap<String, Value>; recurse into each value and
    // also redact top-level sensitive keys.
    for (k, v) in event.extra.iter_mut() {
        if is_sensitive_key(k) {
            *v = Value::String("[Filtered]".into());
        } else {
            scrub_sensitive_in_value(v);
        }
    }
    scrub_runner_diagnostic_fields(&mut event);

    // event.contexts is BTreeMap<String, Context>; `Context` is a typed enum
    // (`Device`, `Os`, `Runtime`, `App`, `Browser`, `Gpu`, `Trace`, `Other`).
    // Delegate each variant to `scrub_context` above so production and the
    // tests in this file share one code path (see the doc-comment there).
    for ctx in event.contexts.values_mut() {
        let taken = std::mem::replace(ctx, Context::Other(BTreeMap::new()));
        *ctx = scrub_context(taken);
    }

    // Process output stays in local logs. Filter any raw stdout/stderr stream
    // category defensively before send, including future producers that have
    // not yet been named here; source-side guards still prevent new raw
    // breadcrumbs from being created in the first place.
    for breadcrumb in event.breadcrumbs.values.iter_mut() {
        if is_raw_process_stream_category(breadcrumb.category.as_deref())
            && !is_content_safe_runner_stderr_message(
                breadcrumb.category.as_deref(),
                breadcrumb.message.as_deref(),
            )
        {
            breadcrumb.message = Some("[Filtered]".into());
        }

        // event.breadcrumbs[].data is BTreeMap<String, Value> — same pattern
        // as event.extra. This is the surface that carries Authorization
        // headers from HTTP breadcrumbs, which is the single most common
        // auth-leak vector on the Rust side.
        for (k, v) in breadcrumb.data.iter_mut() {
            if is_sensitive_key(k) {
                *v = Value::String("[Filtered]".into());
            } else {
                scrub_sensitive_in_value(v);
            }
        }
    }

    Some(event)
}

/// Initialize Sentry with the HQ scrubber and return the client guard.
///
/// The build-time values are read by the BINARY (where `build.rs` sets them via
/// `cargo:rustc-env=...`) and passed in here, so this crate stays free of
/// build-env coupling:
/// - `dsn_str`: `env!("SENTRY_DSN")` — empty string ⇒ Sentry no-ops (dev/PR CI).
/// - `release_version`: `env!("APP_VERSION")` — the shipped (package.json) version,
///   so crash reports and source maps line up.
/// - `environment`: `option_env!("SENTRY_ENVIRONMENT")` — defaults to `production`.
///
/// The caller must hold the returned guard for the process lifetime.
pub fn init(
    dsn_str: &str,
    release_version: &str,
    environment: Option<&str>,
) -> Option<sentry::ClientInitGuard> {
    init_with_identity(
        dsn_str,
        release_version,
        environment,
        SentryIdentity::default(),
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SentryIdentity<'a> {
    pub release_prefix: &'a str,
    pub repo: &'a str,
    pub app: &'a str,
    pub flavor: &'a str,
}

impl Default for SentryIdentity<'_> {
    fn default() -> Self {
        Self {
            release_prefix: "hq-sync",
            repo: "hq-sync",
            app: "hq-desktop-app",
            flavor: "sync",
        }
    }
}

/// Initialize Sentry with app/flavor-specific release and attribution tags.
pub fn init_with_identity(
    dsn_str: &str,
    release_version: &str,
    environment: Option<&str>,
    identity: SentryIdentity<'_>,
) -> Option<sentry::ClientInitGuard> {
    let dsn: Option<sentry::types::Dsn> = if dsn_str.is_empty() {
        None
    } else {
        Some(dsn_str.parse().expect("SENTRY_DSN invalid at build time"))
    };
    let guard = sentry::init(sentry::ClientOptions {
        dsn,
        release: Some(format!("{}@{release_version}", identity.release_prefix).into()),
        environment: Some(environment.unwrap_or("production").to_string().into()),
        sample_rate: std::env::var("SENTRY_SAMPLE_RATE")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(1.0),
        before_send: Some(std::sync::Arc::new(before_send)),
        // Release health: one session per app run (Application mode = whole process).
        auto_session_tracking: true,
        session_mode: sentry::SessionMode::Application,
        ..Default::default()
    });
    configure_identity_scope(identity);
    Some(guard)
}

/// Bind the process-wide attribution tags onto the current Sentry scope.
///
/// `build_commit` stamps the exact commit the binary was built from, so a
/// stable release carrying strictly older code (a silent content rollback) is
/// visible in a single Sentry event rather than hidden behind a version-only
/// release identity. Split out from `init_with_identity` so the tag wiring is
/// exercised directly by a captured-event test without a live client.
fn configure_identity_scope(identity: SentryIdentity<'_>) {
    sentry::configure_scope(|scope| {
        scope.set_tag("repo", identity.repo);
        scope.set_tag("app", identity.app);
        scope.set_tag("flavor", identity.flavor);
        scope.set_tag("build_commit", build_commit());
    });
}

/// The commit SHA the binary was built from, captured at compile time from the
/// `HQ_BUILD_COMMIT` build-time env the release workflow exports. Local and PR
/// builds do not set it, so they report the `"unknown"` sentinel — that is the
/// intended value, not an error.
fn build_commit() -> &'static str {
    resolve_build_commit(option_env!("HQ_BUILD_COMMIT"))
}

fn resolve_build_commit(value: Option<&'static str>) -> &'static str {
    match value {
        Some(commit) if !commit.is_empty() => commit,
        _ => "unknown",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sentry::protocol::{AppContext, Breadcrumb, Request, RuntimeContext};

    // Most scrubber tests are intentionally independent of the process-global
    // native diagnostics. Keep their existing assertions deterministic while
    // the dedicated entry-point tests below exercise `super::before_send`.
    fn before_send(event: Event<'static>) -> Option<Event<'static>> {
        before_send_with_native_context(event, NativePanicPhase::Running, 0)
    }

    // 1. Case-insensitive is_sensitive_key
    #[test]
    fn test_is_sensitive_key_case_insensitive() {
        assert!(is_sensitive_key("Authorization"));
        assert!(is_sensitive_key("AUTHORIZATION"));
        assert!(is_sensitive_key("authorization"));
        assert!(is_sensitive_key("Password"));
        assert!(is_sensitive_key("SECRET"));
        assert!(is_sensitive_key("token"));
        assert!(is_sensitive_key("apikey"));
        assert!(is_sensitive_key("api_key"));
        assert!(!is_sensitive_key("x-api-key"));
        assert!(!is_sensitive_key("url"));
        assert!(!is_sensitive_key("note"));
    }

    #[test]
    fn test_default_identity_keeps_legacy_sync_release() {
        let identity = SentryIdentity::default();
        assert_eq!(identity.release_prefix, "hq-sync");
        assert_eq!(identity.repo, "hq-sync");
        assert_eq!(identity.app, "hq-desktop-app");
        assert_eq!(identity.flavor, "sync");
    }

    #[test]
    fn resolve_build_commit_uses_the_sha_when_present() {
        assert_eq!(
            resolve_build_commit(Some("b8e74e289d845c45c612cb99d4758202d22b6599")),
            "b8e74e289d845c45c612cb99d4758202d22b6599",
        );
    }

    #[test]
    fn resolve_build_commit_falls_back_to_unknown_when_absent_or_empty() {
        // A local or PR build never sets HQ_BUILD_COMMIT (None); a misconfigured
        // export could set it empty. Both degrade to the documented sentinel.
        assert_eq!(resolve_build_commit(None), "unknown");
        assert_eq!(resolve_build_commit(Some("")), "unknown");
    }

    #[test]
    fn identity_scope_carries_build_commit_tag() {
        let events = sentry::test::with_captured_events(|| {
            configure_identity_scope(SentryIdentity::default());
            sentry::capture_message("build-commit-probe", sentry::Level::Info);
        });

        assert_eq!(events.len(), 1);
        let tags = &events[0].tags;
        assert!(
            tags.contains_key("build_commit"),
            "identity scope must carry a build_commit tag"
        );
        // HQ_BUILD_COMMIT is unset under `cargo test`, so the sentinel applies.
        assert_eq!(tags["build_commit"], "unknown");
        // The pre-existing attribution tags are unchanged by the addition.
        assert_eq!(tags["app"], "hq-desktop-app");
        assert_eq!(tags["repo"], "hq-sync");
        assert_eq!(tags["flavor"], "sync");
    }

    // 2. Header strip
    #[test]
    fn test_header_strip() {
        let mut event = Event::default();
        let mut request = Request::default();
        request
            .headers
            .insert("Authorization".to_string(), "Bearer xyz".to_string());
        request
            .headers
            .insert("X-Trace".to_string(), "keep".to_string());
        event.request = Some(request);

        let result = before_send(event).unwrap();
        let headers = &result.request.unwrap().headers;
        assert_eq!(headers["Authorization"], "[Filtered]");
        assert_eq!(headers["X-Trace"], "keep");
    }

    // 3. Extra top-level redact
    #[test]
    fn test_extra_top_level_redact() {
        let mut event = Event::default();
        event
            .extra
            .insert("token".to_string(), Value::String("abc".into()));
        event
            .extra
            .insert("note".to_string(), Value::String("ok".into()));

        let result = before_send(event).unwrap();
        assert_eq!(result.extra["token"], Value::String("[Filtered]".into()));
        assert_eq!(result.extra["note"], Value::String("ok".into()));
    }

    // 4. Extra nested redact
    #[test]
    fn test_extra_nested_redact() {
        let mut event = Event::default();
        let mut inner = serde_json::Map::new();
        inner.insert("password".to_string(), Value::String("x".into()));
        inner.insert("ok".to_string(), Value::String("y".into()));
        event
            .extra
            .insert("payload".to_string(), Value::Object(inner));

        let result = before_send(event).unwrap();
        if let Value::Object(inner) = &result.extra["payload"] {
            assert_eq!(inner["password"], Value::String("[Filtered]".into()));
            assert_eq!(inner["ok"], Value::String("y".into()));
        } else {
            panic!("expected object");
        }
    }

    // 5. Breadcrumb data strip
    #[test]
    fn test_breadcrumb_data_strip() {
        let mut event = Event::default();
        let mut breadcrumb = Breadcrumb::default();
        breadcrumb.data.insert(
            "authorization".to_string(),
            Value::String("Bearer leak".into()),
        );
        breadcrumb
            .data
            .insert("url".to_string(), Value::String("/api".into()));
        event.breadcrumbs.values.push(breadcrumb);

        let result = before_send(event).unwrap();
        let data = &result.breadcrumbs.values[0].data;
        assert_eq!(data["authorization"], Value::String("[Filtered]".into()));
        assert_eq!(data["url"], Value::String("/api".into()));
    }

    #[test]
    fn test_daemon_stderr_breadcrumb_message_is_filtered() {
        let private_path = r"C:\Users\Ada\hq\companies\personal\secret-plan.md";
        let raw_message = format!(
            "EPERM: operation not permitted, rename '{private_path}.hq-tmp-a1b2' -> '{private_path}'"
        );
        let mut event = Event::default();
        event.breadcrumbs.values.push(Breadcrumb {
            category: Some("daemon.stderr".into()),
            level: sentry::Level::Warning,
            message: Some(raw_message.clone()),
            ..Default::default()
        });

        let result = before_send(event).expect("event remains sendable");
        let serialized = serde_json::to_string(&result).expect("serialize scrubbed event");

        assert_eq!(
            result.breadcrumbs.values[0].message.as_deref(),
            Some("[Filtered]")
        );
        assert!(!serialized.contains("secret-plan.md"));
        assert!(!serialized.contains("hq-tmp-a1b2"));
        assert!(!serialized.contains("operation not permitted"));
        assert!(!serialized.contains(&raw_message));
    }

    #[test]
    fn test_runner_stderr_breadcrumb_message_is_filtered() {
        let raw_message = "EPERM: operation not permitted, rename 'C:\\Users\\Ada\\secret-plan.md.hq-tmp-a1b2' -> 'C:\\Users\\Ada\\secret-plan.md'";
        let mut event = Event::default();
        event.breadcrumbs.values.push(Breadcrumb {
            category: Some("runner.stderr".into()),
            level: sentry::Level::Warning,
            message: Some(raw_message.into()),
            ..Default::default()
        });

        let result = before_send(event).expect("event remains sendable");
        let serialized = serde_json::to_string(&result).expect("serialize scrubbed event");

        assert_eq!(
            result.breadcrumbs.values[0].message.as_deref(),
            Some("[Filtered]")
        );
        assert!(!serialized.contains("secret-plan.md"));
        assert!(!serialized.contains("operation not permitted"));
        assert!(!serialized.contains("hq-tmp"));
    }

    #[test]
    fn test_classified_runner_stderr_breadcrumb_message_is_preserved() {
        let mut event = Event::default();
        for (sequence, class) in [
            "eperm", "eacces", "enospc", "ebusy", "network", "auth", "other",
        ]
        .into_iter()
        .enumerate()
        {
            event.breadcrumbs.values.push(Breadcrumb {
                category: Some("runner.stderr".into()),
                message: Some(format!("runner stderr #{} ({class})", sequence + 1)),
                ..Default::default()
            });
        }

        let result = before_send(event).expect("event remains sendable");
        assert!(result
            .breadcrumbs
            .values
            .iter()
            .all(|breadcrumb| breadcrumb.message.as_deref() != Some("[Filtered]")));
        assert_eq!(
            result.breadcrumbs.values.last().unwrap().message.as_deref(),
            Some("runner stderr #7 (other)")
        );
    }

    #[test]
    fn test_fatal_classified_runner_stderr_breadcrumb_message_is_preserved() {
        let mut event = Event::default();
        for (sequence, fatal_class) in [
            "libuv_assert",
            "node_fatal",
            "heap_oom",
            "rust_panic",
            "exec_permission_denied",
            "exec_not_found",
            "node_too_old",
            "none",
        ]
        .into_iter()
        .enumerate()
        {
            event.breadcrumbs.values.push(Breadcrumb {
                category: Some("runner.stderr".into()),
                message: Some(format!(
                    "runner stderr #{} (other;{fatal_class})",
                    sequence + 1
                )),
                ..Default::default()
            });
        }

        let result = before_send(event).expect("event remains sendable");
        assert!(result
            .breadcrumbs
            .values
            .iter()
            .all(|breadcrumb| breadcrumb.message.as_deref() != Some("[Filtered]")));
        assert_eq!(
            result.breadcrumbs.values[0].message.as_deref(),
            Some("runner stderr #1 (other;libuv_assert)")
        );
    }

    #[test]
    fn every_emitter_error_and_fatal_token_round_trips_through_the_content_safe_allowlist() {
        use hq_desktop_core::sync_outcome::{RunnerErrorClass, RunnerFatalClass};

        // Enumerate the emitter's OWN token set — never a hand-copied list — so the
        // allowlist can never silently drift behind it again. Every error-class
        // breadcrumb token (auth renamed to identity) crossed with every fatal
        // token, including the previously-missing node_check_abort, must survive.
        for error_class in RunnerErrorClass::ALL {
            for fatal_class in RunnerFatalClass::ALL {
                let message = format!(
                    "runner stderr #1 ({};{})",
                    error_class.breadcrumb_token(),
                    fatal_class.as_str()
                );
                assert!(
                    is_content_safe_runner_stderr_message(Some("runner.stderr"), Some(&message)),
                    "emitter token pair rejected by allowlist: {message}"
                );
            }
        }

        // The exact drift this fix closes: node_check_abort was missing.
        assert!(is_content_safe_runner_stderr_message(
            Some("runner.stderr"),
            Some("runner stderr #1 (other;node_check_abort)")
        ));
        // The legacy `auth` spelling stays sendable so in-flight older clients
        // (still emitting it) are not blanked by our own before_send …
        assert!(is_content_safe_runner_stderr_message(
            Some("runner.stderr"),
            Some("runner stderr #7245 (auth;none)")
        ));
        // … alongside the new denylist-safe `identity` spelling.
        assert!(is_content_safe_runner_stderr_message(
            Some("runner.stderr"),
            Some("runner stderr #7245 (identity;none)")
        ));
        // HQ-DESKTOP-5D: the disk_full fatal token must validate in both the
        // ENOSPC-error and the ordinary-line breadcrumb spellings, or the fix's
        // new attribution would be blanked before it left the machine.
        assert!(is_content_safe_runner_stderr_message(
            Some("runner.stderr"),
            Some("runner stderr #2 (enospc;disk_full)")
        ));
        assert!(is_content_safe_runner_stderr_message(
            Some("runner.stderr"),
            Some("runner stderr #3 (other;disk_full)")
        ));
    }

    #[test]
    fn no_emitter_breadcrumb_token_contains_a_sentry_denylist_substring() {
        use hq_desktop_core::sync_outcome::{RunnerErrorClass, RunnerFatalClass};

        // The guard that would have caught the destroyed HQ-DESKTOP-4T breadcrumb
        // at authoring time: no token the breadcrumb renderer can emit may contain
        // a substring Sentry's default scrubber denylists, or before_send and the
        // server-side @password:filter would blank the breadcrumb outright.
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
        let tokens = RunnerErrorClass::ALL
            .into_iter()
            .map(|class| class.breadcrumb_token())
            .chain(
                RunnerFatalClass::ALL
                    .into_iter()
                    .map(|fatal| fatal.as_str()),
            );
        for token in tokens {
            for denied in DENYLIST {
                assert!(
                    !token.contains(denied),
                    "emitter breadcrumb token {token:?} contains Sentry denylist substring {denied:?}"
                );
            }
        }
    }

    #[test]
    fn every_libuv_fatal_syscall_token_survives_the_egress_shape_check() {
        use hq_desktop_core::sync_outcome::LIBUV_FATAL_SYSCALLS;
        // Enumerate the emitter's OWN allow-list so the independent egress shape
        // check can never drift behind a newly-added syscall and blank a real tag.
        for syscall in LIBUV_FATAL_SYSCALLS {
            assert_eq!(
                valid_runner_diagnostic_field("runner_fatal_syscall", syscall),
                Some(true),
                "allow-listed syscall {syscall:?} must survive egress"
            );
        }
        assert_eq!(
            valid_runner_diagnostic_field("runner_fatal_syscall", "other"),
            Some(true)
        );
        // A raw path / stderr fragment must never survive.
        assert_eq!(
            valid_runner_diagnostic_field(
                "runner_fatal_syscall",
                "ReadDirectoryChangesW: (5) /Users/Ada/secret.md"
            ),
            Some(false)
        );
    }

    #[test]
    fn every_windows_teardown_probe_token_survives_and_lookalikes_fail_closed() {
        use hq_desktop_core::sync_outcome::{
            SessionEndLatchReading, TeardownLogClass, TeardownLogReading, TeardownShuttingDown,
            WindowsTeardownVerdict,
        };
        // Drive the accepted set from the producer's OWN vocabulary so the egress
        // check can never drift behind a newly-added token and blank a real value.
        for token in [
            WindowsTeardownVerdict::Confirmed.class_name(),
            WindowsTeardownVerdict::Absent.class_name(),
            WindowsTeardownVerdict::Unknown.class_name(),
        ] {
            assert_eq!(
                valid_runner_diagnostic_field("windows_teardown_probe_verdict", token),
                Some(true),
                "verdict token {token:?} must survive egress"
            );
        }
        for token in [
            TeardownShuttingDown::Yes.class_name(),
            TeardownShuttingDown::No.class_name(),
            TeardownShuttingDown::Unavailable.class_name(),
        ] {
            assert_eq!(
                valid_runner_diagnostic_field("windows_teardown_probe_shuttingdown", token),
                Some(true),
                "shuttingdown token {token:?} must survive egress"
            );
        }
        for token in [
            TeardownLogReading::Record(TeardownLogClass::User32Initiated).class_name(),
            TeardownLogReading::Record(TeardownLogClass::KernelGeneral).class_name(),
            TeardownLogReading::Record(TeardownLogClass::KernelPower).class_name(),
            TeardownLogReading::None.class_name(),
            TeardownLogReading::Unavailable.class_name(),
        ] {
            assert_eq!(
                valid_runner_diagnostic_field("windows_teardown_probe_log", token),
                Some(true),
                "log token {token:?} must survive egress"
            );
        }

        // Durable session-end latch (HQ-DESKTOP r3): every producer token must
        // survive egress, driven from the producer's OWN vocabulary so the check
        // can never fall behind a newly-added state.
        for token in [
            SessionEndLatchReading::Latched.class_name(),
            SessionEndLatchReading::Absent.class_name(),
            SessionEndLatchReading::Unavailable.class_name(),
        ] {
            assert_eq!(
                valid_runner_diagnostic_field("session_end_latch", token),
                Some(true),
                "latch token {token:?} must survive egress"
            );
        }

        // Raw event-log text — the exact leak the allowlist exists to stop — must
        // fail closed on every one of the probe keys AND the latch key.
        let leak = r"1074: shutdown.exe (DESKTOP-QOH7J4N) by Ada at C:\Windows";
        for key in [
            "windows_teardown_probe_verdict",
            "windows_teardown_probe_shuttingdown",
            "windows_teardown_probe_log",
            "session_end_latch",
        ] {
            assert_eq!(
                valid_runner_diagnostic_field(key, leak),
                Some(false),
                "{key} must reject raw event-log text"
            );
        }
    }

    #[test]
    fn every_watcher_fault_token_survives_and_lookalikes_fail_closed() {
        use hq_desktop_core::watcher_fault::{
            UnmatchedStderrShape, WatcherFaultBinary, WatcherFaultProvenance,
            WATCHER_FAULT_UNAVAILABLE,
        };
        // Cross-crate anti-drift: enumerate the emitter's OWN vocabularies so the
        // independent egress checks can never fall behind a newly-added token and
        // blank a real attribution tag.
        for binary in WatcherFaultBinary::ALL {
            for key in ["watcher_fault_faulting_image", "watcher_fault_faulting_module"] {
                assert_eq!(
                    valid_runner_diagnostic_field(key, binary.as_str()),
                    Some(true),
                    "allow-listed binary {:?} must survive egress on {key}",
                    binary.as_str()
                );
            }
        }
        for key in ["watcher_fault_faulting_image", "watcher_fault_faulting_module"] {
            assert_eq!(
                valid_runner_diagnostic_field(key, WATCHER_FAULT_UNAVAILABLE),
                Some(true)
            );
        }
        for provenance in WatcherFaultProvenance::ALL {
            assert_eq!(
                valid_runner_diagnostic_field("watcher_fault_provenance", provenance.as_str()),
                Some(true),
                "provenance {:?} must survive egress",
                provenance.as_str()
            );
        }
        for shape in UnmatchedStderrShape::ALL {
            assert_eq!(
                valid_runner_diagnostic_field(
                    "runner_unmatched_stderr_shapes",
                    &format!("{}:7", shape.as_str())
                ),
                Some(true),
                "shape {:?} must survive egress",
                shape.as_str()
            );
        }
        assert_eq!(
            valid_runner_diagnostic_field("watcher_fault_exception_code", "3221226505"),
            Some(true)
        );
        assert_eq!(
            valid_runner_diagnostic_field("watcher_fault_offset", "172467"),
            Some(true)
        );

        // The resolved read-counters rollup survives, including the all-zero form.
        for value in [
            "seen:0,parsed:0,rej_win:0,rej_code:0,sweeps:0,ms:0",
            "seen:3,parsed:2,rej_win:2,rej_code:0,sweeps:5,ms:8123",
        ] {
            assert_eq!(
                valid_runner_diagnostic_field("watcher_fault_read", value),
                Some(true),
                "read-counters rollup {value:?} must survive egress"
            );
        }
        // The job-image descriptor: allow-listed set, candidate, and its own
        // tree-observation provenance token (never a fault-attribution token).
        for binary in WatcherFaultBinary::ALL {
            assert_eq!(
                valid_runner_diagnostic_field("watcher_fault_job_images", binary.as_str()),
                Some(true),
                "job image {:?} must survive egress",
                binary.as_str()
            );
        }
        assert_eq!(
            valid_runner_diagnostic_field("watcher_fault_job_images", "node_exe,npx_cmd,cmd_exe"),
            Some(true)
        );
        assert_eq!(
            valid_runner_diagnostic_field("watcher_fault_job_culprit_candidate", "node_exe"),
            Some(true)
        );
        assert_eq!(
            valid_runner_diagnostic_field(
                "watcher_fault_job_culprit_candidate",
                WATCHER_FAULT_UNAVAILABLE
            ),
            Some(true)
        );
        for value in ["job_tree_observed", "unavailable"] {
            assert_eq!(
                valid_runner_diagnostic_field("watcher_fault_job_image_provenance", value),
                Some(true)
            );
        }

        // Fail-closed: a producer bug that shipped a path, product string, hex,
        // sign, or an unknown token must be rejected so it degrades to [Filtered].
        for (key, value) in [
            ("watcher_fault_provenance", "pid_matched;/Users/Ada"),
            ("watcher_fault_provenance", "no_record"), // the retired ambiguous token
            ("watcher_fault_faulting_image", r"C:\Users\Ada\node.exe"),
            ("watcher_fault_faulting_module", "kernelbase"),
            ("watcher_fault_exception_code", "0xC0000409"),
            ("watcher_fault_exception_code", "-5"),
            ("watcher_fault_offset", "2a1b3"),
            ("runner_unmatched_stderr_shapes", "ndjson_record:6,/Users/Ada:1"),
            ("runner_unmatched_stderr_shapes", "not_a_shape:1"),
            ("watcher_fault_read", "seen:0,parsed:0"), // truncated rollup
            ("watcher_fault_read", "seen:0,parsed:0,rej_win:0,rej_code:0,sweeps:0,ms:0xff"),
            ("watcher_fault_read", "parsed:0,seen:0,rej_win:0,rej_code:0,sweeps:0,ms:0"), // reordered
            ("watcher_fault_job_images", r"node_exe,C:\Users\Ada\x.exe"),
            ("watcher_fault_job_culprit_candidate", "cmd"),
            ("watcher_fault_job_image_provenance", "pid_matched"),
        ] {
            assert_eq!(
                valid_runner_diagnostic_field(key, value),
                Some(false),
                "lookalike {key}={value:?} must fail closed"
            );
        }
    }

    #[test]
    fn every_runner_error_rollup_token_survives_and_lookalikes_fail_closed() {
        use hq_desktop_core::runner_error_shape::{
            RunnerErrorCause, RunnerErrorHttpStatus, RunnerErrorShape, RunnerErrorSite, RunnerPathRoot,
        };
        // Cross-crate anti-drift: enumerate each producer's OWN token set and
        // assert every rendered `token:count` survives the independent egress
        // check. A producer that adds a variant without updating the mirrored
        // vocabulary here fails CI instead of silently blanking a live tag.
        let http: Vec<&str> = RunnerErrorHttpStatus::ALL.iter().map(|s| s.as_str()).collect();
        let causes: Vec<&str> = RunnerErrorCause::ALL.iter().map(|c| c.as_str()).collect();
        let shapes: Vec<&str> = RunnerErrorShape::ALL.iter().map(|s| s.as_str()).collect();
        let path_roots: Vec<&str> = RunnerPathRoot::ALL.iter().map(|p| p.as_str()).collect();
        let sites: Vec<&str> = RunnerErrorSite::ALL.iter().map(|s| s.as_str()).collect();
        for (key, tokens) in [
            ("runner_error_http", &http),
            ("runner_error_causes", &causes),
            ("runner_error_shapes", &shapes),
            ("runner_error_path_roots", &path_roots),
            ("runner_error_sites", &sites),
        ] {
            for token in tokens.iter() {
                assert_eq!(
                    valid_runner_diagnostic_field(key, &format!("{token}:7")),
                    Some(true),
                    "producer token {token:?} must survive egress on {key}"
                );
            }
        }

        // The cause-signature axis is a `hex12:count` rollup, not a closed
        // vocabulary — a valid lowercase-12-hex signature survives egress.
        for good in ["1a2b3c4d5e6f:7", "00ff11ee22dd:1,abcdefabcdef:9"] {
            assert_eq!(
                valid_runner_diagnostic_field("runner_error_cause_signature", good),
                Some(true),
                "valid cause-signature rollup must survive egress: {good:?}"
            );
        }

        // Fail-closed: an off-vocabulary token, a non-numeric count, a raw path
        // or message fragment, and an over-length value must all be rejected so a
        // producer bug degrades to [Filtered] instead of shipping runner bytes.
        let overlong = format!("http_403:{}", "9".repeat(200));
        for (key, value) in [
            ("runner_error_http", "http_403:12,not_a_status:1"),
            ("runner_error_http", "http_403:x"),
            ("runner_error_causes", "access_denied:1,/Users/Ada/secret:1"),
            ("runner_error_causes", "unknown:1"), // the retired flat residual is no longer emitted
            ("runner_error_shapes", "presigned_get_failed:9,knowledge/a.md:1"),
            ("runner_error_path_roots", "companies:1,cognito-abc:1"),
            // The site axis: the raw producer `path` sentinel (parens, hyphen) is
            // NOT an as_str token, so it must fail closed rather than ship a byte.
            ("runner_error_sites", "file:1,(runner):1"),
            ("runner_error_sites", "local-state:1"),
            ("runner_error_http", overlong.as_str()),
            // Signature axis: only a bare lowercase-12-hex key is permitted, so a
            // raw identity, an uppercase digest, a wrong length, or a bad count
            // must all fail closed rather than ship a runner byte.
            ("runner_error_cause_signature", "VaultNotFoundError:1"),
            ("runner_error_cause_signature", "1A2B3C4D5E6F:1"),
            ("runner_error_cause_signature", "1a2b3c:1"),
            ("runner_error_cause_signature", "1a2b3c4d5e6f7:1"),
            ("runner_error_cause_signature", "1a2b3c4d5e6f:x"),
        ] {
            assert_eq!(
                valid_runner_diagnostic_field(key, value),
                Some(false),
                "lookalike {key}={value:?} must fail closed"
            );
        }
    }

    #[test]
    fn cause_rollup_fingerprint_tokens_are_egress_safe_across_crates() {
        use hq_desktop_core::runner_error_shape::{RunnerErrorCause, RunnerErrorCauseRollup};
        // The r3 fingerprint addition: RunnerErrorCauseRollup::fingerprint_token is
        // a NEW producer of a Sentry group token. It returns RunnerErrorCause::as_str
        // of the dominant cause, so the full domain of tokens it can emit is exactly
        // RunnerErrorCause::ALL's as_str set — every one of which the independent
        // runner_error_causes egress mirror must already accept. Pinning it here
        // fails a future cause that slips the mirror instead of shipping a raw byte.
        let allowed: std::collections::HashSet<&str> =
            RUNNER_ERROR_CAUSE_TOKENS.iter().copied().collect();
        for cause in RunnerErrorCause::ALL {
            let token = cause.as_str();
            assert!(
                allowed.contains(token),
                "cause fingerprint token {token:?} is missing from the egress allow-list"
            );
            assert_eq!(
                valid_runner_diagnostic_field("runner_error_causes", &format!("{token}:3")),
                Some(true),
                "cause fingerprint token {token:?} must survive egress"
            );
        }
        // The producer path: a concrete rollup's dominant token is an allow-listed
        // value, and the empty-rollup sentinel is the fixed literal "none".
        let mut rollup = RunnerErrorCauseRollup::default();
        rollup.record("VaultPermissionDeniedError permission denied for the company prefix");
        assert_eq!(rollup.fingerprint_token(), "vault_permission_denied");
        assert!(allowed.contains(rollup.fingerprint_token()));
        assert_eq!(RunnerErrorCauseRollup::default().fingerprint_token(), "none");
    }

    #[test]
    fn site_rollup_fingerprint_tokens_are_egress_safe_across_crates() {
        use hq_desktop_core::runner_error_shape::{RunnerErrorSite, RunnerErrorSiteRollup};
        // HQ-DESKTOP-5M: RunnerErrorSiteRollup::fingerprint_token is a NEW producer
        // of the sixth Sentry group token. It returns RunnerErrorSite::as_str of the
        // dominant site, so its full emit domain is exactly RunnerErrorSite::ALL's
        // as_str set — every one of which the independent runner_error_sites egress
        // mirror must accept. Pinning it fails a future site that slips the mirror.
        let allowed: std::collections::HashSet<&str> =
            RUNNER_ERROR_SITE_TOKENS.iter().copied().collect();
        for site in RunnerErrorSite::ALL {
            let token = site.as_str();
            assert!(
                allowed.contains(token),
                "site fingerprint token {token:?} is missing from the egress allow-list"
            );
            assert_eq!(
                valid_runner_diagnostic_field("runner_error_sites", &format!("{token}:3")),
                Some(true),
                "site fingerprint token {token:?} must survive egress"
            );
        }
        // The producer path: a concrete rollup's dominant token is an allow-listed
        // value, and the empty-rollup sentinel is the fixed literal "none".
        let mut rollup = RunnerErrorSiteRollup::default();
        rollup.record("(local-state)");
        assert_eq!(rollup.fingerprint_token(), "local_state");
        assert!(allowed.contains(rollup.fingerprint_token()));
        assert_eq!(RunnerErrorSiteRollup::default().fingerprint_token(), "none");
    }

    #[test]
    fn runner_error_rollups_survive_before_send_and_malformed_is_filtered() {
        use hq_desktop_core::runner_error_shape::{
            RunnerErrorCause, RunnerErrorHttpStatus, RunnerErrorShape, RunnerPathRoot,
        };
        // The plan's companion check: drive every producer variant through a
        // rendered rollup tag and the real before_send, asserting each survives.
        let per_key: [(&str, Vec<String>); 4] = [
            (
                "runner_error_http",
                RunnerErrorHttpStatus::ALL.iter().map(|s| format!("{}:3", s.as_str())).collect(),
            ),
            (
                "runner_error_causes",
                RunnerErrorCause::ALL.iter().map(|c| format!("{}:3", c.as_str())).collect(),
            ),
            (
                "runner_error_shapes",
                RunnerErrorShape::ALL.iter().map(|s| format!("{}:3", s.as_str())).collect(),
            ),
            (
                "runner_error_path_roots",
                RunnerPathRoot::ALL.iter().map(|p| format!("{}:3", p.as_str())).collect(),
            ),
        ];
        for (key, values) in &per_key {
            for value in values {
                let mut event = Event::default();
                event.tags.insert(key.to_string(), value.clone());
                let result = before_send(event).expect("event remains sendable");
                assert_eq!(
                    result.tags[*key], *value,
                    "before_send filtered a valid producer token: {key}={value}"
                );
            }
        }

        // A realistic multi-token value on each axis survives together — including
        // the completed cause vocabulary's residual tokens and the signature axis.
        let mut event = Event::default();
        event.tags.insert("runner_error_http".into(), "http_500:40,http_403:8".into());
        event
            .tags
            .insert("runner_error_causes".into(), "unknown_unnamed:160,vault_not_found:8".into());
        event.tags.insert("runner_error_shapes".into(), "containment_escape:120,unknown:8".into());
        event.tags.insert("runner_error_path_roots".into(), "knowledge:120,repos:40".into());
        event
            .tags
            .insert("runner_error_cause_signature".into(), "1a2b3c4d5e6f:9,00ff11ee22dd:2".into());
        let survived = before_send(event).expect("event remains sendable");
        assert_eq!(survived.tags["runner_error_http"], "http_500:40,http_403:8");
        assert_eq!(survived.tags["runner_error_causes"], "unknown_unnamed:160,vault_not_found:8");
        assert_eq!(survived.tags["runner_error_shapes"], "containment_escape:120,unknown:8");
        assert_eq!(survived.tags["runner_error_path_roots"], "knowledge:120,repos:40");
        assert_eq!(
            survived.tags["runner_error_cause_signature"],
            "1a2b3c4d5e6f:9,00ff11ee22dd:2"
        );

        // An off-vocabulary value degrades to [Filtered] instead of shipping, on
        // both the cause axis and the signature axis.
        let mut leaky = Event::default();
        leaky.tags.insert("runner_error_causes".into(), "not_a_cause:1".into());
        leaky
            .tags
            .insert("runner_error_cause_signature".into(), "VaultNotFoundError:1".into());
        let filtered = before_send(leaky).expect("event remains sendable");
        assert_eq!(filtered.tags["runner_error_causes"], "[Filtered]");
        assert_eq!(filtered.tags["runner_error_cause_signature"], "[Filtered]");
    }

    #[test]
    fn watcher_fault_fields_survive_and_malformed_fail_closed_before_send() {
        let mut event = Event::default();
        for (key, value) in [
            ("watcher_fault_provenance", "pid_matched"),
            ("watcher_fault_faulting_image", "node_exe"),
            ("watcher_fault_faulting_module", "ntdll_dll"),
            (
                "runner_unmatched_stderr_shapes",
                "ndjson_record:6,stack_frame:2",
            ),
        ] {
            event.tags.insert(key.to_string(), value.to_string());
        }
        event.extra.insert(
            "watcher_fault_exception_code".to_string(),
            Value::String("3221226505".to_string()),
        );
        event.extra.insert(
            "watcher_fault_offset".to_string(),
            Value::String("172467".to_string()),
        );
        // A watcher-route line count as a bare number is content-safe by type.
        event
            .extra
            .insert("runner_stderr_line_count".to_string(), Value::Number(8.into()));

        let result = before_send(event).expect("event remains sendable");
        assert_eq!(result.tags["watcher_fault_provenance"], "pid_matched");
        assert_eq!(result.tags["watcher_fault_faulting_image"], "node_exe");
        assert_eq!(result.tags["watcher_fault_faulting_module"], "ntdll_dll");
        assert_eq!(
            result.tags["runner_unmatched_stderr_shapes"],
            "ndjson_record:6,stack_frame:2"
        );
        assert_eq!(
            result.extra["watcher_fault_exception_code"],
            Value::String("3221226505".to_string())
        );
        assert_eq!(
            result.extra["runner_stderr_line_count"],
            Value::Number(8.into())
        );

        // A poisoned producer value degrades to [Filtered] rather than shipping.
        // Non-path lookalikes so only the runner-diagnostic scrubber is exercised.
        let mut bad = Event::default();
        bad.tags.insert(
            "watcher_fault_faulting_image".to_string(),
            "kernelbase".to_string(),
        );
        bad.extra.insert(
            "watcher_fault_exception_code".to_string(),
            Value::String("0xC0000409".to_string()),
        );
        let result = before_send(bad).expect("event remains sendable");
        assert_eq!(result.tags["watcher_fault_faulting_image"], "[Filtered]");
        assert_eq!(
            result.extra["watcher_fault_exception_code"],
            Value::String("[Filtered]".to_string())
        );
    }

    #[test]
    fn test_runner_stderr_fixed_vocabulary_lookalikes_are_filtered() {
        let mut event = Event::default();
        for message in [
            "runner stderr #x (eperm)",
            "runner stderr #1 (EPERM)",
            "runner stderr #1 (unknown)",
            "runner stderr #1 (eperm) secret-plan.md",
            "runner stderr #1 (other;libuv_assert) secret-plan.md",
        ] {
            event.breadcrumbs.values.push(Breadcrumb {
                category: Some("runner.stderr".into()),
                message: Some(message.into()),
                ..Default::default()
            });
        }

        let result = before_send(event).expect("event remains sendable");
        assert!(result
            .breadcrumbs
            .values
            .iter()
            .all(|breadcrumb| breadcrumb.message.as_deref() == Some("[Filtered]")));
    }

    #[test]
    fn test_unenumerated_stderr_stream_breadcrumb_message_is_filtered() {
        let mut event = Event::default();
        for category in ["stderr", "stdout", "sidecar.stderr", "sidecar.stdout"] {
            event.breadcrumbs.values.push(Breadcrumb {
                category: Some(category.into()),
                message: Some(format!("future producer raw output from {category}")),
                ..Default::default()
            });
        }

        let result = before_send(event).expect("event remains sendable");
        assert!(result
            .breadcrumbs
            .values
            .iter()
            .all(|breadcrumb| breadcrumb.message.as_deref() == Some("[Filtered]")));
    }

    #[test]
    fn test_non_stream_breadcrumb_message_is_preserved() {
        let mut event = Event::default();
        event.breadcrumbs.values.push(Breadcrumb {
            category: Some("daemon.lifecycle".into()),
            message: Some("watcher started".into()),
            ..Default::default()
        });

        let result = before_send(event).expect("event remains sendable");
        assert_eq!(
            result.breadcrumbs.values[0].message.as_deref(),
            Some("watcher started")
        );
    }

    #[test]
    fn test_public_native_panic_entry_points_materialize_one_static_seam() {
        let _guard = NATIVE_PANIC_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        reset_native_panic_context_for_test();

        record_native_panic_seam(NativePanicSeam::TrayLeftClick);
        let event = super::before_send(Event::default()).expect("event remains sendable");
        let breadcrumbs: Vec<_> = event
            .breadcrumbs
            .values
            .iter()
            .filter(|breadcrumb| breadcrumb.category.as_deref() == Some(UI_SEAM_CATEGORY))
            .collect();

        assert_eq!(breadcrumbs.len(), 1);
        assert_eq!(breadcrumbs[0].message.as_deref(), Some("tray.left-click"));
        assert!(breadcrumbs[0].data.is_empty());

        reset_native_panic_context_for_test();
    }

    #[test]
    fn test_public_native_panic_entry_points_bound_history_to_latest_eight() {
        let _guard = NATIVE_PANIC_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        reset_native_panic_context_for_test();

        for seam in [
            NativePanicSeam::TrayLeftClick,
            NativePanicSeam::TrayBlurHide,
            NativePanicSeam::GlobalShortcutTogglePopover,
            NativePanicSeam::GlobalShortcutToggleDesktop,
            NativePanicSeam::WindowCloseRequestedHide,
            NativePanicSeam::WindowThemeChanged,
            NativePanicSeam::WindowForceForeground,
            NativePanicSeam::SingleInstanceSurfaceExisting,
            NativePanicSeam::AppExitRequested,
        ] {
            record_native_panic_seam(seam);
        }

        let event = super::before_send(Event::default()).expect("event remains sendable");
        let messages: Vec<_> = event
            .breadcrumbs
            .values
            .iter()
            .filter(|breadcrumb| breadcrumb.category.as_deref() == Some(UI_SEAM_CATEGORY))
            .map(|breadcrumb| breadcrumb.message.as_deref())
            .collect();

        assert_eq!(
            messages,
            vec![
                Some("tray.blur-hide"),
                Some("global-shortcut.toggle-popover"),
                Some("global-shortcut.toggle-desktop"),
                Some("window.close-requested-hide"),
                Some("window.theme-changed"),
                Some("window-focus.force-foreground"),
                Some("single-instance.surface-existing"),
                Some("app.exit-requested"),
            ]
        );

        reset_native_panic_context_for_test();
    }

    // The Windows session-end exit arm calls this from inside a window
    // procedure, where a block past the deadline is a force-kill and a panic is
    // a process abort. Both properties are asserted, not assumed.
    #[test]
    fn test_flush_within_returns_inside_deadline_with_no_client_configured() {
        let deadline = std::time::Duration::from_millis(250);
        let started = std::time::Instant::now();

        // No `ClientInitGuard` is bound on this thread's hub, which is exactly
        // the shape of a build with an empty DSN.
        assert!(sentry::Hub::current().client().is_none());
        assert!(super::flush_within(deadline));

        assert!(
            started.elapsed() < deadline * 4,
            "flush_within must not block past its deadline"
        );
    }

    #[test]
    fn test_public_native_panic_phase_follows_lifecycle_setter() {
        let _guard = NATIVE_PANIC_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        reset_native_panic_context_for_test();

        for (phase, expected) in [
            (NativePanicPhase::Running, "running"),
            (NativePanicPhase::Exiting, "exiting"),
            (NativePanicPhase::Destroyed, "destroyed"),
        ] {
            set_native_panic_phase(phase);
            let event = super::before_send(Event::default()).expect("event remains sendable");
            assert_eq!(
                event.tags.get(NATIVE_PANIC_PHASE_TAG).map(String::as_str),
                Some(expected)
            );
        }

        reset_native_panic_context_for_test();
    }

    #[test]
    fn test_native_panic_seam_is_scrubbed_safely_and_marks_exit_phase() {
        let seams = [
            NativePanicSeam::TrayLeftClick,
            NativePanicSeam::TrayBlurHide,
            NativePanicSeam::GlobalShortcutTogglePopover,
            NativePanicSeam::GlobalShortcutToggleDesktop,
            NativePanicSeam::WindowCloseRequestedHide,
            NativePanicSeam::WindowThemeChanged,
            NativePanicSeam::WindowForceForeground,
            NativePanicSeam::SingleInstanceSurfaceExisting,
            NativePanicSeam::AppExitRequested,
        ];
        let history = seams
            .into_iter()
            .fold(0_u64, |history, seam| (history << u8::BITS) | seam as u64);

        // Use injected values rather than process-global atomics: Rust test
        // execution is concurrent, while production snapshots both atomics
        // before calling this same helper from `before_send`.
        let event =
            before_send_with_native_context(Event::default(), NativePanicPhase::Exiting, history)
                .expect("native panic event remains sendable");

        let breadcrumbs: Vec<_> = event
            .breadcrumbs
            .values
            .iter()
            .filter(|breadcrumb| breadcrumb.category.as_deref() == Some(UI_SEAM_CATEGORY))
            .collect();

        // The nine static seams prove both the fixed vocabulary and bounded
        // history: the oldest entry drops, leaving the most recent eight.
        assert_eq!(breadcrumbs.len(), NATIVE_PANIC_SEAM_HISTORY_CAPACITY);
        assert_eq!(breadcrumbs[0].message.as_deref(), Some("tray.blur-hide"));
        assert_eq!(
            breadcrumbs.last().unwrap().message.as_deref(),
            Some("app.exit-requested")
        );
        assert!(breadcrumbs.iter().all(|seam| seam.data.is_empty()));
        assert_eq!(
            event.tags.get(NATIVE_PANIC_PHASE_TAG).map(String::as_str),
            Some("exiting")
        );
    }

    // 6a. Typed Context::App round-trip — non-sensitive typed fields preserved
    #[test]
    fn test_context_app_round_trip() {
        let mut event = Event::default();
        let mut other_fields = BTreeMap::new();
        other_fields.insert("apikey".to_string(), Value::String("leak".into()));
        other_fields.insert("build".to_string(), Value::String("keep".into()));
        let app_ctx = AppContext {
            app_name: Some("hq".into()),
            app_version: Some("1.0".into()),
            other: other_fields,
            ..Default::default()
        };
        event
            .contexts
            .insert("app".to_string(), Context::App(Box::new(app_ctx)));

        let result = before_send(event).unwrap();
        let ctx = &result.contexts["app"];

        // Round-trip succeeded → must NOT be the scrub_error marker
        if let Context::Other(map) = ctx {
            assert!(
                !map.contains_key("scrub_error"),
                "scrub_error marker must not appear on successful round-trip"
            );
        }

        // Deserialize back to inspect typed fields
        let val = serde_json::to_value(ctx).unwrap();
        // app_name preserved
        assert_eq!(val["app_name"], serde_json::json!("hq"));
        // sensitive extra field scrubbed (sentry AppContext uses `other` flattened)
        assert_eq!(val["apikey"], serde_json::json!("[Filtered]"));
        // non-sensitive extra field preserved
        assert_eq!(val["build"], serde_json::json!("keep"));
    }

    // 6b. Typed Context::Runtime round-trip
    #[test]
    fn test_context_runtime_round_trip() {
        let mut event = Event::default();
        let mut other_fields = BTreeMap::new();
        other_fields.insert("token".to_string(), Value::String("leak".into()));
        let runtime_ctx = RuntimeContext {
            name: Some("rust".into()),
            version: Some("1.80".into()),
            other: other_fields,
            ..Default::default()
        };
        event.contexts.insert(
            "runtime".to_string(),
            Context::Runtime(Box::new(runtime_ctx)),
        );

        let result = before_send(event).unwrap();
        let ctx = &result.contexts["runtime"];
        let val = serde_json::to_value(ctx).unwrap();
        assert_eq!(val["name"], serde_json::json!("rust"));
        assert_eq!(val["token"], serde_json::json!("[Filtered]"));
    }

    // 6c. Context::Other round-trip
    #[test]
    fn test_context_other_round_trip() {
        let mut event = Event::default();
        let mut map = BTreeMap::new();
        map.insert("apikey".to_string(), Value::String("leak".into()));
        map.insert("other".to_string(), Value::String("keep".into()));
        event
            .contexts
            .insert("custom".to_string(), Context::Other(map));

        let result = before_send(event).unwrap();
        let ctx = &result.contexts["custom"];
        if let Context::Other(map) = ctx {
            assert_eq!(map["apikey"], Value::String("[Filtered]".into()));
            assert_eq!(map["other"], Value::String("keep".into()));
        } else {
            panic!("expected Context::Other");
        }
    }

    // 6d. Fail-closed: serde round-trip failure produces scrub_error marker.
    // Context::Other serializes its BTreeMap as-is (no "type" tag added).
    // Inserting "type": null produces JSON {"type": null, ...}. serde's
    // internally-tagged Context enum requires the tag to be a string, so
    // from_value::<Context> returns Err, and scrub_context returns the
    // scrub_error marker instead of the original (potentially unscrubbed) data.
    #[test]
    fn test_fail_closed_scrub_error_marker() {
        let mut map = BTreeMap::new();
        // null type violates Context's internally-tagged serde shape
        map.insert("type".to_string(), Value::Null);
        map.insert("secret".to_string(), Value::String("original_leak".into()));
        let ctx = Context::Other(map);

        let result = scrub_context(ctx);

        match result {
            Context::Other(marker) => {
                assert!(
                    marker.contains_key("scrub_error"),
                    "expected scrub_error key in marker, got: {:?}",
                    marker
                );
                assert_eq!(
                    marker["scrub_error"],
                    Value::String("[Filtered — serde round-trip failed]".into())
                );
                assert!(
                    !marker.contains_key("secret"),
                    "original secret must not appear in error marker"
                );
            }
            other => panic!("expected Context::Other marker, got: {:?}", other),
        }
    }

    // 7. Empty event no-panic
    #[test]
    fn test_empty_event_no_panic() {
        let event = Event::default();
        let result = before_send(event);
        assert!(result.is_some());
    }

    #[test]
    fn test_runner_diagnostic_fixed_vocabulary_survives_before_send() {
        let mut event = Event::default();
        for (key, value) in [
            ("runner_stack_shape", "node_cjs_loader>app>node_fs"),
            ("runner_stack_signature", "0123456789abcdef"),
            ("sync_route", "manual"),
            ("sync_scope", "single_company"),
            ("runner_phase", "push"),
        ] {
            event.tags.insert(key.to_string(), value.to_string());
        }
        event.extra.insert(
            "watcher_launch_origin".to_string(),
            Value::String("supervisor_respawn".to_string()),
        );
        for (key, value) in [
            ("runner_fatal_class", "node_fatal"),
            ("runner_error_rollup", "stderr:1"),
            ("windows_exit_status", "0xC0000409"),
            ("windows_exit_class", "fault"),
            ("windows_fault_symbol", "STATUS_STACK_BUFFER_OVERRUN"),
        ] {
            event.tags.insert(key.to_string(), value.to_string());
        }
        for (key, value) in [
            ("watcher_lifecycle_state", "starting"),
            ("runner_phase", "push"),
            ("runner_phase_elapsed_bucket", "under_1m"),
        ] {
            event
                .extra
                .insert(key.to_string(), Value::String(value.to_string()));
        }
        event
            .extra
            .insert("runner_stack_depth".to_string(), Value::Number(3.into()));
        event.extra.insert(
            "runner_stack_redacted_frames".to_string(),
            Value::Number(1.into()),
        );

        let result = before_send(event).expect("event remains sendable");
        assert_eq!(
            result.tags["runner_stack_shape"],
            "node_cjs_loader>app>node_fs"
        );
        assert_eq!(result.tags["runner_stack_signature"], "0123456789abcdef");
        assert_eq!(result.tags["sync_route"], "manual");
        assert_eq!(result.tags["sync_scope"], "single_company");
        assert_eq!(result.tags["runner_phase"], "push");
        for key in [
            "runner_fatal_class",
            "runner_error_rollup",
            "windows_exit_status",
            "windows_exit_class",
            "windows_fault_symbol",
        ] {
            assert!(result.tags.contains_key(key), "missing tag {key}");
        }
        for key in [
            "watcher_lifecycle_state",
            "runner_phase",
            "runner_phase_elapsed_bucket",
            "watcher_launch_origin",
            "runner_stack_depth",
            "runner_stack_redacted_frames",
        ] {
            assert!(result.extra.contains_key(key), "missing extra {key}");
        }
        assert_eq!(
            result.extra["watcher_launch_origin"],
            Value::String("supervisor_respawn".to_string())
        );
    }

    #[test]
    fn test_runner_diagnostic_lookalikes_fail_closed_at_egress() {
        for (key, value) in [
            ("runner_stack_shape", "node_fs>/Users/Ada/secret.md"),
            ("runner_stack_shape", "app>app>app>app>app>app>app>app>app"),
            ("runner_stack_signature", "ABCDEF0123456789"),
            ("runner_stack_signature", "0123456789abcdeg"),
            ("watcher_launch_origin", "renderer:/Users/Ada"),
            ("sync_route", "manual-private"),
            ("sync_scope", "indigo"),
            ("runner_phase", "push:/secret"),
            // A producer bug that shipped a raw word, a path, or a non-integer in
            // any of the new libuv/job channels must degrade to `[Filtered]`.
            ("runner_fatal_syscall", "ReadDirectoryChangesW /Users/Ada/secret.md"),
            ("runner_fatal_errno", "5; rm -rf"),
            ("watcher_job_peak_commit_bucket", "512mb_to_1gb:/Users/Ada"),
            ("watcher_job_process_count", "2 processes /Users/Ada"),
            ("watcher_child_kind", "launcher:/Users/Ada"),
            ("rss_scope", "shim/secret"),
        ] {
            let mut event = Event::default();
            event.tags.insert(key.to_string(), value.to_string());
            event
                .extra
                .insert(key.to_string(), Value::String(value.to_string()));
            let result = before_send(event).expect("event remains sendable");
            assert_eq!(
                result.tags[key], "[Filtered]",
                "tag key={key} value={value}"
            );
            assert_eq!(
                result.extra[key],
                Value::String("[Filtered]".to_string()),
                "extra key={key} value={value}"
            );
        }
    }

    #[test]
    fn libuv_and_job_diagnostic_fields_survive_egress_when_valid() {
        for (key, value) in [
            ("runner_fatal_syscall", "ReadDirectoryChangesW"),
            ("runner_fatal_syscall", "other"),
            ("runner_fatal_errno", "5"),
            ("watcher_job_peak_commit_bucket", "512mb_to_1gb"),
            ("watcher_job_peak_commit_bucket", "unknown"),
            ("watcher_job_process_count", "2"),
            ("watcher_job_process_count", "unknown"),
            ("watcher_child_kind", "cmd_shim"),
            ("watcher_child_kind", "launcher"),
            ("watcher_child_kind", "direct_executable"),
            ("rss_scope", "shim"),
            ("rss_scope", "launcher"),
            ("rss_scope", "runner"),
        ] {
            let mut event = Event::default();
            event.tags.insert(key.to_string(), value.to_string());
            let result = before_send(event).expect("event remains sendable");
            assert_eq!(
                result.tags[key], value,
                "valid {key}={value} must survive egress"
            );
        }
    }

    #[test]
    fn exec_target_provenance_fields_survive_egress_only_as_fixed_vocabulary() {
        // Accept exactly the producer's fixed vocabulary (HQ-DESKTOP-52 / -51).
        for (key, value) in [
            ("runner_exec_resolution", "npx_cache"),
            ("runner_exec_resolution", "local_runner"),
            ("runner_exec_resolution", "unknown"),
            ("runner_exec_target_exists", "true"),
            ("runner_exec_target_exists", "false"),
            ("runner_exec_target_exists", "unknown"),
            ("runner_exec_target_executable", "true"),
            ("runner_exec_target_executable", "false"),
            ("runner_exec_target_executable", "unknown"),
            ("runner_target_repair_attempted", "true"),
            ("runner_target_repair_attempted", "false"),
            ("exec_not_runnable_streak", "4"),
            ("exec_not_runnable_streak", "8"),
        ] {
            assert_eq!(
                valid_runner_diagnostic_field(key, value),
                Some(true),
                "valid {key}={value} must pass egress"
            );
        }

        // A bool/integer Value reaches the validator as "" (non-string), which is
        // type-safe by construction and must pass.
        for key in ["runner_target_repair_attempted", "exec_not_runnable_streak"] {
            assert_eq!(valid_runner_diagnostic_field(key, ""), Some(true));
        }

        // Anything outside the fixed vocabulary fails closed to `[Filtered]`, so a
        // producer bug can never ship a path, username, or raw state.
        for (key, value) in [
            ("runner_exec_resolution", "/Users/ada/.npm/_npx"),
            ("runner_exec_target_exists", "maybe"),
            ("runner_exec_target_executable", "/bin/sh"),
            ("runner_target_repair_attempted", "sometimes"),
            ("exec_not_runnable_streak", "four"),
        ] {
            assert_eq!(
                valid_runner_diagnostic_field(key, value),
                Some(false),
                "invalid {key}={value} must fail closed"
            );
        }

        // End-to-end: the probed extras (string tokens, a bool, an integer)
        // survive `before_send`, while a lookalike resolution string is blanked.
        let mut event = Event::default();
        event.extra.insert(
            "runner_exec_target_exists".to_string(),
            Value::String("true".to_string()),
        );
        event
            .extra
            .insert("runner_target_repair_attempted".to_string(), Value::Bool(true));
        event.extra.insert(
            "exec_not_runnable_streak".to_string(),
            Value::Number(4u32.into()),
        );
        event.extra.insert(
            "runner_exec_resolution".to_string(),
            Value::String("not-a-token".to_string()),
        );
        let result = before_send(event).expect("event remains sendable");
        assert_eq!(
            result.extra.get("runner_exec_target_exists"),
            Some(&Value::String("true".to_string()))
        );
        assert_eq!(
            result.extra.get("runner_target_repair_attempted"),
            Some(&Value::Bool(true))
        );
        assert_eq!(
            result.extra.get("exec_not_runnable_streak"),
            Some(&Value::Number(4u32.into()))
        );
        assert_eq!(
            result.extra.get("runner_exec_resolution"),
            Some(&Value::String("[Filtered]".to_string()))
        );
    }

    #[test]
    fn test_runner_stack_shape_signature_pair_fails_closed_at_egress() {
        for (shape, signature) in [("all_redacted", "0123456789abcdef"), ("node_fs", "unknown")] {
            let mut event = Event::default();
            event
                .tags
                .insert("runner_stack_shape".to_string(), shape.to_string());
            event
                .tags
                .insert("runner_stack_signature".to_string(), signature.to_string());
            let result = before_send(event).expect("event remains sendable");
            assert_eq!(result.tags["runner_stack_shape"], "[Filtered]");
            assert_eq!(result.tags["runner_stack_signature"], "[Filtered]");
        }
    }

    /// Tri-source vocabulary guard (HQ-DESKTOP-50): the egress validator's
    /// `runner_phase` arm must accept exactly the tokens the core enumerates in
    /// `RUNNER_PHASE_VOCABULARY`. If the core adds a phase token and this arm is
    /// not updated in the same change, the new token would ship as `[Filtered]` —
    /// a silent regression this test turns into a loud CI failure. The desktop
    /// E2E source-contract spec pins the third source (the TS `RunnerPhase`
    /// union) against the same core constant.
    #[test]
    fn runner_phase_vocabulary_is_single_source_across_core_and_validator() {
        use hq_desktop_core::sync_outcome::RUNNER_PHASE_VOCABULARY;
        for token in RUNNER_PHASE_VOCABULARY {
            assert_eq!(
                valid_runner_diagnostic_field("runner_phase", token),
                Some(true),
                "core phase vocabulary member {token} must validate at egress"
            );
        }
        // Near-misses fail loudly, so a typo or an unregistered token cannot slip
        // through as a valid phase.
        for near_miss in ["pre_protocoll", "scan2", "PUSH", "", "protocol"] {
            assert_eq!(
                valid_runner_diagnostic_field("runner_phase", near_miss),
                Some(false),
                "non-member {near_miss:?} must be rejected"
            );
        }
    }

    /// Cross-crate parity guard (HQ-DESKTOP-55): the egress validator's stack-shape
    /// vocabulary must equal the core producer's `RUNNER_STACK_TOKENS` as a SET. No
    /// such guard existed before; a one-sided token edit would silently `[Filtered]`
    /// exactly the class-scoped heap-OOM signal this change adds, making the fix
    /// appear inert in production. This turns that drift into a loud CI failure.
    #[test]
    fn runner_stack_tokens_match_across_crates() {
        use std::collections::HashSet;
        let validator: HashSet<&str> = RUNNER_STACK_TOKENS.iter().copied().collect();
        let producer: HashSet<&str> = hq_desktop_core::sync_outcome::RUNNER_STACK_TOKENS
            .iter()
            .copied()
            .collect();
        assert_eq!(
            validator, producer,
            "RUNNER_STACK_TOKENS drifted between hq-telemetry and hq-desktop-core"
        );
        // Every class-scoped heap-OOM token a producer can emit in a shape must
        // pass the shape validator (single-token shapes exercise the arm directly).
        for token in hq_desktop_core::sync_outcome::RUNNER_STACK_TOKENS {
            assert!(
                valid_runner_stack_shape(token),
                "producer token {token} must validate at egress"
            );
        }
    }

    /// Heap-OOM egress arms (HQ-DESKTOP-55): the banner is a fixed constant, the
    /// MB/frame figures are bare integers, and the honest `tree` RSS scope passes.
    /// A raw stderr fragment, a path, or an over-long value in any of these fields
    /// must degrade to `[Filtered]` at the boundary.
    #[test]
    fn heap_oom_diagnostic_fields_validate_or_filter() {
        for banner in ["reached_heap_limit", "ineffective_mark_compacts", "other"] {
            assert_eq!(
                valid_runner_diagnostic_field("runner_oom_banner", banner),
                Some(true)
            );
        }
        for bad_banner in ["Reached heap limit Allocation failed", "oom", "", "heap_limit"] {
            assert_eq!(
                valid_runner_diagnostic_field("runner_oom_banner", bad_banner),
                Some(false),
                "non-member banner {bad_banner:?} must be rejected"
            );
        }
        // Numeric extras: `""` (a non-string Value) and a decimal string pass; a
        // symbol, a path, or a signed/oversized value is rejected.
        for field in ["runner_heap_used_mb", "runner_heap_total_mb", "runner_oom_frame_count"] {
            assert_eq!(valid_runner_diagnostic_field(field, ""), Some(true));
            assert_eq!(valid_runner_diagnostic_field(field, "48"), Some(true));
            for bad in ["v8::internal::Runtime_NewArray", "/Users/x", "-1", "12.5"] {
                assert_eq!(
                    valid_runner_diagnostic_field(field, bad),
                    Some(false),
                    "{field} must reject {bad:?}"
                );
            }
        }
        // The honest tree scope passes; the pre-existing scopes still pass; a new
        // unknown scope string is rejected.
        for scope in ["tree", "shim", "launcher", "runner"] {
            assert_eq!(valid_runner_diagnostic_field("rss_scope", scope), Some(true));
        }
        assert_eq!(
            valid_runner_diagnostic_field("rss_scope", "unattributed:launcher"),
            Some(false)
        );
    }

    /// A class-scoped heap-OOM shape carrying the appended V8 tokens survives the
    /// scrubber in shape position and keeps a valid shape/signature pair, while a
    /// raw V8 symbol string in the same field is filtered.
    #[test]
    fn heap_oom_shape_survives_scrubber_but_raw_symbol_is_filtered() {
        let mut event = Event::default();
        event.tags.insert(
            "runner_stack_shape".to_string(),
            "node_oom_handler>v8_report_oom>v8_fatal_process_oom>anon>v8_heap>\
             v8_heap_allocator>v8_heap_allocator>v8_factory"
                .to_string(),
        );
        event
            .tags
            .insert("runner_stack_signature".to_string(), "0123456789abcdef".to_string());
        let result = before_send(event).expect("event remains sendable");
        assert_eq!(
            result.tags["runner_stack_shape"],
            "node_oom_handler>v8_report_oom>v8_fatal_process_oom>anon>v8_heap>\
             v8_heap_allocator>v8_heap_allocator>v8_factory"
        );
        assert_eq!(result.tags["runner_stack_signature"], "0123456789abcdef");

        let mut hostile = Event::default();
        hostile.tags.insert(
            "runner_stack_shape".to_string(),
            "v8::internal::Runtime_NewArray(int, unsigned long*)".to_string(),
        );
        hostile
            .tags
            .insert("runner_stack_signature".to_string(), "0123456789abcdef".to_string());
        let filtered = before_send(hostile).expect("event remains sendable");
        assert_eq!(filtered.tags["runner_stack_shape"], "[Filtered]");
    }

    #[test]
    fn runner_assertion_and_node_provenance_fields_validate_or_filter() {
        // Assert source: allow-listed tokens pass, a path-like value is rejected.
        for good in ["libuv_win_async", "libuv_unix_core", "libuv_handle", "other"] {
            assert_eq!(
                valid_runner_diagnostic_field("runner_assert_source", good),
                Some(true)
            );
        }
        assert_eq!(
            valid_runner_diagnostic_field("runner_assert_source", r"src\win\async.c"),
            Some(false)
        );
        // Assert signature: 16-hex passes; a raw expression is rejected.
        assert_eq!(
            valid_runner_diagnostic_field("runner_assert_signature", "0123456789abcdef"),
            Some(true)
        );
        assert_eq!(
            valid_runner_diagnostic_field("runner_assert_signature", "!(handle->flags)"),
            Some(false)
        );
        // Bare-integer extras: a numeric string and the empty string (a numeric
        // `Value` reaches the check as "") pass; raw text is rejected.
        for key in ["runner_assert_line", "runner_stdout_line_count"] {
            assert_eq!(valid_runner_diagnostic_field(key, "42"), Some(true));
            assert_eq!(valid_runner_diagnostic_field(key, ""), Some(true));
            assert_eq!(
                valid_runner_diagnostic_field(key, "/Users/ada/secret"),
                Some(false)
            );
        }
        // Node major: an integer or the `unknown` sentinel passes; a path fails.
        assert_eq!(
            valid_runner_diagnostic_field("runner_node_major", "20"),
            Some(true)
        );
        assert_eq!(
            valid_runner_diagnostic_field("runner_node_major", "unknown"),
            Some(true)
        );
        assert_eq!(
            valid_runner_diagnostic_field("runner_node_major", "/nvm/versions/v8"),
            Some(false)
        );
    }

    #[test]
    fn crafted_path_in_assert_source_is_scrubbed_before_send() {
        let mut event = Event::default();
        event.tags.insert(
            "runner_assert_source".to_string(),
            r"C:\Users\ada\companies\personal".to_string(),
        );
        event
            .tags
            .insert("runner_assert_signature".to_string(), "0123456789abcdef".to_string());
        let result = before_send(event).expect("event remains sendable");
        // The unregistered path value is filtered; the valid digest survives.
        assert_eq!(result.tags["runner_assert_source"], "[Filtered]");
        assert_eq!(result.tags["runner_assert_signature"], "0123456789abcdef");
    }
}
