// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('svelte', async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import('../../node_modules/svelte/src/index-client.js');
});

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  unlisten: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: tauri.listen }));

import { flushSync, mount, unmount } from 'svelte';
import BannerNotification from '../../src/components/BannerNotification.svelte';

interface BannerPayload {
  kind: string;
  title: string;
  body: string;
  actionLabel: string;
  actionId: string;
  clickActionId: string;
  data: unknown;
}

type BannerListener = (event: { payload: BannerPayload }) => void;
type MountedComponent = ReturnType<typeof mount>;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const payload: BannerPayload = {
  kind: 'dm',
  title: 'Izzy',
  body: 'The post-deploy smoke check is ready.',
  actionLabel: 'Open message',
  actionId: 'open-message',
  clickActionId: 'open-message',
  data: { eventId: 'evt-1' },
};

let host: HTMLDivElement;
let component: MountedComponent | null;
let bannerListener: BannerListener | null;
let runBannerAction: () => Promise<unknown>;

async function mountBanner(): Promise<HTMLElement> {
  component = mount(BannerNotification, { target: host });
  await vi.waitFor(() => expect(bannerListener).toBeTypeOf('function'));
  bannerListener?.({ payload });
  flushSync();
  const banner = host.querySelector<HTMLElement>('.banner');
  expect(banner).toBeTruthy();
  return banner!;
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  component = null;
  bannerListener = null;
  runBannerAction = async () => undefined;
  tauri.unlisten.mockReset();
  tauri.listen.mockReset();
  tauri.invoke.mockReset();
  tauri.listen.mockImplementation(
    async (event: string, listener: BannerListener) => {
      if (event === 'banner:event') bannerListener = listener;
      return tauri.unlisten;
    },
  );
  tauri.invoke.mockImplementation(async (command: string) => {
    if (command === 'banner_action') return runBannerAction();
    if (
      command === 'banner_window_ready' ||
      command === 'resize_banner' ||
      command === 'dismiss_banner'
    ) {
      return undefined;
    }
    throw new Error(`Unexpected invoke: ${command}`);
  });
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host.remove();
  vi.clearAllMocks();
});

describe('BannerNotification action recovery', () => {
  it('exposes pending state and only starts leaving after the action succeeds', async () => {
    const action = deferred<void>();
    runBannerAction = () => action.promise;
    const banner = await mountBanner();
    const chip = host.querySelector<HTMLButtonElement>('.chip')!;

    chip.click();
    flushSync();

    expect(tauri.invoke).toHaveBeenCalledWith(
      'banner_action',
      expect.objectContaining({
        requestId: expect.any(String),
        action: 'open-message',
        payload,
      }),
    );
    expect(banner.getAttribute('aria-busy')).toBe('true');
    expect(chip.disabled).toBe(true);
    expect(chip.getAttribute('aria-busy')).toBe('true');
    expect(chip.textContent).toContain('Working…');
    expect(banner.classList.contains('leaving')).toBe(false);

    action.resolve();
    await vi.waitFor(() => {
      flushSync();
      expect(banner.classList.contains('leaving')).toBe(true);
    });
  });

  it('keeps a failed banner visible and retries without dismissing it', async () => {
    const retry = deferred<void>();
    let attempts = 0;
    runBannerAction = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('offline');
      return retry.promise;
    };
    const banner = await mountBanner();

    host.querySelector<HTMLButtonElement>('.chip')!.click();
    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('[data-testid="banner-action-error"]')).toBeTruthy();
    });

    expect(banner.classList.contains('leaving')).toBe(false);
    expect(
      tauri.invoke.mock.calls.some(([command]) => command === 'dismiss_banner'),
    ).toBe(false);

    const retryButton = host.querySelector<HTMLButtonElement>(
      '[data-testid="banner-action-error"] button',
    )!;
    retryButton.click();
    flushSync();

    expect(retryButton.disabled).toBe(true);
    expect(retryButton.getAttribute('aria-busy')).toBe('true');
    expect(retryButton.textContent).toContain('Retrying…');
    expect(banner.classList.contains('leaving')).toBe(false);

    retry.resolve();
    await vi.waitFor(() => {
      flushSync();
      expect(banner.classList.contains('leaving')).toBe(true);
      expect(host.querySelector('[data-testid="banner-action-error"]')).toBeNull();
    });
    expect(attempts).toBe(2);
  });

  it('dismisses the native banner only after an acknowledged success', async () => {
    const banner = await mountBanner();
    host.querySelector<HTMLButtonElement>('.chip')!.click();

    await vi.waitFor(() => {
      flushSync();
      expect(banner.classList.contains('leaving')).toBe(true);
    });
    await vi.waitFor(() => {
      expect(tauri.invoke).toHaveBeenCalledWith('dismiss_banner');
    });
  });

  it('uses a native primary button without nesting the secondary controls', async () => {
    const banner = await mountBanner();
    const primary = banner.querySelector<HTMLButtonElement>('.banner-primary');

    expect(banner.getAttribute('role')).toBe('group');
    expect(primary).toBeTruthy();
    expect(primary?.querySelector('button')).toBeNull();

    // A native button owns Enter/Space activation in a real browser. Happy DOM
    // does not synthesize click from keydown, so exercise the button activation
    // directly after asserting the semantic contract above.
    primary!.click();

    await vi.waitFor(() => {
      expect(tauri.invoke).toHaveBeenCalledWith(
        'banner_action',
        expect.objectContaining({
          action: 'open-message',
          payload,
        }),
      );
    });
  });

  it('does not let a stale leave timer dismiss a replacement payload', async () => {
    const banner = await mountBanner();
    vi.useFakeTimers();
    try {
      host.querySelector<HTMLButtonElement>('.close')!.click();
      flushSync();
      expect(banner.classList.contains('leaving')).toBe(true);

      const replacement: BannerPayload = {
        ...payload,
        body: 'A newer notification replaced the closing one.',
        data: { eventId: 'evt-2' },
      };
      bannerListener?.({ payload: replacement });
      flushSync();

      expect(banner.classList.contains('leaving')).toBe(false);
      expect(banner.textContent).toContain(replacement.body);

      await vi.advanceTimersByTimeAsync(181);
      expect(
        tauri.invoke.mock.calls.filter(
          ([command]) => command === 'dismiss_banner',
        ),
      ).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('notification action acknowledgement contract', () => {
  const rust = readFileSync(
    resolve(process.cwd(), 'src-tauri/src/commands/banner.rs'),
    'utf8',
  );
  const app = readFileSync(resolve(process.cwd(), 'src/App.svelte'), 'utf8');
  const router = readFileSync(
    resolve(process.cwd(), 'src/lib/bannerActionRouter.ts'),
    'utf8',
  );
  const nativeRecovery = readFileSync(
    resolve(process.cwd(), 'src/lib/nativeNotificationRecovery.ts'),
    'utf8',
  );

  it('waits on a bounded one-shot and never dismisses inside banner_action', () => {
    const start = rust.indexOf('pub async fn banner_action(');
    const end = rust.indexOf('pub async fn banner_action_result(', start);
    const actionSource = rust.slice(start, end);

    expect(actionSource).toContain('pending.register(&request_id)');
    expect(actionSource).toContain(
      'let ack_timeout = action_ack_timeout(&payload.kind, &action);',
    );
    expect(actionSource).toContain('tokio::time::timeout(ack_timeout, receiver)');
    expect(actionSource).not.toContain('dismiss_banner_inner');
  });

  it('reports the real App result using the same request id', () => {
    expect(router).toContain('requestId: string;');
    expect(router).toContain("await this.invoke('banner_action_result', {");
    expect(router).toContain('requestId: payload.requestId');
    expect(app).toContain('executeNotificationAction(kind, action, data)');
    expect(app).toContain('await handleInstallUpdate(true);');
    expect(app).toContain('await handleStartRecording(windowId, true);');
  });

  it('turns failed native DM/share actions into a visible retry banner', () => {
    expect(app).toContain(
      "invoke('show_action_retry_banner', { kind, action, data })",
    );
    expect(app).toContain('notificationActionRecovery = recovery');
    expect(nativeRecovery).toContain('await ports.showRetryBanner(action)');
    expect(nativeRecovery).toContain('await ports.showMainWindow()');
    expect(rust).toContain('pub async fn show_action_retry_banner(');
    expect(rust).toContain('action_label: Some("Retry".to_string())');
  });
});
