//! Windows update handoff.
//!
//! The Tauri updater launches NSIS and immediately calls `process::exit`, which
//! bypasses HQ's normal exit teardown. This module keeps the verified download
//! but hands installation to a copied, signed HQ executable. The helper waits
//! for the parent to exit cleanly before NSIS can touch the installed files.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::Update;
use ulid::Ulid;
use windows::Win32::Foundation::{
    CloseHandle, ERROR_INVALID_PARAMETER, HANDLE, WAIT_OBJECT_0, WIN32_ERROR,
};
use windows::Win32::System::Threading::{
    OpenProcess, WaitForSingleObject, CREATE_NO_WINDOW, PROCESS_SYNCHRONIZE,
};
use winreg::enums::{HKEY_CURRENT_USER, KEY_READ};
use winreg::RegKey;

use crate::util::logfile::log;

const HELPER_FLAG: &str = "--hq-update-helper";
const PARENT_PID_ARG: &str = "--parent-pid";
const INSTALLER_ARG: &str = "--installer";
const EXPECTED_SHA_ARG: &str = "--expected-sha256";
const READY_FILE_ARG: &str = "--ready-file";
const RECEIPT_FILE_ARG: &str = "--receipt-file";
const ORIGINAL_EXE_ARG: &str = "--original-exe";
const INSTALL_DIR_ARG: &str = "--install-dir";
const INSTALL_BACKUP_ARG: &str = "--install-backup";
const INSTALL_MANIFEST_ARG: &str = "--install-manifest";
const EXPECTED_MANIFEST_SHA_ARG: &str = "--expected-manifest-sha256";
const UNINSTALL_REGISTRY_BACKUP_ARG: &str = "--uninstall-registry-backup";
const EXPECTED_REGISTRY_SHA_ARG: &str = "--expected-registry-sha256";
const PRIOR_NSIS_REGISTRY_ARG: &str = "--prior-nsis-registry";
const UNINSTALL_REGISTRY_PATH: &str =
    r"HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\HQ";
const UNINSTALL_REGISTRY_SUBKEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall\HQ";
const ABSENT_REGISTRY_MARKER: &[u8] = b"HQ NSIS uninstall registry key was absent\n";
const HELPER_READY_TIMEOUT: Duration = Duration::from_secs(60);
const PARENT_EXIT_TIMEOUT_MS: u32 = 120_000;
const PROCESS_EXIT_TIMEOUT: Duration = Duration::from_secs(10);
const STALE_STAGING_MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);
const ROLLBACK_READY_PREFIX: &str = ".hq-rollback-ready-";
const FAILED_INSTALL_PREFIX: &str = ".hq-failed-install-";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateReceipt<'a> {
    state: &'a str,
    version: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<&'a str>,
}

#[derive(Deserialize)]
struct StoredUpdateReceipt {
    state: String,
}

struct StagedUpdate {
    root: PathBuf,
    helper: PathBuf,
    installer: PathBuf,
    ready: PathBuf,
    receipt: PathBuf,
    original_exe: PathBuf,
    install_dir: PathBuf,
    install_backup: PathBuf,
    install_manifest: PathBuf,
    manifest_sha256: String,
    uninstall_registry_backup: PathBuf,
    registry_sha256: String,
    prior_nsis_registry_existed: bool,
    sha256: String,
    version: String,
}

#[derive(Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupManifestEntry {
    relative: PathBuf,
    sha256: String,
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn file_sha256_hex(path: &Path) -> Result<String, String> {
    let mut file = File::open(path)
        .map_err(|error| format!("open file for checksum {}: {error}", path.display()))?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("read file for checksum {}: {error}", path.display()))?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn write_new_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| format!("create {}: {error}", path.display()))?;
    file.write_all(bytes)
        .map_err(|error| format!("write {}: {error}", path.display()))?;
    file.sync_all()
        .map_err(|error| format!("sync {}: {error}", path.display()))
}

fn copy_install_tree(source: &Path, target: &Path) -> Result<(), String> {
    if target.exists() {
        return Err(format!(
            "installation backup target already exists: {}",
            target.display()
        ));
    }
    fs::create_dir_all(target)
        .map_err(|error| format!("create installation backup {}: {error}", target.display()))?;
    for entry in fs::read_dir(source)
        .map_err(|error| format!("read installation directory {}: {error}", source.display()))?
    {
        let entry = entry.map_err(|error| format!("read installation entry: {error}"))?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("read installation entry type: {error}"))?;
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        if file_type.is_dir() {
            copy_install_tree(&source_path, &target_path)?;
        } else if file_type.is_file() {
            fs::copy(&source_path, &target_path).map_err(|error| {
                format!(
                    "copy prior installation file {}: {error}",
                    source_path.display()
                )
            })?;
        } else {
            return Err(format!(
                "prior installation contains an unsupported link or special file: {}",
                source_path.display()
            ));
        }
    }
    Ok(())
}

fn collect_install_manifest(
    root: &Path,
    current: &Path,
    entries: &mut Vec<BackupManifestEntry>,
) -> Result<(), String> {
    for entry in fs::read_dir(current)
        .map_err(|error| format!("read installation backup {}: {error}", current.display()))?
    {
        let entry = entry.map_err(|error| format!("read installation backup entry: {error}"))?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("read installation backup entry type: {error}"))?;
        let path = entry.path();
        if file_type.is_dir() {
            collect_install_manifest(root, &path, entries)?;
        } else if file_type.is_file() {
            entries.push(BackupManifestEntry {
                relative: path
                    .strip_prefix(root)
                    .map_err(|error| format!("relativize installation backup path: {error}"))?
                    .to_path_buf(),
                sha256: file_sha256_hex(&path)?,
            });
        } else {
            return Err(format!(
                "installation backup contains an unsupported link or special file: {}",
                path.display()
            ));
        }
    }
    entries.sort_by(|left, right| left.relative.cmp(&right.relative));
    Ok(())
}

fn install_manifest(root: &Path) -> Result<Vec<BackupManifestEntry>, String> {
    let mut entries = Vec::new();
    collect_install_manifest(root, root, &mut entries)?;
    if entries.is_empty() {
        return Err("prior installation backup is empty".to_string());
    }
    Ok(entries)
}

fn write_install_manifest(backup: &Path, path: &Path) -> Result<String, String> {
    let manifest = install_manifest(backup)?;
    let bytes = serde_json::to_vec(&manifest)
        .map_err(|error| format!("serialize installation backup manifest: {error}"))?;
    write_new_file(path, &bytes)?;
    Ok(sha256_hex(&bytes))
}

fn read_verified_install_manifest(
    path: &Path,
    expected_sha256: &str,
) -> Result<Vec<BackupManifestEntry>, String> {
    let bytes =
        fs::read(path).map_err(|error| format!("read installation backup manifest: {error}"))?;
    if expected_sha256.len() != 64 || !sha256_hex(&bytes).eq_ignore_ascii_case(expected_sha256) {
        return Err("installation backup manifest checksum changed before rollback".to_string());
    }
    let mut manifest: Vec<BackupManifestEntry> = serde_json::from_slice(&bytes)
        .map_err(|error| format!("parse installation backup manifest: {error}"))?;
    manifest.sort_by(|left, right| left.relative.cmp(&right.relative));
    Ok(manifest)
}

fn verify_install_tree(
    root: &Path,
    expected: &[BackupManifestEntry],
    label: &str,
) -> Result<(), String> {
    let actual = install_manifest(root)?;
    if actual != expected {
        return Err(format!(
            "{label} does not match the complete prior installation manifest"
        ));
    }
    Ok(())
}

fn registry_command() -> Command {
    let mut command = Command::new("reg.exe");
    command.creation_flags(CREATE_NO_WINDOW.0);
    command
}

fn registry_key_exists() -> Result<bool, String> {
    match RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags(UNINSTALL_REGISTRY_SUBKEY, KEY_READ)
    {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!(
            "open prior uninstall registry metadata for query: {error}"
        )),
    }
}

fn export_uninstall_registry(path: &Path) -> Result<(), String> {
    if !registry_key_exists()? {
        return Err("prior uninstall registry metadata is missing".to_string());
    }
    let status = registry_command()
        .arg("export")
        .arg(UNINSTALL_REGISTRY_PATH)
        .arg(path)
        .arg("/y")
        .status()
        .map_err(|error| format!("export prior uninstall registry metadata: {error}"))?;
    if status.success() && path.is_file() {
        Ok(())
    } else {
        Err(format!(
            "export prior uninstall registry metadata exited with {status}"
        ))
    }
}

fn snapshot_uninstall_registry(path: &Path) -> Result<bool, String> {
    if registry_key_exists()? {
        export_uninstall_registry(path)?;
        Ok(true)
    } else {
        write_new_file(path, ABSENT_REGISTRY_MARKER)?;
        Ok(false)
    }
}

fn delete_uninstall_registry() -> Result<(), String> {
    if !registry_key_exists()? {
        return Ok(());
    }
    let status = registry_command()
        .args(["delete", UNINSTALL_REGISTRY_PATH, "/f"])
        .status()
        .map_err(|error| format!("delete uninstall registry metadata: {error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "delete uninstall registry metadata exited with {status}"
        ))
    }
}

fn import_uninstall_registry(path: &Path) -> Result<(), String> {
    let status = registry_command()
        .arg("import")
        .arg(path)
        .status()
        .map_err(|error| format!("import uninstall registry metadata: {error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "import uninstall registry metadata exited with {status}"
        ))
    }
}

fn write_receipt(path: &Path, state: &str, version: &str, detail: Option<&str>) {
    let receipt = UpdateReceipt {
        state,
        version,
        detail,
    };
    let result = serde_json::to_vec(&receipt)
        .map_err(|error| error.to_string())
        .and_then(|bytes| fs::write(path, bytes).map_err(|error| error.to_string()));
    if let Err(error) = result {
        log(
            "updater",
            &format!("could not write update receipt: {error}"),
        );
    }
}

fn stage_update(bytes: &[u8], version: &str) -> Result<StagedUpdate, String> {
    if !bytes.starts_with(b"MZ") {
        return Err("verified Windows update is not a PE executable".to_string());
    }
    let root =
        std::env::temp_dir()
            .join("hq-desktop-update")
            .join(format!("{}-{}", version, Ulid::new()));
    fs::create_dir_all(&root)
        .map_err(|error| format!("create update staging directory: {error}"))?;

    let result: Result<StagedUpdate, String> = (|| {
        let installer = root.join("hq-update-installer.exe");
        write_new_file(&installer, bytes)?;
        let sha256 = sha256_hex(bytes);

        let original_exe = std::env::current_exe()
            .map_err(|error| format!("resolve current HQ executable: {error}"))?;
        let install_dir = original_exe
            .parent()
            .ok_or_else(|| "current HQ executable has no installation directory".to_string())?
            .to_path_buf();
        let helper = root.join("hq-update-helper.exe");
        fs::copy(&original_exe, &helper)
            .map_err(|error| format!("copy signed update helper: {error}"))?;
        let install_backup = root.join("prior-install");
        copy_install_tree(&install_dir, &install_backup)?;
        let install_manifest = root.join("prior-install-manifest.json");
        let manifest_sha256 = write_install_manifest(&install_backup, &install_manifest)?;
        let uninstall_registry_backup = root.join("prior-uninstall.reg");
        let prior_nsis_registry_existed = snapshot_uninstall_registry(&uninstall_registry_backup)?;
        let registry_sha256 = file_sha256_hex(&uninstall_registry_backup)?;

        let staged = StagedUpdate {
            root: root.clone(),
            helper,
            installer,
            ready: root.join("helper.ready"),
            receipt: root.join("receipt.json"),
            original_exe,
            install_dir,
            install_backup,
            install_manifest,
            manifest_sha256,
            uninstall_registry_backup,
            registry_sha256,
            prior_nsis_registry_existed,
            sha256,
            version: version.to_string(),
        };
        write_receipt(&staged.receipt, "staged", version, None);
        Ok(staged)
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&root);
    }
    result
}

fn cleanup_staged_update(staged: &StagedUpdate) {
    if let Err(error) = fs::remove_dir_all(&staged.root) {
        if error.kind() != std::io::ErrorKind::NotFound {
            log(
                "updater",
                &format!("could not remove update staging directory: {error}"),
            );
        }
    }
}

fn stop_helper_and_cleanup(helper: &mut Child, staged: &StagedUpdate) {
    let _ = helper.kill();
    let _ = helper.wait();
    cleanup_staged_update(staged);
}

fn is_terminal_receipt_state(state: &str) -> bool {
    matches!(state, "installed" | "rolled-back" | "failed")
}

fn should_cleanup_staging_dir(state: Option<&str>, age: Duration) -> bool {
    state.is_some_and(is_terminal_receipt_state) || age >= STALE_STAGING_MAX_AGE
}

fn staging_dir_age(path: &Path) -> Duration {
    let receipt = path.join("receipt.json");
    let modified = fs::metadata(&receipt)
        .or_else(|_| fs::metadata(path))
        .and_then(|metadata| metadata.modified());
    modified
        .ok()
        .and_then(|modified| SystemTime::now().duration_since(modified).ok())
        .unwrap_or_default()
}

fn receipt_state(path: &Path) -> Option<String> {
    let bytes = fs::read(path.join("receipt.json")).ok()?;
    serde_json::from_slice::<StoredUpdateReceipt>(&bytes)
        .ok()
        .map(|receipt| receipt.state)
}

fn cleanup_update_staging_dirs() {
    let root = std::env::temp_dir().join("hq-desktop-update");
    let Ok(entries) = fs::read_dir(&root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let state = receipt_state(&path);
        if should_cleanup_staging_dir(state.as_deref(), staging_dir_age(&path)) {
            if let Err(error) = fs::remove_dir_all(&path) {
                log(
                    "updater",
                    &format!(
                        "could not clean completed or abandoned update staging directory {}: {error}",
                        path.display()
                    ),
                );
            }
        }
    }
    let _ = fs::remove_dir(&root);
}

fn is_rollback_swap_dir_name(name: &str) -> bool {
    name.starts_with(ROLLBACK_READY_PREFIX) || name.starts_with(FAILED_INSTALL_PREFIX)
}

fn cleanup_rollback_swap_dirs() {
    let Ok(current_exe) = std::env::current_exe() else {
        return;
    };
    let Some(install_parent) = current_exe
        .parent()
        .and_then(|install_dir| install_dir.parent())
    else {
        return;
    };
    let Ok(entries) = fs::read_dir(install_parent) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() || !is_rollback_swap_dir_name(&entry.file_name().to_string_lossy()) {
            continue;
        }
        if let Err(error) = fs::remove_dir_all(&path) {
            log(
                "updater",
                &format!(
                    "could not clean rollback swap directory {}: {error}",
                    path.display()
                ),
            );
        }
    }
}

fn spawn_helper(staged: &StagedUpdate) -> Result<std::process::Child, String> {
    Command::new(&staged.helper)
        .arg(HELPER_FLAG)
        .arg(PARENT_PID_ARG)
        .arg(std::process::id().to_string())
        .arg(INSTALLER_ARG)
        .arg(&staged.installer)
        .arg(EXPECTED_SHA_ARG)
        .arg(&staged.sha256)
        .arg(READY_FILE_ARG)
        .arg(&staged.ready)
        .arg(RECEIPT_FILE_ARG)
        .arg(&staged.receipt)
        .arg(ORIGINAL_EXE_ARG)
        .arg(&staged.original_exe)
        .arg(INSTALL_DIR_ARG)
        .arg(&staged.install_dir)
        .arg(INSTALL_BACKUP_ARG)
        .arg(&staged.install_backup)
        .arg(INSTALL_MANIFEST_ARG)
        .arg(&staged.install_manifest)
        .arg(EXPECTED_MANIFEST_SHA_ARG)
        .arg(&staged.manifest_sha256)
        .arg(UNINSTALL_REGISTRY_BACKUP_ARG)
        .arg(&staged.uninstall_registry_backup)
        .arg(EXPECTED_REGISTRY_SHA_ARG)
        .arg(&staged.registry_sha256)
        .arg(PRIOR_NSIS_REGISTRY_ARG)
        .arg(if staged.prior_nsis_registry_existed {
            "present"
        } else {
            "absent"
        })
        .arg("--target-version")
        .arg(&staged.version)
        .spawn()
        .map_err(|error| format!("launch update helper: {error}"))
}

/// Download through Tauri (including minisign verification), then prepare the
/// helper, stop HQ-owned processes, and exit through Tauri's normal lifecycle.
pub async fn install_verified_update(app: &AppHandle, update: &Update) -> Result<(), String> {
    let bytes = update
        .download(|_, _| {}, || {})
        .await
        .map_err(|error| error.to_string())?;
    if crate::updater::sync_in_progress() {
        return Err(crate::updater::UPDATE_DEFERRED_DURING_SYNC.to_string());
    }

    let staged = stage_update(&bytes, &update.version)?;
    let mut helper = match spawn_helper(&staged) {
        Ok(helper) => helper,
        Err(error) => {
            cleanup_staged_update(&staged);
            return Err(error);
        }
    };
    let started = tokio::time::Instant::now();
    while !staged.ready.is_file() {
        if started.elapsed() >= HELPER_READY_TIMEOUT {
            stop_helper_and_cleanup(&mut helper, &staged);
            return Err("Windows update helper did not become ready".to_string());
        }
        match helper.try_wait() {
            Ok(Some(status)) => {
                cleanup_staged_update(&staged);
                return Err(format!("Windows update helper exited early: {status}"));
            }
            Ok(None) => {}
            Err(error) => {
                stop_helper_and_cleanup(&mut helper, &staged);
                return Err(format!("poll update helper: {error}"));
            }
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    // Recheck after the download and helper startup. A manual sync gets to
    // finish; the updater will retry instead of interrupting it.
    if crate::updater::sync_in_progress() {
        stop_helper_and_cleanup(&mut helper, &staged);
        return Err(crate::updater::UPDATE_DEFERRED_DURING_SYNC.to_string());
    }
    let quiescence = match crate::commands::process::quiesce_for_update(PROCESS_EXIT_TIMEOUT) {
        Ok(quiescence) => quiescence,
        Err(error) => {
            stop_helper_and_cleanup(&mut helper, &staged);
            return Err(error);
        }
    };
    write_receipt(&staged.receipt, "parent-exiting", &staged.version, None);
    log(
        "updater",
        &format!(
            "Windows update {} staged; exiting for installer handoff",
            staged.version
        ),
    );
    quiescence.commit();
    app.exit(0);
    Ok(())
}

fn arg_value(args: &[String], name: &str) -> Result<String, String> {
    let index = args
        .iter()
        .position(|arg| arg == name)
        .ok_or_else(|| format!("missing {name}"))?;
    args.get(index + 1)
        .cloned()
        .ok_or_else(|| format!("missing value for {name}"))
}

fn require_helper_sibling(helper_dir: &Path, path: &Path, label: &str) -> Result<(), String> {
    if path.parent() == Some(helper_dir) {
        Ok(())
    } else {
        Err(format!("{label} must be staged beside the update helper"))
    }
}

fn parent_open_error_means_exited(error: &windows::core::Error) -> bool {
    WIN32_ERROR::from_error(error) == Some(ERROR_INVALID_PARAMETER)
}

fn open_parent(parent_pid: u32) -> Result<Option<HANDLE>, String> {
    unsafe {
        match OpenProcess(PROCESS_SYNCHRONIZE, false, parent_pid) {
            Ok(parent) => Ok(Some(parent)),
            Err(error) if parent_open_error_means_exited(&error) => Ok(None),
            Err(error) => Err(format!(
                "open HQ parent process {parent_pid} for synchronization: {error}"
            )),
        }
    }
}

fn wait_for_parent(parent: Option<HANDLE>) -> Result<(), String> {
    let Some(parent) = parent else {
        return Ok(());
    };
    unsafe {
        let result = WaitForSingleObject(parent, PARENT_EXIT_TIMEOUT_MS);
        let _ = CloseHandle(parent);
        if result == WAIT_OBJECT_0 {
            Ok(())
        } else {
            Err("timed out waiting for the HQ parent process to exit".to_string())
        }
    }
}

fn restore_install_tree(
    install_backup: &Path,
    install_manifest: &Path,
    expected_manifest_sha256: &str,
    install_dir: &Path,
) -> Result<(), String> {
    let expected = read_verified_install_manifest(install_manifest, expected_manifest_sha256)?;
    verify_install_tree(install_backup, &expected, "staged installation backup")?;

    let install_parent = install_dir
        .parent()
        .ok_or_else(|| "HQ installation directory has no parent".to_string())?;
    let recovery_id = Ulid::new();
    let recovered = install_parent.join(format!(".hq-rollback-ready-{recovery_id}"));
    let displaced = install_parent.join(format!(".hq-failed-install-{recovery_id}"));
    copy_install_tree(install_backup, &recovered)?;
    verify_install_tree(&recovered, &expected, "prepared rollback installation")?;

    let had_install = install_dir.exists();
    if had_install {
        fs::rename(install_dir, &displaced)
            .map_err(|error| format!("preserve failed HQ installation before rollback: {error}"))?;
    }
    if let Err(error) = fs::rename(&recovered, install_dir) {
        if had_install {
            let _ = fs::rename(&displaced, install_dir);
        }
        let _ = fs::remove_dir_all(&recovered);
        return Err(format!("activate restored HQ installation: {error}"));
    }
    if let Err(error) = verify_install_tree(install_dir, &expected, "restored installation") {
        let _ = fs::remove_dir_all(install_dir);
        if had_install {
            let _ = fs::rename(&displaced, install_dir);
        }
        return Err(error);
    }
    if had_install {
        if let Err(error) = fs::remove_dir_all(&displaced) {
            log(
                "updater",
                &format!("could not clean failed HQ installation after rollback: {error}"),
            );
        }
    }
    Ok(())
}

fn restore_uninstall_registry(
    prior_backup: &Path,
    expected_sha256: &str,
    prior_existed: bool,
) -> Result<(), String> {
    if expected_sha256.len() != 64
        || !file_sha256_hex(prior_backup)?.eq_ignore_ascii_case(expected_sha256)
    {
        return Err("uninstall registry backup checksum changed before rollback".to_string());
    }

    let candidate_backup = prior_backup.with_file_name("failed-install-uninstall.reg");
    let restored_probe = prior_backup.with_file_name("restored-uninstall.reg");
    let candidate_existed = registry_key_exists()?;
    if candidate_existed {
        export_uninstall_registry(&candidate_backup)?;
    }

    let restore_result = (|| {
        delete_uninstall_registry()?;
        if prior_existed {
            import_uninstall_registry(prior_backup)?;
            export_uninstall_registry(&restored_probe)?;
            if !file_sha256_hex(&restored_probe)?.eq_ignore_ascii_case(expected_sha256) {
                return Err(
                    "restored uninstall registry metadata does not match its backup".to_string(),
                );
            }
        } else if registry_key_exists()? {
            return Err("rollback did not remove candidate NSIS uninstall metadata".to_string());
        }
        Ok(())
    })();

    let _ = fs::remove_file(&restored_probe);
    if let Err(error) = restore_result {
        let _ = delete_uninstall_registry();
        if candidate_existed {
            let _ = import_uninstall_registry(&candidate_backup);
        }
        let _ = fs::remove_file(&candidate_backup);
        return Err(error);
    }
    let _ = fs::remove_file(&candidate_backup);
    Ok(())
}

/// `/UPDATE` leaves shortcuts and app-data registrations in place, but it can
/// replace any installed file and its Add/Remove Programs metadata before a
/// later step fails. Restore the byte-verified complete installation snapshot
/// plus the prior NSIS registry state before relaunching the prior app. MSI
/// registration lives elsewhere and remains untouched throughout this path.
fn restore_prior_installation(
    install_backup: &Path,
    install_manifest: &Path,
    expected_manifest_sha256: &str,
    install_dir: &Path,
    uninstall_registry_backup: &Path,
    expected_registry_sha256: &str,
    prior_nsis_registry_existed: bool,
    original_exe: &Path,
) -> Result<(), String> {
    restore_install_tree(
        install_backup,
        install_manifest,
        expected_manifest_sha256,
        install_dir,
    )?;
    let registry_result = restore_uninstall_registry(
        uninstall_registry_backup,
        expected_registry_sha256,
        prior_nsis_registry_existed,
    );
    let relaunch_result = Command::new(original_exe)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("relaunch restored HQ executable: {error}"));
    match (registry_result, relaunch_result) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(registry_error), Ok(())) => Err(registry_error),
        (Ok(()), Err(relaunch_error)) => Err(relaunch_error),
        (Err(registry_error), Err(relaunch_error)) => {
            Err(format!("{registry_error}; {relaunch_error}"))
        }
    }
}

fn run_helper(args: &[String]) -> Result<(), String> {
    let parent_pid = arg_value(args, PARENT_PID_ARG)?
        .parse::<u32>()
        .map_err(|_| "invalid parent pid".to_string())?;
    let installer = PathBuf::from(arg_value(args, INSTALLER_ARG)?);
    let expected_sha = arg_value(args, EXPECTED_SHA_ARG)?;
    let ready = PathBuf::from(arg_value(args, READY_FILE_ARG)?);
    let receipt = PathBuf::from(arg_value(args, RECEIPT_FILE_ARG)?);
    let original_exe = PathBuf::from(arg_value(args, ORIGINAL_EXE_ARG)?);
    let install_dir = PathBuf::from(arg_value(args, INSTALL_DIR_ARG)?);
    let install_backup = PathBuf::from(arg_value(args, INSTALL_BACKUP_ARG)?);
    let install_manifest = PathBuf::from(arg_value(args, INSTALL_MANIFEST_ARG)?);
    let expected_manifest_sha = arg_value(args, EXPECTED_MANIFEST_SHA_ARG)?;
    let uninstall_registry_backup = PathBuf::from(arg_value(args, UNINSTALL_REGISTRY_BACKUP_ARG)?);
    let expected_registry_sha = arg_value(args, EXPECTED_REGISTRY_SHA_ARG)?;
    let prior_nsis_registry_existed = match arg_value(args, PRIOR_NSIS_REGISTRY_ARG)?.as_str() {
        "present" => true,
        "absent" => false,
        _ => return Err("invalid prior NSIS registry state".to_string()),
    };
    let version = arg_value(args, "--target-version")?;
    let helper = std::env::current_exe().map_err(|error| error.to_string())?;
    let helper_dir = helper
        .parent()
        .ok_or_else(|| "update helper has no parent directory".to_string())?;
    require_helper_sibling(helper_dir, &installer, "installer")?;
    require_helper_sibling(helper_dir, &ready, "ready marker")?;
    require_helper_sibling(helper_dir, &receipt, "receipt")?;
    require_helper_sibling(helper_dir, &install_backup, "installation backup")?;
    require_helper_sibling(
        helper_dir,
        &install_manifest,
        "installation backup manifest",
    )?;
    require_helper_sibling(
        helper_dir,
        &uninstall_registry_backup,
        "uninstall registry backup",
    )?;
    if original_exe.parent() != Some(install_dir.as_path()) {
        return Err("original executable must live in the installation directory".to_string());
    }

    let actual_sha = file_sha256_hex(&installer)?;
    if expected_sha.len() != 64 || !actual_sha.eq_ignore_ascii_case(&expected_sha) {
        return Err("staged installer checksum changed before launch".to_string());
    }
    if !install_backup.is_dir() {
        return Err("complete prior installation backup is missing".to_string());
    }
    read_verified_install_manifest(&install_manifest, &expected_manifest_sha)?;
    if expected_registry_sha.len() != 64
        || !file_sha256_hex(&uninstall_registry_backup)?
            .eq_ignore_ascii_case(&expected_registry_sha)
    {
        return Err("uninstall registry backup checksum changed before launch".to_string());
    }
    let parent = open_parent(parent_pid)?;
    write_new_file(&ready, b"ready")?;
    write_receipt(&receipt, "waiting-for-parent", &version, None);
    wait_for_parent(parent)?;

    write_receipt(&receipt, "installing", &version, None);
    let result = Command::new(&installer)
        .args(["/P", "/R", "/UPDATE"])
        .status()
        .map_err(|error| format!("launch NSIS updater: {error}"));
    match result {
        Ok(status) if status.success() => {
            write_receipt(&receipt, "installed", &version, None);
            Ok(())
        }
        Ok(status) => {
            let detail = format!("NSIS exited with {status}");
            match restore_prior_installation(
                &install_backup,
                &install_manifest,
                &expected_manifest_sha,
                &install_dir,
                &uninstall_registry_backup,
                &expected_registry_sha,
                prior_nsis_registry_existed,
                &original_exe,
            ) {
                Ok(()) => {
                    write_receipt(&receipt, "rolled-back", &version, Some(&detail));
                    Err(detail)
                }
                Err(rollback_error) => {
                    let combined = format!("{detail}; rollback failed: {rollback_error}");
                    write_receipt(&receipt, "failed", &version, Some(&combined));
                    Err(combined)
                }
            }
        }
        Err(error) => {
            match restore_prior_installation(
                &install_backup,
                &install_manifest,
                &expected_manifest_sha,
                &install_dir,
                &uninstall_registry_backup,
                &expected_registry_sha,
                prior_nsis_registry_existed,
                &original_exe,
            ) {
                Ok(()) => {
                    write_receipt(&receipt, "rolled-back", &version, Some(&error));
                    Err(error)
                }
                Err(rollback_error) => {
                    let combined = format!("{error}; rollback failed: {rollback_error}");
                    write_receipt(&receipt, "failed", &version, Some(&combined));
                    Err(combined)
                }
            }
        }
    }
}

/// Dispatch the copied helper before Sentry, single-instance, or Tauri setup.
/// Returns normally only for a standard app launch.
pub fn run_helper_if_requested() {
    let args: Vec<String> = std::env::args().collect();
    if !args.iter().any(|arg| arg == HELPER_FLAG) {
        cleanup_rollback_swap_dirs();
        cleanup_update_staging_dirs();
        return;
    }
    let code = match run_helper(&args) {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("Windows update helper failed: {error}");
            1
        }
    };
    std::process::exit(code);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn helper_rejects_paths_outside_its_staging_directory() {
        let helper_dir = Path::new(r"C:\Temp\hq-update");
        assert!(require_helper_sibling(
            helper_dir,
            Path::new(r"C:\Temp\hq-update\installer.exe"),
            "installer"
        )
        .is_ok());
        assert!(require_helper_sibling(
            helper_dir,
            Path::new(r"C:\Windows\System32\notepad.exe"),
            "installer"
        )
        .is_err());
    }

    #[test]
    fn helper_checksum_contract_is_sha256() {
        assert_eq!(
            sha256_hex(b"hq-update"),
            "504cb0ca325c9fade5fd05e16db3b71ec6329bbe79d8e2ed9af0a3b1dd206547"
        );
    }

    #[test]
    fn complete_install_backup_detects_a_missing_resource() {
        let root = std::env::temp_dir().join(format!("hq-update-manifest-test-{}", Ulid::new()));
        let source = root.join("installed");
        let backup = root.join("backup");
        let manifest_path = root.join("manifest.json");
        fs::create_dir_all(source.join("recall-sdk-bridge")).unwrap();
        fs::write(source.join("hq-sync-menubar.exe"), b"app").unwrap();
        fs::write(source.join("uninstall.exe"), b"uninstaller").unwrap();
        fs::write(
            source.join("recall-sdk-bridge").join("bridge.mjs"),
            b"bridge",
        )
        .unwrap();

        copy_install_tree(&source, &backup).unwrap();
        let manifest_sha = write_install_manifest(&backup, &manifest_path).unwrap();
        let expected = read_verified_install_manifest(&manifest_path, &manifest_sha).unwrap();
        verify_install_tree(&backup, &expected, "backup").unwrap();

        fs::remove_file(backup.join("recall-sdk-bridge").join("bridge.mjs")).unwrap();
        assert!(verify_install_tree(&backup, &expected, "backup").is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn parent_open_only_treats_a_missing_pid_as_exited() {
        let missing_pid = windows::core::Error::from(ERROR_INVALID_PARAMETER);
        let access_denied =
            windows::core::Error::from(windows::Win32::Foundation::ERROR_ACCESS_DENIED);

        assert!(parent_open_error_means_exited(&missing_pid));
        assert!(!parent_open_error_means_exited(&access_denied));
    }

    #[test]
    fn staging_cleanup_removes_terminal_and_abandoned_attempts() {
        assert!(should_cleanup_staging_dir(
            Some("installed"),
            Duration::ZERO
        ));
        assert!(should_cleanup_staging_dir(
            Some("rolled-back"),
            Duration::ZERO
        ));
        assert!(should_cleanup_staging_dir(Some("failed"), Duration::ZERO));
        assert!(!should_cleanup_staging_dir(
            Some("installing"),
            Duration::ZERO
        ));
        assert!(should_cleanup_staging_dir(None, STALE_STAGING_MAX_AGE));
    }

    #[test]
    fn rollback_swap_cleanup_is_limited_to_owned_prefixes() {
        assert!(is_rollback_swap_dir_name(".hq-failed-install-01K5ABC"));
        assert!(is_rollback_swap_dir_name(".hq-rollback-ready-01K5ABC"));
        assert!(!is_rollback_swap_dir_name("HQ"));
        assert!(!is_rollback_swap_dir_name(".hq-failed-install"));
    }
}
