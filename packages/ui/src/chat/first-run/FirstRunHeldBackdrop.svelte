<script lang="ts">
  /**
   * The first-run takeover's backdrop with no content (US-010).
   *
   * While the shell still decides whether the first-run takeover opens (the
   * route is pending, or it is visual and the takeover has not mounted yet),
   * this paints the same wallpaper, shade and wordmark the takeover paints, so
   * the window never shows the ordinary shell first. When the takeover mounts
   * on the same backdrop only its content fades in.
   */
  import { portal } from "../portal.js";
  import { newBotWallpaper } from "../create-bot/new-bot-wallpapers.js";
  import "../create-bot/new-bot-takeover.css";
</script>

<div
  class="new-bot-takeover chat-shell first-run-held"
  data-testid="first-run-held"
  aria-hidden="true"
  style={`--new-bot-wallpaper: url("${newBotWallpaper(0)}")`}
  use:portal
>
  <div class="new-bot-takeover-shade"></div>
  <header class="new-bot-takeover-header">
    <span class="new-bot-takeover-wordmark">HQ</span>
  </header>
</div>
