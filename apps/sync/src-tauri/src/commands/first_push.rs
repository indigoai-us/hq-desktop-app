//! First-push: shell out to `hq sync push --creds-from-stdin --json` to
//! upload every local file under a company folder to S3 after provisioning.
//!
//! ## Why a subprocess and not direct S3 calls
//!
//! Before Option C3 of the cloud-promote consolidation, this file held a
//! 719-line independent S3 upload implementation (WalkDir, journal, retry,
//! per-file PUT). That duplicated `share()` from `@indigoai-us/hq-cloud`
//! line-for-line — every bug fix had to land in both places, and the two
//! implementations had subtly different ignore rules and conflict semantics.
//!
//! After C3, the canonical upload path is `hq sync push` (which uses
//! `share()` under the hood). AppBar still owns:
//!
//! * **STS-vending via `/sts/vend-child`** — normally preserves task-scoped
//!   audit traceability (`task_id` + `task_description` + `task_scope`) that
//!   `/sts/vend` doesn't carry. If the grant policy exceeds STS limits and the
//!   existing fallback flag is enabled, first push discards the credentials and
//!   uses the regular company presign transport instead.
//! * **Tauri event emission** — the menubar UI subscribes to per-file
//!   progress and a terminal complete event. We translate from the CLI's
//!   stderr JSONL stream (`--json`) into these Tauri events 1:1.
//!
//! See `workspace/reports/cloud-promote-architecture-2026-04-27.md` and
//! the C3 PR description in `repos/private/hq-sync` for the full rationale.
//!
//! ## Subprocess contract
//!
//! Argv:
//!
//! ```text
//! hq sync push [--creds-from-stdin] --json --company <slug> --hq-root <path> <company_dir>
//! ```
//! The normal STS path uses `--creds-from-stdin`. The overflow fallback omits
//! it and sets `HQ_STATE_DIR` to a short-lived, private snapshot of the same
//! person session that authenticated `/sts/vend-child`.
//!
//! Normal-path stdin: a single JSON document conforming to `@indigoai-us/hq-cloud`'s
//! `EntityContext` shape (camelCase keys):
//!
//! ```json
//! {
//!   "uid": "cmp_...",
//!   "slug": "...",
//!   "bucketName": "hq-vault-...",
//!   "region": "us-east-1",
//!   "credentials": {
//!     "accessKeyId": "...",
//!     "secretAccessKey": "...",
//!     "sessionToken": "..."
//!   },
//!   "expiresAt": "2026-..."
//! }
//! ```
//!
//! Stderr (JSON Lines, one record per line):
//!
//! * `{"type":"plan", "filesToUpload": N, "bytesToUpload": N, ...}` — once at start
//! * `{"type":"progress", "path": "...", "bytes": N, "message"?: "..."}` — per uploaded file
//! * `{"type":"conflict", "path": "...", "direction":"push", "resolution": "..."}`
//! * `{"type":"error", "path": "...", "message": "..."}`
//! * `{"type":"complete", "filesUploaded": N, "bytesUploaded": N, "filesSkipped": N, "conflictPaths": [...], "aborted": bool}` — once at end
//! * `{"type":"fatal", "message": "..."}` — on terminal failure (instead of aborting silently)
//!
//! Exit codes:
//!
//! * `0` — success; `complete` event has been emitted with final counts
//! * `1` — terminal failure; `fatal` event sent to stderr first, OR an
//!   `aborted` complete event was emitted (conflict-strategy abort)
//!
//! ## Why we normally vend ourselves vs. letting share() vend
//!
//! AppBar already has the STS infrastructure (`vend_child`, task scoping).
//! The regular path preserves the task-scoped audit metadata. The overflow
//! fallback uses share()'s normal presigned company transport because no STS
//! credential can safely cover the complete grant set.

use std::process::Stdio;
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

use hq_desktop_core::first_push::{CliEvent, EntityContextPayload, EntityCredentials};
use hq_desktop_core::runner_error_shape::PreRunnerCause;
use tauri::Emitter;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

use crate::commands::provision::ProvisionedCompany;
use crate::commands::vault_client::{
    TaskScope, VaultClient, VaultClientError, VendChildInput, VendChildResult,
};
use crate::events::{
    SyncCompanyFirstPushCompleteEvent, SyncCompanyFirstPushProgressEvent,
    EVENT_SYNC_COMPANY_FIRST_PUSH_COMPLETE, EVENT_SYNC_COMPANY_FIRST_PUSH_PROGRESS,
};
use crate::util::hq_resolver::{self, HqInvocation};
use crate::util::logfile::log;
use crate::util::paths;

// ── Typed failure ───────────────────────────────────────────────────────────

/// A typed first-push failure (HQ-DESKTOP-64). The desktop holds the HTTP status
/// as a typed `u16` at the `/sts/vend-child` seam exactly once; the pre-typed code
/// collapsed it to prose there, so a first-push 403 that preceded a runner exit
/// was invisible on the exit event. This type preserves the status and the derived
/// cause so the caller can record pre-runner attribution AND report content-safe.
///
/// `message` keeps the EXACT human-readable text the pre-typed code produced, and
/// `Display` renders only that message, so the caller's local log line and both
/// Tauri events (`EVENT_SYNC_COMPANY_FIRST_PUSH_FAILED` / `EVENT_SYNC_ERROR`) stay
/// byte-identical to before.
#[derive(Debug, Clone)]
pub struct FirstPushFailure {
    /// The typed HTTP status, present ONLY for the vend-child seam (the one site
    /// whose error carries it). Every other seam is status-less.
    pub status: Option<u16>,
    /// The derived, content-safe cause identity.
    pub cause: PreRunnerCause,
    /// The exact prose the pre-typed code produced (log + UI parity).
    pub message: String,
}

impl FirstPushFailure {
    /// A status-less failure at a non-vend seam (serialize / spawn / stdin / wait /
    /// fatal / non-zero exit / aborted / no-complete): every one maps to the fixed
    /// `push_failed` cause with no HTTP status.
    fn push_failed(message: String) -> Self {
        Self {
            status: None,
            cause: PreRunnerCause::PushFailed,
            message,
        }
    }
}

impl std::fmt::Display for FirstPushFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Render exactly the message so `{e}` in the caller's existing log line is
        // byte-identical to the pre-typed `String` return.
        write!(f, "{}", self.message)
    }
}

/// Derive the typed HTTP status and pre-runner cause from a vend-child error,
/// BEFORE it is collapsed into prose. The vend-child seam is the ONLY first-push
/// site whose error carries a typed status. A body with a scope-exceeds marker
/// maps to the dedicated `ScopeExceedsParent` cause (the observed HQ-DESKTOP-63/64
/// chain, and the same condition `is_expected_acl_scope_skip` suppresses), any
/// other HTTP status to `VendHttp`, and the transport / protocol / ownership
/// variants to their fixed status-less causes.
fn classify_vend_child_error(err: &VaultClientError) -> (Option<u16>, PreRunnerCause) {
    match err {
        VaultClientError::Http { status, body } => {
            // Mirror `is_expected_acl_scope_skip`'s two markers on the raw body so
            // the cause classification and the caller's expected-skip suppression
            // always agree on the same fault.
            let lowered = body.to_lowercase();
            let cause = if lowered.contains("scope_exceeds_parent")
                || lowered.contains("outside granted acl scope")
            {
                PreRunnerCause::ScopeExceedsParent
            } else {
                PreRunnerCause::VendHttp
            };
            (Some(*status), cause)
        }
        VaultClientError::Request(_) => (None, PreRunnerCause::VendTransport),
        VaultClientError::Json(_) => (None, PreRunnerCause::VendProtocol),
        VaultClientError::SelfOwnershipMismatch => (None, PreRunnerCause::OwnershipMismatch),
    }
}

enum FirstPushTransport {
    Sts(VendChildResult),
    Presigned,
}

/// Select the complete first-push transport. Partial credentials are never
/// used: the server's fallback code is emitted only for a policy overflow when
/// `vault.write-presign-fallback` is enabled. An unexpected truncated success
/// payload is refused rather than transferred through either transport.
fn select_first_push_transport(
    result: Result<VendChildResult, VaultClientError>,
) -> Result<FirstPushTransport, VaultClientError> {
    match result {
        Ok(vend) if vend.policy_truncated || !vend.dropped_write_grant_prefixes.is_empty() => {
            Err(VaultClientError::Json(
                "vend-child returned partial credentials; refusing first push".to_string(),
            ))
        }
        Ok(vend) => Ok(FirstPushTransport::Sts(vend)),
        Err(err) if is_presign_fallback_signal(&err) => Ok(FirstPushTransport::Presigned),
        Err(err) => Err(err),
    }
}

fn is_presign_fallback_signal(err: &VaultClientError) -> bool {
    match err {
        VaultClientError::Http { status: 409, body } => {
            serde_json::from_str::<serde_json::Value>(body)
                .ok()
                .and_then(|value| {
                    value
                        .get("code")
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_owned)
                })
                .as_deref()
                == Some("POLICY_PRESIGN_FALLBACK_REQUIRED")
        }
        _ => false,
    }
}

fn presigned_fallback_event_is_incomplete(event_type: &str) -> bool {
    matches!(event_type, "error" | "scope-excluded" | "not-shipped")
}

fn configure_sync_push_command(
    cmd: &mut Command,
    company_slug: &str,
    hq_root: &Path,
    company_dir: &Path,
    use_presigned_transport: bool,
) {
    cmd.arg("sync").arg("push");
    if !use_presigned_transport {
        cmd.arg("--creds-from-stdin");
    }
    cmd.arg("--json")
        .arg("--company")
        .arg(company_slug)
        .arg("--hq-root")
        .arg(hq_root.as_os_str())
        .arg(company_dir.as_os_str());
}

struct PresignFallbackAuthSnapshot {
    state_dir: PathBuf,
}

impl Drop for PresignFallbackAuthSnapshot {
    fn drop(&mut self) {
        if fs::remove_dir_all(&self.state_dir).is_err() {
            log("first-push-cli", "failed to remove temporary auth snapshot");
        }
    }
}

fn snapshot_cli_auth_for_caller(
    tokens: &hq_desktop_core::cognito::CognitoTokens,
    expected_caller_subject: &str,
    token_subject: Option<&str>,
) -> Result<PresignFallbackAuthSnapshot, String> {
    if token_subject != Some(expected_caller_subject) {
        return Err("signed-in account changed during first push; retry first push".to_string());
    }

    let state_dir = std::env::temp_dir().join(format!("hq-first-push-auth-{}", ulid::Ulid::new()));
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder
        .create(&state_dir)
        .map_err(|_| "could not create temporary first-push auth state".to_string())?;

    let result = (|| {
        let token_path = state_dir.join("cognito-tokens.json");
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(token_path)
            .map_err(|_| "could not write temporary first-push auth state".to_string())?;
        let serialized = serde_json::to_vec(tokens)
            .map_err(|_| "could not serialize temporary first-push auth state".to_string())?;
        file.write_all(&serialized)
            .map_err(|_| "could not write temporary first-push auth state".to_string())?;
        file.flush()
            .map_err(|_| "could not write temporary first-push auth state".to_string())?;
        Ok(PresignFallbackAuthSnapshot {
            state_dir: state_dir.clone(),
        })
    })();

    if result.is_err() {
        let _ = fs::remove_dir_all(&state_dir);
    }
    result
}

async fn create_presigned_fallback_auth_snapshot(
    vault: &VaultClient,
) -> Result<PresignFallbackAuthSnapshot, String> {
    let expected_caller_subject = vault
        .caller_subject()
        .ok_or_else(|| "could not verify first-push account; retry first push".to_string())?;
    let tokens = hq_desktop_core::cognito::get_valid_tokens()
        .await
        .map_err(|_| "could not verify first-push account; retry first push".to_string())?;
    let token_subject = hq_desktop_core::cognito::decode_id_token_claims(&tokens.access_token)
        .ok()
        .and_then(|claims| claims.sub);
    snapshot_cli_auth_for_caller(&tokens, &expected_caller_subject, token_subject.as_deref())
}

fn configure_presigned_auth_state(cmd: &mut Command, state_dir: &Path) {
    // hq-cli uses this isolated person token cache for the presigned request.
    // Removing machine overrides keeps the presign caller aligned with the
    // account whose bearer token vended the child-policy response.
    cmd.env("HQ_STATE_DIR", state_dir)
        .env_remove("HQ_MACHINE_CREDS_FILE")
        .env_remove("HQ_MACHINE_TOKEN_STATE_DIR");
}

// ── Public entry point ────────────────────────────────────────────────────────

/// Run an initial push for `company`: vend STS creds → spawn `hq sync push` →
/// re-emit per-file progress + final-complete events through Tauri so the
/// menubar UI sees the same stream it did under the pre-C3 implementation.
///
/// On success, emits `EVENT_SYNC_COMPANY_FIRST_PUSH_COMPLETE` with final
/// upload/skip counts and returns `Ok(())`. On failure (subprocess crash,
/// non-zero exit, or `fatal` event), returns `Err(FirstPushFailure)` carrying the
/// typed status (vend-child seam only), the derived cause, and the exact prose
/// message; the caller (`sync.rs::start_sync`) records pre-runner attribution from
/// the typed fields and surfaces the message to the UI.
pub async fn first_push_company(
    app: &tauri::AppHandle,
    vault: &VaultClient,
    hq_root: &Path,
    company: &ProvisionedCompany,
) -> Result<(), FirstPushFailure> {
    // Step 1: Try the task-scoped STS path first. When the existing server-side
    // flag reports a policy overflow, discard any partial credential payload
    // and let hq-cloud select its normal company presign transport instead.
    let vend_result = vault
        .vend_child(&VendChildInput {
            company_uid: company.uid.clone(),
            task_id: ulid::Ulid::new().to_string(),
            task_description: "hq-sync first-push".to_string(),
            task_scope: TaskScope {
                allowed_prefixes: vec!["".to_string()],
                allowed_actions: Some(vec!["read".to_string(), "write".to_string()]),
            },
            duration_seconds: Some(900),
        })
        .await;
    let transport = match select_first_push_transport(vend_result) {
        Ok(transport) => transport,
        Err(e) => {
            // Derive the typed status + cause from the vault error BEFORE it is
            // collapsed to prose — this is the only seam that carries the status
            // as a typed `u16`. `message` keeps the exact pre-typed text.
            let (status, cause) = classify_vend_child_error(&e);
            return Err(FirstPushFailure {
                status,
                cause,
                message: format!("vend_child for {}: {e}", company.uid),
            });
        }
    };

    // Step 2: Build the optional pre-vended EntityContext. The presigned
    // transport runs the standard hq CLI auth path under an isolated snapshot
    // of the same person session that authenticated the vend-child request.
    let fallback_auth_snapshot = if matches!(&transport, FirstPushTransport::Presigned) {
        Some(
            create_presigned_fallback_auth_snapshot(vault)
                .await
                .map_err(FirstPushFailure::push_failed)?,
        )
    } else {
        None
    };
    let payload_json = match transport {
        FirstPushTransport::Sts(vend_result) => {
            let payload = EntityContextPayload {
                uid: company.uid.clone(),
                slug: company.slug.clone(),
                bucket_name: company.bucket_name.clone(),
                region: "us-east-1".to_string(),
                credentials: EntityCredentials {
                    access_key_id: vend_result.credentials.access_key_id,
                    secret_access_key: vend_result.credentials.secret_access_key,
                    session_token: vend_result.credentials.session_token,
                },
                expires_at: vend_result.expires_at,
            };
            Some(serde_json::to_string(&payload).map_err(|e| {
                FirstPushFailure::push_failed(format!("serialize EntityContext: {e}"))
            })?)
        }
        FirstPushTransport::Presigned => {
            log(
                "first-push-cli",
                "STS policy overflow; discarded STS credentials and selected company presigned I/O",
            );
            None
        }
    };
    let use_presigned_transport = payload_json.is_none();

    // Step 3: Spawn `hq sync push`; only the task-scoped STS path consumes a
    // pre-vended EntityContext. Without it, hq-cloud's company transport
    // selector installs the existing presigned ObjectIO implementation.
    //
    // `hq_resolver::resolve_hq()` decides whether to invoke a local `hq`
    // binary or fall back to `npx -y --package=@indigoai-us/hq-cli@<range>
    // hq` (range pinned by `HQ_CLI_NPM_RANGE`) based on a one-time
    // capability probe (looks for the --creds-from-stdin flag in
    // `hq sync push --help`). This makes the subprocess self-healing when
    // the user's local `hq` is missing or older than the floor — the
    // contract still works, just with a one-time npx cold-start cost.
    let invocation: HqInvocation = hq_resolver::resolve_hq();
    let path_env = paths::child_path();
    let company_dir = hq_root.join("companies").join(&company.slug);

    log(
        "first-push-cli",
        &format!(
            "spawn ({}): hq sync push{} --json --company {} --hq-root {} {}",
            invocation.label(),
            if use_presigned_transport {
                ""
            } else {
                " --creds-from-stdin"
            },
            company.slug,
            hq_root.display(),
            company_dir.display(),
        ),
    );

    // Serialize concurrent npx self-heal installs so they can't race the shared
    // ~/.npm/_npx cache (HQ-SYNC-6). No-op on the resolved-local fast path; held
    // until this push's subprocess completes.
    let _npx_guard = invocation.npx_serial_guard().await;

    let mut cmd = invocation.command();
    configure_sync_push_command(
        &mut cmd,
        &company.slug,
        hq_root,
        &company_dir,
        use_presigned_transport,
    );
    if let Some(snapshot) = &fallback_auth_snapshot {
        configure_presigned_auth_state(&mut cmd, &snapshot.state_dir);
    }
    cmd.env("PATH", &path_env)
        .stdin(if use_presigned_transport {
            Stdio::null()
        } else {
            Stdio::piped()
        })
        // share()'s default human output goes to stdout — in --json mode all
        // events go to stderr, and stdout carries nothing useful. Discarding
        // it avoids burning a kernel buffer on output we'd ignore anyway.
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        // Without kill_on_drop a panic / cancellation in the caller would
        // leak an orphan `hq` subprocess — the user has no UI to see or
        // kill it. Same posture as run_cli_provision.
        .kill_on_drop(true);

    // Own process group so the machine-wide CPU governor can duty-cycle this
    // child (and anything it spawns) without ever signalling the app's own
    // group — same posture as run_process_impl_inner.
    #[cfg(unix)]
    cmd.process_group(0);

    let mut child = cmd.spawn().map_err(|e| {
        FirstPushFailure::push_failed(format!(
            "spawn `hq sync push` ({}): {e}",
            invocation.label()
        ))
    })?;

    // Holds the first-push subprocess under the same machine-wide CPU ceiling
    // as the steady-state sync runner. Dropping the guard always resumes the
    // group, so no exit path can strand a stopped child.
    let _cpu_throttle = child
        .id()
        .map(|pid| hq_desktop_core::cpu_throttle::CpuThrottle::attach(pid as i32));

    // Step 4: Pipe the pre-vended context only for the task-scoped STS path.
    if let Some(payload_json) = payload_json {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| FirstPushFailure::push_failed("child stdin pipe missing".to_string()))?;
        stdin
            .write_all(payload_json.as_bytes())
            .await
            .map_err(|e| FirstPushFailure::push_failed(format!("write child stdin: {e}")))?;
        stdin.flush().await.ok();
    }

    // Step 5: Stream stderr line-by-line. Each line is either:
    //   * a JSON event (parse + dispatch to Tauri events)
    //   * free-form text (log to diagnostic file, ignore for UI)
    //
    // We read sequentially before calling wait() because there's only one
    // pipe to drain (stdout is /dev/null). Once stderr closes (child exits)
    // next_line() returns None and we fall through to wait().
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| FirstPushFailure::push_failed("child stderr pipe missing".to_string()))?;
    let mut reader = BufReader::new(stderr).lines();

    let mut total_files: usize = 0;
    let mut files_done: usize = 0;
    let mut files_uploaded: usize = 0;
    let mut files_skipped: usize = 0;
    let mut last_fatal: Option<String> = None;
    let mut saw_complete = false;
    let mut aborted = false;
    let mut presigned_fallback_incomplete = false;

    while let Ok(Some(line)) = reader.next_line().await {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        // Tolerate non-JSON lines (e.g. shell warnings, accidental println
        // from a future CLI version) — log and continue rather than killing
        // the stream.
        let event: CliEvent = match serde_json::from_str(trimmed) {
            Ok(e) => e,
            Err(_) => {
                log("first-push-cli", &format!("(non-json) {trimmed}"));
                continue;
            }
        };

        match event.event_type.as_str() {
            "plan" => {
                total_files = event
                    .rest
                    .get("filesToUpload")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0) as usize;
                log(
                    "first-push-cli",
                    &format!("plan: filesToUpload={total_files}"),
                );
            }
            "progress" => {
                files_done += 1;
                let path = event
                    .rest
                    .get("path")
                    .and_then(|v| v.as_str())
                    .map(String::from);
                let _ = app.emit(
                    EVENT_SYNC_COMPANY_FIRST_PUSH_PROGRESS,
                    SyncCompanyFirstPushProgressEvent {
                        company_uid: company.uid.clone(),
                        company_slug: company.slug.clone(),
                        files_done,
                        files_total: total_files,
                        current_file: path,
                    },
                );
            }
            "complete" => {
                files_uploaded = event
                    .rest
                    .get("filesUploaded")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0) as usize;
                files_skipped = event
                    .rest
                    .get("filesSkipped")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0) as usize;
                aborted = event
                    .rest
                    .get("aborted")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                saw_complete = true;
                log(
                    "first-push-cli",
                    &format!(
                        "complete: uploaded={files_uploaded} skipped={files_skipped} aborted={aborted}"
                    ),
                );
            }
            "fatal" => {
                let msg = event
                    .rest
                    .get("message")
                    .and_then(|v| v.as_str())
                    .unwrap_or("(no message)")
                    .to_string();
                log("first-push-cli", &format!("fatal: {msg}"));
                last_fatal = Some(msg);
            }
            other if use_presigned_transport && presigned_fallback_event_is_incomplete(other) => {
                presigned_fallback_incomplete = true;
                log(
                    "first-push-cli",
                    "presigned first push reported a path refusal; final success will be withheld",
                );
            }
            // `error` is per-file (already-retried, then skipped); `conflict`
            // is per-file (already resolved). Neither kills the run — log
            // for forensics and let the loop continue.
            other => {
                log("first-push-cli", &format!("event type={other}: {trimmed}"));
            }
        }
    }

    // Step 6: Wait for exit and reconcile.
    let status = child
        .wait()
        .await
        .map_err(|e| FirstPushFailure::push_failed(format!("wait child: {e}")))?;

    log(
        "first-push-cli",
        &format!(
            "exit code={:?}, saw_complete={saw_complete}, aborted={aborted}, slug={}",
            status.code(),
            company.slug,
        ),
    );

    if !status.success() {
        let msg = last_fatal.unwrap_or_else(|| {
            format!(
                "hq sync push exited with status {} for slug={}",
                status.code().unwrap_or(-1),
                company.slug,
            )
        });
        return Err(FirstPushFailure::push_failed(msg));
    }

    if aborted {
        return Err(FirstPushFailure::push_failed(format!(
            "hq sync push aborted for slug={} (uploaded={files_uploaded}, skipped={files_skipped})",
            company.slug,
        )));
    }

    if !saw_complete {
        // Process exited 0 without emitting a `complete` event. That
        // shouldn't happen with the current CLI but is plausible if a
        // future CLI version crashes after share() returns. Surface as
        // an error rather than silently emitting a complete event with
        // (0, 0) counts that would mislead the UI.
        return Err(FirstPushFailure::push_failed(format!(
            "hq sync push exited 0 without `complete` event for slug={}",
            company.slug,
        )));
    }

    if presigned_fallback_incomplete {
        return Err(FirstPushFailure::push_failed(
            "presigned company first push was incomplete: one or more paths were refused"
                .to_string(),
        ));
    }

    // Emit the terminal Tauri event the menubar listens for.
    let _ = app.emit(
        EVENT_SYNC_COMPANY_FIRST_PUSH_COMPLETE,
        SyncCompanyFirstPushCompleteEvent {
            company_uid: company.uid.clone(),
            company_slug: company.slug.clone(),
            files_uploaded,
            files_skipped,
        },
    );
    crate::commands::cdp_mirror::note_first_sync_completed(&company.uid);

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use hq_desktop_core::sync_outcome::is_expected_acl_scope_skip;

    fn complete_child_vend() -> VendChildResult {
        VendChildResult {
            credentials: crate::commands::vault_client::VendChildCredentials {
                access_key_id: "ASIAFAKE".into(),
                secret_access_key: "fake-secret".into(),
                session_token: "fake-session".into(),
            },
            session_name: "prs_fake--task--fake".into(),
            expires_at: "2026-10-06T02:00:00Z".into(),
            policy_truncated: false,
            dropped_write_grant_prefixes: Vec::new(),
        }
    }

    fn auth_tokens() -> hq_desktop_core::cognito::CognitoTokens {
        hq_desktop_core::cognito::CognitoTokens {
            access_token: "synthetic-access-A".into(),
            id_token: Some("synthetic-id-A".into()),
            refresh_token: "synthetic-refresh-A".into(),
            expires_at: 1_800_000_000_000,
        }
    }

    #[test]
    fn explicit_overflow_fallback_signal_selects_presigned_transport() {
        let err = VaultClientError::Http {
            status: 409,
            body: "{\"code\":\"POLICY_PRESIGN_FALLBACK_REQUIRED\"}".into(),
        };

        assert!(matches!(
            select_first_push_transport(Err(err)),
            Ok(FirstPushTransport::Presigned)
        ));
    }

    #[test]
    fn dropped_prefix_response_discards_child_credentials_and_refuses_first_push() {
        let mut vend = complete_child_vend();
        vend.policy_truncated = true;
        vend.dropped_write_grant_prefixes = vec!["private/overflow/".into()];

        assert!(matches!(
            select_first_push_transport(Ok(vend)),
            Err(VaultClientError::Json(message))
                if message == "vend-child returned partial credentials; refusing first push"
        ));
    }

    #[test]
    fn ordinary_child_vend_keeps_the_existing_sts_transport() {
        assert!(matches!(
            select_first_push_transport(Ok(complete_child_vend())),
            Ok(FirstPushTransport::Sts(_))
        ));
    }

    #[test]
    fn flag_off_overflow_refusal_does_not_select_presigned_transport() {
        let err = VaultClientError::Http {
            status: 422,
            body: "{\"code\":\"POLICY_WRITE_SCOPE_TRUNCATED\"}".into(),
        };

        assert!(matches!(
            select_first_push_transport(Err(err)),
            Err(VaultClientError::Http { status: 422, .. })
        ));
    }

    #[test]
    fn presigned_fallback_never_reports_success_after_a_path_refusal() {
        for event_type in ["error", "scope-excluded", "not-shipped"] {
            assert!(
                presigned_fallback_event_is_incomplete(event_type),
                "{event_type}"
            );
        }
        assert!(!presigned_fallback_event_is_incomplete("progress"));
        assert!(!presigned_fallback_event_is_incomplete("complete"));
    }

    #[test]
    fn presigned_fallback_runs_standard_company_sync_without_sts_stdin() {
        let mut command = Command::new("hq");
        configure_sync_push_command(
            &mut command,
            "acme",
            Path::new("/tmp/hq"),
            Path::new("/tmp/hq/companies/acme"),
            true,
        );

        let args: Vec<String> = command
            .as_std()
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            args,
            [
                "sync",
                "push",
                "--json",
                "--company",
                "acme",
                "--hq-root",
                "/tmp/hq",
                "/tmp/hq/companies/acme",
            ]
        );
        assert!(!args.iter().any(|arg| arg == "--creds-from-stdin"));
    }

    #[test]
    fn fallback_token_snapshot_is_isolated_and_preserves_the_vended_account() {
        let tokens = auth_tokens();
        let snapshot = snapshot_cli_auth_for_caller(&tokens, "account-A", Some("account-A"))
            .expect("matching caller can use isolated auth state");
        let token_path = snapshot.state_dir.join("cognito-tokens.json");
        let written: hq_desktop_core::cognito::CognitoTokens =
            serde_json::from_slice(&fs::read(&token_path).expect("snapshot token file"))
                .expect("valid serialized Cognito tokens");
        assert_eq!(written, tokens);

        let state_dir = snapshot.state_dir.clone();
        drop(snapshot);
        assert!(
            !state_dir.exists(),
            "snapshot is cleaned up after first push"
        );
    }

    #[test]
    fn fallback_token_snapshot_refuses_a_different_signed_in_account() {
        let result = snapshot_cli_auth_for_caller(&auth_tokens(), "account-A", Some("account-B"));
        assert!(
            matches!(result, Err(message) if message == "signed-in account changed during first push; retry first push")
        );
    }

    #[test]
    fn fallback_command_uses_snapshot_person_tokens_and_ignores_machine_overrides() {
        let mut command = Command::new("hq");
        configure_presigned_auth_state(&mut command, Path::new("/tmp/hq-auth-snapshot"));

        let envs: Vec<_> = command.as_std().get_envs().collect();
        assert!(envs.iter().any(|(key, value)| {
            *key == "HQ_STATE_DIR"
                && value.map(|path| path == "/tmp/hq-auth-snapshot") == Some(true)
        }));
        assert!(envs
            .iter()
            .any(|(key, value)| *key == "HQ_MACHINE_CREDS_FILE" && value.is_none()));
        assert!(envs
            .iter()
            .any(|(key, value)| *key == "HQ_MACHINE_TOKEN_STATE_DIR" && value.is_none()));
    }

    // The verbatim shape of the observed HQ-DESKTOP-63 vend-child 403 body: prose plus
    // the machine-readable code the server returns. Only its scope-marker substring is
    // load-bearing for classification.
    const OBSERVED_SCOPE_BODY: &str = "{\"error\":\"Child scope exceeds parent permissions: Requested prefixes not covered by parent grant\",\"code\":\"SCOPE_EXCEEDS_PARENT\"}";

    #[test]
    fn vend_child_scope_403_maps_to_scope_exceeds_parent_and_is_expected() {
        let err = VaultClientError::Http {
            status: 403,
            body: OBSERVED_SCOPE_BODY.to_string(),
        };
        assert_eq!(
            classify_vend_child_error(&err),
            (Some(403), PreRunnerCause::ScopeExceedsParent)
        );
        // The caller routes the rendered message through this predicate to suppress the
        // per-body capture; the classification and the suppression must agree.
        let message = format!("vend_child for cmp_01ABC: {err}");
        assert!(is_expected_acl_scope_skip(&message));
    }

    #[test]
    fn vend_child_plain_403_maps_to_vend_http_and_is_not_expected() {
        let err = VaultClientError::Http {
            status: 403,
            body: "{\"error\":\"Forbidden\"}".to_string(),
        };
        assert_eq!(
            classify_vend_child_error(&err),
            (Some(403), PreRunnerCause::VendHttp)
        );
        let message = format!("vend_child for cmp_01ABC: {err}");
        assert!(!is_expected_acl_scope_skip(&message));
        // A plain-403 capture carries none of the observed scope body's substrings.
        assert!(!message.contains("Child scope exceeds parent permissions"));
        assert!(!message.contains("SCOPE_EXCEEDS_PARENT"));
    }

    #[test]
    fn vend_child_5xx_maps_to_vend_http_with_its_status() {
        let err = VaultClientError::Http {
            status: 500,
            body: "internal".to_string(),
        };
        assert_eq!(
            classify_vend_child_error(&err),
            (Some(500), PreRunnerCause::VendHttp)
        );
    }

    #[test]
    fn vend_child_json_and_ownership_map_to_fixed_status_less_causes() {
        assert_eq!(
            classify_vend_child_error(&VaultClientError::Json("bad".to_string())),
            (None, PreRunnerCause::VendProtocol)
        );
        assert_eq!(
            classify_vend_child_error(&VaultClientError::SelfOwnershipMismatch),
            (None, PreRunnerCause::OwnershipMismatch)
        );
    }

    #[test]
    fn push_failed_is_status_less_and_display_is_the_message() {
        let failure = FirstPushFailure::push_failed("spawn `hq sync push`: boom".to_string());
        assert_eq!(failure.status, None);
        assert_eq!(failure.cause, PreRunnerCause::PushFailed);
        // Display renders exactly the message so the caller's log line stays identical.
        assert_eq!(format!("{failure}"), "spawn `hq sync push`: boom");
    }
}
