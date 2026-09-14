/**
 * Desktop-alt boot. The @hq/ui workspace is the only shell — the retired
 * hqWorkHandoff flag and email-domain cohort no longer select a UI.
 */

export async function bootDesktopAltWindow(deps: {
  mountHqWork: () => void | Promise<void>;
}): Promise<void> {
  await deps.mountHqWork();
}
