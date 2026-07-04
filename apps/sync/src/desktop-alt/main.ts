import { getCurrentWindow } from '@tauri-apps/api/window';
import { mount } from 'svelte';
// Geist Sans is loaded by the shared design-system stylesheet. Keep Geist Mono
// for data — IDs, paths, counts, versions.
import '@fontsource-variable/geist-mono/wght.css';
import '../styles/design-system.css';
import DesktopApp from './DesktopApp.svelte';

document.documentElement.dataset.window = getCurrentWindow().label;

const target = document.getElementById('desktop-alt');

if (!target) {
  throw new Error('Missing desktop-alt mount target');
}

const app = mount(DesktopApp, { target });

export default app;
