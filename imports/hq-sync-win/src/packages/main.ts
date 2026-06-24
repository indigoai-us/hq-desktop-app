import { getCurrentWindow } from '@tauri-apps/api/window';
import { mount } from 'svelte';
// Share the popover's design tokens, transparent root background, and
// Fluent thin scrollbars with the Packages window — same rationale as
// src/main.ts. Without it the Packages webview falls back to native
// Win11 16 px chunky scrollbars and a solid black backing.
import '../styles/popover.css';
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

// Tag host OS so platform-specific CSS rules in popover.css can branch
// (e.g. Windows-only inset shadow for the popover edge). Mirrors the
// same block in src/main.ts.
{
  const ua = navigator.userAgent.toLowerCase();
  document.documentElement.dataset.os = ua.includes('windows')
    ? 'windows'
    : ua.includes('mac')
      ? 'macos'
      : 'other';
}

const target = document.getElementById('packages');

if (!target) {
  throw new Error('Missing packages mount target');
}

const app = mount(PackagesApp, { target });

export default app;
