/**
 * Release-gate personas for the desktop shell.
 *
 * v0.10.178 shipped because every test and every human check ran as an Indigo
 * member with conversations. These four identities are the cheap matrix that
 * has to boot before a PR can merge:
 *
 *   empty-inbox     — non-Indigo company member, directory is empty (#setup only)
 *   personal-only   — signed-in user with a personal vault and no company
 *   multi-company   — two companies plus personal
 *   indigo          — today's default (Indigo member with conversations)
 *
 * The preview harness honors `?persona=<id>`. Vitest / e2e import
 * `createPersonaInvoke` and mount `HqWorkDesktopShell` against the same data.
 */
import type { SyncInvokeFn } from '@hq/platform';
import type { Workspace } from '../src/lib/workspaces';

export const PERSONA_IDS = [
  'empty-inbox',
  'personal-only',
  'multi-company',
  'indigo',
] as const;

export type PersonaId = (typeof PERSONA_IDS)[number];

export type PersonaPaint = 'setup' | 'conversations';

export interface PersonaWhoami {
  personUid: string;
  email: string;
  displayName: string;
}

export interface PersonaChannel {
  channelId: string;
  id: string;
  name: string;
  scope: string;
  companyUid?: string;
  companyName?: string;
  type?: string;
  visibility?: string;
  membership?: string;
  unread?: number;
  memberCount?: number;
  lastActivityAt?: string;
}

export interface PersonaContact {
  personUid: string;
  email: string;
  displayName: string;
  companyUid: string | null;
  source: string;
}

export interface ShellPersona {
  id: PersonaId;
  /** One-line description used in test titles and harness captions. */
  label: string;
  isIndigo: boolean;
  whoami: PersonaWhoami;
  accountId: string;
  workspaces: Workspace[];
  channels: PersonaChannel[];
  contacts: PersonaContact[];
  /** What the conversation area must paint instead of the loading skeleton. */
  expectedPaint: PersonaPaint;
}

function workspace(overrides: Partial<Workspace> & Pick<Workspace, 'slug' | 'displayName' | 'kind' | 'state'>): Workspace {
  return {
    cloudUid: null,
    bucketName: null,
    hasLocalFolder: true,
    localPath: `/Users/qa/Documents/HQ/${overrides.kind === 'personal' ? 'personal' : `companies/${overrides.slug}`}`,
    membershipStatus: overrides.kind === 'personal' ? null : 'active',
    role: overrides.kind === 'personal' ? null : 'member',
    lastSyncedAt: '2026-09-01T12:00:00.000Z',
    brokenReason: null,
    invitedBy: null,
    invitedAt: null,
    ...overrides,
  };
}

const MICHEL: PersonaWhoami = {
  personUid: 'prs_michel',
  email: 'michel@acme.test',
  displayName: 'Michel Triana',
};

const ADA: PersonaWhoami = {
  personUid: 'prs_ada',
  email: 'ada@getindigo.ai',
  displayName: 'Ada Lovelace',
};

export const PERSONAS: Record<PersonaId, ShellPersona> = {
  'empty-inbox': {
    id: 'empty-inbox',
    label: 'non-Indigo company member with an empty inbox',
    isIndigo: false,
    whoami: MICHEL,
    accountId: 'acct_michel',
    workspaces: [
      workspace({
        slug: 'personal',
        displayName: 'Michel Triana',
        kind: 'personal',
        state: 'personal',
        cloudUid: 'prs_michel',
        bucketName: 'hq-vault-personal-michel',
        role: null,
        membershipStatus: null,
      }),
      workspace({
        slug: 'acme',
        displayName: 'Acme',
        kind: 'company',
        state: 'synced',
        cloudUid: 'cmp_acme',
        bucketName: 'hq-vault-acme',
        role: 'member',
      }),
    ],
    channels: [],
    contacts: [],
    expectedPaint: 'setup',
  },
  'personal-only': {
    id: 'personal-only',
    label: 'personal-scope-only user with no company',
    isIndigo: false,
    whoami: {
      personUid: 'prs_sam',
      email: 'sam@personal.test',
      displayName: 'Sam Personal',
    },
    accountId: 'acct_sam',
    workspaces: [
      workspace({
        slug: 'personal',
        displayName: 'Sam Personal',
        kind: 'personal',
        state: 'personal',
        cloudUid: 'prs_sam',
        bucketName: 'hq-vault-personal-sam',
        role: null,
        membershipStatus: null,
      }),
    ],
    channels: [],
    contacts: [],
    expectedPaint: 'setup',
  },
  'multi-company': {
    id: 'multi-company',
    label: 'multi-company user',
    isIndigo: false,
    whoami: {
      personUid: 'prs_jordan',
      email: 'jordan@widgets.test',
      displayName: 'Jordan Lee',
    },
    accountId: 'acct_jordan',
    workspaces: [
      workspace({
        slug: 'personal',
        displayName: 'Jordan Lee',
        kind: 'personal',
        state: 'personal',
        cloudUid: 'prs_jordan',
        bucketName: 'hq-vault-personal-jordan',
        role: null,
        membershipStatus: null,
      }),
      workspace({
        slug: 'acme',
        displayName: 'Acme',
        kind: 'company',
        state: 'synced',
        cloudUid: 'cmp_acme',
        bucketName: 'hq-vault-acme',
        role: 'member',
      }),
      workspace({
        slug: 'widgets',
        displayName: 'Widgets Co',
        kind: 'company',
        state: 'synced',
        cloudUid: 'cmp_widgets',
        bucketName: 'hq-vault-widgets',
        role: 'admin',
      }),
    ],
    channels: [
      {
        channelId: 'chn_widgets_general',
        id: 'chn_widgets_general',
        name: 'general',
        scope: 'company',
        companyUid: 'cmp_widgets',
        companyName: 'Widgets Co',
        type: 'chat',
        visibility: 'company',
        membership: 'joined',
        unread: 0,
        memberCount: 4,
        lastActivityAt: '2026-09-01T15:00:00.000Z',
      },
    ],
    contacts: [
      {
        personUid: 'prs_lee',
        email: 'lee@widgets.test',
        displayName: 'Lee Ortiz',
        companyUid: 'cmp_widgets',
        source: 'company',
      },
    ],
    expectedPaint: 'conversations',
  },
  indigo: {
    id: 'indigo',
    label: 'Indigo member (today’s default)',
    isIndigo: true,
    whoami: ADA,
    accountId: 'acct_ada',
    workspaces: [
      workspace({
        slug: 'personal',
        displayName: 'Ada Lovelace',
        kind: 'personal',
        state: 'personal',
        cloudUid: 'prs_ada',
        bucketName: 'hq-vault-personal-ada',
        role: null,
        membershipStatus: null,
      }),
      workspace({
        slug: 'indigo',
        displayName: 'Indigo',
        kind: 'company',
        state: 'synced',
        cloudUid: 'cmp_indigo',
        bucketName: 'hq-vault-indigo',
        role: 'owner',
      }),
    ],
    channels: [
      {
        channelId: 'chn_1',
        id: 'chn_1',
        name: 'general',
        scope: 'company',
        companyUid: 'cmp_indigo',
        companyName: 'Indigo',
        type: 'chat',
        visibility: 'company',
        membership: 'joined',
        unread: 1,
        memberCount: 12,
        lastActivityAt: '2026-09-01T16:00:00.000Z',
      },
    ],
    contacts: [
      {
        personUid: 'prs_grace',
        email: 'grace@getindigo.ai',
        displayName: 'Grace Hopper',
        companyUid: 'cmp_indigo',
        source: 'company',
      },
    ],
    expectedPaint: 'conversations',
  },
};

export function isPersonaId(value: string | null | undefined): value is PersonaId {
  return PERSONA_IDS.includes(value as PersonaId);
}

/**
 * Resolve `?persona=` from a query string. Missing / unknown → null so the
 * preview harness keeps its rich Indigo fixtures (today’s default).
 */
export function resolveHarnessPersona(search: string | null | undefined): ShellPersona | null {
  if (!search) return null;
  const raw = search.startsWith('?') ? search.slice(1) : search;
  const id = new URLSearchParams(raw).get('persona');
  if (!isPersonaId(id)) return null;
  return PERSONAS[id];
}

export interface PersonaInvoke {
  invokeFn: SyncInvokeFn;
  calls: string[];
  persona: ShellPersona;
}

function emptyOk(): { status: number; body: string } {
  return { status: 200, body: JSON.stringify({}) };
}

/**
 * Tauri invoke mock that hydrates `HqWorkDesktopShell` as this persona.
 * Directory / contacts / dm-threads succeed with this persona’s data so a
 * missing #setup fallback cannot hide behind a 404-shaped load error.
 */
export function createPersonaInvoke(id: PersonaId): PersonaInvoke {
  const persona = PERSONAS[id];
  const calls: string[] = [];
  const invokeFn: SyncInvokeFn = async (command, args) => {
    calls.push(command);
    switch (command) {
      case 'get_auth_state':
        return {
          authenticated: true,
          accountId: persona.accountId,
          email: persona.whoami.email,
          displayName: persona.whoami.displayName,
        };
      case 'get_auth_session':
        return {
          accountId: persona.accountId,
          generation: 1,
          status: 'active',
          reason: null,
        };
      case 'whoami':
        return persona.whoami;
      case 'is_indigo_user':
        return persona.isIndigo;
      case 'desktop_alt_is_admin':
      case 'meetings_feature_enabled':
        return false;
      case 'list_syncable_workspaces':
        return { workspaces: persona.workspaces };
      case 'list_channels':
      case 'fetch_channel_directory':
        return {
          contractVersion: 2,
          snapshot: true,
          cursor: 'persona-cursor-00000000000000000000000000000000',
          cursorExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
          rows: persona.channels.map((channel) => ({
            channelId: channel.channelId,
            name: channel.name,
            scope: channel.scope,
            type: channel.type ?? 'chat',
            companyUid: channel.companyUid,
          })),
          channels: persona.channels,
        };
      case 'fetch_channel': {
        const channelId = String(args?.channelId ?? persona.channels[0]?.channelId ?? '');
        const channel = persona.channels.find((row) => row.channelId === channelId);
        if (!channel) return { messages: [], nextCursor: null };
        return {
          messages: [
            {
              eventId: `${channel.channelId}-1`,
              fromPersonUid: persona.whoami.personUid,
              fromDisplayName: persona.whoami.displayName,
              fromEmail: persona.whoami.email,
              body: 'Ship check — this thread should paint, not skeleton.',
              createdAt: '2026-09-01T16:01:00.000Z',
              direction: 'in',
            },
          ],
          nextCursor: null,
        };
      }
      case 'list_contacts':
        return { contacts: persona.contacts };
      case 'list_dm_requests':
        return { requests: [] };
      case 'fetch_notifications':
        return { notifications: [], unreadCount: 0, nextCursor: null };
      case 'get_settings':
        return { hqWorkHandoff: false };
      case 'get_config':
        return {
          hqFolderPath: '/Users/qa/Documents/HQ',
          companySlug: persona.workspaces.find((row) => row.kind === 'company')?.slug ?? 'personal',
          configured: true,
        };
      case 'desktop_alt_consume_pending_route':
      case 'meetings_take_pending_focus':
        return null;
      case 'shell_ready':
        return null;
      case 'hq_pro_fetch': {
        const path = String(args?.url ?? '');
        if (path.startsWith('/v1/notify/dm-threads')) {
          return { status: 200, body: JSON.stringify({ threads: [] }) };
        }
        if (path.startsWith('/v1/notify/inbox')) {
          return { status: 200, body: JSON.stringify({ notifications: [] }) };
        }
        if (path.startsWith('/v1/identity/whoami')) {
          return { status: 200, body: JSON.stringify(persona.whoami) };
        }
        return emptyOk();
      }
      default:
        return null;
    }
  };
  return { invokeFn, calls, persona };
}
