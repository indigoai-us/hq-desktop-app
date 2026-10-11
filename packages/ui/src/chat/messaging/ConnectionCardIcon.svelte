<script lang="ts">
  /**
   * The icon of a connection card, by target. Used by the card and by the
   * modal a card opens, so both show the same mark. Decorative: the title
   * next to it says what it is.
   *
   * Slack draws Slack's own mark (app-brand-marks.ts) in Slack's colour, so
   * the box it sits in should be a light tile. Everything else draws the
   * generic app glyph in the current text colour: Phosphor SquaresFour, the sign
   * for "an app" when there is no logo to show. It is never a letter or two
   * made from the name.
   */
  import RailIcon from "../../common/button/RailIcon.svelte";
  import { SLACK_MARK } from "./app-brand-marks.js";
  import type { ConnectionCardTarget } from "./connection-card-model.js";

  interface Props {
    /** The card. An integration card with no logo gets the generic app glyph. */
    name: ConnectionCardTarget;
    size?: number;
  }

  let { name, size = 16 }: Props = $props();
</script>

{#if name === "slack"}
  <svg viewBox="0 0 24 24" width={size} height={size} fill={`#${SLACK_MARK.hex}`} data-testid="connection-card-icon-slack" aria-hidden="true">
    <path d={SLACK_MARK.path} />
  </svg>
{:else}
  <span class="connection-card-icon-generic" data-testid="connection-card-icon-generic" aria-hidden="true"><RailIcon name="squares-four" {size} /></span>
{/if}

<style>
  .connection-card-icon-generic {
    display: inline-flex;
  }
</style>
