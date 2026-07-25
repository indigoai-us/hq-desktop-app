<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import { listen } from '@tauri-apps/api/event';
  import { buildClaudeCodeUrl } from '../lib/claude-code-link';
  import { shareAclLabel, sharePathPrefix, shareTitle } from '../lib/share-path';
  import { buildSharePrompt } from '../lib/shareTimeline';
  import type { ShareEvent } from '../lib/notificationGroups';
  import type { ReactionEvent } from '../lib/reactions';
  import { ShareReactionController } from '../lib/shareReactionController.svelte';
  import ReactionBar from './messaging/ReactionBar.svelte';

  // Main content for share-detail, Messages shell share rows, and when a share
  // is selected from the quick-window side pane. Shared payload surface shows
  // sender, tenant-scoped path/prefix, timestamp, ACL truth, and current
  // actions (copy prompt / Open in Claude / Message sharer) without inventing
  // file-transfer chrome.

  interface Props {
    events: ShareEvent[];
  }

  let { events }: Props = $props();

  let copyFeedback = $state<string | null>(null);

  // Share reactions: one controller for the pane; map keyed by share eventId.
  const reactionCtl = new ShareReactionController();
  $effect(() => {
    void reactionCtl.setShares(events.map((e) => e.eventId));
  });

  function formatDate(iso: string): string {
    try {
      return new Intl.DateTimeFormat(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(new Date(iso));
    } catch {
      return iso;
    }
  }

  // Prompt template lives in lib/shareTimeline.ts (shared with the Messages
  // share bubbles) so both surfaces copy identical text.
  const buildPrompt = buildSharePrompt;

  // "Message the sharer": open the Messages experience in a DM with the
  // issuer. Prefers the canonical issuerPersonUid; a legacy row (empty uid)
  // falls back to the email-addressed compose flow inside the shell.
  async function messageSharer(evt: ShareEvent): Promise<void> {
    try {
      await invoke('open_messages_window', {
        target: {
          personUid: evt.issuerPersonUid ?? '',
          email: evt.issuerEmail,
          displayName: evt.issuerDisplayName,
        },
      });
    } catch (err) {
      console.error('share-notify ShareMainPane: open_messages_window failed', err);
    }
  }

  async function copyPrompt(evt: ShareEvent): Promise<void> {
    try {
      await navigator.clipboard.writeText(buildPrompt(evt));
      copyFeedback = evt.eventId;
      setTimeout(() => {
        copyFeedback = null;
      }, 1800);
    } catch (err) {
      console.error('Clipboard write failed:', err);
    }
  }

  async function openInClaude(evt: ShareEvent): Promise<void> {
    // Open Claude Code with the templated prompt pre-filled and cwd at
    // the user's HQ folder. Same UX as the notification body-click in
    // App.svelte; we deep-link via the `open_claude_code_link` Tauri
    // command (which validates the `claude://` scheme).
    //
    // We don't have a working hq-console deep-link surface for shared
    // files yet, and the recipient almost always wants to act on the
    // share in an LLM session anyway — so "Open in Claude" is the
    // higher-leverage secondary CTA than the previous "Open in HQ
    // Console" (user direction 2026-05-26).
    //
    // Folder comes from `get_config().hqFolderPath` — fetched lazily
    // per click so we don't have to wire config state into this
    // secondary window. If the call fails the URL still parses (folder
    // defaults to empty) and Claude opens at its last cwd.
    let folder = '';
    try {
      const cfg = await invoke<{ hqFolderPath: string }>('get_config');
      folder = cfg.hqFolderPath ?? '';
    } catch {
      // Best-effort — proceed without folder.
    }
    try {
      const url = buildClaudeCodeUrl({ folder, prompt: buildPrompt(evt) });
      await invoke('open_claude_code_link', { url });
    } catch (err) {
      console.error('share-notify ShareMainPane: open_claude_code_link failed', err);
    }
  }

  $effect(() => {
    // Disposed flag: side-pane swaps can unmount this pane before listen()
    // resolves — run a late unlisten immediately so the handler can't leak.
    let disposed = false;
    let unlistenReaction: (() => void) | undefined;

    // Live reaction updates for the visible shares (the single DM poll path
    // re-fetches watched share scopes on a "reaction" wake and emits this).
    listen<ReactionEvent>('message:reaction', (event) => {
      reactionCtl.applyEvent(event.payload);
    }).then((fn) => {
      if (disposed) fn();
      else unlistenReaction = fn;
    });

    return () => {
      disposed = true;
      unlistenReaction?.();
      reactionCtl.dispose();
    };
  });
</script>

{#if events.length === 0}
  <div class="detail-empty">
    <p>Waiting for share data…</p>
  </div>
{:else}
  <div class="events-list" data-testid="share-main-pane">
    {#each events as evt (evt.eventId)}
      {@const acl = shareAclLabel(evt.permission)}
      <article class="event-card" data-testid="share-payload" aria-label={`Shared path from ${evt.issuerDisplayName}`}>
        <header class="event-header">
          <div class="event-identity">
            <span class="event-issuer">{evt.issuerDisplayName}</span>
            {#if evt.issuerEmail}
              <span class="event-email">{evt.issuerEmail}</span>
            {/if}
          </div>
          <time class="event-date" datetime={evt.createdAt}>{formatDate(evt.createdAt)}</time>
        </header>

        <ul class="paths-list">
          {#each evt.paths as p (p)}
            <li class="path-item" title={p}>
              <span class="path-basename">{shareTitle(p)}</span>
              <span class="path-full">{sharePathPrefix(p)}</span>
            </li>
          {/each}
        </ul>

        {#if acl}
          <p class="event-acl" data-testid="share-acl">{acl}</p>
        {/if}

        {#if evt.note}
          <p class="event-note">{evt.note}</p>
        {/if}

        <ReactionBar
          messageId={evt.eventId}
          reactions={reactionCtl.map[evt.eventId]}
          ontoggle={reactionCtl.toggle}
        />

        <div class="event-actions">
          <button
            class="btn btn-copy"
            onclick={() => copyPrompt(evt)}
            aria-label="Copy prompt to clipboard"
          >
            {copyFeedback === evt.eventId ? 'Copied!' : 'Copy prompt'}
          </button>
          <button
            class="btn btn-console"
            onclick={() => openInClaude(evt)}
            aria-label="Open in Claude Code with prompt"
          >
            Open in Claude ↗
          </button>
          <button
            class="btn btn-console"
            onclick={() => messageSharer(evt)}
            aria-label={`Message ${evt.issuerDisplayName}`}
          >
            Message {evt.issuerDisplayName.split(/\s+/)[0] || 'sharer'}
          </button>
        </div>
      </article>
    {/each}
  </div>
{/if}

<style>
  .detail-empty {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .detail-empty p {
    font-size: var(--type-body, 12px);
    color: var(--pop-muted);
    margin: 0;
  }

  /* Naked canvas payload: spacing + hairlines only — no rounded outer shell.
     Title/meta stacks use an explicit 3px grid gap (DESKTOP-002 / DESKTOP-011). */
  .events-list {
    flex: 1;
    overflow-y: auto;
    padding: 0.75rem 1rem;
    display: flex;
    flex-direction: column;
    gap: 0;
    scrollbar-width: thin;
    scrollbar-color: var(--pop-muted) transparent;
    min-height: 0;
  }

  .events-list::-webkit-scrollbar {
    width: 6px;
  }

  .events-list::-webkit-scrollbar-thumb {
    background: var(--pop-hover);
  }

  .event-card {
    background: transparent;
    border: none;
    border-bottom: 1px solid var(--pop-border, var(--border));
    border-radius: 0;
    padding: 0.875rem 0.25rem 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
  }

  .event-card:last-child {
    border-bottom: none;
  }

  .event-header {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: start;
    gap: 0.5rem;
  }

  .event-identity {
    display: grid;
    grid-template-rows: auto auto;
    grid-template-columns: minmax(0, 1fr);
    gap: var(--v4-row-stack-gap, 3px);
    min-width: 0;
  }

  .event-issuer {
    font-size: var(--type-body, 0.8125rem);
    font-weight: 600;
    color: var(--pop-text, var(--fg));
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .event-email {
    font-size: var(--type-secondary, 0.75rem);
    color: var(--pop-muted, var(--muted));
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .event-date {
    font-size: var(--type-metadata, 0.6875rem);
    color: var(--pop-muted, var(--muted));
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }

  .paths-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .path-item {
    display: grid;
    grid-template-rows: auto auto;
    grid-template-columns: minmax(0, 1fr);
    gap: var(--v4-row-stack-gap, 3px);
    min-width: 0;
  }

  .path-basename {
    font-size: var(--type-body, 0.8125rem);
    font-weight: 500;
    color: var(--pop-text, var(--fg));
  }

  .path-full {
    font-size: var(--type-metadata, 0.6875rem);
    color: var(--pop-muted, var(--muted));
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .event-acl {
    margin: 0;
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: var(--type-metadata, 0.6875rem);
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--pop-muted, var(--muted));
  }

  .event-note {
    margin: 0;
    font-size: var(--type-body, 0.8125rem);
    color: var(--pop-text, var(--fg));
    background: var(--pop-hover, var(--row-hover));
    border-left: 2px solid var(--c-field-border, var(--border));
    padding: 0.375rem 0.625rem;
    border-radius: 0;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .event-actions {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .btn {
    display: inline-flex;
    align-items: center;
    padding: 0.375rem 0.75rem;
    border-radius: 6px;
    font-size: var(--type-secondary, 0.75rem);
    font-weight: 500;
    cursor: pointer;
    border: none;
    transition: background-color 0.12s ease, color 0.12s ease;
    font-family: inherit;
  }

  .btn-copy {
    background: var(--pop-hover, var(--row-hover));
    color: var(--pop-text, var(--fg));
  }

  .btn-copy:hover {
    background: var(--c-field-bg, var(--surface-panel));
  }

  .btn-console {
    background: transparent;
    color: var(--pop-muted, var(--muted));
    border: 1px solid var(--pop-border, var(--border));
  }

  .btn-console:hover {
    background: var(--pop-hover, var(--row-hover));
    color: var(--pop-text, var(--fg));
  }

  .btn:focus-visible {
    outline: 2px solid var(--v4-unread, #0a6fd6);
    outline-offset: 2px;
  }
</style>
