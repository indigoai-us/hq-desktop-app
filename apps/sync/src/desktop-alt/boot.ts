/**
 * Flag-gated desktop-alt boot (US-103).
 *
 * Flag on → embedded @hq/ui DesktopApp. Flag off (default) → legacy
 * desktop-alt DesktopApp.svelte. The Tauri window is the same either way.
 */

export type DesktopAltShell = 'legacy' | 'hq-work';

export async function resolveDesktopAltShell(
  getHandoff: () => Promise<boolean>,
): Promise<DesktopAltShell> {
  try {
    return (await getHandoff()) === true ? 'hq-work' : 'legacy';
  } catch {
    return 'legacy';
  }
}

export async function bootDesktopAltWindow(deps: {
  getHandoff: () => Promise<boolean>;
  mountLegacy: () => void;
  mountHqWork: () => void;
}): Promise<DesktopAltShell> {
  const shell = await resolveDesktopAltShell(deps.getHandoff);
  if (shell === 'hq-work') {
    deps.mountHqWork();
  } else {
    deps.mountLegacy();
  }
  return shell;
}
