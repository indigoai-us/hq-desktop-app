import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

const coreUpdate = readRepoFile('src-tauri/src/commands/hq_core_update.rs');
const installDeps = readRepoFile('src-tauri/src/commands/install_deps.rs');

describe('Windows Core-update rsync provisioning', () => {
  it('runs the best-effort preflight before constructing the rescue command', () => {
    const preflight = '#[cfg(windows)]\n    ensure_managed_rsync_for_core_update_rescue().await;';
    expect(coreUpdate).toContain(preflight);
    expect(coreUpdate.indexOf(preflight)).toBeLessThan(
      coreUpdate.indexOf('let (mut cmd, npx_resolution) = core_update_rescue_command();'),
    );
  });

  it('leaves non-Windows behavior untouched', () => {
    expect(coreUpdate).toContain('#[cfg(windows)]\nasync fn ensure_managed_rsync_for_core_update_rescue()');
    expect(installDeps).toContain('#[cfg(windows)]\npub(crate) async fn ensure_rsync_for_core_update_rescue()');
  });

  it('uses the existing installer when the rescue needs rsync or its path shim', () => {
    expect(installDeps).toContain('|| check_dep_impl("rsync", None).installed');
    expect(installDeps).toContain('rsync_shim_is_present,');
    expect(installDeps).toContain(
      'install_rsync_with_progress(|message| {',
    );
    expect(installDeps).toContain('provision_rsync_for_core_update_within_deadline,');
    expect(installDeps).toContain('CORE_UPDATE_RSYNC_PROVISION_TIMEOUT,');
    expect(installDeps).toContain(
      'if is_resolvable() && has_shim() =>',
    );
    expect(installDeps).toContain('RsyncRescueProvisioning::ShimRefreshed');
    expect(installDeps).toContain('RsyncRescueProvisioning::ProvisioningTimedOut');
    expect(installDeps).toContain('const CORE_UPDATE_RSYNC_PROVISION_TIMEOUT: Duration = Duration::from_secs(45);');
    expect(coreUpdate).toContain('rsync was resolvable but its path shim was refreshed before rescue');
    expect(coreUpdate).toContain('continuing with current rsync resolution');
  });
});
