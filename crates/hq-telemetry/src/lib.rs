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
        }
    }
}

const NATIVE_PANIC_SEAM_HISTORY_CAPACITY: usize = 8;
static NATIVE_PANIC_SEAMS: AtomicU64 = AtomicU64::new(0);

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

fn is_sensitive_key(k: &str) -> bool {
    SENSITIVE_FIELD_NAMES
        .iter()
        .any(|name| k.eq_ignore_ascii_case(name))
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
        matches!(
            value,
            "eperm" | "eacces" | "enospc" | "ebusy" | "network" | "auth" | "other"
        )
    };
    let is_fatal_class = |value: &str| {
        matches!(
            value,
            "libuv_assert"
                | "node_fatal"
                | "heap_oom"
                | "rust_panic"
                | "exec_permission_denied"
                | "exec_not_found"
                | "node_too_old"
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
    sentry::configure_scope(|scope| {
        scope.set_tag("repo", identity.repo);
        scope.set_tag("app", identity.app);
        scope.set_tag("flavor", identity.flavor);
    });
    Some(guard)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sentry::protocol::{AppContext, Breadcrumb, Request, RuntimeContext};

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
}
