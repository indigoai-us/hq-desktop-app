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
   * The look follows the New Bot takeover: a brand wallpaper, a dark scrim and
   * a glass panel holding the words. Like the takeover the card is dark in
   * both app themes, so no color here comes from a theme variable.
   */
  import { onDestroy } from "svelte";
  import aurora from "../create-bot/assets/new-bot-wallpapers/aurora.jpg";
  import nodeConstellation from "../create-bot/assets/new-bot-wallpapers/node-constellation.jpg";
  import {
    connectionActionKey,
    type ConnectionCardAction,
    type ConnectionCardActionHandler,
    type ConnectionCardView,
  } from "./connection-card-model.js";

  interface Props {
    view: ConnectionCardView;
    onaction?: ConnectionCardActionHandler;
  }

  let { view, onaction }: Props = $props();

  /** Each card has its own wallpaper, already bundled for the New Bot takeover. */
  const art = $derived(view.target === "slack" ? aurora : nodeConstellation);

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
    return connectionActionKey(view.target, action, connectionId) in pressed;
  }

  function release(key: string): void {
    const { [key]: _done, ...rest } = pressed;
    pressed = rest;
  }

  function press(action: ConnectionCardAction, connectionId?: string): void {
    const key = connectionActionKey(view.target, action, connectionId);
    if (key in pressed) return;
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
      result = onaction?.({ target: view.target, action, ...(connectionId ? { connectionId } : {}) });
    } catch {
      done();
      return;
    }
    void Promise.resolve(result).then(done, done);
  }
</script>

<div
  class="connection-card"
  data-testid="connection-card"
  data-target={view.target}
  data-state={view.state}
  role="group"
  aria-label={view.title}
>
  <!-- The art is the app's own bundled image. The card itself takes no style attribute. -->
  <span class="connection-card-art" aria-hidden="true" style:background-image={`url("${art}")`}></span>
  <div class="connection-card-glass">
    <div class="connection-card-head">
      <span class="connection-card-icon" aria-hidden="true">
        {#if view.target === "slack"}
          <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
            <path d="M6 2.5v11M10 2.5v11M2.5 6h11M2.5 10h11" />
          </svg>
        {:else}
          <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
            <path d="M5.5 1.5v3M10.5 1.5v3M3.5 4.5h9v2.5a4.5 4.5 0 0 1-9 0zM8 11.5v3" />
          </svg>
        {/if}
      </span>
      <span class="connection-card-title">{view.title}</span>
      {#if view.mark}
        <span class="connection-card-mark" data-testid="connection-card-mark">
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M6.5 11L3.5 8l1-1 2 2 5-5 1 1z" fill="currentColor" /></svg>
          {view.mark}
        </span>
      {/if}
    </div>
    <div class="connection-card-line" data-testid="connection-card-line">{view.line}</div>
    {#if view.waiting.length > 0}
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
    {/if}
    {#if view.moreWaiting}
      <div class="connection-card-more" data-testid="connection-card-more">{view.moreWaiting}</div>
    {/if}
    {#if view.note}
      <div class="connection-card-note" data-testid="connection-card-note" role="status">{view.note}</div>
    {/if}
  </div>
  {#if view.primaryLabel || view.declineLabel}
    <div class="connection-card-actions">
      {#if view.primaryLabel}
        <button
          type="button"
          class="connection-card-btn is-primary"
          data-testid="connection-card-primary"
          disabled={view.primaryPending || isPressed("connect")}
          onclick={() => press("connect")}
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
    position: relative;
    isolation: isolate;
    overflow: hidden;
    box-sizing: border-box;
    flex: 1 1 220px;
    min-width: 200px;
    min-height: 88px;
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
  .connection-card[data-target="slack"] .connection-card-art {
    background-position: center 14%;
  }
  .connection-card[data-target="tools"] .connection-card-art {
    background-position: center 96%;
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
  .connection-card-line {
    font-size: 12px;
    line-height: 1.45;
    color: var(--cc-muted);
  }
  /* The rows sit on a darker inset panel, so a name and its button read as one line. */
  .connection-card-rows {
    list-style: none;
    margin: 0;
    padding: 0 8px;
    display: flex;
    flex-direction: column;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 5px;
    background: rgba(9, 9, 11, 0.46);
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
    font-size: 12px;
    color: var(--cc-muted);
  }
  /* The buttons stand on the art, at the bottom, each with its own fill. */
  .connection-card-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
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
    .connection-card-btn {
      transition: none;
    }
  }
</style>
