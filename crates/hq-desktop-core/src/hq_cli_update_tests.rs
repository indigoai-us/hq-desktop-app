//! Unit tests for `hq_cli_update.rs`.
//!
//! Included from `hq_cli_update.rs` via `#[path = "hq_cli_update_tests.rs"] mod tests;`, so
//! this file is the parent module's `tests` child and `super::*` sees its
//! private items.

use super::NPM_INSTALL_CHILD_ENV as NPM_CHILD_ENV;

// npm must not fall back to a node-gyp compile, which needs python3, make
// and clang that a Mac without Apple's tools does not have.
#[test]
fn npm_install_child_env_turns_off_source_builds() {
    assert!(NPM_CHILD_ENV.contains(&("npm_config_build_from_source", "false")));
    assert!(NPM_CHILD_ENV.contains(&("NODE_LLAMA_CPP_SKIP_DOWNLOAD", "true")));
}

use super::*;
use std::cmp::Ordering;

fn captured_non_convergent_event(
    hq_bin: &str,
    installer_prefix: Option<&str>,
    aim: ExecutedCopyAim,
    lane: paths::ResolutionSource,
) -> serde_json::Value {
    let managed_roots = paths::managed_toolchain_roots();
    let context = PostInstallContext::npm(
        hq_bin,
        hq_bin,
        Some("4.0.0"),
        Some("4.0.0"),
        "5.0.0",
        installer_prefix,
        "npm",
        false,
        Some("5.0.0"),
    )
    .with_managed_roots(&managed_roots)
    .with_executed_copy_aim(aim)
    .with_resolution_telemetry(lane, DeliveredPrefixShim::Present);
    let report = decide_post_install(&context)
        .capture
        .expect("fixture must produce a non-convergent report");
    let event = sentry::test::with_captured_events(|| report_non_convergent_install(&report))
        .into_iter()
        .next()
        .expect("report must capture an event");
    serde_json::json!({
        "tags": event.tags,
        "contexts": event.contexts,
        "extras": event.extra,
    })
}

fn fixture_prefix() -> (tempfile::TempDir, String, String) {
    let home = paths::home_dir().expect("test home is available");
    let temp = tempfile::Builder::new()
        .prefix("sc-desktop-8a-")
        .tempdir_in(home)
        .expect("create private path fixture");
    let prefix = temp.path().join("npm-global");
    let npm = colocated_npm_path(&prefix);
    std::fs::create_dir_all(npm.parent().unwrap()).unwrap();
    std::fs::write(&npm, "fixture").unwrap();
    let hq = prefix_hq_shim_path(&prefix).to_string_lossy().into_owned();
    (temp, prefix.to_string_lossy().into_owned(), hq)
}

#[test]
fn package_use_lease_timeout_report_has_fixed_tag_and_no_paths() {
    use crate::package_use_lease::{
        HolderAgeBucket, HolderPurposeBucket, HolderVersionBucket, LiveHolderCountBucket,
        PackageUseLeaseTimeoutSummary,
    };

    let summary = PackageUseLeaseTimeoutSummary {
        live_holder_count: LiveHolderCountBucket::TwoToThree,
        same_root_live_holder_count: LiveHolderCountBucket::One,
        other_root_live_holder_count: LiveHolderCountBucket::TwoToThree,
        holder_version: HolderVersionBucket::Pre53424,
        oldest_holder_age: HolderAgeBucket::From1hTo24h,
        oldest_holder_purpose: HolderPurposeBucket::Daemon,
    };
    let events =
        sentry::test::with_captured_events(|| report_package_use_lease_timeout(&summary, 0));
    assert_eq!(events.len(), 1);
    let event = &events[0];
    assert_eq!(event.level, sentry::Level::Error);
    assert_eq!(event.tags["hq_cli_update_kind"], "install-failed");
    assert_eq!(
        event.tags["install_failure_kind"],
        "package_use_lease_timeout"
    );
    assert_eq!(
        event.tags["hq_cli_update_stage"],
        "package_use_lease_timeout"
    );
    assert_eq!(event.tags["lease_retry_attempt"], "0");
    assert_eq!(event.tags["holder_live_count_bucket"], "2-3");
    assert_eq!(event.tags["holder_same_root_live_count_bucket"], "1");
    assert_eq!(event.tags["holder_other_root_live_count_bucket"], "2-3");
    assert_eq!(event.tags["holder_version_bucket"], "pre_5_342_4");
    assert_eq!(event.tags["oldest_holder_age_bucket"], "1h-24h");
    assert_eq!(event.tags["oldest_holder_purpose"], "daemon");
    assert_eq!(event.tags["holder_root_relation"], "legacy");
    let fingerprint: Vec<&str> = event.fingerprint.iter().map(|part| part.as_ref()).collect();
    assert_eq!(
        fingerprint,
        vec![
            "hq-cli-update",
            "install-failed",
            "package_use_lease_timeout"
        ]
    );
    let message = event.message.as_deref().expect("static event message");
    assert_eq!(
        message,
        "[hq-cli-update] timed out waiting for active HQ CLI package use"
    );
    assert!(!message.contains('/') && !message.contains('\\'));
    assert!(event.extra.is_empty());
}

#[test]
fn holder_root_relation_tags_are_closed() {
    assert_eq!(HolderRootRelation::Same.as_tag(), "same");
    assert_eq!(HolderRootRelation::Older.as_tag(), "older");
    assert_eq!(HolderRootRelation::Legacy.as_tag(), "legacy");
    assert_eq!(HolderRootRelation::Unknown.as_tag(), "unknown");
}

#[test]
fn holder_root_relation_and_failure_tags_match_their_closed_vocabularies() {
    let holder_root_relation_tags = [
        HolderRootRelation::Same.as_tag(),
        HolderRootRelation::Older.as_tag(),
        HolderRootRelation::Legacy.as_tag(),
        HolderRootRelation::Unknown.as_tag(),
    ];
    assert_eq!(
        holder_root_relation_tags,
        ["same", "older", "legacy", "unknown"]
    );

    let failure_tags = [
        InstallFailureKind::ExpectedPrefixPermission.fingerprint_component(),
        InstallFailureKind::ExpectedWindowsAbort.fingerprint_component(),
        InstallFailureKind::ExpectedWindowsLockedBinary.fingerprint_component(),
        InstallFailureKind::WindowsLockedInstallTarget.fingerprint_component(),
        InstallFailureKind::ExpectedTransientRegistry.fingerprint_component(),
        InstallFailureKind::ExpectedBinCollision.fingerprint_component(),
        InstallFailureKind::ExpectedDiskFull.fingerprint_component(),
        InstallFailureKind::UnexpectedLifecycle.fingerprint_component(),
        InstallFailureKind::Unexpected.fingerprint_component(),
        InstallFailureKind::UnsupportedNode.fingerprint_component(),
        InstallFailureKind::MissingGlobalInstallTarget.fingerprint_component(),
        InstallFailureKind::ForeignRegistryPackageMissing.fingerprint_component(),
    ];
    assert_eq!(
        failure_tags,
        [
            "expected-prefix-permission",
            "expected-windows-abort",
            "expected-windows-locked-binary",
            "windows-locked-install-target",
            "expected-transient-registry",
            "expected-bin-collision",
            "expected-disk-full",
            "unexpected-lifecycle",
            "unexpected",
            "unsupported-node",
            "missing-global-install-target",
            "foreign-registry-404",
        ]
    );
    // The lease-timeout report uses a separate fixed failure tag, asserted
    // together with its capture and fingerprint above.
    let summary = crate::package_use_lease::PackageUseLeaseTimeoutSummary {
        live_holder_count: crate::package_use_lease::LiveHolderCountBucket::One,
        same_root_live_holder_count: crate::package_use_lease::LiveHolderCountBucket::One,
        other_root_live_holder_count: crate::package_use_lease::LiveHolderCountBucket::Zero,
        holder_version: crate::package_use_lease::HolderVersionBucket::Current,
        oldest_holder_age: crate::package_use_lease::HolderAgeBucket::Under10m,
        oldest_holder_purpose: crate::package_use_lease::HolderPurposeBucket::Command,
    };
    let events =
        sentry::test::with_captured_events(|| report_package_use_lease_timeout(&summary, 0));
    assert_eq!(events.len(), 1);
    assert_eq!(
        events[0].tags["install_failure_kind"],
        "package_use_lease_timeout"
    );
}

#[test]
fn package_use_lease_retry_schedule_is_bounded_and_only_has_timeout_delays() {
    assert_eq!(
        auto_update_retry_delay(AutoUpdateFailureKind::PackageUseLeaseTimeout, 0),
        Some(Duration::from_secs(10 * 60))
    );
    assert_eq!(
        auto_update_retry_delay(AutoUpdateFailureKind::PackageUseLeaseTimeout, 1),
        Some(Duration::from_secs(10 * 60))
    );
    assert_eq!(
        auto_update_retry_delay(AutoUpdateFailureKind::PackageUseLeaseTimeout, 2),
        Some(Duration::from_secs(10 * 60))
    );
    assert_eq!(
        auto_update_retry_delay(AutoUpdateFailureKind::PackageUseLeaseTimeout, 3),
        None
    );
    assert_eq!(
        auto_update_retry_delay(AutoUpdateFailureKind::PackageUseLeaseTimeout, u8::MAX),
        None
    );
    assert_eq!(
        auto_update_retry_delay(AutoUpdateFailureKind::Other, 0),
        None
    );
}

#[test]
fn package_use_lease_retry_attempt_tag_has_only_fixed_values() {
    assert_eq!(package_use_lease_retry_attempt_tag(0), "0");
    assert_eq!(package_use_lease_retry_attempt_tag(1), "1");
    assert_eq!(package_use_lease_retry_attempt_tag(2), "2");
    assert_eq!(package_use_lease_retry_attempt_tag(3), "3");
    assert_eq!(package_use_lease_retry_attempt_tag(u8::MAX), "3");
}

#[test]
fn non_convergence_report_tags_the_executed_copy_aim() {
    let (_temp, prefix, hq) = fixture_prefix();
    let event = captured_non_convergent_event(
        &hq,
        Some(&prefix),
        ExecutedCopyAim::NotYetAimed,
        paths::ResolutionSource::UserPrefix,
    );
    assert_eq!(
        event["tags"]["executed_copy_aim"].as_str(),
        Some("not_yet_aimed")
    );
}

#[test]
fn non_convergence_report_classifies_resolved_prefix() {
    let (_temp, prefix, hq) = fixture_prefix();
    let event = captured_non_convergent_event(
        &hq,
        Some("/installer/prefix"),
        ExecutedCopyAim::NotYetAimed,
        paths::ResolutionSource::UserPrefix,
    );
    assert_eq!(
        event["tags"]["resolved_prefix_class"].as_str(),
        Some("user")
    );
    assert_eq!(prefix, npm_prefix_from_hq_bin(&hq).unwrap());
}

#[test]
fn non_convergence_report_marks_resolved_prefix_under_home() {
    let (_temp, prefix, hq) = fixture_prefix();
    let event = captured_non_convergent_event(
        &hq,
        Some(&prefix),
        ExecutedCopyAim::NotYetAimed,
        paths::ResolutionSource::UserPrefix,
    );
    assert_eq!(event["tags"]["resolved_under_home"].as_str(), Some("true"));
}

#[test]
fn non_convergence_report_marks_colocated_npm() {
    let (_temp, prefix, hq) = fixture_prefix();
    let event = captured_non_convergent_event(
        &hq,
        Some(&prefix),
        ExecutedCopyAim::NotYetAimed,
        paths::ResolutionSource::UserPrefix,
    );
    assert_eq!(
        event["tags"]["resolved_colocated_npm"].as_str(),
        Some("true")
    );
}

#[test]
fn non_convergence_report_compares_installer_and_resolved_prefixes() {
    let (_temp, prefix, hq) = fixture_prefix();
    let event = captured_non_convergent_event(
        &hq,
        Some(&prefix),
        ExecutedCopyAim::NotYetAimed,
        paths::ResolutionSource::UserPrefix,
    );
    assert_eq!(
        event["tags"]["resolved_matches_installer_prefix"].as_str(),
        Some("true")
    );
}

#[test]
fn non_convergence_report_reads_the_winning_settings_path_file() {
    let event = captured_non_convergent_event(
        "hq",
        None,
        ExecutedCopyAim::Undrivable,
        paths::ResolutionSource::NotResolved,
    );
    let expected = paths::winning_settings_path_file(&paths::resolved_hq_folder());
    assert_eq!(
        event["tags"]["settings_path_file"].as_str(),
        Some(expected.telemetry_value())
    );
}

#[test]
fn non_convergence_report_measures_managed_bin_in_settings_path() {
    let event = captured_non_convergent_event(
        "hq",
        None,
        ExecutedCopyAim::Undrivable,
        paths::ResolutionSource::NotResolved,
    );
    let root = paths::resolved_hq_folder();
    let file = paths::winning_settings_path_file(&root);
    let roots = paths::managed_toolchain_roots();
    let managed = roots
        .first()
        .map(|root| paths::managed_npm_bin_in(root))
        .unwrap_or_default();
    let expected =
        managed_bin_in_settings_path(file, &paths::settings_path_dirs_in(&root), &managed);
    assert_eq!(
        event["tags"]["managed_bin_in_settings_path"].as_str(),
        Some(expected.telemetry_value())
    );
}

#[test]
fn windows_profile_path_never_enters_non_convergence_tags_or_contexts() {
    #[cfg(windows)]
    let (profile, prefix, hq) = {
        let profile = paths::home_dir().expect("Windows profile home is available");
        let prefix = profile.join("AppData/Roaming/npm");
        let hq = prefix.join("hq.cmd");
        (
            profile.to_string_lossy().into_owned(),
            prefix.to_string_lossy().into_owned(),
            hq.to_string_lossy().into_owned(),
        )
    };
    #[cfg(not(windows))]
    let (profile, prefix, hq) = (
        r"C:\Users\sc-desktop-8a-privacy-fixture".to_string(),
        r"C:\Users\sc-desktop-8a-privacy-fixture\AppData\Roaming\npm".to_string(),
        r"C:\Users\sc-desktop-8a-privacy-fixture\AppData\Roaming\npm\hq.cmd".to_string(),
    );
    let event = captured_non_convergent_event(
        &hq,
        Some(&prefix),
        ExecutedCopyAim::Undrivable,
        paths::ResolutionSource::SettingsPath,
    );
    let tags_and_contexts = serde_json::json!({
        "tags": event["tags"],
        "contexts": event["contexts"],
    })
    .to_string();
    assert!(!tags_and_contexts.contains(&profile));
    #[cfg(windows)]
    {
        let extras = event["extras"].to_string();
        assert!(!extras.contains(&profile));
        assert!(extras.contains("~"));
    }
}

#[test]
fn version_command_timeout_kills_and_reaps_the_child() {
    #[cfg(unix)]
    let mut command = {
        let mut command = std::process::Command::new("sh");
        command.args(["-c", "while :; do :; done"]);
        command
    };
    #[cfg(windows)]
    let mut command = {
        let mut command = std::process::Command::new("powershell.exe");
        command.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Start-Sleep -Seconds 30",
        ]);
        command
    };

    let started = Instant::now();
    let output = output_with_timeout(&mut command, Duration::from_millis(50))
        .expect("the timeout path is not an I/O failure");

    assert!(output.is_none(), "the hung command must time out");
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "kill + reap must complete without waiting for natural exit"
    );
}

#[cfg(unix)]
#[test]
fn inherited_stdout_from_a_descendant_is_read_without_a_drain_thread() {
    let mut command = std::process::Command::new("sh");
    command.args(["-c", "sleep 1 & echo 5.103.34"]);

    let started = Instant::now();
    let output = output_with_timeout(&mut command, Duration::from_millis(75))
        .expect("the inherited-pipe timeout is not an I/O failure");

    let output = output.expect("the immediate child's version output is available");
    assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "5.103.34");
    assert!(
        started.elapsed() < Duration::from_millis(500),
        "the descendant's inherited handle must not hold the caller open"
    );
}

#[cfg(unix)]
#[test]
fn reading_probe_output_preserves_the_inherited_writer_position() {
    use std::io::{Seek, SeekFrom, Write};
    let mut writer = tempfile::tempfile().unwrap();
    writer.write_all(b"5.103.34\n").unwrap();
    writer.set_len(VERSION_OUTPUT_LIMIT + 10).unwrap();
    writer.seek(SeekFrom::End(0)).unwrap();
    let position = writer.stream_position().unwrap();
    let bytes = read_probe_output(writer.try_clone().unwrap()).unwrap();
    assert!(bytes.starts_with(b"5.103.34\n"));
    assert_eq!(bytes.len(), VERSION_OUTPUT_LIMIT as usize);
    assert_eq!(writer.stream_position().unwrap(), position);
}

#[cfg(unix)]
#[test]
fn continuously_writing_descendant_is_terminated_with_the_probe_group() {
    let mut command = std::process::Command::new("sh");
    command.args([
        "-c",
        "echo 5.103.34; while :; do printf x; done & echo $! >&2",
    ]);

    let started = Instant::now();
    let output = output_with_timeout(&mut command, Duration::from_millis(75))
        .expect("process-tree containment is not an I/O failure")
        .expect("the immediate child exits successfully");

    assert!(String::from_utf8_lossy(&output.stdout).starts_with("5.103.34\n"));
    let descendant_pid = String::from_utf8_lossy(&output.stderr)
        .trim()
        .parse::<i32>()
        .expect("the fixture reports its writer pid");
    assert!(
        started.elapsed() < Duration::from_millis(500),
        "a continuous inherited writer must not hold the probe open"
    );
    let reaped_by = Instant::now() + Duration::from_millis(500);
    while unsafe { libc::kill(descendant_pid, 0) } == 0 && Instant::now() < reaped_by {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_ne!(
        unsafe { libc::kill(descendant_pid, 0) },
        0,
        "the continuously writing descendant must be killed"
    );
}

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

/// The defect this whole change closes: the installer must ask npm for the
/// EXACT version the app resolved, not the mutable `@latest` dist-tag that
/// npm re-resolves through its own lagging cache. On unmodified main the
/// function took only a prefix and always emitted `@latest`, so this fails
/// there for the right reason.
#[test]
fn install_argv_pins_the_exact_resolved_version_not_the_latest_dist_tag() {
    let argv = install_argv(Some("/tmp/hq-prefix"), Some("5.97.1"));
    assert_eq!(
        argv,
        vec![
            "install".to_string(),
            "-g".to_string(),
            "--prefix".to_string(),
            "/tmp/hq-prefix".to_string(),
            "@indigoai-us/hq-cli@5.97.1".to_string(),
        ]
    );
    // Still a global install of the right package, whatever the version.
    assert_eq!(argv[0], "install");
    assert_eq!(argv[1], "-g");
    assert!(argv.last().unwrap().starts_with("@indigoai-us/hq-cli@"));
    // The pinned spec must NOT carry the mutable dist-tag.
    assert!(
        !argv.iter().any(|arg| arg.ends_with("@latest")),
        "a pinned install must not request the @latest dist-tag: {argv:?}"
    );
}

/// The `None` arm still yields `@latest` for call sites with no resolved
/// target, so no caller silently loses its ability to install.
#[test]
fn package_spec_falls_back_to_the_latest_tag_only_without_a_resolved_target() {
    assert_eq!(hq_cli_package_spec(None), "@indigoai-us/hq-cli@latest");
    assert_eq!(hq_cli_package_spec(None), HQ_CLI_PACKAGE);
    assert_eq!(
        hq_cli_package_spec(Some("5.97.1")),
        "@indigoai-us/hq-cli@5.97.1"
    );
    let latest_argv = install_argv(None, None);
    assert_eq!(
        latest_argv,
        vec![
            "install".to_string(),
            "-g".to_string(),
            HQ_CLI_PACKAGE.to_string(),
        ]
    );
}

#[test]
fn install_argv_includes_prefix_when_available() {
    let argv = install_argv(Some("/tmp/hq-prefix"), None);
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
        Some("/Users/test/Library/Application Support/Indigo HQ/toolchain/npm-global".to_string())
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

/// The misroute that #353 closed, stated as an invariant rather than a
/// history lesson: for every pnpm layout, `npm_prefix_from_hq_bin` would
/// have handed npm a prefix inside pnpm's own home, so `is_pnpm_global_shim`
/// is the only thing standing between a pnpm ≥11 user and era 1 all over
/// again. If detection ever regresses, this fails loudly.
#[test]
fn nested_pnpm_shim_must_route_to_pnpm_not_to_an_npm_prefix_inside_the_pnpm_home() {
    for hq_bin in [
        "/Users/test/Library/pnpm/bin/hq",
        "/home/test/.local/share/pnpm/bin/hq",
    ] {
        assert!(
            is_pnpm_global_shim(hq_bin),
            "{hq_bin} must route to the pnpm executor"
        );
        // The npm branch would have aimed npm at `<pnpm-home>`, writing
        // `<pnpm-home>/{bin,lib}` and never moving the shim.
        assert!(
            npm_prefix_from_hq_bin(hq_bin).is_some(),
            "{hq_bin} reads as an npm prefix — detection is load-bearing"
        );
        // And the pnpm executor targets the directory the shim is in.
        let env = pnpm_global_env(hq_bin).expect("derivable pnpm env");
        assert_eq!(
            env.global_bin_dir,
            Path::new(hq_bin).parent().unwrap().to_string_lossy()
        );
    }
}

/// The pnpm home must come from the resolved shim, never from a guessed
/// default: aiming `pnpm add -g` at a directory the user does not use would
/// trade a silent non-convergence for a stray global install.
#[test]
fn pnpm_global_env_is_derived_from_the_resolved_shim_layout() {
    let flat = pnpm_global_env("/Users/test/Library/pnpm/hq").expect("flat layout");
    assert_eq!(flat.home, "/Users/test/Library/pnpm");
    assert_eq!(flat.global_bin_dir, "/Users/test/Library/pnpm");
    assert_eq!(flat.source, PnpmHomeSource::FlatPnpmDir);

    let nested = pnpm_global_env("/Users/test/Library/pnpm/bin/hq").expect("nested layout");
    assert_eq!(nested.home, "/Users/test/Library/pnpm");
    assert_eq!(nested.global_bin_dir, "/Users/test/Library/pnpm/bin");
    assert_eq!(nested.source, PnpmHomeSource::NestedBinDir);

    let linux = pnpm_global_env("/home/test/.local/share/pnpm/bin/hq").expect("linux nested");
    assert_eq!(linux.home, "/home/test/.local/share/pnpm");
    assert_eq!(linux.global_bin_dir, "/home/test/.local/share/pnpm/bin");

    // Custom PNPM_HOME, flat: identified by the `global/` store beside the
    // shims rather than by directory name.
    let tmp = tempfile::TempDir::new().unwrap();
    let home = tmp.path().join("my-tools");
    std::fs::create_dir_all(home.join("global")).unwrap();
    let shim = home.join("hq");
    std::fs::write(&shim, "#!/bin/sh\n").unwrap();
    let custom = pnpm_global_env(shim.to_str().unwrap()).expect("custom flat home");
    assert_eq!(custom.home, home.to_string_lossy());
    assert_eq!(custom.source, PnpmHomeSource::GlobalStore);

    // Custom PNPM_HOME with the v11 nesting.
    let tmp_v11 = tempfile::TempDir::new().unwrap();
    let home_v11 = tmp_v11.path().join("my-tools");
    std::fs::create_dir_all(home_v11.join("global")).unwrap();
    std::fs::create_dir_all(home_v11.join("bin")).unwrap();
    let shim_v11 = home_v11.join("bin").join("hq");
    std::fs::write(&shim_v11, "#!/bin/sh\n").unwrap();
    let custom_v11 = pnpm_global_env(shim_v11.to_str().unwrap()).expect("custom nested home");
    assert_eq!(custom_v11.home, home_v11.to_string_lossy());
    assert_eq!(
        custom_v11.global_bin_dir,
        home_v11.join("bin").to_string_lossy()
    );
    assert_eq!(custom_v11.source, PnpmHomeSource::GlobalStore);
}

/// When the home cannot be derived with confidence we must invent nothing —
/// the child is spawned exactly as before, which is the conservative rule
/// `npm_prefix_from_hq_bin` already applies for flat shim dirs.
#[test]
fn pnpm_global_env_is_none_when_the_layout_does_not_prove_a_home() {
    for hq_bin in [
        "hq",
        "",
        "/opt/homebrew/bin/hq",
        "/Users/test/.npm-global/bin/hq",
        "/Users/test/.asdf/shims/hq",
        "/usr/local/bin/hq",
    ] {
        assert_eq!(
            pnpm_global_env(hq_bin),
            None,
            "{hq_bin} must not yield an invented pnpm home"
        );
    }
}

#[test]
fn pnpm_child_path_prepends_the_shim_dir_only_when_it_is_missing() {
    let sep = PATH_LIST_SEPARATOR;
    let base = format!("/usr/local/bin{sep}/usr/bin");
    // The era-2 candidate cause: `<pnpm-home>/bin` is absent from
    // `child_path()`, so the child pnpm resolves a different global dir.
    assert_eq!(
        pnpm_child_path(&base, Some("/Users/t/Library/pnpm/bin")),
        format!("/Users/t/Library/pnpm/bin{sep}{base}")
    );
    // Already present: no duplicate entry, no reordering.
    let with_dir = format!("/Users/t/Library/pnpm{sep}{base}");
    assert_eq!(
        pnpm_child_path(&with_dir, Some("/Users/t/Library/pnpm")),
        with_dir
    );
    // Underivable home: hand the child exactly what it had before.
    assert_eq!(pnpm_child_path(&base, None), base);
    assert_eq!(pnpm_child_path(&base, Some("")), base);
    assert!(path_contains_dir(&with_dir, "/Users/t/Library/pnpm"));
    assert!(!path_contains_dir(&base, "/Users/t/Library/pnpm"));
    assert!(!path_contains_dir(&base, ""));
}

/// Era 2 of HQ-DESKTOP-46, updated for the delivery/direction-gated contract
/// (NOT weakened). Genuine pnpm shadowing — pnpm's effective global bin dir IS
/// the dir holding the executed shim (`global_bin_dir_matches_shim_dir =
/// Some(true)`) AND the target WAS delivered into the store — stays as loud as
/// an npm-targeted non-convergence and keeps its durable block, on every
/// occurrence, and it must say "pnpm", not borrow npm's wording.
#[test]
fn targeted_pnpm_non_convergence_is_its_own_loud_class() {
    let hq_bin = "/Users/t/Library/pnpm/bin/hq";
    let pnpm = PnpmRunDiagnostics {
        home_source: PnpmHomeSource::NestedBinDir,
        home_env_present: false,
        path_has_shim_dir: true,
        // A native-resolution diagnostic only; on a nested layout it would
        // legitimately be Some(false), and it no longer gates any class.
        global_bin_dir_matches_shim_dir: Some(true),
        store_family: PnpmStoreFamily::V11,
        authoritative_query_ok: true,
        exit_status: "0".to_string(),
        output_len: 42,
    };
    // `already_blocked = true`: a targeted defect stays loud across
    // episodes exactly like `NpmTargeted`.
    let outcome = decide_post_install(&PostInstallContext {
        executor: InstallExecutor::Pnpm,
        before_bin: hq_bin,
        after_bin: hq_bin,
        before_version: None,
        after_version: Some("5.93.0"),
        latest: "5.94.1",
        npm_prefix_passed: None,
        // Delivery evidence now gates the pnpm arm too: the target reached the
        // store, yet the executed shim is still stale — genuine shadowing.
        delivered_version: Some("5.94.1"),
        installer_bin: "/opt/homebrew/bin/pnpm",
        already_blocked: true,
        nonblocking_episode_keys: &[],
        managed_roots: &[],
        managed_shadow_repair: ManagedShadowRepairOutcome::NotAttempted,
        executed_copy_aim: ExecutedCopyAim::Undrivable,
        hq_bin_lane: paths::ResolutionSource::NotResolved,
        delivered_prefix_shim: DeliveredPrefixShim::Unknown,
        settings_path: SettingsPathTelemetry::default(),
        pnpm: Some(pnpm.clone()),
    });
    assert_eq!(
        outcome.non_convergence_kind,
        Some(NonConvergenceKind::PnpmTargeted)
    );
    assert!(!outcome.capture_requires_durable_record);
    let report = outcome.capture.as_ref().expect("targeted runs stay loud");
    assert_eq!(report.executor, InstallExecutor::Pnpm);
    assert_eq!(report.installer_bin, "/opt/homebrew/bin/pnpm");
    assert_eq!(report.npm_prefix, None, "pnpm passes no npm prefix");
    assert_eq!(report.pnpm.as_ref(), Some(&pnpm));
    assert_eq!(outcome.record_non_convergent.as_deref(), Some("5.94.1"));
    assert!(outcome.log_line.starts_with("pnpm completed,"));
}

/// The live Kurts recurrence: a pnpm run HQ could not aim at the executed
/// copy (underivable home, or a child PATH that never contained the shim
/// dir). It is `InstallerUnaimed` — observable but NON-BLOCKING: no durable
/// marker, capture NOT gated on a marker write, and bounded to one capture
/// per episode. On the base commit this was `ForeignManaged`, which wrote the
/// pinned marker and wedged auto-update on every publish.
#[test]
fn an_unaimed_pnpm_run_is_non_blocking_and_writes_no_marker() {
    // The exact Kurts field values plus the NestedBinDir/unaimed variant.
    for (hq_bin, home_source) in [
        ("/opt/homebrew/bin/hq", PnpmHomeSource::Undetermined),
        ("/Users/t/Library/pnpm/bin/hq", PnpmHomeSource::NestedBinDir),
    ] {
        let ctx = PostInstallContext {
            executor: InstallExecutor::Pnpm,
            before_bin: hq_bin,
            after_bin: hq_bin,
            before_version: None,
            after_version: Some("5.95.0"),
            latest: "5.103.18",
            npm_prefix_passed: None,
            delivered_version: None,
            installer_bin: "/opt/homebrew/bin/pnpm",
            already_blocked: false,
            nonblocking_episode_keys: &[],
            managed_roots: &[],
            managed_shadow_repair: ManagedShadowRepairOutcome::NotAttempted,
            executed_copy_aim: ExecutedCopyAim::Undrivable,
            hq_bin_lane: paths::ResolutionSource::NotResolved,
            delivered_prefix_shim: DeliveredPrefixShim::Unknown,
            settings_path: SettingsPathTelemetry::default(),
            pnpm: Some(PnpmRunDiagnostics {
                home_source,
                home_env_present: false,
                path_has_shim_dir: false,
                global_bin_dir_matches_shim_dir: None,
                store_family: PnpmStoreFamily::Unknown,
                authoritative_query_ok: false,
                exit_status: "0".to_string(),
                output_len: 0,
            }),
        };
        let outcome = decide_post_install(&ctx);
        assert_eq!(
            outcome.non_convergence_kind,
            Some(NonConvergenceKind::InstallerUnaimed),
            "home_source={home_source:?}"
        );
        assert_eq!(
            outcome.record_non_convergent, None,
            "an unaimed run must write no durable marker"
        );
        assert!(!outcome.capture_requires_durable_record);
        assert!(outcome.capture.is_some(), "it stays observable once");
        let key = non_convergent_episode_key(
            "5.103.18",
            InstallExecutor::Pnpm,
            NonConvergenceKind::InstallerUnaimed,
            Some(home_source),
        );
        assert_eq!(
            outcome.record_nonblocking_episode.as_deref(),
            Some(key.as_str()),
            "the first episode must return its non-blocking key to persist"
        );

        // A repeat with that key already present is suppressed — one capture
        // per episode, so Sentry volume cannot grow.
        let seen = [key];
        let repeat = decide_post_install(&PostInstallContext {
            nonblocking_episode_keys: &seen,
            ..ctx
        });
        assert!(repeat.capture.is_none(), "a repeat episode is suppressed");
        assert_eq!(repeat.record_nonblocking_episode, None);
    }
}

/// The live Zekes recurrence: npm delivered `latest` into HQ's managed
/// prefix, but the app still resolves an npx-cache copy npm can never move.
/// It is `InstallerUnaimed` — non-blocking, no durable marker, one capture
/// per episode. On the base commit `npm_prefix_from_hq_bin` returns `None`
/// for a `.bin` parent, so it fell through to `foreign-managed` and wedged.
#[test]
fn the_observed_macos_npx_cache_shape_is_non_blocking_and_writes_no_marker() {
    let npx_hq = "/Users/z/.npm/_npx/91dc460cc0784cc8/node_modules/.bin/hq";
    let managed_prefix = "/Users/z/Library/Application Support/Indigo HQ/toolchain/npm-global";
    let ctx = PostInstallContext::npm(
        npx_hq,
        npx_hq,
        Some("5.103.1"),
        Some("5.103.1"),
        "5.103.18",
        Some(managed_prefix),
        "/opt/homebrew/bin/npm",
        false,
        Some("5.103.18"),
    );
    let outcome = decide_post_install(&ctx);
    assert_eq!(
        outcome.non_convergence_kind,
        Some(NonConvergenceKind::InstallerUnaimed)
    );
    assert_eq!(
        outcome.record_non_convergent, None,
        "npx copy must not block"
    );
    assert!(!outcome.capture_requires_durable_record);
    let key = non_convergent_episode_key(
        "5.103.18",
        InstallExecutor::Npm,
        NonConvergenceKind::InstallerUnaimed,
        None,
    );
    assert_eq!(
        outcome.record_nonblocking_episode.as_deref(),
        Some(key.as_str())
    );
}

/// The npx-cache non-convergence is bounded to one capture per episode, so
/// the fix cannot increase Sentry volume: a second run that already sees the
/// episode key captures nothing.
#[test]
fn the_new_kind_is_bounded_to_one_capture_per_episode() {
    let npx_hq = "/Users/z/.npm/_npx/abc/node_modules/.bin/hq";
    let key = non_convergent_episode_key(
        "5.103.18",
        InstallExecutor::Npm,
        NonConvergenceKind::InstallerUnaimed,
        None,
    );
    let seen = [key];
    let outcome = decide_post_install(
        &PostInstallContext::npm(
            npx_hq,
            npx_hq,
            Some("5.103.1"),
            Some("5.103.1"),
            "5.103.18",
            Some("/managed/npm-global"),
            "/opt/homebrew/bin/npm",
            false,
            Some("5.103.18"),
        )
        .with_nonblocking_episode_keys(&seen),
    );
    assert_eq!(
        outcome.non_convergence_kind,
        Some(NonConvergenceKind::InstallerUnaimed)
    );
    assert!(
        outcome.capture.is_none(),
        "a repeat episode captures nothing"
    );
    assert_eq!(outcome.record_nonblocking_episode, None);
}

/// The Kevins-MacBook-Pro recurrence: a FIRST install on a machine where
/// nothing resolves. npm exits 0 into its own ambient default prefix, `hq`
/// still resolves to the bare `hq` sentinel (nothing HQ searches contains
/// it), and there is no prefix to read delivery from. HQ never aimed at any
/// copy and proved no layout defect, so this is `InstallerUnaimed` —
/// observable but NON-BLOCKING (no durable marker). On the base commit the
/// npm arm falls through to `ForeignManaged`, which writes the pinned marker
/// and wedges auto-update for a copy HQ could not even name.
#[test]
fn an_unresolved_hq_after_an_npm_install_is_installer_unaimed_and_writes_no_marker() {
    // Classification is pure: the bare `hq` sentinel with no prefix passed is
    // installer-unaimed, not foreign-managed.
    assert_eq!(
        non_convergence_kind(InstallExecutor::Npm, None, false, "hq", false, &[]),
        NonConvergenceKind::InstallerUnaimed,
    );
    let outcome = decide_post_install(&PostInstallContext::npm(
        "hq",
        "hq",
        None,
        None,
        "5.103.20",
        None,
        "/usr/local/bin/npm",
        false,
        None,
    ));
    assert_eq!(
        outcome.non_convergence_kind,
        Some(NonConvergenceKind::InstallerUnaimed)
    );
    assert_eq!(
        outcome.record_non_convergent, None,
        "an unaimed first install must write no durable marker"
    );
    assert!(!outcome.capture_requires_durable_record);
    assert!(outcome.capture.is_some(), "it stays observable once");
    assert_eq!(
        outcome.capture.as_ref().unwrap().hq_bin,
        "PATH",
        "the unresolved bin is reported as the closed PATH token, never a home path"
    );
}

/// An absolute foreign layout with a readable version is unchanged by the
/// unaimed-sentinel arm: it still blocks and still writes the durable marker,
/// because HQ resolved a concrete copy it could name (it simply cannot drive
/// that layout).
#[test]
fn an_absolute_foreign_layout_is_unaffected_by_the_unaimed_sentinel_arm() {
    assert_eq!(
        non_convergence_kind(
            InstallExecutor::Npm,
            None,
            false,
            "/Users/t/.asdf/shims/hq",
            false,
            &[],
        ),
        NonConvergenceKind::ForeignManaged,
    );
}

/// The bare-sentinel override is scoped to the npm arm: a pnpm or Bun run that
/// was aimed at the executed copy AND delivered the target keeps its targeted
/// (blocking) classification even if the post-install shim momentarily resolves
/// to the bare `hq` sentinel — the executor's own targeting/delivery evidence is
/// never discarded by the npm-only sentinel exception.
#[test]
fn the_bare_sentinel_override_does_not_touch_targeted_pnpm_or_bun() {
    assert_eq!(
        non_convergence_kind(InstallExecutor::Pnpm, None, true, "hq", true, &[]),
        NonConvergenceKind::PnpmTargeted,
    );
    assert_eq!(
        non_convergence_kind(InstallExecutor::Bun, None, true, "hq", true, &[]),
        NonConvergenceKind::BunTargeted,
    );
}

/// The pnpm detection/targeting collapse: `is_pnpm_global_shim(x)` is now
/// exactly `pnpm_global_env(x).is_some()` for EVERY layout arm, so the two
/// can never disagree again — the invariant the doc comment promised.
#[test]
fn pnpm_detection_and_targeting_agree_on_every_layout_arm() {
    // String-only arms (no filesystem needed).
    for hq_bin in [
        "hq",
        "",
        "/Users/t/Library/pnpm/hq",     // flat
        "/home/t/.local/share/pnpm/hq", // flat linux
        "/Users/t/Library/pnpm/bin/hq", // pnpm >=11 nested
        "/opt/homebrew/bin/hq",         // npm/homebrew
        "/Users/t/.npm-global/bin/hq",  // npm global
        "/Users/t/.asdf/shims/hq",      // asdf
    ] {
        assert_eq!(
            is_pnpm_global_shim(hq_bin),
            pnpm_global_env(hq_bin).is_some(),
            "detection/targeting disagree on {hq_bin}"
        );
    }
    // Filesystem arms: custom PNPM_HOME (flat + nested) and the previously
    // divergent `<dir>/bin/hq` where `<dir>/bin/global` exists but `<dir>`
    // is not a pnpm home.
    let tmp = tempfile::TempDir::new().unwrap();
    // Custom flat home with a `global/` store.
    let flat = tmp.path().join("tools");
    std::fs::create_dir_all(flat.join("global")).unwrap();
    std::fs::write(flat.join("hq"), "#!/bin/sh\n").unwrap();
    // Custom nested home with a `global/` store.
    let nested = tmp.path().join("tools-v11");
    std::fs::create_dir_all(nested.join("global")).unwrap();
    std::fs::create_dir_all(nested.join("bin")).unwrap();
    std::fs::write(nested.join("bin").join("hq"), "#!/bin/sh\n").unwrap();
    // The divergent shape: `<x>/bin/global` exists, `<x>/global` does not,
    // and `<x>` is not named `pnpm`.
    let divergent = tmp.path().join("x");
    std::fs::create_dir_all(divergent.join("bin").join("global")).unwrap();
    std::fs::write(divergent.join("bin").join("hq"), "#!/bin/sh\n").unwrap();
    for path in [
        flat.join("hq"),
        nested.join("bin").join("hq"),
        divergent.join("bin").join("hq"),
    ] {
        let p = path.to_str().unwrap();
        assert_eq!(
            is_pnpm_global_shim(p),
            pnpm_global_env(p).is_some(),
            "detection/targeting disagree on {p}"
        );
    }
}

/// The divergent `<dir>/bin/hq` shape (the class that used to disagree) now
/// routes to the npm executor with the correct enclosing prefix, so npm
/// updates the copy the app runs instead of `pnpm add -g` firing unaimed.
#[test]
fn the_divergent_bin_global_shape_routes_to_npm_with_the_enclosing_prefix() {
    let tmp = tempfile::TempDir::new().unwrap();
    let x = tmp.path().join("x");
    std::fs::create_dir_all(x.join("bin").join("global")).unwrap();
    let hq = x.join("bin").join("hq");
    std::fs::write(&hq, "#!/bin/sh\n").unwrap();
    let hq_str = hq.to_str().unwrap();
    // Not pnpm — so install_executor_for_hq_bin takes the npm branch.
    assert!(!is_pnpm_global_shim(hq_str));
    assert_eq!(pnpm_global_env(hq_str), None);
    // npm gets the enclosing prefix `<x>/bin`'s parent, `<x>`.
    assert_eq!(
        npm_prefix_from_hq_bin(hq_str),
        Some(x.to_string_lossy().to_string())
    );
    // The canonical Homebrew case the crate already asserts elsewhere.
    assert_eq!(
        npm_prefix_from_hq_bin("/opt/homebrew/bin/hq"),
        Some("/opt/homebrew".to_string())
    );
}

/// Guard against over-broadening: a genuinely foreign npm layout (no prefix
/// to aim at) still classifies `ForeignManaged`, still blocks, and still
/// writes the durable marker on its first episode. The unaimed/npx changes
/// must not weaken this.
#[test]
fn a_genuinely_foreign_layout_still_blocks_and_still_writes_the_marker() {
    let outcome = decide_post_install(&PostInstallContext::npm(
        "/Users/t/.asdf/shims/hq",
        "/Users/t/.asdf/shims/hq",
        Some("5.95.0"),
        Some("5.95.0"),
        "5.103.18",
        None,
        "/opt/homebrew/bin/npm",
        false,
        None,
    ));
    assert_eq!(
        outcome.non_convergence_kind,
        Some(NonConvergenceKind::ForeignManaged)
    );
    assert_eq!(outcome.record_non_convergent.as_deref(), Some("5.103.18"));
    assert!(outcome.capture_requires_durable_record);
}

// ---- Foreign-managed non-convergence, gated on whether HQ aimed at the
// ---- copy the app executes (the r3 fix for the nvm-under-managed-npm shape)

/// The live event fd8f0b5c inputs: npm delivered `latest` into HQ's managed
/// prefix, but the app executes an nvm copy one version behind. The managed
/// root and the managed prefix.
fn live_recurrence_ctx(aim: ExecutedCopyAim, already_blocked: bool) -> PostInstallOutcome {
    let managed_root = PathBuf::from("/Users/me/Library/Application Support/Indigo HQ/toolchain");
    let roots = [managed_root];
    decide_post_install(
        &PostInstallContext::npm(
            "/Users/me/.nvm/versions/node/v24.20.0/bin/hq",
            "/Users/me/.nvm/versions/node/v24.20.0/bin/hq",
            Some("5.103.26"),
            Some("5.103.26"),
            "5.103.27",
            Some("/Users/me/Library/Application Support/Indigo HQ/toolchain/npm-global"),
            "/Users/me/Library/Application Support/Indigo HQ/toolchain/node/bin/npm",
            already_blocked,
            Some("5.103.27"),
        )
        .with_managed_roots(&roots)
        .with_executed_copy_aim(aim),
    )
}

/// Gold (RED on the base commit, GREEN on the candidate): the exact live
/// nvm-under-managed-npm shape stays classified `ForeignManaged`, but with the
/// corrected aim NOT yet pointed at that drivable copy it writes NO durable
/// marker — so the next cycle's aim converges instead of the machine wedging
/// auto-update. On base ea307d53 this returned `record_non_convergent =
/// Some("5.103.27")`, which is exactly what wedged the recurrence.
#[test]
fn a_foreign_layout_not_yet_aimed_at_writes_no_durable_marker() {
    let outcome = live_recurrence_ctx(ExecutedCopyAim::NotYetAimed, false);
    assert_eq!(
        outcome.non_convergence_kind,
        Some(NonConvergenceKind::ForeignManaged),
        "the executed nvm copy under a managed npm is still foreign-managed"
    );
    assert_eq!(
        outcome.record_non_convergent, None,
        "a drivable copy HQ has not yet aimed at must NOT write the durable marker"
    );
    assert!(
        !outcome.capture_requires_durable_record,
        "the non-blocking capture is not gated on a durable record"
    );
    // Still observable on its first episode, and episode-bounded so it does
    // not re-page every 6h.
    assert!(outcome.capture.is_some());
    assert!(outcome.record_nonblocking_episode.is_some());
}

/// The companion proving the gold is not vacuous, and the stop-paging
/// guarantee for machines HQ genuinely cannot repair: the SAME live inputs
/// with an UNDRIVABLE aim still classify `ForeignManaged` AND still write the
/// durable marker on the first episode (exactly the base behaviour), then
/// stay suppressed on the repeat — once per episode.
#[test]
fn an_undrivable_foreign_layout_still_writes_the_marker_once_per_episode() {
    let first = live_recurrence_ctx(ExecutedCopyAim::Undrivable, false);
    assert_eq!(
        first.non_convergence_kind,
        Some(NonConvergenceKind::ForeignManaged)
    );
    assert_eq!(first.record_non_convergent.as_deref(), Some("5.103.27"));
    assert!(first.capture_requires_durable_record);
    assert!(first.capture.is_some());

    // Already blocked (the marker is written): no second marker, no capture.
    let repeat = live_recurrence_ctx(ExecutedCopyAim::Undrivable, true);
    assert_eq!(repeat.record_non_convergent, None);
    assert!(repeat.capture.is_none());
}

/// The partial-install sub-mechanism: HQ delivered `latest` into the aimed
/// prefix but that prefix exposes no `hq` shim, so the app resolves a foreign
/// copy. That is HQ's OWN incomplete install, not a layout HQ cannot drive —
/// so even with an undrivable aim it stays non-blocking and episode-bounded,
/// never writing the durable marker, and the next check reinstalls.
#[test]
fn a_delivered_prefix_with_no_shim_is_non_blocking_and_episode_bounded() {
    let managed_root = PathBuf::from("/Users/me/Library/Application Support/Indigo HQ/toolchain");
    let roots = [managed_root];
    let outcome = decide_post_install(
        &PostInstallContext::npm(
            "/Users/me/.nvm/versions/node/v24.20.0/bin/hq",
            "/Users/me/.nvm/versions/node/v24.20.0/bin/hq",
            Some("5.103.26"),
            Some("5.103.26"),
            "5.103.27",
            Some("/Users/me/Library/Application Support/Indigo HQ/toolchain/npm-global"),
            "/Users/me/Library/Application Support/Indigo HQ/toolchain/node/bin/npm",
            false,
            Some("5.103.27"),
        )
        .with_managed_roots(&roots)
        // Undrivable aim would normally block, but a missing shim after a
        // delivered install must never wedge auto-update.
        .with_executed_copy_aim(ExecutedCopyAim::Undrivable)
        .with_resolution_telemetry(
            paths::ResolutionSource::LoginShell,
            DeliveredPrefixShim::Absent,
        ),
    );
    assert_eq!(
        outcome.non_convergence_kind,
        Some(NonConvergenceKind::ForeignManaged)
    );
    assert_eq!(
        outcome.record_non_convergent, None,
        "a delivered prefix missing its shim must not write the durable marker"
    );
    assert!(!outcome.capture_requires_durable_record);
    assert!(outcome.record_nonblocking_episode.is_some());
}

/// The non-convergent event carries the two new closed lane/shim tokens, so
/// the next occurrence names its own mechanism (settings-PATH parity vs a
/// partial install) without another planning round.
#[test]
fn the_non_convergent_event_carries_the_resolution_lane_and_shim_tokens() {
    let outcome = decide_post_install(
        &PostInstallContext::npm(
            "/Users/me/.nvm/versions/node/v24.20.0/bin/hq",
            "/Users/me/.nvm/versions/node/v24.20.0/bin/hq",
            Some("5.103.26"),
            Some("5.103.26"),
            "5.103.27",
            Some("/Users/me/Library/Application Support/Indigo HQ/toolchain/npm-global"),
            "/Users/me/Library/Application Support/Indigo HQ/toolchain/node/bin/npm",
            false,
            Some("5.103.27"),
        )
        .with_managed_roots(&[PathBuf::from(
            "/Users/me/Library/Application Support/Indigo HQ/toolchain",
        )])
        .with_resolution_telemetry(
            paths::ResolutionSource::SettingsPath,
            DeliveredPrefixShim::Present,
        ),
    );
    let report = outcome.capture.expect("a first foreign episode captures");
    assert_eq!(report.hq_bin_lane, paths::ResolutionSource::SettingsPath);
    assert_eq!(report.delivered_prefix_shim, DeliveredPrefixShim::Present);
    // The telemetry tokens are drawn from closed vocabularies, never a path.
    assert_eq!(report.hq_bin_lane.telemetry_value(), "settings_path");
    assert_eq!(report.delivered_prefix_shim.telemetry_value(), "present");
}

/// The managed-shadow, pnpm, and bun arms are byte-for-byte unaffected by the
/// new aim/shim inputs: only a ForeignManaged verdict consults them.
#[test]
fn the_managed_shadow_pnpm_and_bun_arms_are_unchanged_by_the_new_aim() {
    // A resolution shortfall (pnpm) with a NotYetAimed aim is still exactly a
    // non-blocking shortfall — the foreign gate never runs for it.
    let shortfall = decide_post_install(&PostInstallContext {
        executor: InstallExecutor::Pnpm,
        before_bin: "/Users/me/Library/pnpm/hq",
        after_bin: "/Users/me/Library/pnpm/hq",
        before_version: Some("5.90.0"),
        after_version: Some("5.90.0"),
        latest: "5.103.27",
        npm_prefix_passed: None,
        delivered_version: None,
        installer_bin: "/Users/me/Library/pnpm/pnpm",
        already_blocked: false,
        nonblocking_episode_keys: &[],
        managed_roots: &[],
        managed_shadow_repair: ManagedShadowRepairOutcome::NotAttempted,
        executed_copy_aim: ExecutedCopyAim::NotYetAimed,
        hq_bin_lane: paths::ResolutionSource::UserPrefix,
        delivered_prefix_shim: DeliveredPrefixShim::Absent,
        settings_path: SettingsPathTelemetry::default(),
        pnpm: Some(PnpmRunDiagnostics {
            home_source: PnpmHomeSource::FlatPnpmDir,
            home_env_present: true,
            path_has_shim_dir: true,
            global_bin_dir_matches_shim_dir: Some(true),
            store_family: PnpmStoreFamily::V11,
            authoritative_query_ok: true,
            exit_status: "0".to_string(),
            output_len: 64,
        }),
    });
    assert_eq!(
        shortfall.non_convergence_kind,
        Some(NonConvergenceKind::ResolutionShortfall)
    );
    assert_eq!(
        shortfall.record_non_convergent, None,
        "a shortfall never blocks, regardless of the aim/shim inputs"
    );
    assert!(!shortfall.capture_requires_durable_record);
}

#[test]
fn user_prefix_aim_decision_claims_only_a_drivable_prefix_with_a_colocated_npm() {
    let prefix = "/Users/me/.nvm/versions/node/v24.20.0";
    let npm = "/Users/me/.nvm/versions/node/v24.20.0/bin/npm";
    // All three present -> aim at the user prefix, run its own npm.
    assert_eq!(
        user_prefix_aim_decision(Some(prefix), true, Some(npm)),
        Some(UserPrefixAim {
            prefix: prefix.to_string(),
            npm: npm.to_string(),
        })
    );
    // Not user-owned (a system/Homebrew or managed prefix) -> no user aim.
    assert_eq!(
        user_prefix_aim_decision(Some("/opt/homebrew"), false, Some(npm)),
        None
    );
    // User-owned but no co-located npm -> no user aim (ABI safety stays).
    assert_eq!(user_prefix_aim_decision(Some(prefix), true, None), None);
    // No derivable hq prefix -> no user aim.
    assert_eq!(user_prefix_aim_decision(None, true, Some(npm)), None);
}

#[test]
fn managed_retry_keeps_a_matching_nvm_cli_targeted_in_place() {
    let managed_prefix = "/Users/me/Library/Application Support/Indigo HQ/toolchain/npm-global";
    let nvm_prefix = "/Users/me/.nvm/versions/node/v22.14.0";
    let nvm_aim = UserPrefixAim {
        prefix: nvm_prefix.to_string(),
        npm: format!("{nvm_prefix}/bin/npm"),
    };

    // The live A/B shape: HQ's managed prefix exists, but the `hq` the
    // user runs belongs to nvm. When both use ABI 127, the fallback can use
    // its managed npm without changing the destination, so the resolved nvm
    // copy is the one that receives the update.
    assert_eq!(
        managed_retry_user_prefix_aim(Some(&nvm_aim), Some(127), 127),
        Some(nvm_aim.clone())
    );
    assert_ne!(nvm_aim.prefix, managed_prefix);
    assert_eq!(
        install_argv(Some(&nvm_aim.prefix), Some("5.2.0")),
        vec![
            "install".to_string(),
            "-g".to_string(),
            "--prefix".to_string(),
            nvm_prefix.to_string(),
            "@indigoai-us/hq-cli@5.2.0".to_string(),
        ],
        "the matching-ABI retry must pass the nvm prefix to npm"
    );

    // A different or unknown ABI cannot safely receive packages built by
    // HQ's managed npm, so it must not select the user prefix.
    assert_eq!(
        managed_retry_user_prefix_aim(Some(&nvm_aim), Some(115), 127),
        None
    );
    assert_eq!(
        managed_retry_user_prefix_aim(Some(&nvm_aim), None, 127),
        None
    );
    assert_eq!(managed_retry_user_prefix_aim(None, Some(127), 127), None);
}

#[test]
fn incompatible_user_runtime_guidance_names_node_22_and_nvm_reinstall_command() {
    let detail = managed_retry_user_copy_detail();

    assert!(
        detail.contains("Node 22 LTS"),
        "the refusal must name a supported runtime"
    );
    assert!(
        detail
            .contains("nvm install 22 && nvm use 22 && npm install -g @indigoai-us/hq-cli@latest"),
        "the refusal must give nvm users a command that changes their runtime before reinstalling"
    );
}

#[test]
#[cfg(not(target_os = "windows"))]
fn executed_copy_aim_for_distinguishes_aimed_deferred_and_undrivable() {
    let tmp = tempfile::TempDir::new().unwrap();
    let home = tmp.path();
    let prefix = home.join(".nvm/versions/node/v24.20.0");
    let bin = prefix.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let hq = bin.join("hq");
    let npm = bin.join("npm");
    std::fs::write(&hq, "#!/bin/sh\n").unwrap();
    std::fs::write(&npm, "#!/bin/sh\n").unwrap();
    let managed_roots = [home.join("Library/Application Support/Indigo HQ/toolchain")];
    let prefix_str = prefix.to_string_lossy().to_string();
    let hq_str = hq.to_string_lossy().to_string();
    let npm_str = npm.to_string_lossy().to_string();

    // Aimed at the executed copy's own prefix, running its own npm.
    assert_eq!(
        executed_copy_aim_for(
            &hq_str,
            Some(&prefix_str),
            &npm_str,
            &managed_roots,
            Some(home)
        ),
        ExecutedCopyAim::Aimed
    );
    // Drivable, but this run aimed at the managed prefix instead -> deferred.
    assert_eq!(
        executed_copy_aim_for(
            &hq_str,
            Some("/Users/me/Library/Application Support/Indigo HQ/toolchain/npm-global"),
            "/some/managed/npm",
            &managed_roots,
            Some(home),
        ),
        ExecutedCopyAim::NotYetAimed
    );
    // A user prefix with no co-located npm -> undrivable.
    std::fs::remove_file(&npm).unwrap();
    assert_eq!(
        executed_copy_aim_for(
            &hq_str,
            Some(&prefix_str),
            &npm_str,
            &managed_roots,
            Some(home)
        ),
        ExecutedCopyAim::Undrivable
    );
    // A system prefix (outside home) -> undrivable.
    assert_eq!(
        executed_copy_aim_for(
            "/opt/homebrew/bin/hq",
            Some("/opt/homebrew"),
            "/opt/homebrew/bin/npm",
            &managed_roots,
            Some(home),
        ),
        ExecutedCopyAim::Undrivable
    );
    // An asdf-style shim with no derivable prefix -> undrivable.
    assert_eq!(
        executed_copy_aim_for(
            &home.join(".asdf/shims/hq").to_string_lossy(),
            None,
            "npm",
            &managed_roots,
            Some(home),
        ),
        ExecutedCopyAim::Undrivable
    );
}

#[test]
fn executed_copy_reaim_only_runs_for_a_deferred_foreign_copy() {
    let gate = executed_copy_reaim_gate(
        Some(NonConvergenceKind::ForeignManaged),
        ExecutedCopyAim::NotYetAimed,
        true,
    );
    assert_eq!(gate, ExecutedCopyReaimGate::Attempt);
    assert_eq!(
        executed_copy_reaim_outcome(gate, Some(true), true),
        ExecutedCopyReaim::Converged
    );
    assert_eq!(
        executed_copy_reaim_outcome(gate, Some(true), false),
        ExecutedCopyReaim::StillForeign
    );
    assert_eq!(
        executed_copy_reaim_outcome(gate, Some(false), false),
        ExecutedCopyReaim::InstallFailed
    );
    assert_eq!(
        executed_copy_reaim_outcome(gate, None, false),
        ExecutedCopyReaim::SpawnFailed
    );
    assert_eq!(
        executed_copy_reaim_gate(
            Some(NonConvergenceKind::ForeignManaged),
            ExecutedCopyAim::NotYetAimed,
            false,
        ),
        ExecutedCopyReaimGate::RefusedNoAim
    );
    assert_eq!(
        executed_copy_reaim_gate(
            Some(NonConvergenceKind::ForeignManaged),
            ExecutedCopyAim::Aimed,
            true,
        ),
        ExecutedCopyReaimGate::RefusedNotDeferred
    );
    assert_eq!(
        executed_copy_reaim_gate(None, ExecutedCopyAim::NotYetAimed, true),
        ExecutedCopyReaimGate::RefusedNotForeign
    );
    assert_eq!(
        ExecutedCopyReaim::StillForeign.telemetry_value(),
        "still-foreign"
    );
}

#[test]
#[cfg(not(target_os = "windows"))]
fn delivered_prefix_shim_for_reports_present_absent_and_unknown() {
    let tmp = tempfile::TempDir::new().unwrap();
    let prefix = tmp.path().join("npm-global");
    std::fs::create_dir_all(prefix.join("bin")).unwrap();
    let prefix_str = prefix.to_string_lossy().to_string();
    let shim = prefix.join("bin").join("hq");

    // Delivered and the shim is a RUNNABLE executable -> present.
    write_executable(&shim, "#!/bin/sh\n");
    assert_eq!(
        delivered_prefix_shim_for(Some(&prefix_str), Some("5.103.27")),
        DeliveredPrefixShim::Present
    );
    // Delivered but the shim is a NON-executable file: resolution skips it, so
    // this is a partial install -> absent, never a false Present that would
    // wedge the marker.
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&shim, std::fs::Permissions::from_mode(0o644)).unwrap();
    }
    assert_eq!(
        delivered_prefix_shim_for(Some(&prefix_str), Some("5.103.27")),
        DeliveredPrefixShim::Absent
    );
    // Delivered but `bin/hq` is a DIRECTORY, not a file -> absent.
    std::fs::remove_file(&shim).unwrap();
    std::fs::create_dir(&shim).unwrap();
    assert_eq!(
        delivered_prefix_shim_for(Some(&prefix_str), Some("5.103.27")),
        DeliveredPrefixShim::Absent
    );
    // Delivered but the shim is missing entirely -> absent (the partial install).
    std::fs::remove_dir(&shim).unwrap();
    assert_eq!(
        delivered_prefix_shim_for(Some(&prefix_str), Some("5.103.27")),
        DeliveredPrefixShim::Absent
    );
    // No prefix, or delivery not proven -> unknown.
    assert_eq!(
        delivered_prefix_shim_for(None, Some("5.103.27")),
        DeliveredPrefixShim::Unknown
    );
    assert_eq!(
        delivered_prefix_shim_for(Some(&prefix_str), None),
        DeliveredPrefixShim::Unknown
    );
}

#[test]
fn foreign_verdict_may_block_only_relaxes_the_foreign_kind() {
    use NonConvergenceKind::*;
    // Non-foreign kinds always "may block" — they never route through this,
    // and no settings-PATH repair value changes that.
    for kind in [
        NpmTargeted,
        ResolutionShortfall,
        InstallerUnaimed,
        ManagedShadowed,
    ] {
        for repair in [
            SettingsPathRepair::NotAttempted,
            SettingsPathRepair::Rewritten,
        ] {
            assert!(foreign_verdict_may_block(
                kind,
                ExecutedCopyAim::NotYetAimed,
                DeliveredPrefixShim::Absent,
                repair,
            ));
        }
    }
    // Foreign + not-yet-aimed OR shim-absent -> must NOT block.
    assert!(!foreign_verdict_may_block(
        ForeignManaged,
        ExecutedCopyAim::NotYetAimed,
        DeliveredPrefixShim::Unknown,
        SettingsPathRepair::NotAttempted,
    ));
    assert!(!foreign_verdict_may_block(
        ForeignManaged,
        ExecutedCopyAim::Undrivable,
        DeliveredPrefixShim::Absent,
        SettingsPathRepair::NotAttempted,
    ));
    // Foreign + aimed/undrivable + shim present/unknown -> blocks as before,
    // UNLESS HQ just rewrote the settings PATH.
    assert!(foreign_verdict_may_block(
        ForeignManaged,
        ExecutedCopyAim::Aimed,
        DeliveredPrefixShim::Present,
        SettingsPathRepair::NotAttempted,
    ));
    assert!(foreign_verdict_may_block(
        ForeignManaged,
        ExecutedCopyAim::Undrivable,
        DeliveredPrefixShim::Unknown,
        SettingsPathRepair::NotAttempted,
    ));
    // A `Rewritten` settings-PATH repair relaxes the block even for the
    // otherwise-blocking Undrivable + present-shim foreign shape — the next
    // resolution reads the rewritten PATH and converges.
    assert!(!foreign_verdict_may_block(
        ForeignManaged,
        ExecutedCopyAim::Undrivable,
        DeliveredPrefixShim::Present,
        SettingsPathRepair::Rewritten,
    ));
    // Every NON-`Rewritten` settings-PATH outcome keeps the block byte-for-byte.
    for repair in [
        SettingsPathRepair::NotAttempted,
        SettingsPathRepair::RefusedNotSettingsLane,
        SettingsPathRepair::RefusedNoManagedCopy,
        SettingsPathRepair::RefusedNotStale,
        SettingsPathRepair::WriteFailed,
    ] {
        assert!(foreign_verdict_may_block(
            ForeignManaged,
            ExecutedCopyAim::Undrivable,
            DeliveredPrefixShim::Present,
            repair,
        ));
    }
}

// ---- settings-PATH foreign shadow (HQ-DESKTOP-46) --------------------

/// A foreign-managed npm context matching the live HQ-DESKTOP-46 shape: the
/// app executes a stale Homebrew `hq` resolved via the settings PATH, while
/// HQ delivered `latest` into its managed npm-global prefix (present shim).
/// `repair` is the settings-PATH repair outcome under test.
fn settings_path_foreign_ctx<'a>(
    repair: SettingsPathRepair,
    managed_roots: &'a [PathBuf],
) -> PostInstallContext<'a> {
    PostInstallContext::npm(
        "/opt/homebrew/bin/hq",
        "/opt/homebrew/bin/hq",
        Some("5.103.30"),
        Some("5.103.30"),
        "5.103.34",
        Some("/Users/x/Library/Application Support/Indigo HQ/toolchain/npm-global"),
        "/Users/x/Library/Application Support/Indigo HQ/toolchain/node/bin/npm",
        false,
        // Delivered `latest` INTO the managed prefix — delivery is proven.
        Some("5.103.34"),
    )
    .with_managed_roots(managed_roots)
    .with_executed_copy_aim(ExecutedCopyAim::Undrivable)
    .with_resolution_telemetry(
        paths::ResolutionSource::SettingsPath,
        DeliveredPrefixShim::Present,
    )
    .with_settings_path(SettingsPathTelemetry {
        repair,
        file: paths::SettingsPathFile::Local,
        managed_bin: ManagedBinInSettingsPath::Absent,
        ..SettingsPathTelemetry::default()
    })
}

#[test]
fn settings_path_repair_gate_only_fires_for_the_settings_lane() {
    use paths::ResolutionSource;
    // The executed copy came from anything but the settings-PATH lane -> a
    // settings-PATH rewrite could not change what resolves, so refuse.
    for lane in [
        ResolutionSource::LoginShell,
        ResolutionSource::ManagedToolchain,
        ResolutionSource::UserPrefix,
        ResolutionSource::SystemPrefix,
        ResolutionSource::NotResolved,
    ] {
        assert_eq!(
            settings_path_repair_gate(lane, Some("5.103.34"), Some("5.103.30")),
            SettingsPathRepairGate::RefusedNotSettingsLane
        );
    }
}

#[test]
fn settings_path_repair_gate_requires_a_runnable_newer_managed_copy() {
    use paths::ResolutionSource::SettingsPath;
    // No runnable managed copy -> refused.
    assert_eq!(
        settings_path_repair_gate(SettingsPath, None, Some("5.103.30")),
        SettingsPathRepairGate::RefusedNoManagedCopy
    );
    // A managed copy STRICTLY newer than the executed copy -> attempt.
    assert_eq!(
        settings_path_repair_gate(SettingsPath, Some("5.103.34"), Some("5.103.30")),
        SettingsPathRepairGate::Attempt
    );
    // Equal or older, or an unreadable executed version, can't be proven
    // stale -> refused (a deliberate same-or-newer foreign copy is left alone).
    for (managed, executed) in [
        (Some("5.103.34"), Some("5.103.34")),
        (Some("5.103.30"), Some("5.103.34")),
        (Some("5.103.34"), None),
    ] {
        assert_eq!(
            settings_path_repair_gate(SettingsPath, managed, executed),
            SettingsPathRepairGate::RefusedNotStale
        );
    }
}

#[test]
fn settings_path_repair_outcome_maps_gate_and_write() {
    use SettingsPathRepairGate as G;
    assert_eq!(
        settings_path_repair_outcome(G::Attempt, true),
        SettingsPathRepair::Rewritten
    );
    assert_eq!(
        settings_path_repair_outcome(G::Attempt, false),
        SettingsPathRepair::WriteFailed
    );
    assert_eq!(
        settings_path_repair_outcome(G::RefusedNotSettingsLane, true),
        SettingsPathRepair::RefusedNotSettingsLane
    );
    assert_eq!(
        settings_path_repair_outcome(G::RefusedNoManagedCopy, true),
        SettingsPathRepair::RefusedNoManagedCopy
    );
    assert_eq!(
        settings_path_repair_outcome(G::RefusedNotStale, true),
        SettingsPathRepair::RefusedNotStale
    );
}

#[test]
fn managed_bin_in_settings_path_classifies_present_absent_unknown() {
    use paths::SettingsPathFile;
    let managed = PathBuf::from("/x/toolchain/npm-global/bin");
    let with = [PathBuf::from("/opt/homebrew/bin"), managed.clone()];
    let without = [PathBuf::from("/opt/homebrew/bin")];
    assert_eq!(
        managed_bin_in_settings_path(SettingsPathFile::Local, &with, &managed),
        ManagedBinInSettingsPath::Present
    );
    assert_eq!(
        managed_bin_in_settings_path(SettingsPathFile::Base, &without, &managed),
        ManagedBinInSettingsPath::Absent
    );
    // No winning file -> Unknown regardless of the dirs.
    assert_eq!(
        managed_bin_in_settings_path(SettingsPathFile::None, &with, &managed),
        ManagedBinInSettingsPath::Unknown
    );
}

#[test]
fn only_a_rewritten_settings_path_repair_relaxes_the_foreign_marker() {
    let roots = [PathBuf::from(
        "/Users/x/Library/Application Support/Indigo HQ/toolchain",
    )];
    // A rewritten repair: still classified ForeignManaged, but NO durable
    // marker (the next resolution reads the rewritten PATH and converges).
    // It stays observable once per episode, not silent.
    let rewritten = decide_post_install(&settings_path_foreign_ctx(
        SettingsPathRepair::Rewritten,
        &roots,
    ));
    assert_eq!(
        rewritten.non_convergence_kind,
        Some(NonConvergenceKind::ForeignManaged)
    );
    assert_eq!(
        rewritten.record_non_convergent, None,
        "a rewritten settings-PATH repair must not wedge auto-update"
    );
    assert!(rewritten.capture.is_some(), "it stays observable once");
    assert!(!rewritten.capture_requires_durable_record);
    // Every OTHER outcome still writes the durable marker exactly as before,
    // so an Aimed-but-still-foreign run and a genuinely undrivable run block.
    for repair in [
        SettingsPathRepair::NotAttempted,
        SettingsPathRepair::RefusedNotSettingsLane,
        SettingsPathRepair::RefusedNoManagedCopy,
        SettingsPathRepair::RefusedNotStale,
        SettingsPathRepair::WriteFailed,
    ] {
        let outcome = decide_post_install(&settings_path_foreign_ctx(repair, &roots));
        assert_eq!(
            outcome.non_convergence_kind,
            Some(NonConvergenceKind::ForeignManaged)
        );
        assert_eq!(
            outcome.record_non_convergent.as_deref(),
            Some("5.103.34"),
            "settings_path_repair={repair:?} must still block"
        );
        assert!(outcome.capture_requires_durable_record);
    }
}

/// The live HQ-DESKTOP-46 event: on the base decision a settings-PATH Homebrew
/// shadow (Undrivable, delivered + present managed shim, SettingsPath lane)
/// writes the durable marker that wedges auto-update. Once HQ rewrites the
/// winning settings file's PATH and the re-resolution lands the managed
/// current copy, the run converges — no marker, no capture.
#[test]
fn the_live_settings_path_shadow_blocks_on_base_and_converges_once_rewritten() {
    let roots = [PathBuf::from(
        "/Users/x/Library/Application Support/Indigo HQ/toolchain",
    )];
    // Pre-repair (NotAttempted): the exact durable marker that wedges the
    // machine forever, one per hq-cli publish.
    let base = decide_post_install(&settings_path_foreign_ctx(
        SettingsPathRepair::NotAttempted,
        &roots,
    ));
    assert_eq!(base.record_non_convergent.as_deref(), Some("5.103.34"));
    assert_eq!(
        base.non_convergence_kind,
        Some(NonConvergenceKind::ForeignManaged)
    );

    // Post-repair: the rewritten PATH now resolves `hq` onto the managed
    // current copy, so the after-version is `latest` — a converged run.
    let converged = PostInstallContext::npm(
        "/opt/homebrew/bin/hq",
        "/Users/x/Library/Application Support/Indigo HQ/toolchain/npm-global/bin/hq",
        Some("5.103.30"),
        Some("5.103.34"),
        "5.103.34",
        Some("/Users/x/Library/Application Support/Indigo HQ/toolchain/npm-global"),
        "/Users/x/Library/Application Support/Indigo HQ/toolchain/node/bin/npm",
        false,
        Some("5.103.34"),
    )
    .with_managed_roots(&roots)
    .with_settings_path(SettingsPathTelemetry {
        repair: SettingsPathRepair::Rewritten,
        file: paths::SettingsPathFile::Local,
        managed_bin: ManagedBinInSettingsPath::Present,
        ..SettingsPathTelemetry::default()
    });
    let outcome = decide_post_install(&converged);
    assert!(matches!(
        outcome.verdict,
        ConvergenceVerdict::Converged | ConvergenceVerdict::RelocatedAndConverged
    ));
    assert_eq!(outcome.record_non_convergent, None);
    assert!(outcome.clear_non_convergent);
    assert!(
        outcome.capture.is_none(),
        "a converged run captures nothing"
    );
}

/// Regression (PR #512 review): a real hq-cli whose pnpm store sits beside a
/// shim in a directory literally named `bin` (a flat custom PNPM_HOME) must
/// stay VERSION-READABLE even though the collapsed router now drives it with
/// npm. Version reading is decoupled from routing precisely so the provenance
/// gate in `install_executor_for_hq_bin` does not refuse it as unidentifiable
/// and disable its update.
#[test]
fn a_pnpm_store_beside_a_bin_named_shim_stays_version_readable_and_installable() {
    let tmp = tempfile::TempDir::new().unwrap();
    // Flat custom PNPM_HOME whose last component is literally `bin`.
    let home = tmp.path().join("tools").join("bin");
    let hq = home.join("hq");
    let pkg = home
        .join("global")
        .join("5")
        .join("node_modules")
        .join("@indigoai-us")
        .join("hq-cli");
    std::fs::create_dir_all(&pkg).unwrap();
    std::fs::write(&hq, "#!/bin/sh\n").unwrap();
    std::fs::write(
        pkg.join("package.json"),
        br#"{"name":"@indigoai-us/hq-cli","version":"5.103.18"}"#,
    )
    .unwrap();

    // The collapsed router sends this shape to npm (pnpm home not derivable
    // from the shim), consistent with the primary fix.
    assert!(!is_pnpm_global_shim(&hq.to_string_lossy()));
    // But its version is still read from the pnpm store beside the shim, so
    // the provenance gate passes and the executor is Npm — never a refusal.
    assert_eq!(version_from_hq_binary(&hq).as_deref(), Some("5.103.18"));
    assert_eq!(install_executor_for_hq_bin(&hq), Some(InstallExecutor::Npm));
}

/// The self-naming telemetry source: an npx-cache path reports `npx-cache`,
/// not the `login-shell` catch-all it masqueraded as before.
#[test]
fn bin_resolution_source_names_an_npx_cache_path() {
    assert_eq!(
        bin_resolution_source("/Users/z/.npm/_npx/91dc460cc0784cc8/node_modules/.bin/hq"),
        "npx-cache"
    );
    // A non-npx absolute path is never mislabeled as npx-cache. The exact
    // source of `/opt/homebrew/bin/hq` is platform-specific (`homebrew` on
    // Unix, `unknown` on Windows where that branch is cfg'd out), so assert
    // the invariant that survives both.
    assert_ne!(bin_resolution_source("/opt/homebrew/bin/hq"), "npx-cache");
}

/// Every foreign-managed layout in the 31-event history classifies the same
/// way, so a fix validated against the one observed pnpm ≥11 machine cannot
/// silently special-case it.
#[test]
fn non_convergence_classification_covers_every_observed_layout() {
    for hq_bin in [
        "/Users/t/Library/pnpm/hq",
        "/Users/t/Library/pnpm/bin/hq",
        "/home/t/.local/share/pnpm/hq",
        "/Users/t/.asdf/shims/hq",
        "/Users/t/Library/Application Support/Indigo HQ/toolchain/npm-global/bin/hq",
    ] {
        // npm with no prefix passed is foreign-managed for every one of
        // them: npm has nowhere safe to aim. Delivery evidence is irrelevant
        // — the prefix never matched, so it never reaches the delivery gate.
        assert_eq!(
            non_convergence_kind(InstallExecutor::Npm, None, false, hq_bin, false, &[]),
            NonConvergenceKind::ForeignManaged,
            "npm/{hq_bin}"
        );
        // pnpm aimed from the resolved shim AND the target delivered into
        // pnpm's store, yet the shim is stale: genuine shadowing. The native
        // `pnpm bin -g` direction is no longer an input — delivery evidence
        // plus the executed reading decide this class.
        assert_eq!(
            non_convergence_kind(InstallExecutor::Pnpm, None, true, hq_bin, true, &[]),
            NonConvergenceKind::PnpmTargeted,
            "pnpm-targeted/{hq_bin}"
        );
        // Aimed at the right home but the target was never delivered: a
        // transient resolution shortfall, exactly like the npm arm.
        assert_eq!(
            non_convergence_kind(InstallExecutor::Pnpm, None, true, hq_bin, false, &[]),
            NonConvergenceKind::ResolutionShortfall,
            "pnpm-shortfall/{hq_bin}"
        );
        // Not aimed at all (underivable / PATH without the shim dir): the
        // ambient-spawn unaimed shape — observable but non-blocking, never
        // the foreign-managed durable block it used to be.
        assert_eq!(
            non_convergence_kind(InstallExecutor::Pnpm, None, false, hq_bin, false, &[]),
            NonConvergenceKind::InstallerUnaimed,
            "pnpm-untargeted/{hq_bin}"
        );
    }
    // An npm prefix that matches the post-install binary's own prefix is the
    // one genuinely npm-targeted shape — but only WITH delivery evidence.
    assert_eq!(
        non_convergence_kind(
            InstallExecutor::Npm,
            Some("/Users/t/.npm-global"),
            false,
            "/Users/t/.npm-global/bin/hq",
            true,
            &[],
        ),
        NonConvergenceKind::NpmTargeted
    );
}

/// The exact Windows shape all 12 HQ-DESKTOP-46 events carry: npm delivered
/// `latest` into `<root>\npm-prefix`, yet the app still resolves the stale
/// `<root>\node\hq.cmd`. Both prefixes live in the SAME managed toolchain
/// root, so this is a repairable managed shadow — NOT the foreign layout the
/// base misclassifies it as. The pre-repair decision writes NO durable marker
/// (so the next check self-heals) and its detail carries neither misleading
/// phrase the base copy showed.
#[test]
fn the_observed_windows_managed_shadow_shape_classifies_managed_shadowed() {
    let roots = [PathBuf::from("/opt/IndigoHQ/toolchain")];
    let npm_prefix = "/opt/IndigoHQ/toolchain/npm-prefix";
    let after_bin = "/opt/IndigoHQ/toolchain/node/hq.cmd";
    // Classification is pure: the same field shape, decided directly.
    assert_eq!(
        non_convergence_kind(
            InstallExecutor::Npm,
            Some(npm_prefix),
            false,
            after_bin,
            true,
            &roots,
        ),
        NonConvergenceKind::ManagedShadowed,
    );
    let outcome = decide_post_install(
        &PostInstallContext::npm(
            after_bin,
            after_bin,
            Some("5.101.0"),
            Some("5.101.0"),
            "5.101.7",
            Some(npm_prefix),
            "/opt/IndigoHQ/toolchain/node/npm.cmd",
            false,
            Some("5.101.7"),
        )
        .with_managed_roots(&roots),
    );
    assert_eq!(
        outcome.non_convergence_kind,
        Some(NonConvergenceKind::ManagedShadowed)
    );
    assert_eq!(
        outcome.record_non_convergent, None,
        "a repairable first episode must not wedge auto-update"
    );
    let detail = outcome.result.clone().unwrap_err();
    assert!(!detail.contains("managed outside npm's global prefix"));
    assert!(!detail.contains("Update it with the tool that installed it"));
    assert!(
        outcome.capture.is_some(),
        "the shadow stays observable once"
    );
    assert_eq!(
        outcome.capture.as_ref().unwrap().managed_shadow_repair,
        ManagedShadowRepairOutcome::NotAttempted
    );
}

/// Narrowness: a delivered target in the managed prefix but a resolved `hq`
/// OUTSIDE every managed root (Homebrew, `/usr/local`, a pnpm home) is not a
/// shadow HQ can repair — it stays foreign-managed and DOES record the durable
/// marker on its first episode, exactly as today.
#[test]
fn a_resolved_bin_outside_every_managed_root_stays_foreign_managed() {
    let roots = [PathBuf::from("/opt/IndigoHQ/toolchain")];
    for after_bin in [
        "/opt/homebrew/bin/hq",
        "/usr/local/bin/hq",
        "/Users/t/Library/pnpm/hq",
    ] {
        let outcome = decide_post_install(
            &PostInstallContext::npm(
                after_bin,
                after_bin,
                Some("5.101.0"),
                Some("5.101.0"),
                "5.101.7",
                Some("/opt/IndigoHQ/toolchain/npm-prefix"),
                "/opt/IndigoHQ/toolchain/node/npm.cmd",
                false,
                Some("5.101.7"),
            )
            .with_managed_roots(&roots),
        );
        assert_eq!(
            outcome.non_convergence_kind,
            Some(NonConvergenceKind::ForeignManaged),
            "{after_bin}"
        );
        assert_eq!(
            outcome.record_non_convergent.as_deref(),
            Some("5.101.7"),
            "a foreign first episode still blocks: {after_bin}"
        );
    }
}

/// A cross-root split — prefix under the current `IndigoHQ` root, resolved bin
/// under the LEGACY `Indigo HQ` root — is two different roots, so it is NOT one
/// repairable shadow and stays foreign-managed.
#[test]
fn a_cross_root_split_is_not_a_single_managed_shadow() {
    let roots = [
        PathBuf::from("/opt/IndigoHQ/toolchain"),
        PathBuf::from("/opt/Indigo HQ/toolchain"),
    ];
    assert_eq!(
        non_convergence_kind(
            InstallExecutor::Npm,
            Some("/opt/IndigoHQ/toolchain/npm-prefix"),
            false,
            "/opt/Indigo HQ/toolchain/node/hq.cmd",
            true,
            &roots,
        ),
        NonConvergenceKind::ForeignManaged,
    );
}

/// The same same-root prefixes, but the installer did NOT deliver the target
/// into the managed prefix: without delivery evidence this is not a proven
/// shadow and must not be treated as one.
#[test]
fn the_shadow_shape_without_delivery_evidence_is_not_a_managed_shadow() {
    let roots = [PathBuf::from("/opt/IndigoHQ/toolchain")];
    assert_eq!(
        non_convergence_kind(
            InstallExecutor::Npm,
            Some("/opt/IndigoHQ/toolchain/npm-prefix"),
            false,
            "/opt/IndigoHQ/toolchain/node/hq.cmd",
            false,
            &roots,
        ),
        NonConvergenceKind::ForeignManaged,
    );
}

fn write_hq_cli_pkg(dir: &Path, version: &str) {
    let pkg_dir = dir.join("node_modules").join("@indigoai-us").join("hq-cli");
    std::fs::create_dir_all(&pkg_dir).unwrap();
    std::fs::write(
        pkg_dir.join("package.json"),
        format!(r#"{{"name":"@indigoai-us/hq-cli","version":"{version}"}}"#),
    )
    .unwrap();
}

/// A realistic npm-generated shim body: it names the scoped package path, so
/// the repair's per-shim ownership check recognizes it as HQ's own.
const HQ_CLI_SHIM_FIXTURE: &str =
    "@ECHO off\r\n\"%~dp0\\node_modules\\@indigoai-us\\hq-cli\\dist\\index.js\" %*\r\n";

fn write_hq_shim(path: &Path) {
    std::fs::write(path, HQ_CLI_SHIM_FIXTURE).unwrap();
}

/// The repair removes exactly the HQ_CLI_BIN_NAMES shims and the scoped
/// package directory in the shadow dir, and leaves node.exe, npm.cmd, and an
/// unrelated global package byte-for-byte intact — plus the fresh managed
/// copy in the prefix.
#[test]
fn repair_removes_the_managed_shadow_and_spares_node_and_npm() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let node = root.join("node");
    let prefix = root.join("npm-prefix");
    std::fs::create_dir_all(&node).unwrap();
    std::fs::create_dir_all(&prefix).unwrap();
    write_hq_shim(&node.join("hq.cmd"));
    write_hq_shim(&node.join("hq.ps1"));
    write_hq_shim(&node.join("hq-auth-refresh.cmd"));
    write_hq_cli_pkg(&node, "5.101.0");
    write_hq_cli_pkg(&prefix, "5.101.7");
    write_hq_shim(&prefix.join("hq.cmd"));
    // Bystanders that must survive the repair untouched.
    std::fs::write(node.join("node.exe"), "node").unwrap();
    std::fs::write(node.join("npm.cmd"), "npm").unwrap();
    let unrelated = node.join("node_modules").join("left-pad");
    std::fs::create_dir_all(&unrelated).unwrap();
    std::fs::write(unrelated.join("package.json"), "{}").unwrap();

    let action = repair_managed_shadow(&node.join("hq.cmd"), &prefix, "5.101.7");
    assert_eq!(action, ManagedShadowRepairAction::Removed);
    assert!(!node.join("hq.cmd").exists(), "stale shim removed");
    assert!(!node.join("hq.ps1").exists(), "stale ps1 removed");
    assert!(
        !node.join("hq-auth-refresh.cmd").exists(),
        "the second declared bin shim is removed too"
    );
    assert!(
        !node
            .join("node_modules")
            .join("@indigoai-us")
            .join("hq-cli")
            .exists(),
        "stale package removed"
    );
    assert!(node.join("node.exe").exists(), "node.exe survives");
    assert!(node.join("npm.cmd").exists(), "npm.cmd survives");
    assert!(
        unrelated.join("package.json").exists(),
        "an unrelated global package survives"
    );
    assert!(
        prefix.join("hq.cmd").exists(),
        "the fresh managed copy is never touched"
    );
}

/// Build the unix managed-toolchain layout npm ACTUALLY lays down and return
/// `(node_prefix, node_bin, npm_global)`: `<node>/bin/hq` is a SYMLINK into
/// `<node>/lib/node_modules/@indigoai-us/hq-cli/dist/index.js`, whose bytes
/// name NEITHER token (matching the real package), and the fresh copy lives in
/// `<npm_global>/lib/node_modules/...`.
#[cfg(unix)]
fn build_unix_managed_shadow(root: &Path, shadow_version: &str, prefix_version: &str) {
    use std::os::unix::fs::symlink;
    let node = root.join("node");
    let node_bin = node.join("bin");
    let shadow_pkg = node
        .join("lib")
        .join("node_modules")
        .join("@indigoai-us")
        .join("hq-cli");
    std::fs::create_dir_all(shadow_pkg.join("dist").join("bin")).unwrap();
    std::fs::create_dir_all(&node_bin).unwrap();
    std::fs::write(
        shadow_pkg.join("package.json"),
        format!(
            r#"{{"name":"@indigoai-us/hq-cli","version":"{shadow_version}","bin":{{"hq":"dist/index.js","hq-auth-refresh":"dist/bin/hq-auth-refresh.js"}}}}"#
        ),
    )
    .unwrap();
    // A real hq-cli entrypoint names neither '@indigoai-us' nor 'hq-cli' in
    // its bytes, so the content-only ownership grep fails on a genuine shim.
    std::fs::write(
        shadow_pkg.join("dist").join("index.js"),
        "#!/usr/bin/env node\nrequire('./cli.js');\n",
    )
    .unwrap();
    std::fs::write(
        shadow_pkg
            .join("dist")
            .join("bin")
            .join("hq-auth-refresh.js"),
        "#!/usr/bin/env node\nrequire('../auth.js');\n",
    )
    .unwrap();
    symlink(
        shadow_pkg.join("dist").join("index.js"),
        node_bin.join("hq"),
    )
    .unwrap();
    symlink(
        shadow_pkg
            .join("dist")
            .join("bin")
            .join("hq-auth-refresh.js"),
        node_bin.join("hq-auth-refresh"),
    )
    .unwrap();
    // The managed toolchain's own Node runtime binaries — bystanders.
    for keep in ["node", "npm", "npx"] {
        std::fs::write(node_bin.join(keep), keep).unwrap();
    }
    // The fresh copy npm delivered into the managed npm prefix.
    let prefix_pkg = root
        .join("npm-global")
        .join("lib")
        .join("node_modules")
        .join("@indigoai-us")
        .join("hq-cli");
    std::fs::create_dir_all(&prefix_pkg).unwrap();
    std::fs::write(
        prefix_pkg.join("package.json"),
        format!(r#"{{"name":"@indigoai-us/hq-cli","version":"{prefix_version}"}}"#),
    )
    .unwrap();
}

/// The Sonia recurrence (the macOS reopen): the unix managed-toolchain layout
/// npm actually lays down — `<root>/node/bin/hq` a SYMLINK into
/// `<root>/node/lib/node_modules/@indigoai-us/hq-cli/dist/index.js`, the fresh
/// copy under `<root>/npm-global`. The layout-aware repair derives the prefix
/// from the shim (`<root>/node`), proves ownership via the symlink target, and
/// removes exactly HQ's shims and package. On the base commit the repair reads
/// the prefix as the shim's parent (`<root>/node/bin`), finds no manifest
/// there, and the followed symlink names neither token, so it refuses and the
/// stale shim survives.
#[cfg(unix)]
#[test]
fn the_unix_managed_toolchain_shadow_is_repaired_from_the_derived_prefix() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    build_unix_managed_shadow(root, "5.98.0", "5.103.20");
    let node_bin = root.join("node").join("bin");
    let npm_global = root.join("npm-global");

    let action = repair_managed_shadow(&node_bin.join("hq"), &npm_global, "5.103.20");
    assert_eq!(action, ManagedShadowRepairAction::Removed);
    assert!(
        std::fs::symlink_metadata(node_bin.join("hq")).is_err(),
        "the stale hq symlink is removed"
    );
    assert!(
        std::fs::symlink_metadata(node_bin.join("hq-auth-refresh")).is_err(),
        "the second declared bin shim is removed too"
    );
    assert!(
        !root
            .join("node")
            .join("lib")
            .join("node_modules")
            .join("@indigoai-us")
            .join("hq-cli")
            .exists(),
        "the shadow package is removed from the DERIVED prefix, not the shim dir"
    );
    for keep in ["node", "npm", "npx"] {
        assert!(node_bin.join(keep).exists(), "managed {keep} survives");
    }
    assert!(
        npm_global
            .join("lib")
            .join("node_modules")
            .join("@indigoai-us")
            .join("hq-cli")
            .exists(),
        "the fresh managed copy is never touched"
    );
}

/// A symlinked `hq` that points OUTSIDE the derived prefix's hq-cli package is
/// never HQ's own shim: the repair refuses and removes nothing, even though a
/// real hq-cli manifest sits in the prefix. Guards the broadened symlink
/// ownership rule against deleting an unrelated command.
#[cfg(unix)]
#[test]
fn a_symlinked_shim_pointing_outside_the_hq_cli_package_is_refused() {
    use std::os::unix::fs::symlink;
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    build_unix_managed_shadow(root, "5.98.0", "5.103.20");
    let node_bin = root.join("node").join("bin");
    // Repoint the resolved shim at an unrelated command outside the package —
    // and make its target CONTENT name the scoped package, the exact shape a
    // content-only ownership check (which follows the symlink) would wrongly
    // accept and unlink. Containment must refuse it regardless of content.
    let elsewhere = root.join("elsewhere");
    std::fs::create_dir_all(&elsewhere).unwrap();
    std::fs::write(
        elsewhere.join("other"),
        "#!/bin/sh\n# an unrelated wrapper that merely mentions @indigoai-us/hq-cli\n",
    )
    .unwrap();
    std::fs::remove_file(node_bin.join("hq")).unwrap();
    symlink(elsewhere.join("other"), node_bin.join("hq")).unwrap();

    let action = repair_managed_shadow(&node_bin.join("hq"), &root.join("npm-global"), "5.103.20");
    assert_eq!(action, ManagedShadowRepairAction::ProvenanceRefused);
    assert!(
        std::fs::symlink_metadata(node_bin.join("hq")).is_ok(),
        "a symlink outside the package is left in place"
    );
    assert!(
        root.join("node")
            .join("lib")
            .join("node_modules")
            .join("@indigoai-us")
            .join("hq-cli")
            .exists(),
        "nothing is removed when ownership is refused"
    );
}

/// A shadow whose shim maps to no derivable npm prefix (a bare name, or a
/// parent that is not a recognised npm bin dir) is refused: HQ will not guess a
/// prefix to delete from.
#[cfg(unix)]
#[test]
fn a_shadow_whose_prefix_is_underivable_is_refused() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    build_unix_managed_shadow(root, "5.98.0", "5.103.20");
    // A bare name has no directory to derive a prefix from.
    assert_eq!(
        repair_managed_shadow(Path::new("hq"), &root.join("npm-global"), "5.103.20"),
        ManagedShadowRepairAction::ProvenanceRefused
    );
}

/// Gate 2 still holds on the unix layout: when the managed prefix does not yet
/// hold `>= latest`, the repair refuses so the shadow removal cannot strand the
/// user without a current copy.
#[cfg(unix)]
#[test]
fn a_managed_prefix_below_latest_still_refuses_the_unix_repair() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    build_unix_managed_shadow(root, "5.98.0", "5.103.19");
    let node_bin = root.join("node").join("bin");
    let action = repair_managed_shadow(&node_bin.join("hq"), &root.join("npm-global"), "5.103.20");
    assert_eq!(action, ManagedShadowRepairAction::ProvenanceRefused);
    assert!(
        std::fs::symlink_metadata(node_bin.join("hq")).is_ok(),
        "nothing is removed when the good copy is not yet in place"
    );
}

/// If a shim cannot be removed (a Windows sharing violation, an antivirus
/// lock), the package must NOT be deleted — a surviving shim pointing at a
/// removed package would brick a runnable CLI. The repair leaves everything in
/// place and reports RemovalFailed.
#[cfg(unix)]
#[test]
fn repair_aborts_package_removal_when_a_shim_cannot_be_removed() {
    use std::os::unix::fs::PermissionsExt;
    let tmp = tempfile::tempdir().unwrap();
    let node = tmp.path().join("node");
    let prefix = tmp.path().join("npm-prefix");
    std::fs::create_dir_all(&node).unwrap();
    std::fs::create_dir_all(&prefix).unwrap();
    write_hq_shim(&node.join("hq.cmd"));
    write_hq_cli_pkg(&node, "5.101.0");
    write_hq_cli_pkg(&prefix, "5.101.7");
    // Make the shim's directory read-only so unlinking the shim fails.
    std::fs::set_permissions(&node, std::fs::Permissions::from_mode(0o555)).unwrap();

    let action = repair_managed_shadow(&node.join("hq.cmd"), &prefix, "5.101.7");

    // Restore write so temp-dir cleanup and the assertions can read the tree.
    std::fs::set_permissions(&node, std::fs::Permissions::from_mode(0o755)).unwrap();

    assert_eq!(action, ManagedShadowRepairAction::RemovalFailed);
    assert!(
        node.join("hq.cmd").exists(),
        "a shim that could not be removed is left in place"
    );
    assert!(
        node.join("node_modules")
            .join("@indigoai-us")
            .join("hq-cli")
            .join("package.json")
            .exists(),
        "the package is NOT deleted while a shim removal failed, so the CLI stays runnable"
    );
}

/// A user-placed command that merely shares the `hq` name inside the managed
/// directory (its content does NOT name the package) is never removed, even
/// when a real hq-cli manifest sits beside it.
#[test]
fn repair_never_removes_a_shim_whose_content_is_not_hq_cli() {
    let tmp = tempfile::tempdir().unwrap();
    let node = tmp.path().join("node");
    let prefix = tmp.path().join("npm-prefix");
    std::fs::create_dir_all(&node).unwrap();
    std::fs::create_dir_all(&prefix).unwrap();
    std::fs::write(node.join("hq.cmd"), "@echo off\r\necho not hq\r\n").unwrap();
    write_hq_cli_pkg(&node, "5.101.0");
    write_hq_cli_pkg(&prefix, "5.101.7");

    let action = repair_managed_shadow(&node.join("hq.cmd"), &prefix, "5.101.7");
    assert_eq!(action, ManagedShadowRepairAction::ProvenanceRefused);
    assert!(
        node.join("hq.cmd").exists(),
        "an unowned command is never removed"
    );
    assert!(
        node.join("node_modules")
            .join("@indigoai-us")
            .join("hq-cli")
            .exists(),
        "the package beside an unowned command is left intact"
    );
}

/// The repair refuses (removes nothing) when the shadow's own manifest is not
/// @indigoai-us/hq-cli — an unrelated command named `hq` is never removed.
#[test]
fn repair_refuses_when_the_shadow_is_not_hq_cli() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let node = root.join("node");
    let prefix = root.join("npm-prefix");
    std::fs::create_dir_all(&node).unwrap();
    std::fs::create_dir_all(&prefix).unwrap();
    std::fs::write(node.join("hq.cmd"), "some other hq").unwrap();
    let other = node
        .join("node_modules")
        .join("@indigoai-us")
        .join("hq-cli");
    std::fs::create_dir_all(&other).unwrap();
    std::fs::write(
        other.join("package.json"),
        r#"{"name":"some-other-hq","version":"9.9.9"}"#,
    )
    .unwrap();
    write_hq_cli_pkg(&prefix, "5.101.7");
    let action = repair_managed_shadow(&node.join("hq.cmd"), &prefix, "5.101.7");
    assert_eq!(action, ManagedShadowRepairAction::ProvenanceRefused);
    assert!(
        node.join("hq.cmd").exists(),
        "an unowned shim is never removed"
    );
}

/// The repair refuses when the managed prefix does not yet hold `>= latest`:
/// removing the shadow would strand the user without a current copy.
#[test]
fn repair_refuses_when_the_managed_prefix_lacks_latest() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let node = root.join("node");
    let prefix = root.join("npm-prefix");
    std::fs::create_dir_all(&node).unwrap();
    std::fs::create_dir_all(&prefix).unwrap();
    std::fs::write(node.join("hq.cmd"), "stale").unwrap();
    write_hq_cli_pkg(&node, "5.101.0");
    write_hq_cli_pkg(&prefix, "5.101.0");
    let action = repair_managed_shadow(&node.join("hq.cmd"), &prefix, "5.101.7");
    assert_eq!(action, ManagedShadowRepairAction::ProvenanceRefused);
    assert!(
        node.join("hq.cmd").exists(),
        "nothing is removed when the good copy is not in place"
    );
}

/// After a repair that could not converge, the managed shadow falls back to
/// the foreign-managed policy — the durable marker AND a capture — tagged with
/// the repair outcome so triage can tell "not repairable" from "not attempted".
#[test]
fn a_repair_that_did_not_converge_writes_the_marker_and_reports_the_outcome() {
    let roots = [PathBuf::from("/opt/IndigoHQ/toolchain")];
    let after_bin = "/opt/IndigoHQ/toolchain/node/hq.cmd";
    for repair in [
        ManagedShadowRepairOutcome::RepairFailed,
        ManagedShadowRepairOutcome::ProvenanceRefused,
    ] {
        let outcome = decide_post_install(
            &PostInstallContext::npm(
                after_bin,
                after_bin,
                Some("5.101.0"),
                Some("5.101.0"),
                "5.101.7",
                Some("/opt/IndigoHQ/toolchain/npm-prefix"),
                "/opt/IndigoHQ/toolchain/node/npm.cmd",
                false,
                Some("5.101.7"),
            )
            .with_managed_roots(&roots)
            .with_managed_shadow_repair(repair),
        );
        assert_eq!(
            outcome.non_convergence_kind,
            Some(NonConvergenceKind::ManagedShadowed)
        );
        assert_eq!(
            outcome.record_non_convergent.as_deref(),
            Some("5.101.7"),
            "{repair:?} falls back to the durable marker"
        );
        assert!(outcome.capture_requires_durable_record);
        assert_eq!(
            outcome.capture.as_ref().unwrap().managed_shadow_repair,
            repair
        );
    }
}

/// A repair that converged: the re-decide sees `latest` at the resolved copy,
/// so the verdict is a plain relocated-success that CLEARS the marker and emits
/// no non-convergent capture at all.
#[test]
fn a_converged_managed_shadow_repair_is_a_success_that_clears_the_marker() {
    let roots = [PathBuf::from("/opt/IndigoHQ/toolchain")];
    let after_bin = "/opt/IndigoHQ/toolchain/npm-prefix/hq.cmd";
    let outcome = decide_post_install(
        &PostInstallContext::npm(
            "/opt/IndigoHQ/toolchain/node/hq.cmd",
            after_bin,
            Some("5.101.0"),
            Some("5.101.7"),
            "5.101.7",
            Some("/opt/IndigoHQ/toolchain/npm-prefix"),
            "/opt/IndigoHQ/toolchain/node/npm.cmd",
            false,
            Some("5.101.7"),
        )
        .with_managed_roots(&roots)
        .with_managed_shadow_repair(ManagedShadowRepairOutcome::Converged),
    );
    assert!(outcome.clear_non_convergent);
    assert!(outcome.non_convergence_kind.is_none());
    assert!(outcome.capture.is_none());
    assert_eq!(outcome.record_non_convergent, None);
    assert!(outcome.result.is_ok());
}

/// The classifier defect at the heart of the regression: with the binary
/// unmoved, `npm_prefix_passed == npm_prefix_from_hq_bin(after_bin)` is a
/// tautology, so the same prefix that "proves" targeting is derived from the
/// same path. Delivery evidence is what breaks the tautology — the loud,
/// blocking `NpmTargeted` now requires the target to actually be present in
/// the prefix; without it the same inputs are a non-blocking shortfall.
#[test]
fn npm_targeted_requires_delivery_evidence_and_is_no_longer_a_prefix_tautology() {
    let prefix = "/Users/t/.npm-global";
    let hq_bin = "/Users/t/.npm-global/bin/hq";
    // Same tautological (prefix, bin) pair, opposite delivery evidence.
    assert_eq!(
        non_convergence_kind(InstallExecutor::Npm, Some(prefix), false, hq_bin, true, &[]),
        NonConvergenceKind::NpmTargeted,
        "delivered target in a matching prefix is genuine shadowing"
    );
    assert_eq!(
        non_convergence_kind(
            InstallExecutor::Npm,
            Some(prefix),
            false,
            hq_bin,
            false,
            &[]
        ),
        NonConvergenceKind::ResolutionShortfall,
        "an undelivered target in a matching prefix is a resolution shortfall"
    );
    // Only the loud class blocks; the shortfall never disables auto-update.
    assert!(NonConvergenceKind::NpmTargeted.may_block_auto_update());
    assert!(!NonConvergenceKind::ResolutionShortfall.may_block_auto_update());
    assert!(!NonConvergenceKind::ResolutionShortfall.is_installer_targeted());
    assert_eq!(
        NonConvergenceKind::ResolutionShortfall.telemetry_value(),
        "resolution-shortfall"
    );
}

/// The npm remedy ("update it with the tool that installed it") is a dead
/// end when the app just ran that tool. The pnpm message must differ while
/// keeping the marker the Settings UI keys on to displace the generic
/// copy-the-command text.
#[test]
fn pnpm_non_convergent_detail_has_its_own_remedy_and_keeps_the_ui_marker() {
    let hq_bin = "~/Library/pnpm/bin/hq";
    let pnpm_detail =
        non_convergent_detail(InstallExecutor::Pnpm, hq_bin, Some("5.93.0"), "5.94.1");
    assert!(pnpm_detail.starts_with(NON_CONVERGENT_ERROR_PREFIX));
    assert!(pnpm_detail.contains(hq_bin));
    assert!(pnpm_detail.contains("5.93.0") && pnpm_detail.contains("5.94.1"));
    assert!(
        !pnpm_detail.contains("Update it with the tool that installed it"),
        "the npm remedy is a dead end for a run pnpm itself performed"
    );
    assert!(pnpm_detail.contains("pnpm bin -g"));

    let npm_detail = non_convergent_detail(InstallExecutor::Npm, hq_bin, Some("5.93.0"), "5.94.1");
    assert!(npm_detail.starts_with(NON_CONVERGENT_ERROR_PREFIX));
    assert_ne!(npm_detail, pnpm_detail);

    // An unreadable local version must still produce a usable sentence.
    let unreadable = non_convergent_detail(InstallExecutor::Pnpm, hq_bin, None, "5.94.1");
    assert!(unreadable.contains("an unreadable version"));
}

/// The bounded pnpm summary is the extra that has to survive the org
/// scrubber which reduced `npm_stderr` to `[Filtered]`. It carries closed
/// categories, booleans and lengths — never pnpm's output itself.
#[test]
fn pnpm_diagnostics_summary_is_closed_and_carries_no_output_text() {
    let summary = PnpmRunDiagnostics {
        home_source: PnpmHomeSource::NestedBinDir,
        home_env_present: true,
        path_has_shim_dir: false,
        global_bin_dir_matches_shim_dir: Some(false),
        store_family: PnpmStoreFamily::V11,
        authoritative_query_ok: true,
        exit_status: "0".to_string(),
        output_len: 1024,
    }
    .summary();
    assert_eq!(
        summary,
        "home_source=nested-bin-dir home_env_present=true path_has_shim_dir=false \
             global_bin_dir_matches_shim_dir=false store_family=v11 authoritative_query_ok=true \
             exit_status=0 output_len=1024"
    );
    assert!(!summary.contains('/'));

    // The `None` (unprobed) rendering is its own closed value, never a path.
    let unprobed = PnpmRunDiagnostics {
        home_source: PnpmHomeSource::Undetermined,
        home_env_present: false,
        path_has_shim_dir: false,
        global_bin_dir_matches_shim_dir: None,
        store_family: PnpmStoreFamily::Unknown,
        authoritative_query_ok: false,
        exit_status: "0".to_string(),
        output_len: 0,
    }
    .summary();
    assert!(unprobed.contains("global_bin_dir_matches_shim_dir=unprobed"));
    assert!(unprobed.contains("store_family=unknown"));
    assert!(unprobed.contains("authoritative_query_ok=false"));
    assert!(!unprobed.contains('/'));
}

/// The pnpm executor pins the exact resolved version too, so both executors
/// ask the package manager for the same string the app compared against. With
/// no global bin dir passed the argv keeps its historical shape.
#[test]
fn pnpm_install_argv_pins_the_exact_resolved_version() {
    let argv = pnpm_install_argv(Some("5.97.1"), None);
    assert_eq!(
        argv,
        vec![
            "add".to_string(),
            "-g".to_string(),
            "@indigoai-us/hq-cli@5.97.1".to_string(),
        ]
    );
    assert!(
        !argv.iter().any(|arg| arg.ends_with("@latest")),
        "a pinned pnpm install must not request the @latest dist-tag: {argv:?}"
    );
    // The `None` arms keep the dist-tag fallback for versionless callers and
    // add no global-bin-dir flag.
    assert_eq!(
        pnpm_install_argv(None, None),
        vec![
            "add".to_string(),
            "-g".to_string(),
            HQ_CLI_PACKAGE.to_string(),
        ]
    );
}

#[test]
fn bun_global_install_is_detected_and_pins_the_exact_version() {
    assert!(is_bun_global_shim("/Users/test/.bun/bin/hq"));
    assert!(!is_bun_global_shim("/opt/homebrew/bin/hq"));
    assert!(!is_bun_global_shim("/Users/test/.npm-global/bin/hq"));
    assert_eq!(
        bun_install_argv(Some("5.101.2")),
        vec!["add", "-g", "@indigoai-us/hq-cli@5.101.2"]
    );
}

#[test]
fn bun_global_manifest_is_delivery_evidence() {
    let tmp = tempfile::TempDir::new().unwrap();
    let bun_home = tmp.path().join(".bun");
    let package_dir = bun_home.join("install/global/node_modules/@indigoai-us/hq-cli");
    std::fs::create_dir_all(&package_dir).unwrap();
    std::fs::write(
        package_dir.join("package.json"),
        br#"{"name":"@indigoai-us/hq-cli","version":"5.101.2"}"#,
    )
    .unwrap();

    assert_eq!(
        installed_hq_cli_version_in_bun_global(&bun_home).as_deref(),
        Some("5.101.2")
    );
}

#[cfg(unix)]
#[test]
fn install_executor_accepts_bun_and_homebrew_npm_but_rejects_unrelated_hq() {
    use std::os::unix::fs::symlink;

    let tmp = tempfile::TempDir::new().unwrap();
    let bun_home = tmp.path().join(".bun");
    let bun_bin = bun_home.join("bin");
    let bun_package = bun_home.join("install/global/node_modules/@indigoai-us/hq-cli");
    std::fs::create_dir_all(&bun_bin).unwrap();
    std::fs::create_dir_all(&bun_package).unwrap();
    std::fs::write(bun_bin.join("hq"), b"#!/bin/sh\n").unwrap();
    std::fs::write(
        bun_package.join("package.json"),
        br#"{"name":"@indigoai-us/hq-cli","version":"5.101.2"}"#,
    )
    .unwrap();
    assert_eq!(
        install_executor_for_hq_bin(&bun_bin.join("hq")),
        Some(InstallExecutor::Bun)
    );

    let brew_npm_prefix = tmp.path().join("homebrew-npm");
    let brew_npm_package = brew_npm_prefix.join("lib/node_modules/@indigoai-us/hq-cli");
    let brew_npm_bin = brew_npm_prefix.join("bin");
    std::fs::create_dir_all(&brew_npm_package).unwrap();
    std::fs::create_dir_all(&brew_npm_bin).unwrap();
    std::fs::write(
        brew_npm_package.join("package.json"),
        br#"{"name":"@indigoai-us/hq-cli","version":"5.101.2"}"#,
    )
    .unwrap();
    std::fs::write(brew_npm_package.join("index.js"), b"#!/usr/bin/env node\n").unwrap();
    symlink(brew_npm_package.join("index.js"), brew_npm_bin.join("hq")).unwrap();
    assert_eq!(
        install_executor_for_hq_bin(&brew_npm_bin.join("hq")),
        Some(InstallExecutor::Npm)
    );

    let brew_prefix = tmp.path().join("homebrew");
    let unrelated_package = brew_prefix.join("Cellar/hq/1.2.2");
    let brew_bin = brew_prefix.join("bin");
    std::fs::create_dir_all(&unrelated_package).unwrap();
    std::fs::create_dir_all(&brew_bin).unwrap();
    std::fs::write(unrelated_package.join("hq"), b"#!/bin/sh\n").unwrap();
    std::fs::write(
        unrelated_package.join("package.json"),
        br#"{"name":"hq","version":"1.2.2"}"#,
    )
    .unwrap();
    symlink(unrelated_package.join("hq"), brew_bin.join("hq")).unwrap();
    assert_eq!(install_executor_for_hq_bin(&brew_bin.join("hq")), None);
}

/// The core of the r2 fix: pnpm must be aimed at the directory that actually
/// holds the resolved shim. On unmodified main `pnpm_install_argv` took only a
/// version and never emitted `--config.global-bin-dir`, so the child pnpm
/// resolved a different global bin dir than the app did — this fails there for
/// the right reason.
#[test]
fn pnpm_install_is_aimed_at_the_directory_holding_the_resolved_shim() {
    // Nested pnpm >=11 layout: `<H>/bin/hq`. The home is the grandparent,
    // but the shim — and therefore the dir pnpm must write — is `<H>/bin`.
    let nested = pnpm_global_env("/Users/t/Library/pnpm/bin/hq").expect("nested layout");
    assert_eq!(nested.global_bin_dir, "/Users/t/Library/pnpm/bin");
    let nested_argv = pnpm_install_argv(Some("5.97.2"), Some(&nested.global_bin_dir));
    assert_eq!(
        nested_argv,
        vec![
            "add".to_string(),
            "-g".to_string(),
            "--config.global-bin-dir=/Users/t/Library/pnpm/bin".to_string(),
            "@indigoai-us/hq-cli@5.97.2".to_string(),
        ]
    );

    // Flat pre-11 layout: home == global bin dir, so the forced dir is the
    // home itself and the flag is behaviour-preserving.
    let flat = pnpm_global_env("/Users/t/Library/pnpm/hq").expect("flat layout");
    assert_eq!(flat.global_bin_dir, "/Users/t/Library/pnpm");
    let flat_argv = pnpm_install_argv(Some("5.97.2"), Some(&flat.global_bin_dir));
    assert_eq!(
        flat_argv[2],
        "--config.global-bin-dir=/Users/t/Library/pnpm".to_string()
    );
}

/// The safety rail on the aiming change: an underivable layout
/// (`pnpm_global_env` -> None) must invent no directory. The child is spawned
/// exactly as before, with no `--config.global-bin-dir` flag at all.
#[test]
fn an_underivable_pnpm_layout_pins_no_global_bin_dir() {
    for hq_bin in [
        "hq",
        "/opt/homebrew/bin/hq",
        "/Users/t/.asdf/shims/hq",
        "/usr/local/bin/hq",
    ] {
        assert_eq!(
            pnpm_global_env(hq_bin),
            None,
            "{hq_bin} must not derive a home"
        );
    }
    // With no derivable dir the app passes `None`, and the argv carries no
    // config flag — inventing nothing.
    let argv = pnpm_install_argv(Some("5.97.2"), None);
    assert!(
        !argv
            .iter()
            .any(|arg| arg.starts_with("--config.global-bin-dir")),
        "an underivable layout must not force a global bin dir: {argv:?}"
    );
    // An empty string is treated the same as absent — never an empty flag.
    let empty = pnpm_install_argv(Some("5.97.2"), Some(""));
    assert!(!empty
        .iter()
        .any(|arg| arg.starts_with("--config.global-bin-dir")));
}

/// A pnpm run diagnostics builder for the nested pnpm >=11 field layout. The
/// `matches` argument is now a NATIVE-resolution diagnostic only — it no
/// longer changes any class — but the builder keeps varying it so the tests
/// prove exactly that.
fn pnpm_field_diagnostics(matches: Option<bool>) -> PnpmRunDiagnostics {
    PnpmRunDiagnostics {
        home_source: PnpmHomeSource::NestedBinDir,
        home_env_present: false,
        path_has_shim_dir: true,
        global_bin_dir_matches_shim_dir: matches,
        store_family: PnpmStoreFamily::V11,
        authoritative_query_ok: true,
        exit_status: "0".to_string(),
        output_len: 96,
    }
}

/// The pnpm class is now decided by delivery evidence plus the executed
/// reading alone. The native `pnpm bin -g` direction is a diagnostic only:
/// the SAME targeted+delivered inputs classify PnpmTargeted whether the native
/// dir happens to match the shim dir or (as on every pnpm >=11 nested layout)
/// does not — the exact tautology the base defect gated blocking on.
#[test]
fn pnpm_targeted_requires_delivery_evidence_only() {
    let hq_bin = "/Users/t/Library/pnpm/bin/hq";
    // Delivered => genuine shadowing (loud, blocks), regardless of direction.
    assert_eq!(
        non_convergence_kind(InstallExecutor::Pnpm, None, true, hq_bin, true, &[]),
        NonConvergenceKind::PnpmTargeted
    );
    // NOT delivered => transient shortfall (loud, never blocks).
    assert_eq!(
        non_convergence_kind(InstallExecutor::Pnpm, None, true, hq_bin, false, &[]),
        NonConvergenceKind::ResolutionShortfall
    );
    // The direction diagnostic never promotes or demotes a class: a delivered
    // target with the native dir matching AND with it mismatching both stay
    // PnpmTargeted (via `decide_post_install`, which is what wires the probe).
    for matches in [Some(true), Some(false), None] {
        let outcome = decide_post_install(&PostInstallContext {
            executor: InstallExecutor::Pnpm,
            before_bin: hq_bin,
            after_bin: hq_bin,
            before_version: None,
            after_version: Some("5.93.0"),
            latest: "5.97.2",
            npm_prefix_passed: None,
            delivered_version: Some("5.97.2"),
            installer_bin: "/opt/homebrew/bin/pnpm",
            already_blocked: false,
            nonblocking_episode_keys: &[],
            managed_roots: &[],
            managed_shadow_repair: ManagedShadowRepairOutcome::NotAttempted,
            executed_copy_aim: ExecutedCopyAim::Undrivable,
            hq_bin_lane: paths::ResolutionSource::NotResolved,
            delivered_prefix_shim: DeliveredPrefixShim::Unknown,
            settings_path: SettingsPathTelemetry::default(),
            pnpm: Some(pnpm_field_diagnostics(matches)),
        });
        assert_eq!(
            outcome.non_convergence_kind,
            Some(NonConvergenceKind::PnpmTargeted),
            "delivered target stays PnpmTargeted for direction {matches:?}"
        );
        assert_eq!(outcome.record_non_convergent.as_deref(), Some("5.97.2"));
    }
    assert!(NonConvergenceKind::PnpmTargeted.may_block_auto_update());
}

/// The heart of the r3 regression fix: the exact 2026-08-10 pnpm >=11 field
/// shape that STILL fails to deliver (a genuine registry shortfall, not the
/// converged happy path) is a ResolutionShortfall that writes NO durable
/// marker AND is bounded to one capture per episode — so the 16:13:33 /
/// 16:14:27 double-fire across an app self-update collapses to a single event
/// instead of re-paging on every check and every restart. On unmodified main
/// this same shape (with the forced-flag direction probe echoing a match) was
/// captured on every single occurrence.
#[test]
fn a_pnpm_resolution_shortfall_is_bounded_to_one_capture_per_episode() {
    // The native direction is Some(false) on a nested layout — the healthy
    // shape post-fix — and it no longer forces a misdirected class. pnpm's own
    // answer said the target is NOT in its global store (a genuine shortfall).
    fn shortfall_ctx<'a>(
        hq_bin: &'a str,
        latest: &'a str,
        keys: &'a [String],
    ) -> PostInstallContext<'a> {
        PostInstallContext {
            executor: InstallExecutor::Pnpm,
            before_bin: hq_bin,
            after_bin: hq_bin,
            before_version: None,
            after_version: Some("5.93.0"),
            latest,
            npm_prefix_passed: None,
            delivered_version: Some("5.93.0"),
            installer_bin: "/opt/homebrew/bin/pnpm",
            already_blocked: false,
            nonblocking_episode_keys: keys,
            managed_roots: &[],
            managed_shadow_repair: ManagedShadowRepairOutcome::NotAttempted,
            executed_copy_aim: ExecutedCopyAim::Undrivable,
            hq_bin_lane: paths::ResolutionSource::NotResolved,
            delivered_prefix_shim: DeliveredPrefixShim::Unknown,
            settings_path: SettingsPathTelemetry::default(),
            pnpm: Some(pnpm_field_diagnostics(Some(false))),
        }
    }
    let hq_bin = "/Users/t/Library/pnpm/bin/hq";
    let latest = "5.97.2";

    // First occurrence (empty episode set): classified shortfall, captured,
    // NO durable block, and it hands back the episode key to persist.
    let first = decide_post_install(&shortfall_ctx(hq_bin, latest, &[]));
    assert_eq!(
        first.non_convergence_kind,
        Some(NonConvergenceKind::ResolutionShortfall)
    );
    assert_eq!(
        first.record_non_convergent, None,
        "a shortfall must never wedge auto-update"
    );
    assert!(first.capture.is_some(), "first occurrence stays loud");
    assert!(!first.capture_requires_durable_record);
    let key = first
        .record_nonblocking_episode
        .expect("the first capture returns an episode key to persist");
    assert_eq!(
        key,
        non_convergent_episode_key(
            latest,
            InstallExecutor::Pnpm,
            NonConvergenceKind::ResolutionShortfall,
            Some(PnpmHomeSource::NestedBinDir),
        )
    );

    // Second occurrence with that key already persisted (a later check, or the
    // 16:14 app-restart event): SAME shape, but NOT captured — the double-fire
    // is gone — and still never blocks.
    let keys = [key];
    let repeat = decide_post_install(&shortfall_ctx(hq_bin, latest, &keys));
    assert_eq!(
        repeat.non_convergence_kind,
        Some(NonConvergenceKind::ResolutionShortfall)
    );
    assert!(
        repeat.capture.is_none(),
        "a persistent shortfall episode is captured once, not on every occurrence"
    );
    assert_eq!(repeat.record_nonblocking_episode, None);
    assert_eq!(repeat.record_non_convergent, None);

    // A NEW `latest` re-arms the capture: its episode key carries a different
    // `latest|` prefix, so a genuinely recurring defect is never hidden.
    let after_publish = decide_post_install(&shortfall_ctx(hq_bin, "5.98.0", &keys));
    assert!(
        after_publish.capture.is_some(),
        "a new CLI publish reports the shortfall again"
    );
    assert!(after_publish.record_nonblocking_episode.is_some());
}

/// The invariant the fix must never break: a genuine pnpm shadowing defect —
/// pnpm's effective global bin dir IS the dir holding the executed shim AND
/// the target WAS delivered into the store, yet the shim still reports the old
/// version — keeps reporting on every occurrence and keeps writing the durable
/// block, even for an already-blocked episode.
#[test]
fn a_delivered_pnpm_target_in_the_matching_bin_dir_stays_loud_and_blocking() {
    let hq_bin = "/Users/t/Library/pnpm/bin/hq";
    let outcome = decide_post_install(&PostInstallContext {
        executor: InstallExecutor::Pnpm,
        before_bin: hq_bin,
        after_bin: hq_bin,
        before_version: None,
        after_version: Some("5.93.0"),
        latest: "5.97.2",
        npm_prefix_passed: None,
        delivered_version: Some("5.97.2"), // delivered == target
        installer_bin: "/opt/homebrew/bin/pnpm",
        already_blocked: true, // still loud + blocking anyway
        nonblocking_episode_keys: &[],
        managed_roots: &[],
        managed_shadow_repair: ManagedShadowRepairOutcome::NotAttempted,
        executed_copy_aim: ExecutedCopyAim::Undrivable,
        hq_bin_lane: paths::ResolutionSource::NotResolved,
        delivered_prefix_shim: DeliveredPrefixShim::Unknown,
        settings_path: SettingsPathTelemetry::default(),
        pnpm: Some(pnpm_field_diagnostics(Some(true))),
    });
    assert_eq!(
        outcome.non_convergence_kind,
        Some(NonConvergenceKind::PnpmTargeted)
    );
    assert_eq!(
        outcome.record_non_convergent.as_deref(),
        Some("5.97.2"),
        "genuine shadowing keeps its durable block"
    );
    assert!(outcome.capture.is_some());
    assert!(!outcome.capture_requires_durable_record);
}

/// The pnpm delivery read must consult the pnpm store, never a stray
/// npm-style manifest that happens to sit under the pnpm home. A manual
/// `npm install --prefix <pnpm-home>` can leave `<home>/lib/node_modules`
/// with an older version; the shared `installed_hq_cli_version_in_prefix`
/// enumerates that npm candidate BEFORE the store and stops at the first hit,
/// so it would misreport delivery. The pnpm executor reads the store directly.
#[test]
fn pnpm_store_delivery_read_ignores_a_stray_npm_manifest_under_the_pnpm_home() {
    let tmp = tempfile::TempDir::new().unwrap();
    let home = tmp.path();
    // The pnpm store manifest carries the freshly-delivered target.
    let store = home
        .join("global")
        .join("5")
        .join("node_modules")
        .join("@indigoai-us")
        .join("hq-cli");
    std::fs::create_dir_all(&store).unwrap();
    std::fs::write(
        store.join("package.json"),
        r#"{"name":"@indigoai-us/hq-cli","version":"5.97.2"}"#,
    )
    .unwrap();
    // A stray npm-style manifest under the same home holds an OLD version.
    let stray = home
        .join("lib")
        .join("node_modules")
        .join("@indigoai-us")
        .join("hq-cli");
    std::fs::create_dir_all(&stray).unwrap();
    std::fs::write(
        stray.join("package.json"),
        r#"{"name":"@indigoai-us/hq-cli","version":"5.93.0"}"#,
    )
    .unwrap();

    // The pnpm-store reader returns the STORE version, ignoring the stray.
    assert_eq!(
        installed_hq_cli_version_in_pnpm_store(home.to_str().unwrap()).as_deref(),
        Some("5.97.2")
    );
    // The shared reader, given the same home, is shadowed by the stray npm
    // manifest — which is exactly why the pnpm branch uses the store reader.
    let shim = home.join("bin").join("hq");
    assert_eq!(
        installed_hq_cli_version_in_prefix(home.to_str().unwrap(), shim.to_str().unwrap())
            .as_deref(),
        Some("5.93.0"),
        "the shared reader is shadowed by the stray npm manifest"
    );
}

/// r3 base-failure #1 (the recurrence's root): the exact pnpm >=11 store
/// layout the field machine had. pnpm reports its global root as
/// `<home>/global/v11`, with the delivered package one opaque-hash directory
/// below. On base `fcdca79e` the store reader built only
/// `<home>/global/<n>/node_modules/...`, so this returned None and every
/// verification path read `delivered_version=none` while the install had
/// actually landed. It must now be discovered — both directly and through the
/// executed (non-symlink script) shim, so `local` stops freezing stale.
#[test]
fn pnpm11_store_delivery_is_discovered_under_the_v11_hash_dir() {
    let tmp = tempfile::TempDir::new().unwrap();
    let home = tmp.path();
    let pkg = home
        .join("global")
        .join("v11")
        .join("a1b2c3d4e5")
        .join("node_modules")
        .join("@indigoai-us")
        .join("hq-cli");
    std::fs::create_dir_all(&pkg).unwrap();
    std::fs::write(
        pkg.join("package.json"),
        r#"{"name":"@indigoai-us/hq-cli","version":"5.98.0"}"#,
    )
    .unwrap();
    assert_eq!(
        installed_hq_cli_version_in_pnpm_store(home.to_str().unwrap()).as_deref(),
        Some("5.98.0"),
        "the pnpm 11 v11/<hash> store manifest must be discovered"
    );

    // A pnpm global shim is a plain (non-symlink) script — reproduction proves
    // canonicalize()+ancestors() can never reach its package tree — yet the
    // executed reading now resolves the version via the store candidates.
    let shim = home.join("bin").join("hq");
    std::fs::create_dir_all(shim.parent().unwrap()).unwrap();
    std::fs::write(&shim, "#!/bin/sh\nexit 0\n").unwrap();
    assert_eq!(
        version_from_hq_binary(&shim).as_deref(),
        Some("5.98.0"),
        "the executed pnpm 11 shim resolves its version from the v11 store"
    );
}

/// When `global/v11` holds MORE THAN ONE opaque-hash directory (a prior
/// install pnpm has not pruned), the read must be deterministic and pick the
/// NEWEST version present — never an arbitrary hash child in filesystem
/// enumeration order, which could report a stale version or falsely declare
/// convergence. Both the store reader and the executed-shim read must agree.
#[test]
fn pnpm11_multiple_hash_dirs_resolve_deterministically_to_the_newest() {
    let tmp = tempfile::TempDir::new().unwrap();
    let home = tmp.path();
    let v11 = home.join("global").join("v11");
    for (hash, version) in [("olddir00", "5.93.0"), ("newdir99", "5.98.0")] {
        let pkg = v11
            .join(hash)
            .join("node_modules")
            .join("@indigoai-us")
            .join("hq-cli");
        std::fs::create_dir_all(&pkg).unwrap();
        std::fs::write(
            pkg.join("package.json"),
            format!(r#"{{"name":"@indigoai-us/hq-cli","version":"{version}"}}"#),
        )
        .unwrap();
    }
    // Newest present wins regardless of which hash dir enumerates first.
    assert_eq!(
        installed_hq_cli_version_in_pnpm_store(home.to_str().unwrap()).as_deref(),
        Some("5.98.0"),
        "a lingering older hash dir must not shadow the active install"
    );
    let shim = home.join("bin").join("hq");
    std::fs::create_dir_all(shim.parent().unwrap()).unwrap();
    std::fs::write(&shim, "#!/bin/sh\nexit 0\n").unwrap();
    assert_eq!(
        version_from_hq_binary(&shim).as_deref(),
        Some("5.98.0"),
        "the executed reading agrees with the store's newest install"
    );
    // The `pnpm root -g` fallback is deterministic over the same shape.
    assert_eq!(
        hq_cli_version_under_pnpm_root(&v11).as_deref(),
        Some("5.98.0")
    );
}

/// r3 base-failure #2: store-generation ordering. The base sort parsed "v11"
/// with `u64::parse`, scoring it 0, so a machine migrated from pnpm 10 with a
/// leftover "5" store enumerated the STALE store first. `v11` must now outrank
/// it — the end-to-end reader returns the v11 version when both are present.
#[test]
fn pnpm_store_generations_sort_v11_ahead_of_a_leftover_numeric_store() {
    assert_eq!(pnpm_store_generation("5"), 5);
    assert_eq!(pnpm_store_generation("v11"), 11);
    assert_eq!(pnpm_store_generation("not-a-store"), 0);
    assert!(pnpm_store_generation("v11") > pnpm_store_generation("5"));
    assert!(pnpm_store_generation("v11") > pnpm_store_generation("4"));

    let tmp = tempfile::TempDir::new().unwrap();
    let home = tmp.path();
    let numeric = home
        .join("global")
        .join("5")
        .join("node_modules")
        .join("@indigoai-us")
        .join("hq-cli");
    std::fs::create_dir_all(&numeric).unwrap();
    std::fs::write(
        numeric.join("package.json"),
        r#"{"name":"@indigoai-us/hq-cli","version":"5.93.0"}"#,
    )
    .unwrap();
    let v11 = home
        .join("global")
        .join("v11")
        .join("deadbeef")
        .join("node_modules")
        .join("@indigoai-us")
        .join("hq-cli");
    std::fs::create_dir_all(&v11).unwrap();
    std::fs::write(
        v11.join("package.json"),
        r#"{"name":"@indigoai-us/hq-cli","version":"5.98.0"}"#,
    )
    .unwrap();
    assert_eq!(
        installed_hq_cli_version_in_pnpm_store(home.to_str().unwrap()).as_deref(),
        Some("5.98.0"),
        "v11 must outrank a stale leftover numeric store"
    );
}

/// The authoritative delivery parser over `pnpm ls -g --depth 0 --json`. Both
/// the pnpm 10 and pnpm 11 payload shapes yield the installed version; empty,
/// malformed and unexpected JSON yield None (no evidence → retry, never block).
#[test]
fn pnpm_global_ls_parser_reads_both_majors_and_fails_soft() {
    let pnpm11 = r#"[{"name":"global","path":"/h/global/v11","dependencies":{"@indigoai-us/hq-cli":{"from":"@indigoai-us/hq-cli","version":"5.98.0","resolved":"file:","path":"/h/global/v11/abc/node_modules/@indigoai-us/hq-cli"}}}]"#;
    assert_eq!(
        pnpm_global_ls_hq_cli_version(pnpm11).as_deref(),
        Some("5.98.0")
    );
    let pnpm10 = r#"[{"dependencies":{"@indigoai-us/hq-cli":{"version":"5.97.2"}}}]"#;
    assert_eq!(
        pnpm_global_ls_hq_cli_version(pnpm10).as_deref(),
        Some("5.97.2")
    );
    // A bare object rather than a one-element array (seen on some setups).
    let obj = r#"{"dependencies":{"@indigoai-us/hq-cli":{"version":"5.96.0"}}}"#;
    assert_eq!(
        pnpm_global_ls_hq_cli_version(obj).as_deref(),
        Some("5.96.0")
    );
    // No hq-cli present, empty, malformed, and a scalar all fail soft to None.
    assert_eq!(
        pnpm_global_ls_hq_cli_version(r#"[{"dependencies":{}}]"#),
        None
    );
    assert_eq!(pnpm_global_ls_hq_cli_version(""), None);
    assert_eq!(pnpm_global_ls_hq_cli_version("not json {"), None);
    assert_eq!(pnpm_global_ls_hq_cli_version("42"), None);
}

/// The `pnpm root -g` fallback accepts BOTH store shapes: the pnpm 10 root
/// (`<home>/global/5/node_modules`, package directly beneath) and the pnpm 11
/// root (`<home>/global/v11`, package under a per-install hash dir).
#[test]
fn hq_cli_version_under_pnpm_root_accepts_both_store_shapes() {
    let tmp10 = tempfile::TempDir::new().unwrap();
    let root10 = tmp10.path().join("global").join("5").join("node_modules");
    let pkg10 = root10.join("@indigoai-us").join("hq-cli");
    std::fs::create_dir_all(&pkg10).unwrap();
    std::fs::write(
        pkg10.join("package.json"),
        r#"{"name":"@indigoai-us/hq-cli","version":"5.97.2"}"#,
    )
    .unwrap();
    assert_eq!(
        hq_cli_version_under_pnpm_root(&root10).as_deref(),
        Some("5.97.2")
    );

    let tmp11 = tempfile::TempDir::new().unwrap();
    let root11 = tmp11.path().join("global").join("v11");
    let pkg11 = root11
        .join("f00ba7")
        .join("node_modules")
        .join("@indigoai-us")
        .join("hq-cli");
    std::fs::create_dir_all(&pkg11).unwrap();
    std::fs::write(
        pkg11.join("package.json"),
        r#"{"name":"@indigoai-us/hq-cli","version":"5.98.0"}"#,
    )
    .unwrap();
    assert_eq!(
        hq_cli_version_under_pnpm_root(&root11).as_deref(),
        Some("5.98.0")
    );

    let empty = tempfile::TempDir::new().unwrap();
    assert_eq!(hq_cli_version_under_pnpm_root(empty.path()), None);
}

/// The pnpm global-store family token is a closed diagnostic, never a path.
#[test]
fn pnpm_store_family_classifies_the_generation_name() {
    assert_eq!(pnpm_store_family("v11"), PnpmStoreFamily::V11);
    assert_eq!(pnpm_store_family("v12"), PnpmStoreFamily::V11);
    assert_eq!(pnpm_store_family("5"), PnpmStoreFamily::Numeric);
    assert_eq!(pnpm_store_family("vfoo"), PnpmStoreFamily::Unknown);
    assert_eq!(pnpm_store_family(""), PnpmStoreFamily::Unknown);
    assert_eq!(PnpmStoreFamily::V11.telemetry_value(), "v11");
    assert_eq!(PnpmStoreFamily::Numeric.telemetry_value(), "numeric");
    assert_eq!(PnpmStoreFamily::Unknown.telemetry_value(), "unknown");
}

/// The non-blocking episode bound: keyed per `(latest, executor, kind,
/// home_source)`, membership-tested, and reset by a new `latest`.
#[test]
fn non_convergent_episode_bounding_is_per_latest_and_membership_keyed() {
    let key = non_convergent_episode_key(
        "5.98.0",
        InstallExecutor::Pnpm,
        NonConvergenceKind::ResolutionShortfall,
        Some(PnpmHomeSource::NestedBinDir),
    );
    assert_eq!(key, "5.98.0|pnpm|resolution-shortfall|nested-bin-dir");
    assert!(!non_convergent_episode_reported(&[], &key));
    let recorded = non_convergent_episode_record(&[], &key, "5.98.0");
    assert!(non_convergent_episode_reported(&recorded, &key));

    // A new `latest` carries a different `latest|` prefix, so the old key is
    // dropped from the persisted set and the shortfall reports again.
    let newer_key = non_convergent_episode_key(
        "5.99.0",
        InstallExecutor::Pnpm,
        NonConvergenceKind::ResolutionShortfall,
        Some(PnpmHomeSource::NestedBinDir),
    );
    let after = non_convergent_episode_record(&recorded, &newer_key, "5.99.0");
    assert!(non_convergent_episode_reported(&after, &newer_key));
    assert!(
        !non_convergent_episode_reported(&after, &key),
        "keys for a superseded latest are reset"
    );

    // npm uses the executor token and no pnpm home source.
    assert_eq!(
        non_convergent_episode_key(
            "5.98.0",
            InstallExecutor::Npm,
            NonConvergenceKind::ResolutionShortfall,
            None,
        ),
        "5.98.0|npm|resolution-shortfall|n/a"
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

#[test]
fn post_install_relocation_counts_as_converged() {
    assert_eq!(
        convergence_verdict(
            Some("5.77.14"),
            Some("5.83.0"),
            "/Users/test/.asdf/shims/hq",
            "/opt/homebrew/bin/hq",
            "5.83.0",
        ),
        ConvergenceVerdict::RelocatedAndConverged
    );
}

#[test]
fn genuinely_stale_post_install_resolution_still_blocks() {
    assert_eq!(
        convergence_verdict(
            Some("5.77.14"),
            Some("5.77.14"),
            "/Users/test/.asdf/shims/hq",
            "/Users/test/.asdf/shims/hq",
            "5.83.0",
        ),
        ConvergenceVerdict::NonConvergent
    );
    assert!(!should_auto_install("5.83.0", Some("5.83.0")));
}

#[test]
fn bin_resolution_source_is_closed_and_path_free() {
    #[cfg(not(target_os = "windows"))]
    {
        assert_eq!(bin_resolution_source("/opt/homebrew/bin/hq"), "homebrew");
        assert_eq!(bin_resolution_source("/usr/local/bin/npm"), "usr-local");
        assert_eq!(
            bin_resolution_source("/Users/test/.asdf/shims/hq"),
            "login-shell"
        );
    }
    #[cfg(target_os = "windows")]
    {
        assert_eq!(bin_resolution_source("/opt/homebrew/bin/hq"), "unknown");
        assert_eq!(bin_resolution_source("/usr/local/bin/npm"), "unknown");
        assert_eq!(
            bin_resolution_source("/Users/test/.asdf/shims/hq"),
            "unknown"
        );
    }
    assert_eq!(bin_resolution_source("hq"), "unknown");
}

/// The arm that matters is the one a healthy machine never takes: no
/// version readable AND no binary found means the user simply has no CLI.
#[test]
fn install_is_needed_when_no_cli_is_installed_at_all() {
    assert!(cli_install_needed(
        None, "5.103.1", /* hq_installed */ false
    ));
}

/// A binary IS present but its version cannot be read. That is ambiguous —
/// our own install left broken by an interrupted global install, or an
/// unrelated program named `hq` — and a version string cannot tell them
/// apart. Keep today's behaviour rather than sending the installer at a
/// decision it also cannot make safely (it refuses, so claiming "needed"
/// here would just retry fruitlessly on every check).
#[test]
fn an_unreadable_but_present_cli_is_left_alone() {
    assert!(!cli_install_needed(
        None, "5.103.1", /* hq_installed */ true
    ));
}

#[test]
fn install_is_needed_only_when_the_local_version_is_older() {
    assert!(cli_install_needed(Some("5.102.0"), "5.103.1", true));
    // Current, and ahead (a local dev build) — neither should trigger a
    // reinstall on every check.
    assert!(!cli_install_needed(Some("5.103.1"), "5.103.1", true));
    assert!(!cli_install_needed(Some("5.104.0"), "5.103.1", true));
}

#[test]
fn install_need_compares_numerically_not_lexically() {
    // Guards the same trap `cmp_semver` exists for: "5.9.0" > "5.10.0" as
    // strings would silently stop upgrading past a two-digit minor.
    assert!(cli_install_needed(Some("5.9.0"), "5.10.0", true));
    assert!(!cli_install_needed(Some("5.10.0"), "5.9.0", true));
}

/// Nothing on PATH means nothing to overwrite, so the "refusing to
/// overwrite an unrelated command" guard has nothing to protect and the
/// user simply has no CLI. This is the plain first-install case.
#[test]
fn first_install_uses_npm_when_no_hq_resolves_at_all() {
    assert_eq!(
        install_executor_for_first_install(ResolvedProgramKind::NotResolved),
        Some(InstallExecutor::Npm)
    );
}

/// The protection this whole path exists for: a resolved binary we cannot
/// identify must never be overwritten. In particular a path inside a pnpm
/// or Bun global root proves only that THAT MANAGER owns the binary — any
/// unrelated package exposing an `hq` bin installs to exactly there — so
/// path shape is not ownership evidence and must not unlock an install.
#[test]
fn a_resolved_but_unidentifiable_hq_is_always_refused() {
    for kind in [
        ResolvedProgramKind::Exe,
        ResolvedProgramKind::CmdOrBat,
        ResolvedProgramKind::Extensionless,
        ResolvedProgramKind::OtherExtension,
    ] {
        assert_eq!(install_executor_for_first_install(kind), None);
    }
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
    let detail = non_convergent_detail(
        InstallExecutor::Npm,
        "/Users/test/Library/pnpm/hq",
        Some("5.38.2"),
        "5.79.0",
    );
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
        npm_prefix_from_hq_bin("C:/Users/test/AppData/Local/IndigoHQ/toolchain/npm-prefix/hq.cmd"),
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

/// The exact reported HQ-DESKTOP-53 shape: npm's own `ENOSPC` code, a `write`
/// syscall, no `npm error path` line (npm_path_shape=none), exit 1.
const DISK_FULL_STDERR: &str = "npm error code ENOSPC\n\
        npm error syscall write\n\
        npm error errno -28\n\
        npm error ENOSPC: no space left on device, write";

#[test]
fn no_prefix_non_permission_nontransient_failures_stay_loud() {
    // EINTEGRITY and EEXIST are genuine, non-permission, non-transient
    // failures: they must stay loud (Unexpected) and keep reporting.
    for detail in [
        "npm error code EINTEGRITY\nnpm error path /usr/local/lib/node_modules/@indigoai-us",
        "npm error code EEXIST\nnpm error path /usr/local/lib/node_modules/@indigoai-us",
    ] {
        assert_eq!(
            classify_install_failure(Some(1), detail, None),
            InstallFailureKind::Unexpected,
            "detail: {detail}"
        );
        assert!(
            install_failure_report(Some(1), detail, None).is_some(),
            "detail: {detail}"
        );
    }
    // ENOSPC now routes to the dedicated disk-full arm (a full disk is not an
    // updater defect). The property THIS test guards — the permission arm does
    // not over-widen onto a non-permission failure — is preserved verbatim:
    // ENOSPC classifies as ExpectedDiskFull, explicitly NOT ExpectedPrefixPermission.
    let enospc = "npm error code ENOSPC\nnpm error path /usr/local/lib/node_modules/@indigoai-us";
    assert_eq!(
        classify_install_failure(Some(1), enospc, None),
        InstallFailureKind::ExpectedDiskFull
    );
    assert_ne!(
        classify_install_failure(Some(1), enospc, None),
        InstallFailureKind::ExpectedPrefixPermission
    );
}

#[test]
fn the_reported_enospc_shape_is_disk_full_and_never_reports() {
    // HQ-DESKTOP-53. Across the prefixes the installer may pass and whether or
    // not npm's retry ladder forced a final attempt, npm's own `ENOSPC`
    // classifies ExpectedDiskFull and produces NO Sentry report.
    for prefix in [None, Some("/usr/local")] {
        for forced in [false, true] {
            assert_eq!(
                classify_install_failure_with_final_attempt(
                    Some(1),
                    DISK_FULL_STDERR,
                    prefix,
                    forced
                ),
                InstallFailureKind::ExpectedDiskFull,
                "prefix={prefix:?} forced={forced}"
            );
            assert_eq!(
                install_failure_report_with_final_attempt(
                    Some(1),
                    DISK_FULL_STDERR,
                    prefix,
                    forced
                ),
                None,
                "prefix={prefix:?} forced={forced}"
            );
        }
    }
}

#[test]
fn a_disk_full_failure_shows_the_free_up_space_copy_not_raw_stderr() {
    // The user sees the actionable free-up-space remedy, never the raw npm
    // stderr the passthrough would otherwise surface.
    let detail = install_failure_detail(Some(1), DISK_FULL_STDERR, None);
    assert!(detail.contains("disk space"), "got: {detail}");
    assert!(detail.contains("copied command"), "got: {detail}");
    assert!(
        !detail.contains("npm error"),
        "raw npm stderr leaked to the user: {detail}"
    );
}

#[test]
fn disk_full_arm_leaves_every_other_classification_untouched() {
    // The disk-full arm is FIRST, so prove it did not widen onto any other
    // shape. Each keeps exactly the kind it had before this change.
    assert_eq!(
        classify_install_failure(Some(243), REAL_EACCES_STDERR, Some("/usr/local")),
        InstallFailureKind::ExpectedPrefixPermission
    );
    assert_eq!(
        classify_install_failure(
            Some(-4048),
            "npm error code EPERM\nnpm error errno -4048",
            None
        ),
        InstallFailureKind::ExpectedWindowsLockedBinary
    );
    assert_eq!(
        classify_install_failure_with_final_attempt(
            Some(1),
            "npm error code EEXIST\nnpm error path /usr/local/bin/hq",
            None,
            true,
        ),
        InstallFailureKind::ExpectedBinCollision
    );
    assert_eq!(
        classify_install_failure(
            Some(1),
            "npm error code ETARGET\nnpm error path /usr/local/lib/node_modules/@indigoai-us",
            None,
        ),
        InstallFailureKind::ExpectedTransientRegistry
    );
    for detail in [
        "npm error code EINTEGRITY\nnpm error path /usr/local/lib/node_modules/@indigoai-us",
        "npm error code ENOTDIR\nnpm error syscall mkdir\nnpm error path /usr/local/lib/node_modules/@indigoai-us/hq-cli",
    ] {
        assert_eq!(
            classify_install_failure(Some(1), detail, None),
            InstallFailureKind::Unexpected,
            "detail: {detail}"
        );
        assert!(
            install_failure_report(Some(1), detail, None).is_some(),
            "detail: {detail}"
        );
    }
}

#[test]
fn third_party_lifecycle_failure_mentioning_enospc_stays_a_lifecycle_failure() {
    // A third-party build script that ran out of disk space carries npm's
    // lifecycle markers (an all-digit `code` and `command failed`), so the
    // disk-full arm's code clause cannot match and its phrase clause is gated
    // off by `!has_npm_lifecycle_failure_marker`. It must stay UnexpectedLifecycle,
    // keep reporting, and keep its per-package `disk-space` signature — the
    // disk-full arm must never widen onto the lifecycle path.
    let detail = "npm error code 1\n\
            npm error command failed\n\
            npm error command sh -c prebuild-install || node-gyp rebuild\n\
            npm error path /usr/local/lib/node_modules/better-sqlite3\n\
            gyp ERR! ENOSPC: no space left on device";
    assert_eq!(
        classify_install_failure(Some(1), detail, Some("/usr/local")),
        InstallFailureKind::UnexpectedLifecycle
    );
    assert!(install_failure_report(Some(1), detail, Some("/usr/local")).is_some());
    assert_eq!(
        install_failure_signature(
            InstallFailureKind::UnexpectedLifecycle,
            detail,
            Some("/usr/local")
        ),
        "lifecycle:better-sqlite3:disk-space"
    );
}

#[test]
fn legacy_npm_err_lifecycle_failure_mentioning_enospc_stays_a_lifecycle_failure() {
    // Regression for the LEGACY `npm ERR!` spelling.
    // `has_npm_lifecycle_failure_marker` only recognizes the modern `npm error`
    // spelling, so without the additional `npm_lifecycle_failure()` gate the
    // disk-full phrase fallback would swallow an old-npm build failure that ran
    // out of space. It must stay UnexpectedLifecycle, keep reporting, and keep
    // its per-package disk-space signature.
    let detail = "npm ERR! code 1\n\
            npm ERR! command failed\n\
            npm ERR! command sh -c prebuild-install || node-gyp rebuild\n\
            npm ERR! path /usr/local/lib/node_modules/better-sqlite3\n\
            gyp ERR! ENOSPC: no space left on device";
    assert!(!is_disk_exhaustion_failure(detail));
    assert_eq!(
        classify_install_failure(Some(1), detail, Some("/usr/local")),
        InstallFailureKind::UnexpectedLifecycle
    );
    assert!(install_failure_report(Some(1), detail, Some("/usr/local")).is_some());
    assert_eq!(
        install_failure_signature(
            InstallFailureKind::UnexpectedLifecycle,
            detail,
            Some("/usr/local")
        ),
        "lifecycle:better-sqlite3:disk-space"
    );
}

#[test]
fn transient_registry_failures_keep_the_current_expected_classification() {
    for detail in [
        "npm error code ETIMEDOUT\nnpm error path /usr/local/lib/node_modules/@indigoai-us",
        "npm error code ECONNRESET\nnpm error path /usr/local/lib/node_modules/@indigoai-us",
        // HQ-DESKTOP-5C: a registry socket idle timeout is the same transient
        // class and must classify identically to its five siblings — both the
        // env-blind classifier and the environment-aware refinement.
        "npm error code EIDLETIMEOUT\nnpm error path /usr/local/lib/node_modules/@indigoai-us",
    ] {
        assert_eq!(
            classify_install_failure(Some(1), detail, None),
            InstallFailureKind::ExpectedTransientRegistry,
            "detail: {detail}"
        );
        assert_eq!(
            classify_install_failure_with_environment(
                Some(1),
                detail,
                None,
                false,
                &InstallEnvironment::default(),
            ),
            InstallFailureKind::ExpectedTransientRegistry,
            "env-aware detail: {detail}"
        );
    }

    // The transient absorption must NOT leak into a failure that carries an
    // EIDLETIMEOUT code alongside a lifecycle marker: the `command failed`
    // marker keeps `has_npm_lifecycle_failure_marker` true, so the transient
    // arm is skipped and the failure stays LOUD (captured at Error) rather
    // than being silently absorbed — mirroring the ETARGET/ECONNRESET
    // lifecycle guard. It lands as `Unexpected` (a symbolic registry code is
    // not a numeric lifecycle script status, so no third-party package is
    // attributed), which still pages at Error.
    let lifecycle_with_eidletimeout = "npm error code EIDLETIMEOUT\n\
            npm error command failed\n\
            npm error command sh -c prebuild-install || node-gyp rebuild\n\
            npm error path /usr/local/lib/node_modules/better-sqlite3\n\
            prebuild-install warn install No prebuilt binaries found";
    let lifecycle_kind = classify_install_failure(Some(1), lifecycle_with_eidletimeout, None);
    assert_ne!(
        lifecycle_kind,
        InstallFailureKind::ExpectedTransientRegistry
    );
    assert_eq!(lifecycle_kind, InstallFailureKind::Unexpected);

    // The LEGACY `npm ERR!` spelling of a lifecycle failure carrying EIDLETIMEOUT
    // must also stay loud: has_npm_lifecycle_failure_marker now recognises the
    // legacy marker, so an old npm's real build failure is NOT silently absorbed
    // as a registry timeout. It lands at Error as `Unexpected` (loud) — exactly
    // its pre-EIDLETIMEOUT-allow-list behaviour, so nothing is silenced.
    let legacy_lifecycle_with_eidletimeout = "npm ERR! code EIDLETIMEOUT\n\
            npm ERR! command failed\n\
            npm ERR! command sh -c prebuild-install || node-gyp rebuild\n\
            npm ERR! path /usr/local/lib/node_modules/better-sqlite3";
    let legacy_kind = classify_install_failure(Some(1), legacy_lifecycle_with_eidletimeout, None);
    assert_ne!(legacy_kind, InstallFailureKind::ExpectedTransientRegistry);
    assert_eq!(legacy_kind, InstallFailureKind::Unexpected);
    // And it is still reported (captured at Error), never dropped.
    assert!(install_failure_report(Some(1), legacy_lifecycle_with_eidletimeout, None).is_some());
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
fn derived_prefix_disk_full_failure_at_an_unmatched_global_target_is_disk_full_not_permission() {
    // Formerly asserted ENOSPC -> Unexpected. ENOSPC now routes to the
    // dedicated disk-full arm, but the property this test guards is unchanged:
    // a non-permission failure at a global target that differs from the derived
    // prefix must NOT be swallowed by the permission arm.
    let detail =
        "npm error code ENOSPC\nnpm error path /opt/homebrew/lib/node_modules/@indigoai-us";
    assert_eq!(
        classify_install_failure(Some(1), detail, Some("/usr/local")),
        InstallFailureKind::ExpectedDiskFull
    );
    assert_ne!(
        classify_install_failure(Some(1), detail, Some("/usr/local")),
        InstallFailureKind::ExpectedPrefixPermission
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
        "EIDLETIMEOUT",
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
        install_failure_report_with_final_attempt(Some(1), bin_collision, Some("/usr/local"), true,),
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
fn every_declared_hq_cli_shim_is_recognized_as_a_bin_collision() {
    // Recognition must cover EVERY shim @indigoai-us/hq-cli declares, in all
    // four link forms, both with a known prefix and via the prefix-free
    // suffix path npm emits when the updater could not resolve a prefix.
    // Adding a name to HQ_CLI_BIN_NAMES is then the only edit a new bin needs.
    for name in HQ_CLI_BIN_NAMES {
        let prefix = "/usr/local";
        for path in [
            format!("{prefix}/bin/{name}"),
            format!("{prefix}/{name}"),
            format!("{prefix}/{name}.cmd"),
            format!("{prefix}/{name}.ps1"),
        ] {
            let detail = format!("npm error code EEXIST\nnpm error path {path}");
            assert_eq!(
                npm_path_shape(&detail, Some(prefix)),
                NpmPathShape::BinHq,
                "prefix-anchored shape for {path}"
            );
            assert!(
                is_npm_bin_collision(&detail, Some(prefix)),
                "prefix-anchored collision for {path}"
            );
        }
        for path in [
            format!("/opt/homebrew/bin/{name}"),
            format!("C:/Users/alice/AppData/Roaming/npm/{name}"),
            format!("C:/Users/alice/AppData/Roaming/npm/{name}.cmd"),
            format!("C:/Users/alice/AppData/Roaming/npm/{name}.ps1"),
        ] {
            let detail = format!("npm error code EEXIST\nnpm error path {path}");
            assert_eq!(
                npm_path_shape(&detail, None),
                NpmPathShape::BinHq,
                "prefix-free shape for {path}"
            );
            assert!(
                is_npm_bin_collision(&detail, None),
                "prefix-free collision for {path}"
            );
        }
    }
}

#[test]
fn undeclared_neighbour_shims_do_not_widen_into_a_collision() {
    // The widening is strict: it must not swallow unrelated binaries whose
    // names merely start with `hq` or extend a declared name.
    for prefix in [Some("/usr/local"), None] {
        for path in [
            "/usr/local/bin/hq-other",
            "/usr/local/bin/hqx",
            "/usr/local/bin/hq-auth",
            "/usr/local/bin/hq-auth-refresh-2",
        ] {
            let detail = format!("npm error code EEXIST\nnpm error path {path}");
            assert_eq!(
                npm_path_shape(&detail, prefix),
                NpmPathShape::Other,
                "path {path} with prefix {prefix:?} must stay Other"
            );
            assert!(
                !is_npm_bin_collision(&detail, prefix),
                "path {path} with prefix {prefix:?} must not be a collision"
            );
        }
    }
}

#[test]
fn second_shim_bin_collision_arms_the_same_forced_remedy() {
    // HQ-DESKTOP-4Y: the reported collision was on the package's SECOND
    // declared shim, `hq-auth-refresh`, not `hq`. It must classify exactly
    // like a `hq` collision — Unexpected until npm's `--force` remedy ran,
    // ExpectedBinCollision once it did — and title on the recognized
    // `bin-hq` signature rather than the reported `EEXIST:unknown:other`.
    let second_shim = "npm error code EEXIST\n\
            npm error path /usr/local/bin/hq-auth-refresh";
    assert!(is_npm_bin_collision(second_shim, Some("/usr/local")));
    // The reported event carried no prefix; the prefix-free suffix path must
    // recognize it just the same.
    assert!(is_npm_bin_collision(second_shim, None));

    assert_eq!(
        classify_install_failure(Some(1), second_shim, Some("/usr/local")),
        InstallFailureKind::Unexpected
    );
    assert_eq!(
        classify_install_failure_with_final_attempt(Some(1), second_shim, Some("/usr/local"), true,),
        InstallFailureKind::ExpectedBinCollision
    );
    assert_eq!(
        install_failure_report_with_final_attempt(Some(1), second_shim, Some("/usr/local"), true,),
        Some("[hq-cli-update] hq shim collision survived npm --force".to_string())
    );
    assert_eq!(
        install_failure_signature(
            InstallFailureKind::ExpectedBinCollision,
            second_shim,
            Some("/usr/local"),
        ),
        "EEXIST:unknown:bin-hq"
    );

    // An EACCES while linking the same second shim is the sudo case, not a
    // fresh page: it joins the existing prefix-permission bucket, with a
    // known prefix and via the global-target fallback when none was resolved.
    let second_shim_eacces = "npm error code EACCES\n\
            npm error path /usr/local/bin/hq-auth-refresh";
    assert!(is_prefix_permission_failure(
        second_shim_eacces,
        Some("/usr/local")
    ));
    assert_eq!(
        classify_install_failure(Some(243), second_shim_eacces, Some("/usr/local")),
        InstallFailureKind::ExpectedPrefixPermission
    );
    assert!(is_global_prefix_permission_failure(
        Some(243),
        second_shim_eacces
    ));
    assert_eq!(
        classify_install_failure(Some(243), second_shim_eacces, None),
        InstallFailureKind::ExpectedPrefixPermission
    );

    // A bare EEXIST token in lifecycle build output must still NOT be treated
    // as a bin collision — only npm's structured code+path pair may arm force.
    let lifecycle_output = "npm error code 1\n\
            npm error command failed\n\
            npm error path /usr/local/bin/hq-auth-refresh\n\
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
fn npm_bin_target_is_a_closed_path_free_enumeration() {
    // Each declared shim resolves to its own name, in every link form, so a
    // merged collision group can still say WHICH shim collided.
    for name in HQ_CLI_BIN_NAMES {
        for path in [
            format!("/usr/local/bin/{name}"),
            format!("/usr/local/{name}"),
            format!("C:/Users/alice/AppData/Roaming/npm/{name}.cmd"),
            format!("C:/Users/alice/AppData/Roaming/npm/{name}.ps1"),
        ] {
            let detail = format!("npm error code EEXIST\nnpm error path {path}");
            assert_eq!(npm_bin_target(&detail), name, "path {path}");
        }
    }
    // An unrelated path is `other`; no path line at all is `none`.
    assert_eq!(
        npm_bin_target("npm error code EEXIST\nnpm error path /usr/local/bin/hq-other"),
        "other"
    );
    assert_eq!(
        npm_bin_target(
            "npm error code ENOTDIR\n\
                 npm error path /usr/local/lib/node_modules/@indigoai-us/hq-cli"
        ),
        "other"
    );
    assert_eq!(npm_bin_target("npm error code EEXIST"), "none");
    // The value is ALWAYS one of the closed set and never a raw path — even
    // when the reported path itself sits under a sensitive directory.
    for detail in [
        "npm error code EEXIST\nnpm error path /usr/local/bin/hq",
        "npm error code EEXIST\nnpm error path /Users/alice/secret/hq-auth-refresh.cmd",
        "npm error code ENOTDIR\nnpm error path /Users/alice/.npm/_cacache",
        "",
    ] {
        let target = npm_bin_target(detail);
        assert!(
            HQ_CLI_BIN_NAMES.contains(&target) || target == "other" || target == "none",
            "npm_bin_target returned an out-of-enum value: {target:?}"
        );
        assert!(
            !target.contains('/'),
            "npm_bin_target leaked a path: {target:?}"
        );
    }
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
    let detail =
        install_failure_detail_with_final_attempt(Some(1), bin_collision, Some("/usr/local"), true);
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
        Some("[hq-cli-update] install failed (EACCES:unknown:npm-cache)".to_string()),
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
    assert_eq!(npm_error_code("npm ERR! code ECONNRESET"), "ECONNRESET");
    assert_eq!(
        npm_error_code("application output: npm error code ETARGET"),
        "none"
    );
    assert_eq!(
        npm_error_code("npm error code ../../Users/alice/.npm/_cacache"),
        "unrecognized"
    );
    assert_eq!(
        npm_error_code("npm error path /Users/alice/.npm/_cacache"),
        "none"
    );
}

#[test]
fn unix_exit_status_decodes_libuv_errno() {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    assert_eq!(npm_errno_from_exit_status(Some(243)), "EACCES");
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    assert_eq!(npm_errno_from_exit_status(Some(243)), "unknown");
    assert_eq!(npm_errno_from_exit_status(Some(128)), "unknown");
    assert_eq!(npm_errno_from_exit_status(Some(1)), "unknown");

    #[cfg(target_os = "macos")]
    assert_eq!(npm_errno_from_exit_status(Some(202)), "ECONNRESET");

    #[cfg(target_os = "linux")]
    assert_eq!(npm_errno_from_exit_status(Some(152)), "ECONNRESET");
}

#[test]
fn transient_errno_exit_without_stderr_stays_unexpected() {
    #[cfg(target_os = "macos")]
    let econnreset_exit = 202;
    #[cfg(target_os = "linux")]
    let econnreset_exit = 152;
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    let econnreset_exit = 202;

    assert_eq!(
        classify_install_failure(Some(econnreset_exit), "", None),
        InstallFailureKind::Unexpected
    );
    assert!(install_failure_report(Some(econnreset_exit), "", None).is_some());
}

#[test]
fn lifecycle_exit_colliding_with_errno_stays_loud() {
    #[cfg(target_os = "macos")]
    let econnreset_exit = 202;
    #[cfg(target_os = "linux")]
    let econnreset_exit = 152;
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    let econnreset_exit = 202;

    let detail = "npm error command failed\nnpm error command sh -c node postinstall.js";
    assert_eq!(
        classify_install_failure(Some(econnreset_exit), detail, None),
        InstallFailureKind::Unexpected
    );
    assert!(install_failure_report(Some(econnreset_exit), detail, None).is_some());
}

#[test]
fn lifecycle_failure_with_named_transient_code_stays_loud() {
    #[cfg(target_os = "macos")]
    let econnreset_exit = 202;
    #[cfg(target_os = "linux")]
    let econnreset_exit = 152;
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    let econnreset_exit = 202;

    let detail = "npm error code ECONNRESET\n\
            npm error command failed\n\
            npm error command sh -c node postinstall.js";
    assert_eq!(
        classify_install_failure(Some(econnreset_exit), detail, None),
        InstallFailureKind::Unexpected
    );
    assert!(install_failure_report(Some(econnreset_exit), detail, None).is_some());
}

#[test]
fn bare_eacces_exit_is_not_suppressed_by_the_errno_route() {
    assert_eq!(
        classify_install_failure(Some(243), "", None),
        InstallFailureKind::Unexpected
    );
    assert!(install_failure_report(Some(243), "", None).is_some());
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
fn lifecycle_output_with_transient_tokens_stays_unexpected_and_loud() {
    let detail = "npm error code 1\n\
            npm error command failed\n\
            npm error command sh -c node postinstall.js\n\
            application output: ETARGET ECONNRESET npm error network";

    assert_eq!(
        classify_install_failure(Some(1), detail, Some("/usr/local")),
        InstallFailureKind::Unexpected
    );
    // The title carries the bounded grouping signature, not npm's exit
    // status (main's `install_failure_signature`); the point of this test is
    // that a lifecycle failure wearing transient tokens stays Unexpected
    // and still reports. npm DID report a lifecycle failure here
    // (`npm_lifecycle_failed=true`, its numeric build-script status collapsed to
    // the empty code), so this is NOT the reopen's "npm reported nothing" subclass
    // and keeps its byte-identical `none:unknown:none` envelope (HQ-DESKTOP-56
    // targets only `npm_lifecycle_failed=false` markerless failures).
    assert_eq!(
        install_failure_report(Some(1), detail, Some("/usr/local")),
        Some("[hq-cli-update] install failed (none:unknown:none)".to_string())
    );
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

#[test]
fn windows_busy_install_target_requires_rename_and_selected_prefix_node_modules() {
    let prefix = r"C:\Users\me\AppData\Roaming\npm";
    for syscall in ["unlink", "open"] {
        let detail = format!(
            "npm error code EBUSY\n\
                 npm error errno -4082\n\
                 npm error syscall {syscall}\n\
                 npm error path C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@indigoai-us\\hq-cli"
        );
        assert!(!is_windows_locked_install_target_failure(
            Some(-4082),
            &detail,
            Some(prefix)
        ));
        assert_ne!(
            classify_install_failure(Some(-4082), &detail, Some(prefix)),
            InstallFailureKind::WindowsLockedInstallTarget,
            "syscall {syscall} must retain its existing failure kind"
        );
    }

    let outside_selected_prefix = "npm error code EBUSY\n\
            npm error errno -4082\n\
            npm error syscall rename\n\
            npm error path C:\\Users\\me\\.npm\\_cacache\\tmp\\node-llama-cpp";
    assert!(!is_windows_locked_install_target_failure(
        Some(-4082),
        outside_selected_prefix,
        Some(prefix)
    ));
    assert_eq!(
        npm_path_shape(outside_selected_prefix, Some(prefix)),
        NpmPathShape::NpmCache
    );
    assert_eq!(
        classify_install_failure(Some(-4082), outside_selected_prefix, Some(prefix)),
        InstallFailureKind::Unexpected
    );
}

#[test]
fn windows_busy_install_target_retry_is_bounded_to_the_shared_attempt_budget() {
    let prefix = r"C:\Users\me\AppData\Roaming\npm";
    let detail = "npm error code EBUSY\n\
            npm error errno -4082\n\
            npm error syscall rename\n\
            npm error path C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@indigoai-us\\hq-cli";
    assert!(should_retry_windows_busy_install_target(
        Some(-4082),
        detail,
        Some(prefix),
        &[],
        4
    ));
    assert!(should_retry_windows_busy_install_target(
        Some(-4082),
        detail,
        Some(prefix),
        &[WINDOWS_BUSY_INSTALL_TARGET_RETRY_RUNG],
        4
    ));
    assert!(!should_retry_windows_busy_install_target(
        Some(1),
        "npm error network ETIMEDOUT",
        Some(prefix),
        &[],
        4
    ));
    assert!(!should_retry_windows_busy_install_target(
        Some(-4082),
        detail,
        Some(prefix),
        &[],
        0
    ));
}

// HQ-DESKTOP-3N: a Windows `EPERM` install failure (exit -4048, the libuv
// errno) means npm could not replace the locked/in-use `hq` binary. It is a
// local-machine condition with the copy-the-command fallback — NOT an
// updater defect — so it must classify as expected and never page Sentry.
#[test]
fn windows_eperm_exit_code_is_an_expected_locked_binary_failure() {
    // The exact event behind HQ-DESKTOP-3N: install exited -4048 with no
    // useful stderr tail. Old behavior classified this as Unexpected and
    // captured "[hq-cli-update] install failed (…)" at Error level.
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

/// HQ-DESKTOP-4G / 4H / 4J: npm's exit status must never be the grouping
/// key. These pin the signature helper that replaced it.
#[test]
fn numeric_npm_error_codes_collapse_so_they_cannot_re_key_the_group() {
    // npm echoes a failed build script's own status as its `code`. That is
    // the exit status by another name, so it must not discriminate.
    assert_eq!(symbolic_npm_error_code("npm error code 1"), "none");
    assert_eq!(symbolic_npm_error_code("npm error code 7"), "none");
    assert_eq!(symbolic_npm_error_code("npm error code 236"), "none");
    // No code line at all is already "none".
    assert_eq!(symbolic_npm_error_code("npm error network reset"), "none");
    // Symbolic codes carry real classification and are preserved.
    assert_eq!(symbolic_npm_error_code("npm error code ENOTDIR"), "ENOTDIR");
    assert_eq!(symbolic_npm_error_code("npm error code EEXIST"), "EEXIST");
    assert_eq!(
        symbolic_npm_error_code("npm error code ELIFECYCLE"),
        "ELIFECYCLE"
    );
}

#[test]
fn lifecycle_signature_keys_on_the_failing_dependency_not_the_exit_status() {
    let stderr = |package: &str, status: &str| {
        format!(
            "npm error code {status}\n\
                 npm error command failed\n\
                 npm error path /Users/alice/.npm-global/lib/node_modules/{package}"
        )
    };
    let prefix = Some("/Users/alice/.npm-global");

    // HQ-DESKTOP-4G (exit/code 1) and HQ-DESKTOP-4H (exit/code 7) are the
    // same better-sqlite3 build; one signature, therefore one issue.
    let four_g = stderr("better-sqlite3", "1");
    let four_h = stderr("better-sqlite3", "7");
    assert_eq!(
        install_failure_signature(InstallFailureKind::UnexpectedLifecycle, &four_g, prefix),
        "lifecycle:better-sqlite3:unknown"
    );
    assert_eq!(
        install_failure_signature(InstallFailureKind::UnexpectedLifecycle, &four_h, prefix),
        install_failure_signature(InstallFailureKind::UnexpectedLifecycle, &four_g, prefix),
    );

    // The under-grouping half of the defect: a different dependency that
    // happens to share an exit status must not share the issue.
    let other = stderr("node-llama-cpp", "1");
    assert_ne!(
        install_failure_signature(InstallFailureKind::UnexpectedLifecycle, &other, prefix),
        install_failure_signature(InstallFailureKind::UnexpectedLifecycle, &four_g, prefix),
    );
}

#[test]
fn non_lifecycle_signatures_stay_distinct_across_code_syscall_and_path_shape() {
    let signature = |detail: &str, prefix: Option<&str>| {
        install_failure_signature(InstallFailureKind::Unexpected, detail, prefix)
    };

    // HQ-DESKTOP-4J: ENOTDIR/mkdir at the global install target.
    let enotdir = "npm error code ENOTDIR\n\
            npm error syscall mkdir\n\
            npm error path /usr/local/lib/node_modules/@indigoai-us/hq-cli";
    assert_eq!(
        signature(enotdir, None),
        "ENOTDIR:mkdir:global-lib-node-modules"
    );

    // Each axis moves the signature independently.
    let same_code_other_syscall = "npm error code ENOTDIR\n\
            npm error syscall open\n\
            npm error path /usr/local/lib/node_modules/@indigoai-us/hq-cli";
    assert_ne!(
        signature(same_code_other_syscall, None),
        signature(enotdir, None)
    );

    let same_code_other_shape = "npm error code ENOTDIR\n\
            npm error syscall mkdir\n\
            npm error path /Users/alice/.npm/_cacache/content-v2";
    assert_ne!(
        signature(same_code_other_shape, None),
        signature(enotdir, None)
    );

    let other_code = "npm error code EEXIST\n\
            npm error syscall mkdir\n\
            npm error path /usr/local/lib/node_modules/@indigoai-us/hq-cli";
    assert_ne!(signature(other_code, None), signature(enotdir, None));
}

#[test]
fn no_signature_carries_an_exit_status_or_a_filesystem_path() {
    let cases: [(InstallFailureKind, &str, Option<&str>); 4] = [
        (
            InstallFailureKind::UnexpectedLifecycle,
            "npm error code 236\n\
                 npm error command failed\n\
                 npm error path /Users/alice/.npm-global/lib/node_modules/better-sqlite3",
            Some("/Users/alice/.npm-global"),
        ),
        (
            InstallFailureKind::Unexpected,
            "npm error code ENOTDIR\n\
                 npm error syscall mkdir\n\
                 npm error path /usr/local/lib/node_modules/@indigoai-us/hq-cli",
            None,
        ),
        (
            InstallFailureKind::ExpectedBinCollision,
            "npm error code EEXIST\nnpm error path /usr/local/bin/hq",
            Some("/usr/local"),
        ),
        (InstallFailureKind::Unexpected, "", None),
    ];

    for (kind, detail, prefix) in cases {
        let signature = install_failure_signature(kind, detail, prefix);
        for status in ["1", "7", "190", "202", "236", "243", "-4048"] {
            assert!(
                !signature.contains(status),
                "signature {signature:?} carries exit status {status}"
            );
        }
        for leak in ["Users", "alice", "usr", "lib/node_modules", "npm error"] {
            assert!(
                !signature.contains(leak),
                "signature {signature:?} leaked {leak:?}"
            );
        }
    }
}

/// A scoped third-party package is the one signature component that is not
/// a closed enumeration. It stays safe because `npm_lifecycle_failure`
/// already gates it through `is_safe_npm_package_name` — the same value the
/// `npm_lifecycle_package` tag has always carried.
#[test]
fn lifecycle_signature_only_ever_carries_a_validated_package_name() {
    let scoped = "npm error code 1\n\
            npm error command failed\n\
            npm error path /Users/alice/.npm-global/lib/node_modules/@vendor/native-addon";
    assert_eq!(
        install_failure_signature(
            InstallFailureKind::UnexpectedLifecycle,
            scoped,
            Some("/Users/alice/.npm-global")
        ),
        "lifecycle:@vendor/native-addon:unknown"
    );
    assert!(is_safe_npm_package_name("@vendor/native-addon"));

    // A package name npm did not hand us in a validatable form falls back
    // to a fixed literal rather than to free text.
    let unattributable = "npm error code 1\n\
            npm error command failed\n\
            npm error path /Users/alice/project/package.json";
    assert_eq!(
        install_failure_signature(
            InstallFailureKind::UnexpectedLifecycle,
            unattributable,
            None
        ),
        "lifecycle:unrecognized:unknown"
    );
}

#[test]
fn npm_lifecycle_cause_classifies_each_closed_value_from_real_failure_evidence() {
    // prebuild-install's own miss message (the better-sqlite3 case: the
    // machine's Node ABI has no published prebuild).
    let prebuild = "npm error code 1\n\
            npm error command sh -c prebuild-install || node-gyp rebuild\n\
            prebuild-install warn install No prebuilt binaries found (target=23.0.0 runtime=node arch=arm64)";
    assert_eq!(npm_lifecycle_cause(prebuild), "prebuild-unavailable");

    // node-gyp fell through to a source build with no compiler present.
    let gyp = "npm error code 1\n\
            gyp ERR! build error\n\
            gyp ERR! stack Error: not found: make\n\
            gyp ERR! System Darwin";
    assert_eq!(npm_lifecycle_cause(gyp), "toolchain-missing");

    // Command Line Tools absent — the macOS non-developer case.
    let clt = "npm error code 1\n\
            xcode-select: note: no developer tools were found, requesting install";
    assert_eq!(npm_lifecycle_cause(clt), "toolchain-missing");

    // node-llama-cpp's cmake-js build with cmake missing.
    let cmake = "npm error code 1\n\
            npm error command sh -c node ./dist/cli/cli.js postinstall\n\
            Error: Cannot find cmake, please install cmake and try again";
    assert_eq!(npm_lifecycle_cause(cmake), "toolchain-missing");

    // A transport errno WHILE fetching a prebuild is a network cause.
    let network = "npm error code 1\n\
            prebuild-install http request to https://github.com failed\n\
            Error: connect ETIMEDOUT 140.82.113.3:443";
    assert_eq!(npm_lifecycle_cause(network), "network");

    // Disk exhaustion dominates.
    let disk = "npm error code 1\n\
            gyp ERR! stack Error: ENOSPC: no space left on device";
    assert_eq!(npm_lifecycle_cause(disk), "disk-space");

    // The command echo alone (no failure evidence) must NOT be classified:
    // naming node-gyp in `sh -c prebuild-install || node-gyp rebuild` does
    // not mean the compiler is missing.
    let command_echo_only = "npm error code 1\n\
            npm error command failed\n\
            npm error command sh -c prebuild-install || node-gyp rebuild";
    assert_eq!(npm_lifecycle_cause(command_echo_only), "unknown");
    assert_eq!(npm_lifecycle_cause(""), "unknown");

    // node-gyp reached the compiler and failed on the CODE, not a missing
    // tool. `gyp ERR!` alone must NOT be read as toolchain-missing (it would
    // mis-advise installing tools the user already has)...
    let gyp_compile_error = "npm error code 1\n\
            gyp ERR! build error\n\
            gyp ERR! stack Error: `make` failed with exit code 2\n\
            ../src/binding.cpp:14:3: error: use of undeclared identifier 'foo'";
    assert_eq!(npm_lifecycle_cause(gyp_compile_error), "unknown");
    // ...and it must not override a prebuild-miss message either.
    let prebuild_then_gyp_compile_error = "npm error code 1\n\
            prebuild-install warn install No prebuilt binaries found\n\
            gyp ERR! build error\n\
            ../src/binding.cpp:14:3: error: use of undeclared identifier 'foo'";
    assert_eq!(
        npm_lifecycle_cause(prebuild_then_gyp_compile_error),
        "prebuild-unavailable"
    );
}

#[test]
fn npm_lifecycle_cause_only_ever_returns_a_closed_constant_even_for_adversarial_input() {
    let allowed = [
        "prebuild-unavailable",
        "toolchain-missing",
        "network",
        "disk-space",
        "postinstall-script",
        "unknown",
    ];
    for adversarial in [
        "npm error code 1\nnpm error path /Users/attacker/../../etc/passwd\nlifecycle_cause=INJECTED node_version=99",
        "gyp ERR! /home/victim/secret token=abc123 No prebuilt binaries found",
        "ENOSPC ETIMEDOUT prebuild download https:// cmake not found xcode-select",
        "\u{0}\u{1}\u{2} No PREBUILT Binaries Found \u{7f}",
        "random build noise with no recognizable failure token",
        "npm error command failed\nnpm error command sh -c node ./dist/cli/cli.js postinstall\ntoken=abc /Users/victim/secret",
    ] {
        let cause = npm_lifecycle_cause(adversarial);
        assert!(
            allowed.contains(&cause),
            "cause {cause:?} is not one of the closed constants"
        );
    }
}

#[test]
fn npm_lifecycle_cause_diagnoses_a_bare_postinstall_script_failure() {
    // node-llama-cpp's reported shape WITHOUT a "cannot find cmake" line: a
    // postinstall script that failed with no native-builder output. This is
    // exactly the case that used to degrade to `unknown`.
    let postinstall = "npm error code 1\n\
            npm error path /usr/local/lib/node_modules/node-llama-cpp\n\
            npm error command failed\n\
            npm error command sh -c node ./dist/cli/cli.js postinstall\n\
            Error: postinstall failed while resolving the local binary";
    assert_eq!(npm_lifecycle_cause(postinstall), "postinstall-script");

    // But a "cannot find cmake" postinstall stays the more-actionable
    // toolchain-missing (checked first), never downgraded to postinstall.
    let cmake_missing = "npm error code 1\n\
            npm error command sh -c node ./dist/cli/cli.js postinstall\n\
            Error: Cannot find cmake, please install cmake and try again";
    assert_eq!(npm_lifecycle_cause(cmake_missing), "toolchain-missing");

    // A command echo naming node-gyp is NOT a postinstall script failure and
    // must stay `unknown` — the postinstall arm needs the postinstall token.
    let command_echo_only = "npm error code 1\n\
            npm error command failed\n\
            npm error command sh -c prebuild-install || node-gyp rebuild";
    assert_eq!(npm_lifecycle_cause(command_echo_only), "unknown");
}

#[test]
fn npm_lifecycle_cause_recognizes_cmake_js_prebuilt_miss_vocabulary() {
    // cmake-js reporting no matching prebuilt for this runtime is the same
    // "your Node has no prebuild" condition as prebuild-install's own miss.
    let cmake_js_miss = "npm error code 1\n\
            npm error path /usr/local/lib/node_modules/node-llama-cpp\n\
            npm error command failed\n\
            cmake-js WARN No prebuilt binary available for this platform, building from source";
    assert_eq!(npm_lifecycle_cause(cmake_js_miss), "prebuild-unavailable");

    // The guard is real: a bare "no prebuilt" without cmake-js context must
    // still go through the prebuild-install message path, and "cmake not
    // found" (no cmake-js miss vocabulary) must NOT become prebuild-unavailable.
    let cmake_not_found = "npm error code 1\n\
            npm error command sh -c node ./dist/cli/cli.js postinstall\n\
            Error: Cannot find cmake, please install cmake and try again";
    assert_eq!(npm_lifecycle_cause(cmake_not_found), "toolchain-missing");
}

#[test]
fn npm_lifecycle_builder_derives_only_from_builder_output_never_the_command_echo() {
    // node-gyp's own leveled log prefix.
    assert_eq!(
        npm_lifecycle_builder("npm error command failed\ngyp ERR! stack Error: not found: make"),
        "node-gyp"
    );
    // node-gyp wins over a preceding prebuild miss — it is the builder that
    // actually ran and failed.
    assert_eq!(
        npm_lifecycle_builder(
            "prebuild-install warn install No prebuilt binaries found\ngyp ERR! build error"
        ),
        "node-gyp"
    );
    // cmake-js / CMake's own build output.
    assert_eq!(
        npm_lifecycle_builder(
            "npm error command failed\nCMake Error: could not configure the project"
        ),
        "cmake-js"
    );
    // prebuild-install's own leveled log / miss message.
    assert_eq!(
        npm_lifecycle_builder(
            "prebuild-install warn install No prebuilt binaries found (target=23.0.0)"
        ),
        "prebuild-install"
    );
    // A lifecycle failure with NO native-builder output is the postinstall
    // residual.
    assert_eq!(
        npm_lifecycle_builder(
            "npm error command failed\nnpm error command sh -c node ./dist/cli/cli.js postinstall"
        ),
        "postinstall-script"
    );
    // The command echo alone names node-gyp/prebuild-install but proves
    // neither ran AND names no lifecycle stage, so it is attributed to no
    // builder at all — `unknown`, never the postinstall residual (which would
    // corrupt the builder telemetry this change makes reliable).
    assert_eq!(
        npm_lifecycle_builder(
            "npm error command failed\nnpm error command sh -c prebuild-install || node-gyp rebuild"
        ),
        "unknown"
    );
    // No lifecycle marker at all -> unknown builder.
    assert_eq!(npm_lifecycle_builder("npm error code ENOTDIR"), "unknown");
    assert_eq!(npm_lifecycle_builder(""), "unknown");
}

#[test]
fn npm_lifecycle_builder_requires_explicit_postinstall_stage_evidence() {
    // node-llama-cpp's reported shape: a postinstall entrypoint command with no
    // native-builder output. The `postinstall` token is present, so it is the
    // postinstall residual.
    assert_eq!(
        npm_lifecycle_builder(
            "npm error code 1\n\
                 npm error command failed\n\
                 npm error command sh -c node ./dist/cli/cli.js postinstall"
        ),
        "postinstall-script"
    );
    // npm's explicit stage attribution line also counts (older-npm shape,
    // which carries the ELIFECYCLE marker alongside the stage line).
    assert_eq!(
        npm_lifecycle_builder(
            "npm error code ELIFECYCLE\n\
                 npm error Failed at the node-llama-cpp@3.18.1 postinstall script."
        ),
        "postinstall-script"
    );
    // The truncated better-sqlite3 echo carries the lifecycle marker but names
    // no stage and shows no builder output. It MUST stay `unknown` — this is
    // the P2 residual that used to mis-tag it postinstall-script.
    assert_eq!(
        npm_lifecycle_builder(
            "npm error command failed\n\
                 npm error command sh -c prebuild-install || node-gyp rebuild"
        ),
        "unknown"
    );
    // A lifecycle marker with neither builder output nor a postinstall token
    // stays `unknown` too.
    assert_eq!(
        npm_lifecycle_builder("npm error code ELIFECYCLE\nnpm error errno 1"),
        "unknown"
    );
}

#[test]
fn npm_lifecycle_builder_only_ever_returns_a_closed_constant() {
    let allowed = [
        "prebuild-install",
        "node-gyp",
        "cmake-js",
        "postinstall-script",
        "unknown",
    ];
    for adversarial in [
        "gyp ERR! /home/victim/secret token=abc123",
        "cmake error /Users/attacker/../../etc/passwd",
        "npm error command failed\nnpm error command sh -c node ./x.js postinstall\n\u{0}\u{7f}",
        "random build noise with no recognizable builder token",
        "",
    ] {
        let builder = npm_lifecycle_builder(adversarial);
        assert!(
            allowed.contains(&builder),
            "builder {builder:?} is not one of the closed constants"
        );
    }
}

#[test]
fn sanitized_version_token_accepts_only_bounded_numeric_tokens() {
    assert_eq!(sanitized_version_token(Some("22.17.0")), "22.17.0");
    assert_eq!(sanitized_version_token(Some("v22.17.0")), "22.17.0");
    assert_eq!(sanitized_version_token(Some(" 127 ")), "127");
    // Anything non-numeric, empty, absent, or over-long collapses to unknown
    // so no caller-supplied free text can reach Sentry through the tag.
    assert_eq!(sanitized_version_token(None), "unknown");
    assert_eq!(sanitized_version_token(Some("")), "unknown");
    assert_eq!(sanitized_version_token(Some("22.17.0-nightly")), "unknown");
    assert_eq!(sanitized_version_token(Some("/Users/alice")), "unknown");
    assert_eq!(sanitized_version_token(Some("22; rm -rf")), "unknown");
    assert_eq!(
        sanitized_version_token(Some("1234567890123456789012345")),
        "unknown"
    );
    assert_eq!(sanitized_version_token(Some("v")), "unknown");
}

#[test]
fn npm_toolchain_source_tags_are_closed() {
    assert_eq!(NpmToolchainSource::Managed.tag_value(), "managed");
    assert_eq!(NpmToolchainSource::UserPath.tag_value(), "user-path");
    assert_eq!(NpmToolchainSource::Unknown.tag_value(), "unknown");
    assert_eq!(NpmToolchainSource::default(), NpmToolchainSource::Unknown);
}

#[test]
fn install_failure_episode_key_is_only_minted_for_third_party_lifecycle_failures() {
    let better_sqlite3 = "npm error code 1\n\
            npm error command failed\n\
            npm error path /usr/local/lib/node_modules/better-sqlite3\n\
            prebuild-install warn install No prebuilt binaries found";
    assert_eq!(
        install_failure_episode_key("5.97.0", better_sqlite3).as_deref(),
        Some("5.97.0|better-sqlite3|prebuild-unavailable")
    );

    // An owned package, an unattributable build, and a plain non-lifecycle
    // failure never get a key — they keep paging every time.
    let owned = "npm error code 1\n\
            npm error command failed\n\
            npm error path /usr/local/lib/node_modules/@indigoai-us/hq-cli";
    assert_eq!(install_failure_episode_key("5.97.0", owned), None);
    assert_eq!(
        install_failure_episode_key("5.97.0", "npm error code ENOTDIR"),
        None
    );
}

#[test]
fn partial_install_scope_from_npm_path_is_the_at_indigoai_us_scope_or_nothing() {
    let path_detail = |p: &str| format!("npm error path {p}");

    // The scope dir itself, the `hq-cli` package dir, and a `.hq-cli-*`
    // staging dir all resolve to the SAME `@indigoai-us` scope — the exact
    // directory the prefix-derived remedy targets.
    let scope = "/Users/mike/Library/Application Support/Indigo HQ/toolchain/npm-global/lib/node_modules/@indigoai-us";
    for suffix in ["", "/hq-cli", "/.hq-cli-0DY3ww6z"] {
        assert_eq!(
            partial_install_scope_from_npm_path(&path_detail(&format!("{scope}{suffix}")))
                .as_deref(),
            Some(scope),
            "suffix {suffix:?}"
        );
    }

    // The real HQ-DESKTOP-5B stderr (path + dest lines): npm_path_value reads
    // the `path` line, which truncates to the scope dir.
    let real = "npm error code ENOTEMPTY\n\
            npm error syscall rename\n\
            npm error path /usr/local/lib/node_modules/@indigoai-us/hq-cli\n\
            npm error dest /usr/local/lib/node_modules/@indigoai-us/.hq-cli-0DY3ww6z\n\
            npm error ENOTEMPTY: directory not empty, rename";
    assert_eq!(
        partial_install_scope_from_npm_path(real).as_deref(),
        Some("/usr/local/lib/node_modules/@indigoai-us")
    );

    // A Windows drive path (backslashes already normalised by npm_path_value)
    // resolves too, keeping the drive root.
    assert_eq!(
        partial_install_scope_from_npm_path(&path_detail(
            "C:\\Users\\mike\\AppData\\Roaming\\npm\\node_modules\\@indigoai-us\\hq-cli"
        ))
        .as_deref(),
        Some("C:/Users/mike/AppData/Roaming/npm/node_modules/@indigoai-us")
    );

    // Every ambiguity fails closed to None — a path npm reported that fails the
    // component check yields no scope, so no deletion and no retry happen.
    for adversarial in [
        // Relative path — cannot anchor a deletion.
        "node_modules/@indigoai-us/hq-cli",
        // No node_modules component at all.
        "/usr/local/lib/@indigoai-us/hq-cli",
        // A merely-substring match, not an exact component.
        "/usr/local/lib/node_modules/@indigoai-usx/hq-cli",
        // A bare filesystem root.
        "/",
        // `@indigoai-us` as a plain file basename whose parent is not
        // node_modules.
        "/Users/mike/@indigoai-us",
        // The marker is present but the parent component is wrong.
        "/usr/local/node_modules_backup/@indigoai-us/hq-cli",
        // A valid scope pair, but it leads to an UNRELATED package, not hq-cli
        // or its staging dir — never our debris, so no scope.
        "/usr/local/lib/node_modules/@indigoai-us/some-other-pkg",
    ] {
        assert_eq!(
            partial_install_scope_from_npm_path(&path_detail(adversarial)),
            None,
            "adversarial: {adversarial}"
        );
    }

    // A NESTED path with two `node_modules/@indigoai-us` pairs resolves to the
    // INNER one that actually leads to hq-cli — never the unrelated outer scope.
    assert_eq!(
        partial_install_scope_from_npm_path(&path_detail(
            "/work/node_modules/@indigoai-us/toolchain/lib/node_modules/@indigoai-us/hq-cli"
        ))
        .as_deref(),
        Some("/work/node_modules/@indigoai-us/toolchain/lib/node_modules/@indigoai-us")
    );

    // Genuinely AMBIGUOUS — two pairs each lead to hq-cli — fails closed to None
    // so an ambiguous path never widens the blast radius.
    assert_eq!(
        partial_install_scope_from_npm_path(&path_detail(
            "/a/node_modules/@indigoai-us/hq-cli/x/node_modules/@indigoai-us/hq-cli"
        )),
        None
    );

    // No `npm error path` line at all yields nothing.
    assert_eq!(
        partial_install_scope_from_npm_path("npm error code ENOTEMPTY"),
        None
    );
}

#[test]
fn unexpected_install_failure_episode_key_pages_once_per_version_and_signature() {
    // The HQ-DESKTOP-5B ENOTEMPTY wedge with no resolved prefix — the exact
    // shape 61/61 events took. It is a plain `Unexpected` failure, so it now
    // mints the bounded repeat-guard key from its closed-enumeration signature.
    let enotempty = "npm error code ENOTEMPTY\n\
            npm error syscall rename\n\
            npm error path /usr/local/lib/node_modules/@indigoai-us/hq-cli\n\
            npm error dest /usr/local/lib/node_modules/@indigoai-us/.hq-cli-0DY3ww6z";
    let latest = "5.103.17";
    // The recorded 5B environment: node 22.23.1, npm 10.9.8, user-path.
    let env = InstallEnvironment {
        node_version: Some("22.23.1".to_string()),
        node_abi: Some("127".to_string()),
        npm_version: Some("10.9.8".to_string()),
        toolchain_source: NpmToolchainSource::UserPath,
        managed_toolchain_retry: false,
        ..Default::default()
    };
    let key = install_failure_episode_key_with_environment(
        Some(190),
        enotempty,
        None,
        false,
        latest,
        &env,
    )
    .expect("an unexpected ENOTEMPTY wedge mints an episode key");
    assert_eq!(
        key,
        "5.103.17|unexpected|ENOTEMPTY|rename|global-lib-node-modules"
    );

    // A second identical report under the same target version is suppressed —
    // the noise bound the fix exists to add.
    assert!(install_failure_episode_blocked(&[key.clone()], &key));

    // A newer published CLI version mints a DISTINCT key, so the same wedge
    // pages a first occurrence again and the bound never hides it.
    let bumped = install_failure_episode_key_with_environment(
        Some(190),
        enotempty,
        None,
        false,
        "5.103.18",
        &env,
    );
    assert_eq!(
        bumped.as_deref(),
        Some("5.103.18|unexpected|ENOTEMPTY|rename|global-lib-node-modules")
    );
    assert!(!install_failure_episode_blocked(
        &[key.clone()],
        bumped.as_deref().unwrap()
    ));

    // A different signature (here the syscall) is a different key.
    let different_syscall = "npm error code ENOTEMPTY\n\
            npm error syscall mkdir\n\
            npm error path /usr/local/lib/node_modules/@indigoai-us/hq-cli";
    let other = install_failure_episode_key_with_environment(
        Some(190),
        different_syscall,
        None,
        false,
        latest,
        &env,
    );
    assert_eq!(
        other.as_deref(),
        Some("5.103.17|unexpected|ENOTEMPTY|mkdir|global-lib-node-modules")
    );
    assert!(!install_failure_episode_blocked(
        &[key.clone()],
        other.as_deref().unwrap()
    ));

    // Managed provenance mints a distinct key, so a managed-retry event never
    // collides with its user-path predecessor.
    let mut managed_env = env.clone();
    managed_env.managed_toolchain_retry = true;
    let managed = install_failure_episode_key_with_environment(
        Some(190),
        enotempty,
        None,
        false,
        latest,
        &managed_env,
    );
    assert_eq!(
        managed.as_deref(),
        Some("5.103.17|unexpected|ENOTEMPTY|rename|global-lib-node-modules|managed")
    );

    // The pre-existing shapes are unchanged: a third-party lifecycle failure
    // still mints its package/cause key, and an expected transient failure
    // (now including EIDLETIMEOUT) still mints nothing.
    let lifecycle = "npm error code 1\n\
            npm error command failed\n\
            npm error path /usr/local/lib/node_modules/better-sqlite3\n\
            prebuild-install warn install No prebuilt binaries found";
    assert_eq!(
        install_failure_episode_key_with_environment(
            Some(1),
            lifecycle,
            None,
            false,
            latest,
            &InstallEnvironment::default(),
        )
        .as_deref(),
        Some("5.103.17|better-sqlite3|prebuild-unavailable")
    );
    assert_eq!(
        install_failure_episode_key_with_environment(
            Some(1),
            "npm error code EIDLETIMEOUT",
            None,
            false,
            latest,
            &InstallEnvironment::default(),
        ),
        None
    );

    // A GENUINELY shapeless failure — empty stderr, npm structured nothing — is
    // still deliberately NOT bounded: it mints no key and keeps paging every
    // check, so a different newly introduced failure sharing that empty signature
    // is never hidden behind an earlier one (commit e24e7a45).
    assert_eq!(
        install_failure_episode_key_with_environment(
            Some(1),
            "",
            None,
            false,
            latest,
            &InstallEnvironment::default(),
        ),
        None
    );
    // A NON-EMPTY markerless failure (HQ-DESKTOP-56) now DOES earn a bounded key
    // from its structural attribution, so it pages once per published CLI version
    // instead of on every ~6-hourly check. `SyntaxError: …` is one bare
    // `identifier:` line, so the dominant shape is `key_colon` and the origin is
    // `non-npm` (npm's logger emitted nothing).
    assert_eq!(
        install_failure_episode_key_with_environment(
            Some(1),
            "SyntaxError: Unexpected token export",
            None,
            false,
            latest,
            &InstallEnvironment::default(),
        )
        .as_deref(),
        Some("5.103.17|unattributed|non-npm|key_colon")
    );
}

#[test]
fn managed_toolchain_retry_is_a_distinct_repeat_guard_episode() {
    let better_sqlite3 = "npm error code 1\n\
            npm error command failed\n\
            npm error path /usr/local/lib/node_modules/better-sqlite3\n\
            prebuild-install warn install No prebuilt binaries found";

    // Same (version, package, cause), but the managed retry carries a DISTINCT
    // key so its provenance-bearing event can never collide with the user-path
    // failure that preceded it.
    let user_key = install_failure_episode_key_with_provenance("5.97.0", better_sqlite3, false);
    let managed_key = install_failure_episode_key_with_provenance("5.97.0", better_sqlite3, true);
    assert_eq!(
        user_key.as_deref(),
        Some("5.97.0|better-sqlite3|prebuild-unavailable")
    );
    assert_eq!(
        managed_key.as_deref(),
        Some("5.97.0|better-sqlite3|prebuild-unavailable|managed")
    );
    assert_ne!(user_key, managed_key);

    // A prior user-path report for this (version, package, cause) must NOT
    // suppress the managed retry — otherwise the managed provenance the retry
    // exists to emit is silently dropped.
    let reported = [user_key.clone().unwrap()];
    assert!(install_failure_episode_blocked(
        &reported,
        user_key.as_deref().unwrap()
    ));
    assert!(!install_failure_episode_blocked(
        &reported,
        managed_key.as_deref().unwrap()
    ));

    // A REPEATED managed failure is still suppressed — the guard keeps working
    // within the managed provenance, so a permanent managed-build failure stops
    // re-paging on every scheduled check.
    let after =
        install_failure_episode_record(&reported, managed_key.as_deref().unwrap(), "5.97.0");
    assert!(after.contains(user_key.as_ref().unwrap()));
    assert!(install_failure_episode_blocked(
        &after,
        managed_key.as_deref().unwrap()
    ));

    // A non-lifecycle failure gets no key regardless of provenance — it keeps
    // paging every time, whichever toolchain ran it.
    assert_eq!(
        install_failure_episode_key_with_provenance("5.97.0", "npm error code ENOTDIR", true),
        None
    );
}

#[test]
fn install_failure_episode_blocked_suppresses_only_a_key_in_the_reported_set() {
    let reported = [
        "5.97.0|better-sqlite3|prebuild-unavailable".to_string(),
        "5.97.0|node-llama-cpp|toolchain-missing".to_string(),
    ];
    // Any key already in the set is suppressed...
    assert!(install_failure_episode_blocked(
        &reported,
        "5.97.0|better-sqlite3|prebuild-unavailable"
    ));
    assert!(install_failure_episode_blocked(
        &reported,
        "5.97.0|node-llama-cpp|toolchain-missing"
    ));
    // ...while a changed version, package, or cause is not.
    assert!(!install_failure_episode_blocked(
        &reported,
        "5.98.0|better-sqlite3|prebuild-unavailable"
    ));
    assert!(!install_failure_episode_blocked(
        &reported,
        "5.97.0|better-sqlite3|toolchain-missing"
    ));
    // An empty (unreadable) marker → nothing blocked → fail-closed (report).
    assert!(!install_failure_episode_blocked(
        &[],
        "5.97.0|better-sqlite3|prebuild-unavailable"
    ));
}

#[test]
fn install_failure_episode_record_retains_every_current_version_key() {
    let a = "5.97.0|better-sqlite3|prebuild-unavailable".to_string();
    let b = "5.97.0|node-llama-cpp|toolchain-missing".to_string();

    // Recording A then B keeps BOTH for the version, so an A/B/A interleave
    // (the exact failure mode of a single-slot marker) stays suppressed.
    let after_a = install_failure_episode_record(&[], &a, "5.97.0");
    assert_eq!(after_a, vec![a.clone()]);
    let after_b = install_failure_episode_record(&after_a, &b, "5.97.0");
    assert!(after_b.contains(&a) && after_b.contains(&b));
    assert!(install_failure_episode_blocked(&after_b, &a));
    // Re-recording A does not duplicate it.
    let after_aba = install_failure_episode_record(&after_b, &a, "5.97.0");
    assert_eq!(
        after_aba.iter().filter(|k| **k == a).count(),
        1,
        "a re-reported key must not be duplicated"
    );

    // A new target version resets the set: prior-version keys are dropped.
    let bumped = install_failure_episode_record(
        &after_b,
        "5.98.0|better-sqlite3|prebuild-unavailable",
        "5.98.0",
    );
    assert_eq!(bumped, vec!["5.98.0|better-sqlite3|prebuild-unavailable"]);

    // The set is bounded to MAX_INSTALL_FAILURE_EPISODE_KEYS.
    let mut acc: Vec<String> = Vec::new();
    for i in 0..(MAX_INSTALL_FAILURE_EPISODE_KEYS + 5) {
        acc = install_failure_episode_record(&acc, &format!("9.0.0|pkg{i}|unknown"), "9.0.0");
    }
    assert_eq!(acc.len(), MAX_INSTALL_FAILURE_EPISODE_KEYS);
    assert!(
        acc.iter().all(|k| k.starts_with("9.0.0|")),
        "bounded set must only hold current-version keys"
    );
}

#[test]
fn cause_specific_install_failure_detail_stays_actionable_with_the_copyable_command() {
    let base = |cause_body: &str| {
        format!(
            "npm error code 1\n\
                 npm error command failed\n\
                 npm error path /usr/local/lib/node_modules/better-sqlite3\n\
                 {cause_body}"
        )
    };
    let toolchain = base("gyp ERR! stack Error: not found: make");
    let detail = install_failure_detail(Some(1), &toolchain, Some("/usr/local"));
    // Gate-2 finding: HQ never sends a person to Apple's developer tools.
    assert!(!detail.contains("xcode-select"), "got: {detail}");
    assert!(detail.contains("build tools"), "got: {detail}");
    assert!(detail.contains("copied command"), "got: {detail}");

    let prebuild = base("prebuild-install warn install No prebuilt binaries found");
    let detail = install_failure_detail(Some(1), &prebuild, Some("/usr/local"));
    assert!(detail.contains("version 22"), "got: {detail}");
    assert!(detail.contains("copied command"), "got: {detail}");

    let network = base("prebuild-install download https:// failed: connect ETIMEDOUT");
    let detail = install_failure_detail(Some(1), &network, Some("/usr/local"));
    assert!(detail.contains("could not be downloaded"), "got: {detail}");
    assert!(detail.contains("copied command"), "got: {detail}");

    let disk = base("gyp ERR! ENOSPC: no space left on device");
    let detail = install_failure_detail(Some(1), &disk, Some("/usr/local"));
    assert!(detail.contains("disk space"), "got: {detail}");
    assert!(detail.contains("copied command"), "got: {detail}");

    // The unclassified case keeps the original generic-but-actionable copy.
    let unknown = base("some build noise with no recognizable cause");
    let detail = install_failure_detail(Some(1), &unknown, Some("/usr/local"));
    assert!(detail.contains("dependency build step"), "got: {detail}");
    assert!(detail.contains("copied command"), "got: {detail}");
}

#[test]
fn lifecycle_signature_splits_a_prebuild_gap_from_a_missing_compiler() {
    let path = "npm error path /usr/local/lib/node_modules/better-sqlite3";
    let prebuild = format!(
        "npm error code 1\nnpm error command failed\n{path}\nprebuild-install warn install No prebuilt binaries found"
    );
    let toolchain = format!(
        "npm error code 1\nnpm error command failed\n{path}\ngyp ERR! stack Error: not found: make"
    );
    let prefix = Some("/usr/local");
    let prebuild_sig =
        install_failure_signature(InstallFailureKind::UnexpectedLifecycle, &prebuild, prefix);
    let toolchain_sig =
        install_failure_signature(InstallFailureKind::UnexpectedLifecycle, &toolchain, prefix);
    assert_eq!(
        prebuild_sig,
        "lifecycle:better-sqlite3:prebuild-unavailable"
    );
    assert_eq!(toolchain_sig, "lifecycle:better-sqlite3:toolchain-missing");
    assert_ne!(
        prebuild_sig, toolchain_sig,
        "a prebuild gap and a missing compiler must not share one issue"
    );
}

#[test]
fn install_failure_report_captures_genuine_failures() {
    // A real, unexpected failure stays loud — `Some(message)` drives the
    // Error-level capture. npm printed a marker line but structured no
    // code/syscall/path, so this NON-EMPTY markerless failure now groups under the
    // attributed `unattributed:npm-logger:<dominant shape>` signature
    // (HQ-DESKTOP-56); the single marker line classifies as `other`.
    assert_eq!(
        install_failure_report(Some(1), "npm error network ETIMEDOUT", None),
        Some("[hq-cli-update] install failed (unattributed:npm-logger:other)".to_string()),
    );
    // Killed by signal (no exit code) still reports — and now lands in the
    // same group as the exit-1 run, because the cause is the same.
    assert_eq!(
        install_failure_report(None, "npm error network ETIMEDOUT", None),
        install_failure_report(Some(1), "npm error network ETIMEDOUT", None),
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
    // HQ-DESKTOP-3P: a definitively-unbacked FOREIGN hq (PackageNotFound,
    // outside every managed root) whose version cannot be read is not an
    // install — it is silent-and-installable, not a forever-report. The three
    // probe outcomes still stay distinct.
    assert_eq!(result.probes.hq_backing, HqBacking::UnbackedForeign);
    assert!(!result.hq_installed);
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
    assert!(!should_report_unreadable_version(&result));
    assert!(cli_install_needed(None, "5.103.30", result.hq_installed));
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

    // This assertion is about PATH-based shebang resolution, not the
    // production one-second watchdog. The child deliberately crosses env
    // and a shell, so keep its bounded test deadline independent of runner
    // scheduling; timeout behavior is covered by the watchdog tests.
    let result = probe_local_version_with_timeout(
        Some(&hq),
        Some(npm.to_str().unwrap()),
        interpreter_dir.to_str().unwrap(),
        Duration::from_secs(10),
    );

    assert_eq!(
        result.local.as_deref(),
        Some("5.88.1"),
        "{:?}",
        result.probes
    );
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
    // HQ-DESKTOP-3P: this pnpm shim is definitively unbacked and foreign, so it
    // is silent-and-installable — the still-reporting interpreter-gap case is
    // unprovisioned_managed_node_keeps_reporting_and_names_the_gap.
    assert_eq!(result.probes.hq_backing, HqBacking::UnbackedForeign);
    assert!(!should_report_unreadable_version(&result));
    assert!(cli_install_needed(None, "5.103.30", result.hq_installed));
}

// ---- HQ-DESKTOP-3P: managed-Node interpreter recovery ------------------

/// HQ-DESKTOP-3P reproduction: a resolved `hq` shim in an npm-prefix `bin`
/// dir whose `env node` interpreter is not on the child PATH, with no npm and
/// no managed Node, produces the EXACT production quadruple — and, because the
/// shim is definitively unbacked and FOREIGN (PackageNotFound outside every
/// managed root), the machine now CONVERGES VIA INSTALL rather than reporting
/// the same unreadable-version warning forever. The four probe fields are the
/// byte-identical production set (`managed = None` matches the base commit);
/// only the reporting / `hq_installed` decision is the corrected one.
#[test]
#[cfg(unix)]
fn unreadable_version_reproduces_the_production_quadruple_and_converges_via_install() {
    let tmp = tempfile::TempDir::new().unwrap();
    let bin = tmp.path().join("bin");
    let hq = bin.join("hq");
    std::fs::create_dir_all(&bin).unwrap();
    write_executable(&hq, "#!/usr/bin/env node\n");

    let result =
        probe_local_version_with_managed(Some(&hq), ResolvedProgramKind::Exe, None, None, "");

    assert_eq!(result.local, None);
    assert_eq!(result.probes.hq_backing, HqBacking::UnbackedForeign);
    assert!(!result.hq_installed);
    assert_eq!(
        result.probes.binary_anchor,
        VersionProbeOutcome::PackageNotFound
    );
    assert_eq!(result.probes.npm_root, VersionProbeOutcome::NotAttempted);
    assert_eq!(
        result.probes.hq_version,
        VersionProbeOutcome::InterpreterNotFound
    );
    assert_eq!(
        result.probes.binary_anchor_shape,
        BinaryAnchorShape::NpmPrefix
    );
    assert_eq!(
        result.probes.resolved_program_kind,
        ResolvedProgramKind::Exe
    );
    assert!(!should_report_unreadable_version(&result));
    assert!(cli_install_needed(None, "5.103.30", result.hq_installed));
}

/// HQ-DESKTOP-3P fix: with HQ's managed Node present, the same otherwise
/// unreadable shim reads its version by retrying with the managed Node's bin
/// dir on the child PATH — so NO unreadable-version event is emitted. The
/// four non-`hq_version` fields keep their production meaning; only
/// `hq_version` flips to Succeeded.
#[test]
#[cfg(unix)]
fn recovers_version_through_managed_node_when_env_node_is_absent() {
    let tmp = tempfile::TempDir::new().unwrap();
    let bin = tmp.path().join("bin");
    let hq = bin.join("hq");
    std::fs::create_dir_all(&bin).unwrap();
    write_executable(&hq, "#!/usr/bin/env node\n");

    // Managed Node: a `node` in its own bin dir that answers `--version`.
    let managed_bin = tmp.path().join("managed/node/bin");
    std::fs::create_dir_all(&managed_bin).unwrap();
    let node = managed_bin.join("node");
    write_executable(&node, "#!/bin/sh\nprintf 'v5.99.0\\n'\n");
    let managed = crate::toolchain::ManagedRuntime::Present { node };

    let result = probe_local_version_with_managed(
        Some(&hq),
        ResolvedProgramKind::Exe,
        Some(&managed),
        None,
        "",
    );

    assert_eq!(result.local.as_deref(), Some("5.99.0"));
    assert!(!should_report_unreadable_version(&result));
    assert_eq!(result.probes.hq_version, VersionProbeOutcome::Succeeded);
    assert_eq!(result.probes.managed_runtime, ManagedRuntimeState::Present);
    assert_eq!(
        result.probes.interpreter_recovery,
        InterpreterRecovery::RecoveredWithManagedNode
    );
    // The four original fields keep their production meaning.
    assert_eq!(
        result.probes.binary_anchor,
        VersionProbeOutcome::PackageNotFound
    );
    assert_eq!(result.probes.npm_root, VersionProbeOutcome::NotAttempted);
    assert_eq!(
        result.probes.binary_anchor_shape,
        BinaryAnchorShape::NpmPrefix
    );
    assert_eq!(
        result.probes.resolved_program_kind,
        ResolvedProgramKind::Exe
    );
}

/// The direct `<node> <program>` retry recovers when the shim names node but
/// the managed Node executable is NOT itself named `node` — so `env node` on
/// the widened PATH still misses and only the direct invocation works. This
/// isolates the second retry from the first.
#[test]
#[cfg(unix)]
fn recovers_via_direct_managed_node_when_env_node_lookup_still_misses() {
    let tmp = tempfile::TempDir::new().unwrap();
    let bin = tmp.path().join("bin");
    let hq = bin.join("hq");
    std::fs::create_dir_all(&bin).unwrap();
    write_executable(&hq, "#!/usr/bin/env node\n");

    let managed_bin = tmp.path().join("managed/node/bin");
    std::fs::create_dir_all(&managed_bin).unwrap();
    let node = managed_bin.join("hqnode");
    write_executable(&node, "#!/bin/sh\nprintf 'v6.0.1\\n'\n");
    let managed = crate::toolchain::ManagedRuntime::Present { node };

    let result = probe_local_version_with_managed(
        Some(&hq),
        ResolvedProgramKind::Exe,
        Some(&managed),
        None,
        "",
    );

    assert_eq!(result.local.as_deref(), Some("6.0.1"));
    assert_eq!(
        result.probes.interpreter_recovery,
        InterpreterRecovery::RecoveredWithManagedNode
    );
    assert!(!should_report_unreadable_version(&result));
}

/// With `ManagedRuntime::NotProvisioned` the outcome stays
/// `InterpreterNotFound`, the recovery is `ManagedNodeAbsent`, and the event
/// STILL reports — no silent swallow of the unreadable-version signal.
#[test]
#[cfg(unix)]
fn unprovisioned_managed_node_keeps_reporting_and_names_the_gap() {
    let tmp = tempfile::TempDir::new().unwrap();
    let bin = tmp.path().join("bin");
    let hq = bin.join("hq");
    std::fs::create_dir_all(&bin).unwrap();
    write_executable(&hq, "#!/usr/bin/env node\n");
    // HQ-DESKTOP-3P: a manifest PRESENT beside the shim but unparseable keeps
    // the backing INDETERMINATE (NotProbed) — a real install we cannot prove
    // absent still reports; only a definitively-foreign shim is silent-and-
    // installable (see definitively_unbacked_foreign_hq_is_not_installed_and_converges).
    std::fs::write(bin.join("package.json"), b"{ not valid json\n").unwrap();

    let managed = crate::toolchain::ManagedRuntime::NotProvisioned;
    let result = probe_local_version_with_managed(
        Some(&hq),
        ResolvedProgramKind::Exe,
        Some(&managed),
        None,
        "",
    );

    assert_eq!(result.local, None);
    assert_eq!(
        result.probes.hq_version,
        VersionProbeOutcome::InterpreterNotFound
    );
    assert_eq!(
        result.probes.managed_runtime,
        ManagedRuntimeState::NotProvisioned
    );
    assert_eq!(
        result.probes.interpreter_recovery,
        InterpreterRecovery::ManagedNodeAbsent
    );
    assert!(should_report_unreadable_version(&result));
}

/// The direct `<node> <program>` invocation is never attempted when the
/// resolved program has no node-naming shebang; only the widened-PATH retry
/// runs. A managed Node that WOULD answer `--version` makes a `StillUnreadable`
/// outcome proof that the direct invocation did not fire.
#[test]
#[cfg(unix)]
fn direct_managed_node_is_skipped_when_the_shim_has_no_node_shebang() {
    let tmp = tempfile::TempDir::new().unwrap();
    let bin = tmp.path().join("bin");
    let hq = bin.join("hq");
    std::fs::create_dir_all(&bin).unwrap();
    write_executable(&hq, "#!/usr/bin/env hq-fixture-node\n");

    let managed_bin = tmp.path().join("managed/node/bin");
    std::fs::create_dir_all(&managed_bin).unwrap();
    let node = managed_bin.join("node");
    write_executable(&node, "#!/bin/sh\nprintf 'v9.9.9\\n'\n");
    let managed = crate::toolchain::ManagedRuntime::Present { node };

    let result = probe_local_version_with_managed(
        Some(&hq),
        ResolvedProgramKind::Exe,
        Some(&managed),
        None,
        "",
    );

    assert_eq!(
        result.local, None,
        "a non-node shim must never be run under node"
    );
    assert_eq!(
        result.probes.interpreter_recovery,
        InterpreterRecovery::StillUnreadable
    );
    // HQ-DESKTOP-3P: this shim is definitively unbacked and foreign, so once
    // recovery cannot read a version the machine converges via install rather
    // than reporting forever.
    assert_eq!(result.probes.hq_backing, HqBacking::UnbackedForeign);
    assert!(!should_report_unreadable_version(&result));
    assert!(cli_install_needed(None, "5.103.30", result.hq_installed));
}

/// A resolved-but-absent program (`SpawnProgramMissing`) routes through the
/// same recovery gate, but its reported spawn outcome is unchanged when
/// recovery cannot read a version.
#[test]
#[cfg(unix)]
fn a_missing_shim_routes_through_recovery_without_changing_its_outcome() {
    let tmp = tempfile::TempDir::new().unwrap();
    let hq = tmp.path().join("bin/hq"); // deliberately never created
    let managed_bin = tmp.path().join("managed/node/bin");
    std::fs::create_dir_all(&managed_bin).unwrap();
    let node = managed_bin.join("node");
    write_executable(&node, "#!/bin/sh\nprintf 'v1.2.3\\n'\n");
    let managed = crate::toolchain::ManagedRuntime::Present { node };

    let result = probe_local_version_with_managed(
        Some(&hq),
        ResolvedProgramKind::Exe,
        Some(&managed),
        None,
        "",
    );

    assert_eq!(result.local, None);
    assert_eq!(
        result.probes.interpreter_recovery,
        InterpreterRecovery::StillUnreadable
    );
    assert_eq!(
        result.probes.hq_version,
        VersionProbeOutcome::SpawnProgramMissing
    );
    assert!(should_report_unreadable_version(&result));
}

/// A machine with no `hq` at all stays completely silent — hq_installed
/// false, no report, no recovery — unchanged from today.
#[test]
fn no_hq_at_all_stays_silent() {
    let result =
        probe_local_version_with_managed(None, ResolvedProgramKind::NotResolved, None, None, "");

    assert_eq!(result.local, None);
    assert!(!result.hq_installed);
    assert!(!should_report_unreadable_version(&result));
    assert_eq!(
        result.probes.interpreter_recovery,
        InterpreterRecovery::NotNeeded
    );
    assert_eq!(
        result.probes.managed_runtime,
        ManagedRuntimeState::NotProbed
    );
}

/// The direct-node gate recognizes node entrypoints only — the exact set of
/// shebang shapes that decide whether the `<node> <program>` retry may run.
#[test]
#[cfg(unix)]
fn shebang_names_node_recognizes_node_entrypoints_only() {
    let tmp = tempfile::TempDir::new().unwrap();
    let cases = [
        ("env-node", "#!/usr/bin/env node\n", true),
        (
            "abs-node",
            "#!/usr/local/bin/node --enable-source-maps\n",
            true,
        ),
        (
            "env-dash-s",
            "#!/usr/bin/env -S node --experimental\n",
            true,
        ),
        ("env-nodejs", "#!/usr/bin/env nodejs\n", true),
        ("env-other", "#!/usr/bin/env hq-fixture-node\n", false),
        ("sh", "#!/bin/sh\n", false),
        ("bare-env", "#!/usr/bin/env\n", false),
        ("no-shebang", "console.log(1)\n", false),
    ];
    for (name, body, expected) in cases {
        let path = tmp.path().join(name);
        write_executable(&path, body);
        assert_eq!(shebang_names_node(&path), expected, "case {name}");
    }
}

/// A genuinely broken CLI (a real nonzero exit) is NOT an interpreter
/// failure, so the probe leaves `interpreter_recovery = NotNeeded` even with
/// a managed Node present. The app's provisioner gate keys on
/// `ManagedNodeAbsent`, so this is what keeps a broken or native `hq` from
/// triggering a managed-Node download.
#[test]
#[cfg(unix)]
fn a_genuinely_failing_cli_is_not_flagged_for_interpreter_recovery() {
    let tmp = tempfile::TempDir::new().unwrap();
    let bin = tmp.path().join("bin");
    let hq = bin.join("hq");
    std::fs::create_dir_all(&bin).unwrap();
    // Exits nonzero for a real reason — not a missing interpreter.
    write_executable(&hq, "#!/bin/sh\nexit 3\n");
    // HQ-DESKTOP-3P: an unparseable manifest beside the shim keeps the backing
    // INDETERMINATE (NotProbed) — a broken install we cannot prove absent still
    // reports; only a definitively-foreign shim is silent-and-installable.
    std::fs::write(bin.join("package.json"), b"{ not valid json\n").unwrap();

    let managed_bin = tmp.path().join("managed/node/bin");
    std::fs::create_dir_all(&managed_bin).unwrap();
    let node = managed_bin.join("node");
    write_executable(&node, "#!/bin/sh\nprintf 'v5.0.0\\n'\n");
    let managed = crate::toolchain::ManagedRuntime::Present { node };

    let result = probe_local_version_with_managed(
        Some(&hq),
        ResolvedProgramKind::Exe,
        Some(&managed),
        None,
        "",
    );

    assert_eq!(result.local, None);
    assert_eq!(result.probes.hq_version, VersionProbeOutcome::NonzeroExit);
    assert_eq!(
        result.probes.interpreter_recovery,
        InterpreterRecovery::NotNeeded,
        "a real nonzero exit must not be flagged for managed-Node recovery"
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
    // HQ-DESKTOP-3P: with no child PATH the foreign shim's interpreter is
    // unreachable AND the shim is definitively unbacked, so the machine is
    // silent-and-installable; the child-PATH half below recovers a real version.
    assert_eq!(
        without_child_path.probes.hq_backing,
        HqBacking::UnbackedForeign
    );
    assert!(!should_report_unreadable_version(&without_child_path));
    assert!(cli_install_needed(
        None,
        "5.103.30",
        without_child_path.hq_installed
    ));

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
    // An absent program is now named as such rather than folded into the
    // undifferentiated spawn-failure bucket.
    let missing = tmp.path().join("missing-hq");
    assert_eq!(
        hq_version_string_probe(&missing, "").1,
        VersionProbeOutcome::SpawnProgramMissing
    );

    // Present but not an executable image — the Unix ENOEXEC form of the
    // Windows os error 193 an extensionless POSIX shim produces.
    let not_executable = tmp.path().join("not-executable-hq");
    write_executable(&not_executable, "\u{0}\u{1}not-an-executable-image\n");
    assert_eq!(
        settled_probe_outcome(|| hq_version_string_probe(&not_executable, "").1),
        enoexec_fixture_outcome(),
        "{}",
        direct_spawn_errno(&not_executable.to_string_lossy())
    );

    // Present, but this process may not execute it.
    let access_denied = tmp.path().join("access-denied-hq");
    std::fs::write(&access_denied, "#!/bin/sh\nexit 0\n").unwrap();
    assert_eq!(
        hq_version_string_probe(&access_denied, "").1,
        VersionProbeOutcome::SpawnAccessDenied
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
fn post_install_foreign_managed_repeat_is_suppressed_but_remains_actionable() {
    let outcome = decide_post_install(&PostInstallContext::npm(
        "/Users/t/Library/pnpm/hq",
        "/Users/t/Library/pnpm/hq",
        Some("5.77.14"),
        Some("5.77.14"),
        "5.84.0",
        None,
        "/opt/homebrew/bin/npm",
        true,
        None,
    ));
    assert_eq!(outcome.verdict, ConvergenceVerdict::NonConvergent);
    assert_eq!(
        outcome.non_convergence_kind,
        Some(NonConvergenceKind::ForeignManaged)
    );
    assert!(outcome.record_non_convergent.is_none());
    assert!(outcome.capture.is_none());
    assert!(outcome.capture_requires_durable_record);
    assert!(
        matches!(outcome.result, Err(ref detail) if detail.starts_with(NON_CONVERGENT_ERROR_PREFIX))
    );
}

#[test]
fn non_convergent_episode_block_requires_the_exact_latest_version() {
    assert!(non_convergent_episode_blocked(Some("5.84.0"), "5.84.0"));
    assert!(!non_convergent_episode_blocked(Some("5.83.0"), "5.84.0"));
    assert!(!non_convergent_episode_blocked(None, "5.84.0"));
}

#[test]
fn post_install_version_rollover_starts_and_closes_a_new_episode() {
    let latest = "5.84.0";
    let old_marker = Some("5.83.0");
    let first_episode_blocked = non_convergent_episode_blocked(old_marker, latest);
    assert!(!first_episode_blocked);

    let first = decide_post_install(&PostInstallContext::npm(
        "/Users/t/Library/pnpm/hq",
        "/Users/t/Library/pnpm/hq",
        Some("5.77.14"),
        Some("5.77.14"),
        latest,
        None,
        "/opt/homebrew/bin/npm",
        first_episode_blocked,
        None,
    ));
    assert_eq!(first.record_non_convergent.as_deref(), Some(latest));
    assert!(first.capture.is_some());
    assert!(first.capture_requires_durable_record);

    let durable_marker = first.record_non_convergent.as_deref();
    let repeat_episode_blocked = non_convergent_episode_blocked(durable_marker, latest);
    assert!(repeat_episode_blocked);

    let repeat = decide_post_install(&PostInstallContext::npm(
        "/Users/t/Library/pnpm/hq",
        "/Users/t/Library/pnpm/hq",
        Some("5.77.14"),
        Some("5.77.14"),
        latest,
        None,
        "/opt/homebrew/bin/npm",
        repeat_episode_blocked,
        None,
    ));
    assert!(repeat.record_non_convergent.is_none());
    assert!(repeat.capture.is_none());
    assert!(repeat.capture_requires_durable_record);
}

#[tokio::test]
async fn overlapping_first_episode_installs_share_one_claim_and_capture() {
    use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};
    use std::sync::Arc;
    use tokio::sync::Notify;

    let flight = AsyncSingleFlight::<PostInstallSuccess>::new();
    let installs = Arc::new(AtomicUsize::new(0));
    let records = Arc::new(AtomicUsize::new(0));
    let captures = Arc::new(AtomicUsize::new(0));
    let entered = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());

    let make_operation = || {
        let installs = Arc::clone(&installs);
        let records = Arc::clone(&records);
        let captures = Arc::clone(&captures);
        let entered = Arc::clone(&entered);
        let release = Arc::clone(&release);
        move || async move {
            installs.fetch_add(1, AtomicOrdering::SeqCst);
            entered.notify_one();
            release.notified().await;
            let outcome = decide_post_install(&PostInstallContext::npm(
                "/Users/t/Library/pnpm/hq",
                "/Users/t/Library/pnpm/hq",
                Some("5.77.14"),
                Some("5.77.14"),
                "5.84.0",
                None,
                "/opt/homebrew/bin/npm",
                false,
                None,
            ));
            let record = |_version: String| {
                records.fetch_add(1, AtomicOrdering::SeqCst);
                Ok(())
            };
            let clear = || panic!("non-convergence must not clear the marker");
            let capture = |_report| {
                captures.fetch_add(1, AtomicOrdering::SeqCst);
            };
            let record_failure = |_error| panic!("the marker write must succeed");
            apply_post_install_effects(
                &outcome,
                &PostInstallCoreEffects {
                    record: &record,
                    clear: &clear,
                    capture: &capture,
                    record_failure: &record_failure,
                },
            )
        }
    };
    let first = flight.run(make_operation());
    let second = flight.run(make_operation());
    let release_when_overlapped = async {
        entered.notified().await;
        tokio::task::yield_now().await;
        release.notify_waiters();
    };

    let (first_result, second_result, ()) = tokio::join!(first, second, release_when_overlapped);
    assert!(matches!(
        first_result,
        Err(ref detail) if detail.starts_with(NON_CONVERGENT_ERROR_PREFIX)
    ));
    assert_eq!(first_result.err(), second_result.err());
    assert_eq!(installs.load(AtomicOrdering::SeqCst), 1);
    assert_eq!(records.load(AtomicOrdering::SeqCst), 1);
    assert_eq!(captures.load(AtomicOrdering::SeqCst), 1);
}

#[test]
fn post_install_first_foreign_managed_episode_requires_a_durable_record() {
    let outcome = decide_post_install(&PostInstallContext::npm(
        "/Users/t/.asdf/shims/hq",
        "/Users/t/.asdf/shims/hq",
        Some("5.77.14"),
        Some("5.77.14"),
        "5.84.0",
        None,
        "/opt/homebrew/bin/npm",
        false,
        None,
    ));
    assert_eq!(
        outcome.non_convergence_kind,
        Some(NonConvergenceKind::ForeignManaged)
    );
    assert_eq!(outcome.record_non_convergent.as_deref(), Some("5.84.0"));
    assert!(outcome.capture.is_some());
    assert!(outcome.capture_requires_durable_record);
}

#[test]
fn post_install_npm_targeted_non_convergence_stays_loud() {
    let outcome = decide_post_install(&PostInstallContext::npm(
        "/Users/t/.npm-global/bin/hq",
        "/Users/t/.npm-global/bin/hq",
        Some("5.77.14"),
        Some("5.77.14"),
        "5.84.0",
        Some("/Users/t/.npm-global"),
        "/opt/homebrew/bin/npm",
        true,
        // Delivery evidence present: the target reached the prefix, so a
        // shadowing copy on PATH is a genuine, loud, blocking defect.
        Some("5.84.0"),
    ));
    assert_eq!(
        outcome.non_convergence_kind,
        Some(NonConvergenceKind::NpmTargeted)
    );
    assert!(outcome.capture.is_some());
    assert!(!outcome.capture_requires_durable_record);
}

/// Genuine shadowing: npm delivered the target INTO the prefix, but a copy
/// earlier on PATH still wins, so the resolved binary stays stale. A real
/// updater defect — loud on every occurrence and blocking, so the loop stops
/// reinstalling a version it cannot make win.
#[test]
fn a_delivered_target_that_the_binary_does_not_reflect_stays_loud_and_blocking() {
    let outcome = decide_post_install(&PostInstallContext::npm(
        "/Users/t/.npm-global/bin/hq",
        "/Users/t/.npm-global/bin/hq",
        Some("5.97.0"),
        Some("5.97.0"),
        "5.97.1",
        Some("/Users/t/.npm-global"),
        "/opt/homebrew/bin/npm",
        false,
        Some("5.97.1"), // delivered == target
    ));
    assert_eq!(
        outcome.non_convergence_kind,
        Some(NonConvergenceKind::NpmTargeted)
    );
    assert_eq!(outcome.record_non_convergent.as_deref(), Some("5.97.1"));
    assert!(!outcome.capture_requires_durable_record);
    let report = outcome.capture.expect("genuine shadowing stays loud");
    assert_eq!(report.delivered_version.as_deref(), Some("5.97.1"));
}

/// The registry race: npm exited 0 into the right prefix but delivered N-1
/// (the target never propagated), so no manifest at the target exists. That
/// is a resolution shortfall, not a layout defect: it must NEVER persist the
/// blocking marker, so the next scheduled check retries rather than the
/// version being wedged forever.
#[test]
fn an_undelivered_target_is_a_resolution_shortfall_and_never_blocks_auto_install() {
    for delivered in [Some("5.97.0"), None] {
        let outcome = decide_post_install(&PostInstallContext::npm(
            "/Users/t/.npm-global/bin/hq",
            "/Users/t/.npm-global/bin/hq",
            Some("5.97.0"),
            Some("5.97.0"),
            "5.97.1",
            Some("/Users/t/.npm-global"),
            "/opt/homebrew/bin/npm",
            false,
            delivered, // short of, or absent, the target
        ));
        assert_eq!(
            outcome.non_convergence_kind,
            Some(NonConvergenceKind::ResolutionShortfall),
            "delivered={delivered:?}"
        );
        assert!(
            outcome.record_non_convergent.is_none(),
            "a shortfall must never wedge auto-update (delivered={delivered:?})"
        );
        // Still observable, and its detail self-describes as transient rather
        // than telling the user to change or remove anything.
        let report = outcome.capture.as_ref().expect("a shortfall still signals");
        assert_eq!(report.delivered_version.as_deref(), delivered);
        assert!(matches!(
            &outcome.result,
            Err(detail)
                if detail.starts_with(NON_CONVERGENT_ERROR_PREFIX)
                    && detail.contains("transient registry lag")
        ));
    }
}

/// Un-wedging already-affected machines is bounded. A legacy (unversioned)
/// marker earns exactly one recovery re-attempt; a marker written under the
/// pinned contract is delivery-backed and keeps blocking, so a genuinely
/// stuck layout re-blocks after its single re-attempt rather than looping.
#[test]
fn a_legacy_unversioned_marker_permits_exactly_one_reattempt() {
    assert!(legacy_marker_needs_recovery(None, Some("5.97.1")));
    assert!(legacy_marker_needs_recovery(
        Some("some-older-tag"),
        Some("5.97.1")
    ));
    // No marker → nothing to recover.
    assert!(!legacy_marker_needs_recovery(None, None));
    assert!(!legacy_marker_needs_recovery(
        Some(PINNED_MARKER_CONTRACT),
        None
    ));
}

#[test]
fn a_marker_written_under_the_pinned_contract_keeps_blocking() {
    // A pinned-contract marker is delivery-backed: never re-attempted...
    assert!(!legacy_marker_needs_recovery(
        Some(PINNED_MARKER_CONTRACT),
        Some("5.97.1")
    ));
    // ...and the shared block predicate still blocks that exact version, so
    // the background loop skips it.
    assert!(non_convergent_episode_blocked(Some("5.97.1"), "5.97.1"));
    assert!(!should_auto_install("5.97.1", Some("5.97.1")));
}

/// A pinned install of a not-yet-propagated version fails with ETARGET,
/// already an expected transient registry failure: it is not reported as an
/// install failure and touches no marker (that path is exit-0 only), so
/// auto-update stays armed and simply retries on the next check.
#[test]
fn etarget_on_a_pinned_install_is_an_expected_transient_and_writes_no_marker() {
    let etarget = "npm error code ETARGET\n\
            npm error notarget No matching version found for @indigoai-us/hq-cli@5.97.1";
    assert!(is_expected_transient_registry_failure(etarget));
    for detail in [
        "npm error code ECONNRESET",
        "npm error code ETIMEDOUT",
        "npm error code ENOTFOUND",
    ] {
        assert!(is_expected_transient_registry_failure(detail));
    }
    // A genuine, non-transient failure must NOT be swept into the transient
    // bucket, or a real defect would be silently retried forever.
    assert!(!is_expected_transient_registry_failure(
        "npm error code EACCES"
    ));
}

#[test]
fn post_install_exit_202_stays_unexpected_without_corrobating_stderr() {
    assert_eq!(
        classify_install_failure(Some(202), "", None),
        InstallFailureKind::Unexpected
    );
}

#[test]
#[cfg(unix)]
fn npm_root_probe_diagnostics_classify_output_and_manifest_failures() {
    let tmp = tempfile::TempDir::new().unwrap();
    let missing = tmp.path().join("missing-npm");
    assert_eq!(
        read_installed_version_probe(missing.to_str().unwrap(), "").1,
        VersionProbeOutcome::SpawnProgramMissing
    );

    let not_executable = tmp.path().join("not-executable-npm");
    write_executable(&not_executable, "\u{0}\u{1}not-an-executable-image\n");
    let not_executable = not_executable.to_str().unwrap();
    assert_eq!(
        settled_probe_outcome(|| read_installed_version_probe(not_executable, "").1),
        enoexec_fixture_outcome(),
        "{}",
        direct_spawn_errno(not_executable)
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

// ---- HQ-DESKTOP-3P: hq-cli backing oracle + telemetry sub-case. ----

#[test]
fn hq_cli_backing_classifies_backed_absent_invalid_and_unreadable() {
    let tmp = tempfile::TempDir::new().unwrap();

    // Backed: a shim whose @indigoai-us/hq-cli manifest is reachable from the
    // derived prefix.
    let prefix = tmp.path().join("npm");
    std::fs::create_dir_all(prefix.join("node_modules/@indigoai-us/hq-cli")).unwrap();
    std::fs::write(prefix.join("hq.cmd"), "@echo off\n").unwrap();
    std::fs::write(
        prefix.join("node_modules/@indigoai-us/hq-cli/package.json"),
        br#"{"name":"@indigoai-us/hq-cli","version":"5.103.30"}"#,
    )
    .unwrap();
    assert_eq!(
        hq_cli_backing(&prefix.join("hq.cmd")),
        paths::CandidateBacking::Backed
    );

    // Definitively absent: the same shim shape with the package gone.
    let orphan = tmp.path().join("toolchain");
    std::fs::create_dir_all(&orphan).unwrap();
    std::fs::write(orphan.join("hq.cmd"), "@echo off\n").unwrap();
    assert_eq!(
        hq_cli_backing(&orphan.join("hq.cmd")),
        paths::CandidateBacking::AbsentDefinitive
    );

    // Indeterminate: the manifest path exists but cannot be READ (a directory
    // here, standing in for a permission/AV lock).
    let locked = tmp.path().join("locked");
    std::fs::create_dir_all(locked.join("node_modules/@indigoai-us/hq-cli/package.json")).unwrap();
    std::fs::write(locked.join("hq.cmd"), "@echo off\n").unwrap();
    assert_eq!(
        hq_cli_backing(&locked.join("hq.cmd")),
        paths::CandidateBacking::ManifestUnreadable
    );

    // Invalid: a readable package manifest that cannot be parsed must not
    // be conflated with either an absent package or an unreadable file.
    let invalid = tmp.path().join("invalid");
    std::fs::create_dir_all(invalid.join("node_modules/@indigoai-us/hq-cli")).unwrap();
    std::fs::write(invalid.join("hq.cmd"), "@echo off\n").unwrap();
    std::fs::write(
        invalid.join("node_modules/@indigoai-us/hq-cli/package.json"),
        b"{invalid json",
    )
    .unwrap();
    assert_eq!(
        hq_cli_backing(&invalid.join("hq.cmd")),
        paths::CandidateBacking::ManifestInvalid
    );
}

#[test]
fn classify_hq_backing_names_the_unreadable_subcase_from_the_anchor_outcome() {
    let foreign = std::path::Path::new("/tmp/hq-fixture-foreign/hq.cmd");
    // No hq resolved → not probed.
    assert_eq!(
        classify_hq_backing(None, VersionProbeOutcome::PackageNotFound),
        HqBacking::NotProbed
    );
    // A version read (fast path) → backed.
    assert_eq!(
        classify_hq_backing(Some(foreign), VersionProbeOutcome::Succeeded),
        HqBacking::Backed
    );
    // Definitive absence OUTSIDE a managed root → foreign.
    assert_eq!(
        classify_hq_backing(Some(foreign), VersionProbeOutcome::PackageNotFound),
        HqBacking::UnbackedForeign
    );
    // Definitive absence INSIDE a managed root → managed (HQ's own orphan).
    if let Some(root) = paths::managed_toolchain_roots().first() {
        let managed = root.join("npm-prefix").join("hq.cmd");
        assert_eq!(
            classify_hq_backing(Some(&managed), VersionProbeOutcome::PackageNotFound),
            HqBacking::UnbackedManaged
        );
    }
    // An indeterminate read is never a false "unbacked".
    assert_eq!(
        classify_hq_backing(
            Some(foreign),
            VersionProbeOutcome::ManifestReadOrParseFailed
        ),
        HqBacking::NotProbed
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
/// Materialise an executable fixture with no write handle left open.
///
/// The body is written to a sibling staging file inside a scope that drops
/// the `File` before the mode is set and before the path is renamed into
/// place, so the fixture only becomes visible at `path` after this process
/// has closed its writer. This narrows -- it cannot close -- the window in
/// which a sibling test's `Command::spawn` forks while the write fd is open
/// and the inherited fd makes Linux refuse the exec with `ETXTBSY`; the
/// probe's own `ETXTBSY` retry is what actually removes the failure.
fn write_executable(path: &Path, contents: &str) {
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;

    let parent = path.parent().expect("executable parent");
    let staging = parent.join(format!(
        ".{}.fixture-{}",
        path.file_name().expect("file name").to_string_lossy(),
        std::process::id()
    ));
    {
        let mut file = std::fs::File::create(&staging).unwrap();
        file.write_all(contents.as_bytes()).unwrap();
        file.sync_all().unwrap();
    }
    std::fs::set_permissions(&staging, std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::rename(&staging, path).unwrap();
}

/// What spawning an exec-bit file whose content is not a valid executable
/// image actually produces on THIS host.
///
/// Linux answers `ENOEXEC` straight from the spawn, which is the faithful
/// analogue of the Windows `ERROR_BAD_EXE_FORMAT` (os error 193) the field
/// events come from. macOS and the BSDs do not: their libc `execvp` retries
/// such a file under `/bin/sh`, so the spawn SUCCEEDS and the shell exits
/// nonzero instead. The fixture is therefore platform-dependent; the
/// 193/`ENOEXEC` mapping itself is pinned platform-independently by
/// `classify_spawn_error_splits_the_process_spawn_failed_bucket`.
/// Re-run a version probe until it stops reporting the undifferentiated
/// `ProcessSpawnFailed` residual, then hand back what it settled on.
///
/// `ProcessSpawnFailed` is the bucket the probe uses for "something in the
/// harness broke and the child never got a verdict" -- an `EMFILE` on the
/// stdio `dup`, an interrupted status poll, a short output read. Those are
/// resource transients produced by whatever else is running on the host, not
/// statements about the fixture, and on a loaded CI runner they turned these
/// classification tests red. Retrying past the residual keeps the assertion
/// exactly as strict -- the expected outcome must still be OBSERVED -- while
/// refusing to let unrelated host pressure speak for the fixture.
///
/// A genuine regression that pins the outcome to `ProcessSpawnFailed` still
/// fails: the retries are bounded and the residual is then asserted against.
#[cfg(unix)]
fn settled_probe_outcome(mut probe: impl FnMut() -> VersionProbeOutcome) -> VersionProbeOutcome {
    let mut outcome = probe();
    for attempt in 1..8 {
        if outcome != VersionProbeOutcome::ProcessSpawnFailed {
            break;
        }
        std::thread::sleep(Duration::from_millis(20 * attempt));
        outcome = probe();
    }
    outcome
}

/// The raw errno a direct spawn of `program` reports right now, for failure
/// messages: when one of these classification assertions does trip, the log
/// should name the errno instead of leaving the next reader to guess.
#[cfg(unix)]
fn direct_spawn_errno(program: &str) -> String {
    let mut cmd = paths::spawn_command(program, &[]);
    cmd.stdout(Stdio::null()).stderr(Stdio::null());
    match cmd.spawn() {
        Ok(mut child) => {
            let status = child.wait();
            format!("direct spawn succeeded, status={status:?}")
        }
        Err(error) => format!(
            "direct spawn failed, raw_os_error={:?} kind={:?} ({error})",
            error.raw_os_error(),
            error.kind()
        ),
    }
}

#[cfg(unix)]
fn enoexec_fixture_outcome() -> VersionProbeOutcome {
    if cfg!(target_os = "linux") {
        VersionProbeOutcome::SpawnNotExecutable
    } else {
        VersionProbeOutcome::NonzeroExit
    }
}

/// The probe harness's OWN I/O failure is not evidence about the child.
///
/// Every fallible stage of `output_with_timeout` -- tempfile creation, the
/// `dup` for the child's stdio, the status poll, the output read -- used to
/// return a bare `io::Error` that the callers handed to
/// `classify_spawn_error`, a function whose whole contract is to read an
/// errno as a statement about the child's `exec`. So a plumbing failure was
/// reported as a spawn verdict, and a plumbing errno that collided with
/// `ENOEXEC` (8) or `ERROR_BAD_EXE_FORMAT` (193) would have been reported as
/// "the program is present but is not an executable image" -- a claim the
/// probe never established. That conflation is also how a loaded CI runner
/// turned this module's probe tests red: a transient harness errno arrived
/// where only a spawn errno was expected.
#[test]
fn a_harness_io_failure_is_never_read_as_the_childs_spawn_errno() {
    use std::io::{Error, ErrorKind};

    // The two errnos that DO mean "not an executable image" -- when they come
    // from the spawn. From the harness they must stay in the residual bucket.
    for raw in [193, 8] {
        let harness = harness_io(Error::from_raw_os_error(raw));
        assert_eq!(
            classify_probe_error(&harness),
            VersionProbeOutcome::ProcessSpawnFailed,
            "harness errno {raw} must not be reported as a spawn verdict"
        );
    }

    // Absent/denied are equally claims about the child, so a harness
    // ENOENT/EACCES must not be reported as either.
    for kind in [ErrorKind::NotFound, ErrorKind::PermissionDenied] {
        assert_eq!(
            classify_probe_error(&harness_io(Error::from(kind))),
            VersionProbeOutcome::ProcessSpawnFailed,
            "harness {kind:?} must not be reported as a spawn verdict"
        );
    }

    // An untagged error is a genuine spawn failure and still classifies in
    // full -- the split must not blunt the real diagnostics.
    assert_eq!(
        classify_probe_error(&Error::from_raw_os_error(193)),
        VersionProbeOutcome::SpawnNotExecutable
    );
    #[cfg(unix)]
    assert_eq!(
        classify_probe_error(&Error::from_raw_os_error(8)),
        VersionProbeOutcome::SpawnNotExecutable
    );
    assert_eq!(
        classify_probe_error(&Error::from(ErrorKind::NotFound)),
        VersionProbeOutcome::SpawnProgramMissing
    );
    assert_eq!(
        classify_probe_error(&Error::from(ErrorKind::PermissionDenied)),
        VersionProbeOutcome::SpawnAccessDenied
    );
}

/// `EINTR` from the status poll means a signal arrived while we asked about
/// an ALREADY RUNNING child, so it says nothing about the child. It used to
/// propagate out of the probe and land in the residual spawn bucket, because
/// the whole-probe retry deliberately excludes `Interrupted` (retrying the
/// probe would leak the running child's process group). Absorbing it at the
/// poll keeps that leak impossible AND stops the bogus verdict.
#[test]
fn an_interrupted_status_poll_is_absorbed_rather_than_becoming_a_spawn_verdict() {
    use std::io::{Error, ErrorKind};

    let mut polls = 0;
    let status = poll_child_status(|| {
        polls += 1;
        if polls < 4 {
            Err(Error::from(ErrorKind::Interrupted))
        } else {
            Ok(None)
        }
    })
    .expect("an interrupted poll must not fail the probe");
    assert_eq!(status, None, "the child is still running");
    assert_eq!(polls, 4, "every interrupt is retried in place");

    // A non-EINTR error is still surfaced -- the absorption is narrow.
    let mut polls = 0;
    let error = poll_child_status(|| {
        polls += 1;
        Err::<Option<std::process::ExitStatus>, _>(Error::from(ErrorKind::OutOfMemory))
    })
    .expect_err("a real poll failure must still surface");
    assert_eq!(error.kind(), ErrorKind::OutOfMemory);
    assert_eq!(polls, 1, "a non-interrupt is not retried in place");
}

// ── HQ-DESKTOP-3P: a Windows resolution that exists but cannot be spawned ──

/// `ETXTBSY` is a statement about a WRITER, so the probe must retry it.
///
/// The kernel refuses to exec a file that any process holds open for
/// writing. That is never evidence about the program -- the same file runs
/// the moment the handle closes -- so it belongs with the resource
/// transients the probe retries past, not in the `ProcessSpawnFailed`
/// residual that a caller reads as a verdict. Before this, a parallel test
/// binary (or a concurrent installer) that forked while a fixture's write
/// fd was open turned the classification tests red on Linux.
///
/// Windows spells the same condition `ERROR_SHARING_VIOLATION` (os error
/// 32) rather than `ETXTBSY`, so each platform is asserted with its own
/// errno here instead of the test being skipped off Unix.
#[test]
fn a_text_file_busy_spawn_is_a_retryable_transient_not_a_verdict() {
    use std::io::{Error, ErrorKind};

    // The portable kind is the one every platform must accept.
    let busy = Error::from(ErrorKind::ExecutableFileBusy);
    assert!(
        is_transient_probe_io_error(&busy),
        "a busy binary must be retried, not reported as a spawn verdict: {busy}"
    );

    // Each platform's own "the binary is still being written" errno, asserted
    // as that platform's real answer rather than skipped: ETXTBSY (26) on
    // Unix, ERROR_SHARING_VIOLATION (32) on Windows. The other platform's
    // number must NOT be honoured — os error 26 on Windows is
    // ERROR_NOT_DOS_DISK, an unrelated disk failure.
    #[cfg(any(unix, windows))]
    {
        #[cfg(unix)]
        let busy_errno = 26;
        #[cfg(windows)]
        let busy_errno = 32;
        let native = Error::from_raw_os_error(busy_errno);
        assert!(
            is_transient_probe_io_error(&native),
            "the platform busy errno must be retried: {native}"
        );
        #[cfg(windows)]
        assert!(
            !is_transient_probe_io_error(&Error::from_raw_os_error(26)),
            "os error 26 on Windows is ERROR_NOT_DOS_DISK, never a busy binary"
        );
    }

    // The retry must actually recover, and must still be bounded: a file
    // that stays busy forever reports the residual rather than hanging.
    let mut attempts = 0u32;
    let recovered = retry_transient_io(|| {
        attempts += 1;
        if attempts < 3 {
            return Err(Error::from(ErrorKind::ExecutableFileBusy));
        }
        Ok(attempts)
    })
    .expect("a transiently busy program is retried");
    assert_eq!(recovered, 3);

    let mut forever = 0u32;
    let error = retry_transient_io(|| {
        forever += 1;
        Err::<(), _>(Error::from(ErrorKind::ExecutableFileBusy))
    })
    .expect_err("a permanently busy program still fails");
    assert_eq!(
        classify_spawn_error(&error),
        VersionProbeOutcome::ProcessSpawnFailed
    );
    assert_eq!(forever, 4, "the ETXTBSY retry must stay bounded");

    // A genuine spawn verdict is never swallowed by the new branch.
    assert!(!is_transient_probe_io_error(&Error::from(
        ErrorKind::NotFound
    )));
    assert!(!is_transient_probe_io_error(&Error::from(
        ErrorKind::PermissionDenied
    )));
    #[cfg(unix)]
    assert!(
        !is_transient_probe_io_error(&Error::from_raw_os_error(8)),
        "ENOEXEC is a verdict about the program, never a retry"
    );
    #[cfg(windows)]
    assert!(
        !is_transient_probe_io_error(&Error::from_raw_os_error(193)),
        "ERROR_BAD_EXE_FORMAT is a verdict about the program, never a retry"
    );
}

/// End-to-end proof on the platform that enforces `ETXTBSY`.
///
/// A real write handle is held on the `npm` fixture across the start of the
/// probe and released shortly after, which is the exact field shape: the
/// program is fine, something else was mid-write. Without the retry the
/// probe reports `ProcessSpawnFailed`; with it, it reports the fixture's
/// real answer.
#[test]
#[cfg(target_os = "linux")]
fn a_momentarily_busy_npm_still_reports_its_real_outcome() {
    let tmp = tempfile::TempDir::new().unwrap();
    let flat_bin = tmp.path().join("Library/pnpm");
    let npm_root = tmp.path().join("empty-npm-root");
    let hq = flat_bin.join("hq");
    let npm = flat_bin.join("npm");
    std::fs::create_dir_all(&flat_bin).unwrap();
    std::fs::create_dir_all(&npm_root).unwrap();
    write_executable(&hq, "#!/bin/sh\nexit 7\n");
    write_executable(
        &npm,
        &format!("#!/bin/sh\nprintf '{}\\n'\n", npm_root.display()),
    );

    // Hold the exec target open for writing, then release it well inside
    // the retry budget (20ms + 40ms + 60ms of backoff).
    let writer = std::fs::OpenOptions::new().write(true).open(&npm).unwrap();
    let releaser = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(30));
        drop(writer);
    });

    let result = probe_local_version(Some(&hq), Some(npm.to_str().unwrap()), "");
    releaser.join().unwrap();

    assert_eq!(
        result.probes.npm_root,
        VersionProbeOutcome::PackageNotFound,
        "a momentarily busy npm must not be reported as a spawn failure"
    );
}

/// Every spawn failure used to collapse into `ProcessSpawnFailed`, so the
/// field event could not say whether the program was absent, present but
/// not an executable image, or blocked by permissions.
#[test]
fn classify_spawn_error_splits_the_process_spawn_failed_bucket() {
    use std::io::{Error, ErrorKind};

    // Windows ERROR_BAD_EXE_FORMAT — the exact code an extensionless POSIX
    // shim produces when CreateProcessW is handed it. Pinned on every
    // platform so a Windows-only regression is caught by the macOS/Linux
    // legs too.
    assert_eq!(
        classify_spawn_error(&Error::from_raw_os_error(193)),
        VersionProbeOutcome::SpawnNotExecutable
    );
    #[cfg(unix)]
    assert_eq!(
        classify_spawn_error(&Error::from_raw_os_error(8)),
        VersionProbeOutcome::SpawnNotExecutable,
        "ENOEXEC is the Unix form of the same condition"
    );
    assert_eq!(
        classify_spawn_error(&Error::from(ErrorKind::NotFound)),
        VersionProbeOutcome::SpawnProgramMissing
    );
    assert_eq!(
        classify_spawn_error(&Error::from(ErrorKind::PermissionDenied)),
        VersionProbeOutcome::SpawnAccessDenied
    );
    assert_eq!(
        classify_spawn_error(&Error::from(ErrorKind::Interrupted)),
        VersionProbeOutcome::ProcessSpawnFailed,
        "unclassified spawn errors must keep the original residual bucket"
    );
}

/// Linux CI labelled the production-quadruple probe `ProcessSpawnFailed`
/// when a parallel run hit EAGAIN/EMFILE. Those are retries, not a new
/// outcome; classified spawn failures stay classified.
#[test]
fn transient_probe_io_errors_are_the_resource_exhaustion_set() {
    use std::io::{Error, ErrorKind};

    assert!(is_transient_probe_io_error(&Error::from(
        ErrorKind::WouldBlock
    )));
    assert!(!is_transient_probe_io_error(&Error::from(
        ErrorKind::Interrupted
    )));
    assert!(is_transient_probe_io_error(&Error::from(
        ErrorKind::OutOfMemory
    )));
    assert!(!is_transient_probe_io_error(&Error::from(
        ErrorKind::NotFound
    )));
    assert!(!is_transient_probe_io_error(&Error::from(
        ErrorKind::PermissionDenied
    )));
    #[cfg(target_os = "linux")]
    {
        assert!(is_transient_probe_io_error(&Error::from_raw_os_error(11)));
        assert!(is_transient_probe_io_error(&Error::from_raw_os_error(24)));
        assert!(!is_transient_probe_io_error(&Error::from_raw_os_error(2)));
    }
    #[cfg(target_os = "macos")]
    {
        assert!(is_transient_probe_io_error(&Error::from_raw_os_error(35)));
        assert!(is_transient_probe_io_error(&Error::from_raw_os_error(24)));
        assert!(!is_transient_probe_io_error(&Error::from_raw_os_error(2)));
    }
}

/// **The anti-silencing pin, re-anchored (HQ-DESKTOP-3P).** A resolved `hq`
/// whose backing is INDETERMINATE — a manifest that is PRESENT but could not be
/// read or parsed (a permission/AV hold), NOT a definitive absence — is a CLI
/// we cannot prove is absent. It stays `hq_installed` and keeps reporting: a
/// transient blip must never silence the event, the banner, and the regression
/// watermark while the user's CLI may be fine. The definitively-unbacked
/// foreign case is the sharper, OPPOSITE contract, pinned by
/// `definitively_unbacked_foreign_hq_is_not_installed_and_converges` below.
#[test]
fn indeterminate_backing_resolution_still_reports_and_carries_its_kind() {
    let tmp = tempfile::TempDir::new().unwrap();
    let bin = tmp.path().join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    // A real file the loader cannot execute — the cross-platform stand-in for
    // the extensionless POSIX shim resolved on the field host.
    let hq = bin.join("hq");
    std::fs::write(&hq, "#!/usr/bin/env sh\n").unwrap();
    // A package.json PRESENT beside it but unparseable: the binary anchor is
    // INDETERMINATE, never a definitive absence, so the resolution keeps
    // reporting instead of being treated as a foreign program.
    std::fs::write(bin.join("package.json"), b"{ not valid json\n").unwrap();

    let result =
        probe_local_version_with_kind(Some(&hq), ResolvedProgramKind::Extensionless, None, "");

    assert_eq!(result.local, None);
    assert_eq!(
        result.probes.binary_anchor,
        VersionProbeOutcome::ManifestReadOrParseFailed,
        "an unparseable manifest is indeterminate, not a definitive absence"
    );
    assert_eq!(
        result.probes.hq_backing,
        HqBacking::NotProbed,
        "an indeterminate read never names an unbacked sub-case"
    );
    assert!(
        result.hq_installed,
        "a CLI we cannot prove absent is installed"
    );
    assert!(
        should_report_unreadable_version(&result),
        "silencing a CLI we cannot prove is absent is prohibited"
    );
    assert_eq!(
        result.probes.resolved_program_kind,
        ResolvedProgramKind::Extensionless,
        "the resolver classification must reach the diagnostics"
    );
    assert_eq!(
        result.probes.binary_anchor_shape,
        BinaryAnchorShape::NpmPrefix
    );
}

/// The sharper contract (HQ-DESKTOP-3P): a resolved `hq` that is DEFINITIVELY
/// unbacked and foreign — a definitive `package_not_found` from a path OUTSIDE
/// every managed-toolchain root — whose version also cannot be read is not an
/// hq-cli install at all; it is an unrelated program named `hq`. Reporting it
/// as installed would fire the false unreadable-version warning forever AND
/// block the installer. Instead `hq_installed` is false, the report is silent,
/// and `cli_install_needed` becomes true so the machine converges. All three
/// assertions are RED on the base commit, where `hq_installed = hq.is_some()`.
#[test]
fn definitively_unbacked_foreign_hq_is_not_installed_and_converges() {
    let tmp = tempfile::TempDir::new().unwrap();
    let bin = tmp.path().join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    // An `hq` with NO hq-cli manifest anywhere, at a path outside every
    // managed-toolchain root → binary anchor PackageNotFound, backing
    // UnbackedForeign.
    let hq = bin.join("hq");
    std::fs::write(&hq, "#!/bin/sh\nexit 0\n").unwrap();

    let result = probe_local_version_with_kind(Some(&hq), ResolvedProgramKind::Exe, None, "");

    assert_eq!(result.local, None);
    assert_eq!(
        result.probes.binary_anchor,
        VersionProbeOutcome::PackageNotFound,
        "the foreign hq has no hq-cli package"
    );
    assert_eq!(
        result.probes.hq_backing,
        HqBacking::UnbackedForeign,
        "a definitive absence outside every managed root is foreign"
    );
    // The three field assertions that run RED on the base commit:
    assert!(
        !result.hq_installed,
        "a definitively-unbacked foreign hq is not an install"
    );
    assert!(
        !should_report_unreadable_version(&result),
        "the foreign unbacked case converges via install, not a forever-report"
    );
    assert!(
        cli_install_needed(None, "5.103.30", result.hq_installed),
        "with hq_installed false the installer runs and the machine converges"
    );
}

/// The genuinely-absent CLI stays a quiet no-op — kept as its own case so
/// the anti-silencing pin above can never be satisfied by reporting on
/// everyone.
#[test]
fn absent_hq_reports_the_not_resolved_kind_and_stays_quiet() {
    let result = probe_local_version(None, None, "");

    assert!(!result.hq_installed);
    assert!(!should_report_unreadable_version(&result));
    assert_eq!(
        result.probes.resolved_program_kind,
        ResolvedProgramKind::NotResolved
    );
}

/// Reproduces the exact production probe quadruple on the base commit
/// (`package_not_found` / `npm_prefix` / `package_not_found` /
/// `process_spawn_failed`) using the Unix ENOEXEC analogue of Windows os
/// error 193, and pins that the spawn no longer collapses into the
/// undifferentiated bucket.
///
/// The base-red half is Linux-specific by necessity — see
/// [`enoexec_fixture_outcome`] for why macOS cannot produce the fixture —
/// but the three surrounding field outcomes and the reporting decision are
/// asserted on every Unix leg.
#[test]
#[cfg(unix)]
fn field_shape_spawn_failure_is_classified_as_not_executable() {
    let tmp = tempfile::TempDir::new().unwrap();
    let bin = tmp.path().join("bin");
    let npm_root = tmp.path().join("npm-root");
    std::fs::create_dir_all(&bin).unwrap();
    std::fs::create_dir_all(&npm_root).unwrap();

    // Executable bit set, but the content is not a valid executable image
    // (no shebang, not ELF) — execve answers ENOEXEC, exactly as
    // CreateProcessW answers ERROR_BAD_EXE_FORMAT for a POSIX shim.
    let hq = bin.join("hq");
    write_executable(&hq, "\u{0}\u{1}not-an-executable-image\n");
    // npm resolves a global root that does not contain the package.
    let npm = bin.join("npm");
    write_executable(
        &npm,
        &format!("#!/bin/sh\nprintf '%s\\n' '{}'\n", npm_root.display()),
    );

    let result = probe_local_version(Some(&hq), Some(npm.to_str().unwrap()), "");

    assert_eq!(result.local, None);
    // HQ-DESKTOP-3P: this field fixture is a definitively-unbacked FOREIGN `hq`
    // (PackageNotFound from a path outside every managed root) whose version
    // cannot be read. Under the truthful-`hq_installed` contract it is NOT an
    // install — the machine converges via the installer instead of reporting
    // the same unreadable-version warning forever.
    assert_eq!(result.probes.hq_backing, HqBacking::UnbackedForeign);
    assert!(!result.hq_installed);
    assert!(!should_report_unreadable_version(&result));
    assert!(cli_install_needed(None, "5.103.30", result.hq_installed));
    // The three field-matching outcomes are unchanged…
    assert_eq!(
        result.probes.binary_anchor,
        VersionProbeOutcome::PackageNotFound
    );
    assert_eq!(
        result.probes.binary_anchor_shape,
        BinaryAnchorShape::NpmPrefix
    );
    assert_eq!(result.probes.npm_root, VersionProbeOutcome::PackageNotFound);
    // …and the fourth now names the cause instead of the bucket. This is
    // the assertion that runs RED on the base commit, where every spawn
    // failure collapsed into `process_spawn_failed`.
    assert_ne!(
        result.probes.hq_version,
        VersionProbeOutcome::ProcessSpawnFailed,
        "an unexecutable program must not report as an undifferentiated spawn failure"
    );
    assert_eq!(result.probes.hq_version, enoexec_fixture_outcome());
}

/// End-to-end at the seam that owns the recovery: the selector picks the
/// spawnable `hq.cmd` from a later search directory over the bare shim that
/// used to shadow it, and that selection reads a version with no report.
#[test]
fn recovered_spawnable_selection_reads_a_version_and_stays_quiet() {
    let tmp = tempfile::TempDir::new().unwrap();
    let early = tmp.path().join("git-usr-bin");
    let npm_prefix = tmp.path().join("npm-prefix");
    let package = npm_prefix.join("node_modules/@indigoai-us/hq-cli");
    std::fs::create_dir_all(&early).unwrap();
    std::fs::create_dir_all(&package).unwrap();
    std::fs::write(early.join("hq"), "not-an-executable-image\n").unwrap();
    std::fs::write(npm_prefix.join("hq.cmd"), "@echo off\n").unwrap();
    std::fs::write(
        package.join("package.json"),
        br#"{"name":"@indigoai-us/hq-cli","version":"5.94.1"}"#,
    )
    .unwrap();

    let selected = paths::select_program_in_dirs(
        &[early.clone(), npm_prefix.clone()],
        &[
            "hq.exe".to_string(),
            "hq.cmd".to_string(),
            "hq.bat".to_string(),
            "hq".to_string(),
        ],
        &|path| path.exists(),
    )
    .expect("the spawnable shim must be selected");
    assert_eq!(selected.path, npm_prefix.join("hq.cmd").to_string_lossy());
    assert_eq!(selected.kind, ResolvedProgramKind::CmdOrBat);

    let result =
        probe_local_version_with_kind(Some(Path::new(&selected.path)), selected.kind, None, "");

    assert_eq!(result.local.as_deref(), Some("5.94.1"));
    assert_eq!(result.probes.binary_anchor, VersionProbeOutcome::Succeeded);
    assert!(
        !should_report_unreadable_version(&result),
        "a recovered, readable CLI must produce no event"
    );
}

/// pnpm keeps its globals in its own store, which neither npm candidate
/// layout can reach — so a pnpm-managed Windows install read as unreadable
/// even though its manifest was sitting on disk.
#[test]
fn pnpm_windows_store_layouts_read_a_version_without_spawning() {
    fn write_store(home: &Path, store_version: &str, version: &str) {
        let package = home
            .join("global")
            .join(store_version)
            .join("node_modules/@indigoai-us/hq-cli");
        std::fs::create_dir_all(&package).unwrap();
        std::fs::write(
            package.join("package.json"),
            format!(r#"{{"name":"@indigoai-us/hq-cli","version":"{version}"}}"#),
        )
        .unwrap();
    }

    // 1. Flat pnpm home: `<pnpm-home>\hq.cmd`.
    let tmp = tempfile::TempDir::new().unwrap();
    let flat = tmp.path().join("pnpm");
    std::fs::create_dir_all(&flat).unwrap();
    let flat_shim = flat.join("hq.cmd");
    std::fs::write(&flat_shim, "@echo off\n").unwrap();
    write_store(&flat, "5", "5.90.0");
    assert_eq!(
        version_from_hq_binary_probe(&flat_shim),
        (Some("5.90.0".to_string()), VersionProbeOutcome::Succeeded)
    );

    // 2. pnpm >= 11 nests the shims: `<pnpm-home>\bin\hq.cmd`.
    let nested_home = tmp.path().join("pnpm-nested");
    let nested_bin = nested_home.join("bin");
    std::fs::create_dir_all(&nested_bin).unwrap();
    write_store(&nested_home, "6", "5.91.0");
    let nested_shim = nested_bin.join("hq.cmd");
    std::fs::write(&nested_shim, "@echo off\n").unwrap();
    assert_eq!(
        version_from_hq_binary_probe(&nested_shim),
        (Some("5.91.0".to_string()), VersionProbeOutcome::Succeeded)
    );

    // 3. Custom PNPM_HOME, identified by the `global/` store beside the
    //    shims, and with more than one store version present the newest
    //    format wins.
    let custom = tmp.path().join("custom-pnpm-home");
    std::fs::create_dir_all(&custom).unwrap();
    write_store(&custom, "5", "5.10.0");
    write_store(&custom, "10", "5.92.0");
    let custom_shim = custom.join("hq.cmd");
    std::fs::write(&custom_shim, "@echo off\n").unwrap();
    assert_eq!(
        version_from_hq_binary_probe(&custom_shim),
        (Some("5.92.0".to_string()), VersionProbeOutcome::Succeeded)
    );
}

/// npm layouts must keep their exact candidate order — the pnpm additions
/// are appended, never interleaved.
#[test]
fn npm_candidate_order_is_unchanged_by_the_pnpm_widening() {
    let prefix = Path::new("/prefix");
    let unix = Path::new("/prefix/lib/node_modules/@indigoai-us/hq-cli/package.json");
    let windows = Path::new("/prefix/node_modules/@indigoai-us/hq-cli/package.json");

    assert_eq!(
        hq_cli_package_json_candidates(prefix, Path::new("/prefix/bin/hq")),
        vec![unix.to_path_buf(), windows.to_path_buf()]
    );
    assert_eq!(
        hq_cli_package_json_candidates(prefix, Path::new("/prefix/hq.cmd")),
        vec![windows.to_path_buf(), unix.to_path_buf()]
    );
}

// --- HQ-DESKTOP-56: unsupported-Node classification ------------------------

/// A Node-6 machine's stderr: modern npm cannot even parse under Node 6, so it
/// dies with a bare Node `SyntaxError` and NONE of npm's structured
/// `npm error` markers — exactly the reported shape (npm_error_code=none,
/// npm_syscall=unknown, npm_path_shape=none, npm_lifecycle_failed=false), which
/// the env-blind classifier can only read as `Unexpected`.
fn node_six_stderr() -> &'static str {
    "/usr/local/lib/node_modules/npm/node_modules/@npmcli/arborist/lib/arborist/index.js:1\n\
         export { Arborist }\n\
         ^^^^^^\n\
         SyntaxError: Unexpected token export\n\
             at createScript (vm.js:56:10)\n\
             at Object.runInThisContext (vm.js:97:10)\n\
             at Module._compile (module.js:549:28)\n\
             at Object.Module._extensions..js (module.js:586:10)\n\
             at Module.load (module.js:494:32)\n\
             at tryModuleLoad (module.js:453:12)\n\
             at Function.Module._load (module.js:445:3)"
}

fn unsupported_node_env(version: Option<&str>, abi: Option<&str>) -> InstallEnvironment {
    InstallEnvironment {
        node_version: version.map(str::to_string),
        node_abi: abi.map(str::to_string),
        npm_version: None,
        toolchain_source: NpmToolchainSource::UserPath,
        managed_toolchain_retry: false,
        ..Default::default()
    }
}

#[test]
fn managed_retry_start_proceeds_whenever_a_managed_npm_resolves() {
    // The HQ-DESKTOP-5E fix: a cooldown-deferred (Deferred) or failed (Failed)
    // FRESH provision is NOT evidence that a managed toolchain is absent, so the
    // one-shot retry must PROCEED whenever a managed npm actually resolves —
    // regardless of the repair disposition. The old code abandoned the retry on
    // Deferred/Failed before ever consulting the managed npm.
    let triple = || {
        Some((
            "/managed/bin/npm".to_string(),
            "/managed/bin:/usr/bin".to_string(),
            "/managed/npm-global".to_string(),
        ))
    };
    for disposition in [
        ManagedRepairDisposition::Repaired,
        ManagedRepairDisposition::Deferred,
        ManagedRepairDisposition::Failed,
    ] {
        assert_eq!(
            managed_retry_start_decision(disposition, triple()),
            ManagedRetryStart::Proceed {
                npm: "/managed/bin/npm".to_string(),
                path: "/managed/bin:/usr/bin".to_string(),
                prefix: "/managed/npm-global".to_string(),
            },
            "disposition {disposition:?} with a resolvable managed npm must proceed"
        );
    }
}

#[test]
fn managed_crash_retry_requires_a_successful_fresh_repair() {
    let triple = Some((
        "/managed/bin/npm".to_string(),
        "/managed/bin:/usr/bin".to_string(),
        "/managed/npm-global".to_string(),
    ));
    assert_eq!(
        managed_crash_retry_start_decision(ManagedRepairDisposition::Repaired, triple.clone()),
        ManagedRetryStart::Proceed {
            npm: "/managed/bin/npm".to_string(),
            path: "/managed/bin:/usr/bin".to_string(),
            prefix: "/managed/npm-global".to_string(),
        }
    );
    assert_eq!(
        managed_crash_retry_start_decision(ManagedRepairDisposition::Deferred, triple.clone()),
        ManagedRetryStart::Decline(ManagedRetryOutcome::ProvisionDeferred),
        "do not retry the same managed runtime while its repair is deferred"
    );
    assert_eq!(
        managed_crash_retry_start_decision(ManagedRepairDisposition::Failed, triple),
        ManagedRetryStart::Decline(ManagedRetryOutcome::ProvisionFailed),
        "do not retry the same managed runtime after repair fails"
    );
}

#[test]
fn managed_retry_declines_only_when_no_managed_npm_resolves_naming_the_disposition() {
    // With no managed npm on disk, the retry declines — and names WHICH
    // disposition left it absent, so the next occurrence is self-diagnosing
    // instead of silently blaming the user's toolchain (the HQ-DESKTOP-5E gap).
    assert_eq!(
        managed_retry_start_decision(ManagedRepairDisposition::Repaired, None),
        ManagedRetryStart::Decline(ManagedRetryOutcome::NoManagedNpm),
    );
    assert_eq!(
        managed_retry_start_decision(ManagedRepairDisposition::Deferred, None),
        ManagedRetryStart::Decline(ManagedRetryOutcome::ProvisionDeferred),
    );
    assert_eq!(
        managed_retry_start_decision(ManagedRepairDisposition::Failed, None),
        ManagedRetryStart::Decline(ManagedRetryOutcome::ProvisionFailed),
    );
}

#[test]
fn managed_retry_outcome_tag_values_are_a_closed_stable_set() {
    for (outcome, expected) in [
        (ManagedRetryOutcome::NotArmed, "not-armed"),
        (ManagedRetryOutcome::Ran, "ran"),
        (ManagedRetryOutcome::NoManagedNpm, "no-managed-npm"),
        (ManagedRetryOutcome::ProvisionDeferred, "provision-deferred"),
        (ManagedRetryOutcome::ProvisionFailed, "provision-failed"),
        (ManagedRetryOutcome::SpawnFailed, "spawn-failed"),
        (ManagedRetryOutcome::UnsafeUserTarget, "unsafe-user-target"),
    ] {
        assert_eq!(outcome.tag_value(), expected);
    }
    // The default reproduces "no retry considered", so every pre-existing caller
    // that never sets the field tags itself not-armed and keeps today's shape.
    assert_eq!(
        ManagedRetryOutcome::default(),
        ManagedRetryOutcome::NotArmed
    );
}

#[test]
fn managed_retry_outcome_is_never_a_grouping_component() {
    // Adding the outcome must not move any event between Sentry issues: neither
    // the signature nor the repeat-guard key may read it. Two environments that
    // differ ONLY in managed_retry_outcome must produce byte-identical grouping.
    let enotempty = "npm error code ENOTEMPTY\n\
            npm error syscall rename\n\
            npm error path /usr/local/lib/node_modules/@indigoai-us/hq-cli";
    let base = InstallEnvironment {
        node_version: Some("22.23.1".to_string()),
        node_abi: Some("127".to_string()),
        npm_version: Some("10.9.8".to_string()),
        toolchain_source: NpmToolchainSource::UserPath,
        managed_toolchain_retry: false,
        managed_retry_outcome: ManagedRetryOutcome::NotArmed,
        windows_busy_retry_attempts: None,
        windows_busy_retry_outcome: WindowsBusyRetryOutcome::NotApplicable,
        windows_busy_deferral_attempts: None,
        windows_busy_deferral_outcome: WindowsBusyDeferralOutcome::NotApplicable,
        lock_holder_diagnostic: None,
        missing_target_state: MissingTargetState::Unknown,
        target_version: None,
        running_cli_version: None,
        requested_spec_kind: RequestedSpecKind::Unknown,
        registry_serving_lag_recurred: false,
    };
    let mut declined = base.clone();
    declined.managed_retry_outcome = ManagedRetryOutcome::ProvisionDeferred;

    assert_eq!(
        install_failure_signature_with_environment(
            InstallFailureKind::Unexpected,
            enotempty,
            None,
            &base,
        ),
        install_failure_signature_with_environment(
            InstallFailureKind::Unexpected,
            enotempty,
            None,
            &declined,
        ),
        "managed_retry_outcome must never change the install-failure signature"
    );
    assert_eq!(
        install_failure_episode_key_with_environment(
            Some(190),
            enotempty,
            None,
            false,
            "5.103.22",
            &base,
        ),
        install_failure_episode_key_with_environment(
            Some(190),
            enotempty,
            None,
            false,
            "5.103.22",
            &declined,
        ),
        "managed_retry_outcome must never change the repeat-guard key"
    );
    // Non-vacuous: the shared key is genuinely minted, not a None == None pass.
    assert!(install_failure_episode_key_with_environment(
        Some(190),
        enotempty,
        None,
        false,
        "5.103.22",
        &base,
    )
    .is_some());
}

#[test]
fn unsupported_node_reclassifies_only_a_below_floor_probe() {
    let stderr = node_six_stderr();
    // The exact reported shape: Node 6.17.1 (ABI 48), no npm markers, prefix
    // known -> UnsupportedNode.
    assert_eq!(
        classify_install_failure_with_environment(
            Some(1),
            stderr,
            Some("/usr/local"),
            false,
            &unsupported_node_env(Some("v6.17.1"), Some("48")),
        ),
        InstallFailureKind::UnsupportedNode
    );
    // A supported or unreadable Node keeps today's `Unexpected` for the
    // identical stderr — the refinement requires a parsed major strictly below
    // the floor and otherwise fails open to current behaviour. `v20`/`v22` are
    // AT/above the floor; `None`/`unknown` never parse a major.
    for node in [None, Some("unknown"), Some("v20.11.0"), Some("v22.17.0")] {
        assert_eq!(
            classify_install_failure_with_environment(
                Some(1),
                stderr,
                Some("/usr/local"),
                false,
                &unsupported_node_env(node, None),
            ),
            InstallFailureKind::Unexpected,
            "node {node:?} must stay Unexpected"
        );
    }
}

#[test]
fn unsupported_node_never_overrides_an_expected_or_lifecycle_kind() {
    // Even on a Node-6 machine, every already-classified kind is preserved:
    // the refinement touches ONLY the `Unexpected` fallback, so no existing
    // suppression or grouping is disturbed.
    let old_node = unsupported_node_env(Some("v6.17.1"), Some("48"));
    let cases: &[(Option<i32>, &str, Option<&str>, bool, InstallFailureKind)] = &[
        (
            Some(1),
            "npm error code ENOSPC\nnpm error syscall write\nnpm error ENOSPC: no space left on device, write",
            None,
            false,
            InstallFailureKind::ExpectedDiskFull,
        ),
        (
            Some(1),
            "npm error code EACCES\nnpm error syscall mkdir\nnpm error path /usr/local/lib/node_modules/@indigoai-us\nnpm error errno -13",
            None,
            false,
            InstallFailureKind::ExpectedPrefixPermission,
        ),
        (Some(WINDOWS_ABORT_EXIT), "", None, false, InstallFailureKind::ExpectedWindowsAbort),
        (
            Some(-4048),
            "npm error code EPERM\nnpm error syscall unlink\nnpm error path /usr/local/bin/hq",
            Some("/usr/local"),
            false,
            InstallFailureKind::ExpectedWindowsLockedBinary,
        ),
        (Some(1), "npm error code ETARGET", None, false, InstallFailureKind::ExpectedTransientRegistry),
        (
            Some(1),
            "npm error code EEXIST\nnpm error path /usr/local/bin/hq",
            Some("/usr/local"),
            true,
            InstallFailureKind::ExpectedBinCollision,
        ),
        (
            Some(1),
            "npm error code 1\nnpm error path /root/.npm-global/lib/node_modules/better-sqlite3\nnpm error command failed\nnpm error command sh -c prebuild-install || node-gyp rebuild",
            Some("/root/.npm-global"),
            false,
            InstallFailureKind::UnexpectedLifecycle,
        ),
    ];
    for (exit, detail, prefix, forced, expected) in cases {
        assert_eq!(
            classify_install_failure_with_environment(*exit, detail, *prefix, *forced, &old_node),
            *expected,
            "detail {detail:?} must keep its kind on a Node-6 machine"
        );
    }
}

#[test]
fn env_blind_wrappers_are_behaviour_preserving_for_a_node_6_stderr() {
    let stderr = node_six_stderr();
    // Env-blind delegation is unchanged where it must be: the Node-6 stderr still
    // classifies `Unexpected` and the detail still passes the raw stderr through,
    // proving default-env delegation changed neither the kind nor the copy.
    assert_eq!(
        classify_install_failure(Some(1), stderr, Some("/usr/local")),
        InstallFailureKind::Unexpected
    );
    assert_eq!(
        classify_install_failure_with_final_attempt(Some(1), stderr, Some("/usr/local"), false),
        InstallFailureKind::Unexpected
    );
    // The reported grouping intentionally moves off the empty `none:unknown:none`
    // bucket: this NON-EMPTY markerless stderr is attributed (HQ-DESKTOP-56) as
    // `unattributed:non-npm:stack_frame` — a pure function of `detail`, so the
    // env-blind and default-env-aware paths agree by construction. A Node-6
    // MACHINE reports differently again (`unsupported-node:6`) because the app
    // passes the probed environment; only these legacy env-blind callers see the
    // attributed shape.
    assert_eq!(
        install_failure_report_with_final_attempt(Some(1), stderr, Some("/usr/local"), false),
        Some("[hq-cli-update] install failed (unattributed:non-npm:stack_frame)".to_string())
    );
    // The env-blind detail still shows the raw stderr passthrough...
    assert_eq!(
        install_failure_detail_with_final_attempt(Some(1), stderr, Some("/usr/local"), false),
        stderr.trim()
    );
    // ...while the env-aware detail, given the Node-6 probe, names the required
    // Node instead of echoing the raw parse error.
    let actionable = install_failure_detail_with_environment(
        Some(1),
        stderr,
        Some("/usr/local"),
        false,
        &unsupported_node_env(Some("v6.17.1"), Some("48")),
    );
    assert!(
        actionable.contains("Node.js 20") && !actionable.contains("SyntaxError"),
        "unsupported-node copy must name the floor and never echo raw stderr: {actionable}"
    );
}

#[test]
fn unsupported_node_signature_is_bounded_and_free_text_cannot_enter() {
    let stderr = node_six_stderr();
    // The signature is `unsupported-node:<parsed major>` and nothing else.
    assert_eq!(
        install_failure_signature_with_environment(
            InstallFailureKind::UnsupportedNode,
            stderr,
            Some("/usr/local"),
            &unsupported_node_env(Some("v6.17.1"), Some("48")),
        ),
        "unsupported-node:6"
    );
    // A probed version carrying free text collapses through
    // `sanitized_version_token` to `unknown`, so no major parses and NO
    // reclassification happens — caller free text can never reach the group.
    assert_eq!(
        classify_install_failure_with_environment(
            Some(1),
            stderr,
            Some("/usr/local"),
            false,
            &unsupported_node_env(Some("6.x nightly; rm -rf /"), Some("48")),
        ),
        InstallFailureKind::Unexpected
    );
}

#[test]
fn unsupported_node_episode_key_pages_once_per_target_version() {
    let stderr = node_six_stderr();
    let latest = "5.101.7";
    let env6 = unsupported_node_env(Some("v6.17.1"), Some("48"));
    let key = install_failure_episode_key_with_environment(
        Some(1),
        stderr,
        Some("/usr/local"),
        false,
        latest,
        &env6,
    )
    .expect("unsupported-node mints an episode key");
    assert_eq!(key, "5.101.7|unsupported-node|6");
    // A second identical failure for the same target version + major is a
    // suppressed repeat, so a permanent per-machine condition stops re-paging.
    assert!(install_failure_episode_blocked(&[key.clone()], &key));
    // A new CLI target version, a different Node major, and managed provenance
    // each mint a DISTINCT key, so a genuinely different episode still reports.
    let new_latest = install_failure_episode_key_with_environment(
        Some(1),
        stderr,
        Some("/usr/local"),
        false,
        "5.102.0",
        &env6,
    );
    assert_eq!(new_latest.as_deref(), Some("5.102.0|unsupported-node|6"));
    let node8 = install_failure_episode_key_with_environment(
        Some(1),
        stderr,
        Some("/usr/local"),
        false,
        latest,
        &unsupported_node_env(Some("v8.17.0"), Some("57")),
    );
    assert_eq!(node8.as_deref(), Some("5.101.7|unsupported-node|8"));
    let mut managed_env = env6.clone();
    managed_env.managed_toolchain_retry = true;
    let managed = install_failure_episode_key_with_environment(
        Some(1),
        stderr,
        Some("/usr/local"),
        false,
        latest,
        &managed_env,
    );
    assert_eq!(
        managed.as_deref(),
        Some("5.101.7|unsupported-node|6|managed")
    );
    // The env-blind shape (no probed Node) is a plain `Unexpected` failure. Before
    // HQ-DESKTOP-56 its empty `none:unknown:none` signature minted no key; now this
    // NON-EMPTY markerless stderr is attributed, so it earns a bounded key
    // (`unattributed|non-npm|stack_frame`) and pages once per published version. A
    // genuinely EMPTY stderr still mints no key — pinned in
    // `unexpected_install_failure_episode_key_pages_once_per_version_and_signature`.
    assert_eq!(
        install_failure_episode_key_with_environment(
            Some(1),
            stderr,
            Some("/usr/local"),
            false,
            latest,
            &InstallEnvironment::default(),
        )
        .as_deref(),
        Some("5.101.7|unattributed|non-npm|stack_frame")
    );
}

// ── HQ-DESKTOP-56 reopen: attribution for a NON-EMPTY markerless failure ──

/// The reopen environment: a Windows machine on a SUPPORTED Node 26 whose npm
/// exited 1 with a short stderr carrying none of npm's structured markers.
fn reopen_env() -> InstallEnvironment {
    InstallEnvironment {
        node_version: Some("26.3.0".to_string()),
        node_abi: Some("147".to_string()),
        npm_version: Some("11.16.0".to_string()),
        toolchain_source: NpmToolchainSource::UserPath,
        ..Default::default()
    }
}

#[test]
fn nonempty_markerless_failure_leaves_the_empty_bucket_for_a_bounded_group() {
    let env = reopen_env();
    // A markerless shim/OS error carrying Windows drive paths — no `npm error`
    // line at all, so npm's logger produced nothing (non-npm origin), and the
    // dominant structural shape is path_like. CRLF-delimited, as Windows emits.
    let stderr = "Access to 'C:\\Users\\me\\AppData\\Roaming\\npm\\hq' is denied.\r\n\
                      Could not write to C:\\ProgramData\\hq; the update stopped.";
    // Supported Node 26 -> not UnsupportedNode; stays Unexpected.
    assert_eq!(
        classify_install_failure_with_environment(Some(1), stderr, None, false, &env),
        InstallFailureKind::Unexpected
    );
    let signature = install_failure_signature_with_environment(
        InstallFailureKind::Unexpected,
        stderr,
        None,
        &env,
    );
    assert_eq!(signature, "unattributed:non-npm:path_like");
    // The signature carries only closed tokens: no count, no length, and no raw
    // path byte can enter the group.
    for token in ["C:\\", "Users", "ProgramData"] {
        assert!(
            !signature.contains(token),
            "signature leaked {token}: {signature}"
        );
    }
    assert!(
        signature.bytes().all(|b| !b.is_ascii_digit()),
        "the attributed signature must not embed any count or length: {signature}"
    );
    // It pages once per published CLI version on that discriminating signature.
    let key = install_failure_episode_key_with_environment(
        Some(1),
        stderr,
        None,
        false,
        "5.103.23",
        &env,
    )
    .expect("a non-empty markerless failure now mints a bounded episode key");
    assert_eq!(key, "5.103.23|unattributed|non-npm|path_like");
    assert!(install_failure_episode_blocked(&[key.clone()], &key));
    // A newly published CLI version pages a first occurrence again.
    let bumped = install_failure_episode_key_with_environment(
        Some(1),
        stderr,
        None,
        false,
        "5.103.24",
        &env,
    )
    .expect("bumped version mints a distinct key");
    assert!(!install_failure_episode_blocked(&[key], &bumped));
}

#[test]
fn stderr_origin_splits_non_npm_from_npm_logger_and_folds_empty_to_none() {
    let env = reopen_env();
    let drive_path = "cannot write C:\\Users\\me\\npm\\hq: access denied.";
    // non-npm: npm's own logger emitted nothing.
    assert_eq!(
        unattributed_install_stderr_origin(Some(1), drive_path, None, false, &env),
        Some("non-npm")
    );
    // npm-logger: npm printed marker lines but structured no code/syscall/path.
    let npm_logger = "npm error Unexpected end of JSON input while parsing\n\
                          npm error A complete log of this run can be found above.";
    assert_eq!(
        unattributed_install_stderr_origin(Some(1), npm_logger, None, false, &env),
        Some("npm-logger")
    );
    // Empty stderr is genuinely shapeless: no attributed origin, no retry-arming.
    assert_eq!(
        unattributed_install_stderr_origin(Some(1), "", None, false, &env),
        None
    );
    // A shape npm actually characterised keeps its discriminating signature, so it
    // is never the unattributed subclass.
    let enotempty = "npm error code ENOTEMPTY\n\
                         npm error syscall rename\n\
                         npm error path /usr/local/lib/node_modules/@indigoai-us/hq-cli";
    assert_eq!(
        unattributed_install_stderr_origin(Some(190), enotempty, None, false, &env),
        None
    );
    // A below-floor Node reclassifies to UnsupportedNode, so the same markerless
    // stderr is owned by the unsupported-node path, not the unattributed subclass.
    let node6 = InstallEnvironment {
        node_version: Some("6.17.1".to_string()),
        node_abi: Some("48".to_string()),
        toolchain_source: NpmToolchainSource::UserPath,
        ..Default::default()
    };
    assert_eq!(
        unattributed_install_stderr_origin(Some(1), drive_path, None, false, &node6),
        None
    );
}

// ---- HQ-DESKTOP-5K: npm's own global install-target directory is missing ----

/// The exact reconstructed production input behind HQ-DESKTOP-5K (Sentry issue
/// 7691444052): `npm i -g @indigoai-us/hq-cli@latest` on a Windows machine whose
/// npm global prefix directory chain does not exist, so npm's own `mkdir` fails
/// ENOENT at a global-install path with NO prefix resolved. Byte-for-byte the
/// structured lines the event recorded: code ENOENT, syscall mkdir, a
/// global-lib-node-modules path shape, errno -4058, and no lifecycle marker.
const MISSING_TARGET_STDERR: &str = "npm error code ENOENT\n\
        npm error syscall mkdir\n\
        npm error path C:\\Users\\U\\AppData\\Roaming\\npm\\node_modules\\@indigoai-us\\hq-cli\n\
        npm error errno -4058";

#[test]
fn missing_global_install_target_reconstructed_hq_desktop_5k_classifies_and_groups() {
    // On the UNMODIFIED base this exact input classified as `Unexpected`, titled
    // its report `... (ENOENT:mkdir:global-lib-node-modules)`, and minted episode
    // key `<latest>|unexpected|ENOENT|mkdir|global-lib-node-modules` (the planner's
    // executed byte-identical reproduction). On the candidate it earns its own
    // kind, fingerprint, and bounded signature and leaves the `unexpected` group.
    assert!(is_missing_global_install_target(
        MISSING_TARGET_STDERR,
        None
    ));
    assert_eq!(
        classify_install_failure(Some(-4058), MISSING_TARGET_STDERR, None),
        InstallFailureKind::MissingGlobalInstallTarget,
        "the reconstructed HQ-DESKTOP-5K input must no longer fall through to Unexpected"
    );
    assert_eq!(
        InstallFailureKind::MissingGlobalInstallTarget.fingerprint_component(),
        "missing-global-install-target"
    );
    // The report title carries the NEW bounded signature — no longer
    // `ENOENT:mkdir:global-lib-node-modules` under the unexpected kind.
    assert_eq!(
        install_failure_report(Some(-4058), MISSING_TARGET_STDERR, None),
        Some(
            "[hq-cli-update] install failed (missing-global-install-target:global-lib-node-modules)"
                .to_string()
        )
    );
    assert_eq!(
        install_failure_signature_with_environment(
            InstallFailureKind::MissingGlobalInstallTarget,
            MISSING_TARGET_STDERR,
            None,
            &InstallEnvironment::default(),
        ),
        "missing-global-install-target:global-lib-node-modules"
    );
}

#[test]
fn missing_global_install_target_repeat_guard_pages_once_per_version_with_managed_discriminator() {
    let latest = "0.10.157";
    let key = install_failure_episode_key_with_environment(
        Some(-4058),
        MISSING_TARGET_STDERR,
        None,
        false,
        latest,
        &InstallEnvironment::default(),
    )
    .expect("missing-global-install-target mints an episode key");
    assert_eq!(
        key,
        "0.10.157|missing-global-install-target|global-lib-node-modules"
    );
    // An identical repeat for the same published version is suppressed, so the
    // wedge stops re-paging every 6-hourly check.
    assert!(install_failure_episode_blocked(&[key.clone()], &key));
    // A newly published CLI version mints a fresh key and pages a first occurrence
    // again — the key still VARIES with the published version.
    let next = install_failure_episode_key_with_environment(
        Some(-4058),
        MISSING_TARGET_STDERR,
        None,
        false,
        "0.10.158",
        &InstallEnvironment::default(),
    );
    assert_eq!(
        next.as_deref(),
        Some("0.10.158|missing-global-install-target|global-lib-node-modules")
    );
    // A managed-retry event carries the `|managed` provenance discriminator so it
    // never collides with its user-path predecessor.
    let managed = install_failure_episode_key_with_environment(
        Some(-4058),
        MISSING_TARGET_STDERR,
        None,
        false,
        latest,
        &InstallEnvironment {
            managed_toolchain_retry: true,
            ..InstallEnvironment::default()
        },
    );
    assert_eq!(
        managed.as_deref(),
        Some("0.10.157|missing-global-install-target|global-lib-node-modules|managed")
    );
}

#[test]
fn missing_global_install_target_predicate_is_disjoint_from_lifecycle_and_siblings() {
    // 1. A genuine third-party lifecycle failure (ELIFECYCLE + command failed)
    //    keeps its `UnexpectedLifecycle` kind — the code is not ENOENT, and the
    //    predicate also excludes the lifecycle marker.
    let lifecycle = "npm error code ELIFECYCLE\n\
            npm error command failed\n\
            npm error path /Users/alice/.npm-global/lib/node_modules/better-sqlite3";
    assert!(!is_missing_global_install_target(
        lifecycle,
        Some("/Users/alice/.npm-global")
    ));
    assert_eq!(
        classify_install_failure(Some(1), lifecycle, Some("/Users/alice/.npm-global")),
        InstallFailureKind::UnexpectedLifecycle
    );
    // 2. The better-sqlite3 `ENOENT`-WITH-`command failed` shape (the :8379 fixture
    //    family): npm's own parser does NOT treat it as a lifecycle failure
    //    (ENOENT is not a lifecycle code), so on base it is `Unexpected`. The new
    //    predicate must ALSO leave it untouched — it has no `syscall mkdir` line
    //    AND carries a lifecycle marker, so BOTH guards exclude it.
    let enoent_command_failed = "npm error code ENOENT\nnpm error command failed\nnpm error path /tmp/lib/node_modules/better-sqlite3";
    assert!(!npm_lifecycle_failure(enoent_command_failed).failed);
    assert!(!is_missing_global_install_target(
        enoent_command_failed,
        None
    ));
    assert_eq!(
        classify_install_failure(Some(1), enoent_command_failed, None),
        InstallFailureKind::Unexpected
    );
    // 3. An ENOENT/mkdir whose path shape is NOT a global-install target (here the
    //    npm cache) stays `Unexpected`.
    let cache_enoent = "npm error code ENOENT\n\
            npm error syscall mkdir\n\
            npm error path /Users/alice/.npm/_cacache/tmp/abc";
    assert!(!is_missing_global_install_target(cache_enoent, None));
    assert_eq!(
        classify_install_failure(Some(-4058), cache_enoent, None),
        InstallFailureKind::Unexpected
    );
    // 4. A bare `ENOENT` token with no structured code/syscall lines never matches
    //    (keyed on npm's OWN code + syscall, never a substring).
    assert!(!is_missing_global_install_target(
        "gyp ERR! stack Error: ENOENT while running the build",
        None
    ));
    // 5. The selected-prefix layout ALSO qualifies (a resolved prefix whose
    //    node_modules chain is missing), so both global-install shapes are caught.
    let selected = "npm error code ENOENT\n\
            npm error syscall mkdir\n\
            npm error path /Users/alice/.npm-global/lib/node_modules/@indigoai-us";
    assert!(is_missing_global_install_target(
        selected,
        Some("/Users/alice/.npm-global")
    ));
    assert_eq!(
        classify_install_failure(Some(-4058), selected, Some("/Users/alice/.npm-global")),
        InstallFailureKind::MissingGlobalInstallTarget
    );
    // 6. A DEEPER mkdir ENOENT INSIDE an already-created package (the global
    //    prefix chain exists; only a nested dependency dir failed) must NOT be
    //    misfiled as a missing install root — it stays `Unexpected` so it is not
    //    needlessly self-healed, downgraded, and repeat-suppressed.
    let deep = "npm error code ENOENT\n\
            npm error syscall mkdir\n\
            npm error path /Users/alice/.npm-global/lib/node_modules/@indigoai-us/hq-cli/node_modules/foo/cache";
    assert!(!is_missing_global_install_target(
        deep,
        Some("/Users/alice/.npm-global")
    ));
    assert_eq!(
        classify_install_failure(Some(-4058), deep, Some("/Users/alice/.npm-global")),
        InstallFailureKind::Unexpected
    );
}

#[test]
fn adding_missing_target_kind_leaves_existing_group_keys_byte_identical() {
    // The ENOTDIR global-target shape (HQ-DESKTOP-4J) still groups as `Unexpected`
    // with its exact prior signature and repeat-guard key — the new arm is placed
    // after lifecycle and requires code ENOENT, so it never intercepts ENOTDIR.
    let enotdir = "npm error code ENOTDIR\n\
            npm error syscall mkdir\n\
            npm error errno -20\n\
            npm error path /usr/local/lib/node_modules/@indigoai-us/hq-cli";
    assert_eq!(
        classify_install_failure(Some(236), enotdir, None),
        InstallFailureKind::Unexpected
    );
    assert_eq!(
        install_failure_signature_with_environment(
            InstallFailureKind::Unexpected,
            enotdir,
            None,
            &InstallEnvironment::default(),
        ),
        "ENOTDIR:mkdir:global-lib-node-modules"
    );
    assert_eq!(
        install_failure_episode_key_with_environment(
            Some(236),
            enotdir,
            None,
            false,
            "0.10.157",
            &InstallEnvironment::default(),
        )
        .as_deref(),
        Some("0.10.157|unexpected|ENOTDIR|mkdir|global-lib-node-modules")
    );
    // The new instrumentation state is never a grouping component: the same input
    // with a non-default `missing_target_state` yields the SAME signature.
    assert_eq!(
        install_failure_signature_with_environment(
            InstallFailureKind::Unexpected,
            enotdir,
            None,
            &InstallEnvironment {
                missing_target_state: MissingTargetState::CreatedAndRetried,
                ..InstallEnvironment::default()
            },
        ),
        "ENOTDIR:mkdir:global-lib-node-modules"
    );
    // A GENUINELY shapeless failure — an EMPTY stderr, npm structured nothing —
    // still mints NO repeat-guard key. (HQ-DESKTOP-56 now attributes a NON-EMPTY
    // markerless stderr as `unattributed:<origin>:<shape>` and bounds its paging;
    // only the empty case stays genuinely shapeless and unbounded, per commit
    // e24e7a45. The attribution of non-empty markerless failures is covered by the
    // dedicated HQ-DESKTOP-56 tests.)
    assert_eq!(
        install_failure_episode_key_with_environment(
            Some(1),
            "",
            None,
            false,
            "0.10.157",
            &InstallEnvironment::default(),
        ),
        None
    );
}

// --- E404 registry attribution (HQ-DESKTOP-5Q) ------------------------------

/// A foreign-registry E404: npm's own 404 line names a non-npmjs host and the
/// requested scoped packument (the `%2f` scope separator survives even behind a
/// registry path prefix), plus the "not in this registry" tail. Parameterised on
/// the line prefix so both the modern `npm error` and legacy `npm err!` npm
/// spellings are covered.
fn foreign_e404_stderr(prefix: &str) -> String {
    format!(
        "{prefix} code E404\n\
             {prefix} 404 Not Found - GET https://npm.internal.example.com/api/npm/npm-remote/@indigoai-us%2fhq-cli - Not found\n\
             {prefix} 404\n\
             {prefix} 404  '@indigoai-us/hq-cli@5.103.27' is not in this registry."
    )
}

/// The same shape but resolved through npmjs itself — a genuine "we asked npmjs
/// for something absent" defect that must stay loud.
fn npmjs_e404_stderr(prefix: &str) -> String {
    format!(
        "{prefix} code E404\n\
             {prefix} 404 Not Found - GET https://registry.npmjs.org/@indigoai-us%2fhq-cli - Not found\n\
             {prefix} 404\n\
             {prefix} 404  '@indigoai-us/hq-cli@5.103.27' is not in this registry."
    )
}

#[test]
fn npm_registry_origin_and_404_resource_tag_values_are_closed_stable_sets() {
    assert_eq!(NpmRegistryOrigin::Npmjs.tag_value(), "npmjs");
    assert_eq!(NpmRegistryOrigin::Foreign.tag_value(), "foreign");
    assert_eq!(NpmRegistryOrigin::Unknown.tag_value(), "unknown");
    assert_eq!(Npm404Resource::Packument.tag_value(), "packument");
    assert_eq!(Npm404Resource::Tarball.tag_value(), "tarball");
    assert_eq!(Npm404Resource::Other.tag_value(), "other");
    assert_eq!(Npm404Resource::None.tag_value(), "none");
}

#[test]
fn npm_registry_origin_and_404_resource_parse_only_npms_own_404_line() {
    for prefix in ["npm error", "npm err!"] {
        let foreign = foreign_e404_stderr(prefix);
        assert_eq!(
            npm_registry_origin(&foreign),
            NpmRegistryOrigin::Foreign,
            "{prefix}: foreign host must resolve to Foreign"
        );
        assert_eq!(
            npm_404_resource(&foreign),
            Npm404Resource::Packument,
            "{prefix}: scoped packument GET"
        );
        let npmjs = npmjs_e404_stderr(prefix);
        assert_eq!(
            npm_registry_origin(&npmjs),
            NpmRegistryOrigin::Npmjs,
            "{prefix}: registry.npmjs.org must resolve to Npmjs"
        );
        assert_eq!(npm_404_resource(&npmjs), Npm404Resource::Packument);
    }
    // A tarball GET (contains `/-/` and ends `.tgz`) -> Tarball, foreign origin.
    let tarball = "npm error code E404\n\
            npm error 404 Not Found - GET https://npm.internal.example.com/api/npm/npm-remote/@indigoai-us/hq-cli/-/hq-cli-5.103.27.tgz - Not found";
    assert_eq!(npm_registry_origin(tarball), NpmRegistryOrigin::Foreign);
    assert_eq!(npm_404_resource(tarball), Npm404Resource::Tarball);
    // No parseable 404 GET line -> Unknown origin, None resource (fail-loud: a
    // shapeless E404 stays at Error).
    let no_line = "npm error code E404\nnpm error 404 Not Found";
    assert_eq!(npm_registry_origin(no_line), NpmRegistryOrigin::Unknown);
    assert_eq!(npm_404_resource(no_line), Npm404Resource::None);
    // A deeper per-version metadata path is neither packument nor tarball.
    let per_version = "npm error code E404\n\
            npm error 404 Not Found - GET https://registry.npmjs.org/@indigoai-us%2fhq-cli/5.103.99 - Not found";
    assert_eq!(npm_404_resource(per_version), Npm404Resource::Other);
}

#[test]
fn foreign_registry_e404_classifies_only_for_a_foreign_origin_without_lifecycle() {
    // Foreign-origin E404, no lifecycle -> the new kind, for both line prefixes.
    for prefix in ["npm error", "npm err!"] {
        assert_eq!(
            classify_install_failure_with_environment(
                Some(1),
                &foreign_e404_stderr(prefix),
                None,
                false,
                &InstallEnvironment::default(),
            ),
            InstallFailureKind::ForeignRegistryPackageMissing,
            "{prefix}"
        );
    }
    // An npmjs-origin E404 stays Unexpected (a genuine "asked npmjs for something
    // absent" defect) and an unknown-origin E404 does too.
    for stderr in [
        npmjs_e404_stderr("npm error"),
        "npm error code E404\nnpm error 404 Not Found".to_string(),
    ] {
        assert_eq!(
            classify_install_failure_with_environment(
                Some(1),
                &stderr,
                None,
                false,
                &InstallEnvironment::default(),
            ),
            InstallFailureKind::Unexpected
        );
    }
    // A third-party native-build lifecycle failure whose stderr ALSO carries a
    // 404 GET line keeps its per-package lifecycle attribution — the classifier
    // order (lifecycle arm first) protects it.
    let lifecycle_with_404 = "npm error code 1\n\
            npm error path /Users/alice/.npm-global/lib/node_modules/better-sqlite3\n\
            npm error command failed\n\
            npm error command sh -c prebuild-install || node-gyp rebuild\n\
            prebuild-install warn install No prebuilt binaries found\n\
            npm error 404 Not Found - GET https://npm.internal.example.com/@some%2fdep - Not found";
    assert_eq!(
        classify_install_failure_with_environment(
            Some(1),
            lifecycle_with_404,
            None,
            false,
            &InstallEnvironment::default(),
        ),
        InstallFailureKind::UnexpectedLifecycle
    );
    // An E404 that ALSO carries a lifecycle marker is excluded from the new kind
    // by the `!has_npm_lifecycle_failure_marker` clause and stays Unexpected —
    // the exclusion is load-bearing, not incidental to the code check.
    let e404_with_lifecycle_marker = "npm error code E404\n\
            npm error command failed\n\
            npm error 404 Not Found - GET https://npm.internal.example.com/@indigoai-us%2fhq-cli - Not found";
    assert_eq!(
        classify_install_failure_with_environment(
            Some(1),
            e404_with_lifecycle_marker,
            None,
            false,
            &InstallEnvironment::default(),
        ),
        InstallFailureKind::Unexpected
    );
    // A foreign-host 404 for a TARBALL (not the hq-cli packument document) is NOT
    // the new kind — a missing tarball can be a broken published artifact, so it
    // stays Unexpected/Error rather than being downgraded to a registry
    // misconfiguration. The packument gate is what excludes it.
    let foreign_tarball = "npm error code E404\n\
            npm error 404 Not Found - GET https://npm.internal.example.com/api/npm/npm-remote/@indigoai-us/hq-cli/-/hq-cli-5.103.27.tgz - Not found";
    assert_eq!(
        classify_install_failure_with_environment(
            Some(1),
            foreign_tarball,
            None,
            false,
            &InstallEnvironment::default(),
        ),
        InstallFailureKind::Unexpected
    );
    // As is a foreign-host packument 404 for a DIFFERENT package (a transitive
    // dependency) — only the requested hq-cli packument earns the downgrade.
    let foreign_dependency = "npm error code E404\n\
            npm error 404 Not Found - GET https://npm.internal.example.com/api/npm/npm-remote/@some%2fdep - Not found";
    assert_eq!(
        classify_install_failure_with_environment(
            Some(1),
            foreign_dependency,
            None,
            false,
            &InstallEnvironment::default(),
        ),
        InstallFailureKind::Unexpected
    );
}

// --- E404 npmjs tarball serving lag (HQ-DESKTOP-6D) -------------------------

/// An npmjs tarball serving-lag E404 (HQ-DESKTOP-6D): npm's own 404 line names
/// registry.npmjs.org and the `@indigoai-us/hq-cli` tarball object for `version`,
/// plus the "not in this registry" tail. Parameterised on the line prefix so both
/// the modern `npm error` and legacy `npm err!` spellings are covered.
fn npmjs_tarball_e404_stderr(prefix: &str, version: &str) -> String {
    format!(
        "{prefix} code E404\n\
             {prefix} 404 Not Found - GET https://registry.npmjs.org/@indigoai-us/hq-cli/-/hq-cli-{version}.tgz - Not found\n\
             {prefix} 404\n\
             {prefix} 404  '@indigoai-us/hq-cli@{version}' is not in this registry."
    )
}

/// The install environment for a failure that pinned `version` — the version the
/// updater resolved from `/latest` and pinned into `install_argv`.
fn pinned_env(version: &str) -> InstallEnvironment {
    InstallEnvironment::default().with_pinned_target_version(version)
}

#[test]
fn npmjs_tarball_404_for_the_pinned_version_is_an_expected_transient() {
    // For both npm line prefixes and both toolchain sources, an npmjs tarball 404
    // for the EXACT pinned version is the mid-publish serving transient: the same
    // kind, suppressed report, transient UI copy, and a persisted bounded
    // episode marker.
    for prefix in ["npm error", "npm err!"] {
        for source in [NpmToolchainSource::Managed, NpmToolchainSource::UserPath] {
            let stderr = npmjs_tarball_e404_stderr(prefix, "5.109.6");
            let env = InstallEnvironment {
                toolchain_source: source,
                ..pinned_env("5.109.6")
            };
            assert_eq!(
                classify_install_failure_with_environment(Some(1), &stderr, None, false, &env),
                InstallFailureKind::ExpectedTransientRegistry,
                "{prefix} / {source:?}"
            );
            assert_eq!(
                install_failure_report_with_environment(Some(1), &stderr, None, false, &env),
                None,
                "{prefix} / {source:?}: a transient must not report"
            );
            let detail =
                install_failure_detail_with_environment(Some(1), &stderr, None, false, &env);
            assert!(
                detail.contains("temporarily unavailable or was mid-publish")
                    && detail.contains("retry automatically"),
                "{prefix} / {source:?}: transient UI copy: {detail}"
            );
            assert!(
                matches!(
                    report_install_failure_episode_at(
                        Some(1),
                        &stderr,
                        None,
                        false,
                        &env,
                        "5.109.6",
                        &[],
                        1_000,
                    ),
                    InstallFailureEpisode::DeferredTransient {
                        persist_keys: Some(_)
                    }
                ),
                "{prefix} / {source:?}"
            );
        }
    }
}

#[test]
fn npmjs_tarball_404_stays_loud_outside_the_pinned_window() {
    let stderr = npmjs_tarball_e404_stderr("npm error", "5.109.6");
    // No pin (default env) and a pin for a DIFFERENT version both stay a loud
    // Unexpected E404 with the attributed signature and once-per-version key.
    for env in [InstallEnvironment::default(), pinned_env("5.109.5")] {
        let kind = classify_install_failure_with_environment(Some(1), &stderr, None, false, &env);
        assert_eq!(kind, InstallFailureKind::Unexpected);
        assert_eq!(
            install_failure_signature(kind, &stderr, None),
            "E404:npmjs:tarball"
        );
        assert!(
            install_failure_report_with_environment(Some(1), &stderr, None, false, &env).is_some()
        );
        assert_eq!(
            install_failure_episode_key_with_environment(
                Some(1),
                &stderr,
                None,
                false,
                "5.109.6",
                &env,
            ),
            Some("5.109.6|unexpected|E404:npmjs:tarball".to_string())
        );
    }
    // A dependency tarball is part of the pinned install tree and may lag
    // independently on npmjs, so the bounded registry-serving rule covers it.
    let other_package = "npm error code E404\n\
            npm error 404 Not Found - GET https://registry.npmjs.org/some-dep/-/some-dep-1.2.3.tgz - Not found";
    let kind = classify_install_failure_with_environment(
        Some(1),
        other_package,
        None,
        false,
        &pinned_env("5.109.6"),
    );
    assert_eq!(kind, InstallFailureKind::ExpectedTransientRegistry);
    assert_eq!(
        install_failure_report_with_environment(
            Some(1),
            other_package,
            None,
            false,
            &pinned_env("5.109.6"),
        ),
        None,
        "a pinned dependency tarball serving lag is deferred before reporting"
    );
    // A lifecycle marker beside the same tarball 404 keeps it loud — the
    // `!has_npm_lifecycle_failure_marker` clause is load-bearing, not incidental.
    let with_lifecycle = format!(
        "{}\nnpm error command failed\nnpm error command sh -c node-gyp rebuild",
        npmjs_tarball_e404_stderr("npm error", "5.109.6")
    );
    assert_ne!(
        classify_install_failure_with_environment(
            Some(1),
            &with_lifecycle,
            None,
            false,
            &pinned_env("5.109.6"),
        ),
        InstallFailureKind::ExpectedTransientRegistry
    );
    assert!(install_failure_report_with_environment(
        Some(1),
        &with_lifecycle,
        None,
        false,
        &pinned_env("5.109.6"),
    )
    .is_some());
}

#[test]
fn e404_anti_masking_guard_survives_the_tarball_refinement() {
    // Every other E404 shape keeps its pre-HQ-DESKTOP-6D classification and
    // signature even under a matching pin — the tarball refinement is disjoint.
    // The npmjs PACKUMENT 404 (not a tarball) stays Unexpected/`E404:npmjs:packument`.
    let npmjs_packument = npmjs_e404_stderr("npm error");
    let kind = classify_install_failure_with_environment(
        Some(1),
        &npmjs_packument,
        None,
        false,
        &pinned_env("5.103.27"),
    );
    assert_eq!(kind, InstallFailureKind::Unexpected);
    assert_eq!(
        install_failure_signature(kind, &npmjs_packument, None),
        "E404:npmjs:packument"
    );
    // A foreign-host TARBALL 404 stays Unexpected/`E404:foreign:tarball`.
    let foreign_tarball = "npm error code E404\n\
            npm error 404 Not Found - GET https://npm.internal.example.com/api/npm/npm-remote/@indigoai-us/hq-cli/-/hq-cli-5.109.6.tgz - Not found";
    let kind = classify_install_failure_with_environment(
        Some(1),
        foreign_tarball,
        None,
        false,
        &pinned_env("5.109.6"),
    );
    assert_eq!(kind, InstallFailureKind::Unexpected);
    assert_eq!(
        install_failure_signature(kind, foreign_tarball, None),
        "E404:foreign:tarball"
    );
    // A foreign-host hq-cli PACKUMENT 404 stays ForeignRegistryPackageMissing.
    assert_eq!(
        classify_install_failure_with_environment(
            Some(1),
            &foreign_e404_stderr("npm error"),
            None,
            false,
            &pinned_env("5.103.27"),
        ),
        InstallFailureKind::ForeignRegistryPackageMissing
    );
    // An unparseable E404 stays Unexpected/`E404:unknown:none`.
    let unparseable = "npm error code E404\nnpm error 404 Not Found";
    let kind = classify_install_failure_with_environment(
        Some(1),
        unparseable,
        None,
        false,
        &pinned_env("5.109.6"),
    );
    assert_eq!(kind, InstallFailureKind::Unexpected);
    assert_eq!(
        install_failure_signature(kind, unparseable, None),
        "E404:unknown:none"
    );
}

#[test]
fn npmjs_tarball_transient_covers_a_prerelease_pin_and_gates_on_exact_version() {
    // A valid SemVer prerelease the updater pinned is matched too (both sides are
    // lowercased), and the legacy `npm err!` prefix is handled.
    let stderr = npmjs_tarball_e404_stderr("npm err!", "6.0.0-beta.1");
    assert_eq!(
        classify_install_failure_with_environment(
            Some(1),
            &stderr,
            None,
            false,
            &pinned_env("6.0.0-beta.1"),
        ),
        InstallFailureKind::ExpectedTransientRegistry
    );
    // The exact-version gate holds: a different version, or an empty version,
    // never matches hq-cli's own `<version>.tgz`.
    assert!(npm_404_names_hq_cli_tarball_for(&stderr, "6.0.0-beta.1"));
    assert!(!npm_404_names_hq_cli_tarball_for(&stderr, "6.0.0-beta.2"));
    assert!(!npm_404_names_hq_cli_tarball_for(&stderr, ""));
    // A trailing query on the tarball URL is dropped before the compare.
    let with_query = "npm error code E404\n\
            npm error 404 Not Found - GET https://registry.npmjs.org/@indigoai-us/hq-cli/-/hq-cli-5.109.6.tgz?cache=1 - Not found";
    assert!(npm_404_names_hq_cli_tarball_for(with_query, "5.109.6"));
}

#[test]
fn sanitized_target_version_token_preserves_valid_prereleases_but_rejects_free_text() {
    // A stable version passes through unchanged.
    assert_eq!(sanitized_target_version_token(Some("5.103.27")), "5.103.27");
    assert_eq!(
        sanitized_target_version_token(Some("AliceCase123")),
        "unknown"
    );
    assert_eq!(sanitized_target_version_token(Some("1.2")), "unknown");
    assert_eq!(sanitized_target_version_token(Some("5.335.0")), "5.335.0");
    assert_eq!(
        sanitized_target_version_token(Some("5.335.0-beta.1")),
        "5.335.0-beta.1"
    );
    // Valid SemVer prereleases / build metadata survive (the P2 fix): the
    // digits-and-dots-only sanitizer would have collapsed these to `unknown`.
    assert_eq!(
        sanitized_target_version_token(Some("v6.0.0-beta.1")),
        "6.0.0-beta.1"
    );
    assert_eq!(
        sanitized_target_version_token(Some("6.0.0-rc.2+build.5")),
        "6.0.0-rc.2+build.5"
    );
    // Anything without a digit, empty, over-long, or carrying an unsafe byte
    // (path separator, whitespace) collapses to `unknown` — no free text reaches
    // Sentry.
    assert_eq!(sanitized_target_version_token(None), "unknown");
    assert_eq!(sanitized_target_version_token(Some("")), "unknown");
    assert_eq!(sanitized_target_version_token(Some("latest")), "unknown");
    assert_eq!(
        sanitized_target_version_token(Some("../../etc/passwd")),
        "unknown"
    );
    assert_eq!(sanitized_target_version_token(Some("6.0 0")), "unknown");
    assert_eq!(
        sanitized_target_version_token(Some(&"9".repeat(49))),
        "unknown"
    );
}

#[test]
fn foreign_registry_e404_pages_once_per_version_via_its_episode_key() {
    let e404 = foreign_e404_stderr("npm error");
    let base = InstallEnvironment {
        toolchain_source: NpmToolchainSource::UserPath,
        ..Default::default()
    };
    assert_eq!(
        install_failure_episode_key_with_environment(
            Some(1),
            &e404,
            None,
            false,
            "5.103.27",
            &base,
        ),
        Some("5.103.27|foreign-registry-404|packument".to_string())
    );
    // A managed-retry event mints a distinct key, so it never collides with the
    // user-path predecessor.
    let mut managed = base.clone();
    managed.managed_toolchain_retry = true;
    assert_eq!(
        install_failure_episode_key_with_environment(
            Some(1),
            &e404,
            None,
            false,
            "5.103.27",
            &managed,
        ),
        Some("5.103.27|foreign-registry-404|packument|managed".to_string())
    );
    // A newer published version resets the bound (different `latest|` prefix).
    assert_eq!(
        install_failure_episode_key_with_environment(
            Some(1),
            &e404,
            None,
            false,
            "5.103.28",
            &base,
        ),
        Some("5.103.28|foreign-registry-404|packument".to_string())
    );
}

#[test]
fn e404_signature_and_episode_key_are_produced_by_the_same_helper() {
    // For every E404 shape the Sentry signature and the repeat-guard key must
    // name the SAME origin and resource — both flow through `e404_discriminator`,
    // so they can never disagree.
    for e404 in [
        foreign_e404_stderr("npm error"),
        foreign_e404_stderr("npm err!"),
        npmjs_e404_stderr("npm error"),
        "npm error code E404\nnpm error 404 Not Found".to_string(),
    ] {
        let kind = classify_install_failure_with_environment(
            Some(1),
            &e404,
            None,
            false,
            &InstallEnvironment::default(),
        );
        let signature = install_failure_signature(kind, &e404, None);
        let key = install_failure_episode_key_with_environment(
            Some(1),
            &e404,
            None,
            false,
            "5.103.27",
            &InstallEnvironment::default(),
        )
        .expect("every E404 mints an episode key");
        let (origin, resource) = e404_discriminator(&e404);
        assert!(
            signature.contains(resource.tag_value()) && key.contains(resource.tag_value()),
            "resource disagrees between group and key: sig={signature} key={key}"
        );
        assert!(
            signature.contains(origin.tag_value()) && key.contains(origin.tag_value()),
            "origin disagrees between group and key: sig={signature} key={key}"
        );
    }
}

#[test]
fn target_version_and_spec_kind_are_never_grouping_components() {
    // Pinning the target version must not move an event between Sentry issues:
    // neither the signature nor the repeat-guard key may read it. Two envs that
    // differ ONLY in target_version/requested_spec_kind group identically.
    let e404 = foreign_e404_stderr("npm error");
    let base = InstallEnvironment {
        toolchain_source: NpmToolchainSource::UserPath,
        ..Default::default()
    };
    let pinned = base.clone().with_pinned_target_version("5.103.27");
    let kind_base = classify_install_failure_with_environment(Some(1), &e404, None, false, &base);
    let kind_pinned =
        classify_install_failure_with_environment(Some(1), &e404, None, false, &pinned);
    assert_eq!(kind_base, kind_pinned);
    assert_eq!(
        install_failure_signature_with_environment(kind_base, &e404, None, &base),
        install_failure_signature_with_environment(kind_pinned, &e404, None, &pinned),
        "target_version must never change the install-failure signature"
    );
    assert_eq!(
        install_failure_episode_key_with_environment(
            Some(1),
            &e404,
            None,
            false,
            "5.103.27",
            &base,
        ),
        install_failure_episode_key_with_environment(
            Some(1),
            &e404,
            None,
            false,
            "5.103.27",
            &pinned,
        ),
        "target_version must never change the repeat-guard key"
    );
    // Non-vacuous: the shared key is genuinely minted.
    assert!(install_failure_episode_key_with_environment(
        Some(1),
        &e404,
        None,
        false,
        "5.103.27",
        &base,
    )
    .is_some());
}

#[test]
fn foreign_registry_detail_names_the_condition_without_leaking_host_or_stderr() {
    let e404 = foreign_e404_stderr("npm error");
    let detail = install_failure_detail_with_environment(
        Some(1),
        &e404,
        None,
        false,
        &InstallEnvironment::default(),
    );
    assert!(
        detail.contains("registry that does not carry hq"),
        "detail must name the condition: {detail}"
    );
    assert!(
        detail.contains("terminal"),
        "detail must keep the copy-the-command escape hatch: {detail}"
    );
    for leak in [
        "npm.internal.example.com",
        "npm error",
        "%2f",
        "GET http",
        "5.103.27",
    ] {
        assert!(!detail.contains(leak), "detail leaked {leak:?}: {detail}");
    }
}

#[test]
fn with_pinned_target_version_records_the_exact_pinned_spec() {
    let env = InstallEnvironment::default().with_pinned_target_version("5.103.27");
    assert_eq!(env.target_version.as_deref(), Some("5.103.27"));
    assert_eq!(env.requested_spec_kind, RequestedSpecKind::PinnedVersion);
}

/// The floor accelerates only a version the app can actually read. A
/// missing CLI and an unreadable binary keep their existing arms and the
/// scheduled cadence — the floor must never turn them into a launch-time
/// install storm.
#[test]
fn floor_only_applies_to_a_readable_version() {
    assert!(cli_below_floor_of(Some("5.103.25"), "5.103.26"));
    assert!(!cli_below_floor_of(Some("5.103.26"), "5.103.26"));
    assert!(!cli_below_floor_of(Some("5.108.2"), "5.103.26"));
    assert!(!cli_below_floor_of(None, "5.103.26"));
}

#[test]
fn floor_compares_numerically_not_lexically() {
    // "5.9.0" > "5.10.0" as strings; the floor must not be fooled either.
    assert!(cli_below_floor_of(Some("5.9.0"), "5.10.0"));
    assert!(!cli_below_floor_of(Some("5.10.0"), "5.9.0"));
    // A pre-release of the floor version compares as its core triple.
    assert!(!cli_below_floor_of(Some("5.103.26-beta.1"), "5.103.26"));
}

#[test]
fn launch_check_repairs_now_only_below_the_floor() {
    assert_eq!(
        launch_cli_check_with_floor(Some("5.100.0"), "5.103.26"),
        LaunchCliCheck::RepairNow {
            local: "5.100.0".to_string()
        }
    );
    assert_eq!(
        launch_cli_check_with_floor(Some("5.103.26"), "5.103.26"),
        LaunchCliCheck::Scheduled
    );
    assert_eq!(
        launch_cli_check_with_floor(Some("5.110.0"), "5.103.26"),
        LaunchCliCheck::Scheduled
    );
    assert_eq!(
        launch_cli_check_with_floor(None, "5.103.26"),
        LaunchCliCheck::Scheduled
    );
}

#[test]
fn launch_check_uses_the_shipped_floor() {
    assert_eq!(
        launch_cli_check(Some("0.0.1")),
        LaunchCliCheck::RepairNow {
            local: "0.0.1".to_string()
        }
    );
    assert_eq!(
        launch_cli_check(Some(HQ_CLI_MIN_VERSION)),
        LaunchCliCheck::Scheduled
    );
    assert!(cli_below_floor(Some("0.0.1")));
    assert!(!cli_below_floor(Some(HQ_CLI_MIN_VERSION)));
}

/// An ordinary upgrade honours the opt-out; a floor repair does not.
#[test]
fn floor_repair_bypasses_the_auto_update_opt_out() {
    assert!(auto_install_allowed(true, false));
    assert!(!auto_install_allowed(false, false));
    assert!(auto_install_allowed(false, true));
    assert!(auto_install_allowed(true, true));
}

/// The shipped floor must be a plain `MAJOR.MINOR.PATCH` (the hq-core hook
/// parses it the same way) and must not sit below the npx self-heal range
/// the resolver pins — otherwise a CLI the resolver already accepts could
/// be flagged for repair, or vice versa.
#[test]
fn shipped_floor_is_a_plain_triple_at_or_above_the_resolver_range() {
    let parts: Vec<&str> = HQ_CLI_MIN_VERSION.split('.').collect();
    assert_eq!(parts.len(), 3, "floor must be MAJOR.MINOR.PATCH");
    assert!(parts.iter().all(|p| p.parse::<u64>().is_ok()));
    let resolver_floor = crate::hq_resolver::HQ_CLI_NPM_RANGE
        .trim_start_matches('^')
        .trim_start_matches('~');
    assert_ne!(
        cmp_semver(HQ_CLI_MIN_VERSION, resolver_floor),
        std::cmp::Ordering::Less,
        "HQ_CLI_MIN_VERSION ({HQ_CLI_MIN_VERSION}) is below the resolver's npx range floor ({resolver_floor})"
    );
}

#[test]
fn node_crash_kinds_require_known_exit_and_stable_runtime_signature() {
    let cases = [
        (
            Some(134),
            "FATAL ERROR: JavaScript heap out of memory",
            "v8_heap_oom",
            "javascript_heap_oom",
        ),
        (
            Some(134),
            "FATAL ERROR: v8 internal failure",
            "v8_fatal",
            "fatal_error_marker",
        ),
        (
            Some(134),
            "Assertion failed: node invariant",
            "native_assertion",
            "assertion_failed",
        ),
        (
            Some(-2_147_483_645),
            "Native stack trace from node::",
            "breakpoint",
            "node_native_trace",
        ),
        (
            Some(-1_073_741_819),
            "node::OnFatalError Native stack trace",
            "access_violation",
            "node_native_trace",
        ),
        (
            Some(-1_073_740_791),
            "Native stack trace from node::",
            "stack_buffer_overrun",
            "node_native_trace",
        ),
        (Some(-1), "node::OnFatalError", "abort", "node_native_trace"),
    ];
    for (exit_code, stderr, expected_kind, expected_evidence) in cases {
        let actual = node_crash_kind(exit_code, stderr);
        assert_eq!(actual.kind.tag_value(), expected_kind);
        assert_eq!(actual.evidence, expected_evidence);
    }
    let empty_access_violation = node_crash_kind(Some(-1_073_741_819), "");
    assert_eq!(empty_access_violation.kind.tag_value(), "access_violation");
    assert_eq!(
        empty_access_violation.evidence,
        "exit_status_access_violation"
    );
    // The command boundary decodes captured stderr lossily and trims it
    // before calling the core classifier; stable ASCII crash markers survive
    // that production transform.
    let captured = String::from_utf8_lossy(b"\r\nFATAL ERROR: JavaScript heap out of memory\r\n")
        .trim()
        .to_string();
    assert_eq!(
        node_crash_kind(Some(134), &captured).kind.tag_value(),
        "v8_heap_oom"
    );

    assert_eq!(
        node_crash_kind(Some(134), "npm error code E404")
            .kind
            .tag_value(),
        "none"
    );
    assert_eq!(
        node_crash_kind(
            Some(134),
            "npm error command failed\nFATAL ERROR: JavaScript heap out of memory"
        )
        .kind
        .tag_value(),
        "none"
    );
    assert_eq!(
        node_crash_kind(Some(134), "echoed input: FATAL ERROR: failure")
            .kind
            .tag_value(),
        "none"
    );
    assert_eq!(
        node_crash_kind(Some(7), "Native stack trace")
            .kind
            .tag_value(),
        "none"
    );
    assert_eq!(
        node_crash_kind(Some(-1), "unclassified process failure")
            .kind
            .tag_value(),
        "none"
    );
    assert_eq!(
        node_crash_kind(None, "FATAL ERROR: failure")
            .kind
            .tag_value(),
        "none"
    );
}

#[test]
fn managed_access_violation_with_failed_version_probes_is_attributed_and_reported() {
    let env = InstallEnvironment {
        node_version: Some("v22.12.0".to_string()),
        node_abi: None,
        npm_version: None,
        toolchain_source: NpmToolchainSource::Managed,
        ..InstallEnvironment::default()
    };
    let kind =
        classify_install_failure_with_environment(Some(-1_073_741_819), "", None, false, &env);
    assert_eq!(kind, InstallFailureKind::NativeCrash);
    assert_eq!(kind.fingerprint_component(), "native_crash");
    assert_eq!(
        install_failure_report_with_environment(Some(-1_073_741_819), "", None, false, &env,),
        Some("[hq-cli-update] install failed (node-crash:access_violation)".to_string())
    );
    assert_eq!(
        install_failure_detail_with_environment(
            Some(-1_073_741_819),
            "",
            None,
            false,
            &env,
        ),
        "The Node.js process used to install hq crashed before npm could report an error. HQ's automatic managed-runtime repair and retry did not complete the update. Run the copied command in a terminal if the update still fails."
    );
    assert_eq!(
        install_failure_episode_key_with_environment(
            Some(-1_073_741_819),
            "",
            None,
            false,
            "5.343.0",
            &env,
        ),
        Some("5.343.0|node-crash|access_violation".to_string())
    );

    let events = sentry::test::with_captured_events(|| {
        report_install_failure_with_environment(Some(-1_073_741_819), "", None, false, &env);
    });
    assert_eq!(events.len(), 1, "the native crash remains reportable");
    assert_eq!(events[0].tags["install_failure_kind"], "native_crash");
    assert_eq!(events[0].tags["node_crash_kind"], "access_violation");

    let user_path = InstallEnvironment {
        toolchain_source: NpmToolchainSource::UserPath,
        ..env.clone()
    };
    assert_eq!(
        classify_install_failure_with_environment(
            Some(-1_073_741_819),
            "",
            None,
            false,
            &user_path,
        ),
        InstallFailureKind::Unexpected,
        "only a crash of HQ's managed toolchain uses this refinement"
    );
    let healthy_probes = InstallEnvironment {
        node_abi: Some("127".to_string()),
        npm_version: Some("10.9.2".to_string()),
        ..env
    };
    assert_eq!(
        classify_install_failure_with_environment(
            Some(-1_073_741_819),
            "",
            None,
            false,
            &healthy_probes,
        ),
        InstallFailureKind::Unexpected,
        "successful ABI and npm probes do not imply a corrupt managed toolchain"
    );
    let posix_abort = InstallEnvironment {
        node_abi: None,
        npm_version: None,
        ..healthy_probes
    };
    assert_eq!(
        classify_install_failure_with_environment(Some(134), "", None, false, &posix_abort,),
        InstallFailureKind::Unexpected,
        "POSIX signal-style exits do not use the Windows forced-repair classification"
    );
}

#[test]
fn managed_access_violation_uses_actual_stderr_when_stdout_has_output() {
    let env = InstallEnvironment {
        node_version: Some("v22.12.0".to_string()),
        node_abi: None,
        npm_version: None,
        toolchain_source: NpmToolchainSource::Managed,
        ..InstallEnvironment::default()
    };
    assert_eq!(
        classify_install_failure_with_environment_and_stderr(
            Some(-1_073_741_819),
            "node stdout emitted before native exit",
            "",
            None,
            false,
            &env,
        ),
        InstallFailureKind::NativeCrash,
        "stdout fallback must not hide an empty-stderr Windows access violation"
    );
}

#[test]
fn crash_signature_splits_only_classified_non_npm_failures() {
    let env = reopen_env();
    let oom = install_failure_signature_with_exit_code(
        Some(134),
        InstallFailureKind::Unexpected,
        "FATAL ERROR: JavaScript heap out of memory",
        None,
        &env,
    );
    assert_eq!(oom, "node-crash:v8_heap_oom");
    assert_eq!(
        install_failure_episode_key_with_environment(
            Some(134),
            "FATAL ERROR: JavaScript heap out of memory",
            None,
            false,
            "5.342.18",
            &env,
        )
        .as_deref(),
        Some("5.342.18|node-crash|v8_heap_oom")
    );
    assert_eq!(
        install_failure_report_with_environment(
            Some(134),
            "FATAL ERROR: JavaScript heap out of memory",
            None,
            false,
            &env,
        )
        .as_deref(),
        Some("[hq-cli-update] install failed (node-crash:v8_heap_oom)")
    );

    assert_eq!(
        install_failure_signature_with_exit_code(
            Some(-1_073_741_819),
            InstallFailureKind::Unexpected,
            "",
            None,
            &env,
        ),
        "node-crash:access_violation"
    );
    assert_eq!(
        install_failure_episode_key_with_environment(
            Some(-1_073_741_819),
            "",
            None,
            false,
            "5.342.18",
            &env,
        )
        .as_deref(),
        Some("5.342.18|node-crash|access_violation")
    );
    assert_eq!(
        install_failure_report_with_environment(Some(-1_073_741_819), "", None, false, &env,)
            .as_deref(),
        Some("[hq-cli-update] install failed (node-crash:access_violation)")
    );

    let npm_error = "npm error code ENOTEMPTY";
    assert_eq!(
        install_failure_signature_with_exit_code(
            Some(134),
            InstallFailureKind::Unexpected,
            npm_error,
            None,
            &env,
        ),
        "ENOTEMPTY:unknown:none"
    );
    assert_eq!(
        install_failure_signature_with_exit_code(
            Some(134),
            InstallFailureKind::Unexpected,
            "unclassified process failure",
            None,
            &env,
        ),
        "unattributed:non-npm:other"
    );
    assert_eq!(
        install_failure_episode_key_with_environment(
            Some(134),
            "unclassified process failure",
            None,
            false,
            "5.342.18",
            &env,
        )
        .as_deref(),
        Some("5.342.18|unattributed|non-npm|other")
    );
}

#[test]
fn unattributed_profile_ignores_npm_markers_stays_closed_and_path_free() {
    // CRLF classifies identically to LF (the trailing carriage return is
    // trimmed), so a Windows machine's shape is stable across occurrences.
    assert_eq!(
        unattributed_stderr_profile("SyntaxError: boom\r\nat run (x)").dominant_shape,
        unattributed_stderr_profile("SyntaxError: boom\nat run (x)").dominant_shape
    );
    // npm-marker lines are skipped when a non-marker line remains, so the profile
    // describes what npm did NOT characterise.
    let mixed = "npm error code\nActually failed writing C:\\Users\\me\\hq at C:\\hq";
    let profile = unattributed_stderr_profile(mixed);
    assert_eq!(profile.origin, "npm-logger");
    assert_eq!(profile.dominant_shape, "path_like");
    // A stderr full of user paths yields path_like, and NO path substring reaches
    // the dominant shape or the bounded shapes render.
    let paths_only =
        "C:\\Users\\alice\\secret\\a\r\n/home/alice/secret/b\r\nC:\\Users\\alice\\secret\\c";
    let profile = unattributed_stderr_profile(paths_only);
    assert_eq!(profile.dominant_shape, "path_like");
    assert_eq!(profile.shapes_tag, "path_like:3");
    for token in ["alice", "secret", "C:\\", "/home/"] {
        assert!(!profile.dominant_shape.contains(token));
        assert!(
            !profile.shapes_tag.contains(token),
            "shapes tag leaked {token}: {}",
            profile.shapes_tag
        );
    }
    // Lossily-decoded UTF-16 (replacement chars) must not panic and must still
    // classify to a closed vocabulary token.
    let lossy = unattributed_stderr_profile("\u{FFFD}\u{FFFD} npm\u{FFFD} died");
    assert!(UnmatchedStderrShape::ALL
        .iter()
        .any(|shape| shape.as_str() == lossy.dominant_shape));
}

#[test]
fn empty_and_discriminating_failures_keep_their_pre_fix_envelope() {
    let env = reopen_env();
    // Empty stderr stays the byte-identical shapeless envelope and mints no key.
    assert_eq!(
        install_failure_signature_with_environment(InstallFailureKind::Unexpected, "", None, &env),
        "none:unknown:none"
    );
    assert_eq!(
        install_failure_episode_key_with_environment(Some(1), "", None, false, "5.103.23", &env),
        None
    );
    // A discriminating Unexpected keeps its existing signature untouched.
    let enotempty = "npm error code ENOTEMPTY\n\
                         npm error syscall rename\n\
                         npm error path /usr/local/lib/node_modules/@indigoai-us/hq-cli";
    assert_eq!(
        install_failure_signature_with_environment(
            InstallFailureKind::Unexpected,
            enotempty,
            None,
            &env
        ),
        "ENOTEMPTY:rename:global-lib-node-modules"
    );
    // A lifecycle failure whose numeric build-script status collapsed to the empty
    // signature is NOT the reopen's "npm reported nothing" subclass — npm DID
    // report a lifecycle failure — so it keeps its byte-identical `none:unknown:none`
    // envelope and mints no bounded key.
    let lifecycle_numeric = "npm error code 1\n\
                                 npm error command failed\n\
                                 npm error command sh -c node postinstall.js";
    assert!(
        install_failure_unattributed_profile(
            InstallFailureKind::Unexpected,
            lifecycle_numeric,
            None
        )
        .is_none(),
        "a lifecycle-failed numeric-code failure must not be the unattributed subclass"
    );
    assert_eq!(
        install_failure_signature_with_environment(
            InstallFailureKind::Unexpected,
            lifecycle_numeric,
            None,
            &env
        ),
        "none:unknown:none"
    );
    assert_eq!(
        install_failure_episode_key_with_environment(
            Some(1),
            lifecycle_numeric,
            None,
            false,
            "5.103.23",
            &env
        ),
        None
    );
    // No non-Unexpected kind is ever the unattributed subclass, so every
    // expected/lifecycle/unsupported signature and key is unchanged.
    for kind in [
        InstallFailureKind::ExpectedPrefixPermission,
        InstallFailureKind::ExpectedDiskFull,
        InstallFailureKind::UnexpectedLifecycle,
        InstallFailureKind::UnsupportedNode,
    ] {
        assert!(
            install_failure_unattributed_profile(kind, "boom without markers", None).is_none(),
            "kind {kind:?} must never be the unattributed subclass"
        );
    }
}
