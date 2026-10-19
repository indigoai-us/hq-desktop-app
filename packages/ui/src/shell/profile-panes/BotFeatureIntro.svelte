<script lang="ts">
  import RailIcon from '../../common/button/RailIcon.svelte';
  import NewBotOrbIcon from '../../chat/create-bot/NewBotOrbIcon.svelte';
  import type { LineIconName } from '../../common/button/rail-icons.js';

  let { kind }: { kind: 'channels' | 'apps' | 'brain' | 'routines' } = $props();
  const content = {
    channels: {
      title: 'Good work starts with a conversation.',
      description: 'Bring your bot to the places your team already talks.',
      icons: ['send', 'bell', 'link'] as LineIconName[],
      rows: [['Connect your channels', 'One place for the conversations that matter.'], ['Keep an eye on connections', 'See where your bot is reachable.'], ['Make it yours', 'Manage each channel’s destination and settings.']],
      note: 'Channel management is coming next.',
    },
    apps: {
      title: 'More tools. More possibilities.',
      description: 'A thoughtful set of apps turns your bot into a capable teammate.',
      icons: ['plug', 'folder', 'key'] as LineIconName[],
      rows: [['Bring your tools together', 'Connect apps and services through MCP.'], ['Choose what your bot can use', 'Manage access separately from company connections.'], ['Stay in control', 'Review permissions and connection health.']],
      note: 'App management is coming next.',
    },
    brain: {
      title: 'The right mind for the work.',
      description: 'Give your bot the intelligence that fits the way you work.',
      icons: ['sliders', 'key', 'circle-dot'] as LineIconName[],
      rows: [['Choose a provider', 'Keep your AI accounts and sign-in in one place.'], ['Find the right model', 'Match the model to the task at hand.'], ['Know what’s powering your bot', 'See the provider and model it uses.']],
      note: 'Brain settings are coming next.',
    },
    routines: {
      title: 'A little rhythm. A lot less busywork.',
      description: 'Give recurring work a dependable home.',
      icons: ['arrows-clockwise', 'play', 'check-circle'] as LineIconName[],
      rows: [['Set a rhythm', 'Keep schedules and time zones together.'], ['See what’s next', 'Follow upcoming runs at a glance.'], ['Check the results', 'Find the history behind each routine.']],
      note: 'Routines are not available in this view yet.',
    },
  };
  const view = $derived(content[kind]);
</script>

<section class="feature" data-kind={kind} aria-label={`${kind} introduction`}>
  <div class="scene" aria-hidden="true">
    <div class="orbit orbit-outer"></div><div class="orbit orbit-inner"></div>
    <svg class="connections" viewBox="0 0 360 160" fill="none"><path d="M180 80 70 55M180 80 290 55M180 80 250 128" stroke="currentColor" stroke-dasharray="3 5" /></svg>
    <span class="core"><NewBotOrbIcon kind="local" size={72} /></span>
    {#each view.icons as icon, index}<span class="satellite satellite-{index}"><RailIcon name={icon} /></span>{/each}
    <span class="spark spark-one"></span><span class="spark spark-two"></span>
  </div>
  <div class="story"><h3>{view.title}</h3><p>{view.description}</p></div>
  <div class="capabilities">
    {#each view.rows as row, index}
      <div class="capability"><span class="row-icon"><RailIcon name={view.icons[index]} /></span><div><h4>{row[0]}</h4><p>{row[1]}</p></div></div>
    {/each}
  </div>
  <footer><span class="preview-label">Up next</span><span>{view.note}</span></footer>
</section>

<style>
  @font-face {
    font-family: "Bot Fraunces";
    src: url('../../chat/create-bot/assets/new-bot-wallpapers/fraunces-variable-latin.woff2') format('woff2');
    font-style: italic;
    font-weight: 300 700;
    font-display: swap;
  }
  .feature { border: 1px solid var(--v4-rowline, var(--line)); border-radius: 22px; overflow: hidden; background: color-mix(in srgb, var(--v4-text-1) 2%, transparent); animation: arrive 260ms ease-out both; }
  .scene { position: relative; height: 136px; width: min(100%, 360px); margin: 4px auto 0; color: var(--v4-text-3); }
  .orbit { position: absolute; border: 1px solid color-mix(in srgb, var(--v4-text-1) 7%, transparent); border-radius: 50%; left: 50%; top: 50%; transform: translate(-50%, -50%); }
  .orbit-outer { width: 260px; height: 126px; transform: translate(-50%, -50%) rotate(-14deg); }
  .feature[data-kind="apps"] .orbit { border-radius: 24px; }
  .feature[data-kind="brain"] .orbit-outer { width: 180px; height: 126px; }
  .orbit-inner { width: 164px; height: 108px; transform: translate(-50%, -50%) rotate(22deg); }
  .connections { position: absolute; inset: 0; width: 100%; height: 100%; opacity: .35; }
  .core { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); filter: grayscale(1); }
  .satellite { position: absolute; display: grid; place-items: center; width: 40px; height: 40px; border-radius: 14px; color: var(--v4-text-2); background: var(--v4-secondary-sidebar, var(--side-bg)); border: 1px solid var(--v4-rowline, var(--line)); box-shadow: 0 5px 16px rgb(0 0 0 / .08); }
  .satellite-0 { left: 13%; top: 22%; transform: rotate(-8deg); }
  .satellite-1 { right: 13%; top: 22%; transform: rotate(8deg); }
  .satellite-2 { right: 25%; bottom: 6%; transform: rotate(-6deg); }
  .spark { position: absolute; width: 3px; height: 3px; background: var(--v4-text-3); border-radius: 50%; opacity: .5; }
  .spark-one { left: 31%; bottom: 21%; }.spark-two { right: 38%; top: 14%; }
  .story { text-align: center; padding: 0 28px 22px; }
  h3 { margin: 0 auto; max-width: 22ch; font: italic 300 30px/1.17 "Bot Fraunces", Georgia, serif; letter-spacing: -.025em; color: var(--v4-text-1); text-wrap: balance; }
  p { font: 400 13px/1.6 var(--font-ui, var(--font-sans)); color: var(--v4-text-3); margin: 8px 0 0; }
  .story p { max-width: 37ch; margin-inline: auto; text-wrap: balance; }
  .capabilities { margin: 0 24px; border-top: 1px solid var(--v4-rowline, var(--line)); }
  .capability { display: flex; align-items: center; gap: 14px; padding: 12px 0; }
  .capability + .capability { border-top: 1px solid color-mix(in srgb, var(--v4-text-1) 4%, transparent); }
  .row-icon { display: grid; place-items: center; width: 32px; height: 32px; border-radius: 10px; background: color-mix(in srgb, var(--v4-text-1) 4%, transparent); flex: none; color: var(--v4-text-2); }
  h4 { margin: 0; font: 500 13px/1.5 var(--font-ui, var(--font-sans)); color: var(--v4-text-1); }
  .capability p { margin-top: 2px; }
  footer { display: flex; align-items: center; gap: 10px; padding: 14px 24px; border-top: 1px solid var(--v4-rowline, var(--line)); color: var(--v4-text-3); font-size: 12px; }
  .preview-label { flex: none; border: 1px solid var(--v4-rowline, var(--line)); border-radius: 999px; padding: 3px 8px; color: var(--v4-text-2); }
  @keyframes arrive { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: translateY(0); } }
  @media (prefers-reduced-motion: reduce) { .feature { animation: none; } }
  @media (max-width: 480px) { h3 { font-size: 27px; } .story { padding-inline: 20px; } .capabilities { margin-inline: 18px; } footer { padding-inline: 18px; } }
</style>
