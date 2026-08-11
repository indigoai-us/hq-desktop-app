// Fixture props for rendering Popover in the browser preview harness.
// Shapes mirror production Tauri command / Rust serde (camelCase) contracts —
// do not invent fields production never returns.
import type { Workspace } from '../src/lib/workspaces';
import type { ConflictFile } from '../src/stores/conflicts';
import type { CompanyActivity } from '../src/desktop-alt/lib/team-activity';

const minsAgo = (mins: number) => new Date(Date.now() - mins * 60 * 1000).toISOString();

function workspace(overrides: Partial<Workspace>): Workspace {
  return {
    slug: 'indigo',
    displayName: 'Indigo',
    kind: 'company',
    state: 'synced',
    cloudUid: 'cmp_indigo',
    bucketName: 'hq-vault-indigo',
    hasLocalFolder: true,
    localPath: '/Users/corey/Documents/HQ/companies/indigo',
    membershipStatus: 'active',
    role: 'owner',
    lastSyncedAt: minsAgo(7),
    brokenReason: null,
    invitedBy: null,
    invitedAt: null,
    ...overrides,
  };
}

export const workspaces: Workspace[] = [
  workspace({
    slug: 'personal',
    displayName: 'Personal',
    kind: 'personal',
    state: 'personal',
    cloudUid: 'cmp_personal',
    bucketName: 'hq-vault-personal',
    localPath: '/Users/corey/Documents/HQ/personal',
    role: null,
    lastSyncedAt: minsAgo(3),
  }),
  workspace({}),
  workspace({
    slug: 'liverecover',
    displayName: 'LiveRecover',
    state: 'synced',
    cloudUid: 'cmp_liverecover',
    bucketName: 'hq-vault-liverecover',
    localPath: '/Users/corey/Documents/HQ/companies/liverecover',
    role: 'member',
    lastSyncedAt: minsAgo(18),
  }),
  workspace({
    slug: 'moonflow',
    displayName: 'Moonflow',
    cloudUid: 'cmp_moonflow',
    bucketName: 'hq-vault-moonflow',
    localPath: '/Users/corey/Documents/HQ/companies/moonflow',
    role: 'admin',
    lastSyncedAt: minsAgo(41),
  }),
  workspace({
    slug: 'westbound',
    displayName: 'Westbound',
    state: 'cloud-only',
    cloudUid: 'cmp_westbound',
    bucketName: 'hq-vault-westbound',
    hasLocalFolder: false,
    localPath: null,
    role: 'member',
    lastSyncedAt: null,
  }),
  workspace({
    slug: 'holler-mgmt',
    displayName: 'Holler Mgmt',
    state: 'local-only',
    cloudUid: null,
    bucketName: null,
    localPath: '/Users/corey/Documents/HQ/companies/holler-mgmt',
    membershipStatus: null,
    role: null,
    lastSyncedAt: null,
  }),
  workspace({
    slug: 'newco',
    displayName: 'New Co',
    state: 'local-only',
    cloudUid: null,
    bucketName: null,
    localPath: '/Users/corey/Documents/HQ/companies/newco',
    membershipStatus: null,
    role: null,
    lastSyncedAt: null,
  }),
  workspace({
    slug: 'sender-agency',
    displayName: 'Sender Agency',
    state: 'cloud-only',
    cloudUid: 'cmp_sender',
    bucketName: 'hq-vault-sender',
    hasLocalFolder: false,
    localPath: null,
    membershipStatus: 'pending',
    role: null,
    lastSyncedAt: null,
    invitedBy: 'maya@getindigo.ai',
    invitedAt: minsAgo(60 * 25),
  }),
  workspace({
    slug: 'archive-labs',
    displayName: 'Archive Labs',
    state: 'broken',
    cloudUid: 'cmp_archive_old',
    bucketName: 'hq-vault-archive-old',
    localPath: '/Users/corey/Documents/HQ/companies/archive-labs',
    role: 'member',
    lastSyncedAt: null,
    brokenReason: 'manifest cloud_uid does not match the current vault membership',
  }),
];

export const coreState = {
  channel: 'staging' as const,
  targetRepo: 'indigoai-us/hq-core-staging',
  targetVersion: '15.0.1',
  targetRef: 'staging',
  localVersion: '15.0.1',
  floorSha: null,
  isEligible: true,
  versionBehind: true,
  driftReport: {
    count: 14,
    modified: [],
    missing: [],
    added: [],
    scannedAt: new Date().toISOString(),
    hqVersion: '15.0.1',
    targetRepo: 'indigoai-us/hq-core-staging',
    targetRef: 'staging',
  },
  unchangedCount: 1200,
  userOnlyCount: 30,
  scannedAt: new Date().toISOString(),
};

/**
 * Conflict rows for the popover rescue card (US-017). Shape matches
 * `ConflictFile` from stores/conflicts.ts (path + hashes + canAutoResolve + status).
 */
export const conflictFixtures: ConflictFile[] = [
  {
    path: 'companies/indigo/projects/hq-desktop-app/prd.json',
    localHash: 'local-preview-a',
    remoteHash: 'remote-preview-a',
    canAutoResolve: false,
    status: 'pending',
  },
  {
    path: 'companies/indigo/knowledge/release-notes.md',
    localHash: 'local-preview-b',
    remoteHash: 'remote-preview-b',
    canAutoResolve: true,
    status: 'pending',
  },
];

// Minimal notification-panel popover props (US-001 chrome strip — no header
// tabs, overflow menu, or desktop-view footer).
export const popoverProps = {
  syncState: 'idle' as const,
  config: {
    configured: true,
    companySlug: 'indigo',
    hqFolderPath: '/Users/corey/Documents/HQ',
  },
  workspaces,
  cloudReachable: true,
  cloudError: null,
  manifestError: null,
  conflicts: [] as ConflictFile[],
  showConflictModal: false,
  updateAvailable: null,
  updateInstalling: false,
  // US-017 version / drift rows — production defaults when no core state.
  hqVersion: '15.0.16' as string | null,
  coreDriftCount: 0,
  coreNeedsUpdate: false,
  coreInstalling: false,
  onsync: () => console.debug('[harness] sync'),
  onresolve: (_path: string, _strategy: 'keep-local' | 'keep-remote') => {},
  onopen: (_path: string) => {},
  ondismissconflicts: () => {},
  oninstallupdate: () => {},
  oninstallcore: () => {},
  onopendrift: () => {},
  bindStatsRefresh: () => {},
};

/**
 * Popover props for `?view=popover&scenario=rescue` — live conflict rescue card
 * with Keep local / Keep cloud + Open in editor (US-017).
 */
export const popoverRescueProps = {
  ...popoverProps,
  syncState: 'conflict' as const,
  conflicts: conflictFixtures,
  showConflictModal: true,
  conflictCount: conflictFixtures.length,
  conflictCompany: 'indigo',
};

/**
 * Popover props for `?view=popover&scenario=drift` — HQ core drift + restore
 * and a pending desktop app update row (US-017).
 */
export const popoverDriftProps = {
  ...popoverProps,
  coreDriftCount: 2,
  coreNeedsUpdate: true,
  updateAvailable: {
    version: '0.10.36-beta.1',
    body: 'Desktop surface repairs and updater recovery.',
    date: '2026-07-26',
  },
};

/**
 * Legacy shape kept for reference / future desktop-view surfaces (US-005).
 * The menubar popover no longer hosts the CLI-update overflow block.
 */
export const hqCliUpdateAvailable = {
  local: '5.38.2',
  latest: '5.41.0',
};

/**
 * Team vault analytics — empty / zeroed (HTTP 200 empty vault). Matches
 * `CompanyActivity` (hq-desktop-core + team-activity.ts). Optional extension
 * fields (`membersDetail`, `stats.vaultBytes`) are deliberately ABSENT so the
 * UI treats them as no-data (hq-absent-field-never-means-constraining-value).
 */
export const companyActivityEmpty: CompanyActivity = {
  stats: {
    files7: 0,
    edits7: 0,
    members: 0,
    vaultSize: '',
  },
  sparkline: [],
  top: [],
};

/**
 * Team vault analytics — populated production shape plus optional US-019
 * extensions (`vaultBytes`, `membersDetail`). Includes `recent` only when
 * used via the Tauri wire (see mocks/core.ts); the TS adapter omits recent.
 */
export const companyActivityPopulated: CompanyActivity & {
  recent: Array<{ who: string; what: string; file: string; when: string }>;
} = {
  stats: {
    files7: 128,
    edits7: 342,
    members: 5,
    vaultSize: '2.4 GB',
    vaultBytes: 2_576_980_377,
  },
  sparkline: [4, 9, 2, 14, 7, 21, 5, 12, 3, 18, 9, 11, 6, 16],
  recent: [
    {
      who: 'corey@getindigo.ai',
      what: 'Updated',
      file: 'companies/indigo/projects/desktop-experience/README.md',
      when: 'just now',
    },
    {
      who: 'maya@getindigo.ai',
      what: 'Created',
      file: 'companies/indigo/knowledge/release-notes.md',
      when: '2h ago',
    },
    {
      who: 'jacob@getindigo.ai',
      what: 'Synced from cloud',
      file: 'companies/indigo/policies/desktop.md',
      when: 'Yesterday',
    },
  ],
  top: [
    { who: 'corey@getindigo.ai', edits: 142 },
    { who: 'maya@getindigo.ai', edits: 88 },
    { who: 'sam@liverecover.com', edits: 51 },
    { who: 'jacob@getindigo.ai', edits: 23 },
  ],
  membersDetail: [
    { who: 'corey@getindigo.ai', edits: 142, bytes: 1_048_576 },
    { who: 'maya@getindigo.ai', edits: 88, bytes: 524_288 },
    { who: 'sam@liverecover.com', edits: 51, bytes: 262_144 },
    { who: 'jacob@getindigo.ai', edits: 23, bytes: 131_072 },
  ],
};

/**
 * Banner-notification fixtures for `?view=banner&kind=...`. Shapes mirror the
 * Rust `BannerPayload` (camelCase) so the harness preview matches production.
 */
export const bannerFixtures: Record<string, Record<string, unknown>> = {
  share: {
    kind: 'share',
    title: 'Stefan Schmidt',
    body: 'Sharing the Q1 forecast — take a look before our sync.',
    iconText: '●',
    actionLabel: 'Open',
    actionId: 'open',
    clickActionId: 'open',
    data: {},
  },
  meeting: {
    kind: 'meeting',
    title: 'Zoom meeting detected',
    body: 'Zoom: Weekly sync',
    iconText: '●',
    actionLabel: 'Record',
    actionId: 'record',
    clickActionId: 'open',
    data: { windowId: 'preview-window-1', platform: 'zoom' },
  },
  dm: {
    kind: 'dm',
    title: 'Corey Epstein',
    body: 'Can you review the notification banner change when you get a sec?',
    iconText: '●',
    actionLabel: 'Copy prompt',
    actionId: 'copy',
    clickActionId: 'open',
    data: {},
  },
  update: {
    kind: 'update',
    title: 'New version',
    body: 'Version 0.4.4 is ready — custom HQ-branded notification banners.',
    iconText: '⬆',
    actionLabel: 'Update now',
    actionId: 'update',
    clickActionId: 'open',
    data: { version: '0.4.4' },
  },
};
