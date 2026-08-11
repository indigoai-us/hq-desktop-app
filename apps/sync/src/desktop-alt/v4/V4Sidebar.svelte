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
    type V4CompanyPrimaryId,
    type V4NavId,
    type V4Route,
  } from './model';
  import SidebarSyncMode from './SidebarSyncMode.svelte';
  import BrandLogoSlot from '../../lib/BrandLogoSlot.svelte';
  import type { CachedBrand } from '../../lib/brand';
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
   *
   * Logo slot (US-005): tenant logo + powered-by lockup when branded; HQ mark
   * only when unbranded.
   */

  interface Props {
    route: V4Route;
    companies?: Workspace[] | null;
    /** Signed-in account label for the Settings footer. */
    accountLabel?: string | null;
    /** Vault reachability from list_syncable_workspaces — gates sync-mode
     *  writes (control renders read-only while offline). Omit to let the
     *  sidebar resolve it from its own self-load; defaults to reachable. */
    cloudReachable?: boolean | null;
    onworkspaceenabledchange?: (slug: string, enabled: boolean) => void;
    /** Active white-label brand (US-005); null → HQ defaults. */
    brand?: CachedBrand | null;
    onnavigate?: (route: V4Route) => void;
  }

  let {
    route,
    companies,
    accountLabel,
    cloudReachable = null,
    onworkspaceenabledchange,
    brand = null,
    onnavigate,
  }: Props = $props();

  let fetchedCloudReachable = $state(true);
  const effectiveCloudReachable = $derived(cloudReachable ?? fetchedCloudReachable);

  let fetched = $state<Workspace[]>([]);
  // An explicitly supplied empty list is authoritative: it represents the
  // parent's hydrated empty/error state. Only an omitted value may self-load.
  const model = $derived(
    getV4SidebarModel(route, companies ?? fetched),
  );
  const personalRows = $derived(model.companies.filter((row) => row.isPersonal));
  const companyRows = $derived(model.companies.filter((row) => !row.isPersonal));

  onMount(() => {
    if (companies != null) return;
    void invoke<WorkspacesResult>('list_syncable_workspaces')
      .then((result) => {
        fetched = Array.isArray(result.workspaces) ? result.workspaces : [];
        fetchedCloudReachable = result.cloudReachable;
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

  const REVEAL_INTENT_MS = 140;
  let revealedSlugs = $state(new Set<string>());
  let revealTimer: ReturnType<typeof setTimeout> | null = null;

  function reveal(slug: string) {
    cancelPendingReveal();
    if (revealedSlugs.has(slug)) return;
    revealedSlugs = new Set(revealedSlugs).add(slug);
  }

  function queueReveal(slug: string) {
    cancelPendingReveal();
    if (revealedSlugs.has(slug)) return;
    revealTimer = setTimeout(() => reveal(slug), REVEAL_INTENT_MS);
  }

  function cancelPendingReveal() {
    if (revealTimer !== null) {
      clearTimeout(revealTimer);
      revealTimer = null;
    }
  }

  $effect(() => () => cancelPendingReveal());
</script>

<aside class="v4-sidebar" aria-label="Primary navigation">
  <div class="v4-logo-slot" data-tauri-drag-region>
    <BrandLogoSlot
      brand={brand}
      brandingEnabled={brand?.brandingEnabled ?? false}
      size="desktop"
      companyName={brand?.companySlug ?? null}
    />
  </div>

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

  <div class="v4-companies-area">
    <div class="v4-section-label" id="v4-workspaces-label">Workspaces</div>

    {#if personalRows.length > 0}
      <nav class="v4-nav" aria-labelledby="v4-workspaces-label">
        {#each personalRows as row (row.slug)}
          <div class="v4-company-item personal" role="group">
            <button
              type="button"
              class="v4-row v4-company-row"
              class:active={row.active}
              aria-current={row.active && row.children.every((child) => !child.active) ? 'page' : undefined}
              aria-expanded={row.expanded}
              onclick={() => goCompany(row.slug)}
            >
              <span class={`v4-dot ${row.tone}`} aria-hidden="true"></span>
              <span class="v4-company-copy">
                <span class="v4-company-name">{row.label}</span>
                {#if row.ownerLabel}
                  <span class="v4-company-meta">{row.ownerLabel}</span>
                {/if}
              </span>
            </button>
            <span class="v4-syncmode-slot always-visible">
              <SidebarSyncMode
                slug={row.slug}
                label={row.label}
                isPersonal={true}
                syncEnabled={row.syncEnabled}
                cloudReachable={effectiveCloudReachable}
                onenabledchange={(enabled) => onworkspaceenabledchange?.(row.slug, enabled)}
              />
            </span>
          </div>
        {/each}
      </nav>
    {/if}

    {#if companyRows.length > 0}
      <div class="v4-section-label subheading" id="v4-companies-label">Companies</div>
      <nav class="v4-nav v4-company-nav" aria-labelledby="v4-companies-label">
        {#each companyRows as row (row.slug)}
          <div
            class="v4-company-item"
            class:has-syncmode={row.cloudActivated && !row.expanded}
            class:expanded={row.expanded}
            role="group"
            onpointerenter={() => row.cloudActivated && !row.expanded && queueReveal(row.slug)}
            onpointerleave={cancelPendingReveal}
            onfocusin={() => row.cloudActivated && !row.expanded && reveal(row.slug)}
          >
            <button
              type="button"
              class="v4-row v4-company-row"
              class:active={row.active}
              aria-current={row.active && row.children.every((child) => !child.active) ? 'page' : undefined}
              aria-expanded={row.expanded}
              onclick={() => goCompany(row.slug)}
            >
              <span class={`v4-dot ${row.tone}`} aria-hidden="true"></span>
              <span class="v4-company-copy">
                <span class="v4-company-name">{row.label}</span>
                {#if row.ownerLabel}
                  <span class="v4-company-meta">{row.ownerLabel}</span>
                {/if}
              </span>
              {#if row.pendingInvite}
                <span class="v4-invite-badge" data-testid={`company-invite-badge-${row.slug}`}>Invite</span>
              {:else if row.expanded}
                <span class="v4-disclosure" aria-hidden="true">⌄</span>
              {/if}
            </button>
            {#if row.cloudActivated && !row.expanded && revealedSlugs.has(row.slug)}
              <span class="v4-syncmode-slot">
                <SidebarSyncMode
                  slug={row.slug}
                  label={row.label}
                  syncEnabled={row.syncEnabled}
                  cloudReachable={effectiveCloudReachable}
                  onenabledchange={(enabled) => onworkspaceenabledchange?.(row.slug, enabled)}
                />
              </span>
            {/if}
          </div>
          {#if row.expanded && row.children.length > 0}
            <div
              class="v4-company-children"
              data-testid={`company-children-${row.slug}`}
              aria-label={`${row.label} sections`}
            >
              {#each row.children as child (child.id)}
                <button
                  type="button"
                  class="v4-row v4-company-child"
                  class:active={child.active}
                  aria-current={child.active ? 'page' : undefined}
                  data-testid={`company-child-${row.slug}-${child.id}`}
                  onclick={() => goCompanySection(row.slug, child.id)}
                >
                  <span class="v4-row-label">{child.label}</span>
                </button>
              {/each}
            </div>
          {/if}
        {/each}
      </nav>
    {/if}
  </div>

  <div class="v4-spacer"></div>

  <button
    type="button"
    class="v4-footer"
    class:active={model.settingsActive}
    aria-current={model.settingsActive ? 'page' : undefined}
    onclick={() => go('settings')}
  >
    <span class="v4-footer-label">Settings</span>
    {#if accountLabel}
      <span class="v4-footer-meta">{accountLabel}</span>
    {/if}
  </button>
</aside>

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

  .v4-logo-slot {
    flex: 0 0 auto;
    margin: 0 0 12px;
    padding: 0 8px;
    min-height: 22px;
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
    border-radius: 0;
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
    background: transparent;
    box-shadow: inset 0 -1px 0 var(--v4-hairline);
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

  .v4-unread-badge {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 16px;
    height: 16px;
    padding: 0 5px;
    box-sizing: border-box;
    border-radius: 999px;
    background: var(--v4-unread);
    color: var(--v4-primary-fg);
    font-size: var(--type-metadata, 10px);
    font-weight: 700;
    line-height: 1;
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
  .v4-companies-area {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    min-height: 0;
    margin-top: 16px;
    gap: 10px;
  }

  .v4-section-label {
    flex: 0 0 auto;
    margin: 0 0 6px;
    padding: 0 8px;
    color: var(--v4-text-3);
    font-size: var(--type-secondary, var(--text-xs));
    font-weight: 400;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .v4-section-label.subheading {
    padding-top: 8px;
  }

  .v4-company-nav {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    padding-bottom: 12px;
    scrollbar-color: var(--v4-hairline) transparent;
    scrollbar-width: thin;
  }

  .v4-company-nav::-webkit-scrollbar {
    width: 6px;
  }

  .v4-company-nav::-webkit-scrollbar-thumb {
    border-radius: var(--v4-radius-pill);
    background: var(--v4-hairline);
  }

  .v4-company-item {
    position: relative;
  }

  .v4-company-item.personal {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .v4-company-item.personal .v4-company-row {
    flex: 1 1 auto;
  }

  .v4-company-row {
    padding-right: 34px;
  }

  .v4-company-copy {
    display: inline-flex;
    align-items: baseline;
    gap: 6px;
    min-width: 0;
    flex: 1 1 auto;
  }

  .v4-company-name {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    -webkit-mask-image: linear-gradient(to right, #000 calc(100% - 24px), transparent 100%);
    mask-image: linear-gradient(to right, #000 calc(100% - 24px), transparent 100%);
  }

  .v4-company-item.has-syncmode:hover .v4-company-name,
  .v4-company-item.has-syncmode:focus-within .v4-company-name {
    -webkit-mask-image: linear-gradient(to right, #000 calc(100% - 96px), transparent calc(100% - 78px));
    mask-image: linear-gradient(to right, #000 calc(100% - 96px), transparent calc(100% - 78px));
  }

  .v4-company-meta {
    color: var(--v4-text-3);
    font-size: var(--text-sm);
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .v4-syncmode-slot {
    position: absolute;
    top: 50%;
    right: 6px;
    transform: translateY(-50%);
    opacity: 0;
    pointer-events: none;
  }

  .v4-company-item:hover .v4-syncmode-slot,
  .v4-company-item:focus-within .v4-syncmode-slot {
    opacity: 1;
    pointer-events: auto;
  }

  .v4-syncmode-slot.always-visible {
    position: static;
    transform: none;
    opacity: 1;
    pointer-events: auto;
  }

  .v4-dot {
    flex: 0 0 6px;
    align-self: center;
    width: 6px;
    height: 6px;
    border-radius: 999px;
    background: var(--v4-idle);
  }

  .v4-dot.ok {
    background: var(--v4-ok);
  }

  .v4-dot.warn {
    background: var(--v4-warn);
  }

  .v4-dot.error {
    background: var(--v4-error);
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

  .v4-disclosure {
    flex: 0 0 auto;
    color: var(--v4-text-3);
  }

  .v4-company-children {
    display: flex;
    flex-direction: column;
    gap: var(--v4-row-gap);
    margin-left: 18px;
    padding-top: 4px;
  }

  .v4-company-child {
    padding-left: 18px;
  }

  .v4-child-meta {
    color: var(--v4-text-3);
    flex: 0 0 auto;
  }

  .v4-unread-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 18px;
    height: 18px;
    padding: 0 6px;
    border-radius: 999px;
    background: var(--v4-primary-bg);
    color: var(--v4-primary-fg);
    font-size: var(--text-sm);
    font-weight: 600;
  }

  .v4-spacer {
    flex: 0 0 auto;
  }

  .v4-footer {
    /* Pinned: never shrink under list pressure so the footer stays on-screen
       and the overflow goes to .v4-company-nav instead (US-007).
       DESKTOP-011: title + meta use separate grid slots with explicit 3px gap. */
    display: grid;
    grid-template-rows: auto auto;
    gap: var(--v4-row-stack-gap, 3px);
    justify-items: start;
    width: 100%;
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

  .v4-footer:hover,
  .v4-footer.active {
    background: var(--v4-active-row);
    color: var(--v4-text-1);
  }

  .v4-footer:focus-visible {
    outline: 2px solid var(--v4-focus-ring, var(--v4-control-border));
    outline-offset: -4px;
  }

  .v4-footer:hover .v4-footer-label,
  .v4-footer:focus-visible .v4-footer-label,
  .v4-footer.active .v4-footer-label {
    color: var(--v4-text-1);
  }

  .v4-footer.active .v4-footer-label {
    font-weight: 500;
  }

  .v4-footer-label {
    color: var(--v4-text-2);
    font-size: var(--type-body, var(--text-base));
    font-weight: 400;
  }

  .v4-footer-meta {
    overflow: hidden;
    max-width: 100%;
    color: var(--v4-text-3);
    font-size: var(--text-sm);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
