<script lang="ts">
  /**
   * CompanyOperationsPanel — DESKTOP-010 company-scoped operations workspace.
   *
   * Opened from the primary sidebar More child. Compact internal destinations
   * (Activity · Deployments · Secrets · Settings) stay under the selected
   * company; More remains the active sidebar child for all four. Does not
   * restore a permanent company secondary sidebar.
   *
   * Operational panels retain existing actions, loading/error/empty states,
   * direction/date behavior, deploy open workflow, and metadata-only secrets.
   * Settings opens the HQ console company settings surface (identity / sync /
   * membership) — no in-app credential fields.
   */
  import { open as openExternal } from '@tauri-apps/plugin-shell';
  import { companySettingsUrl } from '../lib/hq-console';
  import {
    COMPANY_OPERATIONS_SECTIONS,
    type CompanyOperationsTab,
  } from '../route';
  import ActivityPanel from './ActivityPanel.svelte';
  import DeploymentsPanel from './DeploymentsPanel.svelte';
  import SecretsPanel from './SecretsPanel.svelte';
  import '../v4/tokens.css';

  interface Props {
    slug: string;
    cloudBacked?: boolean;
    /** Active internal destination — driven by the company route tab. */
    destination?: CompanyOperationsTab;
    /** Navigate to another operations destination (parent updates the route). */
    ondestinationchange?: (destination: CompanyOperationsTab) => void;
  }

  let {
    slug,
    cloudBacked = true,
    destination = 'activity',
    ondestinationchange,
  }: Props = $props();

  const destinations = COMPANY_OPERATIONS_SECTIONS;
  const activeDestination = $derived<CompanyOperationsTab>(
    destinations.some((d) => d.id === destination) ? destination : 'activity',
  );

  function selectDestination(id: CompanyOperationsTab): void {
    if (id === activeDestination) return;
    ondestinationchange?.(id);
  }

  function openCompanySettings(): void {
    void openExternal(companySettingsUrl(slug));
  }

  /**
   * Keyboard selection in the operations nav: ArrowUp/Down move selection,
   * Home/End jump. Selection notifies the parent so the route tab stays in
   * sync (and More remains the active primary sidebar child).
   */
  function handleNavKeydown(event: KeyboardEvent): void {
    const keys = destinations.map((d) => d.id);
    const index = keys.indexOf(activeDestination);
    let nextIndex = index;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      nextIndex = Math.min(keys.length - 1, Math.max(0, index) + (index < 0 ? 0 : 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      nextIndex = Math.max(0, index < 0 ? 0 : index - 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      nextIndex = 0;
    } else if (event.key === 'End') {
      event.preventDefault();
      nextIndex = keys.length - 1;
    } else if (event.key === 'ArrowRight' || event.key === 'Enter' || event.key === ' ') {
      // Enter / Space already activate the focused button; ArrowRight keeps
      // focus in the content pane for further keyboard work.
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        const pane = document.querySelector<HTMLElement>(
          '[data-testid="operations-content"]',
        );
        pane?.focus();
      }
      return;
    } else {
      return;
    }

    const next = destinations[nextIndex];
    if (!next) return;
    selectDestination(next.id);
    queueMicrotask(() => {
      const el = document.querySelector<HTMLElement>(
        `[data-testid="operations-nav-item"][data-destination="${next.id}"]`,
      );
      el?.focus();
    });
  }
</script>

<section
  class="company-operations-panel"
  aria-label="Company operations"
  data-testid="company-operations-panel"
  data-destination={activeDestination}
>
  <header class="ops-header">
    <div class="ops-heading title-stack">
      <h2 class="ops-title">Operations</h2>
      <span class="ops-meta" data-testid="operations-scope-meta">
        Scoped · activity, deployments, secrets, settings
      </span>
    </div>
  </header>

  <!-- data-detail-open stays false so the compact nav never collapses away on
       narrow widths (list-detail hides list-pane when true). Responsive wrap
       is handled by ops CSS instead. -->
  <div
    class="list-detail operations-workspace"
    data-testid="operations-workspace"
    data-detail-open="false"
  >
    <aside class="list-pane ops-nav-pane" data-testid="operations-nav-pane">
      <div
        class="ops-nav"
        aria-label="Company operations destinations"
        data-testid="operations-nav"
        role="listbox"
        tabindex="-1"
        aria-orientation="vertical"
        onkeydown={handleNavKeydown}
      >
        {#each destinations as dest (dest.id)}
          {@const isSelected = dest.id === activeDestination}
          <button
            type="button"
            class="ops-nav-item"
            class:is-selected={isSelected}
            role="option"
            aria-selected={isSelected}
            tabindex={isSelected ? 0 : -1}
            data-testid="operations-nav-item"
            data-destination={dest.id}
            aria-label={dest.label}
            onclick={() => selectDestination(dest.id)}
          >
            <span class="ops-nav-label title-stack">
              <span class="ops-nav-title">{dest.label}</span>
              <span class="ops-nav-meta">{dest.meta}</span>
            </span>
          </button>
        {/each}
      </div>
    </aside>

    <div
      class="detail-pane ops-content-pane"
      data-testid="operations-content"
      tabindex="-1"
    >
      {#if activeDestination === 'activity'}
        <ActivityPanel {slug} {cloudBacked} />
      {:else if activeDestination === 'deployments'}
        <DeploymentsPanel {slug} {cloudBacked} />
      {:else if activeDestination === 'secrets'}
        <SecretsPanel {slug} {cloudBacked} />
      {:else}
        <section
          class="ops-settings"
          aria-labelledby="ops-settings-title"
          data-testid="operations-settings"
        >
          <header class="ops-settings-header">
            <div class="title-stack">
              <h2 id="ops-settings-title" class="ops-settings-title">Company settings</h2>
              <span class="ops-settings-meta">
                Identity, sync rules, and membership live in the HQ console
              </span>
            </div>
            <div
              class="ops-settings-actions detail-primary-actions primary-actions"
              data-testid="operations-settings-actions"
            >
              <button
                type="button"
                class="ops-settings-button"
                data-testid="operations-open-console-settings"
                aria-label="Open company settings in HQ console"
                onclick={openCompanySettings}
              >
                Open console
              </button>
            </div>
          </header>

          <div class="ops-settings-list" data-testid="operations-settings-list">
            <div class="ops-settings-row">
              <span class="ops-settings-row-copy title-stack">
                <span class="ops-settings-row-title">Identity</span>
                <span class="ops-settings-row-meta">Company name, slug, and cloud membership</span>
              </span>
              <button
                type="button"
                class="ops-settings-row-action"
                data-testid="operations-settings-identity"
                onclick={openCompanySettings}
              >
                Open
              </button>
            </div>
            <div class="ops-settings-row">
              <span class="ops-settings-row-copy title-stack">
                <span class="ops-settings-row-title">Sync rules</span>
                <span class="ops-settings-row-meta">What syncs for this company vault</span>
              </span>
              <button
                type="button"
                class="ops-settings-row-action"
                data-testid="operations-settings-sync"
                onclick={openCompanySettings}
              >
                Open
              </button>
            </div>
            <div class="ops-settings-row">
              <span class="ops-settings-row-copy title-stack">
                <span class="ops-settings-row-title">Members and roles</span>
                <span class="ops-settings-row-meta">Humans, agents, and access in console</span>
              </span>
              <button
                type="button"
                class="ops-settings-row-action"
                data-testid="operations-settings-members"
                onclick={openCompanySettings}
              >
                Open
              </button>
            </div>
          </div>
        </section>
      {/if}
    </div>
  </div>
</section>

<style>
  .company-operations-panel {
    display: flex;
    flex-direction: column;
    gap: var(--v4-space-4, 16px);
    min-width: 0;
    min-height: 0;
    height: 100%;
    font-family: var(--font-sans);
    background: transparent;
  }

  .ops-header {
    display: flex;
    flex: 0 0 auto;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--v4-space-4, 16px);
    min-width: 0;
  }

  .ops-heading {
    min-width: 0;
  }

  .title-stack {
    display: grid;
    gap: var(--v4-row-stack-gap, 3px);
    min-width: 0;
  }

  .ops-title {
    margin: 0;
    color: var(--v4-text-1);
    font-size: var(--type-detail, 18px);
    font-weight: 600;
    line-height: 1.2;
  }

  .ops-meta {
    margin: 0;
    overflow: hidden;
    color: var(--v4-text-3);
    font-size: var(--type-secondary, 11px);
    font-weight: 400;
    line-height: 1.3;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Naked canvas: hairline list/detail — no rounded outer shell. */
  .operations-workspace {
    flex: 1 1 auto;
    min-height: 0;
    min-width: 0;
    border: 1px solid var(--v4-hairline);
    border-radius: 0;
    background: transparent;
    overflow: hidden;
  }

  .ops-nav-pane {
    display: flex;
    flex: 0 0 185px;
    flex-direction: column;
    min-height: 0;
    width: 185px;
    max-width: 38%;
    border-right: 1px solid var(--v4-hairline);
    background: transparent;
  }

  .ops-nav {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    gap: 2px;
    min-height: 0;
    overflow-y: auto;
    padding: 8px;
  }

  .ops-nav-item {
    display: flex;
    align-items: center;
    width: 100%;
    min-height: 40px;
    padding: 8px 10px;
    border: 0;
    border-radius: 0;
    background: transparent;
    color: var(--v4-text-2);
    font: inherit;
    font-size: var(--type-body, 12px);
    text-align: left;
    cursor: pointer;
    transition: background 140ms ease;
  }

  .ops-nav-item:hover {
    background: var(--v4-active-row);
  }

  .ops-nav-item.is-selected {
    background: var(--v4-active-row);
    color: var(--v4-text-1);
    border-radius: 6px;
  }

  .ops-nav-item:focus-visible,
  .ops-settings-button:focus-visible,
  .ops-settings-row-action:focus-visible {
    outline: 2px solid var(--v4-text-1);
    outline-offset: 2px;
  }

  .ops-nav-label {
    min-width: 0;
    flex: 1 1 auto;
  }

  .ops-nav-title {
    overflow: hidden;
    color: inherit;
    font-size: var(--type-body, 12px);
    font-weight: 500;
    line-height: 1.25;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ops-nav-meta {
    overflow: hidden;
    color: var(--v4-text-3);
    font-size: var(--type-metadata, 10px);
    font-weight: 400;
    line-height: 1.3;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ops-content-pane {
    min-width: 0;
    min-height: 0;
    overflow: auto;
    padding: var(--v4-space-4, 16px);
    background: transparent;
  }

  .ops-settings {
    display: flex;
    flex-direction: column;
    gap: var(--v4-space-4, 16px);
    min-width: 0;
  }

  .ops-settings-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--v4-space-4, 16px);
    min-width: 0;
  }

  .ops-settings-title {
    margin: 0;
    color: var(--v4-text-1);
    font-size: var(--type-section, 14px);
    font-weight: 600;
    line-height: 1.2;
  }

  .ops-settings-meta {
    color: var(--v4-text-3);
    font-size: var(--type-secondary, 11px);
    line-height: 1.3;
  }

  .ops-settings-actions {
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    gap: 8px;
  }

  .ops-settings-button {
    flex: 0 0 auto;
    height: 30px;
    padding: 0 12px;
    border: 1px solid transparent;
    border-radius: var(--v4-radius-button);
    background: var(--v4-primary-bg);
    color: var(--v4-primary-fg);
    font: inherit;
    font-size: var(--type-body, 12px);
    font-weight: 500;
    line-height: 30px;
    cursor: pointer;
  }

  .ops-settings-list {
    display: grid;
    min-width: 0;
    border: 1px solid var(--v4-hairline);
    border-radius: 0;
    background: transparent;
    overflow: hidden;
  }

  .ops-settings-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 12px;
    min-width: 0;
    padding: 12px 14px;
    border-top: 1px solid var(--v4-hairline);
  }

  .ops-settings-row:first-child {
    border-top: 0;
  }

  .ops-settings-row-title {
    overflow: hidden;
    color: var(--v4-text-1);
    font-size: var(--type-body, 12px);
    font-weight: 500;
    line-height: 1.25;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ops-settings-row-meta {
    overflow: hidden;
    color: var(--v4-text-3);
    font-size: var(--type-metadata, 10px);
    line-height: 1.3;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ops-settings-row-action {
    height: 28px;
    padding: 0 11px;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-button);
    background: transparent;
    color: var(--v4-text-1);
    font: inherit;
    font-size: var(--type-body, 12px);
    font-weight: 500;
    cursor: pointer;
  }

  .ops-settings-row-action:hover {
    background: var(--v4-active-row);
  }

  @media (max-width: 820px) {
    .operations-workspace {
      flex-direction: column;
    }

    .ops-nav-pane {
      flex: 0 0 auto;
      width: 100%;
      max-width: none;
      border-right: 0;
      border-bottom: 1px solid var(--v4-hairline);
    }

    .ops-nav {
      flex-direction: row;
      flex-wrap: wrap;
      overflow-x: auto;
      overflow-y: hidden;
      padding: 6px;
    }

    .ops-nav-item {
      flex: 1 1 auto;
      min-width: max-content;
      min-height: 36px;
    }

    .ops-nav-meta {
      display: none;
    }

    .ops-settings-header {
      flex-wrap: wrap;
    }

    .ops-settings-actions {
      width: 100%;
    }
  }

  @media (max-width: 720px) {
    .ops-content-pane {
      padding: 12px;
    }

    .ops-settings-row {
      grid-template-columns: minmax(0, 1fr);
      gap: 8px;
    }

    .ops-settings-row-action {
      justify-self: start;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .ops-nav-item {
      transition: none;
    }
  }

  @media (prefers-reduced-transparency: reduce) {
    .company-operations-panel,
    .operations-workspace,
    .ops-nav-pane,
    .ops-content-pane,
    .ops-settings-list {
      background: var(--v4-ground);
    }
  }
</style>
