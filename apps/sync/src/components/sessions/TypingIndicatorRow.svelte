<script lang="ts">
  // US-025: live typing row — stacked mini avatars + "… are typing" with
  // animated dots. The dot animation is disabled under prefers-reduced-motion
  // (the text alone still communicates the state honestly).
  import Avatar from './Avatar.svelte';
  import type { WsMember } from './session-types';

  interface Props {
    typers: WsMember[];
  }

  let { typers }: Props = $props();

  const label = $derived.by(() => {
    const names = typers.map((t) => t.displayName);
    if (names.length === 0) return '';
    if (names.length === 1) return `${names[0]} is typing`;
    if (names.length === 2) return `${names[0]} and ${names[1]} are typing`;
    return `${names[0]}, ${names[1]}, and ${names.length - 2} more are typing`;
  });
</script>

{#if typers.length > 0}
  <div class="ws-typing-row" aria-live="polite" data-testid="ws-typing-row">
    <span class="stack" aria-hidden="true">
      {#each typers as typer, index (typer.uid)}
        <span class="mini" style:margin-left={index > 0 ? '-6px' : '0'}>
          <Avatar name={typer.displayName} kind={typer.kind} size={16} />
        </span>
      {/each}
    </span>
    <span class="label">{label}</span>
    <span class="dots" aria-hidden="true">
      <span class="dot"></span>
      <span class="dot"></span>
      <span class="dot"></span>
    </span>
  </div>
{/if}

<style>
  .ws-typing-row {
    display: flex;
    align-items: center;
    gap: var(--v4-space-2);
    min-height: 24px;
    padding: 2px var(--v4-space-4);
  }

  .stack {
    display: inline-flex;
    align-items: center;
    flex: none;
  }

  .mini {
    display: inline-flex;
    border-radius: 50%;
  }

  .label {
    font-size: var(--type-metadata);
    color: var(--v4-text-3);
  }

  .dots {
    display: inline-flex;
    gap: 3px;
    align-items: center;
  }

  .dot {
    width: 3px;
    height: 3px;
    border-radius: 50%;
    background: var(--v4-text-3);
    animation: ws-typing-bounce 1.2s ease-in-out infinite;
  }

  .dot:nth-child(2) {
    animation-delay: 0.15s;
  }

  .dot:nth-child(3) {
    animation-delay: 0.3s;
  }

  @keyframes ws-typing-bounce {
    0%,
    60%,
    100% {
      transform: translateY(0);
      opacity: 0.5;
    }
    30% {
      transform: translateY(-3px);
      opacity: 1;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .dot {
      animation: none;
    }
  }
</style>
