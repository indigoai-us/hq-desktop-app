import { getCurrentWindow } from '@tauri-apps/api/window';
import { setTheme } from '@tauri-apps/api/app';
import { mount } from 'svelte';
// Geist Sans is loaded by the shared design-system stylesheet. Keep Geist Mono
// for data — IDs, paths, counts, versions.
import '@fontsource-variable/geist-mono/wght.css';
import '../styles/design-system.css';
import GlobalErrorBoundary from '../components/GlobalErrorBoundary.svelte';
import { installDesktopZoom } from '../lib/desktopZoom';
import {
  applyAppearancePreferences,
  installAppearancePreferences,
  readBrowserAppearancePreferences,
} from '../lib/appearancePreferences';
import DesktopApp from './DesktopApp.svelte';

const windowLabel = getCurrentWindow().label;
document.documentElement.dataset.window = windowLabel;
// Platform marker before first paint so title-bar / chrome CSS can drop the
// macOS traffic-light inset on Windows (native decorated title bar + Snap
// Layouts; HQ toolbar sits below — US-003).
const isWindows = /Windows/i.test(navigator.userAgent);
document.documentElement.dataset.platform = isWindows ? 'windows' : 'other';

// D-09: apply persisted theme synchronously on document root BEFORE mount so
// the first paint (including titlebar) matches light/dark preference.
applyAppearancePreferences(document.documentElement, readBrowserAppearancePreferences());

installDesktopZoom();
installAppearancePreferences({
  applyNativeTheme: (theme) => setTheme(theme),
});

const target = document.getElementById('desktop-alt');

if (!target) {
  throw new Error('Missing desktop-alt mount target');
}

const app = mount(GlobalErrorBoundary, {
  target,
  props: { component: DesktopApp, windowLabel },
});

export default app;
