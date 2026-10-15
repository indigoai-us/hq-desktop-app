use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde_json::Value;
use tokio::sync::Mutex;

use crate::util::{logfile::log, paths};

const LOG_TAG: &str = "hq-anywhere";
const CLAUDE_BLOCK_BEGIN: &str = "<!-- hq-anywhere:begin";
const CODEX_BLOCK_BEGIN: &str =
    "<!-- hq-anywhere:begin (managed by `hq install --global --runtime codex`";
const MANAGED_BLOCK_END: &str = "<!-- hq-anywhere:end -->";
const HQ_MCP_PACK: &str = "hq-anywhere";

fn safe_renderer_failure(_details: &str) -> String {
    "HQ Anywhere setup failed. Tap to retry.".to_string()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GlobalRuntime {
    Claude,
    Codex,
}

impl GlobalRuntime {
    fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
        }
    }

    fn home_dir(self) -> &'static str {
        match self {
            Self::Claude => ".claude",
            Self::Codex => ".codex",
        }
    }

    fn binary_name(self) -> &'static str {
        self.as_str()
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "claude" => Some(Self::Claude),
            "codex" => Some(Self::Codex),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy)]
enum RuntimeAction {
    Install,
    Uninstall,
}

fn global_runtime_args(action: RuntimeAction, runtime: GlobalRuntime) -> Vec<String> {
    let action = match action {
        RuntimeAction::Install => "install",
        RuntimeAction::Uninstall => "uninstall",
    };
    vec![
        action.to_string(),
        "--global".to_string(),
        "--runtime".to_string(),
        runtime.as_str().to_string(),
    ]
}

fn detect_present_runtimes(home: &Path, path_entries: &[PathBuf]) -> Vec<GlobalRuntime> {
    [GlobalRuntime::Claude, GlobalRuntime::Codex]
        .into_iter()
        .filter(|runtime| {
            home.join(runtime.home_dir()).exists()
                || runtime_binary_on_path(runtime.binary_name(), path_entries)
        })
        .collect()
}

fn runtime_binary_on_path(binary: &str, path_entries: &[PathBuf]) -> bool {
    #[cfg(windows)]
    let extensions = [".exe", ".cmd", ".bat", ".com"];
    #[cfg(not(windows))]
    let extensions = [""];

    path_entries.iter().any(|directory| {
        extensions.iter().any(|extension| {
            let candidate = directory.join(format!("{binary}{extension}"));
            if !candidate.is_file() {
                return false;
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                return fs::metadata(candidate)
                    .map(|metadata| metadata.permissions().mode() & 0o111 != 0)
                    .unwrap_or(false);
            }
            #[cfg(not(unix))]
            {
                true
            }
        })
    })
}

fn has_managed_block(path: &Path, begin: &str) -> bool {
    fs::read_to_string(path)
        .map(|contents| contents.contains(begin) && contents.contains(MANAGED_BLOCK_END))
        .unwrap_or(false)
}

fn claude_mcp_is_hq_anywhere(home: &Path) -> bool {
    let value: Value = match fs::read_to_string(home.join(".claude.json"))
        .ok()
        .and_then(|contents| serde_json::from_str(&contents).ok())
    {
        Some(value) => value,
        None => return false,
    };
    value
        .get("mcpServers")
        .and_then(|servers| servers.get("hq"))
        .and_then(|server| server.get("_hqPack"))
        .and_then(Value::as_str)
        == Some(HQ_MCP_PACK)
}

fn codex_mcp_is_hq_anywhere(home: &Path) -> bool {
    fs::read_to_string(home.join(".codex/config.toml"))
        .map(|contents| {
            let mut in_hq_server = false;
            contents.lines().any(|line| {
                let line = line.trim();
                if line.starts_with('[') && line.ends_with(']') {
                    in_hq_server = line == "[mcp_servers.hq]";
                    return false;
                }
                if !in_hq_server {
                    return false;
                }
                let Some((key, value)) = line.split_once('=') else {
                    return false;
                };
                let value = value.trim();
                key.trim() == "_hqPack"
                    && value.len() >= 2
                    && value.starts_with('"')
                    && value.ends_with('"')
                    && &value[1..value.len() - 1] == HQ_MCP_PACK
            })
        })
        .unwrap_or(false)
}

fn global_runtime_is_installed(home: &Path, runtime: GlobalRuntime) -> bool {
    match runtime {
        GlobalRuntime::Claude => {
            has_managed_block(&home.join(".claude/CLAUDE.md"), CLAUDE_BLOCK_BEGIN)
                && claude_mcp_is_hq_anywhere(home)
        }
        GlobalRuntime::Codex => {
            has_managed_block(&home.join(".codex/AGENTS.md"), CODEX_BLOCK_BEGIN)
                && codex_mcp_is_hq_anywhere(home)
        }
    }
}

/// The CLI's own install record, `~/.hq/anywhere/<runtime>-install.json`. A
/// plugin-mode install (`hq install --global --via plugin`) writes this and
/// neither the managed block nor the MCP entry.
fn install_state_file(home: &Path, runtime: GlobalRuntime) -> PathBuf {
    home.join(".hq/anywhere")
        .join(format!("{}-install.json", runtime.as_str()))
}

/// True when any part of the HQ Anywhere setup is on disk for `runtime`: the
/// managed instructions block, the HQ MCP entry or the CLI's install record.
/// `hq uninstall` exits 1 with "No HQ global install found" when nothing is
/// there, so an opted-out person must not run it against a clean home. Before
/// this check the startup reconcile ran it on every launch and the renderer
/// retried it twice more. `~/.hq/root` alone is not counted: the CLI also
/// accepts it, but it only points at the HQ folder and exists on homes with no
/// runtime install.
fn global_runtime_has_any_install(home: &Path, runtime: GlobalRuntime) -> bool {
    let wrote_files = match runtime {
        GlobalRuntime::Claude => {
            has_managed_block(&home.join(".claude/CLAUDE.md"), CLAUDE_BLOCK_BEGIN)
                || claude_mcp_is_hq_anywhere(home)
        }
        GlobalRuntime::Codex => {
            has_managed_block(&home.join(".codex/AGENTS.md"), CODEX_BLOCK_BEGIN)
                || codex_mcp_is_hq_anywhere(home)
        }
    };
    wrote_files || install_state_file(home, runtime).is_file()
}

fn global_install_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// Apply or remove the current user's HQ Anywhere setup in supported runtimes.
/// The shell-out stays on the async Tauri runtime and uses the shared HQ CLI runner.
///
/// The renderer calls this at startup (`reconcileHqAnywhereGlobalRuntime` in
/// `App.svelte`) as well as from the setting toggle. Only the shipped HQ
/// bundle runs it: any other bundle (scratch, Lane Check, worktree builds)
/// shares the owner's Claude and Codex home folders, so it logs one skip line
/// and changes nothing. On 2026-10-10 an
/// `ai.indigo.hq-lane-check.conflict-toast` bundle ran
/// `hq uninstall --global --runtime claude` from here at launch.
#[tauri::command]
pub async fn set_hq_anywhere_global_install(enabled: bool) -> Result<(), String> {
    run_global_install(enabled, None).await
}

/// First-run "Continue in <tool>": install the HQ Anywhere global runtime
/// setup (hooks, memory, skills) for the one tool the person chose, whether or
/// not that tool's home folder exists yet. Same bundle gate and lock as
/// [`set_hq_anywhere_global_install`].
#[tauri::command]
pub async fn install_hq_runtime_for_tool(runtime: String) -> Result<(), String> {
    let runtime = parse_tool_runtime(&runtime)?;
    run_global_install(true, Some(runtime)).await
}

/// The webview supplies `runtime`, so the error never echoes it back.
fn parse_tool_runtime(runtime: &str) -> Result<GlobalRuntime, String> {
    GlobalRuntime::parse(runtime).ok_or_else(|| "Unsupported coding tool".to_string())
}

async fn run_global_install(enabled: bool, only: Option<GlobalRuntime>) -> Result<(), String> {
    let _guard = global_install_lock().lock().await;
    let identity = crate::scratch_build::LaunchIdentity::current();
    if !identity.allows("HQ Anywhere global runtime setup") {
        return Ok(());
    }
    let home =
        dirs::home_dir().ok_or_else(|| "Could not resolve the home directory.".to_string())?;
    let path_env = paths::child_path();
    let path_entries = std::env::split_paths(OsStr::new(&path_env)).collect::<Vec<_>>();
    apply_global_install(
        &identity,
        enabled,
        only,
        &home,
        &path_entries,
        || crate::commands::install_directory::resolve_hq_path().map(PathBuf::from),
        |args, hq_root| async move {
            let args = args.iter().map(String::as_str).collect::<Vec<_>>();
            crate::commands::install_stages::run_hq_global_runtime_plain(&args, &hq_root).await
        },
    )
    .await
}

/// The body of [`set_hq_anywhere_global_install`] with the bundle identity,
/// home folder, PATH, HQ root and `hq` runner passed in, so tests can assert
/// on exactly which `hq` commands run.
async fn apply_global_install<R, F, Fut>(
    identity: &crate::scratch_build::LaunchIdentity,
    enabled: bool,
    only: Option<GlobalRuntime>,
    home: &Path,
    path_entries: &[PathBuf],
    resolve_hq_root: R,
    mut run_hq: F,
) -> Result<(), String>
where
    R: FnOnce() -> Result<PathBuf, String>,
    F: FnMut(Vec<String>, PathBuf) -> Fut,
    Fut: std::future::Future<Output = Result<(), String>>,
{
    // The command already gated (and logged); this repeat keeps the seam
    // itself safe for any other caller.
    if !identity.is_production() {
        return Ok(());
    }
    let runtimes = match only {
        Some(runtime) => vec![runtime],
        None => detect_present_runtimes(home, path_entries),
    };
    if runtimes.is_empty() {
        log(
            LOG_TAG,
            "no supported coding runtime was detected; nothing to configure",
        );
        return Ok(());
    }

    let action = if enabled {
        RuntimeAction::Install
    } else {
        RuntimeAction::Uninstall
    };
    let mut pending = Vec::new();
    for runtime in runtimes {
        if enabled && global_runtime_is_installed(home, runtime) {
            log(
                LOG_TAG,
                &format!(
                    "{} global setup is already installed; skipping",
                    runtime.as_str()
                ),
            );
        } else if !enabled && !global_runtime_has_any_install(home, runtime) {
            log(
                LOG_TAG,
                &format!(
                    "{} has no global setup to remove; skipping",
                    runtime.as_str()
                ),
            );
        } else {
            pending.push(runtime);
        }
    }
    if pending.is_empty() {
        return Ok(());
    }

    let hq_root = resolve_hq_root()?;
    let mut failures = Vec::new();
    for runtime in pending {
        let argv = global_runtime_args(action, runtime);
        log(LOG_TAG, &format!("running hq {}", argv.join(" ")));
        match run_hq(argv, hq_root.clone()).await {
            Ok(()) => log(
                LOG_TAG,
                &format!("{} global setup completed", runtime.as_str()),
            ),
            Err(error) => {
                log(
                    LOG_TAG,
                    &format!("{} global setup failed: {error}", runtime.as_str()),
                );
                failures.push(format!("{} global setup failed: {error}", runtime.as_str()));
            }
        }
    }

    if failures.is_empty() {
        Ok(())
    } else {
        Err(safe_renderer_failure(&failures.join("; ")))
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    use super::{
        apply_global_install, detect_present_runtimes, global_runtime_args,
        global_runtime_is_installed, parse_tool_runtime, safe_renderer_failure, GlobalRuntime,
        RuntimeAction,
    };
    use crate::scratch_build::LaunchIdentity;

    const SCRATCH_BUNDLE_ID: &str = "ai.indigo.hq-lane-check.conflict-toast";

    fn bundle(id: Option<&str>) -> LaunchIdentity {
        LaunchIdentity {
            scratch_flag: false,
            bundle_identifier: id.map(str::to_string),
        }
    }

    fn production() -> LaunchIdentity {
        bundle(Some(hq_platform::autostart::PRODUCTION_BUNDLE_IDENTIFIER))
    }

    /// Runs the startup reconcile body against a home with Claude and Codex
    /// present. Returns the result, every `hq` argv the runner was asked to
    /// run, and whether the HQ root was resolved.
    fn run_startup_reconcile(
        identity: LaunchIdentity,
        enabled: bool,
    ) -> (Result<(), String>, Vec<Vec<String>>, bool) {
        run_global_install_in(identity, enabled, None, |home| {
            fs::create_dir_all(home.join(".claude")).unwrap();
            fs::create_dir_all(home.join(".codex")).unwrap();
        })
    }

    fn write_claude_install(home: &Path) {
        fs::create_dir_all(home.join(".claude")).unwrap();
        fs::write(
            home.join(".claude/CLAUDE.md"),
            "<!-- hq-anywhere:begin managed -->\nHQ\n<!-- hq-anywhere:end -->\n",
        )
        .unwrap();
        fs::write(
            home.join(".claude.json"),
            r#"{"mcpServers":{"hq":{"_hqPack":"hq-anywhere"}}}"#,
        )
        .unwrap();
    }

    fn write_codex_install(home: &Path) {
        fs::create_dir_all(home.join(".codex")).unwrap();
        fs::write(
            home.join(".codex/AGENTS.md"),
            "<!-- hq-anywhere:begin (managed by `hq install --global --runtime codex`) -->\nHQ\n<!-- hq-anywhere:end -->\n",
        )
        .unwrap();
        fs::write(
            home.join(".codex/config.toml"),
            "[mcp_servers.hq]\ncommand = \"hq-mcp\"\n_hqPack = \"hq-anywhere\"\n",
        )
        .unwrap();
    }

    /// Runs [`apply_global_install`] against a temporary home that `seed`
    /// prepares. Returns the result, every `hq` argv the runner was asked to
    /// run, and whether the HQ root was resolved.
    fn run_global_install_in(
        identity: LaunchIdentity,
        enabled: bool,
        only: Option<GlobalRuntime>,
        seed: impl FnOnce(&Path),
    ) -> (Result<(), String>, Vec<Vec<String>>, bool) {
        let home = TempHome::new();
        seed(home.path());
        let calls = Arc::new(Mutex::new(Vec::<Vec<String>>::new()));
        let resolved = Arc::new(Mutex::new(false));
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("test runtime");
        let result = runtime.block_on(apply_global_install(
            &identity,
            enabled,
            only,
            home.path(),
            &[],
            {
                let resolved = resolved.clone();
                move || {
                    *resolved.lock().unwrap() = true;
                    Ok(PathBuf::from("/tmp/hq-root-for-test"))
                }
            },
            {
                let calls = calls.clone();
                move |argv: Vec<String>, _hq_root: PathBuf| {
                    calls.lock().unwrap().push(argv);
                    async { Ok(()) }
                }
            },
        ));
        let calls = calls.lock().unwrap().clone();
        let resolved = *resolved.lock().unwrap();
        (result, calls, resolved)
    }

    #[test]
    fn a_scratch_bundle_makes_no_install_or_uninstall_call_at_startup() {
        for enabled in [false, true] {
            for identity in [
                bundle(Some(SCRATCH_BUNDLE_ID)),
                bundle(Some("ai.indigo.hq-lane-check")),
                bundle(Some("ai.indigo.hq-sync-menubar-dev")),
                bundle(None),
                LaunchIdentity {
                    scratch_flag: true,
                    bundle_identifier: Some(
                        hq_platform::autostart::PRODUCTION_BUNDLE_IDENTIFIER.to_string(),
                    ),
                },
            ] {
                let (result, calls, resolved) = run_startup_reconcile(identity.clone(), enabled);
                assert_eq!(result, Ok(()), "{identity:?}");
                assert!(calls.is_empty(), "{identity:?} ran hq {calls:?}");
                assert!(!resolved, "{identity:?} resolved the HQ root");
            }
        }
    }

    #[test]
    fn the_production_bundle_still_runs_the_global_runtime_commands() {
        let (result, calls, resolved) =
            run_global_install_in(production(), false, None, |home| {
                write_claude_install(home);
                write_codex_install(home);
            });
        assert_eq!(result, Ok(()));
        assert!(resolved);
        assert_eq!(
            calls,
            [
                ["uninstall", "--global", "--runtime", "claude"],
                ["uninstall", "--global", "--runtime", "codex"],
            ]
        );

        let (result, calls, _) = run_startup_reconcile(production(), true);
        assert_eq!(result, Ok(()));
        assert_eq!(
            calls,
            [
                ["install", "--global", "--runtime", "claude"],
                ["install", "--global", "--runtime", "codex"],
            ]
        );
    }

    /// The 2026-10-15 log showed `hq uninstall --global --runtime claude`
    /// failing with "No HQ global install found" in bursts of three, about
    /// 4 s apart, for a person with HQ Anywhere off and nothing installed.
    #[test]
    fn an_opted_out_person_with_nothing_installed_runs_no_uninstall() {
        let (result, calls, resolved) = run_startup_reconcile(production(), false);
        assert_eq!(result, Ok(()));
        assert!(calls.is_empty(), "ran hq {calls:?}");
        assert!(!resolved, "resolved the HQ root with nothing to remove");
    }

    #[test]
    fn uninstall_still_removes_a_partial_install() {
        let (result, calls, _) = run_global_install_in(production(), false, None, |home| {
            fs::create_dir_all(home.join(".claude")).unwrap();
            fs::write(
                home.join(".claude.json"),
                r#"{"mcpServers":{"hq":{"_hqPack":"hq-anywhere"}}}"#,
            )
            .unwrap();
            fs::create_dir_all(home.join(".codex")).unwrap();
            fs::write(
                home.join(".codex/AGENTS.md"),
                "<!-- hq-anywhere:begin (managed by `hq install --global --runtime codex`) -->\nHQ\n<!-- hq-anywhere:end -->\n",
            )
            .unwrap();
        });
        assert_eq!(result, Ok(()));
        assert_eq!(
            calls,
            [
                ["uninstall", "--global", "--runtime", "claude"],
                ["uninstall", "--global", "--runtime", "codex"],
            ]
        );
    }

    #[test]
    fn uninstall_removes_a_plugin_mode_install_known_only_by_its_install_record() {
        let (result, calls, _) = run_global_install_in(production(), false, None, |home| {
            fs::create_dir_all(home.join(".claude")).unwrap();
            fs::create_dir_all(home.join(".hq/anywhere")).unwrap();
            fs::write(
                home.join(".hq/anywhere/claude-install.json"),
                r#"{"plugin":{"pluginId":"hq@hq"}}"#,
            )
            .unwrap();
        });
        assert_eq!(result, Ok(()));
        assert_eq!(calls, [["uninstall", "--global", "--runtime", "claude"]]);
    }

    #[test]
    fn the_hq_root_pointer_alone_is_not_an_install() {
        let (result, calls, _) = run_global_install_in(production(), false, None, |home| {
            fs::create_dir_all(home.join(".claude")).unwrap();
            fs::create_dir_all(home.join(".codex")).unwrap();
            fs::create_dir_all(home.join(".hq")).unwrap();
            fs::write(home.join(".hq/root"), "/tmp/HQ\n").unwrap();
        });
        assert_eq!(result, Ok(()));
        assert!(calls.is_empty(), "ran hq {calls:?}");
    }

    #[test]
    fn installing_for_one_tool_runs_only_that_runtime_even_before_its_folder_exists() {
        let (result, calls, resolved) =
            run_global_install_in(production(), true, Some(GlobalRuntime::Codex), |home| {
                fs::create_dir_all(home.join(".claude")).unwrap();
            });
        assert_eq!(result, Ok(()));
        assert!(resolved);
        assert_eq!(calls, [["install", "--global", "--runtime", "codex"]]);

        let (result, calls, _) =
            run_global_install_in(production(), true, Some(GlobalRuntime::Claude), |home| {
                write_claude_install(home);
            });
        assert_eq!(result, Ok(()));
        assert!(calls.is_empty(), "reinstalled an installed runtime: {calls:?}");

        let (result, calls, _) = run_global_install_in(
            bundle(Some(SCRATCH_BUNDLE_ID)),
            true,
            Some(GlobalRuntime::Claude),
            |_| {},
        );
        assert_eq!(result, Ok(()));
        assert!(calls.is_empty(), "a scratch bundle ran hq {calls:?}");
    }

    #[test]
    fn parses_only_the_supported_tool_names() {
        assert_eq!(GlobalRuntime::parse("claude"), Some(GlobalRuntime::Claude));
        assert_eq!(GlobalRuntime::parse("codex"), Some(GlobalRuntime::Codex));
        assert_eq!(GlobalRuntime::parse("grok"), None);
        assert_eq!(GlobalRuntime::parse("Claude --global"), None);
    }

    #[test]
    fn an_unsupported_tool_error_does_not_echo_the_renderer_string() {
        assert_eq!(parse_tool_runtime("claude"), Ok(GlobalRuntime::Claude));
        assert_eq!(
            parse_tool_runtime("<img src=x> --global"),
            Err("Unsupported coding tool".to_string())
        );
    }

    struct TempHome(PathBuf);

    impl TempHome {
        fn new() -> Self {
            // The clock alone collides between parallel tests on macOS, whose
            // clock has microsecond resolution; the counter keeps homes apart.
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            let sequence = NEXT.fetch_add(1, Ordering::Relaxed);
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock is after the epoch")
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "hq-anywhere-runtime-test-{}-{nonce}-{sequence}",
                std::process::id()
            ));
            fs::create_dir_all(&path).expect("create temporary HOME");
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempHome {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn put_binary(bin_dir: &Path, name: &str) {
        fs::create_dir_all(bin_dir).expect("create temporary PATH entry");
        let binary = bin_dir.join(name);
        fs::write(&binary, "test executable").expect("write fake runtime binary");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = fs::metadata(&binary)
                .expect("read fake binary")
                .permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(binary, permissions).expect("mark fake binary executable");
        }
    }

    fn executable_name(base: &str) -> String {
        if cfg!(windows) {
            format!("{base}.exe")
        } else {
            base.to_string()
        }
    }

    #[test]
    fn builds_exact_install_and_uninstall_argv_for_each_runtime() {
        assert_eq!(
            global_runtime_args(RuntimeAction::Install, GlobalRuntime::Claude),
            ["install", "--global", "--runtime", "claude"]
        );
        assert_eq!(
            global_runtime_args(RuntimeAction::Install, GlobalRuntime::Codex),
            ["install", "--global", "--runtime", "codex"]
        );
        assert_eq!(
            global_runtime_args(RuntimeAction::Uninstall, GlobalRuntime::Claude),
            ["uninstall", "--global", "--runtime", "claude"]
        );
        assert_eq!(
            global_runtime_args(RuntimeAction::Uninstall, GlobalRuntime::Codex),
            ["uninstall", "--global", "--runtime", "codex"]
        );
    }

    #[test]
    fn detects_both_runtimes_from_their_home_directories() {
        let home = TempHome::new();
        fs::create_dir_all(home.path().join(".claude")).unwrap();
        fs::create_dir_all(home.path().join(".codex")).unwrap();

        assert_eq!(
            detect_present_runtimes(home.path(), &[]),
            [GlobalRuntime::Claude, GlobalRuntime::Codex]
        );
    }

    #[test]
    fn detects_claude_only_when_its_binary_is_on_path() {
        let home = TempHome::new();
        let bin = home.path().join("bin");
        put_binary(&bin, &executable_name("claude"));

        assert_eq!(
            detect_present_runtimes(home.path(), &[bin]),
            [GlobalRuntime::Claude]
        );
    }

    #[test]
    fn detects_codex_only_when_its_binary_is_on_path() {
        let home = TempHome::new();
        let bin = home.path().join("bin");
        put_binary(&bin, &executable_name("codex"));

        assert_eq!(
            detect_present_runtimes(home.path(), &[bin]),
            [GlobalRuntime::Codex]
        );
    }

    #[test]
    fn detects_no_runtime_when_neither_home_nor_path_has_one() {
        let home = TempHome::new();
        let bin = home.path().join("bin");
        fs::create_dir_all(&bin).unwrap();

        assert!(detect_present_runtimes(home.path(), &[bin]).is_empty());
    }

    #[test]
    fn skips_a_runtime_only_when_its_managed_block_and_hq_mcp_entry_exist() {
        let home = TempHome::new();
        fs::create_dir_all(home.path().join(".claude")).unwrap();
        fs::write(
            home.path().join(".claude/CLAUDE.md"),
            "<!-- hq-anywhere:begin managed -->\nHQ\n<!-- hq-anywhere:end -->\n",
        )
        .unwrap();
        fs::write(
            home.path().join(".claude.json"),
            r#"{"mcpServers":{"hq":{"_hqPack":"hq-anywhere"}}}"#,
        )
        .unwrap();
        assert!(global_runtime_is_installed(
            home.path(),
            GlobalRuntime::Claude
        ));

        fs::create_dir_all(home.path().join(".codex")).unwrap();
        fs::write(
            home.path().join(".codex/AGENTS.md"),
            "<!-- hq-anywhere:begin (managed by `hq install --global --runtime codex`) -->\nHQ\n<!-- hq-anywhere:end -->\n",
        )
        .unwrap();
        fs::write(
            home.path().join(".codex/config.toml"),
            "[mcp_servers.hq]\ncommand = \"hq-mcp\"\n_hqPack = \"hq-anywhere\"\n",
        )
        .unwrap();
        assert!(global_runtime_is_installed(
            home.path(),
            GlobalRuntime::Codex
        ));
    }

    #[test]
    fn does_not_skip_codex_setup_for_a_foreign_hq_mcp_entry() {
        let home = TempHome::new();
        fs::create_dir_all(home.path().join(".codex")).unwrap();
        fs::write(
            home.path().join(".codex/AGENTS.md"),
            "<!-- hq-anywhere:begin (managed by `hq install --global --runtime codex`) -->\nHQ\n<!-- hq-anywhere:end -->\n",
        )
        .unwrap();
        fs::write(
            home.path().join(".codex/config.toml"),
            "[mcp_servers.hq]\ncommand = \"other-server\"\n_hqPack = \"another-pack\"\n",
        )
        .unwrap();

        assert!(!global_runtime_is_installed(
            home.path(),
            GlobalRuntime::Codex
        ));
    }

    #[test]
    fn renderer_failure_does_not_expose_cli_diagnostics() {
        let details = "hq install failed: secret path and raw stderr";
        let renderer_message = safe_renderer_failure(details);

        assert_eq!(renderer_message, "HQ Anywhere setup failed. Tap to retry.");
        assert!(!renderer_message.contains("secret path"));
        assert!(!renderer_message.contains("raw stderr"));
    }
}
