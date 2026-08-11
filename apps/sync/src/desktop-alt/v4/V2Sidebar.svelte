<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import { listen } from '@tauri-apps/api/event';
  import { safeUnlisten } from '../../lib/listener-registry';
  import { onMount } from 'svelte';
  import type { Workspace, WorkspacesResult } from '../../lib/workspaces';
  import {
    loadNotificationItems,
    getLastReadTs,
    countUnread,
    NOTIFICATION_UNREAD_COUNT_EVENT,
  } from '../../lib/notificationFeedData';
  import {
    getV2SidebarModel,
    getV2WorkspaceSwitcherItems,
    type V4CompanyPrimaryId,
    type V4NavId,
    type V4Route,
  } from './model';
  import BrandLogoSlot from '../../lib/BrandLogoSlot.svelte';
  import type { CachedBrand } from '../../lib/brand';
  import './tokens.css';

  /**
   * V2 primary sidebar (hq-desktop-v2 US-001 + US-002): translucent 220px
   * chrome. WORKSPACE label + workspace switcher dropdown → the active
   * workspace's sections (Overview / Goals / Projects / Skills / Workers /
   * Knowledge / Team) → GENERAL group (Inbox with unread badge / Messages /
   * Meetings / Library / Files) → footer user card (name + email) that opens
   * Settings.
   *
   * Per-company rows and the standalone sidebar Settings entry are gone. The
   * legacy V4Sidebar stays as an unmounted component (DesktopStatusBar
   * precedent).
   */

  interface Props {
    route: V4Route;
    companies?: Workspace[] | null;
    /** Signed-in display name for the footer user card. */
    accountLabel?: string | null;
    /** Signed-in email for the footer user card (null while unresolved). */
    accountEmail?: string | null;
    /** Active white-label brand; null → HQ defaults. */
    brand?: CachedBrand | null;
    onnavigate?: (route: V4Route) => void;
    /** "+ Add a workspace" footer — shell resolves the destination route. */
    onaddworkspace?: () => void;
  }

  let {
    route,
    companies,
    accountLabel,
    accountEmail = null,
    brand = null,
    onnavigate,
    onaddworkspace,
  }: Props = $props();

  let fetched = $state<Workspace[]>([]);
  let switcherOpen = $state(false);
  let switcherRoot: HTMLDivElement | null = $state(null);
  // An explicitly supplied empty list is authoritative: it represents the
  // parent's hydrated empty/error state. Only an omitted value may self-load.
  const liveWorkspaces = $derived(companies ?? fetched);
  const model = $derived(getV2SidebarModel(route, liveWorkspaces));
  const activeSwitcherSlug = $derived(
    route.kind === 'company' ? (route.slug ?? null) : (model.workspace?.slug ?? null),
  );
  const switcherItems = $derived(
    getV2WorkspaceSwitcherItems(liveWorkspaces, activeSwitcherSlug),
  );

  onMount(() => {
    if (companies != null) return;
    void invoke<WorkspacesResult>('list_syncable_workspaces')
      .then((result) => {
        fetched = Array.isArray(result.workspaces) ? result.workspaces : [];
      })
      .catch((err) => {
        console.error('list_syncable_workspaces failed:', err);
      });
  });

  let notifUnread = $state(0);
  let unreadLoadGeneration = 0;

  async function refreshUnread() {
    const generation = ++unreadLoadGeneration;
    try {
      const items = await loadNotificationItems();
      if (generation !== unreadLoadGeneration) return;
      notifUnread = countUnread(items, getLastReadTs());
    } catch {
      if (generation !== unreadLoadGeneration) return;
      notifUnread = 0;
    }
  }

  $effect(() => {
    const onread = () => void refreshUnread();
    const oncount = (event: Event) => {
      const count = (event as CustomEvent<unknown>).detail;
      if (typeof count === 'number' && Number.isFinite(count)) {
        notifUnread = Math.max(0, Math.round(count));
      }
    };
    window.addEventListener('hq:notifications-read', onread);
    window.addEventListener(NOTIFICATION_UNREAD_COUNT_EVENT, oncount);

    let disposed = false;
    const unlisteners: Array<() => void> = [];
    const track = (unlisten: () => void) => {
      const safe = safeUnlisten(unlisten);
      if (disposed) safe();
      else unlisteners.push(safe);
    };
    // Hydrate only after every native listener has settled (see V4Sidebar).
    void Promise.allSettled([
      listen('dm:unread-summary', onread).then(track),
      listen('sync:complete', onread).then(track),
      listen('update:available', onread).then(track),
      listen('update:cleared', onread).then(track),
    ]).then(() => {
      if (!disposed) void refreshUnread();
    });

    return () => {
      disposed = true;
      unreadLoadGeneration += 1;
      window.removeEventListener('hq:notifications-read', onread);
      window.removeEventListener(NOTIFICATION_UNREAD_COUNT_EVENT, oncount);
      for (const u of unlisteners) u();
    };
  });

  // Close the switcher menu on Escape or click outside while open.
  $effect(() => {
    if (!switcherOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        switcherOpen = false;
      }
    };
    const onPointer = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (switcherRoot && !switcherRoot.contains(target)) {
        switcherOpen = false;
      }
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onPointer);
    };
  });

  function go(kind: V4NavId | 'settings') {
    onnavigate?.({ kind });
  }

  function goSection(section: V4CompanyPrimaryId) {
    if (!model.workspace) return;
    onnavigate?.({ kind: 'company', slug: model.workspace.slug, tab: section });
  }

  function toggleSwitcher() {
    switcherOpen = !switcherOpen;
  }

  function selectWorkspace(slug: string) {
    switcherOpen = false;
    onnavigate?.({ kind: 'company', slug });
  }

  function addWorkspace() {
    switcherOpen = false;
    onaddworkspace?.();
  }

  const workspaceInitial = $derived(
    (model.workspace?.label ?? 'HQ').trim().slice(0, 1).toUpperCase() || 'H',
  );
</script>

<aside class="v2-sidebar" aria-label="Primary navigation">
  <div class="v2-logo-slot" data-tauri-drag-region>
    <BrandLogoSlot
      brand={brand}
      brandingEnabled={brand?.brandingEnabled ?? false}
      size="desktop"
      companyName={brand?.companySlug ?? null}
    />
  </div>

  <div class="v2-section-label" id="v2-workspace-label">Workspace</div>

  <div class="v2-switcher-wrap" bind:this={switcherRoot}>
    <button
      type="button"
      class="v2-switcher"
      data-testid="v2-workspace-switcher"
      aria-labelledby="v2-workspace-label"
      aria-haspopup="menu"
      aria-expanded={switcherOpen}
      onclick={toggleSwitcher}
    >
      <span class="v2-avatar" aria-hidden="true">{workspaceInitial}</span>
      <span class="v2-switcher-name">{model.workspace?.label ?? 'No workspace'}</span>
      <svg class="v2-chevron" class:open={switcherOpen} viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="m4.5 6.25 3.5 3.5 3.5-3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>

    {#if switcherOpen}
      <div class="v2-switcher-menu" data-testid="v2-workspace-menu" role="menu" aria-label="Workspaces">
        {#each switcherItems as item (item.slug)}
          <button
            type="button"
            class="v2-switcher-item"
            class:active={item.active}
            role="menuitem"
            data-testid={`v2-workspace-option-${item.slug}`}
            onclick={() => selectWorkspace(item.slug)}
          >
            <span class="v2-dot" data-tone={item.tone} aria-hidden="true"></span>
            <span class="v2-switcher-item-body">
              <span class="v2-switcher-item-label">{item.label}</span>
              {#if item.syncAgeLabel}
                <span class="v2-switcher-item-age">{item.syncAgeLabel}</span>
              {/if}
            </span>
            {#if item.hotkey}
              <span class="v2-hotkey" aria-hidden="true">{item.hotkey}</span>
            {/if}
          </button>
        {/each}
        <button
          type="button"
          class="v2-switcher-item v2-switcher-add"
          role="menuitem"
          data-testid="v2-add-workspace"
          onclick={addWorkspace}
        >
          <span class="v2-switcher-item-label">+ Add a workspace</span>
        </button>
      </div>
    {/if}
  </div>

  {#if model.workspace}
    <nav class="v2-nav" aria-label="Workspace sections" data-testid="v2-workspace-sections">
      {#each model.sections as row (row.id)}
        <button
          type="button"
          class="v2-row"
          class:active={row.active}
          aria-current={row.active ? 'page' : undefined}
          onclick={() => goSection(row.id)}
        >
          <span class="v2-row-label">{row.label}</span>
        </button>
      {/each}
    </nav>
  {/if}

  <div class="v2-section-label v2-general-label" id="v2-general-label">General</div>
  <nav class="v2-nav" aria-labelledby="v2-general-label" data-testid="v2-general-nav">
    {#each model.general as row (row.id)}
      <button
        type="button"
        class="v2-row"
        class:active={row.active}
        aria-current={row.active ? 'page' : undefined}
        onclick={() => go(row.id)}
      >
        <span class="v2-row-label">{row.label}</span>
        {#if row.id === 'inbox' && notifUnread > 0}
          <span class="v2-unread-badge" aria-label={`${notifUnread} unread`}>
            {notifUnread > 99 ? '99+' : notifUnread}
          </span>
        {/if}
      </button>
    {/each}
  </nav>

  <div class="v2-spacer"></div>

  <!-- Footer user card — the only route into Settings from the sidebar. -->
  <button
    type="button"
    class="v2-user-card"
    data-testid="v2-user-card"
    class:active={model.settingsActive}
    aria-current={model.settingsActive ? 'page' : undefined}
    aria-label="Open settings"
    onclick={() => go('settings')}
  >
    <span class="v2-user-name">{accountLabel ?? 'Signed in'}</span>
    {#if accountEmail}
      <span class="v2-user-email">{accountEmail}</span>
    {/if}
  </button>
</aside>

<style>
  .v2-sidebar {
    display: flex;
    flex-direction: column;
    flex: 0 0 220px;
    width: 220px;
    min-height: 0;
    height: 100%;
    overflow-y: auto;
    padding: 14px 10px 0;
    border-right: 1px solid var(--v4-hairline);
    background: var(--v2-sidebar, var(--v4-sidebar, var(--v4-chrome)));
    backdrop-filter: var(--v4-glass-filter);
    -webkit-backdrop-filter: var(--v4-glass-filter);
    box-shadow: inset 1px 0 0 var(--v4-glass-highlight);
    font-family: var(--font-sans);
    scrollbar-width: thin;
    scrollbar-color: var(--v4-hairline) transparent;
  }

  .v2-logo-slot {
    flex: 0 0 auto;
    margin: 0 0 12px;
    padding: 0 8px;
    min-height: 22px;
  }

  .v2-section-label {
    flex: 0 0 auto;
    margin: 0 0 6px;
    padding: 0 8px;
    color: var(--v4-text-3);
    font-size: var(--type-secondary, var(--text-xs));
    font-weight: 400;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .v2-general-label {
    margin-top: 18px;
  }

  .v2-switcher-wrap {
    position: relative;
    flex: 0 0 auto;
    margin: 0 0 12px;
  }

  .v2-switcher {
    display: flex;
    align-items: center;
    gap: 8px;
    box-sizing: border-box;
    width: 100%;
    flex: 0 0 auto;
    margin: 0;
    padding: 6px 8px;
    border: 1px solid transparent;
    border-radius: var(--v4-radius-button);
    background: transparent;
    color: var(--v4-text-1);
    font: inherit;
    font-size: var(--type-body, var(--text-base));
    font-weight: 500;
    text-align: left;
    cursor: pointer;
  }

  .v2-switcher:hover,
  .v2-switcher[aria-expanded='true'] {
    border-color: var(--v4-hairline);
    background: var(--v4-control-faint);
  }

  .v2-switcher:focus-visible {
    outline: 2px solid var(--v4-focus-ring, var(--v4-control-border));
    outline-offset: -2px;
  }

  .v2-avatar {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 22px;
    width: 22px;
    height: 22px;
    border-radius: var(--v4-radius-button);
    background: var(--v4-primary-bg);
    color: var(--v4-primary-fg);
    font-size: var(--type-metadata, 12px);
    font-weight: 600;
    line-height: 1;
  }

  .v2-switcher-name {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .v2-chevron {
    flex: 0 0 auto;
    width: 14px;
    height: 14px;
    color: var(--v4-text-3);
    transition: transform 120ms ease;
  }

  .v2-chevron.open {
    transform: rotate(180deg);
  }

  .v2-switcher-menu {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    right: 0;
    z-index: 40;
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-height: min(320px, 60vh);
    overflow-y: auto;
    padding: 6px;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-button);
    background: var(--v4-chrome, var(--v4-sidebar));
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
    scrollbar-width: thin;
    scrollbar-color: var(--v4-hairline) transparent;
  }

  .v2-switcher-item {
    display: flex;
    align-items: center;
    gap: 8px;
    box-sizing: border-box;
    width: 100%;
    min-height: var(--v4-row-h);
    padding: 6px 8px;
    border: none;
    border-radius: var(--v4-radius-button);
    background: transparent;
    color: var(--v4-text-2);
    font: inherit;
    font-size: var(--type-body, var(--text-base));
    font-weight: 400;
    text-align: left;
    cursor: pointer;
  }

  .v2-switcher-item:hover,
  .v2-switcher-item.active {
    background: var(--v4-active-row);
    color: var(--v4-text-1);
  }

  .v2-switcher-item:focus-visible {
    outline: 2px solid var(--v4-focus-ring, var(--v4-control-border));
    outline-offset: -2px;
    background: var(--v4-active-row);
    color: var(--v4-text-1);
  }

  .v2-switcher-item.active {
    font-weight: 500;
  }

  .v2-dot {
    flex: 0 0 6px;
    width: 6px;
    height: 6px;
    border-radius: 999px;
    background: var(--v4-idle);
  }

  .v2-dot[data-tone='ok'] {
    background: var(--v4-ok);
  }

  .v2-dot[data-tone='warn'] {
    background: var(--v4-warn);
  }

  .v2-dot[data-tone='error'] {
    background: var(--v4-error);
  }

  .v2-dot[data-tone='idle'] {
    background: var(--v4-idle);
  }

  .v2-switcher-item-body {
    display: flex;
    flex-direction: column;
    gap: 1px;
    flex: 1 1 auto;
    min-width: 0;
  }

  .v2-switcher-item-label {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .v2-switcher-item-age {
    color: var(--v4-text-3);
    font-size: var(--type-metadata, var(--text-xs));
    line-height: 1.2;
  }

  .v2-hotkey {
    flex: 0 0 auto;
    margin-left: auto;
    color: var(--v4-text-3);
    font-size: var(--type-metadata, var(--text-xs));
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.02em;
  }

  .v2-switcher-add {
    margin-top: 2px;
    border-top: 1px solid var(--v4-hairline);
    border-radius: 0 0 var(--v4-radius-button) var(--v4-radius-button);
    color: var(--v4-text-2);
    font-weight: 500;
  }

  .v2-nav {
    display: flex;
    flex-direction: column;
    flex: 0 0 auto;
    gap: var(--v4-row-gap);
  }

  .v2-row {
    display: flex;
    align-items: center;
    gap: 8px;
    box-sizing: border-box;
    width: 100%;
    height: var(--v4-row-h);
    min-height: var(--v4-row-h);
    max-height: var(--v4-row-h);
    flex: 0 0 auto;
    padding: 0 8px;
    border: none;
    border-radius: var(--v4-radius-button);
    background: transparent;
    color: var(--v4-text-2);
    font: inherit;
    font-size: var(--type-body, var(--text-base));
    font-weight: 400;
    line-height: 1;
    text-align: left;
    cursor: pointer;
  }

  .v2-row:hover {
    background: var(--v4-control-faint);
    color: var(--v4-text-1);
  }

  .v2-row:focus-visible {
    outline: 2px solid var(--v4-focus-ring, var(--v4-control-border));
    outline-offset: -2px;
    background: var(--v4-active-row);
    color: var(--v4-text-1);
  }

  .v2-row.active {
    background: var(--v4-active-row);
    color: var(--v4-text-1);
    font-weight: 500;
  }

  .v2-row-label {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .v2-unread-badge {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 16px;
    height: 16px;
    padding: 0 5px;
    box-sizing: border-box;
    border-radius: var(--v4-radius-pill);
    background: var(--v4-unread);
    color: var(--v4-primary-fg);
    font-size: var(--type-metadata, 10px);
    font-weight: 700;
    line-height: 1;
  }

  .v2-spacer {
    flex: 1 1 auto;
    min-height: 12px;
  }

  .v2-user-card {
    display: grid;
    grid-template-rows: auto auto;
    gap: var(--v4-row-stack-gap, 3px);
    justify-items: start;
    width: 100%;
    flex: 0 0 auto;
    margin: 0 0 12px;
    padding: 8px;
    border: none;
    border-radius: var(--v4-radius-button);
    background: transparent;
    color: var(--v4-text-2);
    cursor: pointer;
    text-align: left;
    font: inherit;
  }

  .v2-user-card:hover,
  .v2-user-card.active {
    background: var(--v4-active-row);
    color: var(--v4-text-1);
  }

  .v2-user-card:focus-visible {
    outline: 2px solid var(--v4-focus-ring, var(--v4-control-border));
    outline-offset: -4px;
  }

  .v2-user-name {
    color: var(--v4-text-1);
    font-size: var(--type-body, var(--text-base));
    font-weight: 500;
  }

  .v2-user-email {
    overflow: hidden;
    max-width: 100%;
    color: var(--v4-text-3);
    font-size: var(--text-sm);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
