<script lang="ts">
  /**
   * Preview of the first view (?view=first-view): the Daily Brief inside the
   * welcome report, drawn from Core's real `welcome` output or the seeded
   * 38-project fixture, with the desktop's import report. The brief run is
   * served from memory through the real runs page. No network, no credentials.
   *   ?fixture=personal|company|cursor|seeded   personal (default) has no company.
   *   ?import=0                          no import report (the default has one).
   *   ?hq=1                              read the brief run and the newest import
   *                                      report from the HQ folder on disk
   *                                      (HQ_ROOT) instead, through /__hq/.
   *   ?rise=<seconds>                    the sunrise frozen mid-rise instead.
   *   ?theme=dark|light                  the app theme, passed to the report.
   * The page scrolls in its own frame, as the app's brief pane does.
   */
  import WelcomeReport from '../../../packages/ui/src/brief/WelcomeReport.svelte';
  import BriefRunsPage from '../../../packages/ui/src/brief/BriefRunsPage.svelte';
  import type { BriefSweepSource } from '../../../packages/ui/src/brief/brief-data';
  import seeded from '../../../packages/ui/src/brief/fixtures/welcome-38-projects.json';
  import core from '../../../packages/ui/src/brief/fixtures/core-1432-welcome.json';
  import importFixture from '../../../packages/ui/src/brief/fixtures/import-report-desktop.json';
  import { configureBriefSeed } from '../../../packages/ui/src/brief/brief-seed';

  // The harness seeds every brief with the October 8 fixture. The first view
  // reads only the served brief.json, so turn the seed off here.
  configureBriefSeed(null);

  const params = new URLSearchParams(window.location.search);
  const fixture = params.get('fixture') ?? 'personal';
  const theme = params.get('theme') === 'light' ? 'light' : 'dark';
  const rise = params.has('rise') ? Number(params.get('rise')) : null;
  const fromDisk = params.get('hq') === '1';
  const welcome =
    fixture === 'company'
      ? core.showcase_company
      : fixture === 'cursor'
        ? core.cursor_person
        : fixture === 'seeded'
          ? seeded.welcome
          : core.showcase_personal;
  const brief = { items: seeded.items, welcome };

  const RUN = 'brief-20261018-090000';
  const files: Record<string, string> = {
    'workspace/brief/index.jsonl': JSON.stringify({
      run_id: RUN,
      created_at: '2026-10-18T16:00:00Z',
      state: 'ready',
      catch_up: false,
      lead: 'decisions',
      counts: { decisions: 0, shipped: 0, incidents: 0 },
      headline: 'Your first brief',
    }),
    [`workspace/brief/${RUN}/brief-data.json`]: '{}',
    [`workspace/brief/${RUN}/brief.json`]: JSON.stringify(brief),
  };
  const read = async (path: string): Promise<string | null> => {
    const res = await fetch(`/__hq/${path}`);
    return res.ok ? res.text() : null;
  };
  const source: BriefSweepSource = { readHqFile: fromDisk ? read : async (p) => files[p] ?? null };
  // The host's import-report reader: the newest report.json under workspace/imports, or the fixture.
  const importReport = {
    latest: async () => {
      if (fromDisk) {
        const text = await read('import-report/latest');
        return { ok: true as const, value: text ? (JSON.parse(text) as Record<string, unknown>) : null };
      }
      return { ok: true as const, value: params.get('import') === '0' ? null : (importFixture.report as Record<string, unknown>) };
    },
  };
  // The launch scan the suggested integrations come from, and the company's apps (none connected yet).
  const SCAN = {
    platform: 'macos' as const,
    scannedAtMs: 1,
    apps: [
      { bundleId: 'com.github.GitHubClient', name: 'GitHub Desktop' },
      { bundleId: 'com.linear', name: 'Linear' },
      { bundleId: 'com.tinyspeck.slackmacgap', name: 'Slack' },
    ],
    mcpServers: [],
    sources: [],
    truncated: false,
  };
  const never = <T,>() => new Promise<T>(() => undefined);
  const appsHost = {
    detect: async () => SCAN,
    load: async () => ({ catalog: {}, connections: [], installations: {}, canManage: true, problem: null }),
    autoConnect: async () => ({ ok: false, reason: '', retry: false }),
    connect: () => never(),
    setup: () => never(),
    undo: async () => ({ ok: true, connectionId: null, installationId: null }),
  };
  // What Connect opened, so a test can see it went to the existing settings page.
  const opened = (where: string) => () => {
    document.body.dataset.firstViewOpened = where;
  };
</script>

<div style="height:100vh;overflow:auto" data-testid="first-view-scroller">
  <WelcomeReport
    ready={rise === null}
    elapsed={rise}
    {theme}
    aiApps={{ detect: appsHost.detect, cli: { claudeCode: true, codex: true }, onopenaiapps: opened('ai-apps') }}
    connect={{ host: appsHost as never, company: { uid: 'cmp_preview', name: 'Acme' }, onopenintegrations: opened('integrations'), onnewcompany: async () => never() }}
    openHarness={{ harnesses: ['claude-code', 'codex'], open: async () => null }}
  >
    <BriefRunsPage adapter={{ importReport } as never} companies={[]} {source} onconnectcompany={opened('company')} onlaunch={async () => never()} />
  </WelcomeReport>
</div>
