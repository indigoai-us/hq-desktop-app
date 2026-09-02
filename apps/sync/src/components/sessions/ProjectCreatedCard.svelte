<script lang="ts">
  /**
   * "Project X was created · Create its channel?"
   *
   * The Rust project watch notices a `prd.json` HQ wrote while THIS session
   * was live, binds the session to it, and emits `agent-session:project-created`.
   * This card is the offer that follows. Creating a channel is outward-facing
   * — a channel other people can see — so it happens only on the confirm
   * click, through the same `session_share_to_channel` path the share dialog
   * uses (`target: new` from the project path, no transcript, no invites).
   * When the project already has a channel there is nothing to create: the
   * card just says the session is linked.
   */
  import { onMount } from 'svelte';
  import { listen } from '@tauri-apps/api/event';

  import { safeUnlisten } from '../../lib/listener-registry';
  import { liveSessionStore } from '../../desktop-alt/lib/live-session-store.svelte';
  import {
    linkForProject,
    loadSessionProjectLinks,
    PROJECT_CHANNEL_LINKED_EVENT,
    PROJECT_CREATED_EVENT,
    type ProjectChannelLinked,
    type ProjectCreatedNotice,
  } from '../../desktop-alt/lib/session-project-links';

  interface Props {
    /** The session on screen — notices for any other session are ignored. */
    sessionId?: string | null;
    onopenchannel?: (channelId: string) => void;
  }

  let { sessionId = null, onopenchannel }: Props = $props();

  type CardState =
    | { kind: 'hidden' }
    | { kind: 'offer'; notice: ProjectCreatedNotice }
    | { kind: 'creating'; notice: ProjectCreatedNotice }
    | {
        kind: 'linked';
        notice: ProjectCreatedNotice;
        channelId: string;
        channelName: string;
        created: boolean;
      }
    | { kind: 'error'; notice: ProjectCreatedNotice; message: string };

  let card = $state<CardState>({ kind: 'hidden' });
  /** Bumped per notice, so a slow pre-check cannot settle a newer offer. */
  let arrival = 0;

  onMount(() => {
    const attached = listen<ProjectCreatedNotice>(PROJECT_CREATED_EVENT, ({ payload }) => {
      if (!payload || !sessionId || payload.sessionId !== sessionId) return;
      void arrive(payload);
    }).catch(() => () => {});
    return () => {
      void attached.then((unlisten) => safeUnlisten(unlisten)());
    };
  });

  /** Offer at once; then, if the project already has a channel, just link. */
  async function arrive(notice: ProjectCreatedNotice): Promise<void> {
    const mine = ++arrival;
    card = { kind: 'offer', notice };
    try {
      const links = await loadSessionProjectLinks(notice.company);
      const link = linkForProject(links, notice.project);
      if (card.kind !== 'offer' || mine !== arrival) return;
      if (link?.channelId) {
        settle(notice, link.channelId, link.channelName ?? link.channelId, false);
      }
    } catch {
      // The offer stands; the confirm click resolves it either way.
    }
  }

  function settle(
    notice: ProjectCreatedNotice,
    channelId: string,
    channelName: string,
    created: boolean,
  ): void {
    card = { kind: 'linked', notice, channelId, channelName, created };
    const detail: ProjectChannelLinked = {
      company: notice.company,
      project: notice.project,
      channelId,
      channelName,
    };
    window.dispatchEvent(new CustomEvent(PROJECT_CHANNEL_LINKED_EVENT, { detail }));
  }

  /** The ONE outward call, and only from this click. */
  async function confirm(): Promise<void> {
    if (card.kind !== 'offer' || !sessionId) return;
    const notice = card.notice;
    card = { kind: 'creating', notice };
    try {
      const result = await liveSessionStore.shareToChannel({
        sessionId,
        company: notice.company,
        target: { kind: 'new', name: '', projectPath: notice.projectPath },
        inviteUids: [],
        includeTranscript: false,
      });
      settle(notice, result.channelId, result.channelName, result.created);
    } catch (err) {
      card = {
        kind: 'error',
        notice,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  function retry(): void {
    if (card.kind !== 'error') return;
    card = { kind: 'offer', notice: card.notice };
  }

  function dismiss(): void {
    card = { kind: 'hidden' };
  }
</script>

{#if card.kind !== 'hidden'}
  <div
    class="project-card"
    role="status"
    data-testid="session-project-created"
    data-state={card.kind}
    data-project={card.notice.project}
  >
    {#if card.kind === 'linked'}
      <span class="text">
        Project <strong>{card.notice.project}</strong>
        {card.created ? 'has its channel' : 'is linked'} ·
        <span class="channel" data-testid="session-project-channel">#{card.channelName}</span>
      </span>
      <button
        type="button"
        class="action"
        data-testid="session-project-open-channel"
        onclick={() => onopenchannel?.((card as { channelId: string }).channelId)}
      >
        Open channel
      </button>
    {:else if card.kind === 'error'}
      <span class="text error">Couldn't create the channel: {card.message}</span>
      <button type="button" class="action" data-testid="session-project-retry" onclick={retry}>
        Try again
      </button>
    {:else}
      <span class="text">
        Project <strong>{card.notice.project}</strong> was created · Create its channel?
      </span>
      <button
        type="button"
        class="action primary"
        data-testid="session-project-create-channel"
        disabled={card.kind === 'creating'}
        aria-busy={card.kind === 'creating' ? 'true' : undefined}
        onclick={() => void confirm()}
      >
        {card.kind === 'creating' ? 'Creating…' : 'Create channel'}
      </button>
    {/if}
    <button
      type="button"
      class="dismiss"
      aria-label="Dismiss"
      data-testid="session-project-dismiss"
      onclick={dismiss}
    >
      ×
    </button>
  </div>
{/if}

<style>
  .project-card {
    display: flex;
    align-items: center;
    gap: var(--v4-space-2);
    flex: none;
    box-sizing: border-box;
    width: 100%;
    max-width: calc(760px + 2 * var(--v4-space-4));
    margin: 0 auto;
    padding: var(--v4-space-2) var(--v4-space-4) 0;
    font-family: var(--font-sans);
    font-size: var(--type-metadata);
    color: var(--v4-text-2);
  }

  .text {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .text strong,
  .channel {
    color: var(--v4-text-1);
    font-weight: 600;
  }

  .error {
    color: var(--v4-text-1);
  }

  .action {
    flex: none;
    height: 22px;
    padding: 0 8px;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-pill, 999px);
    background: transparent;
    color: var(--v4-text-1);
    font-family: inherit;
    font-size: 11px;
    cursor: pointer;
  }

  .action:hover:not(:disabled) {
    background: var(--v4-active-row);
  }

  .action:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .dismiss {
    margin-left: auto;
    width: 22px;
    height: 22px;
    border: 0;
    border-radius: var(--v4-radius-button);
    background: transparent;
    color: var(--v4-text-3);
    font-family: inherit;
    font-size: 14px;
    line-height: 1;
    cursor: pointer;
  }

  .dismiss:hover {
    color: var(--v4-text-1);
    background: var(--v4-active-row);
  }
</style>
