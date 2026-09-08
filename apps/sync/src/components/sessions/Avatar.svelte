<script lang="ts">
  // US-025 shared atom: achromatic initials avatar. Humans render as circles,
  // agents as rounded squares — a silhouette-level distinction that works
  // without color, matching the v4 achromatic contract.
  import { initials } from './session-types';
  import type { WsMemberKind } from './session-types';

  interface Props {
    name: string;
    kind?: WsMemberKind;
    size?: number;
  }

  let { name, kind = 'human', size = 28 }: Props = $props();

  const fontSize = $derived(Math.max(9, Math.round(size * 0.38)));
</script>

<span
  class="ws-avatar"
  class:agent={kind === 'agent'}
  style:width={`${size}px`}
  style:height={`${size}px`}
  style:font-size={`${fontSize}px`}
  aria-hidden="true"
>
  {initials(name)}
</span>

<style>
  .ws-avatar {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    border-radius: 50%;
    background: var(--v4-control-bg);
    border: 1px solid var(--v4-hairline);
    color: var(--v4-text-2);
    letter-spacing: 0.02em;
    user-select: none;
  }

  .ws-avatar.agent {
    border-radius: 30%;
  }
</style>
