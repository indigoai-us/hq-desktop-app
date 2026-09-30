use hq_desktop_core::hq_cli_update::{
    install_with_previous_cli_recovery, should_record_forward_cli_install_effects,
    HqCliInstallMode, HqCliUpdateInfo,
};
use std::fs;
use std::path::Path;
use std::process::Command;

fn write_fake_hq(path: &Path, version: &str) {
    let staged = path.with_extension("new");
    fs::write(&staged, format!("#!/bin/sh\nprintf '%s\\n' '{version}'\n")).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&staged, fs::Permissions::from_mode(0o755)).unwrap();
    }
    fs::rename(staged, path).unwrap();
}

fn probe_fake_hq(path: &Path) -> Option<String> {
    let output = Command::new(path).output().expect("spawn fake hq");
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn info(local: Option<&str>, latest: &str) -> HqCliUpdateInfo {
    HqCliUpdateInfo {
        local: local.map(str::to_string),
        latest: latest.to_string(),
    }
}

#[cfg(unix)]
#[tokio::test]
async fn failed_install_reinstalls_and_probes_the_previous_cli() {
    let temp = tempfile::tempdir().unwrap();
    let hq = temp.path().join("hq");
    write_fake_hq(&hq, "1.0.0");
    let install_hq = hq.clone();
    let rollback_hq = hq.clone();
    let result = install_with_previous_cli_recovery(
        Some("1.0.0".to_string()),
        move || async move {
            write_fake_hq(&install_hq, "partial-install");
            Err("installer failed mid-install".to_string())
        },
        move |version| async move {
            assert_eq!(version, "1.0.0");
            write_fake_hq(&rollback_hq, "1.0.0");
            Ok(probe_fake_hq(&rollback_hq))
        },
    )
    .await;

    assert_eq!(result.unwrap_err(), "installer failed mid-install");
    assert_eq!(probe_fake_hq(&hq).as_deref(), Some("1.0.0"));
}

#[cfg(unix)]
#[tokio::test]
async fn rollback_probe_must_confirm_the_original_version() {
    let result = install_with_previous_cli_recovery(
        Some("1.0.0".to_string()),
        || async { Err("installer failed".to_string()) },
        |_| async { Ok(Some("0.9.0".to_string())) },
    )
    .await;

    let error = result.unwrap_err();
    assert!(error.contains("rollback probe did not confirm the previous HQ CLI version 1.0.0"));
    assert!(error.contains("got Some(\"0.9.0\")"));
}

#[tokio::test]
async fn rollback_failure_is_reported_with_the_install_failure() {
    let result = install_with_previous_cli_recovery(
        Some("1.0.0".to_string()),
        || async { Err("installer failed".to_string()) },
        |_| async { Err("package manager unavailable".to_string()) },
    )
    .await;

    assert_eq!(
        result.unwrap_err(),
        "installer failed; restoring the previous HQ CLI failed: package manager unavailable"
    );
}

#[tokio::test]
async fn successful_install_with_unreadable_local_version_triggers_rollback() {
    let temp = tempfile::tempdir().unwrap();
    let hq = temp.path().join("hq");
    write_fake_hq(&hq, "1.0.0");
    let rollback_hq = hq.clone();
    let result = install_with_previous_cli_recovery(
        Some("1.0.0".to_string()),
        || async { Ok(info(None, "2.0.0")) },
        move |version| async move {
            assert_eq!(version, "1.0.0");
            write_fake_hq(&rollback_hq, "1.0.0");
            Ok(probe_fake_hq(&rollback_hq))
        },
    )
    .await
    .unwrap();

    assert_eq!(result.local.as_deref(), Some("1.0.0"));
    assert_eq!(probe_fake_hq(&hq).as_deref(), Some("1.0.0"));
}

#[test]
fn rollback_mode_does_not_write_a_nonconvergent_marker() {
    let temp = tempfile::tempdir().unwrap();
    let marker = temp.path().join("nonconvergent-marker");
    if should_record_forward_cli_install_effects(HqCliInstallMode::Rollback) {
        fs::write(&marker, "old-version").unwrap();
    }
    assert!(!marker.exists());
}

#[cfg(unix)]
#[tokio::test]
async fn successful_deferral_keeps_the_current_cli_without_rollback() {
    let temp = tempfile::tempdir().unwrap();
    let hq = temp.path().join("hq");
    write_fake_hq(&hq, "1.0.0");
    let before = fs::read(&hq).unwrap();
    let result = install_with_previous_cli_recovery(
        Some("1.0.0".to_string()),
        || async { Ok(info(Some("1.0.0"), "2.0.0")) },
        |_| async { panic!("deferral must not invoke rollback") },
    )
    .await
    .unwrap();

    assert_eq!(result.local.as_deref(), Some("1.0.0"));
    assert_eq!(fs::read(&hq).unwrap(), before);
    assert_eq!(probe_fake_hq(&hq).as_deref(), Some("1.0.0"));
}

#[cfg(unix)]
#[tokio::test]
async fn successful_update_keeps_the_new_cli_without_rollback() {
    let temp = tempfile::tempdir().unwrap();
    let hq = temp.path().join("hq");
    write_fake_hq(&hq, "1.0.0");
    let install_hq = hq.clone();
    let result = install_with_previous_cli_recovery(
        Some("1.0.0".to_string()),
        move || async move {
            write_fake_hq(&install_hq, "2.0.0");
            Ok(info(Some("2.0.0"), "2.0.0"))
        },
        |_| async { panic!("converged install must not invoke rollback") },
    )
    .await
    .unwrap();

    assert_eq!(result.local.as_deref(), Some("2.0.0"));
    assert_eq!(probe_fake_hq(&hq).as_deref(), Some("2.0.0"));
}

#[cfg(unix)]
#[tokio::test]
async fn unavailable_initial_probe_does_not_block_the_update() {
    let temp = tempfile::tempdir().unwrap();
    let hq = temp.path().join("hq");
    let install_hq = hq.clone();
    let result = install_with_previous_cli_recovery(
        None,
        move || async move {
            write_fake_hq(&install_hq, "2.0.0");
            Ok(info(Some("2.0.0"), "2.0.0"))
        },
        |_| async { panic!("without a verified original version rollback is unavailable") },
    )
    .await
    .unwrap();

    assert_eq!(result.local.as_deref(), Some("2.0.0"));
    assert_eq!(probe_fake_hq(&hq).as_deref(), Some("2.0.0"));
}

#[test]
fn updater_uses_version_only_recovery_and_best_effort_initial_probe() {
    let app_cli = include_str!("../../../apps/sync/src-tauri/src/commands/hq_cli_update.rs");
    let updater = app_cli
        .split("async fn install_hq_cli_update_once")
        .nth(1)
        .unwrap()
        .split("async fn install_hq_cli_update_locked")
        .next()
        .unwrap();

    assert!(updater.contains("install_with_previous_cli_recovery"));
    assert!(updater.contains("probe_working_cli_version"));
    assert!(updater.contains("Some(version.clone())"));
    assert!(updater.contains("HqCliInstallMode::Rollback"));
    assert!(updater.contains("original_executor"));
    assert!(updater.contains("update will proceed without rollback"));
    assert!(!updater.contains("capture_working_cli_snapshot"));

    let locked = app_cli
        .split("async fn install_hq_cli_update_locked")
        .nth(1)
        .unwrap();
    assert!(locked.contains("let version = requested_version"));
    assert!(locked.contains(".as_deref()"));
    let rollback_guard = locked
        .find("if !should_record_forward_cli_install_effects(mode)")
        .unwrap();
    let first_forward_marker = locked.find("let non_convergent_version").unwrap();
    assert!(rollback_guard < first_forward_marker);
    assert!(locked.contains("should_record_forward_cli_install_effects(mode)"));
    assert!(locked.contains("install_argv(prefix.as_deref(), Some(latest.as_str()))"));
    assert!(locked.contains("install_hq_cli_update_via_pnpm(&app, &hq, &latest"));
    assert!(locked.contains("install_hq_cli_update_via_bun(&app, &hq, &latest"));
    assert!(app_cli.contains("pnpm_install_argv("));
    assert!(app_cli.contains("bun_install_argv(Some(latest)"));
}
