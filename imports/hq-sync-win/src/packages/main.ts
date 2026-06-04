import { getCurrentWindow } from '@tauri-apps/api/window';
import { mount } from 'svelte';
import PackagesApp from './PackagesApp.svelte';

// Tag the document AND body with the window label so PackagesApp's
// `:global(html[data-window='packages'], body[data-window='packages'])` rule
// can keep the chrome transparent — letting the Rust-side Mica/Acrylic
// vibrancy (apply_windows_vibrancy) show through, the same scoping convention
// the other secondary windows use (NotificationHistory / MeetingsWindow). This
// is the dedicated packages entry, so the label is always 'packages'.
const label = getCurrentWindow().label;
document.documentElement.dataset.window = label;
document.body.dataset.window = label;

const target = document.getElementById('packages');

if (!target) {
  throw new Error('Missing packages mount target');
}

const app = mount(PackagesApp, { target });

export default app;
