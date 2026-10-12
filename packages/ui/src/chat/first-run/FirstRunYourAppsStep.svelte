<script lang="ts">
  /**
   * First-run "Your apps" (integration auto-detect MVP): the body of the one
   * step that replaces Note taker and Project management. Every app found on
   * this computer, grouped by what is left to do (see your-apps.ts). The
   * takeover's Continue is always live; a connect still running finishes on
   * its own, as on the old app step.
   *
   * Approved surface: owner decision dec-20261012015131-z0g0 ("Add it to
   * install. We do not need Corey's OK"). The tile, pill and dot styles are
   * FirstRunAppStep's.
   */
  import { untrack } from "svelte";
  import ConnectionCardLogo from "../messaging/ConnectionCardLogo.svelte";
  import { appLogo } from "../messaging/integration-cards-model.js";
  import {
    FILTER_AFTER,
    NOT_IN_HQ_SHOWN,
    READY_SHOWN,
    YOUR_APPS_COPY,
    opensSignIn,
    signInRunning,
    type AppTile,
    type ConnectedChip,
    type YourAppsView,
  } from "./your-apps.js";

  interface Props {
    lead: string;
    view: YourAppsView;
    /** Catalog or connection read failed: one line above the groups. */
    problem?: { reason: string; retry: boolean } | null;
    onconnect: (tile: AppTile) => void;
    onsetup: (tile: AppTile) => void;
    onundo: (chip: ConnectedChip) => void;
    onreload?: () => void;
  }

  let { lead, view, problem = null, onconnect, onsetup, onundo, onreload }: Props = $props();

  let filter = $state("");
  let showAllReady = $state(false);
  let showAllNotInHq = $state(false);
  let showAlso = $state(false);

  const actionable = $derived(view.ready.length + view.notInHq.length);
  const needsFilter = $derived(actionable > FILTER_AFTER);
  const q = $derived(needsFilter ? filter.trim().toLocaleLowerCase() : "");
  const matches = (tile: AppTile): boolean =>
    !q || tile.name.toLocaleLowerCase().includes(q) || tile.domain.includes(q);
  const ready = $derived(view.ready.filter(matches));
  const notInHq = $derived(view.notInHq.filter(matches));
  const readyShown = $derived(showAllReady || q ? ready : ready.slice(0, READY_SHOWN));
  const notInHqShown = $derived(showAllNotInHq || q ? notInHq : notInHq.slice(0, NOT_IN_HQ_SHOWN));
  /** One browser sign-in at a time: other Connect, Set up and Try again presses wait for it. */
  const browserBusy = $derived(signInRunning(view));
  /** A connect that just failed is scrolled into view, so its reason is seen in a short window. */
  const failedKey = $derived(
    [...view.ready, ...view.notInHq].filter((t) => t.run.state === "failed").map((t) => t.domain).join(","),
  );
  // Tiles already failed when the step opens are not "new": no scroll on mount.
  let lastFailedKey = untrack(() => failedKey);
  /** Tiles by domain, bound in the snippet (no document-wide lookup). */
  const tileEls: Record<string, HTMLElement | undefined> = {};
  $effect(() => {
    const key = failedKey;
    if (!key || key === lastFailedKey) {
      lastFailedKey = key;
      return;
    }
    const before = lastFailedKey.split(",");
    const newest = key.split(",").find((d) => !before.includes(d));
    lastFailedKey = key;
    const tile = newest ? tileEls[newest] : undefined;
    if (tile && typeof tile.scrollIntoView === "function") tile.scrollIntoView({ block: "nearest" });
  });
  const alsoNames = $derived(view.alsoFound);
  const alsoShort = $derived(alsoNames.slice(0, 3));
  const alsoRest = $derived(alsoNames.length - alsoShort.length + view.unmatched);

  function label(tile: AppTile): string {
    switch (tile.run.state) {
      case "connecting":
        return tile.run.via === "browser" ? YOUR_APPS_COPY.waiting : YOUR_APPS_COPY.connecting;
      case "checking-docs":
        return YOUR_APPS_COPY.checking;
      case "failed":
        return YOUR_APPS_COPY.retry;
      default:
        break;
    }
    switch (tile.action) {
      case "setup":
        return YOUR_APPS_COPY.setup;
      case "not-yet":
        return YOUR_APPS_COPY.notYet;
      default:
        return YOUR_APPS_COPY.connect;
    }
  }

  function pressable(tile: AppTile): boolean {
    if (tile.run.state === "connecting" || tile.run.state === "checking-docs" || tile.run.state === "unsupported") return false;
    if (opensSignIn(tile) && browserBusy) return false;
    if (tile.run.state === "failed") return tile.run.retry;
    return opensSignIn(tile) || tile.action === "install" || tile.action === "integrations";
  }

  function press(tile: AppTile): void {
    if (!pressable(tile)) return;
    if (tile.action === "setup") onsetup(tile);
    else onconnect(tile);
  }

  /** Key and member tiles carry their reason in the note and show no button. */
  function hasButton(tile: AppTile): boolean {
    return tile.action !== "needs-key" && tile.action !== "admin-only";
  }

  function chipNote(chip: ConnectedChip): string {
    return chip.how === "team" ? YOUR_APPS_COPY.team : chip.how === "auto" ? YOUR_APPS_COPY.noSignIn : YOUR_APPS_COPY.you;
  }
</script>

<p class="new-bot-create-copy" data-testid="first-run-apps-lead">{lead}</p>
{#if problem}
  <p class="new-bot-price first-run-status" data-testid="first-run-apps-problem">
    {problem.reason}
    {#if problem.retry && onreload}<button type="button" class="new-bot-inline-link" data-testid="first-run-apps-reload" onclick={onreload}>Retry</button>{/if}
  </p>
{/if}
{#if needsFilter}
  <!-- Named for screen readers; the placeholder carries the hint on screen. -->
  <label class="sr-only" for="first-run-apps-filter">Find an app</label>
  <input
    id="first-run-apps-filter"
    class="new-bot-create-input found-filter"
    data-testid="first-run-apps-filter"
    value={filter}
    autocomplete="off"
    placeholder="Find an app"
    oninput={(event) => (filter = (event.currentTarget as HTMLInputElement).value)}
  />
{/if}

{#if view.connected.length}
  <section class="found-group" aria-labelledby="first-run-apps-connected" data-testid="first-run-apps-connected">
    <div class="found-group-head"><p class="found-group-title" id="first-run-apps-connected">{YOUR_APPS_COPY.groupConnected} · {view.connected.length}</p></div>
    <ul class="found-chips">
      {#each view.connected as chip (chip.domain)}
        <li class="found-chip" data-testid={`first-run-chip-${chip.domain}`}>
          <span class="first-run-app-dot" aria-hidden="true"></span>{chip.name}
          <span class="found-chip-note">{chipNote(chip)}</span>
          {#if chip.canUndo}
            <button
              type="button"
              class="first-run-app-undo"
              data-testid={`first-run-undo-${chip.domain}`}
              aria-label={`${YOUR_APPS_COPY.undo} ${chip.name}`}
              disabled={chip.undoing}
              aria-busy={chip.undoing ? "true" : undefined}
              onclick={() => onundo(chip)}
            >{YOUR_APPS_COPY.undo}</button>
          {/if}
        </li>
      {/each}
    </ul>
  </section>
{/if}

{#if ready.length}
  <section class="found-group" aria-labelledby="first-run-apps-ready" data-testid="first-run-apps-ready">
    <div class="found-group-head">
      <p class="found-group-title" id="first-run-apps-ready">{YOUR_APPS_COPY.groupReady} · {ready.length}</p>
      {#if !q && ready.length > READY_SHOWN && !showAllReady}
        <button type="button" class="new-bot-inline-link found-group-link" data-testid="first-run-apps-ready-all" onclick={() => (showAllReady = true)}>Show all {ready.length}</button>
      {:else}
        <span class="found-group-note">{YOUR_APPS_COPY.groupReadyNote}</span>
      {/if}
    </div>
    <ul class="first-run-apps">
      {#each readyShown as tile (tile.domain)}
        {@render appTile(tile)}
      {/each}
    </ul>
  </section>
{/if}

{#if notInHq.length}
  <section class="found-group" aria-labelledby="first-run-apps-not-in-hq" data-testid="first-run-apps-not-in-hq">
    <div class="found-group-head">
      <p class="found-group-title" id="first-run-apps-not-in-hq">{YOUR_APPS_COPY.groupNotInHq} · {notInHq.length}</p>
      {#if !q && notInHq.length > NOT_IN_HQ_SHOWN && !showAllNotInHq}
        <button type="button" class="new-bot-inline-link found-group-link" data-testid="first-run-apps-not-in-hq-all" onclick={() => (showAllNotInHq = true)}>Show all {notInHq.length}</button>
      {:else}
        <span class="found-group-note">{YOUR_APPS_COPY.groupNotInHqNote}</span>
      {/if}
    </div>
    <ul class="first-run-apps">
      {#each notInHqShown as tile (tile.domain)}
        {@render appTile(tile)}
      {/each}
    </ul>
  </section>
{/if}

{#if alsoRest > 0 || alsoShort.length}
  <section class="found-group" aria-labelledby="first-run-apps-also" data-testid="first-run-apps-also">
    <div class="found-group-head"><p class="found-group-title" id="first-run-apps-also">{YOUR_APPS_COPY.groupAlso}</p></div>
    <p class="found-rest">
      {#if showAlso}
        {alsoNames.join(", ")}{view.unmatched ? `${alsoNames.length ? ", and " : ""}${view.unmatched} more` : ""}.
      {:else}
        {alsoShort.join(", ")}{alsoRest > 0 ? `${alsoShort.length ? " and " : ""}${alsoRest} more` : ""}.
      {/if}
      {YOUR_APPS_COPY.alsoTail}
      {#if !showAlso && alsoNames.length > alsoShort.length}<button type="button" class="new-bot-inline-link" data-testid="first-run-apps-also-all" onclick={() => (showAlso = true)}>Show all</button>{/if}
    </p>
  </section>
{/if}

{#if needsFilter && q && !ready.length && !notInHq.length}<p class="new-bot-company-empty">No app matches that.</p>{/if}

{#snippet appTile(tile: AppTile)}
  {@const failed = tile.run.state === "failed"}
  {@const busy = tile.run.state === "connecting" || tile.run.state === "checking-docs"}
  <li class="first-run-app" class:failed bind:this={tileEls[tile.domain]} data-testid={`first-run-app-${tile.domain}`} data-action={tile.action} data-state={tile.run.state}>
    <ConnectionCardLogo logo={appLogo(tile.domain)} size={30} />
    <span class="first-run-app-text">
      <span class="first-run-app-name">{tile.name}</span>
      <!-- The note carries the tile's state (Connecting, Didn't connect and why): read out as it changes. -->
      <span class="first-run-app-note" aria-live="polite" title={tile.note} data-testid={`first-run-app-note-${tile.domain}`}>{tile.note}</span>
    </span>
    {#if hasButton(tile)}
      <button
        type="button"
        class="first-run-app-connect"
        class:docs={tile.action === "setup"}
        data-testid={`first-run-connect-${tile.domain}`}
        aria-label={`${label(tile)} ${tile.name}`}
        disabled={!pressable(tile)}
        aria-busy={busy ? "true" : undefined}
        onclick={() => press(tile)}
      >{label(tile)}</button>
    {/if}
  </li>
{/snippet}

<style>
  /* One compact line, so the apps themselves stay in view in a short window. */
  .found-filter {
    padding-block: 7px;
    font-size: 13px;
  }
  .found-group + .found-group,
  .new-bot-create-copy + .found-group {
    margin-top: 14px;
  }
  .found-group-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 10px;
    margin: 0 0 8px;
  }
  .found-group-title {
    margin: 0;
    color: rgba(255, 255, 255, 0.54);
    font-family: "Geist Mono", ui-monospace, Menlo, monospace;
    font-size: 10px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }
  .found-group-note {
    color: rgba(255, 255, 255, 0.38);
    font-size: 11px;
  }
  .found-group-link {
    color: var(--new-bot-muted);
    font-size: 11px;
  }
  .found-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .found-chip {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    border: 1px solid var(--new-bot-line);
    border-radius: 999px;
    padding: 5px 11px;
    background: rgba(255, 255, 255, 0.1);
    font-size: 12px;
    font-weight: 500;
  }
  .found-chip-note {
    color: var(--new-bot-muted);
    font-weight: 400;
  }
  .found-rest {
    margin: 0;
    color: rgba(255, 255, 255, 0.5);
    font-size: 12px;
    line-height: 1.5;
  }
  /* Two tiles across; one per row when the card is too narrow for the
     button and a short note (container query on the step body). */
  .first-run-apps {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
    margin: 0;
    padding: 0;
    list-style: none;
    container-type: inline-size;
  }
  @container (max-width: 470px) {
    .first-run-app {
      grid-column: 1 / -1;
    }
  }
  .first-run-app {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
    min-height: 52px;
    border: 1px solid var(--new-bot-line);
    border-radius: 12px;
    padding: 8px 10px;
    background: rgba(9, 9, 11, 0.36);
  }
  .first-run-app.failed {
    border-color: rgba(254, 202, 202, 0.42);
  }
  .first-run-app-text {
    display: grid;
    flex: 1 1 auto;
    gap: 1px;
    min-width: 0;
  }
  .first-run-app-name {
    overflow: hidden;
    font-size: 13px;
    font-weight: 500;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* Up to two lines, so a full sentence ("Needs a key. Add it later from
     Integrations.") is read, not cut off. */
  .first-run-app-note {
    display: -webkit-box;
    overflow: hidden;
    color: var(--new-bot-muted);
    font-size: 12px;
    line-height: 1.35;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
  }
  .first-run-app.failed .first-run-app-note {
    color: #fecaca;
    /* The reason is read in full, not cut off. */
    white-space: normal;
  }
  .first-run-app-connect {
    flex: 0 0 auto;
    border: 1px solid var(--new-bot-line);
    border-radius: 999px;
    padding: 5px 11px;
    background: rgba(255, 255, 255, 0.08);
    color: var(--new-bot-ink);
    font: inherit;
    font-size: 12px;
    white-space: nowrap;
    cursor: pointer;
  }
  .first-run-app-connect.docs {
    border-color: rgba(255, 181, 128, 0.45);
  }
  .first-run-app-connect:disabled {
    cursor: default;
    opacity: 0.7;
  }
  .first-run-app-connect:focus-visible,
  .first-run-app-undo:focus-visible {
    outline: 1px solid var(--new-bot-ink);
    outline-offset: 2px;
  }
  .first-run-app-undo {
    border: 0;
    padding: 0;
    background: transparent;
    color: var(--new-bot-muted);
    font: inherit;
    font-size: 12px;
    text-decoration: underline;
    text-underline-offset: 3px;
    cursor: pointer;
  }
  .first-run-app-dot {
    flex: 0 0 auto;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #4ade80;
    box-shadow: 0 0 10px rgba(74, 222, 128, 0.55);
  }
</style>
