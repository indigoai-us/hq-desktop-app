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

/**
 * `mountHqWork` may return a promise so the caller can `import()` the embedded
 * shell lazily. A static import would pull the whole `@hq/ui` DesktopApp graph
 * into the desktop-alt entry chunk, making the default flag-off population pay
 * its download, parse, and memory cost for code that is never mounted.
 *
 * The flag invoke resolves in milliseconds; the HQ Work chunk parses in
 * seconds. We do **not** start that import in parallel with `getHandoff()` —
 * the flag is default-off, and overlapping would charge flag-off users for a
 * bundle they never mount. `mountHqWork` starts the import as soon as the
 * flag is known truthy (no other awaits in between).
 */
export async function bootDesktopAltWindow(deps: {
  getHandoff: () => Promise<boolean>;
  mountLegacy: () => void;
  mountHqWork: () => void | Promise<void>;
}): Promise<DesktopAltShell> {
  const shell = await resolveDesktopAltShell(deps.getHandoff);
  if (shell === 'hq-work') {
    await deps.mountHqWork();
  } else {
    deps.mountLegacy();
  }
  return shell;
}
