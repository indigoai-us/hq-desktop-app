/**
 * Preview-only answers for the visual first run's "Your team", Note taker
 * and Project management screens (audit-switches.ts `?team=` and `?apps=`,
 * with a `?firstrun=visual...` switch). Nothing here reaches the bundle.
 *
 *   ?team=invites   two companies invited the person; Join answers after ?loadingMs
 *   ?team=member    the person belongs to one company (the default pick, so
 *                   the app screens show for it)
 *   ?team=many      fourteen companies: the filter field shows
 *   ?team=fail      invites, and Join and Start a company both fail
 *   ?apps=on        the catalog lists note takers and trackers; Connect works
 *   ?apps=empty     the catalog has none of either kind
 *   ?apps=forbidden the catalog read is refused (not an owner or admin)
 *   ?apps=fail      Connect fails, to see the failure line with Retry
 */

export type TeamSwitch = 'invites' | 'member' | 'many' | 'fail';
export type AppsSwitch = 'on' | 'empty' | 'forbidden' | 'fail';

function params(search?: string | null): URLSearchParams {
  const raw = search ?? (typeof window === 'undefined' ? '' : window.location.search);
  return new URLSearchParams(raw.startsWith('?') ? raw.slice(1) : raw);
}

export function teamSwitch(search?: string | null): TeamSwitch | null {
  const value = params(search).get('team');
  return value === 'invites' || value === 'member' || value === 'many' || value === 'fail' ? value : null;
}

export function appsSwitch(search?: string | null): AppsSwitch | null {
  const value = params(search).get('apps');
  return value === 'on' || value === 'empty' || value === 'forbidden' || value === 'fail' ? value : null;
}

function workspace(slug: string, displayName: string, status: 'active' | 'pending', uid: string): Record<string, unknown> {
  return {
    slug,
    displayName,
    kind: 'company',
    state: status === 'active' ? 'synced' : 'cloud-only',
    cloudUid: uid,
    bucketName: null,
    hasLocalFolder: status === 'active',
    localPath: null,
    membershipStatus: status,
    role: status === 'active' ? 'owner' : null,
    lastSyncedAt: null,
    brokenReason: null,
    invitedBy: status === 'pending' ? 'prs_preview' : null,
    invitedAt: status === 'pending' ? '2026-10-08T12:00:00.000Z' : null,
  };
}

const PERSONAL = {
  slug: 'personal',
  displayName: 'Personal',
  kind: 'personal',
  state: 'personal',
  cloudUid: null,
  bucketName: null,
  hasLocalFolder: true,
  localPath: null,
  membershipStatus: null,
  role: null,
  lastSyncedAt: null,
  brokenReason: null,
  invitedBy: null,
  invitedAt: null,
};

export function teamWorkspaces(kind: TeamSwitch): Record<string, unknown>[] {
  if (kind === 'member') return [PERSONAL, workspace('acme-robotics', 'Acme Robotics', 'active', 'cmp_acme')];
  if (kind === 'many') {
    const names = ['Acme Robotics', 'Blue Harbor', 'Cedar Labs', 'Delta Works', 'Ember Studio', 'Fjord Health', 'Granite Co', 'Helix Bio', 'Iris Media', 'Juniper AI', 'Kestrel Ops', 'Lumen Retail', 'Mesa Foods', 'Nimbus Cloud'];
    return [PERSONAL, ...names.map((n, i) => workspace(n.toLowerCase().replace(/\s+/g, '-'), n, i < 2 ? 'pending' : 'active', `cmp_${i}`))];
  }
  return [
    PERSONAL,
    workspace('acme-robotics', 'Acme Robotics', 'pending', 'cmp_acme'),
    workspace('blue-harbor', 'Blue Harbor', 'pending', 'cmp_harbor'),
  ];
}

const CATALOG = [
  { name: 'Granola', domain: 'granola.ai', description: 'AI meeting notes', authClass: 'none', entryId: 'cat_granola' },
  { name: 'Fathom', domain: 'fathom.video', description: 'Records and summarizes calls', authClass: 'oauth', entryId: 'cat_fathom' },
  { name: 'Zoom', domain: 'zoom.us', description: 'Meetings and recordings', authClass: 'oauth', entryId: 'cat_zoom' },
  { name: 'Loom', domain: 'loom.com', description: 'Video messages', authClass: 'key', entryId: 'cat_loom' },
  { name: 'Linear', domain: 'linear.app', description: 'Issues and projects', authClass: 'none', entryId: 'cat_linear' },
  { name: 'Jira', domain: 'atlassian.com', description: 'Atlassian Jira', authClass: 'oauth', entryId: 'cat_jira' },
  { name: 'Asana', domain: 'asana.com', description: 'Tasks and projects', authClass: 'oauth', entryId: 'cat_asana' },
  { name: 'ClickUp', domain: 'clickup.com', description: 'Tasks, docs and goals', authClass: 'oauth', entryId: 'cat_clickup' },
  { name: 'Notion', domain: 'notion.so', description: 'Docs and wikis', authClass: 'oauth', entryId: 'cat_notion' },
  { name: 'Sentry', domain: 'sentry.io', description: 'Errors', authClass: 'oauth', entryId: 'cat_sentry' },
];

/** Domains connected in this page load (Connect in the preview). */
const connected = new Map<string, string>();

function later<T>(ms: number, run: () => T): Promise<T> {
  return new Promise((resolve, reject) =>
    setTimeout(() => {
      try {
        resolve(run());
      } catch (err) {
        reject(err);
      }
    }, ms),
  );
}

/**
 * The answer for a command under `?team=` / `?apps=`, or undefined when the
 * switches do not claim it.
 */
export function firstRunScreensAnswer(
  cmd: string,
  args: Record<string, unknown> | undefined,
  search?: string | null,
): { value: unknown } | undefined {
  const team = teamSwitch(search);
  const apps = appsSwitch(search);
  const ms = Number(params(search).get('loadingMs')) || 2500;
  const url = typeof args?.url === 'string' ? args.url : '';
  if (team) {
    if (cmd === 'list_syncable_workspaces') {
      return {
        value: { workspaces: teamWorkspaces(team), cloudReachable: true, error: null, hqFolderPath: '/Users/corey/Documents/HQ', manifestError: null },
      };
    }
    if (cmd === 'claim_pending_company_invite') {
      return {
        value: later(ms, () => {
          if (team === 'fail') throw new Error('harness: claim failed');
          return { ok: true, claimedSlugs: [String(args?.slug ?? args?.companySlug ?? '')], message: 'Joined' };
        }),
      };
    }
    if (team === 'fail' && cmd === 'fetch_channel') {
      return { value: later(400, () => { throw new Error('harness: create company unavailable'); }) };
    }
  }
  if (apps && cmd === 'hq_pro_fetch') {
    if (url.startsWith('/v1/integrations/factory/catalog')) {
      if (apps === 'forbidden') {
        return { value: { status: 403, body: JSON.stringify({ error: 'INTEGRATION_FACTORY_FORBIDDEN', message: 'Forbidden' }) } };
      }
      const entries = apps === 'empty' ? CATALOG.filter((e) => e.domain === 'notion.so' || e.domain === 'sentry.io') : CATALOG;
      return { value: later(600, () => ({ status: 200, body: JSON.stringify({ ok: true, companyUid: 'cmp_acme', entries }) })) };
    }
    if (url.startsWith('/v1/integrations/admin')) {
      const connections = [...connected].map(([domain, createdAt], i) => ({
        id: `conn_${i}`,
        provider: `factory:${domain.split('.')[0]}`,
        status: 'connected',
        createdAt,
        createdBy: 'prs_preview',
        installation: { domain, displayName: domain },
        access: { mode: 'everyone' },
      }));
      return { value: { status: 200, body: JSON.stringify({ viewer: { personUid: 'prs_preview', canManageIntegrations: true }, connections, audit: [] }) } };
    }
    if (url.startsWith('/v1/integrations/factory/install') || url.startsWith('/v1/integrations/factory/oauth/start')) {
      const body = typeof args?.body === 'string' ? JSON.parse(args.body) : (args?.body ?? {});
      const ref = body as Record<string, unknown>;
      const domain = String(ref.domain ?? CATALOG.find((e) => e.entryId === ref.catalogEntryId)?.domain ?? '');
      const oauth = url.includes('oauth');
      return {
        value: later(ms, () => {
          if (apps === 'fail') return { status: 500, body: JSON.stringify({ error: 'boom' }) };
          if (oauth) {
            // The browser sign-in "finishes" a beat later: the poll then finds it.
            setTimeout(() => connected.set(domain, new Date().toISOString()), 1500);
            return { status: 200, body: JSON.stringify({ provider: domain, displayName: domain, authorizationUrl: 'https://example.com/oauth-preview', state: 's', expiresAt: '2026-12-01T00:00:00Z' }) };
          }
          connected.set(domain, new Date().toISOString());
          return { status: 200, body: JSON.stringify({ connection: { id: 'conn_new', provider: domain }, installation: { displayName: domain } }) };
        }),
      };
    }
  }
  return undefined;
}
