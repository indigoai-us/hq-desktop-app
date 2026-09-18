// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('svelte', async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import('../../node_modules/svelte/src/index-client.js');
});

const tauri = vi.hoisted(() => ({ invoke: vi.fn(async () => undefined) }));
const win = vi.hoisted(() => ({
  setSize: vi.fn(async () => undefined),
  setShadow: vi.fn(async () => undefined),
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

// The film cannot run here; the wizard is replaced by a marker so this test
// stays about the fall-through and not about the wizard's own dependencies.
vi.mock('./onboarding/CinematicIntro.svelte', async () => {
  return await import('./onboarding/__fixtures__/ThrowingIntro.svelte');
});
vi.mock('./onboarding/OnboardingWizard.svelte', async () => {
  return await import('./onboarding/__fixtures__/WizardStub.svelte');
});

import { flushSync, mount, tick, unmount } from 'svelte';

import Onboarding from './Onboarding.svelte';

const INTRO_SEEN_KEY = 'hq.onboarding.introSeen';

describe('Onboarding: the cinematic intro can never block setup', () => {
  let host: HTMLDivElement;
  let component: Record<string, unknown> | null = null;

  beforeEach(() => {
    window.localStorage.clear();
    host = document.createElement('div');
    document.body.appendChild(host);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    if (component) unmount(component);
    component = null;
    host.remove();
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it('falls through to the wizard when the intro throws on a first install', async () => {
    component = mount(Onboarding, {
      target: host,
      props: { state: 'NeedsInstall', mode: 'onboarding' },
    });
    flushSync();
    await tick();

    expect(console.error).toHaveBeenCalledWith(
      'onboarding: cinematic intro failed, falling through',
      expect.any(Error),
    );
    expect(host.querySelector('[data-testid="wizard-stub"]')).not.toBeNull();
    // Not a black screen: nothing of the failed film is left on the sheet.
    expect(host.textContent).toContain('wizard');
    // A machine that cannot play the film must not be re-trapped on it.
    expect(window.localStorage.getItem(INTRO_SEEN_KEY)).toBe('1');
  });

  it('ends a replay cleanly when the intro throws, without writing the seen flag', async () => {
    const onfinish = vi.fn();
    component = mount(Onboarding, {
      target: host,
      props: { state: 'SteadyState', mode: 'replay', onfinish },
    });
    flushSync();
    await tick();

    expect(onfinish).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(INTRO_SEEN_KEY)).toBeNull();
  });

  it('never opens the film for a machine that is already set up', async () => {
    component = mount(Onboarding, {
      target: host,
      props: { state: 'SteadyState', mode: 'onboarding' },
    });
    flushSync();
    await tick();

    // If the film had been chosen, the throwing fixture would have fired.
    expect(host.querySelector('[data-testid="wizard-stub"]')).not.toBeNull();
    expect(console.error).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(INTRO_SEEN_KEY)).toBeNull();
  });

  it('never re-opens the film once it has been seen on this install', async () => {
    window.localStorage.setItem(INTRO_SEEN_KEY, '1');
    component = mount(Onboarding, {
      target: host,
      props: { state: 'NeedsInstall', mode: 'onboarding' },
    });
    flushSync();
    await tick();

    expect(host.querySelector('[data-testid="wizard-stub"]')).not.toBeNull();
    expect(console.error).not.toHaveBeenCalled();
  });
});
