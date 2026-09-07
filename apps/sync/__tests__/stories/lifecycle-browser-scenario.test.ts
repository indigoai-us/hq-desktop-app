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

  it('#setup summary: Create another company posts a fresh create_company card (404 before any company)', async () => {
    const { invokeFn, inspect } = createLifecycleInvoke({ delayScale: 0 });
    // No company yet → the server has no summary card to act on.
    await expect(
      invokeFn('run_card_action', {
        channelId: SETUP_CHANNEL_ID,
        cardId: 'companies_summary',
        actionId: 'create_company',
        values: {},
      }),
    ).rejects.toThrow(/404/);

    await invokeFn('run_card_action', {
      channelId: SETUP_CHANNEL_ID,
      cardId: 'card_create_company',
      actionId: 'submit',
      values: { name: 'Ramen Bae', slug: 'ramen-bae' },
    });
    const summary = cards(inspect.messages(SETUP_CHANNEL_ID))
      .map(parseLifecycleCard)
      .find((c) => c?.cardKind === 'companies_summary');
    expect(summary, 'summary card parses').toBeTruthy();
    expect(summary?.cardId).toBe('companies_summary');
    expect(summary?.actions).toEqual([
      { id: 'create_company', label: 'Create another company', style: 'primary', href: null },
    ]);
    expect(summary?.fields.map((f) => f.label)).toEqual(['Ramen Bae']);

    const posted = (await invokeFn('run_card_action', {
      channelId: SETUP_CHANNEL_ID,
      cardId: 'companies_summary',
      actionId: 'create_company',
      values: {},
    })) as { cardId: string; channelId: string; state: string };
    expect(posted.channelId).toBe(SETUP_CHANNEL_ID);
    expect(posted.cardId).toMatch(/^card_create_company_\d+$/);
    expect(posted.state).toBe('open');
    const fresh = cards(inspect.messages(SETUP_CHANNEL_ID))
      .map(parseLifecycleCard)
      .find((c) => c?.cardId === posted.cardId);
    expect(fresh?.cardKind).toBe('create_company');
    expect(fresh?.state).toBe('open');

    // Submitting it mints a second company channel and grows the summary.
    const created = (await invokeFn('run_card_action', {
      channelId: SETUP_CHANNEL_ID,
      cardId: posted.cardId,
      actionId: 'submit',
      values: { name: 'Second Co', slug: 'second-co' },
    })) as { state: string; companyUid: string };
    expect(created.state).toBe('done');
    expect(inspect.channels().some((c) => c.companyUid === created.companyUid)).toBe(true);
    const grown = cards(inspect.messages(SETUP_CHANNEL_ID))
      .map(parseLifecycleCard)
      .find((c) => c?.cardKind === 'companies_summary');
    expect(grown?.fields.map((f) => f.label)).toEqual(['Ramen Bae', 'Second Co']);
    // Every envelope still round-trips the parser.
    for (const envelope of cards(inspect.messages(SETUP_CHANNEL_ID))) {
      expect(parseSystemEvent(envelope), JSON.stringify(envelope)).not.toBeNull();
    }
  });

  it('Team tab add_agent: upgrade card on Starter, create_agent on Workforce, blocked for members', async () => {
    const { invokeFn, inspect } = createLifecycleInvoke({ delayScale: 0 });
    await invokeFn('run_card_action', {
      channelId: SETUP_CHANNEL_ID,
      cardId: 'card_create_company',
      actionId: 'submit',
      values: { name: 'Ramen Bae', slug: 'ramen-bae' },
    });
    await vi.waitFor(() => {
      const company = cards(inspect.messages(COMPANY_CHANNEL_ID)).map(parseLifecycleCard);
      expect(company.find((c) => c?.cardKind === 'upgrade_plan')?.state).toBe('open');
    });
    const team = parseCompanyTab(inspect.tab('team'));
    const spend = team?.sections[1]?.rows.find((r) => r.cardId === 'team:spend');
    expect(spend?.actions.map((a) => a.id)).toEqual(['add_agent']);

    // Starter: the (already open) upgrade card is resurfaced, not duplicated.
    const onStarter = (await invokeFn('run_company_tab_action', {
      companyUid: 'cmp_ramen_bae',
      tab: 'team',
      cardId: 'team:spend',
      actionId: 'add_agent',
      values: {},
    })) as { channelId: string; cardId: string; state: string };
    expect(onStarter.channelId).toBe(COMPANY_CHANNEL_ID);
    expect(onStarter.cardId).toBe('card_upgrade_plan');
    expect(
      cards(inspect.messages(COMPANY_CHANNEL_ID)).filter((c) => c.kind === 'upgrade_plan'),
    ).toHaveLength(1);

    await invokeFn('run_card_action', {
      channelId: COMPANY_CHANNEL_ID,
      cardId: 'card_upgrade_plan',
      actionId: 'checkout',
      values: { plan: 'workforce' },
    });
    await vi.waitFor(() => {
      const company = cards(inspect.messages(COMPANY_CHANNEL_ID)).map(parseLifecycleCard);
      expect(company.find((c) => c?.cardId === 'card_create_agent_1')?.state).toBe('open');
    });
    // Workforce with an open create_agent card: point at it.
    const resurfaced = (await invokeFn('run_company_tab_action', {
      companyUid: 'cmp_ramen_bae',
      tab: 'team',
      cardId: 'team:spend',
      actionId: 'add_agent',
      values: {},
    })) as { channelId: string; cardId: string };
    expect(resurfaced).toMatchObject({ channelId: COMPANY_CHANNEL_ID, cardId: 'card_create_agent_1' });

    // Finish that agent, then Add agent posts a fresh, uniquely-id'd turn 1.
    await invokeFn('run_card_action', { channelId: COMPANY_CHANNEL_ID, cardId: 'card_create_agent_1', actionId: 'next', values: { name: 'Polar', handle: 'polar' } });
    await invokeFn('run_card_action', { channelId: COMPANY_CHANNEL_ID, cardId: 'card_create_agent_2', actionId: 'next', values: { runtime: 'codex' } });
    await invokeFn('run_card_action', { channelId: COMPANY_CHANNEL_ID, cardId: 'card_create_agent_3', actionId: 'create', values: { size: 'basic' } });
    const another = (await invokeFn('run_company_tab_action', {
      companyUid: 'cmp_ramen_bae',
      tab: 'team',
      cardId: 'team:spend',
      actionId: 'add_agent',
      values: {},
    })) as { channelId: string; cardId: string };
    expect(another.channelId).toBe(COMPANY_CHANNEL_ID);
    expect(another.cardId).toMatch(/^card_create_agent_1_\d+$/);
    const fresh = cards(inspect.messages(COMPANY_CHANNEL_ID)).map(parseLifecycleCard).find((c) => c?.cardId === another.cardId);
    expect(fresh?.cardKind).toBe('create_agent');
    expect(fresh?.state).toBe('open');
    // The next turn keeps the suffix so the ids never collide with the first run.
    await invokeFn('run_card_action', { channelId: COMPANY_CHANNEL_ID, cardId: another.cardId, actionId: 'next', values: { name: 'Nova', handle: 'nova' } });
    await vi.waitFor(() => {
      const ids = cards(inspect.messages(COMPANY_CHANNEL_ID)).map((c) => String(c.cardId));
      expect(ids).toContain(another.cardId.replace('card_create_agent_1', 'card_create_agent_2'));
    });

    // Members get a blocked result with a reason, not a thrown error.
    const member = createLifecycleInvoke({ role: 'member' });
    const blocked = (await member.invokeFn('run_company_tab_action', {
      companyUid: 'cmp_ramen_bae',
      tab: 'team',
      cardId: 'team:spend',
      actionId: 'add_agent',
      values: {},
    })) as { state: string; reason: string };
    expect(blocked.state).toBe('blocked');
    expect(blocked.reason).toMatch(/owners/i);
    const memberTeam = parseCompanyTab(member.inspect.tab('team'));
    expect(memberTeam?.sections[1]?.rows.find((r) => r.cardId === 'team:spend')?.actions).toEqual([]);
  });

  it('pending checkout keeps retry/cancel actions; cancel returns the card to open; retry answers a url', async () => {
    // Real timers: the abandoned checkout must NOT flip to done after cancel.
    const owner = createLifecycleInvoke({ delayScale: 1 });
    await owner.invokeFn('run_card_action', {
      channelId: SETUP_CHANNEL_ID,
      cardId: 'card_create_company',
      actionId: 'submit',
      values: { name: 'Ramen Bae', slug: 'ramen-bae' },
    });
    await vi.waitFor(
      () => {
        const company = cards(owner.inspect.messages(COMPANY_CHANNEL_ID)).map(parseLifecycleCard);
        expect(company.find((c) => c?.cardKind === 'upgrade_plan')?.state).toBe('open');
      },
      { timeout: 8_000 },
    );
    const started = (await owner.invokeFn('run_card_action', {
      channelId: COMPANY_CHANNEL_ID,
      cardId: 'card_upgrade_plan',
      actionId: 'checkout',
      values: { plan: 'workforce' },
    })) as { state: string; url?: string };
    expect(started.state).toBe('pending');
    expect(started.url).toMatch(/^https:\/\//);
    const pending = cards(owner.inspect.messages(COMPANY_CHANNEL_ID))
      .map(parseLifecycleCard)
      .find((c) => c?.cardId === 'card_upgrade_plan');
    expect(pending?.state).toBe('pending');
    expect(pending?.actions.map((a) => `${a.id}:${a.style}`)).toEqual([
      'retry_checkout:secondary',
      'cancel_checkout:secondary',
    ]);

    const retried = (await owner.invokeFn('run_card_action', {
      channelId: COMPANY_CHANNEL_ID,
      cardId: 'card_upgrade_plan',
      actionId: 'retry_checkout',
      values: {},
    })) as { state: string; url?: string };
    expect(retried.state).toBe('pending');
    expect(retried.url).toBe(started.url);

    const cancelled = (await owner.invokeFn('run_card_action', {
      channelId: COMPANY_CHANNEL_ID,
      cardId: 'card_upgrade_plan',
      actionId: 'cancel_checkout',
      values: {},
    })) as { state: string };
    expect(cancelled.state).toBe('open');
    const reopened = cards(owner.inspect.messages(COMPANY_CHANNEL_ID))
      .map(parseLifecycleCard)
      .find((c) => c?.cardId === 'card_upgrade_plan');
    expect(reopened?.state).toBe('open');
    expect(reopened?.actions.map((a) => a.id)).toEqual(['checkout', 'stay']);
    // The abandoned checkout never flips the card to done.
    await new Promise((resolve) => setTimeout(resolve, 1700));
    const later = cards(owner.inspect.messages(COMPANY_CHANNEL_ID))
      .map(parseLifecycleCard)
      .find((c) => c?.cardId === 'card_upgrade_plan');
    expect(later?.state).toBe('open');
  }, 15_000);

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
