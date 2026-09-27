// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('svelte', async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import('../../node_modules/svelte/src/index-client.js');
});

const tauri = vi.hoisted(() => ({ invoke: vi.fn(async (..._args: unknown[]) => undefined) }));
const win = vi.hoisted(() => ({
  setSize: vi.fn(async (..._args: unknown[]) => undefined),
  setShadow: vi.fn(async (..._args: unknown[]) => undefined),
  center: vi.fn(async () => undefined),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
vi.mock('@tauri-apps/api/window', async () => {
  const actual = await vi.importActual<typeof import('@tauri-apps/api/window')>(
    '@tauri-apps/api/window',
  );
  return {
    ...actual,
    getCurrentWindow: () => win,
    currentMonitor: async () => null,
  };
});

// The wizard is replaced by a marker so these tests stay about the window
// Onboarding puts it in, not about the wizard's own dependencies.
vi.mock('./onboarding/OnboardingWizard.svelte', async () => {
  return await import('./onboarding/__fixtures__/WizardStub.svelte');
});

import { flushSync, mount, tick, unmount } from 'svelte';

import Onboarding from './Onboarding.svelte';

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    flushSync();
    await tick();
    await Promise.resolve();
  }
}

function commands(): string[] {
  return tauri.invoke.mock.calls.map(([command]) => String(command));
}

describe('Onboarding: the welcome flow window', () => {
  let host: HTMLDivElement;
  let component: Record<string, unknown> | null = null;

  beforeEach(() => {
    tauri.invoke.mockClear();
    win.setSize.mockClear();
    win.setShadow.mockClear();
    win.center.mockClear();
    host = document.createElement('div');
    document.body.appendChild(host);
  });

  afterEach(() => {
    if (component) unmount(component);
    component = null;
    host.remove();
  });

  it('opens a first install straight on the welcome flow, in an 800x900 window over the blurred desktop', async () => {
    component = mount(Onboarding, {
      target: host,
      props: { state: 'NeedsInstall', mode: 'onboarding' },
    });
    await settle();

    const stub = host.querySelector<HTMLElement>('[data-testid="wizard-stub"]');
    expect(stub?.dataset.mode).toBe('onboarding');
    expect(stub?.dataset.initialStep).toBe('0');
    const size = win.setSize.mock.calls[0]?.[0] as { width: number; height: number };
    expect([size.width, size.height]).toEqual([800, 900]);
    expect(win.center).toHaveBeenCalled();
    // The popover material comes off and the welcome backdrop goes on.
    expect(tauri.invoke).toHaveBeenCalledWith('set_main_window_vibrancy', { enabled: false });
    expect(tauri.invoke).toHaveBeenCalledWith('set_welcome_backdrop', {
      enabled: true,
      fadeMs: 1800,
    });
    expect(commands().indexOf('set_main_window_vibrancy')).toBeLessThan(
      commands().indexOf('set_welcome_backdrop'),
    );
  });

  it('hands the window back to the compact popover when it goes away', async () => {
    component = mount(Onboarding, {
      target: host,
      props: { state: 'NeedsInstall', mode: 'onboarding' },
    });
    await settle();
    tauri.invoke.mockClear();
    win.setSize.mockClear();

    unmount(component);
    component = null;
    await settle();

    expect(tauri.invoke).toHaveBeenCalledWith('set_welcome_backdrop', {
      enabled: false,
      fadeMs: 1800,
    });
    expect(tauri.invoke).toHaveBeenCalledWith('set_main_window_vibrancy', { enabled: true });
    const size = win.setSize.mock.calls.at(-1)?.[0] as { width: number; height: number };
    expect([size.width, size.height]).toEqual([288, 360]);
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
    host.querySelector<HTMLButtonElement>('[data-testid="wizard-stub-finish"]')?.click();
    await settle();

    expect(commands().indexOf('mark_first_run_complete')).toBeGreaterThan(-1);
    expect(commands().indexOf('mark_first_run_complete')).toBeLessThan(
      commands().indexOf('show_main_window_at_tray'),
    );
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
      '3',
    );
    host.querySelector<HTMLButtonElement>('[data-testid="wizard-stub-finish"]')?.click();
    await settle();
    expect(commands()).not.toContain('mark_first_run_complete');
    expect(onfinish).toHaveBeenCalledTimes(1);
  });
});
