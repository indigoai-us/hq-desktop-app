/**
 * Preview-only fixture for the first-run "Bring in your context" scan
 * (`?firstrun=visual-import...`, audit-switches.ts). Replays a realistic
 * `hq import scan --json --stream` sequence (contract:
 * workspace/reports/scan-stream-contract.md) as `import-scan://event` events,
 * so the knowledge tree renders without the CLI. Nothing here reaches the
 * app bundle.
 *
 *   visual-import         three companies, nine projects, about 14 s
 *   visual-import-fast    the same scan (plus a project that moves to its
 *                         company later) in a quarter of a second
 *   visual-import-slow    the same scan over about a minute, with the long
 *                         silent "Skills and settings" step
 *   visual-import-empty   two sources that find nothing
 *   visual-import-error   Codex fails part way; the rest carries on
 *   visual-import-fail    the stream breaks before it finishes
 *   visual-import-update  an HQ whose scanner is too old ("Update HQ")
 */

export type ImportVariant = 'default' | 'fast' | 'slow' | 'empty' | 'error' | 'fail' | 'update';

export interface FixtureStep {
  /** Milliseconds after the previous step. */
  gap: number;
  event: Record<string, unknown>;
}

export interface ImportFixture {
  steps: FixtureStep[];
  /** How the command answers once every step is out. */
  status: 'done' | 'failed';
}

const v = (event: Record<string, unknown>) => ({ v: 1, ...event });

const SOURCES = [
  { id: 'hq', label: 'HQ companies' },
  { id: 'repos', label: 'Code repositories' },
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'artifacts', label: 'Skills and settings' },
];

const MILESTONES = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
function counts(source: string, key: string, total: number, gap: number): FixtureStep[] {
  const values = MILESTONES.filter((m) => m < total).concat(total);
  return values.map((value) => ({ gap, event: v({ type: 'count', source, key, value }) }));
}

const COMPANIES = [
  { id: 'holler', name: 'Holler' },
  { id: 'indigo', name: 'Indigo' },
  { id: 'synesis-strategy', name: 'Synesis Strategy' },
];

const PROJECTS: Array<{ id: string; name: string; company: string }> = [
  { id: 'p_0a11c0ffee01', name: 'brand-site', company: 'indigo' },
  { id: 'p_0a11c0ffee02', name: 'growth', company: 'holler' },
  { id: 'p_0a11c0ffee03', name: 'hq-desktop', company: 'indigo' },
  { id: 'p_0a11c0ffee04', name: 'launch', company: 'holler' },
  { id: 'p_0a11c0ffee05', name: 'mobile-app', company: 'holler' },
  { id: 'p_0a11c0ffee06', name: 'board-decks', company: 'synesis-strategy' },
  { id: 'p_0a11c0ffee07', name: 'client-research', company: 'synesis-strategy' },
  { id: 'p_0a11c0ffee08', name: 'ops', company: 'synesis-strategy' },
];
const LATE = { id: 'p_0a11c0ffee09', name: 'hq-sync', company: 'indigo' };
const MOVER = { id: 'p_0a11c0ffee0a', name: 'notes' };

/** The full scan, with every gap scaled by `k`. */
function fullScan(k: number, opts: { mover: boolean; codexError: boolean; artifactsPause: number }): FixtureStep[] {
  const s = (gap: number) => Math.round(gap * k);
  const steps: FixtureStep[] = [
    { gap: s(250), event: v({ type: 'start', sources: SOURCES }) },
    { gap: s(120), event: v({ type: 'source', id: 'hq', status: 'scanning' }) },
    ...COMPANIES.map((c) => ({ gap: s(160), event: v({ type: 'company', id: c.id, name: c.name, basis: 'hq-company' }) })),
    ...counts('hq', 'companies', 3, s(80)),
    { gap: s(200), event: v({ type: 'source', id: 'hq', status: 'done', counts: { companies: 3 } }) },
    { gap: s(150), event: v({ type: 'source', id: 'repos', status: 'scanning' }) },
    ...counts('repos', 'repos', 11, s(140)),
    ...PROJECTS.map((p) => ({ gap: s(110), event: v({ type: 'project', id: p.id, name: p.name, company: p.company, basis: 'repo' }) })),
    ...(opts.mover
      ? [{ gap: s(110), event: v({ type: 'project', id: MOVER.id, name: MOVER.name, company: null, basis: 'repo' }) }]
      : []),
    { gap: s(200), event: v({ type: 'source', id: 'repos', status: 'done', counts: { repos: 11 } }) },
    { gap: s(150), event: v({ type: 'source', id: 'claude-code', status: 'scanning' }) },
    ...counts('claude-code', 'sessions', 412, s(260)),
    { gap: s(120), event: v({ type: 'project', id: LATE.id, name: LATE.name, company: LATE.company, basis: 'claude-code-cwd' }) },
    ...(opts.mover
      ? [{ gap: s(120), event: v({ type: 'project', id: MOVER.id, name: MOVER.name, company: 'synesis-strategy', basis: 'repo' }) }]
      : []),
    { gap: s(200), event: v({ type: 'source', id: 'claude-code', status: 'done', counts: { sessions: 412 } }) },
    { gap: s(150), event: v({ type: 'source', id: 'codex', status: 'scanning' }) },
  ];
  if (opts.codexError) {
    steps.push(
      ...counts('codex', 'sessions', 20, s(240)),
      {
        gap: s(300),
        event: v({ type: 'error', source: 'codex', message: 'Some session folders could not be read.' }),
      },
      { gap: s(200), event: v({ type: 'source', id: 'codex', status: 'error', message: "Couldn't read Codex" }) },
    );
  } else {
    steps.push(
      ...counts('codex', 'sessions', 96, s(240)),
      { gap: s(200), event: v({ type: 'source', id: 'codex', status: 'done', counts: { sessions: 96 } }) },
    );
  }
  const artifacts = { skills: 42, commands: 9, hooks: 6, agents: 2, policies: 31, plans: 14, claude_md: 7, settings_fragments: 3, mcp_servers: 4 };
  steps.push(
    { gap: s(150), event: v({ type: 'source', id: 'artifacts', status: 'scanning' }) },
    ...Object.entries(artifacts).map(([key, value], i) => ({
      gap: i === 0 ? Math.round(opts.artifactsPause * k) : s(20),
      event: v({ type: 'count', source: 'artifacts', key, value }),
    })),
    { gap: s(80), event: v({ type: 'source', id: 'artifacts', status: 'done', counts: artifacts }) },
    {
      gap: s(200),
      event: v({
        type: 'done',
        report: 'workspace/imports/20261008T090807Z/report.json',
        summary: { companies: 3, projects: opts.mover ? 10 : 9, sessions: opts.codexError ? 432 : 508 },
      }),
    },
  );
  return steps;
}

export function importFixture(variant: ImportVariant): ImportFixture {
  switch (variant) {
    case 'fast':
      return { steps: fullScan(0, { mover: true, codexError: false, artifactsPause: 0 }).map((s, i) => ({ ...s, gap: i === 0 ? 30 : 4 })), status: 'done' };
    case 'slow':
      return { steps: fullScan(4, { mover: true, codexError: false, artifactsPause: 5000 }), status: 'done' };
    case 'error':
      return { steps: fullScan(1, { mover: false, codexError: true, artifactsPause: 2500 }), status: 'done' };
    case 'empty':
      return {
        steps: [
          { gap: 250, event: v({ type: 'start', sources: [SOURCES[2], SOURCES[3]] }) },
          { gap: 150, event: v({ type: 'source', id: 'claude-code', status: 'scanning' }) },
          { gap: 900, event: v({ type: 'source', id: 'claude-code', status: 'done', counts: { sessions: 0 } }) },
          { gap: 150, event: v({ type: 'source', id: 'codex', status: 'scanning' }) },
          { gap: 900, event: v({ type: 'source', id: 'codex', status: 'done', counts: { sessions: 0 } }) },
          {
            gap: 200,
            event: v({
              type: 'done',
              report: 'workspace/imports/20261008T090807Z/report.json',
              summary: { companies: 0, projects: 0, sessions: 0 },
            }),
          },
        ],
        status: 'done',
      };
    case 'fail': {
      const steps = fullScan(1, { mover: false, codexError: false, artifactsPause: 2500 });
      const cut = steps.findIndex((s) => s.event.type === 'source' && s.event.id === 'codex');
      return { steps: steps.slice(0, cut), status: 'failed' };
    }
    case 'update':
      return {
        steps: [
          {
            gap: 600,
            event: v({
              type: 'error',
              source: 'scanner',
              code: 'scanner_outdated',
              message: 'The import-context scanner is not installed in this HQ. Update HQ and try again.',
            }),
          },
          { gap: 40, event: v({ type: 'done', report: null, summary: { companies: 0, projects: 0, sessions: 0 } }) },
        ],
        status: 'done',
      };
    default:
      return { steps: fullScan(1, { mover: false, codexError: false, artifactsPause: 2500 }), status: 'done' };
  }
}

type Emit = (event: string, payload?: unknown) => unknown;

const running = new Map<string, { timers: ReturnType<typeof setTimeout>[]; finish: (status: string) => void }>();

/** Replay a fixture for `scanId`; resolves the way `import_scan_start` does. */
export function replayImportScan(variant: ImportVariant, scanId: string, emit: Emit): Promise<{ status: string }> {
  const fixture = importFixture(variant);
  return new Promise((resolve) => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    let at = 0;
    const finish = (status: string) => {
      timers.forEach(clearTimeout);
      running.delete(scanId);
      resolve({ status });
    };
    for (const step of fixture.steps) {
      at += step.gap;
      timers.push(setTimeout(() => void emit('import-scan://event', { scanId, event: step.event }), at));
    }
    timers.push(setTimeout(() => finish(fixture.status), at + 60));
    running.set(scanId, { timers, finish });
  });
}

export function cancelImportScan(scanId: string): boolean {
  const run = running.get(scanId);
  if (!run) return false;
  run.finish('cancelled');
  return true;
}
