import * as Sentry from "@sentry/svelte";
import './styles/design-system.css';
import App from './App.svelte';
import MeetingsWindow from './components/MeetingsWindow.svelte';
import DriftDetail from './components/DriftDetail.svelte';
import ActivityLog from './components/ActivityLog.svelte';
import ShareDetail from './components/ShareDetail.svelte';
import MeetingPermissionsWindow from './components/MeetingPermissionsWindow.svelte';
import DmDetail from './components/DmDetail.svelte';
import BannerNotification from './components/BannerNotification.svelte';
import Widget from './components/Widget.svelte';
import GlobalErrorBoundary from './components/GlobalErrorBoundary.svelte';
import { mount } from 'svelte';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { beforeSend } from "./sentry-before-send";

Sentry.init({
  dsn: import.meta.env.VITE_SENTRY_DSN,
  initialScope: { tags: { repo: "hq-sync-web" } },
  release: `hq-sync-web@${__APP_VERSION__}`,
  beforeSend,
});

const windowLabel = getCurrentWindow().label;
// Tag the document so per-window `:global(html, body)` rules can scope
// themselves with `[data-window="…"]` and stop bleeding across windows.
// Without this, whichever component's CSS gets bundled last wins the
// body background — most visibly turning the transparent popover into
// a solid black rectangle when MeetingsWindow's #18181b body bg
// overrode App.svelte's `background: transparent`.
document.documentElement.dataset.window = windowLabel;
const isWindows = /Windows/i.test(navigator.userAgent);
document.documentElement.dataset.platform = isWindows ? 'windows' : 'other';

let Component: typeof App;
if (windowLabel === 'meetings-window') {
  Component = MeetingsWindow as unknown as typeof App;
} else if (windowLabel === 'drift-detail') {
  Component = DriftDetail as unknown as typeof App;
} else if (windowLabel === 'activity-log') {
  Component = ActivityLog as unknown as typeof App;
} else if (windowLabel === 'share-detail') {
  Component = ShareDetail as unknown as typeof App;
} else if (windowLabel === 'meeting-permissions') {
  Component = MeetingPermissionsWindow as unknown as typeof App;
} else if (windowLabel === 'dm-detail') {
  Component = DmDetail as unknown as typeof App;
} else if (windowLabel === 'dm-banner') {
  Component = BannerNotification as unknown as typeof App;
} else if (windowLabel === 'widget') {
  Component = Widget as unknown as typeof App;
} else {
  Component = App;
}

const app = mount(GlobalErrorBoundary, {
  target: document.getElementById('app')!,
  props: { component: Component, windowLabel },
});

export default app;
