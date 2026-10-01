<script lang="ts">
  import { onMount } from "svelte";
  import {
    applyWakingStatus,
    recordWakingCheckFailure,
    WAKING_POLL_MS,
    wakingStatusLine,
    type WakingBotSession,
  } from "./waking-model.js";

  interface Props {
    session: WakingBotSession;
    getStatus: ((agentUid: string) => Promise<unknown>) | null;
    onupdate: (session: WakingBotSession) => void;
    onclose: () => void;
    onretry: () => void;
    onopenchat: () => void;
  }

  let { session, getStatus, onupdate, onclose, onretry, onopenchat }: Props = $props();

  const initials = $derived(
    session.name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((word) => word[0]?.toUpperCase() ?? "")
      .join("") || "B",
  );
  const statusLine = $derived(wakingStatusLine(session));

  onMount(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function check(): Promise<void> {
      if (stopped || session.phase !== "waking") return;
      if (!getStatus || !session.agentUid) {
        timer = setTimeout(() => void check(), WAKING_POLL_MS);
        return;
      }
      try {
        const result = await getStatus(session.agentUid);
        if (stopped) return;
        const response = result as { ok?: unknown; value?: unknown };
        const next = response && response.ok === true
          ? applyWakingStatus(session, response.value)
          : recordWakingCheckFailure(session);
        onupdate(next);
      } catch {
        if (!stopped) onupdate(recordWakingCheckFailure(session));
      }
      if (!stopped && session.phase === "waking") timer = setTimeout(() => void check(), WAKING_POLL_MS);
    }

    void check();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  });
</script>

<section class="new-bot-waking" data-testid="new-bot-waking-screen" aria-live="polite">
  <div
    class="new-bot-waking-ring"
    data-testid="new-bot-waking-ring"
    style={`--waking-progress: ${session.progress}%`}
    aria-label={`${session.progress}% complete`}
  >
    <span class="new-bot-waking-avatar">{initials}</span>
  </div>
  <p class="new-bot-takeover-kicker">A new teammate</p>
  <h1 id="new-bot-takeover-title">Waking up <em>{session.name}</em></h1>
  <p class="new-bot-waking-status" data-testid="new-bot-waking-status">{statusLine}</p>

  {#if session.phase === "failed"}
    <button type="button" class="new-bot-waking-action" data-testid="new-bot-waking-retry" onclick={onretry}>Try again</button>
  {:else}
    <button type="button" class="new-bot-waking-link" data-testid="new-bot-waking-open-chat" onclick={onopenchat}>Open chat now</button>
  {/if}

  <button type="button" class="new-bot-waking-close" data-testid="new-bot-waking-close" onclick={onclose}>Close</button>
</section>
