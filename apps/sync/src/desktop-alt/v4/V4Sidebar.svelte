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

  interface Props {
    route: V4Route;
    companies?: Workspace[] | null;
    accountEmail?: string | null;
    cloudReachable?: boolean | null;
    onworkspaceenabledchange?: (slug: string, enabled: boolean) => void;
    onnavigate?: (route: V4Route) => void;
  }

  let {
    route,
    companies,
    accountEmail,
    cloudReachable = null,
    onworkspaceenabledchange,
    onnavigate,
  }: Props = $props();

  let fetchedCloudReachable = $state(true);
  const effectiveCloudReachable = $derived(cloudReachable ?? fetchedCloudReachable);

  let fetched = $state<Workspace[]>([]);
  const model = $derived(
    getV4SidebarModel(route, companies && companies.length > 0 ? companies : fetched),
  );
  const personalRows = $derived(model.companies.filter((row) => row.isPersonal));
  const companyRows = $derived(model.companies.filter((row) => !row.isPersonal));

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

  let notifUnread = $state(0);

  async function refreshUnread() {
    try {
      const items = await loadNotificationItems();
      notifUnread = countUnread(items, getLastReadTs());
    } catch {
      notifUnread = 0;
    }
  }

  $effect(() => {
    void refreshUnread();

    const onread = () => void refreshUnread();
    window.addEventListener('hq:notifications-read', onread);

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
            class:has-syncmode={!row.expanded}
            class:expanded={row.expanded}
            role="group"
            onpointerenter={() => !row.expanded && queueReveal(row.slug)}
            onpointerleave={cancelPendingReveal}
            onfocusin={() => !row.expanded && reveal(row.slug)}
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
            {#if !row.expanded && revealedSlugs.has(row.slug)}
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
                  {#if child.id === 'more'}
                    <span class="v4-child-meta" aria-hidden="true">•••</span>
                  {/if}
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

  .v4-companies-area {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    min-height: 0;
    margin-top: 16px;
    gap: 10px;
  }

  .v4-section-label {
    padding: 0 8px;
    color: var(--v4-text-3);
    font-size: var(--text-sm);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .v4-section-label.subheading {
    padding-top: 8px;
  }

  .v4-company-nav {
    min-height: 0;
    overflow-y: auto;
    padding-bottom: 12px;
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
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
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
  }

  .v4-syncmode-slot.always-visible {
    position: static;
    transform: none;
  }

  .v4-dot {
    width: 6px;
    height: 6px;
    border-radius: 999px;
    flex: 0 0 auto;
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
    padding: 2px 6px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--v4-warn) 18%, transparent);
    color: var(--v4-text-2);
    font-size: var(--text-sm);
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
    flex: 1 1 auto;
  }

  .v4-footer {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
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

  .v4-footer-meta {
    color: var(--v4-text-3);
    font-size: var(--text-sm);
  }
</style>
