/**
 * Channel-native company lifecycle — stateful browser scenario.
 *
 * `?view=lifecycle` mounts the production HqWorkWorkShell against this
 * in-memory backend so a human can click the whole flow before anything is
 * deployed:
 *
 *   #setup  → create_company card → #ramen-bae company channel is minted
 *           → activate_cloud (pending → done) → upgrade_plan (radio rows)
 *           → create_agent (3 turns) → Polar agent channel (status → hello).
 *
 * Variants:
 *   ?view=lifecycle&role=member    every card / tab row has viewer.canAct=false
 *   ?view=lifecycle&state=blocked  handle taken · provisioning failed · needs Workforce
 *
 * Entry points (sidebar "+" → New company / New agent, company switcher →
 * New company, company header → Add agent, #setup summary → Create another
 * company) run the same server actions the real backend exposes:
 *   run_card_action        setup / companies_summary / create_company
 *                          → posts a fresh create_company card, answers
 *                            { cardId, channelId: 'setup' } (404 before any
 *                            company exists — the seeded card is already there)
 *   run_company_tab_action team / team:spend / add_agent
 *                          → posts (or resurfaces) create_agent on Workforce,
 *                            the upgrade card on Starter, answers
 *                            { channelId, cardId }; members get state: blocked
 * The plan step's pending (checkout) state carries retry_checkout / cancel_checkout.
 *
 * Wire shapes follow `parseLifecycleCard` / `parseCompanyTab` exactly; an
 * unknown shape renders nothing, so every envelope here is round-tripped by
 * `lifecycle-scenario.test.ts`.
 *
 * Live updates use the same seams the Tauri host uses: the scenario mutates
 * its message store and emits the native `channel:new-message` /
 * `channel:unread-changed` events (mocks/event.ts), and the shell re-fetches
 * through `fetch_channel` / `hq_pro_fetch` like it does against Rust.
 */
import type { SyncInvokeFn } from '@hq/platform';
import { emit } from './mocks/event';
import { invoke as baseInvoke } from './mocks/core';

export type LifecycleRole = 'owner' | 'member';
export type LifecycleState = 'default' | 'blocked';

export interface LifecycleOptions {
  role?: LifecycleRole;
  state?: LifecycleState;
  /** Timer scale — tests pass 0 so pending → done flips resolve immediately. */
  delayScale?: number;
}

export const COMPANY_UID = 'cmp_ramen_bae';
export const COMPANY_CHANNEL_ID = 'chn_ramen_bae';
export const AGENT_CHANNEL_ID = 'chn_polar';
export const AGENT_UID = 'agt_polar';
export const SETUP_CHANNEL_ID = 'setup';

const OWNER = {
  personUid: 'prs_corey',
  email: 'corey@ramenbae.co',
  displayName: 'Corey Epstein',
};
const MEMBER = {
  personUid: 'prs_jacob',
  email: 'jacob@ramenbae.co',
  displayName: 'Jacob Posel',
};

type Json = Record<string, unknown>;

interface Message {
  eventId: string;
  fromPersonUid: string | null;
  fromDisplayName: string;
  fromEmail?: string | null;
  body: string;
  createdAt: string;
  direction: 'in' | 'out';
  messageKind?: 'system';
  systemEvent?: Json;
}

interface ChannelRow extends Json {
  channelId: string;
  name: string;
  scope: string;
  companyUid?: string;
  companyName?: string;
  visibility: string;
  membership: string;
  unread: number;
  memberCount: number;
  lastActivityAt: string;
  members?: Array<{ personUid: string; displayName: string }>;
}

export function resolveLifecycleOptions(search: string | null | undefined): LifecycleOptions {
  const raw = (search ?? '').startsWith('?') ? (search ?? '').slice(1) : (search ?? '');
  const params = new URLSearchParams(raw);
  return {
    role: params.get('role') === 'member' ? 'member' : 'owner',
    state: params.get('state') === 'blocked' ? 'blocked' : 'default',
  };
}

export function createLifecycleInvoke(options: LifecycleOptions = {}) {
  const role: LifecycleRole = options.role ?? 'owner';
  const variant: LifecycleState = options.state ?? 'default';
  const delayScale = options.delayScale ?? 1;
  const canAct = role === 'owner';
  const me = role === 'owner' ? OWNER : MEMBER;
  const viewer = canAct
    ? { canAct: true, role: 'owner' }
    : { canAct: false, role: 'member', actorName: OWNER.displayName };

  const calls: string[] = [];
  const channels: ChannelRow[] = [];
  const messages = new Map<string, Message[]>();
  const workspaces: Json[] = [
    {
      slug: 'personal',
      displayName: me.displayName,
      kind: 'personal',
      state: 'personal',
      cloudUid: 'cmp_personal',
      bucketName: 'hq-vault-personal',
      hasLocalFolder: true,
      localPath: '/Users/corey/Documents/HQ/personal',
      membershipStatus: null,
      role: null,
      lastSyncedAt: new Date().toISOString(),
      brokenReason: null,
      invitedBy: null,
      invitedAt: null,
    },
  ];
  let companyName = 'Ramen Bae';
  let plan: 'starter' | 'workforce' | 'enterprise' = 'starter';
  let eventSeq = 0;
  const humans: Array<{ uid: string; name: string; email: string; role: string }> = [
    { uid: OWNER.personUid, name: OWNER.displayName, email: OWNER.email, role: 'owner' },
    { uid: MEMBER.personUid, name: MEMBER.displayName, email: MEMBER.email, role: 'member' },
  ];
  let agentCreated = false;
  let agentSize: 'basic' | 'power' | 'dev' = 'basic';
  /** Companies created from the #setup summary ("Create another company"). */
  const extraCompanies: Array<{ uid: string; channelId: string; name: string; slug: string }> = [];
  let createCardSeq = 1;
  /** Bumped by cancel_checkout so an abandoned checkout never flips to done. */
  let checkoutToken = 0;
  const CHECKOUT_URL = 'https://checkout.stripe.com/c/pay/demo_ramen_bae';
  const agentDraft = { name: 'Polar', handle: 'polar', runtime: 'codex' };
  const integrations = {
    connected: [
      { id: 'slack', name: 'Slack', account: 'ramenbae.slack.com' },
      { id: 'github', name: 'GitHub', account: 'ramen-bae' },
      { id: 'gcal', name: 'Google Calendar', account: 'corey@ramenbae.co' },
    ],
    available: [
      { id: 'linear', name: 'Linear' },
      { id: 'notion', name: 'Notion' },
      { id: 'shopify', name: 'Shopify' },
      { id: 'klaviyo', name: 'Klaviyo' },
      { id: 'hubspot', name: 'HubSpot' },
    ],
  };

  // ── helpers ──────────────────────────────────────────────────────────────

  const nowIso = () => new Date(Date.now() + eventSeq).toISOString();
  const nextId = (prefix: string) => `${prefix}_${++eventSeq}`;
  const wait = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, Math.round(ms * delayScale)));

  function list(channelId: string): Message[] {
    let rows = messages.get(channelId);
    if (!rows) {
      rows = [];
      messages.set(channelId, rows);
    }
    return rows;
  }

  function bumpChannel(channelId: string, at: string): void {
    const row = channels.find((c) => c.channelId === channelId);
    if (row) row.lastActivityAt = at;
  }

  async function wake(channelId: string, eventId: string, createdAt: string): Promise<void> {
    await emit('channel:new-message', [{ channelId, eventId, createdAt }]);
  }

  /** Post a fresh system envelope (new eventId → the shell fetches `since`). */
  async function postCard(channelId: string, card: Json): Promise<Message> {
    const createdAt = nowIso();
    const message: Message = {
      eventId: nextId('evt'),
      fromPersonUid: null,
      fromDisplayName: 'HQ',
      body: cardFallbackBody(card),
      createdAt,
      direction: 'in',
      messageKind: 'system',
      systemEvent: card,
    };
    list(channelId).push(message);
    bumpChannel(channelId, createdAt);
    await wake(channelId, message.eventId, createdAt);
    return message;
  }

  async function postText(
    channelId: string,
    from: { personUid: string; displayName: string; email?: string },
    body: string,
  ): Promise<Message> {
    const createdAt = nowIso();
    const message: Message = {
      eventId: nextId('evt'),
      fromPersonUid: from.personUid,
      fromDisplayName: from.displayName,
      fromEmail: from.email ?? null,
      body,
      createdAt,
      direction: from.personUid === me.personUid ? 'out' : 'in',
    };
    list(channelId).push(message);
    bumpChannel(channelId, createdAt);
    await wake(channelId, message.eventId, createdAt);
    return message;
  }

  /** Rewrite a card in place (same eventId → the shell drops `since`). */
  async function patchCard(channelId: string, cardId: string, patch: Json): Promise<void> {
    const row = list(channelId).find((m) => m.systemEvent?.cardId === cardId);
    if (!row?.systemEvent) return;
    row.systemEvent = { ...row.systemEvent, ...patch };
    await wake(channelId, row.eventId, row.createdAt);
  }

  function cardFallbackBody(card: Json): string {
    return typeof card.title === 'string' ? card.title : 'Lifecycle update';
  }

  function card(
    kind: string,
    cardId: string,
    companyUid: string | null,
    state: string,
    extra: Json,
  ): Json {
    return {
      v: 1,
      type: 'lifecycle_card',
      cardId,
      kind,
      companyUid,
      state,
      viewer,
      ...extra,
    };
  }

  function openCompanyChannel(): void {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(
      new CustomEvent('hq:open-channel', {
        detail: {
          channelId: COMPANY_CHANNEL_ID,
          title: companyName,
          companyUid: COMPANY_UID,
          automatic: false,
        },
      }),
    );
  }

  // ── card envelopes ──────────────────────────────────────────────────────

  const createCompanyCard = (state: string, extra: Json = {}) =>
    card('create_company', 'card_create_company', null, state, {
      stepLabel: 'Step 1 of 3',
      title: 'Name your company',
      summary: 'This creates the company channel, vault, and team roster.',
      fields: [
        {
          id: 'name',
          label: 'Company name',
          control: 'text',
          required: true,
          value: '',
          hint: 'Shown in the sidebar and on invites.',
        },
        {
          id: 'slug',
          label: 'Handle',
          control: 'text',
          required: true,
          value: 'ramen-bae',
          hint: 'ramen-bae is available',
          description: 'Used for the channel name and vault path.',
        },
      ],
      actions: [{ id: 'submit', label: 'Create company', style: 'primary' }],
      ...extra,
    });

  const activateCloudCard = (state: string, extra: Json = {}) =>
    card('activate_cloud', 'card_activate_cloud', COMPANY_UID, state, {
      stepLabel: 'Step 2 of 3',
      title: 'Turning on cloud sync',
      summary: 'Provisioning the vault bucket, Work Mesh topics, and the team roster.',
      fields: [
        { id: 'bucket', label: 'Vault', control: 'readonly', value: 'hq-vault-ramen-bae' },
        { id: 'region', label: 'Region', control: 'readonly', value: 'us-west-2' },
      ],
      actions: [],
      ...extra,
    });

  const upgradePlanCard = (state: string, extra: Json = {}) =>
    card('upgrade_plan', 'card_upgrade_plan', COMPANY_UID, state, {
      stepLabel: 'Step 3 of 3',
      title: 'Choose a plan',
      summary: 'Agents, integrations, and cloud sessions unlock on Workforce.',
      fields: [
        {
          id: 'plan',
          label: 'Plan',
          control: 'radio',
          required: true,
          value: 'workforce',
          options: [
            {
              id: 'starter',
              label: 'Starter',
              description: 'Vault sync, channels, 3 seats.',
              price: 'Free',
            },
            {
              id: 'workforce',
              label: 'Workforce',
              description: 'Everything in Starter plus fleet agents and integrations.',
              price: '$500/mo flat',
            },
            {
              id: 'enterprise',
              label: 'Enterprise',
              description: 'SSO, audit log, dedicated Outpost, priority support.',
              price: 'Talk to us',
            },
          ],
        },
      ],
      actions: [
        { id: 'checkout', label: 'Continue to checkout', style: 'primary' },
        { id: 'stay', label: 'Stay on Starter', style: 'secondary' },
      ],
      ...extra,
    });

  const createAgentCard = (turn: 1 | 2 | 3, state: string, extra: Json = {}) => {
    const shared = {
      title: 'Create an agent',
      summary: 'A fleet agent gets its own channel, vault grants, and runtime.',
    };
    if (turn === 1) {
      return card('create_agent', 'card_create_agent_1', COMPANY_UID, state, {
        ...shared,
        stepLabel: 'Agent · 1 of 3',
        fields: [
          {
            id: 'name',
            label: 'Agent name',
            control: 'text',
            required: true,
            value: agentDraft.name,
          },
          {
            id: 'handle',
            label: 'Handle',
            control: 'text',
            required: true,
            value: agentDraft.handle,
            hint: '@polar is available',
          },
        ],
        actions: [{ id: 'next', label: 'Next', style: 'primary' }],
        ...extra,
      });
    }
    if (turn === 2) {
      return card('create_agent', 'card_create_agent_2', COMPANY_UID, state, {
        ...shared,
        stepLabel: 'Agent · 2 of 3',
        fields: [
          {
            id: 'runtime',
            label: 'Runtime',
            control: 'radio',
            required: true,
            value: agentDraft.runtime,
            options: [
              { id: 'claude', label: 'Claude Code', description: 'Anthropic · long-context sessions.' },
              { id: 'codex', label: 'Codex', description: 'OpenAI · fast background runs.' },
              { id: 'grok', label: 'Grok Build', description: 'xAI · headless implementation.' },
            ],
          },
        ],
        actions: [{ id: 'next', label: 'Next', style: 'primary' }],
        ...extra,
      });
    }
    return card('create_agent', 'card_create_agent_3', COMPANY_UID, state, {
      ...shared,
      stepLabel: 'Agent · 3 of 3',
      fields: [
        {
          id: 'size',
          label: 'Size',
          control: 'radio',
          required: true,
          value: agentSize,
          options: [
            { id: 'basic', label: 'Basic', description: 'Q&A, simple tasks.', price: '$100/mo' },
            { id: 'power', label: 'Power', description: 'Multi-user, projects, light dev.', price: '$250/mo' },
            { id: 'dev', label: 'Dev', description: 'Complex dev, many users, project orchestration.', price: '$500/mo' },
          ],
        },
      ],
      actions: [{ id: 'create', label: 'Create agent', style: 'primary' }],
      ...extra,
    });
  };

  const PENDING_CHECKOUT_ACTIONS: Json[] = [
    { id: 'retry_checkout', label: 'Open checkout again', style: 'secondary' },
    { id: 'cancel_checkout', label: 'Cancel', style: 'secondary' },
  ];

  const companyExists = () => channels.some((c) => c.channelId === COMPANY_CHANNEL_ID);

  /** #setup "Your companies" summary: one readonly row per company + create. */
  const companiesSummaryCard = (): Json =>
    card('companies_summary', 'companies_summary', null, 'open', {
      title: 'Your companies',
      summary: 'Each company is a channel. Create another to add one.',
      fields: [
        { id: 'ramen-bae', label: companyName, control: 'readonly', value: planLabel(plan) },
        ...extraCompanies.map((c) => ({ id: c.slug, label: c.name, control: 'readonly', value: 'Starter' })),
      ],
      actions: [{ id: 'create_company', label: 'Create another company', style: 'primary' }],
    });

  function planLabel(id: typeof plan): string {
    return id === 'enterprise' ? 'Enterprise' : id === 'workforce' ? 'Workforce' : 'Starter';
  }

  /** Post the summary once; afterwards rewrite it in place (same eventId). */
  async function upsertCompaniesSummary(): Promise<void> {
    const existing = list(SETUP_CHANNEL_ID).find((m) => m.systemEvent?.cardId === 'companies_summary');
    if (existing) {
      await patchCard(SETUP_CHANNEL_ID, 'companies_summary', companiesSummaryCard());
      return;
    }
    await postCard(SETUP_CHANNEL_ID, companiesSummaryCard());
  }

  const agentStatusCard = (state: string, extra: Json = {}) =>
    card('status', 'card_polar_status', COMPANY_UID, state, {
      title: 'Polar is setting up',
      summary: 'Polar is provisioning',
      fields: [
        { id: 'agentUid', label: 'Agent', control: 'readonly', value: AGENT_UID },
        { id: 'runtime', label: 'Runtime', control: 'readonly', value: 'Codex' },
        { id: 'size', label: 'Size', control: 'readonly', value: 'Basic · $100/mo' },
      ],
      actions: [],
      ...extra,
    });

  // ── state transitions ───────────────────────────────────────────────────

  function mintCompanyChannel(): void {
    if (channels.some((c) => c.channelId === COMPANY_CHANNEL_ID)) return;
    channels.unshift({
      channelId: COMPANY_CHANNEL_ID,
      name: 'ramen-bae',
      scope: 'company',
      companyUid: COMPANY_UID,
      companyName,
      visibility: 'company',
      membership: 'joined',
      unread: 0,
      memberCount: 2,
      lastActivityAt: nowIso(),
    });
    workspaces.push({
      slug: 'ramen-bae',
      displayName: companyName,
      kind: 'company',
      state: 'cloud',
      cloudUid: COMPANY_UID,
      bucketName: 'hq-vault-ramen-bae',
      hasLocalFolder: true,
      localPath: '/Users/corey/Documents/HQ/companies/ramen-bae',
      membershipStatus: 'active',
      role,
      lastSyncedAt: nowIso(),
      brokenReason: null,
      invitedBy: null,
      invitedAt: null,
    });
  }

  function mintAgentChannel(): void {
    if (channels.some((c) => c.channelId === AGENT_CHANNEL_ID)) return;
    agentCreated = true;
    channels.unshift({
      channelId: AGENT_CHANNEL_ID,
      name: agentDraft.name,
      scope: 'company',
      companyUid: COMPANY_UID,
      companyName,
      visibility: 'company',
      membership: 'joined',
      unread: 0,
      memberCount: 3,
      lastActivityAt: nowIso(),
      members: [
        { personUid: AGENT_UID, displayName: agentDraft.name },
        { personUid: OWNER.personUid, displayName: OWNER.displayName },
        { personUid: MEMBER.personUid, displayName: MEMBER.displayName },
      ],
    });
  }

  async function runCreateCompany(values: Record<string, string>): Promise<Json> {
    const name = (values.name ?? '').trim() || companyName;
    const slug = (values.slug ?? '').trim().toLowerCase();
    if (variant === 'blocked' || slug === 'indigo') {
      await patchCard(SETUP_CHANNEL_ID, 'card_create_company', {
        state: 'blocked',
        statusLabel: 'Blocked',
        reason: `The handle ${slug || 'ramen-bae'} is already taken.`,
        fields: createCompanyCard('blocked').fields,
        actions: [{ id: 'retry', label: 'Try another handle', style: 'primary' }],
      });
      return { cardId: 'card_create_company', actionId: 'submit', state: 'blocked' };
    }
    companyName = name;
    await patchCard(SETUP_CHANNEL_ID, 'card_create_company', {
      state: 'done',
      statusLabel: `Created ${companyName}`,
      fields: [
        { id: 'name', label: 'Company name', control: 'readonly', value: companyName },
        { id: 'slug', label: 'Handle', control: 'readonly', value: slug || 'ramen-bae' },
      ],
    });
    mintCompanyChannel();
    list(COMPANY_CHANNEL_ID).push({
      eventId: nextId('evt'),
      fromPersonUid: null,
      fromDisplayName: 'HQ',
      body: `Welcome to #${slug || 'ramen-bae'}. This channel is the company: setup, team, and agents all live here.`,
      createdAt: nowIso(),
      direction: 'in',
    });
    list(COMPANY_CHANNEL_ID).push({
      eventId: nextId('evt'),
      fromPersonUid: null,
      fromDisplayName: 'HQ',
      body: 'Turning on cloud sync',
      createdAt: nowIso(),
      direction: 'in',
      messageKind: 'system',
      systemEvent: activateCloudCard('pending', { statusLabel: 'Provisioning' }),
    });
    await emit('channel:unread-changed', { source: 'lifecycle-scenario' });
    await upsertCompaniesSummary();
    void (async () => {
      // Let the sidebar reconcile the directory (400ms debounce) so the open
      // resolves to the real company row (scope → hero + tabs), not a stub.
      await wait(900);
      openCompanyChannel();
      await wait(2000);
      await patchCard(COMPANY_CHANNEL_ID, 'card_activate_cloud', {
        state: 'done',
        statusLabel: 'Cloud sync on',
      });
      await wait(400);
      await postCard(COMPANY_CHANNEL_ID, upgradePlanCard('open'));
    })();
    return {
      cardId: 'card_create_company',
      actionId: 'submit',
      state: 'done',
      companyUid: COMPANY_UID,
    };
  }

  /** "Create another company": post a fresh create_company card into #setup. */
  async function runCreateAnotherCompany(): Promise<Json> {
    if (!companyExists()) {
      // No companies yet → no summary card on the server (404). The seeded
      // create_company card already sits in #setup.
      throw new Error('[not_found] Request failed (status 404)');
    }
    createCardSeq += 1;
    const cardId = `card_create_company_${createCardSeq}`;
    const slug = `new-co-${createCardSeq}`;
    await postCard(
      SETUP_CHANNEL_ID,
      createCompanyCard('open', {
        cardId,
        stepLabel: 'New company',
        fields: [
          { id: 'name', label: 'Company name', control: 'text', required: true, value: '' },
          { id: 'slug', label: 'Handle', control: 'text', required: true, value: slug, hint: `${slug} is available` },
        ],
      }),
    );
    return { cardId, actionId: 'create_company', state: 'open', channelId: SETUP_CHANNEL_ID };
  }

  /** Submit on a summary-posted create card: mint a small second company. */
  async function runCreateExtraCompany(cardId: string, values: Record<string, string>): Promise<Json> {
    const name = (values.name ?? '').trim() || 'New company';
    const slug = ((values.slug ?? '').trim().toLowerCase() || name.toLowerCase().replace(/[^a-z0-9]+/g, '-')).replace(/^-|-$/g, '');
    const uid = `cmp_${slug.replace(/-/g, '_')}`;
    const channelId = `chn_${slug.replace(/-/g, '_')}`;
    await patchCard(SETUP_CHANNEL_ID, cardId, {
      state: 'done',
      statusLabel: `Created ${name}`,
      fields: [
        { id: 'name', label: 'Company name', control: 'readonly', value: name },
        { id: 'slug', label: 'Handle', control: 'readonly', value: slug },
      ],
    });
    if (!channels.some((c) => c.channelId === channelId)) {
      extraCompanies.push({ uid, channelId, name, slug });
      channels.unshift({
        channelId,
        name: slug,
        scope: 'company',
        companyUid: uid,
        companyName: name,
        visibility: 'company',
        membership: 'joined',
        unread: 0,
        memberCount: 1,
        lastActivityAt: nowIso(),
      });
      workspaces.push({
        slug,
        displayName: name,
        kind: 'company',
        state: 'cloud',
        cloudUid: uid,
        bucketName: `hq-vault-${slug}`,
        hasLocalFolder: false,
        localPath: null,
        membershipStatus: 'active',
        role,
        lastSyncedAt: nowIso(),
        brokenReason: null,
        invitedBy: null,
        invitedAt: null,
      });
      list(channelId).push(textMessage(null, 'HQ', `Welcome to #${slug}. This channel is the company.`));
      await emit('channel:unread-changed', { source: 'lifecycle-scenario' });
    }
    await upsertCompaniesSummary();
    return { cardId, actionId: 'submit', state: 'done', companyUid: uid };
  }

  /** Team tab "Add agent": post or resurface the next card in the company channel. */
  async function runAddAgent(): Promise<Json> {
    if (!canAct) {
      return {
        cardId: 'team:spend',
        actionId: 'add_agent',
        state: 'blocked',
        reason: `Only owners can add agents to ${companyName}.`,
      };
    }
    const live = (m: Message) => {
      const st = m.systemEvent?.state;
      return st === 'open' || st === 'pending' || st === 'blocked';
    };
    if (plan === 'starter') {
      const existing = list(COMPANY_CHANNEL_ID).find(
        (m) => m.systemEvent?.kind === 'upgrade_plan' && live(m),
      );
      const cardId = existing?.systemEvent?.cardId
        ? String(existing.systemEvent.cardId)
        : `card_upgrade_plan_${++createCardSeq}`;
      if (!existing) await postCard(COMPANY_CHANNEL_ID, upgradePlanCard('open', { cardId }));
      return { cardId, actionId: 'add_agent', state: 'open', channelId: COMPANY_CHANNEL_ID };
    }
    const existing = list(COMPANY_CHANNEL_ID).find(
      (m) => m.systemEvent?.kind === 'create_agent' && live(m),
    );
    if (existing?.systemEvent?.cardId) {
      return {
        cardId: String(existing.systemEvent.cardId),
        actionId: 'add_agent',
        state: 'open',
        channelId: COMPANY_CHANNEL_ID,
      };
    }
    const suffix = agentCreated || list(COMPANY_CHANNEL_ID).some((m) => m.systemEvent?.cardId === 'card_create_agent_1')
      ? `_${++createCardSeq}`
      : '';
    const cardId = `card_create_agent_1${suffix}`;
    await postCard(COMPANY_CHANNEL_ID, createAgentCard(1, 'open', { cardId }));
    return { cardId, actionId: 'add_agent', state: 'open', channelId: COMPANY_CHANNEL_ID };
  }

  async function runUpgradePlan(
    cardId: string,
    actionId: string,
    values: Record<string, string>,
  ): Promise<Json> {
    if (actionId === 'retry_checkout') {
      // Same session; the shell opens the url.
      return { cardId, actionId, state: 'pending', url: CHECKOUT_URL };
    }
    if (actionId === 'cancel_checkout') {
      checkoutToken += 1;
      await patchCard(COMPANY_CHANNEL_ID, cardId, {
        state: 'open',
        statusLabel: null,
        summary: upgradePlanCard('open').summary,
        actions: upgradePlanCard('open').actions,
      });
      return { cardId, actionId, state: 'open' };
    }
    if (actionId === 'stay') {
      plan = 'starter';
      await patchCard(COMPANY_CHANNEL_ID, cardId, {
        state: 'skipped',
        statusLabel: 'Staying on Starter',
      });
      await wait(400);
      await postCard(
        COMPANY_CHANNEL_ID,
        createAgentCard(1, 'blocked', {
          statusLabel: 'Needs Workforce',
          reason: 'Fleet agents need the Workforce plan. Upgrade to create Polar.',
          actions: [
            { id: 'upgrade', label: 'Upgrade plan', style: 'primary' },
          ],
        }),
      );
      return { cardId, actionId, state: 'skipped' };
    }
    const chosen = values.plan === 'enterprise' ? 'enterprise' : 'workforce';
    const token = ++checkoutToken;
    await patchCard(COMPANY_CHANNEL_ID, cardId, {
      state: 'pending',
      statusLabel: 'Waiting for checkout',
      summary: 'Complete checkout in the browser. This card updates when Stripe confirms.',
      // Pending keeps the spinner and read-only fields but still offers a
      // way back in (or out) if the checkout tab was closed.
      actions: PENDING_CHECKOUT_ACTIONS,
    });
    void (async () => {
      await wait(1500);
      if (checkoutToken !== token) return;
      plan = chosen;
      await patchCard(COMPANY_CHANNEL_ID, cardId, {
        state: 'done',
        statusLabel: chosen === 'enterprise' ? 'Enterprise active' : 'Workforce active',
        summary: null,
        actions: upgradePlanCard('open').actions,
      });
      await upsertCompaniesSummary();
      await wait(400);
      await postCard(COMPANY_CHANNEL_ID, createAgentCard(1, 'open'));
    })();
    return { cardId, actionId, state: 'pending', url: CHECKOUT_URL };
  }

  async function runCreateAgent(cardId: string, values: Record<string, string>): Promise<Json> {
    // Cards posted by "Add agent" after the first run carry a suffix
    // (card_create_agent_1_7); the next turns keep it so ids stay unique.
    const turnSuffix = cardId.replace(/^card_create_agent_[123]/, '');
    if (cardId.startsWith('card_create_agent_1')) {
      const handle = (values.handle ?? '').trim().replace(/^@/, '').toLowerCase();
      if (handle === 'indigo' || handle === 'hq') {
        await patchCard(COMPANY_CHANNEL_ID, cardId, {
          state: 'blocked',
          statusLabel: 'Blocked',
          reason: `@${handle} is already taken in ${companyName}.`,
          actions: [{ id: 'retry', label: 'Try another handle', style: 'primary' }],
        });
        return { cardId, actionId: 'next', state: 'blocked' };
      }
      agentDraft.name = (values.name ?? '').trim() || agentDraft.name;
      agentDraft.handle = handle || agentDraft.handle;
      await patchCard(COMPANY_CHANNEL_ID, cardId, {
        state: 'done',
        statusLabel: `@${agentDraft.handle}`,
      });
      await wait(300);
      await postCard(COMPANY_CHANNEL_ID, createAgentCard(2, 'open', { cardId: `card_create_agent_2${turnSuffix}` }));
      return { cardId, actionId: 'next', state: 'done' };
    }
    if (cardId.startsWith('card_create_agent_2')) {
      agentDraft.runtime = values.runtime || agentDraft.runtime;
      await patchCard(COMPANY_CHANNEL_ID, cardId, {
        state: 'done',
        statusLabel: runtimeLabel(agentDraft.runtime),
      });
      await wait(300);
      await postCard(COMPANY_CHANNEL_ID, createAgentCard(3, 'open', { cardId: `card_create_agent_3${turnSuffix}` }));
      return { cardId, actionId: 'next', state: 'done' };
    }
    agentSize = (values.size as typeof agentSize) || agentSize;
    await patchCard(COMPANY_CHANNEL_ID, cardId, {
      state: 'done',
      statusLabel: `${agentDraft.name} created`,
    });
    mintAgentChannel();
    list(AGENT_CHANNEL_ID).push({
      eventId: nextId('evt'),
      fromPersonUid: null,
      fromDisplayName: 'HQ',
      body: `${agentDraft.name} is setting up`,
      createdAt: nowIso(),
      direction: 'in',
      messageKind: 'system',
      systemEvent: agentStatusCard('pending', {
        title: `${agentDraft.name} is setting up`,
        summary: `${agentDraft.name} is provisioning`,
        statusLabel: 'Provisioning',
        fields: [
          { id: 'agentUid', label: 'Agent', control: 'readonly', value: AGENT_UID },
          { id: 'runtime', label: 'Runtime', control: 'readonly', value: runtimeLabel(agentDraft.runtime) },
          { id: 'size', label: 'Size', control: 'readonly', value: sizeLabel(agentSize) },
        ],
      }),
    });
    await emit('channel:unread-changed', { source: 'lifecycle-scenario' });
    void (async () => {
      await wait(2000);
      await patchCard(AGENT_CHANNEL_ID, 'card_polar_status', {
        state: 'done',
        title: `${agentDraft.name} is online`,
        summary: `${agentDraft.name} checked in`,
        statusLabel: 'Online',
      });
      await wait(500);
      await postText(
        AGENT_CHANNEL_ID,
        { personUid: AGENT_UID, displayName: agentDraft.name },
        `Hi ${OWNER.displayName.split(' ')[0]} — I'm ${agentDraft.name}, running on ${runtimeLabel(agentDraft.runtime)}. I have read access to the ${companyName} vault and can pick up projects from the board. What should I start on?`,
      );
    })();
    return {
      cardId,
      actionId: 'create',
      state: 'done',
      agentChannelId: AGENT_CHANNEL_ID,
      agentUid: AGENT_UID,
    };
  }

  function runtimeLabel(id: string): string {
    return id === 'claude' ? 'Claude Code' : id === 'grok' ? 'Grok Build' : 'Codex';
  }
  function sizeLabel(id: string): string {
    return id === 'dev' ? 'Dev · $500/mo' : id === 'power' ? 'Power · $250/mo' : 'Basic · $100/mo';
  }

  // ── company tabs ────────────────────────────────────────────────────────

  const tabRow = (cardId: string, fields: Json[], actions: Json[], extra: Json = {}): Json =>
    card('tab_row', cardId, COMPANY_UID, 'open', { fields, actions, ...extra });

  function teamTab(): Json {
    const humanRows = humans.map((h) =>
      tabRow(
        `team:human:${h.uid}`,
        [
          { id: 'name', label: 'Name', control: 'readonly', value: h.name },
          { id: 'email', label: 'Email', control: 'readonly', value: h.email },
          h.role === 'owner'
            ? { id: 'role', label: 'Role', control: 'readonly', value: 'Owner' }
            : {
                id: 'role',
                label: 'Role',
                control: 'select',
                value: h.role,
                options: [
                  { id: 'owner', label: 'Owner' },
                  { id: 'member', label: 'Member' },
                ],
              },
        ],
        h.role === 'owner'
          ? []
          : [
              { id: 'set_role', label: 'Save', style: 'secondary' },
              { id: 'remove', label: 'Remove', style: 'secondary' },
            ],
      ),
    );
    humanRows.push(
      tabRow(
        'team:invite',
        [
          { id: 'email', label: 'Invite by email', control: 'text', value: '' },
          {
            id: 'role',
            label: 'Role',
            control: 'select',
            value: 'member',
            options: [
              { id: 'member', label: 'Member' },
              { id: 'owner', label: 'Owner' },
            ],
          },
        ],
        [{ id: 'invite', label: 'Invite', style: 'primary' }],
      ),
    );
    const agentRows: Json[] = agentCreated || plan !== 'starter'
      ? [
          tabRow(
            `team:agent:${AGENT_UID}`,
            [
              { id: 'name', label: 'Name', control: 'readonly', value: agentDraft.name },
              {
                id: 'size',
                label: 'Size',
                control: 'select',
                value: agentSize,
                options: [
                  { id: 'basic', label: 'Basic' },
                  { id: 'power', label: 'Power' },
                  { id: 'dev', label: 'Dev' },
                ],
              },
              { id: 'provider', label: 'Provider', control: 'readonly', value: runtimeLabel(agentDraft.runtime) },
              { id: 'price', label: 'Price', control: 'readonly', value: sizeLabel(agentSize).split(' · ')[1] ?? '$100/mo' },
            ],
            [
              { id: 'resize', label: 'Resize', style: 'secondary' },
              { id: 'remove', label: 'Remove', style: 'secondary' },
            ],
          ),
        ]
      : [];
    agentRows.push(
      tabRow(
        'team:spend',
        [
          {
            id: 'total',
            label: 'Agent spend',
            control: 'readonly',
            value: agentRows.length ? sizeLabel(agentSize).split(' · ')[1] ?? '$100/mo' : '$0/mo',
          },
        ],
        canAct ? [{ id: 'add_agent', label: 'Add agent', style: 'primary' }] : [],
      ),
    );
    return {
      tab: 'team',
      companyUid: COMPANY_UID,
      viewer,
      appearance: { name: companyName, wallpaper: 'aurora' },
      sections: [
        { id: 'humans', title: `Humans · ${humans.length}`, rows: humanRows },
        { id: 'agents', title: `Agents · ${agentRows.length - 1}`, rows: agentRows },
        {
          id: 'permissions',
          title: 'Permissions',
          rows: [
            tabRow(
              'team:perm:members-create-channels',
              [
                {
                  id: 'audience',
                  label: 'Who can create channels',
                  control: 'select',
                  value: 'members',
                  options: [
                    { id: 'owners', label: 'Owners' },
                    { id: 'members', label: 'Everyone' },
                  ],
                },
              ],
              [{ id: 'save', label: 'Save', style: 'secondary' }],
            ),
            tabRow(
              'team:perm:agents-post',
              [
                {
                  id: 'audience',
                  label: 'Where agents can post',
                  control: 'select',
                  value: 'own',
                  options: [
                    { id: 'own', label: 'Their own channel' },
                    { id: 'any', label: 'Any company channel' },
                  ],
                },
              ],
              [{ id: 'save', label: 'Save', style: 'secondary' }],
            ),
          ],
        },
      ],
    };
  }

  function integrationsTab(): Json {
    return {
      tab: 'integrations',
      companyUid: COMPANY_UID,
      viewer,
      appearance: { name: companyName, wallpaper: 'aurora' },
      sections: [
        {
          id: 'connected',
          title: `Connected · ${integrations.connected.length}`,
          rows: integrations.connected.map((row) =>
            tabRow(
              `int:connected:${row.id}`,
              [
                { id: 'name', label: 'Name', control: 'readonly', value: row.name },
                { id: 'account', label: 'Account', control: 'readonly', value: row.account },
              ],
              [{ id: 'disconnect', label: 'Disconnect', style: 'secondary' }],
            ),
          ),
        },
        {
          id: 'available',
          title: 'Available',
          rows: integrations.available.map((row) =>
            tabRow(
              `int:available:${row.id}`,
              [{ id: 'name', label: 'Name', control: 'readonly', value: row.name }],
              [
                {
                  id: 'connect',
                  label: plan === 'starter' ? 'Needs Workforce' : 'Connect',
                  style: 'link',
                  href: `https://hq.getindigo.ai/integrations/${row.id}/connect`,
                },
              ],
            ),
          ),
        },
      ],
    };
  }

  function settingsTab(): Json {
    const planLabel =
      plan === 'enterprise' ? 'Enterprise' : plan === 'workforce' ? 'Workforce · $500/mo flat' : 'Starter · Free';
    return {
      tab: 'settings',
      companyUid: COMPANY_UID,
      viewer,
      appearance: { name: companyName, wallpaper: 'aurora' },
      sections: [
        {
          id: 'general',
          title: 'General',
          rows: [
            tabRow(
              'set:name',
              [{ id: 'name', label: 'Name', control: 'text', value: companyName }],
              [{ id: 'save', label: 'Edit', style: 'secondary' }],
            ),
            tabRow(
              'set:wallpaper',
              [
                {
                  id: 'wallpaper',
                  label: 'Wallpaper',
                  control: 'select',
                  value: 'aurora',
                  options: [
                    { id: 'aurora', label: 'Aurora' },
                    { id: 'monoliths', label: 'Chrome monoliths' },
                    { id: 'easel', label: "Artist's easel" },
                  ],
                },
              ],
              [{ id: 'save', label: 'Change', style: 'secondary' }],
            ),
          ],
        },
        {
          id: 'billing',
          title: 'Plan and billing',
          rows: [
            tabRow(
              'set:plan',
              [
                { id: 'plan', label: 'Plan', control: 'readonly', value: planLabel },
                { id: 'seats', label: 'Seats', control: 'readonly', value: `${humans.length} of ${plan === 'starter' ? 3 : 25}` },
              ],
              [
                {
                  id: 'manage',
                  label: plan === 'starter' ? 'Upgrade' : 'Manage billing',
                  style: 'link',
                  href: 'https://billing.stripe.com/p/session/test_ramen_bae',
                },
              ],
            ),
            tabRow(
              'set:invoice',
              [{ id: 'email', label: 'Invoice email', control: 'text', value: OWNER.email }],
              [{ id: 'save', label: 'Save', style: 'secondary' }],
            ),
          ],
        },
        {
          id: 'cloud',
          title: 'Cloud',
          rows: [
            tabRow(
              'set:cloud',
              [
                { id: 'bucket', label: 'Vault', control: 'readonly', value: 'hq-vault-ramen-bae' },
                { id: 'region', label: 'Region', control: 'readonly', value: 'us-west-2' },
                { id: 'sync', label: 'Sync', control: 'readonly', value: variant === 'blocked' ? 'Provisioning failed' : 'On · synced 2m ago' },
              ],
              variant === 'blocked'
                ? [{ id: 'retry', label: 'Retry provisioning', style: 'primary' }]
                : [{ id: 'resync', label: 'Resync now', style: 'secondary' }],
            ),
          ],
        },
        {
          id: 'danger',
          title: 'Danger zone',
          rows: [
            tabRow(
              'set:delete',
              [
                {
                  id: 'confirm',
                  label: `Type ${companyName} to delete`,
                  control: 'text',
                  value: '',
                },
              ],
              [{ id: 'delete', label: 'Delete company', style: 'secondary' }],
            ),
          ],
        },
      ],
    };
  }

  function atlasTab(): Json {
    const nodes: Json[] = [
      { id: COMPANY_UID, type: 'company', label: companyName, subtitle: plan === 'starter' ? 'Starter' : 'Workforce', x: 400, y: 280 },
      { id: OWNER.personUid, type: 'person', label: OWNER.displayName, subtitle: 'Owner', x: 220, y: 160 },
      { id: MEMBER.personUid, type: 'person', label: MEMBER.displayName, subtitle: 'Member', x: 220, y: 400 },
      { id: 'proj_launch', type: 'file', label: 'spring-launch/prd.json', subtitle: 'Project · 3 of 8 stories', x: 600, y: 160 },
      { id: 'file_brief', type: 'file', label: 'brand-brief.md', subtitle: 'Knowledge', x: 600, y: 400 },
    ];
    const edges: Json[] = [
      { from: COMPANY_UID, to: OWNER.personUid },
      { from: COMPANY_UID, to: MEMBER.personUid },
      { from: COMPANY_UID, to: 'proj_launch' },
      { from: 'proj_launch', to: 'file_brief' },
      { from: OWNER.personUid, to: 'proj_launch' },
    ];
    if (agentCreated) {
      nodes.push({ id: AGENT_UID, type: 'agent', label: agentDraft.name, subtitle: runtimeLabel(agentDraft.runtime), x: 400, y: 470 });
      edges.push({ from: COMPANY_UID, to: AGENT_UID }, { from: AGENT_UID, to: 'proj_launch' });
    }
    return {
      tab: 'atlas',
      companyUid: COMPANY_UID,
      viewer,
      appearance: { name: companyName, wallpaper: 'aurora' },
      sections: [],
      graph: { nodes, edges },
    };
  }

  // ── seed ────────────────────────────────────────────────────────────────

  function seed(): void {
    if (role === 'member') {
      // Members join a company that already exists; #setup shows the
      // completed create step so the read-only chrome is visible.
      list(SETUP_CHANNEL_ID).push(systemMessage(
        createCompanyCard('done', {
          statusLabel: `Created ${companyName}`,
          fields: [
            { id: 'name', label: 'Company name', control: 'readonly', value: companyName },
            { id: 'slug', label: 'Handle', control: 'readonly', value: 'ramen-bae' },
          ],
        }),
      ));
      mintCompanyChannel();
      list(SETUP_CHANNEL_ID).push(systemMessage(companiesSummaryCard()));
      list(COMPANY_CHANNEL_ID).push(
        textMessage(null, 'HQ', `Welcome to #ramen-bae. This channel is the company: setup, team, and agents all live here.`),
        systemMessage(activateCloudCard('done', { statusLabel: 'Cloud sync on' })),
        systemMessage(upgradePlanCard('open')),
      );
      return;
    }
    if (variant === 'blocked') {
      list(SETUP_CHANNEL_ID).push(systemMessage(
        createCompanyCard('blocked', {
          statusLabel: 'Blocked',
          reason: 'The handle ramen-bae is already taken.',
          fields: [
            { id: 'name', label: 'Company name', control: 'text', required: true, value: 'Ramen Bae' },
            {
              id: 'slug',
              label: 'Handle',
              control: 'text',
              required: true,
              value: 'ramen-bae',
              error: 'ramen-bae is taken',
              hint: 'Try ramen-bae-co',
            },
          ],
          actions: [{ id: 'retry', label: 'Try another handle', style: 'primary' }],
        }),
      ));
      mintCompanyChannel();
      list(COMPANY_CHANNEL_ID).push(
        textMessage(null, 'HQ', `Welcome to #ramen-bae. This channel is the company: setup, team, and agents all live here.`),
        systemMessage(activateCloudCard('blocked', {
          statusLabel: 'Provisioning failed',
          reason: 'The vault bucket could not be created: hq-vault-ramen-bae already exists in another region.',
          actions: [{ id: 'retry', label: 'Retry provisioning', style: 'primary' }],
        })),
        systemMessage(upgradePlanCard('skipped', { statusLabel: 'Staying on Starter' })),
        systemMessage(createAgentCard(1, 'blocked', {
          statusLabel: 'Needs Workforce',
          reason: 'Fleet agents need the Workforce plan. Upgrade to create Polar.',
          actions: [{ id: 'upgrade', label: 'Upgrade plan', style: 'primary' }],
        })),
      );
      mintAgentChannel();
      list(AGENT_CHANNEL_ID).push(systemMessage(agentStatusCard('blocked', {
        title: 'Polar could not start',
        summary: 'Polar is provisioning',
        statusLabel: 'Provisioning failed',
        reason: 'The Codex runtime rejected the session token. Retry after the cloud step succeeds.',
        actions: [{ id: 'retry', label: 'Retry', style: 'primary' }],
      })));
      return;
    }
    list(SETUP_CHANNEL_ID).push(systemMessage(createCompanyCard('open')));
  }

  function systemMessage(cardEnvelope: Json): Message {
    return {
      eventId: nextId('evt'),
      fromPersonUid: null,
      fromDisplayName: 'HQ',
      body: cardFallbackBody(cardEnvelope),
      createdAt: nowIso(),
      direction: 'in',
      messageKind: 'system',
      systemEvent: cardEnvelope,
    };
  }
  function textMessage(personUid: string | null, displayName: string, body: string): Message {
    return {
      eventId: nextId('evt'),
      fromPersonUid: personUid,
      fromDisplayName: displayName,
      body,
      createdAt: nowIso(),
      direction: personUid === me.personUid ? 'out' : 'in',
    };
  }

  seed();

  // ── invoke ──────────────────────────────────────────────────────────────

  function page(channelId: string, since?: string | null): Json {
    const rows = list(channelId).filter((m) => !since || m.createdAt >= since);
    // Desktop fetch_channel pages are newest-first.
    return { messages: [...rows].reverse(), nextCursor: null };
  }

  function hqPro(path: string, method: string): Json {
    const clean = path.split('?')[0] ?? path;
    const query = new URLSearchParams(path.split('?')[1] ?? '');
    const messagesMatch = clean.match(/^\/v1\/notify\/channels\/([^/]+)\/messages$/);
    if (messagesMatch && method === 'GET') {
      return ok(page(decodeURIComponent(messagesMatch[1] ?? ''), query.get('since')));
    }
    if (clean.startsWith('/v1/notify/dm-threads')) return ok({ threads: [] });
    if (clean.startsWith('/v1/notify/inbox')) return ok({ notifications: [] });
    if (clean.startsWith('/v1/identity/whoami')) return ok(me);
    if (clean === '/v1/profile') {
      return ok({ personUid: me.personUid, displayName: me.displayName, email: me.email, title: role === 'owner' ? 'Founder' : 'Designer' });
    }
    return ok({});
  }
  const ok = (body: unknown) => ({ status: 200, body: JSON.stringify(body) });

  const invokeFn: SyncInvokeFn = async (command, args) => {
    calls.push(command);
    const a = (args ?? {}) as Record<string, unknown>;
    switch (command) {
      case 'get_auth_state':
        return { authenticated: true, accountId: `cognito-${me.personUid}`, email: me.email, displayName: me.displayName };
      case 'get_auth_session':
        return { accountId: `cognito-${me.personUid}`, generation: 1, status: 'active', reason: null };
      case 'whoami':
        return me;
      case 'is_indigo_user':
        return false;
      case 'desktop_alt_is_admin':
        return role === 'owner';
      case 'list_syncable_workspaces':
        return { workspaces: [...workspaces], cloudReachable: true, error: null, hqFolderPath: '/Users/corey/Documents/HQ', manifestError: null };
      case 'list_channels':
        return { channels: channels.map((c) => ({ ...c })) };
      case 'fetch_channel_directory':
        // contractVersion-2 snapshot the sidebar reconciler consumes.
        return {
          contractVersion: 2,
          snapshot: true,
          cursor: `lifecycle-cursor-${String(eventSeq).padStart(30, '0')}`,
          cursorExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
          rows: channels.map((c) => ({
            channelId: c.channelId,
            name: c.name,
            scope: c.scope,
            type: 'chat',
            companyUid: c.companyUid ?? null,
            companyName: c.companyName ?? null,
            lastActivityAt: c.lastActivityAt,
            unreadCount: c.unread,
            memberCount: c.memberCount,
            ...(c.members ? { members: c.members } : {}),
          })),
        };
      case 'fetch_channel':
        return page(String(a.channelId ?? ''));
      case 'list_channel_members': {
        const row = channels.find((c) => c.channelId === String(a.channelId ?? ''));
        const members = row?.members ?? humans.map((h) => ({ personUid: h.uid, displayName: h.name, email: h.email }));
        return { members };
      }
      case 'list_contacts':
        return {
          contacts: humans
            .filter((h) => h.uid !== me.personUid)
            .map((h) => ({ personUid: h.uid, email: h.email, displayName: h.name, companyUid: COMPANY_UID, source: 'company' })),
        };
      case 'list_company_members':
        return { members: humans.map((h) => ({ personUid: h.uid, email: h.email, displayName: h.name, companyUid: COMPANY_UID, companyName })) };
      case 'list_dm_requests':
        return { requests: [] };
      case 'get_unread_summary':
        return { unreadDms: 0, pendingRequests: 0 };
      case 'fetch_notifications':
      case 'fetch_notification_history':
        return { notifications: [], unreadCount: 0, nextCursor: null };
      case 'get_setup_status':
        return { hqFolderPath: '/Users/corey/Documents/HQ', configured: true };
      case 'take_pending_setup_target':
      case 'desktop_alt_consume_pending_route':
      case 'meetings_take_pending_focus':
      case 'shell_ready':
      case 'mark_channel_read':
      case 'set_active_conversation':
        return null;
      case 'send_channel_message': {
        const channelId = String(a.channelId ?? '');
        const sent = await postText(channelId, me, String(a.body ?? ''));
        if (channelId === AGENT_CHANNEL_ID && agentCreated) {
          void (async () => {
            await wait(1200);
            await postText(AGENT_CHANNEL_ID, { personUid: AGENT_UID, displayName: agentDraft.name }, 'On it. I will post a plan here before I touch anything.');
          })();
        }
        return { eventId: sent.eventId, createdAt: sent.createdAt };
      }
      case 'run_card_action': {
        if (!canAct) throw new Error('[forbidden] Only owners can act on this card');
        const cardId = String(a.cardId ?? '');
        const actionId = String(a.actionId ?? '');
        const values = (a.values ?? {}) as Record<string, string>;
        if (cardId === 'companies_summary' && actionId === 'create_company') {
          return runCreateAnotherCompany();
        }
        if (/^card_create_company_\d+$/.test(cardId)) {
          return runCreateExtraCompany(cardId, values);
        }
        if (cardId === 'card_create_company') {
          if (actionId === 'retry') {
            await patchCard(SETUP_CHANNEL_ID, cardId, {
              state: 'open',
              statusLabel: null,
              reason: null,
              fields: (createCompanyCard('open').fields as Json[]).map((f) =>
                f.id === 'slug' ? { ...f, value: 'ramen-bae-co', hint: 'ramen-bae-co is available' } : f,
              ),
              actions: [{ id: 'submit', label: 'Create company', style: 'primary' }],
            });
            return { cardId, actionId, state: 'open' };
          }
          return runCreateCompany(values);
        }
        if (cardId === 'card_activate_cloud') {
          await patchCard(COMPANY_CHANNEL_ID, cardId, { state: 'pending', statusLabel: 'Provisioning', reason: null, actions: [] });
          void (async () => {
            await wait(2000);
            await patchCard(COMPANY_CHANNEL_ID, cardId, { state: 'done', statusLabel: 'Cloud sync on' });
          })();
          return { cardId, actionId, state: 'pending' };
        }
        if (cardId.startsWith('card_upgrade_plan')) return runUpgradePlan(cardId, actionId, values);
        if (cardId.startsWith('card_create_agent_')) {
          if (actionId === 'upgrade') {
            await patchCard(COMPANY_CHANNEL_ID, cardId, { state: 'skipped', statusLabel: 'Superseded' });
            await postCard(COMPANY_CHANNEL_ID, upgradePlanCard('open', { cardId: 'card_upgrade_plan_2' }));
            return { cardId, actionId, state: 'skipped' };
          }
          if (actionId === 'retry') {
            await patchCard(COMPANY_CHANNEL_ID, cardId, {
              state: 'open',
              statusLabel: null,
              reason: null,
              actions: [{ id: 'next', label: 'Next', style: 'primary' }],
            });
            return { cardId, actionId, state: 'open' };
          }
          return runCreateAgent(cardId, values);
        }
        if (cardId === 'card_polar_status') {
          await patchCard(AGENT_CHANNEL_ID, cardId, { state: 'pending', statusLabel: 'Provisioning', reason: null, actions: [] });
          void (async () => {
            await wait(2000);
            await patchCard(AGENT_CHANNEL_ID, cardId, { state: 'done', title: 'Polar is online', statusLabel: 'Online' });
          })();
          return { cardId, actionId, state: 'pending' };
        }
        return { cardId, actionId, state: 'done' };
      }
      case 'get_company_tab': {
        const tab = String(a.tab ?? 'settings');
        if (tab === 'team') return teamTab();
        if (tab === 'integrations') return integrationsTab();
        if (tab === 'atlas') return atlasTab();
        return settingsTab();
      }
      case 'run_company_tab_action': {
        const cardId = String(a.cardId ?? '');
        const actionId = String(a.actionId ?? '');
        const values = (a.values ?? {}) as Record<string, string>;
        if (cardId === 'team:spend' && actionId === 'add_agent') return runAddAgent();
        if (!canAct) throw new Error('[forbidden] Only owners can change this');
        if (cardId === 'team:invite' && actionId === 'invite' && values.email?.trim()) {
          const email = values.email.trim();
          humans.push({ uid: `prs_${email.split('@')[0]}`, name: email, email, role: values.role || 'member' });
        } else if (cardId.startsWith('team:human:') && actionId === 'set_role') {
          const uid = cardId.slice('team:human:'.length);
          const h = humans.find((row) => row.uid === uid);
          if (h && values.role) h.role = values.role;
        } else if (cardId.startsWith('team:human:') && actionId === 'remove') {
          const uid = cardId.slice('team:human:'.length);
          const at = humans.findIndex((row) => row.uid === uid);
          if (at > 0) humans.splice(at, 1);
        } else if (cardId === `team:agent:${AGENT_UID}` && actionId === 'resize' && values.size) {
          agentSize = values.size as typeof agentSize;
        } else if (cardId === 'set:name' && values.name?.trim()) {
          companyName = values.name.trim();
          const row = channels.find((c) => c.channelId === COMPANY_CHANNEL_ID);
          if (row) row.companyName = companyName;
        } else if (cardId.startsWith('int:connected:') && actionId === 'disconnect') {
          const id = cardId.slice('int:connected:'.length);
          const at = integrations.connected.findIndex((row) => row.id === id);
          if (at >= 0) {
            const [gone] = integrations.connected.splice(at, 1);
            if (gone) integrations.available.unshift({ id: gone.id, name: gone.name });
          }
        }
        return { cardId, actionId, state: 'done', replayed: false };
      }
      case 'hq_pro_fetch':
        return hqPro(String(a.url ?? ''), String(a.method ?? 'GET').toUpperCase());
      default:
        return baseInvoke(command, args as Record<string, unknown> | undefined);
    }
  };

  return {
    invokeFn,
    calls,
    /** Test hooks — read-only views over the in-memory backend. */
    inspect: {
      channels: () => channels.map((c) => ({ ...c })),
      messages: (channelId: string) => list(channelId).map((m) => ({ ...m })),
      tab: (tab: string) =>
        tab === 'team' ? teamTab() : tab === 'integrations' ? integrationsTab() : tab === 'atlas' ? atlasTab() : settingsTab(),
    },
  };
}
