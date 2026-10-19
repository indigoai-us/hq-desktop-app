<script lang="ts">
  import BotTabSkeleton from './BotTabSkeleton.svelte';
  import RailIcon from '../../common/button/RailIcon.svelte';
  import Dropdown from '../../common/Dropdown.svelte';
  import { portal, focusOnMount } from '../../chat/portal.js';
  import { dismissable } from '../../common/dismissable.js';
  import { effortLabel } from '../../chat/local-bot-settings.js';
  import type { BrainRow, BrainProvider } from './bot-brain.js';
  export interface BrainSwitchProgress { provider: BrainProvider; status: 'running' | 'waiting'; }
  let { rows, loading = false, error = '', notice = '', canSwitch = false, switching = null, onrefresh, onconnect, onsave, onswitch }: {
    rows: BrainRow[]; loading?: boolean; error?: string; notice?: string; canSwitch?: boolean; switching?: BrainSwitchProgress | null;
    onrefresh?: () => Promise<void>; onconnect?: (id: BrainProvider) => Promise<void>;
    onsave?: (id: BrainProvider, model: string, effort: string) => Promise<void>;
    onswitch?: (id: BrainProvider, model: string, effort: string) => Promise<void>;
  } = $props();
  let selected = $state<BrainProvider | null>(null);
  let model = $state(''), effort = $state('');
  let busy = $state(false), actionError = $state(''), confirming = $state(false);
  const current = $derived(rows.find(row => row.id === selected));
  const active = $derived(rows.find(row => row.active));
  const dirty = $derived(current && (model !== current.model || effort !== current.effort));
  const switchable = $derived(!!current && canSwitch && !current.active && current.state === 'connected' && !!onswitch);
  const switchingName = $derived(switching ? rows.find(row => row.id === switching.provider)?.name ?? switching.provider : '');
  function open(row: BrainRow) { selected = row.id; confirming = false; model = row.active ? row.model : row.models[0]?.value ?? ''; effort = row.active ? row.effort : ''; actionError = ''; }
  function close() { if (!busy) { selected = null; confirming = false; actionError = ''; } }
  async function act(connect = false) {
    if (!current || busy) return;
    busy = true; actionError = '';
    try { if (connect) await onconnect?.(current.id); else await onsave?.(current.id, model, effort); selected = null; }
    catch { actionError = connect ? 'Could not start sign-in. Try again.' : 'Could not save this configuration. Your selections are kept; try again.'; }
    finally { busy = false; }
  }
  async function confirmSwitch() {
    if (!current || busy || !switchable) return;
    busy = true; actionError = '';
    try { await onswitch?.(current.id, model, effort); selected = null; confirming = false; }
    catch (err) { actionError = err instanceof Error && err.message ? err.message : 'Could not start the switch. Try again.'; confirming = false; }
    finally { busy = false; }
  }
</script>
{#if loading}<BotTabSkeleton kind="brain" onretry={onrefresh} />{:else}
<section class="brain" aria-label="Manage brain">
  <div class="active"><div><span class="eyebrow">Current brain</span><h4>{loading ? 'Checking configuration…' : active ? `${active.name} · ${active.models.find(choice => choice.value === active.model)?.label ?? active.model}` : 'Current provider not reported'}</h4><p>{active?.effort ? `Thinking level: ${effortLabel(active.effort, false)}` : active ? 'Thinking level: Provider default' : 'Refresh to check the latest configuration.'}</p>{#if switching}<p class="switching" role="status" data-testid="brain-switching">{switching.status === 'waiting' ? `Switching to ${switchingName} once the bot finishes its current reply…` : `Switching to ${switchingName}…`}</p>{/if}</div><button aria-label="Refresh brain" disabled={loading || busy || !onrefresh} onclick={() => onrefresh?.()}><RailIcon name="refresh" /></button></div>
  {#if error}<p class="notice" role="alert">{error}</p>{/if}
  {#if notice}<p class="notice" role="status">{notice}</p>{/if}
  <div class="section-head"><h4>Providers</h4></div>
  {#each rows as row (row.id)}
    <article class="provider" data-testid={`brain-${row.id}`}><div class="row-head"><span class="logo"><RailIcon name={row.id === 'claude' ? 'claude-code' : row.id} size={28} /></span><div class="name"><h4>{row.name}</h4><p>{row.subtitle}</p></div>{#if row.active}<span class="badge">Current</span>{/if}</div>
      <div class="status"><i class:connected={row.state === 'connected'}></i>{loading ? 'Checking…' : row.state === 'connected' ? 'Connected' : row.state === 'disconnected' ? 'Not connected' : 'Status unavailable'}</div>
      <footer><button disabled={loading} onclick={() => open(row)}>{row.state === 'connected' ? (row.active ? 'Configure' : canSwitch ? 'Use this brain' : 'View') : 'View setup'}<RailIcon name="arrow-right" /></button></footer>
    </article>
  {/each}
</section>
{/if}
{#if current}
<div class="overlay" use:portal><div class="dialog" tabindex="-1" role="dialog" aria-modal="true" aria-label={`${current.name} brain settings`} use:focusOnMount use:dismissable={{ onclose: close }}>
  <header><span class="logo"><RailIcon name={current.id === 'claude' ? 'claude-code' : current.id} size={32} /></span><div><span class="eyebrow">Brain settings</span><h3>{current.name}</h3></div><button disabled={busy} aria-label="Close brain settings" onclick={close}><RailIcon name="x" /></button></header>
  <p>{current.detail}</p>
  {#if current.state !== 'connected'}<div class="notice"><p>{current.state === 'unknown' ? 'Verify or connect your provider before using its models.' : 'Sign in to use models from this provider.'}</p><button class="primary" disabled={busy || !current.canConnect || !onconnect} onclick={() => act(true)}>Connect {current.name}</button></div>{/if}
  {#if current.active}
  <form onsubmit={event => { event.preventDefault(); void act(); }}>
    <fieldset disabled={busy || !current.canSave || current.state !== 'connected'}>
      <div class="field"><span>Model</span><Dropdown constrainToDialog label="Model" options={current.models} bind:value={model} block disabled={busy || !current.canSave || current.state !== 'connected'} /></div>
      <div class="field"><span>Thinking level</span><Dropdown constrainToDialog label="Thinking level" options={[{ value: '', label: 'Keep current default' }, ...current.efforts.map(value => ({ value, label: effortLabel(value, false) })), ...(effort && !current.efforts.includes(effort) ? [{ value: effort, label: effort + ' (current)' }] : [])]} bind:value={effort} block disabled={busy || !current.canSave || current.state !== 'connected'} /></div>
    </fieldset>
    <p class="muted">Changes apply to future messages. Model availability depends on your account and runtime.</p>
    {#if actionError}<p class="notice" role="alert">{actionError}</p>{/if}
    <footer><button type="button" disabled={busy} onclick={close}>Cancel</button>{#if current.canSave}<button class="primary" disabled={busy || !dirty || !current.canSave || current.state !== 'connected' || !onsave}>{busy ? 'Saving…' : 'Save configuration'}</button>{/if}</footer>
  </form>
  {:else if switchable}
  <form data-testid="brain-switch-form" onsubmit={event => { event.preventDefault(); if (confirming) void confirmSwitch(); else confirming = true; }}>
    <fieldset disabled={busy || confirming || !!switching}>
      <div class="field"><span>Model</span><Dropdown constrainToDialog label="Model" options={current.models} bind:value={model} block disabled={busy || confirming || !!switching} /></div>
      <div class="field"><span>Thinking level</span><Dropdown constrainToDialog label="Thinking level" options={[{ value: '', label: `${current.name} default` }, ...current.efforts.map(value => ({ value, label: effortLabel(value, false) }))]} bind:value={effort} block disabled={busy || confirming || !!switching} /></div>
    </fieldset>
    {#if actionError}<p class="notice" role="alert">{actionError}</p>{/if}
    {#if switching}<p class="muted" role="status">A switch is already running. Wait for it to finish.</p>{/if}
    {#if confirming}
      <div class="confirm" role="group" aria-label="Confirm brain switch"><p>Switch this bot to {current.name}? It restarts and answers a test message first{active ? `. ${active.name} stays signed in.` : '.'}</p><footer><button type="button" disabled={busy} onclick={() => { confirming = false; }}>Cancel</button><button type="button" class="primary" disabled={busy || !model} onclick={() => { void confirmSwitch(); }}>{busy ? 'Switching…' : 'Switch'}</button></footer></div>
    {:else}
      <footer><button type="button" disabled={busy} onclick={close}>Cancel</button><button type="button" class="primary" disabled={busy || !model || !!switching} onclick={() => { confirming = true; }}>Use this brain</button></footer>
    {/if}
  </form>
  {:else if current.state === 'connected'}
  <footer><button type="button" disabled={busy} onclick={close}>Close</button></footer>
  {/if}
</div></div>
{/if}
<style>
.brain { display:grid; gap:12px; } h3,h4,p { margin:0; } h3 { font:italic 400 24px/1.3 Georgia,serif; } h4 { font-weight:500; font-size:14px; } p { color:var(--v4-text-3); line-height:1.6; font-size:13px; }.active,.provider { padding:14px; border:1px solid var(--v4-rowline,var(--line)); border-radius:12px; background:color-mix(in srgb,var(--v4-text-1) 2%,transparent); }.provider { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:8px; }.provider .row-head { grid-column:1 / -1; }.provider .status,.provider footer { margin:0; }.active { display:flex; align-items:center; gap:12px; }.active > div { flex:1; min-width:0; }.active h4 { margin:8px 0; overflow-wrap:anywhere; }.switching { margin-top:6px; color:var(--v4-text-2); }.eyebrow,.badge { color:var(--v4-text-3); font-size:12px; }.section-head,.row-head { display:flex; gap:12px; align-items:center; justify-content:space-between; }.name { flex:1; }.logo { display:inline-flex; align-items:center; justify-content:center; width:42px; height:42px; border:1px solid var(--v4-control-border,var(--line)); border-radius:10px; }.badge { border:1px solid var(--v4-control-border,var(--line)); border-radius:999px; padding:3px 8px; }.status { display:flex; gap:6px; align-items:center; margin:8px 0 0; font-size:12px; color:var(--v4-text-3); }.status i { width:5px; height:5px; border-radius:50%; background:var(--v4-text-3); }.status i.connected { background:var(--v4-ok); } footer { display:flex; justify-content:flex-end; align-items:center; flex-wrap:wrap; gap:8px; margin-top:8px; }  button { display:inline-flex; align-items:center; justify-content:center; gap:6px; border:1px solid var(--v4-control-border,var(--line)); border-radius:999px; padding:8px 12px; background:none; color:var(--v4-text-1); font:inherit; cursor:pointer; } button:disabled { opacity:.45; cursor:default; } button:hover:not(:disabled) { background:var(--v4-hover); }.primary { background:var(--v4-primary-bg); color:var(--v4-primary-fg); } button.primary:hover:not(:disabled) { background:var(--v4-primary-bg); color:var(--v4-primary-fg); opacity:.9; }.notice { padding:14px; border:1px solid var(--v4-control-border,var(--line)); border-radius:12px; }.notice button { margin-top:10px; }.confirm { margin-top:12px; padding:14px; border:1px solid var(--v4-control-border,var(--line)); border-radius:12px; }.confirm p { color:var(--v4-text-1); }.overlay { position:fixed; inset:0; z-index:10030; display:grid; place-items:center; padding:16px; background:rgb(0 0 0/.55); }.dialog { box-sizing:border-box; width:min(480px,100%); max-height:calc(100dvh - 32px); overflow:auto; border:1px solid var(--v4-control-border,var(--line)); border-radius:20px; background:var(--v4-secondary-sidebar,var(--side-bg,#191919)); padding:24px; } header { display:flex; gap:12px; align-items:center; margin-bottom:20px; } header > div { flex:1; } fieldset { display:grid; gap:12px; padding:0; margin:20px 0; border:0; min-width:0; } .field { display:grid; gap:8px; font-size:12px; color:var(--v4-text-3); }.muted { font-size:12px; }.dialog > .notice { margin-top:16px; } button:focus-visible { outline:2px solid var(--v4-text-2); outline-offset:3px; } @media(max-width:480px) { .dialog { padding:14px; }.section-head { align-items:flex-start; } }
</style>
