import { getCurrentWindow } from '@tauri-apps/api/window';
import { setTheme } from '@tauri-apps/api/app';
import { mount } from 'svelte';
// Geist Sans is loaded by the shared design-system stylesheet. Keep Geist Mono
// for data — IDs, paths, counts, versions.
import '@fontsource-variable/geist-mono/wght.css';
import '../styles/design-system.css';
import GlobalErrorBoundary from '../components/GlobalErrorBoundary.svelte';
import { installDesktopZoom } from '../lib/desktopZoom';
import { installAppearancePreferences } from '../lib/appearancePreferences';
import { getHqWorkHandoff } from '../lib/hq-work';
import { bootDesktopAltWindow } from './boot';
import { dismissBootLoader } from './boot-loader';
import DesktopApp from './DesktopApp.svelte';

const windowLabel = getCurrentWindow().label;
document.documentElement.dataset.window = windowLabel;
// Platform marker before first paint so title-bar / chrome CSS can drop the
// macOS traffic-light inset on Windows (native decorated title bar + Snap
// Layouts; HQ toolbar sits below — US-003).
const isWindows = /Windows/i.test(navigator.userAgent);
document.documentElement.dataset.platform = isWindows ? 'windows' : 'other';
installDesktopZoom();
installAppearancePreferences({
  applyNativeTheme: (theme) => setTheme(theme),
});

const target = document.getElementById('desktop-alt');

if (!target) {
  throw new Error('Missing desktop-alt mount target');
}

// No top-level await: vite `target: safari13` cannot transpile TLA in this entry.
const app = bootDesktopAltWindow({
  getHandoff: () => getHqWorkHandoff(),
  mountLegacy: () => {
    mount(GlobalErrorBoundary, {
      target,
      props: { component: DesktopApp, windowLabel },
    });
    // Legacy paints synchronously; drop the HTML overlay immediately.
    dismissBootLoader();
  },
  // Dynamic import: the embedded shell pulls the entire @hq/ui DesktopApp
  // graph, and the flag is default-off. Loading it statically would charge
  // every legacy user for a bundle they never mount. Kick off as soon as
  // getHandoff() is truthy — no other awaits precede this import.
  mountHqWork: async () => {
    const { default: HqWorkWorkShell } = await import(
      './HqWorkWorkShell.svelte'
    );
    mount(GlobalErrorBoundary, {
      target,
      props: { component: HqWorkWorkShell, windowLabel },
    });
    // Overlay stays until HqWorkWorkShell identity-settles and paints.
  },
}).catch((error) => {
  // Never leave the user behind a shimmer over a broken window.
  dismissBootLoader();
  throw error;
});

export default app;
