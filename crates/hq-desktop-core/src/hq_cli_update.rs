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

/// A closed, privacy-safe outcome for one installed-version probe. These
/// values are deliberately the only probe data allowed into Sentry: they
/// identify the failed stage without carrying a path, command output, account
/// name, environment value, or other machine-specific data.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum VersionProbeOutcome {
    NotAttempted,
    Succeeded,
    CanonicalizeFailed,
    PackageNotFound,
    ManifestReadOrParseFailed,
    ProcessSpawnFailed,
    InterpreterNotFound,
    NonzeroExit,
    InvalidUtf8,
    EmptyOutput,
}

/// A closed classification of the resolved hq binary's parent layout. This is
/// deliberately separate from the binary-anchor read outcome: a flat bin
/// directory is a normal reason the manifest lookup can miss, while an npm
/// prefix-shaped layout may still have an unreadable manifest for another
/// reason. No path is retained or sent to telemetry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BinaryAnchorShape {
    NotAttempted,
    NpmPrefix,
    FlatGlobalBin,
    UnresolvableParent,
}

/// The three ordered probes used to discover an installed hq CLI version.
/// The shape remains fixed even when a successful earlier probe means a later
/// one must not execute.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LocalVersionProbeDiagnostics {
    pub binary_anchor: VersionProbeOutcome,
    pub npm_root: VersionProbeOutcome,
    pub hq_version: VersionProbeOutcome,
    pub binary_anchor_shape: BinaryAnchorShape,
}

impl LocalVersionProbeDiagnostics {
    fn not_attempted() -> Self {
        Self {
            binary_anchor: VersionProbeOutcome::NotAttempted,
            npm_root: VersionProbeOutcome::NotAttempted,
            hq_version: VersionProbeOutcome::NotAttempted,
            binary_anchor_shape: BinaryAnchorShape::NotAttempted,
        }
    }
}

fn binary_anchor_shape(hq_bin: &Path) -> BinaryAnchorShape {
    let Some(parent) = hq_bin
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    else {
        return BinaryAnchorShape::UnresolvableParent;
    };
    let is_windows_npm_shim = hq_bin
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| matches!(ext.to_ascii_lowercase().as_str(), "cmd" | "bat"))
        .unwrap_or(false);
    if is_windows_npm_shim
        || matches!(
            parent.file_name().and_then(|name| name.to_str()),
            Some("bin")
        )
    {
        BinaryAnchorShape::NpmPrefix
    } else {
        BinaryAnchorShape::FlatGlobalBin
    }
}

/// The result of one version-discovery pass. `hq_installed` preserves the
/// absent-hq distinction so callers can stay quiet for people who do not have
/// the CLI while still reporting an installed-but-unreadable CLI.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalVersionProbeResult {
    pub local: Option<String>,
    pub hq_installed: bool,
    pub probes: LocalVersionProbeDiagnostics,
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
    match read_hq_cli_package_version(pkg) {
        Ok(version) => version,
        Err(()) => None,
    }
}

/// Read an hq-cli manifest while retaining enough information for the caller
/// to distinguish an absent package from an unreadable or malformed one. A
/// package for a different npm module is a normal ancestor-walk miss.
fn read_hq_cli_package_version(pkg: &Path) -> Result<Option<String>, ()> {
    let bytes = match std::fs::read(pkg) {
        Ok(bytes) => bytes,
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
            ) =>
        {
            return Ok(None)
        }
        Err(_) => return Err(()),
    };
    let parsed: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| ())?;
    if parsed.get("name").and_then(|name| name.as_str()) != Some("@indigoai-us/hq-cli") {
        return Ok(None);
    }
    parsed
        .get("version")
        .and_then(|version| version.as_str())
        .map(|version| Some(version.to_string()))
        .ok_or(())
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
    version_from_hq_binary_probe(hq_bin).0
}

fn version_from_hq_binary_probe(hq_bin: &Path) -> (Option<String>, VersionProbeOutcome) {
    let real = match std::fs::canonicalize(hq_bin) {
        Ok(real) => real,
        Err(_) => return (None, VersionProbeOutcome::CanonicalizeFailed),
    };
    let mut saw_manifest_failure = false;
    for ancestor in real.ancestors() {
        match read_hq_cli_package_version(&ancestor.join("package.json")) {
            Ok(Some(version)) => return (Some(version), VersionProbeOutcome::Succeeded),
            Ok(None) => {}
            Err(()) => saw_manifest_failure = true,
        }
    }
    // Windows npm does not create a symlink into the package tree. It writes
    // `<prefix>\hq.cmd` beside `<prefix>\node_modules`, so canonicalizing the
    // shim can never reach package.json through its ancestors. Anchor the
    // fallback to that exact shim's prefix instead of asking npm for its
    // unrelated default global root.
    let hq_bin_str = hq_bin.to_string_lossy();
    if let Some(prefix) = npm_prefix_from_hq_bin(&hq_bin_str) {
        for package_json in hq_cli_package_json_candidates(Path::new(&prefix), hq_bin) {
            match read_hq_cli_package_version(&package_json) {
                Ok(Some(version)) => return (Some(version), VersionProbeOutcome::Succeeded),
                Ok(None) => {}
                Err(()) => saw_manifest_failure = true,
            }
        }
    }
    let outcome = if saw_manifest_failure {
        VersionProbeOutcome::ManifestReadOrParseFailed
    } else {
        VersionProbeOutcome::PackageNotFound
    };
    (None, outcome)
}

/// Parse `hq --version` output into a bare version string. Last-resort only:
/// the CLI's `index.ts` carries a hardcoded `.version("…")` string that can
/// lag the published npm version (same gotcha documented in
/// `util::hq_resolver`), so this may be stale. We still prefer a possibly-
/// stale number over returning None and silently disabling the nag.
pub fn hq_version_string(bin: &Path) -> Option<String> {
    hq_version_string_probe(bin, &paths::child_path()).0
}

fn hq_version_string_probe(bin: &Path, path: &str) -> (Option<String>, VersionProbeOutcome) {
    let bin = bin.to_string_lossy();
    let mut cmd = paths::spawn_command(&bin, &[]);
    let out = match cmd.arg("--version").env("PATH", path).output() {
        Ok(output) => output,
        Err(_) => return (None, VersionProbeOutcome::ProcessSpawnFailed),
    };
    if !out.status.success() {
        return (
            None,
            if out.status.code() == Some(127) {
                VersionProbeOutcome::InterpreterNotFound
            } else {
                VersionProbeOutcome::NonzeroExit
            },
        );
    }
    let s = match String::from_utf8(out.stdout) {
        Ok(stdout) => stdout,
        Err(_) => return (None, VersionProbeOutcome::InvalidUtf8),
    };
    let Some(line) = s.lines().next() else {
        return (None, VersionProbeOutcome::EmptyOutput);
    };
    let line = line.trim();
    let cleaned = line.trim_start_matches('v').trim();
    if cleaned.is_empty() {
        (None, VersionProbeOutcome::EmptyOutput)
    } else {
        (Some(cleaned.to_string()), VersionProbeOutcome::Succeeded)
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
    get_local_version_diagnostics().local
}

/// Discover the local version once and retain the bounded outcomes needed to
/// diagnose the otherwise-undifferentiated None result.
pub fn get_local_version_diagnostics() -> LocalVersionProbeResult {
    // Keep the resolver call order unchanged: do not look up npm when the
    // binary-anchored package probe has already succeeded.
    let hq = paths::resolve_bin("hq");
    if hq != "hq" {
        let hq_path = Path::new(&hq);
        let binary_anchor_shape = binary_anchor_shape(hq_path);
        let (local, binary_anchor) = version_from_hq_binary_probe(hq_path);
        if let Some(local) = local {
            return LocalVersionProbeResult {
                local: Some(local),
                hq_installed: true,
                probes: LocalVersionProbeDiagnostics {
                    binary_anchor,
                    binary_anchor_shape,
                    ..LocalVersionProbeDiagnostics::not_attempted()
                },
            };
        }
        let npm = paths::resolve_bin("npm");
        let npm = (npm != "npm").then_some(npm.as_str());
        return probe_local_version_after_binary(
            Some(hq_path),
            binary_anchor,
            binary_anchor_shape,
            npm,
            &paths::child_path(),
        );
    }

    // Preserve the legacy npm-root fallback even when `hq` is absent: an npm
    // package may exist before its bin-link is created. The result still marks
    // hq as absent, so an all-fail check remains a quiet no-op.
    let npm = paths::resolve_bin("npm");
    let npm = (npm != "npm").then_some(npm.as_str());
    probe_local_version_after_binary(
        None,
        VersionProbeOutcome::NotAttempted,
        BinaryAnchorShape::NotAttempted,
        npm,
        &paths::child_path(),
    )
}

#[cfg(test)]
fn probe_local_version(
    hq: Option<&Path>,
    npm: Option<&str>,
    path: &str,
) -> LocalVersionProbeResult {
    let (local, binary_anchor) = match hq {
        Some(hq) => version_from_hq_binary_probe(hq),
        None => (None, VersionProbeOutcome::NotAttempted),
    };
    let binary_anchor_shape = hq
        .map(binary_anchor_shape)
        .unwrap_or(BinaryAnchorShape::NotAttempted);
    if let Some(local) = local {
        return LocalVersionProbeResult {
            local: Some(local),
            hq_installed: hq.is_some(),
            probes: LocalVersionProbeDiagnostics {
                binary_anchor,
                binary_anchor_shape,
                ..LocalVersionProbeDiagnostics::not_attempted()
            },
        };
    }
    probe_local_version_after_binary(hq, binary_anchor, binary_anchor_shape, npm, path)
}

fn probe_local_version_after_binary(
    hq: Option<&Path>,
    binary_anchor: VersionProbeOutcome,
    binary_anchor_shape: BinaryAnchorShape,
    npm: Option<&str>,
    path: &str,
) -> LocalVersionProbeResult {
    let hq_installed = hq.is_some();
    let (npm_local, npm_root) = match npm {
        Some(npm) => read_installed_version_probe(npm, path),
        None => (None, VersionProbeOutcome::NotAttempted),
    };
    if let Some(local) = npm_local {
        return LocalVersionProbeResult {
            local: Some(local),
            hq_installed,
            probes: LocalVersionProbeDiagnostics {
                binary_anchor,
                npm_root,
                hq_version: VersionProbeOutcome::NotAttempted,
                binary_anchor_shape,
            },
        };
    }

    let (local, hq_version) = match hq {
        Some(hq) => hq_version_string_probe(hq, path),
        None => (None, VersionProbeOutcome::NotAttempted),
    };
    LocalVersionProbeResult {
        local,
        hq_installed,
        probes: LocalVersionProbeDiagnostics {
            binary_anchor,
            npm_root,
            hq_version,
            binary_anchor_shape,
        },
    }
}

/// An unreadable version is actionable only when the hq resolver found a
/// binary. A missing hq remains a deliberate quiet no-op.
pub fn should_report_unreadable_version(result: &LocalVersionProbeResult) -> bool {
    result.local.is_none() && result.hq_installed
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
/// failed. Scrubbed by `hq_telemetry::before_send` before send. This is the
/// "detection silently degraded" signal the team triages immediately —
/// the exact class that hid a stale CLI behind a missing banner.
pub fn report_unreadable_version(latest: &str, probes: &LocalVersionProbeDiagnostics) {
    sentry::with_scope(
        |scope| {
            scope.set_tag("hq_cli_update_kind", "version-unreadable");
            scope.set_tag("latest", latest);
            scope.set_extra(
                "hq_cli_version_probes",
                serde_json::json!({
                    "binary_anchor": probes.binary_anchor,
                    "npm_root": probes.npm_root,
                    "hq_version": probes.hq_version,
                    "binary_anchor_shape": probes.binary_anchor_shape,
                })
                .into(),
            );
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
/// on Windows. It can also fail while linking `<prefix>/bin/hq` or one of the
/// Windows hq shim forms. Normalize separators so an event captured on either
/// platform follows the same rule.
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
        format!("{prefix}/hq"),
        format!("{prefix}/hq.cmd"),
        format!("{prefix}/hq.ps1"),
    ]
    .iter()
    .any(|target| detail.contains(target))
}

/// Keep the cache-specific diagnostic distinct from an expected selected-prefix
/// failure. It intentionally does not treat an exit code alone as permission
/// evidence: unrelated exit-243 failures must remain reportable.
fn is_npm_permission_failure(detail: &str) -> bool {
    let detail = detail.to_ascii_lowercase();
    detail.contains("eacces")
        || detail.contains("permission denied")
        || detail.contains("errno -13")
}

/// A path-free summary retained for the existing npm-cache telemetry contract.
/// Selected-prefix failures take precedence, so the two categories do not
/// overlap; all other shapes remain reportable as `other`.
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NpmPathShape {
    SelectedPrefixNodeModules,
    GlobalLibNodeModules,
    BinHq,
    NpmCache,
    Other,
    None,
}

impl NpmPathShape {
    fn tag_value(self) -> &'static str {
        match self {
            Self::SelectedPrefixNodeModules => "selected-prefix-node-modules",
            Self::GlobalLibNodeModules => "global-lib-node-modules",
            Self::BinHq => "bin-hq",
            Self::NpmCache => "npm-cache",
            Self::Other => "other",
            Self::None => "none",
        }
    }
}

fn npm_path_value(detail: &str) -> Option<String> {
    detail.lines().find_map(|line| {
        let line = line.trim();
        let lower = line.to_ascii_lowercase();
        let marker = if lower.starts_with("npm error path ") {
            "npm error path "
        } else if lower.starts_with("npm err! path ") {
            "npm err! path "
        } else {
            return None;
        };
        Some(
            line[marker.len()..]
                .trim()
                .trim_matches(['\'', '\"', '`'])
                .replace('\\', "/"),
        )
    })
}

fn normalized_npm_path(detail: &str) -> Option<String> {
    npm_path_value(detail).map(|path| path.to_ascii_lowercase())
}

fn npm_path_shape(detail: &str, prefix: Option<&str>) -> NpmPathShape {
    let Some(path) = normalized_npm_path(detail) else {
        return NpmPathShape::None;
    };

    if path.contains("/.npm/_cacache") || path.contains("/npm-cache/") {
        return NpmPathShape::NpmCache;
    }

    if let Some(prefix) = prefix {
        let prefix = prefix
            .trim()
            .trim_end_matches(['/', '\\'])
            .to_ascii_lowercase()
            .replace('\\', "/");
        if !prefix.is_empty() {
            if [
                format!("{prefix}/lib/node_modules"),
                format!("{prefix}/node_modules"),
            ]
            .iter()
            .any(|target| path.contains(target))
            {
                return NpmPathShape::SelectedPrefixNodeModules;
            }
            if [
                format!("{prefix}/bin/hq"),
                format!("{prefix}/hq"),
                format!("{prefix}/hq.cmd"),
                format!("{prefix}/hq.ps1"),
            ]
            .iter()
            .any(|target| path == *target)
            {
                return NpmPathShape::BinHq;
            }
        }
    }

    if [
        "/lib/node_modules/@indigoai-us",
        "/node_modules/@indigoai-us",
    ]
    .iter()
    .any(|target| path.ends_with(target) || path.contains(&format!("{target}/hq-cli")))
    {
        NpmPathShape::GlobalLibNodeModules
    } else if path.ends_with("/bin/hq")
        || ["/npm/hq", "/npm/hq.cmd", "/npm/hq.ps1"]
            .iter()
            .any(|target| path.ends_with(target))
    {
        NpmPathShape::BinHq
    } else {
        NpmPathShape::Other
    }
}

fn npm_error_code(detail: &str) -> String {
    let code = detail.lines().find_map(|raw_line| {
        let line = raw_line.trim();
        let lower = line.to_ascii_lowercase();
        if lower.starts_with("npm error code ") {
            Some(&line["npm error code ".len()..])
        } else if lower.starts_with("npm err! code ") {
            Some(&line["npm err! code ".len()..])
        } else {
            None
        }
        .and_then(|value| value.split_whitespace().next())
    });

    match code {
        None => "none".to_string(),
        Some(code)
            if (1..=32).contains(&code.len())
                && code
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_') =>
        {
            code.to_ascii_uppercase()
        }
        Some(_) => "unrecognized".to_string(),
    }
}

/// Temporary npm registry and resolution failures already retry on the next
/// scheduled update. Preserve this current-main classification while rebasing
/// the permission diagnostics so a telemetry fix cannot make them noisy again.
fn is_expected_transient_registry_failure(detail: &str) -> bool {
    matches!(
        npm_error_code(detail).as_str(),
        "ETARGET" | "ECONNRESET" | "ETIMEDOUT" | "ENOTFOUND" | "EAI_AGAIN" | "ERR_SOCKET_TIMEOUT"
    )
}

fn npm_syscall(detail: &str) -> &'static str {
    let syscall = detail.lines().find_map(|line| {
        let line = line.trim().to_ascii_lowercase();
        line.strip_prefix("npm error syscall ")
            .or_else(|| line.strip_prefix("npm err! syscall "))
            .and_then(|value| value.split_whitespace().next())
            .map(str::to_string)
    });
    match syscall.as_deref() {
        Some("mkdir") => "mkdir",
        Some("open") => "open",
        Some("rename") => "rename",
        Some("unlink") => "unlink",
        Some("rmdir") => "rmdir",
        Some("write") => "write",
        _ => "unknown",
    }
}

/// Build the diagnostic Sentry can safely retain for an unexpected npm
/// install failure. Raw stderr is intentionally excluded: project default
/// scrubbing treats it as sensitive free text and replaces the whole value.
/// Every field here is either a closed enumeration, a boolean, or a number.
fn npm_diagnostics_summary(
    exit_code: &str,
    detail: &str,
    path_shape: NpmPathShape,
    prefix_known: bool,
    eacces: bool,
) -> String {
    format!(
        "error_code={} syscall={} path_shape={} prefix_known={} eacces={} exit_code={} stderr_len={}",
        npm_error_code(detail),
        npm_syscall(detail),
        path_shape.tag_value(),
        prefix_known,
        eacces,
        exit_code,
        detail.len(),
    )
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct NpmLifecycleFailure {
    failed: bool,
    package: Option<String>,
}

fn is_safe_npm_package_part(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'_' | b'-')
        })
}

fn is_safe_npm_package_name(value: &str) -> bool {
    if !(1..=64).contains(&value.len()) {
        return false;
    }
    if let Some(scoped) = value.strip_prefix('@') {
        let Some((scope, package)) = scoped.split_once('/') else {
            return false;
        };
        !package.contains('/')
            && is_safe_npm_package_part(scope)
            && is_safe_npm_package_part(package)
    } else {
        !value.contains('/') && is_safe_npm_package_part(value)
    }
}

fn npm_lifecycle_failure(detail: &str) -> NpmLifecycleFailure {
    // Treat this as a lifecycle failure only when npm supplied both of its
    // structured signals: a command-failed line and a lifecycle-specific
    // code. In particular, an OS errno (for example ENOENT or EACCES) that
    // happens to appear beside build output must stay on the Unexpected path.
    let npm_code = npm_error_code(detail);
    let lifecycle_code =
        npm_code.bytes().all(|byte| byte.is_ascii_digit()) || npm_code == "ELIFECYCLE";
    let command_failed = detail.lines().any(|line| {
        let line = line.trim().to_ascii_lowercase();
        line.starts_with("npm error command failed") || line.starts_with("npm err! command failed")
    });
    if !(lifecycle_code && command_failed) {
        return NpmLifecycleFailure {
            failed: false,
            package: None,
        };
    }

    let package = npm_path_value(detail)
        .and_then(|path| {
            path.rsplit_once("/node_modules/")
                .map(|(_, value)| value.to_string())
        })
        .and_then(|path| {
            let mut parts = path.split('/');
            let first = parts.next()?;
            if first.starts_with('@') {
                Some(format!("{first}/{}", parts.next()?))
            } else {
                Some(first.to_string())
            }
        })
        .filter(|package| is_safe_npm_package_name(package));

    NpmLifecycleFailure {
        failed: true,
        package,
    }
}

fn is_indigoai_owned_npm_package(package: &str) -> bool {
    package.starts_with("@indigoai-us/")
}

fn is_third_party_npm_lifecycle_failure(detail: &str) -> bool {
    let lifecycle = npm_lifecycle_failure(detail);
    lifecycle.failed
        && lifecycle
            .package
            .as_deref()
            .is_some_and(|package| !is_indigoai_owned_npm_package(package))
}

/// A normalized local-log record for an npm attempt. It deliberately contains
/// only bounded npm code and path-shape values, never raw npm output or paths.
pub fn npm_install_attempt_summary(
    exit_code: Option<i32>,
    detail: &str,
    prefix: Option<&str>,
) -> String {
    let exit_code = exit_code
        .map(|code| code.to_string())
        .unwrap_or_else(|| "signal/none".to_string());
    format!(
        "npm_code={} path_shape={} exit_code={}",
        npm_error_code(detail),
        npm_path_shape(detail, prefix).tag_value(),
        exit_code,
    )
}

fn has_eacces_evidence(detail: &str) -> bool {
    let detail = detail.to_ascii_lowercase();
    detail.contains("eacces")
        || detail.contains("permission denied")
        || detail.contains("errno -13")
}

/// Detect the expected local permission failure at an npm global-install
/// target that is not covered by the derived-prefix comparison. This covers
/// both an unknown managed prefix and a known prefix that differs from npm's
/// actual global target. Keep the fallback narrow: it requires permission
/// evidence plus an npm global-install target and never suppresses cache or
/// unrelated-path failures.
pub fn is_global_prefix_permission_failure(_exit_code: Option<i32>, detail: &str) -> bool {
    has_eacces_evidence(detail)
        && matches!(
            npm_path_shape(detail, None),
            NpmPathShape::GlobalLibNodeModules | NpmPathShape::BinHq
        )
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
/// failures stay actionable in the UI/local log and normally do not page
/// Sentry. A bin collision that survived npm's forced remedy is the exception:
/// it stays observable at Warning under its own fingerprint. Third-party
/// lifecycle failures remain Error-level but have a separate fingerprint.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallFailureKind {
    ExpectedPrefixPermission,
    ExpectedWindowsAbort,
    ExpectedWindowsLockedBinary,
    ExpectedTransientRegistry,
    ExpectedBinCollision,
    UnexpectedLifecycle,
    Unexpected,
}

/// A bin collision is expected only when npm's documented `--force` remedy
/// was applied to the final attempt that produced this exact structured npm
/// failure. A bare EEXIST token elsewhere in stderr remains reportable.
pub fn is_npm_bin_collision(detail: &str, prefix: Option<&str>) -> bool {
    npm_error_code(detail) == "EEXIST" && npm_path_shape(detail, prefix) == NpmPathShape::BinHq
}

pub fn classify_install_failure(
    exit_code: Option<i32>,
    detail: &str,
    prefix: Option<&str>,
) -> InstallFailureKind {
    classify_install_failure_with_final_attempt(exit_code, detail, prefix, false)
}

/// Classify a failed npm install with the retry-run's causal context. The
/// default classifier above intentionally uses `false`, so callers that did
/// not run the bounded retry ladder cannot suppress an EEXIST on assumption.
pub fn classify_install_failure_with_final_attempt(
    exit_code: Option<i32>,
    detail: &str,
    prefix: Option<&str>,
    final_attempt_forced: bool,
) -> InstallFailureKind {
    if is_prefix_permission_failure(detail, prefix)
        || is_global_prefix_permission_failure(exit_code, detail)
    {
        InstallFailureKind::ExpectedPrefixPermission
    } else if matches!(exit_code, Some(WINDOWS_CONTROL_C_EXIT | WINDOWS_ABORT_EXIT)) {
        InstallFailureKind::ExpectedWindowsAbort
    } else if is_windows_locked_binary_failure(exit_code, detail) {
        InstallFailureKind::ExpectedWindowsLockedBinary
    } else if is_expected_transient_registry_failure(detail) {
        InstallFailureKind::ExpectedTransientRegistry
    } else if final_attempt_forced && is_npm_bin_collision(detail, prefix) {
        InstallFailureKind::ExpectedBinCollision
    } else if is_third_party_npm_lifecycle_failure(detail) {
        InstallFailureKind::UnexpectedLifecycle
    } else {
        InstallFailureKind::Unexpected
    }
}

impl InstallFailureKind {
    /// A stable grouping key for diagnostics and Sentry. We intentionally keep
    /// expected local failures separate from actual updater defects; the
    /// post-force bin-collision exception remains visible at Warning while the
    /// other expected kinds are not sent by `report_install_failure`.
    pub fn fingerprint_component(self) -> &'static str {
        match self {
            Self::ExpectedPrefixPermission => "expected-prefix-permission",
            Self::ExpectedWindowsAbort => "expected-windows-abort",
            Self::ExpectedWindowsLockedBinary => "expected-windows-locked-binary",
            Self::ExpectedTransientRegistry => "expected-transient-registry",
            Self::ExpectedBinCollision => "expected-bin-collision",
            Self::UnexpectedLifecycle => "unexpected-lifecycle",
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
    install_failure_detail_with_final_attempt(exit_code, detail, prefix, false)
}

pub fn install_failure_detail_with_final_attempt(
    exit_code: Option<i32>,
    detail: &str,
    prefix: Option<&str>,
    final_attempt_forced: bool,
) -> String {
    let kind = classify_install_failure_with_final_attempt(
        exit_code,
        detail,
        prefix,
        final_attempt_forced,
    );
    if kind == InstallFailureKind::ExpectedTransientRegistry {
        return "npm's registry was temporarily unavailable or was mid-publish. The updater will retry automatically on its next scheduled check; you can also retry the copied command shortly."
            .to_string();
    }
    if kind == InstallFailureKind::ExpectedBinCollision {
        return format!(
            "An existing hq shim is blocking this update. Remove or rename the stale shim named in npm's output, then run the copied command in a fresh terminal.\n\n{}",
            detail.trim()
        );
    }
    if npm_lifecycle_failure(detail).failed {
        return "A dependency build step failed while npm was installing hq. Run the copied command in a terminal to see the full build output and repair the local toolchain."
            .to_string();
    }
    if !detail.trim().is_empty() {
        return detail.trim().to_string();
    }
    match kind {
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
        InstallFailureKind::ExpectedBinCollision => {
            "An existing hq shim is blocking this update. Remove or rename the stale shim, then run the copied command in a fresh terminal."
                .to_string()
        }
        InstallFailureKind::Unexpected | InstallFailureKind::UnexpectedLifecycle => format!(
            "npm install exited with status {}",
            exit_code
                .map(|code| code.to_string())
                .unwrap_or_else(|| "signal/none".to_string())
        ),
    }
}

/// Decide whether a CLI-install failure should be reported to Sentry, and with
/// what message. Returns `None` for expected local-machine failures except a
/// post-force bin collision, which is captured once at Warning — the
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
    install_failure_report_with_final_attempt(exit_code, detail, prefix, false)
}

pub fn install_failure_report_with_final_attempt(
    exit_code: Option<i32>,
    detail: &str,
    prefix: Option<&str>,
    final_attempt_forced: bool,
) -> Option<String> {
    match classify_install_failure_with_final_attempt(
        exit_code,
        detail,
        prefix,
        final_attempt_forced,
    ) {
        InstallFailureKind::ExpectedBinCollision => {
            return Some("[hq-cli-update] hq shim collision survived npm --force".to_string())
        }
        InstallFailureKind::Unexpected | InstallFailureKind::UnexpectedLifecycle => {}
        InstallFailureKind::ExpectedPrefixPermission
        | InstallFailureKind::ExpectedWindowsAbort
        | InstallFailureKind::ExpectedWindowsLockedBinary
        | InstallFailureKind::ExpectedTransientRegistry => return None,
    }
    let exit_str = exit_code
        .map(|c| c.to_string())
        .unwrap_or_else(|| "signal/none".to_string());
    Some(format!("[hq-cli-update] install failed (exit {exit_str})"))
}

/// Capture an auto/manual CLI-install failure to Sentry — but only when it is a
/// reportable failure (see `install_failure_report`). The expected permission
/// failure at the selected global prefix is deliberately NOT captured: it
/// floods Sentry with an unactionable Error every auto-update cycle while the
/// user already has the copy-the-command fallback. A post-force bin collision
/// is instead captured once at Warning. Captures include only a normalized,
/// closed-enumeration diagnostic summary; raw npm stderr remains in the local
/// diagnostic log and never reaches Sentry.
pub fn report_install_failure(exit_code: Option<i32>, detail: &str, prefix: Option<&str>) {
    report_install_failure_with_final_attempt(exit_code, detail, prefix, false);
}

pub fn report_install_failure_with_final_attempt(
    exit_code: Option<i32>,
    detail: &str,
    prefix: Option<&str>,
    final_attempt_forced: bool,
) {
    let kind = classify_install_failure_with_final_attempt(
        exit_code,
        detail,
        prefix,
        final_attempt_forced,
    );
    let Some(message) =
        install_failure_report_with_final_attempt(exit_code, detail, prefix, final_attempt_forced)
    else {
        return;
    };
    let exit_str = exit_code
        .map(|c| c.to_string())
        .unwrap_or_else(|| "signal/none".to_string());
    let eacces =
        has_eacces_evidence(detail) || kind == InstallFailureKind::ExpectedPrefixPermission;
    let npm_path_shape = npm_path_shape(detail, prefix);
    let npm_prefix_known = prefix.is_some();
    let npm_error_code = npm_error_code(detail);
    let npm_lifecycle = npm_lifecycle_failure(detail);
    let npm_stderr_len = detail.len().to_string();
    let npm_diagnostics = npm_diagnostics_summary(
        exit_str.as_str(),
        detail,
        npm_path_shape,
        npm_prefix_known,
        eacces,
    );
    sentry::with_scope(
        |scope| {
            scope.set_tag("hq_cli_update_kind", "install-failed");
            scope.set_tag("install_failure_kind", kind.fingerprint_component());
            scope.set_tag("exit_code", exit_str.as_str());
            scope.set_tag("eacces", if eacces { "true" } else { "false" });
            scope.set_tag("npm_failure_site", npm_failure_site(detail, prefix));
            scope.set_tag("npm_error_code", npm_error_code.as_str());
            scope.set_tag("npm_syscall", npm_syscall(detail));
            scope.set_tag("npm_path_shape", npm_path_shape.tag_value());
            scope.set_tag(
                "npm_final_attempt_forced",
                if final_attempt_forced {
                    "true"
                } else {
                    "false"
                },
            );
            scope.set_tag(
                "npm_lifecycle_failed",
                if npm_lifecycle.failed {
                    "true"
                } else {
                    "false"
                },
            );
            if npm_lifecycle.failed {
                scope.set_tag(
                    "npm_lifecycle_package",
                    npm_lifecycle.package.as_deref().unwrap_or("unrecognized"),
                );
            }
            scope.set_tag(
                "npm_prefix_known",
                if npm_prefix_known { "true" } else { "false" },
            );
            scope.set_tag("npm_stderr_len", npm_stderr_len.as_str());
            let fingerprint = [
                "hq-cli-update",
                "install-failed",
                kind.fingerprint_component(),
                exit_str.as_str(),
            ];
            scope.set_fingerprint(Some(&fingerprint));
            scope.set_extra("npm_diagnostics", npm_diagnostics.into());
        },
        || {
            let level = if kind == InstallFailureKind::ExpectedBinCollision {
                sentry::Level::Warning
            } else {
                sentry::Level::Error
            };
            sentry::capture_message(&message, level);
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

/// Whether the resolved `hq` is a shim in pnpm's *flat* global bin directory
/// (`~/Library/pnpm` on macOS, `~/.local/share/pnpm` on Linux,
/// `%LOCALAPPDATA%\pnpm` on Windows, or a custom `PNPM_HOME`). npm cannot
/// update such an install: `npm install -g` writes an unrelated prefix, exits
/// 0, and the shim on PATH stays stale — the exact non-convergent loop
/// `install_converged` guards. pnpm-managed installs must be updated with
/// pnpm itself (`pnpm add -g`), so the installer branches on this.
pub fn is_pnpm_global_shim(hq_bin: &str) -> bool {
    if hq_bin == "hq" {
        return false;
    }
    let path = Path::new(hq_bin);
    let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) else {
        return false;
    };
    // Every default pnpm home is a directory literally named `pnpm` holding the
    // shims flat (…/pnpm/hq). An npm layout never matches: its Unix shims live
    // under a dir named `bin`, and its Windows shims sit directly in a prefix
    // that is not named `pnpm`.
    if parent.file_name().and_then(|n| n.to_str()) == Some("pnpm") {
        return true;
    }
    // pnpm ≥11 nests shims one level deeper: `<pnpm-home>/bin/hq`. The parent
    // is now literally named `bin`, which is exactly the shape
    // `npm_prefix_from_hq_bin` reads as an npm prefix — so without this arm,
    // npm would install into `<pnpm-home>/{bin,lib}` and never move the shim.
    // The grandparent being the pnpm home (named `pnpm`, or holding pnpm's
    // `global/` store) is what tells the two layouts apart.
    if parent.file_name().and_then(|n| n.to_str()) == Some("bin") {
        if let Some(grandparent) = parent.parent() {
            if grandparent.file_name().and_then(|n| n.to_str()) == Some("pnpm")
                || grandparent.join("global").is_dir()
            {
                return true;
            }
        }
    }
    // Custom PNPM_HOME: pnpm keeps its `global/` store beside the shims, which
    // no npm prefix layout does.
    parent.join("global").is_dir()
}

/// argv for updating a pnpm-managed global install. pnpm resolves the right
/// global dir itself from its own config/PNPM_HOME — no `--prefix` juggling.
pub fn pnpm_install_argv() -> Vec<String> {
    vec![
        "add".to_string(),
        "-g".to_string(),
        HQ_CLI_PACKAGE.to_string(),
    ]
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
    read_installed_version_probe(npm_bin, path).0
}

fn read_installed_version_probe(
    npm_bin: &str,
    path: &str,
) -> (Option<String>, VersionProbeOutcome) {
    let mut cmd = paths::spawn_command(npm_bin, &[]);
    let out = match cmd.args(["root", "-g"]).env("PATH", path).output() {
        Ok(output) => output,
        Err(_) => return (None, VersionProbeOutcome::ProcessSpawnFailed),
    };
    if !out.status.success() {
        return (
            None,
            if out.status.code() == Some(127) {
                VersionProbeOutcome::InterpreterNotFound
            } else {
                VersionProbeOutcome::NonzeroExit
            },
        );
    }
    let root = match String::from_utf8(out.stdout) {
        Ok(stdout) => stdout.trim().to_string(),
        Err(_) => return (None, VersionProbeOutcome::InvalidUtf8),
    };
    if root.is_empty() {
        return (None, VersionProbeOutcome::EmptyOutput);
    }
    let pkg_json = std::path::Path::new(&root)
        .join("@indigoai-us")
        .join("hq-cli")
        .join("package.json");
    let bytes = match std::fs::read(&pkg_json) {
        Ok(bytes) => bytes,
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
            ) =>
        {
            return (None, VersionProbeOutcome::PackageNotFound)
        }
        Err(_) => return (None, VersionProbeOutcome::ManifestReadOrParseFailed),
    };
    let parsed: serde_json::Value = match serde_json::from_slice(&bytes) {
        Ok(parsed) => parsed,
        Err(_) => return (None, VersionProbeOutcome::ManifestReadOrParseFailed),
    };
    match parsed.get("version").and_then(|v| v.as_str()) {
        Some(version) => (Some(version.to_string()), VersionProbeOutcome::Succeeded),
        None => (None, VersionProbeOutcome::ManifestReadOrParseFailed),
    }
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

    /// A pnpm-managed `hq` must route the installer to `pnpm add -g` — npm
    /// cannot replace a shim in pnpm's flat global dir (the non-convergent
    /// class this whole module guards). Detection is by layout: the default
    /// pnpm homes on every OS, plus a custom PNPM_HOME via its `global/` store.
    #[test]
    fn pnpm_global_shim_detected_by_layout() {
        // Default pnpm homes (the field case: ~/Library/pnpm/hq at v5.77.4).
        assert!(is_pnpm_global_shim("/Users/test/Library/pnpm/hq"));
        assert!(is_pnpm_global_shim("/home/test/.local/share/pnpm/hq"));
        // Backslash separators only parse as components on Windows.
        #[cfg(windows)]
        assert!(is_pnpm_global_shim(
            "C:\\Users\\test\\AppData\\Local\\pnpm\\hq"
        ));
        // pnpm ≥11: shims nest under `<pnpm-home>/bin` — a parent literally
        // named `bin`, the same shape npm prefixes use. Regression from the
        // live smoke on 2026-08-05: pnpm 11.0.9 wrote ~/Library/pnpm/bin/hq
        // and the flat-dir checks above all missed it.
        assert!(is_pnpm_global_shim("/Users/test/Library/pnpm/bin/hq"));
        assert!(is_pnpm_global_shim("/home/test/.local/share/pnpm/bin/hq"));
        // Custom PNPM_HOME with the v11 nesting: global/ store marks the home.
        let tmp_v11 = tempfile::TempDir::new().unwrap();
        let home_v11 = tmp_v11.path().join("my-tools");
        std::fs::create_dir_all(home_v11.join("global")).unwrap();
        std::fs::create_dir_all(home_v11.join("bin")).unwrap();
        let shim_v11 = home_v11.join("bin").join("hq");
        std::fs::write(&shim_v11, "#!/bin/sh\n").unwrap();
        assert!(is_pnpm_global_shim(shim_v11.to_str().unwrap()));
        // Custom PNPM_HOME: shims beside a `global/` store dir.
        let tmp = tempfile::TempDir::new().unwrap();
        let home = tmp.path().join("my-tools");
        std::fs::create_dir_all(home.join("global")).unwrap();
        let shim = home.join("hq");
        std::fs::write(&shim, "#!/bin/sh\n").unwrap();
        assert!(is_pnpm_global_shim(shim.to_str().unwrap()));
    }

    #[test]
    fn pnpm_global_shim_false_for_npm_layouts_and_missing_hq() {
        assert!(!is_pnpm_global_shim("hq"));
        assert!(!is_pnpm_global_shim("/opt/homebrew/bin/hq"));
        assert!(!is_pnpm_global_shim("/Users/test/.npm-global/bin/hq"));
        assert!(!is_pnpm_global_shim(
            "/Users/test/Library/Application Support/Indigo HQ/toolchain/npm-global/bin/hq"
        ));
    }

    /// Lock the pnpm argv shape the same way `install_argv` is locked: a typo
    /// (dropping `-g`, wrong package) must fail a unit test, not a user.
    #[test]
    fn pnpm_install_argv_targets_global_hq_cli_latest() {
        let argv = pnpm_install_argv();
        assert_eq!(argv[0], "add");
        assert_eq!(argv[1], "-g");
        assert!(argv[2].starts_with("@indigoai-us/hq-cli@"));
        assert!(argv[2].ends_with("@latest"));
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
    fn exit_243_eacces_with_no_derived_prefix_is_expected_and_not_reported() {
        // HQ-DESKTOP-3Y: when `hq` cannot be resolved, npm picks its own
        // global prefix. An EACCES at that global-install target is still an
        // expected local-machine condition, not an updater defect.
        assert_eq!(
            classify_install_failure(Some(243), REAL_EACCES_STDERR, None),
            InstallFailureKind::ExpectedPrefixPermission
        );
        assert_eq!(
            install_failure_report(Some(243), REAL_EACCES_STDERR, None),
            None
        );
    }

    #[test]
    fn no_prefix_permission_failure_outside_the_npm_global_target_stays_loud() {
        for detail in [
            "npm error code EACCES\nnpm error path /Users/me/.npm/_cacache/index-v5",
            "npm error code EACCES\nnpm error path /Users/me/project/node_modules/other-package",
            "npm error code EACCES\nnpm error path /Users/me/project/lib/node_modules/unrelated-package",
        ] {
            assert_eq!(
                classify_install_failure(Some(243), detail, None),
                InstallFailureKind::Unexpected,
                "detail: {detail}"
            );
            assert!(install_failure_report(Some(243), detail, None).is_some());
        }
    }

    #[test]
    fn no_prefix_non_permission_nontransient_failures_stay_loud() {
        for detail in [
            "npm error code ENOSPC\nnpm error path /usr/local/lib/node_modules/@indigoai-us",
            "npm error code EINTEGRITY\nnpm error path /usr/local/lib/node_modules/@indigoai-us",
            "npm error code EEXIST\nnpm error path /usr/local/lib/node_modules/@indigoai-us",
        ] {
            assert_eq!(
                classify_install_failure(Some(1), detail, None),
                InstallFailureKind::Unexpected,
                "detail: {detail}"
            );
        }
    }

    #[test]
    fn transient_registry_failures_keep_the_current_expected_classification() {
        for detail in [
            "npm error code ETIMEDOUT\nnpm error path /usr/local/lib/node_modules/@indigoai-us",
            "npm error code ECONNRESET\nnpm error path /usr/local/lib/node_modules/@indigoai-us",
        ] {
            assert_eq!(
                classify_install_failure(Some(1), detail, None),
                InstallFailureKind::ExpectedTransientRegistry,
                "detail: {detail}"
            );
        }
    }

    #[test]
    fn exit_243_without_a_global_install_path_does_not_suppress() {
        let detail = "npm error code EACCES\nnpm error path /Users/me/project/.cache/hq";
        assert!(!is_global_prefix_permission_failure(Some(243), detail));
        assert_eq!(
            classify_install_failure(Some(243), detail, None),
            InstallFailureKind::Unexpected
        );
    }

    #[test]
    fn exit_243_without_permission_evidence_at_a_global_path_stays_loud() {
        let detail = "npm error code 243\nnpm error path /usr/local/lib/node_modules/@indigoai-us";
        assert!(!is_global_prefix_permission_failure(Some(243), detail));
        assert_eq!(
            classify_install_failure(Some(243), detail, None),
            InstallFailureKind::Unexpected
        );
    }

    #[test]
    fn no_prefix_permission_failure_recognizes_npm_global_bin_targets() {
        for detail in [
            "npm error code EACCES\nnpm error path /usr/local/bin/hq",
            "npm error code EACCES\nnpm error path C:\\Users\\me\\AppData\\Roaming\\npm\\hq.cmd",
        ] {
            assert!(is_global_prefix_permission_failure(Some(243), detail));
            assert_eq!(
                classify_install_failure(Some(243), detail, None),
                InstallFailureKind::ExpectedPrefixPermission
            );
        }
    }

    #[test]
    fn derived_prefix_classification_is_unchanged() {
        assert_eq!(
            classify_install_failure(Some(243), REAL_EACCES_STDERR, Some("/usr/local")),
            InstallFailureKind::ExpectedPrefixPermission
        );
        assert_eq!(
            classify_install_failure(
                Some(243),
                "npm error code EACCES\nnpm error path /Users/me/.npm/_cacache/index-v5",
                Some("/usr/local"),
            ),
            InstallFailureKind::Unexpected
        );
    }

    #[test]
    fn derived_prefix_permission_failure_at_an_unmatched_global_target_is_expected() {
        let detail =
            "npm error code EACCES\nnpm error path /opt/homebrew/lib/node_modules/@indigoai-us";
        assert_eq!(
            classify_install_failure(Some(243), detail, Some("/usr/local")),
            InstallFailureKind::ExpectedPrefixPermission
        );
        assert_eq!(
            install_failure_report(Some(243), detail, Some("/usr/local")),
            None
        );
    }

    #[test]
    fn derived_prefix_permission_failure_at_the_npm_cache_stays_loud() {
        let detail = "npm error code EACCES\nnpm error path /Users/me/.npm/_cacache/index-v5";
        assert_eq!(
            classify_install_failure(Some(243), detail, Some("/usr/local")),
            InstallFailureKind::Unexpected
        );
    }

    #[test]
    fn derived_prefix_permission_failure_at_an_unrelated_path_stays_loud() {
        let detail =
            "npm error code EACCES\nnpm error path /Users/me/project/node_modules/other-package";
        assert_eq!(
            classify_install_failure(Some(243), detail, Some("/usr/local")),
            InstallFailureKind::Unexpected
        );
    }

    #[test]
    fn derived_prefix_permission_failure_without_a_path_stays_loud() {
        assert_eq!(
            classify_install_failure(Some(243), "npm error code EACCES", Some("/usr/local")),
            InstallFailureKind::Unexpected
        );
    }

    #[test]
    fn derived_prefix_non_permission_failure_at_an_unmatched_global_target_stays_loud() {
        let detail =
            "npm error code ENOSPC\nnpm error path /opt/homebrew/lib/node_modules/@indigoai-us";
        assert_eq!(
            classify_install_failure(Some(1), detail, Some("/usr/local")),
            InstallFailureKind::Unexpected
        );
    }

    #[test]
    fn npm_diagnostics_derivation_is_enumerated_and_path_free() {
        assert_eq!(npm_error_code(REAL_EACCES_STDERR), "EACCES");
        assert_eq!(npm_syscall(REAL_EACCES_STDERR), "mkdir");
        assert_eq!(
            npm_path_shape(REAL_EACCES_STDERR, Some("/usr/local")),
            NpmPathShape::SelectedPrefixNodeModules
        );
        assert_eq!(
            npm_path_shape(REAL_EACCES_STDERR, None),
            NpmPathShape::GlobalLibNodeModules
        );
        assert_eq!(
            npm_path_shape("npm error path /Users/me/.npm/_cacache/index-v5", None),
            NpmPathShape::NpmCache
        );
        assert_eq!(npm_error_code("npm error code EWHATEVER"), "EWHATEVER");
        assert_eq!(npm_syscall("npm error syscall chmod"), "unknown");
        assert!(has_eacces_evidence("npm error Error: permission denied"));
        assert!(has_eacces_evidence("npm error errno -13"));
        assert!(!has_eacces_evidence("npm error code ECONNRESET"));
    }

    #[test]
    fn npm_error_code_preserves_safe_real_tokens_without_widening_suppression() {
        assert_eq!(npm_error_code("npm error code E404"), "E404");
        assert_eq!(npm_error_code("npm error code ELIFECYCLE"), "ELIFECYCLE");
        assert_eq!(npm_error_code("npm error code 1"), "1");
        assert_eq!(npm_error_code("npm error syscall open"), "none");
        assert_eq!(
            npm_error_code("npm error code /Users/alice/private"),
            "unrecognized"
        );
        assert_eq!(npm_error_code("npm error code \"E404\""), "unrecognized");
        assert_eq!(
            npm_error_code("npm error code ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567"),
            "unrecognized"
        );

        for code in [
            "ETARGET",
            "ECONNRESET",
            "ETIMEDOUT",
            "ENOTFOUND",
            "EAI_AGAIN",
            "ERR_SOCKET_TIMEOUT",
        ] {
            assert!(is_expected_transient_registry_failure(&format!(
                "npm error code {code}"
            )));
        }
        for code in ["E404", "ELIFECYCLE", "1", "ECONNREFUSED"] {
            assert!(!is_expected_transient_registry_failure(&format!(
                "npm error code {code}"
            )));
        }
    }

    #[test]
    fn lifecycle_tags_and_local_attempt_summaries_are_bounded_and_path_free() {
        let scoped = "npm error code 1\n\
            npm error command failed\n\
            npm error path /Users/alice/toolchain/lib/node_modules/@scope/pkg";
        assert_eq!(
            npm_lifecycle_failure(scoped),
            NpmLifecycleFailure {
                failed: true,
                package: Some("@scope/pkg".to_string()),
            }
        );

        let unscoped = "npm error code ELIFECYCLE\n\
            npm error command failed\n\
            npm error path /Users/alice/toolchain/lib/node_modules/better-sqlite3";
        assert_eq!(
            npm_lifecycle_failure(unscoped),
            NpmLifecycleFailure {
                failed: true,
                package: Some("better-sqlite3".to_string()),
            }
        );

        let malformed = "npm error code 1\n\
            npm error command failed\n\
            npm error path /Users/alice/toolchain/lib/node_modules/@Scope/Package";
        assert_eq!(
            npm_lifecycle_failure(malformed),
            NpmLifecycleFailure {
                failed: true,
                package: None,
            }
        );
        assert_eq!(
            npm_lifecycle_failure("npm error code 1"),
            NpmLifecycleFailure {
                failed: false,
                package: None,
            }
        );
        assert_eq!(
            npm_lifecycle_failure(
                "npm error code ENOENT\nnpm error command failed\nnpm error path /tmp/lib/node_modules/better-sqlite3"
            ),
            NpmLifecycleFailure {
                failed: false,
                package: None,
            },
            "errno output must not be misclassified as a lifecycle failure"
        );
        assert_eq!(
            npm_lifecycle_failure(
                "npm error code 1\nnpm error path /tmp/lib/node_modules/better-sqlite3\nbuild output: npm error command failed"
            ),
            NpmLifecycleFailure {
                failed: false,
                package: None,
            },
            "only npm's structured command-failed marker can classify a lifecycle failure"
        );

        let summary = npm_install_attempt_summary(Some(1), scoped, Some("/Users/alice/toolchain"));
        assert!(summary.contains("npm_code=1"));
        assert!(summary.contains("path_shape=selected-prefix-node-modules"));
        assert!(summary.contains("exit_code=1"));
        assert!(!summary.contains("/Users/"));
        assert!(!summary.contains("alice"));
    }

    #[test]
    fn forced_structured_bin_collision_is_the_only_new_expected_kind() {
        let bin_collision = "npm error code EEXIST\n\
            npm error path /usr/local/bin/hq";
        assert!(is_npm_bin_collision(bin_collision, Some("/usr/local")));
        for path in [
            "C:\\Users\\alice\\AppData\\Roaming\\npm\\hq",
            "C:\\Users\\alice\\AppData\\Roaming\\npm\\hq.cmd",
            "C:\\Users\\alice\\AppData\\Roaming\\npm\\hq.ps1",
        ] {
            let detail = format!("npm error code EEXIST\nnpm error path {path}");
            assert!(is_npm_bin_collision(&detail, None), "detail: {detail}");
        }
        let custom_windows_prefix = "C:\\Users\\alice\\AppData\\Local\\hq-tools";
        let custom_windows_collision =
            format!("npm error code EEXIST\nnpm error path {custom_windows_prefix}\\hq.ps1");
        assert!(is_npm_bin_collision(
            &custom_windows_collision,
            Some(custom_windows_prefix)
        ));
        let custom_windows_permission =
            format!("npm error code EACCES\nnpm error path {custom_windows_prefix}\\hq.cmd");
        assert_eq!(
            classify_install_failure(
                Some(243),
                &custom_windows_permission,
                Some(custom_windows_prefix)
            ),
            InstallFailureKind::ExpectedPrefixPermission,
            "a custom Windows npm prefix must retain permission suppression"
        );
        assert_eq!(
            classify_install_failure(Some(1), bin_collision, Some("/usr/local")),
            InstallFailureKind::Unexpected
        );
        assert_eq!(
            classify_install_failure_with_final_attempt(
                Some(1),
                bin_collision,
                Some("/usr/local"),
                true,
            ),
            InstallFailureKind::ExpectedBinCollision
        );
        assert_eq!(
            install_failure_report_with_final_attempt(
                Some(1),
                bin_collision,
                Some("/usr/local"),
                true,
            ),
            Some("[hq-cli-update] hq shim collision survived npm --force".to_string())
        );

        let lifecycle_output = "npm error code 1\n\
            npm error command failed\n\
            npm error path /usr/local/bin/hq\n\
            script output contains EEXIST";
        assert!(!is_npm_bin_collision(lifecycle_output, Some("/usr/local")));
        assert_eq!(
            classify_install_failure_with_final_attempt(
                Some(1),
                lifecycle_output,
                Some("/usr/local"),
                true,
            ),
            InstallFailureKind::Unexpected
        );
    }

    #[test]
    fn third_party_lifecycle_has_its_own_group_but_owned_or_unknown_packages_stay_unexpected() {
        let third_party = "npm error code 1\nnpm error command failed\nnpm error path /usr/local/lib/node_modules/better-sqlite3";
        assert_eq!(
            classify_install_failure(Some(1), third_party, Some("/usr/local")),
            InstallFailureKind::UnexpectedLifecycle
        );

        let owned = "npm error code 1\nnpm error command failed\nnpm error path /usr/local/lib/node_modules/@indigoai-us/hq-cli";
        assert_eq!(
            classify_install_failure(Some(1), owned, Some("/usr/local")),
            InstallFailureKind::Unexpected
        );

        let unattributable =
            "npm error code 1\nnpm error command failed\nnpm error path /usr/local/build/work";
        assert_eq!(
            classify_install_failure(Some(1), unattributable, Some("/usr/local")),
            InstallFailureKind::Unexpected
        );
    }

    #[test]
    fn bin_and_lifecycle_failures_have_actionable_user_fallbacks() {
        let bin_collision = "npm error code EEXIST\nnpm error path /usr/local/bin/hq";
        let detail = install_failure_detail_with_final_attempt(
            Some(1),
            bin_collision,
            Some("/usr/local"),
            true,
        );
        assert!(detail.contains("stale shim"), "got: {detail}");
        assert!(detail.contains("copied command"), "got: {detail}");
        assert!(detail.contains("/usr/local/bin/hq"), "got: {detail}");

        let lifecycle = "npm error code 1\n\
            npm error command failed\n\
            npm error path /usr/local/lib/node_modules/better-sqlite3";
        let detail = install_failure_detail(Some(1), lifecycle, Some("/usr/local"));
        assert!(detail.contains("dependency build step"), "got: {detail}");
        assert!(detail.contains("copied command"), "got: {detail}");
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
        // Genuine unexpected failures (network, ENOSPC) stay loud.
        assert!(!is_windows_locked_binary_failure(
            Some(1),
            "npm error network request to https://registry.npmjs.org failed: ETIMEDOUT"
        ));
        assert_eq!(
            classify_install_failure(Some(1), "npm error network ETIMEDOUT", None),
            InstallFailureKind::Unexpected
        );
        assert!(!is_windows_locked_binary_failure(Some(1), ""));
    }

    #[test]
    fn install_failure_report_captures_genuine_failures() {
        // A real, unexpected failure stays loud — `Some(message)` drives the
        // Error-level capture.
        assert_eq!(
            install_failure_report(Some(1), "npm error network ETIMEDOUT", None),
            Some("[hq-cli-update] install failed (exit 1)".to_string()),
        );
        // Killed by signal (no exit code) still reports, with the signal label.
        assert_eq!(
            install_failure_report(None, "npm error network ETIMEDOUT", None),
            Some("[hq-cli-update] install failed (exit signal/none)".to_string()),
        );
        assert_eq!(
            classify_install_failure(Some(1), "npm error network ETIMEDOUT", None),
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

    #[test]
    #[cfg(unix)]
    fn unreadable_version_result_keeps_probe_failures_distinct() {
        let tmp = tempfile::TempDir::new().unwrap();
        let hq = tmp.path().join("bin/hq");
        let npm = tmp.path().join("bin/npm");
        std::fs::create_dir_all(hq.parent().unwrap()).unwrap();
        write_executable(&hq, "#!/bin/sh\nexit 9\n");
        write_executable(&npm, "#!/bin/sh\nexit 8\n");

        let result = probe_local_version(Some(&hq), Some(npm.to_str().unwrap()), "");

        assert_eq!(result.local, None);
        assert!(result.hq_installed);
        assert_eq!(
            result.probes.binary_anchor,
            VersionProbeOutcome::PackageNotFound
        );
        assert_eq!(result.probes.npm_root, VersionProbeOutcome::NonzeroExit);
        assert_eq!(result.probes.hq_version, VersionProbeOutcome::NonzeroExit);
        assert_eq!(
            result.probes.binary_anchor_shape,
            BinaryAnchorShape::NpmPrefix,
        );
        assert!(should_report_unreadable_version(&result));
    }

    #[test]
    fn absent_hq_stays_quiet_even_when_every_probe_fails() {
        let result = probe_local_version(None, None, "");

        assert_eq!(result.local, None);
        assert!(!result.hq_installed);
        assert_eq!(result.probes, LocalVersionProbeDiagnostics::not_attempted());
        assert!(!should_report_unreadable_version(&result));
    }

    #[test]
    #[cfg(unix)]
    fn successful_binary_anchor_still_short_circuits_npm_root_and_hq_version() {
        let tmp = tempfile::TempDir::new().unwrap();
        let pkg_dir = tmp.path().join("lib/node_modules/@indigoai-us/hq-cli");
        std::fs::create_dir_all(pkg_dir.join("bin")).unwrap();
        std::fs::write(
            pkg_dir.join("package.json"),
            br#"{"name":"@indigoai-us/hq-cli","version":"5.77.7"}"#,
        )
        .unwrap();
        let real_hq = pkg_dir.join("bin/hq.js");
        write_executable(&real_hq, "#!/bin/sh\nexit 99\n");
        let bin_dir = tmp.path().join("bin");
        std::fs::create_dir_all(&bin_dir).unwrap();
        let hq = bin_dir.join("hq");
        std::os::unix::fs::symlink(&real_hq, &hq).unwrap();

        let result = probe_local_version(Some(&hq), None, "");

        assert_eq!(result.local.as_deref(), Some("5.77.7"));
        assert_eq!(result.probes.binary_anchor, VersionProbeOutcome::Succeeded);
        assert_eq!(result.probes.npm_root, VersionProbeOutcome::NotAttempted);
        assert_eq!(result.probes.hq_version, VersionProbeOutcome::NotAttempted);
    }

    #[test]
    #[cfg(unix)]
    fn npm_root_fallback_preserves_precedence_over_hq_version() {
        let tmp = tempfile::TempDir::new().unwrap();
        let bin_dir = tmp.path().join("bin");
        let hq = bin_dir.join("hq");
        let npm = bin_dir.join("npm");
        let npm_root = tmp.path().join("npm-root");
        let package = npm_root.join("@indigoai-us/hq-cli/package.json");
        std::fs::create_dir_all(package.parent().unwrap()).unwrap();
        std::fs::write(
            &package,
            br#"{"name":"@indigoai-us/hq-cli","version":"5.77.8"}"#,
        )
        .unwrap();
        std::fs::create_dir_all(&bin_dir).unwrap();
        write_executable(&hq, "#!/bin/sh\nexit 99\n");
        write_executable(
            &npm,
            &format!("#!/bin/sh\nprintf '%s\\n' '{}'\n", npm_root.display()),
        );

        let result = probe_local_version(Some(&hq), Some(npm.to_str().unwrap()), "");

        assert_eq!(result.local.as_deref(), Some("5.77.8"));
        assert_eq!(
            result.probes.binary_anchor,
            VersionProbeOutcome::PackageNotFound
        );
        assert_eq!(result.probes.npm_root, VersionProbeOutcome::Succeeded);
        assert_eq!(result.probes.hq_version, VersionProbeOutcome::NotAttempted);
    }

    #[test]
    #[cfg(unix)]
    fn hq_version_fallback_runs_only_after_earlier_probes_fail() {
        let tmp = tempfile::TempDir::new().unwrap();
        let bin_dir = tmp.path().join("bin");
        let hq = bin_dir.join("hq");
        let npm = bin_dir.join("npm");
        std::fs::create_dir_all(&bin_dir).unwrap();
        write_executable(&hq, "#!/bin/sh\nprintf 'v5.77.9\\n'\n");
        write_executable(&npm, "#!/bin/sh\nexit 7\n");

        let result = probe_local_version(Some(&hq), Some(npm.to_str().unwrap()), "");

        assert_eq!(result.local.as_deref(), Some("5.77.9"));
        assert_eq!(
            result.probes.binary_anchor,
            VersionProbeOutcome::PackageNotFound
        );
        assert_eq!(result.probes.npm_root, VersionProbeOutcome::NonzeroExit);
        assert_eq!(result.probes.hq_version, VersionProbeOutcome::Succeeded);
    }

    #[test]
    #[cfg(unix)]
    fn hq_version_probe_uses_the_injected_child_path_for_node_shebang_resolution() {
        let tmp = tempfile::TempDir::new().unwrap();
        let flat_bin = tmp.path().join("Library/pnpm");
        let interpreter_dir = tmp.path().join("fixture-interpreters");
        let hq = flat_bin.join("hq");
        let npm = flat_bin.join("npm");
        std::fs::create_dir_all(&flat_bin).unwrap();
        std::fs::create_dir_all(&interpreter_dir).unwrap();
        write_executable(&hq, "#!/usr/bin/env hq-fixture-node\n");
        write_executable(
            &interpreter_dir.join("hq-fixture-node"),
            "#!/bin/sh\nprintf 'v5.88.1\\n'\n",
        );
        write_executable(&npm, "#!/bin/sh\nexit 8\n");

        let result = probe_local_version(
            Some(&hq),
            Some(npm.to_str().unwrap()),
            interpreter_dir.to_str().unwrap(),
        );

        assert_eq!(result.local.as_deref(), Some("5.88.1"));
        assert_eq!(result.probes.hq_version, VersionProbeOutcome::Succeeded);
        assert!(!should_report_unreadable_version(&result));
    }

    #[test]
    #[cfg(unix)]
    fn hq_version_probe_reports_interpreter_not_found_when_the_shebang_interpreter_is_absent() {
        let tmp = tempfile::TempDir::new().unwrap();
        let flat_bin = tmp.path().join("Library/pnpm");
        let hq = flat_bin.join("hq");
        let npm = flat_bin.join("npm");
        std::fs::create_dir_all(&flat_bin).unwrap();
        write_executable(&hq, "#!/usr/bin/env hq-fixture-node\n");
        write_executable(&npm, "#!/bin/sh\nexit 8\n");

        let result = probe_local_version(Some(&hq), Some(npm.to_str().unwrap()), "");

        assert_eq!(result.local, None);
        assert_eq!(
            result.probes.hq_version,
            VersionProbeOutcome::InterpreterNotFound
        );
        assert!(should_report_unreadable_version(&result));
    }

    #[test]
    #[cfg(unix)]
    fn hq_version_probe_still_reports_nonzero_exit_for_a_genuine_failing_cli() {
        let tmp = tempfile::TempDir::new().unwrap();
        let flat_bin = tmp.path().join("Library/pnpm");
        let hq = flat_bin.join("hq");
        let npm = flat_bin.join("npm");
        std::fs::create_dir_all(&flat_bin).unwrap();
        write_executable(&hq, "#!/bin/sh\nexit 5\n");
        write_executable(&npm, "#!/bin/sh\nexit 8\n");

        let result = probe_local_version(Some(&hq), Some(npm.to_str().unwrap()), "");

        assert_eq!(result.local, None);
        assert_eq!(result.probes.hq_version, VersionProbeOutcome::NonzeroExit);
    }

    #[test]
    #[cfg(unix)]
    fn field_triple_from_production_events_reproduces_on_base_and_resolves_on_candidate() {
        let tmp = tempfile::TempDir::new().unwrap();
        let flat_bin = tmp.path().join("Library/pnpm");
        let interpreter_dir = tmp.path().join("fixture-interpreters");
        let npm_root = tmp.path().join("unrelated-npm-root");
        let hq = flat_bin.join("hq");
        let npm = flat_bin.join("npm");
        std::fs::create_dir_all(&flat_bin).unwrap();
        std::fs::create_dir_all(&interpreter_dir).unwrap();
        std::fs::create_dir_all(&npm_root).unwrap();
        write_executable(&hq, "#!/usr/bin/env hq-fixture-node\n");
        write_executable(
            &interpreter_dir.join("hq-fixture-node"),
            "#!/bin/sh\nprintf 'v5.88.2\\n'\n",
        );
        write_executable(
            &npm,
            &format!("#!/bin/sh\nprintf '{}\\n'\n", npm_root.display()),
        );

        let without_child_path = probe_local_version(Some(&hq), Some(npm.to_str().unwrap()), "");
        assert_eq!(without_child_path.local, None);
        assert_eq!(
            without_child_path.probes.binary_anchor,
            VersionProbeOutcome::PackageNotFound
        );
        assert_eq!(
            without_child_path.probes.npm_root,
            VersionProbeOutcome::PackageNotFound
        );
        assert_eq!(
            without_child_path.probes.hq_version,
            VersionProbeOutcome::InterpreterNotFound
        );
        assert!(should_report_unreadable_version(&without_child_path));

        let with_child_path = probe_local_version(
            Some(&hq),
            Some(npm.to_str().unwrap()),
            interpreter_dir.to_str().unwrap(),
        );
        assert_eq!(with_child_path.local.as_deref(), Some("5.88.2"));
        assert_eq!(
            with_child_path.probes.hq_version,
            VersionProbeOutcome::Succeeded
        );
        assert!(!should_report_unreadable_version(&with_child_path));
    }

    #[test]
    fn binary_anchor_shape_distinguishes_npm_prefix_flat_global_bin_and_unresolvable_parent() {
        assert_eq!(
            binary_anchor_shape(Path::new("/opt/homebrew/bin/hq")),
            BinaryAnchorShape::NpmPrefix,
        );
        assert_eq!(
            binary_anchor_shape(Path::new("/Users/fixture/Library/pnpm/hq")),
            BinaryAnchorShape::FlatGlobalBin,
        );
        assert_eq!(
            binary_anchor_shape(Path::new("")),
            BinaryAnchorShape::UnresolvableParent,
        );
    }

    #[test]
    #[cfg(unix)]
    fn binary_anchor_diagnostics_classify_canonicalize_package_and_manifest_failures() {
        let tmp = tempfile::TempDir::new().unwrap();
        let missing = tmp.path().join("missing/hq");
        assert_eq!(
            version_from_hq_binary_probe(&missing).1,
            VersionProbeOutcome::CanonicalizeFailed
        );

        let standalone = tmp.path().join("standalone-hq");
        write_executable(&standalone, "#!/bin/sh\nexit 0\n");
        assert_eq!(
            version_from_hq_binary_probe(&standalone).1,
            VersionProbeOutcome::PackageNotFound
        );

        let bad_package = tmp.path().join("package.json");
        std::fs::write(&bad_package, b"not json").unwrap();
        assert_eq!(
            version_from_hq_binary_probe(&standalone).1,
            VersionProbeOutcome::ManifestReadOrParseFailed
        );
    }

    #[test]
    #[cfg(unix)]
    fn command_probe_diagnostics_classify_spawn_status_utf8_and_empty_output() {
        let tmp = tempfile::TempDir::new().unwrap();
        let missing = tmp.path().join("missing-hq");
        assert_eq!(
            hq_version_string_probe(&missing, "").1,
            VersionProbeOutcome::ProcessSpawnFailed
        );

        let nonzero = tmp.path().join("nonzero-hq");
        let invalid_utf8 = tmp.path().join("invalid-utf8-hq");
        let empty = tmp.path().join("empty-hq");
        write_executable(&nonzero, "#!/bin/sh\nexit 5\n");
        write_executable(&invalid_utf8, "#!/bin/sh\nprintf '\\377'\n");
        write_executable(&empty, "#!/bin/sh\nprintf '\\n'\n");
        assert_eq!(
            hq_version_string_probe(&nonzero, "").1,
            VersionProbeOutcome::NonzeroExit
        );
        assert_eq!(
            hq_version_string_probe(&invalid_utf8, "").1,
            VersionProbeOutcome::InvalidUtf8
        );
        assert_eq!(
            hq_version_string_probe(&empty, "").1,
            VersionProbeOutcome::EmptyOutput
        );
    }

    #[test]
    #[cfg(unix)]
    fn npm_root_probe_diagnostics_classify_output_and_manifest_failures() {
        let tmp = tempfile::TempDir::new().unwrap();
        let missing = tmp.path().join("missing-npm");
        assert_eq!(
            read_installed_version_probe(missing.to_str().unwrap(), "").1,
            VersionProbeOutcome::ProcessSpawnFailed
        );

        let nonzero = tmp.path().join("nonzero-npm");
        let missing_interpreter = tmp.path().join("missing-interpreter-npm");
        let invalid_utf8 = tmp.path().join("invalid-utf8-npm");
        let empty = tmp.path().join("empty-npm");
        let absent_package = tmp.path().join("absent-package-npm");
        let non_directory_root = tmp.path().join("non-directory-root");
        let non_directory_package = tmp.path().join("non-directory-package-npm");
        let malformed_package = tmp.path().join("malformed-package-npm");
        write_executable(&nonzero, "#!/bin/sh\nexit 5\n");
        write_executable(&missing_interpreter, "#!/bin/sh\nexit 127\n");
        write_executable(&invalid_utf8, "#!/bin/sh\nprintf '\\377'\n");
        write_executable(&empty, "#!/bin/sh\nprintf '\\n'\n");
        write_executable(
            &absent_package,
            &format!("#!/bin/sh\nprintf '%s\\n' '{}'\n", tmp.path().display()),
        );
        std::fs::write(&non_directory_root, b"not a directory").unwrap();
        write_executable(
            &non_directory_package,
            &format!(
                "#!/bin/sh\nprintf '%s\\n' '{}'\n",
                non_directory_root.display()
            ),
        );
        let npm_root = tmp.path().join("npm-root");
        let package = npm_root.join("@indigoai-us/hq-cli/package.json");
        std::fs::create_dir_all(package.parent().unwrap()).unwrap();
        std::fs::write(&package, b"not json").unwrap();
        write_executable(
            &malformed_package,
            &format!("#!/bin/sh\nprintf '%s\\n' '{}'\n", npm_root.display()),
        );

        assert_eq!(
            read_installed_version_probe(nonzero.to_str().unwrap(), "").1,
            VersionProbeOutcome::NonzeroExit
        );
        assert_eq!(
            read_installed_version_probe(missing_interpreter.to_str().unwrap(), "").1,
            VersionProbeOutcome::InterpreterNotFound
        );
        assert_eq!(
            read_installed_version_probe(invalid_utf8.to_str().unwrap(), "").1,
            VersionProbeOutcome::InvalidUtf8
        );
        assert_eq!(
            read_installed_version_probe(empty.to_str().unwrap(), "").1,
            VersionProbeOutcome::EmptyOutput
        );
        assert_eq!(
            read_installed_version_probe(absent_package.to_str().unwrap(), "").1,
            VersionProbeOutcome::PackageNotFound
        );
        assert_eq!(
            read_installed_version_probe(non_directory_package.to_str().unwrap(), "").1,
            VersionProbeOutcome::PackageNotFound
        );
        assert_eq!(
            read_installed_version_probe(malformed_package.to_str().unwrap(), "").1,
            VersionProbeOutcome::ManifestReadOrParseFailed
        );
    }

    /// `get_local_version` is the compatibility wrapper over
    /// `get_local_version_diagnostics().local`. Exercise the old ordered
    /// algorithm independently so the diagnostic refactor cannot change its
    /// return value while preserving only the new result's internal shape.
    #[test]
    #[cfg(unix)]
    fn get_local_version_return_shape_is_unchanged_across_the_ordered_scenarios() {
        let absent = probe_local_version(None, None, "");
        assert_eq!(
            legacy_local_version(None, None, ""),
            absent.local,
            "absent hq"
        );

        let binary_tmp = tempfile::TempDir::new().unwrap();
        let package = binary_tmp
            .path()
            .join("lib/node_modules/@indigoai-us/hq-cli");
        std::fs::create_dir_all(package.join("bin")).unwrap();
        std::fs::write(
            package.join("package.json"),
            br#"{"name":"@indigoai-us/hq-cli","version":"5.80.1"}"#,
        )
        .unwrap();
        let real_hq = package.join("bin/hq.js");
        write_executable(&real_hq, "#!/bin/sh\nexit 91\n");
        let binary_hq = binary_tmp.path().join("bin/hq");
        std::fs::create_dir_all(binary_hq.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(&real_hq, &binary_hq).unwrap();
        let binary = probe_local_version(Some(&binary_hq), None, "");
        assert_eq!(
            legacy_local_version(Some(&binary_hq), None, ""),
            binary.local,
            "binary-anchor hit"
        );

        let npm_tmp = tempfile::TempDir::new().unwrap();
        let npm_hq = npm_tmp.path().join("bin/hq");
        let npm = npm_tmp.path().join("bin/npm");
        let npm_root = npm_tmp.path().join("npm-root");
        let npm_package = npm_root.join("@indigoai-us/hq-cli/package.json");
        std::fs::create_dir_all(npm_hq.parent().unwrap()).unwrap();
        std::fs::create_dir_all(npm_package.parent().unwrap()).unwrap();
        write_executable(&npm_hq, "#!/bin/sh\nexit 92\n");
        std::fs::write(
            &npm_package,
            br#"{"name":"@indigoai-us/hq-cli","version":"5.80.2"}"#,
        )
        .unwrap();
        write_executable(
            &npm,
            &format!("#!/bin/sh\nprintf '%s\\n' '{}'\n", npm_root.display()),
        );
        let npm_bin = npm.to_str().unwrap();
        let npm_result = probe_local_version(Some(&npm_hq), Some(npm_bin), "");
        assert_eq!(
            legacy_local_version(Some(&npm_hq), Some(npm_bin), ""),
            npm_result.local,
            "npm-root hit"
        );

        let version_tmp = tempfile::TempDir::new().unwrap();
        let version_hq = version_tmp.path().join("bin/hq");
        let failing_npm = version_tmp.path().join("bin/npm");
        std::fs::create_dir_all(version_hq.parent().unwrap()).unwrap();
        write_executable(&version_hq, "#!/bin/sh\nprintf 'v5.80.3\\n'\n");
        write_executable(&failing_npm, "#!/bin/sh\nexit 93\n");
        let failing_npm_bin = failing_npm.to_str().unwrap();
        let hq_version = probe_local_version(Some(&version_hq), Some(failing_npm_bin), "");
        assert_eq!(
            legacy_local_version(Some(&version_hq), Some(failing_npm_bin), ""),
            hq_version.local,
            "hq --version hit"
        );

        let failure_tmp = tempfile::TempDir::new().unwrap();
        let failing_hq = failure_tmp.path().join("bin/hq");
        let failing_npm = failure_tmp.path().join("bin/npm");
        std::fs::create_dir_all(failing_hq.parent().unwrap()).unwrap();
        write_executable(&failing_hq, "#!/bin/sh\nexit 94\n");
        write_executable(&failing_npm, "#!/bin/sh\nexit 95\n");
        let failing_npm_bin = failing_npm.to_str().unwrap();
        let all_fail = probe_local_version(Some(&failing_hq), Some(failing_npm_bin), "");
        assert_eq!(
            legacy_local_version(Some(&failing_hq), Some(failing_npm_bin), ""),
            all_fail.local,
            "all probes fail"
        );
    }

    #[cfg(unix)]
    fn legacy_local_version(hq: Option<&Path>, npm: Option<&str>, path: &str) -> Option<String> {
        if let Some(hq) = hq {
            if let Some(version) = version_from_hq_binary(hq) {
                return Some(version);
            }
        }
        if let Some(npm) = npm {
            if let Some(version) = read_installed_version(npm, path) {
                return Some(version);
            }
        }
        hq.and_then(hq_version_string)
    }

    #[cfg(unix)]
    fn write_executable(path: &Path, contents: &str) {
        use std::os::unix::fs::PermissionsExt;

        std::fs::write(path, contents).unwrap();
        let mut permissions = std::fs::metadata(path).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(path, permissions).unwrap();
    }
}
