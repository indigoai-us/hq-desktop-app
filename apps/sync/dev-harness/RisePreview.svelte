<script lang="ts">
  /**
   * Frozen and live rise for screenshots and clips.
   * ?phase=opening|reveal|brief|record &theme=dark|light &t=<seconds>
   * opening and reveal freeze the real BriefRise. brief is the ready report.
   * record plays the rise and cross-fades into the brief. In-page answers only.
   */
  import type { FoundWorkApps } from '@hq/platform';
  import BriefRise from '../../../packages/ui/src/brief/BriefRise.svelte';
  import BriefConnectApps from '../../../packages/ui/src/brief/BriefConnectApps.svelte';
  import WelcomeReport from '../../../packages/ui/src/brief/WelcomeReport.svelte';
  import DailyBrief from '../../../packages/ui/src/brief/DailyBrief.svelte';
  import { WELCOME_RISE_SOURCES, welcomeRiseBriefInput, welcomeRiseNow } from '../../../packages/ui/src/brief/welcome-rise-run';
  import type { YourAppsHost, YourAppsLoad, YourAppsResult } from '../../../packages/ui/src/chat/first-run/your-apps-host';

  const params = new URLSearchParams(window.location.search);
  const phase = params.get('phase') ?? 'reveal';
  const theme = params.get('theme') === 'light' ? 'light' : 'dark';
  const elapsed = params.has('t') ? Number(params.get('t')) : null;
  let briefOpacity = $state(0);

  const SOURCES = WELCOME_RISE_SOURCES;

  const SCAN = {
    platform: 'macos',
    scannedAtMs: 1,
    apps: [
      { bundleId: 'com.anthropic.claudefordesktop', name: 'Claude' },
      { bundleId: 'com.openai.chat', name: 'ChatGPT' },
    ],
    mcpServers: [],
    sources: [],
    truncated: false,
  } as unknown as FoundWorkApps;

  const load: YourAppsLoad = {
    catalog: {},
    connections: [],
    installations: {},
    canManage: true,
    problem: null,
  };
  const never = <T,>() => new Promise<T>(() => undefined);
  const host: YourAppsHost = {
    detect: async () => SCAN,
    load: async () => load,
    autoConnect: async (): Promise<YourAppsResult> => ({ ok: false, reason: '', retry: false }),
    connect: async (): Promise<YourAppsResult> => never(),
    setup: async (): Promise<YourAppsResult> => never(),
    undo: async (): Promise<YourAppsResult> => ({ ok: true, connectionId: null, installationId: null }),
  };

  const showRise = phase !== 'brief';
  const showBrief = phase === 'brief' || phase === 'record';
  const briefInput = welcomeRiseBriefInput(welcomeRiseNow());
</script>

<div class="shot" data-testid="rise-shot" data-phase={phase} data-theme={theme}>
  {#if showRise}
    <BriefRise
      sources={SOURCES}
      {elapsed}
      {theme}
      readyAt={phase === 'record' ? 23 : null}
      bind:briefOpacity
    />
    <div class="invite">
      <BriefConnectApps
        detect={async () => SCAN}
        cli={{ claudeCode: true, codex: false }}
        anywhereOnId="claude"
        quiet
        {theme}
      />
    </div>
  {/if}
  {#if showBrief}
    <div class="brief" data-theme={theme} style:opacity={phase === 'brief' ? 1 : briefOpacity}>
      <WelcomeReport
        ready
        {theme}
        aiApps={{ detect: async () => SCAN, cli: { claudeCode: true, codex: false }, anywhereOnId: 'claude' }}
        connect={{ host, company: { uid: 'cmp_preview', name: 'Acme' }, onnewcompany: async () => never() }}
      >
        <DailyBrief
          input={briefInput}
          actions={{ destinations: { assistantName: 'Atlas', claudeCode: true, codex: false }, onassistant: async () => null }}
          onlaunch={async () => null}
        />
      </WelcomeReport>
    </div>
  {/if}
</div>

<style>
  .shot {
    position: relative;
    height: 100vh;
    overflow: hidden;
    background: #121216;
  }
  .shot[data-theme="light"] {
    background: #f4efe9;
  }
  .invite {
    position: absolute;
    left: 28px;
    bottom: 28px;
    z-index: 4;
    width: min(420px, calc(50% - 120px));
  }
  .brief {
    position: absolute;
    inset: 0;
    overflow: auto;
    background: var(--b-bg, #1b1b1e);
  }
  .brief[data-theme="light"] {
    background: #f6f1ea;
  }
</style>
