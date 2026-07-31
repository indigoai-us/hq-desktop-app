//! Pure and synchronous support for the HQ CLI update command layer.

use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::paths;

/// npm package the menubar nags the user to keep current.
pub const HQ_CLI_PACKAGE: &str = "@indigoai-us/hq-cli@latest";

/// Payload emitted to the frontend and returned by `check_hq_cli_update`.
#[derive(Debug, Clone, Serialize)]
pub struct HqCliUpdateInfo {
    /// Locally-installed version (None if `hq` isn't on PATH).
    pub local: Option<String>,
    /// `latest` dist-tag from the npm registry.
    pub latest: String,
}

#[derive(Debug, Deserialize)]
pub struct NpmLatest {
    pub version: String,
}

/// Three-segment numeric semver compare ("X.Y.Z[-pre]"). Pre-release
/// suffixes are dropped before comparison since the npm `latest` tag is
/// always stable. Anything that fails to parse compares as zero — we'd
/// rather under-report an update than crash the checker.
pub fn cmp_semver(a: &str, b: &str) -> std::cmp::Ordering {
    fn parse(v: &str) -> (u64, u64, u64) {
        let core = v.split('-').next().unwrap_or(v);
        let mut parts = core.split('.');
        let major = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        let minor = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        let patch = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        (major, minor, patch)
    }
    parse(a).cmp(&parse(b))
}

/// Read `package.json` at `pkg` and return its `version` **iff** the
/// package name is `@indigoai-us/hq-cli`. The name guard lets us walk a
/// binary's ancestor chain and stop only at the *right* package — never a
/// parent workspace's `package.json` that happens to sit above the install.
pub fn version_if_hq_cli(pkg: &Path) -> Option<String> {
    let bytes = std::fs::read(pkg).ok()?;
    let parsed: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    if parsed.get("name").and_then(|n| n.as_str()) != Some("@indigoai-us/hq-cli") {
        return None;
    }
    parsed
        .get("version")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

/// Resolve the installed version by anchoring to the *actual `hq` binary the
/// user runs*. An npm global install lays down `<prefix>/bin/hq` as a symlink
/// into `<prefix>/lib/node_modules/@indigoai-us/hq-cli/<bin script>`, so once
/// we `canonicalize` the resolved path we land *inside* the package tree and
/// can walk `ancestors()` to its `package.json`. Windows instead lays down
/// `<prefix>\hq.cmd` beside `<prefix>\node_modules`; that layout is read
/// directly from the resolved shim's parent.
///
/// This is the fix for the prefix-mismatch bug: it does NOT depend on which
/// `npm` the app resolved or what `npm root -g` reports — it reads the
/// version of the binary that's literally on the user's PATH.
pub fn version_from_hq_binary(hq_bin: &Path) -> Option<String> {
    let real = std::fs::canonicalize(hq_bin).ok()?;
    for ancestor in real.ancestors() {
        if let Some(v) = version_if_hq_cli(&ancestor.join("package.json")) {
            return Some(v);
        }
    }

    // Windows npm does not create a symlink into the package tree. It writes
    // `<prefix>\hq.cmd` beside `<prefix>\node_modules`, so canonicalizing the
    // shim can never reach package.json through its ancestors. Anchor the
    // fallback to that exact shim's prefix instead of asking npm for its
    // unrelated default global root.
    let hq_bin_str = hq_bin.to_string_lossy();
    let prefix = npm_prefix_from_hq_bin(&hq_bin_str)?;
    for package_json in hq_cli_package_json_candidates(Path::new(&prefix), hq_bin) {
        if let Some(v) = version_if_hq_cli(&package_json) {
            return Some(v);
        }
    }
    None
}

/// Parse `hq --version` output into a bare version string. Last-resort only:
/// the CLI's `index.ts` carries a hardcoded `.version("…")` string that can
/// lag the published npm version (same gotcha documented in
/// `util::hq_resolver`), so this may be stale. We still prefer a possibly-
/// stale number over returning None and silently disabling the nag.
pub fn hq_version_string(bin: &Path) -> Option<String> {
    let bin = bin.to_string_lossy();
    let mut cmd = paths::spawn_command(&bin, &[]);
    let out = cmd.arg("--version").output().ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8(out.stdout).ok()?;
    let line = s.lines().next()?.trim().to_string();
    let cleaned = line.trim_start_matches('v').trim();
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned.to_string())
    }
}

/// Resolve the installed `@indigoai-us/hq-cli` version. Returns `None`
/// only when the CLI genuinely isn't installed (or, rarely, is installed
/// but unreadable by every probe — `check_once` Sentry-captures that case).
///
/// Resolution order (first hit wins):
///   1. Binary-anchored — `version_from_hq_binary(resolve_bin("hq"))`.
///      Authoritative and prefix-independent.
///   2. `npm root -g` package.json — retained for non-symlink layouts.
///   3. `hq --version` — last resort (may lag; see `hq_version_string`).
pub fn get_local_version() -> Option<String> {
    // 1. Binary-anchored read — the primary path; fixes the prefix-mismatch
    //    silent-None bug by reading the version of the binary actually on PATH.
    let hq = paths::resolve_bin("hq");
    let hq_installed = hq != "hq";
    if hq_installed {
        if let Some(v) = version_from_hq_binary(Path::new(&hq)) {
            return Some(v);
        }
    }

    // 2. npm global package.json — same canonical source, located via
    //    `npm root -g`. Covers layouts where `hq` isn't a symlink into the
    //    package tree (e.g. a wrapper script).
    let npm = paths::resolve_bin("npm");
    if npm != "npm" {
        if let Some(v) = read_installed_version(&npm, &paths::child_path()) {
            return Some(v);
        }
    }

    // 3. `hq --version` — last resort, but better than silent None for a
    //    user who clearly has the CLI on PATH.
    if hq_installed {
        if let Some(v) = hq_version_string(Path::new(&hq)) {
            return Some(v);
        }
    }

    None
}

/// Read `cliAutoUpdate` directly from menubar.json (untyped) so the background
/// checker never blocks on a typed round-trip and picks up a Settings toggle
/// without a restart. Mirrors `dm_notify::dm_notifications_enabled`. Defaults
/// to true — the app keeps the CLI current unless the user opts out.
pub fn cli_auto_update_enabled() -> bool {
    let Ok(dir) = paths::hq_config_dir() else {
        return true;
    };
    let Ok(contents) = std::fs::read_to_string(dir.join("menubar.json")) else {
        return true;
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&contents) else {
        return true;
    };
    json.get("cliAutoUpdate")
        .and_then(|v| v.as_bool())
        .unwrap_or(true)
}

/// Master automatic-updates switch (`autoUpdate` in menubar.json), default
/// ON. Read untyped like `cli_auto_update_enabled` so every updater (menubar
/// app, `hq` CLI, hq-core) picks the toggle up without a restart. This is the
/// single gate the CLI background auto-installer now uses; the app + core
/// silent installs gate on it frontend-side. A missing/corrupt config reads as
/// `true` — the same fail-open leniency `cli_auto_update_enabled` uses, which
/// matches the "keep everything current unless the user opts out" intent.
pub fn auto_update_enabled() -> bool {
    let Ok(dir) = paths::hq_config_dir() else {
        return true;
    };
    let Ok(contents) = std::fs::read_to_string(dir.join("menubar.json")) else {
        return true;
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&contents) else {
        return true;
    };
    json.get("autoUpdate")
        .and_then(|v| v.as_bool())
        .unwrap_or(true)
}

/// menubar.json key that records the most recent CLI version the user
/// dismissed the "update available" notice for. Read untyped (same leniency
/// as `cli_auto_update_enabled`) so the background loop picks it up without a
/// restart, and written through the untyped-merge path so it survives the
/// typed `save_settings` round-trip.
pub const DISMISSED_VERSION_KEY: &str = "cliUpdateDismissedVersion";

/// The version the user last dismissed the CLI-update notice for, if any.
/// `None` when the key is absent / unreadable — i.e. nothing dismissed, so
/// the notice is free to show.
pub fn dismissed_cli_version() -> Option<String> {
    let dir = paths::hq_config_dir().ok()?;
    let contents = std::fs::read_to_string(dir.join("menubar.json")).ok()?;
    let json: Value = serde_json::from_str(&contents).ok()?;
    json.get(DISMISSED_VERSION_KEY)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

/// Pure dismissal decision: should the live "update available" banner be
/// suppressed for `latest` given the version the user last `dismissed`?
///
/// Per-version semantics: a dismissal is sticky for the version it was made
/// against and is re-shown only when a **strictly newer** `latest` appears —
/// dismissing 5.38.x stays dismissed until 5.39 (or any greater version) is
/// published. We compare with `cmp_semver` so a dismissed "5.38.2" suppresses
/// "5.38.2" (Equal) but not "5.39.0" (Greater → show again). A newly published
/// version is exactly the fix users are being emailed about, so re-surfacing
/// it once (still dismissible) is the intended non-nagging behavior.
pub fn suppress_for_dismissal(latest: &str, dismissed: Option<&str>) -> bool {
    match dismissed {
        Some(d) => cmp_semver(latest, d) != std::cmp::Ordering::Greater,
        None => false,
    }
}

/// Whether the live banner should be suppressed for `latest` because the user
/// already dismissed it. Reads the persisted dismissal then applies the pure
/// `suppress_for_dismissal` rule.
pub fn is_cli_update_dismissed(latest: &str) -> bool {
    suppress_for_dismissal(latest, dismissed_cli_version().as_deref())
}

/// menubar.json key recording a `latest` whose install npm reported as
/// successful but which left the detected local version untouched. Read/written
/// untyped through the same path as `DISMISSED_VERSION_KEY`.
pub const NON_CONVERGENT_VERSION_KEY: &str = "cliUpdateNonConvergentVersion";

/// The version an earlier install completed on without moving the detected
/// version, if any. `None` when the key is absent, `null`, or unreadable.
pub fn non_convergent_cli_version() -> Option<String> {
    let dir = paths::hq_config_dir().ok()?;
    let contents = std::fs::read_to_string(dir.join("menubar.json")).ok()?;
    let json: Value = serde_json::from_str(&contents).ok()?;
    json.get(NON_CONVERGENT_VERSION_KEY)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

/// Version of the `hq` the app will actually **execute** — the only probe valid
/// for proving an install converged.
///
/// `get_local_version` deliberately falls back to `npm root -g`. That is right
/// for the banner (it answers "is something stale installed?") but fatal as a
/// convergence proof: when the resolved `hq` is a pnpm or Homebrew copy npm
/// cannot replace, an `npm install -g` moves the npm-root reading to `latest`
/// while the executable the app actually runs stays stale. Accepting that
/// reading would let the updater declare victory over an install it never
/// touched, mark the CLI current forever, and leave the app quietly running the
/// old binary — a quieter version of the same bug this module is fixing.
///
/// So this probe stays bound to the resolved binary: anchor into its own
/// package tree, and failing that ask the binary itself. Never `npm root -g`.
pub fn resolved_hq_version(hq_bin: &str) -> Option<String> {
    if hq_bin == "hq" {
        return None;
    }
    let path = Path::new(hq_bin);
    version_from_hq_binary(path).or_else(|| hq_version_string(path))
}

/// Replace every occurrence of the home directory with `~`. Sentry extras want
/// the install *layout* (`~/Library/pnpm/hq` tells us everything we need); the
/// account name in front of it is personal data we have no reason to ship.
///
/// Global replace, not a prefix strip: this also runs over npm stderr, where
/// home paths appear mid-string (`EACCES: permission denied, mkdir
/// '/Users/alice/…'`) rather than at the front. `/` as a home directory is
/// ignored — replacing every slash would destroy the text it is meant to
/// sanitise.
pub fn redact_home_in(text: &str, home: Option<&str>) -> String {
    match home {
        Some(h) if !h.is_empty() && h != "/" => text.replace(h, "~"),
        _ => text.to_string(),
    }
}

/// `redact_home_in` against this machine's real home directory.
pub fn redact_home(path: &str) -> String {
    let home = paths::home_dir().map(|h| h.to_string_lossy().to_string());
    redact_home_in(path, home.as_deref())
}

/// Did an install npm reported as successful actually move the version the app
/// detects?
///
/// A zero exit only proves npm wrote a package *somewhere*. When the resolved
/// `hq` is managed by something npm cannot replace — a pnpm shim, a Homebrew
/// formula, a copy shadowed earlier on PATH — npm writes a perfectly good
/// package into a prefix nothing reads, and `get_local_version` keeps returning
/// the old number. `after` is the post-install reading; convergence means it
/// reached `latest`. A reading that stands still, creeps to something still
/// short of `latest`, or goes blind entirely all mean the install did not take
/// effect where it counts.
pub fn install_converged(after: Option<&str>, latest: &str) -> bool {
    match after {
        Some(a) => cmp_semver(a, latest) != std::cmp::Ordering::Less,
        None => false,
    }
}

/// Should the background loop auto-install `latest`?
///
/// `false` once an install of that exact version has already completed without
/// converging: repeating it cannot produce a different result, and the loop
/// would otherwise reinstall 15s after every launch and every 6h forever. A
/// newer `latest` clears the block on its own (the environment may have been
/// fixed in between), and the user-initiated "Update" button never consults
/// this — an explicit click should always be allowed to try again.
pub fn should_auto_install(latest: &str, non_convergent: Option<&str>) -> bool {
    non_convergent != Some(latest)
}

/// Stable marker on the non-convergent error string. The UI keys off it to tell
/// this apart from an npm failure, because the two remedies are opposites: an
/// npm failure wants "retry, or copy the install command", whereas a
/// non-convergent install means that exact command has *already* been proven
/// unable to replace the selected CLI, so offering it again only repeats the
/// failure. Callers strip the marker before display.
pub const NON_CONVERGENT_ERROR_PREFIX: &str = "hq-cli-update/non-convergent: ";

/// The message shown (and logged) when an install completes without
/// converging. It has to name the specific binary that did not move: a machine
/// in this state usually has two or three `hq` copies, and knowing *which* one
/// the app resolves is the entire remedy.
pub fn non_convergent_detail(hq_bin: &str, local: Option<&str>, latest: &str) -> String {
    let current = local.unwrap_or("an unreadable version");
    format!(
        "{NON_CONVERGENT_ERROR_PREFIX}hq {latest} installed successfully, but the app still \
         resolves hq {current} at {hq_bin}. That copy is managed outside npm's global prefix \
         (pnpm, Homebrew, or an earlier entry on PATH), so an npm install cannot replace it. \
         Update it with the tool that installed it, or remove it so the npm-managed copy \
         takes over."
    )
}

/// Capture the non-convergent-install signal. This is a distinct class from
/// `install-failed`: npm exited 0 and nothing threw, so nothing else in the
/// pipeline would ever notice. It is exactly the silent state that ran on a
/// prod install for weeks, reinstalling on every cycle while the detected
/// version stayed frozen, so it stays at Warning level with its own fingerprint
/// rather than folding into the install-failure bucket.
pub fn report_non_convergent_install(
    latest: &str,
    local: Option<&str>,
    hq_bin: &str,
    prefix: Option<&str>,
) {
    sentry::with_scope(
        |scope| {
            scope.set_tag("hq_cli_update_kind", "install-non-convergent");
            scope.set_tag("latest", latest);
            scope.set_tag("local", local.unwrap_or("unreadable"));
            scope.set_fingerprint(Some(&["hq-cli-update", "install-non-convergent"]));
            // Home-redacted: the install LAYOUT is the diagnostic
            // (`~/Library/pnpm/hq` says everything); the account name in front
            // of it is personal data. The shared `before_send` scrubber only
            // filters by key name, so ordinary string extras like these reach
            // Sentry verbatim unless redacted here.
            scope.set_extra("hq_bin", redact_home(hq_bin).into());
            scope.set_extra(
                "npm_prefix",
                redact_home(prefix.unwrap_or("npm default prefix")).into(),
            );
        },
        || {
            sentry::capture_message(
                "[hq-cli-update] install completed but the detected CLI version did not change",
                sentry::Level::Warning,
            );
        },
    );
}

/// Capture a Sentry event when `hq` is installed but every version probe
/// failed. Scrubbed by `sentry_scrub.rs` before send. This is the
/// "detection silently degraded" signal the team triages immediately —
/// the exact class that hid a stale CLI behind a missing banner.
pub fn report_unreadable_version(latest: &str) {
    sentry::with_scope(
        |scope| {
            scope.set_tag("hq_cli_update_kind", "version-unreadable");
            scope.set_tag("latest", latest);
        },
        || {
            sentry::capture_message(
                "[hq-cli-update] hq is installed but its version could not be read \
                 (binary-anchor, npm root, and hq --version all failed)",
                sentry::Level::Warning,
            );
        },
    );
}

/// Whether an npm install failure is the EXPECTED "global npm prefix needs
/// sudo" condition. This is deliberately stricter than an `EACCES` string
/// check: npm and lifecycle scripts can report permission failures for its
/// cache, a package script, or an unrelated filesystem path. Only a write to
/// the exact prefix selected for this `hq` update is the known, non-actionable
/// user-machine setup failure.
///
/// npm uses `<prefix>/lib/node_modules` on Unix and `<prefix>/node_modules`
/// on Windows. It can also fail while linking `<prefix>/bin/hq`. Normalize
/// separators so an event captured on either platform follows the same rule.
pub fn is_prefix_permission_failure(detail: &str, prefix: Option<&str>) -> bool {
    let detail = detail.to_ascii_lowercase().replace('\\', "/");
    let is_permission_error = detail.contains("eacces") || detail.contains("permission denied");
    let Some(prefix) = prefix else {
        return false;
    };
    let prefix = prefix
        .trim()
        .trim_end_matches(['/', '\\'])
        .to_ascii_lowercase()
        .replace('\\', "/");
    if !is_permission_error || prefix.is_empty() {
        return false;
    }

    [
        format!("{prefix}/lib/node_modules"),
        format!("{prefix}/node_modules"),
        format!("{prefix}/bin/hq"),
    ]
    .iter()
    .any(|target| detail.contains(target))
}

/// Whether npm reported a permission failure. Keep this parsing separate from
/// the selected-prefix classifier: npm may fail at its cache, a package script,
/// or another filesystem location, and those locations have different
/// remediation paths.
fn is_npm_permission_failure(detail: &str) -> bool {
    let detail = detail.to_ascii_lowercase();
    detail.contains("eacces") || detail.contains("permission denied")
}

/// Return a scrub-safe category for a permission failure without retaining the
/// reported filesystem path. npm's cache errors consistently name its
/// `_cacache` directory; selected-prefix errors take precedence so the two
/// categories remain disjoint.
fn npm_failure_site(detail: &str, prefix: Option<&str>) -> &'static str {
    if !is_npm_permission_failure(detail) {
        return "other";
    }
    if is_prefix_permission_failure(detail, prefix) {
        return "prefix";
    }
    if detail.to_ascii_lowercase().contains("_cacache") {
        return "cache";
    }
    "other"
}

/// Return only an allow-listed npm error code for Sentry. npm stderr is often
/// scrubbed before it can be inspected, but an error code tells us whether a
/// captured failure came from npm's cache, registry, or installer without
/// retaining a path, username, or raw output.
fn npm_error_code(detail: &str) -> String {
    const ALLOWED_CODES: &[&str] = &[
        "EACCES",
        "EAI_AGAIN",
        "ECONNREFUSED",
        "ECONNRESET",
        "EEXIST",
        "EINTEGRITY",
        "ENOSPC",
        "ENOTEMPTY",
        "ENOTFOUND",
        "EPERM",
        "EPIPE",
        "ERR_SOCKET_TIMEOUT",
        "ETARGET",
        "ETIMEDOUT",
    ];
    const MARKER: &str = "npm error code ";

    let code = detail.lines().find_map(|line| {
        let line = line.trim();
        line.get(..MARKER.len())
            .filter(|prefix| prefix.eq_ignore_ascii_case(MARKER))
            .and_then(|_| line.get(MARKER.len()..))
            .and_then(|remainder| remainder.split_ascii_whitespace().next())
    });

    match code {
        Some(code)
            if code
                .bytes()
                .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
                && ALLOWED_CODES.contains(&code) =>
        {
            code.to_string()
        }
        _ => "unknown".to_string(),
    }
}

/// npm's registry can briefly serve an unsatisfiable graph while packages are
/// published, or fail during an otherwise ordinary network interruption. The
/// updater's next scheduled cycle retries after that short external condition
/// has cleared; this is not an actionable desktop-app error.
fn is_expected_transient_registry_failure(detail: &str) -> bool {
    let detail = detail.to_ascii_lowercase();
    if !detail.contains("npm error") {
        return false;
    }

    ["etarget", "notarget", "no matching version found"]
        .iter()
        .any(|marker| detail.contains(marker))
        || [
            "econnreset",
            "etimedout",
            "enotfound",
            "eai_again",
            "err_socket_timeout",
            "npm error network",
        ]
        .iter()
        .any(|marker| detail.contains(marker))
}

/// Windows reports an aborting child as an NTSTATUS in `ExitStatus::code()`.
/// Rust exposes the DWORD as a signed `i32`, hence these otherwise-surprising
/// negative values. They are both normal user-machine interruptions for an
/// npm subprocess: `STATUS_CONTROL_C_EXIT` means a user/session manager
/// stopped it, and `STATUS_STACK_BUFFER_OVERRUN` is Node's Windows abort path.
/// Neither identifies an HQ service or desktop-app defect.
const WINDOWS_CONTROL_C_EXIT: i32 = -1_073_741_510; // 0xC000013A
const WINDOWS_ABORT_EXIT: i32 = -1_073_740_791; // 0xC0000409

/// libuv encodes a Windows `EPERM` ("operation not permitted") as this signed
/// errno, and npm propagates it as the install process's exit code when it
/// cannot replace the `hq` executable because the file is locked or in use — a
/// running `hq`/terminal process, or antivirus/endpoint protection holding the
/// binary open. This is the same value Node surfaces as
/// `{ errno: -4048, code: 'EPERM' }`. Like the abort codes above, it is a
/// normal user-machine condition, not an HQ updater defect (HQ-DESKTOP-3N).
const WINDOWS_EPERM_EXIT: i32 = -4048;

/// Whether a failed npm install is the EXPECTED Windows "the `hq` binary is
/// locked / in use" condition (libuv `EPERM`). npm bubbles the same underlying
/// error two ways depending on where it aborts:
///   * as the install process's exit code — the raw libuv errno `-4048`, or
///   * in its stderr as `code EPERM` / `errno -4048` / "operation not
///     permitted" while renaming or unlinking the package it is replacing.
///
/// This is the Windows analogue of the `EACCES` sudo case: a local-machine
/// setup/interference fault the app already handles with the copy-the-command
/// UI fallback, not an updater defect. `EACCES` is classified by
/// `is_prefix_permission_failure`, so it is explicitly excluded here to keep the
/// two buckets disjoint. The `hq-cli` updater only ever runs
/// `npm install -g @indigoai-us/hq-cli@latest`, so an `EPERM` from that run is
/// the locked-binary case rather than an unrelated permission fault.
pub fn is_windows_locked_binary_failure(exit_code: Option<i32>, detail: &str) -> bool {
    if exit_code == Some(WINDOWS_EPERM_EXIT) {
        return true;
    }
    let detail = detail.to_ascii_lowercase();
    if detail.contains("eacces") {
        return false;
    }
    detail.contains("eperm")
        || detail.contains("operation not permitted")
        || detail.contains("errno -4048")
}

/// Stable classification for a failed npm install. Expected local-machine
/// failures stay actionable in the UI/local log but must not page Sentry;
/// unexpected failures are captured with a separate fingerprint.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallFailureKind {
    ExpectedPrefixPermission,
    ExpectedWindowsAbort,
    ExpectedWindowsLockedBinary,
    ExpectedTransientRegistry,
    Unexpected,
}

pub fn classify_install_failure(
    exit_code: Option<i32>,
    detail: &str,
    prefix: Option<&str>,
) -> InstallFailureKind {
    if is_prefix_permission_failure(detail, prefix) {
        InstallFailureKind::ExpectedPrefixPermission
    } else if matches!(exit_code, Some(WINDOWS_CONTROL_C_EXIT | WINDOWS_ABORT_EXIT)) {
        InstallFailureKind::ExpectedWindowsAbort
    } else if is_windows_locked_binary_failure(exit_code, detail) {
        InstallFailureKind::ExpectedWindowsLockedBinary
    } else if is_expected_transient_registry_failure(detail) {
        InstallFailureKind::ExpectedTransientRegistry
    } else {
        InstallFailureKind::Unexpected
    }
}

impl InstallFailureKind {
    /// A stable grouping key for diagnostics and Sentry. We intentionally keep
    /// expected local failures separate from actual updater defects; the former
    /// are not sent to Sentry at all by `report_install_failure`.
    pub fn fingerprint_component(self) -> &'static str {
        match self {
            Self::ExpectedPrefixPermission => "expected-prefix-permission",
            Self::ExpectedWindowsAbort => "expected-windows-abort",
            Self::ExpectedWindowsLockedBinary => "expected-windows-locked-binary",
            Self::ExpectedTransientRegistry => "expected-transient-registry",
            Self::Unexpected => "unexpected",
        }
    }
}

/// User-facing fallback text for an install failure that did not include useful
/// npm stderr. The desktop UI always offers the copy-command escape hatch; the
/// Windows abort wording tells the user why retrying after closing competing
/// terminals/Node processes is worthwhile instead of presenting a raw NTSTATUS.
pub fn install_failure_detail(
    exit_code: Option<i32>,
    detail: &str,
    prefix: Option<&str>,
) -> String {
    if classify_install_failure(exit_code, detail, prefix)
        == InstallFailureKind::ExpectedTransientRegistry
    {
        return "npm's registry was temporarily unavailable or was mid-publish. The updater will retry automatically on its next scheduled check; you can also retry the copied command shortly."
            .to_string();
    }
    if !detail.trim().is_empty() {
        return detail.trim().to_string();
    }
    match classify_install_failure(exit_code, detail, prefix) {
        InstallFailureKind::ExpectedPrefixPermission => {
            "npm cannot write its global prefix. Run the copied command in a terminal with a user-owned npm prefix (or use an administrator-approved install).".to_string()
        }
        InstallFailureKind::ExpectedWindowsAbort => {
            "npm's Windows child process was interrupted or aborted. Close competing npm/Node terminals, retry the copied command in a fresh terminal, and check endpoint protection if it keeps happening.".to_string()
        }
        InstallFailureKind::ExpectedWindowsLockedBinary => {
            "npm could not replace the hq program because the file is locked or in use (a running hq command or terminal, or antivirus/endpoint protection). Close any open hq processes and terminals, then retry the copied command in a fresh terminal; if it keeps happening, allow-list hq in your endpoint protection.".to_string()
        }
        InstallFailureKind::ExpectedTransientRegistry => {
            "npm's registry was temporarily unavailable or was mid-publish. The updater will retry automatically on its next scheduled check; you can also retry the copied command shortly.".to_string()
        }
        InstallFailureKind::Unexpected => format!(
            "npm install exited with status {}",
            exit_code
                .map(|code| code.to_string())
                .unwrap_or_else(|| "signal/none".to_string())
        ),
    }
}

/// Decide whether a CLI-install failure should be reported to Sentry, and with
/// what message. Returns `None` for every EXPECTED local-machine failure — the
/// permission failure at the selected npm global prefix (HQ-SYNC-WEB-Y: exit
/// 243, 180 events / 7 users), the Windows child abort codes, and the Windows
/// `EPERM` locked-binary condition (HQ-DESKTOP-3N: exit -4048). The app already
/// handles each gracefully (the UI falls back to the copy-the-command path and
/// the failure is kept in the local diagnostic log for Connect diagnostics), so
/// an Error-level capture on every auto-update cycle is pure noise. Returns
/// `Some(message)` for every genuine, unexpected failure, including permission
/// errors at another path — that is the real signal we want to stay loud at
/// Error level.
pub fn install_failure_report(
    exit_code: Option<i32>,
    detail: &str,
    prefix: Option<&str>,
) -> Option<String> {
    if classify_install_failure(exit_code, detail, prefix) != InstallFailureKind::Unexpected {
        return None;
    }
    let exit_str = exit_code
        .map(|c| c.to_string())
        .unwrap_or_else(|| "signal/none".to_string());
    Some(format!("[hq-cli-update] install failed (exit {exit_str})"))
}

/// Capture an auto/manual CLI-install failure to Sentry — but only when it is a
/// genuine, unexpected failure (see `install_failure_report`). The expected
/// permission failure at the selected global prefix is deliberately NOT
/// captured: it floods Sentry with an unactionable Error every auto-update
/// cycle while the user already has the copy-the-command fallback. The npm
/// stderr tail rides along as the useful signal for every captured failure,
/// home-redacted here: npm errors quote absolute paths
/// (`EACCES … mkdir '/Users/alice/…'`), and the shared `before_send` scrubber
/// only filters values whose *key* looks secret-like, so an ordinary string
/// extra reaches Sentry verbatim unless it is redacted at the call site.
pub fn report_install_failure(exit_code: Option<i32>, detail: &str, prefix: Option<&str>) {
    let kind = classify_install_failure(exit_code, detail, prefix);
    let Some(message) = install_failure_report(exit_code, detail, prefix) else {
        return;
    };
    let exit_str = exit_code
        .map(|c| c.to_string())
        .unwrap_or_else(|| "signal/none".to_string());
    sentry::with_scope(
        |scope| {
            scope.set_tag("hq_cli_update_kind", "install-failed");
            scope.set_tag("install_failure_kind", kind.fingerprint_component());
            scope.set_tag("exit_code", exit_str.as_str());
            scope.set_tag(
                "eacces",
                if is_npm_permission_failure(detail) {
                    "true"
                } else {
                    "false"
                },
            );
            scope.set_tag("npm_failure_site", npm_failure_site(detail, prefix));
            scope.set_tag("npm_error_code", npm_error_code(detail));
            let fingerprint = [
                "hq-cli-update",
                "install-failed",
                kind.fingerprint_component(),
                exit_str.as_str(),
            ];
            scope.set_fingerprint(Some(&fingerprint));
            scope.set_extra("npm_stderr", redact_home(detail).into());
        },
        || {
            sentry::capture_message(&message, sentry::Level::Error);
        },
    );
}

/// Report a failure to prepare the updater's app-owned npm cache without
/// sending the local cache path or the raw filesystem error to Sentry.
pub fn report_npm_cache_setup_failure(category: &'static str) {
    sentry::with_scope(
        |scope| {
            scope.set_tag("hq_cli_update_kind", "cache-setup-failed");
            scope.set_tag("npm_cache_setup_failure", category);
            scope.set_fingerprint(Some(&["hq-cli-update", "cache-setup-failed", category]));
        },
        || {
            sentry::capture_message(
                "[hq-cli-update] app-owned npm cache could not be prepared",
                sentry::Level::Error,
            );
        },
    );
}

/// Derive the npm global prefix from the exact `hq` binary the app resolved.
///
/// Unix npm uses `<prefix>/bin/hq`; Windows npm writes `<prefix>\hq.cmd`.
/// Detection is already anchored to `resolve_bin("hq")`, so the updater must
/// write to that same enclosing prefix or it can install a fresh CLI that the
/// app never executes. Deliberately avoid `canonicalize`: for Unix symlinks we
/// want the symlink's own prefix, not the package-internal target path.
///
/// **The `bin` guard on the Unix branch is load-bearing.** `resolve_bin` also
/// searches package managers whose global bin directory is *flat* — pnpm's
/// `~/Library/pnpm` (macOS) and `~/.local/share/pnpm` (Linux) both hold the
/// shim directly. For those, walking up two levels lands on a directory npm has
/// never managed (plain `~/Library`), and npm will cheerfully honour `--prefix`
/// there: it creates `~/Library/bin` + `~/Library/lib/node_modules`, exits 0,
/// and the install is invisible to every detection path. The updater then
/// reinstalls on every launch and every 6h check, forever, logging success each
/// time. So a parent directory literally named `bin` is what proves the
/// grandparent is an npm prefix; without it we return `None` and let npm use
/// its own configured global prefix, which is at least internally consistent
/// with `npm root -g` (the fallback `get_local_version` reads).
pub fn npm_prefix_from_hq_bin(hq_bin: &str) -> Option<String> {
    if hq_bin == "hq" {
        return None;
    }
    let path = Path::new(hq_bin);
    let parent = path.parent()?;
    let is_windows_npm_shim = path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| matches!(ext.to_ascii_lowercase().as_str(), "cmd" | "bat"))
        .unwrap_or(false);
    let prefix = if is_windows_npm_shim {
        // `<prefix>\hq.cmd` — the shim sits directly in the prefix.
        parent
    } else {
        // `<prefix>/bin/hq`. A parent named `bin` is the only thing that proves
        // the grandparent is an npm prefix; see the doc comment for the pnpm
        // flat-dir case this rejects.
        if !matches!(parent.file_name().and_then(|n| n.to_str()), Some("bin")) {
            return None;
        }
        parent.parent()?
    };
    if prefix.as_os_str().is_empty() {
        None
    } else {
        Some(prefix.to_string_lossy().to_string())
    }
}

fn hq_cli_package_json_candidates(prefix: &Path, hq_bin: &Path) -> Vec<std::path::PathBuf> {
    let is_windows_npm_shim = hq_bin
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| matches!(ext.to_ascii_lowercase().as_str(), "cmd" | "bat"))
        .unwrap_or(false);
    let windows = prefix
        .join("node_modules")
        .join("@indigoai-us")
        .join("hq-cli")
        .join("package.json");
    let unix = prefix
        .join("lib")
        .join("node_modules")
        .join("@indigoai-us")
        .join("hq-cli")
        .join("package.json");
    if is_windows_npm_shim {
        vec![windows, unix]
    } else {
        vec![unix, windows]
    }
}

/// Build the argv for the global install. Factored out so the unit test
/// can lock the shape without spawning npm. When we know the prefix that
/// contains the resolved `hq`, pass it explicitly so npm updates the binary
/// the app actually runs instead of npm's unrelated default global prefix.
pub fn install_argv(prefix: Option<&str>) -> Vec<String> {
    let mut argv = vec!["install".to_string(), "-g".to_string()];
    if let Some(prefix) = prefix {
        argv.push("--prefix".to_string());
        argv.push(prefix.to_string());
    }
    argv.push(HQ_CLI_PACKAGE.to_string());
    argv
}

/// Read the version field from the installed package.json inside the npm
/// global prefix. We do this instead of `hq --version` because the CLI's
/// `index.ts` carries a hardcoded `.version("5.5.0")`-style string that
/// has not been kept in sync with the published npm version (same gotcha
/// documented in `util::hq_resolver`). package.json is the canonical source.
///
/// `npm_bin` is the absolute path to the `npm` binary being queried; callers
/// pass the same beefed-up PATH used for child processes so node-backed npm
/// still starts under a Dock-launched app. This intentionally reads npm's
/// default global prefix and is only a fallback for version detection layouts
/// that cannot be resolved from the `hq` binary itself.
pub fn read_installed_version(npm_bin: &str, path: &str) -> Option<String> {
    let mut cmd = paths::spawn_command(npm_bin, &[]);
    let out = cmd.args(["root", "-g"]).env("PATH", path).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let root = String::from_utf8(out.stdout).ok()?.trim().to_string();
    if root.is_empty() {
        return None;
    }
    let pkg_json = std::path::Path::new(&root)
        .join("@indigoai-us")
        .join("hq-cli")
        .join("package.json");
    let bytes = std::fs::read(&pkg_json).ok()?;
    let parsed: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    parsed
        .get("version")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cmp::Ordering;

    #[test]
    fn cmp_semver_compares_numerically_not_lexically() {
        // The whole point of a custom comparator — string compare would
        // say "5.10.0" < "5.2.0" because '1' < '2'.
        assert_eq!(cmp_semver("5.10.0", "5.2.0"), Ordering::Greater);
        assert_eq!(cmp_semver("5.10.10", "5.10.2"), Ordering::Greater);
    }

    #[test]
    fn cmp_semver_equal_and_less() {
        assert_eq!(cmp_semver("5.11.0", "5.11.0"), Ordering::Equal);
        assert_eq!(cmp_semver("5.11.0", "5.12.0"), Ordering::Less);
        assert_eq!(cmp_semver("5.12.1", "5.12.2"), Ordering::Less);
    }

    #[test]
    fn cmp_semver_handles_prerelease_suffix() {
        // npm `latest` is stable, but tolerate the suffix instead of
        // returning "no update" when the user is on a -beta or -rc.
        assert_eq!(cmp_semver("5.12.0-beta.1", "5.12.0"), Ordering::Equal);
        assert_eq!(cmp_semver("5.11.0-rc.3", "5.12.0"), Ordering::Less);
    }

    /// Lock the npm argv shape so a typo (e.g., dropping `-g`, renaming
    /// the package) can't ship a non-global or wrong-package install.
    #[test]
    fn install_argv_targets_global_hq_cli() {
        let argv = install_argv(None);
        assert_eq!(argv[0], "install");
        assert_eq!(argv[1], "-g");
        assert!(
            argv[2].starts_with("@indigoai-us/hq-cli@"),
            "package arg must target @indigoai-us/hq-cli; got {}",
            argv[2],
        );
        // The banner button is the "update to current" path — pin must
        // resolve to `latest`, not a hardcoded version that would rot.
        assert!(
            argv[2].ends_with("@latest"),
            "package arg must request @latest; got {}",
            argv[2],
        );
    }

    #[test]
    fn install_argv_includes_prefix_when_available() {
        let argv = install_argv(Some("/tmp/hq-prefix"));
        assert_eq!(
            argv,
            vec![
                "install".to_string(),
                "-g".to_string(),
                "--prefix".to_string(),
                "/tmp/hq-prefix".to_string(),
                HQ_CLI_PACKAGE.to_string(),
            ]
        );
        let prefix_flag = argv.iter().position(|arg| arg == "--prefix").unwrap();
        assert_eq!(
            argv.get(prefix_flag + 1),
            Some(&"/tmp/hq-prefix".to_string())
        );
    }

    #[test]
    fn npm_prefix_from_resolved_hq_bin_uses_enclosing_prefix() {
        assert_eq!(
            npm_prefix_from_hq_bin(
                "/Users/test/Library/Application Support/Indigo HQ/toolchain/npm-global/bin/hq"
            ),
            Some(
                "/Users/test/Library/Application Support/Indigo HQ/toolchain/npm-global"
                    .to_string()
            )
        );
        assert_eq!(npm_prefix_from_hq_bin("hq"), None);
    }

    /// The stuck-auto-update regression, reproduced from a prod HQ.app whose
    /// `hq` resolved to pnpm's **flat** global bin directory
    /// (`~/Library/pnpm/hq` — `user_cli_dirs`' third candidate). npm's layout
    /// is `<prefix>/bin/hq`, so walking up two levels from a flat shim dir
    /// invents `~/Library` as the prefix. npm accepted it, created
    /// `~/Library/bin` + `~/Library/lib/node_modules`, and exited 0 — while
    /// every detection path kept reading the *other* install. Result: "install
    /// succeeded" on every cycle for weeks with the detected version frozen.
    ///
    /// A parent directory literally named `bin` is the only thing that proves
    /// the grandparent is an npm prefix. Without it we must return `None` and
    /// let npm use its own configured global prefix, which is at least
    /// internally consistent.
    #[test]
    fn npm_prefix_rejects_flat_shim_dirs_that_are_not_npm_prefixes() {
        // pnpm on macOS — the exact path from the field report.
        assert_eq!(npm_prefix_from_hq_bin("/Users/test/Library/pnpm/hq"), None);
        // pnpm on Linux.
        assert_eq!(
            npm_prefix_from_hq_bin("/Users/test/.local/share/pnpm/hq"),
            None
        );
        // Any other hand-rolled wrapper directory.
        assert_eq!(npm_prefix_from_hq_bin("/Users/test/.hq/shims/hq"), None);
    }

    /// The npm layouts that *do* yield a usable prefix must keep working —
    /// this is the half of the contract the fix must not regress.
    #[test]
    fn npm_prefix_still_accepts_real_npm_bin_layouts() {
        assert_eq!(
            npm_prefix_from_hq_bin("/opt/homebrew/bin/hq"),
            Some("/opt/homebrew".to_string())
        );
        assert_eq!(
            npm_prefix_from_hq_bin("/Users/test/.npm-global/bin/hq"),
            Some("/Users/test/.npm-global".to_string())
        );
    }

    /// Convergence is the property the old code never checked: npm exiting 0
    /// only proves a package was written *somewhere*, not that it landed where
    /// detection reads. `install_converged` is what turns "npm said fine" into
    /// "the CLI the app runs actually moved".
    #[test]
    fn install_converged_requires_detection_to_reach_latest() {
        assert!(install_converged(Some("5.79.0"), "5.79.0"));
        // Detection ahead of the registry (a beta/local build) still counts.
        assert!(install_converged(Some("5.80.0"), "5.79.0"));
        // The prod signature: npm exits 0, detection is unchanged.
        assert!(!install_converged(Some("5.77.10"), "5.79.0"));
        // Detection went blind right after an install — cannot prove anything.
        assert!(!install_converged(None, "5.79.0"));
    }

    /// Without this gate the background loop reinstalls the same version 15s
    /// after every launch and every 6h forever — the observable "stuck" symptom.
    #[test]
    fn auto_install_stops_repeating_a_non_convergent_version() {
        // Nothing recorded → always allowed.
        assert!(should_auto_install("5.79.0", None));
        // Already proven not to move the needle → do not spin on it again.
        assert!(!should_auto_install("5.79.0", Some("5.79.0")));
        // A newly published version clears the block: the environment may have
        // changed, and this release is exactly what a stale user needs.
        assert!(should_auto_install("5.80.0", Some("5.79.0")));
    }

    /// The failure text is the whole remedy for a non-convergent install — it
    /// has to name the binary that did not move, or the user has no way to know
    /// which of several installed copies is shadowing the update. It also has
    /// to carry the marker, since the UI keys off it to suppress the
    /// copy-the-install-command action that would just repeat the failure.
    #[test]
    fn non_convergent_detail_names_the_binary_that_did_not_move() {
        let detail = non_convergent_detail("/Users/test/Library/pnpm/hq", Some("5.38.2"), "5.79.0");
        assert!(
            detail.starts_with(NON_CONVERGENT_ERROR_PREFIX),
            "UI keys off this marker; got {detail}"
        );
        assert!(detail.contains("5.79.0"), "must name the target version");
        assert!(detail.contains("5.38.2"), "must name the stuck version");
        assert!(
            detail.contains("/Users/test/Library/pnpm/hq"),
            "must name the shadowing binary; got {detail}"
        );
    }

    /// Convergence must be judged on the binary the app EXECUTES. Anchoring it
    /// to `get_local_version` would accept the `npm root -g` fallback — which,
    /// for exactly the pnpm/Homebrew layouts this PR is about, reports the copy
    /// npm just wrote while the resolved executable is untouched. That trades a
    /// loud reinstall loop for a silent "up to date" lie.
    #[test]
    #[cfg(unix)]
    fn resolved_hq_version_never_falls_back_to_the_npm_root_reading() {
        use std::io::Write;
        let tmp = tempfile::TempDir::new().unwrap();

        // A pnpm-style FLAT shim: a real script, not a symlink into any package
        // tree, with no `@indigoai-us/hq-cli/package.json` above it.
        let shim_dir = tmp.path().join("Library/pnpm");
        std::fs::create_dir_all(&shim_dir).unwrap();
        let shim = shim_dir.join("hq");
        std::fs::File::create(&shim)
            .unwrap()
            .write_all(b"#!/bin/sh\nexit 1\n")
            .unwrap();

        // A newer npm-global install sitting elsewhere on the same machine —
        // the copy `npm root -g` would report. It must NOT be picked up here.
        let pkg_dir = tmp
            .path()
            .join("npm-global/lib/node_modules/@indigoai-us/hq-cli");
        std::fs::create_dir_all(&pkg_dir).unwrap();
        std::fs::File::create(pkg_dir.join("package.json"))
            .unwrap()
            .write_all(br#"{"name":"@indigoai-us/hq-cli","version":"5.79.0"}"#)
            .unwrap();

        // Binary-anchoring fails and the shim exits non-zero, so both probes
        // come back empty rather than borrowing the unrelated 5.79.0.
        assert_eq!(resolved_hq_version(&shim.to_string_lossy()), None);
        // ...and an unresolved `hq` is never treated as a version.
        assert_eq!(resolved_hq_version("hq"), None);
    }

    /// A resolvable npm-layout binary still reads correctly — the half of the
    /// probe that must keep working for ordinary users.
    #[test]
    #[cfg(unix)]
    fn resolved_hq_version_reads_an_npm_layout_symlink() {
        use std::io::Write;
        let tmp = tempfile::TempDir::new().unwrap();
        let pkg_dir = tmp.path().join("lib/node_modules/@indigoai-us/hq-cli");
        std::fs::create_dir_all(pkg_dir.join("dist")).unwrap();
        std::fs::File::create(pkg_dir.join("package.json"))
            .unwrap()
            .write_all(br#"{"name":"@indigoai-us/hq-cli","version":"5.79.0"}"#)
            .unwrap();
        let real = pkg_dir.join("dist/index.js");
        std::fs::File::create(&real)
            .unwrap()
            .write_all(b"#!/usr/bin/env node\n")
            .unwrap();
        let bin_dir = tmp.path().join("bin");
        std::fs::create_dir_all(&bin_dir).unwrap();
        let link = bin_dir.join("hq");
        std::os::unix::fs::symlink(&real, &link).unwrap();

        assert_eq!(
            resolved_hq_version(&link.to_string_lossy()),
            Some("5.79.0".to_string())
        );
    }

    /// Sentry extras carry the install layout, never the account name. The
    /// shared `before_send` scrubber filters by KEY name only, so ordinary
    /// string extras leak verbatim unless redacted at the call site.
    #[test]
    fn redact_home_strips_the_account_name_everywhere_it_appears() {
        let home = Some("/Users/alice");
        // A bare path value.
        assert_eq!(
            redact_home_in("/Users/alice/Library/pnpm/hq", home),
            "~/Library/pnpm/hq"
        );
        // npm stderr embeds paths mid-string — a prefix strip would miss these,
        // which is why this is a global replace.
        assert_eq!(
            redact_home_in(
                "npm error Error: EACCES: permission denied, mkdir '/Users/alice/Library/lib'",
                home,
            ),
            "npm error Error: EACCES: permission denied, mkdir '~/Library/lib'"
        );
        // Nothing to redact / no home known → unchanged.
        assert_eq!(
            redact_home_in("/opt/homebrew/bin/hq", home),
            "/opt/homebrew/bin/hq"
        );
        assert_eq!(redact_home_in("/Users/alice/x", None), "/Users/alice/x");
        // `/` as home would otherwise shred every path in the string.
        assert_eq!(
            redact_home_in("/Users/alice/x", Some("/")),
            "/Users/alice/x"
        );
    }

    #[test]
    fn npm_prefix_from_windows_hq_cmd_uses_its_parent_directory() {
        assert_eq!(
            npm_prefix_from_hq_bin(
                "C:/Users/test/AppData/Local/IndigoHQ/toolchain/npm-prefix/hq.cmd"
            ),
            Some("C:/Users/test/AppData/Local/IndigoHQ/toolchain/npm-prefix".to_string()),
            "Windows global npm shims live directly in <prefix>, not <prefix>/bin"
        );
    }

    #[test]
    fn version_from_windows_hq_cmd_reads_sibling_node_modules_package() {
        let tmp = tempfile::TempDir::new().unwrap();
        let prefix = tmp.path().join("npm-prefix");
        let pkg_dir = prefix.join("node_modules/@indigoai-us/hq-cli");
        std::fs::create_dir_all(&pkg_dir).unwrap();
        std::fs::write(
            pkg_dir.join("package.json"),
            br#"{"name":"@indigoai-us/hq-cli","version":"5.79.0"}"#,
        )
        .unwrap();
        let shim = prefix.join("hq.cmd");
        std::fs::write(
            &shim,
            b"@node \"%~dp0\\node_modules\\@indigoai-us\\hq-cli\\dist\\index.js\" %*\r\n",
        )
        .unwrap();

        assert_eq!(
            version_from_hq_binary(&shim),
            Some("5.79.0".to_string()),
            "Windows npm shims are siblings of node_modules, not symlinks into the package"
        );
    }

    // The exact npm stderr behind HQ-SYNC-WEB-Y (exit 243, 7 users): a root-
    // owned global prefix the menubar app can't write to without sudo.
    const REAL_EACCES_STDERR: &str = "npm error code EACCES\n\
        npm error syscall mkdir\n\
        npm error path /usr/local/lib/node_modules/@indigoai-us\n\
        npm error errno -13\n\
        npm error Error: EACCES: permission denied, mkdir \
        '/usr/local/lib/node_modules/@indigoai-us'";

    #[test]
    fn prefix_permission_failure_detects_the_sudo_case() {
        assert!(is_prefix_permission_failure(
            REAL_EACCES_STDERR,
            Some("/usr/local"),
        ));
        assert!(is_prefix_permission_failure(
            "Error: permission denied, mkdir 'C:\\Program Files\\nodejs\\node_modules'",
            Some("C:\\Program Files\\nodejs"),
        ));
    }

    #[test]
    fn prefix_permission_failure_requires_the_selected_npm_target_path() {
        // A bare EACCES and permission errors elsewhere must stay loud. The
        // previous broad match silently discarded these real failures.
        assert!(!is_prefix_permission_failure(
            "npm error EACCES",
            Some("/usr/local")
        ));
        assert!(!is_prefix_permission_failure(
            "Error: EACCES: permission denied, open '/Users/me/.npm/_cacache/index-v5'",
            Some("/usr/local"),
        ));
        assert!(!is_prefix_permission_failure(
            "Error: permission denied, mkdir '/opt/homebrew/lib/node_modules'",
            Some("/usr/local"),
        ));
        assert!(!is_prefix_permission_failure(REAL_EACCES_STDERR, None));
        assert!(!is_prefix_permission_failure(
            "npm error network request to https://registry.npmjs.org failed: ETIMEDOUT",
            Some("/usr/local"),
        ));
        assert!(!is_prefix_permission_failure(
            "npm error code ENOSPC: no space left on device",
            Some("/usr/local"),
        ));
        assert!(!is_prefix_permission_failure("", Some("/usr/local")));
    }

    #[test]
    fn install_failure_report_skips_expected_eacces() {
        // HQ-SYNC-WEB-Y: the exit-243 EACCES flood must NOT be reported to
        // Sentry — it's an expected client-side environment fault (root-owned
        // npm prefix needs sudo) with a copy-the-command UI fallback. `None`
        // here is exactly what makes `report_install_failure` skip the capture.
        assert_eq!(
            install_failure_report(Some(243), REAL_EACCES_STDERR, Some("/usr/local")),
            None
        );
    }

    #[test]
    fn exit_one_permission_failure_outside_the_selected_prefix_is_captured() {
        let detail = "npm error code EACCES\nnpm error path /Users/me/.npm/_cacache/index-v5";
        assert_eq!(
            classify_install_failure(Some(1), detail, Some("/usr/local")),
            InstallFailureKind::Unexpected
        );
        assert_eq!(
            install_failure_report(Some(1), detail, Some("/usr/local")),
            Some("[hq-cli-update] install failed (exit 1)".to_string()),
        );
    }

    #[test]
    fn npm_permission_tags_classify_cache_prefix_and_other_without_paths() {
        let cache_detail = "npm error code EACCES\nnpm error path /Users/me/.npm/_cacache/tmp";
        let prefix_detail =
            "npm error code EACCES\nnpm error path /usr/local/lib/node_modules/@indigoai-us";
        let other_detail = "npm error code EACCES\nnpm error path /tmp/unrelated-file";

        assert!(is_npm_permission_failure(cache_detail));
        assert_eq!(npm_failure_site(cache_detail, Some("/usr/local")), "cache");
        assert_eq!(
            npm_failure_site(prefix_detail, Some("/usr/local")),
            "prefix"
        );
        assert_eq!(npm_failure_site(other_detail, Some("/usr/local")), "other");
        assert_eq!(
            npm_failure_site("npm error network ETIMEDOUT", None),
            "other"
        );
    }

    #[test]
    fn npm_error_code_tags_are_allow_listed_and_path_free() {
        assert_eq!(
            npm_error_code("npm error code EACCES\nnpm error path /Users/alice/.npm/_cacache"),
            "EACCES"
        );
        assert_eq!(
            npm_error_code("npm error code ETARGET\nnpm error notarget No matching version found"),
            "ETARGET"
        );
        assert_eq!(
            npm_error_code("npm error code ../../Users/alice/.npm/_cacache"),
            "unknown"
        );
        assert_eq!(
            npm_error_code("npm error path /Users/alice/.npm/_cacache"),
            "unknown"
        );
    }

    #[test]
    fn transient_registry_failures_are_suppressed_but_keep_actionable_ui_text() {
        const ETARGET_STDERR: &str = "npm error code ETARGET\n\
            npm error notarget No matching version found for @aws-sdk/core@^3.977.4";
        const ECONNRESET_STDERR: &str = "npm error code ECONNRESET\n\
            npm error network request to https://registry.npmjs.org failed";

        for detail in [ETARGET_STDERR, ECONNRESET_STDERR] {
            assert_eq!(
                classify_install_failure(Some(1), detail, Some("/usr/local")),
                InstallFailureKind::ExpectedTransientRegistry,
                "{detail}"
            );
            assert_eq!(
                install_failure_report(Some(1), detail, Some("/usr/local")),
                None,
                "{detail}"
            );
            let fallback = install_failure_detail(Some(1), detail, Some("/usr/local"));
            assert!(fallback.contains("temporarily unavailable or was mid-publish"));
            assert!(fallback.contains("retry automatically"));
        }
    }

    #[test]
    fn existing_failure_buckets_take_priority_over_transient_markers() {
        let prefix_permission_with_network_text = "npm error code EACCES\n\
            npm error path /usr/local/lib/node_modules/@indigoai-us\n\
            npm error network ETIMEDOUT";
        assert_eq!(
            classify_install_failure(
                Some(1),
                prefix_permission_with_network_text,
                Some("/usr/local")
            ),
            InstallFailureKind::ExpectedPrefixPermission
        );

        let windows_eperm_with_network_text = "npm error code EPERM\n\
            npm error errno -4048\n\
            npm error network ECONNRESET";
        assert_eq!(
            classify_install_failure(Some(1), windows_eperm_with_network_text, None),
            InstallFailureKind::ExpectedWindowsLockedBinary
        );
    }

    #[test]
    fn install_failure_report_skips_expected_windows_abort_codes() {
        // Windows exposes NTSTATUS as a signed i32. These are local process
        // interruptions/Node aborts, not an HQ updater incident, and should
        // remain actionable only through the returned UI error and local log.
        for code in [WINDOWS_CONTROL_C_EXIT, WINDOWS_ABORT_EXIT] {
            assert_eq!(
                classify_install_failure(Some(code), "", None),
                InstallFailureKind::ExpectedWindowsAbort
            );
            assert_eq!(install_failure_report(Some(code), "", None), None);
            assert_eq!(
                InstallFailureKind::ExpectedWindowsAbort.fingerprint_component(),
                "expected-windows-abort"
            );
        }
    }

    #[test]
    fn empty_windows_abort_output_gets_actionable_recovery_text() {
        let detail = install_failure_detail(Some(WINDOWS_ABORT_EXIT), "", None);
        assert!(detail.contains("Windows child process"));
        assert!(detail.contains("fresh terminal"));
    }

    // HQ-DESKTOP-3N: a Windows `EPERM` install failure (exit -4048, the libuv
    // errno) means npm could not replace the locked/in-use `hq` binary. It is a
    // local-machine condition with the copy-the-command fallback — NOT an
    // updater defect — so it must classify as expected and never page Sentry.
    #[test]
    fn windows_eperm_exit_code_is_an_expected_locked_binary_failure() {
        // The exact event behind HQ-DESKTOP-3N: install exited -4048 with no
        // useful stderr tail. Old behavior classified this as Unexpected and
        // captured "[hq-cli-update] install failed (exit -4048)" at Error level.
        assert_eq!(
            classify_install_failure(Some(-4048), "", None),
            InstallFailureKind::ExpectedWindowsLockedBinary
        );
        // Suppressed from Sentry (the regression: this used to return Some(...)).
        assert_eq!(install_failure_report(Some(-4048), "", None), None);
        assert_eq!(
            InstallFailureKind::ExpectedWindowsLockedBinary.fingerprint_component(),
            "expected-windows-locked-binary"
        );
        // Empty stderr falls back to actionable locked-binary recovery text.
        let detail = install_failure_detail(Some(-4048), "", None);
        assert!(detail.contains("locked or in use"), "got: {detail}");
        assert!(detail.contains("retry"), "got: {detail}");
    }

    #[test]
    fn windows_eperm_in_stderr_is_also_treated_as_locked_binary() {
        // npm can bubble the same libuv EPERM through stderr (with a non-4048
        // process code) while renaming/unlinking the package it is replacing.
        const EPERM_STDERR: &str = "npm error code EPERM\n\
            npm error syscall unlink\n\
            npm error errno -4048\n\
            npm error EPERM: operation not permitted, unlink \
            'C:\\Users\\me\\AppData\\Roaming\\npm\\hq.cmd'";
        assert_eq!(
            classify_install_failure(Some(1), EPERM_STDERR, None),
            InstallFailureKind::ExpectedWindowsLockedBinary
        );
        assert_eq!(install_failure_report(Some(1), EPERM_STDERR, None), None);
        assert!(is_windows_locked_binary_failure(Some(1), EPERM_STDERR));
    }

    #[test]
    fn locked_binary_detection_excludes_eacces_and_unrelated_failures() {
        // EACCES (the root-owned-prefix sudo case) is a DIFFERENT expected kind,
        // classified by prefix-permission — it must not read as locked-binary.
        assert!(!is_windows_locked_binary_failure(
            Some(243),
            REAL_EACCES_STDERR
        ));
        assert_eq!(
            classify_install_failure(Some(243), REAL_EACCES_STDERR, Some("/usr/local")),
            InstallFailureKind::ExpectedPrefixPermission
        );
        // Transient registry failures are a distinct expected kind and must not
        // be mistaken for Windows locked-binary failures.
        assert!(!is_windows_locked_binary_failure(
            Some(1),
            "npm error network request to https://registry.npmjs.org failed: ETIMEDOUT"
        ));
        assert_eq!(
            classify_install_failure(Some(1), "npm error network ETIMEDOUT", None),
            InstallFailureKind::ExpectedTransientRegistry
        );
        assert!(!is_windows_locked_binary_failure(Some(1), ""));
    }

    #[test]
    fn install_failure_report_captures_genuine_failures() {
        // A real, unexpected failure stays loud — `Some(message)` drives the
        // Error-level capture.
        assert_eq!(
            install_failure_report(Some(1), "npm error code ENOSPC\nnpm error disk full", None),
            Some("[hq-cli-update] install failed (exit 1)".to_string()),
        );
        // Killed by signal (no exit code) still reports, with the signal label.
        assert_eq!(
            install_failure_report(None, "npm error code ENOSPC\nnpm error disk full", None),
            Some("[hq-cli-update] install failed (exit signal/none)".to_string()),
        );
        assert_eq!(
            classify_install_failure(Some(1), "npm error code ENOSPC\nnpm error disk full", None),
            InstallFailureKind::Unexpected
        );
        assert_eq!(
            InstallFailureKind::Unexpected.fingerprint_component(),
            "unexpected"
        );
    }

    #[test]
    fn dismissal_suppresses_same_and_older_versions() {
        // Nothing dismissed → always show.
        assert!(!suppress_for_dismissal("5.38.2", None));
        // Dismissed the exact current version → stay hidden.
        assert!(suppress_for_dismissal("5.38.2", Some("5.38.2")));
        // A version older than what was dismissed → also hidden (can't regress
        // the user back into a notice for something they already moved past).
        assert!(suppress_for_dismissal("5.38.1", Some("5.38.2")));
    }

    #[test]
    fn dismissal_clears_when_a_newer_version_appears() {
        // The headline example: dismissing 5.38.x stays dismissed until 5.39.
        assert!(!suppress_for_dismissal("5.39.0", Some("5.38.2")));
        // A patch bump past the dismissed version re-surfaces once (a freshly
        // published fix is exactly what stale users need to see) — still
        // dismissible afterwards.
        assert!(!suppress_for_dismissal("5.38.3", Some("5.38.2")));
        // Numeric, not lexical: 5.41 > 5.9 even though '4' < '9'.
        assert!(!suppress_for_dismissal("5.41.0", Some("5.9.0")));
    }

    #[test]
    fn cmp_semver_missing_segments_default_to_zero() {
        // Don't panic on weird inputs — under-report rather than crash.
        assert_eq!(cmp_semver("5", "5.0.0"), Ordering::Equal);
        assert_eq!(cmp_semver("", "5.12.0"), Ordering::Less);
        assert_eq!(cmp_semver("not-a-version", "0.0.0"), Ordering::Equal);
    }

    #[test]
    fn version_if_hq_cli_requires_matching_name() {
        use std::io::Write;
        let tmp = tempfile::TempDir::new().unwrap();
        // Wrong name → None, even with a version present.
        let wrong = tmp.path().join("wrong.json");
        std::fs::File::create(&wrong)
            .unwrap()
            .write_all(br#"{"name":"left-pad","version":"9.9.9"}"#)
            .unwrap();
        assert_eq!(version_if_hq_cli(&wrong), None);
        // Right name → version.
        let right = tmp.path().join("package.json");
        std::fs::File::create(&right)
            .unwrap()
            .write_all(br#"{"name":"@indigoai-us/hq-cli","version":"5.12.3"}"#)
            .unwrap();
        assert_eq!(version_if_hq_cli(&right), Some("5.12.3".to_string()));
    }

    /// Direct regression test for the prefix-mismatch bug: an `hq` symlink in
    /// one prefix pointing into the package tree in another must still resolve
    /// the installed version, with no dependence on `npm root -g`.
    #[test]
    #[cfg(unix)]
    fn version_from_hq_binary_follows_symlink() {
        use std::io::Write;
        let tmp = tempfile::TempDir::new().unwrap();
        // npm-global-style tree:
        //   <tmp>/lib/node_modules/@indigoai-us/hq-cli/{package.json, bin/hq.js}
        //   <tmp>/bin/hq -> .../hq-cli/bin/hq.js
        let pkg_dir = tmp.path().join("lib/node_modules/@indigoai-us/hq-cli");
        std::fs::create_dir_all(pkg_dir.join("bin")).unwrap();
        std::fs::File::create(pkg_dir.join("package.json"))
            .unwrap()
            .write_all(br#"{"name":"@indigoai-us/hq-cli","version":"5.40.1"}"#)
            .unwrap();
        let real_bin = pkg_dir.join("bin/hq.js");
        std::fs::File::create(&real_bin)
            .unwrap()
            .write_all(b"#!/usr/bin/env node\n")
            .unwrap();
        let bin_dir = tmp.path().join("bin");
        std::fs::create_dir_all(&bin_dir).unwrap();
        let link = bin_dir.join("hq");
        std::os::unix::fs::symlink(&real_bin, &link).unwrap();

        assert_eq!(version_from_hq_binary(&link), Some("5.40.1".to_string()));
    }

    /// A bare `hq` (binary not found, resolver returned the literal name) must
    /// not be canonicalized into a bogus version.
    #[test]
    fn version_from_hq_binary_missing_returns_none() {
        let tmp = tempfile::TempDir::new().unwrap();
        assert_eq!(
            version_from_hq_binary(&tmp.path().join("does-not-exist/hq")),
            None
        );
    }
}
