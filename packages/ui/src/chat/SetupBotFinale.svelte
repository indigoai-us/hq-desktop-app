<script lang="ts">
  /**
   * SetupBotFinale — the finish card under the setup bot's last message, once
   * the bot marks setup finished (a `setupDone` hq-block). Offers the next
   * places to work: the HQ folder in Claude Code or Codex (only the ones
   * installed on this Mac), and the HQ console on the web. Presentational;
   * every action goes back up.
   *
   * WORDING: "bot", never "agent".
   */
  import SetupButton from "./SetupButton.svelte";
  import { SETUP_BOT_FINALE_COPY, SETUP_BOT_CONSOLE_URL } from "./setup-bot";

  interface Props {
    /** Claude Code is installed on this Mac. */
    hasClaude: boolean;
    /** Codex is installed on this Mac. */
    hasCodex: boolean;
    onclaude: () => void;
    oncodex: () => void;
    /** Open a URL in the system browser. */
    onopenurl: (url: string) => void;
    /** Put the card away for good in this conversation. */
    ondismiss: () => void;
    /** A launch failure, in plain words. */
    launchError?: string | null;
    /**
     * The Slack offer's button label ("Put Pickles in Slack"), set only when
     * the bot offered it (someone who started their own company). Null hides it.
     */
    slackLabel?: string | null;
    /** Ask the bot to walk the person through its Slack bot. */
    onslack?: () => void;
  }

  let {
    hasClaude,
    hasCodex,
    onclaude,
    oncodex,
    onopenurl,
    ondismiss,
    launchError = null,
    slackLabel = null,
    onslack,
  }: Props = $props();

  const hasTools = $derived(hasClaude || hasCodex);
</script>

<section class="setup-bot-finale" data-testid="setup-bot-finale" role="group" aria-label={SETUP_BOT_FINALE_COPY.title}>
  <div class="heading">
    <div class="heading-text">
      <span class="eyebrow">{SETUP_BOT_FINALE_COPY.eyebrow}</span>
      <h3 class="title">{SETUP_BOT_FINALE_COPY.title}</h3>
    </div>
    <!-- The conversation carries on after setup ends, so the card has to be
         possible to put away; it never comes back for this bot. -->
    <button
      type="button"
      class="dismiss"
      data-testid="setup-bot-finale-dismiss"
      aria-label={SETUP_BOT_FINALE_COPY.dismiss}
      title={SETUP_BOT_FINALE_COPY.dismiss}
      onclick={() => ondismiss()}>×</button>
  </div>

  {#if hasTools}
    <div class="group">
      <p class="lead">{SETUP_BOT_FINALE_COPY.toolsLead}</p>
      <div class="actions" role="group" aria-label={SETUP_BOT_FINALE_COPY.toolsLead}>
        {#if hasClaude}
          <SetupButton variant="primary" data-testid="setup-bot-finale-claude" onclick={() => onclaude()}>
            {SETUP_BOT_FINALE_COPY.claude}
          </SetupButton>
        {/if}
        {#if hasCodex}
          <SetupButton variant="primary" data-testid="setup-bot-finale-codex" onclick={() => oncodex()}>
            {SETUP_BOT_FINALE_COPY.codex}
          </SetupButton>
        {/if}
      </div>
      {#if launchError}
        <p class="launch-error" role="alert" data-testid="setup-bot-finale-error">{launchError}</p>
      {/if}
    </div>
  {/if}

  {#if slackLabel && onslack}
    <div class="group">
      <p class="lead">{SETUP_BOT_FINALE_COPY.slackLead}</p>
      <div class="actions">
        <SetupButton data-testid="setup-bot-finale-slack" onclick={() => onslack?.()}>
          {slackLabel}
        </SetupButton>
      </div>
    </div>
  {/if}

  <div class="group">
    <p class="lead">{SETUP_BOT_FINALE_COPY.consoleLead}</p>
    <div class="actions">
      <SetupButton data-testid="setup-bot-finale-console" onclick={() => onopenurl(SETUP_BOT_CONSOLE_URL)}>
        {SETUP_BOT_FINALE_COPY.console}
      </SetupButton>
    </div>
  </div>
</section>

<style>
  .setup-bot-finale {
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
    gap: 16px;
    margin: 8px 0 16px 48px;
    padding: 18px 20px;
    max-width: 560px;
    border: 1px solid var(--line, rgba(127, 127, 127, 0.25));
    border-radius: 12px;
    background: var(--raised, rgba(127, 127, 127, 0.06));
    animation: finale-in 240ms ease-out both;
  }
  .heading {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
  }
  .heading-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .dismiss {
    flex: none;
    width: 24px;
    height: 24px;
    margin: -4px -4px 0 0;
    padding: 0;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--t2, currentColor);
    font-size: 17px;
    line-height: 1;
    cursor: pointer;
    opacity: 0.7;
  }
  .dismiss:hover {
    background: var(--hover, rgba(127, 127, 127, 0.12));
    opacity: 1;
  }
  .eyebrow {
    font-size: 11px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    opacity: 0.65;
  }
  .title {
    margin: 0;
    font-size: 17px;
    font-weight: 600;
  }
  .group {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .lead {
    margin: 0;
    font-size: 13px;
    line-height: 1.45;
    opacity: 0.85;
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
  @keyframes finale-in {
    from {
      opacity: 0;
      transform: translateY(4px);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .setup-bot-finale {
      animation: none;
    }
  }
</style>
