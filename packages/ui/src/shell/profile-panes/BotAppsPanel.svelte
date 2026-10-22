<script lang="ts">
  import BotTabSkeleton from './BotTabSkeleton.svelte';
  import RailIcon from '../../common/button/RailIcon.svelte';
  import ConnectionCardLogo from '../../chat/messaging/ConnectionCardLogo.svelte';
  import { botAppLogo, botHasApp, companyHasCatalogApp } from './bot-apps.js';
  import { portal, focusOnMount } from '../../chat/portal.js';
  import { dismissable } from '../../common/dismissable.js';
  import type { BotApp, ConnectResult, SupportedApp } from './bot-apps.js';
  let { title = null, configurable = [], onconfigure, rows, catalog = [], loading = false, catalogLoading = false, error = '', catalogError = '', notice = '', canConnect = false, onsearch, onrefresh, onconnect, ontoggle, oncancel }: {
    title?: string | null;
    configurable?: string[]; onconfigure?: (id: string) => void;
    rows: BotApp[]; catalog?: SupportedApp[]; loading?: boolean; catalogLoading?: boolean; error?: string; catalogError?: string; notice?: string; canConnect?: boolean;
    oncancel?: () => void;
    onsearch?: (query: string) => Promise<void>; onrefresh?: () => Promise<void>; onconnect?: (app: SupportedApp) => Promise<ConnectResult>; ontoggle?: (id: string, enabled: boolean) => Promise<void>;
  } = $props();
  let query = $state('');
  let browsing = $state(false);
  let view = $state<'list' | 'grid'>('grid');
  let catalogQuery = $state('');
  let applied = $state('');
  let selected = $state<string | null>(null);
  let selectedCatalog = $state<SupportedApp | null>(null);
  let busy = $state(false);
  let adding = $state<string | null>(null);
  let justConnected = $state<string | null>(null);
  let actionError = $state('');
  let browseError = $state('');
  let confirmation = $state(false);
  const current = $derived(rows.find(row => row.id === selected));
  const matches = (row: BotApp, text: string) => `${row.name} ${row.domain}`.toLowerCase().includes(text.toLowerCase().trim());
  const mine = $derived(rows.filter(botHasApp));
  const others = $derived(rows.filter(row => !botHasApp(row)));
  const unverified = $derived(rows.filter(row => row.status === 'unknown').length);
  const shown = $derived(mine.filter(row => matches(row, query)));
  const shownOthers = $derived(others.filter(row => row.id === justConnected || matches(row, applied)).sort((a, b) => Number(b.id === justConnected) - Number(a.id === justConnected)));
  const newApps = $derived(catalog.filter(app => !companyHasCatalogApp(rows, app)));
  const labels = { ready: 'Available to bot', available: 'Company connection', attention: 'Needs attention', unknown: 'Access unverified' };
  const browseLabels = { ready: 'On this bot', available: 'Not on this bot', attention: 'Needs attention', unknown: 'Access unverified' };
  const method = (app: SupportedApp) => app.authClass === 'oauth' ? 'Browser sign-in' : app.authClass === 'key' ? 'API key' : 'No sign-in needed';
  function browse() { browsing = true; applied = catalogQuery; browseError = ''; void onsearch?.(catalogQuery); }
  function closeBrowse() { if (!adding) { browsing = false; justConnected = null; browseError = ''; } }
  function search() { applied = catalogQuery; void onsearch?.(catalogQuery); }
  function open(id: string) { selected = id; selectedCatalog = null; actionError = ''; confirmation = false; }
  function close() { if (!busy) { selected = null; selectedCatalog = null; actionError = ''; confirmation = false; } }
  async function act(action: () => Promise<void>) {
    busy = true; actionError = '';
    try { await action(); confirmation = false; }
    catch { actionError = 'Could not complete this action. Refresh or try again.'; }
    finally { busy = false; }
  }
  async function connect(app: SupportedApp) {
    if (!onconnect || busy) return;
    busy = true; actionError = '';
    try {
      const result = await onconnect(app);
      selectedCatalog = null;
      if (result.kind === 'handoff') { browsing = false; justConnected = null; }
      else justConnected = result.id;
    } catch { actionError = 'Could not complete this action. Refresh or try again.'; }
    finally { busy = false; }
  }
  async function addFromBrowse(id: string) {
    if (!ontoggle || adding) return;
    adding = id; browseError = '';
    try { await ontoggle(id, true); if (justConnected === id) justConnected = null; }
    catch { browseError = 'Could not add this app to the bot. Refresh or try again.'; }
    finally { adding = null; }
  }
</script>
{#if loading}<BotTabSkeleton kind="apps" onretry={onrefresh} />{:else}
<section class="apps" aria-label="Manage apps">
  <div class="section-head">
    <div>{#if title}<h4>{title}</h4>{/if}<p class="muted">Shared company accounts this bot can use. Browse apps to add more.</p></div>
    <button class="icon-button" disabled={loading || busy || !onrefresh} onclick={() => onrefresh?.()} aria-label="Refresh apps" title="Refresh apps"><RailIcon name="refresh" /></button>
    <button class="primary browse-button" aria-haspopup="dialog" onclick={browse}><RailIcon name="plus" />Browse apps</button>
  </div>
  {#if mine.length}<div class="toolbar">
    <label class="search"><RailIcon name="search" /><input aria-label="Filter bot apps" bind:value={query} placeholder="Search apps…" /></label>
    <div class="view-toggle" role="group" aria-label="App view">
      <button class="icon-button" class:active={view === 'list'} aria-label="List view" title="List view" aria-pressed={view === 'list'} onclick={() => view = 'list'}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 5h10M7 10h10M7 15h10M3 5h.01M3 10h.01M3 15h.01" /></svg></button>
      <button class="icon-button" class:active={view === 'grid'} aria-label="Grid view" title="Grid view" aria-pressed={view === 'grid'} onclick={() => view = 'grid'}><svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="3" width="5" height="5" rx="1" /><rect x="12" y="3" width="5" height="5" rx="1" /><rect x="3" y="12" width="5" height="5" rx="1" /><rect x="12" y="12" width="5" height="5" rx="1" /></svg></button>
    </div>
    <span class="muted count">{`${shown.length}${shown.length !== mine.length ? ` of ${mine.length}` : ''} apps`}</span>
  </div>{/if}
  {#if error}<p class="notice" role="alert">{error}</p>{/if}
  {#if !error && unverified}<p class="notice" role="alert" data-testid="bot-apps-unverified">Could not check this bot’s access to {unverified === 1 ? '1 company app' : `${unverified} company apps`}. Refresh to try again.</p>{/if}
  {#if notice}<p class="notice" role="status">{notice}</p>{/if}
  {#if !error && !unverified && mine.length === 0}<p class="muted" data-testid="bot-apps-empty">No company apps are connected to this bot.</p>
  {:else if mine.length && shown.length === 0}<p class="muted">No apps match this search.</p>{/if}
  <div class="app-results" class:grid-view={view === 'grid'} data-view={view}>{#each shown as app (app.id)}<button class="app-card" data-testid="bot-app" onclick={() => open(app.id)}><span class="logo"><ConnectionCardLogo logo={botAppLogo(app)} size={32} /></span><span class="app-content"><strong>{app.name}</strong><span class="status"><i class:ready={app.status === 'ready'} class:attention={app.status === 'attention'}></i>{labels[app.status]}{app.tools !== null ? ` · ${app.tools} tools` : ''}</span></span><span class="manage" aria-hidden="true">↗</span></button>{/each}</div>
</section>
{/if}
{#if browsing && !selectedCatalog && !current}
  <div class="overlay" use:portal><div class="dialog catalog-dialog" role="dialog" aria-modal="true" aria-label="Browse apps" tabindex="-1" use:dismissable={{ onclose: closeBrowse, outside: true }}>
    <header><div><h3>Find your next app</h3><p class="muted">Add one of the company’s apps to this bot, or connect a new app to the company.</p></div><button class="icon-button" aria-label="Close app browser" disabled={!!adding} onclick={closeBrowse}><RailIcon name="x" /></button></header>
    <form class="search catalog-search" onsubmit={event => { event.preventDefault(); search(); }}><RailIcon name="search" /><input use:focusOnMount aria-label="Search supported apps" bind:value={catalogQuery} placeholder="Search apps…" /><button disabled={catalogLoading || !onsearch}>{catalogLoading ? 'Searching…' : 'Search'}</button></form>
    {#if browseError}<p class="notice browse-error" role="alert">{browseError}</p>{/if}
    <div class="catalog-results">
      {#if others.length}<section class="catalog-group" aria-label="Company connections"><div class="group-head"><h4>Company connections</h4><p class="muted">Connected to the company but not to this bot.</p></div>
        {#if shownOthers.length === 0}<p class="muted">No company connections match.</p>{/if}
        <div class="catalog-grid">{#each shownOthers as app (app.id)}<div class="catalog-card" data-testid="company-app">
          <button class="catalog-identity card-title" aria-label="{app.name} details" disabled={!!adding || busy} onclick={() => open(app.id)}><ConnectionCardLogo logo={botAppLogo(app)} size={32} /><strong>{app.name}</strong></button>
          <span class="status"><i class:attention={app.status === 'attention'}></i>{app.id === justConnected ? 'Just connected · not on this bot' : browseLabels[app.status]}</span>
          {#if app.canToggle && ontoggle}<button class="primary card-action" disabled={!!adding || busy} onclick={() => void addFromBrowse(app.id)}>{adding === app.id ? 'Adding…' : 'Add to bot'}</button>
          {:else}<button class="card-action" disabled={!!adding || busy} onclick={() => open(app.id)}>Details</button>{/if}
        </div>{/each}</div>
      </section>{/if}
      <section class="catalog-group" aria-label="Connect a new app"><div class="group-head"><h4>Connect a new app</h4><p class="muted">Apps the company has not connected yet.</p></div>
        {#if catalogLoading}<BotTabSkeleton kind="apps" />{:else if catalogError}<p role="alert">{catalogError}</p>{:else if newApps.length === 0}<p class="muted">No apps found. Try another name.</p>{/if}
        {#if !catalogLoading}<div class="catalog-grid">{#each newApps as app (app.id)}<div class="catalog-card" data-testid="catalog-app">
          <span class="catalog-identity"><ConnectionCardLogo logo={botAppLogo(app)} size={32} /><strong>{app.name}</strong></span>
          <span class="status">{method(app)}</span>
          <button class="card-action" disabled={!!adding || busy} onclick={() => { selectedCatalog = app; selected = null; actionError = ''; }}>Connect</button>
        </div>{/each}</div>{/if}
      </section>
    </div>
  </div></div>
{/if}
{#if current || selectedCatalog}
  <div class="overlay" use:portal><div class="dialog" role="dialog" aria-modal="true" tabindex="-1" aria-label={current ? 'Manage app' : 'Connect app'} use:focusOnMount use:dismissable={{ onclose: close }}>
    <header><span class="logo"><ConnectionCardLogo logo={botAppLogo(current ?? selectedCatalog!)} size={44} /></span><div><h3>{current?.name ?? selectedCatalog?.name}</h3><p class="muted">{current?.domain ?? selectedCatalog?.domain}</p></div><button disabled={busy} aria-label="Close app details" onclick={close}><RailIcon name="x" /></button></header>
    {#if current}<p class="status">{labels[current.status]}</p><p>{current.detail}</p>{#if current.tools !== null}<p class="muted">{current.tools} tools reported by this bot.</p>{/if}
      {#if confirmation}<p class="notice">Remove this bot’s access? The company connection and other people’s access will remain.</p>{/if}
    {:else if selectedCatalog}<p>{selectedCatalog.description}</p><p class="notice">{selectedCatalog.authClass === 'oauth' ? 'Sign in securely in your browser, then return here. HQ will verify the connection.' : selectedCatalog.authClass === 'key' ? 'Continue to enter the provider’s API key securely.' : 'This MCP does not require a sign-in.'}</p>{#if !canConnect}<p class="muted">Connecting apps requires company admin access and an available connection flow.</p>{/if}{/if}
    {#if actionError}<p class="notice" role="alert">{actionError}</p>{/if}
    {#if busy}<p role="status">{selectedCatalog?.authClass === 'oauth' ? 'Waiting for browser sign-in…' : 'Updating connection…'}</p>{/if}
    <footer>{#if current && configurable.includes(current.id) && onconfigure}<button disabled={busy} onclick={() => { const id = current!.id; close(); onconfigure?.(id); }}>Connection settings</button>{/if}{#if busy && selectedCatalog?.authClass === "oauth" && oncancel}<button onclick={oncancel}>Cancel sign-in check</button>{/if}<button disabled={busy} onclick={close}>{browsing ? 'Back to apps' : 'Done'}</button>
      {#if current?.canToggle && ontoggle}<button disabled={busy} class:primary={!current.enabled} onclick={() => { if (current.enabled && !confirmation) confirmation = true; else void act(() => ontoggle!(current.id, !current.enabled)); }}>{busy ? 'Saving…' : current.enabled ? confirmation ? 'Confirm removal' : 'Remove bot access' : 'Add to bot'}</button>
      {:else if selectedCatalog}<button class="primary" disabled={busy || !canConnect || !onconnect} onclick={() => void connect(selectedCatalog!)}>{busy ? 'Connecting…' : selectedCatalog.authClass === 'key' ? 'Continue with API key' : 'Connect app'}</button>{/if}
    </footer>
  </div></div>
{/if}
<style>
  .apps { display:grid; gap:8px; container-type:inline-size; }
  h3,h4,p { margin:0; } h3 { font:italic 400 24px/1.3 Georgia,serif; } h4,strong { font-weight:500; } p { line-height:1.6; }
  button,input { font:inherit; color:var(--v4-text-1); }
  button { display:inline-flex; align-items:center; justify-content:center; gap:6px; cursor:pointer; background:transparent; border:1px solid var(--v4-control-border,var(--line)); border-radius:8px; padding:7px 10px; }
  button:hover:not(:disabled) { background:var(--v4-hover); } button:disabled { opacity:.45; cursor:default; }
  .primary { background:var(--v4-primary-bg); color:var(--v4-primary-fg); }
  button.primary:hover:not(:disabled) { background:var(--v4-primary-bg); color:var(--v4-primary-fg); opacity:.9; }
  button:focus-visible { outline:2px solid var(--v4-text-2); outline-offset:3px; }
  .section-head { display:flex; align-items:center; gap:6px; } .section-head > div { flex:1; min-width:0; }
  .toolbar { display:flex; align-items:center; flex-wrap:wrap; gap:6px; }
  .toolbar .search { flex:1 1 130px; min-width:100px; }
  .count { white-space:nowrap; }
  .browse-button { font-size:12px; min-height:var(--hq-btn-h); white-space:nowrap; }
  .icon-button { width:32px; height:var(--hq-btn-h); padding:6px; flex:none; }
  .view-toggle { display:flex; gap:2px; padding:2px; border:1px solid var(--v4-control-border,var(--line)); border-radius:8px; }
  .view-toggle .icon-button { width:26px; height:26px; border:0; border-radius:5px; }
  .view-toggle .active { background:var(--v4-hover); color:var(--v4-text-1); box-shadow:0 1px 3px rgb(0 0 0/.12); }
  .view-toggle svg { width:16px; height:16px; fill:none; stroke:currentColor; stroke-width:1.5; stroke-linecap:round; }
  .muted,.manage { color:var(--v4-text-3); font-size:12px; line-height:1.5; }
  .search { display:flex; gap:6px; align-items:center; border:1px solid var(--v4-control-border,var(--line)); border-radius:8px; padding:6px 9px; box-sizing:border-box; min-height:var(--hq-btn-h); }
  .search:focus-within { border-color:var(--v4-text-3); }
  .search input,.search input:focus,.search input:focus-visible { outline:none; box-shadow:none; background:none; border:0; min-width:0; width:100%; font-size:12px; }
  .logo { display:inline-flex; flex:none; }
  .app-results { display:grid; gap:6px; }
  .app-results.grid-view { grid-template-columns:repeat(auto-fill,minmax(min(190px,100%),1fr)); }
  .app-card { width:100%; min-width:0; text-align:left; justify-content:flex-start; padding:10px; gap:10px; border-radius:10px; background:color-mix(in srgb,var(--v4-text-1) 2%,transparent); }
  .app-content { display:grid; flex:1; gap:4px; min-width:0; }
  .app-content strong { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:13px; }
  .status { display:flex; align-items:center; flex-wrap:wrap; gap:5px; color:var(--v4-text-3); font-size:11px; }
  .status i { flex:none; width:5px; height:5px; border-radius:50%; background:var(--v4-text-3); }
  .status i.ready { background:var(--v4-ok); }.status i.attention { background:var(--v4-error); }
  .grid-view .manage { display:none; }
  .notice { padding:14px; border:1px solid var(--v4-rowline,var(--line)); border-radius:10px; }
  .overlay { position:fixed; inset:0; z-index:10030; display:grid; place-items:center; padding:16px; background:rgb(0 0 0/.55); }
  .dialog { box-sizing:border-box; width:min(480px,100%); max-height:calc(100dvh - 32px); overflow:auto; padding:24px; border:1px solid var(--v4-control-border,var(--line)); border-radius:20px; background:var(--v4-secondary-sidebar,var(--side-bg,#191919)); }
  header { display:flex; align-items:center; gap:12px; margin-bottom:16px; } header > div { flex:1; min-width:0; } h3 { overflow-wrap:anywhere; }
  .dialog > p + p { margin-top:12px; } footer { display:flex; flex-wrap:wrap; gap:8px; justify-content:flex-end; margin-top:20px; }
  .catalog-dialog { width:min(820px,100%); display:flex; flex-direction:column; overflow:hidden; }
  .catalog-search { flex:none; margin-bottom:16px; } .catalog-search button { padding:5px 10px; font-size:12px; }
  .browse-error { flex:none; margin-bottom:12px; }
  .catalog-results { overflow:auto; min-height:0; padding:2px; }
  .catalog-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(min(220px,100%),1fr)); gap:10px; }
  .catalog-card { display:flex; flex-direction:column; align-items:flex-start; padding:12px; border:1px solid var(--v4-control-border,var(--line)); border-radius:12px; gap:10px; min-width:0; }
  .catalog-identity { display:flex; align-items:center; gap:10px; min-width:0; overflow-wrap:anywhere; }
  .card-title { border:0; padding:0; background:transparent; text-align:left; justify-content:flex-start; } .card-title:hover:not(:disabled) { background:transparent; text-decoration:underline; }
  .card-action { margin-top:auto; font-size:12px; padding:5px 10px; }
  .catalog-group { display:grid; gap:10px; } .catalog-group + .catalog-group { margin-top:18px; }
  .group-head { display:grid; gap:2px; }
  @container(max-width:420px) { .toolbar .search { flex-basis:calc(100% - 140px); } }
  @media(max-width:480px) { .dialog { padding:16px; } }
</style>
