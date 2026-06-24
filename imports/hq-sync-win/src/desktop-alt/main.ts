import { getCurrentWindow } from '@tauri-apps/api/window';
import { mount } from 'svelte';
import DesktopApp from './DesktopApp.svelte';

// Tag the document with the window label so the plain global stylesheet
// (styles/desktop-alt.css) can scope its theme to html[data-window='desktop-alt'].
// This is the dedicated desktop-alt entry, so the label is always 'desktop-alt'.
document.documentElement.dataset.window = getCurrentWindow().label;

const target = document.getElementById('desktop-alt');

if (!target) {
  throw new Error('Missing desktop-alt mount target');
}

const app = mount(DesktopApp, { target });

export default app;
