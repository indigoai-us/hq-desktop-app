<script lang="ts">
  /**
   * One connection card (Slack, or Connect your tools) inside a bot's message.
   *
   * Drawn entirely from a view the app built (connection-card-model.ts): the
   * title, the line, the buttons and the note are the app's own words, bound
   * as text. Nothing here comes from the bot, and a press never opens a link
   * by itself. It tells the host which button was pressed and the host decides
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
   * Every card is one fixed height in every state (`--cc-height` below). What
   * does not fit scrolls inside the glass panel: the tools card's rows. The
   * header, the line and the button strip never move.
   */
  import { onDestroy } from "svelte";
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
        <!-- The app's logo: the badge at once, the favicon once it has loaded. -->
        <ConnectionCardLogo logo={view.logo} size={28} />
      {:else}
        <span class="connection-card-icon" aria-hidden="true">
          <ConnectionCardIcon name={view.target} />
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
    <!-- A long line is cut at two lines so the card keeps its height; the title holds all of it. -->
    <div class="connection-card-line" data-testid="connection-card-line" title={view.line}>{view.line}</div>
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

<style>
  /*
   * Brand wallpaper, scrim, glass: the New Bot takeover's layers at card size.
   * The card is dark on art in the light and the dark app theme alike, so
   * every color is set here for a dark surface and none is a theme variable.
   *
   * Readability does not depend on the art. Words sit on the glass panel, or
   * on a button with its own fill. The brightest pixel in either wallpaper is
   * pure white (a star). Through the scrim (0.16 at its lightest) and the
   * glass (0.68) it comes out at about rgb(81, 81, 82), and the faintest words
   * (the muted line, the green mark, the amber note) stay above 4.5:1 on that
   * even before the blur evens it out. Change the scrim, the glass or an ink
   * together, never one alone.
   */
  .connection-card {
    --cc-ink: #fafafa;
    --cc-muted: rgba(250, 250, 250, 0.76);
    --cc-line: rgba(255, 255, 255, 0.16);
    --cc-accent: #c4a5ff;
    --cc-ok: #4ade80;
    --cc-warn: #fcd34d;
    /* The one height of every connection card, in every state. Room for the
       title, two lines and a note on the glass, the art, and the button strip. */
    --cc-height: 240px;
    position: relative;
    isolation: isolate;
    overflow: hidden;
    box-sizing: border-box;
    flex: 1 1 220px;
    min-width: 200px;
    height: var(--cc-height);
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 5px;
    border: 1px solid var(--cc-line);
    border-radius: 8px;
    font-size: 13px;
    color: var(--cc-ink);
    background: #09090b;
    color-scheme: dark;
  }
  .connection-card-art {
    position: absolute;
    z-index: -1;
    inset: 0;
    background-position: center;
    background-size: cover;
    background-repeat: no-repeat;
  }
  /* The scrim: darkest at the edges, like the takeover's shade. */
  .connection-card-art::after {
    content: "";
    position: absolute;
    inset: 0;
    background:
      radial-gradient(ellipse at center, rgba(9, 9, 11, 0), rgba(9, 9, 11, 0.34)),
      rgba(9, 9, 11, 0.16);
  }
  /* The glass panel: the takeover card's treatment. */
  .connection-card-glass {
    /* As tall as its words, never taller than the room above the buttons:
       past that the rows scroll inside it. */
    flex: 0 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 7px 9px 8px;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 5px;
    background: rgba(17, 17, 19, 0.68);
    box-shadow:
      0 4px 14px rgba(0, 0, 0, 0.3),
      inset 0 1px 0 rgba(255, 255, 255, 0.06);
    backdrop-filter: blur(18px) saturate(140%);
    -webkit-backdrop-filter: blur(18px) saturate(140%);
  }
  .connection-card[data-state="connecting"] {
    border-color: var(--cc-accent);
  }
  .connection-card[data-state="connecting"] .connection-card-glass {
    border-color: color-mix(in srgb, var(--cc-accent) 34%, transparent);
  }
  .connection-card[data-state="connected"] {
    border-color: color-mix(in srgb, var(--cc-ok) 70%, transparent);
  }
  .connection-card[data-state="connected"] .connection-card-glass {
    border-color: color-mix(in srgb, var(--cc-ok) 30%, transparent);
    background: color-mix(in srgb, #16a34a 10%, rgba(17, 17, 19, 0.74));
  }
  /* Declined recedes: the art goes grey and dark, the border dashed, the
     title and icon dimmer. The words keep the muted ink, which stays well
     above 4.5:1 here: it is the one sentence that says how to come back. */
  .connection-card[data-state="declined"] {
    border-style: dashed;
    border-color: rgba(255, 255, 255, 0.3);
    color: var(--cc-muted);
  }
  .connection-card[data-state="declined"] .connection-card-art {
    filter: grayscale(1) brightness(0.38);
  }
  .connection-card[data-state="declined"] .connection-card-glass {
    border-color: rgba(255, 255, 255, 0.07);
    background: rgba(17, 17, 19, 0.5);
    box-shadow: none;
  }
  .connection-card-head {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 7px;
  }
  .connection-card-icon {
    display: inline-flex;
    flex: 0 0 auto;
    color: var(--cc-muted);
  }
  .connection-card[data-state="connecting"] .connection-card-icon {
    color: var(--cc-accent);
  }
  .connection-card[data-state="connected"] .connection-card-icon {
    color: var(--cc-ok);
  }
  .connection-card[data-state="declined"] .connection-card-icon {
    color: rgba(250, 250, 250, 0.5);
  }
  .connection-card-title {
    font-weight: 600;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .connection-card-mark {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    gap: 3px;
    font-size: 11px;
    font-weight: 600;
    color: var(--cc-ok);
    white-space: nowrap;
  }
  /* Two lines at most, then an ellipsis: a long line never grows the card. */
  .connection-card-line,
  .connection-card-note {
    flex: 0 0 auto;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
    overflow-wrap: anywhere;
  }
  .connection-card-line {
    font-size: 12px;
    line-height: 1.45;
    color: var(--cc-muted);
  }
  /* The rows sit on a darker inset panel, so a name and its button read as
     one line. The panel takes the room that is left and scrolls inside it. */
  .connection-card-list {
    position: relative;
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 5px;
    background: rgba(9, 9, 11, 0.46);
    overflow: hidden;
  }
  /* The fade over the last visible row while more rows are below. */
  .connection-card-list::after {
    content: "";
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 26px;
    pointer-events: none;
    background: linear-gradient(to bottom, rgba(9, 9, 11, 0), rgba(9, 9, 11, 0.86));
    opacity: 0;
    transition: opacity 0.15s;
  }
  .connection-card-list[data-more-below="true"]::after {
    opacity: 1;
  }
  .connection-card-scroll {
    flex: 1 1 auto;
    min-height: 0;
    overflow-x: hidden;
    overflow-y: auto;
    /* At its end the wheel moves the conversation: the default, kept on purpose. */
    overscroll-behavior: auto;
    scrollbar-width: thin;
    scrollbar-color: rgba(255, 255, 255, 0.26) transparent;
  }
  .connection-card-scroll::-webkit-scrollbar {
    width: 6px;
  }
  .connection-card-scroll::-webkit-scrollbar-track {
    background: transparent;
  }
  .connection-card-scroll::-webkit-scrollbar-thumb {
    border-radius: 3px;
    background: rgba(255, 255, 255, 0.26);
  }
  .connection-card-scroll::-webkit-scrollbar-thumb:hover {
    background: rgba(255, 255, 255, 0.42);
  }
  .connection-card-scroll:focus-visible {
    outline: 2px solid var(--cc-accent);
    outline-offset: -2px;
  }
  .connection-card-rows {
    list-style: none;
    margin: 0;
    padding: 0 8px;
    display: flex;
    flex-direction: column;
  }
  .connection-card-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 6px 8px;
    padding: 6px 0;
  }
  .connection-card-row + .connection-card-row {
    border-top: 1px solid rgba(255, 255, 255, 0.08);
  }
  .connection-card-row-name {
    font-weight: 500;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .connection-card-more {
    flex: 0 0 auto;
    font-size: 12px;
    color: var(--cc-muted);
  }
  .connection-card-scroll .connection-card-more {
    padding: 6px 8px 7px;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
  }
  /* The buttons stand on the art, at the bottom, each with its own fill. */
  .connection-card-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    flex: 0 0 auto;
    margin-top: auto;
    padding: 0 1px 1px;
  }
  .connection-card-btn {
    padding: 6px 10px;
    font: inherit;
    font-size: 12px;
    font-weight: 500;
    color: var(--cc-ink);
    background: rgba(255, 255, 255, 0.08);
    border: 1px solid rgba(255, 255, 255, 0.24);
    border-radius: 6px;
    cursor: pointer;
    transition: border-color 0.12s, background 0.12s;
  }
  .connection-card-btn:hover:not(:disabled) {
    border-color: rgba(255, 255, 255, 0.6);
    background: rgba(255, 255, 255, 0.14);
  }
  .connection-card-btn:focus-visible {
    outline: 2px solid var(--cc-accent);
    outline-offset: 2px;
  }
  /* The takeover's primary action: near-white on glass, dark words. */
  .connection-card-btn.is-primary {
    color: #111113;
    background: rgba(255, 255, 255, 0.92);
    border-color: rgba(255, 255, 255, 0.82);
    box-shadow: 0 2px 10px rgba(0, 0, 0, 0.32);
  }
  .connection-card-btn.is-primary:hover:not(:disabled) {
    background: #fff;
    border-color: #fff;
  }
  .connection-card-btn.is-quiet {
    color: rgba(250, 250, 250, 0.88);
    background: rgba(9, 9, 11, 0.6);
    border-color: rgba(255, 255, 255, 0.14);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
  }
  .connection-card-btn.is-quiet:hover:not(:disabled) {
    color: var(--cc-ink);
    background: rgba(9, 9, 11, 0.72);
    border-color: rgba(255, 255, 255, 0.4);
  }
  .connection-card-btn:disabled {
    cursor: default;
    opacity: 0.55;
  }
  /* A pending primary stays a solid button: see-through white over the art
     would turn the color of whatever is behind it. */
  .connection-card-btn.is-primary:disabled {
    opacity: 1;
    color: #303036;
    background: #b4b4bb;
    border-color: #b4b4bb;
    box-shadow: none;
  }
  .connection-card-note {
    font-size: 12px;
    line-height: 1.4;
    color: var(--cc-warn);
  }
  @media (prefers-reduced-motion: reduce) {
    .connection-card-btn,
    .connection-card-list::after {
      transition: none;
    }
  }
</style>
