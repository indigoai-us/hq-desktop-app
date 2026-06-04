<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import { listen } from '@tauri-apps/api/event';
  import { onMount } from 'svelte';
  import type { Workspace, WorkspacesResult } from '../lib/workspaces';
  import { useCompanySummary } from './lib/company-summary.svelte';
  import { useCompanyBoard } from './lib/company-board.svelte';
  import { BOARD_COLUMNS } from './lib/types';
  import './styles/desktop-alt.css';

  // ── Company OS shell ──────────────────────────────────────────────────────
  // Minimal flagship Company OS surface for the Windows fork: a company-scoped
  // Board (goals / projects / in-flight items grouped into Inbox/Doing/Review/
  // Done) with real summary counts. This is the gated alternate desktop UX
  // (port of upstream #149/#150) — it only ever renders in the `desktop-alt`
  // window, which the Rust gate opens for @getindigo.ai users only.

  // Companies the user can scope to. `null` while the first load is in flight.
  let workspaces = $state<Workspace[] | null>(null);
  let workspaceError = $state<string | null>(null);
  let selectedSlug = $state<string | null>(null);

  // Only company workspaces are board-scoped (Personal has no company board).
  const companies = $derived(
    (workspaces ?? []).filter((w) => w.kind === 'company'),
  );

  const selectedCompany = $derived(
    companies.find((c) => c.slug === selectedSlug) ?? null,
  );

  // Reactive loaders — both carry the zero-stuck refetch fix (see their libs).
  const summary = useCompanySummary({ slug: () => selectedSlug });
  const board = useCompanyBoard({ slug: () => selectedSlug });

  async function loadWorkspaces(): Promise<void> {
    try {
      const result = await invoke<WorkspacesResult>('list_syncable_workspaces');
      workspaces = result.workspaces ?? [];
      workspaceError = result.error ?? null;
      // Auto-select the first company once, so the board paints without a click.
      if (selectedSlug === null) {
        const firstCompany = workspaces.find((w) => w.kind === 'company');
        selectedSlug = firstCompany?.slug ?? null;
      }
    } catch (err) {
      console.error('list_syncable_workspaces failed:', err);
      workspaces = [];
      workspaceError = String(err);
    }
  }

  onMount(() => {
    void loadWorkspaces();

    // Honour a pending route handed in when the window was opened with intent
    // (e.g. a notification). The minimal surface only has the Board today, so
    // we consume + clear the slot to keep the contract with the Rust side even
    // though there's nothing else to navigate to yet.
    void invoke<string | null>('desktop_alt_consume_pending_route').catch(
      () => null,
    );

    // Live navigation for an already-open window. No-op target today, but the
    // listener keeps the desktop:navigate contract intact.
    const unlistenPromise = listen<string>('desktop:navigate', () => {
      // Future: route to the requested screen. Board is the only screen now.
    });

    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  });

  function selectCompany(slug: string): void {
    selectedSlug = slug;
  }
</script>

<div class="desktop-shell">
  <aside class="desktop-sidebar">
    <div class="sidebar-title">Company OS</div>

    <section class="company-section">
      <div class="section-label">Companies</div>
      <div class="company-list">
        {#if workspaces === null}
          <div class="empty-row">Loading…</div>
        {:else if companies.length === 0}
          <div class="empty-row">No companies yet</div>
        {:else}
          <nav class="sidebar-nav">
            {#each companies as company (company.slug)}
              <button
                class:active={company.slug === selectedSlug}
                onclick={() => selectCompany(company.slug)}
              >
                <span>{company.displayName}</span>
              </button>
            {/each}
          </nav>
        {/if}
      </div>
    </section>
  </aside>

  <main class="desktop-main">
    <div class="desktop-main-scroll">
      <div class="page">
        {#if selectedCompany === null}
          <header class="page-header">
            <h1>Company OS</h1>
          </header>
          <div class="placeholder-panel">
            <p>Select a company to see its board.</p>
            {#if workspaceError}
              <span class="workspace-error">Workspace error: {workspaceError}</span>
            {/if}
          </div>
        {:else}
          <header class="page-header">
            <h1>{selectedCompany.displayName}</h1>
            <div class="summary-row" aria-label="Company summary counts">
              <span class="summary-stat">
                <strong>{summary.summary.board}</strong> board
              </span>
              <span class="summary-stat">
                <strong>{summary.summary.activity.last7d}</strong> active 7d
              </span>
              <span class="summary-stat">
                <strong>{summary.summary.deployments}</strong> deployments
              </span>
              <span class="summary-stat">
                <strong>{summary.summary.secrets}</strong> secrets
              </span>
              {#if summary.loading}
                <span class="summary-loading">refreshing…</span>
              {/if}
            </div>
            {#if summary.error}
              <div class="summary-error">{summary.error}</div>
            {/if}
          </header>

          <section class="board" aria-label="Company board">
            {#each BOARD_COLUMNS as column (column.key)}
              {@const cards = board.board[column.key]}
              <div class="board-column">
                <div class="board-column-head">
                  <span class="board-column-name">{column.label}</span>
                  <span class="board-column-count">{cards.length}</span>
                </div>
                <div class="board-column-body">
                  {#if cards.length === 0}
                    <div class="board-empty">—</div>
                  {:else}
                    {#each cards as card (card.id)}
                      <article class="board-card">
                        <div class="board-card-title">{card.title}</div>
                        <div class="board-card-meta">
                          {#if card.tag}
                            <span class="board-card-tag">{card.tag}</span>
                          {/if}
                          {#if card.age}
                            <span class="board-card-age">{card.age}</span>
                          {/if}
                          {#if card.assigneeInitials}
                            <span class="board-card-assignee"
                              >{card.assigneeInitials}</span
                            >
                          {/if}
                        </div>
                      </article>
                    {/each}
                  {/if}
                </div>
              </div>
            {/each}
          </section>

          {#if board.error}
            <div class="summary-error">Board: {board.error}</div>
          {/if}
        {/if}
      </div>
    </div>

    <footer class="desktop-status-bar">
      <span>HQ Company OS</span>
      <span
        >{companies.length} compan{companies.length === 1 ? 'y' : 'ies'}</span
      >
    </footer>
  </main>
</div>

<style>
  /* Component-scoped layout for the minimal Company OS surface. The window
     theme tokens (--bg/--fg/--border/etc.) come from the plain global
     stylesheet `styles/desktop-alt.css` (imported above), scoped to
     html[data-window='desktop-alt']. */
  .summary-row {
    display: flex;
    flex-wrap: wrap;
    gap: 14px;
    align-items: baseline;
    margin-top: 8px;
    color: var(--muted, #71717a);
    font-size: 12px;
  }

  .summary-stat strong {
    color: var(--fg, #fafafa);
    font-size: 14px;
    font-weight: 650;
  }

  .summary-loading {
    color: var(--muted-3, #52525b);
    font-size: 11px;
  }

  .summary-error {
    margin-top: 8px;
    color: var(--amber, #f59e0b);
    font-size: 12px;
  }

  .board {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 14px;
    margin-top: 18px;
  }

  .board-column {
    display: flex;
    flex-direction: column;
    min-width: 0;
    border: 1px solid var(--border, rgba(255, 255, 255, 0.1));
    border-radius: 8px;
    background: var(--row-hover, rgba(255, 255, 255, 0.035));
  }

  .board-column-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 10px;
    border-bottom: 1px solid var(--border, rgba(255, 255, 255, 0.1));
  }

  .board-column-name {
    color: var(--fg, #fafafa);
    font-size: 12px;
    font-weight: 650;
  }

  .board-column-count {
    color: var(--muted, #71717a);
    font-size: 11px;
  }

  .board-column-body {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px;
    min-height: 48px;
  }

  .board-empty {
    color: var(--muted-3, #52525b);
    font-size: 12px;
    text-align: center;
  }

  .board-card {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px;
    border: 1px solid var(--border, rgba(255, 255, 255, 0.1));
    border-radius: 6px;
    background: var(--bg, #0a0a0a);
  }

  .board-card-title {
    color: var(--fg, #fafafa);
    font-size: 13px;
    line-height: 1.3;
  }

  .board-card-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    color: var(--muted, #71717a);
    font-size: 11px;
  }

  .board-card-tag {
    padding: 1px 6px;
    border: 1px solid var(--border, rgba(255, 255, 255, 0.1));
    border-radius: 4px;
  }

  .board-card-assignee {
    margin-left: auto;
    padding: 1px 6px;
    border-radius: 999px;
    background: var(--row-active, rgba(255, 255, 255, 0.06));
    color: var(--muted-2, #a1a1aa);
    font-size: 10px;
    font-weight: 650;
  }
</style>
