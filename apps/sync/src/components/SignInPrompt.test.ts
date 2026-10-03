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
  vi.useRealTimers();
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
    await flushUntil(() => providerButtons().length === 2);
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
    await flushUntil(() => providerButtons().length === 2);

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

describe('SignInPrompt welcome handoff', () => {
  it('advances when a valid native session appears while the welcome view is open', async () => {
    const onsuccess = vi.fn();
    tauri.invoke.mockImplementation((command: string) => {
      if (command === 'desktop_continuation_context') return Promise.resolve(null);
      if (command === 'get_auth_state') {
        return Promise.resolve({ authenticated: true, expiresAt: '2099-01-01T00:00:00Z' });
      }
      return Promise.resolve(undefined);
    });

    component = mount(SignInPrompt, { target: host, props: { onsuccess } });

    await flushUntil(() => onsuccess.mock.calls.length === 1);

    expect(onsuccess).toHaveBeenCalledWith({
      authenticated: true,
      expiresAt: '2099-01-01T00:00:00Z',
    });
  });

  it('shows an in-place browser handoff with reopen and back actions', async () => {
    let waitForCallback!: () => void;
    const callback = new Promise<{ code: string }>((resolve) => {
      waitForCallback = () => resolve({ code: 'code' });
    });
    tauri.invoke.mockImplementation((command: string) => {
      switch (command) {
        case 'desktop_continuation_context':
          return Promise.resolve(null);
        case 'get_auth_state':
          return Promise.resolve({ authenticated: false, expiresAt: '' });
        case 'start_oauth_login':
          return Promise.resolve({ authorizeUrl: 'https://login.example.test/google', state: 'state' });
        case 'oauth_listen_for_code':
          return callback;
        default:
          return Promise.resolve(undefined);
      }
    });
    tauri.open.mockResolvedValue(undefined);
    component = mount(SignInPrompt, { target: host });
    await flushUntil(() => providerButtons().length === 2);

    providerButtons()[0]?.click();
    await flushUntil(() => host.querySelector('[data-testid="signin-browser-handoff"]') !== null);

    expect(host.textContent).toContain('Finish signing in in your browser');
    expect(host.textContent).toContain('Continue with Google in your browser');
    host.querySelector<HTMLButtonElement>('[data-testid="reopen-browser-signin"]')?.click();
    await flush();
    expect(tauri.open).toHaveBeenCalledTimes(2);

    Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'Back')?.click();
    await flushUntil(() => host.querySelector('[data-testid="signin-browser-handoff"]') === null);
    expect(providerButtons()[0]?.disabled).toBe(false);

    waitForCallback();
  });

  it('ends a stalled browser handoff with a plain Try again path', async () => {
    vi.useFakeTimers();
    let resolveCallback!: (value: { code: string }) => void;
    const callback = new Promise<{ code: string }>((resolve) => {
      resolveCallback = resolve;
    });
    const onsuccess = vi.fn();
    tauri.invoke.mockImplementation((command: string) => {
      switch (command) {
        case 'desktop_continuation_context':
          return Promise.resolve(null);
        case 'get_auth_state':
          return Promise.resolve({ authenticated: false, expiresAt: '' });
        case 'start_oauth_login':
          return Promise.resolve({ authorizeUrl: 'https://login.example.test/google', state: 'state' });
        case 'oauth_listen_for_code':
          return callback;
        default:
          return Promise.resolve(undefined);
      }
    });
    tauri.open.mockResolvedValue(undefined);
    component = mount(SignInPrompt, { target: host, props: { onsuccess } });
    await flushUntil(() => providerButtons().length === 2);

    providerButtons()[0]?.click();
    await flushUntil(() => host.querySelector('[data-testid="signin-browser-handoff"]') !== null);
    await vi.advanceTimersByTimeAsync(3 * 60 * 1_000);
    await flush();

    expect(host.textContent).toContain('We couldn’t finish sign-in. Try again.');
    expect(host.querySelector<HTMLButtonElement>('[data-testid="retry-signin"]')?.textContent).toBe('Try again');
    expect(tauri.invoke).toHaveBeenCalledWith('oauth_cancel_listen', { state: 'state' });

    resolveCallback({ code: 'late-code' });
    await flush();

    expect(tauri.invoke).not.toHaveBeenCalledWith(
      'oauth_exchange_code',
      expect.objectContaining({ code: 'late-code' }),
    );
    expect(onsuccess).not.toHaveBeenCalled();
  });

  it('cancels the native listener and ignores its callback after unmount', async () => {
    let resolveCallback!: (value: { code: string }) => void;
    const callback = new Promise<{ code: string }>((resolve) => {
      resolveCallback = resolve;
    });
    const onsuccess = vi.fn();
    tauri.invoke.mockImplementation((command: string) => {
      switch (command) {
        case 'desktop_continuation_context':
          return Promise.resolve(null);
        case 'get_auth_state':
          return Promise.resolve({ authenticated: false, expiresAt: '' });
        case 'start_oauth_login':
          return Promise.resolve({ authorizeUrl: 'https://login.example.test/google', state: 'state' });
        case 'oauth_listen_for_code':
          return callback;
        default:
          return Promise.resolve(undefined);
      }
    });
    tauri.open.mockResolvedValue(undefined);
    component = mount(SignInPrompt, { target: host, props: { onsuccess } });
    await flushUntil(() => providerButtons().length === 2);

    providerButtons()[0]?.click();
    await flushUntil(() => host.querySelector('[data-testid="signin-browser-handoff"]') !== null);
    await unmount(component);
    component = null;

    expect(tauri.invoke).toHaveBeenCalledWith('oauth_cancel_listen', { state: 'state' });
    resolveCallback({ code: 'late-code' });
    await flush();

    expect(tauri.invoke).not.toHaveBeenCalledWith(
      'oauth_exchange_code',
      expect.objectContaining({ code: 'late-code' }),
    );
    expect(onsuccess).not.toHaveBeenCalled();
  });

  it('reports manual sign-in success only once when the session poll observes it', async () => {
    vi.useFakeTimers();
    let authenticated = false;
    const onsuccess = vi.fn();
    tauri.invoke.mockImplementation((command: string) => {
      switch (command) {
        case 'desktop_continuation_context':
          return Promise.resolve(null);
        case 'get_auth_state':
          return Promise.resolve({
            authenticated,
            expiresAt: authenticated ? '2099-01-01T00:00:00Z' : '',
          });
        case 'start_oauth_login':
          return Promise.resolve({ authorizeUrl: 'https://login.example.test/google', state: 'state' });
        case 'oauth_listen_for_code':
          return Promise.resolve({ code: 'code' });
        case 'oauth_exchange_code':
          authenticated = true;
          return Promise.resolve({ authenticated: true, expiresAt: '2099-01-01T00:00:00Z' });
        default:
          return Promise.resolve(undefined);
      }
    });
    tauri.open.mockResolvedValue(undefined);
    component = mount(SignInPrompt, { target: host, props: { onsuccess } });
    await flushUntil(() => providerButtons().length === 2);

    providerButtons()[0]?.click();
    await flushUntil(() => onsuccess.mock.calls.length === 1);
    await vi.advanceTimersByTimeAsync(2_000);
    await flush();

    expect(onsuccess).toHaveBeenCalledTimes(1);
  });

  it('keeps a callback failure plain while recording the existing failure event', async () => {
    tauri.invoke.mockImplementation((command: string) => {
      switch (command) {
        case 'desktop_continuation_context':
          return Promise.resolve(null);
        case 'get_auth_state':
          return Promise.resolve({ authenticated: false, expiresAt: '' });
        case 'start_oauth_login':
          return Promise.resolve({ authorizeUrl: 'https://login.example.test/google', state: 'state' });
        case 'oauth_listen_for_code':
          return Promise.reject(new Error('callback rejected: provider detail'));
        default:
          return Promise.resolve(undefined);
      }
    });
    tauri.open.mockResolvedValue(undefined);
    component = mount(SignInPrompt, { target: host });
    await flushUntil(() => providerButtons().length === 2);

    providerButtons()[0]?.click();
    await flushUntil(() => host.textContent?.includes('We couldn’t finish sign-in. Try again.') ?? false);

    expect(host.textContent).not.toContain('provider detail');
    expect(tauri.invoke).toHaveBeenCalledWith(
      'emit_desktop_operational_telemetry',
      expect.objectContaining({
        eventName: 'desktop_auth_failure',
        properties: expect.objectContaining({ step: 'provider_page_opened', errorCategory: 'auth' }),
      }),
    );
  });
});

const CONTINUATION_CONTEXT = {
  installAttemptId: '11111111-1111-4111-8111-111111111111',
  appVersion: '0.10.229',
  apiBase: 'https://api.placeholder.test',
};

const CONTINUATION_CONFIG = {
  protocolVersion: 1,
  minimumDesktopVersion: '0.10.229',
  variant: 'continuation',
  rolloutPercent: 100,
} as const;

function continuationArmedInvoke(flag: () => Promise<boolean>) {
  tauri.invoke.mockImplementation((command: string) => {
    switch (command) {
      case 'web_authorize_enabled':
        return flag();
      case 'desktop_continuation_context':
        return Promise.resolve(CONTINUATION_CONTEXT);
      case 'desktop_continuation_config':
        return Promise.resolve(CONTINUATION_CONFIG);
      case 'desktop_continuation_may_start':
        return Promise.resolve(null);
      case 'desktop_continuation_start':
        return Promise.resolve({ attemptId: 'continuation-attempt' });
      case 'desktop_continuation_await_identity':
        return new Promise(() => {});
      case 'desktop_continuation_deliver':
        return Promise.resolve(200);
      default:
        return Promise.resolve(undefined);
    }
  });
}

describe('SignInPrompt web authorize flag', () => {
  it('keeps today\'s provider buttons when the flag is off', async () => {
    tauri.invoke.mockImplementation((command: string) => {
      switch (command) {
        case 'web_authorize_enabled':
          return Promise.resolve(false);
        case 'desktop_continuation_context':
          return Promise.resolve(null);
        default:
          return Promise.resolve(undefined);
      }
    });
    component = mount(SignInPrompt, { target: host });
    await flushUntil(() =>
      tauri.invoke.mock.calls.some(([command]) => command === 'web_authorize_enabled'),
    );
    await flushUntil(() => providerButtons().length === 2);
    expect(host.querySelector('[data-testid="web-authorize-signin"]')).toBeNull();
    expect(providerButtons().map((button) => button.textContent)).toEqual([
      expect.stringContaining('Continue with Google'),
      expect.stringContaining('Continue with Microsoft'),
    ]);
  });

  it('shows Sign in when the flag is on and opens the web authorize page', async () => {
    tauri.invoke.mockImplementation((command: string) => {
      switch (command) {
        case 'web_authorize_enabled':
          return Promise.resolve(true);
        case 'desktop_continuation_context':
          return Promise.resolve(null);
        case 'start_web_authorize':
          return Promise.resolve({
            authorizeUrl: 'https://hqforwork.com/authorize/desktop?client_id=7acei2c8v870enheptb1j5foln',
            state: 'web-state',
          });
        case 'oauth_listen_for_code':
          return new Promise(() => {});
        default:
          return Promise.resolve(undefined);
      }
    });
    component = mount(SignInPrompt, { target: host });
    await flushUntil(() => Boolean(host.querySelector('[data-testid="web-authorize-signin"]')));
    expect(host.querySelector('[data-testid="other-ways-to-sign-in"]')).not.toBeNull();
    host.querySelector<HTMLButtonElement>('[data-testid="web-authorize-signin"]')?.click();
    flushSync();
    await flush();
    expect(tauri.invoke).toHaveBeenCalledWith('start_web_authorize');
    expect(tauri.open).toHaveBeenCalledWith(
      'https://hqforwork.com/authorize/desktop?client_id=7acei2c8v870enheptb1j5foln',
    );
  });

  it('reserves the button area until the flag resolves and does not flash provider buttons', async () => {
    vi.useFakeTimers();
    tauri.invoke.mockImplementation((command: string) => {
      switch (command) {
        case 'web_authorize_enabled':
          return new Promise((resolve) => {
            setTimeout(() => resolve(true), 1_500);
          });
        case 'desktop_continuation_context':
          return Promise.resolve(null);
        default:
          return Promise.resolve(undefined);
      }
    });
    component = mount(SignInPrompt, { target: host });
    await flush();
    expect(host.querySelector('[data-testid="sign-in-actions"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="web-authorize-signin"]')).toBeNull();
    expect(providerButtons()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_500);
    await flushUntil(() => Boolean(host.querySelector('[data-testid="web-authorize-signin"]')));
    expect(host.querySelector('[data-testid="web-authorize-signin"]')?.textContent).toContain('Sign in');
    expect(host.querySelector('[data-testid="other-ways-to-sign-in"]')).not.toBeNull();
  });

  it('falls back to enabled provider buttons and plain copy when web authorize listen rejects', async () => {
    tauri.invoke.mockImplementation((command: string) => {
      switch (command) {
        case 'web_authorize_enabled':
          return Promise.resolve(true);
        case 'desktop_continuation_context':
          return Promise.resolve(null);
        case 'start_web_authorize':
          return Promise.resolve({
            authorizeUrl: 'https://hqforwork.com/authorize/desktop',
            state: 'web-state',
          });
        case 'oauth_listen_for_code':
          throw new Error('callback rejected: provider detail');
        case 'oauth_cancel_listen':
          return Promise.resolve(undefined);
        default:
          return Promise.resolve(undefined);
      }
    });
    tauri.open.mockResolvedValue(undefined);
    component = mount(SignInPrompt, { target: host });
    await flushUntil(() => Boolean(host.querySelector('[data-testid="web-authorize-signin"]')));
    host.querySelector<HTMLButtonElement>('[data-testid="web-authorize-signin"]')?.click();
    await flushUntil(
      () =>
        (host.textContent?.includes(
          'That sign-in did not finish. Choose your provider and try once more.',
        ) ??
          false) &&
        host.querySelector('[data-testid="web-authorize-signin"]') === null &&
        providerButtons().length === 2 &&
        providerButtons().every((button) => !button.disabled),
    );
    expect(host.textContent).not.toContain('provider detail');
    expect(host.querySelector('[data-testid="web-authorize-signin"]')).toBeNull();
    expect(providerButtons().map((button) => button.textContent)).toEqual([
      expect.stringContaining('Continue with Google'),
      expect.stringContaining('Continue with Microsoft'),
    ]);
    expect(providerButtons().every((button) => !button.disabled)).toBe(true);
  });
});

describe('SignInPrompt continuation vs web authorize flag', () => {
  it('starts continuation without waiting when the flag is off', async () => {
    continuationArmedInvoke(() => Promise.resolve(false));
    component = mount(SignInPrompt, { target: host });
    await flushUntil(() =>
      tauri.invoke.mock.calls.some(([command]) => command === 'desktop_continuation_start'),
    );
    expect(tauri.invoke.mock.calls.some(([command]) => command === 'desktop_continuation_config')).toBe(
      true,
    );
  });

  it('starts continuation when web_authorize_enabled rejects', async () => {
    continuationArmedInvoke(() => Promise.reject(new Error('flag unavailable')));
    component = mount(SignInPrompt, { target: host });
    await flushUntil(() =>
      tauri.invoke.mock.calls.some(([command]) => command === 'desktop_continuation_start'),
    );
    await flushUntil(() => providerButtons().length === 2);
  });

  it('starts continuation without waiting for a slow web_authorize_enabled flag', async () => {
    vi.useFakeTimers();
    continuationArmedInvoke(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve(false), 1_500);
        }),
    );
    component = mount(SignInPrompt, { target: host });
    await flushUntil(() =>
      tauri.invoke.mock.calls.some(([command]) => command === 'desktop_continuation_config'),
    );
    expect(tauri.invoke.mock.calls.some(([command]) => command === 'web_authorize_enabled')).toBe(true);
    expect(
      tauri.invoke.mock.calls.findIndex(([command]) => command === 'desktop_continuation_config'),
    ).toBeGreaterThan(-1);
    expect(host.querySelector('[data-testid="web-authorize-signin"]')).toBeNull();
    expect(providerButtons()).toHaveLength(0);
    await flushUntil(() =>
      tauri.invoke.mock.calls.some(([command]) => command === 'desktop_continuation_start'),
    );
    await vi.advanceTimersByTimeAsync(1_500);
    await flush();
  });
});
