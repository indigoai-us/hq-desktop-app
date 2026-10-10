<!--
  ?view=repair-cards[&state=<id>][&theme=light|dark][&bot=<name>][&live=1]

  The product runtime repair card (RuntimeRepairCard.svelte, drawn from
  runtime-repair-model.ts) in a local bot's DM. Without &state the page shows
  every state side by side; with &state it shows one DM thread. &live=1 runs
  each button through the real RuntimeRepairController with a fake host.

  States: signed-out, update, model, transient, signing-in, updating, fixed.
  Message rows reuse ChannelConversation's row geometry (32px avatar, 12px
  gutter, 14px/600 author, 15px body) and IdentityMark.
-->
<script lang="ts">
  import '../../../packages/ui/src/chat/chat-tokens.css';
  import '../../../packages/ui/src/chat/messaging/messaging-tokens.css';
  import '../../../packages/ui/src/chat/messaging/message-row.css';
  import IdentityMark from '../../../packages/ui/src/chat/messaging/IdentityMark.svelte';
  import RuntimeRepairCard from '../../../packages/ui/src/chat/messaging/RuntimeRepairCard.svelte';
  import {
    repairCardView,
    type RepairCardState,
    type RepairPayload,
  } from '../../../packages/ui/src/chat/messaging/runtime-repair-model';
  import { RuntimeRepairController } from '../../../packages/ui/src/chat/messaging/runtime-repair.svelte';

  const params = new URLSearchParams(window.location.search);
  /** The bot's name as the person knows it (`&bot=`); the product uses the real one. */
  const BOT = params.get('bot')?.trim() || 'Scout';
  const BOT_UID = 'agt_scout_preview';

  const payload = (cls: RepairPayload['class'], runtime: RepairPayload['runtime']): RepairPayload => ({
    v: 1,
    kind: 'runtime-repair',
    class: cls,
    runtime,
    action: ({ 'signed-out': 'signIn', 'cli-outdated': 'update', 'model-unsupported': 'switchModel', transient: 'tryAgain' } as const)[cls],
    botName: 'scout',
  });

  interface Scenario {
    id: string;
    label: string;
    ask: string;
    payload: RepairPayload;
    state: RepairCardState;
  }

  const SCENARIOS: Scenario[] = [
    { id: 'signed-out', label: 'Signed out', ask: 'Can you sum up yesterday\u2019s pricing call?', payload: payload('signed-out', 'claude'), state: { phase: 'offered' } },
    { id: 'update', label: 'CLI too old', ask: 'Draft the weekly update for the team.', payload: payload('cli-outdated', 'codex'), state: { phase: 'offered' } },
    { id: 'model', label: 'Unsupported model', ask: 'Review the launch plan and flag risks.', payload: payload('model-unsupported', 'claude'), state: { phase: 'offered' } },
    { id: 'transient', label: 'Transient', ask: 'What\u2019s on my calendar tomorrow?', payload: payload('transient', 'claude'), state: { phase: 'offered' } },
    { id: 'signing-in', label: 'In progress: signing in', ask: 'Can you sum up yesterday\u2019s pricing call?', payload: payload('signed-out', 'claude'), state: { phase: 'working', action: 'signIn' } },
    { id: 'updating', label: 'In progress: updating', ask: 'Draft the weekly update for the team.', payload: payload('cli-outdated', 'codex'), state: { phase: 'working', action: 'update' } },
    { id: 'fixed', label: 'Fixed', ask: 'Can you sum up yesterday\u2019s pricing call?', payload: payload('signed-out', 'claude'), state: { phase: 'fixed', action: 'signIn' } },
  ];

  /**
   * `&live=1`: the cards run through the real controller with a fake host
   * (each action takes a moment, then the check passes), so a press shows
   * working and then fixed in place.
   */
  const live = params.get('live') === '1';
  const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const controller = new RuntimeRepairController({
    signIn: async () => (await wait(1200), true),
    update: async () => (await wait(1200), true),
    setModel: async () => (await wait(600), true),
    probe: async () => (await wait(600), { ok: true }),
    send: async () => {},
  });

  const only = params.get('state');
  const theme = params.get('theme') === 'light' ? 'light' : 'dark';
  const shown = only ? SCENARIOS.filter((s) => s.id === only) : SCENARIOS;

  function viewFor(s: Scenario) {
    const state = live ? controller.stateFor(s.id) : s.state;
    return repairCardView(s.payload, state, BOT, controller.updatePathFor(s.payload.runtime));
  }
</script>

{#snippet thread(s: Scenario)}
  <div class="rr-thread">
    <div class="rr-msg rr-group-start">
      <span class="rr-avatar"><IdentityMark kind="person" label="Stefan Johnson" size="regular" /></span>
      <div class="rr-col">
        <div class="rr-meta"><span class="rr-author">Stefan Johnson</span><span class="rr-time">9:41 AM</span></div>
        <div class="rr-body">{s.ask}</div>
      </div>
    </div>
    <div class="rr-msg rr-group-start">
      <span class="rr-avatar"><IdentityMark kind="agent" label={BOT} agentUid={BOT_UID} size="regular" /></span>
      <div class="rr-col">
        <div class="rr-meta"><span class="rr-author">{BOT}</span><span class="rr-time">9:41 AM</span></div>
        <RuntimeRepairCard view={viewFor(s)} onaction={(action) => controller.run(s.id, s.payload, action)} />
      </div>
    </div>
  </div>
{/snippet}

<div class="chat-shell rr-page" data-theme={theme} class:single={!!only}>
  {#if only && shown[0]}
    <section class="rr-dm" data-testid="repair-state" data-state={shown[0].id}>
      <header class="rr-dm-head">
        <IdentityMark kind="agent" label={BOT} agentUid={BOT_UID} size="small" />
        <span class="rr-dm-name">{BOT}</span>
        <span class="rr-dm-sub">Bot · runs on this Mac</span>
      </header>
      {@render thread(shown[0])}
    </section>
  {:else}
    <header class="rr-title">
      <h1>Bot runtime repair cards</h1>
      <p>A local bot posts one of these in its DM when it is signed out or can’t run, then the same card confirms in place.</p>
    </header>
    <div class="rr-grid">
      {#each shown as s (s.id)}
        <section class="rr-panel" data-testid="repair-state" data-state={s.id}>
          <span class="rr-k">{s.label}</span>
          {@render thread(s)}
        </section>
      {/each}
    </div>
  {/if}
</div>

<style>
  /* The tray-window CSS pins html/body to the viewport; this page scrolls. */
  :global(html),
  :global(body),
  :global(#app) {
    margin: 0;
    height: auto !important;
    min-height: 0 !important;
    max-height: none !important;
    overflow: visible !important;
    width: auto !important;
  }
  .rr-page {
    min-height: 100vh;
    box-sizing: border-box;
    padding: 28px;
    background: var(--elevated);
    color: var(--t1);
  }
  .rr-page.single {
    padding: 0;
  }
  .rr-title h1 {
    margin: 0 0 4px;
    font-size: 20px;
    font-weight: 500;
    letter-spacing: -0.005em;
  }
  .rr-title p {
    margin: 0 0 20px;
    font-size: 13px;
    color: var(--t2);
    max-width: 70ch;
  }
  .rr-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 16px;
  }
  .rr-panel {
    border: 1px solid var(--line2);
    border-radius: 8px;
    padding: 12px 8px 12px;
    background: var(--ground);
  }
  .rr-k {
    display: block;
    padding: 0 8px;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--t3);
  }
  .rr-dm {
    min-height: 100vh;
    box-sizing: border-box;
  }
  .rr-dm-head {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 48px;
    padding: 0 16px;
    border-bottom: 1px solid var(--line);
  }
  .rr-dm-name {
    font-size: 14px;
    font-weight: 600;
  }
  .rr-dm-sub {
    font-size: 12px;
    color: var(--t3);
  }
  .rr-dm .rr-thread {
    padding: 8px 8px 24px;
  }
  /* ChannelConversation's .dm-msg row geometry. */
  .rr-msg {
    display: grid;
    grid-template-columns: 32px minmax(0, 1fr);
    align-items: start;
    gap: 12px;
    box-sizing: border-box;
    width: 100%;
    padding: var(--msg-row-pad-y, 3px) 8px;
  }
  .rr-group-start {
    margin-top: var(--msg-group-gap, 12px);
    padding-top: 3px;
  }
  .rr-avatar {
    display: grid;
    place-items: start center;
    width: 32px;
    padding-top: var(--msg-avatar-pad-top, 2px);
  }
  .rr-col {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    min-width: 0;
  }
  .rr-meta {
    display: flex;
    align-items: baseline;
    gap: 0.4375rem;
    margin: 0 0 var(--msg-name-body-gap, 0.1875rem);
  }
  .rr-author {
    font-size: 14px;
    font-weight: 600;
    line-height: var(--msg-author-line-height, 1.3);
    color: var(--t1);
  }
  .rr-time {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--t3);
  }
  .rr-body {
    font: var(--msg-body-font);
    color: var(--t2);
  }
</style>
