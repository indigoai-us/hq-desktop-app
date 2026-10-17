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
  it('never starts a browser continuation on mount, because it would open the bare Hosted UI', async () => {
    tauri.invoke.mockImplementation((command: string) => {
      switch (command) {
        case 'desktop_continuation_context':
          return Promise.resolve({
            installAttemptId: '11111111-1111-4111-8111-111111111111',
            appVersion: '0.10.229',
            apiBase: 'https://api.placeholder.test',
          });
        case 'desktop_continuation_config':
          return Promise.resolve({
            protocolVersion: 1,
            minimumDesktopVersion: '0.10.229',
            variant: 'continuation',
            rolloutPercent: 100,
          });
        case 'desktop_continuation_may_start':
          return Promise.resolve(null);
        case 'desktop_continuation_start':
          return new Promise(() => {});
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
      tauri.invoke.mock.calls.some(([command]) => command === 'desktop_continuation_context'),
    );
    for (let i = 0; i < 10; i += 1) await flush();

    const commands = tauri.invoke.mock.calls.map(([command]) => command);
    expect(commands).not.toContain('desktop_continuation_start');
    expect(commands).not.toContain('start_oauth_login');
    expect(tauri.open).not.toHaveBeenCalled();

    providerButtons()[0]?.click();
    flushSync();

    expect(tauri.invoke).toHaveBeenCalledWith('start_oauth_login', { provider: 'Google' });
    expect(providerButtons()[0]?.disabled).toBe(true);
    expect(providerButtons()[0]?.textContent).toContain('Waiting for browser…');
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

    // main #1287 added a native get_auth_state recheck on mount, and the
    // outpost identity probe (get_machine_identity_status) reads a local file
    // mode. Both are local probes, not data calls. Retry itself must add no call.
    const callsBeforeRetry = tauri.invoke.mock.calls.length;
    retry!.click();
    expect(onretry).toHaveBeenCalledTimes(1);
    expect(tauri.invoke.mock.calls.length).toBe(callsBeforeRetry);
    const localProbes = ['desktop_continuation_context', 'get_auth_state', 'get_machine_identity_status'];
    const commands = tauri.invoke.mock.calls.map(([command]) => command);
    expect(commands.every((command) => localProbes.includes(command))).toBe(true);
  });

  it('omits Retry when no handler is passed and never renders a password control', async () => {
    component = mount(SignInPrompt, { target: host });
    await flush();

    expect(host.querySelector('[data-testid="sign-in-session-retry"]')).toBeNull();
    expect(host.querySelector('input[type="password"]')).toBeNull();
  });

  it('keeps "Sign in to HQ" as the one heading on the signed-out page, with the reason under it (OWNER-D 5)', async () => {
    component = mount(SignInPrompt, {
      target: host,
      props: { layout: 'column', reauth: true, note: 'Your session expired.' },
    });
    await flush();

    const headings = host.querySelectorAll('h1, h2');
    expect(headings).toHaveLength(1);
    expect(headings[0]!.textContent).toBe('Sign in to HQ');
    expect(host.querySelector('[data-testid="sign-in-description"]')?.textContent?.trim()).toBe(
      'Your session expired.',
    );
  });
});

describe('SignInPrompt outpost machine identity', () => {
  function invokeWith(
    status: unknown,
    overrides: Record<string, () => Promise<unknown>> = {},
  ): void {
    tauri.invoke.mockImplementation((command: string) => {
      if (command in overrides) return overrides[command]!();
      switch (command) {
        case 'desktop_continuation_context':
          return Promise.resolve(null);
        case 'get_machine_identity_status':
          return Promise.resolve(status);
        case 'get_auth_state':
          return Promise.resolve({ authenticated: false, expiresAt: '' });
        default:
          return Promise.resolve(undefined);
      }
    });
  }

  function outpostButton(): HTMLButtonElement | null {
    return host.querySelector<HTMLButtonElement>('[data-testid="sign-in-use-outpost"]');
  }

  it('offers the outpost identity only when the device has one that is not in use', async () => {
    invokeWith({ available: true, active: false });
    component = mount(SignInPrompt, { target: host, props: { onretry: vi.fn() } });
    await flushUntil(() => outpostButton() !== null);

    const button = outpostButton()!;
    expect(button.textContent?.trim()).toBe("Use this outpost's identity");
    expect(button.querySelector('svg')).not.toBeNull();
    expect(host.querySelector('.sign-in-card')?.contains(button)).toBe(true);
    const retry = host.querySelector('[data-testid="sign-in-session-retry"]')!;
    expect(button.compareDocumentPosition(retry) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(host.querySelector('input[type="password"]')).toBeNull();
  });

  it('hides the outpost action when the identity is absent, already active, or unknown', async () => {
    for (const status of [{ available: false, active: false }, { available: true, active: true }, null]) {
      invokeWith(status);
      component = mount(SignInPrompt, { target: host });
      await flush();
      await flush();
      expect(outpostButton()).toBeNull();
      await unmount(component);
      component = null;
    }
  });

  it('signs in as the outpost and hands the native session to the host once', async () => {
    const onsuccess = vi.fn();
    let signedIn = false;
    invokeWith(
      { available: true, active: false },
      {
        use_machine_identity: () => {
          signedIn = true;
          return Promise.resolve({ accountId: 'out_01ABC', generation: 2, status: 'active', reason: null });
        },
        get_auth_state: () =>
          Promise.resolve(
            signedIn
              ? { authenticated: true, expiresAt: '2026-10-14T08:00:00Z' }
              : { authenticated: false, expiresAt: '' },
          ),
      },
    );
    component = mount(SignInPrompt, { target: host, props: { onsuccess } });
    await flushUntil(() => outpostButton() !== null);

    outpostButton()!.click();
    await flushUntil(() => onsuccess.mock.calls.length > 0);

    const commands = tauri.invoke.mock.calls.map(([command]) => command);
    expect(commands).toContain('use_machine_identity');
    expect(onsuccess).toHaveBeenCalledTimes(1);
    expect(onsuccess).toHaveBeenCalledWith({ authenticated: true, expiresAt: '2026-10-14T08:00:00Z' });
    expect(host.querySelector('.error')).toBeNull();
  });

  it('keeps a failed outpost sign-in plain and leaves the action available', async () => {
    const onsuccess = vi.fn();
    invokeWith(
      { available: true, active: false },
      {
        use_machine_identity: () => Promise.reject(new Error('invoke failed: 500 Internal Server Error')),
      },
    );
    component = mount(SignInPrompt, { target: host, props: { onsuccess } });
    await flushUntil(() => outpostButton() !== null);

    outpostButton()!.click();
    await flushUntil(() => host.querySelector('.error') !== null);

    const message = host.querySelector('.error')?.textContent ?? '';
    expect(message).toBe('We couldn’t sign in as this outpost. Try again.');
    expect(message).not.toMatch(/500|Internal Server Error|invoke/);
    expect(onsuccess).not.toHaveBeenCalled();
    expect(outpostButton()).not.toBeNull();
    expect(outpostButton()!.disabled).toBe(false);
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
    await flush();

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
    await flush();

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

  it('retries a timed-out Google sign-in with the same provider', async () => {
    vi.useFakeTimers();
    tauri.invoke.mockImplementation((command: string) => {
      switch (command) {
        case 'desktop_continuation_context':
          return Promise.resolve(null);
        case 'get_auth_state':
          return Promise.resolve({ authenticated: false, expiresAt: '' });
        case 'start_oauth_login':
          return Promise.resolve({ authorizeUrl: 'https://login.example.test/google', state: 'state' });
        case 'oauth_listen_for_code':
          return new Promise(() => {});
        default:
          return Promise.resolve(undefined);
      }
    });
    tauri.open.mockResolvedValue(undefined);
    component = mount(SignInPrompt, { target: host });
    await flush();

    providerButtons()[0]?.click();
    await flushUntil(() => host.querySelector('[data-testid="signin-browser-handoff"]') !== null);
    await vi.advanceTimersByTimeAsync(3 * 60 * 1_000);
    await flush();

    host.querySelector<HTMLButtonElement>('[data-testid="retry-signin"]')?.click();
    await flush();

    const starts = tauri.invoke.mock.calls.filter(([command]) => command === 'start_oauth_login');
    expect(starts).toEqual([
      ['start_oauth_login', { provider: 'Google' }],
      ['start_oauth_login', { provider: 'Google' }],
    ]);
    expect(tauri.invoke.mock.calls.map(([command]) => command)).not.toContain('desktop_continuation_start');
  });

  it('retries a timed-out Microsoft sign-in with the same provider and email', async () => {
    vi.useFakeTimers();
    tauri.invoke.mockImplementation((command: string) => {
      switch (command) {
        case 'desktop_continuation_context':
          return Promise.resolve(null);
        case 'get_auth_state':
          return Promise.resolve({ authenticated: false, expiresAt: '' });
        case 'start_oauth_login':
          return Promise.resolve({ authorizeUrl: 'https://login.example.test/microsoft', state: 'state' });
        case 'oauth_listen_for_code':
          return new Promise(() => {});
        default:
          return Promise.resolve(undefined);
      }
    });
    tauri.open.mockResolvedValue(undefined);
    component = mount(SignInPrompt, { target: host });
    await flush();

    providerButtons()[1]?.click();
    flushSync();
    const email = host.querySelector<HTMLInputElement>('[data-testid="microsoft-email"]')!;
    email.value = 'person@example.test';
    email.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
    host.querySelector<HTMLButtonElement>('[data-testid="microsoft-email-continue"]')?.click();
    await flushUntil(() => host.querySelector('[data-testid="signin-browser-handoff"]') !== null);
    await vi.advanceTimersByTimeAsync(3 * 60 * 1_000);
    await flush();

    host.querySelector<HTMLButtonElement>('[data-testid="retry-signin"]')?.click();
    await flush();

    const starts = tauri.invoke.mock.calls.filter(([command]) => command === 'start_oauth_login');
    expect(starts).toEqual([
      ['start_oauth_login', { provider: 'Microsoft', email: 'person@example.test' }],
      ['start_oauth_login', { provider: 'Microsoft', email: 'person@example.test' }],
    ]);
  });

  it('shows the Google and Microsoft choice after a failed sign-in in the column layout', async () => {
    vi.useFakeTimers();
    tauri.invoke.mockImplementation((command: string) => {
      switch (command) {
        case 'desktop_continuation_context':
          return Promise.resolve(null);
        case 'get_auth_state':
          return Promise.resolve({ authenticated: false, expiresAt: '' });
        case 'start_oauth_login':
          return Promise.resolve({ authorizeUrl: 'https://login.example.test/google', state: 'state' });
        case 'oauth_listen_for_code':
          return new Promise(() => {});
        default:
          return Promise.resolve(undefined);
      }
    });
    tauri.open.mockResolvedValue(undefined);
    component = mount(SignInPrompt, { target: host, props: { layout: 'column' } });
    await flush();

    const actions = host.querySelector<HTMLElement>('.sign-in-actions')!;
    expect(actions.hidden).toBe(true);
    host.querySelector<HTMLButtonElement>('[data-testid="sign-in-with-hq"]')?.click();
    await flushUntil(() => host.querySelector('[data-testid="signin-browser-handoff"]') !== null);
    await vi.advanceTimersByTimeAsync(3 * 60 * 1_000);
    await flush();

    expect(host.textContent).toContain('We couldn’t finish sign-in. Try again.');
    expect(host.querySelector('[data-testid="sign-in-with-hq"]')).toBeNull();
    expect(host.querySelector<HTMLElement>('.sign-in-actions')!.hidden).toBe(false);
    expect(providerButtons().map((button) => button.textContent?.trim())).toEqual([
      'Continue with Google',
      'Continue with Microsoft',
    ]);

    providerButtons()[1]?.click();
    flushSync();
    expect(host.querySelector('[data-testid="microsoft-email"]')).not.toBeNull();
    expect(
      tauri.invoke.mock.calls.filter(([command]) => command === 'start_oauth_login'),
    ).toEqual([['start_oauth_login', { provider: 'Google' }]]);
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
    await flush();

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
    await flush();

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
    await flush();

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
