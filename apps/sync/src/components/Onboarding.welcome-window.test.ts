// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('svelte', async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import('../../node_modules/svelte/src/index-client.js');
});

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined),
}));
const win = vi.hoisted(() => ({
  setSize: vi.fn(async (..._args: unknown[]) => undefined),
  setShadow: vi.fn(async (..._args: unknown[]) => undefined),
  center: vi.fn(async () => undefined),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
const shell = vi.hoisted(() => ({ open: vi.fn(async (..._args: unknown[]) => undefined) }));
vi.mock('@tauri-apps/plugin-shell', () => ({ open: shell.open }));
vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: vi.fn(async () => true),
  sendNotification: vi.fn(),
}));
vi.mock('@tauri-apps/api/window', async () => {
  const actual = await vi.importActual<typeof import('@tauri-apps/api/window')>(
    '@tauri-apps/api/window',
  );
  return {
    ...actual,
    getCurrentWindow: () => win,
  };
});

// The wizard is replaced by a marker so these tests stay about the window
// Onboarding puts it in, not about the wizard's own dependencies.
vi.mock('./onboarding/OnboardingWizard.svelte', async () => {
  return await import('./onboarding/__fixtures__/WizardStub.svelte');
});

import { flushSync, mount, tick, unmount } from 'svelte';

import Onboarding from './Onboarding.svelte';
import { CONSENT_STEP_INDEX, DIRECTORY_STEP_INDEX } from '../lib/onboarding-wizard';
import { WELCOME_RESIZE_TIMEOUT_MS } from '../lib/welcome-window-size';

async function settle(): Promise<void> {
  for (let i = 0; i < 12; i += 1) {
    flushSync();
    await tick();
    await Promise.resolve();
  }
}

function commands(): string[] {
  return tauri.invoke.mock.calls.map(([command]) => String(command));
}

/** A first install opens on the heads-up; "Start now" goes on to the flow. */
async function startNow(): Promise<void> {
  host.querySelector<HTMLButtonElement>('[data-testid="heads-up-start"]')?.click();
  await settle();
}

const WALLPAPER = 'data:image/jpeg;base64,/9j/';

/** Sizes the window, as the webview reports it, smaller than the screen. */
function setViewport(width: number, height: number): void {
  vi.stubGlobal('innerWidth', width);
  vi.stubGlobal('innerHeight', height);
}

/** The native resize lands: the webview reports the new size. */
function resizeViewport(width: number, height: number): void {
  setViewport(width, height);
  window.dispatchEvent(new Event('resize'));
}

let host: HTMLDivElement;

describe('Onboarding: the welcome flow window', () => {
  let component: Record<string, unknown> | null = null;

  beforeEach(() => {
    tauri.invoke.mockReset();
    tauri.invoke.mockImplementation(async () => undefined);
    win.setSize.mockClear();
    win.setShadow.mockClear();
    win.center.mockClear();
    shell.open.mockClear();
    localStorage.clear();
    host = document.createElement('div');
    document.body.appendChild(host);
  });

  afterEach(() => {
    if (component) unmount(component);
    component = null;
    host.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('opens a first install on the small heads-up window, not the full-screen flow', async () => {
    component = mount(Onboarding, {
      target: host,
      props: { state: 'NeedsInstall', mode: 'onboarding' },
    });
    await settle();

    expect(host.querySelector('[data-testid="heads-up"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="wizard-stub"]')).toBeNull();
    // The native first-run window is handed back and sized to a centred card.
    expect(tauri.invoke).toHaveBeenCalledWith('set_welcome_window', { enabled: false });
    expect(tauri.invoke).not.toHaveBeenCalledWith('set_welcome_window', { enabled: true });
    const size = win.setSize.mock.calls.at(-1)?.[0] as { width: number; height: number };
    expect([size.width, size.height]).toEqual([440, 380]);
    expect(win.center).toHaveBeenCalled();
    expect(commands()).not.toContain('get_desktop_wallpaper');
  });

  it('keeps the heads-up card transparent until the window is at card size', async () => {
    let finishResize: () => void = () => {};
    win.center.mockImplementationOnce(
      () => new Promise<undefined>((done) => (finishResize = () => done(undefined))),
    );
    component = mount(Onboarding, {
      target: host,
      props: { state: 'NeedsInstall', mode: 'onboarding' },
    });
    await settle();
    const card = () => host.querySelector<HTMLElement>('[data-testid="heads-up"]');
    expect(card()?.dataset.ready).toBe('false');
    expect(card()?.classList.contains('ready')).toBe(false);

    finishResize();
    await settle();
    expect(card()?.dataset.ready).toBe('true');
    expect(card()?.classList.contains('ready')).toBe(true);
  });

  it('still shows the heads-up card when the window cannot be resized', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
    win.setSize.mockRejectedValueOnce(new Error('no window'));
    component = mount(Onboarding, {
      target: host,
      props: { state: 'NeedsInstall', mode: 'onboarding' },
    });
    await settle();
    expect(host.querySelector<HTMLElement>('[data-testid="heads-up"]')?.dataset.ready).toBe('true');
    warned.mockRestore();
  });

  it('starts the session scan as soon as the heads-up opens, before sign-in', async () => {
    component = mount(Onboarding, {
      target: host,
      props: { state: 'NeedsInstall', mode: 'onboarding' },
    });
    await settle();
    expect(commands()).toContain('scan_local_sessions');
    expect(host.querySelector('[data-testid="wizard-stub"]')).toBeNull();
  });

  it('warns and carries on when this build has no session scan', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
    tauri.invoke.mockImplementation(async (command: unknown) => {
      if (command === 'scan_local_sessions') throw 'Command scan_local_sessions not found';
      return undefined;
    });
    component = mount(Onboarding, {
      target: host,
      props: { state: 'NeedsInstall', mode: 'onboarding' },
    });
    await settle();
    expect(warned).toHaveBeenCalledWith(
      expect.stringContaining('scan_local_sessions is not available'),
      'Command scan_local_sessions not found',
    );
    expect(host.querySelector('[data-testid="heads-up"]')).not.toBeNull();
    warned.mockRestore();
  });

  it('logs heads-up screen enter and leave timing lines', async () => {
    component = mount(Onboarding, {
      target: host,
      props: { state: 'NeedsInstall', mode: 'onboarding' },
    });
    await settle();
    const lines = () =>
      tauri.invoke.mock.calls
        .filter(([command]) => command === 'frontend_log')
        .map(([, args]) => (args as { tag: string; message: string }));
    expect(lines()).toContainEqual({
      tag: 'first-run',
      message: 'kind=screen event=enter surface=welcome id=heads-up',
    });
    await startNow();
    expect(
      lines().some(
        (line) =>
          line.tag === 'first-run' &&
          /^kind=screen event=leave surface=welcome id=heads-up elapsed_ms=\d+$/.test(line.message),
      ),
    ).toBe(true);
  });

  it('"Start now" closes the heads-up and opens the welcome flow over the whole screen', async () => {
    component = mount(Onboarding, {
      target: host,
      props: { state: 'NeedsInstall', mode: 'onboarding' },
    });
    await settle();
    tauri.invoke.mockClear();
    win.setSize.mockClear();
    await startNow();

    expect(host.querySelector('[data-testid="heads-up"]')).toBeNull();
    const stub = host.querySelector<HTMLElement>('[data-testid="wizard-stub"]');
    expect(stub?.dataset.mode).toBe('onboarding');
    expect(stub?.dataset.initialStep).toBe('0');
    // The native side fits the window to the work area; the renderer does
    // not size it.
    expect(tauri.invoke).toHaveBeenCalledWith('set_welcome_window', { enabled: true });
    expect(win.setSize).not.toHaveBeenCalled();
    // The popover material comes off first.
    expect(tauri.invoke).toHaveBeenCalledWith('set_main_window_vibrancy', { enabled: false });
    expect(commands().indexOf('set_main_window_vibrancy')).toBeLessThan(
      commands().indexOf('set_welcome_window'),
    );
    expect(commands()).toContain('get_desktop_wallpaper');
    expect(commands()).not.toContain('mark_first_run_complete');
  });

  it('"Start now" mounts the flow only once the window has its welcome size', async () => {
    // The window starts at the heads-up card's size, and the native side
    // applies the welcome size after `set_welcome_window` returns.
    setViewport(440, 380);
    let handOver: () => void = () => {};
    tauri.invoke.mockImplementation(async (command: unknown, args: unknown) => {
      if (command === 'set_welcome_window' && (args as { enabled: boolean }).enabled) {
        await new Promise<void>((done) => (handOver = done));
      }
      return undefined;
    });
    component = mount(Onboarding, {
      target: host,
      props: { state: 'NeedsInstall', mode: 'onboarding' },
    });
    await settle();
    await startNow();
    const wizard = () => host.querySelector('[data-testid="wizard-stub"]');
    const pending = () => host.querySelector('[data-testid="welcome-window-pending"]');

    // The command has not returned: the flow is not built, and the card is
    // already gone so it never sits in a full-screen window. The flow's
    // background stands in.
    expect(tauri.invoke).toHaveBeenCalledWith('set_welcome_window', { enabled: true });
    expect(wizard()).toBeNull();
    expect(host.querySelector('[data-testid="heads-up"]')).toBeNull();
    expect(pending()?.classList.contains('hq-welcome')).toBe(true);

    // The command returned, but the window is still card-sized.
    handOver();
    await settle();
    expect(wizard()).toBeNull();
    expect(pending()).not.toBeNull();

    // The resize lands.
    resizeViewport(1440, 900);
    await settle();
    expect(wizard()).not.toBeNull();
    expect(pending()).toBeNull();
    expect(host.querySelector('[data-testid="heads-up"]')).toBeNull();
    expect(commands()).toContain('get_desktop_wallpaper');
  });

  it('"Start now" mounts the flow anyway when the resize never arrives', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    setViewport(440, 380);
    component = mount(Onboarding, {
      target: host,
      props: { state: 'NeedsInstall', mode: 'onboarding' },
    });
    await settle();
    await startNow();
    expect(host.querySelector('[data-testid="wizard-stub"]')).toBeNull();

    await vi.advanceTimersByTimeAsync(WELCOME_RESIZE_TIMEOUT_MS);
    await settle();
    expect(host.querySelector('[data-testid="wizard-stub"]')).not.toBeNull();
  });

  it('"Start now" does not wait for a resize when the window could not be handed over', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    setViewport(440, 380);
    tauri.invoke.mockImplementation(async (command: unknown, args: unknown) => {
      if (command === 'set_welcome_window' && (args as { enabled: boolean }).enabled) {
        throw new Error('no window');
      }
      return undefined;
    });
    component = mount(Onboarding, {
      target: host,
      props: { state: 'NeedsInstall', mode: 'onboarding' },
    });
    await settle();
    await startNow();
    expect(host.querySelector('[data-testid="wizard-stub"]')).not.toBeNull();
    logged.mockRestore();
  });

  it('"Do it later" sets a reminder and hides HQ to the tray without finishing first run', async () => {
    component = mount(Onboarding, {
      target: host,
      props: { state: 'NeedsInstall', mode: 'onboarding' },
    });
    await settle();
    host.querySelector<HTMLButtonElement>('[data-testid="heads-up-later"]')?.click();
    await settle();

    expect(commands()).toContain('hide_main_window');
    expect(Number(localStorage.getItem('hq.firstRun.headsUpRemindAt'))).toBeGreaterThan(Date.now());
    expect(commands()).not.toContain('mark_first_run_complete');
    expect(tauri.invoke).not.toHaveBeenCalledWith('set_welcome_window', { enabled: true });
  });

  it('"Manual setup" opens the manual setup guide and hides HQ to the tray', async () => {
    component = mount(Onboarding, {
      target: host,
      props: { state: 'NeedsInstall', mode: 'onboarding' },
    });
    await settle();
    host.querySelector<HTMLButtonElement>('[data-testid="heads-up-manual"]')?.click();
    await settle();

    expect(shell.open).toHaveBeenCalledWith('https://hq.computer/docs/manual-setup');
    expect(commands()).toContain('hide_main_window');
    expect(commands()).not.toContain('mark_first_run_complete');
  });

  it('paints the wallpaper and does not ask for the native blur when the wallpaper is available', async () => {
    tauri.invoke.mockImplementation(async (command: unknown) =>
      command === 'get_desktop_wallpaper' ? WALLPAPER : undefined,
    );
    component = mount(Onboarding, {
      target: host,
      props: { state: 'NeedsInstall', mode: 'onboarding' },
    });
    await settle();
    await startNow();

    const stub = host.querySelector<HTMLElement>('[data-testid="wizard-stub"]');
    expect(stub?.dataset.wallpaper).toBe(WALLPAPER);
    expect(tauri.invoke).not.toHaveBeenCalledWith('set_welcome_backdrop', {
      enabled: true,
      fadeMs: 1800,
    });
  });

  it('falls back to the native blur when the wallpaper cannot be read', async () => {
    tauri.invoke.mockImplementation(async (command: unknown) => {
      if (command === 'get_desktop_wallpaper') throw new Error('no wallpaper');
      return undefined;
    });
    component = mount(Onboarding, {
      target: host,
      props: { state: 'NeedsInstall', mode: 'onboarding' },
    });
    await settle();
    await startNow();

    expect(host.querySelector<HTMLElement>('[data-testid="wizard-stub"]')?.dataset.wallpaper).toBe('');
    expect(tauri.invoke).toHaveBeenCalledWith('set_welcome_backdrop', {
      enabled: true,
      fadeMs: 1800,
    });
    expect(commands().indexOf('get_desktop_wallpaper')).toBeLessThan(
      commands().indexOf('set_welcome_backdrop'),
    );
  });

  it('falls back to the native blur when there is no wallpaper (non-macOS)', async () => {
    tauri.invoke.mockImplementation(async () => null);
    component = mount(Onboarding, {
      target: host,
      props: { state: 'NeedsInstall', mode: 'onboarding' },
    });
    await settle();
    await startNow();

    expect(tauri.invoke).toHaveBeenCalledWith('set_welcome_backdrop', {
      enabled: true,
      fadeMs: 1800,
    });
  });

  it('hands the window back to the compact popover when it goes away', async () => {
    component = mount(Onboarding, {
      target: host,
      props: { state: 'NeedsInstall', mode: 'onboarding' },
    });
    await settle();
    await startNow();
    tauri.invoke.mockClear();
    win.setSize.mockClear();

    unmount(component);
    component = null;
    await settle();

    expect(tauri.invoke).toHaveBeenCalledWith('set_welcome_backdrop', {
      enabled: false,
      fadeMs: 1800,
    });
    expect(tauri.invoke).toHaveBeenCalledWith('set_welcome_window', { enabled: false });
    expect(tauri.invoke).toHaveBeenCalledWith('set_main_window_vibrancy', { enabled: true });
    const size = win.setSize.mock.calls.at(-1)?.[0] as { width: number; height: number };
    expect([size.width, size.height]).toEqual([288, 360]);
    expect(win.center).toHaveBeenCalled();
  });

  it('resumes a half-finished install on the install, not the welcome', async () => {
    component = mount(Onboarding, {
      target: host,
      props: { state: 'InstallResume', mode: 'onboarding' },
    });
    await settle();
    expect(host.querySelector<HTMLElement>('[data-testid="wizard-stub"]')?.dataset.initialStep).toBe(
      '2',
    );
  });

  it('mounts a resumed install only once the window has its welcome size', async () => {
    setViewport(440, 380);
    component = mount(Onboarding, {
      target: host,
      props: { state: 'InstallResume', mode: 'onboarding' },
    });
    await settle();
    expect(tauri.invoke).toHaveBeenCalledWith('set_welcome_window', { enabled: true });
    expect(host.querySelector('[data-testid="wizard-stub"]')).toBeNull();
    // The flow's background shows while the window is resized, not an empty
    // window.
    expect(
      host.querySelector('[data-testid="welcome-window-pending"]')?.classList.contains('hq-welcome'),
    ).toBe(true);

    resizeViewport(1440, 900);
    await settle();
    expect(host.querySelector('[data-testid="wizard-stub"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="welcome-window-pending"]')).toBeNull();
  });

  it('mounts at once when the window already fills the work area', async () => {
    // The first run: the native side fitted the window before showing it.
    setViewport(1440, 900);
    vi.stubGlobal('screen', { availWidth: 1440, availHeight: 900 });
    // The hand-over has not returned yet; the flow must not wait for it.
    tauri.invoke.mockImplementation(async (command: unknown, args: unknown) => {
      if (command === 'set_welcome_window' && (args as { enabled: boolean }).enabled) {
        await new Promise<void>(() => {});
      }
      return undefined;
    });
    component = mount(Onboarding, {
      target: host,
      props: { state: 'InstallResume', mode: 'onboarding' },
    });
    await settle();
    expect(tauri.invoke).toHaveBeenCalledWith('set_welcome_window', { enabled: true });
    expect(host.querySelector('[data-testid="wizard-stub"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="welcome-window-pending"]')).toBeNull();
  });

  it('opens folder recovery directly when a completed install has lost its HQ root', async () => {
    component = mount(Onboarding, {
      target: host,
      props: {
        state: 'NeedsInstall',
        mode: 'onboarding',
        setupEvidence: {
          installCompleted: true,
          firstRunCompleted: true,
          installInProgress: false,
          manifestIncomplete: false,
          hadMachineId: true,
          hqRootValid: false,
        },
      },
    });
    await settle();

    const stub = host.querySelector<HTMLElement>('[data-testid="wizard-stub"]');
    expect(stub).not.toBeNull();
    expect(stub?.dataset.mode).toBe('onboarding');
    expect(stub?.dataset.initialStep).toBe(String(DIRECTORY_STEP_INDEX));
    expect(stub?.dataset.initialStep).toBe('1');
    expect(stub?.dataset.recoveringMissingRoot).toBe('true');
  });

  it('does not treat a genuine first install as missing-root recovery', async () => {
    component = mount(Onboarding, {
      target: host,
      props: { state: 'NeedsInstall', mode: 'onboarding' },
    });
    await settle();
    await startNow();

    const stub = host.querySelector<HTMLElement>('[data-testid="wizard-stub"]');
    expect(stub?.dataset.initialStep).toBe('0');
    expect(stub?.dataset.recoveringMissingRoot).toBe('false');
  });

  it('plays the replay in the same window and ends it without first-run writes', async () => {
    const onfinish = vi.fn();
    component = mount(Onboarding, {
      target: host,
      props: { state: 'SteadyState', mode: 'replay', onfinish },
    });
    await settle();

    const stub = host.querySelector<HTMLElement>('[data-testid="wizard-stub"]');
    expect(stub?.dataset.mode).toBe('replay');
    expect(stub?.dataset.initialStep).toBe('0');

    host.querySelector<HTMLButtonElement>('[data-testid="wizard-stub-finish"]')?.click();
    await settle();

    expect(onfinish).toHaveBeenCalledTimes(1);
    expect(commands()).not.toContain('mark_first_run_complete');
    expect(commands()).not.toContain('show_main_window_at_tray');
  });

  it('finishes a first install by marking first run complete and opening the desktop', async () => {
    const onfinish = vi.fn();
    component = mount(Onboarding, {
      target: host,
      props: { state: 'NeedsInstall', mode: 'onboarding', onfinish },
    });
    await settle();
    await startNow();
    host.querySelector<HTMLButtonElement>('[data-testid="wizard-stub-finish"]')?.click();
    await settle();

    expect(commands().indexOf('mark_first_run_complete')).toBeGreaterThan(-1);
    expect(commands().indexOf('mark_first_run_complete')).toBeLessThan(
      commands().indexOf('show_main_window_at_tray'),
    );
    // The desktop opens with no route, so its first-run decision (the tree
    // takeover when the visual first run is on) picks the first page. Asking
    // for a page here would skip the tree.
    const opens = tauri.invoke.mock.calls.filter(([command]) => command === 'show_main_window_at_tray');
    expect(opens).toEqual([['show_main_window_at_tray']]);
    expect(commands()).not.toContain('open_desktop_alt_window');
    expect(onfinish).toHaveBeenCalledTimes(1);
  });

  it('asks a stale-consent re-prompt only the consent question and marks nothing', async () => {
    const onfinish = vi.fn();
    component = mount(Onboarding, {
      target: host,
      props: { state: 'SteadyState', mode: 'reprompt', onfinish },
    });
    await settle();
    expect(host.querySelector<HTMLElement>('[data-testid="wizard-stub"]')?.dataset.initialStep).toBe(
      String(CONSENT_STEP_INDEX),
    );
    host.querySelector<HTMLButtonElement>('[data-testid="wizard-stub-finish"]')?.click();
    await settle();
    expect(commands()).not.toContain('mark_first_run_complete');
    expect(onfinish).toHaveBeenCalledTimes(1);
  });

  it('logs a failed vibrancy change and still opens the welcome window', async () => {
    const error = new Error('vibrancy unavailable');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    tauri.invoke.mockImplementation(async (command: unknown) => {
      if (command === 'set_main_window_vibrancy') throw error;
      return undefined;
    });
    component = mount(Onboarding, {
      target: host,
      props: { state: 'NeedsInstall', mode: 'onboarding' },
    });
    await settle();
    await startNow();

    expect(logged).toHaveBeenCalledWith('onboarding: window vibrancy failed', error);
    expect(tauri.invoke).toHaveBeenCalledWith('set_welcome_window', { enabled: true });
    expect(host.querySelector('[data-testid="wizard-stub"]')).not.toBeNull();
    logged.mockRestore();
  });

  it('logs a failed welcome-window resize and still reads the wallpaper', async () => {
    const error = new Error('welcome window failed');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    tauri.invoke.mockImplementation(async (command: unknown) => {
      if (command === 'set_welcome_window') throw error;
      if (command === 'get_desktop_wallpaper') return WALLPAPER;
      return undefined;
    });
    component = mount(Onboarding, {
      target: host,
      props: { state: 'NeedsInstall', mode: 'onboarding' },
    });
    await settle();
    await startNow();

    expect(logged).toHaveBeenCalledWith('onboarding: welcome window failed', error);
    expect(tauri.invoke).toHaveBeenCalledWith('get_desktop_wallpaper');
    logged.mockRestore();
  });

  it('logs a failed native blur and still shows the wizard', async () => {
    const error = new Error('backdrop failed');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    tauri.invoke.mockImplementation(async (command: unknown) => {
      if (command === 'set_welcome_backdrop') throw error;
      return null;
    });
    component = mount(Onboarding, {
      target: host,
      props: { state: 'NeedsInstall', mode: 'onboarding' },
    });
    await settle();
    await startNow();

    expect(logged).toHaveBeenCalledWith('onboarding: welcome backdrop failed', error);
    expect(host.querySelector('[data-testid="wizard-stub"]')).not.toBeNull();
    logged.mockRestore();
  });

  it('logs a failed window shadow and still restores the compact size', async () => {
    const error = new Error('shadow failed');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    win.setShadow.mockRejectedValue(error);
    component = mount(Onboarding, {
      target: host,
      props: { state: 'NeedsInstall', mode: 'onboarding' },
    });
    await settle();
    await startNow();
    logged.mockClear();

    unmount(component);
    component = null;
    await settle();

    expect(logged).toHaveBeenCalledWith('onboarding: window shadow failed', error);
    expect(win.setSize).toHaveBeenCalled();
    logged.mockRestore();
  });
});
