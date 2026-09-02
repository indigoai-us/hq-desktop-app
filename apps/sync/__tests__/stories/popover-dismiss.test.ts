// @vitest-environment happy-dom

// The menubar popover is an undecorated, always-on-all-spaces window with no
// traffic-light close control, so the only ways out are click-away (Rust
// `Focused(false)` handling in tray.rs), Esc, and the header close button.
// This pins the two renderer-side affordances.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('svelte', async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import('../../node_modules/svelte/src/index-client.js');
});

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  unlisten: vi.fn(),
  windowListen: vi.fn(),
  onFocusChanged: vi.fn(),
  setSize: vi.fn(),
}));
const feedData = vi.hoisted(() => ({
  loadTimeline: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: tauri.listen }));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    listen: tauri.windowListen,
    onFocusChanged: tauri.onFocusChanged,
    setSize: tauri.setSize,
  }),
  LogicalSize: class LogicalSize {
    constructor(
      public width: number,
      public height: number,
    ) {}
  },
}));
vi.mock('../../src/lib/notificationFeedData', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/notificationFeedData')>();
  return {
    ...actual,
    loadNotificationTimeline: feedData.loadTimeline,
  };
});

import { flushSync, mount, unmount } from 'svelte';
import Popover from '../../src/components/Popover.svelte';

type MountedComponent = ReturnType<typeof mount>;

let host: HTMLDivElement;
let component: MountedComponent | null;

function mountPopover(props: Record<string, unknown> = {}): HTMLElement {
  component = mount(Popover, {
    target: host,
    props: {
      syncState: 'idle',
      config: null,
      onsync: vi.fn(),
      messagesUnreadCount: 0,
      companies: [{ uid: 'personal', slug: 'personal', name: 'Personal' }],
      ...props,
    },
  });
  flushSync();
  return host;
}

const hideCalls = () => tauri.invoke.mock.calls.filter(([cmd]) => cmd === 'hide_main_window');

function pressEscape(init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', {
    key: 'Escape',
    bubbles: true,
    cancelable: true,
    ...init,
  });
  window.dispatchEvent(event);
  flushSync();
  return event;
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  component = null;
  tauri.invoke.mockReset();
  tauri.listen.mockReset();
  tauri.unlisten.mockReset();
  tauri.windowListen.mockReset();
  tauri.onFocusChanged.mockReset();
  tauri.setSize.mockReset();
  feedData.loadTimeline.mockReset();
  tauri.listen.mockResolvedValue(tauri.unlisten);
  tauri.windowListen.mockResolvedValue(tauri.unlisten);
  tauri.onFocusChanged.mockResolvedValue(tauri.unlisten);
  feedData.loadTimeline.mockResolvedValue({
    items: [],
    historyState: 'resolved',
    activityState: 'resolved',
    updateState: 'resolved',
  });
  tauri.invoke.mockImplementation(async (command: string) => {
    if (command === 'get_sync_status') {
      return {
        lastSyncAt: new Date().toISOString(),
        pendingFiles: 0,
        conflicts: 0,
        daemonRunning: true,
        source: 'test',
      };
    }
    if (command === 'hide_main_window') return null;
    throw new Error(`Unexpected invoke: ${command}`);
  });
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host.remove();
  vi.clearAllMocks();
});

describe('popover dismissal', () => {
  it('hides the window when Esc is pressed anywhere in the popover', () => {
    mountPopover();
    const event = pressEscape();
    expect(hideCalls()).toHaveLength(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it('leaves Esc to a nested surface that already handled it', () => {
    mountPopover();
    const event = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    event.preventDefault();
    window.dispatchEvent(event);
    flushSync();
    expect(hideCalls()).toHaveLength(0);
  });

  it('lets the conflict modal own Esc while it is open', () => {
    mountPopover({
      syncState: 'conflict',
      showConflictModal: true,
      conflicts: [
        {
          path: 'notes.md',
          localHash: 'aaaaaaaaaa',
          remoteHash: 'bbbbbbbbbb',
          canAutoResolve: false,
          status: 'pending',
        },
      ],
      conflictCount: 1,
      onresolve: vi.fn(),
      onopen: vi.fn(),
      ondismissconflicts: vi.fn(),
    });
    pressEscape();
    expect(hideCalls()).toHaveLength(0);
  });

  it('ignores keys other than Esc', () => {
    mountPopover();
    pressEscape({ key: 'Enter' });
    expect(hideCalls()).toHaveLength(0);
  });

  it('stops listening for Esc once the popover unmounts', async () => {
    mountPopover();
    await unmount(component!);
    component = null;
    pressEscape();
    expect(hideCalls()).toHaveLength(0);
  });

  it('renders a labelled close button in the header that hides the window', () => {
    const el = mountPopover();
    const close = el.querySelector<HTMLButtonElement>('[data-testid="popover-close"]');
    expect(close).not.toBeNull();
    expect(close!.getAttribute('aria-label')).toBe('Close');
    // Lives in the status row — the popover's header — not buried in the feed.
    expect(close!.closest('[data-testid="popover-status-row"]')).not.toBeNull();
    close!.click();
    flushSync();
    expect(hideCalls()).toHaveLength(1);
  });
});

// Source contracts for the native half of the fix, which the renderer harness
// cannot exercise. The behavioural assertions live in tray.rs unit tests
// (`should_hide_popover_on_blur`).
const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const normalize = (s: string) => s.replace(/\s+/g, ' ');

describe('popover dismissal (native surface)', () => {
  it('exposes hide_main_window to the renderer', () => {
    expect(normalize(read('src-tauri/src/commands/app.rs'))).toContain(
      'pub fn hide_main_window(app: tauri::AppHandle)',
    );
    expect(normalize(read('src-tauri/src/main.rs'))).toContain(
      'commands::app::hide_main_window,',
    );
  });

  it('routes the blur-hide decision through the testable predicate', () => {
    const tray = normalize(read('src-tauri/src/tray.rs'));
    expect(tray).toContain('fn should_hide_popover_on_blur(inputs: BlurHideInputs) -> bool');
    expect(tray).toContain('user_dismissed_once: popover_dismissed_by_user()');
  });

  it('does not leave the dev-flag popover sticky-topmost', () => {
    const tray = read('src-tauri/src/tray.rs');
    const devBlock = tray.slice(tray.indexOf('HQ_DEV_SHOW_ON_LAUNCH'));
    const devShow = devBlock
      .slice(0, devBlock.indexOf('HQ_DEV_OPEN_DESKTOP_ON_LAUNCH'))
      // Drop comment lines — the code is the contract, and the comment there
      // names the call it deliberately no longer makes.
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    expect(devShow).toContain('HQ_DEV_SHOW_ON_LAUNCH');
    expect(devShow).not.toContain('set_always_on_top(true)');
    expect(devShow).toContain('bring_webview_to_front');
  });
});
