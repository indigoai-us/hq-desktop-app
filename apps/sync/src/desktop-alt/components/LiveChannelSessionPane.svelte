<script lang="ts">
  /**
   * Channel Session is the real Sessions page in the thread column.
   */
  import SessionsPage from '../pages/SessionsPage.svelte';
  import { dispatchEmbeddedNavigation } from '@hq/ui';
  import type { SessionThread } from '@hq/ui';

  interface Props {
    thread: SessionThread;
    starting?: boolean;
    startError?: string | null;
  }

  let { thread, starting = false, startError = null }: Props = $props();

  const sessionId = $derived(thread.liveSessionId ?? null);
</script>

<div class="live-pane" data-testid="live-channel-session-pane" data-session-id={sessionId ?? ''}>
  {#if startError}
    <p class="note error" data-testid="live-channel-session-error">{startError}</p>
  {:else if starting || !sessionId}
    <p class="note" data-testid="live-channel-session-starting">Starting session…</p>
  {:else}
    <SessionsPage
      {sessionId}
      embedded
      onopenchannel={(channelId) => dispatchEmbeddedNavigation({ kind: 'channel', channelId })}
    />
  {/if}
</div>

<style>
  .live-pane {
    display: flex;
    flex-direction: column;
    min-height: 0;
    flex: 1;
  }

  .note {
    margin: 0;
    padding: 8px 16px;
    font-size: 12px;
    color: var(--t3, #9a9aa3);
  }

  .note.error {
    color: var(--v4-error, #e88);
  }
</style>
