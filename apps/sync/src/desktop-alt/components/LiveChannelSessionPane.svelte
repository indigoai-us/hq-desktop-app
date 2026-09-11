<script lang="ts">
  /**
   * Channel Session is the real Sessions page in the thread column.
   */
  import SessionsPage from '../pages/SessionsPage.svelte';
  import { dispatchEmbeddedNavigation } from '@hq/ui';
  import type { SessionThread } from '@hq/ui';
  import { liveSessionStore } from '../lib/live-session-store.svelte';

  interface Props {
    thread: SessionThread;
    starting?: boolean;
    startError?: string | null;
  }

  let { thread, starting = false, startError = null }: Props = $props();

  const sessionId = $derived(thread.liveSessionId ?? null);
  let sawWorking = $state(false);

  $effect(() => {
    const id = sessionId;
    if (!id || liveSessionStore.activeSessionId !== id) return;
    const phase = liveSessionStore.phase;
    if (phase === 'working') sawWorking = true;
    if (!sawWorking) return;
    if (phase === 'idle' || phase === 'ended') {
      window.dispatchEvent(
        new CustomEvent('hq-channel-session-status', {
          detail: { sessionId: id, status: 'finished' },
        }),
      );
    }
  });
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
