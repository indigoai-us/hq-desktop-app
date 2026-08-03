// Mock of @tauri-apps/api/core for the browser preview harness.
// Returns plausible fixture data per command so components mount and render
// without a Tauri backend. Design-only: no real side effects.
import type { Workspace } from '../../src/lib/workspaces';
import { emit } from './event';

const settings = {
  hqPath: '/Users/corey/Documents/HQ',
  syncOnLaunch: false,
  notifications: true,
  startAtLogin: true,
  realtimeSync: true,
  personalSyncEnabled: true,
  instantSync: true,
  shareNotifications: true,
  dmNotifications: true,
  cliAutoUpdate: true,
  autoUpdate: true,
  stagingChannel: true,
  releaseChannel: null as string | null,
  meetingDetectNotify: {
    enabled: true,
    platforms: ['zoom', 'meet', 'teams', 'slack', 'webex'],
  },
  defaultRecordingCompanyUid: 'cmp_indigo' as string | null,
  telemetryEnabled: true,
  widgetEnabled: true,
  widgetDisplay: null as string | null,
};

function harnessScenario(): string | null {
  const params = new URLSearchParams(window.location.search);
  const explicitScenario = params.get('scenario');
  if (explicitScenario) return explicitScenario;

  // `?view=onboarding&step=2` promises a directly inspectable setup screen.
  // Hold the long-running sync stage by default so the preview cannot race
  // through completion and leave Computer Use looking at a transition gap.
  if (params.get('view') === 'onboarding' && params.get('step') === '2') {
    return 'onboarding-progress';
  }

  return null;
}

const HARNESS_UPDATE = {
  version: '0.10.36-beta.1',
  body: 'Desktop surface repairs and updater recovery.',
  date: '2026-07-26',
};

let harnessAppUpdateInstalled = false;
let harnessCliVersion = '0.19.4';
let harnessCliDismissed = false;
let harnessPacksUpdated = false;
let harnessCoreVersion = '15.0.16';
let harnessCoreUpdated = false;

const HARNESS_DRIFT = {
  channel: 'release',
  targetRepo: 'indigoai-us/hq-core',
  targetVersion: '15.0.17',
  targetRef: 'v15.0.17',
  localVersion: '15.0.16',
  floorSha: 'floor-preview',
  isEligible: true,
  versionBehind: true,
  driftReport: {
    count: 2,
    modified: [
      {
        path: 'core/policies/desktop-design.md',
        size: 1840,
        gitShaLocal: 'local-design',
        gitShaUpstream: 'upstream-design',
      },
      {
        path: 'core/workers/registry.yaml',
        size: 3920,
        gitShaLocal: 'local-registry',
        gitShaUpstream: 'upstream-registry',
      },
    ],
    missing: [],
    added: [],
    scannedAt: '2026-07-26T12:00:00.000Z',
    hqVersion: '15.0.16',
    targetRepo: 'indigoai-us/hq-core',
    targetRef: 'v15.0.17',
  },
  unchangedCount: 842,
  userOnlyCount: 17,
  scannedAt: '2026-07-26T12:00:00.000Z',
};

function hasSettingsUpdates(scenario = harnessScenario()): boolean {
  return (
    scenario === 'settings-updates' ||
    scenario === 'settings-errors' ||
    scenario === 'update-available'
  );
}

function currentHarnessCoreState() {
  if (harnessScenario() !== 'drift' && !hasSettingsUpdates()) return null;
  if (!harnessCoreUpdated) return HARNESS_DRIFT;
  return {
    ...HARNESS_DRIFT,
    localVersion: harnessCoreVersion,
    versionBehind: false,
    driftReport: {
      ...HARNESS_DRIFT.driftReport,
      count: 0,
      modified: [],
      missing: [],
      added: [],
      hqVersion: harnessCoreVersion,
    },
  };
}

function runHarnessCoreInstall() {
  const scenario = harnessScenario();
  const failed = scenario === 'settings-errors';
  if (!failed) {
    harnessCoreVersion = HARNESS_DRIFT.targetVersion;
    harnessCoreUpdated = true;
  }
  return {
    exit_code: failed ? 1 : 0,
    log_tail: failed
      ? 'Preview: rescue validation failed before replacement'
      : 'Preview: HQ Core replacement complete',
    log_path: failed
      ? '/tmp/hq-rescue-preview.log'
      : '/tmp/hq-rescue-preview-success.log',
  };
}

// ---------------------------------------------------------------------------
// Company-board fixtures (representative Indigo data) — for the ?view=company
// harness. Wire shapes mirror the US-003/US-011 Rust commands.
// ---------------------------------------------------------------------------

const COMPANY_GOALS = {
  objectives: [
    {
      id: 'in-obj-001',
      title: 'Desktop Experience',
      description: 'Native macOS/desktop apps that make HQ feel like a product, not a CLI.',
      status: 'on_track',
      timeframe: '2026',
      owner: null,
      initiativeIds: ['in-init-001'],
      keyResults: [
        { id: 'kr-1', title: 'Desktop weekly active users', target: 500, current: 310 },
        { id: 'kr-2', title: 'Popover open latency budget met', target: 100, current: 100 },
      ],
    },
    {
      id: 'in-obj-002',
      title: 'Platform Stability',
      description: 'Sync reliability and zero data loss across every workspace.',
      status: 'on_track',
      timeframe: '2026',
      owner: null,
      initiativeIds: ['in-init-002'],
      keyResults: [],
    },
    {
      id: 'in-obj-003',
      title: 'AI Features',
      description: 'Agentic workflows woven across the HQ surface.',
      status: 'at_risk',
      timeframe: '2026',
      owner: null,
      initiativeIds: ['in-init-003'],
      keyResults: [],
    },
    {
      id: 'in-obj-004',
      title: 'Go-to-Market',
      description: 'Grow HQ adoption beyond the dogfood team.',
      status: 'on_track',
      timeframe: '2026',
      owner: null,
      initiativeIds: ['in-init-004'],
      keyResults: [],
    },
  ],
  initiatives: [
    { id: 'in-init-001', title: 'Desktop Experience', description: '', status: 'active' },
    { id: 'in-init-002', title: 'Platform Stability', description: '', status: 'active' },
  ],
};

const COMPANY_PROJECTS = [
  { id: 'in-proj-201', title: 'Event-driven HQ-Cloud sync', description: 'Push-based sync — drop the 60s poll for instant fan-out.', company: 'indigo', status: 'active', prdPath: 'companies/indigo/projects/event-driven-hq-cloud-sync/prd.json', createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-12T00:00:00Z', storyCount: 8, storiesComplete: 3, provenance: { owner: 'Corey Epstein', creator: 'Maya Chen', origin: 'Indigo board' } },
  { id: 'in-proj-202', title: 'S3-versioned conflict handling', description: 'Use S3 object versions to resolve concurrent edits.', company: 'indigo', status: 'in_progress', prdPath: 'companies/indigo/projects/hq-sync-conflict-versioning/prd.json', createdAt: '2026-06-02T00:00:00Z', updatedAt: '2026-06-13T00:00:00Z', storyCount: 6, storiesComplete: 2, provenance: { owner: 'Maya Chen', creator: 'Corey Epstein', origin: 'Indigo board' } },
  { id: 'in-proj-203', title: 'Browse vs Sync — role-aware sharing', description: 'Let viewers browse a vault without a full local sync.', company: 'indigo', status: 'in_progress', prdPath: 'companies/indigo/projects/hq-sync-browse-vs-sync/prd.json', createdAt: '2026-06-03T00:00:00Z', updatedAt: '2026-06-11T00:00:00Z', storyCount: 5, storiesComplete: 1, provenance: { creator: 'Jacob Lee', origin: 'Indigo board' } },
  { id: 'in-proj-125', title: 'HQ Sync Desktop — Flagship Company OS', description: 'Top-level Board, Projects port, actionable surfaces.', company: 'indigo', status: 'completed', prdPath: 'companies/indigo/projects/hq-sync-desktop-flagship/prd.json', createdAt: '2026-05-30T00:00:00Z', updatedAt: '2026-06-09T00:00:00Z', storyCount: 12, storiesComplete: 12, provenance: { owner: 'Corey Epstein', creator: 'Corey Epstein', origin: 'Indigo board' } },
  { id: 'in-proj-204', title: 'Instant DM delivery', description: 'MQTT-over-WSS wake signal for sub-second DMs.', company: 'indigo', status: 'completed', prdPath: 'companies/indigo/projects/instant-dm-delivery/prd.json', createdAt: '2026-06-04T00:00:00Z', updatedAt: '2026-06-10T00:00:00Z', storyCount: 5, storiesComplete: 5, provenance: { owner: 'Izzy', creator: 'Jacob Lee', origin: 'Indigo board' } },
  { id: 'in-proj-205', title: 'Meeting detect + notify', description: 'Clickable detected-meeting notifications + permissions wizard.', company: 'indigo', status: 'prd_created', prdPath: 'companies/indigo/projects/meeting-detect-notify/prd.json', createdAt: '2026-06-05T00:00:00Z', updatedAt: '2026-06-08T00:00:00Z', storyCount: 7, storiesComplete: 0, provenance: { creator: 'Maya Chen', origin: 'Indigo board' } },
  { id: 'in-proj-206', title: 'S3 → Laptop Live Sync', description: 'Continuous background sync without manual triggers.', company: 'indigo', status: 'exploring', prdPath: null, createdAt: '2026-06-06T00:00:00Z', updatedAt: '2026-06-07T00:00:00Z', storyCount: 0, storiesComplete: 0, provenance: { creator: 'Corey Epstein', origin: 'Idea bank' } },
];

const LIBRARY_ROOT = {
  workers: [
    { id: 'architect', name: 'Architect', type: 'CodeWorker', description: 'Surface architecture tradeoffs and deep-module opportunities.', scope: 'root', status: 'active', path: 'core/workers/public/dev-team/architect/', team: 'dev-team' },
    { id: 'frontend-dev', name: 'Frontend Dev', type: 'CodeWorker', description: 'Build polished desktop and web interfaces.', scope: 'root', status: 'active', path: 'core/workers/public/dev-team/frontend-dev/', team: 'dev-team' },
    { id: 'paper-designer', name: 'Paper Designer', type: 'DesignWorker', description: 'Translate Paper references into implementable UI systems.', scope: 'root', status: 'active', path: 'core/workers/public/paper-designer/', team: 'design' },
    { id: 'indigo-cmo', name: 'Indigo CMO', type: 'OpsWorker', description: 'Company-scoped go-to-market planning.', scope: 'company', company: 'indigo', status: 'active', path: 'companies/indigo/workers/cmo/' },
    { id: 'liverecover-analyst', name: 'Liverecover Analyst', type: 'ResearchWorker', description: 'Analyze local company signals and market notes.', scope: 'company', company: 'liverecover', status: 'active', path: 'companies/liverecover/workers/analyst/' },
  ],
  skills: [
    { name: 'startwork', description: 'Start a work session from local HQ context.', scope: 'root', path: '.claude/skills/startwork/SKILL.md', allowedTools: ['Read', 'Bash'] },
    { name: 'plan', description: 'Create an execution-ready project plan.', scope: 'root', path: '.claude/skills/plan/SKILL.md', allowedTools: ['Read', 'Write'] },
    { name: 'search', description: 'Search across HQ knowledge and projects.', scope: 'root', path: '.claude/skills/search/SKILL.md', allowedTools: ['Read', 'Bash'] },
    { name: 'signals', description: 'Read company signals and action items.', scope: 'company', company: 'indigo', path: 'companies/indigo/skills/signals/SKILL.md', allowedTools: ['Read'] },
  ],
};

const LIBRARY_COMPANY = {
  workers: LIBRARY_ROOT.workers.filter((worker) => worker.company === 'indigo'),
  skills: LIBRARY_ROOT.skills.filter((skill) => skill.company === 'indigo'),
};

const MARKETPLACE_LISTINGS = [
  {
    id: 'lst_engineering',
    type: 'worker',
    name: 'hq-pack-engineering',
    slug: 'engineering',
    version: '2.4.1',
    author: 'indigo',
    summary: 'A focused software-delivery team for planning, implementation, review, and release.',
    contributes: 'Workers and skills for end-to-end product engineering.',
    createdAt: '2026-07-18T12:00:00.000Z',
  },
  {
    id: 'lst_impeccable',
    type: 'skill',
    name: 'hq-pack-impeccable',
    slug: 'impeccable',
    version: '1.3.0',
    author: 'indigo',
    summary: 'Systematic visual design critique and interface polish.',
    contributes: 'Design-review and refinement skills.',
    createdAt: '2026-07-15T12:00:00.000Z',
  },
  {
    id: 'lst_gstack',
    type: 'worker',
    name: 'hq-pack-gstack',
    slug: 'gstack',
    version: '1.9.2',
    author: 'garry',
    summary: 'A pragmatic generalist stack for shipping web products.',
    contributes: 'Planning, browser QA, review, and release workflows.',
    createdAt: '2026-07-12T12:00:00.000Z',
  },
];

let HARNESS_MODERATION_QUEUE = [
  {
    id: 'lst_pending_engineering',
    type: 'worker',
    name: 'hq-pack-engineering-next',
    slug: 'engineering-next',
    version: '2.5.0',
    author: 'indigo',
    summary: 'The next engineering pack release, awaiting reviewer approval.',
    contributes: 'Planning, implementation, quality, and release workers.',
    submittedAt: '2026-07-25T16:30:00.000Z',
    files: ['package.yaml', 'workers/engineer.md', 'skills/review/SKILL.md'],
    instructions: [
      {
        path: 'skills/review/SKILL.md',
        text: 'Inspect the complete change and report every actionable issue before release.',
      },
      {
        path: 'package.yaml#initialization.prompt',
        text: 'Read the installed pack instructions and confirm the active company before use.',
      },
    ],
    injectionScan: [],
    versionLock: 'preview-v1',
  },
];

let HARNESS_CREATOR_APPLICATIONS = [
  {
    applicationId: 'app_preview_creator',
    applicantUid: 'prs_preview_creator',
    applicantEmail: 'alex@example.com',
    handle: 'alex-builds',
    reason: 'I publish tested desktop workflow packs for small product teams.',
    status: 'pending',
    submittedAt: '2026-07-24T14:10:00.000Z',
  },
];

function meetingFixture(
  id: string,
  summary: string,
  daysFromToday: number,
  hour: number,
  minute: number,
  durationMinutes: number,
  companyUid = 'cmp_indigo',
) {
  const start = new Date();
  start.setDate(start.getDate() + daysFromToday);
  start.setHours(hour, minute, 0, 0);
  const end = new Date(start.getTime() + durationMinutes * 60_000);
  return {
    id,
    summary,
    start: { dateTime: start.toISOString() },
    end: { dateTime: end.toISOString() },
    status: 'confirmed',
    meetingUrl: `https://meet.google.com/${id}`,
    sourceCalendarId: 'primary',
    sourceAccountId: 'acct-indigo',
    sourceCompanyUid: companyUid,
  };
}

function meetingFixtures() {
  return [
    {
      ...meetingFixture('weekly-creative', 'Weekly creative review', 0, 11, 0, 45),
      signals: [
        { type: 'action', title: 'Approve the revised storyboard' },
        { type: 'decision', title: 'Ship the compact shell' },
      ],
    },
    meetingFixture('desktop-standup', 'HQ Desktop standup', 0, 15, 30, 30),
    meetingFixture('recovery-sync', 'Recovery sync', 1, 10, 0, 30, 'cmp_liverecover'),
    meetingFixture('platform-review', 'Platform stability review', 2, 13, 0, 60),
  ];
}

function meetingBotFixtures() {
  const events = meetingFixtures();
  return [
    {
      botId: 'bot-weekly-creative',
      meetingUrl: events[0].meetingUrl,
      platform: 'google_meet',
      status: 'scheduled',
      calendarEventId: events[0].id,
      meetingTitle: events[0].summary,
      scheduledStartTime: events[0].start.dateTime,
      autoScheduled: true,
      sourceLanded: false,
    },
    {
      botId: 'bot-platform-review',
      meetingUrl: events[3].meetingUrl,
      platform: 'google_meet',
      status: 'scheduled',
      calendarEventId: events[3].id,
      meetingTitle: events[3].summary,
      scheduledStartTime: events[3].start.dateTime,
      autoScheduled: false,
      sourceLanded: false,
    },
  ];
}

// PRDs keyed by prdPath — enough stories for classifyStories to surface an
// in-progress one (its title shows on the in-flight row + drill-in Kanban).
function prdFor(name: string, current: string, done: number, total: number) {
  const stories = [] as Array<Record<string, unknown>>;
  for (let i = 0; i < total; i++) {
    stories.push({
      id: `US-${String(i + 1).padStart(3, '0')}`,
      title: i === done ? current : i < done ? `Completed step ${i + 1}` : `Planned step ${i + 1}`,
      description: '',
      acceptanceCriteria: ['Behaves as specified', 'Has a regression test'],
      passes: i < done,
      priority: i < 2 ? '1' : '2',
      labels: i < done ? ['done'] : ['todo'],
      dependsOn: i > 0 ? [`US-${String(i).padStart(3, '0')}`] : [],
      provenance: {
        assignee: i % 2 === 0 ? 'Izzy' : 'Maya Chen',
        creator: 'Corey Epstein',
        origin: `${name} PRD`,
      },
    });
  }
  return { name, description: '', branchName: null, userStories: stories, metadata: {} };
}

const COMPANY_PRDS: Record<string, unknown> = {
  'companies/indigo/projects/event-driven-hq-cloud-sync/prd.json': prdFor('Event-driven HQ-Cloud sync', 'Wire the IoT push receiver into the sync loop', 3, 8),
  'companies/indigo/projects/hq-sync-conflict-versioning/prd.json': prdFor('S3-versioned conflict handling', 'Resolve conflicts from the S3 version cursor', 2, 6),
  'companies/indigo/projects/hq-sync-browse-vs-sync/prd.json': prdFor('Browse vs Sync', 'Add the role-aware browse-only vault view', 1, 5),
};

type Handler = (args?: Record<string, unknown>) => unknown;

function minutesAgo(mins: number): string {
  return new Date(Date.now() - mins * 60 * 1000).toISOString();
}

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
    lastSyncedAt: minutesAgo(7),
    brokenReason: null,
    invitedBy: null,
    invitedAt: null,
    ...overrides,
  };
}

const HARNESS_WORKSPACES: Workspace[] = [
  workspace({
    slug: 'personal',
    displayName: 'Corey Epstein',
    kind: 'personal',
    state: 'personal',
    cloudUid: 'cmp_personal',
    bucketName: 'hq-vault-personal',
    localPath: '/Users/corey/Documents/HQ/personal',
    role: null,
    lastSyncedAt: minutesAgo(3),
  }),
  workspace({}),
  workspace({
    slug: 'liverecover',
    displayName: 'Liverecover',
    cloudUid: 'cmp_liverecover',
    bucketName: 'hq-vault-liverecover',
    localPath: '/Users/corey/Documents/HQ/companies/liverecover',
    role: 'member',
    lastSyncedAt: minutesAgo(18),
  }),
  workspace({
    slug: 'moonflow',
    displayName: 'Moonflow',
    cloudUid: 'cmp_moonflow',
    bucketName: 'hq-vault-moonflow',
    localPath: '/Users/corey/Documents/HQ/companies/moonflow',
    role: 'admin',
    lastSyncedAt: minutesAgo(41),
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
];

const handlers: Record<string, Handler> = {
  // Deterministic full-desktop route for visual QA:
  //   ?view=desktop&route=company:indigo:projects
  // Mirrors the native pending-route handoff consumed once on mount.
  desktop_alt_consume_pending_route: () =>
    new URLSearchParams(window.location.search).get('route'),
  // Company-board path (?view=company)
  list_syncable_workspaces: () => ({
    workspaces: HARNESS_WORKSPACES,
    cloudReachable: true,
    error: null,
    hqFolderPath: '/Users/corey/Documents/HQ',
    manifestError: null,
  }),
  get_company_board: (args) => ({
    inbox: [
      {
        id: `${String(args?.slug ?? 'company')}-board-inbox`,
        title: 'Review desktop recovery notes',
        subtitle: 'New signal from the latest sync',
        labels: ['desktop'],
        assigneeInitials: 'CE',
        age: '12m',
      },
    ],
    doing: [
      {
        id: `${String(args?.slug ?? 'company')}-board-doing`,
        title: 'Deep settings verification',
        subtitle: 'Updater, permissions, and display states',
        labels: ['in progress'],
        assigneeInitials: 'MC',
        age: 'now',
      },
    ],
    review: [],
    done: [],
  }),
  connect_workspace_to_cloud: () => null,
  get_sync_mode: (args) => ({
    syncMode: args?.companySlug === 'liverecover' ? 'shared' : 'all',
  }),
  // Echo the requested mode back so the Companies-page Shared/All toggle
  // resolves its optimistic write in the browser harness (mirrors the real
  // set_sync_mode, which returns the resulting MembershipSyncConfig).
  set_sync_mode: (args) => ({ syncMode: args?.mode ?? 'all' }),
  get_config: () => ({ hqFolderPath: '/Users/corey/Documents/HQ', companySlug: 'indigo', configured: true }),
  check_core_state: () => currentHarnessCoreState(),
  // Lazy HQ file tree (?view=desktop → company Knowledge tab / Files mode).
  // Serves a small knowledge subtree for any company so the inline
  // CompanyKnowledgePanel (US-014) is drivable in the browser harness.
  list_hq_dir: (args) => {
    const rel = String(args?.relPath ?? '');
    if (rel === '') {
      return [
        { name: 'companies', path: 'companies', isDir: true, hasChildren: true },
        { name: 'personal', path: 'personal', isDir: true, hasChildren: true },
        { name: 'repos', path: 'repos', isDir: true, hasChildren: true },
        { name: 'core', path: 'core', isDir: true, hasChildren: true },
        { name: 'README.md', path: 'README.md', isDir: false, hasChildren: false },
      ];
    }
    if (rel === 'companies') {
      return [
        { name: 'indigo', path: 'companies/indigo', isDir: true, hasChildren: true },
        { name: 'liverecover', path: 'companies/liverecover', isDir: true, hasChildren: true },
      ];
    }
    if (rel === 'personal') {
      return [
        { name: 'projects', path: 'personal/projects', isDir: true, hasChildren: true },
        { name: 'notes.md', path: 'personal/notes.md', isDir: false, hasChildren: false },
      ];
    }
    if (rel === 'repos') {
      return [
        { name: 'public', path: 'repos/public', isDir: true, hasChildren: true },
        { name: 'private', path: 'repos/private', isDir: true, hasChildren: true },
      ];
    }
    if (rel === 'core') {
      return [
        { name: 'docs', path: 'core/docs', isDir: true, hasChildren: true },
        { name: 'policies', path: 'core/policies', isDir: true, hasChildren: true },
        { name: 'VERSION', path: 'core/VERSION', isDir: false, hasChildren: false },
      ];
    }
    if (/^companies\/[^/]+$/.test(rel)) {
      return [
        { name: 'knowledge', path: `${rel}/knowledge`, isDir: true, hasChildren: true },
        { name: 'projects', path: `${rel}/projects`, isDir: true, hasChildren: true },
        { name: 'policies', path: `${rel}/policies`, isDir: true, hasChildren: true },
      ];
    }
    if (/^companies\/[^/]+\/knowledge$/.test(rel)) {
      return [
        { name: 'guides', path: `${rel}/guides`, isDir: true, hasChildren: true },
        { name: 'overview.md', path: `${rel}/overview.md`, isDir: false, hasChildren: false },
      ];
    }
    if (/^companies\/[^/]+\/knowledge\/guides$/.test(rel)) {
      return [
        { name: 'onboarding.md', path: `${rel}/onboarding.md`, isDir: false, hasChildren: false },
      ];
    }
    if (/^companies\/[^/]+\/projects\/[^/]+$/.test(rel)) {
      return [
        { name: 'notes', path: `${rel}/notes`, isDir: true, hasChildren: true },
        { name: 'README.md', path: `${rel}/README.md`, isDir: false, hasChildren: false },
        { name: 'prd.json', path: `${rel}/prd.json`, isDir: false, hasChildren: false },
      ];
    }
    if (/^companies\/[^/]+\/projects\/[^/]+\/notes$/.test(rel)) {
      return [
        { name: 'architecture.md', path: `${rel}/architecture.md`, isDir: false, hasChildren: false },
      ];
    }
    return [];
  },
  get_company_file_content: (args) => {
    const path = String(args?.path ?? '');
    return `# ${path.split('/').pop()}

Harness preview content for \`${path}\`.

> A quoted operating note with **strong context** and an [action link](https://hq.computer).

| Owner | Status | Next review |
| --- | --- | ---: |
| Corey Epstein | In progress | Jul 29 |
| Maya Chen | Waiting on input | Aug 2 |

- First checklist item
- Second item with \`inline code\`

\`\`\`ts
const surface = { neutral: true, provenance: 'visible' };
\`\`\`

---

This final paragraph verifies spacing after a thematic break.
  `;
  },
  get_authorized_file_preview: (args) => {
    const path = String(args?.path ?? '').toLowerCase();
    return {
      mimeType: path.endsWith('.pdf') ? 'application/pdf' : 'image/png',
      // 1×1 transparent PNG. The harness needs deterministic media bytes,
      // never a local filesystem URL.
      dataBase64:
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+Q3p2AAAAAElFTkSuQmCC',
    };
  },
  reveal_authorized_file: () => null,
  open_authorized_file_in_claude: () => null,
  get_library_root: () => LIBRARY_ROOT,
  get_library_company: () => LIBRARY_COMPANY,
  list_packages: () => ({
    packs: {
      hqRoot: '/Users/corey/Documents/HQ',
      hqVersion: '15.0.66-beta.1',
      installed: [
        {
          name: 'hq-pack-engineering',
          version: '2.4.1',
          publisher: 'indigo',
          source: 'registry:hq-pack-engineering',
          transport: 'registry',
          hqCoreSatisfied: true,
          contributes: { workers: 5, skills: 12 },
          links: { live: 17, broken: 0, missing: 0, foreign: 0 },
          brokenLinks: [],
          inCatalog: true,
          updateAvailable: false,
          initialization: { entrypoint: 'startwork' },
        },
      ],
      available: [],
      warnings: [],
    },
    registry: {
      installed: [
        { name: 'hq-pack-engineering', slug: 'engineering', version: '2.4.1' },
      ],
      available: [{ slug: 'impeccable', tier: 'public' }],
      offline: false,
    },
    error: null,
  }),
  check_package_updates: () => null,
  get_library_worker_detail: (args) => {
    const path = String(args?.workerPath ?? '');
    const worker = LIBRARY_ROOT.workers.find((item) => item.path === path) ?? LIBRARY_ROOT.workers[0];
    return {
      id: worker.id,
      name: worker.name,
      type: worker.type,
      description: worker.description,
      team: worker.team ?? null,
      skills: [{ name: 'startwork', description: 'Load the right company and repo context.' }],
      instructions: `# ${worker.name}\n\nUse local HQ files first and keep work scoped to the selected company.`,
    };
  },
  get_library_skill_detail: (args) => {
    const path = String(args?.skillPath ?? '');
    const skill = LIBRARY_ROOT.skills.find((item) => item.path === path) ?? LIBRARY_ROOT.skills[0];
    return {
      name: skill.name,
      description: skill.description,
      allowedTools: skill.allowedTools,
      body: `# ${skill.name}\n\nRepresentative harness detail for ${skill.description}`,
    };
  },
  list_marketplace_listings: () => MARKETPLACE_LISTINGS,
  list_moderation_queue: () => HARNESS_MODERATION_QUEUE,
  decide_moderation_listing: (args) => {
    const id = String(args?.id ?? '');
    const decision = String(args?.decision ?? 'reject');
    HARNESS_MODERATION_QUEUE = HARNESS_MODERATION_QUEUE.filter((item) => item.id !== id);
    return {
      id,
      status: decision === 'approve' ? 'approved' : 'rejected',
      note: String(args?.note ?? ''),
    };
  },
  list_creator_applications: () => HARNESS_CREATOR_APPLICATIONS,
  decide_creator_application: (args) => {
    const applicationId = String(args?.id ?? '');
    const decision = String(args?.decision ?? 'deny');
    HARNESS_CREATOR_APPLICATIONS = HARNESS_CREATOR_APPLICATIONS.filter(
      (item) => item.applicationId !== applicationId,
    );
    return {
      applicationId,
      status: decision === 'approve' ? 'approved' : 'denied',
      reviewedBy: 'corey@getindigo.ai',
      reviewedAt: '2026-07-26T12:00:00.000Z',
    };
  },
  yank_marketplace_listing: (args) => ({
    id: String(args?.id ?? ''),
    status: 'yanked',
    note: 'Already-installed users are NOT auto-removed in v1.',
  }),
  get_company_deployments: () => [
    { sub: 'app', url: 'app.example.hq.computer', state: 'active', lastDeploy: '8m ago', size: '18.4 MB', ver: 'v0.10.33', pwd: false },
    { sub: 'preview', url: 'preview.hq.computer', state: 'deploying', lastDeploy: 'just now', size: '18.3 MB', ver: 'v0.10.34-rc.1', pwd: true },
    { sub: 'docs', url: 'docs.hq.computer', state: 'paused', lastDeploy: '3d ago', size: '6.8 MB', ver: 'v4.2.0', pwd: false },
  ],
  get_company_secrets: () => [
    {
      env: 'production',
      count: 2,
      items: [
        { key: 'DATABASE_URL', upd: '2d ago', rot: '21d' },
        { key: 'SENTRY_AUTH_TOKEN', upd: '8d ago', rot: '90d' },
      ],
    },
    {
      env: 'staging',
      count: 1,
      items: [{ key: 'API_BASE_URL', upd: '1d ago', rot: '—' }],
    },
  ],
  desktop_alt_is_admin: () => true,
  get_company_summary: () => ({ board: 7, activity: { last7d: 34 }, deployments: 3, secrets: 12 }),
  // Creator per project (from the cloud board's S3 created-by). Some projects
  // intentionally omitted → they stay honestly "Unassigned" in the Lead column.
  get_company_project_creators: () => [
    { id: 'in-proj-201', prdPath: 'companies/indigo/projects/event-driven-hq-cloud-sync/prd.json', creator: 'corey@getindigo.ai' },
    { id: 'in-proj-202', prdPath: 'companies/indigo/projects/hq-sync-conflict-versioning/prd.json', creator: 'maya@getindigo.ai' },
    { id: 'in-proj-125', prdPath: 'companies/indigo/projects/hq-sync-desktop-flagship/prd.json', creator: 'corey@getindigo.ai' },
    { id: 'in-proj-204', prdPath: 'companies/indigo/projects/instant-dm-delivery/prd.json', creator: 'jacob@getindigo.ai' },
  ],
  get_company_activity: () => ({
    stats: { files7: 128, edits7: 342, members: 5, vaultSize: '2.4 GB' },
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
  }),
  get_local_company_goals: () => COMPANY_GOALS,
  get_local_projects: () => COMPANY_PROJECTS,
  list_agent_sessions: () => ({
    sessions: [
      {
        id: 'session-event-sync',
        tool: 'codex',
        origin: 'local',
        cwd: '/Users/corey/Documents/HQ/repos/public/hq-desktop-app',
        project: 'event-driven-hq-cloud-sync',
        company: 'indigo',
        model: 'gpt-5',
        status: 'running',
        startedAt: new Date(Date.now() - 42 * 60_000).toISOString(),
        lastActivityAt: new Date(Date.now() - 30_000).toISOString(),
        source: 'codex-rollout · US-004',
      },
      {
        id: 'session-browse-sync',
        tool: 'claude',
        origin: 'local',
        cwd: '/Users/corey/Documents/HQ',
        project: 'hq-sync-browse-vs-sync',
        company: 'indigo',
        model: 'claude-opus-4-8',
        status: 'awaiting_input',
        startedAt: new Date(Date.now() - 18 * 60_000).toISOString(),
        lastActivityAt: new Date(Date.now() - 2 * 60_000).toISOString(),
        source: 'claude-jsonl',
      },
    ],
    history: [],
    outpost: null,
  }),
  get_company_team_telemetry: () => ({
    perMember: [
      {
        personUid: 'prs_corey',
        displayName: 'Corey Epstein',
        kind: 'human',
        role: 'Owner',
        totals: {
          events: 184,
          distinctSessions: 31,
          skills: { bySkill: [{ skill: 'run-project', count: 22 }, { skill: 'storyboard', count: 14 }] },
        },
        activeProjects: ['HQ Desktop app', 'Event-driven HQ-Cloud sync'],
      },
      {
        personUid: 'agt_izzy',
        displayName: 'Izzy',
        kind: 'agent',
        role: 'Fleet agent',
        totals: {
          events: 143,
          distinctSessions: 28,
          skills: { bySkill: [{ skill: 'dm', count: 36 }, { skill: 'hq-sync', count: 19 }] },
        },
        activeProjects: ['Instant DM delivery'],
      },
      {
        personUid: 'prs_maya',
        displayName: 'Maya Chen',
        kind: 'human',
        role: 'Member',
        totals: {
          events: 88,
          distinctSessions: 17,
          skills: { bySkill: [{ skill: 'review', count: 12 }, { skill: 'quality-gate', count: 9 }] },
        },
        activeProjects: ['S3-versioned conflict handling'],
      },
      {
        personUid: 'agt_lin',
        displayName: 'Lin',
        kind: 'agent',
        totals: {
          events: 51,
          distinctSessions: 9,
          skills: { bySkill: [{ skill: 'diagnose', count: 11 }] },
        },
        activeProjects: [],
      },
    ],
  }),
  get_local_project_prd: (args) =>
    COMPANY_PRDS[(args?.prdPath as string) ?? ''] ?? prdFor('Project', 'Current step in progress', 1, 4),
  get_local_project_readme: () => '# Project\n\nA representative README for the preview harness.',
  get_settings: () => {
    const scenario = harnessScenario();
    if (scenario === 'settings-load-error') {
      throw new Error('Preview: menubar.json could not be read');
    }
    return {
      ...settings,
      widgetDisplay: scenario === 'widget-disconnected' ? 'Studio Display' : settings.widgetDisplay,
    };
  },
  save_settings: (args) => {
    const prefs = (args?.prefs ?? {}) as Partial<typeof settings>;
    Object.assign(settings, prefs);
    return null;
  },
  get_sync_status: () => ({
    lastSyncAt: new Date(Date.now() - 7 * 60 * 1000).toISOString(),
    pendingFiles: 0,
    conflicts: 0,
    daemonRunning: true,
    source: 'menubar',
  }),
  get_activity_log: () => {
    const now = Date.now();
    return [
      { company: 'indigo', path: 'companies/indigo/knowledge/prd.json', bytes: 4096, direction: 'down', author: 'maya@getindigo.ai', isNew: true, at: now - 40 * 1000 },
      { company: 'indigo', path: 'companies/indigo/projects/event-driven/notes.md', bytes: 2210, direction: 'down', author: 'corey@getindigo.ai', isNew: false, at: now - 3 * 60 * 1000 },
      { company: 'liverecover', path: 'companies/liverecover/sources/meetings/2026-06-04.md', bytes: 18400, direction: 'down', author: 'sam@liverecover.com', isNew: true, at: now - 9 * 60 * 1000 },
      { company: 'personal', path: 'personal/projects/redesign/sketch.md', bytes: 980, direction: 'up', author: undefined, isNew: false, at: now - 14 * 60 * 1000 },
      { company: 'indigo', path: 'companies/indigo/policies/e2e-testing.md', bytes: 5120, direction: 'down', author: 'maya@getindigo.ai', isNew: false, at: now - 22 * 60 * 1000 },
    ];
  },
  // Notifications feed (the popover's default body since the redesign). Returns
  // a representative mix of DMs, shares, and cross-session new-file rows so the
  // inline feed renders fully in the browser harness (?view=popover).
  fetch_notification_history: () => {
    const iso = (minsAgo: number) => new Date(Date.now() - minsAgo * 60 * 1000).toISOString();
    return {
      dms: [
        {
          eventId: 'dm-1',
          fromPersonUid: 'prs_grace',
          fromDisplayName: 'Maya Chen',
          fromEmail: 'grace@getindigo.ai',
          body: 'Pushed the conflict-versioning notes — take a look when you get a sec?',
          createdAt: iso(6),
        },
        {
          eventId: 'dm-2',
          fromPersonUid: 'prs_alan',
          fromDisplayName: 'Sam Rivera',
          fromEmail: 'alan@example.com',
          body: 'Meeting recap is synced to the Liverecover folder.',
          createdAt: iso(48),
        },
      ],
      shares: [
        {
          eventId: 'share-1',
          issuerDisplayName: 'Jacob Patel',
          issuerEmail: 'jacob@getindigo.ai',
          // Legacy row — no issuerPersonUid; "Message the sharer" falls back
          // to the email-addressed compose flow.
          issuerPersonUid: '',
          paths: ['companies/indigo/financials/Q2-model.xlsx'],
          note: 'Latest forecast for review',
          permission: 'read',
          createdAt: iso(20),
        },
        {
          eventId: 'share-2',
          issuerDisplayName: 'Ada Lovelace',
          issuerEmail: 'ada@getindigo.ai',
          issuerPersonUid: 'prs_ada',
          paths: [
            'companies/indigo/design/v4-spec.md',
            'companies/indigo/design/tokens.css',
          ],
          note: 'Redesign spec + tokens — reactions land on these cards now.',
          permission: 'read',
          createdAt: iso(4),
        },
      ],
      files: [
        {
          eventId: 'file-1',
          path: 'companies/indigo/knowledge/prd.json',
          bytes: 4096,
          addedBy: 'maya@getindigo.ai',
          companySlug: 'indigo',
          createdAt: iso(40),
        },
        {
          eventId: 'file-2',
          path: 'companies/indigo/policies/e2e-testing.md',
          bytes: 5120,
          addedBy: 'maya@getindigo.ai',
          companySlug: 'indigo',
          createdAt: iso(75),
        },
      ],
    };
  },
  get_autostart_enabled: () => true,
  set_autostart_enabled: () => null,
  meetings_feature_enabled: () => true,
  meetings_list_upcoming: () => meetingFixtures(),
  meetings_list_memberships: () => [
    { companyUid: 'cmp_indigo', companyName: 'Indigo', role: 'owner', status: 'active' },
    { companyUid: 'cmp_liverecover', companyName: 'Liverecover', role: 'member', status: 'active' },
  ],
  meetings_list_accounts: () => [
    { accountId: 'acct-indigo', email: 'corey@getindigo.ai', scope: 'calendar', connectedAt: '2026-06-01T10:00:00Z' },
  ],
  meetings_list_calendars_for_account: () => ({
    calendars: [{ id: 'primary', summary: 'Corey Epstein', primary: true, accessRole: 'owner' }],
    selectedCalendarIds: ['primary'],
  }),
  meetings_list_scheduled_bots: (args) => {
    const ids = Array.isArray(args?.calendarEventIds) ? args.calendarEventIds : null;
    const bots = meetingBotFixtures();
    return ids ? bots.filter((bot) => ids.includes(bot.calendarEventId)) : bots;
  },
  meetings_list_active_detections: () => [
    {
      windowId: 'preview-meeting-window',
      detectionId: 'preview-meeting-detection',
      platform: 'meet',
      meetingUrl: 'https://meet.google.com/preview-audit',
      detectedAt: '2026-07-26T14:00:00.000Z',
      source: 'preview',
    },
  ],
  meetings_list_active_recordings: () => [],
  is_indigo_user: () => true,
  available_channels: () => ['stable', 'beta', 'alpha'],
  notification_permission_state: () =>
    harnessScenario() === 'permission-denied' ? 'denied' : 'prompt',
  notification_request_permission: () => 'granted',
  resolve_hq_path: () => '/Users/corey/Documents/HQ',
  detect_ai_tools: () => ({
    claude_cli: true,
    claude_desktop: true,
    codex_cli: true,
    codex_desktop: true,
    grok_cli: false,
    claude_last_used_ms: 1_700_000_000_000,
    codex_last_used_ms: 1_699_000_000_000,
    grok_last_used_ms: null,
    any: true,
  }),
  detect_claude_ready: () => ({
    installed: true,
    desktop_installed: true,
    logged_in: true,
  }),
  set_hq_install_path: () => null,
  start_initial_cloud_sync: () =>
    harnessScenario() === 'onboarding-progress'
      ? new Promise<never>(() => {})
      : null,
  pick_folder: () => null,
  check_for_updates: () =>
    hasSettingsUpdates() && !harnessAppUpdateInstalled ? HARNESS_UPDATE : null,
  get_pending_update: () =>
    hasSettingsUpdates() && !harnessAppUpdateInstalled ? HARNESS_UPDATE : null,
  install_update: () => {
    if (harnessScenario() === 'settings-errors') {
      throw new Error('Preview: app update signature verification failed');
    }
    harnessAppUpdateInstalled = true;
    return null;
  },
  check_hq_cli_update: () =>
    hasSettingsUpdates() &&
    harnessCliVersion !== '0.20.0' &&
    !harnessCliDismissed
      ? { local: harnessCliVersion, latest: '0.20.0' }
      : null,
  get_hq_cli_version: () => harnessCliVersion,
  install_hq_cli_update: () => {
    if (harnessScenario() === 'settings-errors') {
      throw new Error('Preview: hq CLI update failed');
    }
    harnessCliVersion = '0.20.0';
    harnessCliDismissed = false;
    return { local: harnessCliVersion, latest: '0.20.0' };
  },
  set_hq_cli_update_dismissed: () => {
    harnessCliDismissed = true;
    return null;
  },
  check_pack_update: () =>
    hasSettingsUpdates() && !harnessPacksUpdated
      ? { count: 2, names: ['hq-pack-engineering', 'hq-pack-parker'] }
      : null,
  update_packs: () => {
    if (harnessScenario() === 'settings-errors') {
      throw new Error('Preview: pack registry unavailable');
    }
    harnessPacksUpdated = true;
    return null;
  },
  get_hq_version: () => harnessCoreVersion,
  install_hq_core_update: () => runHarnessCoreInstall(),
  run_replace_from_staging: () => runHarnessCoreInstall(),
  list_displays: () =>
    harnessScenario() === 'widget-disconnected'
      ? [
          { name: 'Built-in Retina Display', primary: true },
          { name: 'Projector', primary: false },
        ]
      : [
          { name: 'Built-in Retina Display', primary: true },
          { name: 'Studio Display', primary: false },
        ],
  apply_widget_settings: () => null,
  start_daemon: () => null,
  stop_daemon: () => null,
  daemon_status: () => ({ running: true }),
  open_activity_log: () => null,
  open_meetings_window: () => null,
  open_drift_detail: () => null,
  desktop_alt_dev_audit_render: () => null,
  quit_app: () => null,
  // Meeting-permissions wizard (?view=permissions) — a representative
  // not-yet-granted snapshot so the friendly "why we ask" notice is exercised.
  meeting_detect_feature_enabled: () => true,
  meetings_permissions_state: () => ({
    accessibility: 'prompt',
    screenCapture: 'denied',
    microphone: 'prompt',
    fullDiskAccess: 'prompt',
    allRequiredGranted: false,
  }),
  permissions_open_settings: () => null,
  permissions_force_native_register: () => null,

  // -------------------------------------------------------------------------
  // Messaging window fixtures (US-008→011) — representative DMs, a thread, and
  // pending requests so the Messages window renders populated in the harness.
  // -------------------------------------------------------------------------
  get_unread_summary: () => ({ unreadDms: 2, pendingRequests: 2 }),
  list_contacts: () => ({
    contacts: [
      { personUid: 'prs_ada', email: 'ada@getindigo.ai', displayName: 'Ada Lovelace', companyUid: 'cmp_indigo', source: 'company', lastMessageAt: '2026-06-09T19:43:10.000Z', lastMessageBody: 'Please do — I’m restyling it to match the desktop view right now.', lastMessageDirection: 'out' },
      { personUid: 'prs_grace', email: 'grace@getindigo.ai', displayName: 'Grace Hopper', companyUid: 'cmp_indigo', source: 'company' },
      { personUid: 'prs_alan', email: 'alan@example.com', displayName: 'Alan Turing', companyUid: null, source: 'connection' },
      { personUid: 'prs_katherine', email: 'katherine@getindigo.ai', displayName: 'Katherine Johnson', companyUid: 'cmp_indigo', source: 'company', lastMessageAt: '2026-06-08T19:43:10.000Z' },
    ],
  }),
  list_channels: () => ({
    channels: [
      {
        channelId: 'ch_release',
        name: '',
        scope: 'group',
        visibility: 'private',
        membership: 'joined',
        unread: 2,
        memberCount: 3,
        lastActivityAt: new Date(Date.now() - 12 * 60 * 1000).toISOString(),
        members: [
          { personUid: 'prs_jacob', displayName: 'Jacob Patel' },
          { personUid: 'prs_alan', displayName: 'Alan Turing' },
        ],
      },
      {
        channelId: 'ch_core',
        name: 'hq-core',
        scope: 'company',
        companyUid: 'cmp_indigo',
        companyName: 'Indigo',
        visibility: 'company',
        membership: 'joined',
        unread: 4,
        memberCount: 18,
        lastActivityAt: new Date(Date.now() - 32 * 60 * 1000).toISOString(),
      },
      {
        channelId: 'ch_exec',
        name: 'corey-exec',
        scope: 'company',
        companyUid: 'cmp_indigo',
        companyName: 'Indigo',
        visibility: 'private',
        membership: 'joined',
        unread: 0,
        memberCount: 5,
        lastActivityAt: new Date(Date.now() - 90 * 60 * 1000).toISOString(),
      },
    ],
  }),
  fetch_channel: (args) => {
    const channelId = String(args?.channelId ?? 'ch_core');
    const names = channelId === 'ch_release'
      ? ['Jacob Patel', 'Alan Turing']
      : ['Grace Hopper', 'Ada Lovelace'];
    return {
      messages: names.map((name, index) => ({
        eventId: `${channelId}-${index + 1}`,
        fromPersonUid: `prs_${index + 1}`,
        fromDisplayName: name,
        fromEmail: `${name.split(' ')[0]?.toLocaleLowerCase()}@getindigo.ai`,
        body: index === 0
          ? 'The release checklist is clean. I am ready for the final smoke.'
          : 'Confirmed — updater artifacts and the public channel both look good.',
        createdAt: new Date(Date.now() - (8 - index * 3) * 60 * 1000).toISOString(),
        direction: 'in',
      })),
      nextCursor: null,
    };
  },
  mark_channel_read: () => null,
  send_channel_message: () => ({ eventId: 'channel-sent-1', createdAt: new Date().toISOString() }),
  list_company_members: () => ({
    members: [
      { personUid: 'prs_grace', email: 'grace@getindigo.ai', displayName: 'Grace Hopper', companyUid: 'cmp_indigo', companyName: 'Indigo' },
      { personUid: 'prs_katherine', email: 'katherine@getindigo.ai', displayName: 'Katherine Johnson', companyUid: 'cmp_indigo', companyName: 'Indigo' },
    ],
  }),
  fetch_dm_thread: (args) => {
    const peer = String(args?.withPersonUid ?? 'prs_ada');
    const people: Record<string, { name: string; email: string; latest: string }> = {
      prs_ada: {
        name: 'Ada Lovelace',
        email: 'ada@getindigo.ai',
        latest: 'Please do — I’m restyling it to match the desktop view right now.',
      },
      prs_grace: {
        name: 'Grace Hopper',
        email: 'grace@getindigo.ai',
        latest: 'Pushed the conflict-versioning notes — take a look when you get a sec?',
      },
      prs_alan: {
        name: 'Alan Turing',
        email: 'alan@example.com',
        latest: 'Meeting recap is synced to the Liverecover folder.',
      },
      prs_katherine: {
        name: 'Katherine Johnson',
        email: 'katherine@getindigo.ai',
        latest: 'Orbit math notes are ready for review.',
      },
    };
    const person = people[peer] ?? people.prs_ada;
    return {
      messages: [
        { eventId: 'm1', fromPersonUid: peer, fromDisplayName: person.name, fromEmail: person.email, body: 'Hey — did the Phase 1 backend land in prod?', createdAt: '2026-06-09T19:40:00.000Z', direction: 'in' },
        { eventId: 'm2', fromPersonUid: 'prs_me', fromDisplayName: 'You', fromEmail: 'me@coreyepstein.com', body: 'Yep, just went live. Connection routes are up and the send path is verified.', createdAt: '2026-06-09T19:41:00.000Z', direction: 'out' },
        { eventId: 'm3', fromPersonUid: peer, fromDisplayName: person.name, fromEmail: person.email, body: 'Amazing. Want me to take the Messages window for a spin?', createdAt: '2026-06-09T19:42:30.000Z', direction: 'in' },
        { eventId: 'm4', fromPersonUid: peer === 'prs_katherine' ? peer : 'prs_me', fromDisplayName: peer === 'prs_katherine' ? person.name : 'You', fromEmail: peer === 'prs_katherine' ? person.email : 'me@coreyepstein.com', body: person.latest, createdAt: '2026-06-09T19:43:10.000Z', direction: peer === 'prs_katherine' ? 'in' : 'out' },
      ],
      nextCursor: null,
    };
  },
  list_dm_requests: () => ({
    requests: [
      { pairKey: 'pk1', fromPersonUid: 'prs_lin', fromEmail: 'lin@northwind.co', fromDisplayName: 'Lin Manuel', message: 'Hi! We met at the HQ demo — would love to connect here.', sharedCompany: null, createdAt: '2026-06-09T18:10:00.000Z' },
      { pairKey: 'pk2', fromPersonUid: 'prs_rao', fromEmail: 'rao@getindigo.ai', fromDisplayName: 'Rao Patel', message: 'Pinging you about the messaging rollout.', sharedCompany: 'Indigo', createdAt: '2026-06-09T17:05:00.000Z' },
    ],
  }),
  send_dm: () => ({ eventId: 'sent-1', createdAt: '2026-06-09T19:44:00.000Z' }),
  // Reactions (US-025 + share reactions) — canned aggregates so pills render.
  fetch_reactions: (args) => {
    const id = String(args?.messageId ?? '');
    if (id === 'share-2') {
      return [
        { emoji: '🎉', count: 2, reactedByMe: true },
        { emoji: '👀', count: 1, reactedByMe: false },
      ];
    }
    if (id === 'share-1') return [{ emoji: '👍', count: 1, reactedByMe: false }];
    return [];
  },
  toggle_reaction: () => ({ ok: true, added: true }),
  set_active_conversation: () => null,
  set_watched_shares: () => null,
  send_dm_to_email: () => ({ state: 'connection_requested' }),
  respond_dm_request: () => null,
  open_desktop_alt_window: (args) => {
    const route = String(args?.route ?? '').trim();
    if (!route) return null;
    void emit('desktop:navigate', route);
    return null;
  },
  messages_window_ready: () => null,
  open_messages_window: () => null,
  take_pending_messages_target: () => null,
};

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const handler = handlers[cmd];
  if (handler) return handler(args) as T;
  // Unknown command: log once and resolve null so mount paths don't throw.
  console.debug('[harness] unhandled invoke:', cmd, args);
  return null as T;
}

export class Channel<T = unknown> {
  onmessage: ((msg: T) => void) | null = null;
}

// Some Tauri plugins (e.g. plugin-notification) import these from core. The
// harness has no backend, so they resolve to inert no-ops.
export class PluginListener {
  constructor(
    public plugin: string,
    public event: string,
    public channelId: number,
  ) {}
  async unregister(): Promise<void> {}
}

export async function addPluginListener<T>(
  _plugin: string,
  _event: string,
  _cb: (payload: T) => void,
): Promise<PluginListener> {
  return new PluginListener(_plugin, _event, 0);
}

export function transformCallback(_cb?: (response: unknown) => void, _once = false): number {
  return 0;
}

export function convertFileSrc(filePath: string, _protocol = 'asset'): string {
  return filePath;
}
