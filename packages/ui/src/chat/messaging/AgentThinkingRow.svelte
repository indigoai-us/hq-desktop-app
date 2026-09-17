<script lang="ts">
  // Dense status row for the client-side agent "thinking" indicator. Rendered
  // under the last message (via Conversation's `belowMessages` snippet) — status,
  // not an alert, not a message bubble. Tokens only so dark + light stay correct.
  //
  // The row keeps its own clock so the line visibly moves while the agent works:
  // the agent's reported status when it sends one, otherwise a short walk of
  // honest phrases, plus "working for 42s" past 15s. The clock is presentation
  // only — it never removes a row. Teardown is still a strictly newer message
  // from that agent (transient-indicators-clear-on-newer-event-not-time-window).
  import { thinkingLine, type ThinkingEntry } from "../agent-thinking.js";
  import { agentAvatarFor } from "./agent-avatars";

  interface Props {
    entries: ThinkingEntry[];
  }

  let { entries }: Props = $props();

  /** One second is the coarsest tick the elapsed counter can read smoothly. */
  const TICK_MS = 1_000;

  let now = $state(Date.now());

  $effect(() => {
    if (entries.length === 0) return;
    const handle = setInterval(() => {
      now = Date.now();
    }, TICK_MS);
    return () => clearInterval(handle);
  });

  function initial(name: string): string {
    const trimmed = name.trim();
    return trimmed ? trimmed[0].toUpperCase() : '?';
  }
</script>

{#if entries.length > 0}
  <div
    class="agent-thinking"
    role="status"
    aria-live="polite"
    data-testid="agent-thinking-row"
  >
    {#each entries as entry (entry.agentUid)}
      {@const generated = agentAvatarFor(entry.agentUid)}
      {@const line = thinkingLine(entry, now)}
      <div class="thinking-row">
        <span class="avatar" aria-hidden="true">
          {#if generated}<img
              class="avatar-img"
              src={generated}
              alt=""
            />{:else}{initial(entry.agentName)}{/if}
        </span>
        <span class="label">
          <!-- Keyed so a new phrase (or a new reported status) fades in rather
               than swapping characters in place. -->
          {#key line.label}<span class="label-text">{line.label}</span>{/key}<span
            class="ellipsis-anim"
            aria-hidden="true"
          ><span>.</span><span>.</span><span>.</span></span><span
            class="ellipsis-static">…</span
          >{#if line.elapsed}<span
              class="elapsed"
              aria-hidden="true"
              data-testid="agent-thinking-elapsed">{line.elapsed}</span
            >{/if}
        </span>
      </div>
    {/each}
  </div>
{/if}

<style>
  .agent-thinking {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    margin-top: 0.5rem;
  }

  .thinking-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-height: 1.625rem;
    height: 1.625rem;
  }

  .avatar {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: var(--surface-raise);
    color: var(--muted-2);
    font-size: 0.625rem;
    font-weight: 600;
    line-height: 1;
    overflow: hidden;
  }

  .avatar-img {
    width: 100%;
    height: 100%;
    border-radius: 50%;
    object-fit: cover;
    display: block;
  }

  .label {
    min-width: 0;
    font-size: var(--text-base);
    color: var(--muted-2);
    line-height: 1.3;
  }

  .label-text {
    animation: thinking-phrase 0.32s ease-out;
  }

  .elapsed {
    margin-left: 0.375rem;
    opacity: 0.7;
    font-variant-numeric: tabular-nums;
  }

  .ellipsis-anim {
    display: inline-flex;
    letter-spacing: 0.02em;
  }

  .ellipsis-anim span {
    animation: thinking-dot 1.2s ease-in-out infinite;
    opacity: 0.25;
  }

  .ellipsis-anim span:nth-child(2) {
    animation-delay: 0.2s;
  }

  .ellipsis-anim span:nth-child(3) {
    animation-delay: 0.4s;
  }

  .ellipsis-static {
    display: none;
  }

  @keyframes thinking-dot {
    0%,
    100% {
      opacity: 0.25;
    }
    50% {
      opacity: 1;
    }
  }

  @keyframes thinking-phrase {
    from {
      opacity: 0.35;
    }
    to {
      opacity: 1;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .ellipsis-anim {
      display: none;
    }

    .ellipsis-static {
      display: inline;
    }

    .label-text {
      animation: none;
    }
  }
</style>
