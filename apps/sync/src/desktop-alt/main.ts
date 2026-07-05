import { getCurrentWindow } from '@tauri-apps/api/window';
import { mount } from 'svelte';
// Geist Sans is loaded by the shared design-system stylesheet. Keep Geist Mono
// for data — IDs, paths, counts, versions.
import '@fontsource-variable/geist-mono/wght.css';
import '../styles/design-system.css';
import GlobalErrorBoundary from '../components/GlobalErrorBoundary.svelte';
import DesktopApp from './DesktopApp.svelte';

const windowLabel = getCurrentWindow().label;
document.documentElement.dataset.window = windowLabel;

const target = document.getElementById('desktop-alt');

if (!target) {
  throw new Error('Missing desktop-alt mount target');
}

const app = mount(GlobalErrorBoundary, {
  target,
  props: { component: DesktopApp, windowLabel },
});

export default app;
