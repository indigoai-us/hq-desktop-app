// @vitest-environment happy-dom

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
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: tauri.listen }));

import { flushSync, mount, unmount } from 'svelte';
import NotificationFeed from '../../src/components/NotificationFeed.svelte';
import NotificationRow from '../../src/components/NotificationRow.svelte';

const root = (...parts: string[]) => resolve(process.cwd(), ...parts);
const read = (...parts: string[]) => readFileSync(root(...parts), 'utf8');

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;
let historyPayload: {
  dms: Array<{
    eventId: string;
    fromPersonUid: string;
    fromEmail: string;
    fromDisplayName: string;
    body: string;
    createdAt: string;
  }>;
  shares: unknown[];
  files: Array<{
    eventId: string;
    path: string;
    addedBy: string;
    companySlug: string;
    createdAt: string;
  }>;
};

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  vi.stubGlobal('localStorage', {
    length: 0,
    clear: vi.fn(),
    getItem: vi.fn(() => null),
    key: vi.fn(() => null),
    removeItem: vi.fn(),
    setItem: vi.fn(),
  } satisfies Storage);
  tauri.listen.mockResolvedValue(vi.fn());
  historyPayload = {
    dms: Array.from({ length: 224 }, (_, index) => ({
      eventId: `dm-${index}`,
      fromPersonUid: `person-${index}`,
      fromEmail: `person-${index}@example.com`,
      fromDisplayName: `Person ${index}`,
      body: `Notification ${index}`,
      createdAt: new Date(Date.now() - index * 1_000).toISOString(),
    })),
    shares: [],
    files: [],
  };
  tauri.invoke.mockImplementation(async (command: string) => {
    if (command === 'fetch_notification_history') return historyPayload;
    if (command === 'get_activity_log') return [];
    if (command === 'get_pending_update') return null;
    return undefined;
  });
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host.remove();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('visual hierarchy polish: shared notification row', () => {
  it('shows a neutral actor pill, source/type metadata, full timestamp semantics, and truncation tooltip', () => {
    const timestamp = Date.parse('2026-07-27T15:12:00.000Z');
    component = mount(NotificationRow, {
      target: host,
      props: {
        type: 'message',
        actor: 'Corey Epstein',
        sourceLabel: 'Direct message',
        text: 'A long notification summary that should remain discoverable after truncation',
        ts: timestamp,
      },
    });
    flushSync();

    const actor = host.querySelector<HTMLElement>('[data-testid="notification-actor"]');
    expect(actor?.textContent?.trim()).toBe('Corey Epstein');
    expect(actor?.getAttribute('title')).toBe('Corey Epstein');

    const metadata = host.querySelector<HTMLElement>('[data-testid="notification-source"]');
    expect(metadata?.textContent?.trim()).toBe('Direct message');

    const time = host.querySelector<HTMLTimeElement>('time.nr-ts');
    expect(time?.dateTime).toBe('2026-07-27T15:12:00.000Z');
    expect(time?.title).not.toBe('');

    expect(host.querySelector<HTMLElement>('.nr-text')?.title).toContain(
      'A long notification summary',
    );
  });

  it('immediately disables and spins an async row open action until it settles', async () => {
    let finish!: () => void;
    const onopen = vi.fn(
      () =>
        new Promise<void>((resolvePromise) => {
          finish = resolvePromise;
        }),
    );
    component = mount(NotificationRow, {
      target: host,
      props: {
        type: 'share',
        actor: 'Alex',
        text: 'shared launch-plan.md',
        ts: Date.now(),
        onopen,
      },
    });
    flushSync();

    const open = host.querySelector<HTMLButtonElement>('.nr-primary-action')!;
    open.click();
    flushSync();

    expect(onopen).toHaveBeenCalledTimes(1);
    expect(open.disabled).toBe(true);
    expect(open.getAttribute('aria-busy')).toBe('true');
    expect(open.querySelector('[data-testid="notification-pending"]')).toBeTruthy();

    open.click();
    expect(onopen).toHaveBeenCalledTimes(1);

    finish();
    await vi.waitFor(() => {
      flushSync();
      expect(open.disabled).toBe(false);
    });
  });

  it('shares one pending gate across row and visible actions while announcing unread count', async () => {
    let finish!: () => void;
    const onopen = vi.fn(
      () =>
        new Promise<void>((resolvePromise) => {
          finish = resolvePromise;
        }),
    );
    component = mount(NotificationRow, {
      target: host,
      props: {
        type: 'share',
        actor: 'Alex',
        text: 'shared launch-plan.md',
        ts: Date.now(),
        unread: true,
        badgeCount: 4,
        actionLabel: 'View file',
        onopen,
      },
    });
    flushSync();

    const row = host.querySelector<HTMLElement>('[data-testid="notification-row"]')!;
    const primary = host.querySelector<HTMLButtonElement>('.nr-primary-action')!;
    const visibleAction = host.querySelector<HTMLButtonElement>('.nr-open')!;

    expect(row.getAttribute('aria-label')).toContain('4 unread');
    expect(primary.getAttribute('aria-label')).toContain('4 unread');

    visibleAction.click();
    flushSync();

    expect(onopen).toHaveBeenCalledTimes(1);
    expect(primary.disabled).toBe(true);
    expect(visibleAction.disabled).toBe(true);
    expect(primary.getAttribute('aria-busy')).toBe('true');
    expect(visibleAction.getAttribute('aria-busy')).toBe('true');
    expect(visibleAction.textContent).toContain('Working');

    primary.click();
    visibleAction.click();
    expect(onopen).toHaveBeenCalledTimes(1);

    finish();
    await vi.waitFor(() => {
      flushSync();
      expect(primary.disabled).toBe(false);
      expect(visibleAction.disabled).toBe(false);
    });
  });

  it('prevents the row destination and secondary action from racing each other', async () => {
    let finishOpen!: () => void;
    let finishAction!: () => void;
    const onopen = vi.fn(
      () =>
        new Promise<void>((resolvePromise) => {
          finishOpen = resolvePromise;
        }),
    );
    const onaction = vi.fn(
      () =>
        new Promise<void>((resolvePromise) => {
          finishAction = resolvePromise;
        }),
    );
    component = mount(NotificationRow, {
      target: host,
      props: {
        type: 'system',
        actor: 'HQ',
        text: 'Version 0.10.35 is ready',
        ts: Date.now(),
        actionLabel: 'Update now',
        onopen,
        onaction,
      },
    });
    flushSync();

    const primary = host.querySelector<HTMLButtonElement>('.nr-primary-action')!;
    const action = host.querySelector<HTMLButtonElement>('.nr-open')!;

    primary.click();
    flushSync();
    expect(primary.disabled).toBe(true);
    expect(action.disabled).toBe(true);
    action.click();
    expect(onaction).not.toHaveBeenCalled();

    finishOpen();
    await vi.waitFor(() => {
      flushSync();
      expect(primary.disabled).toBe(false);
      expect(action.disabled).toBe(false);
    });

    action.click();
    flushSync();
    expect(onaction).toHaveBeenCalledTimes(1);
    expect(primary.disabled).toBe(true);
    expect(action.disabled).toBe(true);
    primary.click();
    expect(onopen).toHaveBeenCalledTimes(1);

    finishAction();
    await vi.waitFor(() => {
      flushSync();
      expect(primary.disabled).toBe(false);
      expect(action.disabled).toBe(false);
    });
  });
});

describe('visual hierarchy polish: bounded Inbox chronology', () => {
  it('renders 60 of 224 rows initially, keeps full counts, and reveals the next page', async () => {
    const onitemschange = vi.fn();
    const onunreadchange = vi.fn();
    component = mount(NotificationFeed, {
      target: host,
      props: {
        density: 'comfortable',
        onitemschange,
        onunreadchange,
      },
    });
    flushSync();

    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelectorAll('[data-testid="notification-row"]')).toHaveLength(60);
    });

    expect(onitemschange).toHaveBeenLastCalledWith(224);
    expect(onunreadchange).toHaveBeenLastCalledWith(224);
    const showMore = host.querySelector<HTMLButtonElement>(
      '[data-testid="notification-show-more"]',
    )!;
    expect(showMore.textContent?.trim()).toBe('Show 60 more');

    showMore.click();
    flushSync();
    expect(host.querySelectorAll('[data-testid="notification-row"]')).toHaveLength(120);
    expect(onitemschange).toHaveBeenLastCalledWith(224);
    expect(onunreadchange).toHaveBeenLastCalledWith(224);
  });

  it('forms complete file clusters before paginating rows and replaces dismissed slots', async () => {
    const now = Date.now();
    historyPayload = {
      dms: Array.from({ length: 70 }, (_, index) => ({
        eventId: `dm-${index}`,
        fromPersonUid: `person-${index}`,
        fromEmail: `person-${index}@example.com`,
        fromDisplayName: `Person ${index}`,
        body: `Notification ${index}`,
        createdAt: new Date(now - 10_000 - index * 1_000).toISOString(),
      })),
      shares: [],
      files: Array.from({ length: 100 }, (_, index) => ({
        eventId: `file-${index}`,
        path: `notes/file-${index}.md`,
        addedBy: 'HQ Sync',
        companySlug: 'indigo',
        createdAt: new Date(now - index).toISOString(),
      })),
    };

    component = mount(NotificationFeed, {
      target: host,
      props: { density: 'comfortable' },
    });
    flushSync();

    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelectorAll('[data-testid="notification-row"]')).toHaveLength(60);
    });

    const cluster = [...host.querySelectorAll<HTMLElement>('[data-testid="notification-row"]')]
      .find((row) => row.textContent?.includes('100 new files in indigo'));
    expect(cluster).toBeTruthy();
    expect(
      host.querySelector('[data-testid="notification-show-more"]')?.textContent,
    ).toContain('Show 11 more');

    cluster!.querySelector<HTMLButtonElement>('.nr-dismiss')!.click();
    flushSync();

    expect(host.querySelectorAll('[data-testid="notification-row"]')).toHaveLength(60);
    expect(host.textContent).not.toContain('100 new files in indigo');
    expect(
      host.querySelector('[data-testid="notification-show-more"]')?.textContent,
    ).toContain('Show 10 more');
  });
});

describe('visual hierarchy polish: scoped surface contracts', () => {
  const row = read('src/components/NotificationRow.svelte');
  const feed = read('src/components/NotificationFeed.svelte');
  const inbox = read('src/desktop-alt/pages/InboxPage.svelte');
  const quickPane = read('src/components/QuickWindowSidePane.svelte');
  const widget = read('src/components/Widget.svelte');
  const marketplace = read('src/desktop-alt/panels/MarketplacePanel.svelte');
  const companyPage = read('src/desktop-alt/pages/CompanyPage.svelte');
  const companyBoard = read('src/desktop-alt/panels/CompanyBoardPanel.svelte');
  const activity = read('src/desktop-alt/panels/ActivityPanel.svelte');
  const secrets = read('src/desktop-alt/panels/SecretsPanel.svelte');
  const moderation = read('src/desktop-alt/panels/ModerationPanel.svelte');
  const companyLibrary = read('src/desktop-alt/panels/CompanyLibraryPanel.svelte');
  const versionPopout = read('src/desktop-alt/components/VersionPopout.svelte');
  const desktop = read('src/desktop-alt/DesktopApp.svelte');
  const harness = read('dev-harness/mocks/core.ts');

  it('keeps notification hierarchy shared across Inbox, popover, widget, and quick pane', () => {
    expect(row).toContain('sourceLabel?: string');
    expect(feed).toContain('sourceLabel="Direct message"');
    expect(feed).toContain('sourceLabel="Shared file"');
    expect(feed).toContain('sourceLabel="Workspace activity"');
    expect(feed).toContain('sourceLabel="App update"');
    expect(inbox).toContain('density="comfortable"');
    expect(quickPane).toContain('row.ids.length > 1');
    expect(quickPane).toContain('`Direct messages · ${row.ids.length}`');
    expect(quickPane).toContain('`Shared files · ${row.ids.length}`');
    expect(widget).toContain('sourceLabel={notificationSourceLabel(row.item)}');
  });

  it('caps initial chronology rendering without changing total or unread semantics', () => {
    expect(feed).toContain("const INITIAL_RENDER_LIMIT = { compact: 32, comfortable: 60 } as const");
    expect(feed).toContain('buildNotificationGroups(undismissedItems, Date.now()');
    expect(feed).toContain('aggregateRepeatedMessagesAcrossDays: !showDayLabels');
    expect(feed).toContain('group.rows.slice(0, rowsLeft)');
    expect(feed).toContain('countUnread(visibleItems, lastReadTs)');
    expect(feed).toContain('onitemschange?.(visibleItems.length)');
    expect(feed).toContain('data-testid="notification-show-more"');
    expect(feed).toContain(
      'Show {Math.min(INITIAL_RENDER_LIMIT[density], remainingCount)} more',
    );
  });

  it('uses open neutral list structure without colored rails or nested notification cards', () => {
    for (const source of [row, feed, inbox, quickPane]) {
      expect(source).not.toMatch(/border-(?:left|inline-start)\s*:\s*[^;]*--(?:v4-)?(?:warn|error|unread)/);
    }
    expect(inbox).toContain('background: transparent');
    expect(inbox).toContain('border-radius: 0');
    expect(inbox).not.toContain('var(--v4-warn)');
  });

  it('restores full-color marketplace covers while retaining neutral glass chrome', () => {
    expect(marketplace).not.toContain('filter: saturate(0%);');
    expect(marketplace).toContain('filter: none;');
    expect(marketplace).toContain('mix-blend-mode: normal;');
    expect(marketplace).toContain('class="cover-color"');
    expect(marketplace).toContain('mix-blend-mode: color;');
    expect(marketplace).toContain('var(--cover-tint-a)');
    expect(marketplace).toContain('var(--cover-tint-b)');
    expect(marketplace).toContain('background: var(--v4-raised);');
    expect(marketplace).toContain(
      'backdrop-filter: var(--v4-glass-filter-popover, var(--v4-glass-filter));',
    );
    expect(marketplace).not.toContain('var(--v4-warn)');
  });

  it('gives marketplace install and widget navigation immediate busy feedback', () => {
    expect(marketplace).toContain('aria-busy={installing}');
    expect(marketplace).toContain('data-testid="marketplace-install-spinner"');
    expect(widget).toContain("let navigationPending = $state<'inbox' | 'desktop' | null>(null)");
    expect(widget).toContain("aria-busy={navigationPending === 'inbox'}");
    expect(widget).toContain("aria-busy={navigationPending === 'desktop'}");
    expect(widget).toContain('data-testid="widget-navigation-spinner"');
  });

  it('gates pending invites before any tenant data or company actions mount', () => {
    expect(companyPage).toContain("const pendingInvite = $derived(company.membershipStatus === 'pending')");
    expect(companyPage).toContain('data-testid="company-invite-gate"');
    expect(companyPage).toMatch(/\{:else\}\s+\{#key `\$\{company\.slug\}:\$\{tab\}`\}/);
    expect(companyPage).toContain("Accept before HQ loads this company’s projects");
    expect(companyPage).toContain('Review or decline');
    expect(companyPage).toContain('{#if !pendingInvite}');
  });

  it('labels broken-company overview values as cached instead of live cloud data', () => {
    expect(companyPage).toContain("const connectionIssue = $derived(company.state === 'broken')");
    expect(companyPage).toContain('{connectionIssue}');
    expect(companyBoard).toContain("label: 'cached data · reconnect needed'");
    expect(companyBoard).toContain('Counts below are local cached data until reconnect succeeds');
  });

  it('keeps partial activity honest and de-duplicates legacy secret payloads', () => {
    expect(activity).toContain('const recentSummaryLabel');
    expect(activity).toContain("'files'} in summary");
    expect(activity).toContain('Recent file details are unavailable');
    expect(secrets).toContain('function normalizeSecretEnvs');
    expect(secrets).toContain('current.items.set');
    expect(harness).toContain("file: 'companies/indigo/projects/desktop-experience/README.md'");
    expect(harness).toContain("env: 'production'");
    expect(harness).toContain("items: [");
  });

  it('uses compact neutral moderation and update hierarchy without amber danger actions', () => {
    expect(moderation).toContain('.request-actions .approve');
    expect(moderation).toContain('justify-content: flex-end');
    expect(moderation).toContain('.yank-button:disabled::before');
    expect(moderation).not.toMatch(/\.yank-button::before\s*\{[^}]*var\(--v4-warn\)/s);
    expect(moderation).not.toMatch(/\.confirm-yank::before\s*\{[^}]*var\(--v4-warn\)/s);
    expect(versionPopout).toMatch(/\.vp-product\s*\{[^}]*background: transparent/s);
    expect(versionPopout).not.toMatch(/\.vp-product\.core\s*\{[^}]*--v4-ok/s);
    expect(versionPopout).not.toMatch(/\.vp-kind\.core\s*\{[^}]*--v4-ok/s);
  });

  it('gives company skills and workers context without multiplying every deep command', () => {
    expect(companyLibrary).toContain('class="company-library-header"');
    expect(companyLibrary).toContain('Company-scoped workflows and operating knowledge');
    expect(desktop).toContain('...orderedCompanies.map');
    expect(desktop).not.toContain('...orderedCompanies.flatMap');
    expect(desktop).toContain('only materialize deep section commands for the active company');
  });
});
