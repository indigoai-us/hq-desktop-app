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
    type V4CompanyPrimaryId,
    type V4NavId,
    type V4Route,
  } from './model';
  import BrandLogoSlot from '../../lib/BrandLogoSlot.svelte';
  import type { CachedBrand } from '../../lib/brand';
  import './tokens.css';

  /**
   * V2 primary sidebar (hq-desktop-v2 US-001): translucent 220px chrome.
   * WORKSPACE label + workspace switcher placeholder (avatar + chevron — the
   * full switcher lands in US-002) → the active workspace's sections
   * (Overview / Goals / Projects / Skills / Workers / Knowledge / Team) →
   * GENERAL group (Inbox with unread badge / Messages / Meetings / Library /
   * Files) → footer user card (name + email) that opens Settings.
   *
   * Per-company rows and the standalone sidebar Settings entry are gone. The
   * legacy V4Sidebar stays as an unmounted component (DesktopStatusBar
   * precedent) until US-002 finishes the IA move.
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
  }

  let {
    route,
    companies,
    accountLabel,
    accountEmail = null,
    brand = null,
    onnavigate,
  }: Props = $props();

  let fetched = $state<Workspace[]>([]);
  // An explicitly supplied empty list is authoritative: it represents the
  // parent's hydrated empty/error state. Only an omitted value may self-load.
  const model = $derived(getV2SidebarModel(route, companies ?? fetched));

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

  function go(kind: V4NavId | 'settings') {
    onnavigate?.({ kind });
  }

  function goSection(section: V4CompanyPrimaryId) {
    if (!model.workspace) return;
    onnavigate?.({ kind: 'company', slug: model.workspace.slug, tab: section });
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

  <!-- Workspace switcher placeholder — full switcher is US-002. -->
  <button
    type="button"
    class="v2-switcher"
    data-testid="v2-workspace-switcher"
    aria-labelledby="v2-workspace-label"
    aria-haspopup="menu"
    aria-expanded="false"
    onclick={() => {
      if (model.workspace) onnavigate?.({ kind: 'company', slug: model.workspace.slug });
    }}
  >
    <span class="v2-avatar" aria-hidden="true">{workspaceInitial}</span>
    <span class="v2-switcher-name">{model.workspace?.label ?? 'No workspace'}</span>
    <svg class="v2-chevron" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="m4.5 6.25 3.5 3.5 3.5-3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  </button>

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

  .v2-switcher {
    display: flex;
    align-items: center;
    gap: 8px;
    box-sizing: border-box;
    width: 100%;
    flex: 0 0 auto;
    margin: 0 0 12px;
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

  .v2-switcher:hover {
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
