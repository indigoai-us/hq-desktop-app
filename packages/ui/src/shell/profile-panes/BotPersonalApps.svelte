<script lang="ts">
  import { untrack } from 'svelte';
  import type { BotPersonalApp, BotPersonalAppsApi, BotPersonalCatalogEntry } from '@hq/platform';
  import RailIcon from '../../common/button/RailIcon.svelte';
  import ConnectionCardLogo from '../../chat/messaging/ConnectionCardLogo.svelte';
  import { portal, focusOnMount } from '../../chat/portal.js';
  import { dismissable } from '../../common/dismissable.js';
  import { botAppLogo } from './bot-apps.js';
  let { uid, api, onopenurl, onunavailable }: { uid: string; api: BotPersonalAppsApi; onopenurl?: (url: string) => void; onunavailable?: () => void } = $props();
  let apps = $state<BotPersonalApp[]>([]);
  let loading = $state(true);
  let error = $state('');
  let notice = $state('');
  let adding = $state(false);
  let name = $state('');
  let url = $state('');
  let selected = $state<string | null>(null);
  let busy = $state(false);
  let actionError = $state('');
  let confirmRemove = $state(false);
  let signingIn = $state<string | null>(null);
  let connecting = $state(false);
  let browsing = $state(false);
  let catalog = $state<BotPersonalCatalogEntry[]>([]);
  let catalogLoading = $state(false);
  let catalogError = $state('');
  let catalogQuery = $state('');
  let picked = $state<BotPersonalCatalogEntry | null>(null);
  let generation = 0;
  const shownCatalog = $derived(catalog.filter(entry => `${entry.name} ${entry.description}`.toLowerCase().includes(catalogQuery.toLowerCase().trim())));
  const method = (entry: BotPersonalCatalogEntry) => !entry.supported ? 'Not available here yet' : entry.auth === 'oauth' ? 'Browser sign-in' : 'No sign-in needed';
  const current = $derived(apps.find(app => app.name === selected) ?? null);
  const domainOf = (value: string | null) => { try { return value ? new URL(value).hostname.replace(/^mcp\./, '') : ''; } catch { return ''; } };
  const statusOf = (app: BotPersonalApp) => !app.enabled ? 'Turned off' : app.auth === 'oauth' && !app.connected ? 'Needs sign-in' : app.tools !== null ? `Signed in · ${app.tools} tools` : 'Signed in';
  const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  async function refresh() {
    const version = generation;
    loading = apps.length === 0; error = '';
    const result = await api.list(uid);
    if (version !== generation) return;
    if (result.ok) apps = result.value.apps;
    // 404: this person can't manage this bot's own apps (not the owner, or the
    // feature is off for the company). Hide the section instead of an error.
    else if (result.status === 404) onunavailable?.();
    else error ='Could not load this bot’s personal apps. Refresh to try again.';
    loading = false;
  }
  async function signIn(app: string) {
    const version = generation;
    signingIn = app; actionError = ''; notice = '';
    try {
      const started = await api.startSignIn(uid, app);
      if (!started.ok) { actionError = started.message || 'Sign-in could not start. Try again.'; return; }
      onopenurl?.(started.value.authorizationUrl);
      notice = `Finish signing in to ${app} in your browser. This check stops after 5 minutes.`;
      for (let i = 0; i < 150 && version === generation && signingIn === app; i++) {
        await wait(2000);
        const status = await api.signInStatus(uid, started.value.flowId);
        if (version !== generation || signingIn !== app) return;
        if (!status.ok || status.value.status === 'expired') { actionError = 'The sign-in expired. Start it again.'; return; }
        if (status.value.status === 'error') { actionError = status.value.error || 'Sign-in failed. Try again.'; return; }
        if (status.value.status === 'approved') {
          connecting = true;
          notice = `Signed in to ${app}. The bot is reloading to pick up its tools.`;
          if (await untilConnected(app, version)) notice = `${app} is connected.`;
          else if (version === generation) notice = `Signed in to ${app}, but the bot hasn’t picked it up yet. Refresh in a minute.`;
          return;
        }
      }
      if (signingIn === app) actionError = 'Sign-in was not finished in time. Start it again.';
    } finally { if (signingIn === app) { signingIn = null; connecting = false; } }
  }
  async function untilConnected(app: string, version: number) {
    for (let i = 0; i < 40; i++) {
      await wait(3000);
      if (version !== generation) return false;
      const result = await api.list(uid);
      if (version !== generation) return false;
      if (!result.ok) continue;
      apps = result.value.apps;
      if (apps.some(row => row.name === app && row.connected)) return true;
    }
    return false;
  }
  async function add() {
    busy = true; actionError = '';
    const appName = name.trim().toLowerCase(), appUrl = url.trim();
    try {
      const result = await api.add(uid, { name: appName, url: appUrl });
      if (!result.ok) { actionError = result.status === 409 ? 'This bot already has an app with that name.' : result.message || 'Could not add this app.'; return; }
      adding = false; name = ''; url = '';
      await refresh();
      void signIn(appName);
    } finally { busy = false; }
  }
  async function browse() {
    browsing = true; picked = null; actionError = '';
    if (catalog.length) return;
    catalogLoading = true; catalogError = '';
    const result = await api.catalog(uid);
    catalogLoading = false;
    if (result.ok) catalog = result.value.entries;
    else catalogError = 'Could not load the app catalog. Close and try again.';
  }
  async function addFromCatalog(entry: BotPersonalCatalogEntry) {
    if (!entry.url || !entry.supported) return;
    busy = true; actionError = '';
    const auth = entry.auth === 'oauth' ? 'oauth' : 'none';
    try {
      const result = await api.add(uid, { name: entry.name, url: entry.url, auth });
      if (!result.ok) { actionError = result.status === 409 ? 'This bot already has this app.' : result.message || 'Could not add this app.'; return; }
      browsing = false; picked = null; catalog = [];
      if (auth === 'oauth') { await refresh(); void signIn(entry.name); }
      else { notice = `${entry.name} was added. The bot is reloading to pick up its tools.`; await wait(20000); await refresh(); }
    } finally { busy = false; }
  }
  async function remove(app: string) {
    busy = true; actionError = '';
    try {
      const result = await api.remove(uid, app);
      if (!result.ok) { actionError = 'Could not remove this app. Try again.'; return; }
      selected = null; confirmRemove = false;
      notice = `${app} was removed from this bot, including its saved sign-in.`;
      await refresh();
    } finally { busy = false; }
  }
  function close() { if (!busy) { selected = null; adding = false; browsing = false; picked = null; actionError = ''; confirmRemove = false; } }
  $effect(() => {
    void uid; void api;
    untrack(() => { generation++; apps = []; signingIn = null; connecting = false; void refresh(); });
    return () => { generation++; };
  });
</script>
<section class="personal" aria-label="Personal apps">
  <div class="section-head">
    <div><h4>Personal apps</h4><p class="muted">Apps this bot signs in to on its own. Only this bot can use them.</p></div>
    <button class="icon-button" disabled={loading || !!signingIn} onclick={() => void refresh()} aria-label="Refresh personal apps" title="Refresh personal apps"><RailIcon name="refresh" /></button>
    <button disabled={!!signingIn} onclick={() => { adding = true; actionError = ''; }}>Add by address</button>
    <button class="primary" disabled={!!signingIn} aria-haspopup="dialog" onclick={() => void browse()}><RailIcon name="plus" />Browse apps</button>
  </div>
  {#if error}<p class="notice" role="alert">{error}</p>{/if}
  {#if notice}<p class="notice" role="status">{notice}</p>{/if}
  {#if actionError && !selected && !adding}<p class="notice" role="alert">{actionError}</p>{/if}
  {#if loading}<p class="muted" role="status">Checking this bot’s apps…</p>
  {:else if !error && apps.length === 0}<p class="muted">No personal apps yet. Add an app’s MCP address to let this bot sign in to it.</p>
  {:else}
    <div class="cards">{#each apps as app (app.name)}
      <button class="app-card" data-testid="personal-app" onclick={() => { selected = app.name; actionError = ''; confirmRemove = false; }}>
        <span class="logo"><ConnectionCardLogo logo={botAppLogo({ domain: domainOf(app.url), name: app.name, provider: app.name })} size={32} /></span>
        <span class="content"><strong>{app.name}</strong><span class="status"><i class:ready={app.connected && app.enabled} class:attention={app.auth === 'oauth' && !app.connected}></i>{signingIn === app.name ? connecting ? 'Connecting…' : 'Waiting for sign-in…' : statusOf(app)}</span></span>
      </button>
    {/each}</div>
  {/if}
</section>
{#if browsing && !picked}
  <div class="overlay" use:portal><div class="dialog catalog-dialog" role="dialog" aria-modal="true" aria-label="Browse personal apps" tabindex="-1" use:dismissable={{ onclose: close, outside: true }}>
    <header><div><h3>Add a personal app</h3><p class="muted">Apps this bot’s runtime knows how to connect. The bot signs in with your account, and only this bot can use it.</p></div><button class="icon-button" aria-label="Close app browser" onclick={close}><RailIcon name="x" /></button></header>
    <label class="search catalog-search"><RailIcon name="search" /><input use:focusOnMount aria-label="Search personal apps" bind:value={catalogQuery} placeholder="Search {catalog.length || ''} apps…" /></label>
    <div class="catalog-results">
      {#if catalogLoading}<p class="muted" role="status">Loading the bot’s app catalog…</p>{:else if catalogError}<p class="notice" role="alert">{catalogError}</p>{:else if shownCatalog.length === 0}<p class="muted">No apps match.</p>{/if}
      <div class="catalog-grid">{#each shownCatalog as entry (entry.name)}
        <button class="catalog-card" data-testid="personal-catalog-app" disabled={!entry.supported} onclick={() => { picked = entry; actionError = ''; }}>
          <span class="catalog-identity"><ConnectionCardLogo logo={botAppLogo({ domain: domainOf(entry.url), name: entry.name, provider: entry.name })} size={32} /><strong>{entry.name}</strong></span>
          <span class="catalog-description muted">{entry.description}</span>
          <span class="method muted">{entry.installed || apps.some(app => app.name === entry.name) ? 'Added' : method(entry)}</span>
        </button>
      {/each}</div>
    </div>
  </div></div>
{/if}
{#if picked}
  <div class="overlay" use:portal><div class="dialog" role="dialog" aria-modal="true" aria-label="Add {picked.name}" tabindex="-1" use:focusOnMount use:dismissable={{ onclose: () => { if (!busy) picked = null; } }}>
    <header><span class="logo"><ConnectionCardLogo logo={botAppLogo({ domain: domainOf(picked.url), name: picked.name, provider: picked.name })} size={44} /></span><div><h3>{picked.name}</h3><p class="muted">{picked.url}</p></div><button class="icon-button" aria-label="Close" disabled={busy} onclick={() => picked = null}><RailIcon name="x" /></button></header>
    <p>{picked.description}</p>
    <p class="notice">{picked.auth === 'oauth' ? 'You’ll sign in to this app in your browser. The bot keeps that sign-in for itself.' : 'This app doesn’t need a sign-in. The bot reloads to pick up its tools.'}</p>
    {#if actionError}<p class="notice" role="alert">{actionError}</p>{/if}
    <footer><button disabled={busy} onclick={() => picked = null}>Back to apps</button><button class="primary" disabled={busy || apps.some(app => app.name === picked!.name)} onclick={() => void addFromCatalog(picked!)}>{busy ? 'Adding…' : picked.auth === 'oauth' ? 'Add and sign in' : 'Add app'}</button></footer>
  </div></div>
{/if}
{#if adding}
  <div class="overlay" use:portal><div class="dialog" role="dialog" aria-modal="true" aria-label="Add personal app" tabindex="-1" use:dismissable={{ onclose: close }}>
    <header><div><h3>Add a personal app</h3><p class="muted">The bot signs in with your account for this app. Nobody else in the company can use it.</p></div><button class="icon-button" aria-label="Close" disabled={busy} onclick={close}><RailIcon name="x" /></button></header>
    <form onsubmit={event => { event.preventDefault(); void add(); }}>
      <label>Name<input use:focusOnMount bind:value={name} placeholder="notion" autocomplete="off" /></label>
      <label>MCP address<input bind:value={url} placeholder="https://mcp.notion.com/mcp" autocomplete="off" /></label>
      {#if actionError}<p class="notice" role="alert">{actionError}</p>{/if}
      <footer><button type="button" disabled={busy} onclick={close}>Cancel</button><button class="primary" disabled={busy || !name.trim() || !url.trim()}>{busy ? 'Adding…' : 'Add and sign in'}</button></footer>
    </form>
  </div></div>
{/if}
{#if current}
  <div class="overlay" use:portal><div class="dialog" role="dialog" aria-modal="true" aria-label="Manage personal app" tabindex="-1" use:focusOnMount use:dismissable={{ onclose: close }}>
    <header><span class="logo"><ConnectionCardLogo logo={botAppLogo({ domain: domainOf(current.url), name: current.name, provider: current.name })} size={44} /></span><div><h3>{current.name}</h3><p class="muted">{current.url}</p></div><button class="icon-button" aria-label="Close" disabled={busy} onclick={close}><RailIcon name="x" /></button></header>
    <p class="status-line">{statusOf(current)}</p>
    <p class="muted">This app runs in the bot itself and uses the bot’s own sign-in. Removing it also deletes that saved sign-in.</p>
    {#if confirmRemove}<p class="notice">Remove {current.name} from this bot?</p>{/if}
    {#if actionError}<p class="notice" role="alert">{actionError}</p>{/if}
    <footer>
      <button disabled={busy} onclick={() => { if (!confirmRemove) confirmRemove = true; else void remove(current!.name); }}>{busy ? 'Removing…' : confirmRemove ? 'Confirm removal' : 'Remove'}</button>
      {#if current.auth === 'oauth'}<button class="primary" disabled={busy || !!signingIn} onclick={() => { const app = current!.name; selected = null; void signIn(app); }}>{current.connected ? 'Sign in again' : 'Sign in'}</button>{/if}
    </footer>
  </div></div>
{/if}
<style>
  .personal { display:grid; gap:8px; margin-top:18px; padding-top:14px; border-top:1px solid var(--v4-rowline,var(--line)); container-type:inline-size; }
  h3,h4,p { margin:0; } h3 { font:italic 400 24px/1.3 Georgia,serif; } h4,strong { font-weight:500; } p { line-height:1.6; }
  button,input { font:inherit; color:var(--v4-text-1); }
  button { display:inline-flex; align-items:center; justify-content:center; gap:6px; cursor:pointer; background:transparent; border:1px solid var(--v4-control-border,var(--line)); border-radius:8px; padding:7px 10px; font-size:12px; }
  button:hover:not(:disabled) { background:var(--v4-hover); } button:disabled { opacity:.45; cursor:default; }
  .primary { background:var(--v4-primary-bg); color:var(--v4-primary-fg); }
  button.primary:hover:not(:disabled) { background:var(--v4-primary-bg); color:var(--v4-primary-fg); opacity:.9; }
  button:focus-visible { outline:2px solid var(--v4-text-2); outline-offset:3px; }
  .section-head { display:flex; align-items:center; gap:6px; } .section-head > div { flex:1; min-width:0; }
  .icon-button { width:32px; height:var(--hq-btn-h); padding:6px; flex:none; }
  .muted { color:var(--v4-text-3); font-size:12px; line-height:1.5; }
  .notice { padding:14px; border:1px solid var(--v4-rowline,var(--line)); border-radius:10px; }
  .cards { display:grid; gap:6px; grid-template-columns:repeat(auto-fill,minmax(min(190px,100%),1fr)); }
  .app-card { width:100%; min-width:0; text-align:left; justify-content:flex-start; padding:10px; gap:10px; border-radius:10px; background:color-mix(in srgb,var(--v4-text-1) 2%,transparent); }
  .content { display:grid; flex:1; gap:4px; min-width:0; } .content strong { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:13px; }
  .status { display:flex; align-items:center; gap:5px; color:var(--v4-text-3); font-size:11px; }
  .status i { flex:none; width:5px; height:5px; border-radius:50%; background:var(--v4-text-3); }
  .status i.ready { background:var(--v4-ok); } .status i.attention { background:var(--v4-error); }
  .logo { display:inline-flex; flex:none; }
  .overlay { position:fixed; inset:0; z-index:10030; display:grid; place-items:center; padding:16px; background:rgb(0 0 0/.55); }
  .dialog { box-sizing:border-box; width:min(480px,100%); max-height:calc(100dvh - 32px); overflow:auto; padding:24px; border:1px solid var(--v4-control-border,var(--line)); border-radius:20px; background:var(--v4-secondary-sidebar,var(--side-bg,#191919)); }
  header { display:flex; align-items:center; gap:12px; margin-bottom:16px; } header > div { flex:1; min-width:0; } h3,.dialog .muted { overflow-wrap:anywhere; }
  .dialog > p + p { margin-top:12px; } .status-line { font-size:13px; }
  form { display:grid; gap:12px; } label { display:grid; gap:6px; font-size:12px; color:var(--v4-text-2); }
  input { border:1px solid var(--v4-control-border,var(--line)); border-radius:8px; padding:8px 10px; background:transparent; font-size:13px; }
  input:focus { outline:none; border-color:var(--v4-text-3); }
  footer { display:flex; flex-wrap:wrap; gap:8px; justify-content:flex-end; margin-top:20px; }
  .catalog-dialog { width:min(820px,100%); display:flex; flex-direction:column; overflow:hidden; }
  .search { display:flex; gap:6px; align-items:center; border:1px solid var(--v4-control-border,var(--line)); border-radius:8px; padding:6px 9px; margin-bottom:16px; flex:none; }
  .search:focus-within { border-color:var(--v4-text-3); }
  .search input,.search input:focus { border:0; padding:0; outline:none; width:100%; font-size:12px; }
  .catalog-results { overflow:auto; min-height:0; padding:2px; }
  .catalog-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(min(220px,100%),1fr)); gap:10px; }
  .catalog-card { display:flex; flex-direction:column; align-items:flex-start; text-align:left; padding:12px; border-radius:12px; gap:10px; min-width:0; }
  .catalog-identity { display:flex; align-items:center; gap:10px; min-width:0; overflow-wrap:anywhere; }
  .catalog-description { display:-webkit-box; -webkit-line-clamp:2; line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
  .method { margin-top:auto; }
  @media(max-width:480px) { .dialog { padding:16px; } }
</style>
