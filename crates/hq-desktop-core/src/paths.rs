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

        if let Some(found) = select_program_on_disk(&extended_search_dirs(), &candidates) {
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
        //    sources the full startup chain. `command -v` prints the resolved
        //    path on success, nothing on miss.
        if let Ok(output) = Command::new("zsh")
            .args(["-lc", &format!("command -v {}", name)])
            .output()
        {
            if output.status.success() {
                let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !path.is_empty() && Path::new(&path).exists() {
                    return ResolvedProgram {
                        path,
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
    vec![
        home.join(".npm-global").join("bin"),
        // pnpm's default global executable directory on macOS (pnpm ≤10 puts
        // shims directly in PNPM_HOME; pnpm ≥11 nests them in a `bin` subdir).
        home.join("Library").join("pnpm"),
        home.join("Library").join("pnpm").join("bin"),
        // pnpm's default global executable directory on Linux (same ≤10 flat
        // vs ≥11 nested layout).
        home.join(".local").join("share").join("pnpm"),
        home.join(".local").join("share").join("pnpm").join("bin"),
    ]
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

#[cfg(not(target_os = "windows"))]
fn resolve_bin_in_dirs(home: Option<&Path>, name: &str) -> Option<String> {
    if let Some(home) = home {
        // Managed HQ toolchain (installed by hq-installer). Match
        // `child_path()` and hq-installer's login PATH order so a stale
        // foreign `~/.npm-global/bin/hq` cannot shadow the managed CLI the
        // app's runtime PATH would execute.
        let toolchain = managed_toolchain_dir(home);
        for subdir in ["npm-global/bin", "node/bin"] {
            let candidate = toolchain.join(subdir).join(name);
            if candidate.exists() {
                return Some(candidate.to_string_lossy().to_string());
            }
        }

        // User-level npm/pnpm prefixes after the managed toolchain.
        for dir in user_cli_dirs(home) {
            let candidate = dir.join(name);
            if candidate.exists() {
                return Some(candidate.to_string_lossy().to_string());
            }
        }
    }

    // Standard install locations.
    for prefix in ["/opt/homebrew/bin", "/usr/local/bin"] {
        let candidate = Path::new(prefix).join(name);
        if candidate.exists() {
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

    if let Ok(local_app) = std::env::var("LOCALAPPDATA") {
        // pnpm's per-user global prefix on Windows (pnpm ≤10 puts shims
        // directly in PNPM_HOME; pnpm ≥11 nests them in a `bin` subdir).
        dirs.push(PathBuf::from(&local_app).join("pnpm"));
        dirs.push(PathBuf::from(&local_app).join("pnpm").join("bin"));
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
    for spawnable_pass in [true, false] {
        for dir in dirs {
            for candidate in candidates {
                if is_spawnable_program(candidate) != spawnable_pass {
                    continue;
                }
                let full = dir.join(candidate);
                if exists(&full) {
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

        if let Some(home) = home_dir() {
            // Managed HQ toolchain (installed by hq-installer) — checked first
            // so users who only have Node via the installer can resolve `npx`
            // and node shebangs.
            let toolchain = managed_toolchain_dir(&home);
            for subdir in ["npm-global/bin", "node/bin"] {
                let bin = toolchain.join(subdir);
                if bin.exists() {
                    parts.push(bin.to_string_lossy().to_string());
                }
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

        parts.join(&PATH_SEP.to_string())
    }
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

    #[cfg(target_os = "windows")]
    #[test]
    fn test_windows_search_dirs_include_pnpm_global_prefixes() {
        let local_app = std::env::var("LOCALAPPDATA")
            .map(PathBuf::from)
            .expect("Windows test environment must define LOCALAPPDATA");
        let dirs = extended_search_dirs();
        for expected in [local_app.join("pnpm"), local_app.join("pnpm").join("bin")] {
            assert!(
                dirs.iter().any(|dir| dir == &expected),
                "Windows resolver must search the pnpm global prefix: {}",
                expected.display()
            );
        }
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
    fn test_user_cli_dirs_include_npm_and_pnpm_defaults() {
        let home = PathBuf::from("/Users/testuser");
        assert_eq!(
            user_cli_dirs(&home),
            vec![
                PathBuf::from("/Users/testuser/.npm-global/bin"),
                PathBuf::from("/Users/testuser/Library/pnpm"),
                PathBuf::from("/Users/testuser/Library/pnpm/bin"),
                PathBuf::from("/Users/testuser/.local/share/pnpm"),
                PathBuf::from("/Users/testuser/.local/share/pnpm/bin"),
            ]
        );
    }

    // REGRESSION (2026-08-05): pnpm 11 moved global shims from PNPM_HOME to
    // PNPM_HOME/bin, so `~/Library/pnpm/bin/hq` was invisible to detection and
    // Settings reported "HQ CLI: Not installed". The login-shell fallback
    // missed it too — pnpm setup writes PATH into .zshrc, which `zsh -lc`
    // does not source.
    #[cfg(not(target_os = "windows"))]
    #[test]
    fn test_resolve_bin_in_dirs_finds_pnpm_v11_nested_bin() {
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

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn test_resolve_bin_in_dirs_finds_linux_pnpm_v11_nested_bin() {
        let tmp = tempfile::TempDir::new().unwrap();
        let name = "hq-test-bin";
        let expected = tmp.path().join(".local/share/pnpm/bin").join(name);
        std::fs::create_dir_all(expected.parent().unwrap()).unwrap();
        std::fs::write(&expected, b"#!/bin/sh\n").unwrap();

        assert_eq!(
            resolve_bin_in_dirs(Some(tmp.path()), name),
            Some(expected.to_string_lossy().to_string())
        );
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
}
