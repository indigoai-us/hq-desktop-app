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

  it('uses the existing installer only when the current probe cannot run rsync', () => {
    expect(installDeps).toContain('|| check_dep_impl("rsync", None).installed');
    expect(installDeps).toContain(
      '|| async { install_rsync_with_progress(|_| {}).await.map(|_| ()) },',
    );
    expect(installDeps).toContain('Ok(()) if is_resolvable() => RsyncRescueProvisioning::Provisioned');
    expect(installDeps).toContain('Err(reason) => RsyncRescueProvisioning::ProvisioningFailed(reason)');
    expect(coreUpdate).toContain('continuing with current rsync resolution');
  });
});
