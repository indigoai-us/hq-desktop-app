<script lang="ts">
  // Dense status row for the client-side agent "thinking" indicator. Rendered
  // under the last message (via Conversation's `belowMessages` snippet) — status,
  // not an alert, not a message bubble. Tokens only so dark + light stay correct.
  import { labelFor, type ThinkingEntry } from "../agent-thinking.js";
  import { agentAvatarFor } from "./agent-avatars";

  interface Props {
    entries: ThinkingEntry[];
  }

  let { entries }: Props = $props();

  function initial(name: string): string {
    const trimmed = name.trim();
    return trimmed ? trimmed[0].toUpperCase() : '?';
  }

  function thinkingLabel(entry: ThinkingEntry): string {
    const label = labelFor(entry);
    return label.endsWith('…') ? label.slice(0, -1) : label;
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
      <div class="thinking-row">
        <span class="avatar" aria-hidden="true">
          {#if generated}<img
              class="avatar-img"
              src={generated}
              alt=""
            />{:else}{initial(entry.agentName)}{/if}
        </span>
        {#if entry.phase === 'thinking'}
          <span class="label">
            {thinkingLabel(entry)}<span class="ellipsis-anim" aria-hidden="true"
              ><span>.</span><span>.</span><span>.</span></span
            ><span class="ellipsis-static">…</span>
          </span>
        {:else}
          <span class="label">{labelFor(entry)}</span>
        {/if}
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

  @media (prefers-reduced-motion: reduce) {
    .ellipsis-anim {
      display: none;
    }

    .ellipsis-static {
      display: inline;
    }
  }
</style>
