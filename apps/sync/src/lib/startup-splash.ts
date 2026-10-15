/**
 * What the `main` window paints while the startup auth check is still running.
 *
 * On a first launch, native setup hands `main` to the welcome flow as a fully
 * transparent window at heads-up card size (US-004). A small spinner on a
 * transparent window reads as no window at all, and the startup check plus the
 * welcome flow's first paint can take several seconds on a cold machine. So the
 * welcome window gets an opaque splash (HQ mark and a progress line) from the
 * first frame. The splash is card-sized, so it never paints full-screen. The
 * compact popover keeps its spinner.
 */
export type StartupSplash = 'none' | 'spinner' | 'welcome-splash';

export function startupSplashFor(input: {
  startupResolved: boolean;
  welcomeWindowActive: boolean;
}): StartupSplash {
  if (input.startupResolved) return 'none';
  return input.welcomeWindowActive ? 'welcome-splash' : 'spinner';
}
