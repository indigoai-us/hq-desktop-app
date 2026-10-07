//! Personal first-push: provision the caller's person entity bucket (once) and
//! upload personal HQ files (excluding the `companies/` tree) via /sts/vend-self.

use std::future::Future;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;

use base64::Engine as _;
use bytes::Bytes;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::Emitter;
use walkdir::WalkDir;

use aws_credential_types::Credentials;
use aws_sdk_s3::config::{Builder as S3ConfigBuilder, Region};
use aws_sdk_s3::primitives::ByteStream;

use crate::commands::vault_client::{EntityInfo, VaultClient, VaultClientError, VendSelfInput};
use crate::events::{
    SyncPersonalFirstPushCompleteEvent, SyncPersonalFirstPushProgressEvent,
    SyncPersonalFirstPushScanEvent, SyncPersonalFirstPushSkippedEvent,
    SyncPersonalProvisionedEvent, SyncPersonalSkippedOwnershipMismatchEvent,
    EVENT_SYNC_PERSONAL_FIRST_PUSH_COMPLETE, EVENT_SYNC_PERSONAL_FIRST_PUSH_PROGRESS,
    EVENT_SYNC_PERSONAL_FIRST_PUSH_SCAN, EVENT_SYNC_PERSONAL_FIRST_PUSH_SKIPPED,
    EVENT_SYNC_PERSONAL_PROVISIONED, EVENT_SYNC_PERSONAL_SKIPPED_OWNERSHIP_MISMATCH,
};
use crate::util::ignore::IgnoreFilter;
use crate::util::journal::{read_journal, write_journal, Direction, JournalEntry};
use crate::util::logfile::log;

// ── Types ─────────────────────────────────────────────────────────────────────

pub(crate) type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;

/// Dynamic-dispatch uploader used by both production (real S3) and tests (fake counter).
pub(crate) type UploaderFn =
    Arc<dyn Fn(String, Bytes, String) -> BoxFuture<UploadOutcome> + Send + Sync>;

#[derive(Debug)]
pub(crate) enum UploadOutcome {
    Ok,
    Transient(String),
    Permanent(String),
}

// ── Personal-vault path exclusion list ────────────────────────────────────────

/// Top-level directories under `hq_root/` that the personal vault MUST NOT
/// sync. Everything else (root files, `.claude/`, `knowledge/`, `modules/`,
/// `core/`, hidden dotfile dirs like `.codex/`, etc.) is included subject
/// to the IgnoreFilter (`.gitignore` + `.hqignore`).
///
/// Rationale per exclusion:
///   - `companies/`: synced separately by the runner's per-membership fanout;
///     do not double-write into the personal vault.
///   - `person-settings/`: cloud-authoritative preferences are written through
///     hq-pro; a local projection must not bypass its validation on first push.
///   - `workspace/`, `repos/`: per user directive — heavy local-only content
///     (cloned remotes, session threads) that should not live in the personal
///     vault.
///   - `.git/`: a git repo's internal state is large, opaque, and useless
///     after sync — gitignore alone doesn't cover `.git/` because it's the
///     repo itself, not a tracked path.
///
/// Note: `core/`, `data/`, and `personal/` were previously excluded but are
/// now INCLUDED (user directive 2026-05-13). `core/` ships the hq-core
/// scaffold (policies/, settings/, skills/, workers/, the rules manifest at
/// core/core.yaml) — real project content the box needs. `data/` and
/// `personal/` carry per-user data and policies/hooks/skills that the user
/// expects to follow them across machines. The hq-root identity marker
/// `core.yaml` (distinct from `core/core.yaml`) is filtered separately
/// downstream by the anchored `/core.yaml` DEFAULT_IGNORES rule in
/// `@indigoai-us/hq-cloud`.
///
/// Mirror this constant in `@indigoai-us/hq-cloud`'s sync-runner so push
/// behaviour from the Node runner matches the Rust first-push.
pub(crate) const PERSONAL_VAULT_EXCLUDED_TOP_LEVEL: &[&str] =
    &[".git", "companies", "person-settings", "repos", "workspace"];

/// Journal slug for the personal vault. MUST match `PERSONAL_VAULT_JOURNAL_SLUG`
/// in `@indigoai-us/hq-cloud` (`src/journal.ts` = `"__hq_personal_vault__"`).
///
/// The steady-state runner journals the personal vault under this slug. An
/// older layout used the bare `"personal"` slug (the `companies/personal`
/// company journal); hq-cloud's `migratePersonalVaultJournal()` renames that
/// file to this slug on the first runner sync, and the JS CLI was updated to
/// read/write it (see `hq-cli` cloud.ts `PERSONAL_VAULT_JOURNAL_SLUG`).
///
/// This Rust personal-push planner + uploader were left reading the legacy
/// `"personal"` journal, so they judged file currency against a STALE,
/// runner-abandoned baseline — flagging already-synced files as "changed" and
/// re-uploading the local (often older) copy over a newer cloud object with no
/// remote-currency check. That regressed the personal vault on idle devices
/// (CloudTrail-confirmed, 2026-06-10). Reading the same slug the runner writes
/// makes the skip-unchanged decision correct again.
pub(crate) const PERSONAL_VAULT_JOURNAL_SLUG: &str = "__hq_personal_vault__";

/// COMPLETE with zero uploads, for the two paths where this call walks
/// nothing: the runner already owns steady-state personal sync, or the install
/// stage handed the upload to the running sync daemon. One emit site for both.
fn emit_first_push_complete_without_uploading<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    person_uid: &str,
) {
    let _ = app.emit(
        EVENT_SYNC_PERSONAL_FIRST_PUSH_COMPLETE,
        SyncPersonalFirstPushCompleteEvent {
            person_uid: person_uid.to_string(),
            files_uploaded: 0,
            files_skipped: 0,
        },
    );
}

/// Steady-state gate predicate: true once the hq-cloud runner's personal
/// journal (`sync-journal.__hq_personal_vault__.json`) exists, meaning the
/// runner owns bidirectional personal sync. The warm-up first-push only seeds
/// a brand-new vault; after that it must NOT re-walk/upload (it compares
/// against a baseline the runner's pulls never update, causing split-brain
/// re-uploads, repeated upload failures, and an inflated "Syncing Personal …
/// of N" count). Used by `ensure_personal_bucket_and_first_push`.
pub(crate) fn engine_owns_personal_steady_state() -> bool {
    matches!(
        crate::util::journal::journal_path(PERSONAL_VAULT_JOURNAL_SLUG),
        Ok(p) if p.exists()
    )
}

/// True when a relative path (relative to hq_root, forward-slash separators)
/// is part of the personal vault — i.e. its top-level segment is NOT in
/// `PERSONAL_VAULT_EXCLUDED_TOP_LEVEL`. Empty paths return false (no top
/// segment to check).
/// "Preparing sync…" pre-pass: walk every push-side target, hash each file,
/// and compare against the journal to count exactly how many UPLOADS the
/// runner will emit. The runner only fires `progress` events for actual
/// transfers (skipped files are silent), so this count IS the bar's
/// denominator for the upload phase.
///
/// Pull-side downloads aren't counted here yet — that requires an S3 LIST
/// per bucket (vend STS + paginated list). For the common steady-state
/// case (everything matches the journal), pull-side downloads = 0, so this
/// count is exact. For first-time syncs (empty journal, empty bucket),
/// downloads also = 0 (nothing remote to pull). Mid-life syncs with
/// out-of-band changes may have a small under-count; the UI's honest-
/// fallback caption switches from "X of Y" to bare "X transferred" once
/// cumulative exceeds the estimate.
///
/// Cost: one full local walk + sha256 per file (matches what the runner
/// will do anyway). For 13K files that's ~1-3s of disk I/O. Steady-state
/// folder = mostly cached pages, much faster.
pub(crate) fn count_files_to_transfer(hq_root: &Path, company_slugs: &[String]) -> u64 {
    let filter = match crate::util::ignore::IgnoreFilter::for_hq_root(hq_root) {
        Ok(f) => f,
        Err(_) => return 0,
    };

    let mut to_upload: u64 = 0;
    // Holds the hashing below inside the same machine-wide CPU ceiling the
    // governor enforces on child processes. This walk runs in the app's own
    // process, which the governor will not signal, so it has to pace itself.
    let mut pacer = hq_desktop_core::cpu_throttle::InProcessPacer::new();

    // ── Personal allowlist (.claude, knowledge, policies, projects) ───────
    // Read the SAME journal slug the steady-state runner writes
    // (`__hq_personal_vault__`), not the legacy `"personal"` slug — otherwise
    // the count reflects a stale baseline. See PERSONAL_VAULT_JOURNAL_SLUG.
    let personal_journal =
        crate::util::journal::read_journal(PERSONAL_VAULT_JOURNAL_SLUG).unwrap_or_default();
    // Session-continuity carve-out: the active thread file the pointer
    // references is a dynamic name, so it can't be a pure-predicate match —
    // resolve it once (reads handoff.json) and OR it into the per-file gate.
    let continuity: std::collections::HashSet<String> =
        continuity_pointer_rel_paths(hq_root).into_iter().collect();
    for entry in WalkDir::new(hq_root).into_iter().filter_map(|e| e.ok()) {
        if !entry.file_type().is_file() {
            continue;
        }
        if !filter.should_sync(entry.path()) {
            continue;
        }
        let rel = match entry.path().strip_prefix(hq_root) {
            Ok(r) => r.to_string_lossy().replace('\\', "/"),
            Err(_) => continue,
        };
        if !is_personal_vault_path(&rel) && !continuity.contains(rel.as_str()) {
            continue;
        }
        if file_needs_upload(entry.path(), &rel, &personal_journal, &mut pacer) {
            to_upload += 1;
        }
    }

    // ── Each company folder ───────────────────────────────────────────────
    for slug in company_slugs {
        let dir = hq_root.join("companies").join(slug);
        if !dir.is_dir() {
            continue;
        }
        let company_journal = crate::util::journal::read_journal(slug).unwrap_or_default();
        // Remote keys are company-relative (e.g. "knowledge/foo.md"), not
        // hq-root-relative. The runner's share() strips companies/{slug}/
        // from the absolute path before journaling.
        for entry in WalkDir::new(&dir).into_iter().filter_map(|e| e.ok()) {
            if !entry.file_type().is_file() {
                continue;
            }
            if !filter.should_sync(entry.path()) {
                continue;
            }
            let rel_to_company = match entry.path().strip_prefix(&dir) {
                Ok(r) => r.to_string_lossy().replace('\\', "/"),
                Err(_) => continue,
            };
            if file_needs_upload(entry.path(), &rel_to_company, &company_journal, &mut pacer) {
                to_upload += 1;
            }
        }
    }

    to_upload
}

/// Tolerance when comparing a local mtime against the journal's `mtimeMs`.
///
/// The journal is authored by the Node engine, whose `stat().mtimeMs` carries
/// a fractional millisecond; Rust's `Duration::as_millis` truncates to a whole
/// one. Comparing them exactly would fail on nearly every file and silently
/// disable the fast path. A couple of milliseconds is far below any real edit
/// interval, and this comparison only feeds a progress estimate.
const MTIME_EPSILON_MS: f64 = 2.0;

/// How many uploaded files may accumulate in the first-push journal before it
/// is flushed to disk mid-run. See the batching comment at the write site.
const JOURNAL_WRITE_BATCH: usize = 25;

/// Local mtime in milliseconds since the epoch, in the same units the engine
/// records. `None` when the platform or filesystem will not report one.
fn mtime_ms(meta: &std::fs::Metadata) -> Option<f64> {
    let modified = meta.modified().ok()?;
    let since = modified.duration_since(std::time::UNIX_EPOCH).ok()?;
    Some(since.as_millis() as f64)
}

/// True iff the file's current sha256 differs from its journal entry (or has
/// no journal entry). Mirrors `share.ts` skipUnchanged logic. Hashing errors
/// (missing file, permission denied) are treated as "needs upload" to err on
/// the side of including it — the runner will hit the same error and surface
/// it cleanly.
///
/// `pacer` is charged for the hashing only — see the metadata fast path below
/// for why the surrounding walk is deliberately left unpaced.
fn file_needs_upload(
    abs_path: &Path,
    journal_key: &str,
    journal: &crate::util::journal::SyncJournal,
    pacer: &mut hq_desktop_core::cpu_throttle::InProcessPacer,
) -> bool {
    let Some(entry) = journal.files.get(journal_key) else {
        // Never synced: it uploads, and there is nothing to compare against.
        return true;
    };

    // Metadata fast path — the same rule the hq-cloud runner applies on its own
    // push side (see `JournalEntry::mtime_ms`: "the push side skips re-hashing
    // when size + mtimeMs match"). This pre-pass exists to PREDICT the runner's
    // upload count, so mirroring the runner's skip rule makes the estimate more
    // faithful, not less.
    //
    // It is also the difference between a `stat` per file and a full read plus
    // SHA-256 of every syncable byte. On a large HQ root the unconditional
    // version was a multi-minute, single-core burn on every sync — and because
    // it runs inside the app's own process, the CPU governor cannot touch it
    // (it refuses to signal its own process group). Not doing the work beats
    // throttling it.
    if let Ok(meta) = std::fs::metadata(abs_path) {
        if meta.len() == entry.size {
            if let (Some(journalled), Some(local)) = (entry.mtime_ms, mtime_ms(&meta)) {
                if (journalled - local).abs() < MTIME_EPSILON_MS {
                    return false;
                }
            }
        }
    }

    // Slow path: the file looks changed (or the journal predates `mtimeMs`).
    // Reading and hashing it is the expensive part, so it is what gets paced.
    let started = std::time::Instant::now();
    let contents = match std::fs::read(abs_path) {
        Ok(c) => c,
        Err(_) => return true,
    };
    let hash = format!("{:x}", Sha256::digest(&contents));
    pacer.charge(started.elapsed());
    entry.hash != hash
}

pub(crate) fn is_personal_vault_path(rel: &str) -> bool {
    // companies/manifest.yaml is the routing source-of-truth (which slugs
    // exist, which are cloud-backed) — included in the personal-vault
    // scope despite the parent `companies/` top-level exclusion. Mirrors
    // the TS `computePersonalVaultPaths` special-case shipped in
    // @indigoai-us/hq-cloud@5.39.0 so the Rust first-push and Node
    // steady-state push agree on whether manifest.yaml belongs in the
    // personal vault.
    if rel == "companies/manifest.yaml" {
        return true;
    }
    // workspace/threads/handoff.json is the session-continuity pointer — the
    // ONE file under the otherwise machine-local `workspace/` that must travel
    // across machines so a `/handoff` on one box reaches a second box. Same
    // shape as the manifest special-case. The ACTIVE THREAD FILE the pointer
    // references is NOT a fixed name, so it cannot be a pure-predicate match —
    // it is resolved from `handoff.json` by `continuity_pointer_rel_paths`
    // and OR-ed into the walk filter at the two call sites. Mirrors the TS
    // `computeContinuityPointerPaths` carve-out in @indigoai-us/hq-cloud.
    if rel == CONTINUITY_POINTER_REL {
        return true;
    }
    let top = rel.split('/').next().unwrap_or("");
    if top.is_empty() {
        return false;
    }
    !PERSONAL_VAULT_EXCLUDED_TOP_LEVEL.contains(&top)
}

/// Fixed hq-root-relative path (forward-slash separators) of the session
/// continuity pointer. Mirrors `CONTINUITY_POINTER_REL` in
/// `@indigoai-us/hq-cloud` (`src/personal-vault.ts`).
pub(crate) const CONTINUITY_POINTER_REL: &str = "workspace/threads/handoff.json";

/// Compute the hq-root-relative paths of the session-continuity carve-out:
/// `workspace/threads/handoff.json` plus the single thread file it references
/// via `thread_path`. `workspace/` is otherwise machine-local (it is in
/// `PERSONAL_VAULT_EXCLUDED_TOP_LEVEL`); this is the ONE exception, so a
/// `/handoff` on one machine reaches a second machine — the durable output
/// already syncs, only the session pointer didn't travel.
///
/// Mirrors `computeContinuityPointerPaths` in `@indigoai-us/hq-cloud`
/// (`src/personal-vault.ts`). Returns forward-slash, hq-root-relative strings
/// that match exactly what the personal-vault walk computes via
/// `entry.path().strip_prefix(hq_root)`, so they can be OR-ed straight into
/// the walk filter.
///
/// The thread file is included ONLY when `thread_path` is a relative path that
/// resolves (canonicalize) to an existing regular file STRICTLY inside
/// `workspace/threads/`. Absolute paths, traversal (`../../.env`), paths under
/// `workspace/` but outside `threads/`, and symlink escapes are all rejected —
/// a malformed or tampered `handoff.json` must never smuggle an arbitrary file
/// into the personal vault. Fail-soft throughout: a missing / unreadable /
/// malformed pointer, or an out-of-bounds / missing `thread_path`, degrades to
/// "the pointer alone" or `[]`.
pub(crate) fn continuity_pointer_rel_paths(hq_root: &Path) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let threads_dir = hq_root.join("workspace").join("threads");
    let handoff = threads_dir.join("handoff.json");

    // No pointer on this machine yet (or unreadable) — nothing to carry.
    let raw = match std::fs::read_to_string(&handoff) {
        Ok(s) => s,
        Err(_) => return out,
    };
    out.push(CONTINUITY_POINTER_REL.to_string());

    // Resolve the active thread file from the pointer's `thread_path`. Any
    // failure leaves the pointer itself in `out` and skips the thread body —
    // the next handoff (or a peer's push) re-converges it.
    let thread_path = match serde_json::from_str::<serde_json::Value>(&raw) {
        Ok(v) => v
            .get("thread_path")
            .and_then(|t| t.as_str())
            .map(|s| s.to_string()),
        Err(_) => return out,
    };
    let thread_path = match thread_path {
        Some(p) if !p.is_empty() => p,
        _ => return out,
    };

    // Reject absolute paths up front.
    if Path::new(&thread_path).is_absolute() {
        return out;
    }
    // Normalize to clean forward-slash segments; reject traversal outright so
    // `..` can never climb out of the threads dir, and drop `.`/empty segments
    // so the emitted rel matches the walk's `strip_prefix` form exactly.
    let mut segments: Vec<&str> = Vec::new();
    for seg in thread_path.split('/') {
        match seg {
            "" | "." => continue,
            ".." => return out,
            s => segments.push(s),
        }
    }
    let rel = segments.join("/");
    // String-level containment: must live under workspace/threads/.
    if !rel.starts_with("workspace/threads/") {
        return out;
    }
    // realpath-level containment: canonicalize and re-check, which catches a
    // symlink inside threads/ whose target escapes (the string check alone
    // cannot). Then require a regular file.
    let candidate = hq_root.join(&rel);
    let threads_canon = match std::fs::canonicalize(&threads_dir) {
        Ok(p) => p,
        Err(_) => return out,
    };
    let real = match std::fs::canonicalize(&candidate) {
        Ok(p) => p,
        Err(_) => return out, // pointer references a thread file absent here
    };
    if !real.starts_with(&threads_canon) {
        return out;
    }
    if !real.is_file() {
        return out;
    }
    out.push(rel);
    out
}

// ── Cache ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonEntityCache {
    pub person_uid: String,
    pub bucket_name: String,
    pub created_at: String,
}

fn cache_path() -> Result<PathBuf, String> {
    #[cfg(test)]
    if let Some(home) = std::env::var_os("HQ_TEST_HOME") {
        return Ok(PathBuf::from(home).join(".hq").join("person-entity.json"));
    }
    let home = dirs::home_dir().ok_or("cannot resolve home directory")?;
    Ok(home.join(".hq").join("person-entity.json"))
}

fn read_cache() -> Option<PersonEntityCache> {
    let p = cache_path().ok()?;
    let s = std::fs::read_to_string(&p).ok()?;
    serde_json::from_str(&s).ok()
}

fn write_cache(cache: &PersonEntityCache) -> Result<(), String> {
    let p = cache_path()?;
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = p.with_extension("json.tmp");
    let body = serde_json::to_string_pretty(cache).map_err(|e| e.to_string())?;
    let mut f = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
    f.write_all(body.as_bytes()).map_err(|e| e.to_string())?;
    f.sync_all().ok();
    std::fs::rename(&tmp, &p).map_err(|e| e.to_string())
}

pub(crate) fn delete_cache() {
    if let Ok(p) = cache_path() {
        let _ = std::fs::remove_file(p);
    }
}

// ── S3 helpers ────────────────────────────────────────────────────────────────

fn hex_to_bytes(hex: &str) -> Vec<u8> {
    (0..hex.len())
        .step_by(2)
        .filter(|&i| i + 2 <= hex.len())
        .map(|i| {
            u8::from_str_radix(&hex[i..i + 2], 16).expect("Sha256::digest() always emits valid hex")
        })
        .collect()
}

/// Returns ASCII-only `(metadata key, value)` pairs to stamp on every
/// PutObject during personal first-push. Mirrors `buildAuthorMetadata` in
/// packages/hq-cloud/src/s3.ts and hq-console/src/lib/s3-vault.ts so the
/// Vault tab's CREATED BY column resolves uniformly across upload paths.
/// Returns an empty Vec when no Cognito tokens are cached or claims are
/// unparseable — uploads still succeed, the column just stays "—".
fn build_personal_author_metadata() -> Vec<(String, String)> {
    let mut meta = Vec::with_capacity(3);
    let claims = match crate::commands::cognito::read_tokens_from_file() {
        Ok(Some(tokens)) => tokens
            .id_token
            .as_deref()
            .and_then(|t| crate::commands::cognito::decode_id_token_claims(t).ok()),
        _ => None,
    };
    if let Some(c) = claims {
        if let Some(sub) = c.sub.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            if sub.bytes().all(|b| (0x20..=0x7E).contains(&b)) {
                meta.push(("created-by-sub".to_string(), sub.to_string()));
            }
        }
        if let Some(email) = c.email.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            if email.bytes().all(|b| (0x20..=0x7E).contains(&b)) {
                meta.push(("created-by".to_string(), email.to_string()));
            }
        }
    }
    let created_at = Utc::now().to_rfc3339();
    if created_at.bytes().all(|b| (0x20..=0x7E).contains(&b)) {
        meta.push(("created-at".to_string(), created_at));
    }
    meta
}

fn build_s3_client(
    access_key_id: &str,
    secret_access_key: &str,
    session_token: &str,
) -> aws_sdk_s3::Client {
    let creds = Credentials::new(
        access_key_id,
        secret_access_key,
        Some(session_token.to_string()),
        None,
        "hq-sync-personal-first-push",
    );
    // Hard-coded to us-east-1: vault Lambda always provisions buckets in us-east-1.
    let config = S3ConfigBuilder::new()
        .credentials_provider(creds)
        .region(Region::new("us-east-1"))
        .build();
    aws_sdk_s3::Client::from_conf(config)
}

// ── Upload retry ──────────────────────────────────────────────────────────────

async fn upload_with_retry(
    key: &str,
    data: Bytes,
    sha256_hex: &str,
    uploader: &UploaderFn,
) -> Result<(), String> {
    const MAX_ATTEMPTS: usize = 3;
    const DELAY_MS: [u64; 2] = [1000, 3000];

    let mut last_err = String::new();
    for attempt in 0..MAX_ATTEMPTS {
        if attempt > 0 {
            #[cfg(not(test))]
            tokio::time::sleep(std::time::Duration::from_millis(DELAY_MS[attempt - 1])).await;
        }
        match uploader(key.to_string(), data.clone(), sha256_hex.to_string()).await {
            UploadOutcome::Ok => return Ok(()),
            UploadOutcome::Transient(e) => last_err = e,
            UploadOutcome::Permanent(e) => return Err(format!("permanent upload error: {e}")),
        }
    }
    Err(format!(
        "upload '{key}' failed after {MAX_ATTEMPTS} attempts: {last_err}"
    ))
}

// ── Core upload algorithm ─────────────────────────────────────────────────────

/// Walk `hq_root/`, applying the ignore filter and excluding `companies/` prefix.
/// Reads + writes the personal-vault journal under `PERSONAL_VAULT_JOURNAL_SLUG`
/// (`__hq_personal_vault__`) — the same slug the steady-state runner uses — so
/// currency decisions agree with the runner instead of a stale legacy journal.
///
/// One-file-at-a-time entry point (`upload_concurrency = 1`). Production
/// reaches the same loop through `ensure_impl_with` in `FirstPushMode::Legacy`.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) async fn run_personal_first_push<C, P, S>(
    hq_root: &Path,
    uploader: UploaderFn,
    on_scan: C,
    on_progress: P,
    on_skip: S,
) -> Result<(usize, usize), String>
where
    C: Fn(usize, usize, Option<String>),
    P: Fn(usize, usize, Option<String>),
    S: Fn(String, String),
{
    run_personal_first_push_with_concurrency(hq_root, uploader, on_scan, on_progress, on_skip, 1)
        .await
}

/// Same walk as `run_personal_first_push`, with the upload phase allowed to
/// keep up to `upload_concurrency` PutObjects in flight.
///
/// `upload_concurrency <= 1` runs the original one-at-a-time loop unchanged;
/// that is the path the `desktop.install-initial-sync-handoff` kill switch
/// restores. Anything larger runs the bounded concurrent loop below. The scan
/// phase, the journal baseline, the per-file retry policy
/// (`upload_with_retry`), the vanished-file tolerance, and the first-error
/// abort are the same in both.
pub(crate) async fn run_personal_first_push_with_concurrency<C, P, S>(
    hq_root: &Path,
    uploader: UploaderFn,
    on_scan: C,
    on_progress: P,
    on_skip: S,
    upload_concurrency: usize,
) -> Result<(usize, usize), String>
where
    C: Fn(usize, usize, Option<String>),
    P: Fn(usize, usize, Option<String>),
    S: Fn(String, String),
{
    let filter = IgnoreFilter::for_hq_root(hq_root)?;

    // Session-continuity carve-out: the active thread file the pointer
    // references is a dynamic name, so it can't be a pure-predicate match —
    // resolve it once (reads handoff.json) and OR it into the per-file gate.
    let continuity: std::collections::HashSet<String> =
        continuity_pointer_rel_paths(hq_root).into_iter().collect();
    let mut file_paths: Vec<PathBuf> = Vec::new();
    for entry in WalkDir::new(hq_root).into_iter().filter_map(|e| e.ok()) {
        if !entry.file_type().is_file() {
            continue;
        }
        let abs = entry.path().to_path_buf();
        if !filter.should_sync(&abs) {
            continue;
        }
        let rel = match abs.strip_prefix(hq_root) {
            Ok(r) => r.to_string_lossy().replace('\\', "/"),
            Err(_) => continue,
        };
        if !is_personal_vault_path(&rel) && !continuity.contains(rel.as_str()) {
            continue;
        }
        file_paths.push(abs);
    }

    let walk_total = file_paths.len();
    let mut uploaded = 0usize;
    let mut skipped = 0usize;
    // Currency baseline MUST be the runner's personal-vault journal
    // (`__hq_personal_vault__`), not the legacy `"personal"` slug. Reading the
    // stale legacy journal made `file_needs_upload` re-flag already-synced
    // files and re-push older local copies over newer cloud objects. See
    // PERSONAL_VAULT_JOURNAL_SLUG.
    let mut journal = read_journal(PERSONAL_VAULT_JOURNAL_SLUG)?;
    let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);

    // Phase A — scan: hash every in-scope file against the journal to build
    // the upload plan. `on_scan` is a liveness signal carrying walk totals;
    // the popover's "x of N files" denominator comes from `on_progress`
    // below, which only ever carries the plan (changed-file) size — feeding
    // the walk total there made a 1-file delta read "x of 2,877 files".
    let mut upload_err: Option<String> = None;
    let mut plan: Vec<(PathBuf, String)> = Vec::new();
    // The scan hashes in the app's own process, which the CPU governor cannot
    // signal — pace it ourselves, same as count_files_to_transfer.
    let mut scan_pacer = hq_desktop_core::cpu_throttle::InProcessPacer::new();
    'scan: for (i, abs) in file_paths.into_iter().enumerate() {
        let rel_key = match abs.strip_prefix(hq_root) {
            Ok(p) => p.to_string_lossy().replace('\\', "/"),
            Err(e) => {
                upload_err = Some(format!("path strip error: {e}"));
                break 'scan;
            }
        };

        on_scan(i, walk_total, Some(rel_key.clone()));

        if !IgnoreFilter::within_size_limit(&abs) {
            on_skip(rel_key.clone(), "exceeds 50MB limit".into());
            skipped += 1;
            continue;
        }

        // Metadata fast path — same size + mtimeMs rule as file_needs_upload
        // and the hq-cloud runner's push side. Skipping on a stat beats
        // reading and SHA-256ing every unchanged byte; on a re-push of a
        // large, mostly-synced vault this is the difference between seconds
        // and minutes of single-core burn. Rust-seeded entries carry no
        // mtimeMs, so a true first push still hashes (journal is empty
        // there anyway) — the fast path only fires once the steady-state
        // runner has stamped mtimes.
        if let Some(entry) = journal.files.get(&rel_key) {
            if let Ok(meta) = std::fs::metadata(&abs) {
                if meta.len() == entry.size {
                    if let (Some(journalled), Some(local)) = (entry.mtime_ms, mtime_ms(&meta)) {
                        if (journalled - local).abs() < MTIME_EPSILON_MS {
                            skipped += 1;
                            continue;
                        }
                    }
                }
            }
        }

        let started = std::time::Instant::now();
        let contents = match std::fs::read(&abs) {
            Ok(c) => c,
            // A single file that vanished between the walk and this read (temp
            // files, editor swaps, a concurrent delete) must NOT abort the whole
            // first push — skip it and keep going. Other read errors still abort.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                on_skip(rel_key.clone(), "file vanished before read".into());
                skipped += 1;
                continue;
            }
            Err(e) => {
                upload_err = Some(format!("{}: {e}", abs.display()));
                break 'scan;
            }
        };
        let digest = Sha256::digest(&contents);
        let sha256_hex = format!("{:x}", digest);
        scan_pacer.charge(started.elapsed());

        if let Some(entry) = journal.files.get(&rel_key) {
            if entry.hash == sha256_hex {
                skipped += 1;
                continue;
            }
        }

        plan.push((abs, rel_key));
    }
    on_scan(walk_total, walk_total, None);

    // Phase B — upload exactly the plan. Files are re-read here rather than
    // carried from the scan: holding the whole changed set in memory would
    // pin the entire vault on a true first push. Re-hashing keeps the
    // journal entry honest if a file changed between phases.
    if upload_err.is_none() && upload_concurrency > 1 {
        let plan_total = plan.len();
        upload_err = upload_plan_concurrently(
            plan,
            &mut journal,
            &now,
            &uploader,
            &on_progress,
            &on_skip,
            upload_concurrency,
            &mut uploaded,
            &mut skipped,
        )
        .await?;
        on_progress(plan_total, plan_total, None);
    } else if upload_err.is_none() {
        let plan_total = plan.len();
        'upload: for (i, (abs, rel_key)) in plan.into_iter().enumerate() {
            on_progress(i, plan_total, Some(rel_key.clone()));

            let contents = match std::fs::read(&abs) {
                Ok(c) => Bytes::from(c),
                // Same vanished-file tolerance as the scan phase: a planned file
                // that disappeared between phases is skipped, not fatal.
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    on_skip(rel_key.clone(), "file vanished before read".into());
                    skipped += 1;
                    continue;
                }
                Err(e) => {
                    upload_err = Some(format!("{}: {e}", abs.display()));
                    break 'upload;
                }
            };
            let size = contents.len() as u64;
            let digest = Sha256::digest(&contents);
            let sha256_hex = format!("{:x}", digest);

            if let Some(entry) = journal.files.get(&rel_key) {
                if entry.hash == sha256_hex {
                    skipped += 1;
                    continue;
                }
            }

            match upload_with_retry(&rel_key, contents, &sha256_hex, &uploader).await {
                Ok(()) => {}
                Err(e) => {
                    upload_err = Some(e);
                    break 'upload;
                }
            }

            journal.files.insert(
                rel_key.clone(),
                JournalEntry {
                    hash: sha256_hex,
                    size,
                    synced_at: now.clone(),
                    direction: Direction::Up,
                    // Rust authors neither remoteEtag nor mtimeMs (see
                    // JournalEntry docs). This is the seed path only; the
                    // hq-cloud runner stamps both on the next steady-state sync.
                    remote_etag: None,
                    mtime_ms: None,
                    extra: Default::default(),
                },
            );
            uploaded += 1;
            // Batched: a full-journal serialize+write per uploaded file turns a
            // large first push into thousands of redundant JSON writes. The
            // final write below persists everything on every exit path (success
            // and upload_err alike); a hard crash inside a batch loses at most
            // JOURNAL_WRITE_BATCH entries, and re-uploading those is idempotent.
            if uploaded % JOURNAL_WRITE_BATCH == 0 {
                write_journal(PERSONAL_VAULT_JOURNAL_SLUG, &journal)?;
            }
        }
        on_progress(plan_total, plan_total, None);
    }

    journal.last_sync = now;
    let _ = write_journal(PERSONAL_VAULT_JOURNAL_SLUG, &journal);

    if let Some(e) = upload_err {
        return Err(e);
    }

    Ok((uploaded, skipped))
}

/// Result of one planned upload in the concurrent upload phase.
enum PlannedUpload {
    /// Uploaded; journal it.
    Uploaded {
        rel_key: String,
        sha256_hex: String,
        size: u64,
    },
    /// The file now matches its journal entry (changed back between phases).
    Unchanged,
    /// The file disappeared between the scan and the read.
    Vanished(String),
}

/// Upload phase with bounded concurrency. Mirrors the sequential loop in
/// `run_personal_first_push_with_concurrency` file for file:
///
/// - `on_progress(i, total, Some(rel))` fires for each planned file before it
///   is read, with `i` its position in the plan;
/// - a vanished file is skipped with the same reason, other read errors abort;
/// - each file goes through `upload_with_retry` (same attempts, same
///   transient/permanent split);
/// - the first failure stops the phase and becomes the returned error. Uploads
///   already in flight at that moment are dropped without being journaled,
///   which is safe because re-uploading them later is idempotent;
/// - the journal is flushed every `JOURNAL_WRITE_BATCH` uploads.
///
/// Returns `Ok(Some(err))` for an upload/read failure (the caller writes the
/// journal and surfaces it, as the sequential loop does) and `Err` only for a
/// journal write failure, matching the sequential loop's `?`.
#[allow(clippy::too_many_arguments)]
async fn upload_plan_concurrently<P, S>(
    plan: Vec<(PathBuf, String)>,
    journal: &mut crate::util::journal::SyncJournal,
    now: &str,
    uploader: &UploaderFn,
    on_progress: &P,
    on_skip: &S,
    upload_concurrency: usize,
    uploaded: &mut usize,
    skipped: &mut usize,
) -> Result<Option<String>, String>
where
    P: Fn(usize, usize, Option<String>),
    S: Fn(String, String),
{
    use futures_util::stream::StreamExt as _;

    let plan_total = plan.len();
    // Snapshot each planned file's baseline hash up front so the in-flight
    // futures never borrow the journal the loop below is writing to. Only this
    // phase writes the journal, and only for keys it has uploaded, so the
    // snapshot is the same value the sequential loop would read.
    let planned: Vec<(usize, PathBuf, String, Option<String>)> = plan
        .into_iter()
        .enumerate()
        .map(|(i, (abs, rel_key))| {
            let baseline = journal.files.get(&rel_key).map(|e| e.hash.clone());
            (i, abs, rel_key, baseline)
        })
        .collect();

    let mut results = futures_util::stream::iter(planned.into_iter().map(
        |(i, abs, rel_key, baseline)| {
            let uploader = uploader.clone();
            async move {
                on_progress(i, plan_total, Some(rel_key.clone()));
                let contents = match std::fs::read(&abs) {
                    Ok(c) => Bytes::from(c),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                        return Ok(PlannedUpload::Vanished(rel_key));
                    }
                    Err(e) => return Err(format!("{}: {e}", abs.display())),
                };
                let size = contents.len() as u64;
                let sha256_hex = format!("{:x}", Sha256::digest(&contents));
                if baseline.as_deref() == Some(sha256_hex.as_str()) {
                    return Ok(PlannedUpload::Unchanged);
                }
                upload_with_retry(&rel_key, contents, &sha256_hex, &uploader).await?;
                Ok(PlannedUpload::Uploaded {
                    rel_key,
                    sha256_hex,
                    size,
                })
            }
        },
    ))
    .buffer_unordered(upload_concurrency.max(1));

    while let Some(result) = results.next().await {
        match result {
            Ok(PlannedUpload::Uploaded {
                rel_key,
                sha256_hex,
                size,
            }) => {
                journal.files.insert(
                    rel_key,
                    JournalEntry {
                        hash: sha256_hex,
                        size,
                        synced_at: now.to_string(),
                        direction: Direction::Up,
                        // Same as the sequential loop: Rust authors neither
                        // remoteEtag nor mtimeMs; the runner stamps both later.
                        remote_etag: None,
                        mtime_ms: None,
                        extra: Default::default(),
                    },
                );
                *uploaded += 1;
                if *uploaded % JOURNAL_WRITE_BATCH == 0 {
                    write_journal(PERSONAL_VAULT_JOURNAL_SLUG, journal)?;
                }
            }
            Ok(PlannedUpload::Unchanged) => *skipped += 1,
            Ok(PlannedUpload::Vanished(rel_key)) => {
                on_skip(rel_key, "file vanished before read".into());
                *skipped += 1;
            }
            Err(e) => return Ok(Some(e)),
        }
    }
    Ok(None)
}

// ── Cache validation ──────────────────────────────────────────────────────────

/// Returns Ok(true) if cache UID is still present, Ok(false) if confirmed gone,
/// Err if a transient error prevented the check (caller should keep the cache).
async fn validate_cache_via_list(
    vault: &VaultClient,
    cache: &PersonEntityCache,
) -> Result<bool, VaultClientError> {
    let entities = vault.list_entities_by_type("person").await?;
    Ok(entities.iter().any(|e| e.uid == cache.person_uid))
}

async fn list_person_entities_with_retry(
    vault: &VaultClient,
) -> Result<Vec<EntityInfo>, VaultClientError> {
    const MAX_ATTEMPTS: usize = 3;
    const INITIAL_BACKOFF_MS: u64 = 200;

    let mut attempt = 1;
    loop {
        match vault.list_entities_by_type("person").await {
            Ok(entities) => return Ok(entities),
            Err(err) if attempt >= MAX_ATTEMPTS => return Err(err),
            Err(_) => {
                let backoff_ms = INITIAL_BACKOFF_MS * (1_u64 << (attempt - 1));
                tokio::time::sleep(std::time::Duration::from_millis(backoff_ms)).await;
                attempt += 1;
            }
        }
    }
}

/// Provision the caller's person entity by reading Cognito idToken claims
/// (sub, name/email) and POST'ing to /entity. Used when `list_entities_by_type`
/// returns empty — i.e. a brand-new account that has never synced before.
/// Mirrors `vault-client.ts::ensureMyPersonEntity` so the auto-create path is
/// identical in shape to the runner's claim-dance path.
///
/// Return semantics:
///   * `Ok(Some(entity))` — created (or recovered an already-existing) person.
///   * `Ok(None)` — the person already exists server-side (HTTP 409) but could
///     not be resolved this cycle. This is BENIGN: the `hq-sync-runner` that
///     follows owns the personal vault, so the caller should skip personal
///     first-push quietly rather than surface a `sync:error`. Mirrors the TS
///     runner's claim-dance, which tolerates an already-provisioned person
///     ("claim-dance skipped — …") instead of treating it as a sync failure.
///   * `Err(..)` — a REAL failure (5xx, network, auth, malformed token). These
///     are NOT 409s and stay loud so genuine first-push breakage is reported.
pub(crate) async fn create_person_entity_from_cognito(
    vault: &VaultClient,
) -> Result<Option<EntityInfo>, String> {
    let tokens = crate::commands::cognito::read_tokens_from_file()?
        .ok_or_else(|| "no cached cognito tokens — sign in first".to_string())?;
    let id_token = tokens
        .id_token
        .as_deref()
        .ok_or_else(|| "cognito tokens missing id_token field".to_string())?;
    let claims = crate::commands::cognito::decode_id_token_claims(id_token)?;
    let owner_sub = claims
        .sub
        .clone()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "id_token has no `sub` claim".to_string())?;
    let display_name = claims.display_name();
    if display_name.is_empty() {
        return Err(
            "id_token has no name/given_name/family_name/email — can't derive a display name"
                .into(),
        );
    }
    // Slugify: lower, [^a-z0-9]→'-', trim leading/trailing '-', cap at 63 chars.
    // Fallback if slug is empty: "user-<last 8 of sub, lowercased>".
    let mut slug: String = display_name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    while slug.contains("--") {
        slug = slug.replace("--", "-");
    }
    let slug = slug.trim_matches('-');
    let slug = if slug.is_empty() {
        let last8: String = owner_sub
            .chars()
            .rev()
            .take(8)
            .collect::<String>()
            .chars()
            .rev()
            .collect::<String>()
            .to_lowercase();
        format!("user-{last8}")
    } else {
        let mut s = slug.to_string();
        s.truncate(63);
        s
    };

    log(
        "personal",
        &format!("auto-create person entity: slug={slug} name={display_name}"),
    );
    match vault
        .create_entity(&crate::commands::vault_client::CreateEntityInput {
            entity_type: "person".into(),
            slug: slug.clone(),
            name: display_name,
            email: claims.email.clone(),
            owner_uid: Some(owner_sub),
        })
        .await
    {
        Ok(entity) => Ok(Some(entity)),
        // 409 = the person entity already exists. We only reach create at all
        // when `list_entities_by_type("person")` returned empty, so an
        // already-exists here means the list/create views disagreed this cycle
        // (e.g. eventual-consistency or scoping skew). Recover the existing row
        // by slug so first-push can still proceed; if it can't be resolved,
        // return None so the caller skips quietly. Either way this is benign and
        // must NOT surface as a user-facing "personal first-push failed" error.
        Err(VaultClientError::Http { status: 409, .. }) => {
            log(
                "personal",
                &format!("person entity already exists (409) — recovering by slug={slug}"),
            );
            match vault.find_entity_by_slug("person", &slug).await {
                Ok(Some(existing)) => Ok(Some(existing)),
                Ok(None) => {
                    log(
                        "personal",
                        &format!("person entity exists (409) but not resolvable by slug={slug} — skipping personal first-push (runner will handle)"),
                    );
                    Ok(None)
                }
                Err(e) => {
                    // Recovery lookup itself failed transiently. The person
                    // still exists (we got a 409), so this remains benign —
                    // skip quietly rather than report an error.
                    log(
                        "personal",
                        &format!("person-entity recovery lookup failed after 409: {e} — skipping personal first-push"),
                    );
                    Ok(None)
                }
            }
        }
        Err(e) => Err(format!("create person entity: {e}")),
    }
}

// ── Person resolution: cache → list+provision (no recursion) ─────────────────

/// Resolves (person_uid, bucket_name) using the local cache when valid, falling
/// back to a vault list + canonical sort + provision call if needed.
///
/// Cache validation uses `validate_cache_via_list` exclusively — the by-slug
/// route expects a Cognito sub / human identifier, not a UID like `prs_01HX...`.
/// On transient vault errors the cached data is used optimistically.
/// Returns `Ok(Some((person_uid, bucket_name)))` once resolved. Returns
/// `Ok(None)` when the person entity already exists but can't be resolved this
/// cycle (benign 409 — see `create_person_entity_from_cognito`); the caller
/// skips personal first-push quietly in that case.
async fn resolve_or_provision<R: tauri::Runtime + 'static>(
    app: &tauri::AppHandle<R>,
    vault: &VaultClient,
) -> Result<Option<(String, String)>, String> {
    if let Some(cache) = read_cache() {
        match validate_cache_via_list(vault, &cache).await {
            Ok(true) => return Ok(Some((cache.person_uid, cache.bucket_name))),
            Ok(false) => {
                // Entity confirmed absent from vault — invalidate cache
                delete_cache();
            }
            Err(_) => {
                // Transient error (5xx, network) — proceed optimistically with cached data
                return Ok(Some((cache.person_uid, cache.bucket_name)));
            }
        }
    }

    // Cache miss or just invalidated: list all person entities and apply canonical sort
    let entities = list_person_entities_with_retry(vault)
        .await
        .map_err(|e| format!("list person entities: {e}"))?;

    let mut sorted = entities;
    sorted.sort_by(|a, b| {
        let ac = a.created_at.as_str();
        let bc = b.created_at.as_str();
        match ac.cmp(bc) {
            std::cmp::Ordering::Equal => a.uid.cmp(&b.uid),
            ord => ord,
        }
    });
    let mut pick = match sorted.into_iter().next() {
        Some(p) => p,
        None => {
            // First sync for a brand-new account: no person entity exists yet.
            // Auto-create one from the cached Cognito idToken claims (sub for
            // owner, name/given+family/email for displayName). This replaces
            // the old bail ("no person entity for caller") that used to leave
            // the user stuck — they had to do the setup dance externally.
            // After creation the rest of provisioning continues as for any
            // existing entity (provision_bucket, cache, return).
            //
            // `Ok(None)` here means the person already exists server-side (409)
            // but couldn't be resolved — propagate the benign skip upward.
            match crate::commands::personal::create_person_entity_from_cognito(vault).await? {
                Some(entity) => entity,
                None => return Ok(None),
            }
        }
    };

    // The person entity now exists, which is the ONLY precondition
    // `/v1/usage/opt-in` has — and the one onboarding could not satisfy when it
    // first posted the consent. Repair it here, BEFORE bucket provisioning,
    // which can fail and return early: gating the consent repair on the bucket
    // would leave the original race unfixed for exactly the users whose
    // provisioning is having a bad day.
    crate::commands::telemetry::reassert_consent_for_person(vault, &pick.uid).await;

    if pick.bucket_name.is_none() {
        let bucket_info = vault
            .provision_bucket(&pick.uid)
            .await
            .map_err(|e| format!("provision_bucket for {}: {e}", pick.uid))?;
        pick.bucket_name = Some(bucket_info.bucket_name.clone());
        let _ = app.emit(
            EVENT_SYNC_PERSONAL_PROVISIONED,
            SyncPersonalProvisionedEvent {
                person_uid: pick.uid.clone(),
                bucket_name: bucket_info.bucket_name,
            },
        );
    }

    let resolved_bucket = pick.bucket_name.unwrap_or_default();
    let cache = PersonEntityCache {
        person_uid: pick.uid.clone(),
        bucket_name: resolved_bucket.clone(),
        created_at: pick.created_at.clone(),
    };
    let _ = write_cache(&cache);

    Ok(Some((pick.uid, resolved_bucket)))
}

// ── Public entry point ────────────────────────────────────────────────────────

/// Guarantee the caller's `person` entity exists before the consent write.
///
/// AC1 of US-002: `/v1/usage/opt-in` resolves the caller's `prs_*` person
/// entity and 404s (`no-person-entity`) when none exists — the original
/// lost-answer defect. The consent step now sits AFTER setup, which provisions
/// the entity, but that provisioning is kicked off in the BACKGROUND by
/// `start_initial_cloud_sync` and may still be in flight when consent is
/// submitted. Rather than relying on step ordering alone, the consent step
/// awaits this command first: it resolves the entity from cache or provisions
/// it synchronously, so the POST that follows always has somewhere to land.
///
/// Returns `Ok(true)` once an entity exists (resolved or freshly created), and
/// `Ok(false)` for the benign 409 where the entity exists server-side but is
/// not resolvable this cycle — in both cases the entity IS present, so the
/// consent write may proceed. Only a hard error (no token, vault unreachable)
/// surfaces as `Err`, which the caller treats like any other upload failure.
#[tauri::command]
pub async fn ensure_person_entity(app: tauri::AppHandle) -> Result<bool, String> {
    let jwt = crate::commands::sync::resolve_jwt().await?;
    let vault_url = crate::commands::sync::resolve_vault_api_url()?;
    let vault = VaultClient::new(&vault_url, &jwt);
    // `Some(..)` = resolved to a concrete uid; `None` = benign 409, entity
    // already exists server-side. Either way the entity is present.
    Ok(resolve_or_provision(&app, &vault).await?.is_some())
}

/// Store the signed-in person's HQ Anywhere opt-in through hq-pro's person-settings API.
#[tauri::command]
pub async fn put_hq_anywhere_person_setting(value: bool) -> Result<(), String> {
    let access_token = crate::commands::cognito::get_valid_access_token()
        .await
        .map_err(|error| {
            eprintln!("[person-settings] could not refresh caller token: {error}");
            "Could not save the HQ Anywhere setting.".to_string()
        })?;
    let api_url = crate::commands::sync::resolve_vault_api_url().map_err(|error| {
        eprintln!("[person-settings] could not resolve vault API: {error}");
        "Could not save the HQ Anywhere setting.".to_string()
    })?;
    let vault = VaultClient::new(&api_url, &access_token);
    vault
        .put_hq_anywhere_person_setting(value)
        .await
        .map(|_| ())
        .map_err(|error| {
            eprintln!("[person-settings] HQ Anywhere setting write failed: {error}");
            "Could not save the HQ Anywhere setting.".to_string()
        })
}

pub async fn ensure_personal_bucket_and_first_push<R: tauri::Runtime + 'static>(
    app: &tauri::AppHandle<R>,
    vault: &VaultClient,
    hq_root: &Path,
) -> Result<(), String> {
    ensure_impl(app, vault, hq_root, None).await
}

/// Internal version that accepts an optional uploader override for tests.
/// When `uploader_override` is `None`, the real S3 client is used.
///
/// This is the pre-handoff behaviour: no sync-daemon check and the one-file-
/// at-a-time upload. It is what `start_initial_cloud_sync` runs when the
/// `desktop.install-initial-sync-handoff` kill switch is off.
pub(crate) async fn ensure_impl<R: tauri::Runtime + 'static>(
    app: &tauri::AppHandle<R>,
    vault: &VaultClient,
    hq_root: &Path,
    uploader_override: Option<UploaderFn>,
) -> Result<(), String> {
    ensure_impl_with(app, vault, hq_root, uploader_override, &FirstPushMode::Legacy)
        .await
        .map(|_| ())
}

// ── Install-stage handoff to the sync daemon ──────────────────────────────────

/// hq-flags kill switch for the fast install-stage initial sync. Default ON:
/// only an explicit `false` in the registry restores the old sequential
/// first-push. A missing row or an unreachable registry keeps it on.
pub(crate) const INSTALL_INITIAL_SYNC_HANDOFF_FLAG: &str = "desktop.install-initial-sync-handoff";

/// Uploads kept in flight by the concurrent first-push. Kept small on purpose:
/// each in-flight file is held in memory (up to the 50 MB per-file limit), and
/// eight is already enough to take a ~1,600-file first push from minutes to
/// seconds at ~75 ms per PutObject.
pub(crate) const FIRST_PUSH_UPLOAD_CONCURRENCY: usize = 8;

/// How long the install stage waits for a daemon that is still `Starting` to
/// reach `Running` before it stops waiting and uploads the files itself.
const DAEMON_STARTING_WAIT: std::time::Duration = std::time::Duration::from_secs(15);
const DAEMON_STARTING_POLL: std::time::Duration = std::time::Duration::from_millis(250);

/// After a handoff, how long to wait for the daemon's personal-vault journal
/// before the background safety net runs the upload itself, and how often to
/// look.
const HANDOFF_SAFETY_NET_DEADLINE: std::time::Duration = std::time::Duration::from_secs(5 * 60);
const HANDOFF_SAFETY_NET_POLL: std::time::Duration = std::time::Duration::from_secs(5);

/// Everything the handoff gate needs to know about the sync daemon, read at
/// one point in time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct DaemonHandoffSnapshot {
    pub lifecycle: crate::commands::daemon::WatchDaemonState,
    /// The user-facing Auto-sync toggle (`realtimeSync`).
    pub auto_sync_enabled: bool,
    /// The Personal sync toggle. Off means the daemon runs `--skip-personal`.
    pub personal_sync_enabled: bool,
    /// Sync is not paused (Cloud Off) and not disabled by the dev kill switch.
    pub spawn_allowed: bool,
    /// A Cognito session is cached, so the daemon can authenticate.
    pub signed_in: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DaemonHandoffDecision {
    /// The daemon is running and will push the personal vault.
    Confirmed,
    /// The daemon is still starting; ask again shortly.
    Pending,
    /// Not confirmed. The caller uploads the files itself.
    Refused,
}

/// The handoff rule. The daemon only counts as owning the upload when every
/// condition holds and it is `Running` (in production: a live runner process,
/// see `daemon::watch_daemon_handoff_lifecycle`). `Starting` is not enough on
/// its own (its preflight can still fail), so it is `Pending`. `Backoff`, `Stopped`,
/// Auto-sync off, Personal sync off, sync paused, or signed out are `Refused`.
pub(crate) fn daemon_handoff_decision(snapshot: &DaemonHandoffSnapshot) -> DaemonHandoffDecision {
    use crate::commands::daemon::WatchDaemonState;
    if !(snapshot.auto_sync_enabled
        && snapshot.personal_sync_enabled
        && snapshot.spawn_allowed
        && snapshot.signed_in)
    {
        return DaemonHandoffDecision::Refused;
    }
    match snapshot.lifecycle {
        WatchDaemonState::Running => DaemonHandoffDecision::Confirmed,
        WatchDaemonState::Starting => DaemonHandoffDecision::Pending,
        WatchDaemonState::Backoff | WatchDaemonState::Stopped => DaemonHandoffDecision::Refused,
    }
}

fn live_daemon_handoff_snapshot() -> DaemonHandoffSnapshot {
    DaemonHandoffSnapshot {
        lifecycle: crate::commands::daemon::watch_daemon_handoff_lifecycle(),
        auto_sync_enabled: crate::commands::daemon::is_realtime_sync_enabled(),
        personal_sync_enabled: hq_desktop_core::daemon::is_personal_sync_enabled(),
        spawn_allowed: hq_desktop_core::daemon::ensure_sync_spawn_allowed().is_ok(),
        signed_in: matches!(crate::commands::cognito::read_tokens_from_file(), Ok(Some(_))),
    }
}

/// Source of daemon snapshots plus the wait policy for a `Starting` daemon.
/// Production reads live state; tests inject a scripted sequence.
#[derive(Clone)]
pub(crate) struct DaemonHandoffProbe {
    snapshot: Arc<dyn Fn() -> DaemonHandoffSnapshot + Send + Sync>,
    starting_wait: std::time::Duration,
    poll_interval: std::time::Duration,
}

impl DaemonHandoffProbe {
    pub(crate) fn live() -> Self {
        Self {
            snapshot: Arc::new(live_daemon_handoff_snapshot),
            starting_wait: DAEMON_STARTING_WAIT,
            poll_interval: DAEMON_STARTING_POLL,
        }
    }

    #[cfg(test)]
    pub(crate) fn scripted(
        snapshot: Arc<dyn Fn() -> DaemonHandoffSnapshot + Send + Sync>,
        starting_wait: std::time::Duration,
        poll_interval: std::time::Duration,
    ) -> Self {
        Self {
            snapshot,
            starting_wait,
            poll_interval,
        }
    }

    fn snapshot(&self) -> DaemonHandoffSnapshot {
        (self.snapshot)()
    }

    /// True only when the daemon is positively confirmed to own the upload.
    /// A `Starting` daemon is given `starting_wait` to reach `Running`; any
    /// other answer, or running out of time, is `false`.
    pub(crate) async fn daemon_owns_personal_upload(&self) -> bool {
        let deadline = tokio::time::Instant::now() + self.starting_wait;
        loop {
            match daemon_handoff_decision(&self.snapshot()) {
                DaemonHandoffDecision::Confirmed => return true,
                DaemonHandoffDecision::Refused => return false,
                DaemonHandoffDecision::Pending => {
                    if tokio::time::Instant::now() >= deadline {
                        return false;
                    }
                    tokio::time::sleep(self.poll_interval).await;
                }
            }
        }
    }
}

/// How `ensure_impl_with` handles the upload once the vault is provisioned.
#[derive(Clone)]
pub(crate) enum FirstPushMode {
    /// Pre-handoff behaviour: no daemon check, one upload at a time.
    Legacy,
    /// Install stage: hand the upload to the sync daemon when the probe
    /// confirms it owns it; otherwise upload with bounded concurrency.
    InstallHandoff(DaemonHandoffProbe),
    /// Upload with bounded concurrency, no daemon check. Used by the
    /// post-handoff safety net once the daemon has had its chance.
    ConcurrentWalk,
}

/// What the personal first-push did. `start_initial_cloud_sync` only needs
/// Ok/Err; the variants exist for logs and tests.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PersonalFirstPushOutcome {
    /// The person entity exists but was not resolvable this cycle (benign 409).
    PersonEntityAlreadyExists,
    /// The runner's personal journal already exists; the runner owns sync.
    EngineOwnsSteadyState,
    /// The vault is provisioned and the running sync daemon will upload it.
    /// Nothing was uploaded by this call.
    HandedToSyncDaemon,
    /// This call walked the vault and uploaded what changed.
    Uploaded {
        files_uploaded: usize,
        files_skipped: usize,
    },
}

/// Install-stage entry point used by `start_initial_cloud_sync` when the
/// `desktop.install-initial-sync-handoff` flag is on.
///
/// Provisions the person entity and personal bucket, then either hands the
/// upload to the running sync daemon (returning in seconds) or, when the
/// daemon is not positively confirmed, uploads the vault itself with bounded
/// concurrency. After a handoff, a background safety net waits for the
/// daemon's personal journal and runs the upload itself if the daemon stops
/// or never gets to it.
pub async fn ensure_personal_vault_for_install<R: tauri::Runtime + 'static>(
    app: &tauri::AppHandle<R>,
    vault: &VaultClient,
    hq_root: &Path,
) -> Result<PersonalFirstPushOutcome, String> {
    let probe = DaemonHandoffProbe::live();
    let outcome = ensure_impl_with(
        app,
        vault,
        hq_root,
        None,
        &FirstPushMode::InstallHandoff(probe.clone()),
    )
    .await?;
    if outcome == PersonalFirstPushOutcome::HandedToSyncDaemon {
        spawn_handoff_safety_net(app.clone(), hq_root.to_path_buf(), probe);
    }
    Ok(outcome)
}

/// Why the post-handoff wait ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HandoffWatchVerdict {
    /// The daemon's personal journal appeared: it synced the vault.
    DaemonSynced,
    /// The daemon stopped owning the upload (crashed, backoff, toggled off).
    DaemonStopped,
    /// The deadline passed without a personal journal.
    TimedOut,
}

/// Wait for the daemon to finish its first personal-vault pass.
pub(crate) async fn watch_daemon_handoff<J>(
    probe: &DaemonHandoffProbe,
    journal_exists: J,
    deadline: std::time::Duration,
    poll_interval: std::time::Duration,
) -> HandoffWatchVerdict
where
    J: Fn() -> bool,
{
    let until = tokio::time::Instant::now() + deadline;
    loop {
        if journal_exists() {
            return HandoffWatchVerdict::DaemonSynced;
        }
        if daemon_handoff_decision(&probe.snapshot()) == DaemonHandoffDecision::Refused {
            return HandoffWatchVerdict::DaemonStopped;
        }
        if tokio::time::Instant::now() >= until {
            return HandoffWatchVerdict::TimedOut;
        }
        tokio::time::sleep(poll_interval).await;
    }
}

/// One safety net at a time, so a retried install stage cannot stack them.
static HANDOFF_SAFETY_NET_IN_FLIGHT: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// Background follow-up to a handoff. The daemon may have planned its first
/// pass before this install provisioned the personal bucket, in which case
/// that pass carries no personal target, or it may crash. Either way the
/// personal journal does not appear, and this runs the same concurrent walk
/// the install stage would have run. The walk re-checks the journal gate, so
/// it does nothing once the runner owns the vault. Errors are logged; the
/// install stage has already reported its result.
fn spawn_handoff_safety_net<R: tauri::Runtime + 'static>(
    app: tauri::AppHandle<R>,
    hq_root: PathBuf,
    probe: DaemonHandoffProbe,
) {
    use std::sync::atomic::Ordering;
    if HANDOFF_SAFETY_NET_IN_FLIGHT
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let verdict = watch_daemon_handoff(
            &probe,
            engine_owns_personal_steady_state,
            HANDOFF_SAFETY_NET_DEADLINE,
            HANDOFF_SAFETY_NET_POLL,
        )
        .await;
        log(
            "personal",
            &format!("personal handoff safety net: verdict={verdict:?}"),
        );
        if verdict != HandoffWatchVerdict::DaemonSynced {
            let result = async {
                let jwt = crate::commands::sync::resolve_jwt().await?;
                let vault_url = crate::commands::sync::resolve_vault_api_url()?;
                let vault = VaultClient::new(&vault_url, &jwt);
                ensure_impl_with(&app, &vault, &hq_root, None, &FirstPushMode::ConcurrentWalk)
                    .await
            }
            .await;
            match result {
                Ok(outcome) => log(
                    "personal",
                    &format!("personal handoff safety net finished: {outcome:?}"),
                ),
                Err(e) => log(
                    "personal",
                    &format!("personal handoff safety net upload failed: {e}"),
                ),
            }
        }
        HANDOFF_SAFETY_NET_IN_FLIGHT.store(false, Ordering::Release);
    });
}

/// Shared provisioning + gating + upload body for every mode.
pub(crate) async fn ensure_impl_with<R: tauri::Runtime + 'static>(
    app: &tauri::AppHandle<R>,
    vault: &VaultClient,
    hq_root: &Path,
    uploader_override: Option<UploaderFn>,
    mode: &FirstPushMode,
) -> Result<PersonalFirstPushOutcome, String> {
    let (person_uid, bucket_name) = match resolve_or_provision(app, vault).await? {
        Some(p) => p,
        None => {
            // Benign: the person entity already exists but isn't resolvable this
            // cycle (HTTP 409). Skip personal first-push quietly — the
            // hq-sync-runner that follows owns the personal vault. Emit a
            // diagnostic skip event (no frontend error surface) and return Ok so
            // the user never sees a spurious "personal first-push failed".
            let _ = app.emit(
                EVENT_SYNC_PERSONAL_FIRST_PUSH_SKIPPED,
                SyncPersonalFirstPushSkippedEvent {
                    person_uid: String::new(),
                    path: "personal".to_string(),
                    reason: "person-entity-already-exists".to_string(),
                },
            );
            log(
                "personal",
                "personal first-push skipped — person entity already exists (benign 409)",
            );
            return Ok(PersonalFirstPushOutcome::PersonEntityAlreadyExists);
        }
    };

    // Second consent-repair site, and NOT redundant with the one inside
    // `resolve_or_provision`.
    //
    // That one runs before bucket provisioning, so a bucket failure cannot
    // strand the repair — but it sits below the person-cache early returns, so
    // it only fires on a cache MISS. Once `person-entity.json` is written every
    // later sync resolves from cache and never reaches it. A first attempt that
    // failed for any reason (provenance not yet written by onboarding, the new
    // person not yet visible to the opt-in route, a transient network error)
    // would then never be retried, leaving consent unset forever.
    //
    // This call is on the cached path, so each sync gets another chance. It is
    // cheap: once the record names this person it returns immediately without
    // touching the network.
    crate::commands::telemetry::reassert_consent_for_person(vault, &person_uid).await;

    // ── Steady-state gate ──────────────────────────────────────────────────
    // The warm-up first-push exists ONLY to seed a brand-new personal vault
    // before the hq-cloud runner has ever synced it. Once the runner's journal
    // (sync-journal.__hq_personal_vault__.json) exists, the runner owns the
    // personal vault bidirectionally. Re-walking + uploading here compares
    // files against a baseline the runner's pulls never update, so any file
    // another machine pushed (and the runner pulled) looks "locally changed"
    // and gets re-uploaded over newer cloud state — split-brain. In the field
    // this ALSO failed every cycle ("permanent upload error") while surfacing
    // an inflated "Syncing Personal … of N" count (N = files the runner then
    // skips). Provisioning above still runs every cycle; only the upload walk
    // is gated. Emit COMPLETE so the popover's personal slot latches normally.
    if engine_owns_personal_steady_state() {
        log(
            "personal",
            "personal first-push skipped — engine journal exists, runner owns steady-state personal sync",
        );
        emit_first_push_complete_without_uploading(app, &person_uid);
        return Ok(PersonalFirstPushOutcome::EngineOwnsSteadyState);
    }

    // ── Install-stage handoff gate ─────────────────────────────────────────
    // On a fresh install the runner's journal does not exist yet, so the gate
    // above stays open, but the sync daemon started seconds earlier is about
    // to push these same files. Walking and uploading them here as well took
    // ~2 minutes of a ~2.5 minute install. When the daemon is positively
    // confirmed to own the upload (running, Auto-sync on, Personal sync on,
    // not paused, signed in), skip the walk. The vault is provisioned above,
    // so the daemon has a bucket to push into. Anything less than a positive
    // confirmation falls through to the walk. Only the install mode checks;
    // Legacy and ConcurrentWalk never skip here.
    if let FirstPushMode::InstallHandoff(probe) = mode {
        if probe.daemon_owns_personal_upload().await {
            log(
                "personal",
                "personal first-push handed to the sync daemon — vault provisioned, daemon running and will upload",
            );
            // Same COMPLETE the steady-state gate emits, so listeners latch.
            // files_uploaded: 0 is accurate: this call uploaded nothing. The
            // log line above and the HandedToSyncDaemon outcome record why; no
            // extra broadcast is sent for it (see the broadcast-emit ceiling in
            // scripts/perf-budget-contract.test.ts).
            emit_first_push_complete_without_uploading(app, &person_uid);
            return Ok(PersonalFirstPushOutcome::HandedToSyncDaemon);
        }
        log(
            "personal",
            "personal first-push not handed off — sync daemon not confirmed; uploading here",
        );
    }
    let upload_concurrency = match mode {
        FirstPushMode::Legacy => 1,
        FirstPushMode::InstallHandoff(_) | FirstPushMode::ConcurrentWalk => {
            FIRST_PUSH_UPLOAD_CONCURRENCY
        }
    };

    // Obtain STS credentials via /sts/vend-self (never vend-child)
    let vend_result = match vault
        .vend_self(&VendSelfInput {
            person_uid: person_uid.clone(),
            duration_seconds: None,
        })
        .await
    {
        Ok(r) => r,
        Err(VaultClientError::SelfOwnershipMismatch) => {
            let _ = app.emit(
                EVENT_SYNC_PERSONAL_SKIPPED_OWNERSHIP_MISMATCH,
                SyncPersonalSkippedOwnershipMismatchEvent {
                    person_uid: person_uid.clone(),
                },
            );
            return Err("personal first-push aborted: SELF_OWNERSHIP_MISMATCH".to_string());
        }
        Err(e) => return Err(format!("vend_self for {person_uid}: {e}")),
    };

    let uploader: UploaderFn = match uploader_override {
        Some(f) => f,
        None => {
            let s3 = Arc::new(build_s3_client(
                &vend_result.credentials.access_key_id,
                &vend_result.credentials.secret_access_key,
                &vend_result.credentials.session_token,
            ));
            let bucket = bucket_name.clone();
            // Resolve uploader identity from the cached Cognito id token. The
            // hq-console Vault tab's CREATED BY column reads
            // S3 user metadata `created-by` / `created-by-sub` set on PutObject;
            // without these the column reads "—" for every personal-vault row.
            // ASCII-filter both fields to match `buildAuthorMetadata` in
            // packages/hq-cloud/src/s3.ts and hq-console/src/lib/s3-vault.ts.
            let author_meta = build_personal_author_metadata();
            Arc::new(
                move |key: String, data: Bytes, sha256_hex: String| -> BoxFuture<UploadOutcome> {
                    let s3 = s3.clone();
                    let bucket = bucket.clone();
                    let author_meta = author_meta.clone();
                    Box::pin(async move {
                        let sha256_b64 = base64::engine::general_purpose::STANDARD
                            .encode(hex_to_bytes(&sha256_hex));
                        let mut req = s3
                            .put_object()
                            .bucket(&bucket)
                            .key(&key)
                            .body(ByteStream::from(data))
                            .checksum_sha256(sha256_b64);
                        for (k, v) in author_meta.iter() {
                            req = req.metadata(k, v);
                        }
                        match req.send().await {
                            Ok(_) => UploadOutcome::Ok,
                            Err(e) => {
                                let status =
                                    e.raw_response().map(|r| r.status().as_u16()).unwrap_or(0);
                                if status == 0 || status >= 500 {
                                    UploadOutcome::Transient(e.to_string())
                                } else {
                                    UploadOutcome::Permanent(e.to_string())
                                }
                            }
                        }
                    })
                },
            )
        }
    };

    let app_scan = app.clone();
    let person_uid_scan = person_uid.clone();
    let app_progress = app.clone();
    let person_uid_progress = person_uid.clone();
    let app_skip = app.clone();
    let person_uid_skip = person_uid.clone();
    let puid_complete = person_uid.clone();

    let (files_uploaded, files_skipped) = run_personal_first_push_with_concurrency(
        hq_root,
        uploader,
        move |scanned, total, file| {
            let _ = app_scan.emit(
                EVENT_SYNC_PERSONAL_FIRST_PUSH_SCAN,
                SyncPersonalFirstPushScanEvent {
                    person_uid: person_uid_scan.clone(),
                    files_scanned: scanned,
                    files_total: total,
                    current_file: file,
                },
            );
        },
        move |done, total, file| {
            let _ = app_progress.emit(
                EVENT_SYNC_PERSONAL_FIRST_PUSH_PROGRESS,
                SyncPersonalFirstPushProgressEvent {
                    person_uid: person_uid_progress.clone(),
                    files_done: done,
                    files_total: total,
                    current_file: file,
                },
            );
        },
        move |key, reason| {
            let _ = app_skip.emit(
                EVENT_SYNC_PERSONAL_FIRST_PUSH_SKIPPED,
                SyncPersonalFirstPushSkippedEvent {
                    person_uid: person_uid_skip.clone(),
                    path: key,
                    reason,
                },
            );
        },
        upload_concurrency,
    )
    .await?;

    let _ = app.emit(
        EVENT_SYNC_PERSONAL_FIRST_PUSH_COMPLETE,
        SyncPersonalFirstPushCompleteEvent {
            person_uid: puid_complete,
            files_uploaded,
            files_skipped,
        },
    );

    Ok(PersonalFirstPushOutcome::Uploaded {
        files_uploaded,
        files_skipped,
    })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::EVENT_SYNC_PERSONAL_SKIPPED_OWNERSHIP_MISMATCH;
    use crate::util::test_support::{scoped_home, ENV_MUTEX};
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Mutex,
    };
    use tauri::Listener;
    use tempfile::TempDir;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    // --- prepare-phase metadata fast path -----------------------------------

    /// Build a journal entry for a file on disk, optionally recording the
    /// engine-authored `mtimeMs` that unlocks the no-hash fast path.
    fn entry_for(path: &Path, hash: &str, with_mtime: bool) -> crate::util::journal::JournalEntry {
        let meta = std::fs::metadata(path).unwrap();
        crate::util::journal::JournalEntry {
            hash: hash.to_string(),
            size: meta.len(),
            synced_at: "2026-01-01T00:00:00Z".into(),
            direction: crate::util::journal::Direction::Up,
            remote_etag: None,
            mtime_ms: with_mtime.then(|| mtime_ms(&meta).unwrap()),
            extra: Default::default(),
        }
    }

    fn journal_with(
        key: &str,
        entry: crate::util::journal::JournalEntry,
    ) -> crate::util::journal::SyncJournal {
        let mut j = crate::util::journal::SyncJournal::default();
        j.files.insert(key.to_string(), entry);
        j
    }

    fn sha_of(bytes: &[u8]) -> String {
        format!("{:x}", Sha256::digest(bytes))
    }

    /// A pacer that never sleeps, so these tests measure the decision, not the
    /// pacing. Pacing arithmetic is covered in `cpu_throttle`.
    fn unpaced() -> hq_desktop_core::cpu_throttle::InProcessPacer {
        hq_desktop_core::cpu_throttle::InProcessPacer::with_duty(None)
    }

    /// REGRESSION: the "Preparing sync…" pre-pass read and SHA-256'd every
    /// syncable file on every sync. On a large HQ root that was a multi-minute
    /// single-core burn — and because it runs inside the app's own process, the
    /// CPU governor cannot throttle it (it refuses to signal its own group).
    /// The engine's own push side already skips re-hashing when size + mtimeMs
    /// match; this pre-pass, whose whole job is to predict what the engine will
    /// upload, must apply the same rule.
    #[test]
    fn an_unchanged_file_is_recognised_without_reading_its_contents() {
        let tmp = TempDir::new().unwrap();
        let file = tmp.path().join("unchanged.md");
        std::fs::write(&file, b"hello").unwrap();

        // A journal entry whose hash is deliberately WRONG. If the fast path is
        // working, the hash is never consulted, so a stale one cannot matter —
        // and if it regresses, this test fails loudly instead of silently
        // getting slower.
        let journal = journal_with("unchanged.md", entry_for(&file, "not-the-real-hash", true));

        assert!(
            !file_needs_upload(&file, "unchanged.md", &journal, &mut unpaced()),
            "matching size + mtime must settle it without hashing",
        );
    }

    #[test]
    fn a_file_whose_size_changed_is_hashed_and_flagged() {
        let tmp = TempDir::new().unwrap();
        let file = tmp.path().join("grown.md");
        std::fs::write(&file, b"hello").unwrap();
        let journal = journal_with("grown.md", entry_for(&file, &sha_of(b"hello"), true));

        std::fs::write(&file, b"hello world").unwrap();

        assert!(
            file_needs_upload(&file, "grown.md", &journal, &mut unpaced()),
            "a size change must fall through to hashing and flag the upload",
        );
    }

    /// mtime moving is only a HINT that contents changed. Touching a file
    /// without editing it must not inflate the count the progress bar uses as
    /// its denominator — so the fall-through has to actually compare hashes
    /// rather than trust the metadata mismatch.
    #[test]
    fn a_touched_but_unedited_file_is_not_counted_as_an_upload() {
        let tmp = TempDir::new().unwrap();
        let file = tmp.path().join("touched.md");
        std::fs::write(&file, b"same bytes").unwrap();
        let mut entry = entry_for(&file, &sha_of(b"same bytes"), true);
        // Journal records an mtime well in the past; contents are identical.
        entry.mtime_ms = Some(entry.mtime_ms.unwrap() - 60_000.0);
        let journal = journal_with("touched.md", entry);

        assert!(
            !file_needs_upload(&file, "touched.md", &journal, &mut unpaced()),
            "identical contents must not be counted just because mtime moved",
        );
    }

    /// Journals written before the engine recorded `mtimeMs` have no fast path
    /// available. They must keep working — by hashing, as before.
    #[test]
    fn a_journal_without_mtime_falls_back_to_hashing() {
        let tmp = TempDir::new().unwrap();
        let file = tmp.path().join("legacy.md");
        std::fs::write(&file, b"legacy").unwrap();

        let unchanged = journal_with("legacy.md", entry_for(&file, &sha_of(b"legacy"), false));
        assert!(
            !file_needs_upload(&file, "legacy.md", &unchanged, &mut unpaced()),
            "matching hash means no upload even with no mtime to shortcut on",
        );

        let changed = journal_with("legacy.md", entry_for(&file, &sha_of(b"different"), false));
        assert!(
            file_needs_upload(&file, "legacy.md", &changed, &mut unpaced()),
            "a hash mismatch must still flag the upload",
        );
    }

    #[test]
    fn a_file_the_journal_has_never_seen_always_needs_upload() {
        let tmp = TempDir::new().unwrap();
        let file = tmp.path().join("brand-new.md");
        std::fs::write(&file, b"new").unwrap();

        assert!(
            file_needs_upload(
                &file,
                "brand-new.md",
                &crate::util::journal::SyncJournal::default(),
                &mut unpaced()
            ),
            "no journal entry means it has never been synced",
        );
    }

    #[test]
    fn an_unreadable_file_errs_toward_counting_it() {
        // The runner will hit the same error and report it; the pre-pass must
        // not quietly drop the file from the denominator.
        let tmp = TempDir::new().unwrap();
        let missing = tmp.path().join("gone.md");
        let mut entry = entry_for(tmp.path(), "whatever", false);
        entry.size = 3;
        let journal = journal_with("gone.md", entry);

        assert!(
            file_needs_upload(&missing, "gone.md", &journal, &mut unpaced()),
            "a file that cannot be read must still count",
        );
    }

    #[test]
    fn steady_state_gate_closes_once_runner_journal_exists() {
        // REGRESSION: in the field the warm-up first-push ran every cycle
        // (no gate), re-uploading files the runner skips, failing with
        // "permanent upload error", and surfacing an inflated "Syncing
        // Personal … of N" count. The gate must skip the upload once the
        // runner's personal journal exists.
        let _guard = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let tmp_state = TempDir::new().unwrap();
        std::env::set_var("HQ_STATE_DIR", tmp_state.path());

        // Brand-new vault — no runner journal yet → gate OPEN (seed path runs).
        assert!(
            !engine_owns_personal_steady_state(),
            "with no runner journal the warm-up first-push must be allowed to seed",
        );

        // Runner has synced at least once → its journal exists → gate CLOSED.
        let jp = crate::util::journal::journal_path(PERSONAL_VAULT_JOURNAL_SLUG).unwrap();
        std::fs::write(&jp, "{\"files\":{},\"last_sync\":\"\"}").unwrap();
        assert!(
            engine_owns_personal_steady_state(),
            "once the runner journal exists the first-push upload must be gated off",
        );

        std::env::remove_var("HQ_STATE_DIR");
    }

    fn make_uploader(calls: Arc<Mutex<Vec<String>>>) -> UploaderFn {
        Arc::new(
            move |key: String, _data: Bytes, _sha256: String| -> BoxFuture<UploadOutcome> {
                calls.lock().unwrap().push(key);
                Box::pin(async { UploadOutcome::Ok })
            },
        )
    }

    fn make_counter_uploader(counter: Arc<AtomicUsize>) -> UploaderFn {
        Arc::new(
            move |_key: String, _data: Bytes, _sha256: String| -> BoxFuture<UploadOutcome> {
                counter.fetch_add(1, Ordering::SeqCst);
                Box::pin(async { UploadOutcome::Ok })
            },
        )
    }

    fn write_file(path: &Path, content: &[u8]) {
        if let Some(p) = path.parent() {
            std::fs::create_dir_all(p).unwrap();
        }
        std::fs::write(path, content).unwrap();
    }

    /// Realistic fixture: slug is a Cognito sub / email, NOT the same as uid.
    fn person_entity_json(
        uid: &str,
        slug: &str,
        bucket: Option<&str>,
        created_at: &str,
    ) -> serde_json::Value {
        let mut v = serde_json::json!({
            "uid": uid,
            "slug": slug,
            "type": "person",
            "status": "active",
            "createdAt": created_at,
        });
        if let Some(b) = bucket {
            v["bucketName"] = serde_json::Value::String(b.to_string());
        }
        v
    }

    fn vend_self_ok() -> serde_json::Value {
        serde_json::json!({
            "credentials": {
                "accessKeyId": "ASIA",
                "secretAccessKey": "secret",
                "sessionToken": "tok"
            },
            "expiresAt": "2026-01-01T01:00:00Z"
        })
    }

    #[tokio::test]
    async fn test_cache_miss_person_list_retries_then_recovers() {
        let server = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path("/entity/by-type/person"))
            .respond_with(ResponseTemplate::new(500).set_body_string("temporary"))
            .up_to_n_times(2)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/entity/by-type/person"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "entities": [person_entity_json("prs_x", "user@example.com", Some("hq-vault-prs-x"), "2026-01-01T00:00:00Z")]
            })))
            .mount(&server)
            .await;

        let tmp_home = TempDir::new().unwrap();
        let result = {
            let _guard = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
            let _home = scoped_home(tmp_home.path());

            let app = tauri::test::mock_app();
            let handle = app.handle().clone();
            let vault = VaultClient::new(&server.uri(), "tok");
            let r = resolve_or_provision(&handle, &vault).await;

            r
        };

        assert_eq!(
            result.unwrap(),
            Some(("prs_x".to_string(), "hq-vault-prs-x".to_string())),
            "cache-miss list should recover after transient failures"
        );

        let reqs = server.received_requests().await.unwrap();
        let list_reqs: Vec<_> = reqs
            .iter()
            .filter(|r| r.url.path() == "/entity/by-type/person")
            .collect();
        assert_eq!(
            list_reqs.len(),
            3,
            "person list should be attempted twice after transient failures"
        );
    }

    #[tokio::test]
    async fn test_cache_miss_person_list_gives_up_after_max_attempts() {
        let server = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path("/entity/by-type/person"))
            .respond_with(ResponseTemplate::new(500).set_body_string("boom"))
            .mount(&server)
            .await;

        let tmp_home = TempDir::new().unwrap();
        let result = {
            let _guard = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
            let _home = scoped_home(tmp_home.path());

            let app = tauri::test::mock_app();
            let handle = app.handle().clone();
            let vault = VaultClient::new(&server.uri(), "tok");
            let r = resolve_or_provision(&handle, &vault).await;

            r
        };

        assert_eq!(
            result.unwrap_err(),
            "list person entities: HTTP 500: boom",
            "final failure should keep the original error message shape"
        );

        let reqs = server.received_requests().await.unwrap();
        let list_reqs: Vec<_> = reqs
            .iter()
            .filter(|r| r.url.path() == "/entity/by-type/person")
            .collect();
        assert_eq!(
            list_reqs.len(),
            3,
            "person list should stop after the bounded retry budget"
        );
    }

    /// Writes a `~/.hq/cognito-tokens.json` (under the test's `HOME`) whose
    /// id_token decodes to the given `sub` + `name`, so the auto-create person
    /// path can derive a slug. With name="Test User" the derived slug is
    /// "test-user". Returns the synthetic id_token for reference.
    fn write_cognito_tokens(home: &Path, sub: &str, name: &str) -> String {
        use base64::engine::general_purpose::URL_SAFE_NO_PAD;
        use base64::Engine as _;
        let payload = serde_json::json!({ "sub": sub, "name": name }).to_string();
        let b64 = URL_SAFE_NO_PAD.encode(payload.as_bytes());
        let id_token = format!("hdr.{b64}.sig");
        let json = serde_json::json!({
            "accessToken": "atok",
            "idToken": id_token,
            "refreshToken": "rtok",
            "expiresAt": 9_999_999_999_999i64,
        });
        let dir = home.join(".hq");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("cognito-tokens.json"),
            serde_json::to_vec(&json).unwrap(),
        )
        .unwrap();
        id_token
    }

    // (a) No bucket → ensure_personal_bucket_and_first_push provisions exactly once.
    #[tokio::test]
    async fn test_no_bucket_triggers_provision() {
        let server = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path("/entity/by-type/person"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "entities": [person_entity_json("prs_x", "user@example.com", None, "2026-01-01T00:00:00Z")]
            })))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/provision/bucket"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "bucketName": "hq-vault-prs-x",
                "kmsKeyId": "key-1"
            })))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/sts/vend-self"))
            .respond_with(ResponseTemplate::new(200).set_body_json(vend_self_ok()))
            .mount(&server)
            .await;

        let tmp_state = TempDir::new().unwrap();
        let tmp_hq = TempDir::new().unwrap();
        let tmp_home = TempDir::new().unwrap();
        let upload_counter = Arc::new(AtomicUsize::new(0));

        let result = {
            let _guard = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
            std::env::set_var("HQ_STATE_DIR", tmp_state.path());
            let _home = scoped_home(tmp_home.path());

            let app = tauri::test::mock_app();
            let handle = app.handle().clone();
            let vault = VaultClient::new(&server.uri(), "tok");
            let r = ensure_impl(
                &handle,
                &vault,
                tmp_hq.path(),
                Some(make_counter_uploader(upload_counter.clone())),
            )
            .await;

            std::env::remove_var("HQ_STATE_DIR");
            r
        };

        assert!(result.is_ok(), "expected Ok, got: {:?}", result);

        let reqs = server.received_requests().await.unwrap();
        let prov: Vec<_> = reqs
            .iter()
            .filter(|r| r.url.path() == "/provision/bucket")
            .collect();
        assert_eq!(
            prov.len(),
            1,
            "provision must be called exactly once when no bucket; got {} calls",
            prov.len()
        );
        assert_eq!(
            upload_counter.load(Ordering::SeqCst),
            0,
            "no uploads from empty hq_root"
        );
    }

    // (b) Bucket already present → provision is NOT called.
    #[tokio::test]
    async fn test_with_bucket_skips_provision() {
        let server = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path("/entity/by-type/person"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "entities": [person_entity_json("prs_x", "user@example.com", Some("hq-vault-prs-x"), "2026-01-01T00:00:00Z")]
            })))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/sts/vend-self"))
            .respond_with(ResponseTemplate::new(200).set_body_json(vend_self_ok()))
            .mount(&server)
            .await;

        let tmp_state = TempDir::new().unwrap();
        let tmp_hq = TempDir::new().unwrap();
        let tmp_home = TempDir::new().unwrap();
        let upload_counter = Arc::new(AtomicUsize::new(0));

        let result = {
            let _guard = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
            std::env::set_var("HQ_STATE_DIR", tmp_state.path());
            let _home = scoped_home(tmp_home.path());

            let app = tauri::test::mock_app();
            let handle = app.handle().clone();
            let vault = VaultClient::new(&server.uri(), "tok");
            let r = ensure_impl(
                &handle,
                &vault,
                tmp_hq.path(),
                Some(make_counter_uploader(upload_counter.clone())),
            )
            .await;

            std::env::remove_var("HQ_STATE_DIR");
            r
        };

        assert!(result.is_ok(), "expected Ok, got: {:?}", result);

        let reqs = server.received_requests().await.unwrap();
        let prov: Vec<_> = reqs
            .iter()
            .filter(|r| r.url.path() == "/provision/bucket")
            .collect();
        assert_eq!(
            prov.len(),
            0,
            "provision must NOT be called when bucket_name is already set"
        );
        assert_eq!(
            upload_counter.load(Ordering::SeqCst),
            0,
            "no uploads from empty hq_root"
        );
    }

    // (c) Personal vault scope is now defined by exclusion (the inverse of
    //     the old PERSONAL_VAULT_PATHS allowlist). Everything except
    //     companies/, .git/, repos/, workspace/ is included (user directive
    //     2026-05-13: data/ + personal/ also now part of the personal vault).
    //     is included, subject to .gitignore/.hqignore.
    #[tokio::test]
    async fn test_personal_vault_path_exclusion() {
        let tmp_state = TempDir::new().unwrap();
        let tmp_hq = TempDir::new().unwrap();
        let root = tmp_hq.path();

        // Included (must be uploaded)
        write_file(&root.join("knowledge/notes.md"), b"knowledge");
        write_file(&root.join("policies/auto-deploy.md"), b"policy");
        write_file(&root.join("projects/foo/prd.json"), b"prd");
        write_file(&root.join(".claude/skills/foo/SKILL.md"), b"skill");
        write_file(&root.join("README.md"), b"root readme");
        write_file(&root.join("docs/README.md"), b"docs");
        // `modules/modules.yaml` is in DEFAULT_IGNORES (local resolution
        // state); test a different file under modules/ to validate the
        // dir itself is now included by the personal-vault rules.
        write_file(&root.join("modules/somepkg/README.md"), b"modules-content");
        write_file(&root.join("packages/foo/README.md"), b"packages");
        write_file(&root.join(".codex/state.json"), b"codex");
        // `core/` is now included (user directive 2026-05-13). Real-world
        // contents under `core/` include policies/, settings/, skills/,
        // workers/, plus the scaffold rules at core/core.yaml.
        write_file(&root.join("core/policies/auto-deploy.md"), b"core-policy");
        write_file(
            &root.join("core/core.yaml"),
            b"version: 1\nhqVersion: 15.0.7\n",
        );
        // `data/` and `personal/` are now also part of the personal vault
        // (user directive 2026-05-13). They were previously local-only.
        write_file(&root.join("data/repos.yaml"), b"data-content");
        write_file(
            &root.join("personal/policies/wait-for-ci.md"),
            b"personal-policy",
        );
        // Excluded (must be skipped)
        write_file(&root.join("companies/acme/file.md"), b"company");
        write_file(
            &root.join("person-settings/person_abc/hq-anywhere.json"),
            b"cloud-authoritative settings",
        );
        write_file(&root.join("repos/foo/README.md"), b"repos");
        write_file(&root.join("workspace/threads/T-1.md"), b"workspace");

        let calls = Arc::new(Mutex::new(vec![]));
        {
            let _guard = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
            std::env::set_var("HQ_STATE_DIR", tmp_state.path());
            let _ = run_personal_first_push(
                root,
                make_uploader(calls.clone()),
                |_, _, _| {},
                |_, _, _| {},
                |_, _| {},
            )
            .await;
            std::env::remove_var("HQ_STATE_DIR");
        }

        let captured = calls.lock().unwrap();

        // Included prefixes must appear.
        for included in [
            ".claude/",
            "knowledge/",
            "policies/",
            "projects/",
            "docs/",
            "modules/somepkg/",
            "packages/",
            ".codex/",
            "core/policies/",
            "core/core.yaml",
            "data/",
            "personal/",
            "README.md",
        ] {
            assert!(
                captured
                    .iter()
                    .any(|k| k.starts_with(included) || k.as_str() == included),
                "{included} must be uploaded; got: {captured:?}",
            );
        }
        // Excluded entries must NOT appear.
        for forbidden in ["companies/", "person-settings/", "repos/", "workspace/"] {
            assert!(
                !captured.iter().any(|k| k.starts_with(forbidden)),
                "{forbidden} must be skipped; got: {captured:?}",
            );
        }
    }

    // ── is_personal_vault_path (pure helper) ─────────────────────────────

    #[test]
    fn test_is_personal_vault_path_exclusion() {
        // Included — historically allowlisted entries still in.
        assert!(is_personal_vault_path("knowledge/foo.md"));
        assert!(is_personal_vault_path("policies/auto-deploy.md"));
        assert!(is_personal_vault_path("projects/foo/prd.json"));
        assert!(is_personal_vault_path(".claude/skills/foo/SKILL.md"));
        assert!(is_personal_vault_path(".claude/commands/x.md"));
        // Included — newly permitted under exclusion semantics.
        assert!(
            is_personal_vault_path("README.md"),
            "root files now included"
        );
        assert!(is_personal_vault_path("modules/modules.yaml"));
        assert!(is_personal_vault_path("packages/foo/README.md"));
        assert!(is_personal_vault_path("scripts/run.sh"));
        assert!(is_personal_vault_path(".codex/state.json"));
        assert!(is_personal_vault_path(".agents/runs/x.json"));
        assert!(
            is_personal_vault_path("knowledge.md"),
            "single-segment root file is a top-level itself"
        );
        // `core/` re-included 2026-05-13 — it ships the hq-core scaffold
        // (policies/, settings/, skills/, workers/, the rules manifest at
        // core/core.yaml). The hq-root `core.yaml` identity marker is
        // filtered separately downstream by the anchored `/core.yaml`
        // DEFAULT_IGNORES rule in `@indigoai-us/hq-cloud`.
        assert!(
            is_personal_vault_path("core/policies/foo.md"),
            "core/ is part of the personal vault"
        );
        assert!(
            is_personal_vault_path("core/core.yaml"),
            "core/core.yaml is the scaffold definition (synced)"
        );
        // `data/` and `personal/` are now part of the personal vault
        // (user directive 2026-05-13). Were previously excluded.
        assert!(
            is_personal_vault_path("data/db.sqlite"),
            "data/ now in personal vault"
        );
        assert!(
            is_personal_vault_path("personal/notes.md"),
            "personal/ now in personal vault"
        );
        // Excluded — top-level dir is in the exclusion list.
        assert!(
            !is_personal_vault_path("companies/acme/x.md"),
            "companies handled by per-membership fanout"
        );
        assert!(
            !is_personal_vault_path("repos/foo/README.md"),
            "repos/ have their own remotes"
        );
        assert!(
            !is_personal_vault_path("workspace/threads/T-1.md"),
            "workspace/ is local session state"
        );
        assert!(
            !is_personal_vault_path(".git/HEAD"),
            ".git/ is never synced"
        );
        // workspace/threads/handoff.json is the ONE workspace/ exception — the
        // session-continuity pointer, included despite the workspace/
        // exclusion. Mirrors hq-cloud computeContinuityPointerPaths. Sibling
        // thread files (the T-1.md above) stay excluded — only the pointer
        // gets the pure-predicate bypass; the active thread is OR-ed in at the
        // walk sites via continuity_pointer_rel_paths.
        assert!(
            is_personal_vault_path(CONTINUITY_POINTER_REL),
            "continuity pointer special-cased — included in personal vault despite workspace/ exclusion",
        );
        assert_eq!(CONTINUITY_POINTER_REL, "workspace/threads/handoff.json");
        // companies/manifest.yaml is the ONE special-case: routing
        // source-of-truth, included despite the companies/ exclusion.
        // Mirrors hq-cloud@5.39.0 computePersonalVaultPaths.
        assert!(
            is_personal_vault_path("companies/manifest.yaml"),
            "manifest.yaml special-cased — routing source-of-truth, included in personal vault",
        );
        // Anti-test: ONLY manifest.yaml gets the bypass; other companies/
        // root files stay excluded.
        assert!(
            !is_personal_vault_path("companies/README.md"),
            "only manifest.yaml is special-cased — other companies/ root files stay excluded",
        );
        assert!(
            !is_personal_vault_path("person-settings/person_abc/hq-anywhere.json"),
            "cloud-authoritative person settings stay outside first-push scope",
        );
        assert!(
            is_personal_vault_path("knowledge/person-settings/notes.md"),
            "nested user content named person-settings remains in scope",
        );
        assert!(
            !is_personal_vault_path("companies/manifest.yml"),
            "exact filename match — .yml variant stays excluded",
        );
        // Empty input still false (no top segment to evaluate).
        assert!(!is_personal_vault_path(""));
    }

    // ── continuity_pointer_rel_paths (session-continuity carve-out) ───────
    //
    // Mirrors the hq-cloud `computeContinuityPointerPaths` tests: the pointer
    // + the single active thread it references travel; nothing else under
    // workspace/ does; and a malformed/tampered pointer can never smuggle a
    // file out of workspace/threads/.
    #[test]
    fn test_continuity_pointer_rel_paths() {
        const POINTER: &str = "workspace/threads/handoff.json";

        // (a) No handoff.json at all → empty (nothing to carry).
        {
            let tmp = TempDir::new().unwrap();
            std::fs::create_dir_all(tmp.path().join("workspace/threads")).unwrap();
            assert!(continuity_pointer_rel_paths(tmp.path()).is_empty());
        }

        // (b) Pointer + a valid active thread → both, nothing else.
        {
            let tmp = TempDir::new().unwrap();
            let root = tmp.path();
            let active = "workspace/threads/T-20260617-1000-active.json";
            write_file(&root.join(active), b"{}");
            write_file(&root.join("workspace/threads/T-old-inactive.json"), b"{}");
            write_file(&root.join("workspace/threads/INDEX.md"), b"#");
            write_file(
                &root.join(POINTER),
                format!("{{\"thread_path\":\"{active}\"}}").as_bytes(),
            );
            let mut got = continuity_pointer_rel_paths(root);
            got.sort();
            assert_eq!(got, vec![active.to_string(), POINTER.to_string()]);
        }

        // (c) Pointer present, thread_path absent → only the pointer.
        {
            let tmp = TempDir::new().unwrap();
            write_file(
                &tmp.path().join(POINTER),
                b"{\"message\":\"no pointer field\"}",
            );
            assert_eq!(
                continuity_pointer_rel_paths(tmp.path()),
                vec![POINTER.to_string()]
            );
        }

        // (d) Malformed JSON → fail-soft to pointer-only (no panic).
        {
            let tmp = TempDir::new().unwrap();
            write_file(&tmp.path().join(POINTER), b"{ not json ]");
            assert_eq!(
                continuity_pointer_rel_paths(tmp.path()),
                vec![POINTER.to_string()]
            );
        }

        // (e) thread_path points at a missing file → only the pointer.
        {
            let tmp = TempDir::new().unwrap();
            write_file(
                &tmp.path().join(POINTER),
                b"{\"thread_path\":\"workspace/threads/T-ghost.json\"}",
            );
            assert_eq!(
                continuity_pointer_rel_paths(tmp.path()),
                vec![POINTER.to_string()]
            );
        }

        // (f) Absolute thread_path → rejected (only the pointer). Put a REAL
        //     file at the absolute target so only the containment guard, not a
        //     missing-file fallthrough, is what rejects it.
        {
            let tmp = TempDir::new().unwrap();
            let root = tmp.path();
            let evil = root.join("secret.txt");
            write_file(&evil, b"top secret");
            write_file(
                &root.join(POINTER),
                format!("{{\"thread_path\":\"{}\"}}", evil.display()).as_bytes(),
            );
            assert_eq!(
                continuity_pointer_rel_paths(root),
                vec![POINTER.to_string()]
            );
        }

        // (g) Traversal thread_path (../../.env) → rejected.
        {
            let tmp = TempDir::new().unwrap();
            let root = tmp.path();
            write_file(&root.join(".env"), b"SECRET=1");
            write_file(
                &root.join(POINTER),
                b"{\"thread_path\":\"workspace/threads/../../.env\"}",
            );
            let got = continuity_pointer_rel_paths(root);
            assert_eq!(got, vec![POINTER.to_string()]);
            assert!(!got.iter().any(|p| p.ends_with(".env")));
        }

        // (h) Under workspace/ but outside threads/ → rejected.
        {
            let tmp = TempDir::new().unwrap();
            let root = tmp.path();
            write_file(&root.join("workspace/reports/secret.md"), b"x");
            write_file(
                &root.join(POINTER),
                b"{\"thread_path\":\"workspace/reports/secret.md\"}",
            );
            assert_eq!(
                continuity_pointer_rel_paths(root),
                vec![POINTER.to_string()]
            );
        }

        // (i) Symlink inside threads/ whose target escapes → rejected by the
        //     realpath re-check. (Unix-only; skipped where symlinks are not
        //     supported.)
        #[cfg(unix)]
        {
            let tmp = TempDir::new().unwrap();
            let root = tmp.path();
            write_file(&root.join("outside.txt"), b"secret");
            std::fs::create_dir_all(root.join("workspace/threads")).unwrap();
            std::os::unix::fs::symlink(
                root.join("outside.txt"),
                root.join("workspace/threads/escape.json"),
            )
            .unwrap();
            write_file(
                &root.join(POINTER),
                b"{\"thread_path\":\"workspace/threads/escape.json\"}",
            );
            assert_eq!(
                continuity_pointer_rel_paths(root),
                vec![POINTER.to_string()]
            );
        }
    }

    // End-to-end through the real personal first-push walk: the pointer + its
    // active thread upload; an inactive sibling thread and unrelated workspace
    // litter stay machine-local. This is the parity counterpart to the hq-cloud
    // `computePersonalVaultPaths` carve-out test.
    #[tokio::test]
    async fn test_continuity_pointer_carve_out_uploads_pointer_and_active_thread() {
        let tmp_state = TempDir::new().unwrap();
        let tmp_hq = TempDir::new().unwrap();
        let root = tmp_hq.path();

        // A normal included file so the walk has non-continuity content too.
        write_file(&root.join("knowledge/notes.md"), b"knowledge");
        // The continuity pointer + its active thread (must travel).
        let active = "workspace/threads/T-20260617-1000-active.json";
        write_file(&root.join(active), b"{\"task\":\"active\"}");
        write_file(
            &root.join("workspace/threads/handoff.json"),
            format!("{{\"thread_path\":\"{active}\"}}").as_bytes(),
        );
        // Must NOT travel: an inactive thread, the threads INDEX, and a lock.
        write_file(&root.join("workspace/threads/T-old-inactive.json"), b"{}");
        write_file(&root.join("workspace/threads/INDEX.md"), b"# threads");
        write_file(&root.join("workspace/locks/x.lock"), b"1");

        let calls = Arc::new(Mutex::new(vec![]));
        {
            let _guard = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
            std::env::set_var("HQ_STATE_DIR", tmp_state.path());
            let _ = run_personal_first_push(
                root,
                make_uploader(calls.clone()),
                |_, _, _| {},
                |_, _, _| {},
                |_, _| {},
            )
            .await;
            std::env::remove_var("HQ_STATE_DIR");
        }

        let captured = calls.lock().unwrap();
        assert!(
            captured
                .iter()
                .any(|k| k == "workspace/threads/handoff.json"),
            "continuity pointer must upload; got: {captured:?}",
        );
        assert!(
            captured.iter().any(|k| k == active),
            "active thread file must upload; got: {captured:?}",
        );
        assert!(
            captured.iter().any(|k| k == "knowledge/notes.md"),
            "ordinary personal-vault content still uploads; got: {captured:?}",
        );
        // The carve-out must NOT broaden the rest of workspace/.
        assert!(
            !captured
                .iter()
                .any(|k| k == "workspace/threads/T-old-inactive.json"),
            "inactive thread must stay machine-local; got: {captured:?}",
        );
        assert!(
            !captured.iter().any(|k| k == "workspace/threads/INDEX.md"),
            "threads INDEX must stay machine-local; got: {captured:?}",
        );
        assert!(
            !captured.iter().any(|k| k.starts_with("workspace/locks/")),
            "workspace/locks must stay machine-local; got: {captured:?}",
        );
    }

    // Regression: upload-phase progress totals must reflect the CHANGED-file
    // plan, not the walk total. Pre-fix, on_progress fired once per file
    // EXAMINED with total = every personal-vault file, so a re-run that only
    // needed to move 1 of 2,877 files showed "x of 2,877 files" in the
    // popover. The walker now scans first (on_scan, walk totals) and emits
    // on_progress only for files in the upload plan, with the plan size as
    // the denominator.
    #[tokio::test]
    async fn test_progress_total_is_changed_count_not_walk_count() {
        let tmp_state = TempDir::new().unwrap();
        let tmp_hq = TempDir::new().unwrap();
        let root = tmp_hq.path();

        write_file(&root.join("knowledge/a.md"), b"alpha");
        write_file(&root.join("knowledge/b.md"), b"bravo");
        write_file(&root.join("knowledge/c.md"), b"charlie");

        {
            let _guard = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
            std::env::set_var("HQ_STATE_DIR", tmp_state.path());

            // First run: all 3 are new → plan total 3.
            let progress1: Arc<Mutex<Vec<(usize, usize, Option<String>)>>> =
                Arc::new(Mutex::new(vec![]));
            let p1 = progress1.clone();
            run_personal_first_push(
                root,
                make_uploader(Arc::new(Mutex::new(vec![]))),
                |_, _, _| {},
                move |done, total, file| p1.lock().unwrap().push((done, total, file)),
                |_, _| {},
            )
            .await
            .unwrap();
            assert!(
                progress1
                    .lock()
                    .unwrap()
                    .iter()
                    .all(|(_, total, _)| *total == 3),
                "first run: every progress event must carry plan total 3; got {:?}",
                progress1.lock().unwrap(),
            );

            // Touch ONE file. Re-run: walk still sees 3 files, but the plan
            // is 1 — progress must say "of 1", never "of 3".
            write_file(&root.join("knowledge/b.md"), b"bravo-changed");
            let scans: Arc<Mutex<Vec<(usize, usize)>>> = Arc::new(Mutex::new(vec![]));
            let s2 = scans.clone();
            let progress2: Arc<Mutex<Vec<(usize, usize, Option<String>)>>> =
                Arc::new(Mutex::new(vec![]));
            let p2 = progress2.clone();
            let (uploaded, _) = run_personal_first_push(
                root,
                make_uploader(Arc::new(Mutex::new(vec![]))),
                move |done, total, _| s2.lock().unwrap().push((done, total)),
                move |done, total, file| p2.lock().unwrap().push((done, total, file)),
                |_, _| {},
            )
            .await
            .unwrap();

            std::env::remove_var("HQ_STATE_DIR");

            assert_eq!(uploaded, 1, "only the touched file uploads");
            let prog = progress2.lock().unwrap();
            assert!(
                prog.iter().all(|(_, total, _)| *total == 1),
                "progress denominator must be the changed count (1), not the walk count (3); got {prog:?}",
            );
            assert!(
                prog.iter()
                    .filter_map(|(_, _, f)| f.as_deref())
                    .all(|f| f == "knowledge/b.md"),
                "progress must only fire for planned uploads; got {prog:?}",
            );
            // Scan liveness still reports walk totals (3) — separate channel.
            assert!(
                scans.lock().unwrap().iter().all(|(_, total)| *total == 3),
                "scan events carry the walk total; got {:?}",
                scans.lock().unwrap(),
            );
        }
    }

    // Regression (HQ-SYNC-WEB-1A): a file that vanishes between the walk and
    // the upload read (temp file, editor swap, concurrent delete) must be
    // SKIPPED, not abort the whole first push. Pre-fix, the read error set
    // upload_err and returned Err, so one transient file killed the entire push.
    #[tokio::test]
    async fn test_vanished_file_is_skipped_not_fatal() {
        let tmp_state = TempDir::new().unwrap();
        let tmp_hq = TempDir::new().unwrap();
        let root = tmp_hq.path();

        write_file(&root.join("knowledge/stays.md"), b"i remain");
        write_file(&root.join("knowledge/vanishes.md"), b"delete me mid-push");

        {
            let _guard = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
            std::env::set_var("HQ_STATE_DIR", tmp_state.path());

            let uploaded_keys: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(vec![]));
            let skips: Arc<Mutex<Vec<(String, String)>>> = Arc::new(Mutex::new(vec![]));
            let skips_c = skips.clone();

            // Delete the target the instant the upload phase reaches it (on_progress
            // fires just before each planned file's read) so its read hits
            // ErrorKind::NotFound — a deterministic stand-in for the real race.
            let vanish_abs = root.join("knowledge/vanishes.md");
            let result = run_personal_first_push(
                root,
                make_uploader(uploaded_keys.clone()),
                |_, _, _| {},
                move |_, _, file| {
                    if file.as_deref() == Some("knowledge/vanishes.md") {
                        let _ = std::fs::remove_file(&vanish_abs);
                    }
                },
                move |key, reason| skips_c.lock().unwrap().push((key, reason)),
            )
            .await;

            std::env::remove_var("HQ_STATE_DIR");

            // The push completes instead of aborting on the vanished file.
            let (uploaded, _skipped) = result.expect("a vanished file must not fail the push");
            assert_eq!(uploaded, 1, "the surviving file must still upload");
            let up = uploaded_keys.lock().unwrap();
            assert!(
                up.iter().any(|k| k == "knowledge/stays.md"),
                "surviving file must be uploaded; got {up:?}"
            );
            let sk = skips.lock().unwrap();
            assert!(
                sk.iter()
                    .any(|(k, r)| k == "knowledge/vanishes.md" && r == "file vanished before read"),
                "vanished file must be skipped with the vanished reason; got {sk:?}"
            );
        }
    }

    // (d) Re-run with journal populated → zero PutObject calls.
    //     Uses an allowlisted path (knowledge/) — pre-allowlist this test
    //     used a root-level notes.md which is now excluded by design.
    #[tokio::test]
    async fn test_rerun_no_op_via_journal() {
        let tmp_state = TempDir::new().unwrap();
        let tmp_hq = TempDir::new().unwrap();
        let root = tmp_hq.path();

        write_file(&root.join("knowledge/notes.md"), b"stable content");

        {
            let _guard = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
            std::env::set_var("HQ_STATE_DIR", tmp_state.path());

            let calls1 = Arc::new(Mutex::new(vec![]));
            run_personal_first_push(
                root,
                make_uploader(calls1.clone()),
                |_, _, _| {},
                |_, _, _| {},
                |_, _| {},
            )
            .await
            .unwrap();
            assert_eq!(calls1.lock().unwrap().len(), 1);

            let calls2 = Arc::new(Mutex::new(vec![]));
            let (uploaded, _) = run_personal_first_push(
                root,
                make_uploader(calls2.clone()),
                |_, _, _| {},
                |_, _, _| {},
                |_, _| {},
            )
            .await
            .unwrap();

            std::env::remove_var("HQ_STATE_DIR");

            assert_eq!(uploaded, 0, "second run must upload nothing");
            assert!(
                calls2.lock().unwrap().is_empty(),
                "no PutObject calls on re-run"
            );
        }
    }

    // (f) Regression — personal-vault rollback (2026-06-10). The push MUST judge
    //     currency against the runner's `__hq_personal_vault__` journal, NOT the
    //     legacy `"personal"` journal. A file already recorded as synced by the
    //     runner must be SKIPPED even when a stale legacy `"personal"` journal
    //     disagrees — otherwise the Rust path re-uploads the local (possibly
    //     older) copy over a newer cloud object, regressing the vault. Pre-fix
    //     this read the empty legacy journal and uploaded; post-fix it reads the
    //     runner journal and skips.
    #[tokio::test]
    async fn test_personal_push_uses_runner_journal_slug_not_legacy() {
        use crate::util::journal::SyncJournal;
        let tmp_state = TempDir::new().unwrap();
        let tmp_hq = TempDir::new().unwrap();
        let root = tmp_hq.path();

        let rel = "knowledge/notes.md";
        let content = b"already synced by the runner";
        write_file(&root.join(rel), content);
        let hash = format!("{:x}", Sha256::digest(content));

        {
            let _guard = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
            std::env::set_var("HQ_STATE_DIR", tmp_state.path());

            // Runner's journal (`__hq_personal_vault__`): file already synced,
            // hash matches what's on disk → should be skipped.
            let mut runner = SyncJournal::default();
            runner.files.insert(
                rel.to_string(),
                JournalEntry {
                    hash: hash.clone(),
                    size: content.len() as u64,
                    synced_at: "2026-06-10T18:00:00Z".into(),
                    direction: Direction::Down,
                    remote_etag: None,
                    mtime_ms: None,
                    extra: Default::default(),
                },
            );
            write_journal(PERSONAL_VAULT_JOURNAL_SLUG, &runner).unwrap();

            // Stale legacy `"personal"` journal — empty. The PRE-FIX code read
            // THIS and would re-upload the file; present here to prove the slug
            // choice is exactly what decides skip-vs-reupload.
            write_journal("personal", &SyncJournal::default()).unwrap();

            let calls = Arc::new(Mutex::new(vec![]));
            let (uploaded, _) = run_personal_first_push(
                root,
                make_uploader(calls.clone()),
                |_, _, _| {},
                |_, _, _| {},
                |_, _| {},
            )
            .await
            .unwrap();

            std::env::remove_var("HQ_STATE_DIR");

            assert_eq!(
                uploaded, 0,
                "file already in the runner journal must be skipped, not re-uploaded over a possibly-newer cloud object",
            );
            assert!(
                calls.lock().unwrap().is_empty(),
                "no PutObject when the runner journal says synced (no stale re-push)",
            );
        }
    }

    // (e) Multi-person → canonical pick is oldest created_at, regardless of list order.
    // Runs twice (reversed list order on second run); both vend_self calls must use prs_x.
    #[tokio::test]
    async fn test_multi_person_canonical_pick() {
        let server = MockServer::start().await;

        // Run 1 fallback and Run 2 response: [prs_x (oldest), prs_y (newer)]
        Mock::given(method("GET"))
            .and(path("/entity/by-type/person"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "entities": [
                    person_entity_json("prs_x", "oldest@example.com", Some("hq-vault-prs-x"), "2026-01-01T00:00:00Z"),
                    person_entity_json("prs_y", "newer@example.com",  Some("hq-vault-prs-y"), "2026-02-01T00:00:00Z"),
                ]
            })))
            .mount(&server)
            .await;

        // Run 1 response (higher priority, expires after 1 use): [prs_y, prs_x] — prs_y listed first
        Mock::given(method("GET"))
            .and(path("/entity/by-type/person"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "entities": [
                    person_entity_json("prs_y", "newer@example.com",  Some("hq-vault-prs-y"), "2026-02-01T00:00:00Z"),
                    person_entity_json("prs_x", "oldest@example.com", Some("hq-vault-prs-x"), "2026-01-01T00:00:00Z"),
                ]
            })))
            .up_to_n_times(1)
            .mount(&server)
            .await;

        Mock::given(method("POST"))
            .and(path("/sts/vend-self"))
            .respond_with(ResponseTemplate::new(200).set_body_json(vend_self_ok()))
            .mount(&server)
            .await;

        let tmp_state = TempDir::new().unwrap();
        let tmp_hq = TempDir::new().unwrap();
        let tmp_home = TempDir::new().unwrap();

        {
            let _guard = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
            std::env::set_var("HQ_STATE_DIR", tmp_state.path());
            let _home = scoped_home(tmp_home.path());

            let app = tauri::test::mock_app();
            let handle = app.handle().clone();
            let vault = VaultClient::new(&server.uri(), "tok");

            // Run 1: list = [prs_y, prs_x] → canonical sort picks prs_x (oldest)
            ensure_impl(
                &handle,
                &vault,
                tmp_hq.path(),
                Some(make_counter_uploader(Arc::new(AtomicUsize::new(0)))),
            )
            .await
            .unwrap();
            // Delete cache so Run 2 re-lists (reversed order)
            delete_cache();
            // Remove the runner journal Run 1 wrote so Run 2 takes the seed
            // path again — otherwise the steady-state gate skips Run 2's
            // vend_self entirely. This test exercises canonical person pick
            // across re-lists, not the gate (see
            // steady_state_gate_closes_once_runner_journal_exists).
            let _ = std::fs::remove_file(
                crate::util::journal::journal_path(PERSONAL_VAULT_JOURNAL_SLUG).unwrap(),
            );
            // Run 2: list = [prs_x, prs_y] → canonical sort still picks prs_x
            ensure_impl(
                &handle,
                &vault,
                tmp_hq.path(),
                Some(make_counter_uploader(Arc::new(AtomicUsize::new(0)))),
            )
            .await
            .unwrap();

            std::env::remove_var("HQ_STATE_DIR");
        }

        let reqs = server.received_requests().await.unwrap();
        let vend_self_reqs: Vec<_> = reqs
            .iter()
            .filter(|r| r.url.path() == "/sts/vend-self")
            .collect();
        assert_eq!(
            vend_self_reqs.len(),
            2,
            "vend_self must be called twice (once per run)"
        );

        for req in &vend_self_reqs {
            let body: serde_json::Value = serde_json::from_slice(&req.body).unwrap_or_default();
            assert_eq!(
                body["personUid"],
                serde_json::json!("prs_x"),
                "canonical pick must always be prs_x (oldest); vend_self body: {body}"
            );
        }
    }

    // (f) vend_self routing: zero hits on /sts/vend-child, ≥1 on /sts/vend-self.
    #[tokio::test]
    async fn test_vend_self_routing_zero_vend_child_hits() {
        let server = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path("/entity/by-type/person"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "entities": [person_entity_json("prs_x", "user@example.com", Some("hq-vault-prs-x"), "2026-01-01T00:00:00Z")]
            })))
            .mount(&server)
            .await;
        // vend-child mock records calls (should get zero)
        Mock::given(method("POST"))
            .and(path("/sts/vend-child"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/sts/vend-self"))
            .respond_with(ResponseTemplate::new(200).set_body_json(vend_self_ok()))
            .mount(&server)
            .await;

        let tmp_state = TempDir::new().unwrap();
        let tmp_hq = TempDir::new().unwrap();
        let tmp_home = TempDir::new().unwrap();

        {
            let _guard = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
            std::env::set_var("HQ_STATE_DIR", tmp_state.path());
            let _home = scoped_home(tmp_home.path());

            let app = tauri::test::mock_app();
            let handle = app.handle().clone();
            let vault = VaultClient::new(&server.uri(), "tok");
            ensure_impl(
                &handle,
                &vault,
                tmp_hq.path(),
                Some(make_counter_uploader(Arc::new(AtomicUsize::new(0)))),
            )
            .await
            .unwrap();

            std::env::remove_var("HQ_STATE_DIR");
        }

        let reqs = server.received_requests().await.unwrap();
        let vend_child: Vec<_> = reqs
            .iter()
            .filter(|r| r.url.path() == "/sts/vend-child")
            .collect();
        let vend_self: Vec<_> = reqs
            .iter()
            .filter(|r| r.url.path() == "/sts/vend-self")
            .collect();

        assert_eq!(
            vend_child.len(),
            0,
            "vend_child must NOT be called from personal flow"
        );
        assert!(
            vend_self.len() >= 1,
            "vend_self must be called at least once"
        );
    }

    // (g) SELF_OWNERSHIP_MISMATCH → returns Err, emits event, zero upload calls.
    #[tokio::test]
    async fn test_self_ownership_mismatch_surfaces_as_err() {
        let server = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path("/entity/by-type/person"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "entities": [person_entity_json("prs_x", "user@example.com", Some("hq-vault-prs-x"), "2026-01-01T00:00:00Z")]
            })))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/sts/vend-self"))
            .respond_with(ResponseTemplate::new(403).set_body_json(serde_json::json!({
                "error": "ownership mismatch",
                "code": "SELF_OWNERSHIP_MISMATCH"
            })))
            .mount(&server)
            .await;

        let tmp_state = TempDir::new().unwrap();
        let tmp_hq = TempDir::new().unwrap();
        let tmp_home = TempDir::new().unwrap();
        let upload_counter = Arc::new(AtomicUsize::new(0));

        let mismatch_events: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(vec![]));
        let mismatch_events_clone = mismatch_events.clone();

        let result = {
            let _guard = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
            std::env::set_var("HQ_STATE_DIR", tmp_state.path());
            let _home = scoped_home(tmp_home.path());

            let app = tauri::test::mock_app();
            let handle = app.handle().clone();
            // Register event listener BEFORE invoking the function
            app.listen(EVENT_SYNC_PERSONAL_SKIPPED_OWNERSHIP_MISMATCH, move |e| {
                mismatch_events_clone
                    .lock()
                    .unwrap()
                    .push(e.payload().to_string());
            });
            let vault = VaultClient::new(&server.uri(), "tok");
            let r = ensure_impl(
                &handle,
                &vault,
                tmp_hq.path(),
                Some(make_counter_uploader(upload_counter.clone())),
            )
            .await;

            std::env::remove_var("HQ_STATE_DIR");
            r
        };

        // 1. Function returns Err
        assert!(result.is_err(), "expected Err from SELF_OWNERSHIP_MISMATCH");
        let err_msg = result.unwrap_err();
        assert!(
            err_msg.contains("SELF_OWNERSHIP_MISMATCH"),
            "error must mention SELF_OWNERSHIP_MISMATCH; got: {err_msg}"
        );

        // 2. sync:personal-skipped-ownership-mismatch event was emitted
        let evs = mismatch_events.lock().unwrap();
        assert_eq!(
            evs.len(),
            1,
            "mismatch event must be emitted exactly once; got: {:?}",
            *evs
        );

        // 3. Zero uploader calls (function aborted before reaching run_personal_first_push)
        assert_eq!(
            upload_counter.load(Ordering::SeqCst),
            0,
            "no uploads must happen after ownership mismatch"
        );
    }

    // (h) Regression (feedback_dd73b772 / feedback_b5bd30ee): the person entity
    //     is already provisioned, but the list comes back empty this cycle, so
    //     resolve_or_provision reaches create → server returns 409. The fix
    //     recovers the existing entity by slug and resolves normally — the
    //     benign already-exists must NOT surface as a "personal first-push
    //     failed" error every sync.
    #[tokio::test]
    async fn test_create_409_recovered_by_slug_is_not_an_error() {
        let server = MockServer::start().await;

        // list returns empty → forces the create path
        Mock::given(method("GET"))
            .and(path("/entity/by-type/person"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({ "entities": [] })),
            )
            .mount(&server)
            .await;
        // create → 409 (already exists)
        Mock::given(method("POST"))
            .and(path("/entity"))
            .respond_with(
                ResponseTemplate::new(409)
                    .set_body_json(serde_json::json!({ "error": "already exists" })),
            )
            .mount(&server)
            .await;
        // recovery by slug returns the existing entity (bucket present → no provision)
        Mock::given(method("GET"))
            .and(path("/entity/by-slug/person/test-user"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "entity": person_entity_json("prs_existing", "test-user", Some("hq-vault-prs-existing"), "2026-01-01T00:00:00Z")
            })))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/sts/vend-self"))
            .respond_with(ResponseTemplate::new(200).set_body_json(vend_self_ok()))
            .mount(&server)
            .await;

        let tmp_state = TempDir::new().unwrap();
        let tmp_hq = TempDir::new().unwrap();
        let tmp_home = TempDir::new().unwrap();
        let upload_counter = Arc::new(AtomicUsize::new(0));

        let result = {
            let _guard = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
            std::env::set_var("HQ_STATE_DIR", tmp_state.path());
            let _home = scoped_home(tmp_home.path());
            write_cognito_tokens(tmp_home.path(), "sub-123", "Test User");

            let app = tauri::test::mock_app();
            let handle = app.handle().clone();
            let vault = VaultClient::new(&server.uri(), "tok");
            let r = ensure_impl(
                &handle,
                &vault,
                tmp_hq.path(),
                Some(make_counter_uploader(upload_counter.clone())),
            )
            .await;

            std::env::remove_var("HQ_STATE_DIR");
            r
        };

        assert!(
            result.is_ok(),
            "benign 409 (recovered by slug) must NOT surface as an error; got: {:?}",
            result
        );

        // vend_self ran against the recovered entity → first-push proceeded.
        let reqs = server.received_requests().await.unwrap();
        let vend: Vec<_> = reqs
            .iter()
            .filter(|r| r.url.path() == "/sts/vend-self")
            .collect();
        assert_eq!(
            vend.len(),
            1,
            "vend_self must run once against the recovered entity"
        );
    }

    // (i) Person exists (409) but is not resolvable by slug → benign skip:
    //     ensure_impl returns Ok(()), emits a personal-first-push-skipped
    //     diagnostic event, performs zero uploads, and never reaches vend_self.
    #[tokio::test]
    async fn test_create_409_unresolvable_skips_quietly() {
        let server = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path("/entity/by-type/person"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({ "entities": [] })),
            )
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/entity"))
            .respond_with(
                ResponseTemplate::new(409)
                    .set_body_json(serde_json::json!({ "error": "already exists" })),
            )
            .mount(&server)
            .await;
        // recovery by slug 404s → unresolvable
        Mock::given(method("GET"))
            .and(path("/entity/by-slug/person/test-user"))
            .respond_with(
                ResponseTemplate::new(404)
                    .set_body_json(serde_json::json!({ "error": "not found" })),
            )
            .mount(&server)
            .await;

        let tmp_state = TempDir::new().unwrap();
        let tmp_hq = TempDir::new().unwrap();
        let tmp_home = TempDir::new().unwrap();
        let upload_counter = Arc::new(AtomicUsize::new(0));
        let skip_events: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(vec![]));
        let skip_events_clone = skip_events.clone();

        let result = {
            let _guard = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
            std::env::set_var("HQ_STATE_DIR", tmp_state.path());
            let _home = scoped_home(tmp_home.path());
            write_cognito_tokens(tmp_home.path(), "sub-123", "Test User");

            let app = tauri::test::mock_app();
            let handle = app.handle().clone();
            app.listen(EVENT_SYNC_PERSONAL_FIRST_PUSH_SKIPPED, move |e| {
                skip_events_clone
                    .lock()
                    .unwrap()
                    .push(e.payload().to_string());
            });
            let vault = VaultClient::new(&server.uri(), "tok");
            let r = ensure_impl(
                &handle,
                &vault,
                tmp_hq.path(),
                Some(make_counter_uploader(upload_counter.clone())),
            )
            .await;

            std::env::remove_var("HQ_STATE_DIR");
            r
        };

        assert!(
            result.is_ok(),
            "unresolvable benign 409 must NOT surface as an error; got: {:?}",
            result
        );
        assert_eq!(
            upload_counter.load(Ordering::SeqCst),
            0,
            "no uploads when personal first-push is skipped"
        );
        let evs = skip_events.lock().unwrap();
        assert!(
            evs.iter()
                .any(|p| p.contains("person-entity-already-exists")),
            "a personal-first-push-skipped event with the benign reason must be emitted; got: {:?}",
            *evs
        );
        let reqs = server.received_requests().await.unwrap();
        let vend: Vec<_> = reqs
            .iter()
            .filter(|r| r.url.path() == "/sts/vend-self")
            .collect();
        assert_eq!(vend.len(), 0, "vend_self must not run on the skip path");
    }

    // (j) A REAL create failure (5xx) is NOT a benign 409 — it must still
    //     surface loudly as an Err so genuine first-push breakage is reported.
    #[tokio::test]
    async fn test_create_5xx_still_surfaces_as_err() {
        let server = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path("/entity/by-type/person"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({ "entities": [] })),
            )
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/entity"))
            .respond_with(
                ResponseTemplate::new(500).set_body_json(serde_json::json!({ "error": "boom" })),
            )
            .mount(&server)
            .await;

        let tmp_state = TempDir::new().unwrap();
        let tmp_hq = TempDir::new().unwrap();
        let tmp_home = TempDir::new().unwrap();
        let upload_counter = Arc::new(AtomicUsize::new(0));

        let result = {
            let _guard = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
            std::env::set_var("HQ_STATE_DIR", tmp_state.path());
            let _home = scoped_home(tmp_home.path());
            write_cognito_tokens(tmp_home.path(), "sub-123", "Test User");

            let app = tauri::test::mock_app();
            let handle = app.handle().clone();
            let vault = VaultClient::new(&server.uri(), "tok");
            let r = ensure_impl(
                &handle,
                &vault,
                tmp_hq.path(),
                Some(make_counter_uploader(upload_counter.clone())),
            )
            .await;

            std::env::remove_var("HQ_STATE_DIR");
            r
        };

        assert!(
            result.is_err(),
            "a 5xx create failure must surface as Err (loud), not be swallowed"
        );
        let msg = result.unwrap_err();
        assert!(
            msg.contains("create person entity"),
            "error should identify the create failure; got: {msg}"
        );
        assert_eq!(
            upload_counter.load(Ordering::SeqCst),
            0,
            "no uploads on a hard create failure"
        );
    }

    // Additional: journal path for "personal" slug is correct.
    #[test]
    fn test_personal_journal_path() {
        use crate::util::journal::journal_path;
        let _guard = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = TempDir::new().unwrap();
        std::env::set_var("HQ_STATE_DIR", tmp.path());
        let p = journal_path("personal").unwrap();
        std::env::remove_var("HQ_STATE_DIR");
        assert!(
            p.to_string_lossy().ends_with("sync-journal.personal.json"),
            "got: {}",
            p.display()
        );
    }

    // ── Install-stage handoff + concurrent first-push ─────────────────────

    use crate::commands::daemon::WatchDaemonState;
    use std::time::Duration;

    fn daemon_snapshot(lifecycle: WatchDaemonState) -> DaemonHandoffSnapshot {
        DaemonHandoffSnapshot {
            lifecycle,
            auto_sync_enabled: true,
            personal_sync_enabled: true,
            spawn_allowed: true,
            signed_in: true,
        }
    }

    fn fixed_probe(snapshot: DaemonHandoffSnapshot) -> DaemonHandoffProbe {
        DaemonHandoffProbe::scripted(
            Arc::new(move || snapshot),
            Duration::from_millis(50),
            Duration::from_millis(1),
        )
    }

    /// Returns each snapshot in turn, then repeats the last one.
    fn sequence_probe(
        seq: Vec<DaemonHandoffSnapshot>,
        starting_wait: Duration,
    ) -> DaemonHandoffProbe {
        let idx = Arc::new(AtomicUsize::new(0));
        DaemonHandoffProbe::scripted(
            Arc::new(move || {
                let i = idx.fetch_add(1, Ordering::SeqCst);
                seq[i.min(seq.len() - 1)]
            }),
            starting_wait,
            Duration::from_millis(1),
        )
    }

    /// Uploader that records the peak number of uploads in flight.
    fn make_tracking_uploader(
        in_flight: Arc<AtomicUsize>,
        peak: Arc<AtomicUsize>,
        calls: Arc<Mutex<Vec<String>>>,
    ) -> UploaderFn {
        Arc::new(
            move |key: String, _data: Bytes, _sha256: String| -> BoxFuture<UploadOutcome> {
                let in_flight = in_flight.clone();
                let peak = peak.clone();
                let calls = calls.clone();
                Box::pin(async move {
                    let now = in_flight.fetch_add(1, Ordering::SeqCst) + 1;
                    peak.fetch_max(now, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(5)).await;
                    in_flight.fetch_sub(1, Ordering::SeqCst);
                    calls.lock().unwrap().push(key);
                    UploadOutcome::Ok
                })
            },
        )
    }

    async fn mount_vault_with_bucket(server: &MockServer) {
        Mock::given(method("GET"))
            .and(path("/entity/by-type/person"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "entities": [person_entity_json("prs_x", "user@example.com", Some("hq-vault-prs-x"), "2026-01-01T00:00:00Z")]
            })))
            .mount(server)
            .await;
        Mock::given(method("POST"))
            .and(path("/sts/vend-self"))
            .respond_with(ResponseTemplate::new(200).set_body_json(vend_self_ok()))
            .mount(server)
            .await;
    }

    fn seed_vault_files(root: &Path, n: usize) {
        for i in 0..n {
            write_file(
                &root.join(format!("core/skills/s{i}.md")),
                format!("core file {i}").as_bytes(),
            );
        }
        write_file(&root.join("knowledge/notes.md"), b"notes");
    }

    #[test]
    fn handoff_decision_requires_every_condition_and_a_running_daemon() {
        use DaemonHandoffDecision::*;
        let running = daemon_snapshot(WatchDaemonState::Running);
        assert_eq!(daemon_handoff_decision(&running), Confirmed);
        assert_eq!(
            daemon_handoff_decision(&daemon_snapshot(WatchDaemonState::Starting)),
            Pending
        );
        assert_eq!(
            daemon_handoff_decision(&daemon_snapshot(WatchDaemonState::Backoff)),
            Refused
        );
        assert_eq!(
            daemon_handoff_decision(&daemon_snapshot(WatchDaemonState::Stopped)),
            Refused
        );
        for lifecycle in [WatchDaemonState::Running, WatchDaemonState::Starting] {
            let base = daemon_snapshot(lifecycle);
            for off in [
                DaemonHandoffSnapshot { auto_sync_enabled: false, ..base },
                DaemonHandoffSnapshot { personal_sync_enabled: false, ..base },
                DaemonHandoffSnapshot { spawn_allowed: false, ..base },
                DaemonHandoffSnapshot { signed_in: false, ..base },
            ] {
                assert_eq!(
                    daemon_handoff_decision(&off),
                    Refused,
                    "any missing condition must refuse the handoff: {off:?}"
                );
            }
        }
    }

    #[tokio::test]
    async fn probe_waits_for_a_starting_daemon_to_reach_running() {
        let probe = sequence_probe(
            vec![
                daemon_snapshot(WatchDaemonState::Starting),
                daemon_snapshot(WatchDaemonState::Starting),
                daemon_snapshot(WatchDaemonState::Running),
            ],
            Duration::from_secs(5),
        );
        assert!(probe.daemon_owns_personal_upload().await);
    }

    #[tokio::test]
    async fn probe_refuses_a_daemon_that_never_finishes_starting() {
        let probe = sequence_probe(
            vec![daemon_snapshot(WatchDaemonState::Starting)],
            Duration::from_millis(20),
        );
        assert!(!probe.daemon_owns_personal_upload().await);
    }

    #[tokio::test]
    async fn probe_refuses_a_daemon_whose_start_fails() {
        let probe = sequence_probe(
            vec![
                daemon_snapshot(WatchDaemonState::Starting),
                daemon_snapshot(WatchDaemonState::Backoff),
            ],
            Duration::from_secs(5),
        );
        assert!(!probe.daemon_owns_personal_upload().await);
    }

    // REGRESSION (install initial-sync took ~2 of ~2.5 minutes): with the
    // sync daemon running, the install stage must provision and return
    // without walking or uploading the personal vault.
    #[tokio::test]
    async fn install_handoff_with_running_daemon_does_not_walk_or_upload() {
        let server = MockServer::start().await;
        mount_vault_with_bucket(&server).await;

        let tmp_state = TempDir::new().unwrap();
        let tmp_hq = TempDir::new().unwrap();
        let tmp_home = TempDir::new().unwrap();
        seed_vault_files(tmp_hq.path(), 30);
        let upload_counter = Arc::new(AtomicUsize::new(0));
        let completes: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(vec![]));
        let scans = Arc::new(AtomicUsize::new(0));

        let (result, journal_written) = {
            let _guard = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
            std::env::set_var("HQ_STATE_DIR", tmp_state.path());
            let _home = scoped_home(tmp_home.path());

            let app = tauri::test::mock_app();
            let handle = app.handle().clone();
            let c = completes.clone();
            app.listen(EVENT_SYNC_PERSONAL_FIRST_PUSH_COMPLETE, move |e| {
                c.lock().unwrap().push(e.payload().to_string());
            });
            let sc = scans.clone();
            app.listen(EVENT_SYNC_PERSONAL_FIRST_PUSH_SCAN, move |_| {
                sc.fetch_add(1, Ordering::SeqCst);
            });
            let vault = VaultClient::new(&server.uri(), "tok");
            let r = ensure_impl_with(
                &handle,
                &vault,
                tmp_hq.path(),
                Some(make_counter_uploader(upload_counter.clone())),
                &FirstPushMode::InstallHandoff(fixed_probe(daemon_snapshot(
                    WatchDaemonState::Running,
                ))),
            )
            .await;
            let written = engine_owns_personal_steady_state();
            std::env::remove_var("HQ_STATE_DIR");
            (r, written)
        };

        assert_eq!(result, Ok(PersonalFirstPushOutcome::HandedToSyncDaemon));
        assert_eq!(upload_counter.load(Ordering::SeqCst), 0, "no uploads");
        assert_eq!(scans.load(Ordering::SeqCst), 0, "no walk");
        assert!(
            !journal_written,
            "the handoff must not create the runner's personal journal"
        );
        let reqs = server.received_requests().await.unwrap();
        assert!(
            !reqs.iter().any(|r| r.url.path() == "/sts/vend-self"),
            "no upload credentials are vended on a handoff"
        );
        let completes = completes.lock().unwrap();
        assert_eq!(completes.len(), 1, "COMPLETE must still be emitted once");
        assert!(completes[0].contains("\"filesUploaded\":0"), "{}", completes[0]);
    }

    // When the daemon is not positively confirmed, the install stage uploads
    // the vault itself — with bounded concurrency.
    #[tokio::test]
    async fn install_handoff_uploads_itself_when_the_daemon_is_not_confirmed() {
        let base = daemon_snapshot(WatchDaemonState::Running);
        let cases = [
            ("daemon stopped", daemon_snapshot(WatchDaemonState::Stopped)),
            ("daemon in backoff", daemon_snapshot(WatchDaemonState::Backoff)),
            ("daemon stuck starting", daemon_snapshot(WatchDaemonState::Starting)),
            ("auto-sync off", DaemonHandoffSnapshot { auto_sync_enabled: false, ..base }),
            ("personal sync off", DaemonHandoffSnapshot { personal_sync_enabled: false, ..base }),
            ("sync paused", DaemonHandoffSnapshot { spawn_allowed: false, ..base }),
            ("signed out", DaemonHandoffSnapshot { signed_in: false, ..base }),
        ];
        for (label, snapshot) in cases {
            let server = MockServer::start().await;
            mount_vault_with_bucket(&server).await;
            let tmp_state = TempDir::new().unwrap();
            let tmp_hq = TempDir::new().unwrap();
            let tmp_home = TempDir::new().unwrap();
            seed_vault_files(tmp_hq.path(), 20);
            let in_flight = Arc::new(AtomicUsize::new(0));
            let peak = Arc::new(AtomicUsize::new(0));
            let calls: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(vec![]));

            let result = {
                let _guard = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
                std::env::set_var("HQ_STATE_DIR", tmp_state.path());
                let _home = scoped_home(tmp_home.path());
                let app = tauri::test::mock_app();
                let handle = app.handle().clone();
                let vault = VaultClient::new(&server.uri(), "tok");
                let r = ensure_impl_with(
                    &handle,
                    &vault,
                    tmp_hq.path(),
                    Some(make_tracking_uploader(in_flight, peak.clone(), calls.clone())),
                    &FirstPushMode::InstallHandoff(fixed_probe(snapshot)),
                )
                .await;
                std::env::remove_var("HQ_STATE_DIR");
                r
            };

            assert_eq!(
                result,
                Ok(PersonalFirstPushOutcome::Uploaded {
                    files_uploaded: 21,
                    files_skipped: 0
                }),
                "{label}: the stage must upload the vault itself"
            );
            let calls = calls.lock().unwrap();
            assert!(
                calls.iter().any(|k| k.starts_with("core/")),
                "{label}: core/ stays in the personal vault"
            );
            let peak = peak.load(Ordering::SeqCst);
            assert!(
                peak > 1 && peak <= FIRST_PUSH_UPLOAD_CONCURRENCY,
                "{label}: fallback uploads must be concurrent and bounded; peak={peak}"
            );
        }
    }

    // Kill switch off: `ensure_impl` is the pre-handoff path. It never
    // consults the daemon and uploads strictly one file at a time.
    #[tokio::test]
    async fn legacy_mode_uploads_sequentially_without_a_daemon_check() {
        let server = MockServer::start().await;
        mount_vault_with_bucket(&server).await;
        let tmp_state = TempDir::new().unwrap();
        let tmp_hq = TempDir::new().unwrap();
        let tmp_home = TempDir::new().unwrap();
        seed_vault_files(tmp_hq.path(), 12);
        let in_flight = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let calls: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(vec![]));

        let result = {
            let _guard = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
            std::env::set_var("HQ_STATE_DIR", tmp_state.path());
            let _home = scoped_home(tmp_home.path());
            let app = tauri::test::mock_app();
            let handle = app.handle().clone();
            let vault = VaultClient::new(&server.uri(), "tok");
            let r = ensure_impl(
                &handle,
                &vault,
                tmp_hq.path(),
                Some(make_tracking_uploader(in_flight, peak.clone(), calls.clone())),
            )
            .await;
            std::env::remove_var("HQ_STATE_DIR");
            r
        };

        assert!(result.is_ok(), "{result:?}");
        assert_eq!(calls.lock().unwrap().len(), 13);
        assert_eq!(peak.load(Ordering::SeqCst), 1, "legacy path is sequential");
    }

    #[tokio::test]
    async fn concurrent_first_push_is_bounded_and_journals_every_upload() {
        let tmp_state = TempDir::new().unwrap();
        let tmp_hq = TempDir::new().unwrap();
        let root = tmp_hq.path();
        seed_vault_files(root, 60);

        let _guard = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        std::env::set_var("HQ_STATE_DIR", tmp_state.path());

        let in_flight = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let calls: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(vec![]));
        let progress: Arc<Mutex<Vec<(usize, usize, Option<String>)>>> =
            Arc::new(Mutex::new(vec![]));
        let p = progress.clone();
        let (uploaded, skipped) = run_personal_first_push_with_concurrency(
            root,
            make_tracking_uploader(in_flight.clone(), peak.clone(), calls.clone()),
            |_, _, _| {},
            move |done, total, file| p.lock().unwrap().push((done, total, file)),
            |_, _| {},
            FIRST_PUSH_UPLOAD_CONCURRENCY,
        )
        .await
        .unwrap();

        assert_eq!((uploaded, skipped), (61, 0));
        let peak_seen = peak.load(Ordering::SeqCst);
        assert!(
            peak_seen > 1 && peak_seen <= FIRST_PUSH_UPLOAD_CONCURRENCY,
            "peak in flight must be concurrent but bounded; got {peak_seen}"
        );
        let journal = read_journal(PERSONAL_VAULT_JOURNAL_SLUG).unwrap();
        assert_eq!(journal.files.len(), 61, "every upload is journaled");
        let progress = progress.lock().unwrap();
        assert_eq!(progress.len(), 62, "one event per planned file plus the final one");
        assert!(progress.iter().all(|(_, total, _)| *total == 61));
        assert_eq!(progress.last().unwrap(), &(61, 61, None));

        // Re-run: the journal written by the concurrent phase makes it a no-op.
        let calls2: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(vec![]));
        let (uploaded2, _) = run_personal_first_push_with_concurrency(
            root,
            make_tracking_uploader(in_flight, peak, calls2.clone()),
            |_, _, _| {},
            |_, _, _| {},
            |_, _| {},
            FIRST_PUSH_UPLOAD_CONCURRENCY,
        )
        .await
        .unwrap();
        std::env::remove_var("HQ_STATE_DIR");
        assert_eq!(uploaded2, 0);
        assert!(calls2.lock().unwrap().is_empty());
    }

    /// One file fails permanently. Returns the error and the journal size.
    async fn run_with_one_failing_file(concurrency: usize) -> (String, usize) {
        let tmp_state = TempDir::new().unwrap();
        let tmp_hq = TempDir::new().unwrap();
        let root = tmp_hq.path();
        write_file(&root.join("knowledge/a-bad.md"), b"bad");

        let _guard = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        std::env::set_var("HQ_STATE_DIR", tmp_state.path());
        let uploader: UploaderFn = Arc::new(
            |key: String, _data: Bytes, _sha: String| -> BoxFuture<UploadOutcome> {
                Box::pin(async move {
                    if key == "knowledge/a-bad.md" {
                        UploadOutcome::Permanent("AccessDenied".into())
                    } else {
                        UploadOutcome::Ok
                    }
                })
            },
        );
        let err = run_personal_first_push_with_concurrency(
            root,
            uploader,
            |_, _, _| {},
            |_, _, _| {},
            |_, _| {},
            concurrency,
        )
        .await
        .expect_err("a permanent failure must fail the push");
        let journaled = read_journal(PERSONAL_VAULT_JOURNAL_SLUG).unwrap().files.len();
        std::env::remove_var("HQ_STATE_DIR");
        (err, journaled)
    }

    #[tokio::test]
    async fn concurrent_first_push_surfaces_a_failed_file_exactly_like_sequential() {
        let (seq_err, seq_journaled) = run_with_one_failing_file(1).await;
        let (con_err, con_journaled) = run_with_one_failing_file(FIRST_PUSH_UPLOAD_CONCURRENCY).await;
        assert_eq!(seq_err, "permanent upload error: AccessDenied");
        assert_eq!(con_err, seq_err, "same error text on both paths");
        assert_eq!((seq_journaled, con_journaled), (0, 0), "the failed file is not journaled");
    }

    #[tokio::test]
    async fn concurrent_first_push_keeps_transient_retry_semantics() {
        let tmp_state = TempDir::new().unwrap();
        let tmp_hq = TempDir::new().unwrap();
        let root = tmp_hq.path();
        write_file(&root.join("knowledge/flaky.md"), b"flaky");
        write_file(&root.join("knowledge/down.md"), b"down");
        write_file(&root.join("knowledge/fine.md"), b"fine");

        let attempts: Arc<Mutex<std::collections::HashMap<String, usize>>> =
            Arc::new(Mutex::new(Default::default()));
        let a = attempts.clone();
        let uploader: UploaderFn = Arc::new(
            move |key: String, _data: Bytes, _sha: String| -> BoxFuture<UploadOutcome> {
                let n = {
                    let mut m = a.lock().unwrap();
                    let n = m.entry(key.clone()).or_insert(0);
                    *n += 1;
                    *n
                };
                Box::pin(async move {
                    match key.as_str() {
                        // Two transient failures, then success: retried.
                        "knowledge/flaky.md" if n < 3 => UploadOutcome::Transient("503".into()),
                        // Always transient: gives up after 3 attempts.
                        "knowledge/down.md" => UploadOutcome::Transient("503".into()),
                        _ => UploadOutcome::Ok,
                    }
                })
            },
        );

        let _guard = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        std::env::set_var("HQ_STATE_DIR", tmp_state.path());
        let err = run_personal_first_push_with_concurrency(
            root,
            uploader,
            |_, _, _| {},
            |_, _, _| {},
            |_, _| {},
            FIRST_PUSH_UPLOAD_CONCURRENCY,
        )
        .await
        .expect_err("a file that never succeeds fails the push");
        std::env::remove_var("HQ_STATE_DIR");

        assert_eq!(
            err,
            "upload 'knowledge/down.md' failed after 3 attempts: 503"
        );
        let attempts = attempts.lock().unwrap();
        assert_eq!(attempts.get("knowledge/down.md"), Some(&3));
    }

    #[tokio::test]
    async fn concurrent_first_push_skips_a_vanished_file() {
        let tmp_state = TempDir::new().unwrap();
        let tmp_hq = TempDir::new().unwrap();
        let root = tmp_hq.path();
        write_file(&root.join("knowledge/stays.md"), b"i remain");
        write_file(&root.join("knowledge/vanishes.md"), b"delete me mid-push");

        let _guard = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        std::env::set_var("HQ_STATE_DIR", tmp_state.path());
        let skips: Arc<Mutex<Vec<(String, String)>>> = Arc::new(Mutex::new(vec![]));
        let skips_c = skips.clone();
        let vanish_abs = root.join("knowledge/vanishes.md");
        let (uploaded, _) = run_personal_first_push_with_concurrency(
            root,
            make_uploader(Arc::new(Mutex::new(vec![]))),
            |_, _, _| {},
            move |_, _, file| {
                if file.as_deref() == Some("knowledge/vanishes.md") {
                    let _ = std::fs::remove_file(&vanish_abs);
                }
            },
            move |key, reason| skips_c.lock().unwrap().push((key, reason)),
            FIRST_PUSH_UPLOAD_CONCURRENCY,
        )
        .await
        .expect("a vanished file must not fail the push");
        std::env::remove_var("HQ_STATE_DIR");

        assert_eq!(uploaded, 1);
        assert!(skips
            .lock()
            .unwrap()
            .iter()
            .any(|(k, r)| k == "knowledge/vanishes.md" && r == "file vanished before read"));
    }

    #[tokio::test]
    async fn handoff_watch_reports_how_the_daemon_handoff_ended() {
        let running = fixed_probe(daemon_snapshot(WatchDaemonState::Running));

        // Journal appears on the third look: the daemon synced the vault.
        let looks = Arc::new(AtomicUsize::new(0));
        let l = looks.clone();
        let verdict = watch_daemon_handoff(
            &running,
            move || l.fetch_add(1, Ordering::SeqCst) >= 2,
            Duration::from_secs(5),
            Duration::from_millis(1),
        )
        .await;
        assert_eq!(verdict, HandoffWatchVerdict::DaemonSynced);

        // Daemon crashes into backoff before writing the journal.
        let crashed = sequence_probe(
            vec![
                daemon_snapshot(WatchDaemonState::Running),
                daemon_snapshot(WatchDaemonState::Backoff),
            ],
            Duration::from_secs(5),
        );
        let verdict = watch_daemon_handoff(
            &crashed,
            || false,
            Duration::from_secs(5),
            Duration::from_millis(1),
        )
        .await;
        assert_eq!(verdict, HandoffWatchVerdict::DaemonStopped);

        // Daemon keeps running but never syncs personal (e.g. its first pass
        // was planned before the bucket existed).
        let verdict = watch_daemon_handoff(
            &running,
            || false,
            Duration::from_millis(20),
            Duration::from_millis(1),
        )
        .await;
        assert_eq!(verdict, HandoffWatchVerdict::TimedOut);
    }

    // After the safety net's wait, its walk re-checks the journal gate: once
    // the runner owns the vault it uploads nothing (split-brain guard).
    #[tokio::test]
    async fn safety_net_walk_respects_the_steady_state_gate() {
        let server = MockServer::start().await;
        mount_vault_with_bucket(&server).await;
        let tmp_state = TempDir::new().unwrap();
        let tmp_hq = TempDir::new().unwrap();
        let tmp_home = TempDir::new().unwrap();
        seed_vault_files(tmp_hq.path(), 5);
        let counter = Arc::new(AtomicUsize::new(0));

        let result = {
            let _guard = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
            std::env::set_var("HQ_STATE_DIR", tmp_state.path());
            let _home = scoped_home(tmp_home.path());
            let jp = crate::util::journal::journal_path(PERSONAL_VAULT_JOURNAL_SLUG).unwrap();
            std::fs::write(&jp, "{\"files\":{},\"last_sync\":\"\"}").unwrap();
            let app = tauri::test::mock_app();
            let handle = app.handle().clone();
            let vault = VaultClient::new(&server.uri(), "tok");
            let r = ensure_impl_with(
                &handle,
                &vault,
                tmp_hq.path(),
                Some(make_counter_uploader(counter.clone())),
                &FirstPushMode::ConcurrentWalk,
            )
            .await;
            std::env::remove_var("HQ_STATE_DIR");
            r
        };
        assert_eq!(result, Ok(PersonalFirstPushOutcome::EngineOwnsSteadyState));
        assert_eq!(counter.load(Ordering::SeqCst), 0);
    }
}
