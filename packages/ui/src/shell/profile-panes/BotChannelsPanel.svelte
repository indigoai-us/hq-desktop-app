<script lang="ts">
  import BotTabSkeleton from './BotTabSkeleton.svelte';
  import RailIcon from '../../common/button/RailIcon.svelte';
  import ConnectionCardLogo from '../../chat/messaging/ConnectionCardLogo.svelte';
  import { appLogo } from '../../chat/messaging/integration-cards-model.js';
  import { CHANNEL_STATUS, DEFAULT_CHANNELS, type BotChannel } from './bot-channels.js';
  import { dismissable } from '../../common/dismissable.js';

  let { rows, catalog = [], loading = false, error = '', onrefresh, onconnect, ondisconnect, onconfigure }: {
    rows: BotChannel[];
    /** Explicitly supported channels supplied by the host; never an invented production catalog. */
    catalog?: BotChannel[];
    loading?: boolean;
    error?: string;
    onrefresh?: () => Promise<void>;
    onconnect?: (id: string) => Promise<void>;
    onconfigure?: (id: string) => Promise<void>;
    ondisconnect?: (id: string) => Promise<void>;
  } = $props();
  let browsing = $state(false);
  let query = $state('');
  let selected = $state<string | null>(null);
  let pending = $state<string | null>(null);
  let actionError = $state('');
  let confirmDisconnect = $state(false);
  const visible = $derived(rows.filter(row => DEFAULT_CHANNELS.some(item => item.id === row.id) || ['connected', 'pending', 'error'].includes(row.state)));
  const choices = $derived(catalog.filter(row => `${row.name} ${row.description}`.toLowerCase().includes(query.toLowerCase().trim())));
  const current = $derived(rows.find(row => row.id === selected) ?? catalog.find(row => row.id === selected));
  const connected = $derived(rows.filter(row => row.state === 'connected').length);
  function close(): void { if (!pending) { selected = null; actionError = ''; confirmDisconnect = false; } }
  async function openChannel(channel: BotChannel): Promise<void> {
    actionError = ''; selected = channel.id;
    if (!channel.canConnect || !onconfigure) return;
    pending = channel.id;
    try { await onconfigure(channel.id); selected = null; }
    catch { actionError = 'Could not open channel setup. Try again.'; }
    finally { pending = null; }
  }
  async function act(id: string, disconnect = false): Promise<void> {
    if (pending) return;
    pending = id; actionError = '';
    try {
      if (disconnect) await ondisconnect?.(id);
      else { await onconnect?.(id); selected = null; }
      confirmDisconnect = false;
    } catch { actionError = disconnect ? 'Could not disconnect. Try again.' : 'Could not start the connection. Try again.'; }
    finally { pending = null; }
  }
</script>

{#if loading}<BotTabSkeleton kind="channels" onretry={onrefresh} />{:else}
<section class="channels" aria-label="Bot channels" data-testid="bot-channels">
  <div class="overview"><div><span>{loading ? 'Checking connections…' : `${connected} connected`}</span></div><button class="icon-button" type="button" aria-label="Refresh channel status" disabled={loading || !onrefresh || !!pending} onclick={() => onrefresh?.()}><RailIcon name="refresh" /></button></div>
  {#if error}<p class="notice" role="alert">{error}</p>{/if}
  <div class="list" aria-busy={loading}>
    {#each visible as channel (channel.id)}
      <article class="channel" data-testid="channel-{channel.id}">
        <div class="row-head"><span class="logo"><ConnectionCardLogo logo={appLogo(channel.domain)} size={32} /></span><div class="name"><h3>{channel.name}</h3><span class="status"><i class:connected={channel.state === 'connected'} class:attention={channel.state === 'error'}></i>{loading ? 'Checking status…' : CHANNEL_STATUS[channel.state]}</span></div>
          <button type="button" class="button" disabled={loading || !!pending} onclick={() => openChannel(channel)}>
            {channel.state === 'connected' ? (channel.canConnect || channel.canDisconnect ? 'Manage' : 'Details') : !channel.canConnect ? 'Details' : channel.state === 'pending' ? 'Continue setup' : channel.state === 'error' ? 'Reconnect' : 'Connect'}<RailIcon name={channel.state === 'connected' ? 'sliders' : 'arrow-right'} />
          </button>
        </div>
        {#if channel.detail}<p class="detail">{channel.detail}</p>{/if}
      </article>
    {/each}
  </div>
  <div class="browse-card"><span class="browse-symbol"><RailIcon name="plus" /></span><div><h3>Add a channel</h3></div><button type="button" class="button" aria-expanded={browsing} onclick={() => (browsing = !browsing)}>Browse channels<RailIcon name="search" /></button></div>
  {#if browsing}
    <section class="catalog" aria-label="Supported channels">
      <label class="search"><RailIcon name="search" /><input aria-label="Search supported channels" bind:value={query} placeholder="Search channels…" /></label>
      {#if catalog.length === 0}<p class="notice">No additional channel catalog is available for this bot yet.</p>
      {:else if choices.length === 0}<p class="notice">No channels match “{query}”. Try another name.</p>
      {:else}{#each choices as channel (channel.id)}
        {@const known = rows.find(row => row.id === channel.id) ?? channel}
        <button type="button" class="catalog-row" disabled={loading || !!pending} onclick={() => openChannel(known)}><span class="logo"><ConnectionCardLogo logo={appLogo(channel.domain)} size={32} /></span><span><strong>{channel.name}</strong><span>{channel.description}</span></span><span class="catalog-state">{known.state === 'connected' ? 'Connected' : 'View setup'}<RailIcon name="arrow-right" /></span></button>
      {/each}{/if}
    </section>
  {/if}
</section>
{/if}

{#if current}
  <div class="overlay">
    <div class="connection-dialog" tabindex="-1" role="dialog" aria-modal="true" aria-label={`${current.name} connection`} use:dismissable={{ onclose: close, outside: true }}>
      <header><span class="logo"><ConnectionCardLogo logo={appLogo(current.domain)} size={44} /></span><div><h3>{current.name}</h3><p>{CHANNEL_STATUS[current.state]}</p></div><button type="button" class="icon-button" aria-label="Close channel details" disabled={!!pending} onclick={close}><RailIcon name="x" /></button></header>
      <p>{current.description}</p>
      <div class="connection-note">{current.detail ?? (current.state === 'connected' ? 'This channel is connected to your bot.' : 'Continue to the guided connection flow. The channel is marked connected only after confirmation.')}</div>
      {#if actionError}<p class="notice" role="alert">{actionError}</p>{/if}
      {#if pending}<p role="status">{confirmDisconnect ? 'Disconnecting…' : 'Opening connection setup…'}</p>{/if}
      {#if confirmDisconnect}<p class="notice">Disconnect {current.name}? Your bot will stop receiving messages through this connection.</p>{/if}
      <footer>
        <button type="button" class="button" disabled={!!pending} onclick={close}>Done</button>
        {#if current.state === 'connected'}
          {#if current.canDisconnect && ondisconnect}<button type="button" class="button" disabled={!!pending} onclick={() => confirmDisconnect ? act(current.id, true) : (confirmDisconnect = true)}>{confirmDisconnect ? 'Confirm disconnect' : 'Disconnect'}</button>{/if}
        {:else if current.canConnect && onconnect}<button type="button" class="button primary" disabled={!!pending || !current.canConnect || !onconnect} onclick={() => act(current.id)}>{current.state === 'pending' ? 'Continue setup' : `Connect ${current.name}`}<RailIcon name="arrow-right" /></button>{/if}
      </footer>
    </div>
  </div>
{/if}

<style>
  .channels { display: grid; gap: 12px; }
  .overview { display: flex; align-items: center; justify-content: space-between; gap: 12px; }

  p { margin: 6px 0 0; font-size: 13px; line-height: 1.55; color: var(--v4-text-3); }
  h3, strong { margin: 0; font: 500 13px/1.5 var(--font-ui); color: var(--v4-text-1); }
  .list { display: grid; gap: 10px; }
  .channel { border: 1px solid var(--v4-rowline, var(--line)); border-radius: 12px; padding: 14px; background: color-mix(in srgb, var(--v4-text-1) 2%, transparent); }
  .row-head { display: flex; align-items: center; gap: 12px; }.name { flex: 1; min-width: 0; }
  .logo { display: inline-flex; flex: none; filter: grayscale(1); }.status { display: flex; align-items: center; gap: 6px; margin-top: 3px; font-size: 12px; color: var(--v4-text-3); }
  .status i { width: 5px; height: 5px; border-radius: 50%; background: var(--v4-text-3); }.status i.connected { background: var(--v4-ok); }.status i.attention { background: var(--v4-error); }
  .detail { font-size: 12px; padding-top: 8px; margin-top: 10px; border-top: 1px solid var(--v4-rowline, var(--line)); }
  .button, .icon-button { display: inline-flex; align-items: center; justify-content: center; gap: 7px; flex: none; border: 1px solid var(--v4-control-border, var(--line)); border-radius: 999px; background: transparent; color: var(--v4-text-1); min-height: 34px; padding: 0 12px; font: inherit; cursor: pointer; }
  .button:hover:not(:disabled), .icon-button:hover:not(:disabled) { background: var(--v4-hover); }.button:disabled, .icon-button:disabled { opacity: .45; cursor: default; }.icon-button { width: 34px; padding: 0; }
  .primary { background: var(--v4-primary-bg); color: var(--v4-primary-fg); }
  button:focus-visible, input:focus-visible { outline: 2px solid var(--v4-text-2); outline-offset: 2px; }
  .browse-card { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; border: 1px dashed var(--v4-control-border, var(--line)); border-radius: 12px; padding: 14px; }.browse-card > div { flex: 1; min-width: 180px; }.browse-symbol { display: grid; place-items: center; width: 32px; height: 32px; border-radius: 10px; background: var(--v4-control-bg); }
  .search { display: flex; align-items: center; gap: 8px; border: 1px solid var(--v4-control-border, var(--line)); border-radius: 10px; padding: 9px 12px; }.search input { width: 100%; background: none; border: 0; color: var(--v4-text-1); font: inherit; min-width: 0; }
  .catalog-row { width: 100%; display: flex; gap: 12px; align-items: center; padding: 14px 2px; text-align: left; background: none; border: 0; border-bottom: 1px solid var(--v4-rowline, var(--line)); color: var(--v4-text-3); font: inherit; cursor: pointer; }.catalog-row:hover { background: var(--v4-hover); }.catalog-row > span:nth-child(2) { display: grid; gap: 3px; flex: 1; min-width: 0; }.catalog-state { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; }
  .notice { border: 1px solid var(--v4-rowline, var(--line)); padding: 12px; border-radius: 10px; color: var(--v4-text-2); }
  .overlay { position: fixed; inset: 0; z-index: 100; background: rgb(0 0 0 / .55); display: grid; place-items: center; padding: 16px; }
  .connection-dialog { width: min(440px, 100%); max-height: calc(100dvh - 32px); overflow: auto; box-sizing: border-box; border: 1px solid var(--v4-control-border, var(--line)); border-radius: 20px; padding: 24px; background: var(--v4-secondary-sidebar, var(--side-bg)); color: var(--v4-text-1); }
  header { display: flex; gap: 12px; align-items: center; margin-bottom: 20px; }header > div { flex: 1; }header p { margin: 2px 0 0; }.connection-note { font-size: 13px; line-height: 1.6; margin-top: 16px; color: var(--v4-text-2); }footer { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; margin-top: 24px; }
  @media (max-width: 480px) { .channel { padding: 14px; }.row-head { gap: 8px; }.row-head .button { padding-inline: 10px; }.catalog-state { max-width: 65px; }.connection-dialog { padding: 20px; } }
</style>
