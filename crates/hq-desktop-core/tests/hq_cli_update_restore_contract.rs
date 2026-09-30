#[test]
fn updater_snapshots_the_working_cli_and_restores_non_convergent_installs() {
    let app_cli = include_str!("../../../apps/sync/src-tauri/src/commands/hq_cli_update.rs");
    let updater = app_cli
        .split("async fn install_hq_cli_update_once")
        .nth(1)
        .unwrap()
        .split("async fn capture_working_cli_snapshot")
        .next()
        .unwrap();

    assert!(updater.contains("capture_working_cli_snapshot"));
    assert!(updater.contains("restore_if_install_not_converged"));
}
