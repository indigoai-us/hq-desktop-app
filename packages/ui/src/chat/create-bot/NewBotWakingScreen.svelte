<script lang="ts">
  import { onMount } from "svelte";
  import {
    applyWakingStatus,
    recordWakingCheckFailure,
    WAKING_POLL_MS,
    wakingStatusLine,
    type WakingBotSession,
  } from "./waking-model.js";
  import { focusOnMount } from "../portal.js";

  interface Props {
    session: WakingBotSession;
    getStatus: ((agentUid: string) => Promise<unknown>) | null;
    retryAgent?: ((agentUid: string) => Promise<unknown>) | null;
    onupdate: (session: WakingBotSession) => void;
    onclose: () => void;
    onretry: () => void;
    onopenchat: () => void;
  }

  let { session, getStatus, retryAgent = null, onupdate, onclose, onretry, onopenchat }: Props = $props();

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
      const checkedSession = session;
      if (stopped || !checkedSession || checkedSession.phase !== "waking") return;
      if (!getStatus || !checkedSession.agentUid) {
        timer = setTimeout(() => void check(), WAKING_POLL_MS);
        return;
      }
      try {
        const result = await getStatus(checkedSession.agentUid);
        if (stopped) return;
        const response = result as { ok?: unknown; value?: unknown };
        const next = response && response.ok === true
          ? applyWakingStatus(checkedSession, response.value)
          : recordWakingCheckFailure(checkedSession);
        onupdate(next);
      } catch {
        if (!stopped) onupdate(recordWakingCheckFailure(checkedSession));
      }
      if (!stopped && checkedSession.phase === "waking") timer = setTimeout(() => void check(), WAKING_POLL_MS);
    }

    void check();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  });
</script>

<section class="new-bot-waking" data-testid="new-bot-waking-screen">
  <div
    class="new-bot-waking-ring"
    data-testid="new-bot-waking-ring"
    style={`--waking-progress: ${session.progress}%`}
    role="progressbar"
    aria-label={`Waking up ${session.name}`}
    aria-valuemin="0"
    aria-valuemax="100"
    aria-valuenow={session.progress}
  >
    <span class="new-bot-waking-avatar">{initials}</span>
  </div>
  <p class="new-bot-takeover-kicker">A new teammate</p>
  <h1 id="new-bot-takeover-title">Waking up <em>{session.name}</em></h1>
  <p
    class="new-bot-waking-status"
    data-testid="new-bot-waking-status"
    aria-live="polite"
    aria-atomic="true"
  >{statusLine}</p>

  {#if session.phase === "failed"}
    <button type="button" class="new-bot-waking-action" data-testid="new-bot-waking-retry" disabled={!retryAgent} use:focusOnMount onclick={onretry}>Try again</button>
  {:else}
    <button type="button" class="new-bot-waking-link" data-testid="new-bot-waking-open-chat" use:focusOnMount onclick={onopenchat}>Open chat now</button>
  {/if}

  <button type="button" class="new-bot-waking-close" data-testid="new-bot-waking-close" onclick={onclose}>Close</button>
</section>
