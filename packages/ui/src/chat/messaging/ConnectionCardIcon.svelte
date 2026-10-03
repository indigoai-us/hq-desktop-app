<script lang="ts">
  /**
   * The icon of a connection card, by target. Used by the card and by the
   * modal a card opens, so both show the same mark. Decorative: the title
   * next to it says what it is.
   */
  import type { ConnectionCardTarget } from "./connection-card-model.js";

  interface Props {
    /** The card. An integration card with no logo gets the generic tools mark. */
    name: ConnectionCardTarget;
    size?: number;
  }

  let { name, size = 16 }: Props = $props();
</script>

{#if name === "slack"}
  <svg viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
    <path d="M6 2.5v11M10 2.5v11M2.5 6h11M2.5 10h11" />
  </svg>
{:else}
  <svg viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M5.5 1.5v3M10.5 1.5v3M3.5 4.5h9v2.5a4.5 4.5 0 0 1-9 0zM8 11.5v3" />
  </svg>
{/if}
