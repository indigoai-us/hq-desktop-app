// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('svelte', async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import('../../node_modules/svelte/src/index-client.js');
});

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  open: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));
vi.mock('@tauri-apps/plugin-shell', () => ({ open: tauri.open }));

import { flushSync, mount, tick, unmount } from 'svelte';

import SignInPrompt from './SignInPrompt.svelte';

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await tick();
  flushSync();
}

async function flushUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await flush();
    if (predicate()) return;
  }
  throw new Error('Timed out waiting for sign-in continuation preparation.');
}

function providerButtons(): HTMLButtonElement[] {
  return Array.from(host.querySelectorAll<HTMLButtonElement>('.sign-in-actions .sign-in-btn'));
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  tauri.invoke.mockReset();
  tauri.open.mockReset();
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host.remove();
  vi.restoreAllMocks();
});

describe('SignInPrompt browser continuation', () => {
  it('starts provider OAuth and renders loading while rollout preparation is unresolved', async () => {
    let resolveConfig!: (value: unknown) => void;
    const config = new Promise<unknown>((resolve) => {
      resolveConfig = resolve;
    });
    tauri.invoke.mockImplementation((command: string) => {
      switch (command) {
        case 'desktop_continuation_context':
          return Promise.resolve({
            installAttemptId: '11111111-1111-4111-8111-111111111111',
            appVersion: '0.10.229',
            apiBase: 'https://api.placeholder.test',
          });
        case 'desktop_continuation_config':
          return config;
        case 'desktop_continuation_deliver':
          return Promise.resolve(200);
        case 'start_oauth_login':
          return new Promise(() => {});
        default:
          return Promise.resolve(undefined);
      }
    });
    component = mount(SignInPrompt, { target: host });

    await flushUntil(() =>
      tauri.invoke.mock.calls.some(([command]) => command === 'desktop_continuation_config'),
    );
    providerButtons()[0]?.click();
    flushSync();

    expect(tauri.invoke).toHaveBeenCalledWith('start_oauth_login', { provider: 'Google' });
    expect(providerButtons()[0]?.disabled).toBe(true);
    expect(providerButtons()[0]?.textContent).toContain('Waiting for browser…');

    resolveConfig({ protocolVersion: 1, minimumDesktopVersion: '0.10.229', variant: 'control', rolloutPercent: 100 });
  });

  it('asks for email before Microsoft OAuth so work accounts are not sent to MicrosoftPersonal', async () => {
    tauri.invoke.mockImplementation((command: string) => {
      switch (command) {
        case 'desktop_continuation_context':
          return Promise.resolve(null);
        case 'start_oauth_login':
          return new Promise(() => {});
        default:
          return Promise.resolve(undefined);
      }
    });
    component = mount(SignInPrompt, { target: host });
    await flush();

    providerButtons()[1]?.click();
    flushSync();

    expect(tauri.invoke).not.toHaveBeenCalledWith(
      'start_oauth_login',
      expect.objectContaining({ provider: 'Microsoft' }),
    );
    const email = host.querySelector<HTMLInputElement>('[data-testid="microsoft-email"]');
    expect(email).not.toBeNull();
    email!.value = 'scottallen@dim6fitness.com';
    email!.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
    host.querySelector<HTMLButtonElement>('[data-testid="microsoft-email-continue"]')?.click();
    flushSync();

    expect(tauri.invoke).toHaveBeenCalledWith('start_oauth_login', {
      provider: 'Microsoft',
      email: 'scottallen@dim6fitness.com',
    });
  });
});

describe('SignInPrompt session retry (OWNER-015)', () => {
  beforeEach(() => {
    tauri.invoke.mockImplementation((command: string) =>
      command === 'desktop_continuation_context' ? Promise.resolve(null) : Promise.resolve(undefined),
    );
  });

  it('renders Retry inside the card, after the providers, and makes no data call to show it', async () => {
    const onretry = vi.fn();
    component = mount(SignInPrompt, { target: host, props: { onretry } });
    await flush();

    const card = host.querySelector('.sign-in-card');
    const retry = host.querySelector<HTMLButtonElement>('[data-testid="sign-in-session-retry"]');
    expect(retry).not.toBeNull();
    expect(card?.contains(retry)).toBe(true);
    expect(retry!.querySelector('svg')).not.toBeNull();
    const actions = host.querySelector('.sign-in-actions')!;
    expect(actions.compareDocumentPosition(retry!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    retry!.click();
    expect(onretry).toHaveBeenCalledTimes(1);
    const commands = tauri.invoke.mock.calls.map(([command]) => command);
    expect(commands.every((command) => command === 'desktop_continuation_context')).toBe(true);
  });

  it('omits Retry when no handler is passed and never renders a password control', async () => {
    component = mount(SignInPrompt, { target: host });
    await flush();

    expect(host.querySelector('[data-testid="sign-in-session-retry"]')).toBeNull();
    expect(host.querySelector('input[type="password"]')).toBeNull();
  });
});
