<script lang="ts">
  /**
   * One connection card (Slack, or Connect your tools) inside a bot's message.
   *
   * Drawn entirely from a view the app built (connection-card-model.ts): the
   * title, the line, the buttons and the note are the app's own words, bound
   * as text. One thing on a card can be the bot's: an integration card's
   * reason, sanitized plain text bound as text, drawn under the app's own
   * sentence with the bot's name on it. A press never opens a link by
   * itself. It tells the host which button was pressed and the host decides
   * what to open.
   *
   * A pressed button is disabled at once and stays so until the host has
   * handled the press, so a double click acts once.
   *
   * A card can have a modal. Its view then says the main button opens it
   * (`primaryAction: "open"`): the button tells assistive tech a dialog
   * follows and the host receives an `open` action. That button is not
   * disabled by its own press, because focus comes back to it when the
   * dialog closes; a second press while the first is being handled is
   * still ignored.
   *
   * The look follows the New Bot takeover: a brand wallpaper, a dark scrim and
   * a glass panel holding the words. Like the takeover the card is dark in
   * both app themes, so no color here comes from a theme variable.
   *
   * Every card is one fixed height in every state (`--cc-height` below): the
   * header row (logo, name, status), the app's sentence on up to two rows
   * (and under it, on an offered app's card, the bot's one-line reason), the
   * button strip at the bottom. What does not fit scrolls inside the glass
   * panel: the tools card's rows. The header, the sentence and the button
   * strip never move.
   */
  import { onDestroy } from "svelte";
  import "./connection-card.css";
  import ConnectionCardIcon from "./ConnectionCardIcon.svelte";
  import ConnectionCardLogo from "./ConnectionCardLogo.svelte";
  import { connectionCardArt, integrationCardArt } from "./connection-card-art.js";
  import {
    connectionActionKey,
    type ConnectionCardAction,
    type ConnectionCardActionHandler,
    type ConnectionCardView,
  } from "./connection-card-model.js";

  interface Props {
    view: ConnectionCardView;
    onaction?: ConnectionCardActionHandler;
    /** The card's place in its row (0-based). Integration cards take their wallpaper from it. */
    index?: number;
  }

  let { view, onaction, index = 0 }: Props = $props();

  /**
   * Each card has its own wallpaper, already bundled for the New Bot
   * takeover. Integration cards rotate through them by place in the row.
   */
  const art = $derived(view.target === "integration" ? integrationCardArt(index) : connectionCardArt(view.target));
  /**
   * The box at the head of every card, in px: an integration card's logo
   * and a built-in card's icon are the same size, so the header rows of the
   * cards in one row line up.
   */
  const HEAD_BOX = 28;
  const primaryAction = $derived(view.primaryAction);
  /** The connection a "Let {bot} use it" main button shares. */
  const primaryConnectionId = $derived(primaryAction === "allow" ? (view.connectionId ?? undefined) : undefined);

  /** Shortest time a pressed button stays disabled: longer than a double click. */
  const PRESS_HOLD_MS = 600;

  // Presses the host has not finished handling, by action key.
  let pressed = $state<Record<string, true>>({});
  const timers = new Set<ReturnType<typeof setTimeout>>();
  onDestroy(() => {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  });

  function isPressed(action: ConnectionCardAction, connectionId?: string): boolean {
    return connectionActionKey(view.target, action, connectionId, view.domain) in pressed;
  }

  function release(key: string): void {
    const { [key]: _done, ...rest } = pressed;
    pressed = rest;
  }

  function press(action: ConnectionCardAction, connectionId?: string, button?: HTMLElement | null): void {
    const key = connectionActionKey(view.target, action, connectionId, view.domain);
    if (key in pressed) return;
    // WebKit does not focus a button on a mouse press. The dialog returns
    // focus to whatever had it when it opened, so put it on the button first.
    if (action === "open") button?.focus();
    pressed = { ...pressed, [key]: true };
    const startedAt = Date.now();
    const done = (): void => {
      const wait = Math.max(0, PRESS_HOLD_MS - (Date.now() - startedAt));
      const timer = setTimeout(() => {
        timers.delete(timer);
        release(key);
      }, wait);
      timers.add(timer);
    };
    let result: void | Promise<void>;
    try {
      result = onaction?.({
        target: view.target,
        action,
        ...(connectionId ? { connectionId } : {}),
        ...(view.domain ? { domain: view.domain } : {}),
        ...(view.fromState ? { fromState: true } : {}),
      });
    } catch {
      done();
      return;
    }
    void Promise.resolve(result).then(done, done);
  }

  // The rows scroll inside the card. A soft fade at the bottom edge of the
  // list says more rows are below; it goes once the list is at its end.
  let list = $state<HTMLElement | null>(null);
  let moreBelow = $state(false);
  function measureList(): void {
    const el = list;
    moreBelow = el ? el.scrollHeight - el.clientHeight - el.scrollTop > 1 : false;
  }
  $effect(() => {
    const el = list;
    // Measure again when the rows change.
    void view.waiting.length;
    void view.moreWaiting;
    if (!el) {
      moreBelow = false;
      return;
    }
    measureList();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => measureList());
    observer.observe(el);
    return () => observer.disconnect();
  });
</script>

<div
  class="connection-card"
  data-testid="connection-card"
  data-target={view.target}
  data-kind={view.kind}
  data-domain={view.domain}
  data-state={view.state}
  role="group"
  aria-label={view.title}
>
  <!-- The art is the app's own bundled image. The card itself takes no style attribute. -->
  <span
    class="connection-card-art"
    aria-hidden="true"
    style:background-image={`url("${art.url}")`}
    style:background-position={art.position}
  ></span>
  <div class="connection-card-glass">
    <div class="connection-card-head">
      {#if view.logo}
        <!-- The app's logo: its bundled mark, else the generic glyph. Never a remote image. -->
        <ConnectionCardLogo logo={view.logo} size={HEAD_BOX} />
      {:else}
        <!-- Slack's own mark on a light tile; the generic glyph on the glass for the tools card. -->
        <span
          class="connection-card-icon"
          data-testid="connection-card-icon"
          data-icon={view.target}
          aria-hidden="true"
          style:width={`${HEAD_BOX}px`}
          style:height={`${HEAD_BOX}px`}
        >
          <ConnectionCardIcon name={view.target} size={18} />
        </span>
      {/if}
      <span class="connection-card-title">{view.title}</span>
      {#if view.mark}
        <span class="connection-card-mark" data-testid="connection-card-mark">
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M6.5 11L3.5 8l1-1 2 2 5-5 1 1z" fill="currentColor" /></svg>
          {view.mark}
        </span>
      {/if}
    </div>
    <!-- The app's sentence, on up to two rows, cut with an ellipsis past that so the card keeps its height; the title holds all of it. -->
    <div class="connection-card-line" data-testid="connection-card-line" title={view.line}>{view.line}</div>
    {#if view.reason}
      <!-- The bot's own reason, under the app's sentence and named as the bot's. One line, the rest in the title. -->
      <div class="connection-card-reason" data-testid="connection-card-reason" title={view.reason}>{view.reason}</div>
    {/if}
    {#if view.waiting.length > 0}
      <div class="connection-card-list" data-more-below={moreBelow ? "true" : "false"}>
        <!-- The list scrolls, so it takes focus: the arrow keys scroll it for
             someone who does not use a pointer. -->
        <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
        <div
          class="connection-card-scroll"
          data-testid="connection-card-scroll"
          role="group"
          aria-label="Your connections"
          tabindex="0"
          bind:this={list}
          onscroll={measureList}
        >
          <ul class="connection-card-rows">
            {#each view.waiting as row (row.connectionId)}
              <li class="connection-card-row" data-testid="connection-card-row" data-connection-id={row.connectionId}>
                <span class="connection-card-row-name">{row.name}</span>
                <button
                  type="button"
                  class="connection-card-btn"
                  data-testid="connection-card-allow"
                  disabled={row.pending || isPressed("allow", row.connectionId)}
                  onclick={() => press("allow", row.connectionId)}
                >
                  {row.label}
                </button>
              </li>
            {/each}
          </ul>
          {#if view.moreWaiting}
            <div class="connection-card-more" data-testid="connection-card-more">{view.moreWaiting}</div>
          {/if}
        </div>
      </div>
    {:else if view.moreWaiting}
      <div class="connection-card-more" data-testid="connection-card-more">{view.moreWaiting}</div>
    {/if}
    {#if view.note}
      <div class="connection-card-note" data-testid="connection-card-note" role="status" title={view.note}>{view.note}</div>
    {/if}
  </div>
  {#if view.primaryLabel || view.declineLabel}
    <div class="connection-card-actions">
      {#if view.primaryLabel}
        <button
          type="button"
          class="connection-card-btn is-primary"
          data-testid="connection-card-primary"
          data-action={primaryAction}
          aria-haspopup={primaryAction === "open" ? "dialog" : undefined}
          disabled={view.primaryPending || (primaryAction !== "open" && isPressed(primaryAction, primaryConnectionId))}
          onclick={(event) => press(primaryAction, primaryConnectionId, event.currentTarget)}
        >
          {view.primaryLabel}
        </button>
      {/if}
      {#if view.declineLabel}
        <button
          type="button"
          class="connection-card-btn is-quiet"
          data-testid="connection-card-decline"
          disabled={isPressed("decline")}
          onclick={() => press("decline")}
        >
          {view.declineLabel}
        </button>
      {/if}
    </div>
  {/if}
</div>
