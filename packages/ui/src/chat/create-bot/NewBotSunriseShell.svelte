<script lang="ts">
  /**
   * The New bot takeover's shell for hosts outside the takeover (Settings →
   * Bots): the wallpaper, the HQ header with Cancel, and the card the step
   * screens sit in. It covers the whole window and the card shrinks and
   * scrolls with it, so it fits a small window too.
   */
  import type { Snippet } from "svelte";
  import RailIcon from "../../common/button/RailIcon.svelte";
  import { portal } from "../portal.js";
  import { newBotWallpaper } from "./new-bot-wallpapers.js";
  import "./new-bot-takeover.css";

  interface Props {
    testId?: string;
    cancelDisabled?: boolean;
    oncancel: () => void;
    children: Snippet;
  }

  let { testId = "new-bot-sunrise-shell", cancelDisabled = false, oncancel, children }: Props = $props();

  function onKeydown(event: KeyboardEvent): void {
    if (event.key !== "Escape" || cancelDisabled) return;
    event.stopPropagation();
    oncancel();
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="new-bot-takeover chat-shell"
  data-testid={testId}
  data-sunrise="true"
  role="presentation"
  style={`--new-bot-wallpaper: url("${newBotWallpaper(0)}")`}
  use:portal
  onkeydown={onKeydown}
>
  <div class="new-bot-takeover-shade" aria-hidden="true"></div>
  <header class="new-bot-takeover-header">
    <span class="new-bot-takeover-wordmark">HQ</span>
    <button
      type="button"
      class="new-bot-takeover-cancel"
      data-testid="new-bot-takeover-cancel"
      disabled={cancelDisabled}
      onclick={oncancel}
    ><RailIcon name="x" />Cancel</button>
  </header>
  <main class="new-bot-takeover-stage">
    <div
      class="new-bot-takeover-card new-bot-takeover-card--flow new-bot-takeover-card--steps"
      data-testid="new-bot-sunrise-flow"
      role="dialog"
      aria-modal="true"
      aria-label="New bot"
      tabindex="-1"
    >
      {@render children()}
    </div>
  </main>
</div>
