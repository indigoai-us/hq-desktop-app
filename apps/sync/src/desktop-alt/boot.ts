/**
 * Desktop-alt boot. The @hq/ui workspace is the only shell — the retired
 * hqWorkHandoff flag and email-domain cohort no longer select a UI.
 */

export type DesktopAltShell = 'hq-work';

export async function resolveDesktopAltShell(
  _getHandoff?: () => Promise<boolean>,
): Promise<DesktopAltShell> {
  return 'hq-work';
}

export async function bootDesktopAltWindow(deps: {
  getHandoff?: () => Promise<boolean>;
  mountLegacy?: () => void;
  mountHqWork: () => void | Promise<void>;
}): Promise<DesktopAltShell> {
  await deps.mountHqWork();
  return 'hq-work';
}
