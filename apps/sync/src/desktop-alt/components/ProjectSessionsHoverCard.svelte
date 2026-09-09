<script lang="ts">
  /**
   * The sidebar hover card for a project channel: the sessions bound to that
   * project, live ones first with a phase dot, then recent ones. Mounted by
   * `@hq/ui`'s `rowExtras` seam with the hovered row only; everything else
   * comes from the host's own store, so the shell never learns what a
   * session is.
   */
  import { dispatchEmbeddedNavigation, type ConversationRow } from '@hq/ui';

  import { projectLinksStore } from '../lib/project-links-store.svelte';
  import {
    linkForRow,
    historySessionParam,
    newSessionParam,
    type LinkedSession,
  } from '../lib/session-project-links';

  interface Props {
    row: ConversationRow;
    /** The company slug the row belongs to (resolved by the shell). */
    company?: string | null;
  }

  let { row, company = null }: Props = $props();

  const link = $derived(
    company
      ? linkForRow(row, projectLinksStore.linksFor(company))
      : Object.values(projectLinksStore.byCompany)
          .map((links) => linkForRow(row, links))
          .find((found) => found !== null) ?? null,
  );
  const companySlug = $derived(
    company ??
      Object.entries(projectLinksStore.byCompany).find(
        ([, links]) => linkForRow(row, links) !== null,
      )?.[0] ??
      null,
  );

  const PHASE_LABEL: Record<string, string> = {
    starting: 'Starting',
    idle: 'Idle',
    working: 'Working',
    needsYou: 'Needs you',
    ended: 'Ended',
  };

  function when(session: LinkedSession): string {
    const at = Date.parse(session.startedAt);
    if (!Number.isFinite(at)) return '';
    const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000));
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
  }

  function openSession(session: LinkedSession): void {
    if (!link || !companySlug) return;
    dispatchEmbeddedNavigation({
      kind: 'extra',
      page: 'sessions',
      param: historySessionParam(companySlug, link.project, session),
    });
  }

  function newSession(): void {
    if (!link || !companySlug) return;
    dispatchEmbeddedNavigation({
      kind: 'extra',
      page: 'sessions',
      param: newSessionParam(companySlug, link.project, link.channelId),
    });
  }
</script>

<div class="card" data-testid="project-sessions-card" data-project={link?.project ?? ''}>
  {#if link}
    <div class="head">
      <span class="name">{link.projectName}</span>
      <button type="button" class="new" data-testid="project-sessions-new" onclick={newSession}>
        New session
      </button>
    </div>
    {#if link.sessions.length === 0}
      <p class="empty">No sessions yet.</p>
    {:else}
      <ul class="list">
        {#each link.sessions as session (session.sessionId)}
          <li>
            <button
              type="button"
              class="session"
              data-testid="project-sessions-open"
              data-session-id={session.sessionId}
              onclick={() => openSession(session)}
            >
              <span class="dot" data-phase={session.phase} aria-hidden="true"></span>
              <span class="label">
                {session.title ?? `${session.tool === 'codex' ? 'Codex' : session.tool === 'grok' ? 'Grok' : 'Claude'} session`}
              </span>
              <span class="meta">
                {PHASE_LABEL[session.phase] ?? session.phase}{when(session) ? ` · ${when(session)}` : ''}
              </span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  {:else}
    <p class="empty">No project linked to this channel.</p>
  {/if}
</div>

<style>
  .card {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-family: var(--font-sans);
    font-size: var(--type-metadata, 12px);
    color: var(--v4-text-2);
  }

  .head {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 600;
    color: var(--v4-text-1);
  }

  .new {
    flex: none;
    height: 22px;
    padding: 0 8px;
    border: 1px solid var(--v4-hairline);
    border-radius: 999px;
    background: transparent;
    color: var(--v4-text-1);
    font: inherit;
    font-size: 11px;
    cursor: pointer;
  }

  .new:hover {
    background: var(--v4-active-row);
  }

  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .session {
    display: grid;
    grid-template-columns: 8px 1fr;
    grid-template-rows: auto auto;
    column-gap: 8px;
    align-items: center;
    width: 100%;
    padding: 4px 6px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .session:hover {
    background: var(--v4-active-row);
  }

  .dot {
    grid-row: 1 / span 2;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--v4-text-3);
  }

  .dot[data-phase='working'] {
    background: var(--v4-accent, #7c9cff);
  }

  .dot[data-phase='needsYou'] {
    background: var(--v4-warning, #e0a33b);
  }

  .dot[data-phase='idle'],
  .dot[data-phase='starting'] {
    background: var(--v4-success, #5fbf7a);
  }

  .label {
    color: var(--v4-text-1);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .meta {
    grid-column: 2;
    font-size: 11px;
    color: var(--v4-text-3);
  }

  .empty {
    margin: 0;
    color: var(--v4-text-3);
  }
</style>
