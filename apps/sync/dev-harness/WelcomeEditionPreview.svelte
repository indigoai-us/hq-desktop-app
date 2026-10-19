<script lang="ts">
  /**
   * Preview of the welcome edition (?view=welcome-edition) drawn from Core's
   * real `welcome` output (hq-core-staging PR 1432, brief-sweep.py) or the
   * seeded 38-project fixture (US-019). The brief run is served from memory
   * through the real runs page, so the edition renders exactly as the first
   * brief does. No network, no credentials.
   *   ?fixture=personal|company|seeded   personal (default) has no company.
   *   ?rise=<seconds>                    the sunrise frozen mid-rise instead.
   *   ?theme=dark|light
   */
  import WelcomeReport from '../../../packages/ui/src/brief/WelcomeReport.svelte';
  import BriefRunsPage from '../../../packages/ui/src/brief/BriefRunsPage.svelte';
  import type { BriefSweepSource } from '../../../packages/ui/src/brief/brief-data';
  import seeded from '../../../packages/ui/src/brief/fixtures/welcome-38-projects.json';
  import core from '../../../packages/ui/src/brief/fixtures/core-1432-welcome.json';
  import { configureBriefSeed } from '../../../packages/ui/src/brief/brief-seed';

  // The harness seeds every brief with the October 8 fixture. The welcome
  // edition reads only the served brief.json, so turn the seed off here.
  configureBriefSeed(null);

  const params = new URLSearchParams(window.location.search);
  const fixture = params.get('fixture') ?? 'personal';
  const theme = params.get('theme') === 'light' ? 'light' : 'dark';
  const rise = params.has('rise') ? Number(params.get('rise')) : null;
  const welcome =
    fixture === 'company' ? core.showcase_company : fixture === 'seeded' ? seeded.welcome : core.showcase_personal;
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
  const source: BriefSweepSource = { readHqFile: async (p) => files[p] ?? null };
  const never = <T,>() => new Promise<T>(() => undefined);
</script>

<div style="min-height:100vh">
  <WelcomeReport
    ready={rise === null}
    elapsed={rise}
    {theme}
    aiApps={{ detect: async () => null, cli: { claudeCode: true, codex: true } }}
    openTool={{ label: 'Open Claude Code', detail: 'Claude Code is set up with HQ. Open it to keep working there.', busy: false, error: null, onopen: () => undefined }}
    openHarness={{ harnesses: ['claude-code', 'codex', 'cursor'], open: async () => null }}
  >
    <BriefRunsPage adapter={{} as never} companies={[]} {source} onconnectcompany={() => undefined} onlaunch={async () => never()} />
  </WelcomeReport>
</div>
