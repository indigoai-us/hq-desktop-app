// @vitest-environment happy-dom
/**
 * `?view=lifecycle` harness scenario — headless check that the in-memory
 * backend speaks the exact wire shapes the shell's parsers accept (an unknown
 * shape renders nothing) and that the production shell boots against it,
 * paints the #setup create_company card, and walks the flow.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('svelte', async () => {
  // @ts-expect-error client entry has no public type export.
  return await import('../../node_modules/svelte/src/index-client.js');
});

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => null),
}));

vi.mock('@tauri-apps/api/event', async () => {
  // The scenario drives the shell through the same mocked event bus the
  // browser harness uses, so the host's native-wake listeners must be live.
  return await import('../../dev-harness/mocks/event');
});

vi.mock('@tauri-apps/api/app', () => ({
  getVersion: vi.fn(async () => '0.10.191'),
  setTheme: vi.fn(async () => {}),
}));

import { flushSync, mount, unmount } from 'svelte';
import {
  parseLifecycleCard,
  parseSystemEvent,
} from '../../../../packages/ui/src/chat/messaging/channelMessageModels';
import { parseCompanyTab } from '../../../../packages/ui/src/chat/tabs/tab-model';
import HqWorkWorkShell from '../../src/desktop-alt/HqWorkWorkShell.svelte';
import {
  AGENT_CHANNEL_ID,
  COMPANY_CHANNEL_ID,
  SETUP_CHANNEL_ID,
  createLifecycleInvoke,
  resolveLifecycleOptions,
} from '../../dev-harness/lifecycle-scenario';

async function flush(times = 48): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
  flushSync();
}

let host: HTMLElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  try {
    window.localStorage?.clear?.();
  } catch {
    /* Node 22 may not expose localStorage in this worker */
  }
});

function cards(rows: Array<{ systemEvent?: unknown }>) {
  return rows
    .map((row) => row.systemEvent)
    .filter((event) => event !== undefined);
}

describe('lifecycle scenario wire shapes', () => {
  it('parses ?role= and ?state= from the harness query', () => {
    expect(resolveLifecycleOptions('?view=lifecycle')).toEqual({ role: 'owner', state: 'default' });
    expect(resolveLifecycleOptions('?view=lifecycle&role=member').role).toBe('member');
    expect(resolveLifecycleOptions('view=lifecycle&state=blocked').state).toBe('blocked');
    expect(resolveLifecycleOptions('?role=admin&state=nope')).toEqual({ role: 'owner', state: 'default' });
  });

  it('every seeded card in every variant survives parseSystemEvent', () => {
    for (const options of [
      { role: 'owner', state: 'default' },
      { role: 'member', state: 'default' },
      { role: 'owner', state: 'blocked' },
    ] as const) {
      const { inspect } = createLifecycleInvoke(options);
      for (const channelId of [SETUP_CHANNEL_ID, COMPANY_CHANNEL_ID, AGENT_CHANNEL_ID]) {
        for (const envelope of cards(inspect.messages(channelId))) {
          const parsed = parseSystemEvent(envelope);
          expect(parsed, JSON.stringify(envelope)).not.toBeNull();
          expect(parsed?.kind).toBe('lifecycle_card');
          if (options.role === 'member' && parsed?.kind === 'lifecycle_card') {
            expect(parsed.viewer.canAct).toBe(false);
            expect(parsed.viewer.actorName).toBe('Corey Epstein');
          }
        }
      }
    }
  });

  it('blocked variant seeds handle-taken, provisioning-failed, and needs-Workforce', () => {
    const { inspect } = createLifecycleInvoke({ state: 'blocked' });
    const setup = cards(inspect.messages(SETUP_CHANNEL_ID)).map(parseLifecycleCard);
    expect(setup[0]?.state).toBe('blocked');
    expect(setup[0]?.fields.find((f) => f.id === 'slug')?.error).toMatch(/taken/);
    const company = cards(inspect.messages(COMPANY_CHANNEL_ID)).map(parseLifecycleCard);
    expect(company.find((c) => c?.cardKind === 'activate_cloud')?.reason).toMatch(/bucket/);
    const agent = company.find((c) => c?.cardKind === 'create_agent');
    expect(agent?.state).toBe('blocked');
    expect(agent?.reason).toMatch(/Workforce/);
    const status = cards(inspect.messages(AGENT_CHANNEL_ID)).map(parseLifecycleCard);
    expect(status[0]?.state).toBe('blocked');
  });

  it('every company tab parses with realistic rows and honours the member view', () => {
    for (const role of ['owner', 'member'] as const) {
      const { inspect } = createLifecycleInvoke({ role });
      const team = parseCompanyTab(inspect.tab('team'));
      expect(team).not.toBeNull();
      expect(team?.sections.map((s) => s.id)).toEqual(['humans', 'agents', 'permissions']);
      // 2 humans + the invite row.
      expect(team?.sections[0]?.rows).toHaveLength(3);
      const integrations = parseCompanyTab(inspect.tab('integrations'));
      expect(integrations?.sections[0]?.rows).toHaveLength(3);
      expect(integrations?.sections[1]?.rows).toHaveLength(5);
      const settings = parseCompanyTab(inspect.tab('settings'));
      expect(settings?.sections.map((s) => s.id)).toEqual(['general', 'billing', 'cloud', 'danger']);
      expect(settings?.appearance?.wallpaper).toBe('aurora');
      const atlas = parseCompanyTab(inspect.tab('atlas'));
      expect(atlas?.graph?.nodes.length).toBeGreaterThanOrEqual(5);
      for (const tab of [team, integrations, settings]) {
        expect(tab?.viewer.canAct).toBe(role === 'owner');
        for (const section of tab?.sections ?? []) {
          for (const row of section.rows) {
            expect(row.viewer.canAct).toBe(role === 'owner');
          }
        }
      }
    }
  });

  it('walks create_company → cloud → plan → agent with zero delay', async () => {
    const { invokeFn, inspect } = createLifecycleInvoke({ delayScale: 0 });
    const create = (await invokeFn('run_card_action', {
      channelId: SETUP_CHANNEL_ID,
      cardId: 'card_create_company',
      actionId: 'submit',
      values: { name: 'Ramen Bae', slug: 'ramen-bae' },
    })) as { state: string };
    expect(create.state).toBe('done');
    expect(inspect.channels().some((c) => c.channelId === COMPANY_CHANNEL_ID)).toBe(true);
    await vi.waitFor(() => {
      const company = cards(inspect.messages(COMPANY_CHANNEL_ID)).map(parseLifecycleCard);
      expect(company.find((c) => c?.cardKind === 'activate_cloud')?.state).toBe('done');
      expect(company.find((c) => c?.cardKind === 'upgrade_plan')?.state).toBe('open');
    });

    await invokeFn('run_card_action', {
      channelId: COMPANY_CHANNEL_ID,
      cardId: 'card_upgrade_plan',
      actionId: 'checkout',
      values: { plan: 'workforce' },
    });
    await vi.waitFor(() => {
      const company = cards(inspect.messages(COMPANY_CHANNEL_ID)).map(parseLifecycleCard);
      expect(company.find((c) => c?.cardKind === 'upgrade_plan')?.state).toBe('done');
      expect(company.find((c) => c?.cardId === 'card_create_agent_1')?.state).toBe('open');
    });

    await invokeFn('run_card_action', {
      channelId: COMPANY_CHANNEL_ID,
      cardId: 'card_create_agent_1',
      actionId: 'next',
      values: { name: 'Polar', handle: 'polar' },
    });
    await invokeFn('run_card_action', {
      channelId: COMPANY_CHANNEL_ID,
      cardId: 'card_create_agent_2',
      actionId: 'next',
      values: { runtime: 'codex' },
    });
    const created = (await invokeFn('run_card_action', {
      channelId: COMPANY_CHANNEL_ID,
      cardId: 'card_create_agent_3',
      actionId: 'create',
      values: { size: 'basic' },
    })) as { agentChannelId?: string };
    expect(created.agentChannelId).toBe(AGENT_CHANNEL_ID);
    const agentRow = inspect.channels().find((c) => c.channelId === AGENT_CHANNEL_ID);
    expect(agentRow?.members?.some((m) => m.personUid.startsWith('agt_'))).toBe(true);
    await vi.waitFor(() => {
      const rows = inspect.messages(AGENT_CHANNEL_ID);
      expect(parseLifecycleCard(rows[0]?.systemEvent)?.state).toBe('done');
      expect(rows.at(-1)?.fromPersonUid).toBe('agt_polar');
    });
    // Team tab now lists the agent.
    const team = parseCompanyTab(inspect.tab('team'));
    expect(team?.sections[1]?.rows.some((r) => r.cardId === 'team:agent:agt_polar')).toBe(true);
  });

  it('member role refuses card actions', async () => {
    const { invokeFn } = createLifecycleInvoke({ role: 'member' });
    await expect(
      invokeFn('run_card_action', {
        channelId: COMPANY_CHANNEL_ID,
        cardId: 'card_upgrade_plan',
        actionId: 'checkout',
        values: {},
      }),
    ).rejects.toThrow(/owners/i);
  });
});

describe('desktop shell boots the lifecycle scenario', () => {
  it('paints #setup with the create_company card and fires shell_ready', async () => {
    const { invokeFn, calls } = createLifecycleInvoke({ delayScale: 0 });
    host = document.createElement('div');
    document.body.appendChild(host);
    component = mount(HqWorkWorkShell, {
      target: host,
      props: { invokeFn, bootTimeoutMs: 40 },
    });
    await flush();
    expect(host.querySelector('[data-testid="hq-work-identity-error"]')).toBeNull();
    await vi.waitFor(
      () => {
        expect(host.querySelector('[data-testid="channel-skeleton"]')).toBeNull();
        expect(host.querySelector('[data-testid="setup-channel-intro"]')).toBeTruthy();
        const card = host.querySelector('[data-testid="lifecycle-card"]');
        expect(card?.getAttribute('data-card-kind')).toBe('create_company');
        expect(card?.getAttribute('data-state')).toBe('open');
        expect(calls).toContain('shell_ready');
      },
      { timeout: 5_000 },
    );
  }, 15_000);
});
