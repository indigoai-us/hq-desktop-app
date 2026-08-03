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
    getV4SidebarModel,
    V4_COMPANY_PRIMARY_ITEMS,
    type V4CompanyPrimaryId,
    type V4NavId,
    type V4Route,
  } from './model';
  import { open as openExternal } from '@tauri-apps/plugin-shell';
  import { HQ_CONSOLE_BASE } from '../lib/hq-console';
  import './tokens.css';

  /**
   * V4 primary sidebar (SPEC section 4 + DESKTOP-001): 220px Liquid Glass
   * chrome, hairline right border. Nav is Inbox / Messages / Meetings /
   * Marketplace / Library / Files (Inbox is notification chronology; Messages
   * is the complete conversation workspace; US-007 removed Home / Mission
   * Control / Companies page rows) →
   * COMPANIES section (selected company expands Overview / Goals / Projects /
   * Knowledge / Team / More inline; children collapse on global destinations)
   * → Settings footer.
   *
   * Pointer reveal waits a short hover-intent delay so sweeping the mouse down
   * the list doesn't mount every control and fan out one get_sync_mode vault
   * round-trip per row. Focus reveals immediately.
   */

  interface Props {
    route: V4Route;
    companies?: Workspace[] | null;
    /** Signed-in account name for the profile footer. */
    accountLabel?: string | null;
    /** Signed-in account email for the profile footer. */
    accountEmail?: string | null;
    /** Monogram for the profile footer avatar circle. */
    accountInitials?: string | null;
    onnavigate?: (route: V4Route) => void;
  }

  let {
    route,
    companies,
    accountLabel,
    accountEmail,
    accountInitials,
    onnavigate,
  }: Props = $props();

  let fetched = $state<Workspace[]>([]);
  // An explicitly supplied empty list is authoritative: it represents the
  // parent's hydrated empty/error state. Only an omitted value may self-load.
  const model = $derived(
    getV4SidebarModel(route, companies ?? fetched),
  );
  // Slack-style workspace switcher: one current workspace at the top of the
  // sidebar; every workspace (personal and companies alike) lives in the
  // switcher menu. The company on the active route is current; on global
  // destinations the last explicit selection persists, else first workspace.
  let lastSelectedSlug = $state<string | null>(null);
  const routeRow = $derived(model.companies.find((row) => row.expanded || row.active) ?? null);
  $effect(() => {
    if (routeRow) lastSelectedSlug = routeRow.slug;
  });
  const currentRow = $derived(
    routeRow ??
      model.companies.find((row) => row.slug === lastSelectedSlug) ??
      model.companies.find((row) => !row.isPersonal) ??
      model.companies[0] ??
      null,
  );
  // The route model only carries children for the expanded company; the
  // sidebar shows the current workspace's sections on global routes too.
  // Menu sections: companies own ⌘1–⌘9 in list order; Personal sits in its
  // own section with the dedicated ⌘0 shortcut.
  const menuCompanies = $derived(model.companies.filter((row) => !row.isPersonal));
  const menuPersonal = $derived(model.companies.filter((row) => row.isPersonal));

  const currentSections = $derived(
    currentRow == null
      ? []
      : currentRow.children.length > 0
        ? currentRow.children
        : V4_COMPANY_PRIMARY_ITEMS.map((item) => ({ ...item, active: false })),
  );

  let switcherOpen = $state(false);
  let switcherButton = $state<HTMLButtonElement | null>(null);
  let menuPos = $state({ top: 0, left: 0 });

  function toggleSwitcher() {
    if (!switcherOpen && switcherButton) {
      const rect = switcherButton.getBoundingClientRect();
      menuPos = { top: rect.bottom + 6, left: rect.left };
    }
    switcherOpen = !switcherOpen;
  }

  function selectWorkspace(slug: string) {
    lastSelectedSlug = slug;
    switcherOpen = false;
    goCompany(slug);
  }

  function addWorkspace() {
    switcherOpen = false;
    void openExternal(HQ_CONSOLE_BASE);
  }

  /** Mount the switcher menu on document.body so the sidebar's overflow and
   *  glass filter can't clip it. */
  function portal(node: HTMLElement) {
    document.body.appendChild(node);
    return { destroy: () => node.remove() };
  }

  const TILE_GRADIENTS = [
    ['#6366f1', '#8b5cf6'],
    ['#0ea5e9', '#6366f1'],
    ['#f59e0b', '#ef4444'],
    ['#10b981', '#0ea5e9'],
    ['#ec4899', '#8b5cf6'],
    ['#475569', '#1e293b'],
  ] as const;

  function tileGradient(slug: string): string {
    let hash = 0;
    for (const ch of slug) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
    const [from, to] = TILE_GRADIENTS[Math.abs(hash) % TILE_GRADIENTS.length];
    return `linear-gradient(135deg, ${from}, ${to})`;
  }

  function workspaceInitials(label: string): string {
    const words = label.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return '?';
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return (words[0][0] + words[1][0]).toUpperCase();
  }

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
    // Hydrate only after every native listener has settled. An event that
    // lands during registration is recovered by this authoritative first
    // refresh instead of falling through a mount gap.
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

  function goCompany(slug: string) {
    onnavigate?.({ kind: 'company', slug });
  }

  function goCompanySection(slug: string, section: V4CompanyPrimaryId) {
    onnavigate?.({ kind: 'company', slug, tab: section });
  }

</script>

<svelte:window
  onkeydown={(event) => {
    if (switcherOpen && event.key === 'Escape') switcherOpen = false;
  }}
/>

<aside class="v4-sidebar" aria-label="Primary navigation">
  {#if currentRow}
    <button
      type="button"
      class="ws-current"
      bind:this={switcherButton}
      aria-haspopup="menu"
      aria-expanded={switcherOpen}
      data-testid="workspace-switcher"
      onclick={toggleSwitcher}
    >
      <span class="ws-tile" style={`background:${tileGradient(currentRow.slug)}`} aria-hidden="true">
        {workspaceInitials(currentRow.label)}
      </span>
      <span class="ws-current-name">{currentRow.label}</span>
      <svg class="ws-chevron" width="10" height="6" viewBox="0 0 10 6" aria-hidden="true">
        <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>
  {/if}

  {#if currentRow}
    <!-- The selected workspace's sections live directly under its switcher —
         they belong to the workspace, app-wide destinations follow below. -->
    <nav
      class="ws-sections"
      data-testid={`company-children-${currentRow.slug}`}
      aria-label={`${currentRow.label} sections`}
    >
      {#each currentSections as child (child.id)}
        <button
          type="button"
          class="v4-row"
          class:active={child.active}
          aria-current={child.active ? 'page' : undefined}
          data-testid={`company-child-${currentRow.slug}-${child.id}`}
          onclick={() => goCompanySection(currentRow.slug, child.id)}
        >
          <span class="v4-row-label">{child.id === 'more' ? 'Operations' : child.label}</span>
        </button>
      {/each}
    </nav>
  {/if}

  <div class="v4-spacer"></div>

  <!-- App-wide destinations live at the bottom, apart from the workspace
       context above: everything under the switcher is about that company. -->
  <div class="ws-divider" aria-hidden="true"></div>

  <nav class="v4-nav" aria-label="Primary">
    {#each model.nav as row (row.id)}
      <button
        type="button"
        class="v4-row"
        class:active={row.active}
        aria-current={row.active ? 'page' : undefined}
        onclick={() => go(row.id)}
      >
        <span class="v4-row-label">{row.label}</span>
        {#if row.id === 'inbox' && notifUnread > 0}
          <span class="v4-unread-badge" aria-label={`${notifUnread} unread`}>
            {notifUnread > 99 ? '99+' : notifUnread}
          </span>
        {/if}
      </button>
    {/each}
  </nav>

  <!-- Profile footer: circle avatar + name + email; opens Settings. -->
  <button
    type="button"
    class="v4-footer"
    class:active={model.settingsActive}
    aria-current={model.settingsActive ? 'page' : undefined}
    aria-label="Settings"
    onclick={() => go('settings')}
  >
    <span class="v4-avatar" aria-hidden="true">{accountInitials ?? 'HQ'}</span>
    <span class="v4-footer-copy">
      <span class="v4-footer-name">{accountLabel ?? 'Account'}</span>
      {#if accountEmail}
        <span class="v4-footer-meta">{accountEmail}</span>
      {/if}
    </span>
  </button>
</aside>

{#if switcherOpen}
  <div class="ws-layer" use:portal>
    <div
      class="ws-backdrop"
      aria-hidden="true"
      onclick={() => (switcherOpen = false)}
    ></div>
    <div
      class="ws-menu"
      role="menu"
      aria-label="Switch workspace"
      style={`top:${menuPos.top}px;left:${menuPos.left}px`}
    >
      {#each menuCompanies as row, index (row.slug)}
        <button
          type="button"
          class="ws-menu-row"
          class:current={currentRow != null && row.slug === currentRow.slug}
          role="menuitem"
          data-testid={`workspace-option-${row.slug}`}
          onclick={() => selectWorkspace(row.slug)}
        >
          <span class="ws-tile menu" style={`background:${tileGradient(row.slug)}`} aria-hidden="true">
            {workspaceInitials(row.label)}
          </span>
          <span class="ws-menu-copy">
            <span class="ws-menu-name">{row.label}</span>
            <span class="ws-menu-meta">
              <span
                class={`ws-status-dot ${row.cloudActivated ? 'ok' : 'idle'}`}
                aria-hidden="true"
              ></span>
              {row.cloudActivated ? 'Connected' : 'Local'}
            </span>
          </span>
          {#if row.pendingInvite}
            <span class="v4-invite-badge" data-testid={`company-invite-badge-${row.slug}`}>Invite</span>
          {:else if index < 9}
            <span class="ws-shortcut" aria-hidden="true">⌘{index + 1}</span>
          {/if}
        </button>
      {/each}
      {#if menuPersonal.length > 0}
        <div class="ws-menu-divider" role="none"></div>
        {#each menuPersonal as row (row.slug)}
          <button
            type="button"
            class="ws-menu-row"
            class:current={currentRow != null && row.slug === currentRow.slug}
            role="menuitem"
            data-testid={`workspace-option-${row.slug}`}
            onclick={() => selectWorkspace(row.slug)}
          >
            <span class="ws-tile menu" style={`background:${tileGradient(row.slug)}`} aria-hidden="true">
              {workspaceInitials(row.label)}
            </span>
            <span class="ws-menu-copy">
              <span class="ws-menu-name">{row.label}</span>
              <span class="ws-menu-meta">Personal workspace</span>
            </span>
            <span class="ws-shortcut" aria-hidden="true">⌘0</span>
          </button>
        {/each}
      {/if}
      <div class="ws-menu-divider" role="none"></div>
      <button type="button" class="ws-menu-row ws-add" role="menuitem" onclick={addWorkspace}>
        <span class="ws-tile menu add" aria-hidden="true">+</span>
        <span class="ws-menu-name">Add a workspace</span>
      </button>
    </div>
  </div>
{/if}

<style>
  .v4-sidebar {
    display: flex;
    flex-direction: column;
    flex: 0 0 220px;
    width: 220px;
    min-height: 0;
    height: 100%;
    overflow: hidden;
    padding: 14px 10px 0;
    border-right: 1px solid var(--v4-hairline);
    background: var(--v4-sidebar, var(--v4-chrome));
    backdrop-filter: var(--v4-glass-filter);
    -webkit-backdrop-filter: var(--v4-glass-filter);
    box-shadow: inset 1px 0 0 var(--v4-glass-highlight);
    font-family: var(--font-sans);
  }

  .v4-nav {
    display: flex;
    flex-direction: column;
    flex: 0 0 auto;
    gap: var(--v4-row-gap);
  }

  .v4-row {
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
    /* Native macOS sidebar row: rounded rect selection, not underlines. */
    border-radius: 6px;
    background: transparent;
    color: var(--v4-text-2);
    font: inherit;
    font-size: var(--type-body, var(--text-base));
    font-weight: 400;
    line-height: 1;
    text-align: left;
    cursor: pointer;
  }

  .v4-row:hover {
    background: var(--v4-control-faint);
    color: var(--v4-text-1);
  }

  .v4-row:focus-visible {
    outline: 2px solid var(--v4-focus-ring, var(--v4-control-border));
    outline-offset: -2px;
    background: var(--v4-active-row);
    color: var(--v4-text-1);
  }

  .v4-row.active {
    background: var(--v4-active-row);
    color: var(--v4-text-1);
    font-weight: 500;
  }

  .v4-row-label {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  /* Native macOS sidebar count (Mail-style): a plain muted number, no pill. */
  .v4-unread-badge {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    background: transparent;
    color: var(--v4-text-3);
    font-size: var(--type-secondary, 13px);
    font-weight: 600;
    line-height: 1;
    font-variant-numeric: tabular-nums;
  }

  .v4-invite-badge {
    flex: 0 0 auto;
    margin-left: auto;
    padding: 0;
    border: 0;
    border-radius: 0;
    background: transparent;
    color: var(--v4-text-2);
    font-size: var(--type-metadata, 10px);
    font-weight: 500;
    line-height: 14px;
    letter-spacing: 0.02em;
    text-transform: uppercase;
  }
  /* ---- Workspace switcher (Slack-style, onboarding-flavored) ---- */

  .ws-current {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    margin: 0 0 14px;
    padding: 6px 8px;
    border: none;
    border-radius: 8px;
    background: transparent;
    color: var(--v4-text-1);
    font: inherit;
    text-align: left;
    cursor: pointer;
    transition: background 0.15s;
  }

  .ws-current:hover {
    background: var(--v4-control-faint);
  }

  .ws-current:focus-visible {
    outline: 1.5px solid var(--v4-focus-ring, var(--v4-control-border));
    outline-offset: 2px;
  }

  .ws-tile {
    flex: 0 0 auto;
    display: inline-grid;
    place-items: center;
    width: 28px;
    height: 28px;
    border-radius: 8px;
    box-shadow: inset 0 0 0 0.5px rgba(0, 0, 0, 0.18);
    color: #fff;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.01em;
    user-select: none;
  }

  .ws-tile.menu {
    width: 36px;
    height: 36px;
    border-radius: 9px;
    font-size: 14px;
  }

  .ws-tile.add {
    background: var(--v4-control-faint);
    box-shadow: inset 0 0 0 0.5px var(--v4-hairline);
    color: var(--v4-text-2);
    font-size: 18px;
    font-weight: 400;
  }

  .ws-current-name {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-size: var(--type-body, var(--text-base));
    font-weight: 600;
  }

  .ws-chevron {
    flex: 0 0 auto;
    color: var(--v4-text-3);
  }

  .ws-sections {
    display: flex;
    flex-direction: column;
    flex: 0 1 auto;
    min-height: 0;
    overflow-y: auto;
    gap: var(--v4-row-gap);
    scrollbar-color: var(--v4-hairline) transparent;
    scrollbar-width: thin;
  }

  .ws-sections::-webkit-scrollbar {
    width: 6px;
  }

  .ws-sections::-webkit-scrollbar-thumb {
    border-radius: var(--v4-radius-pill);
    background: var(--v4-hairline);
  }

  .ws-divider {
    flex: 0 0 auto;
    height: 1px;
    margin: 12px 8px;
    background: var(--v4-hairline);
  }

  .ws-layer {
    position: fixed;
    inset: 0;
    z-index: 10000;
  }

  .ws-backdrop {
    position: absolute;
    inset: 0;
  }

  .ws-menu {
    position: absolute;
    width: 292px;
    max-height: calc(100vh - 96px);
    overflow-y: auto;
    box-sizing: border-box;
    padding: 6px;
    border: 1px solid var(--border-strong, var(--pop-border, rgba(120, 120, 120, 0.3)));
    border-radius: var(--v4-radius-popover, 12px);
    background: var(
      --v4-popover-strong,
      var(--v4-popover, var(--pop-bg, rgba(42, 42, 42, 0.82)))
    );
    backdrop-filter: var(--v4-glass-filter-popover, var(--v4-glass-filter));
    -webkit-backdrop-filter: var(--v4-glass-filter-popover, var(--v4-glass-filter));
    box-shadow: var(--v4-shadow-popover, var(--pop-shadow)), inset 0 1px 0 var(--v4-glass-highlight);
    font-family: var(--font-sans);
  }

  .ws-menu-item {
    position: relative;
  }

  .ws-menu-row {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 8px;
    border: none;
    border-radius: 8px;
    background: transparent;
    color: var(--v4-text-1);
    font: inherit;
    text-align: left;
    cursor: pointer;
    transition: background 0.15s;
  }

  .ws-menu-row:hover {
    background: var(--v4-control-faint);
  }

  /* Current workspace: persistent filled selection (macOS menu idiom),
     no checkmark. */
  .ws-menu-row.current {
    background: var(--v4-active-row);
  }

  .ws-menu-row.current .ws-menu-name {
    font-weight: 700;
  }

  .ws-menu-row:focus-visible {
    outline: 1.5px solid var(--v4-focus-ring, var(--v4-control-border));
    outline-offset: -1.5px;
  }

  .ws-menu-copy {
    display: grid;
    gap: 2px;
    min-width: 0;
    flex: 1 1 auto;
  }

  .ws-menu-name {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-size: 14px;
    font-weight: 600;
    line-height: 18px;
  }

  .ws-add .ws-menu-name {
    font-weight: 500;
  }

  .ws-menu-meta {
    display: flex;
    align-items: center;
    gap: 5px;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    color: var(--v4-text-3);
    font-size: var(--type-metadata, 13px);
    line-height: 16px;
  }

  .ws-status-dot {
    flex: 0 0 auto;
    width: 6px;
    height: 6px;
    border-radius: 999px;
    background: var(--v4-idle);
  }

  .ws-status-dot.ok {
    background: var(--v4-ok);
  }

  /* Slack-style advertised hotkey, right-aligned per row. */
  .ws-shortcut {
    flex: 0 0 auto;
    color: var(--v4-text-3);
    font-size: var(--type-metadata, 12px);
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.02em;
  }

  .ws-menu-divider {
    height: 1px;
    margin: 6px 4px;
    background: var(--v4-hairline);
  }

  .v4-invite-badge {
    flex: 0 0 auto;
    padding: 0;
    border-radius: 0;
    background: transparent;
    color: var(--v4-text-3);
    font-size: var(--text-sm);
    font-weight: 600;
    letter-spacing: 0.04em;
  }

  .v4-child-meta {
    color: var(--v4-text-3);
    flex: 0 0 auto;
  }

  /* Grows to pin the profile footer to the bottom of the sidebar. */
  .v4-spacer {
    flex: 1 1 auto;
  }

  /* Profile footer — avatar circle + name + email; opens Settings. */
  .v4-footer {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    margin: 0 0 12px;
    padding: 6px 8px;
    border: none;
    border-radius: 8px;
    background: transparent;
    color: var(--v4-text-1);
    cursor: pointer;
    text-align: left;
    font: inherit;
    transition: background 0.15s;
  }

  .v4-footer:hover,
  .v4-footer.active {
    background: var(--v4-active-row);
  }

  .v4-footer:focus-visible {
    outline: 2px solid var(--v4-focus-ring, var(--v4-control-border));
    outline-offset: -2px;
  }

  .v4-avatar {
    flex: 0 0 auto;
    display: inline-grid;
    place-items: center;
    width: 28px;
    height: 28px;
    border-radius: 999px;
    background: var(--v4-control-bg);
    color: var(--v4-text-2);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.02em;
    user-select: none;
  }

  .v4-footer-copy {
    display: grid;
    gap: 1px;
    min-width: 0;
    flex: 1 1 auto;
  }

  .v4-footer-name {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    color: var(--v4-text-1);
    font-size: var(--type-body, 13px);
    font-weight: 500;
  }

  .v4-footer-meta {
    overflow: hidden;
    max-width: 100%;
    color: var(--v4-text-3);
    font-size: var(--type-metadata, 12px);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
