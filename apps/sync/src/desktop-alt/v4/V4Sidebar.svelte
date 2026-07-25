<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import { listen } from '@tauri-apps/api/event';
  import { onMount } from 'svelte';
  import type { Workspace, WorkspacesResult } from '../../lib/workspaces';
  import {
    loadNotificationItems,
    getLastReadTs,
    countUnread,
  } from '../../lib/notificationFeedData';
  import {
    getV4SidebarModel,
    type V4CompanyPrimaryId,
    type V4NavId,
    type V4Route,
  } from './model';
  import SidebarSyncMode from './SidebarSyncMode.svelte';
  import './tokens.css';

  /**
   * V4 primary sidebar (SPEC section 4 + DESKTOP-001): 220px Liquid Glass
   * chrome, hairline right border. Nav is Inbox / Meetings / Marketplace /
   * Library / Files (US-008: Messages + Notifications merged into Inbox;
   * US-007 removed Home / Mission Control / Companies page rows) →
   * COMPANIES section (selected company expands Overview / Goals / Projects /
   * Knowledge / Team / More inline; children collapse on global destinations)
   * → Settings footer.
   *
   * At most one top-level active row, driven by `route` (see getV4SidebarModel)
   * — palette-only surfaces light none. Company primary children are a second
   * hierarchy level only; there is no permanent company secondary sidebar.
   */
  interface Props {
    route: V4Route;
    /** `list_syncable_workspaces` workspaces; omit to let the sidebar self-load. */
    companies?: Workspace[] | null;
    /** Signed-in account email for the Settings footer. */
    accountEmail?: string | null;
    /** Vault reachability from list_syncable_workspaces — gates sync-mode
     *  writes (control renders read-only while offline). Omit to let the
     *  sidebar resolve it from its own self-load; defaults to reachable. */
    cloudReachable?: boolean | null;
    onnavigate?: (route: V4Route) => void;
  }

  let {
    route,
    companies,
    accountEmail,
    cloudReachable = null,
    onnavigate,
  }: Props = $props();

  let fetchedCloudReachable = $state(true);
  const effectiveCloudReachable = $derived(cloudReachable ?? fetchedCloudReachable);

  let fetched = $state<Workspace[]>([]);
  const model = $derived(
    getV4SidebarModel(route, companies && companies.length > 0 ? companies : fetched),
  );

  onMount(() => {
    if (companies && companies.length > 0) return;
    void invoke<WorkspacesResult>('list_syncable_workspaces')
      .then((result) => {
        fetched = result.workspaces;
        fetchedCloudReachable = result.cloudReachable;
      })
      .catch((err) => {
        console.error('list_syncable_workspaces failed:', err);
      });
  });

  // Unified unread indicator on the combined Inbox row — one badge covering
  // messages (DMs), shares, and new-file activity (the shared feed lib already
  // merges all three streams) (US-008). Self-loaded from the shared feed-data
  // lib; refreshed when new content lands (DM wake / sync complete) and when
  // the Inbox advances the read watermark (`hq:notifications-read` window event).
  let notifUnread = $state(0);

  async function refreshUnread() {
    try {
      const items = await loadNotificationItems();
      notifUnread = countUnread(items, getLastReadTs());
    } catch {
      // Vault unreachable / signed out — no badge is the right render.
      notifUnread = 0;
    }
  }

  $effect(() => {
    void refreshUnread();

    const onread = () => void refreshUnread();
    window.addEventListener('hq:notifications-read', onread);

    // `listen` registers asynchronously. The desktop window can close before
    // either promise settles, so unregister late handlers immediately rather
    // than leaving stale event IDs in the native listener registry.
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    const track = (unlisten: () => void) => {
      if (disposed) unlisten();
      else unlisteners.push(unlisten);
    };
    void listen('dm:unread-summary', onread).then(track);
    void listen('sync:complete', onread).then(track);

    return () => {
      disposed = true;
      window.removeEventListener('hq:notifications-read', onread);
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

  // Once a cloud-activated company row is hovered/focused, keep SidebarSyncMode
  // mounted so its mode cache lives; CSS owns show/hide on subsequent hover.
  // Pointer reveal waits a short hover-intent delay so sweeping the mouse down
  // the (up to ~25-row) list doesn't mount every control and fan out one
  // get_sync_mode vault round-trip per row passed over. Focus reveals
  // immediately — keyboard traversal is always intentional.
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
    <div class="v4-section-label" id="v4-companies-label">Companies</div>
    <nav class="v4-nav v4-company-nav" aria-labelledby="v4-companies-label">
      {#each model.companies as row (row.slug)}
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
            <span class="v4-company-name">{row.label}</span>
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
                disabled={!effectiveCloudReachable}
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
                {#if child.id === 'more'}
                  <span class="v4-child-meta" aria-hidden="true">•••</span>
                {/if}
              </button>
            {/each}
          </div>
        {/if}
      {/each}
    </nav>
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
    {#if accountEmail}
      <span class="v4-footer-meta">{accountEmail}</span>
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
    /* Clip at the sidebar boundary so the ONLY scroller is .v4-company-nav —
       the nav above and the Settings footer below stay pinned even with the
       full ~25-company list (US-007). */
    overflow: hidden;
    padding: 14px 10px 0;
    border-right: 1px solid var(--v4-hairline);
    background: var(--v4-sidebar, var(--v4-chrome));
    backdrop-filter: blur(22px) saturate(180%);
    -webkit-backdrop-filter: blur(22px) saturate(180%);
    box-shadow: inset 1px 0 0 var(--pop-highlight);
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
    /* Lock the row to exactly --v4-row-h so a tall glyph, the name's mask layer,
       or sub-pixel font metrics can never grow/shrink it (US-007). flex-shrink:0
       stops the scroll container from compressing rows when the list overflows. */
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
    color: #ffffff;
    font-size: var(--type-metadata, 10px);
    font-weight: 700;
    line-height: 1;
  }

  .v4-invite-badge {
    flex: 0 0 auto;
    margin-left: auto;
    padding: 1px 6px;
    border-radius: 999px;
    border: 1px solid var(--v4-hairline);
    background: var(--v4-control-faint, transparent);
    color: var(--v4-text-2);
    font-size: var(--type-metadata, 10px);
    font-weight: 500;
    line-height: 14px;
    letter-spacing: 0.02em;
    text-transform: uppercase;
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

  .v4-companies-area {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    min-height: 0;
    margin-top: var(--v4-space-5);
  }

  .v4-company-nav {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    padding-right: 2px;
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

  /* Positioned wrapper so Shared/All can overlay the row without nesting
     buttons or changing --v4-row-h (US-009). */
  .v4-company-item {
    position: relative;
    flex: 0 0 auto;
  }

  .v4-syncmode-slot {
    position: absolute;
    right: 4px;
    top: 50%;
    transform: translateY(-50%);
    display: inline-flex;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.12s ease;
    z-index: 1;
  }

  .v4-company-item:hover .v4-syncmode-slot,
  .v4-company-item:focus-within .v4-syncmode-slot {
    opacity: 1;
    pointer-events: auto;
  }

  /* While the Shared/All control is visible it overlays the right ~86px of the
     row, so widen the company-name fade-out from the resting 24px to fade the
     text away BEFORE the control starts — no doubled low-contrast text under
     the pill (US-009). Only rows that actually carry a control widen. */
  .v4-company-item.has-syncmode:hover .v4-company-name,
  .v4-company-item.has-syncmode:focus-within .v4-company-name {
    -webkit-mask-image: linear-gradient(to right, #000 calc(100% - 96px), transparent calc(100% - 78px));
    mask-image: linear-gradient(to right, #000 calc(100% - 96px), transparent calc(100% - 78px));
  }

  .v4-dot {
    flex: 0 0 6px;
    align-self: center;
    width: 6px;
    height: 6px;
    border-radius: var(--v4-radius-pill);
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

  .v4-dot.idle {
    background: var(--v4-idle);
  }

  .v4-company-name {
    flex: 1 1 auto;
    overflow: hidden;
    min-width: 0;
    white-space: nowrap;
    /* Match the line box to the row height so the name is centered identically
       on every row regardless of glyph ascenders/descenders — without this the
       text box height tracks the font metrics and rows read as uneven (US-007).
       overflow:hidden keeps a 28px line box from spilling outside the row. */
    line-height: var(--v4-row-h);
    /* Right-edge fade-out instead of an ellipsis cutoff: the last 24px fades to
       transparent. When the name fits, the fade region sits past the text and is
       invisible; only an overflowing name actually clips. -webkit- prefix is
       required for the WKWebView this app runs in. */
    -webkit-mask-image: linear-gradient(to right, #000 calc(100% - 24px), transparent 100%);
    mask-image: linear-gradient(to right, #000 calc(100% - 24px), transparent 100%);
  }

  .v4-disclosure {
    flex: 0 0 auto;
    color: var(--v4-text-3);
    font-size: var(--type-metadata, 10px);
    line-height: 1;
  }

  /* DESKTOP-001: one additional hierarchy level under the selected company. */
  .v4-company-children {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: var(--v4-row-gap);
    margin: 2px 0 6px 18px;
    padding: 2px 0 2px 12px;
  }

  .v4-company-children::before {
    content: '';
    position: absolute;
    inset: 2px auto 2px 0;
    width: 1px;
    background: var(--v4-hairline);
  }

  .v4-company-child {
    height: 26px;
    min-height: 26px;
    max-height: 26px;
    color: var(--v4-text-3);
    font-size: var(--type-body, 12px);
  }

  .v4-company-child.active {
    color: var(--v4-text-1);
  }

  .v4-child-meta {
    flex: 0 0 auto;
    color: var(--v4-text-3);
    font-size: var(--type-metadata, 10px);
    letter-spacing: 0.04em;
  }

  .v4-spacer {
    flex: 0 0 var(--v4-space-4);
    min-height: var(--v4-space-4);
  }

  .v4-footer {
    /* Pinned: never shrink under list pressure so the footer stays on-screen
       and the overflow goes to .v4-company-nav instead (US-007).
       DESKTOP-011: title + meta use separate grid slots with explicit 3px gap. */
    display: grid;
    grid-template-rows: auto auto;
    grid-template-columns: minmax(0, 1fr);
    align-items: start;
    justify-items: start;
    flex: 0 0 auto;
    gap: var(--v4-row-stack-gap, 3px);
    margin: 0 -10px;
    padding: 12px 18px 14px;
    border: none;
    border-top: 1px solid var(--v4-hairline);
    background: transparent;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .v4-footer:hover .v4-footer-label,
  .v4-footer:focus-visible .v4-footer-label,
  .v4-footer.active .v4-footer-label {
    color: var(--v4-text-1);
  }

  .v4-footer:focus-visible {
    outline: 2px solid var(--v4-focus-ring, var(--v4-control-border));
    outline-offset: -4px;
  }

  .v4-footer.active .v4-footer-label {
    font-weight: 500;
  }

  .v4-footer-label {
    color: var(--v4-text-2);
    font-size: var(--type-body, var(--text-base));
    font-weight: 400;
    line-height: 1.2;
  }

  .v4-footer-meta {
    overflow: hidden;
    max-width: 100%;
    color: var(--v4-text-3);
    font-size: var(--type-secondary, var(--text-xs));
    line-height: 1.2;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  @media (prefers-reduced-transparency: reduce) {
    .v4-sidebar {
      backdrop-filter: none;
      -webkit-backdrop-filter: none;
      box-shadow: none;
    }
  }
</style>
