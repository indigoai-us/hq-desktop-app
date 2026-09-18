//! macOS LaunchAgent path reconciliation and post-update handoff.
//!
//! The shipped bundle is `HQ.app`, but existing user agents were written when
//! the bundle was `HQ Sync.app`. A KeepAlive agent that still points at the
//! old path keeps the previous binary running after an in-place update, so the
//! new `HQ.app` looks installed while the user stays on the old version.
//!
//! After a self-update the process must not relaunch through LaunchServices.
//! A GUI relaunch is invisible to launchd, so a KeepAlive agent starts a
//! second copy every ThrottleInterval (~10s). The single-instance plugin then
//! brings the primary window forward. Post-update restart waits for this
//! process to exit, then `bootout` / `bootstrap` / `kickstart` so launchd owns
//! the replacement. LaunchAgent argv includes `--from-launch-agent` so a
//! KeepAlive bounce does not steal focus.
//!
//! Pure helpers in this module are compiled on every platform so Linux CI
//! covers the rewrite / process-filter / leftover-bundle logic. Filesystem
//! launchctl and process-kill side effects stay macOS-gated.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// User LaunchAgent label. Must stay in lockstep with
/// `apps/sync/src-tauri/tauri.conf.json` `identifier` — see
/// `scripts/bundle-name-contract.test.ts`.
pub const LAUNCH_AGENT_LABEL: &str = "ai.indigo.hq-sync-menubar";

/// Shipped macOS bundle folder name (`productName` + `.app`).
pub const PRODUCT_BUNDLE_NAME: &str = "HQ.app";

/// Pre-rename bundle folder. Retired from `/Applications` when it is not the
/// running bundle.
pub const LEGACY_BUNDLE_NAME: &str = "HQ Sync.app";

/// Canonical installed executable inside `HQ.app`.
pub const CURRENT_BUNDLE_EXECUTABLE: &str = "/Applications/HQ.app/Contents/MacOS/hq-sync-menubar";

/// Extra ProgramArguments flag so a launchd KeepAlive (or post-update
/// kickstart) relaunch can be distinguished from a user opening HQ.app.
/// The single-instance handler must not activate the primary window when
/// this argument is present.
pub const LAUNCH_AGENT_RELAUNCH_ARG: &str = "--from-launch-agent";

const LOG_TAG: &str = "launchagent";

/// What happened while reconciling the LaunchAgent and leftover bundle.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ReconcileReport {
    pub repointed: Option<(String, String)>,
    pub killed: Vec<(u32, String)>,
    pub retired_legacy: Option<String>,
}

impl ReconcileReport {
    pub fn should_surface_notice(&self) -> bool {
        self.repointed.is_some() || !self.killed.is_empty() || self.retired_legacy.is_some()
    }
}

/// Outcome of rewriting a plist file on disk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlistAction {
    /// No plist at the given path.
    Absent,
    /// Present but ProgramArguments/Program could not be read. Left untouched.
    Unreadable,
    /// Already points at the running executable and carries the relaunch flag.
    Current,
    /// Rewrote ProgramArguments/Program to `new_path`. Other keys preserved.
    Repointed { old_path: String, new_path: String },
    /// Path was already current; added `--from-launch-agent` (no user notice).
    ArgsUpdated,
}

/// How a leftover bundle was moved out of the way.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RetireMethod {
    Trashed(PathBuf),
    RenamedOld(PathBuf),
}

/// First ProgramArguments string, falling back to the Program key.
pub fn registered_program_path(plist: &str) -> Option<String> {
    extract_program_arguments(plist).or_else(|| extract_program_key(plist))
}

/// Walk ancestors until a `*.app` bundle folder is found.
pub fn enclosing_app_bundle(path: &Path) -> Option<&Path> {
    path.ancestors().find(|p| {
        p.extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("app"))
    })
}

/// True when `exe` lives inside `/Applications/<something>.app`.
pub fn is_applications_bundle_exe(exe: &Path) -> bool {
    enclosing_app_bundle(exe)
        .and_then(|bundle| bundle.parent())
        .is_some_and(|parent| parent == Path::new("/Applications"))
}

/// Detect `/Applications/HQ Sync.app` when it is not the running bundle.
pub fn detect_leftover_legacy_bundle(
    applications_dir: &Path,
    running_bundle: &Path,
) -> Option<PathBuf> {
    let leftover = applications_dir.join(LEGACY_BUNDLE_NAME);
    if !leftover.exists() {
        return None;
    }
    if let (Ok(left), Ok(running)) = (leftover.canonicalize(), running_bundle.canonicalize()) {
        if left == running {
            return None;
        }
    } else if leftover == running_bundle {
        return None;
    }
    Some(leftover)
}

/// Processes that are running from a stale exe/bundle, excluding `self_pid`
/// and anything whose path matches the currently running executable.
pub fn filter_stale_processes(
    processes: &[(u32, String)],
    self_pid: u32,
    self_path: &str,
    stale_exe: Option<&str>,
    stale_bundle: Option<&Path>,
) -> Vec<(u32, String)> {
    processes
        .iter()
        .filter(|(pid, path)| {
            if *pid == self_pid || *pid <= 1 {
                return false;
            }
            if paths_equivalent(path, self_path) {
                return false;
            }
            process_matches_stale(path, stale_exe, stale_bundle)
        })
        .cloned()
        .collect()
}

/// Rewrite ProgramArguments (first string) and/or Program to `new_path`,
/// leaving every other key (KeepAlive, RunAtLoad, Label, extra args) intact.
pub fn rewrite_plist_program_path(plist: &str, new_path: &str) -> Result<String, String> {
    let old = registered_program_path(plist)
        .ok_or_else(|| "malformed LaunchAgent plist: no ProgramArguments/Program".to_string())?;
    if old == new_path {
        return Ok(plist.to_string());
    }

    let mut out = plist.to_string();
    if extract_program_arguments(&out).is_some() {
        out = replace_first_array_string_after_key(&out, "ProgramArguments", new_path).ok_or_else(
            || "malformed LaunchAgent plist: ProgramArguments is not a string array".to_string(),
        )?;
    }
    if extract_program_key(&out).is_some() {
        out = replace_string_after_key(&out, "Program", new_path)
            .ok_or_else(|| "malformed LaunchAgent plist: Program is not a string".to_string())?;
    }
    match registered_program_path(&out) {
        Some(path) if path == new_path => Ok(out),
        _ => Err("failed to rewrite LaunchAgent program path".to_string()),
    }
}

/// Read a plist file and rewrite it in place when the program path is stale.
///
/// Never creates a missing file (callers that want default-on autostart go
/// through the existing `autostart::set_enabled` path). Never overwrites an
/// unreadable plist. Callers pass a path — tests use a temp file so the
/// owner's real `~/Library/LaunchAgents/ai.indigo.hq-sync-menubar.plist` is
/// not touched.
pub fn reconcile_plist_file(plist_path: &Path, current_exe: &str) -> Result<PlistAction, String> {
    let contents = match std::fs::read_to_string(plist_path) {
        Ok(text) => text,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(PlistAction::Absent),
        Err(err) => {
            log_la(&format!("unreadable {}: {err}", plist_path.display()));
            return Ok(PlistAction::Unreadable);
        }
    };
    let Some(old_path) = registered_program_path(&contents) else {
        log_la(&format!("unreadable {}", plist_path.display()));
        return Ok(PlistAction::Unreadable);
    };
    let mut body = contents;
    let path_changed = !paths_equivalent(&old_path, current_exe);
    if path_changed {
        body = rewrite_plist_program_path(&body, current_exe)?;
    }
    let (body, args_changed) = match ensure_launch_agent_relaunch_arg(&body) {
        Ok(result) => result,
        Err(err) => {
            if !path_changed {
                log_la(&format!("relaunch-arg rewrite failed: {err}"));
                return Ok(PlistAction::Unreadable);
            }
            log_la(&format!(
                "relaunch-arg rewrite failed after path update: {err}"
            ));
            (body, false)
        }
    };
    if !path_changed && !args_changed {
        return Ok(PlistAction::Current);
    }
    atomic_write(plist_path, body.as_bytes())?;
    if path_changed {
        log_la(&format!("repointed {old_path} -> {current_exe}"));
        if args_changed {
            log_la("added --from-launch-agent to ProgramArguments");
        }
        Ok(PlistAction::Repointed {
            old_path,
            new_path: current_exe.to_string(),
        })
    } else {
        log_la("added --from-launch-agent to ProgramArguments");
        Ok(PlistAction::ArgsUpdated)
    }
}

/// Move `path` into `trash_dir` when possible; otherwise rename with a `.old`
/// suffix next to the original. Never deletes.
pub fn retire_path(path: &Path, trash_dir: Option<&Path>) -> Result<RetireMethod, String> {
    if let Some(trash) = trash_dir {
        if trash.is_dir() {
            if let Some(name) = path.file_name() {
                let dest = unique_sibling(trash, name);
                if std::fs::rename(path, &dest).is_ok() {
                    return Ok(RetireMethod::Trashed(dest));
                }
            }
        }
    }

    let dest = unique_old_suffix(path);
    std::fs::rename(path, &dest).map_err(|err| format!("retire {}: {err}", path.display()))?;
    Ok(RetireMethod::RenamedOld(dest))
}

/// Injected inputs so tests never talk to the owner's real LaunchAgent,
/// launchd, or process table.
pub struct ReconcileRequest<'a> {
    pub plist_path: &'a Path,
    pub current_exe: &'a str,
    pub self_pid: u32,
    pub label: &'a str,
    pub uid: u32,
    pub applications_dir: &'a Path,
    pub running_bundle: &'a Path,
    pub trash_dir: Option<&'a Path>,
    pub processes: &'a [(u32, String)],
    pub run_launchctl: bool,
    pub kill_processes: bool,
    pub retire_legacy: bool,
}

/// Reconcile a LaunchAgent using caller-supplied paths and process list.
///
/// Production (`reconcile_installed`) fills these from the live environment.
/// Tests point `plist_path` at a temp file and set `run_launchctl` /
/// `kill_processes` false so the owner's agent is never loaded, unloaded, or
/// rewritten.
pub fn reconcile_with(request: ReconcileRequest<'_>) -> ReconcileReport {
    let mut report = ReconcileReport::default();

    let leftover = if request.retire_legacy {
        detect_leftover_legacy_bundle(request.applications_dir, request.running_bundle)
    } else {
        None
    };

    let action = match reconcile_plist_file(request.plist_path, request.current_exe) {
        Ok(action) => action,
        Err(err) => {
            log_la(&format!("rewrite failed: {err}"));
            PlistAction::Unreadable
        }
    };

    let stale_exe = match &action {
        PlistAction::Repointed { old_path, .. } => Some(old_path.as_str()),
        _ => None,
    };

    if let PlistAction::Repointed { old_path, new_path } = &action {
        report.repointed = Some((old_path.clone(), new_path.clone()));
        if request.run_launchctl {
            reload_launch_agent(request.uid, request.label, request.plist_path);
        }
    }

    let stale = filter_stale_processes(
        request.processes,
        request.self_pid,
        request.current_exe,
        stale_exe,
        leftover.as_deref(),
    );

    if request.kill_processes {
        for (pid, path) in &stale {
            terminate_pid(*pid);
            log_la(&format!("killed stale {pid} {path}"));
            report.killed.push((*pid, path.clone()));
        }
    } else {
        report.killed = stale;
    }

    if let Some(bundle) = leftover {
        match retire_path(&bundle, request.trash_dir) {
            Ok(method) => {
                let retired = match method {
                    RetireMethod::Trashed(dest) => {
                        log_la(&format!(
                            "retired leftover {} via trash {}",
                            bundle.display(),
                            dest.display()
                        ));
                        dest
                    }
                    RetireMethod::RenamedOld(dest) => {
                        log_la(&format!(
                            "retired leftover {} via rename {}",
                            bundle.display(),
                            dest.display()
                        ));
                        dest
                    }
                };
                report.retired_legacy = Some(retired.display().to_string());
            }
            Err(err) => log_la(&format!(
                "retire leftover {} failed: {err}",
                bundle.display()
            )),
        }
    }

    report
}

/// Production entry: heal the installed `/Applications` copy. No-op when this
/// process is not running from `/Applications/*.app` (dev builds must not
/// rewrite the user's login agent to a target/debug binary).
pub fn reconcile_installed(retire_legacy: bool) -> ReconcileReport {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = retire_legacy;
        ReconcileReport::default()
    }
    #[cfg(target_os = "macos")]
    {
        let exe = match std::env::current_exe() {
            Ok(path) => path,
            Err(err) => {
                log_la(&format!("current_exe failed: {err}"));
                return ReconcileReport::default();
            }
        };
        if !is_applications_bundle_exe(&exe) {
            return ReconcileReport::default();
        }
        // Scope every side effect below to THIS install's bundle identifier.
        // A side-by-side build (own identifier, e.g. a local debug bundle)
        // must not repoint or bootout the owner's agent, and must not kill the
        // installed copy's process just because both binaries are named
        // `hq-sync-menubar`.
        let identifier = bundle_identifier_for_exe(&exe);
        let (label, retire_legacy) = match install_scope(identifier.as_deref(), retire_legacy) {
            InstallScope::Scoped {
                label,
                retire_legacy,
            } => (label, retire_legacy),
            InstallScope::Unknown => {
                log_la("bundle identifier unknown; skipping LaunchAgent reconcile (no kill)");
                return ReconcileReport::default();
            }
        };
        let Some(plist_path) = plist_path_for_label(&label) else {
            log_la("no home directory; skipping");
            return ReconcileReport::default();
        };
        let running_bundle = enclosing_app_bundle(&exe)
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("/Applications/HQ.app"));
        let processes = list_process_executables();
        let trash_dir = dirs::home_dir().map(|home| home.join(".Trash"));
        let exe_str = exe.to_string_lossy().into_owned();
        reconcile_with(ReconcileRequest {
            plist_path: &plist_path,
            current_exe: &exe_str,
            self_pid: std::process::id(),
            label: &label,
            uid: current_uid(),
            applications_dir: Path::new("/Applications"),
            running_bundle: &running_bundle,
            trash_dir: trash_dir.as_deref(),
            processes: &processes,
            run_launchctl: true,
            kill_processes: true,
            retire_legacy,
        })
    }
}

/// Path to the user LaunchAgent for `label`. Tests must not write the real one.
pub fn plist_path_for_label(label: &str) -> Option<PathBuf> {
    dirs::home_dir().map(|home| {
        home.join("Library")
            .join("LaunchAgents")
            .join(format!("{label}.plist"))
    })
}

/// Path to the real user LaunchAgent. Tests must not write this file.
pub fn installed_plist_path() -> Option<PathBuf> {
    plist_path_for_label(LAUNCH_AGENT_LABEL)
}

/// `CFBundleIdentifier` from an `Info.plist` body. Pure so every platform's CI
/// covers it.
pub fn bundle_identifier_from_info_plist(plist: &str) -> Option<String> {
    let after_key = plist.split("<key>CFBundleIdentifier</key>").nth(1)?;
    let value = after_key
        .split("<string>")
        .nth(1)?
        .split("</string>")
        .next()?;
    let id = xml_unescape(value.trim());
    if id.is_empty() {
        None
    } else {
        Some(id)
    }
}

/// Bundle identifier of the `.app` an executable lives in, or `None` when the
/// bundle or its `Info.plist` cannot be read. `None` always means "this
/// process does not know who it is", and every caller must then do nothing.
pub fn bundle_identifier_for_exe(exe: &Path) -> Option<String> {
    let bundle = enclosing_app_bundle(exe)?;
    let info = bundle.join("Contents").join("Info.plist");
    match std::fs::read_to_string(&info) {
        Ok(text) => match bundle_identifier_from_info_plist(&text) {
            Some(id) => Some(id),
            None => {
                log_la(&format!("no CFBundleIdentifier in {}", info.display()));
                None
            }
        },
        Err(err) => {
            log_la(&format!("unreadable {}: {err}", info.display()));
            None
        }
    }
}

/// What a running install is allowed to reconcile.
///
/// A side-by-side debug build carries its OWN bundle identifier. It must only
/// ever touch the LaunchAgent named after that identifier, and may only
/// terminate processes belonging to that same install — never the owner's
/// installed `ai.indigo.hq-sync-menubar` copy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InstallScope {
    /// Reconcile the agent labelled `label`. `retire_legacy` can only be true
    /// for the canonical shipped identifier — a differently identified build
    /// never owns `HQ Sync.app`.
    Scoped { label: String, retire_legacy: bool },
    /// The bundle identifier could not be read. Do nothing: no plist rewrite,
    /// no launchctl, and above all no kill.
    Unknown,
}

/// Resolve the scope for a running install. An absent or blank identifier
/// resolves to [`InstallScope::Unknown`] — "do not kill", never "kill
/// everything".
pub fn install_scope(identifier: Option<&str>, retire_legacy_requested: bool) -> InstallScope {
    match identifier.map(str::trim) {
        Some(id) if !id.is_empty() => InstallScope::Scoped {
            label: id.to_string(),
            retire_legacy: retire_legacy_requested && id == LAUNCH_AGENT_LABEL,
        },
        _ => InstallScope::Unknown,
    }
}

/// launchctl argv pairs for bootout then bootstrap. Kept pure so tests can
/// lock the sequence without talking to launchd.
pub fn launchctl_reload_args(uid: u32, label: &str, plist_path: &Path) -> Vec<Vec<String>> {
    let domain = format!("gui/{uid}");
    let target = format!("{domain}/{label}");
    vec![
        vec!["bootout".to_string(), target],
        vec![
            "bootstrap".to_string(),
            domain,
            plist_path.to_string_lossy().into_owned(),
        ],
    ]
}

/// True when a second-process argv came from the LaunchAgent (KeepAlive or
/// post-update kickstart) rather than a user opening the bundle.
pub fn argv_is_launch_agent_relaunch<S: AsRef<str>>(argv: &[S]) -> bool {
    argv.iter()
        .any(|arg| arg.as_ref() == LAUNCH_AGENT_RELAUNCH_ARG)
}

/// Every ProgramArguments string, in order. Empty when the key is absent.
pub fn program_argument_strings(plist: &str) -> Vec<String> {
    let Some(after_key) = plist.split("<key>ProgramArguments</key>").nth(1) else {
        return Vec::new();
    };
    let Some(array) = after_key.split("<array>").nth(1) else {
        return Vec::new();
    };
    let Some(array) = array.split("</array>").next() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut rest = array;
    while let Some((_, after_open)) = rest.split_once("<string>") {
        let Some((value, after_close)) = after_open.split_once("</string>") else {
            break;
        };
        out.push(xml_unescape(value.trim()));
        rest = after_close;
    }
    out
}

/// Insert `--from-launch-agent` into ProgramArguments when missing.
/// Returns `(plist, changed)`.
pub fn ensure_launch_agent_relaunch_arg(plist: &str) -> Result<(String, bool), String> {
    let args = program_argument_strings(plist);
    if args.iter().any(|arg| arg == LAUNCH_AGENT_RELAUNCH_ARG) {
        return Ok((plist.to_string(), false));
    }
    if args.is_empty() {
        return Ok((plist.to_string(), false));
    }
    let needle = "<key>ProgramArguments</key>";
    let key_at = plist
        .find(needle)
        .ok_or_else(|| "malformed LaunchAgent plist: ProgramArguments key missing".to_string())?;
    let after_key = key_at + needle.len();
    let array_end_rel = plist[after_key..].find("</array>").ok_or_else(|| {
        "malformed LaunchAgent plist: ProgramArguments array is not closed".to_string()
    })?;
    let insert_at = after_key + array_end_rel;
    let insert = format!("        <string>{LAUNCH_AGENT_RELAUNCH_ARG}</string>\n    ");
    Ok((splice(plist, insert_at, insert_at, &insert), true))
}

/// PID from `launchctl list <label>` stdout, if the job is running.
pub fn parse_launchctl_list_pid(stdout: &str) -> Option<u32> {
    for line in stdout.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix("\"PID\"") else {
            continue;
        };
        let value = rest
            .trim()
            .trim_start_matches('=')
            .trim()
            .trim_end_matches(';')
            .trim();
        return value.parse().ok();
    }
    None
}

/// Unload a KeepAlive job only when this process is not that job. Bootout of
/// our own launchd job would kill the updater before it can hand off.
pub fn should_bootout_foreign_job(self_pid: u32, agent_pid: Option<u32>) -> bool {
    match agent_pid {
        Some(pid) if pid == self_pid => false,
        _ => true,
    }
}

/// Detached waiter that reloads the LaunchAgent after `pid` exits.
/// Env vars carry paths so the shell script never interpolates them.
pub fn launchctl_handoff_after_exit_command(
    pid: u32,
    uid: u32,
    label: &str,
    plist_path: &Path,
) -> (Vec<String>, Vec<(String, String)>) {
    let domain = format!("gui/{uid}");
    let target = format!("{domain}/{label}");
    let script = concat!(
        "while /bin/kill -0 \"$HQ_HANDOFF_PID\" 2>/dev/null; do /bin/sleep 0.2; done; ",
        "/bin/launchctl bootout \"$HQ_HANDOFF_TARGET\" >/dev/null 2>&1; ",
        "/bin/launchctl bootstrap \"$HQ_HANDOFF_DOMAIN\" \"$HQ_HANDOFF_PLIST\" && ",
        "/bin/launchctl kickstart \"$HQ_HANDOFF_TARGET\"",
    );
    (
        vec![
            "/usr/bin/nohup".to_string(),
            "/bin/sh".to_string(),
            "-c".to_string(),
            script.to_string(),
        ],
        vec![
            ("HQ_HANDOFF_PID".to_string(), pid.to_string()),
            ("HQ_HANDOFF_TARGET".to_string(), target),
            ("HQ_HANDOFF_DOMAIN".to_string(), domain),
            (
                "HQ_HANDOFF_PLIST".to_string(),
                plist_path.to_string_lossy().into_owned(),
            ),
        ],
    )
}

/// After a macOS self-update: if the user LaunchAgent exists, schedule launchd
/// to own the replacement process and return true. The caller must then exit
/// without a LaunchServices relaunch (`app.restart()`).
pub fn schedule_handoff_after_exit() -> bool {
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
    #[cfg(target_os = "macos")]
    {
        let identifier = match std::env::current_exe() {
            Ok(exe) => bundle_identifier_for_exe(&exe),
            Err(err) => {
                log_la(&format!("current_exe failed: {err}"));
                None
            }
        };
        // Same scoping rule as `reconcile_installed`: hand off only this
        // install's own launchd job, never the canonical one from a
        // differently identified build.
        let InstallScope::Scoped { label, .. } = install_scope(identifier.as_deref(), false) else {
            log_la("bundle identifier unknown; skip launchd handoff");
            return false;
        };
        let Some(plist_path) = plist_path_for_label(&label) else {
            log_la("no home directory; cannot hand off to launchd");
            return false;
        };
        if !plist_path.exists() {
            log_la("no LaunchAgent plist; skip launchd handoff");
            return false;
        }
        let uid = current_uid();
        let self_pid = std::process::id();
        bootout_foreign_job_if_needed(uid, self_pid, &label);
        spawn_handoff_waiter(self_pid, uid, &label, &plist_path)
    }
}

fn extract_program_arguments(plist: &str) -> Option<String> {
    program_argument_strings(plist).into_iter().next()
}

fn extract_program_key(plist: &str) -> Option<String> {
    let after_key = plist.split("<key>Program</key>").nth(1)?;
    let value = after_key
        .split("<string>")
        .nth(1)?
        .split("</string>")
        .next()?;
    Some(xml_unescape(value.trim()))
}

fn replace_first_array_string_after_key(plist: &str, key: &str, new_path: &str) -> Option<String> {
    let needle = format!("<key>{key}</key>");
    let key_at = plist.find(&needle)?;
    let after_key = key_at + needle.len();
    let array_rel = plist[after_key..].find("<array>")?;
    let body_at = after_key + array_rel + "<array>".len();
    let array_end_rel = plist[body_at..].find("</array>")?;
    let array_body = &plist[body_at..body_at + array_end_rel];
    let open_rel = array_body.find("<string>")?;
    let value_at = body_at + open_rel + "<string>".len();
    let close_rel = plist[value_at..].find("</string>")?;
    Some(splice(
        plist,
        value_at,
        value_at + close_rel,
        &xml_escape(new_path),
    ))
}

fn replace_string_after_key(plist: &str, key: &str, new_path: &str) -> Option<String> {
    let needle = format!("<key>{key}</key>");
    let key_at = plist.find(&needle)?;
    let after_key = key_at + needle.len();
    let open_rel = plist[after_key..].find("<string>")?;
    let value_at = after_key + open_rel + "<string>".len();
    let close_rel = plist[value_at..].find("</string>")?;
    Some(splice(
        plist,
        value_at,
        value_at + close_rel,
        &xml_escape(new_path),
    ))
}

fn splice(src: &str, start: usize, end: usize, insert: &str) -> String {
    let mut out = String::with_capacity(src.len() + insert.len());
    out.push_str(&src[..start]);
    out.push_str(insert);
    out.push_str(&src[end..]);
    out
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn xml_unescape(value: &str) -> String {
    value
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

fn paths_equivalent(a: &str, b: &str) -> bool {
    if a == b {
        return true;
    }
    let pa = Path::new(a);
    let pb = Path::new(b);
    if let (Ok(ca), Ok(cb)) = (pa.canonicalize(), pb.canonicalize()) {
        return ca == cb;
    }
    false
}

fn process_matches_stale(
    process_path: &str,
    stale_exe: Option<&str>,
    stale_bundle: Option<&Path>,
) -> bool {
    let path = Path::new(process_path);
    if let Some(exe) = stale_exe {
        if paths_equivalent(process_path, exe) {
            return true;
        }
        if let Some(bundle) = enclosing_app_bundle(Path::new(exe)) {
            if path.starts_with(bundle) {
                return true;
            }
        }
    }
    if let Some(bundle) = stale_bundle {
        if path.starts_with(bundle) {
            return true;
        }
    }
    false
}

fn unique_sibling(dir: &Path, name: &std::ffi::OsStr) -> PathBuf {
    let dest = dir.join(name);
    if !dest.exists() {
        return dest;
    }
    let stamp = unix_stamp();
    let mut stamped = name.to_os_string();
    stamped.push("-");
    stamped.push(&stamp);
    dir.join(stamped)
}

fn unique_old_suffix(path: &Path) -> PathBuf {
    let mut dest = path.as_os_str().to_os_string();
    dest.push(".old");
    let dest = PathBuf::from(dest);
    if !dest.exists() {
        return dest;
    }
    let mut stamped = dest.into_os_string();
    stamped.push("-");
    stamped.push(&unix_stamp());
    PathBuf::from(stamped)
}

fn unix_stamp() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("plist.tmp");
    std::fs::write(&tmp, bytes).map_err(|err| format!("write {}: {err}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|err| format!("rename {}: {err}", path.display()))?;
    Ok(())
}

fn log_la(msg: &str) {
    hq_desktop_core::logfile::log(LOG_TAG, msg);
}

#[cfg(target_os = "macos")]
fn bootout_foreign_job_if_needed(uid: u32, self_pid: u32, label: &str) {
    let output = std::process::Command::new("launchctl")
        .args(["list", label])
        .output();
    let agent_pid = match output {
        Ok(output) => parse_launchctl_list_pid(&String::from_utf8_lossy(&output.stdout)),
        Err(err) => {
            log_la(&format!("launchctl list error: {err}"));
            return;
        }
    };
    if !should_bootout_foreign_job(self_pid, agent_pid) {
        return;
    }
    let target = format!("gui/{uid}/{label}");
    match std::process::Command::new("launchctl")
        .args(["bootout", &target])
        .output()
    {
        Ok(output) if output.status.success() => {
            log_la("bootout of unloaded/foreign KeepAlive job before handoff");
        }
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            log_la(&format!("pre-handoff bootout failed: {}", stderr.trim()));
        }
        Err(err) => log_la(&format!("pre-handoff bootout error: {err}")),
    }
}

#[cfg(target_os = "macos")]
fn spawn_handoff_waiter(self_pid: u32, uid: u32, label: &str, plist_path: &Path) -> bool {
    use std::process::Stdio;
    let (argv, env) = launchctl_handoff_after_exit_command(self_pid, uid, label, plist_path);
    let Some((program, args)) = argv.split_first() else {
        log_la("handoff command was empty");
        return false;
    };
    let mut cmd = std::process::Command::new(program);
    cmd.args(args);
    for (key, value) in env {
        cmd.env(key, value);
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    match cmd.spawn() {
        Ok(_) => {
            log_la("scheduled launchd handoff after this process exits");
            true
        }
        Err(err) => {
            log_la(&format!("schedule launchd handoff failed: {err}"));
            false
        }
    }
}

fn reload_launch_agent(uid: u32, label: &str, plist_path: &Path) {
    let steps = launchctl_reload_args(uid, label, plist_path);
    let mut bootstrap_ok = false;
    for args in &steps {
        match std::process::Command::new("launchctl").args(args).output() {
            Ok(output) => {
                if args.first().map(String::as_str) == Some("bootstrap") && output.status.success()
                {
                    bootstrap_ok = true;
                }
                if !output.status.success() {
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    log_la(&format!(
                        "launchctl {} failed: {}",
                        args.join(" "),
                        stderr.trim()
                    ));
                }
            }
            Err(err) => log_la(&format!("launchctl {} error: {err}", args.join(" "))),
        }
    }
    if !bootstrap_ok {
        let plist = plist_path.to_string_lossy();
        let _ = std::process::Command::new("launchctl")
            .args(["unload", plist.as_ref()])
            .status();
        match std::process::Command::new("launchctl")
            .args(["load", plist.as_ref()])
            .status()
        {
            Ok(status) if status.success() => {}
            Ok(status) => log_la(&format!("launchctl load fallback exited {status}")),
            Err(err) => log_la(&format!("launchctl load fallback error: {err}")),
        }
    }
}

fn terminate_pid(pid: u32) {
    let pid_s = pid.to_string();
    let _ = std::process::Command::new("kill")
        .args(["-TERM", &pid_s])
        .status();
    std::thread::sleep(std::time::Duration::from_millis(400));
    if pid_is_alive(pid) {
        let _ = std::process::Command::new("kill")
            .args(["-KILL", &pid_s])
            .status();
    }
}

fn pid_is_alive(pid: u32) -> bool {
    std::process::Command::new("kill")
        .args(["-0", &pid.to_string()])
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

#[cfg(target_os = "macos")]
fn current_uid() -> u32 {
    unsafe { libc::getuid() }
}

#[cfg(target_os = "macos")]
mod procinfo {
    use std::ffi::c_void;

    pub const PROC_ALL_PIDS: u32 = 1;
    pub const MAX_PATH: usize = 4096;

    extern "C" {
        pub fn proc_listpids(
            type_: u32,
            typeinfo: u32,
            buffer: *mut c_void,
            buffersize: i32,
        ) -> i32;
        pub fn proc_pidpath(pid: i32, buffer: *mut c_void, buffersize: u32) -> i32;
    }
}

#[cfg(target_os = "macos")]
fn list_process_executables() -> Vec<(u32, String)> {
    let needed =
        unsafe { procinfo::proc_listpids(procinfo::PROC_ALL_PIDS, 0, std::ptr::null_mut(), 0) };
    if needed <= 0 {
        return Vec::new();
    }
    let cap = (needed as usize / std::mem::size_of::<i32>()).saturating_add(32);
    let mut pids = vec![0_i32; cap];
    let filled = unsafe {
        procinfo::proc_listpids(
            procinfo::PROC_ALL_PIDS,
            0,
            pids.as_mut_ptr() as *mut std::ffi::c_void,
            (pids.len() * std::mem::size_of::<i32>()) as i32,
        )
    };
    if filled <= 0 {
        return Vec::new();
    }
    let count = (filled as usize) / std::mem::size_of::<i32>();
    let mut out = Vec::new();
    let mut buf = vec![0_u8; procinfo::MAX_PATH];
    for pid in pids.into_iter().take(count) {
        if pid <= 0 {
            continue;
        }
        buf.fill(0);
        let n = unsafe {
            procinfo::proc_pidpath(
                pid,
                buf.as_mut_ptr() as *mut std::ffi::c_void,
                buf.len() as u32,
            )
        };
        if n <= 0 {
            continue;
        }
        let path = String::from_utf8_lossy(&buf[..n as usize]).into_owned();
        if !path.is_empty() {
            out.push((pid as u32, path));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;
    use std::fs;
    use tempfile::TempDir;

    const OLD_EXE: &str = "/Applications/HQ Sync.app/Contents/MacOS/hq-sync-menubar";
    const NEW_EXE: &str = CURRENT_BUNDLE_EXECUTABLE;
    const OLD_HQ_NAME: &str = "/Applications/HQ.app/Contents/MacOS/HQ";

    fn fixture(program: &str, keepalive: bool) -> String {
        let keepalive_block = if keepalive {
            "    <key>KeepAlive</key>\n    <true/>\n"
        } else {
            ""
        };
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>{LAUNCH_AGENT_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>{program}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
{keepalive_block}</dict>
</plist>
"#
        )
    }

    fn fixture_program_key(program: &str) -> String {
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>{LAUNCH_AGENT_LABEL}</string>
    <key>Program</key>
    <string>{program}</string>
    <key>KeepAlive</key>
    <true/>
</dict>
</plist>
"#
        )
    }

    #[test]
    fn extract_reads_program_arguments() {
        let plist = fixture(OLD_EXE, true);
        assert_eq!(registered_program_path(&plist).as_deref(), Some(OLD_EXE));
    }

    #[test]
    fn extract_reads_program_key() {
        let plist = fixture_program_key(OLD_EXE);
        assert_eq!(registered_program_path(&plist).as_deref(), Some(OLD_EXE));
    }

    #[test]
    fn extract_none_on_malformed() {
        assert_eq!(registered_program_path("not a plist"), None);
        assert_eq!(registered_program_path(""), None);
        assert_eq!(
            registered_program_path("<key>Label</key><string>x</string>"),
            None
        );
    }

    #[test]
    fn rewrite_old_path_preserves_keepalive_and_label() {
        let original = fixture(OLD_EXE, true);
        let rewritten = rewrite_plist_program_path(&original, NEW_EXE).unwrap();
        assert_eq!(
            registered_program_path(&rewritten).as_deref(),
            Some(NEW_EXE)
        );
        assert!(rewritten.contains("<key>KeepAlive</key>"));
        assert!(rewritten.contains("<true/>"));
        assert!(rewritten.contains(&format!("<string>{LAUNCH_AGENT_LABEL}</string>")));
        assert!(rewritten.contains("<key>RunAtLoad</key>"));
        assert!(!rewritten.contains("HQ Sync.app"));
    }

    #[test]
    fn rewrite_current_path_is_idempotent() {
        let original = fixture(NEW_EXE, false);
        let rewritten = rewrite_plist_program_path(&original, NEW_EXE).unwrap();
        assert_eq!(rewritten, original);
    }

    #[test]
    fn rewrite_updates_program_key() {
        let original = fixture_program_key(OLD_EXE);
        let rewritten = rewrite_plist_program_path(&original, NEW_EXE).unwrap();
        assert_eq!(
            registered_program_path(&rewritten).as_deref(),
            Some(NEW_EXE)
        );
        assert!(rewritten.contains("<key>KeepAlive</key>"));
    }

    #[test]
    fn rewrite_malformed_errors() {
        assert!(rewrite_plist_program_path("garbage", NEW_EXE).is_err());
    }

    #[test]
    fn rewrite_stale_hq_binary_name() {
        let original = fixture(OLD_HQ_NAME, false);
        let rewritten = rewrite_plist_program_path(&original, NEW_EXE).unwrap();
        assert_eq!(
            registered_program_path(&rewritten).as_deref(),
            Some(NEW_EXE)
        );
    }

    #[test]
    fn reconcile_plist_missing_is_absent() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("missing.plist");
        assert_eq!(
            reconcile_plist_file(&path, NEW_EXE).unwrap(),
            PlistAction::Absent
        );
        assert!(!path.exists());
    }

    #[test]
    fn reconcile_plist_malformed_is_unreadable_and_untouched() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("broken.plist");
        fs::write(&path, "not xml").unwrap();
        assert_eq!(
            reconcile_plist_file(&path, NEW_EXE).unwrap(),
            PlistAction::Unreadable
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), "not xml");
    }

    #[test]
    fn reconcile_plist_current_is_noop() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("agent.plist");
        let (with_flag, changed) =
            ensure_launch_agent_relaunch_arg(&fixture(NEW_EXE, true)).unwrap();
        assert!(changed);
        fs::write(&path, with_flag).unwrap();
        assert_eq!(
            reconcile_plist_file(&path, NEW_EXE).unwrap(),
            PlistAction::Current
        );
        assert!(fs::read_to_string(&path).unwrap().contains("KeepAlive"));
        assert!(fs::read_to_string(&path)
            .unwrap()
            .contains(LAUNCH_AGENT_RELAUNCH_ARG));
    }

    #[test]
    fn reconcile_plist_adds_relaunch_arg_without_repoint_notice() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("agent.plist");
        fs::write(&path, fixture(NEW_EXE, true)).unwrap();
        assert_eq!(
            reconcile_plist_file(&path, NEW_EXE).unwrap(),
            PlistAction::ArgsUpdated
        );
        let body = fs::read_to_string(&path).unwrap();
        assert!(body.contains(LAUNCH_AGENT_RELAUNCH_ARG));
        assert!(body.contains("KeepAlive"));
        assert_eq!(
            reconcile_plist_file(&path, NEW_EXE).unwrap(),
            PlistAction::Current
        );
    }

    #[test]
    fn reconcile_plist_old_path_rewrites() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("agent.plist");
        fs::write(&path, fixture(OLD_EXE, true)).unwrap();
        match reconcile_plist_file(&path, NEW_EXE).unwrap() {
            PlistAction::Repointed { old_path, new_path } => {
                assert_eq!(old_path, OLD_EXE);
                assert_eq!(new_path, NEW_EXE);
            }
            other => panic!("expected repoint, got {other:?}"),
        }
        let body = fs::read_to_string(&path).unwrap();
        assert!(body.contains(NEW_EXE));
        assert!(body.contains("KeepAlive"));
        assert!(!body.contains("HQ Sync.app"));
    }

    #[test]
    fn stale_process_filter_ignores_self() {
        let self_pid = 99;
        let processes = vec![
            (self_pid, OLD_EXE.to_string()),
            (100, NEW_EXE.to_string()),
            (101, OLD_EXE.to_string()),
            (1, OLD_EXE.to_string()),
            (0, OLD_EXE.to_string()),
        ];
        let stale = filter_stale_processes(
            &processes,
            self_pid,
            NEW_EXE,
            Some(OLD_EXE),
            Some(Path::new("/Applications/HQ Sync.app")),
        );
        assert_eq!(stale, vec![(101, OLD_EXE.to_string())]);
    }

    #[test]
    fn stale_process_filter_matches_helper_inside_old_bundle() {
        let helper = "/Applications/HQ Sync.app/Contents/MacOS/tray-helper";
        let processes = vec![(42, helper.to_string()), (7, NEW_EXE.to_string())];
        let stale = filter_stale_processes(
            &processes,
            7,
            NEW_EXE,
            Some(OLD_EXE),
            Some(Path::new("/Applications/HQ Sync.app")),
        );
        assert_eq!(stale, vec![(42, helper.to_string())]);
    }

    #[test]
    fn leftover_legacy_bundle_detected_when_not_running() {
        let tmp = TempDir::new().unwrap();
        let apps = tmp.path();
        let leftover = apps.join(LEGACY_BUNDLE_NAME);
        fs::create_dir(&leftover).unwrap();
        let running = apps.join(PRODUCT_BUNDLE_NAME);
        fs::create_dir(&running).unwrap();
        let found = detect_leftover_legacy_bundle(apps, &running).unwrap();
        assert_eq!(found, leftover);
    }

    #[test]
    fn leftover_legacy_bundle_ignored_when_it_is_the_running_bundle() {
        let tmp = TempDir::new().unwrap();
        let leftover = tmp.path().join(LEGACY_BUNDLE_NAME);
        fs::create_dir(&leftover).unwrap();
        assert_eq!(detect_leftover_legacy_bundle(tmp.path(), &leftover), None);
    }

    #[test]
    fn leftover_legacy_bundle_absent() {
        let tmp = TempDir::new().unwrap();
        let running = tmp.path().join(PRODUCT_BUNDLE_NAME);
        fs::create_dir(&running).unwrap();
        assert_eq!(detect_leftover_legacy_bundle(tmp.path(), &running), None);
    }

    #[test]
    fn retire_moves_to_trash_when_possible() {
        let tmp = TempDir::new().unwrap();
        let apps = tmp.path().join("Applications");
        let trash = tmp.path().join("Trash");
        fs::create_dir(&apps).unwrap();
        fs::create_dir(&trash).unwrap();
        let leftover = apps.join(LEGACY_BUNDLE_NAME);
        fs::create_dir(&leftover).unwrap();
        fs::write(leftover.join("marker"), "old").unwrap();

        match retire_path(&leftover, Some(&trash)).unwrap() {
            RetireMethod::Trashed(dest) => {
                assert!(dest.starts_with(&trash));
                assert!(dest.join("marker").exists());
                assert!(!leftover.exists());
            }
            other => panic!("expected trash, got {other:?}"),
        }
    }

    #[test]
    fn retire_falls_back_to_old_suffix() {
        let tmp = TempDir::new().unwrap();
        let leftover = tmp.path().join(LEGACY_BUNDLE_NAME);
        fs::create_dir(&leftover).unwrap();
        match retire_path(&leftover, None).unwrap() {
            RetireMethod::RenamedOld(dest) => {
                assert_eq!(dest.file_name(), Some(OsStr::new("HQ Sync.app.old")));
                assert!(dest.exists());
                assert!(!leftover.exists());
            }
            other => panic!("expected .old rename, got {other:?}"),
        }
    }

    #[test]
    fn applications_bundle_guard() {
        assert!(is_applications_bundle_exe(Path::new(
            "/Applications/HQ.app/Contents/MacOS/hq-sync-menubar"
        )));
        assert!(is_applications_bundle_exe(Path::new(
            "/Applications/HQ Sync.app/Contents/MacOS/HQ Sync"
        )));
        assert!(!is_applications_bundle_exe(Path::new(
            "/Users/corey/target/debug/hq-sync-menubar"
        )));
        assert!(!is_applications_bundle_exe(Path::new(
            "/tmp/HQ.app/Contents/MacOS/hq-sync-menubar"
        )));
    }

    #[test]
    fn launchctl_reload_args_bootout_then_bootstrap() {
        let plist = Path::new("/tmp/ai.indigo.hq-sync-menubar.test-repoint.plist");
        let args = launchctl_reload_args(501, LAUNCH_AGENT_LABEL, plist);
        assert_eq!(
            args[0],
            vec!["bootout", "gui/501/ai.indigo.hq-sync-menubar"]
        );
        assert_eq!(
            args[1],
            vec![
                "bootstrap",
                "gui/501",
                "/tmp/ai.indigo.hq-sync-menubar.test-repoint.plist"
            ]
        );
    }

    #[test]
    fn argv_detects_launch_agent_relaunch_and_ignores_user_open() {
        assert!(argv_is_launch_agent_relaunch(&[
            CURRENT_BUNDLE_EXECUTABLE,
            LAUNCH_AGENT_RELAUNCH_ARG,
        ]));
        assert!(!argv_is_launch_agent_relaunch(&[CURRENT_BUNDLE_EXECUTABLE]));
        assert!(!argv_is_launch_agent_relaunch(&[
            CURRENT_BUNDLE_EXECUTABLE,
            "hqwork://thread/abc",
        ]));
        assert!(!argv_is_launch_agent_relaunch(&Vec::<&str>::new()));
    }

    #[test]
    fn ensure_relaunch_arg_is_idempotent_and_preserves_keepalive() {
        let original = fixture(NEW_EXE, true);
        let (once, changed) = ensure_launch_agent_relaunch_arg(&original).unwrap();
        assert!(changed);
        assert!(once.contains(LAUNCH_AGENT_RELAUNCH_ARG));
        assert!(once.contains("<key>KeepAlive</key>"));
        assert_eq!(
            program_argument_strings(&once),
            vec![NEW_EXE.to_string(), LAUNCH_AGENT_RELAUNCH_ARG.to_string()]
        );
        let (twice, changed_again) = ensure_launch_agent_relaunch_arg(&once).unwrap();
        assert!(!changed_again);
        assert_eq!(twice, once);
    }

    #[test]
    fn parse_launchctl_list_pid_reads_running_and_absent() {
        let running = r#"{
	"Label" = "ai.indigo.hq-sync-menubar";
	"LastExitStatus" = 0;
	"PID" = 17529;
	"Program" = "/Applications/HQ.app/Contents/MacOS/hq-sync-menubar";
};"#;
        assert_eq!(parse_launchctl_list_pid(running), Some(17529));
        let idle = r#"{
	"Label" = "ai.indigo.hq-sync-menubar";
	"LastExitStatus" = 0;
	"Program" = "/Applications/HQ.app/Contents/MacOS/hq-sync-menubar";
};"#;
        assert_eq!(parse_launchctl_list_pid(idle), None);
        assert_eq!(parse_launchctl_list_pid(""), None);
    }

    #[test]
    fn bootout_foreign_job_skips_self_and_unloads_missing_or_other() {
        assert!(!should_bootout_foreign_job(17529, Some(17529)));
        assert!(should_bootout_foreign_job(17529, None));
        assert!(should_bootout_foreign_job(17529, Some(99)));
    }

    #[test]
    fn handoff_after_exit_command_waits_then_reloads_via_env() {
        let plist = Path::new("/Users/test/Library/LaunchAgents/ai.indigo.hq-sync-menubar.plist");
        let (argv, env) =
            launchctl_handoff_after_exit_command(4242, 501, LAUNCH_AGENT_LABEL, plist);
        assert_eq!(argv[0], "/usr/bin/nohup");
        assert_eq!(argv[1], "/bin/sh");
        assert_eq!(argv[2], "-c");
        let script = &argv[3];
        assert!(script.contains("HQ_HANDOFF_PID"));
        assert!(script.contains("bootout"));
        assert!(script.contains("bootstrap"));
        assert!(script.contains("kickstart"));
        assert!(
            !script.contains("-k"),
            "post-exit kickstart must not -k a just-bootstrapped job"
        );
        assert!(
            !script.contains("4242"),
            "pid must not be interpolated into the script"
        );
        assert!(
            !script.contains("/Users/test"),
            "plist path must not be interpolated"
        );
        let env: std::collections::HashMap<_, _> = env.into_iter().collect();
        assert_eq!(env.get("HQ_HANDOFF_PID").map(String::as_str), Some("4242"));
        assert_eq!(
            env.get("HQ_HANDOFF_TARGET").map(String::as_str),
            Some("gui/501/ai.indigo.hq-sync-menubar")
        );
        assert_eq!(
            env.get("HQ_HANDOFF_DOMAIN").map(String::as_str),
            Some("gui/501")
        );
        assert_eq!(
            env.get("HQ_HANDOFF_PLIST").map(String::as_str),
            Some("/Users/test/Library/LaunchAgents/ai.indigo.hq-sync-menubar.plist")
        );
    }

    // --- Bundle-identity scoping -------------------------------------------
    //
    // Field report 2026-09-18: a side-by-side debug build (own bundle id,
    // updater off) started up and terminated the owner's installed
    // /Applications/HQ.app process, because the LaunchAgent label was a
    // hard-coded constant. The test build rewrote the canonical agent plist to
    // its own exe, which made the installed exe "stale", which killed it.

    const INFO_PLIST: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
    <key>CFBundleName</key>
    <string>HQ</string>
    <key>CFBundleIdentifier</key>
    <string>ai.indigo.hq-dm-test-20260918a</string>
</dict>
</plist>
"#;

    #[test]
    fn reads_bundle_identifier_from_info_plist() {
        assert_eq!(
            bundle_identifier_from_info_plist(INFO_PLIST).as_deref(),
            Some("ai.indigo.hq-dm-test-20260918a")
        );
    }

    #[test]
    fn missing_or_blank_bundle_identifier_reads_as_none() {
        assert_eq!(
            bundle_identifier_from_info_plist("<plist><dict></dict></plist>"),
            None
        );
        assert_eq!(
            bundle_identifier_from_info_plist(
                "<key>CFBundleIdentifier</key>\n<string>   </string>"
            ),
            None
        );
    }

    #[test]
    fn side_by_side_build_scopes_to_its_own_label_and_never_retires_legacy() {
        let scope = install_scope(Some("ai.indigo.hq-dm-test-20260918a"), true);
        assert_eq!(
            scope,
            InstallScope::Scoped {
                label: "ai.indigo.hq-dm-test-20260918a".to_string(),
                retire_legacy: false,
            }
        );
    }

    #[test]
    fn canonical_build_keeps_its_label_and_legacy_retirement() {
        assert_eq!(
            install_scope(Some(LAUNCH_AGENT_LABEL), true),
            InstallScope::Scoped {
                label: LAUNCH_AGENT_LABEL.to_string(),
                retire_legacy: true,
            }
        );
    }

    #[test]
    fn unknown_bundle_identifier_means_do_nothing_not_kill_everything() {
        assert_eq!(install_scope(None, true), InstallScope::Unknown);
        assert_eq!(install_scope(Some("   "), true), InstallScope::Unknown);
    }

    #[test]
    fn scoped_label_selects_that_label_s_plist_only() {
        let Some(mine) = plist_path_for_label("ai.indigo.hq-dm-test-20260918a") else {
            return; // no home dir in this environment
        };
        let canonical = installed_plist_path().expect("home dir resolved once");
        assert_ne!(mine, canonical);
        assert!(mine
            .to_string_lossy()
            .ends_with("ai.indigo.hq-dm-test-20260918a.plist"));
    }

    #[test]
    fn side_by_side_install_does_not_kill_the_canonical_install() {
        // The test build's own agent plist does not exist, so nothing is
        // repointed and no process is stale — the installed copy survives.
        let tmp = tempfile::tempdir().expect("tempdir");
        let own_plist = tmp.path().join("ai.indigo.hq-dm-test-20260918a.plist");
        let installed_exe = "/Applications/HQ.app/Contents/MacOS/hq-sync-menubar";
        let test_exe = "/Applications/HQ DM Test 20260918a.app/Contents/MacOS/hq-sync-menubar";
        let report = reconcile_with(ReconcileRequest {
            plist_path: &own_plist,
            current_exe: test_exe,
            self_pid: 4242,
            label: "ai.indigo.hq-dm-test-20260918a",
            uid: 501,
            applications_dir: tmp.path(),
            running_bundle: Path::new("/Applications/HQ DM Test 20260918a.app"),
            trash_dir: None,
            processes: &[(99, installed_exe.to_string())],
            run_launchctl: false,
            kill_processes: false,
            retire_legacy: false,
        });
        assert_eq!(report, ReconcileReport::default());
        assert!(report.killed.is_empty());
        assert!(
            !own_plist.exists(),
            "must not create a plist it did not find"
        );
    }

    #[test]
    fn same_identifier_still_reaps_its_own_stale_process() {
        // Single-instance behaviour for the SAME bundle id is unchanged: the
        // canonical agent repoints from the old path and the old process at
        // that path is stale.
        let tmp = tempfile::tempdir().expect("tempdir");
        let plist = tmp.path().join("agent.plist");
        fs::write(&plist, fixture(OLD_EXE, true)).expect("seed plist");
        let report = reconcile_with(ReconcileRequest {
            plist_path: &plist,
            current_exe: CURRENT_BUNDLE_EXECUTABLE,
            self_pid: 4242,
            label: LAUNCH_AGENT_LABEL,
            uid: 501,
            applications_dir: tmp.path(),
            running_bundle: Path::new("/Applications/HQ.app"),
            trash_dir: None,
            processes: &[(77, OLD_EXE.to_string())],
            run_launchctl: false,
            kill_processes: false,
            retire_legacy: false,
        });
        assert_eq!(report.killed, vec![(77, OLD_EXE.to_string())]);
    }
    #[test]

    fn notice_when_repointed_or_killed_or_retired() {
        assert!(!ReconcileReport::default().should_surface_notice());
        assert!(ReconcileReport {
            repointed: Some((OLD_EXE.into(), NEW_EXE.into())),
            ..ReconcileReport::default()
        }
        .should_surface_notice());
        assert!(ReconcileReport {
            killed: vec![(12, OLD_EXE.into())],
            ..ReconcileReport::default()
        }
        .should_surface_notice());
        assert!(ReconcileReport {
            retired_legacy: Some("/Trash/HQ Sync.app".into()),
            ..ReconcileReport::default()
        }
        .should_surface_notice());
    }

    /// Copy a plist (the owner's real agent if present, otherwise a KeepAlive
    /// fixture) to a temp label, point it at the old path, and run
    /// reconciliation. Never writes the real LaunchAgent.
    #[test]
    fn reconcile_copied_plist_to_temp_label_does_not_touch_real_agent() {
        let tmp = TempDir::new().unwrap();
        let apps = tmp.path().join("Applications");
        let trash = tmp.path().join("Trash");
        fs::create_dir(&apps).unwrap();
        fs::create_dir(&trash).unwrap();
        fs::create_dir(apps.join(PRODUCT_BUNDLE_NAME)).unwrap();
        let leftover = apps.join(LEGACY_BUNDLE_NAME);
        fs::create_dir(&leftover).unwrap();

        let plist_path = tmp
            .path()
            .join("ai.indigo.hq-sync-menubar.test-repoint.plist");

        let source = installed_plist_path()
            .and_then(|real| fs::read_to_string(real).ok())
            .unwrap_or_else(|| fixture(OLD_EXE, true));
        let stale = rewrite_plist_program_path(
            &if registered_program_path(&source).is_some() {
                source
            } else {
                fixture(OLD_EXE, true)
            },
            OLD_EXE,
        )
        .unwrap_or_else(|_| fixture(OLD_EXE, true));
        fs::write(&plist_path, stale).unwrap();

        let real_before = installed_plist_path().and_then(|p| fs::read_to_string(p).ok());

        let processes = vec![
            (7, NEW_EXE.to_string()),
            (88, OLD_EXE.to_string()),
            (7, NEW_EXE.to_string()),
        ];
        let report = reconcile_with(ReconcileRequest {
            plist_path: &plist_path,
            current_exe: NEW_EXE,
            self_pid: 7,
            label: "ai.indigo.hq-sync-menubar.test-repoint",
            uid: 501,
            applications_dir: &apps,
            running_bundle: &apps.join(PRODUCT_BUNDLE_NAME),
            trash_dir: Some(&trash),
            processes: &processes,
            run_launchctl: false,
            kill_processes: false,
            retire_legacy: true,
        });

        assert_eq!(
            report
                .repointed
                .as_ref()
                .map(|(old, new)| (old.as_str(), new.as_str())),
            Some((OLD_EXE, NEW_EXE))
        );
        assert_eq!(report.killed, vec![(88, OLD_EXE.to_string())]);
        assert!(report.retired_legacy.is_some());
        assert!(report.should_surface_notice());
        assert!(!leftover.exists());
        let rewritten = fs::read_to_string(&plist_path).unwrap();
        assert!(rewritten.contains(NEW_EXE));

        let real_after = installed_plist_path().and_then(|p| fs::read_to_string(p).ok());
        assert_eq!(
            real_before, real_after,
            "owner LaunchAgent must not change during the temp-label test"
        );
    }
}
