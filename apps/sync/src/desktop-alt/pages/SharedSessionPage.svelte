<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import SessionTranscript from '../../components/sessions/SessionTranscript.svelte';
  import { foldSessionEvents } from '../../components/sessions/transcript-adapter';
  import { readSharedSession, type SharedMessage } from '../lib/shared-project-sessions';
  let { channelId, sessionId }: { channelId: string; sessionId: string } = $props();
  let title = $state('Shared session');
  let messages = $state<SharedMessage[]>([]);
  let loading = $state(true);
  let error = $state('');
  let revision = 0;
  let busy = $state(false);
  let nextSequence = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  const blocks = $derived(foldSessionEvents(messages.map(message => message.role === 'user'
    ? { kind: 'userMessage' as const, text: message.text, imageCount: 0 }
    : { kind: 'assistantMessage' as const, text: message.text, parentToolUseId: null })).blocks);

  async function refresh(mine: number) {
    if (busy) return;
    busy = true;
    try {
      let after: number | null = nextSequence;
      do {
        const page = await readSharedSession(channelId, sessionId, after);
        if (mine !== revision) return;
        title = page.session.title;
        const seen = new Set(messages.map(message => message.sequence));
        messages = [...messages, ...page.messages.filter(message => !seen.has(message.sequence))];
        nextSequence = Math.max(nextSequence, ...page.messages.map(message => message.sequence + 1));
        if (page.nextCursor !== null && page.nextCursor <= after) throw new Error('Invalid transcript page');
        after = page.nextCursor;
      } while (after !== null);
      error = '';
    } catch {
      if (mine !== revision) return;
      // Fail closed, including already displayed text, when membership can no
      // longer be verified. No offline cache of another person's transcript.
      messages = [];
      title = 'Shared session';
      nextSequence = 0;
      error = 'This session is unavailable. Check your connection and project membership.';
    } finally {
      if (mine === revision) { loading = false; busy = false; }
    }
  }
  $effect(() => {
    channelId; sessionId;
    const mine = ++revision;
    messages = []; nextSequence = 0; loading = true; busy = false;
    untrack(() => void refresh(mine));
    timer = setInterval(() => void refresh(mine), 10_000);
    return () => { ++revision; clearInterval(timer); };
  });
  onDestroy(() => { ++revision; clearInterval(timer); messages = []; });
</script>

<section class="shared-session" aria-label="Read-only shared session">
  <header><span>{title}</span><span class="access">Read only · Project members</span></header>
  {#if error}
    <div role="alert">{error} <button onclick={() => refresh(revision)} disabled={busy}>Retry</button></div>
  {/if}
  <SessionTranscript {blocks} {loading} emptyHint="No shared messages yet." />
  <footer>Only the session owner can continue this conversation.</footer>
</section>

<style>
  .shared-session { display: flex; flex-direction: column; min-width: 0; min-height: 0; height: 100%; }
  header { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 16px 24px; border-bottom: 1px solid var(--session-border, #333); }
  .access, footer { color: var(--session-muted, #999); font-size: 13px; }
  footer { padding: 12px 24px; }
  [role='alert'] { padding: 12px 24px; font-size: 13px; }
</style>
