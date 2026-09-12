//! Shell out to `hq cloud provision company <slug>` — the canonical cloud-
//! promotion subcommand that lives in `@indigoai-us/hq-cli`.
//!
//! The CLI is the single source of truth for: GET-then-POST entity idempotency,
//! atomic `companies/manifest.yaml` patch, atomic `companies/<slug>/.hq/config.json`
//! write, and initial `share()` sync. Both calling paths in this app
//! (`provision::provision_missing_companies` auto-flow and
//! `workspaces::connect_workspace_to_cloud` Connect button) delegate here so
//! the contract stays in one place — see
//! `workspace/reports/cloud-promote-architecture-2026-04-27.md` for the
//! consolidation rationale.
//!
//! ## Subprocess contract
//!
//! Argv:
//!
//! ```text
//! hq cloud provision company <slug> [--name "<name>"]
//! ```
//!
//! Stdout: a JSON object conforming to `CliProvisionResult`. We capture the
//! entire stream and find the last parseable result object. The CLI normally
//! writes one JSON line, but an `npx` self-heal can append npm notices such as
//! `npm fund` after it; those non-JSON lines must not turn an exit-0 provision
//! into a false failure.
//!
//! Stderr: free-form progress lines prefixed by the CLI itself (e.g.
//! `[hq cloud provision] validated slug=acme`). We tee every line into
//! the persistent diagnostic log via `util::logfile::log("provision-cli", …)`
//! so a stuck or failed provision leaves breadcrumbs we can grep for. The
//! stderr (and stdout) readers decode with `String::from_utf8_lossy`, so a
//! single non-UTF-8 byte replaces itself with U+FFFD rather than ending the
//! capture — a silently-truncated tail is what let an exit-1 provision reach
//! Sentry with `stderr_tail=""` and get mislabelled a vault incident
//! (HQ-DESKTOP-68).
//!
//! Exit codes:
//!   * `0` — success, JSON has `ok: true`, `initial_sync.ok: true`
//!   * `1` — vault auth/network/API error, BUT only when the CLI actually said
//!     so on stderr. Exit 1 is overloaded: `npx`/`npm` also exit 1 for local
//!     failures before the CLI loads. We classify local-env failures first;
//!     an exit 1 that wrote NOTHING to stderr is reported as `no-output`
//!     (cause unproven) with runtime/duration/stdout evidence, never as vault.
//!   * `2` — validation error (bad slug, manifest missing, dir missing, etc.)
//!   * `3` — entity provisioned + manifest patched + config written, but the
//!     initial sync failed. The JSON line on stdout still carries the
//!     `cloud_uid` so retries can resume.
//!
//! ## Why a fresh subprocess and not a library call
//!
//! The CLI lives in a separate npm package (`@indigoai-us/hq-cli`) and
//! depends on `@indigoai-us/hq-cloud` for the `share()` runner. Calling it
//! out-of-process keeps the Tauri/Rust binary free of any Node.js coupling
//! and lets the CLI evolve independently — the only contract we depend on
//! is the JSON shape on stdout and the exit-code mapping above.
//!
//! ## Why we don't fall back to direct vault calls
//!
//! The whole point of this refactor is single-source-of-truth. If the CLI
//! is unavailable (binary missing, npm not installed, etc.) we surface a
//! clear `CliProvisionError::Spawn` to the caller rather than silently
//! re-implementing the flow with `vault_client.rs`. The caller then logs
//! and the user sees the error in Connect diagnostics.
//!
//! `vault_client.rs` is retained for other callers (membership lookups,
//! telemetry, STS vending, etc.) — only the cloud-promote callers were
//! migrated.

use std::collections::VecDeque;
use std::path::Path;
use std::process::Stdio;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{ChildStderr, ChildStdout};

use crate::hq_resolver::{self, HqInvocation};
use crate::logfile::log;
use crate::paths;
use crate::runtime_diagnosis::{self, ChildExitDiagnosis, RuntimeDiagnosis, RuntimeDiagnosisInput};

/// Last N stderr lines kept in memory so we can attach them to Sentry events.
/// Capped to keep payloads under Sentry's per-event size limits.
const STDERR_TAIL_CAP: usize = 50;

/// Last N stdout lines attached to a failure event as evidence. The full
/// stdout line list still feeds `parse_provision_stdout`; only the Sentry
/// extra is capped, matching `STDERR_TAIL_CAP` so payloads stay bounded.
const STDOUT_TAIL_CAP: usize = 50;

/// Outcome of draining one child pipe. A closed vocabulary so it can travel as
/// a Sentry tag without exposing raw bytes: the previous reader ended silently
/// on the first non-UTF-8 line, which is exactly how an exit-1 provision could
/// reach Sentry with an empty tail (HQ-DESKTOP-68).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReaderOutcome {
    /// The stream reached end-of-file cleanly.
    Eof,
    /// The stream read errored mid-way (kind only — never the raw message).
    IoError(std::io::ErrorKind),
    /// The reader task itself failed to join (panic / cancellation).
    JoinFailed,
}

impl ReaderOutcome {
    /// Closed-cardinality tag value. Never carries the io error message.
    pub fn tag(&self) -> &'static str {
        match self {
            Self::Eof => "eof",
            Self::IoError(_) => "io-error",
            Self::JoinFailed => "join-failed",
        }
    }
}

/// Everything captured from the child's pipes, drained concurrently with
/// `child.wait()`. `stdout_lines` is the complete stream (fed to the JSON
/// parser); `stdout_tail`/`stderr_tail` are the bounded rings attached to
/// Sentry; the reader outcomes record whether either stream ended abnormally.
#[derive(Debug, Clone)]
pub struct ChildOutput {
    pub stdout_lines: Vec<String>,
    pub stdout_tail: Vec<String>,
    pub stderr_tail: Vec<String>,
    pub stdout_reader: ReaderOutcome,
    pub stderr_reader: ReaderOutcome,
    /// Total stderr lines the child wrote, counted while draining — NOT the
    /// capped ring length, so a chatty failure reports its true volume.
    pub stderr_line_count: usize,
    /// Whether any nonblank stderr line was observed while draining. Tracked at
    /// the source rather than derived from the (capped) `stderr_tail`, so a real
    /// diagnostic followed by >50 blank lines is still seen as "stderr spoke".
    pub stderr_had_nonblank: bool,
}

/// Remove ANSI colour/control sequences before looking for a JSON result.
/// npm normally emits plain text, but this makes the stdout contract robust to
/// a coloured wrapper without pulling a terminal-parsing dependency into core.
fn strip_ansi(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch != '\u{1b}' {
            output.push(ch);
            continue;
        }
        if chars.peek() == Some(&'[') {
            chars.next();
            // CSI ends at any byte in the final-byte range 0x40..=0x7e.
            while let Some(code) = chars.next() {
                if ('@'..='~').contains(&code) {
                    break;
                }
            }
        }
    }
    output
}

/// Find the last JSON provision result in stdout, ignoring npm/wrapper noise.
/// A result must deserialize into the full CLI contract, so an unrelated JSON
/// diagnostic cannot be mistaken for a successful provision. We also accept a
/// wrapper prefix before the object (for example a future `npm notice ...`)
/// but require the object to consume the rest of the line.
fn parse_provision_stdout(lines: &[String]) -> Result<CliProvisionResult, String> {
    let mut last_nonempty: Option<String> = None;
    let mut last_json_error: Option<String> = None;

    for raw in lines.iter().rev() {
        let line = strip_ansi(raw);
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if last_nonempty.is_none() {
            last_nonempty = Some(line.to_string());
        }

        // The result is one JSON object. Searching from the final line upward
        // tolerates trailing `npm fund` chatter while preserving the CLI's
        // last-result-wins behaviour if it ever emits more than one result.
        let Some(json) = line.find('{').map(|start| &line[start..]) else {
            continue;
        };
        match serde_json::from_str::<CliProvisionResult>(json) {
            Ok(result) => return Ok(result),
            Err(error) => last_json_error = Some(format!("{error} (line={line:?})")),
        }
    }

    match (last_nonempty, last_json_error) {
        (None, _) => Err("no output on stdout".to_string()),
        (_, Some(error)) => Err(format!("stdout JSON failed to parse: {error}")),
        (Some(line), None) => Err(format!(
            "no provision JSON object in stdout (last_line={line:?})"
        )),
    }
}

/// Everything a non-spawn provision failure attaches to Sentry beyond the
/// error itself. Split out so `finish_child_exit` (production) and
/// `finish_child_exit_for_test` share one reporter: the only difference between
/// them is where `runtime`/`node_major` come from (a real probe vs. an injected
/// value), never what gets emitted.
///
/// Every free-form field (`stderr_tail`, `stdout_tail`) rides as a Sentry
/// *extra*, which passes through `hq_telemetry::before_send` scrubbing; every
/// *tag* stays closed-vocabulary (reader outcomes, provenance, probe outcomes,
/// node major) because the scrubber does not rewrite tags.
struct ProvisionExitDiagnostics {
    stderr_tail: Vec<String>,
    stdout_tail: Vec<String>,
    stderr_line_count: usize,
    stdout_line_count: usize,
    stderr_reader: ReaderOutcome,
    stdout_reader: ReaderOutcome,
    duration_ms: u64,
    /// Present only on the no-output arm — the one failure where the child left
    /// no diagnostic of its own, so runtime provenance/probes are the evidence.
    runtime: Option<RuntimeDiagnosisInput>,
    node_major: Option<u32>,
}

/// Capture a provision-cli failure to Sentry with full diagnostic context.
/// Tags carry the slug + CLI invocation + exit code + reader outcomes so we can
/// slice failures by stack/version; extras carry the stderr/stdout tails, line
/// counts and the child's wall-clock duration.
///
/// `local-env` failures (npm cache permission, disk full, npm registry
/// unreachable / timeout) carry an additional `local_env_kind` tag so the
/// existing `provision_kind=network` vault-incident alert rule can be
/// tightened to exclude them — these are user-laptop problems, not platform
/// incidents.
///
/// A `no-output` failure (exit with an empty stderr tail — cause unproven) is
/// tagged `provision_kind=no-output` so it no longer matches the vault-incident
/// rule, carries runtime provenance/probe evidence, and is fingerprinted into
/// one issue instead of minting a fresh per-slug title every time.
fn report_provision_error(
    err: &CliProvisionError,
    slug: &str,
    invocation_label: &str,
    invocation_kind: &str,
    exit_code: Option<i32>,
    diag: &ProvisionExitDiagnostics,
) {
    let kind = match err {
        CliProvisionError::Spawn(_) => "spawn",
        CliProvisionError::Validation { .. } => "validation",
        CliProvisionError::Network(_) => "network",
        CliProvisionError::LocalEnv { .. } => "local-env",
        CliProvisionError::NoOutput { .. } => "no-output",
        CliProvisionError::Sync { .. } => "sync",
        CliProvisionError::Other(_) => "other",
    };
    let local_env_kind: Option<&str> = match err {
        CliProvisionError::LocalEnv { kind, .. } => Some(kind),
        _ => None,
    };
    // Exit-2 validation subclass (HQ-DESKTOP-6A): a closed-vocabulary tag that
    // also collapses the per-slug proliferation via fingerprint. `None` for
    // every non-validation arm, so their tags/fingerprints/levels are untouched.
    let validation_kind: Option<&str> = match err {
        CliProvisionError::Validation { validation_kind, .. } => Some(validation_kind),
        _ => None,
    };
    // Known setup-incomplete validation subclasses are user-laptop / setup
    // problems, not platform errors — capture them at Warning so they stop
    // reading as error-level incidents (the "reported as errors" defect).
    // `unclassified` stays Error so a genuine CLI validation regression remains
    // visible; every non-validation arm is unaffected. `before_send` preserves
    // the capture-site level, so setting it here is sufficient.
    let level = match validation_kind {
        Some(vk) if is_setup_incomplete_validation(vk) => sentry::Level::Warning,
        _ => sentry::Level::Error,
    };
    let is_no_output = matches!(err, CliProvisionError::NoOutput { .. });
    let stderr_blob = diag.stderr_tail.join("\n");
    let stdout_blob = diag.stdout_tail.join("\n");
    let exit_str = exit_code
        .map(|c| c.to_string())
        .unwrap_or_else(|| "signal/none".to_string());

    sentry::with_scope(
        |scope| {
            scope.set_tag("slug", slug);
            scope.set_tag("provision_kind", kind);
            if let Some(k) = local_env_kind {
                scope.set_tag("local_env_kind", k);
            }
            scope.set_tag("cli_invocation", invocation_label);
            scope.set_tag("exit_code", &exit_str);
            scope.set_tag("stderr_reader", diag.stderr_reader.tag());
            scope.set_tag("stdout_reader", diag.stdout_reader.tag());
            scope.set_extra("stderr_tail", stderr_blob.into());
            scope.set_extra("stdout_tail", stdout_blob.into());
            scope.set_extra("stderr_lines", (diag.stderr_line_count as u64).into());
            scope.set_extra("stdout_lines", (diag.stdout_line_count as u64).into());
            scope.set_extra("child_duration_ms", diag.duration_ms.into());
            // Runtime evidence rides only on the no-output arm, where the child
            // said nothing about why it exited. Closed vocabulary, no paths —
            // exactly the tags `report_unexplained_spawn` already emits, plus
            // the node major from the version probe.
            if let Some(runtime) = diag.runtime.as_ref() {
                scope.set_tag("program_provenance", runtime.program_provenance.tag());
                scope.set_tag(
                    "runtime_owner",
                    runtime_diagnosis::runtime_owner(&runtime.managed_runtime),
                );
                scope.set_tag("node_probe", runtime.node_probe.tag());
                scope.set_tag("npx_probe", runtime.npx_probe.tag());
                if let Some(reason) = runtime_diagnosis::unknown_reason(&runtime.managed_runtime) {
                    scope.set_tag("runtime_unknown_reason", reason);
                }
                scope.set_tag(
                    "node_major",
                    diag.node_major
                        .map(|m| m.to_string())
                        .unwrap_or_else(|| "unknown".to_string()),
                );
            }
            // Collapse all no-output exits into one issue instead of a fresh
            // per-slug title each time; slug/cli_invocation/exit_code/node_major
            // stay as tags for slicing.
            if is_no_output {
                scope.set_fingerprint(Some(&[
                    "provision-cli",
                    "no-output",
                    invocation_kind,
                    &exit_str,
                ]));
            }
            // Collapse per-slug validation proliferation (HQ-DESKTOP-6A) into
            // one issue per subclass; slug/exit_code stay as tags for slicing.
            // Applies to `unclassified` too (grouped, still Error), so a real
            // CLI validation regression is one visible issue, not per-slug.
            if let Some(vk) = validation_kind {
                scope.set_tag("validation_kind", vk);
                scope.set_fingerprint(Some(&["provision-cli", "validation", vk]));
            }
        },
        || {
            sentry::capture_message(&format!("[provision-cli] {err}"), level);
        },
    );
}

/// Capture an unresolved spawn failure without exposing the resolved program
/// path or raw process text. The message preserves the existing spawn error
/// classification; every newly added diagnostic tag uses a closed vocabulary
/// because Sentry's scrubber does not rewrite tags.
fn report_unexplained_spawn(
    slug: &str,
    invocation_kind: &str,
    error: &CliProvisionError,
    diagnosis: &RuntimeDiagnosisInput,
) {
    sentry::with_scope(
        |scope| {
            scope.set_tag("slug", slug);
            scope.set_tag("provision_kind", "spawn");
            scope.set_tag("cli_invocation", invocation_kind);
            scope.set_tag("exit_code", "signal/none");
            scope.set_extra("stderr_tail", "".into());
            scope.set_tag("program_provenance", diagnosis.program_provenance.tag());
            scope.set_tag(
                "runtime_owner",
                runtime_diagnosis::runtime_owner(&diagnosis.managed_runtime),
            );
            scope.set_tag("node_probe", diagnosis.node_probe.tag());
            scope.set_tag("npx_probe", diagnosis.npx_probe.tag());
            if let Some(reason) = runtime_diagnosis::unknown_reason(&diagnosis.managed_runtime) {
                scope.set_tag("runtime_unknown_reason", reason);
            }
        },
        || {
            sentry::capture_message(&format!("[provision-cli] {error}"), sentry::Level::Error);
        },
    );
}

/// Test-only production reporting seam used by the menubar envelope test.
#[cfg(any(test, feature = "test-support"))]
pub fn report_unexplained_spawn_for_test(
    slug: &str,
    invocation: &HqInvocation,
    diagnosis: &RuntimeDiagnosisInput,
) {
    let invocation_label = invocation.sentry_label();
    let error = CliProvisionError::Spawn(format!(
        "{invocation_label}: No such file or directory (os error 2)"
    ));
    report_unexplained_spawn(slug, invocation.telemetry_kind(), &error, diagnosis);
}

/// Test-only seam over the WHOLE spawn-failure decision — classification and
/// the capture-or-suppress choice together.
///
/// `report_unexplained_spawn_for_test` above only exercises the reporting half,
/// so it cannot prove the *absence* of an event. This one takes the same
/// arguments the production spawn arm builds (`invocation_kind` /
/// `sentry_invocation_label` derived from the same `HqInvocation`) and calls
/// the same private function, so an envelope test asserting "zero events for a
/// proven missing runtime" is measuring production behaviour rather than a
/// re-implementation of it.
#[cfg(any(test, feature = "test-support"))]
pub fn finish_spawn_failure_for_test(
    slug: &str,
    invocation: &HqInvocation,
    spawn_error: &std::io::Error,
    diagnosis: RuntimeDiagnosisInput,
) -> CliProvisionError {
    finish_spawn_failure(
        slug,
        invocation.telemetry_kind(),
        &invocation.sentry_label(),
        spawn_error,
        diagnosis,
    )
}

fn finish_spawn_failure(
    slug: &str,
    invocation_kind: &str,
    sentry_invocation_label: &str,
    spawn_error: &std::io::Error,
    diagnosis: RuntimeDiagnosisInput,
) -> CliProvisionError {
    let log_detail = format!(
        "spawn program={:?}, error={spawn_error}, node_probe={:?}, npx_probe={:?}, runtime={:?}",
        diagnosis.attempted_program,
        diagnosis.node_probe,
        diagnosis.npx_probe,
        diagnosis.managed_runtime,
    );
    log("provision-cli", &log_detail);

    match runtime_diagnosis::diagnose(&diagnosis) {
        RuntimeDiagnosis::LocalLogOnly { kind, user_detail } => CliProvisionError::LocalEnv {
            kind,
            detail: user_detail.to_string(),
        },
        RuntimeDiagnosis::Unexplained => {
            let error =
                CliProvisionError::Spawn(format!("{sentry_invocation_label}: {spawn_error}"));
            report_unexplained_spawn(slug, invocation_kind, &error, &diagnosis);
            error
        }
    }
}

/// Inspect the captured stderr tail for unambiguous local-environment
/// failures and classify them. Returns `(kind, detail)` if matched.
///
/// `kind` is a stable identifier the frontend uses to render a kind-specific
/// "Fix in Claude Code" deep link (see `src/lib/copy-prompts.ts`). The
/// frontend parses the `Display` string
/// (`"local environment failure (<kind>): <detail>"`) to extract this, so
/// adding a new kind requires no IPC schema changes — just a new match arm
/// here and a new builder branch on the frontend side.
///
/// The patterns are deliberately narrow — they target failures that happen
/// *before* the CLI is loaded (most commonly when the resolver routes through
/// `npx -y --package=@indigoai-us/hq-cli@<range> hq`), where `npx` returns
/// exit code 1 for reasons that have nothing to do with vault. Mis-bucketing
/// these as `CliProvisionError::Network` produces false-positive
/// `provision_kind=network` Sentry alerts in `#hq-liveops` that look like
/// platform outages but are user-laptop fixes.
fn classify_local_env_failure(stderr_tail: &[String]) -> Option<(&'static str, String)> {
    let blob = stderr_tail.join("\n");

    // npm cache permission — `~/.npm/_cacache/...` owned by root from a prior
    // `sudo npm` run. Remedy is `sudo chown -R $(id -u):$(id -g) ~/.npm`.
    if blob.contains("npm error code EACCES")
        || blob.contains("npm ERR! code EACCES")
        || blob.contains("EACCES: permission denied")
    {
        let detail = first_matching_line(&blob, &["npm error path", "npm ERR! path", "EACCES"])
            .unwrap_or_else(|| "~/.npm cache contains root-owned files".to_string());
        return Some(("npm-cache-permission", detail));
    }

    // Disk full during package extraction.
    if blob.contains("npm error code ENOSPC")
        || blob.contains("npm ERR! code ENOSPC")
        || blob.contains("ENOSPC: no space left")
    {
        return Some((
            "disk-full",
            "no space left on device during npm package install".to_string(),
        ));
    }

    // npm registry DNS failure — captive portal, offline, custom-registry typo.
    if blob.contains("npm error code ENOTFOUND")
        || blob.contains("npm ERR! code ENOTFOUND")
        || blob.contains("getaddrinfo ENOTFOUND")
    {
        let detail = first_matching_line(&blob, &["ENOTFOUND", "getaddrinfo"])
            .unwrap_or_else(|| "could not resolve npm registry host".to_string());
        return Some(("npm-registry-unreachable", detail));
    }

    // npm registry TCP timeout — proxy / slow link / npmjs.org incident.
    if blob.contains("npm error code ETIMEDOUT")
        || blob.contains("npm ERR! code ETIMEDOUT")
        || blob.contains("connect ETIMEDOUT")
        || blob.contains("ESOCKETTIMEDOUT")
    {
        return Some((
            "npm-registry-timeout",
            "npm request to registry timed out".to_string(),
        ));
    }

    None
}

/// Helper for `classify_local_env_failure` — pull a line of the blob that
/// contains one of the needles, trimmed. Needles are tried in order, so the
/// caller can express priority by ordering: e.g. `["npm error path", "EACCES"]`
/// prefers the path line over the bare error-code line. Returns None when no
/// needle matches so the caller can fall back to a generic detail string.
fn first_matching_line(blob: &str, needles: &[&str]) -> Option<String> {
    for n in needles {
        for line in blob.lines() {
            if line.contains(n) {
                return Some(line.trim().to_string());
            }
        }
    }
    None
}

/// Subclass an exit-2 (validation) failure into a closed vocabulary by matching
/// the CLI's stderr shapes. Returns a `&'static str` from a fixed set so it can
/// travel as a Sentry tag AND ride inside the fingerprint without exposing any
/// raw child text (paths in the raw stderr line stay in the scrubbed
/// `stderr_tail` extra, never here).
///
/// The shapes come from `@indigoai-us/hq-cli`'s `cloud-provision.ts`
/// `validateManifestAndDir`, which throws `ProvisionError(2, …)` with the
/// messages matched below. The reported occurrence (HQ-DESKTOP-6A/6B) is
/// `companies/manifest.yaml not found at <root>` -> `"manifest-missing"`.
///
/// Matching is over the joined blob (caller passes stderr + stdout tails) so an
/// `npm warn` line that precedes the CLI's own message can't defeat the match,
/// mirroring the exit-1 local-env classifier. Needles are deliberately specific
/// so a genuinely unexpected validation message falls through to
/// `"unclassified"` (kept at Error level by the reporter) rather than being
/// silently downgraded. Order runs most-specific first so a single line lands
/// in exactly one bucket.
fn classify_setup_validation_failure(output_tail: &[String]) -> &'static str {
    let blob = output_tail.join("\n");

    // The company entry exists in the manifest but is marked archived.
    if blob.contains("status=archived") || blob.contains("is archived") {
        return "archived";
    }
    // The slug isn't a key under the manifest's top-level `.companies` map.
    if blob.contains(".companies")
        && (blob.contains("not found under")
            || blob.contains("not present")
            || blob.contains("no entry"))
    {
        return "slug-not-in-manifest";
    }
    // The company directory the manifest points at doesn't exist on disk.
    if blob.contains("does not exist") && (blob.contains("director") || blob.contains("compan")) {
        return "company-dir-missing";
    }
    // The manifest file exists but can't be parsed / lacks the top-level map.
    if blob.contains("malformed") || blob.contains("missing top-level") {
        return "manifest-malformed";
    }
    // The resolved HQ root has no manifest at all — the reported 6A/6B shape.
    if (blob.contains("manifest.yaml") && blob.contains("not found"))
        || blob.contains("manifest not found")
    {
        return "manifest-missing";
    }
    "unclassified"
}

/// The closed set of exit-2 validation subclasses that are user-laptop / setup
/// problems rather than platform errors. These are captured at `Level::Warning`
/// (the "reported as errors" defect this fixes); `"unclassified"` is NOT in the
/// set, so a genuine CLI validation regression stays at `Level::Error`.
fn is_setup_incomplete_validation(validation_kind: &str) -> bool {
    matches!(
        validation_kind,
        "manifest-missing"
            | "manifest-malformed"
            | "slug-not-in-manifest"
            | "company-dir-missing"
            | "archived"
    )
}

// ── Child output draining ─────────────────────────────────────────────────────

/// Decode one raw line (delimiter included) into a String, replacing invalid
/// UTF-8 with U+FFFD and trimming a single trailing `\n`/`\r\n`. Lossy decoding
/// is the fix for HQ-DESKTOP-68: `Lines::next_line` returned an error on the
/// first non-UTF-8 byte, which ended the reader loop and left an empty tail.
fn decode_line(raw: &[u8]) -> String {
    let mut line = String::from_utf8_lossy(raw).into_owned();
    if line.ends_with('\n') {
        line.pop();
        if line.ends_with('\r') {
            line.pop();
        }
    }
    line
}

/// Last `cap` elements of `lines`, cloned in order.
fn last_n(lines: &[String], cap: usize) -> Vec<String> {
    let start = lines.len().saturating_sub(cap);
    lines[start..].to_vec()
}

/// Everything `read_stderr_tail` observes while draining: the bounded tail, how
/// the stream ended, the TRUE line count (uncapped), and whether any nonblank
/// line was seen. The last two are tracked at the source so neither the reported
/// count nor the vault-vs-no-output decision is derived from the capped tail.
struct StderrDrain {
    tail: Vec<String>,
    outcome: ReaderOutcome,
    line_count: usize,
    had_nonblank: bool,
}

/// Drain stderr into the diagnostic log AND a bounded ring, lossily, while
/// counting every line and remembering whether any was nonblank.
async fn read_stderr_tail(stderr: ChildStderr) -> StderrDrain {
    let mut reader = BufReader::new(stderr);
    let mut ring: VecDeque<String> = VecDeque::with_capacity(STDERR_TAIL_CAP);
    let mut buf: Vec<u8> = Vec::new();
    let mut line_count: usize = 0;
    let mut had_nonblank = false;
    let outcome = loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf).await {
            Ok(0) => break ReaderOutcome::Eof,
            Ok(_) => {
                let line = decode_line(&buf);
                // Tee every line the child writes into ~/.hq/logs/hq-sync.log.
                log("provision-cli", &line);
                line_count += 1;
                if !line.trim().is_empty() {
                    had_nonblank = true;
                }
                if ring.len() == STDERR_TAIL_CAP {
                    ring.pop_front();
                }
                ring.push_back(line);
            }
            Err(error) => break ReaderOutcome::IoError(error.kind()),
        }
    };
    StderrDrain {
        tail: ring.into_iter().collect(),
        outcome,
        line_count,
        had_nonblank,
    }
}

/// Drain stdout into the full line list (fed to `parse_provision_stdout`),
/// lossily. Returns the lines plus how the stream ended.
async fn read_stdout_lines(stdout: ChildStdout) -> (Vec<String>, ReaderOutcome) {
    let mut reader = BufReader::new(stdout);
    let mut lines: Vec<String> = Vec::new();
    let mut buf: Vec<u8> = Vec::new();
    let outcome = loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf).await {
            Ok(0) => break ReaderOutcome::Eof,
            Ok(_) => lines.push(decode_line(&buf)),
            Err(error) => break ReaderOutcome::IoError(error.kind()),
        }
    };
    (lines, outcome)
}

/// Drain both child pipes concurrently. The reader tasks are spawned so they run
/// alongside `child.wait()` (a full pipe can't wedge the child); a reader task
/// that fails to join is recorded as `ReaderOutcome::JoinFailed` rather than
/// silently dropping the stream.
async fn drain_child_output(stdout: ChildStdout, stderr: ChildStderr) -> ChildOutput {
    let stderr_task = tokio::spawn(read_stderr_tail(stderr));
    let stdout_task = tokio::spawn(read_stdout_lines(stdout));

    let stderr = match stderr_task.await {
        Ok(drain) => drain,
        Err(join) => {
            log(
                "provision-cli",
                &format!("stderr reader task join failed (non-fatal): {join}"),
            );
            StderrDrain {
                tail: Vec::new(),
                outcome: ReaderOutcome::JoinFailed,
                line_count: 0,
                had_nonblank: false,
            }
        }
    };
    let (stdout_lines, stdout_reader) = match stdout_task.await {
        Ok(pair) => pair,
        Err(join) => {
            log(
                "provision-cli",
                &format!("stdout reader task join failed (non-fatal): {join}"),
            );
            (Vec::new(), ReaderOutcome::JoinFailed)
        }
    };

    let stdout_tail = last_n(&stdout_lines, STDOUT_TAIL_CAP);
    ChildOutput {
        stdout_lines,
        stdout_tail,
        stderr_tail: stderr.tail,
        stdout_reader,
        stderr_reader: stderr.outcome,
        stderr_line_count: stderr.line_count,
        stderr_had_nonblank: stderr.had_nonblank,
    }
}

// ── Post-wait exit decision ───────────────────────────────────────────────────

/// Map the child's exit code + captured output to a typed result. Pure: no
/// probing, no Sentry — `finish_child_exit` layers the runtime probe and the
/// capture on top so this classification can be unit-tested in isolation.
///
/// Exit 1 is only a vault/network failure when the CLI actually wrote to stderr.
/// An exit 1 with a non-empty tail the local-env classifier can't place stays
/// `Network` (unchanged); an exit 1 whose stderr tail is empty becomes
/// `NoOutput` (cause unproven) instead of a false vault incident.
// The `Err` type is the shared `CliProvisionError`, whose `Sync` variant embeds
// a full `CliProvisionResult`; every provision fn returns this same Result, so
// the large-err lint is architectural, not specific to this seam.
#[allow(clippy::result_large_err)]
fn classify_child_exit(
    exit_code: Option<i32>,
    output: &ChildOutput,
    slug: &str,
) -> Result<CliProvisionResult, CliProvisionError> {
    let parse_result = parse_provision_stdout(&output.stdout_lines);
    let parsed: Option<CliProvisionResult> = parse_result.as_ref().ok().cloned();

    match exit_code {
        Some(0) => parsed.ok_or_else(|| {
            let detail = parse_result
                .as_ref()
                .err()
                .cloned()
                .unwrap_or_else(|| "stdout parser returned no result".to_string());
            CliProvisionError::Other(format!("exit 0 but {detail} for slug={slug}"))
        }),
        // Exit 1 is overloaded: the CLI documents it as "vault auth/network",
        // but `npx`/`npm` also return 1 for local failures before the CLI even
        // loads — and a child that dies at startup can exit 1 while writing
        // nothing at all. Classify local-env first (npm may write on either
        // stream); then split the remainder into vault (stderr said something)
        // vs. no-output (stderr said nothing — cause unproven).
        Some(1) => {
            let mut combined = output.stderr_tail.clone();
            combined.extend(output.stdout_tail.iter().cloned());
            match classify_local_env_failure(&combined) {
                Some((env_kind, detail)) => Err(CliProvisionError::LocalEnv {
                    kind: env_kind,
                    detail,
                }),
                None => {
                    // Use the nonblank flag observed while draining, NOT the
                    // capped tail: a real diagnostic followed by >50 blank lines
                    // is evicted from the ring but still means stderr spoke, so
                    // it stays Network rather than being mislabelled no-output.
                    if output.stderr_had_nonblank {
                        Err(CliProvisionError::Network(format!(
                            "exit 1 (vault) — see ~/.hq/logs/hq-sync.log [provision-cli] for slug={slug}"
                        )))
                    } else {
                        Err(CliProvisionError::NoOutput {
                            exit_code: 1,
                            slug: slug.to_string(),
                        })
                    }
                }
            }
        }
        // Exit 2 is a validation failure — almost always a user-setup / local-
        // environment problem (chiefly a resolved HQ root with no
        // `companies/manifest.yaml`). Subclass it from the CLI's stderr (and
        // stdout, like the exit-1 arm, so an npm-warn prefix before the CLI's
        // line can't defeat the match) into a closed vocabulary so Sentry can
        // collapse the per-slug proliferation and downgrade the known setup
        // subclasses to Warning. The message text and the exit-2 -> Validation
        // mapping are byte-for-byte unchanged.
        Some(2) => {
            let mut combined = output.stderr_tail.clone();
            combined.extend(output.stdout_tail.iter().cloned());
            Err(CliProvisionError::Validation {
                message: format!(
                    "exit 2 (validation) — see ~/.hq/logs/hq-sync.log [provision-cli] for slug={slug}"
                ),
                validation_kind: classify_setup_validation_failure(&combined),
            })
        }
        Some(3) => Err(CliProvisionError::Sync {
            message: format!(
                "exit 3 (initial sync) — entity provisioned but upload failed; see ~/.hq/logs/hq-sync.log for slug={slug}"
            ),
            partial: parsed,
        }),
        Some(other) => Err(CliProvisionError::Other(format!(
            "unexpected exit code {other} for slug={slug}"
        ))),
        None => Err(CliProvisionError::Other(format!(
            "child terminated by signal (no exit code) for slug={slug}"
        ))),
    }
}

/// Classify the child exit, capture the failure to Sentry with full evidence,
/// and return the typed result. The runtime probe runs ONLY on the no-output
/// arm (where the child left no diagnostic of its own); every other arm reports
/// with the captured output but no probe.
async fn finish_child_exit(
    slug: &str,
    invocation: &HqInvocation,
    attempted_program: String,
    exit_code: Option<i32>,
    output: ChildOutput,
    duration_ms: u64,
) -> Result<CliProvisionResult, CliProvisionError> {
    let result = classify_child_exit(exit_code, &output, slug);

    if let Err(ref err) = result {
        let (runtime, node_major) = if matches!(err, CliProvisionError::NoOutput { .. }) {
            let ChildExitDiagnosis {
                runtime,
                node_major,
            } = runtime_diagnosis::inspect_child_exit(attempted_program).await;
            (Some(runtime), node_major)
        } else {
            (None, None)
        };
        let diag = ProvisionExitDiagnostics {
            stderr_tail: output.stderr_tail,
            stdout_tail: output.stdout_tail,
            stderr_line_count: output.stderr_line_count,
            stdout_line_count: output.stdout_lines.len(),
            stderr_reader: output.stderr_reader,
            stdout_reader: output.stdout_reader,
            duration_ms,
            runtime,
            node_major,
        };
        report_provision_error(
            err,
            slug,
            &invocation.label(),
            invocation.telemetry_kind(),
            exit_code,
            &diag,
        );
    }
    result
}

/// Test-only seam over the WHOLE post-wait decision — classification, evidence
/// assembly and the capture together — with the runtime probe stubbed by the
/// caller. Mirrors `finish_spawn_failure_for_test`: production derives
/// `runtime`/`node_major` from a real probe, the test injects them so an
/// envelope assertion is deterministic and measures production reporting rather
/// than re-implementing it.
#[cfg(any(test, feature = "test-support"))]
#[allow(clippy::too_many_arguments, clippy::result_large_err)]
pub fn finish_child_exit_for_test(
    slug: &str,
    invocation: &HqInvocation,
    exit_code: Option<i32>,
    output: ChildOutput,
    duration_ms: u64,
    runtime: Option<RuntimeDiagnosisInput>,
    node_major: Option<u32>,
) -> Result<CliProvisionResult, CliProvisionError> {
    let result = classify_child_exit(exit_code, &output, slug);
    if let Err(ref err) = result {
        let diag = ProvisionExitDiagnostics {
            stderr_tail: output.stderr_tail,
            stdout_tail: output.stdout_tail,
            stderr_line_count: output.stderr_line_count,
            stdout_line_count: output.stdout_lines.len(),
            stderr_reader: output.stderr_reader,
            stdout_reader: output.stdout_reader,
            duration_ms,
            runtime,
            node_major,
        };
        report_provision_error(
            err,
            slug,
            &invocation.label(),
            invocation.telemetry_kind(),
            exit_code,
            &diag,
        );
    }
    result
}

// ── Public types ─────────────────────────────────────────────────────────────

/// Per-step sync result inside `CliProvisionResult`. Mirrors the CLI's
/// `initial_sync` field — `ok: false` means the entity was provisioned but the
/// follow-up `share()` call failed (exit code 3).
///
/// Every field is optional because the CLI's TS interface declares them all
/// optional too: a happy-path run carries `ok` + counts; a failed run carries
/// `ok: false` + `error`; and a `--skip-initial-sync` run (always used by
/// AppBar) carries only `skipped: true`. Treating any of these as required
/// caused serde to reject the skip payload silently and surface as
/// "exit 0 but no JSON line on stdout".
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CliInitialSync {
    #[serde(default)]
    pub ok: Option<bool>,
    #[serde(default)]
    pub files_uploaded: Option<u64>,
    #[serde(default)]
    pub bytes_uploaded: Option<u64>,
    #[serde(default)]
    pub error: Option<String>,
    /// True when the CLI was invoked with `--skip-initial-sync`. AppBar passes
    /// this on every call because it owns its own STS-credentialed upload
    /// pipeline (`first_push_company` + Tauri progress events).
    #[serde(default)]
    pub skipped: Option<bool>,
}

/// Parsed JSON result emitted on stdout by `hq cloud provision company`.
///
/// Field names match the CLI's `ProvisionResult` interface (snake_case JSON,
/// not camelCase) — see
/// `repos/public/hq/packages/hq-cli/src/commands/cloud-provision.ts`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CliProvisionResult {
    pub ok: bool,
    pub company_slug: String,
    pub cloud_uid: String,
    pub bucket_name: String,
    pub vault_api_url: String,
    /// Some entities have no KMS key — never assume non-null.
    #[serde(default)]
    pub kms_key_id: Option<String>,
    pub created_entity: bool,
    pub manifest_patched: bool,
    pub config_written: bool,
    pub initial_sync: CliInitialSync,
}

/// Typed error surface for `run_cli_provision`. Mapped from the CLI's
/// documented exit codes (1=vault, 2=validation, 3=sync) plus our local
/// failure modes (spawn / IO / non-JSON output).
#[derive(Debug)]
pub enum CliProvisionError {
    /// Failed to spawn `hq` — binary not on PATH or exec error. The user is
    /// missing the CLI; surface a clear "install hq" message.
    Spawn(String),
    /// Exit code 2 — bad slug, missing manifest entry, archived company, etc.
    /// Caller should NOT retry; the user must fix the input.
    ///
    /// `validation_kind` is a closed-vocabulary subclass of the exit-2 failure
    /// (`manifest-missing`, `manifest-malformed`, `slug-not-in-manifest`,
    /// `company-dir-missing`, `archived`, or `unclassified`) derived from the
    /// CLI's stderr by `classify_setup_validation_failure`. It rides Sentry as a
    /// tag + fingerprint so the per-slug setup failures collapse into one issue
    /// per subclass instead of minting a fresh error per company slug
    /// (HQ-DESKTOP-6A). It is telemetry-only: `Display` formats `message` alone,
    /// so the IPC string the frontend parses is byte-for-byte unchanged.
    Validation {
        message: String,
        validation_kind: &'static str,
    },
    /// Exit code 1 — vault HTTP / network / auth failure. Retryable.
    Network(String),
    /// Exit code 1 *before* the CLI even started — `npx` / `npm` failed
    /// during the pre-launch package fetch. These look identical to vault
    /// failures from the exit code alone, but the captured `stderr_tail`
    /// carries an unambiguous npm-error blob. Surfaced as a distinct variant
    /// so Sentry routing + the popover can offer kind-specific remediation
    /// instead of a generic "vault error" message.
    ///
    /// `kind` is one of: `"npm-cache-permission"`, `"disk-full"`,
    /// `"npm-registry-unreachable"`, `"npm-registry-timeout"`,
    /// `"node-missing"`, or `"npx-unavailable"` — and these strings are part
    /// of the IPC contract with the frontend's `OpenInClaudeCodeButton` /
    /// `copy-prompts.ts` registry.
    LocalEnv { kind: &'static str, detail: String },
    /// A non-zero exit (in practice exit 1) whose stderr tail was EMPTY, so the
    /// vault/network cause is unproven. The old code fell through to `Network`
    /// here, minting false `provision_kind=network` vault incidents for a child
    /// that never reached any vault route (HQ-DESKTOP-68 / HQ-DESKTOP-69). This
    /// variant keeps the failure loud but honest: the event carries runtime
    /// provenance, node/npx probes, the child duration and the stdout tail so
    /// the next occurrence can be attributed instead of guessed.
    NoOutput { exit_code: i32, slug: String },
    /// Exit code 3 — entity created, manifest patched, config written, but
    /// the initial `share()` upload failed. The CLI's stdout still emits a
    /// `CliProvisionResult` with `cloud_uid` populated, so callers can
    /// retry the sync separately. We carry the partial result for them.
    Sync {
        message: String,
        partial: Option<CliProvisionResult>,
    },
    /// Anything we can't classify — non-zero exit code outside [1,2,3], or
    /// stdout that didn't contain a parseable JSON line, or IO mid-stream.
    Other(String),
}

impl std::fmt::Display for CliProvisionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Spawn(m) => write!(f, "spawn `hq` failed: {m}"),
            // `validation_kind` is telemetry-only and deliberately absent from
            // the Display string — the frontend IPC contract depends on this
            // exact text staying unchanged.
            Self::Validation { message, .. } => {
                write!(f, "validation error from `hq cloud provision`: {message}")
            }
            Self::Network(m) => write!(f, "vault/network error from `hq cloud provision`: {m}"),
            // The exact prefix `"local environment failure (<kind>): "` is
            // part of the IPC contract — the frontend regex-parses the kind
            // out of this string to render the right "Fix in Claude Code"
            // button. Don't reword it without updating
            // `src/lib/copy-prompts.ts::parseLocalEnvFailure`.
            Self::LocalEnv { kind, detail } => {
                write!(f, "local environment failure ({kind}): {detail}")
            }
            Self::NoOutput { exit_code, slug } => {
                write!(
                    f,
                    "`hq cloud provision` exited {exit_code} with no stderr output \
                     (vault/network cause unproven) — see ~/.hq/logs/hq-sync.log \
                     [provision-cli] for slug={slug}"
                )
            }
            Self::Sync { message, .. } => {
                write!(f, "initial sync failed after entity provisioned: {message}")
            }
            Self::Other(m) => write!(f, "`hq cloud provision` failed: {m}"),
        }
    }
}

impl std::error::Error for CliProvisionError {}

impl From<CliProvisionError> for String {
    fn from(e: CliProvisionError) -> String {
        e.to_string()
    }
}

// ── Public entry point ───────────────────────────────────────────────────────

/// Spawn `hq cloud provision company <slug> [--name <name>] --hq-root <root>`
/// and parse the JSON result.
///
/// * `slug` — company slug (must match a top-level key under `.companies` in
///   `companies/manifest.yaml`). The CLI rejects `"personal"` itself.
/// * `display_name` — optional human-readable name forwarded as `--name`.
///   Falls back to the CLI's default (the slug) when None.
/// * `hq_root` — absolute path to the user's HQ folder. Forwarded as
///   `--hq-root <path>` AND set as the subprocess `current_dir`. Without
///   this the CLI defaults `--hq-root` to `~/hq` and bails with
///   `companies/manifest.yaml not found at /Users/<u>/hq/companies/manifest.yaml`
///   for any user whose HQ folder isn't at the lowercase default — exit 2
///   silently propagates back to the menubar with no UI feedback.
///
/// Stderr lines are tee'd into `~/.hq/logs/hq-sync.log` under the
/// `provision-cli` tag so a hung or failed provision leaves a trail.
///
/// On success the parsed `CliProvisionResult` is returned with
/// `result.ok == true` and `result.initial_sync.ok == true`. Exit code 3
/// (initial-sync failure after entity creation) is surfaced as
/// `CliProvisionError::Sync` carrying the partial result so the caller can
/// still record the `cloud_uid` and let the user retry the sync separately.
pub async fn run_cli_provision(
    slug: &str,
    display_name: Option<&str>,
    hq_root: &Path,
) -> Result<CliProvisionResult, CliProvisionError> {
    // `hq_resolver::resolve_hq()` self-heals when the user's local `hq`
    // is missing or older than the pinned floor (HQ_CLI_NPM_RANGE) by
    // routing through `npx -y --package=@indigoai-us/hq-cli@<range> hq`.
    // The capability probe is shared with first_push and cached for the
    // AppBar process lifetime, so this call is free after the first
    // invocation.
    //
    // The pinned range covers the cloud-provision flags this command needs
    // (`--skip-initial-sync` shipped in 5.6.1, `cloud provision company`
    // shipped in 5.6.0), so the resolver's choice is safe here.
    let invocation: HqInvocation = hq_resolver::resolve_hq();
    let path_env = paths::child_path();

    log(
        "provision-cli",
        &format!(
            "spawn ({}): hq cloud provision company {slug} --hq-root {}{}",
            invocation.label(),
            hq_root.display(),
            display_name
                .map(|n| format!(" --name {n:?}"))
                .unwrap_or_default()
        ),
    );

    // Serialize concurrent npx self-heal installs so they can't race the shared
    // ~/.npm/_npx cache (HQ-SYNC-6). No-op on the resolved-local fast path; held
    // until this provision subprocess completes.
    let _npx_guard = invocation.npx_serial_guard().await;

    let mut cmd = invocation.command();
    cmd.arg("cloud")
        .arg("provision")
        .arg("company")
        .arg(slug)
        // AppBar always opts out of the CLI's post-provision share() — our own
        // first_push_company runs with STS-vended per-company creds + Tauri
        // progress events. Pre-C3 this comment said "would otherwise upload
        // twice"; post-C3 we still want to keep this flag so the CLI doesn't
        // perform a Cognito-credentialed upload before AppBar's vend-child
        // upload runs (the two would race and produce different journal
        // states).
        .arg("--skip-initial-sync")
        // Pass the resolved HQ folder explicitly. The CLI defaults
        // `--hq-root` to `~/hq` (lowercase) — if the user's HQ folder is
        // anywhere else (e.g. `~/Documents/HQ`), the CLI exits 2 with
        // "companies/manifest.yaml not found at ..." and the menubar shows
        // nothing. `current_dir` is set to the same path as belt-and-
        // suspenders for any future code path that reads cwd-relative.
        .arg("--hq-root")
        .arg(hq_root)
        .current_dir(hq_root)
        .env("PATH", &path_env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if let Some(name) = display_name {
        cmd.arg("--name").arg(name);
    }

    // `kill_on_drop` ensures a panic / cancellation in the caller doesn't
    // leave an orphaned `hq` subprocess — we'd rather lose progress than
    // leak processes the user has no UI to kill.
    cmd.kill_on_drop(true);

    let invocation_kind = invocation.telemetry_kind();
    let sentry_invocation_label = invocation.sentry_label();
    let attempted_program = cmd.as_std().get_program().to_string_lossy().into_owned();
    // Measure wall-clock from just before spawn so a silent, slow child (the
    // reported occurrence ran ~58 s and printed nothing) carries its duration
    // as evidence on the failure event.
    let started = Instant::now();
    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(error) => {
            let diagnosis =
                runtime_diagnosis::inspect_spawn_failure(attempted_program.clone(), error.kind())
                    .await;
            return Err(finish_spawn_failure(
                slug,
                invocation_kind,
                &sentry_invocation_label,
                &error,
                diagnosis,
            ));
        }
    };

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| CliProvisionError::Other("child stdout pipe missing".to_string()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| CliProvisionError::Other("child stderr pipe missing".to_string()))?;

    // Drain both pipes concurrently with `child.wait()`: a chatty npx install
    // can't wedge a full pipe, and a non-UTF-8 byte can no longer end a reader
    // early and strip the tail (HQ-DESKTOP-68). Every stderr line is tee'd into
    // ~/.hq/logs/hq-sync.log inside `read_stderr_tail`.
    let (status, output) = tokio::join!(child.wait(), drain_child_output(stdout, stderr));
    let status = status.map_err(|e| CliProvisionError::Other(format!("wait child: {e}")))?;
    let duration_ms = started.elapsed().as_millis() as u64;

    let exit_code = status.code();
    log(
        "provision-cli",
        &format!(
            "exit code={:?}, parsed_json={}, slug={slug}, child_duration_ms={duration_ms}",
            exit_code,
            parse_provision_stdout(&output.stdout_lines).is_ok(),
        ),
    );
    if output.stderr_reader != ReaderOutcome::Eof {
        log(
            "provision-cli",
            &format!(
                "stderr reader ended abnormally: {}",
                output.stderr_reader.tag()
            ),
        );
    }
    if output.stdout_reader != ReaderOutcome::Eof {
        log(
            "provision-cli",
            &format!(
                "stdout reader ended abnormally: {}",
                output.stdout_reader.tag()
            ),
        );
    }

    finish_child_exit(
        slug,
        &invocation,
        attempted_program,
        exit_code,
        output,
        duration_ms,
    )
    .await
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::PathBuf;

    /// The struct must accept the exact JSON shape documented in
    /// `cloud-provision.ts::ProvisionResult`. Locks the CLI ↔ Rust contract.
    #[test]
    fn deserialize_success_payload() {
        let line = json!({
            "ok": true,
            "company_slug": "indigo",
            "cloud_uid": "cmp_01H123",
            "bucket_name": "hq-vault-cmp-01H123",
            "vault_api_url": "https://vault.example.com",
            "kms_key_id": "key-abc",
            "created_entity": true,
            "manifest_patched": true,
            "config_written": true,
            "initial_sync": {
                "ok": true,
                "files_uploaded": 42,
                "bytes_uploaded": 123456
            }
        })
        .to_string();
        let r: CliProvisionResult = serde_json::from_str(&line).unwrap();
        assert!(r.ok);
        assert_eq!(r.cloud_uid, "cmp_01H123");
        assert_eq!(r.bucket_name, "hq-vault-cmp-01H123");
        assert_eq!(r.kms_key_id.as_deref(), Some("key-abc"));
        assert_eq!(r.initial_sync.ok, Some(true));
        assert_eq!(r.initial_sync.files_uploaded, Some(42));
    }

    /// The CLI emits `kms_key_id: null` when the entity has no KMS key —
    /// must round-trip cleanly into Option<String>::None rather than erroring.
    #[test]
    fn deserialize_null_kms_key() {
        let line = json!({
            "ok": true,
            "company_slug": "acme",
            "cloud_uid": "cmp_x",
            "bucket_name": "hq-vault-cmp-x",
            "vault_api_url": "https://v",
            "kms_key_id": null,
            "created_entity": false,
            "manifest_patched": true,
            "config_written": true,
            "initial_sync": { "ok": true }
        })
        .to_string();
        let r: CliProvisionResult = serde_json::from_str(&line).unwrap();
        assert!(r.kms_key_id.is_none());
        assert_eq!(r.initial_sync.files_uploaded, None);
    }

    /// Partial-success payload (exit 3) — `initial_sync.ok: false` with an
    /// error message. Used by callers to record the cloud_uid and skip the
    /// follow-up sync gracefully.
    #[test]
    fn deserialize_exit3_partial_payload() {
        let line = json!({
            "ok": false,
            "company_slug": "acme",
            "cloud_uid": "cmp_partial",
            "bucket_name": "hq-vault-cmp-partial",
            "vault_api_url": "https://v",
            "kms_key_id": null,
            "created_entity": true,
            "manifest_patched": true,
            "config_written": true,
            "initial_sync": { "ok": false, "error": "S3 PutObject failed: timeout" }
        })
        .to_string();
        let r: CliProvisionResult = serde_json::from_str(&line).unwrap();
        assert!(!r.ok);
        assert_eq!(r.cloud_uid, "cmp_partial");
        assert_eq!(r.initial_sync.ok, Some(false));
        assert_eq!(
            r.initial_sync.error.as_deref(),
            Some("S3 PutObject failed: timeout"),
        );
    }

    /// AppBar always invokes the CLI with `--skip-initial-sync`, in which case
    /// the CLI emits `initial_sync: { skipped: true }` (no `ok` field). The
    /// Rust struct used to require `ok: bool`, so this payload silently failed
    /// to deserialize and the caller surfaced "exit 0 but no JSON line on
    /// stdout" — the actual stdout was fine, the parser was wrong. Lock the
    /// contract here so it can't regress.
    #[test]
    fn deserialize_skip_initial_sync_payload() {
        let line = json!({
            "ok": true,
            "company_slug": "bug2-verify",
            "cloud_uid": "cmp_01KQSR92SNH",
            "bucket_name": "hq-vault-cmp-01kqsr92snh21n8nba2r77zaqk",
            "vault_api_url": "https://v",
            "kms_key_id": null,
            "created_entity": true,
            "manifest_patched": true,
            "config_written": true,
            "initial_sync": { "skipped": true }
        })
        .to_string();
        let r: CliProvisionResult = serde_json::from_str(&line).unwrap();
        assert!(r.ok);
        assert_eq!(r.initial_sync.skipped, Some(true));
        assert_eq!(r.initial_sync.ok, None);
        assert_eq!(r.initial_sync.files_uploaded, None);
    }

    #[test]
    fn parse_stdout_finds_result_before_trailing_npm_fund_noise() {
        let result = json!({
            "ok": true,
            "company_slug": "acme",
            "cloud_uid": "cmp_acme",
            "bucket_name": "hq-vault-cmp-acme",
            "vault_api_url": "https://vault.example.com",
            "created_entity": true,
            "manifest_patched": true,
            "config_written": true,
            "initial_sync": { "skipped": true }
        })
        .to_string();
        let lines = vec![
            "npm notice 1 package is looking for funding".to_string(),
            result,
            "npm notice Run `npm fund` for details".to_string(),
        ];

        let parsed = parse_provision_stdout(&lines).expect("must ignore npm noise");
        assert_eq!(parsed.company_slug, "acme");
        assert_eq!(parsed.cloud_uid, "cmp_acme");
    }

    #[test]
    fn parse_stdout_ignores_non_result_json_and_ansi_prefixes() {
        let result = json!({
            "ok": true,
            "company_slug": "acme",
            "cloud_uid": "cmp_acme",
            "bucket_name": "hq-vault-cmp-acme",
            "vault_api_url": "https://vault.example.com",
            "created_entity": false,
            "manifest_patched": true,
            "config_written": true,
            "initial_sync": { "ok": true }
        });
        let lines = vec![
            "{\"npm\":\"diagnostic only\"}".to_string(),
            format!("\u{1b}[32mnpm notice result: {}\u{1b}[0m", result),
            "npm notice Run `npm fund` for details".to_string(),
        ];

        let parsed = parse_provision_stdout(&lines).expect("must find the provision object");
        assert_eq!(parsed.company_slug, "acme");
        assert!(parsed.initial_sync.ok.unwrap());
    }

    #[test]
    fn parse_stdout_preserves_a_real_json_schema_error() {
        let lines = vec![
            "npm notice Run `npm fund` for details".to_string(),
            "{\"ok\":true,\"company_slug\":\"acme\"}".to_string(),
        ];

        let error = parse_provision_stdout(&lines).expect_err("incomplete result must fail");
        assert!(error.contains("stdout JSON failed to parse"), "{error}");
        assert!(error.contains("cloud_uid"), "{error}");
    }

    #[test]
    fn error_display_smoke() {
        let e = CliProvisionError::Validation {
            message: "bad slug".to_string(),
            validation_kind: "unclassified",
        };
        assert!(e.to_string().contains("validation"));
        assert!(
            e.to_string().ends_with("bad slug"),
            "validation_kind must not leak into the IPC Display string: {e}"
        );
        let e = CliProvisionError::Network("503".to_string());
        assert!(e.to_string().contains("network"));
        let e = CliProvisionError::Sync {
            message: "timeout".to_string(),
            partial: None,
        };
        assert!(e.to_string().contains("initial sync"));
    }

    /// The Display string for `LocalEnv` is part of the IPC contract — the
    /// Svelte frontend parses `local environment failure (<kind>): <detail>`
    /// to extract `kind` for the `OpenInClaudeCodeButton`. Locking the prefix
    /// here so a casual reword can't silently break the popover.
    #[test]
    fn local_env_display_contract_is_parseable() {
        let e = CliProvisionError::LocalEnv {
            kind: "npm-cache-permission",
            detail: "~/.npm cache contains root-owned files".to_string(),
        };
        let s = e.to_string();
        assert!(
            s.starts_with("local environment failure ("),
            "Display must start with the parseable prefix; got {s:?}",
        );
        assert!(s.contains("(npm-cache-permission)"));
        assert!(s.contains("root-owned"));
    }

    /// Classifier: npm cache EACCES (the canonical example from the
    /// HQ-SYNC-WEB-E Sentry alert that motivated this code). Must classify
    /// regardless of which npm flavour text is in stderr (modern "npm error"
    /// vs. legacy "npm ERR!" prefix) and must surface the cache path detail
    /// when present so the popover prompt names the right directory.
    #[test]
    fn classify_npm_eacces_modern() {
        let tail: Vec<String> = vec![
            "npm error code EACCES".to_string(),
            "npm error syscall open".to_string(),
            "npm error path /Users/alice/.npm/_cacache/index-v5/aa/bb/foo".to_string(),
            "npm error errno EACCES".to_string(),
        ];
        let (kind, detail) = classify_local_env_failure(&tail).expect("must classify");
        assert_eq!(kind, "npm-cache-permission");
        assert!(
            detail.contains("/Users/alice/.npm"),
            "detail should carry the offending cache path; got {detail:?}",
        );
    }

    #[test]
    fn classify_npm_eacces_legacy() {
        let tail: Vec<String> = vec![
            "npm ERR! code EACCES".to_string(),
            "npm ERR! path /Users/bob/.npm/_cacache/x".to_string(),
        ];
        let (kind, _detail) = classify_local_env_failure(&tail).expect("must classify");
        assert_eq!(kind, "npm-cache-permission");
    }

    #[test]
    fn classify_disk_full() {
        let tail: Vec<String> = vec![
            "npm error code ENOSPC".to_string(),
            "ENOSPC: no space left on device, write".to_string(),
        ];
        let (kind, _detail) = classify_local_env_failure(&tail).expect("must classify");
        assert_eq!(kind, "disk-full");
    }

    #[test]
    fn classify_registry_unreachable() {
        let tail: Vec<String> = vec![
            "npm error code ENOTFOUND".to_string(),
            "npm error errno ENOTFOUND".to_string(),
            "npm error network getaddrinfo ENOTFOUND registry.npmjs.org".to_string(),
        ];
        let (kind, detail) = classify_local_env_failure(&tail).expect("must classify");
        assert_eq!(kind, "npm-registry-unreachable");
        assert!(detail.contains("registry.npmjs.org") || detail.contains("ENOTFOUND"));
    }

    #[test]
    fn classify_registry_timeout() {
        let tail: Vec<String> = vec![
            "npm error code ETIMEDOUT".to_string(),
            "connect ETIMEDOUT 104.16.0.0:443".to_string(),
        ];
        let (kind, _detail) = classify_local_env_failure(&tail).expect("must classify");
        assert_eq!(kind, "npm-registry-timeout");
    }

    /// Vault-flavoured stderr (genuine CLI 5xx) must NOT classify as
    /// local-env — otherwise the alert routing flips the wrong way and real
    /// vault incidents go quiet. This is the inverse of the original bug.
    #[test]
    fn classify_vault_error_returns_none() {
        let tail: Vec<String> = vec![
            "[hq cloud provision] vault POST /v1/entity returned 503".to_string(),
            "Error: vault unreachable after 3 retries".to_string(),
        ];
        assert!(classify_local_env_failure(&tail).is_none());
    }

    /// Empty stderr — defensive: the classifier must never panic on a tail
    /// that's empty or carries only whitespace. Returning None lets the
    /// caller fall back to the generic Network mapping.
    #[test]
    fn classify_empty_stderr_returns_none() {
        assert!(classify_local_env_failure(&[]).is_none());
        let tail: Vec<String> = vec!["".to_string(), "  ".to_string()];
        assert!(classify_local_env_failure(&tail).is_none());
    }

    // ── Exit-2 validation subclassing (HQ-DESKTOP-6A) ─────────────────────────

    /// The reported 6A/6B stderr: a resolved HQ root with no manifest.
    #[test]
    fn classify_validation_manifest_missing() {
        let tail = vec![
            "[hq cloud provision] companies/manifest.yaml not found at /Users/isa/hq/companies/manifest.yaml"
                .to_string(),
        ];
        assert_eq!(classify_setup_validation_failure(&tail), "manifest-missing");
    }

    /// An `npm warn` line printed before the CLI's own message must not defeat
    /// the match — the classifier reads the joined blob, like the exit-1 arm.
    #[test]
    fn classify_validation_manifest_missing_survives_npm_warn_prefix() {
        let tail = vec![
            "npm warn exec The following package was not found and will be installed: @indigoai-us/hq-cli@5.109.10".to_string(),
            "[hq cloud provision] companies/manifest.yaml not found at /Users/isa/hq/companies/manifest.yaml".to_string(),
        ];
        assert_eq!(classify_setup_validation_failure(&tail), "manifest-missing");
    }

    /// The sibling exit-2 shapes each land in their own closed-vocabulary bucket.
    #[test]
    fn classify_validation_sibling_shapes() {
        assert_eq!(
            classify_setup_validation_failure(&[
                "[hq cloud provision] manifest.yaml is malformed: could not parse YAML".to_string(),
            ]),
            "manifest-malformed"
        );
        assert_eq!(
            classify_setup_validation_failure(&[
                "[hq cloud provision] slug `seo-brand` not found under `.companies` in manifest"
                    .to_string(),
            ]),
            "slug-not-in-manifest"
        );
        assert_eq!(
            classify_setup_validation_failure(&[
                "[hq cloud provision] company directory companies/seo-brand does not exist"
                    .to_string(),
            ]),
            "company-dir-missing"
        );
        assert_eq!(
            classify_setup_validation_failure(&[
                "[hq cloud provision] company seo-brand status=archived; refusing to provision"
                    .to_string(),
            ]),
            "archived"
        );
    }

    /// A genuinely unexpected validation message (or none at all) must fall
    /// through to `unclassified` so it is NOT silently downgraded to Warning.
    #[test]
    fn classify_validation_unknown_is_unclassified() {
        assert_eq!(classify_setup_validation_failure(&[]), "unclassified");
        assert_eq!(
            classify_setup_validation_failure(&[
                "[hq cloud provision] slug must match ^[a-z][a-z0-9-]*$".to_string(),
            ]),
            "unclassified"
        );
    }

    /// The Warning downgrade applies to exactly the closed set of setup-
    /// incomplete subclasses; `unclassified` stays Error.
    #[test]
    fn setup_incomplete_set_is_closed_and_excludes_unclassified() {
        for k in [
            "manifest-missing",
            "manifest-malformed",
            "slug-not-in-manifest",
            "company-dir-missing",
            "archived",
        ] {
            assert!(is_setup_incomplete_validation(k), "{k} should downgrade");
        }
        assert!(!is_setup_incomplete_validation("unclassified"));
    }

    /// The Some(2) arm threads the subclass through from the combined
    /// stderr+stdout tail while keeping the message text unchanged. Here the
    /// manifest line arrives on stdout (npm can write there), proving the arm
    /// classifies over both streams.
    #[test]
    fn classify_child_exit_exit2_threads_validation_kind_from_combined_tail() {
        let out = child_output(
            vec!["[hq cloud provision] companies/manifest.yaml not found at /x/hq/companies/manifest.yaml"],
            vec![],
        );
        let err = classify_child_exit(Some(2), &out, "seo-brand").expect_err("exit 2 is an error");
        match err {
            CliProvisionError::Validation {
                validation_kind,
                message,
            } => {
                assert_eq!(validation_kind, "manifest-missing");
                assert!(message.contains("for slug=seo-brand"), "{message}");
                assert!(message.contains("exit 2 (validation)"), "{message}");
            }
            other => panic!("expected Validation, got {other:?}"),
        }
    }

    /// Exit 2 with no CLI message stays `unclassified` (kept at Error by the
    /// reporter) rather than being mistaken for a setup subclass.
    #[test]
    fn classify_child_exit_exit2_empty_is_unclassified() {
        let out = child_output(vec![], vec![]);
        let err = classify_child_exit(Some(2), &out, "seo-brand").expect_err("exit 2 is an error");
        assert!(matches!(
            err,
            CliProvisionError::Validation {
                validation_kind: "unclassified",
                ..
            }
        ));
    }

    /// `From<CliProvisionError> for String` lets callers `?`-propagate into
    /// Tauri commands whose error type is `String`. Smoke-test the conversion.
    #[test]
    fn into_string_for_tauri_command() {
        let e = CliProvisionError::Spawn("not on PATH".to_string());
        let s: String = e.into();
        assert!(s.contains("spawn"));
        assert!(s.contains("not on PATH"));
    }

    #[test]
    fn proven_missing_node_is_returned_and_logged_without_a_sentry_event() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let log_path = tmp.path().join("hq-sync.log");
        let _guard = crate::logfile::LogOverrideGuard::new(log_path.clone());
        let private_detail = "/Users/Ada/.nvm/npx was not found";
        let spawn_error = std::io::Error::new(std::io::ErrorKind::NotFound, private_detail);
        let diagnosis = RuntimeDiagnosisInput {
            attempted_program: "npx".to_string(),
            program_provenance: runtime_diagnosis::ProgramProvenance::BareName,
            spawn_error_kind: std::io::ErrorKind::NotFound,
            node_probe: runtime_diagnosis::ProbeOutcome::NotFound,
            npx_probe: runtime_diagnosis::ProbeOutcome::NotFound,
            managed_runtime: crate::toolchain::ManagedRuntime::NotProvisioned,
        };
        let result = std::cell::RefCell::new(None);

        let captures = sentry::test::with_captured_events(|| {
            result.replace(Some(finish_spawn_failure(
                "acme",
                "npx",
                "npx:@indigoai-us/hq-cli@^5.10.0",
                &spawn_error,
                diagnosis,
            )));
        });

        assert!(
            captures.is_empty(),
            "a proven user-owned setup gap stays local"
        );
        let error = result.into_inner().expect("spawn failure result");
        assert!(matches!(
            &error,
            CliProvisionError::LocalEnv {
                kind: "node-missing",
                ..
            }
        ));
        assert!(error
            .to_string()
            .starts_with("local environment failure (node-missing):"));
        assert!(
            !error.to_string().contains(private_detail),
            "private diagnostic detail must not cross the Tauri IPC boundary",
        );
        assert!(
            error
                .to_string()
                .contains("Install Node.js and reopen HQ Sync"),
            "the returned detail must stay bounded and actionable",
        );
        let log = std::fs::read_to_string(log_path).expect("local diagnostic log");
        assert!(log.contains(private_detail));
        assert!(log.contains("node_probe=NotFound"));
        assert!(log.contains("npx_probe=NotFound"));
    }

    #[test]
    fn proven_npx_gap_keeps_the_managed_node_path_out_of_ipc() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let log_path = tmp.path().join("hq-sync.log");
        let _guard = crate::logfile::LogOverrideGuard::new(log_path.clone());
        let managed_node = PathBuf::from(
            "/Users/Ada/Library/Application Support/Indigo HQ/toolchain/node/bin/node",
        );
        let spawn_error = std::io::Error::new(std::io::ErrorKind::NotFound, "npx missing");
        let diagnosis = RuntimeDiagnosisInput {
            attempted_program: "npx".to_string(),
            program_provenance: runtime_diagnosis::ProgramProvenance::BareName,
            spawn_error_kind: std::io::ErrorKind::NotFound,
            node_probe: runtime_diagnosis::ProbeOutcome::Ok,
            npx_probe: runtime_diagnosis::ProbeOutcome::NotFound,
            managed_runtime: crate::toolchain::ManagedRuntime::Present {
                node: managed_node.clone(),
            },
        };

        let error = finish_spawn_failure(
            "acme",
            "npx",
            "npx:@indigoai-us/hq-cli@^5.10.0",
            &spawn_error,
            diagnosis,
        );
        let ipc = error.to_string();

        assert!(ipc.starts_with("local environment failure (npx-unavailable):"));
        assert!(!ipc.contains(&managed_node.to_string_lossy().to_string()));
        assert!(ipc.contains("Repair or reinstall Node.js and reopen HQ Sync"));
        let log = std::fs::read_to_string(log_path).expect("local diagnostic log");
        assert!(log.contains(&managed_node.to_string_lossy().to_string()));
    }

    // ── No-output classification (HQ-DESKTOP-68) ──────────────────────────────

    fn child_output(stdout_lines: Vec<&str>, stderr_tail: Vec<&str>) -> ChildOutput {
        let stdout_lines: Vec<String> = stdout_lines.into_iter().map(String::from).collect();
        let stdout_tail = last_n(&stdout_lines, STDOUT_TAIL_CAP);
        let stderr_tail: Vec<String> = stderr_tail.into_iter().map(String::from).collect();
        let stderr_had_nonblank = stderr_tail.iter().any(|l| !l.trim().is_empty());
        let stderr_line_count = stderr_tail.len();
        ChildOutput {
            stdout_lines,
            stdout_tail,
            stderr_tail,
            stdout_reader: ReaderOutcome::Eof,
            stderr_reader: ReaderOutcome::Eof,
            stderr_line_count,
            stderr_had_nonblank,
        }
    }

    #[test]
    fn classify_child_exit_no_stderr_is_no_output_not_network() {
        // THE regression: exit 1 with an empty stderr tail is no longer a false
        // vault/network incident.
        let out = child_output(vec![], vec![]);
        let err = classify_child_exit(Some(1), &out, "arbium").expect_err("exit 1 is an error");
        assert!(
            matches!(err, CliProvisionError::NoOutput { exit_code: 1, .. }),
            "empty exit-1 must be no-output, not vault/network; got {err:?}"
        );
    }

    #[test]
    fn classify_child_exit_keeps_network_when_stderr_has_unclassified_text() {
        let out = child_output(
            vec![],
            vec!["[hq cloud provision] vault POST /v1/entity returned 503"],
        );
        let err = classify_child_exit(Some(1), &out, "arbium").expect_err("exit 1 is an error");
        assert!(matches!(err, CliProvisionError::Network(_)), "got {err:?}");
        assert!(err.to_string().contains("vault/network"));
    }

    #[test]
    fn classify_child_exit_reads_npm_errors_from_stdout_tail() {
        // npm may write its error blob to stdout; the combined-tail classifier
        // must still bucket it as local-env rather than no-output.
        let out = child_output(
            vec!["npm error code EACCES", "npm error path /x/.npm/_cacache"],
            vec![],
        );
        let err = classify_child_exit(Some(1), &out, "arbium").expect_err("exit 1 is an error");
        assert!(
            matches!(
                err,
                CliProvisionError::LocalEnv {
                    kind: "npm-cache-permission",
                    ..
                }
            ),
            "got {err:?}"
        );
    }

    #[test]
    fn no_output_display_carries_exit_code_and_slug_without_paths() {
        let e = CliProvisionError::NoOutput {
            exit_code: 1,
            slug: "arbium".to_string(),
        };
        let s = e.to_string();
        assert!(s.contains("exited 1"), "{s}");
        assert!(s.contains("slug=arbium"), "{s}");
        assert!(!s.contains("/Users/") && !s.contains("/home/"), "{s}");
    }

    #[test]
    fn no_output_report_attaches_evidence_extras_reader_tags_and_fingerprint() {
        let runtime = RuntimeDiagnosisInput {
            attempted_program: "/opt/homebrew/bin/npx".to_string(),
            program_provenance: runtime_diagnosis::ProgramProvenance::SystemPath,
            spawn_error_kind: std::io::ErrorKind::Other,
            node_probe: runtime_diagnosis::ProbeOutcome::Ok,
            npx_probe: runtime_diagnosis::ProbeOutcome::Ok,
            managed_runtime: crate::toolchain::ManagedRuntime::NotProvisioned,
        };
        let output = child_output(vec![], vec![]);
        let mut err = None;
        let events = sentry::test::with_captured_events(|| {
            err = Some(finish_child_exit_for_test(
                "arbium",
                &HqInvocation::Npx,
                Some(1),
                output,
                58_000,
                Some(runtime),
                Some(26),
            ));
        });

        assert!(matches!(err, Some(Err(CliProvisionError::NoOutput { .. }))));
        assert_eq!(events.len(), 1);
        let event = &events[0];
        assert_eq!(event.level, sentry::Level::Error);
        assert_eq!(event.tags["provision_kind"], "no-output");
        assert_eq!(
            event.tags["cli_invocation"],
            "npx:@indigoai-us/hq-cli@^5.10.0"
        );
        assert_eq!(event.tags["exit_code"], "1");
        assert_eq!(event.tags["stderr_reader"], "eof");
        assert_eq!(event.tags["stdout_reader"], "eof");
        assert_eq!(event.tags["program_provenance"], "system-path");
        assert_eq!(event.tags["runtime_owner"], "user");
        assert_eq!(event.tags["node_probe"], "ok");
        assert_eq!(event.tags["npx_probe"], "ok");
        assert_eq!(event.tags["node_major"], "26");
        assert_eq!(
            event.extra["child_duration_ms"],
            serde_json::Value::from(58_000u64)
        );
        assert_eq!(event.extra["stderr_lines"], serde_json::Value::from(0u64));
        assert_eq!(event.extra["stdout_lines"], serde_json::Value::from(0u64));
        assert!(event.extra.contains_key("stdout_tail"));
        let fingerprint: Vec<&str> = event.fingerprint.iter().map(|c| c.as_ref()).collect();
        assert_eq!(fingerprint, ["provision-cli", "no-output", "npx", "1"]);
    }

    #[test]
    fn classify_child_exit_uses_observed_nonblank_not_the_truncated_tail() {
        // Codex P2: a real diagnostic evicted by >50 trailing blank lines leaves
        // an all-blank tail, but stderr DID speak, so exit 1 must stay Network —
        // never derive that decision from the capped tail.
        let blanks: Vec<String> = std::iter::repeat(String::new())
            .take(STDERR_TAIL_CAP)
            .collect();
        let output = ChildOutput {
            stdout_lines: vec![],
            stdout_tail: vec![],
            stderr_tail: blanks,
            stdout_reader: ReaderOutcome::Eof,
            stderr_reader: ReaderOutcome::Eof,
            stderr_line_count: STDERR_TAIL_CAP + 11,
            stderr_had_nonblank: true,
        };
        let err = classify_child_exit(Some(1), &output, "arbium").expect_err("exit 1 is an error");
        assert!(matches!(err, CliProvisionError::Network(_)), "got {err:?}");
    }

    #[test]
    fn report_emits_full_stderr_line_count_not_the_capped_tail() {
        // Codex P2: the stderr_lines extra must report the true volume, not
        // min(count, 50) — so a chatty failure is distinguishable from a quiet
        // one, symmetric with stdout_lines.
        let output = ChildOutput {
            stdout_lines: vec![],
            stdout_tail: vec![],
            stderr_tail: vec!["some vault error".to_string()],
            stdout_reader: ReaderOutcome::Eof,
            stderr_reader: ReaderOutcome::Eof,
            stderr_line_count: 1234,
            stderr_had_nonblank: true,
        };
        let events = sentry::test::with_captured_events(|| {
            let _ = finish_child_exit_for_test(
                "arbium",
                &HqInvocation::Npx,
                Some(1),
                output,
                10,
                None,
                None,
            );
        });
        assert_eq!(events.len(), 1);
        assert_eq!(
            events[0].extra["stderr_lines"],
            serde_json::Value::from(1234u64)
        );
    }

    #[cfg(unix)]
    async fn spawn_sh(script: &str) -> (ChildStdout, ChildStderr, tokio::process::Child) {
        let mut child = tokio::process::Command::new("sh")
            .arg("-c")
            .arg(script)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn sh");
        let stdout = child.stdout.take().expect("stdout pipe");
        let stderr = child.stderr.take().expect("stderr pipe");
        (stdout, stderr, child)
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn drain_child_output_keeps_lines_after_invalid_utf8() {
        // A 0xFF byte used to end the reader loop (Lines::next_line →
        // InvalidData), stripping the tail — the exact mechanism that let an
        // exit-1 provision reach Sentry with an empty tail (HQ-DESKTOP-68).
        let (stdout, stderr, mut child) =
            spawn_sh("printf 'o\\377ut1\\nout2\\n'; printf 'e\\377rr1\\nerr2\\n' >&2; exit 1")
                .await;
        let output = drain_child_output(stdout, stderr).await;
        let _ = child.wait().await;

        assert_eq!(output.stderr_reader, ReaderOutcome::Eof);
        assert_eq!(output.stdout_reader, ReaderOutcome::Eof);
        assert_eq!(
            output.stderr_tail,
            vec!["e\u{FFFD}rr1".to_string(), "err2".to_string()]
        );
        assert_eq!(
            output.stdout_lines,
            vec!["o\u{FFFD}ut1".to_string(), "out2".to_string()]
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn drain_child_output_caps_stdout_tail_at_50_and_keeps_full_lines_for_parsing() {
        let (stdout, stderr, mut child) =
            spawn_sh("i=1; while [ $i -le 60 ]; do echo line$i; i=$((i+1)); done").await;
        let output = drain_child_output(stdout, stderr).await;
        let _ = child.wait().await;

        assert_eq!(
            output.stdout_lines.len(),
            60,
            "full stdout feeds the parser"
        );
        assert_eq!(output.stdout_tail.len(), STDOUT_TAIL_CAP);
        assert_eq!(output.stdout_tail.first().unwrap(), "line11");
        assert_eq!(output.stdout_tail.last().unwrap(), "line60");
        assert_eq!(output.stdout_reader, ReaderOutcome::Eof);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn drain_child_output_reports_eof_on_clean_exit() {
        let (stdout, stderr, mut child) = spawn_sh("echo hello; echo oops >&2; exit 0").await;
        let output = drain_child_output(stdout, stderr).await;
        let _ = child.wait().await;

        assert_eq!(output.stdout_reader, ReaderOutcome::Eof);
        assert_eq!(output.stderr_reader, ReaderOutcome::Eof);
        assert_eq!(output.stdout_lines, vec!["hello".to_string()]);
        assert_eq!(output.stderr_tail, vec!["oops".to_string()]);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn drain_tracks_full_stderr_count_and_nonblank_beyond_the_cap() {
        // Codex P2 (both findings) at the source: one real line then 60 blanks.
        // The real line is evicted from the 50-line ring, but the drain still
        // reports that stderr spoke and counts all 61 lines — so the failure
        // stays Network and stderr_lines is not clamped to 50.
        let (stdout, stderr, mut child) = spawn_sh(
            "echo 'real vault error' >&2; i=1; while [ $i -le 60 ]; do echo '' >&2; i=$((i+1)); done; exit 1",
        )
        .await;
        let output = drain_child_output(stdout, stderr).await;
        let _ = child.wait().await;

        assert!(
            output.stderr_had_nonblank,
            "the real line must be remembered past the cap"
        );
        assert_eq!(
            output.stderr_line_count, 61,
            "full count, not the capped ring length"
        );
        assert_eq!(output.stderr_tail.len(), STDERR_TAIL_CAP);
        assert!(
            output.stderr_tail.iter().all(|l| l.trim().is_empty()),
            "the tail is all blanks once the real line is evicted"
        );

        let err = classify_child_exit(Some(1), &output, "arbium").expect_err("exit 1 is an error");
        assert!(matches!(err, CliProvisionError::Network(_)), "got {err:?}");
    }
}
