use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Why the managed-toolchain root could not be determined.
///
/// The token is deliberately closed vocabulary: it can be included in
/// diagnostic telemetry without exposing a user path or environment value.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RootDiscoveryError {
    pub reason: &'static str,
}

pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub fn no_window(cmd: &mut Command) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = cmd;
    }
}

pub fn no_window_tokio(cmd: &mut tokio::process::Command) {
    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = cmd;
    }
}

#[cfg(target_os = "windows")]
const PATH_SEP: char = ';';
#[cfg(not(target_os = "windows"))]
const PATH_SEP: char = ':';

#[cfg(target_os = "windows")]
const EXE_EXT: &str = ".exe";
#[cfg(not(target_os = "windows"))]
const EXE_EXT: &str = "";

/// Returns the managed HQ toolchain directory installed by hq-installer.
/// Path mirrors `managed_toolchain_dir_in()` in hq-installer's `deps.rs`.
#[cfg(not(target_os = "windows"))]
fn managed_toolchain_dir(home: &Path) -> PathBuf {
    home.join("Library")
        .join("Application Support")
        .join("Indigo HQ")
        .join("toolchain")
}

/// Returns the canonical managed HQ toolchain directory installed by
/// hq-installer-win: `%LOCALAPPDATA%\IndigoHQ\toolchain\`.
#[cfg(target_os = "windows")]
fn managed_toolchain_dir() -> Option<PathBuf> {
    let local_app = std::env::var_os("LOCALAPPDATA")?;
    Some(PathBuf::from(local_app).join("IndigoHQ").join("toolchain"))
}

#[cfg(target_os = "windows")]
fn legacy_managed_toolchain_dir() -> Option<PathBuf> {
    let local_app = std::env::var_os("LOCALAPPDATA")?;
    Some(PathBuf::from(local_app).join("Indigo HQ").join("toolchain"))
}

/// Every managed-toolchain root this platform may have, most-canonical first.
///
/// Windows installs moved from `Indigo HQ` to `IndigoHQ`, so an upgraded
/// machine can still be running out of the legacy directory. Empty when the
/// platform's base directory can't be resolved at all.
pub fn managed_toolchain_roots() -> Vec<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        [managed_toolchain_dir(), legacy_managed_toolchain_dir()]
            .into_iter()
            .flatten()
            .collect()
    }

    #[cfg(not(target_os = "windows"))]
    {
        home_dir()
            .map(|home| vec![managed_toolchain_dir(&home)])
            .unwrap_or_default()
    }
}

/// Every managed-toolchain root, or an explicit reason why HQ could not look.
///
/// Callers that make an ownership decision must use this fallible form:
/// inability to resolve HOME/LOCALAPPDATA is not evidence that HQ never
/// provisioned a runtime.  The historical infallible wrapper remains above so
/// existing preflight behavior stays unchanged. In particular, that wrapper
/// retains its historical handling of malformed environment values while this
/// ownership-sensitive path fails closed.
pub fn managed_toolchain_roots_checked() -> Result<Vec<PathBuf>, RootDiscoveryError> {
    #[cfg(target_os = "windows")]
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);

    #[cfg(not(target_os = "windows"))]
    let base = match std::env::var_os("HOME") {
        Some(home) => Some(PathBuf::from(home)),
        None => dirs::home_dir(),
    };

    managed_toolchain_roots_from_base(base)
}

/// Platform-routed root construction from an already-discovered base path.
///
/// Keeping discovery separate from construction gives tests a deterministic
/// way to prove that an unresolved HOME/LOCALAPPDATA remains an error without
/// mutating process-global environment variables.
pub(crate) fn managed_toolchain_roots_from_base(
    base: Option<PathBuf>,
) -> Result<Vec<PathBuf>, RootDiscoveryError> {
    let base = base.ok_or(RootDiscoveryError {
        reason: "base-dir-unresolved",
    })?;
    if base.as_os_str().is_empty() {
        return Err(RootDiscoveryError {
            reason: "base-dir-empty",
        });
    }
    if !base.is_absolute() {
        return Err(RootDiscoveryError {
            reason: "base-dir-relative",
        });
    }

    #[cfg(target_os = "windows")]
    {
        Ok(vec![
            base.join("IndigoHQ").join("toolchain"),
            base.join("Indigo HQ").join("toolchain"),
        ])
    }

    #[cfg(not(target_os = "windows"))]
    {
        Ok(vec![managed_toolchain_dir(&base)])
    }
}

/// Directory the managed Node install occupies under a toolchain root.
///
/// This — not the toolchain root — is HQ's Node-specific footprint. The root
/// is shared with the managed git and rsync installs, so its mere existence
/// says nothing about whether HQ ever put a Node on this machine.
pub fn managed_node_dir_in(root: &Path) -> PathBuf {
    root.join("node")
}

/// Absolute path the managed Node executable occupies under a toolchain root.
///
/// The installer lays Node out differently per platform: the darwin tarball
/// keeps its `bin/` directory, while the Windows zip is flattened straight
/// into `toolchain\node`.
pub fn managed_node_executable_in(root: &Path) -> PathBuf {
    let node_dir = managed_node_dir_in(root);

    #[cfg(target_os = "windows")]
    {
        node_dir.join("node.exe")
    }

    #[cfg(not(target_os = "windows"))]
    {
        node_dir.join("bin").join("node")
    }
}

/// Absolute path of the managed `npx` shim next to HQ's managed Node runtime.
pub fn managed_npx_executable_in(root: &Path) -> PathBuf {
    let node_dir = managed_node_dir_in(root);

    #[cfg(target_os = "windows")]
    {
        node_dir.join("npx.cmd")
    }

    #[cfg(not(target_os = "windows"))]
    {
        node_dir.join("bin").join("npx")
    }
}

/// Directory npm installs HQ's managed *global* packages into, under a toolchain
/// root. This is the app-managed install TARGET for the `hq` CLI — distinct from
/// the managed Node's own `node/bin`. It is the single source of truth shared by
/// the first-run dependency installer and the hq-CLI updater's managed retry, so
/// the two can never drift to different prefixes.
///
/// The installer lays it out per platform: `npm-global` on unix (npm's default
/// `<prefix>/bin` shim layout) and a flat `npm-prefix` on Windows (npm writes its
/// shims directly into the prefix, with no `bin/` subdirectory).
pub fn managed_npm_prefix_in(root: &Path) -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        root.join("npm-prefix")
    }

    #[cfg(not(target_os = "windows"))]
    {
        root.join("npm-global")
    }
}

/// Directory the managed npm prefix places executable shims in — what goes on
/// PATH. `<prefix>/bin` on unix; the prefix itself on Windows (its shims are
/// written flat into the prefix, matching hq-installer-win's layout).
pub fn managed_npm_bin_in(root: &Path) -> PathBuf {
    let prefix = managed_npm_prefix_in(root);

    #[cfg(target_os = "windows")]
    {
        prefix
    }

    #[cfg(not(target_os = "windows"))]
    {
        prefix.join("bin")
    }
}

/// Whether `path` is `root` itself or lives inside it, compared by path
/// COMPONENTS rather than raw strings so a trailing separator, a `.` segment,
/// or a mixed separator style cannot change the answer. Case-insensitive on
/// Windows (its filesystem is), case-sensitive elsewhere. An empty `root` is
/// never a container — it must not vacuously match every path.
pub fn path_is_within(path: &Path, root: &Path) -> bool {
    if root.as_os_str().is_empty() {
        return false;
    }
    let mut components = path.components();
    for expected in root.components() {
        match components.next() {
            Some(actual) if os_component_eq(actual.as_os_str(), expected.as_os_str()) => {}
            _ => return false,
        }
    }
    true
}

#[cfg(target_os = "windows")]
fn os_component_eq(a: &std::ffi::OsStr, b: &std::ffi::OsStr) -> bool {
    a.eq_ignore_ascii_case(b)
}

#[cfg(not(target_os = "windows"))]
fn os_component_eq(a: &std::ffi::OsStr, b: &std::ffi::OsStr) -> bool {
    a == b
}

/// Whether two paths both live inside the SAME managed toolchain root. This is
/// what distinguishes an HQ-owned shadow — two HQ-managed CLI copies under one
/// toolchain root, which HQ can repair — from a genuinely foreign layout (a
/// copy under Homebrew, `%APPDATA%\npm`, or a pnpm home HQ does not own) or a
/// cross-root split (the current `IndigoHQ` root vs the legacy `Indigo HQ`
/// root), neither of which is a single repairable shadow.
pub fn both_within_same_managed_root(a: &Path, b: &Path, roots: &[PathBuf]) -> bool {
    roots
        .iter()
        .any(|root| path_is_within(a, root) && path_is_within(b, root))
}

/// System / package-manager prefixes HQ must NEVER install into, even if a
/// pathological `$HOME` somehow contained one. `/usr` also covers `/usr/local`
/// (Intel Homebrew) and `/usr/bin`; `/opt/homebrew` is Apple-Silicon Homebrew.
/// Windows has no analogous user-writable global-prefix hazard here, so the list
/// is unix-shaped and simply never matches a Windows path.
const SYSTEM_OWNED_PREFIXES: &[&str] = &["/usr", "/opt/homebrew", "/bin", "/sbin"];

/// Whether `prefix` is a user-owned Node/npm global prefix HQ may drive IN PLACE
/// — i.e. one the updater can install INTO by running that prefix's own
/// co-located npm, without ever pointing HQ's managed npm at a runtime it does
/// not match. True only when the prefix is, all at once:
///   * OUTSIDE every managed toolchain root — HQ's own managed prefixes route
///     through the managed path, never this one; AND
///   * INSIDE the user's home directory — an nvm / volta / asdf / user-npm
///     prefix, never a shared location; AND
///   * NOT a system or Homebrew prefix HQ must never write into (`/usr`,
///     `/usr/local`, `/opt/homebrew`, `/bin`, `/sbin`).
///
/// Pure over its inputs (managed roots and home are passed in) so the boundary
/// is unit-testable without touching process-global environment. A relative or
/// empty prefix is never user-owned. This is the guard that keeps the new
/// aim-at-the-executed-copy path from ever writing into Homebrew or a system
/// prefix (see the updater's `select_ordinary_install_aim`).
pub fn is_user_owned_prefix(prefix: &Path, managed_roots: &[PathBuf], home: Option<&Path>) -> bool {
    if prefix.as_os_str().is_empty() || !prefix.is_absolute() {
        return false;
    }
    // Resolve symlinks BEFORE the lexical containment checks. A prefix that
    // reaches a system / package-manager location (e.g. `/opt/homebrew` or
    // `/usr/local`) THROUGH a symlink under `$HOME` would otherwise pass the
    // lexical `$HOME`-containment test and let the in-place aim run npm with
    // `--prefix` pointing into that tree — the exact Homebrew-corruption hazard
    // the boundary exists to prevent. A non-existent path (the pure unit
    // fixtures) canonicalizes to itself, so the lexical semantics are unchanged.
    let prefix = canonicalize_or_self(prefix);
    let home = home.map(canonicalize_or_self);
    let managed_roots: Vec<PathBuf> = managed_roots.iter().map(|r| canonicalize_or_self(r)).collect();

    // HQ's own managed roots are driven by the managed path, never this one.
    if managed_roots
        .iter()
        .any(|root| path_is_within(&prefix, root))
    {
        return false;
    }
    // Never a system / Homebrew / OS-owned prefix, regardless of home.
    if SYSTEM_OWNED_PREFIXES
        .iter()
        .any(|sys| path_is_within(&prefix, Path::new(sys)))
    {
        return false;
    }
    // Must live inside the user's own home directory to be user-owned.
    match home {
        Some(home) if !home.as_os_str().is_empty() && home.is_absolute() => {
            path_is_within(&prefix, &home)
        }
        _ => false,
    }
}

/// Canonicalize `path`, falling back to the path itself when it cannot be
/// resolved (it does not exist yet, or a permission error). Used by
/// [`is_user_owned_prefix`] so a symlinked containment is resolved without
/// changing the lexical semantics for non-existent fixture paths.
fn canonicalize_or_self(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// Whether `path` is a shim the resolver would actually run: a REGULAR FILE
/// (never a directory), and on unix one with an execute bit set. A delivered
/// install whose `bin/hq` is a directory or a non-executable file is skipped by
/// resolution, so existence alone must not read as a usable shim.
pub fn is_runnable_shim(path: &Path) -> bool {
    match std::fs::metadata(path) {
        Ok(meta) if meta.is_file() => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                meta.permissions().mode() & 0o111 != 0
            }
            #[cfg(not(unix))]
            {
                true
            }
        }
        _ => false,
    }
}

/// [`resolution_source_of`] for a resolved-bin STRING that may still be the
/// unresolved bare sentinel (`"hq"` / `"npm"` / empty) after a failed
/// resolution. Maps that sentinel to [`ResolutionSource::NotResolved`] instead of
/// letting the login-shell catch-all mislabel it (mirrors
/// [`crate::hq_cli_update::bin_resolution_source`]'s sentinel handling).
pub fn resolution_source_of_bin(bin: &str) -> ResolutionSource {
    if bin.is_empty() || bin == "hq" || bin == "npm" {
        return ResolutionSource::NotResolved;
    }
    resolution_source_of(Path::new(bin))
}

pub fn home_dir() -> Option<PathBuf> {
    if let Some(home) = std::env::var_os("HOME") {
        if !home.is_empty() {
            return Some(PathBuf::from(home));
        }
    }
    dirs::home_dir()
}

/// Returns the ~/.hq/ directory path.
pub fn hq_config_dir() -> Result<PathBuf, String> {
    let home = home_dir().ok_or_else(|| "Cannot determine home directory".to_string())?;
    Ok(home.join(".hq"))
}

/// Resolve a node-backed CLI binary (e.g. `hq-sync-runner`, `hq`) to an
/// absolute path.
///
/// **Why this exists:** Tauri apps launched from Dock/Finder inherit a
/// minimal launchd PATH (roughly `/usr/bin:/bin:/usr/sbin:/sbin`) — they do
/// NOT see `/opt/homebrew/bin` or the user's `.zshrc` additions. A bare
/// `Command::new("hq-sync-runner")` then fails with "No such file or
/// directory (os error 2)" even though `which hq-sync-runner` works in
/// Terminal.
///
/// Resolution order:
/// 1. Managed HQ toolchain (`~/Library/Application Support/Indigo HQ/toolchain/`)
///    — npm-global/bin and node/bin directories installed by hq-installer
/// 2. `$HOME/.npm-global/bin/{name}` — user-level npm prefix (no-sudo installs)
/// 3. `/opt/homebrew/bin/{name}` — Apple Silicon homebrew
/// 4. `/usr/local/bin/{name}` — Intel homebrew / system-wide installs
/// 5. Ask a login shell via `zsh -lc 'command -v {name}'` — respects the
///    user's actual shell config (picks up nvm, volta, asdf, etc.).
///
/// Returns the bare name as a last-ditch fallback — the caller's
/// `Command::new` will then error with the original "os error 2", which
/// surfaces as a sync error the UI can show. We don't invent a path that
/// doesn't exist.
/// Read `env.PATH` from the HQ root's Claude Code settings and return its
/// directories, most-authoritative file first. `.claude/settings.local.json`
/// (the machine-local override that a session — and the `ensure-hq-cli` hook —
/// writes) wins over the generated `.claude/settings.json`. Only absolute,
/// existing directories are returned, de-duplicated in file/segment order.
///
/// This is what lets the app resolve the SAME `hq` a Claude Code session would:
/// the session finds `hq` via this PATH, so the version check / auto-update /
/// install must consult it too, or it wrongly concludes the CLI is missing or
/// stale when it merely lives on a prefix only the settings PATH knows about.
pub fn settings_path_dirs_in(hq_root: &Path) -> Vec<PathBuf> {
    // Claude Code merges settings PER KEY, and `env.PATH` is a scalar: a value in
    // settings.local.json OVERRIDES the one in settings.json rather than
    // concatenating. So the FIRST file that defines a non-empty `env.PATH` wins
    // outright — settings.json is consulted only when the local file has none.
    // Concatenating would let a stale base PATH resolve an `hq` the session
    // (which uses only the local PATH) would never run. That precedence lives in
    // ONE place — `winning_settings_path_file` — so the resolver here and the
    // installer's writer can never disagree about which file supplies env.PATH
    // (the reader/writer split that let a stale Homebrew `hq` shadow the managed
    // CLI in HQ-DESKTOP-46).
    let claude = hq_root.join(".claude");
    let Some(file) = winning_settings_path_file(hq_root).filename() else {
        return Vec::new();
    };
    let path_val = settings_env_path_value(&claude.join(file)).unwrap_or_default();
    let mut dirs: Vec<PathBuf> = Vec::new();
    let mut seen: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();
    for seg in path_val.split(PATH_SEP) {
        if seg.is_empty() {
            continue;
        }
        let dir = PathBuf::from(seg);
        // Absolute + real directory only: a relative or missing entry from a
        // hand-edited settings file must not shadow the real search order.
        if dir.is_absolute() && dir.is_dir() && seen.insert(dir.clone()) {
            dirs.push(dir);
        }
    }
    dirs
}

/// Which `.claude` settings file supplies the winning `env.PATH` for an HQ root,
/// under the precedence Claude Code applies (see [`settings_path_dirs_in`]):
/// `settings.local.json` wins whenever it defines a non-empty `env.PATH`, else
/// `settings.json`, else neither.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SettingsPathFile {
    /// `.claude/settings.local.json` defines a non-empty `env.PATH`.
    Local,
    /// `.claude/settings.local.json` does not, but `.claude/settings.json` does.
    Base,
    /// Neither file defines a non-empty `env.PATH`.
    #[default]
    None,
}

impl SettingsPathFile {
    /// The `.claude` filename this variant names, or `None` when neither file
    /// supplies a PATH.
    pub fn filename(self) -> Option<&'static str> {
        match self {
            Self::Local => Some("settings.local.json"),
            Self::Base => Some("settings.json"),
            Self::None => Option::None,
        }
    }

    /// Closed, path-free token for the `settings_path_file` telemetry tag.
    pub fn telemetry_value(self) -> &'static str {
        match self {
            Self::Local => "local",
            Self::Base => "base",
            Self::None => "none",
        }
    }
}

/// Read a `.claude` settings file's `env.PATH` string, if the file exists, parses
/// as JSON, and defines a non-empty `env.PATH`. `None` for a missing, malformed,
/// or PATH-less file — the same three skips the resolver has always applied,
/// now shared between the reader and [`winning_settings_path_file`].
fn settings_env_path_value(path: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let path_val = value
        .get("env")
        .and_then(|env| env.get("PATH"))
        .and_then(|p| p.as_str())?;
    (!path_val.is_empty()).then(|| path_val.to_string())
}

/// The [`SettingsPathFile`] whose `env.PATH` the app resolves `hq` through for
/// `hq_root`. Single source of truth shared by the resolver
/// ([`settings_path_dirs_in`]) and the installer's writer
/// (`configure_claude_settings_path`): the composed managed-first PATH must be
/// WRITTEN into whichever file the resolver READS, or it lands in a file the
/// resolver ignores and a stale foreign `hq` keeps shadowing the managed CLI
/// (HQ-DESKTOP-46). Pure over the filesystem (only reads the two settings
/// files) so the precedence is unit-testable with a tempdir.
pub fn winning_settings_path_file(hq_root: &Path) -> SettingsPathFile {
    let claude = hq_root.join(".claude");
    if settings_env_path_value(&claude.join("settings.local.json")).is_some() {
        SettingsPathFile::Local
    } else if settings_env_path_value(&claude.join("settings.json")).is_some() {
        SettingsPathFile::Base
    } else {
        SettingsPathFile::None
    }
}

/// True iff `path` is a regular file with an executable bit set. Merely existing
/// is not enough on Unix: a shell skips a non-executable (or a directory) named
/// `hq` and keeps searching, so returning it here would surface a permission
/// error at spawn time instead of the binary the session actually runs.
#[cfg(not(target_os = "windows"))]
fn is_executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    match std::fs::metadata(path) {
        Ok(meta) => meta.is_file() && (meta.permissions().mode() & 0o111 != 0),
        Err(_) => false,
    }
}

/// Zero-arg HQ folder resolution for PATH lookups: menubar.json `hqPath`, then
/// config.json `hqFolderPath`, then core.yaml discovery, then `~/HQ`. Mirrors
/// [`crate::agency::resolve_hq_folder`] without reaching outside this module so
/// `paths` stays self-contained.
fn resolved_hq_folder_for_path() -> PathBuf {
    fn json_str_field(path: Result<PathBuf, String>, key: &str) -> Option<String> {
        let p = path.ok()?;
        let s = std::fs::read_to_string(&p).ok()?;
        let v: serde_json::Value = serde_json::from_str(&s).ok()?;
        v.get(key)?.as_str().map(str::to_string)
    }
    // resolve_hq_folder priority is (menubar override, then config path).
    let menubar = json_str_field(menubar_json_path(), "hqPath");
    let config = json_str_field(config_json_path(), "hqFolderPath");
    resolve_hq_folder(config.as_deref(), menubar.as_deref())
}

/// [`settings_path_dirs_in`] against the resolved HQ folder. Empty when there is
/// no HQ folder or settings file, so callers degrade to their existing search.
pub(crate) fn settings_path_dirs() -> Vec<PathBuf> {
    settings_path_dirs_in(&resolved_hq_folder_for_path())
}

/// The HQ folder the PATH resolver reads its `.claude` settings from — the same
/// four-tier resolution [`settings_path_dirs`] uses (menubar.json `hqPath`, then
/// config.json `hqFolderPath`, then core.yaml discovery, then `~/HQ`). Public so
/// the in-run settings-PATH repair writes into the SAME root the resolver reads,
/// keeping reader and writer on one folder.
pub fn resolved_hq_folder() -> PathBuf {
    resolved_hq_folder_for_path()
}

/// Whether `path` lives inside npm's `npx` cache (`…/_npx/…`).
///
/// npm materialises an `_npx/<hash>/node_modules/.bin/` tree per `npx`
/// invocation to run a package without a global install. That copy is ephemeral
/// and, crucially, **un-updatable**: no `npm install -g`/`pnpm add -g` can move
/// it, because it is keyed by the invocation's package specs, not by any global
/// prefix. So the `hq` resolver must never adopt one as the CLI it converges —
/// doing so pins the machine on a version the updater can install "successfully"
/// forever while the executed copy never changes.
///
/// Matches npm's `npx` cache STRUCTURE: a whole path component literally named
/// `_npx` (npm's reserved cache directory — see
/// [`crate::runner_target::npx_cache_dir`]) followed later by a `node_modules`
/// component. npm always materialises `_npx/<hash>/node_modules/.bin/<name>`, so
/// requiring `node_modules` beneath the `_npx` dir is what distinguishes the
/// real cache from an ordinary directory merely NAMED `_npx` (e.g. a home or
/// prefix at `/Users/_npx/…/hq`, which has no cache tree under it and must stay
/// resolvable). Whole-component match only, never a substring, so `my_npx` and
/// `_npxtools` are untouched; case-insensitive on Windows only.
pub fn is_npx_cache_path(path: &Path) -> bool {
    let names: Vec<&str> = path
        .components()
        .filter_map(|component| match component {
            std::path::Component::Normal(part) => part.to_str(),
            _ => None,
        })
        .collect();
    let is_npx = |name: &str| {
        if cfg!(target_os = "windows") {
            name.eq_ignore_ascii_case("_npx")
        } else {
            name == "_npx"
        }
    };
    names.iter().enumerate().any(|(i, name)| {
        is_npx(name) && names[i + 1..].iter().any(|later| *later == "node_modules")
    })
}

/// Whether the resolver must reject `candidate` for this `name`. Scoped to `hq`:
/// only the CLI the updater converges may never be an npx-cache copy OR HQ's own
/// orphaned managed-toolchain shim. Every other program — `npm`, `node`, `npx`,
/// `git`, `hq-sync-runner` — and every backed or foreign `hq` copy resolves
/// exactly as before, so the runner's deliberate npx-cache execution path and
/// every third-party install are untouched.
fn hq_lookup_rejects_candidate(name: &str, candidate: &Path) -> bool {
    name == "hq" && (is_npx_cache_path(candidate) || is_orphaned_managed_shim(candidate))
}

/// Whether an `hq` candidate is HQ's OWN orphaned managed-toolchain shim: it sits
/// inside a managed-toolchain root HQ itself created AND its `@indigoai-us/hq-cli`
/// package is DEFINITIVELY gone. Such a shim can never be spawned to a version and
/// can never be updated in place, so adopting it pins the machine on a permanent
/// unreadable-version report; skipping it lets the resolver find a real install
/// elsewhere, or (with none) fall through to the not-resolved marker so the
/// existing installer can put a real CLI on the machine.
///
/// The provenance gate is checked FIRST and is pure path math, so the common case
/// — an `hq` anywhere outside a managed root — costs nothing and a foreign program
/// named `hq` is never rejected here. Only a candidate already proven to live in a
/// managed root pays for the bounded backing read, and only a DEFINITIVE absence
/// rejects: an unreadable or indeterminate manifest (a permission/AV hold) keeps
/// the candidate, so a transient blip can never turn a working machine into a
/// reinstall.
fn is_orphaned_managed_shim(candidate: &Path) -> bool {
    hq_bin_in_managed_root(candidate)
        && matches!(
            crate::hq_cli_update::hq_cli_backing(candidate),
            CandidateBacking::AbsentDefinitive
        )
}

pub fn resolve_bin(name: &str) -> String {
    resolve_bin_with_kind(name).path
}

/// [`resolve_bin`] plus the classification of what it landed on.
///
/// Callers that only need a program to spawn keep using `resolve_bin`. Callers
/// that must tell "found a working program" from "found a file Windows cannot
/// execute" from "found nothing" read the [`ResolvedProgramKind`] — the
/// version probes need exactly that distinction to report an installed-but-
/// unreadable CLI honestly instead of reporting it as absent.
pub fn resolve_bin_with_kind(name: &str) -> ResolvedProgram {
    #[cfg(target_os = "windows")]
    {
        let candidates = candidate_filenames(name);
        // For `hq`, skip an npx-cache copy and HQ's own orphaned managed shim at
        // every candidate source; for every other program this is a no-op, so
        // their resolution is unchanged.
        let reject = |path: &Path| hq_lookup_rejects_candidate(name, path);

        if name == "hq" {
            // ONE cross-lane sweep. The settings-PATH dirs come FIRST (strict
            // session parity: prefer the exact binary a Claude Code session would
            // resolve via `env.PATH` in .claude/settings.local.json), then the
            // extended search dirs. Because both lanes are swept together, a
            // spawnable + backed match in ANY lane outranks a non-spawnable or
            // unbacked match in an earlier lane — restoring the cross-directory
            // spawnable preference that a separate settings call defeated, and
            // adding the backed-candidate preference. The backing oracle lives in
            // `hq_cli_update`, which owns the package-layout knowledge.
            let mut dirs = settings_path_dirs();
            dirs.extend(extended_search_dirs());
            let backing = |path: &Path| crate::hq_cli_update::hq_cli_backing(path);
            if let Some(found) = select_hq_program_on_disk(&dirs, &candidates, &reject, &backing) {
                return found;
            }
        } else if let Some(found) =
            select_program_on_disk_rejecting(&extended_search_dirs(), &candidates, &reject)
        {
            return found;
        }

        let mut where_cmd = Command::new("where.exe");
        where_cmd.arg(name);
        no_window(&mut where_cmd);
        if let Ok(output) = where_cmd.output() {
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                let matches: Vec<&str> = stdout
                    .lines()
                    .map(|l| l.trim())
                    .filter(|l| !l.is_empty() && Path::new(l).exists())
                    // Drop an npx-cache `hq` from where.exe's list too.
                    .filter(|l| !reject(Path::new(l)))
                    .collect();
                if let Some(best) = pick_spawnable_program(&matches) {
                    return best;
                }
            }
        }

        ResolvedProgram::not_resolved(name)
    }

    #[cfg(not(target_os = "windows"))]
    {
        // Strict session parity for `hq`: prefer the exact binary a Claude Code
        // session would resolve via `env.PATH` in .claude/settings.local.json,
        // ahead of the app's managed toolchain and every other search dir.
        if name == "hq" {
            for dir in settings_path_dirs() {
                let candidate = dir.join(name);
                // Require an executable regular file: a shell skips a
                // non-executable or a directory named `hq` and keeps searching,
                // so we must too or we'd hand back an unspawnable path. Also skip
                // an npx-cache copy: it can never be updated, so adopting it as
                // the resolved CLI would pin the machine — keep searching for a
                // real install instead.
                if is_executable_file(&candidate) && !hq_lookup_rejects_candidate(name, &candidate) {
                    return ResolvedProgram {
                        path: candidate.to_string_lossy().to_string(),
                        kind: ResolvedProgramKind::Exe,
                    };
                }
            }
        }

        // Unix has no extension-based spawnability contract: a file the
        // resolver found is a program the loader will attempt. Report it as
        // `Exe` so the closed diagnostics stay meaningful cross-platform.
        if let Some(path) = resolve_bin_in_dirs(home_dir().as_deref(), name) {
            return ResolvedProgram {
                path,
                kind: ResolvedProgramKind::Exe,
            };
        }

        // 5. Login-shell PATH lookup — catches nvm/volta/asdf + any custom prefix
        //    the user configured in .zshrc. `-l` makes zsh a login shell so it
        //    sources the full startup chain.
        //
        //    For `hq` we must ENUMERATE every PATH match (`whence -pa`) rather
        //    than take only the first (`command -v`): a login-shell PATH can list
        //    an npx-cache `hq` ahead of a real custom install, and the updater
        //    could never move the npx copy — so we skip it and keep looking for a
        //    real one instead of reporting the CLI missing. For every other name
        //    nothing is ever rejected, so `command -v`'s single first match is
        //    authoritative exactly as before.
        let shell_query = if name == "hq" {
            format!("whence -pa {}", name)
        } else {
            format!("command -v {}", name)
        };
        if let Ok(output) = Command::new("zsh").args(["-lc", &shell_query]).output() {
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                for line in stdout.lines() {
                    let path = line.trim();
                    if path.is_empty()
                        || !Path::new(path).exists()
                        || hq_lookup_rejects_candidate(name, Path::new(path))
                    {
                        continue;
                    }
                    return ResolvedProgram {
                        path: path.to_string(),
                        kind: ResolvedProgramKind::Exe,
                    };
                }
            }
        }

        // Fall back to bare name — Command::new will then produce os error 2
        // with the binary name still recognizable in the error message.
        ResolvedProgram::not_resolved(name)
    }
}

/// Resolve a binary from deterministic home-relative and system-prefix
/// locations. Kept separate from the login-shell fallback so tests can assert
/// precedence without depending on the developer machine's actual HOME or
/// shell configuration.
#[cfg(not(target_os = "windows"))]
fn user_cli_dirs(home: &Path) -> Vec<PathBuf> {
    user_cli_dirs_with_pnpm_home(home, pnpm_home_dir().as_deref())
}

/// Pure form of [`user_cli_dirs`] with `PNPM_HOME` injected, so the override
/// ordering is unit-testable without mutating the process environment (env
/// mutation is racy under a parallel test harness).
///
/// `PNPM_HOME` comes FIRST: pnpm honours it over its per-OS default, so a user
/// who relocated their global bin dir would otherwise resolve a stale binary at
/// the default location — or, more commonly, nothing at all.
#[cfg(not(target_os = "windows"))]
fn user_cli_dirs_with_pnpm_home(home: &Path, pnpm_home: Option<&Path>) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(pnpm_home) = pnpm_home {
        dirs.extend(pnpm_shim_dirs(pnpm_home));
    }
    dirs.push(home.join(".npm-global").join("bin"));
    // pnpm's default global home on macOS, then on Linux.
    dirs.extend(pnpm_shim_dirs(&home.join("Library").join("pnpm")));
    dirs.extend(pnpm_shim_dirs(
        &home.join(".local").join("share").join("pnpm"),
    ));
    // Bun's default global executable directory on every Unix platform.
    dirs.push(home.join(".bun").join("bin"));

    // Drop repeats — a PNPM_HOME equal to a per-OS default would otherwise be
    // listed twice. `Vec::dedup` cannot do this: the duplicate is NOT adjacent
    // (PNPM_HOME leads the list, the default it repeats sits later), and dedup
    // only collapses adjacent equals.
    let mut seen = std::collections::HashSet::new();
    dirs.retain(|dir| seen.insert(dir.clone()));
    dirs
}

/// Both directories a pnpm global shim can occupy for a given pnpm home.
///
/// pnpm <=10 writes shims flat into the home (`<home>/hq`); pnpm >=11 nests
/// them one level down (`<home>/bin/hq`). `hq_cli_update` already recognizes
/// both layouts when it locates an install to upgrade, so the resolver has to
/// probe both or it fails to find the very shim the updater maintains.
fn pnpm_shim_dirs(pnpm_home: &Path) -> [PathBuf; 2] {
    [pnpm_home.to_path_buf(), pnpm_home.join("bin")]
}

/// `PNPM_HOME` as an absolute path, when set.
///
/// pnpm writes its global shims (`hq`, and every other `pnpm add -g` binary)
/// into this directory, and users are free to point it anywhere — the per-OS
/// defaults in [`user_cli_dirs`] only apply when it is unset. A relative value
/// is discarded rather than resolved against the desktop process's working
/// directory, matching [`user_program_roots`].
fn pnpm_home_dir() -> Option<PathBuf> {
    pnpm_home_from_env(std::env::var_os("PNPM_HOME"))
}

/// Pure form of [`pnpm_home_dir`] so the absolute/relative filtering is
/// unit-testable without mutating the process environment.
fn pnpm_home_from_env(raw: Option<std::ffi::OsString>) -> Option<PathBuf> {
    raw.map(PathBuf::from).filter(|dir| dir.is_absolute())
}

/// Explicit user-owned roots used to classify a failed program path for
/// bounded telemetry. Invalid environment paths are excluded rather than
/// interpreted relative to the desktop process's working directory.
pub(crate) fn user_program_roots() -> Vec<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .filter(|root| root.is_absolute())
            .map(|root| vec![root.join("npm")])
            .unwrap_or_default()
    }

    #[cfg(not(target_os = "windows"))]
    {
        home_dir()
            .filter(|home| home.is_absolute())
            .map(|home| user_cli_dirs(&home))
            .unwrap_or_default()
    }
}

/// Explicit system-owned roots used to classify a failed program path for
/// bounded telemetry. These are the same stable install locations searched
/// by the resolver, without inherited-PATH or shell-derived directories.
pub(crate) fn system_program_roots() -> Vec<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"]
            .into_iter()
            .filter_map(std::env::var_os)
            .map(PathBuf::from)
            .filter(|root| root.is_absolute())
            .map(|root| root.join("nodejs"))
            .collect()
    }

    #[cfg(not(target_os = "windows"))]
    {
        [
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/usr/bin"),
            PathBuf::from("/bin"),
        ]
        .into_iter()
        .collect()
    }
}

/// Managed-toolchain bin dirs the app itself spawns from, in priority order.
/// `git-shim` holds the wrapper the installer writes around the portable
/// (dugite) git; it must be found BEFORE /usr/bin, whose `git` is the Xcode
/// CLT stub on a fresh Mac. The headed install matrix (2026-09-03) caught the
/// wizard's own git-init stage failing on exactly that stub right after the
/// deps stage had installed a working git.
#[cfg(not(target_os = "windows"))]
pub const MANAGED_TOOLCHAIN_BIN_SUBDIRS: &[&str] = &["npm-global/bin", "node/bin", "git-shim"];

#[cfg(not(target_os = "windows"))]
fn resolve_bin_in_dirs(home: Option<&Path>, name: &str) -> Option<String> {
    if let Some(home) = home {
        // Managed HQ toolchain (installed by hq-installer). Match
        // `child_path()` and hq-installer's login PATH order so a stale
        // foreign `~/.npm-global/bin/hq` cannot shadow the managed CLI the
        // app's runtime PATH would execute.
        let toolchain = managed_toolchain_dir(home);
        for subdir in MANAGED_TOOLCHAIN_BIN_SUBDIRS {
            let candidate = toolchain.join(subdir).join(name);
            if candidate.exists() && !hq_lookup_rejects_candidate(name, &candidate) {
                return Some(candidate.to_string_lossy().to_string());
            }
        }

        // User-level npm/pnpm prefixes after the managed toolchain, then
        // ~/.local/bin (where the installer's direct-binary yq/jq land).
        for dir in user_cli_dirs(home)
            .into_iter()
            .chain(std::iter::once(home.join(".local").join("bin")))
        {
            let candidate = dir.join(name);
            if candidate.exists() && !hq_lookup_rejects_candidate(name, &candidate) {
                return Some(candidate.to_string_lossy().to_string());
            }
        }
    }

    // Standard install locations.
    for prefix in ["/opt/homebrew/bin", "/usr/local/bin"] {
        let candidate = Path::new(prefix).join(name);
        if candidate.exists() && !hq_lookup_rejects_candidate(name, &candidate) {
            return Some(candidate.to_string_lossy().to_string());
        }
    }

    None
}

#[cfg(target_os = "windows")]
fn extended_search_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();

    if let Some(toolchain) = managed_toolchain_dir() {
        dirs.push(toolchain.join("node"));
        // Keep this order aligned with hq-installer's
        // `extended_search_path()`. Windows npm global shims and the
        // drive-letter-translating rsync wrapper live directly in
        // `npm-prefix`; the Core rescue must see that wrapper before the raw
        // rsync.exe in `bin`.
        dirs.push(toolchain.join("npm-prefix"));
        dirs.push(toolchain.join("bin"));
        dirs.push(toolchain.join("git").join("cmd"));
        dirs.push(toolchain.join("git").join("mingw64").join("bin"));
    }
    if let Some(legacy) = legacy_managed_toolchain_dir() {
        dirs.push(legacy.join("node"));
        dirs.push(legacy.join("npm-prefix"));
        dirs.push(legacy.join("bin"));
        dirs.push(legacy.join("git").join("cmd"));
        dirs.push(legacy.join("git").join("mingw64").join("bin"));
    }

    if let Some(home) = home_dir() {
        dirs.push(home.join(".hq").join("bin"));
        dirs.push(home.join("scoop").join("shims"));
    }

    // Official Node.js Windows installers place node.exe and the npm/npx
    // command shims here. Do not rely only on the inherited PATH: tray apps
    // and start-at-login processes can retain the pre-install environment
    // until the next Windows sign-in even though a new terminal sees Node.
    for variable in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
        if let Some(root) = std::env::var_os(variable) {
            dirs.push(PathBuf::from(root).join("nodejs"));
        }
    }

    // npm's per-user global prefix on Windows.
    if let Some(app_data) = std::env::var_os("APPDATA") {
        dirs.push(PathBuf::from(app_data).join("npm"));
    }

    // pnpm's per-user global bin dir on Windows — a custom `PNPM_HOME` first,
    // then the `%LOCALAPPDATA%\pnpm` default. `pnpm add -g @indigoai-us/hq-cli`
    // installs the `hq` shim here and nowhere npm knows about, so without these
    // entries a pnpm user's spawn falls through to the bare name and dies with
    // os error 2 (`hq_cli_update` already resolves the same two locations).
    if let Some(pnpm_home) = pnpm_home_dir() {
        dirs.extend(pnpm_shim_dirs(&pnpm_home));
    }
    if let Some(local_app) = std::env::var_os("LOCALAPPDATA") {
        dirs.extend(pnpm_shim_dirs(&PathBuf::from(local_app).join("pnpm")));
    }

    if let Ok(local_app) = std::env::var("LOCALAPPDATA") {
        dirs.push(
            PathBuf::from(local_app)
                .join("Microsoft")
                .join("WindowsApps"),
        );
    }

    for git_bash in [
        "C:\\Program Files\\Git\\bin",
        "C:\\Program Files\\Git\\usr\\bin",
        "C:\\Program Files (x86)\\Git\\bin",
        "C:\\Program Files (x86)\\Git\\usr\\bin",
    ] {
        dirs.push(PathBuf::from(git_bash));
    }

    dirs
}

/// A closed classification of the program a resolution landed on.
///
/// Windows is the platform this distinguishes: `CreateProcessW` accepts a
/// native `.exe` image and Rust's batch-aware dispatch handles `.cmd`/`.bat`,
/// but an *extensionless* POSIX shim (or a `.ps1`) is rejected with
/// `ERROR_BAD_EXE_FORMAT` — os error 193 — even though the file exists. The
/// enum is deliberately cfg-independent so diagnostics carrying it compile and
/// serialize identically on every platform; the non-Windows resolvers report
/// [`ResolvedProgramKind::Exe`] for anything they found (a Unix executable has
/// no extension contract) and [`ResolvedProgramKind::NotResolved`] otherwise.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ResolvedProgramKind {
    Exe,
    CmdOrBat,
    Extensionless,
    OtherExtension,
    NotResolved,
}

impl ResolvedProgramKind {
    /// Whether the Windows loader can execute this program directly.
    pub fn is_spawnable(self) -> bool {
        matches!(self, Self::Exe | Self::CmdOrBat)
    }
}

/// Best-effort, closed classification of WHICH resolution lane produced the
/// `hq` binary the resolver returned. Path-free so it can ride the
/// unreadable-version telemetry event: it names the lane (settings PATH,
/// managed toolchain, a user prefix, a system prefix, or the login-shell
/// fallback) without carrying the path itself.
///
/// Attribution is a membership test of the resolved binary's parent directory
/// against the same directory sets the resolver searches, in resolver
/// precedence order, so a directory shared by two lanes is credited to the
/// higher-precedence one — exactly how the resolver would have picked it. A
/// resolution that matches none of the deterministic sets came from the
/// login-shell (`zsh -lc`) enumeration on Unix or `where.exe` on Windows, which
/// this records as [`ResolutionSource::LoginShell`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ResolutionSource {
    #[default]
    NotResolved,
    SettingsPath,
    ManagedToolchain,
    UserPrefix,
    SystemPrefix,
    LoginShell,
}

impl ResolutionSource {
    /// Closed, path-free token for the `hq_bin_lane` telemetry tag. Kept in
    /// lockstep with the serde `snake_case` rendering so the tag vocabulary has a
    /// single source of truth and can never carry a raw filesystem path.
    pub fn telemetry_value(self) -> &'static str {
        match self {
            Self::NotResolved => "not_resolved",
            Self::SettingsPath => "settings_path",
            Self::ManagedToolchain => "managed_toolchain",
            Self::UserPrefix => "user_prefix",
            Self::SystemPrefix => "system_prefix",
            Self::LoginShell => "login_shell",
        }
    }
}

fn parent_in(path: &Path, dirs: &[PathBuf]) -> bool {
    match path.parent() {
        Some(parent) => dirs.iter().any(|dir| dir == parent),
        None => false,
    }
}

/// Pure classifier: attribute a resolved binary to a resolution lane by testing
/// its parent directory against the supplied dir sets in resolver-precedence
/// order. Kept pure so the precedence is unit-testable with fixture dirs.
///
/// `resolver_fallback` is the remaining deterministic-resolver dir set (used on
/// Windows, where the resolver also searches pnpm / Scoop / `.hq\bin` /
/// WindowsApps before the `where.exe` fallback): checked AFTER the precise
/// lanes, so a resolution found there is a user-level install
/// (`UserPrefix`) rather than the login-shell residual. Empty on Unix.
pub(crate) fn classify_resolution_source(
    resolved: &Path,
    settings: &[PathBuf],
    managed: &[PathBuf],
    user: &[PathBuf],
    system: &[PathBuf],
    resolver_fallback: &[PathBuf],
) -> ResolutionSource {
    if parent_in(resolved, settings) {
        ResolutionSource::SettingsPath
    } else if parent_in(resolved, managed) {
        ResolutionSource::ManagedToolchain
    } else if parent_in(resolved, user) {
        ResolutionSource::UserPrefix
    } else if parent_in(resolved, system) {
        ResolutionSource::SystemPrefix
    } else if parent_in(resolved, resolver_fallback) {
        ResolutionSource::UserPrefix
    } else {
        ResolutionSource::LoginShell
    }
}

/// The managed-toolchain bin directories the resolver searches, per platform.
fn managed_resolution_dirs() -> Vec<PathBuf> {
    #[cfg(not(target_os = "windows"))]
    {
        let Some(home) = home_dir() else {
            return Vec::new();
        };
        let toolchain = managed_toolchain_dir(&home);
        vec![
            toolchain.join("npm-global").join("bin"),
            toolchain.join("node").join("bin"),
        ]
    }

    #[cfg(target_os = "windows")]
    {
        let mut dirs = Vec::new();
        for root in [managed_toolchain_dir(), legacy_managed_toolchain_dir()]
            .into_iter()
            .flatten()
        {
            dirs.push(root.join("node"));
            dirs.push(root.join("npm-prefix"));
            dirs.push(root.join("bin"));
        }
        dirs
    }
}

/// Whether `path` lies inside any of `roots` (a root counts when it is an
/// ancestor of `path`). Pure so the managed-provenance gate is unit-testable
/// against fixture roots without touching the environment.
fn path_in_any_root(path: &Path, roots: &[PathBuf]) -> bool {
    roots
        .iter()
        .any(|root| !root.as_os_str().is_empty() && path.starts_with(root))
}

/// Whether a resolved `hq` binary sits inside one of HQ's OWN managed-toolchain
/// roots. Combined with a definitive absent-package answer this is what marks a
/// candidate as HQ's orphaned shim (safe to reject) rather than an unrelated
/// program named `hq` (never rejected); it also splits the `unbacked_managed`
/// from the `unbacked_foreign` telemetry sub-case. Path math only — no
/// filesystem I/O, so it is cheap enough to gate the backing read behind.
pub(crate) fn hq_bin_in_managed_root(hq_bin: &Path) -> bool {
    path_in_any_root(hq_bin, &managed_toolchain_roots())
}

/// Best-effort resolution-lane attribution for the binary `resolve_bin_with_kind`
/// returned. Only meaningful for a resolved path; callers pass
/// [`ResolutionSource::NotResolved`] themselves when nothing resolved.
pub fn resolution_source_of(resolved: &Path) -> ResolutionSource {
    // On Windows the resolver also searches the broader `extended_search_dirs()`
    // (pnpm / Scoop / `.hq\bin` / WindowsApps / Git) before `where.exe`; feed
    // that set as the resolver fallback so those installs classify as a user
    // prefix, not `login_shell`. Empty on Unix, where the deterministic set is
    // already covered by managed/user/system.
    #[cfg(target_os = "windows")]
    let resolver_fallback = extended_search_dirs();
    #[cfg(not(target_os = "windows"))]
    let resolver_fallback: Vec<PathBuf> = Vec::new();

    classify_resolution_source(
        resolved,
        &settings_path_dirs(),
        &managed_resolution_dirs(),
        &user_program_roots(),
        &system_program_roots(),
        &resolver_fallback,
    )
}

/// A resolved program plus the classification of what kind of file it is.
///
/// A non-spawnable resolution is deliberately *retained and marked*, never
/// discarded: dropping it back to the bare name would tell every caller the
/// CLI is absent, which silences the installed-but-unusable signal while the
/// user's CLI stays broken.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedProgram {
    pub path: String,
    pub kind: ResolvedProgramKind,
}

impl ResolvedProgram {
    /// The unresolved marker: the bare name, exactly what `resolve_bin` has
    /// always returned when nothing was found, so `Command::new` still errors
    /// with the binary name recognizable in the message.
    pub fn not_resolved(name: &str) -> Self {
        Self {
            path: name.to_string(),
            kind: ResolvedProgramKind::NotResolved,
        }
    }

    /// Whether the resolver found a real file (as opposed to falling back to
    /// the bare name).
    pub fn is_resolved(&self) -> bool {
        self.kind != ResolvedProgramKind::NotResolved
    }

    /// Whether the resolved program can actually be spawned on this platform.
    pub fn is_spawnable(&self) -> bool {
        self.kind.is_spawnable()
    }
}

/// Classify a candidate filename or full path by its extension.
///
/// Pure and platform-independent so the Windows selection rules are executable
/// (and testable) on every CI leg.
pub fn program_kind(candidate: &str) -> ResolvedProgramKind {
    match Path::new(candidate)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .as_deref()
    {
        None => ResolvedProgramKind::Extensionless,
        Some("exe") => ResolvedProgramKind::Exe,
        Some("cmd") | Some("bat") => ResolvedProgramKind::CmdOrBat,
        Some(_) => ResolvedProgramKind::OtherExtension,
    }
}

/// Whether a candidate filename names a program Windows can execute directly.
pub fn is_spawnable_program(candidate: &str) -> bool {
    program_kind(candidate).is_spawnable()
}

/// Ordered selection over (search directories × candidate filenames) with an
/// injectable existence check.
///
/// **Two passes, deliberately.** The first pass walks every directory in order
/// considering only *spawnable* candidates; the second repeats the walk for the
/// remaining ones. So a spawnable match in ANY search directory outranks a
/// non-spawnable match in an earlier directory — the shadowing that let a bare
/// extensionless POSIX shim in, say, `C:\Program Files\Git\usr\bin` hide the
/// real `hq.cmd` in `%APPDATA%\npm` and make every spawn fail with os error
/// 193. Within each pass, directory precedence and candidate order are
/// preserved exactly as before.
///
/// When only non-spawnable candidates exist the FIRST of them is still
/// returned, marked with its kind. Returning `None` there would collapse
/// resolution to the bare name and mis-report a broken-but-present CLI as
/// absent.
pub fn select_program_in_dirs(
    dirs: &[PathBuf],
    candidates: &[String],
    exists: &dyn Fn(&Path) -> bool,
) -> Option<ResolvedProgram> {
    select_program_in_dirs_rejecting(dirs, candidates, exists, &|_| false)
}

/// [`select_program_in_dirs`] with an extra `reject` predicate that skips any
/// on-disk candidate the caller must not adopt. The `hq` lookup passes a reject
/// that filters out npx-cache copies (see [`is_npx_cache_path`]); every other
/// lookup passes a no-op, so their resolution is byte-for-byte unchanged. A
/// rejected candidate is skipped exactly as a non-existent one — the sweep keeps
/// looking in later directories and in the second (non-spawnable) pass — so a
/// real install anywhere in the search order still wins over an npx copy.
pub fn select_program_in_dirs_rejecting(
    dirs: &[PathBuf],
    candidates: &[String],
    exists: &dyn Fn(&Path) -> bool,
    reject: &dyn Fn(&Path) -> bool,
) -> Option<ResolvedProgram> {
    for spawnable_pass in [true, false] {
        for dir in dirs {
            for candidate in candidates {
                if is_spawnable_program(candidate) != spawnable_pass {
                    continue;
                }
                let full = dir.join(candidate);
                if exists(&full) && !reject(&full) {
                    return Some(ResolvedProgram {
                        path: full.to_string_lossy().to_string(),
                        kind: program_kind(candidate),
                    });
                }
            }
        }
    }
    None
}

/// [`select_program_in_dirs`] against the real filesystem.
///
/// Kept cfg-independent on purpose: this is the exact call the Windows arm of
/// [`resolve_bin_with_kind`] makes, so the macOS and Linux CI legs compile and
/// exercise it too instead of leaving the whole sweep provable only on Windows.
pub fn select_program_on_disk(dirs: &[PathBuf], candidates: &[String]) -> Option<ResolvedProgram> {
    select_program_in_dirs(dirs, candidates, &|path: &Path| path.exists())
}

/// [`select_program_on_disk`] with the `reject` predicate threaded through, for
/// the Windows `hq` lookup's npx-cache skip.
pub fn select_program_on_disk_rejecting(
    dirs: &[PathBuf],
    candidates: &[String],
    reject: &dyn Fn(&Path) -> bool,
) -> Option<ResolvedProgram> {
    select_program_in_dirs_rejecting(dirs, candidates, &|path: &Path| path.exists(), reject)
}

/// Whether a resolved `hq` candidate is backed by a reachable
/// `@indigoai-us/hq-cli` package manifest. The resolver uses this to prefer a
/// real install over a foreign or orphaned program named `hq`.
///
/// [`CandidateBacking::Indeterminate`] — a manifest that could not be read, as
/// opposed to one that is definitively absent — must never drive a rejection or a
/// demotion, so a permission blip cannot turn a working machine into a reinstall.
/// The oracle itself lives in `hq_cli_update` ([`crate::hq_cli_update::hq_cli_backing`]),
/// which owns the package-layout knowledge; the resolver takes it injected so this
/// selection stays pure and unit-testable with fixture oracles.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CandidateBacking {
    Backed,
    AbsentDefinitive,
    Indeterminate,
}

impl CandidateBacking {
    fn is_backed(self) -> bool {
        matches!(self, Self::Backed)
    }
}

/// The `hq` cross-lane selection: [`select_program_in_dirs_rejecting`]'s
/// spawnable-first sweep, then a bounded backed-candidate preference layered on
/// top. Preference order is backed+spawnable, then spawnable, then backed, then
/// first-found — a real install always beats a foreign or orphaned program named
/// `hq`, but an unbacked candidate is still returned (marked) when it is all that
/// exists, so an installed-but-broken third-party CLI keeps reporting honestly.
///
/// This is the single sweep that replaces the previous per-lane calls: feed it
/// the settings-PATH dirs FIRST, then the extended search dirs, and the
/// spawnable pass covers every lane before ANY lane's non-spawnable fallback — so
/// a spawnable `hq.cmd` in a later lane can no longer be pre-empted by a
/// non-spawnable extensionless `hq` in an earlier one. Directory precedence
/// within each pass is unchanged, so settings-PATH keeps first position among
/// equally-ranked hits.
///
/// Cost is bounded and short-circuited on the winner: the base sweep runs once,
/// and the backing oracle is consulted first on the single candidate the sweep
/// already picked. Only when THAT winner is unbacked does the selection widen to
/// look for a backed candidate that outranks it — so the healthy hot path (a
/// backed first hit) performs exactly one backing check and no widening. The
/// oracle does bounded filesystem reads only: no spawn, no network, no loop.
pub fn select_hq_program_in_dirs(
    dirs: &[PathBuf],
    candidates: &[String],
    exists: &dyn Fn(&Path) -> bool,
    reject: &dyn Fn(&Path) -> bool,
    backing: &dyn Fn(&Path) -> CandidateBacking,
) -> Option<ResolvedProgram> {
    let base = select_program_in_dirs_rejecting(dirs, candidates, exists, reject)?;
    // The base winner is already the best of its spawnability class (first
    // spawnable, else first found). If it is also backed it cannot be outranked —
    // return it without probing any other candidate's backing.
    if backing(Path::new(&base.path)).is_backed() {
        return Some(base);
    }
    // The base winner is unbacked. Widen for a backed candidate that outranks it:
    //   - a spawnable base (tier 2) is only beaten by a backed+spawnable (tier 1);
    //   - a non-spawnable base (tier 4 — no spawnable exists anywhere) is beaten by
    //     the first backed candidate (tier 3).
    let spawnable_only = base.is_spawnable();
    first_backed_candidate(dirs, candidates, exists, reject, backing, spawnable_only).or(Some(base))
}

/// First existing, non-rejected, BACKED candidate in resolver order (directory
/// precedence, spawnable candidates first). When `spawnable_only`, non-spawnable
/// candidates are skipped so a backed non-spawnable can never outrank an unbacked
/// spawnable. Used only on the widen path, so its extra backing probes never
/// touch the healthy hot path.
fn first_backed_candidate(
    dirs: &[PathBuf],
    candidates: &[String],
    exists: &dyn Fn(&Path) -> bool,
    reject: &dyn Fn(&Path) -> bool,
    backing: &dyn Fn(&Path) -> CandidateBacking,
    spawnable_only: bool,
) -> Option<ResolvedProgram> {
    let passes: &[bool] = if spawnable_only {
        &[true]
    } else {
        &[true, false]
    };
    for spawnable_pass in passes {
        for dir in dirs {
            for candidate in candidates {
                if is_spawnable_program(candidate) != *spawnable_pass {
                    continue;
                }
                let full = dir.join(candidate);
                if exists(&full) && !reject(&full) && backing(&full).is_backed() {
                    return Some(ResolvedProgram {
                        path: full.to_string_lossy().to_string(),
                        kind: program_kind(candidate),
                    });
                }
            }
        }
    }
    None
}

/// [`select_hq_program_in_dirs`] against the real filesystem, with the real
/// backing oracle. This is the exact call the Windows `hq` arm of
/// [`resolve_bin_with_kind`] makes, so the pure selection is compiled and
/// exercised on every CI leg, not only on windows-latest.
pub fn select_hq_program_on_disk(
    dirs: &[PathBuf],
    candidates: &[String],
    reject: &dyn Fn(&Path) -> bool,
    backing: &dyn Fn(&Path) -> CandidateBacking,
) -> Option<ResolvedProgram> {
    select_hq_program_in_dirs(
        dirs,
        candidates,
        &|path: &Path| path.exists(),
        reject,
        backing,
    )
}

/// Pick the best program out of an ordered `where.exe` match list.
///
/// Keeps the long-standing preference (first `.exe`/`.cmd`/`.bat`, else the
/// first match) and only adds the classification. The fall-back-to-first is
/// load-bearing and pinned by test: `where.exe` can list an extensionless
/// POSIX script first, and the caller still needs a determinate program to
/// report against rather than a silent "not installed".
pub fn pick_spawnable_program(paths: &[&str]) -> Option<ResolvedProgram> {
    paths
        .iter()
        .find(|path| is_spawnable_program(path))
        .or_else(|| paths.first())
        .map(|path| ResolvedProgram {
            path: (*path).to_string(),
            kind: program_kind(path),
        })
}

pub fn candidate_filenames(name: &str) -> Vec<String> {
    if name.ends_with(EXE_EXT) || name.ends_with(".cmd") || name.ends_with(".bat") {
        return vec![name.to_string()];
    }

    #[cfg(target_os = "windows")]
    {
        vec![
            format!("{name}.exe"),
            format!("{name}.cmd"),
            format!("{name}.bat"),
            name.to_string(),
        ]
    }

    #[cfg(not(target_os = "windows"))]
    {
        vec![format!("{name}{EXE_EXT}"), name.to_string()]
    }
}

pub fn spawn_command(path: &str, args: &[&str]) -> std::process::Command {
    // On Windows, std::process::Command recognizes .cmd/.bat programs and
    // performs its own cmd.exe dispatch with batch-aware argument escaping.
    // Keep the program and arguments structured here: manually invoking
    // cmd.exe would turn caller-controlled HQ arguments into shell syntax.
    let mut cmd = std::process::Command::new(path);
    cmd.args(args);
    no_window(&mut cmd);
    cmd
}

/// Background `git` probe helper for HQ-tree scans (project creator history).
///
/// Applies [`no_window`] so Windows project/Overview refreshes do not flash a
/// console for every `git` invocation. Also sets `GIT_OPTIONAL_LOCKS=0` so
/// read-only history walks never contend with an interactive git index lock.
pub fn git_command() -> Command {
    let mut cmd = Command::new("git");
    no_window(&mut cmd);
    cmd.env("GIT_OPTIONAL_LOCKS", "0");
    cmd
}

/// Tokio equivalent of [`spawn_command`]. Tokio wraps std::process::Command,
/// so Windows npm shims retain Rust's batch-aware dispatch and escaping.
pub fn tokio_spawn_command(path: &str, args: &[&str]) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(path);
    cmd.args(args);
    no_window_tokio(&mut cmd);
    cmd
}

/// Append `<version-dir>/<subdir>` for every immediate child of `versions_root`.
/// Used to enumerate the per-version `bin` dirs of the version managers that lay
/// out an installed node like nvm does (`<root>/<version>/…/bin`).
#[cfg(not(target_os = "windows"))]
fn push_versioned_node_bins(out: &mut Vec<PathBuf>, versions_root: &Path, subdirs: &[&str]) {
    if let Ok(entries) = std::fs::read_dir(versions_root) {
        for entry in entries.flatten() {
            for sub in subdirs {
                out.push(entry.path().join(sub));
            }
        }
    }
}

/// Interpreter directories owned by Node version managers and system package
/// managers OTHER than nvm, so a node-shebanged `hq` still resolves its
/// interpreter when the user manages Node with fnm, Volta, asdf, mise, nodenv,
/// MacPorts, or Nix. Every entry is filtered to those that exist, so an absent
/// manager contributes nothing. Kept pure (a fixture `home`) so the enumeration
/// is unit-testable without the developer machine's real HOME.
#[cfg(not(target_os = "windows"))]
fn node_version_manager_dirs(home: &Path) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();

    // fnm — each installed node version, under the legacy `~/.fnm` root or the
    // XDG data dir; the interpreter is one level below `installation/bin`.
    for root in [
        home.join(".fnm"),
        home.join(".local").join("share").join("fnm"),
    ] {
        push_versioned_node_bins(
            &mut dirs,
            &root.join("node-versions"),
            &["installation/bin", "bin"],
        );
    }
    // Volta keeps its managed shims in a single bin dir.
    dirs.push(home.join(".volta").join("bin"));
    // asdf — each nodejs install plus the global shim dir.
    push_versioned_node_bins(
        &mut dirs,
        &home.join(".asdf").join("installs").join("nodejs"),
        &["bin"],
    );
    dirs.push(home.join(".asdf").join("shims"));
    // mise (the rtx successor) — each node install plus its shim dir.
    let mise = home.join(".local").join("share").join("mise");
    push_versioned_node_bins(&mut dirs, &mise.join("installs").join("node"), &["bin"]);
    dirs.push(mise.join("shims"));
    // nodenv — each version plus its shim dir.
    push_versioned_node_bins(
        &mut dirs,
        &home.join(".nodenv").join("versions"),
        &["bin"],
    );
    dirs.push(home.join(".nodenv").join("shims"));
    // Nix profiles.
    dirs.push(home.join(".nix-profile").join("bin"));
    dirs.push(PathBuf::from("/nix/var/nix/profiles/default/bin"));
    // MacPorts.
    dirs.push(PathBuf::from("/opt/local/bin"));

    dirs.retain(|dir| dir.exists());
    dirs
}

/// Build a PATH value suitable for handing to a spawned child process.
///
/// **Why this exists:** even after we resolve a launcher binary to an absolute
/// path via `resolve_bin`, the *child itself* still inherits the parent's
/// PATH. Node-backed CLIs use `#!/usr/bin/env node` shebangs — `env` does a
/// PATH lookup for `node`. Under the minimal launchd PATH a Dock-launched
/// Tauri app inherits, that lookup fails and the child exits with 127
/// ("command not found"). Same applies to anything the script itself spawns.
///
/// We prepend likely interpreter locations (nvm versions, npm-global,
/// homebrew) to whatever PATH we have so shebangs resolve cleanly.
///
/// Order: managed HQ toolchain → nvm node dirs → `~/.npm-global/bin` →
/// `/opt/homebrew/bin` → `/usr/local/bin` → system defaults → parent PATH.
pub fn child_path() -> String {
    #[cfg(target_os = "windows")]
    {
        let mut parts: Vec<String> = Vec::new();
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

        // Claude Code settings PATH first — strict parity with the PATH a
        // session hands to `hq`, so a node-shebanged `hq` finds the same tools.
        for dir in settings_path_dirs() {
            let s = dir.to_string_lossy().to_string();
            if !s.is_empty() && seen.insert(s.to_lowercase()) {
                parts.push(s);
            }
        }

        for dir in extended_search_dirs() {
            let s = dir.to_string_lossy().to_string();
            if !s.is_empty() && seen.insert(s.to_lowercase()) {
                parts.push(s);
            }
        }

        if let Ok(windir) = std::env::var("SystemRoot") {
            for sub in ["system32", "System32\\WindowsPowerShell\\v1.0", ""] {
                let candidate = if sub.is_empty() {
                    PathBuf::from(&windir)
                } else {
                    PathBuf::from(&windir).join(sub)
                };
                let s = candidate.to_string_lossy().to_string();
                if !s.is_empty() && seen.insert(s.to_lowercase()) {
                    parts.push(s);
                }
            }
        }

        if let Ok(existing) = std::env::var("PATH") {
            for p in existing.split(PATH_SEP) {
                if !p.is_empty() && seen.insert(p.to_lowercase()) {
                    parts.push(p.to_string());
                }
            }
        }

        return parts.join(&PATH_SEP.to_string());
    }

    #[cfg(not(target_os = "windows"))]
    {
        let mut parts: Vec<String> = Vec::new();

        // Claude Code settings PATH first — strict parity with the PATH a
        // session hands to `hq`, so a node-shebanged `hq` finds the same tools.
        for dir in settings_path_dirs() {
            parts.push(dir.to_string_lossy().to_string());
        }

        if let Some(home) = home_dir() {
            // Managed HQ toolchain (installed by hq-installer) — checked first
            // so users who only have Node via the installer can resolve `npx`
            // and node shebangs.
            let toolchain = managed_toolchain_dir(&home);
            for subdir in MANAGED_TOOLCHAIN_BIN_SUBDIRS {
                let bin = toolchain.join(subdir);
                if bin.exists() {
                    parts.push(bin.to_string_lossy().to_string());
                }
            }
            // ~/.local/bin: the installer's direct-binary yq/jq fallback dir.
            let local_bin = home.join(".local").join("bin");
            if local_bin.exists() {
                parts.push(local_bin.to_string_lossy().to_string());
            }

            // nvm: prepend every installed node version's bin dir. Order doesn't
            // matter for correctness (any working `node` resolves `env node`).
            let nvm_versions = home.join(".nvm").join("versions").join("node");
            if let Ok(entries) = std::fs::read_dir(&nvm_versions) {
                for entry in entries.flatten() {
                    let bin = entry.path().join("bin");
                    if bin.exists() {
                        parts.push(bin.to_string_lossy().to_string());
                    }
                }
            }
            // User-level npm/pnpm prefixes (no-sudo installs).
            for dir in user_cli_dirs(&home) {
                if dir.exists() {
                    parts.push(dir.to_string_lossy().to_string());
                }
            }
        }

        for p in [
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
            "/usr/sbin",
            "/sbin",
        ] {
            parts.push(p.to_string());
        }

        if let Ok(existing) = std::env::var("PATH") {
            for p in existing.split(':') {
                if !p.is_empty() && !parts.iter().any(|x| x == p) {
                    parts.push(p.to_string());
                }
            }
        }

        // Other Node version managers (fnm/Volta/asdf/mise/nodenv) and system
        // package managers (MacPorts/Nix), appended LAST — a pure last-resort
        // interpreter source. Placed after the inherited PATH so they can never
        // override the node the user's manager, an nvm install, or the inherited
        // PATH already selected: sync and daemon launches keep the active
        // version, while a machine with no node anywhere still gets an
        // interpreter for the version probe to recover with.
        if let Some(home) = home_dir() {
            for dir in node_version_manager_dirs(&home) {
                parts.push(dir.to_string_lossy().to_string());
            }
        }

        // Stable de-dup: a settings-PATH dir may repeat a managed/system entry
        // pushed later. Keep the first (highest-priority) occurrence.
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        parts.retain(|p| seen.insert(p.clone()));

        parts.join(&PATH_SEP.to_string())
    }
}

/// Prepend an interpreter-hint directory to a child PATH unless it is already
/// present. The version probe uses this to add the directory that ships a
/// `node` interpreter beside the resolved CLI shim — the managed Node's bin
/// dir, or the shim's own parent — so a `#!/usr/bin/env node` shebang resolves
/// on a recovery retry even when the base child PATH could not find `node`.
///
/// Pure and order-preserving (mirrors [`crate::hq_cli_update::pnpm_child_path`]):
/// the hint goes first so it wins the interpreter lookup, and a hint already on
/// the PATH is left untouched rather than duplicated.
pub fn path_with_interpreter_hint(base_path: &str, hint_dir: &Path) -> String {
    let hint = hint_dir.to_string_lossy();
    if hint.is_empty() || base_path.split(PATH_SEP).any(|segment| segment == hint) {
        return base_path.to_string();
    }
    if base_path.is_empty() {
        return hint.into_owned();
    }
    format!("{hint}{PATH_SEP}{base_path}")
}

/// Returns the path to ~/.hq/config.json.
pub fn config_json_path() -> Result<PathBuf, String> {
    Ok(hq_config_dir()?.join("config.json"))
}

/// Returns the path to ~/.hq/menubar.json.
pub fn menubar_json_path() -> Result<PathBuf, String> {
    Ok(hq_config_dir()?.join("menubar.json"))
}

/// Returns the path to ~/.hq/sync-version.json.
///
/// This app records its own version here on launch so the hq-cli can attach
/// the installed hq-sync version to feedback submissions — the CLI has no
/// other way to learn the running menubar app version. Owned exclusively by
/// this app; the CLI only reads it (best-effort, absent => "not installed").
pub fn sync_version_json_path() -> Result<PathBuf, String> {
    Ok(hq_config_dir()?.join("sync-version.json"))
}

/// Returns the path to ~/.hq/sync-packs-cache.json.
///
/// Owned exclusively by this app — last-known `list_packages` snapshot for
/// instant popover render. Distinct from `~/.hq/pack-update-cache.json`,
/// which is owned by the hq CLI's update prober.
pub fn packs_cache_json_path() -> Result<PathBuf, String> {
    Ok(hq_config_dir()?.join("sync-packs-cache.json"))
}

/// Returns the path to ~/.hq/deploy-prefs.json.
///
/// This file is owned exclusively by hq-core's `/deploy` skill — it persists
/// `defaultOrg` and `deploy.preference`. hq-sync only touches it during the
/// one-shot legacy stub migration (see
/// `commands::config::migrate_legacy_config_stub`).
pub fn deploy_prefs_json_path() -> Result<PathBuf, String> {
    Ok(hq_config_dir()?.join("deploy-prefs.json"))
}

/// Resolve the HQ folder path with priority:
/// 1. menubar_override (from menubar.json hqPath)
/// 2. config_path (from config.json hqFolderPath)
/// 3. Discovery: scan likely locations for a folder containing a valid
///    `core.yaml` (the canonical hq-core marker — version + hqVersion fields).
///    Both v14+ (`core/core.yaml`) and legacy (`core.yaml` at root) layouts
///    are accepted; see `is_valid_hq_root`. First match wins. This is the
///    safety net for installs that didn't write the path back to menubar.json
///    (older installer flows).
/// 4. ~/HQ default
pub fn resolve_hq_folder(config_path: Option<&str>, menubar_override: Option<&str>) -> PathBuf {
    // Priority 1: menubar.json override
    if let Some(path) = menubar_override {
        if !path.is_empty() {
            return PathBuf::from(path);
        }
    }

    // Priority 2: config.json hqFolderPath
    if let Some(path) = config_path {
        if !path.is_empty() {
            return PathBuf::from(path);
        }
    }

    // Priority 3: discover via core.yaml signature.
    if let Some(found) = discover_hq_folder_via_core_yaml() {
        return found;
    }

    // Priority 4: ~/HQ default
    home_dir().unwrap_or_else(|| PathBuf::from("/")).join("HQ")
}

/// Candidate parent paths the installer wizard typically uses (or that users
/// commonly choose). First entry that contains a valid `core.yaml` wins.
/// Order matters — most-likely first to avoid scanning the entire home dir.
fn hq_discovery_candidates() -> Vec<PathBuf> {
    let home = match home_dir() {
        Some(h) => h,
        None => return Vec::new(),
    };
    vec![
        home.join("HQ"),
        home.join("hq"),
        home.join("Documents").join("HQ"),
        home.join("Documents").join("hq"),
        home.join("Desktop").join("HQ"),
        home.join("Desktop").join("hq"),
    ]
}

/// True iff the candidate folder contains a `core.yaml` (canonical or
/// legacy location) that parses as YAML and has the canonical hq-core
/// schema fields (`version` + `hqVersion`). Validates beyond mere presence
/// so a random folder named `core.yaml` (config file from another tool,
/// abandoned scratch) won't false-match.
///
/// File location is layout-aware:
///   * **canonical (v14+):** `<path>/core/core.yaml`
///   * **legacy (pre-v14):** `<path>/core.yaml`
///
/// The v14 hq-core release moved `core.yaml` one level deeper (see
/// `apps/hq-core/MIGRATION.md` — "Root core.yaml; canonical location is
/// core/core.yaml"). Before that fix, Priority 3 discovery silently
/// rejected every v14+ HQ folder and fell through to the `~/HQ` default.
pub fn is_valid_hq_root(path: &Path) -> bool {
    let canonical = path.join("core").join("core.yaml");
    let legacy = path.join("core.yaml");
    let core_yaml = if canonical.is_file() {
        canonical
    } else if legacy.is_file() {
        legacy
    } else {
        return false;
    };
    let bytes = match std::fs::read(&core_yaml) {
        Ok(b) => b,
        Err(_) => return false,
    };
    let parsed: serde_yaml::Value = match serde_yaml::from_slice(&bytes) {
        Ok(v) => v,
        Err(_) => return false,
    };
    // Both fields must be present per the hq-core schema (see
    // indigoai-us/hq-core core/core.yaml). `version` is the schema version,
    // `hqVersion` is the template version. Random YAML files won't have both.
    parsed.get("version").is_some() && parsed.get("hqVersion").is_some()
}

/// Scan the well-known candidate locations for an HQ folder. Returns the
/// first valid root found, or None. Cheap — a few `stat` calls plus one
/// small YAML parse on a hit; no fs walk.
pub fn discover_hq_folder_via_core_yaml() -> Option<PathBuf> {
    hq_discovery_candidates()
        .into_iter()
        .find(|p| is_valid_hq_root(p))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_hq_config_dir() {
        let dir = hq_config_dir().unwrap();
        assert!(dir.ends_with(".hq"));
    }

    // ---- settings_path_dirs_in: the strict-parity PATH reader -------------

    /// Write `.claude/<file>` under `root` with the given JSON body.
    fn write_settings(root: &Path, file: &str, body: &str) {
        let claude = root.join(".claude");
        std::fs::create_dir_all(&claude).unwrap();
        std::fs::write(claude.join(file), body).unwrap();
    }

    #[test]
    fn settings_path_dirs_reads_local_env_path_in_order() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();
        let a = tmp.path().join("a");
        let b = tmp.path().join("b");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        let sep = PATH_SEP;
        write_settings(
            root,
            "settings.local.json",
            &format!(
                "{{\"env\":{{\"PATH\":\"{}{sep}{}\"}}}}",
                a.display(),
                b.display()
            ),
        );
        let dirs = settings_path_dirs_in(root);
        assert_eq!(dirs, vec![a, b]);
    }

    #[test]
    fn settings_local_path_overrides_base_not_concatenated() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();
        let local = tmp.path().join("local");
        let base = tmp.path().join("base");
        std::fs::create_dir_all(&local).unwrap();
        std::fs::create_dir_all(&base).unwrap();
        write_settings(
            root,
            "settings.local.json",
            &format!("{{\"env\":{{\"PATH\":\"{}\"}}}}", local.display()),
        );
        write_settings(
            root,
            "settings.json",
            &format!("{{\"env\":{{\"PATH\":\"{}\"}}}}", base.display()),
        );
        // env.PATH is a scalar: local OVERRIDES base — base is NOT appended.
        assert_eq!(settings_path_dirs_in(root), vec![local]);
    }

    #[test]
    fn settings_base_used_only_when_local_has_no_path() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();
        let base = tmp.path().join("base");
        std::fs::create_dir_all(&base).unwrap();
        // Local exists but defines no env.PATH -> fall through to base.
        write_settings(root, "settings.local.json", "{\"env\":{}}");
        write_settings(
            root,
            "settings.json",
            &format!("{{\"env\":{{\"PATH\":\"{}\"}}}}", base.display()),
        );
        assert_eq!(settings_path_dirs_in(root), vec![base]);
    }

    #[test]
    fn winning_settings_path_file_names_local_base_or_none() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();
        // Nothing at all -> None.
        assert_eq!(winning_settings_path_file(root), SettingsPathFile::None);
        // Only base defines env.PATH -> Base.
        write_settings(root, "settings.json", "{\"env\":{\"PATH\":\"/x\"}}");
        assert_eq!(winning_settings_path_file(root), SettingsPathFile::Base);
        // Local exists but with an empty/absent env.PATH -> still Base.
        write_settings(root, "settings.local.json", "{\"env\":{}}");
        assert_eq!(winning_settings_path_file(root), SettingsPathFile::Base);
        // Local defines a non-empty env.PATH -> Local wins outright.
        write_settings(root, "settings.local.json", "{\"env\":{\"PATH\":\"/y\"}}");
        assert_eq!(winning_settings_path_file(root), SettingsPathFile::Local);
        // A malformed local file is skipped, not fatal, and falls through to base.
        write_settings(root, "settings.local.json", "{not json");
        assert_eq!(winning_settings_path_file(root), SettingsPathFile::Base);
    }

    #[test]
    fn settings_path_file_filename_and_tokens_are_closed() {
        assert_eq!(
            SettingsPathFile::Local.filename(),
            Some("settings.local.json")
        );
        assert_eq!(SettingsPathFile::Base.filename(), Some("settings.json"));
        assert_eq!(SettingsPathFile::None.filename(), None);
        assert_eq!(SettingsPathFile::Local.telemetry_value(), "local");
        assert_eq!(SettingsPathFile::Base.telemetry_value(), "base");
        assert_eq!(SettingsPathFile::None.telemetry_value(), "none");
        // The default file is the safe "nothing supplies a PATH" state.
        assert_eq!(SettingsPathFile::default(), SettingsPathFile::None);
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn is_executable_file_requires_exec_bit_and_regular_file() {
        let tmp = tempfile::TempDir::new().unwrap();
        // A directory named `hq` must not count.
        let dir_named_hq = tmp.path().join("hq_dir");
        std::fs::create_dir_all(&dir_named_hq).unwrap();
        assert!(!is_executable_file(&dir_named_hq));
        // A non-executable regular file must not count.
        let plain = tmp.path().join("plain");
        std::fs::write(&plain, b"#!/bin/sh\n").unwrap();
        assert!(!is_executable_file(&plain));
        // An executable regular file counts.
        use std::os::unix::fs::PermissionsExt;
        let exe = tmp.path().join("exe");
        std::fs::write(&exe, b"#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(is_executable_file(&exe));
        // A missing path is not executable.
        assert!(!is_executable_file(&tmp.path().join("nope")));
    }

    #[test]
    fn settings_path_dirs_skips_relative_and_missing_entries() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();
        let real = tmp.path().join("real");
        std::fs::create_dir_all(&real).unwrap();
        let missing = tmp.path().join("does-not-exist");
        let sep = PATH_SEP;
        write_settings(
            root,
            "settings.local.json",
            &format!(
                "{{\"env\":{{\"PATH\":\"{}{sep}some/relative/dir{sep}{}\"}}}}",
                real.display(),
                missing.display()
            ),
        );
        // Only the absolute, existing directory survives.
        assert_eq!(settings_path_dirs_in(root), vec![real]);
    }

    #[test]
    fn settings_path_dirs_empty_when_no_settings_or_no_env_path() {
        let tmp = tempfile::TempDir::new().unwrap();
        // No .claude at all.
        assert!(settings_path_dirs_in(tmp.path()).is_empty());
        // Present but no env.PATH key.
        write_settings(tmp.path(), "settings.local.json", "{\"env\":{}}");
        assert!(settings_path_dirs_in(tmp.path()).is_empty());
        // Malformed JSON is ignored, not a panic.
        write_settings(tmp.path(), "settings.json", "{not json");
        assert!(settings_path_dirs_in(tmp.path()).is_empty());
    }

    #[test]
    fn test_config_json_path() {
        let path = config_json_path().unwrap();
        assert!(path.ends_with("config.json"));
        assert!(path.parent().unwrap().ends_with(".hq"));
    }

    #[test]
    fn test_menubar_json_path() {
        let path = menubar_json_path().unwrap();
        assert!(path.ends_with("menubar.json"));
    }

    #[test]
    fn test_packs_cache_json_path() {
        let path = packs_cache_json_path().unwrap();
        assert!(path.ends_with("sync-packs-cache.json"));
        assert!(path.parent().unwrap().ends_with(".hq"));
    }

    #[test]
    fn managed_npm_prefix_and_bin_have_the_installer_layout() {
        let root = PathBuf::from(if cfg!(windows) {
            r"C:\Users\me\AppData\Local\IndigoHQ\toolchain"
        } else {
            "/home/me/Library/Application Support/Indigo HQ/toolchain"
        });

        let prefix = managed_npm_prefix_in(&root);
        let bin = managed_npm_bin_in(&root);

        #[cfg(windows)]
        {
            // Flat `npm-prefix` with shims written directly into it (no `bin/`).
            assert_eq!(prefix, root.join("npm-prefix"));
            assert_eq!(bin, root.join("npm-prefix"));
        }

        #[cfg(not(windows))]
        {
            // `npm-global` with npm's default `<prefix>/bin` shim layout.
            assert_eq!(prefix, root.join("npm-global"));
            assert_eq!(bin, root.join("npm-global").join("bin"));
        }

        // The prefix sits directly under the toolchain root, next to the managed
        // Node — never inside `node/`.
        assert_eq!(prefix.parent().unwrap(), root.as_path());
        assert_ne!(prefix, managed_node_dir_in(&root));
    }

    #[test]
    fn test_resolve_menubar_override_wins() {
        let result = resolve_hq_folder(Some("/from/config"), Some("/from/menubar"));
        assert_eq!(result, PathBuf::from("/from/menubar"));
    }

    #[test]
    fn test_resolve_config_path() {
        let result = resolve_hq_folder(Some("/from/config"), None);
        assert_eq!(result, PathBuf::from("/from/config"));
    }

    #[test]
    fn test_resolve_default() {
        let result = resolve_hq_folder(None, None);
        assert!(result.ends_with("HQ"));
    }

    #[test]
    fn test_resolve_empty_menubar_falls_through() {
        let result = resolve_hq_folder(Some("/from/config"), Some(""));
        assert_eq!(result, PathBuf::from("/from/config"));
    }

    #[test]
    fn test_resolve_empty_both_falls_to_default() {
        let result = resolve_hq_folder(Some(""), Some(""));
        assert!(result.ends_with("HQ"));
    }

    #[test]
    fn test_resolve_bin_returns_name_when_missing() {
        // A name that almost certainly doesn't exist anywhere
        let result = resolve_bin("hq-sync-nonexistent-xyz-123");
        assert_eq!(result, "hq-sync-nonexistent-xyz-123");
    }

    // ── Windows program selection (pure; runs on every CI leg, and matches the
    // `paths::tests::test_windows` substring filter windows-check.yml uses) ──

    /// Windows candidate order for an extensionless request, mirroring
    /// `candidate_filenames` on that platform.
    fn windows_candidates(name: &str) -> Vec<String> {
        vec![
            format!("{name}.exe"),
            format!("{name}.cmd"),
            format!("{name}.bat"),
            name.to_string(),
        ]
    }

    /// Existence oracle over an explicit `(directory, filename)` set. Built by
    /// joining rather than by literal strings so the pure selection tests read
    /// identically on every platform's path separator.
    fn present(entries: &[(&PathBuf, &str)]) -> impl Fn(&Path) -> bool {
        let present: Vec<PathBuf> = entries.iter().map(|(dir, file)| dir.join(file)).collect();
        move |path: &Path| present.iter().any(|candidate| candidate == path)
    }

    /// The Windows search order this project actually ships, named so the
    /// selection tests describe the field layout rather than a toy one.
    fn windows_dirs() -> (PathBuf, PathBuf, PathBuf, PathBuf) {
        (
            PathBuf::from("C:").join("toolchain").join("npm-prefix"),
            PathBuf::from("C:")
                .join("Users")
                .join("dev")
                .join(".hq")
                .join("bin"),
            PathBuf::from("C:")
                .join("Program Files")
                .join("Git")
                .join("usr")
                .join("bin"),
            PathBuf::from("C:")
                .join("Users")
                .join("dev")
                .join("AppData")
                .join("Roaming")
                .join("npm"),
        )
    }

    #[test]
    fn test_windows_spawnable_predicate_accepts_only_executable_image_forms() {
        for spawnable in ["hq.exe", "hq.EXE", "hq.cmd", "hq.Cmd", "hq.bat", "hq.BAT"] {
            assert!(
                is_spawnable_program(spawnable),
                "{spawnable} must be treated as spawnable"
            );
        }
        for rejected in ["hq", "hq.ps1", "hq.js", "hq.sh", "hq.py"] {
            assert!(
                !is_spawnable_program(rejected),
                "{rejected} is not an executable image CreateProcess accepts"
            );
        }
        assert_eq!(program_kind("hq.exe"), ResolvedProgramKind::Exe);
        assert_eq!(program_kind("hq.cmd"), ResolvedProgramKind::CmdOrBat);
        assert_eq!(program_kind("hq.bat"), ResolvedProgramKind::CmdOrBat);
        assert_eq!(program_kind("hq"), ResolvedProgramKind::Extensionless);
        assert_eq!(program_kind("hq.ps1"), ResolvedProgramKind::OtherExtension);
        // A dot in a *directory* must not be read as the program's extension.
        assert_eq!(
            program_kind(r"C:\Program Files\Git\usr\bin\hq"),
            ResolvedProgramKind::Extensionless
        );
    }

    #[test]
    fn test_windows_selection_prefers_a_spawnable_match_in_a_later_directory() {
        // The field shape: a bare POSIX shim sits in an EARLY search directory
        // and the real npm shim in a LATER one. First-exists returned the bare
        // shim, whose spawn dies with os error 193.
        let (_, hq_bin, git_usr_bin, appdata_npm) = windows_dirs();
        let dirs = vec![hq_bin, git_usr_bin.clone(), appdata_npm.clone()];
        let selected = select_program_in_dirs(
            &dirs,
            &windows_candidates("hq"),
            &present(&[(&git_usr_bin, "hq"), (&appdata_npm, "hq.cmd")]),
        )
        .expect("a spawnable candidate exists");

        assert_eq!(
            selected,
            ResolvedProgram {
                path: appdata_npm.join("hq.cmd").to_string_lossy().to_string(),
                kind: ResolvedProgramKind::CmdOrBat,
            },
            "a spawnable candidate in any directory must beat a non-spawnable earlier hit"
        );
    }

    #[test]
    fn test_windows_selection_preserves_directory_and_candidate_precedence() {
        let (npm_prefix, _, _, appdata_npm) = windows_dirs();
        let dirs = vec![npm_prefix.clone(), appdata_npm.clone()];

        // Directory precedence among spawnable candidates is unchanged.
        let selected = select_program_in_dirs(
            &dirs,
            &windows_candidates("hq"),
            &present(&[(&npm_prefix, "hq.cmd"), (&appdata_npm, "hq.cmd")]),
        )
        .unwrap();
        assert_eq!(selected.path, npm_prefix.join("hq.cmd").to_string_lossy());

        // Candidate order within a directory is unchanged: .exe still wins.
        let selected = select_program_in_dirs(
            &dirs,
            &windows_candidates("hq"),
            &present(&[
                (&npm_prefix, "hq.exe"),
                (&npm_prefix, "hq.cmd"),
                (&npm_prefix, "hq.bat"),
            ]),
        )
        .unwrap();
        assert_eq!(selected.path, npm_prefix.join("hq.exe").to_string_lossy());
        assert_eq!(selected.kind, ResolvedProgramKind::Exe);
    }

    #[test]
    fn test_windows_selection_marks_a_non_spawnable_hit_rather_than_dropping_it() {
        // No spawnable candidate exists ANYWHERE. Collapsing to `None` here
        // would resolve to the bare name, flip `hq_installed` to false, and
        // silence the installed-but-unreadable report while the CLI stays
        // broken. The hit must survive, marked.
        let (_, hq_bin, git_usr_bin, _) = windows_dirs();
        let dirs = vec![hq_bin.clone(), git_usr_bin.clone()];
        let selected = select_program_in_dirs(
            &dirs,
            &windows_candidates("hq"),
            &present(&[(&hq_bin, "hq"), (&git_usr_bin, "hq")]),
        )
        .expect("a non-spawnable hit must still resolve");

        assert_eq!(selected.path, hq_bin.join("hq").to_string_lossy());
        assert_eq!(selected.kind, ResolvedProgramKind::Extensionless);
        assert!(!selected.is_spawnable());
        assert!(selected.is_resolved());

        // Nothing anywhere stays unresolved.
        assert_eq!(
            select_program_in_dirs(&dirs, &windows_candidates("hq"), &present(&[])),
            None
        );
    }

    /// The same sweep the Windows resolver runs, against a real temp tree —
    /// so the on-disk call path is compiled and executed on every CI leg, not
    /// only on windows-latest.
    #[test]
    fn test_windows_on_disk_sweep_recovers_the_spawnable_shim() {
        let tmp = tempfile::TempDir::new().unwrap();
        let early = tmp.path().join("git-usr-bin");
        let later = tmp.path().join("appdata-npm");
        std::fs::create_dir_all(&early).unwrap();
        std::fs::create_dir_all(&later).unwrap();
        std::fs::write(early.join("hq"), "posix shim\n").unwrap();
        std::fs::write(later.join("hq.cmd"), "@echo off\n").unwrap();

        let dirs = vec![early.clone(), later.clone()];
        let selected = select_program_on_disk(&dirs, &windows_candidates("hq")).unwrap();
        assert_eq!(selected.path, later.join("hq.cmd").to_string_lossy());
        assert_eq!(selected.kind, ResolvedProgramKind::CmdOrBat);

        // Remove the spawnable shim: the bare one is still resolved, marked.
        std::fs::remove_file(later.join("hq.cmd")).unwrap();
        let selected = select_program_on_disk(&dirs, &windows_candidates("hq")).unwrap();
        assert_eq!(selected.path, early.join("hq").to_string_lossy());
        assert_eq!(selected.kind, ResolvedProgramKind::Extensionless);

        // Remove it too: nothing resolves.
        std::fs::remove_file(early.join("hq")).unwrap();
        assert_eq!(
            select_program_on_disk(&dirs, &windows_candidates("hq")),
            None
        );
    }

    #[test]
    fn test_windows_where_exe_fallback_to_first_is_classified_not_dropped() {
        // `where.exe` can list an extensionless POSIX script first (the
        // 2026-06-09 npx regression). The preference still picks the spawnable
        // entry when one exists…
        let picked = pick_spawnable_program(&[
            r"C:\Program Files\Git\usr\bin\npx",
            r"C:\Program Files\nodejs\npx.cmd",
        ])
        .unwrap();
        assert_eq!(picked.path, r"C:\Program Files\nodejs\npx.cmd");
        assert_eq!(picked.kind, ResolvedProgramKind::CmdOrBat);

        // …and when none does, the first match is still returned, marked —
        // never dropped to "not installed".
        let picked =
            pick_spawnable_program(&[r"C:\Program Files\Git\usr\bin\hq", r"C:\Users\dev\hq.ps1"])
                .unwrap();
        assert_eq!(picked.path, r"C:\Program Files\Git\usr\bin\hq");
        assert_eq!(picked.kind, ResolvedProgramKind::Extensionless);

        assert_eq!(pick_spawnable_program(&[]), None);
    }

    #[test]
    fn test_windows_selection_keeps_other_binaries_on_their_existing_precedence() {
        // resolve_bin is shared by every Windows lookup (node, npm, npx, git,
        // gh, the recall sidecar). Prefer-spawnable must not reorder callers
        // that already resolve to a spawnable program.
        let node_dir = PathBuf::from("C:").join("toolchain").join("node");
        let (npm_prefix, _, _, appdata_npm) = windows_dirs();
        let dirs = vec![node_dir.clone(), npm_prefix.clone(), appdata_npm.clone()];
        for (name, files, expected_dir, expected_file) in [
            (
                "node",
                vec![(&node_dir, "node.exe"), (&appdata_npm, "node.exe")],
                &node_dir,
                "node.exe",
            ),
            (
                "npm",
                vec![(&npm_prefix, "npm.cmd"), (&appdata_npm, "npm.cmd")],
                &npm_prefix,
                "npm.cmd",
            ),
            (
                "npx",
                vec![(&appdata_npm, "npx.cmd")],
                &appdata_npm,
                "npx.cmd",
            ),
            ("git", vec![(&node_dir, "git.exe")], &node_dir, "git.exe"),
        ] {
            let selected =
                select_program_in_dirs(&dirs, &windows_candidates(name), &present(&files)).unwrap();
            assert_eq!(
                selected.path,
                expected_dir.join(expected_file).to_string_lossy(),
                "{name} precedence changed"
            );
            assert!(selected.is_spawnable());
        }
    }

    #[test]
    fn test_windows_resolve_bin_with_kind_reports_the_unresolved_marker() {
        let resolved = resolve_bin_with_kind("hq-sync-nonexistent-xyz-123");
        assert_eq!(resolved.path, "hq-sync-nonexistent-xyz-123");
        assert_eq!(resolved.kind, ResolvedProgramKind::NotResolved);
        assert!(!resolved.is_resolved());
        assert!(!resolved.is_spawnable());
        assert_eq!(
            resolved,
            ResolvedProgram::not_resolved("hq-sync-nonexistent-xyz-123")
        );
        // The bare-name fallback `resolve_bin` has always returned is intact.
        assert_eq!(
            resolve_bin("hq-sync-nonexistent-xyz-123"),
            "hq-sync-nonexistent-xyz-123"
        );
    }

    // ---- HQ-DESKTOP-3P: cross-lane spawnable preference, backed-candidate
    // preference, and orphaned-managed-shim rejection for the `hq` lookup. ----

    /// A pure backing oracle: the listed paths are backed, everything else is a
    /// DEFINITIVE absence. Lets the selection tiers be proven without package.json
    /// fixtures on disk.
    fn backing_over<'a>(backed: &'a [PathBuf]) -> impl Fn(&Path) -> CandidateBacking + 'a {
        move |path: &Path| {
            if backed.iter().any(|candidate| candidate == path) {
                CandidateBacking::Backed
            } else {
                CandidateBacking::AbsentDefinitive
            }
        }
    }

    fn never_reject(_: &Path) -> bool {
        false
    }

    #[test]
    fn test_windows_hq_cross_lane_spawnable_beats_earlier_extensionless_settings_hit() {
        // Lane (a), field event 1bbf51ea (settings_path / extensionless /
        // spawn_not_executable): a settings-PATH dir holds an extensionless `hq`
        // (non-spawnable) and a LATER extended-search dir holds `hq.cmd`.
        let settings = PathBuf::from("C:").join("settings-path");
        let (_, _, _, appdata_npm) = windows_dirs();

        // The base lane sequence pre-empted: a settings-ONLY sweep returns the
        // extensionless file, whose spawn dies with os error 193. This is exactly
        // the separate settings call the fix collapses away.
        let settings_only = select_program_in_dirs(
            &[settings.clone()],
            &windows_candidates("hq"),
            &present(&[(&settings, "hq")]),
        )
        .expect("the settings lane finds the extensionless hq");
        assert_eq!(settings_only.kind, ResolvedProgramKind::Extensionless);

        // The fix: ONE cross-lane sweep over settings THEN extended selects the
        // later spawnable `hq.cmd`.
        let dirs = vec![settings.clone(), appdata_npm.clone()];
        let selected = select_hq_program_in_dirs(
            &dirs,
            &windows_candidates("hq"),
            &present(&[(&settings, "hq"), (&appdata_npm, "hq.cmd")]),
            &never_reject,
            &backing_over(&[]),
        )
        .expect("a spawnable candidate exists across lanes");
        assert_eq!(
            selected.path,
            appdata_npm.join("hq.cmd").to_string_lossy(),
            "a spawnable hq.cmd in a later lane must beat a non-spawnable settings hit"
        );
        assert_eq!(selected.kind, ResolvedProgramKind::CmdOrBat);
    }

    #[test]
    fn test_windows_hq_prefers_a_backed_install_over_an_earlier_unbacked_foreign_hq() {
        // A foreign spawnable `hq.cmd` sits EARLIER than the real backed install.
        // Cross-lane spawnable preference alone would keep the foreign one (both
        // spawnable); the backed-candidate preference promotes the real install so
        // the version probe reads it instead of failing on the foreign.
        let foreign = PathBuf::from("C:").join("foreign");
        let (_, _, _, appdata_npm) = windows_dirs();
        let dirs = vec![foreign.clone(), appdata_npm.clone()];
        let backed = vec![appdata_npm.join("hq.cmd")];
        let selected = select_hq_program_in_dirs(
            &dirs,
            &windows_candidates("hq"),
            &present(&[(&foreign, "hq.cmd"), (&appdata_npm, "hq.cmd")]),
            &never_reject,
            &backing_over(&backed),
        )
        .unwrap();
        assert_eq!(
            selected.path,
            appdata_npm.join("hq.cmd").to_string_lossy(),
            "a backed install must outrank an unbacked foreign hq even in a later dir"
        );
    }

    #[test]
    fn test_windows_hq_returns_an_unbacked_foreign_hq_when_it_is_all_that_exists() {
        // A foreign, unbacked `hq.cmd` and nothing else: STILL returned and marked,
        // never dropped — an installed-but-broken third-party CLI keeps reporting
        // honestly and `hq_installed` stays true.
        let foreign = PathBuf::from("C:").join("foreign");
        let dirs = vec![foreign.clone()];
        let selected = select_hq_program_in_dirs(
            &dirs,
            &windows_candidates("hq"),
            &present(&[(&foreign, "hq.cmd")]),
            &never_reject,
            &backing_over(&[]),
        )
        .expect("an unbacked foreign hq is still resolved");
        assert_eq!(selected.path, foreign.join("hq.cmd").to_string_lossy());
        assert!(selected.is_spawnable());
    }

    #[test]
    fn test_windows_hq_backed_non_spawnable_beats_unbacked_non_spawnable() {
        // No spawnable candidate anywhere. The BACKED extensionless hit (tier 3)
        // must beat the unbacked extensionless first-found (tier 4), so the probe
        // anchors to the real package.
        let early = PathBuf::from("C:").join("early");
        let later = PathBuf::from("C:").join("later");
        let dirs = vec![early.clone(), later.clone()];
        let backed = vec![later.join("hq")];
        let selected = select_hq_program_in_dirs(
            &dirs,
            &windows_candidates("hq"),
            &present(&[(&early, "hq"), (&later, "hq")]),
            &never_reject,
            &backing_over(&backed),
        )
        .unwrap();
        assert_eq!(selected.path, later.join("hq").to_string_lossy());
        assert_eq!(selected.kind, ResolvedProgramKind::Extensionless);
    }

    #[test]
    fn test_windows_hq_backed_first_hit_short_circuits_probing_backing_once() {
        // A backed spawnable first hit is returned after exactly ONE backing probe:
        // the oracle is consulted on the winner and on nothing else, keeping the
        // healthy hot path cheap.
        let (npm_prefix, _, _, appdata_npm) = windows_dirs();
        let dirs = vec![npm_prefix.clone(), appdata_npm.clone()];
        let probes = std::cell::Cell::new(0usize);
        let backing = |path: &Path| {
            probes.set(probes.get() + 1);
            if path == npm_prefix.join("hq.cmd") {
                CandidateBacking::Backed
            } else {
                CandidateBacking::AbsentDefinitive
            }
        };
        let selected = select_hq_program_in_dirs(
            &dirs,
            &windows_candidates("hq"),
            &present(&[(&npm_prefix, "hq.cmd"), (&appdata_npm, "hq.cmd")]),
            &never_reject,
            &backing,
        )
        .unwrap();
        assert_eq!(selected.path, npm_prefix.join("hq.cmd").to_string_lossy());
        assert_eq!(
            probes.get(),
            1,
            "a backed first hit must consult backing exactly once"
        );
    }

    #[test]
    fn test_windows_hq_on_disk_rejects_orphaned_managed_shim_and_selects_backed_install() {
        // Lane (b), field event 7a553866 (managed_toolchain / cmd_or_bat /
        // nonzero_exit, npm_root package_not_found): a managed-toolchain shim whose
        // @indigoai-us/hq-cli package is GONE outranks a real user-prefix install.
        // Uses the REAL backing oracle over real fixtures.
        let tmp = tempfile::TempDir::new().unwrap();
        let managed = tmp.path().join("toolchain").join("npm-prefix");
        let user = tmp.path().join("appdata").join("npm");
        std::fs::create_dir_all(&managed).unwrap();
        std::fs::create_dir_all(user.join("node_modules/@indigoai-us/hq-cli")).unwrap();
        // Orphaned managed shim: hq.cmd with NO package beside it.
        std::fs::write(managed.join("hq.cmd"), "@echo off\n").unwrap();
        // Backed user install: hq.cmd + its manifest.
        std::fs::write(user.join("hq.cmd"), "@echo off\n").unwrap();
        std::fs::write(
            user.join("node_modules/@indigoai-us/hq-cli/package.json"),
            br#"{"name":"@indigoai-us/hq-cli","version":"5.103.30"}"#,
        )
        .unwrap();

        assert_eq!(
            crate::hq_cli_update::hq_cli_backing(&managed.join("hq.cmd")),
            CandidateBacking::AbsentDefinitive,
            "the managed shim's package is definitively gone"
        );
        assert_eq!(
            crate::hq_cli_update::hq_cli_backing(&user.join("hq.cmd")),
            CandidateBacking::Backed,
            "the user install is backed by a reachable manifest"
        );

        let managed_roots = [tmp.path().join("toolchain")];
        let reject = |path: &Path| {
            is_npx_cache_path(path)
                || (path_in_any_root(path, &managed_roots)
                    && matches!(
                        crate::hq_cli_update::hq_cli_backing(path),
                        CandidateBacking::AbsentDefinitive
                    ))
        };
        let backing = |path: &Path| crate::hq_cli_update::hq_cli_backing(path);
        let cands = windows_candidates("hq");

        // The base sweep (no reject) picks the orphan first — the defect.
        let base = select_program_on_disk(&[managed.clone(), user.clone()], &cands).unwrap();
        assert_eq!(
            base.path,
            managed.join("hq.cmd").to_string_lossy(),
            "the base sweep selects the orphaned managed shim — the reported defect"
        );

        // The fix: reject the orphan, select the backed user install.
        let dirs = vec![managed.clone(), user.clone()];
        let selected = select_hq_program_on_disk(&dirs, &cands, &reject, &backing).unwrap();
        assert_eq!(
            selected.path,
            user.join("hq.cmd").to_string_lossy(),
            "the backed user install must win over the orphaned managed shim"
        );

        // Orphan-only: nothing resolves (rejected), so hq_installed flips false and
        // the existing installer can put a real CLI on the machine.
        assert_eq!(
            select_hq_program_on_disk(&[managed.clone()], &cands, &reject, &backing),
            None,
            "an orphan-only machine resolves to the not-resolved marker"
        );
    }

    #[test]
    fn test_windows_hq_indeterminate_backing_never_rejects_the_managed_shim() {
        // A managed shim whose hq-cli manifest cannot be READ (here the manifest
        // path is a directory, standing in for a permission/AV lock) is
        // INDETERMINATE, not a definitive absence — so it must NOT be rejected. A
        // transient read failure must never turn a working machine into a reinstall.
        let tmp = tempfile::TempDir::new().unwrap();
        let managed = tmp.path().join("toolchain").join("npm-prefix");
        std::fs::create_dir_all(managed.join("node_modules/@indigoai-us/hq-cli/package.json"))
            .unwrap();
        std::fs::write(managed.join("hq.cmd"), "@echo off\n").unwrap();

        assert_eq!(
            crate::hq_cli_update::hq_cli_backing(&managed.join("hq.cmd")),
            CandidateBacking::Indeterminate,
            "an unreadable manifest is indeterminate, not a definitive absence"
        );

        let managed_roots = [tmp.path().join("toolchain")];
        let reject = |path: &Path| {
            path_in_any_root(path, &managed_roots)
                && matches!(
                    crate::hq_cli_update::hq_cli_backing(path),
                    CandidateBacking::AbsentDefinitive
                )
        };
        let backing = |path: &Path| crate::hq_cli_update::hq_cli_backing(path);
        let cands = windows_candidates("hq");
        let selected = select_hq_program_on_disk(&[managed.clone()], &cands, &reject, &backing)
            .expect("an indeterminate managed shim is NOT rejected");
        assert_eq!(selected.path, managed.join("hq.cmd").to_string_lossy());
    }

    #[test]
    fn test_path_in_any_root_and_managed_root_membership() {
        let root_a = PathBuf::from("C:").join("toolchain");
        let root_b = PathBuf::from("D:").join("legacy");
        let roots = [root_a.clone(), root_b.clone(), PathBuf::new()];
        assert!(path_in_any_root(
            &root_a.join("npm-prefix").join("hq.cmd"),
            &roots
        ));
        assert!(path_in_any_root(&root_b.join("bin").join("hq"), &roots));
        assert!(!path_in_any_root(
            &PathBuf::from("C:").join("Users").join("dev").join("hq.cmd"),
            &roots
        ));
        // An empty root never matches — an unresolved base must not swallow the world.
        assert!(!path_in_any_root(
            &PathBuf::from("hq.cmd"),
            &[PathBuf::new()]
        ));
    }

    #[test]
    fn test_windows_hq_other_names_are_unaffected_by_the_backed_preference() {
        // The tiered `hq` selection is never used for other names — those keep the
        // plain first-spawnable sweep. Prove the primitive the resolver still calls
        // for `node`/`npm` is byte-identical here.
        let (npm_prefix, _, _, appdata_npm) = windows_dirs();
        let dirs = vec![npm_prefix.clone(), appdata_npm.clone()];
        let selected = select_program_in_dirs(
            &dirs,
            &windows_candidates("node"),
            &present(&[(&appdata_npm, "node.exe"), (&npm_prefix, "node.exe")]),
        )
        .unwrap();
        assert_eq!(selected.path, npm_prefix.join("node.exe").to_string_lossy());
    }

    #[test]
    fn test_create_no_window_constant_matches_windows_api() {
        assert_eq!(CREATE_NO_WINDOW, 0x0800_0000);
    }

    #[test]
    fn test_git_command_targets_git_and_disables_optional_locks() {
        let cmd = git_command();
        assert_eq!(cmd.get_program(), "git");
        let locks = cmd
            .get_envs()
            .find_map(|(key, value)| (key == "GIT_OPTIONAL_LOCKS").then_some(value));
        assert_eq!(locks, Some(Some(std::ffi::OsStr::new("0"))));
    }

    #[test]
    fn managed_toolchain_base_must_be_nonempty_and_absolute() {
        for (base, expected_reason) in [
            (PathBuf::new(), "base-dir-empty"),
            (PathBuf::from("relative/home"), "base-dir-relative"),
        ] {
            let error = managed_toolchain_roots_from_base(Some(base))
                .expect_err("an ambiguous platform base must not prove absence");
            assert_eq!(error.reason, expected_reason);
        }
    }

    #[cfg(all(test, target_os = "windows"))]
    #[test]
    fn test_no_window_tokio_does_not_panic() {
        let mut cmd = tokio::process::Command::new("cmd.exe");
        no_window_tokio(&mut cmd);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_windows_shell_shims_keep_program_and_arguments_structured() {
        let npm = r"C:\Program Files\nodejs\npm.cmd";
        let blocking = spawn_command(npm, &["--version"]);
        assert_eq!(blocking.get_program(), npm);
        assert_eq!(blocking.get_args().collect::<Vec<_>>(), vec!["--version"]);

        let asynchronous = tokio_spawn_command(npm, &["--version"]);
        assert_eq!(asynchronous.as_std().get_program(), npm);
        assert_eq!(
            asynchronous.as_std().get_args().collect::<Vec<_>>(),
            vec!["--version"]
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_windows_resolved_npm_shim_executes_without_a_console_shell_command() {
        let npm = resolve_bin("npm");
        assert!(
            npm.to_ascii_lowercase().ends_with("npm.cmd"),
            "expected npm.cmd from the Windows resolver, got {npm}"
        );
        let output = spawn_command(&npm, &["--version"])
            .output()
            .expect("Rust batch dispatch should start npm.cmd");
        assert!(
            output.status.success(),
            "npm.cmd --version failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_windows_native_executables_stay_direct() {
        let command = tokio_spawn_command("node.exe", &["--version"]);
        assert_eq!(command.as_std().get_program(), "node.exe");
        assert_eq!(
            command.as_std().get_args().collect::<Vec<_>>(),
            vec!["--version"]
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_windows_search_dirs_include_standard_node_install() {
        let program_files = std::env::var_os("ProgramFiles")
            .map(PathBuf::from)
            .expect("Windows test environment must define ProgramFiles");
        let expected = program_files.join("nodejs");
        assert!(
            extended_search_dirs().iter().any(|dir| dir == &expected),
            "Windows resolver must search the standard Node installer directory: {}",
            expected.display()
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_windows_search_dirs_match_managed_installer_tool_order() {
        let toolchain =
            managed_toolchain_dir().expect("Windows test environment must define LOCALAPPDATA");
        let dirs = extended_search_dirs();
        let node = dirs.iter().position(|dir| dir == &toolchain.join("node"));
        let npm = dirs
            .iter()
            .position(|dir| dir == &toolchain.join("npm-prefix"));
        let wrappers = dirs.iter().position(|dir| dir == &toolchain.join("bin"));
        let git_cmd = dirs
            .iter()
            .position(|dir| dir == &toolchain.join("git").join("cmd"));
        let git_mingw = dirs
            .iter()
            .position(|dir| dir == &toolchain.join("git").join("mingw64").join("bin"));

        assert!(
            matches!((node, npm, wrappers), (Some(n), Some(p), Some(w)) if n < p && p < w),
            "managed node, npm shims, and wrappers must match installer precedence: {dirs:?}"
        );
        assert!(
            git_cmd.is_some() && git_mingw.is_some(),
            "Core rescue must inherit the managed MinGit command and helper directories: {dirs:?}"
        );
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn test_resolve_bin_in_dirs_prefers_managed_toolchain_over_user_npm_global() {
        let tmp = tempfile::TempDir::new().unwrap();
        let name = "hq-test-bin";
        let user_bin = tmp.path().join(".npm-global/bin");
        let toolchain_bin = managed_toolchain_dir(tmp.path()).join("npm-global/bin");
        std::fs::create_dir_all(&user_bin).unwrap();
        std::fs::create_dir_all(&toolchain_bin).unwrap();
        std::fs::write(user_bin.join(name), b"#!/bin/sh\n").unwrap();
        let expected = toolchain_bin.join(name);
        std::fs::write(&expected, b"#!/bin/sh\n").unwrap();

        assert_eq!(
            resolve_bin_in_dirs(Some(tmp.path()), name),
            Some(expected.to_string_lossy().to_string())
        );
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn test_resolve_bin_in_dirs_finds_macos_pnpm_global_binary() {
        let tmp = tempfile::TempDir::new().unwrap();
        let name = "hq-test-bin";
        let expected = tmp.path().join("Library/pnpm").join(name);
        std::fs::create_dir_all(expected.parent().unwrap()).unwrap();
        std::fs::write(&expected, b"#!/bin/sh\n").unwrap();

        assert_eq!(
            resolve_bin_in_dirs(Some(tmp.path()), name),
            Some(expected.to_string_lossy().to_string())
        );
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn test_resolve_bin_in_dirs_finds_bun_global_binary() {
        let tmp = tempfile::TempDir::new().unwrap();
        let name = "hq-test-bin";
        let expected = tmp.path().join(".bun/bin").join(name);
        std::fs::create_dir_all(expected.parent().unwrap()).unwrap();
        std::fs::write(&expected, b"#!/bin/sh\n").unwrap();

        assert_eq!(
            resolve_bin_in_dirs(Some(tmp.path()), name),
            Some(expected.to_string_lossy().to_string())
        );
    }

    /// The npx-cache predicate matches only a whole `_npx` DIRECTORY component,
    /// never a substring and never a leaf file merely named `_npx`.
    #[test]
    fn the_npx_cache_predicate_matches_whole_components_only() {
        // The live shape: an ephemeral hq under npm's per-invocation cache,
        // which always carries the `_npx/<hash>/node_modules/…` tree.
        assert!(is_npx_cache_path(Path::new(
            "/Users/z/.npm/_npx/91dc460cc0784cc8/node_modules/.bin/hq"
        )));
        // An `_npx` dir WITHOUT the cache's node_modules tree is an ordinary
        // directory (e.g. a home/prefix merely named `_npx`) and must resolve.
        assert!(!is_npx_cache_path(Path::new("/Users/_npx/toolchain/bin/hq")));
        assert!(!is_npx_cache_path(Path::new("/tmp/x/_npx/abc/hq")));
        // Substring matches must NOT trip it.
        assert!(!is_npx_cache_path(Path::new(
            "/Users/z/_npxtools/x/node_modules/.bin/hq"
        )));
        assert!(!is_npx_cache_path(Path::new(
            "/Users/z/my_npx/x/node_modules/.bin/hq"
        )));
        // A leaf file literally named `_npx` is not the cache dir.
        assert!(!is_npx_cache_path(Path::new("/Users/z/bin/_npx")));
        // A real managed install is never an npx path.
        assert!(!is_npx_cache_path(Path::new(
            "/Users/z/Library/Application Support/Indigo HQ/toolchain/npm-global/bin/hq"
        )));
        // Case sensitivity: exact on non-Windows, folded on Windows.
        #[cfg(not(target_os = "windows"))]
        assert!(!is_npx_cache_path(Path::new(
            "/tmp/_NPX/abc/node_modules/.bin/hq"
        )));
        #[cfg(target_os = "windows")]
        assert!(is_npx_cache_path(Path::new(
            r"C:\Users\z\_NPX\abc\node_modules\.bin\hq"
        )));
    }

    /// Only the `hq` lookup rejects an npx-cache copy; every other program
    /// resolves an identical path unchanged, so the runner's deliberate
    /// npx-cache execution and `npm`/`node`/`npx` resolution are untouched.
    #[test]
    fn only_the_hq_lookup_is_filtered() {
        let npx_hq = Path::new("/Users/z/.npm/_npx/abc/node_modules/.bin/hq");
        assert!(hq_lookup_rejects_candidate("hq", npx_hq));
        // An npx path for any OTHER name is not rejected here.
        let npx_node = Path::new("/Users/z/.npm/_npx/abc/node_modules/.bin/node");
        for name in ["npm", "node", "npx", "git", "hq-sync-runner"] {
            assert!(
                !hq_lookup_rejects_candidate(name, npx_node),
                "{name} resolution must be unaffected by the npx filter"
            );
        }
        // A non-npx `hq` is never rejected.
        assert!(!hq_lookup_rejects_candidate(
            "hq",
            Path::new("/opt/homebrew/bin/hq")
        ));
    }

    /// The `hq` sweep skips an npx-cache candidate that sits FIRST in the search
    /// order and falls through to the real managed install. Without the reject
    /// (the base defect) the same sweep adopts the ephemeral npx copy.
    #[test]
    fn the_hq_lookup_skips_an_npx_cache_candidate_and_falls_through_to_the_managed_install() {
        let tmp = tempfile::TempDir::new().unwrap();
        let npx_bin = tmp.path().join(".npm/_npx/91dc460cc0784cc8/node_modules/.bin");
        let managed_bin = tmp.path().join("toolchain/npm-global/bin");
        std::fs::create_dir_all(&npx_bin).unwrap();
        std::fs::create_dir_all(&managed_bin).unwrap();
        std::fs::write(npx_bin.join("hq"), b"#!/bin/sh\n").unwrap();
        std::fs::write(managed_bin.join("hq"), b"#!/bin/sh\n").unwrap();

        let dirs = [npx_bin.clone(), managed_bin.clone()];
        let candidates = ["hq".to_string()];
        let exists = |p: &Path| p.exists();
        let reject = |p: &Path| hq_lookup_rejects_candidate("hq", p);

        // Base defect: the plain sweep adopts the npx copy because it is first.
        assert_eq!(
            select_program_in_dirs(&dirs, &candidates, &exists)
                .unwrap()
                .path,
            npx_bin.join("hq").to_string_lossy()
        );
        // Fix: the rejecting sweep skips it and resolves the managed install.
        assert_eq!(
            select_program_in_dirs_rejecting(&dirs, &candidates, &exists, &reject)
                .unwrap()
                .path,
            managed_bin.join("hq").to_string_lossy()
        );
    }

    /// A machine whose ONLY `hq` is the npx cache resolves to nothing, so
    /// `install_executor_for_first_install` arms a real global install instead of
    /// adopting the un-updatable copy.
    #[test]
    fn an_npx_only_machine_reports_not_resolved_so_the_first_install_path_arms() {
        let tmp = tempfile::TempDir::new().unwrap();
        let npx_bin = tmp.path().join(".npm/_npx/abc/node_modules/.bin");
        std::fs::create_dir_all(&npx_bin).unwrap();
        std::fs::write(npx_bin.join("hq"), b"#!/bin/sh\n").unwrap();

        let dirs = [npx_bin];
        let candidates = ["hq".to_string()];
        let exists = |p: &Path| p.exists();
        let reject = |p: &Path| hq_lookup_rejects_candidate("hq", p);
        assert!(
            select_program_in_dirs_rejecting(&dirs, &candidates, &exists, &reject).is_none(),
            "an npx-only machine must resolve nothing so a real install arms"
        );
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn test_user_cli_dirs_include_npm_pnpm_and_bun_defaults() {
        let home = PathBuf::from("/Users/testuser");
        assert_eq!(
            user_cli_dirs_with_pnpm_home(&home, None),
            vec![
                PathBuf::from("/Users/testuser/.npm-global/bin"),
                // Each pnpm home contributes the flat (pnpm <=10) and nested
                // (pnpm >=11) shim directory.
                PathBuf::from("/Users/testuser/Library/pnpm"),
                PathBuf::from("/Users/testuser/Library/pnpm/bin"),
                PathBuf::from("/Users/testuser/.local/share/pnpm"),
                PathBuf::from("/Users/testuser/.local/share/pnpm/bin"),
                PathBuf::from("/Users/testuser/.bun/bin"),
            ]
        );
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn test_resolve_bin_in_dirs_finds_pnpm11_nested_shim() {
        // pnpm >=11 writes the shim to `<pnpm-home>/bin/hq`, not flat into the
        // home. `hq_cli_update` maintains installs in this layout, so the
        // resolver must find them too.
        let tmp = tempfile::TempDir::new().unwrap();
        let name = "hq-test-bin";
        let expected = tmp.path().join("Library/pnpm/bin").join(name);
        std::fs::create_dir_all(expected.parent().unwrap()).unwrap();
        std::fs::write(&expected, b"#!/bin/sh\n").unwrap();

        assert_eq!(
            resolve_bin_in_dirs(Some(tmp.path()), name),
            Some(expected.to_string_lossy().to_string())
        );
    }

    #[test]
    fn test_pnpm_shim_dirs_cover_flat_and_nested_layouts() {
        let home = PathBuf::from("/tmp/pnpm-home");
        assert_eq!(
            pnpm_shim_dirs(&home),
            [
                PathBuf::from("/tmp/pnpm-home"),
                PathBuf::from("/tmp/pnpm-home/bin"),
            ]
        );
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn test_user_cli_dirs_put_custom_pnpm_home_first() {
        let home = PathBuf::from("/Users/testuser");
        let pnpm_home = PathBuf::from("/opt/pnpm-bin");
        assert_eq!(
            user_cli_dirs_with_pnpm_home(&home, Some(&pnpm_home)),
            vec![
                PathBuf::from("/opt/pnpm-bin"),
                PathBuf::from("/opt/pnpm-bin/bin"),
                PathBuf::from("/Users/testuser/.npm-global/bin"),
                PathBuf::from("/Users/testuser/Library/pnpm"),
                PathBuf::from("/Users/testuser/Library/pnpm/bin"),
                PathBuf::from("/Users/testuser/.local/share/pnpm"),
                PathBuf::from("/Users/testuser/.local/share/pnpm/bin"),
                PathBuf::from("/Users/testuser/.bun/bin"),
            ]
        );
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn test_user_cli_dirs_do_not_duplicate_pnpm_home_matching_default() {
        let home = PathBuf::from("/Users/testuser");
        let pnpm_home = home.join("Library").join("pnpm");
        let dirs = user_cli_dirs_with_pnpm_home(&home, Some(&pnpm_home));
        assert_eq!(
            dirs.iter().filter(|d| **d == pnpm_home).count(),
            1,
            "PNPM_HOME equal to the macOS default must not be listed twice: {dirs:?}"
        );
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn test_resolve_bin_in_dirs_finds_binary_via_custom_pnpm_home() {
        let tmp = tempfile::TempDir::new().unwrap();
        let name = "hq-test-bin";
        let pnpm_home = tmp.path().join("custom-pnpm");
        std::fs::create_dir_all(&pnpm_home).unwrap();
        let expected = pnpm_home.join(name);
        std::fs::write(&expected, b"#!/bin/sh\n").unwrap();

        // The binary exists ONLY under the custom PNPM_HOME — none of the
        // per-OS defaults contain it, so a hit proves the override is consulted.
        let dirs = user_cli_dirs_with_pnpm_home(tmp.path(), Some(&pnpm_home));
        let found = dirs
            .iter()
            .map(|d| d.join(name))
            .find(|candidate| candidate.exists());
        assert_eq!(found, Some(expected));
    }

    #[test]
    fn test_pnpm_home_from_env_keeps_absolute_and_drops_relative() {
        use std::ffi::OsString;

        // Absolute → honoured. The fixture is platform-specific: a leading
        // slash is NOT absolute on Windows, which needs a drive prefix.
        #[cfg(target_os = "windows")]
        let absolute = r"C:\Users\testuser\AppData\Local\pnpm";
        #[cfg(not(target_os = "windows"))]
        let absolute = "/opt/pnpm-bin";

        assert_eq!(
            pnpm_home_from_env(Some(OsString::from(absolute))),
            Some(PathBuf::from(absolute))
        );
        // Relative → discarded, never resolved against the process cwd.
        assert_eq!(
            pnpm_home_from_env(Some(OsString::from("relative/pnpm"))),
            None
        );
        // Empty / unset → no entry.
        assert_eq!(pnpm_home_from_env(Some(OsString::new())), None);
        assert_eq!(pnpm_home_from_env(None), None);
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn test_child_path_includes_homebrew() {
        let path = child_path();
        assert!(path.contains("/opt/homebrew/bin"));
        assert!(path.contains("/usr/local/bin"));
        assert!(path.contains("/usr/bin"));
    }

    #[test]
    fn test_child_path_preserves_existing() {
        // Whatever PATH the test runner has, child_path should include its entries.
        if let Ok(existing) = std::env::var("PATH") {
            if let Some(first) = existing.split(':').next() {
                if !first.is_empty() {
                    let path = child_path();
                    assert!(
                        path.contains(first),
                        "child_path dropped existing entry {}",
                        first
                    );
                }
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn test_managed_toolchain_path_matches_installer() {
        let home = PathBuf::from("/Users/testuser");
        let toolchain = managed_toolchain_dir(&home);
        assert_eq!(
            toolchain,
            PathBuf::from("/Users/testuser/Library/Application Support/Indigo HQ/toolchain"),
            "must match hq-installer's managed_toolchain_dir_in()"
        );
    }

    #[test]
    fn test_resolve_bin_finds_system_binary() {
        // `ls` lives at /bin/ls on all macOS/Linux — the /usr/local/bin
        // branch won't match, but the zsh fallback should on any dev box.
        // On minimal CI containers without zsh this may return "ls", which
        // is still correct behavior (Command::new will then find /bin/ls
        // via its own PATH lookup).
        let result = resolve_bin("ls");
        // Either we resolved to an absolute path, or we fell back to the
        // bare name — both are valid.
        assert!(result == "ls" || std::path::Path::new(&result).exists());
    }

    #[test]
    fn path_is_within_matches_by_component_and_tolerates_trailing_separators() {
        assert!(path_is_within(
            Path::new("/opt/IndigoHQ/toolchain/node/hq.cmd"),
            Path::new("/opt/IndigoHQ/toolchain"),
        ));
        assert!(path_is_within(
            Path::new("/opt/IndigoHQ/toolchain/node"),
            Path::new("/opt/IndigoHQ/toolchain/"),
        ));
        // A directory whose NAME merely shares a prefix is not "inside" it: the
        // comparison is component-wise, not a substring test.
        assert!(!path_is_within(
            Path::new("/opt/IndigoHQ/toolchain-backup/node"),
            Path::new("/opt/IndigoHQ/toolchain"),
        ));
        // An empty root never vacuously contains a path.
        assert!(!path_is_within(Path::new("/opt/x"), Path::new("")));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn path_is_within_is_case_insensitive_on_windows() {
        assert!(path_is_within(
            Path::new(r"C:\Users\Me\AppData\Local\IndigoHQ\toolchain\node\hq.cmd"),
            Path::new(r"c:\users\me\appdata\local\indigohq\toolchain"),
        ));
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn path_is_within_is_case_sensitive_off_windows() {
        assert!(!path_is_within(
            Path::new("/opt/IndigoHQ/toolchain/node"),
            Path::new("/opt/indigohq/toolchain"),
        ));
    }

    #[test]
    fn both_within_same_managed_root_requires_one_root_to_contain_both() {
        let roots = vec![
            PathBuf::from("/opt/IndigoHQ/toolchain"),
            PathBuf::from("/opt/Indigo HQ/toolchain"),
        ];
        // Both under the SAME (IndigoHQ) root: an HQ-owned shadow.
        assert!(both_within_same_managed_root(
            Path::new("/opt/IndigoHQ/toolchain/npm-prefix"),
            Path::new("/opt/IndigoHQ/toolchain/node"),
            &roots,
        ));
        // Split across the current and the legacy root: NOT a single shadow.
        assert!(!both_within_same_managed_root(
            Path::new("/opt/IndigoHQ/toolchain/npm-prefix"),
            Path::new("/opt/Indigo HQ/toolchain/node"),
            &roots,
        ));
        // One path outside every managed root: foreign, not a shadow.
        assert!(!both_within_same_managed_root(
            Path::new("/opt/IndigoHQ/toolchain/npm-prefix"),
            Path::new("/opt/homebrew"),
            &roots,
        ));
        // No roots at all reproduces the prior behaviour: never a shadow.
        assert!(!both_within_same_managed_root(
            Path::new("/opt/IndigoHQ/toolchain/npm-prefix"),
            Path::new("/opt/IndigoHQ/toolchain/node"),
            &[],
        ));
    }

    #[test]
    #[cfg(not(target_os = "windows"))]
    fn the_user_owned_prefix_test_excludes_system_and_managed_roots() {
        let managed_roots = vec![PathBuf::from(
            "/Users/me/Library/Application Support/Indigo HQ/toolchain",
        )];
        let home = Path::new("/Users/me");

        // The live shape: an nvm prefix inside the user's home, outside every
        // managed root — HQ may drive it in place.
        assert!(is_user_owned_prefix(
            Path::new("/Users/me/.nvm/versions/node/v24.20.0"),
            &managed_roots,
            Some(home),
        ));
        // A plain user npm prefix inside home is also drivable.
        assert!(is_user_owned_prefix(
            Path::new("/Users/me/.npm-global"),
            &managed_roots,
            Some(home),
        ));

        // A managed prefix (HQ's own npm-global under the managed root) is NEVER
        // user-owned — it routes through the managed path.
        assert!(!is_user_owned_prefix(
            Path::new("/Users/me/Library/Application Support/Indigo HQ/toolchain/npm-global"),
            &managed_roots,
            Some(home),
        ));

        // System / Homebrew prefixes are excluded even though the risk-3 hazard
        // is exactly HQ writing into one of them.
        for system in [
            "/opt/homebrew",
            "/usr/local",
            "/usr",
            "/usr/bin",
            "/bin",
            "/sbin",
        ] {
            assert!(
                !is_user_owned_prefix(Path::new(system), &managed_roots, Some(home)),
                "{system} must not be treated as user-owned"
            );
        }

        // A prefix outside the user's home is not user-owned (a shared /opt tool).
        assert!(!is_user_owned_prefix(
            Path::new("/opt/tools/node"),
            &managed_roots,
            Some(home),
        ));
        // A relative or empty prefix, or an unknown home, is never user-owned.
        assert!(!is_user_owned_prefix(
            Path::new("relative/prefix"),
            &managed_roots,
            Some(home),
        ));
        assert!(!is_user_owned_prefix(
            Path::new("/Users/me/.nvm/versions/node/v24.20.0"),
            &managed_roots,
            None,
        ));
    }

    #[test]
    #[cfg(unix)]
    fn is_user_owned_prefix_resolves_symlinks_out_of_home() {
        let tmp = tempfile::TempDir::new().unwrap();
        let home = tmp.path().join("home");
        let external = tmp.path().join("external");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(external.join("node")).unwrap();
        // A symlink UNDER $HOME that escapes to a location outside it (the stand-in
        // for `~/.nvm` -> `/opt/homebrew`). Lexically it is inside $HOME, but it
        // resolves outside — so it must NOT read as user-owned.
        let escape = home.join("escape");
        std::os::unix::fs::symlink(&external, &escape).unwrap();
        let managed_roots: Vec<PathBuf> = vec![];
        assert!(!is_user_owned_prefix(
            &escape.join("node"),
            &managed_roots,
            Some(&home),
        ));
        // A genuine directory under $HOME stays user-owned.
        let real = home.join("nvm/versions/node/v24");
        std::fs::create_dir_all(&real).unwrap();
        assert!(is_user_owned_prefix(&real, &managed_roots, Some(&home)));
    }

    #[test]
    #[cfg(unix)]
    fn is_runnable_shim_requires_an_executable_regular_file() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::TempDir::new().unwrap();
        let f = tmp.path().join("hq");
        std::fs::write(&f, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(!is_runnable_shim(&f), "a non-executable file is not runnable");
        std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(is_runnable_shim(&f), "an executable regular file is runnable");
        let d = tmp.path().join("dir");
        std::fs::create_dir(&d).unwrap();
        assert!(!is_runnable_shim(&d), "a directory is never a runnable shim");
        assert!(!is_runnable_shim(&tmp.path().join("missing")));
    }

    #[test]
    fn resolution_source_of_bin_maps_the_unresolved_sentinel_to_not_resolved() {
        for sentinel in ["hq", "npm", ""] {
            assert_eq!(
                resolution_source_of_bin(sentinel),
                ResolutionSource::NotResolved,
                "the bare {sentinel:?} sentinel is not-resolved, never login-shell"
            );
        }
        // A resolved absolute path outside every known dir set still classifies by
        // lane (login-shell on unix), exactly as resolution_source_of does.
        #[cfg(not(target_os = "windows"))]
        assert_eq!(
            resolution_source_of_bin("/opt/whatever/bin/hq"),
            ResolutionSource::LoginShell
        );
    }

    // ---- HQ-DESKTOP-3P: interpreter-hint PATH + version-manager widening ----

    #[test]
    #[cfg(not(target_os = "windows"))]
    fn path_with_interpreter_hint_prepends_once_and_never_duplicates() {
        let hint = Path::new("/opt/managed/node/bin");
        // Empty base → just the hint.
        assert_eq!(
            path_with_interpreter_hint("", hint),
            "/opt/managed/node/bin"
        );
        // Prepended, preserving the existing PATH.
        assert_eq!(
            path_with_interpreter_hint("/usr/bin:/bin", hint),
            "/opt/managed/node/bin:/usr/bin:/bin"
        );
        // Already present → unchanged (no duplicate, order preserved).
        assert_eq!(
            path_with_interpreter_hint("/usr/bin:/opt/managed/node/bin", hint),
            "/usr/bin:/opt/managed/node/bin"
        );
        // An empty hint is a no-op.
        assert_eq!(
            path_with_interpreter_hint("/usr/bin", Path::new("")),
            "/usr/bin"
        );
    }

    #[test]
    #[cfg(not(target_os = "windows"))]
    fn node_version_manager_dirs_includes_present_managers_and_skips_absent() {
        let tmp = tempfile::TempDir::new().unwrap();
        let home = tmp.path();
        // Present: a Volta shim dir, an fnm node version, an asdf shim dir.
        std::fs::create_dir_all(home.join(".volta/bin")).unwrap();
        std::fs::create_dir_all(home.join(".fnm/node-versions/v20.0.0/installation/bin")).unwrap();
        std::fs::create_dir_all(home.join(".asdf/shims")).unwrap();
        // Absent: nodenv and mise are never created.

        let dirs = node_version_manager_dirs(home);

        assert!(dirs.contains(&home.join(".volta/bin")), "Volta bin present");
        assert!(
            dirs.contains(&home.join(".fnm/node-versions/v20.0.0/installation/bin")),
            "fnm version bin present"
        );
        assert!(
            dirs.contains(&home.join(".asdf/shims")),
            "asdf shims present"
        );
        assert!(
            !dirs.contains(&home.join(".nodenv/shims")),
            "an absent nodenv dir must be skipped"
        );
        assert!(
            !dirs.contains(&home.join(".local/share/mise/shims")),
            "an absent mise dir must be skipped"
        );
    }

    #[test]
    fn classify_resolution_source_credits_the_highest_precedence_lane() {
        let settings = vec![PathBuf::from("/s/bin")];
        let managed = vec![PathBuf::from("/m/node/bin")];
        let user = vec![PathBuf::from("/u/.npm-global/bin")];
        let system = vec![PathBuf::from("/usr/local/bin")];
        // Remaining deterministic-resolver dirs (Windows pnpm/Scoop analogue).
        let fallback = vec![PathBuf::from("/pnpm/shims")];
        let classify = |resolved: &str| {
            classify_resolution_source(
                Path::new(resolved),
                &settings,
                &managed,
                &user,
                &system,
                &fallback,
            )
        };

        assert_eq!(classify("/s/bin/hq"), ResolutionSource::SettingsPath);
        assert_eq!(classify("/m/node/bin/hq"), ResolutionSource::ManagedToolchain);
        assert_eq!(classify("/u/.npm-global/bin/hq"), ResolutionSource::UserPrefix);
        assert_eq!(classify("/usr/local/bin/hq"), ResolutionSource::SystemPrefix);
        // A deterministic resolver dir (pnpm/Scoop) is a user-level install, not
        // the login-shell residual — this is the Windows misclassification fix.
        assert_eq!(classify("/pnpm/shims/hq"), ResolutionSource::UserPrefix);
        // Not in any known set → attributed to the login-shell fallback.
        assert_eq!(classify("/opt/custom/bin/hq"), ResolutionSource::LoginShell);

        // The precise system lane is checked BEFORE the broad resolver fallback,
        // so a system dir that also appears in the fallback stays SystemPrefix.
        assert_eq!(
            classify_resolution_source(
                Path::new("/usr/local/bin/hq"),
                &settings,
                &managed,
                &user,
                &system,
                &[PathBuf::from("/usr/local/bin")],
            ),
            ResolutionSource::SystemPrefix
        );
        // A dir shared by two lanes is credited to the higher-precedence one.
        let shared = vec![PathBuf::from("/shared/bin")];
        assert_eq!(
            classify_resolution_source(
                Path::new("/shared/bin/hq"),
                &shared,
                &managed,
                &shared,
                &system,
                &fallback,
            ),
            ResolutionSource::SettingsPath
        );
    }
}

#[cfg(all(test, not(target_os = "windows")))]
mod managed_git_shim_resolution_tests {
    use super::*;

    #[test]
    fn resolve_bin_prefers_managed_git_shim_and_finds_local_bin_tools() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        let shim = managed_toolchain_dir(home).join("git-shim");
        std::fs::create_dir_all(&shim).unwrap();
        std::fs::write(shim.join("git"), "#!/bin/sh\n").unwrap();
        let local = home.join(".local").join("bin");
        std::fs::create_dir_all(&local).unwrap();
        std::fs::write(local.join("jq"), "").unwrap();

        assert_eq!(
            resolve_bin_in_dirs(Some(home), "git").as_deref(),
            Some(shim.join("git").to_string_lossy().as_ref())
        );
        assert_eq!(
            resolve_bin_in_dirs(Some(home), "jq").as_deref(),
            Some(local.join("jq").to_string_lossy().as_ref())
        );
        assert!(MANAGED_TOOLCHAIN_BIN_SUBDIRS.contains(&"git-shim"));
    }
}
