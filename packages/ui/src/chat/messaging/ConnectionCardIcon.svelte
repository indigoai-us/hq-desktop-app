<script lang="ts">
  /**
   * The icon of a connection card, by target. Used by the card and by the
   * modal a card opens, so both show the same mark. Decorative: the title
   * next to it says what it is.
   *
   * Slack draws Slack's own mark (app-brand-marks.ts) in Slack's colour, so
   * the box it sits in should be a light tile. Everything else draws the
   * generic app glyph in the current text colour: four small tiles, the sign
   * for "an app" when there is no logo to show. It is never a letter or two
   * made from the name.
   */
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
  <svg viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" data-testid="connection-card-icon-generic" aria-hidden="true">
    <rect x="2" y="2" width="5" height="5" rx="1.4" />
    <rect x="9" y="2" width="5" height="5" rx="1.4" />
    <rect x="2" y="9" width="5" height="5" rx="1.4" />
    <rect x="9" y="9" width="5" height="5" rx="1.4" />
  </svg>
{/if}
