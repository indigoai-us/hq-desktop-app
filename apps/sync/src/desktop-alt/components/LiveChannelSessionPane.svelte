<script lang="ts">
  /**
   * Real Sessions transcript + composer, sized for the channel side pane.
   */
  import SessionComposer from '../../components/sessions/SessionComposer.svelte';
  import SessionTranscript from '../../components/sessions/SessionTranscript.svelte';
  import { liveSessionStore } from '../lib/live-session-store.svelte';
  import type { SessionThread } from '@hq/ui';

  interface Props {
    thread: SessionThread;
    starting?: boolean;
    startError?: string | null;
  }

  let { thread, starting = false, startError = null }: Props = $props();

  const sessionId = $derived(thread.liveSessionId ?? null);

  $effect(() => {
    const id = sessionId;
    if (id) liveSessionStore.activate(id);
  });

  const transcript = $derived(liveSessionStore.transcript);
  const phase = $derived(liveSessionStore.phase);
  const summary = $derived(liveSessionStore.summary);

  async function onSend(text: string): Promise<void> {
    if (!sessionId) return;
    await liveSessionStore.send(text);
  }
</script>

<div class="live-pane" data-testid="live-channel-session-pane" data-session-id={sessionId ?? ''}>
  {#if startError}
    <p class="note error" data-testid="live-channel-session-error">{startError}</p>
  {:else if starting || !sessionId}
    <p class="note" data-testid="live-channel-session-starting">Starting session…</p>
  {/if}

  <div class="transcript">
    <SessionTranscript
      blocks={transcript.blocks}
      status={phase === 'working' ? 'tools' : starting ? 'starting' : ''}
      loading={Boolean(sessionId) && liveSessionStore.loading && transcript.blocks.length === 0}
      hasEarlier={liveSessionStore.hasEarlier}
      loadingEarlier={liveSessionStore.loadingEarlier}
      onloadearlier={() => liveSessionStore.loadEarlier()}
      emptyHint={starting ? '' : 'Send a follow-up.'}
      onallowonce={(requestId) =>
        void liveSessionStore.respondPermission(requestId, { kind: 'allowOnce' })}
      onallowsession={(requestId) =>
        void liveSessionStore.respondPermission(requestId, { kind: 'allowSession' })}
      ondenypermission={(requestId, message) =>
        void liveSessionStore.respondPermission(requestId, { kind: 'deny', message })}
      onanswerquestion={(requestId, answers) =>
        void liveSessionStore.answerQuestion(requestId, answers)}
    />
  </div>

  <div class="composer">
    <SessionComposer
      working={phase === 'working'}
      disabled={!sessionId}
      placeholder="Prompt this session…"
      company={summary?.company ?? null}
      project={summary?.project ?? null}
      tool={summary?.tool ?? 'grok'}
      onsend={(text) => void onSend(text)}
      onstop={() => void liveSessionStore.interrupt()}
    />
  </div>
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

  .transcript {
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  .composer {
    flex-shrink: 0;
    border-top: 1px solid var(--line, rgba(255, 255, 255, 0.08));
  }
</style>
