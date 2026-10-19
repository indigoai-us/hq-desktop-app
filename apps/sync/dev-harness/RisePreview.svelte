<script lang="ts">
  /**
   * Frozen and live rise for screenshots and clips.
   * ?phase=opening|reveal|brief|record &theme=dark|light &t=<seconds>
   * opening and reveal freeze the real BriefRise. brief is the ready report.
   * record plays the rise and cross-fades into the brief. In-page answers only.
   * The pane sits in a mockup window frame (title bar and rail) as in round 11b.
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
      { bundleId: 'ai.x.grok', name: 'Grok' },
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

<div class="window" data-testid="rise-window" data-theme={theme}>
<header class="titlebar" aria-hidden="true">
  <span class="lights"><i></i><i></i><i></i></span>
  <span class="title">HQ</span>
</header>
<nav class="rail" aria-hidden="true">
  <span class="mark">HQ</span>
  <span class="tab on">
    <svg viewBox="0 0 20 20"><path d="M3.5 9 10 3.5 16.5 9v7.5h-4.5V12H8v4.5H3.5z" /></svg>
  </span>
  <span class="tab">
    <svg viewBox="0 0 20 20"><path d="M3 11.5 5 4h10l2 7.5V16H3zM3 11.5h4.5l1 2h3l1-2H17" /></svg>
  </span>
  <span class="tab">
    <svg viewBox="0 0 20 20"><path d="M3.5 3.5h5v5h-5zM11.5 3.5h5v5h-5zM3.5 11.5h5v5h-5zM11.5 11.5h5v5h-5z" /></svg>
  </span>
  <span class="avatar">AL</span>
</nav>
<div class="shot" data-testid="rise-shot" data-phase={phase} data-theme={theme}>
  {#if showRise}
    <BriefRise
      sources={SOURCES}
      {elapsed}
      {theme}
      readyAt={phase === 'record' ? 23 : null}
      now={welcomeRiseNow()}
      bind:briefOpacity
    />
    <div class="invite">
      <BriefConnectApps
        detect={async () => SCAN}
        cli={{ claudeCode: true, codex: true }}
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
        aiApps={{ detect: async () => SCAN, cli: { claudeCode: true, codex: true }, anywhereOnId: 'claude' }}
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
</div>

<style>
  .window {
    --chrome: #1d1820;
    --rail-top: #18151c;
    --rail-bottom: #20171f;
    --chrome-line: rgba(255, 236, 220, 0.08);
    --title-ink: #a29ca4;
    --ring: #68656a;
    --glyph: #ebebeb;
    --tab-on: #2f2c33;
    --avatar-ring: #383037;
    position: relative;
    height: 100vh;
    overflow: hidden;
    background: var(--chrome);
  }
  .window[data-theme="light"] {
    --chrome: #f5e9d8;
    --rail-top: #f7ecda;
    --rail-bottom: #f6e7d2;
    --chrome-line: #d8c7af;
    --title-ink: #645f59;
    --ring: #bab1a4;
    --glyph: #171616;
    --tab-on: #e9decc;
    --avatar-ring: #dbcebb;
  }
  .titlebar {
    position: absolute;
    inset: 0 0 auto 0;
    height: 46px;
    display: flex;
    align-items: center;
    gap: 30px;
    border-bottom: 1px solid var(--chrome-line);
    box-sizing: border-box;
  }
  .lights {
    display: flex;
    gap: 8px;
    padding-left: 20px;
  }
  .lights i {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    border: 1px solid var(--ring);
    box-sizing: border-box;
  }
  .title {
    margin-left: 3px;
    font: 600 13px/1 -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif;
    color: var(--title-ink);
  }
  .rail {
    position: absolute;
    top: 46px;
    bottom: 0;
    left: 0;
    width: 76px;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding-top: 29px;
    background: linear-gradient(180deg, var(--rail-top), var(--rail-bottom));
  }
  .mark {
    margin-bottom: 26px;
    font: 600 21px/1 "Fraunces", Georgia, serif;
    color: var(--glyph);
  }
  .tab {
    width: 40px;
    height: 44px;
    display: grid;
    place-items: center;
    border-radius: 10px;
    margin-bottom: 0;
  }
  .tab:nth-of-type(3) {
    margin-top: 8px;
  }
  .tab:nth-of-type(4) {
    margin-top: -1px;
  }
  .tab.on {
    background: var(--tab-on);
  }
  .tab svg {
    width: 20px;
    height: 20px;
    fill: none;
    stroke: var(--glyph);
    stroke-width: 1.6;
    stroke-linejoin: round;
  }
  .avatar {
    margin-top: auto;
    margin-bottom: 25px;
    width: 31px;
    height: 31px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    border: 1.5px solid var(--avatar-ring);
    box-sizing: border-box;
    font: 600 11px/1 -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif;
    color: var(--title-ink);
  }
  .shot {
    position: absolute;
    top: 46px;
    left: 76px;
    right: 0;
    bottom: 0;
    overflow: hidden;
    background: #121216;
  }
  .shot[data-theme="light"] {
    background: #f4efe9;
  }
  .invite {
    position: absolute;
    left: 52px;
    top: 300px;
    z-index: 4;
    width: min(485px, calc(100% - 104px));
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
