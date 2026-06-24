<script lang="ts">
  import { onMount } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { listen, type UnlistenFn } from '@tauri-apps/api/event';
  import {
    shortSource,
    type PackagesView,
    type InstalledPack,
    type AvailablePack,
    type PackagesProgress,
    type PackagesDone,
  } from '../lib/packages';

  // Inline-popover mode: App.svelte hands in an `onback` callback and the
  // PackagesApp renders inside the main popover instead of a standalone
  // window. Without `onback` the component still works as a standalone
  // window root (the legacy mount path under packages/main.ts).
  interface Props {
    onback?: () => void;
  }
  let { onback }: Props = $props();

  let view = $state<PackagesView | null>(null);
  let loading = $state(true);
  let busy = $state<{ op: string; name: string } | null>(null);
  let logLines = $state<string[]>([]);
  let errorMsg = $state<string | null>(null);
  let confirmUninstall = $state<string | null>(null);

  const installed = $derived(view?.packs?.installed ?? []);
  const available = $derived(view?.packs?.available ?? []);
  const registryAvailable = $derived(view?.registry?.available ?? []);
  const updatesCount = $derived(installed.filter((p) => p.updateAvailable).length);

  async function refresh() {
    try {
      view = await invoke<PackagesView>('list_packages');
      errorMsg = view?.error ?? null;
    } catch (e) {
      errorMsg = String(e);
    }
  }

  async function install(source: string, registry = false) {
    busy = { op: 'install', name: shortSource(source) };
    logLines = [];
    errorMsg = null;
    try {
      await invoke('install_package', { source, registry });
    } catch (e) {
      errorMsg = String(e);
      busy = null;
    }
  }

  async function update(name: string) {
    busy = { op: 'update', name };
    logLines = [];
    errorMsg = null;
    try {
      await invoke('update_package', { name });
    } catch (e) {
      errorMsg = String(e);
      busy = null;
    }
  }

  async function uninstall(name: string) {
    confirmUninstall = null;
    busy = { op: 'uninstall', name };
    logLines = [];
    errorMsg = null;
    try {
      await invoke('uninstall_package', { name });
      logLines = [`Uninstalled ${name}.`];
      await refresh();
    } catch (e) {
      errorMsg = String(e);
    } finally {
      busy = null;
    }
  }

  function checkUpdates() {
    invoke('check_package_updates').catch(() => {});
  }

  onMount(() => {
    const unlisteners: UnlistenFn[] = [];
    (async () => {
      unlisteners.push(
        await listen<PackagesProgress>('packages:progress', (e) => {
          logLines = [...logLines.slice(-200), e.payload.line];
        }),
      );
      unlisteners.push(
        await listen<PackagesDone>('packages:complete', async () => {
          busy = null;
          await refresh();
        }),
      );
      unlisteners.push(
        await listen<PackagesDone>('packages:error', (e) => {
          errorMsg = e.payload.message ?? 'Operation failed';
          busy = null;
        }),
      );
      unlisteners.push(
        await listen<PackagesView>('packages:updates', (e) => {
          view = e.payload;
        }),
      );

      // Ready handshake: get the stashed snapshot, else cold-load.
      try {
        const initial = await invoke<PackagesView | null>('packages_window_ready');
        if (initial) {
          view = initial;
          errorMsg = initial.error ?? null;
        } else {
          await refresh();
        }
      } catch {
        await refresh();
      }
      loading = false;
      // Kick off the slower update probe in the background.
      checkUpdates();
    })();

    return () => unlisteners.forEach((u) => u());
  });

  function contributeSummary(p: InstalledPack): string {
    const parts = Object.entries(p.contributes).map(([k, n]) => `${n} ${k}`);
    return parts.join(', ') || 'no contributions';
  }

  function isGatedOff(a: AvailablePack): boolean {
    return a.conditionalStatus === 'fail';
  }
</script>

<main>
  <header data-tauri-drag-region>
    {#if onback}
      <button
        type="button"
        class="back"
        title="Back"
        aria-label="Back"
        onclick={() => onback?.()}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
        >
          <path
            d="M10 3.5 5.5 8l4.5 4.5"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>
    {/if}
    <h1>Packages</h1>
    {#if updatesCount > 0}
      <span class="badge">{updatesCount} update{updatesCount === 1 ? '' : 's'}</span>
    {/if}
    <button class="ghost" onclick={refresh} disabled={!!busy}>Refresh</button>
    {#if !onback}
      <!-- Chrome-less standalone window: in-content close affordance.
           Hidden when inline (App.svelte's back arrow handles return). -->
      <button
        type="button"
        class="close"
        title="Close"
        aria-label="Close"
        onclick={() => import('@tauri-apps/api/window').then(m => m.getCurrentWindow().close())}
      >
        &times;
      </button>
    {/if}
  </header>

  {#if loading}
    <p class="muted pad">Loading packages…</p>
  {:else}
    {#if errorMsg}
      <div class="error">{errorMsg}</div>
    {/if}

    {#if busy}
      <section class="op">
        <div class="op-head">
          <span class="spinner"></span>
          {busy.op === 'install' ? 'Installing' : busy.op === 'update' ? 'Updating' : 'Uninstalling'}
          <strong>{busy.name}</strong>…
        </div>
        {#if logLines.length}
          <pre class="log">{logLines.join('\n')}</pre>
        {/if}
      </section>
    {/if}

    <section>
      <h2>Installed</h2>
      {#if installed.length === 0}
        <p class="muted">No packs installed yet.</p>
      {/if}
      {#each installed as p (p.name)}
        <div class="row">
          <div class="row-main">
            <div class="row-title">
              {p.name}
              {#if p.version}<span class="ver">v{p.version}</span>{/if}
              {#if p.updateAvailable}<span class="badge">update</span>{/if}
              {#if p.hqCoreSatisfied === false}<span class="warn">needs HQ {p.requiresHqCore}</span>{/if}
              {#if p.links.broken > 0}<span class="warn">{p.links.broken} broken link{p.links.broken === 1 ? '' : 's'}</span>{/if}
            </div>
            <div class="row-sub muted">
              {#if p.error}{p.error}{:else}{contributeSummary(p)}{/if}
            </div>
          </div>
          <div class="row-actions">
            {#if p.updateAvailable}
              <button class="primary" onclick={() => update(p.name)} disabled={!!busy}>Update</button>
            {/if}
            <button class="danger" onclick={() => (confirmUninstall = p.name)} disabled={!!busy}>Uninstall</button>
          </div>
        </div>
        {#if confirmUninstall === p.name}
          <div class="confirm">
            Remove <strong>{p.name}</strong> and its host links?
            <button class="danger" onclick={() => uninstall(p.name)}>Remove</button>
            <button class="ghost" onclick={() => (confirmUninstall = null)}>Cancel</button>
          </div>
        {/if}
      {/each}
    </section>

    <section>
      <h2>Available</h2>
      {#if available.length === 0 && registryAvailable.length === 0}
        <p class="muted">Everything in the catalog is installed.</p>
      {/if}
      {#each available as a (a.source)}
        <div class="row">
          <div class="row-main">
            <div class="row-title">
              {shortSource(a.source)}
              {#if isGatedOff(a)}<span class="muted small">(gated off)</span>{/if}
            </div>
            {#if a.description}<div class="row-sub muted">{a.description}</div>{/if}
          </div>
          <div class="row-actions">
            <button class="primary" onclick={() => install(a.source, false)} disabled={!!busy}>Install</button>
          </div>
        </div>
      {/each}
      {#each registryAvailable as r (r.slug)}
        <div class="row">
          <div class="row-main">
            <div class="row-title">{r.slug}{#if r.tier}<span class="muted small"> · {r.tier}</span>{/if}</div>
            <div class="row-sub muted">Registry package</div>
          </div>
          <div class="row-actions">
            <button class="primary" onclick={() => install(r.slug, true)} disabled={!!busy}>Install</button>
          </div>
        </div>
      {/each}
    </section>

    {#if view?.registry?.offline}
      <p class="muted small pad">Registry offline — showing local data only.</p>
    {/if}
  {/if}
</main>

<style>
  /* Keep the window chrome transparent so the Rust-side Mica/Acrylic vibrancy
     (apply_windows_vibrancy) shows through — same pattern as the other Windows
     secondary windows (NotificationHistory / MeetingPermissionsWindow). The
     `main` root below carries a translucent solid-background fallback for when
     vibrancy is unavailable (Win Server SKUs, third-party shells). The label is
     set on both html + body in main.ts so this scope can't bleed across
     windows. */
  :global(html[data-window='packages']),
  :global(body[data-window='packages']) {
    margin: 0;
    height: 100%;
    background: transparent;
  }
  main {
    display: flex;
    flex-direction: column;
    height: 100vh;
    /* Match the OS DWMWCP_ROUNDSMALL (~4 px) set in main.rs. */
    border-radius: 4px;
    overflow-x: hidden;
    overflow-y: auto;
    color: var(--popover-text, #e8e8ea);
    font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, sans-serif;
    font-size: 13px;
    /* Use the popover background token so Mica shows through consistently
       across all inline screens (Settings, NotificationHistory, DmDetail,
       Packages). The `prefers-reduced-transparency` media query already
       swaps this for an opaque fallback when Mica is unavailable. */
    background: var(--popover-bg, rgba(18, 18, 20, 0.68));
    backdrop-filter: var(--popover-blur, blur(28px) saturate(1.45));
    -webkit-backdrop-filter: var(--popover-blur, blur(28px) saturate(1.45));
  }
  header {
    position: sticky;
    top: 0;
    display: flex;
    align-items: center;
    gap: 10px;
    /* Matches Settings.svelte / NotificationHistory header padding so
       the three in-popover sibling screens read at the same height.
       The original 28 px top was room for a standalone-window drag
       region — unnecessary inline. */
    padding: 10px 16px;
    background: rgba(12, 12, 13, 0.6);
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    backdrop-filter: blur(8px);
  }
  h1 { font-size: 15px; margin: 0; flex: 1; font-weight: 600; }
  h2 {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #8a8a90;
    margin: 18px 16px 8px;
  }
  section.op { margin: 12px 16px 0; }
  .op-head { display: flex; align-items: center; gap: 8px; color: #c8c8cc; }
  .log {
    margin: 8px 0 0;
    padding: 8px 10px;
    background: rgba(0, 0, 0, 0.35);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 6px;
    max-height: 160px;
    overflow-y: auto;
    font-size: 11px;
    color: #9a9aa0;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 16px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.05);
  }
  .row-main { flex: 1; min-width: 0; }
  .row-title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-weight: 500; }
  .row-sub { margin-top: 2px; overflow: hidden; text-overflow: ellipsis; }
  .row-actions { display: flex; gap: 6px; flex-shrink: 0; }
  .ver { color: #8a8a90; font-weight: 400; }
  .muted { color: #8a8a90; }
  .small { font-size: 11px; }
  .pad { padding: 12px 16px; }
  .badge {
    background: rgba(255, 255, 255, 0.12); color: #d8d8dc;
    border-radius: 999px; padding: 1px 8px; font-size: 11px;
  }
  .warn { color: #e0a23c; font-size: 11px; }
  .error {
    margin: 12px 16px 0; padding: 8px 12px;
    background: rgba(74, 32, 32, 0.6); border: 1px solid #4a2020; border-radius: 6px;
    color: #f0b0b0; font-size: 12px;
  }
  .confirm {
    display: flex; align-items: center; gap: 8px;
    padding: 8px 16px; background: rgba(255, 255, 255, 0.04); font-size: 12px;
  }
  button {
    border: 1px solid rgba(255, 255, 255, 0.16); background: rgba(255, 255, 255, 0.04); color: #e8e8ea;
    border-radius: 6px; padding: 4px 12px; font-size: 12px; cursor: pointer;
  }
  button:hover:not(:disabled) { background: rgba(255, 255, 255, 0.1); }
  button:disabled { opacity: 0.4; cursor: default; }
  button.primary { background: #e8e8ea; color: #0c0c0d; border-color: #e8e8ea; }
  button.danger { color: #e08c8c; border-color: #4a2424; }
  button.ghost { background: transparent; }
  /* In-content close — chrome-less window provides no system X.
     Square 22px hit target, Win11-style hover-emphasis (rgba red on hover). */
  button.close {
    background: transparent; border-color: transparent; color: #c9c9cf;
    width: 22px; height: 22px; padding: 0; font-size: 16px; line-height: 1;
    -webkit-app-region: no-drag;
  }
  button.close:hover { background: rgba(232, 17, 35, 0.85); color: #ffffff; }
  /* Back chevron — same outlined-icon-button look as the sibling
     in-popover screens (NotificationHistory, Settings, DmDetail). Only
     rendered when `onback` is wired (inline mode). */
  button.back {
    background: transparent; border: 1px solid rgba(255, 255, 255, 0.16);
    color: #c9c9cf; border-radius: 7px; width: 26px; height: 26px;
    padding: 0; display: inline-flex; align-items: center; justify-content: center;
    -webkit-app-region: no-drag;
  }
  button.back:hover { background: rgba(255, 255, 255, 0.08); color: #ffffff; }
  .spinner {
    width: 12px; height: 12px; border-radius: 50%;
    border: 2px solid rgba(255, 255, 255, 0.2); border-top-color: #e8e8ea;
    animation: spin 0.7s linear infinite; display: inline-block;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
