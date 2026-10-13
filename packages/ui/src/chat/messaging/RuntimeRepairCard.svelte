<script lang="ts">
  /**
   * A local bot's runtime repair card: the bot's reply when its coding tool
   * is signed out, too old, set to a model the tool cannot run, or failed
   * once. Drawn in the connection card's look, from the same stylesheet
   * (connection-card.css), so the two never drift.
   *
   * Drawn entirely from a view the app built (runtime-repair-model.ts): every
   * word is the app's own, bound as text. A press tells the host which action
   * to run; the host runs it and the view it hands back says how it went. The
   * card is the same message row the whole time: the problem, then the work,
   * then "You're all set".
   *
   * Like the connection card it is dark in both app themes, so no color here
   * comes from a theme variable.
   */
  import "./connection-card.css";
  import ConnectionCardLogo from "./ConnectionCardLogo.svelte";
  import aurora from "../create-bot/assets/new-bot-wallpapers/aurora.jpg";
  import glassWhiteboard from "../create-bot/assets/new-bot-wallpapers/glass-whiteboard.jpg";
  import nodeConstellation from "../create-bot/assets/new-bot-wallpapers/node-constellation.jpg";
  import roadSunrise from "../create-bot/assets/new-bot-wallpapers/road-sunrise.jpg";
  import type { RepairAction, RepairCardView, RepairClass } from "./runtime-repair-model.js";

  interface Props {
    view: RepairCardView;
    onaction?: (action: RepairAction) => void | Promise<void>;
  }

  let { view, onaction }: Props = $props();

  /**
   * One bundled New Bot wallpaper per problem, cropped like the connection
   * cards. The card keeps its art through working and fixed, so it reads as
   * one card changing in place.
   */
  const ART: Record<RepairClass, { url: string; position: string }> = {
    "signed-out": { url: aurora, position: "center 30%" },
    "cli-outdated": { url: roadSunrise, position: "center 60%" },
    "model-unsupported": { url: glassWhiteboard, position: "center 40%" },
    transient: { url: nodeConstellation, position: "center 70%" },
  };

  const art = $derived(ART[view.art]);
  /** The connection card's states: working takes the connecting edge, fixed the connected glass. */
  const cardState = $derived(view.phase === "working" ? "connecting" : view.phase === "fixed" ? "connected" : "offered");
  const working = $derived(view.phase === "working");

  /** A press the host has not finished with. A double click acts once. */
  let pressed = $state(false);

  function press(action: RepairAction | null): void {
    if (!action || pressed || working) return;
    pressed = true;
    let result: void | Promise<void>;
    try {
      result = onaction?.(action);
    } catch {
      pressed = false;
      return;
    }
    const done = (): void => {
      pressed = false;
    };
    void Promise.resolve(result).then(done, done);
  }
</script>

<div
  class="connection-card"
  data-testid="runtime-repair-card"
  data-kind="runtime-repair"
  data-class={view.repairClass}
  data-phase={view.phase}
  data-state={cardState}
  role="group"
  aria-label={view.title}
  aria-busy={working ? "true" : undefined}
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
      <ConnectionCardLogo logo={view.logo} size={28} />
      <span class="connection-card-title" data-testid="runtime-repair-title">{view.title}</span>
      {#if view.mark && working}
        <span class="connection-card-mark is-working" data-testid="runtime-repair-mark" role="status">
          <span class="connection-card-spin" aria-hidden="true"></span>
          {view.mark}
        </span>
      {:else if view.mark}
        <span class="connection-card-mark" data-testid="runtime-repair-mark" role="status">
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M6.5 11L3.5 8l1-1 2 2 5-5 1 1z" fill="currentColor" /></svg>
          {view.mark}
        </span>
      {/if}
    </div>
    <div class="connection-card-line" data-testid="runtime-repair-line" title={view.line}>{view.line}</div>
    {#if view.note}
      <div class="connection-card-note" data-testid="runtime-repair-note" role="status" title={view.note}>{view.note}</div>
    {/if}
  </div>
  {#if view.primaryLabel || view.secondaryLabel}
    <div class="connection-card-actions">
      {#if view.primaryLabel}
        <button
          type="button"
          class="connection-card-btn is-primary"
          data-testid="runtime-repair-primary"
          data-action={view.primaryAction ?? undefined}
          disabled={working || pressed || !view.primaryAction}
          onclick={() => press(view.primaryAction)}
        >
          {view.primaryLabel}
        </button>
      {/if}
      {#if view.secondaryLabel}
        <button
          type="button"
          class="connection-card-btn is-quiet"
          data-testid="runtime-repair-secondary"
          data-action={view.secondaryAction ?? undefined}
          disabled={working || pressed || !view.secondaryAction}
          onclick={() => press(view.secondaryAction)}
        >
          {view.secondaryLabel}
        </button>
      {/if}
    </div>
  {/if}
</div>
