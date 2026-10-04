<script lang="ts">
  /**
   * SetupToolOffer — the card under the setup bot's first message when the
   * person has the Claude or Codex desktop app and uses it a lot. The bot
   * (hq-cli) sends "Looks like you use the Claude app. Want to continue setup
   * there?" with a `continueInTool` hq-block; the host draws this card for it.
   *
   * Two actions, both handled by the host: continue in that app (opens the
   * HQ folder in it with setup ready to go) or keep going here (sends the
   * reply the bot waits for). Presentational; nothing here talks to the bot.
   *
   * WORDING: plain words only, never a command to type.
   */
  import SetupButton from "./SetupButton.svelte";
  import { SETUP_TOOL_OFFER_COPY, type SetupOfferTool } from "./setup-bot";

  interface Props {
    tool: SetupOfferTool;
    /** Open the HQ folder in the tool, with setup ready to go. */
    oncontinue: () => void;
    /** Carry on with setup in this conversation. */
    onkeep: () => void;
    /** A launch is in progress: the buttons wait. */
    busy?: boolean;
    /** A launch failure, in plain words. */
    launchError?: string | null;
  }

  let { tool, oncontinue, onkeep, busy = false, launchError = null }: Props = $props();

  const copy = $derived(SETUP_TOOL_OFFER_COPY[tool]);
</script>

<section
  class="setup-tool-offer"
  data-testid="setup-tool-offer"
  data-tool={tool}
  role="group"
  aria-label={copy.continue}
>
  <div class="actions">
    <SetupButton variant="primary" data-testid="setup-tool-offer-continue" disabled={busy} onclick={() => oncontinue()}>
      {copy.continue}
    </SetupButton>
    <SetupButton variant="secondary" data-testid="setup-tool-offer-keep" disabled={busy} onclick={() => onkeep()}>
      {SETUP_TOOL_OFFER_COPY.keep}
    </SetupButton>
  </div>
  {#if launchError}
    <p class="launch-error" role="alert" data-testid="setup-tool-offer-error">{launchError}</p>
  {/if}
</section>

<style>
  .setup-tool-offer {
    /* The chat theme's own ink, so the buttons read in light and dark. */
    --setup-btn-fg: var(--t1, currentColor);
    --setup-btn-line: var(--line, rgba(127, 127, 127, 0.35));
    --setup-btn-primary-bg: var(--t1, currentColor);
    --setup-btn-primary-fg: var(--panel-bg, #fff);
    --setup-btn-muted: var(--t2, currentColor);
    --setup-btn-hover: var(--hover, rgba(127, 127, 127, 0.12));
    color: var(--t1, inherit);
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: 4px 0 16px 48px;
    max-width: 560px;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .launch-error {
    margin: 0;
    font-size: 12px;
    color: var(--text-danger, #d9534f);
  }
</style>
