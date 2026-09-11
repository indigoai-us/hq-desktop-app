// @vitest-environment happy-dom
//
// US-018 story acceptance tests (Desktop host side) — "Show company office
// hours and room availability".
//
// The shared Svelte office view is pinned in
// `packages/ui/src/meet/US-018.story.test.ts`. This file pins what only the
// Desktop host can get wrong:
//
//  * the Office destination is CAPABILITY-GATED — a build (or a browser) whose
//    adapter reports no `nativeCalls` never advertises a door it cannot open;
//  * the route surface keeps Office as a first-class company child (not an
//    operations tab), so a deep link lands somewhere real;
//  * and the host panel refuses in its own voice — not connected, or not
//    verified on this device — instead of reaching hq-pro anyway.
//
// The refusal path is the authorization statement: until the bundled US-011
// service-evidence preflight passes, the panel must make ZERO authorized calls.
//
// REACHABILITY (added after review): the desktop-alt route/sidebar tree above
// is NOT what `main.ts` mounts. The shipping shell is HqWorkWorkShell →
// @hq/work WorkShell → @hq/ui DesktopApp, so this file also pins that a signed
// -in user can reach Office THERE. The panel itself is one shared
// implementation (`packages/ui/src/meet/OfficePanel.svelte`); the end-to-end
// plumbing lives in `src/desktop-alt/office-shipping-path.test.ts` and the
// @hq/ui half in `packages/ui/src/meet/office-reachability.test.ts`.
//
// Everything is driven through an injected `invoke`; no Tauri, no network, no
// real clock.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('svelte', async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import('../../node_modules/svelte/src/index-client.js');
});

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(async () => null as unknown),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));

import { flushSync, mount, tick, unmount } from 'svelte';

import type { Workspace } from '../../src/lib/workspaces';
import {
  COMPANY_PRIMARY_SECTIONS,
  COMPANY_SECTIONS,
  companyPrimarySectionForTab,
  companyTabForPrimarySection,
  fromV4Route,
  isCompanyOperationsTab,
  resolvePendingDesktopRoute,
} from '../../src/desktop-alt/route';
import {
  getV4SidebarModel,
  sortV4CompaniesConnectedFirst,
  V4_CAPABILITY_GATED_PRIMARY_IDS,
  V4_COMPANY_PRIMARY_ITEMS,
} from '../../src/desktop-alt/v4/model';
import OfficePanel from '../../src/desktop-alt/panels/OfficePanel.svelte';
import serviceEvidence from '../../src/call/service-evidence.json';
import { companyChannelTabsFor } from '@hq/ui';

const repoFile = (relative: string): string =>
  readFileSync(resolve(process.cwd(), relative), 'utf8');

const baseCompany: Workspace = {
  slug: 'indigo',
  displayName: 'Indigo',
  kind: 'company',
  state: 'synced',
  cloudUid: 'cmp_indigo',
  bucketName: 'bucket',
  hasLocalFolder: true,
  localPath: '/tmp/HQ/companies/indigo',
  membershipStatus: 'active',
  role: 'member',
  lastSyncedAt: null,
  brokenReason: null,
  invitedBy: null,
  invitedAt: null,
};

const OFFICE_ROUTE = { kind: 'company', slug: 'indigo', tab: 'office' } as const;

function childIds(nativeCalls: boolean): string[] {
  const model = getV4SidebarModel(OFFICE_ROUTE, [baseCompany], { nativeCalls });
  const row = model.companies.find((company) => company.slug === 'indigo')!;
  return row.children.map((child) => child.id);
}

describe('US-018 desktop: the Office child is gated on the host capability', () => {
  it('hides the Office company child when the host reports no native calling', () => {
    const ids = childIds(false);
    expect(ids).not.toContain('office');
    // Every other child is untouched — the gate is surgical, not a blanket.
    expect(ids).toEqual(
      V4_COMPANY_PRIMARY_ITEMS.filter((item) => item.id !== 'office').map(
        (item) => item.id,
      ),
    );
    // Default (capabilities omitted) is closed, so a caller that forgets to
    // pass capabilities never accidentally advertises Office.
    const defaulted = getV4SidebarModel(OFFICE_ROUTE, [baseCompany]);
    expect(
      defaulted.companies[0]?.children.map((child) => child.id),
    ).not.toContain('office');
    expect(V4_CAPABILITY_GATED_PRIMARY_IDS.office).toBe('nativeCalls');
  });

  it('shows the Office child, in place and active, when native calling is available', () => {
    const ids = childIds(true);
    expect(ids).toContain('office');
    expect(ids).toEqual(V4_COMPANY_PRIMARY_ITEMS.map((item) => item.id));
    // Office sits where the spec puts it: after Team, before More.
    expect(ids.indexOf('office')).toBe(ids.indexOf('team') + 1);
    expect(ids.indexOf('office')).toBe(ids.indexOf('more') - 1);

    const model = getV4SidebarModel(OFFICE_ROUTE, [baseCompany], {
      nativeCalls: true,
    });
    const row = model.companies[0]!;
    expect(row.expanded).toBe(true);
    const active = row.children.filter((child) => child.active);
    expect(active.map((child) => child.id)).toEqual(['office']);
  });

  it('applies the same gate to the shared company sorter both sidebars consume', () => {
    const gated = sortV4CompaniesConnectedFirst(
      [baseCompany],
      'indigo',
      'office',
      { nativeCalls: false },
    );
    expect(gated[0]?.children.map((child) => child.id)).not.toContain('office');
    // With the child hidden there is nothing to light, so no row is active —
    // the sidebar never highlights a destination it did not render.
    expect(gated[0]?.children.some((child) => child.active)).toBe(false);

    const open = sortV4CompaniesConnectedFirst([baseCompany], 'indigo', 'office', {
      nativeCalls: true,
    });
    expect(
      open[0]?.children.filter((child) => child.active).map((child) => child.id),
    ).toEqual(['office']);
  });

  it('never expands children — Office included — for a pending invite', () => {
    const pending = { ...baseCompany, membershipStatus: 'pending' as const };
    const model = getV4SidebarModel(OFFICE_ROUTE, [pending], { nativeCalls: true });
    expect(model.companies[0]?.expanded).toBe(false);
    expect(model.companies[0]?.children).toEqual([]);
  });
});

describe('US-018 desktop: the Office route is a first-class company destination', () => {
  it('resolves and keys the office tab as a company child, not an operations tab', () => {
    expect(resolvePendingDesktopRoute('company:indigo:office')).toEqual({
      kind: 'company',
      slug: 'indigo',
      tab: 'office',
    });
    expect(fromV4Route(OFFICE_ROUTE)).toEqual({
      kind: 'company',
      slug: 'indigo',
      tab: 'office',
    });
    expect(companyPrimarySectionForTab('office')).toBe('office');
    expect(companyTabForPrimarySection('office')).toBe('office');
    // Office must NOT be swept into the More operations workspace.
    expect(isCompanyOperationsTab('office')).toBe(false);
    expect(COMPANY_SECTIONS.map((section) => section.id)).toContain('office');
    expect(COMPANY_PRIMARY_SECTIONS.map((section) => section.id)).toContain(
      'office',
    );
  });

  it('leaves route resolution capability-blind, so the refusal has to come from the panel', () => {
    // Documented on purpose: `resolvePendingDesktopRoute` / `fromV4Route` take
    // no capabilities, so a deep link to office still resolves on a host with
    // no native calling. That is safe ONLY because the sidebar never offers the
    // destination (above) and OfficePanel refuses in its own voice (below).
    // If a capability-aware route guard is ever added, tighten this test.
    expect(resolvePendingDesktopRoute('company:indigo:office')?.kind).toBe(
      'company',
    );
  });
});

describe('US-018 desktop: OfficePanel host-level states', () => {
  const RUN_AT = Date.parse((serviceEvidence as { runAt: string }).runAt);
  let host: HTMLDivElement | null = null;
  let component: ReturnType<typeof mount> | null = null;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    tauri.invoke.mockReset();
  });

  afterEach(() => {
    if (component) unmount(component);
    component = null;
    host?.remove();
    host = null;
    vi.useRealTimers();
  });

  function render(props: Record<string, unknown>): HTMLElement {
    host = document.createElement('div');
    document.body.appendChild(host);
    component = mount(OfficePanel, { target: host, props: props as never });
    flushSync();
    return host;
  }

  async function settle(): Promise<void> {
    for (let i = 0; i < 40; i += 1) {
      await Promise.resolve();
      await tick();
      flushSync();
    }
  }

  function testid(root: HTMLElement, id: string): HTMLElement | null {
    return root.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  }

  it('says the company is not connected instead of opening an office for nobody', async () => {
    vi.setSystemTime(RUN_AT + 60_000);
    const invokeFn = vi.fn(async () => null as unknown);
    const root = render({
      companyUid: null,
      companyLabel: 'Indigo',
      invokeFn,
    });
    await settle();

    expect(testid(root, 'office-not-connected')?.textContent).toContain(
      'Indigo is not connected to HQ cloud',
    );
    expect(testid(root, 'office-not-connected')?.textContent).toContain(
      'Connect this company',
    );
    // No office view, and — the authorization point — no host traffic at all.
    expect(testid(root, 'office-self')).toBeNull();
    expect(invokeFn).not.toHaveBeenCalled();
  });

  it('refuses in its own voice, and makes no authorized call, when the device is not verified', async () => {
    // The bundled US-011 receipt is stale past its OWN max age
    // (BUNDLED_EVIDENCE_MAX_AGE_MS, 90 days — a bundled artifact cannot
    // refresh itself, so it gets an explicit lifetime rather than the 30-day
    // per-session default). The adapter's preflight gate closes, and the panel
    // must surface that rather than reaching hq-pro with an unverified build.
    vi.setSystemTime(RUN_AT + 100 * 24 * 60 * 60 * 1000);
    const invokeFn = vi.fn(async () => null as unknown);
    const root = render({
      companyUid: 'cmp_indigo',
      companyLabel: 'Indigo',
      invokeFn,
    });
    await settle();

    const refusal = testid(root, 'office-host-refusal');
    expect(refusal?.textContent).toContain('Office hours are unavailable');
    expect(refusal?.textContent).toContain(
      'Calling is not verified on this device yet',
    );
    expect(testid(root, 'office-self')).toBeNull();
    expect(testid(root, 'office-list')).toBeNull();
    // Nothing authorized went out: no roster read, no identity probe.
    expect(
      invokeFn.mock.calls.filter(
        ([cmd]) => cmd === 'hq_pro_fetch' || cmd === 'whoami',
      ),
    ).toEqual([]);
  });

  it('refuses when the signed-in identity cannot be resolved, rather than loading an office as nobody', async () => {
    vi.setSystemTime(RUN_AT + 60_000);
    const invokeFn = vi.fn(async (cmd: string) => {
      if (cmd === 'get_auth_state') return { authenticated: false };
      return null as unknown;
    });
    const root = render({ companyUid: 'cmp_indigo', invokeFn });
    await settle();

    expect(testid(root, 'office-host-refusal')?.textContent).toContain(
      'Your HQ identity could not be resolved',
    );
    expect(
      invokeFn.mock.calls.some(([cmd]) => cmd === 'hq_pro_fetch'),
    ).toBe(false);
  });

  it('loads the company office through the authorized seam and explains a refusing call window', async () => {
    vi.setSystemTime(RUN_AT + 60_000);
    const fetched: Array<{ url: string; method: string }> = [];
    let openWindowCalls = 0;
    const invokeFn = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'get_auth_state') {
        return { authenticated: true, accountId: 'prs_self', email: 'a@b.c' };
      }
      if (cmd === 'whoami') return { personUid: 'prs_self', email: 'a@b.c' };
      if (cmd === 'device_fingerprint') return 'device-1';
      if (cmd === 'calls_open_window') {
        openWindowCalls += 1;
        throw new Error('the call window refused to open');
      }
      if (cmd === 'hq_pro_fetch') {
        const url = String(args?.url ?? '');
        const method = String(args?.method ?? '');
        fetched.push({ url, method });
        if (url.startsWith('/v1/meet-native/office')) {
          return {
            status: 200,
            body: JSON.stringify({
              companyUid: 'cmp_indigo',
              observedAt: Date.now(),
              people: [
                {
                  personUid: 'prs_self',
                  connectivity: 'online',
                  willingness: 'knock',
                },
                {
                  personUid: 'prs_mate',
                  connectivity: 'online',
                  willingness: 'dnd',
                  occupancy: 'occupied',
                },
              ],
            }),
          };
        }
        if (url === '/v1/meet-native/rooms') {
          return {
            status: 200,
            body: JSON.stringify({
              room: { roomId: 'room_1' },
              call: { callId: 'call_1', epoch: 4 },
            }),
          };
        }
        return { status: 404, body: JSON.stringify({ code: 'NOT_FOUND' }) };
      }
      return null as unknown;
    });

    const root = render({ companyUid: 'cmp_indigo', invokeFn });
    await settle();

    // The roster came from the authorized office route, scoped to THIS company.
    expect(fetched[0]).toEqual({
      url: '/v1/meet-native/office?companyUid=cmp_indigo&limit=25',
      method: 'GET',
    });
    expect(testid(root, 'office-host-refusal')).toBeNull();
    expect(testid(root, 'office-row-prs_mate')).not.toBeNull();
    // Still three separate facts once it reaches the desktop host.
    expect(testid(root, 'office-connectivity-prs_mate')?.textContent).toContain(
      'Reachable',
    );
    expect(
      testid(root, 'office-willingness-badge-prs_mate')?.textContent,
    ).toContain('Do not disturb');
    expect(testid(root, 'office-occupancy-prs_mate')?.textContent).toContain(
      'In a room',
    );
    // A private room without a permitted payload offers no door in.
    expect(testid(root, 'office-open-room-prs_mate')).toBeNull();
    expect(testid(root, 'office-action-error')).toBeNull();

    // Start a room from the keyboard; the native window seam refuses.
    const start = testid(root, 'office-start-room') as HTMLButtonElement;
    expect(start.tagName).toBe('BUTTON');
    start.focus();
    expect(document.activeElement).toBe(start);
    start.click();
    await settle();

    expect(
      fetched.some((call) => call.url === '/v1/meet-native/rooms'),
    ).toBe(true);
    expect(openWindowCalls).toBe(1);
    const error = testid(root, 'office-action-error');
    expect(error?.getAttribute('role')).toBe('alert');
    expect(error?.textContent).toContain('The call window could not be opened');
    // The surface stays usable — the failure is reported, not terminal.
    expect((testid(root, 'office-start-room') as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it('scopes every office read to the company it is mounted for, with no roster carried across', async () => {
    vi.setSystemTime(RUN_AT + 60_000);
    const asked: string[] = [];
    const invokeFn = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'get_auth_state') {
        return { authenticated: true, accountId: 'prs_self' };
      }
      if (cmd === 'whoami') return { personUid: 'prs_self' };
      if (cmd === 'device_fingerprint') return 'device-1';
      if (cmd === 'hq_pro_fetch') {
        const url = String(args?.url ?? '');
        const company = url.includes('cmp_b') ? 'cmp_b' : 'cmp_a';
        asked.push(url);
        return {
          status: 200,
          body: JSON.stringify({
            companyUid: company,
            observedAt: Date.now(),
            people: [
              { personUid: 'prs_self', connectivity: 'online', willingness: 'knock' },
              {
                personUid: company === 'cmp_a' ? 'prs_only_a' : 'prs_only_b',
                connectivity: 'online',
                willingness: 'open',
                occupancy: 'occupied',
                room: {
                  roomId: `room_${company}`,
                  callId: `call_${company}`,
                  epoch: 1,
                  participants: [company === 'cmp_a' ? 'prs_only_a' : 'prs_only_b'],
                },
              },
            ],
          }),
        };
      }
      return null as unknown;
    });

    const first = render({ companyUid: 'cmp_a', invokeFn });
    await settle();
    expect(testid(first, 'office-row-prs_only_a')).not.toBeNull();

    // Leaving the company tears the panel — and its store — down completely.
    unmount(component!);
    component = null;
    first.remove();

    const second = render({ companyUid: 'cmp_b', invokeFn });
    await settle();

    // Every read named its own company explicitly; nothing was reused, and no
    // read for the company we left happened after the switch.
    expect(asked.length).toBeGreaterThanOrEqual(2);
    for (const url of asked) {
      expect(url).toMatch(
        /^\/v1\/meet-native\/office\?companyUid=cmp_[ab]&limit=25$/,
      );
    }
    const order = asked.map((url) => (url.includes('cmp_b') ? 'cmp_b' : 'cmp_a'));
    expect(order[0]).toBe('cmp_a');
    expect(order[order.length - 1]).toBe('cmp_b');
    expect(order.indexOf('cmp_b')).toBeGreaterThan(order.lastIndexOf('cmp_a'));
    expect(testid(second, 'office-row-prs_only_b')).not.toBeNull();
    expect(testid(second, 'office-row-prs_only_a')).toBeNull();
    // No company-A private room data survived the transition.
    const rendered = second.textContent ?? '';
    expect(rendered).not.toContain('prs_only_a');
    expect(rendered).not.toContain('room_cmp_a');
    expect(rendered).not.toContain('call_cmp_a');
  });
});


describe('US-018 desktop: Office is reachable in the shell that actually ships', () => {
  it('mounts only HqWorkWorkShell, so that tree is the one that must offer Office', () => {
    const main = repoFile('src/desktop-alt/main.ts');
    expect(main).toContain("import('./HqWorkWorkShell.svelte')");
    expect(main).not.toContain("import('./DesktopApp.svelte')");
  });

  it('gates the shipping company tab list on the adapter capability', () => {
    // Same rule as the desktop-alt sidebar above, applied to the tabs the
    // shipping shell renders — and closed by default.
    expect(companyChannelTabsFor().map((tab) => tab.id)).not.toContain('office');
    expect(
      companyChannelTabsFor({ nativeCalls: false }).map((tab) => tab.id),
    ).not.toContain('office');
    expect(
      companyChannelTabsFor({ nativeCalls: true }).map((tab) => tab.id),
    ).toContain('office');
  });

  it('renders the one shared Office panel from the shipping shell', () => {
    const desktopApp = repoFile('../../packages/ui/src/shell/DesktopApp.svelte');
    expect(desktopApp).toContain(
      'import OfficePanel from "../meet/OfficePanel.svelte"',
    );
    expect(desktopApp).toContain('{#if companyTab === "office"}');
    expect(desktopApp).toContain('tabs={companyTabsForHost}');
    // Both halves of the seam reach the panel, or it can neither preflight nor
    // open a window.
    const mountBlock = desktopApp.slice(
      desktopApp.indexOf('<OfficePanel'),
      desktopApp.indexOf('<OfficePanel') + 400,
    );
    expect(mountBlock).toContain('{adapter}');
    expect(mountBlock).toContain('{callsHost}');
  });

  it('carries the native calling seams down the shipping host chain', () => {
    expect(repoFile('src/desktop-alt/HqWorkWorkShell.svelte')).toContain(
      'callsHost={capabilities.calls}',
    );
    expect(repoFile('../../apps/work/src/lib/WorkShell.svelte')).toContain(
      '{callsHost}',
    );
  });

  it('keeps desktop-alt as a binding to that panel, never a second copy', () => {
    const alt = repoFile('src/desktop-alt/panels/OfficePanel.svelte');
    expect(alt).toContain('<meet.OfficePanel');
    expect(alt).not.toContain('createOfficeStore');
  });
});
