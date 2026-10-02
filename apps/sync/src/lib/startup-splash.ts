/**
 * What the `main` window paints while the startup auth check is still running.
 *
 * On a first launch, native setup hands `main` to the welcome flow: it fills
 * the work area with a fully transparent window. A small spinner on a
 * transparent window reads as no window at all, and the startup check plus the
 * welcome flow's first paint can take several seconds on a cold machine. So the
 * welcome window gets an opaque splash (HQ mark and a progress line) from the
 * first frame. The compact popover keeps its spinner.
 */
export type StartupSplash = 'none' | 'spinner' | 'welcome-splash';

export function startupSplashFor(input: {
  startupResolved: boolean;
  welcomeWindowActive: boolean;
}): StartupSplash {
  if (input.startupResolved) return 'none';
  return input.welcomeWindowActive ? 'welcome-splash' : 'spinner';
}
