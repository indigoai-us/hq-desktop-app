<script lang="ts">
  import aurora from "./assets/new-bot-wallpapers/aurora.jpg";
  import glassWhiteboard from "./assets/new-bot-wallpapers/glass-whiteboard.jpg";
  import nodeConstellation from "./assets/new-bot-wallpapers/node-constellation.jpg";
  import roadSunrise from "./assets/new-bot-wallpapers/road-sunrise.jpg";
  import { focusOnMount, portal } from "../portal.js";
  import type { AdapterPromise, AgentProvisionOptionsView } from "@hq/platform";
  import type { CloudBotDraft, EntryPointResult } from "../lifecycle-entry-points.js";
  import NewBotCreateScreen from "./NewBotCreateScreen.svelte";
  import "./new-bot-takeover.css";

  interface Props {
    canCreateLocalBot?: boolean;
    oncancel: () => void;
    oncomplete?: (() => void) | null;
    onopenlocal?: (() => void) | null;
    companies?: ReadonlyArray<{ companyUid: string; label: string }>;
    currentCompanyUid?: string | null;
    runtimeReady?: Record<string, boolean> | null;
    loadProvisionOptions?: ((companyUid: string) => AdapterPromise<AgentProvisionOptionsView>) | null;
    oncreate?: ((companyUid: string, draft: CloudBotDraft) => Promise<EntryPointResult>) | null;
    /** Test seam. Production starts on the first clean bundled wallpaper. */
    wallpaperIndex?: number;
  }

  let {
    canCreateLocalBot = false,
    oncancel,
    oncomplete = null,
    onopenlocal = null,
    companies = [],
    currentCompanyUid = null,
    runtimeReady = null,
    loadProvisionOptions = null,
    oncreate = null,
    wallpaperIndex = 0,
  }: Props = $props();

  const wallpapers = [glassWhiteboard, roadSunrise, nodeConstellation, aurora];
  const wallpaper = $derived(wallpapers[Math.abs(wallpaperIndex) % wallpapers.length] ?? glassWhiteboard);

  let dialogEl = $state<HTMLDivElement | null>(null);

  const focusableSelector =
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      oncancel();
      return;
    }
    if (event.key !== "Tab") return;

    const focusable = dialogEl
      ? [...dialogEl.querySelectorAll<HTMLElement>(focusableSelector)]
      : [];
    if (focusable.length === 0) return;

    event.preventDefault();
    const index = focusable.indexOf(document.activeElement as HTMLElement);
    if (index === -1) {
      focusable[event.shiftKey ? focusable.length - 1 : 0]?.focus();
      return;
    }
    const nextIndex = event.shiftKey
      ? (index - 1 + focusable.length) % focusable.length
      : (index + 1) % focusable.length;
    focusable[nextIndex]?.focus();
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div
  bind:this={dialogEl}
  class="new-bot-takeover"
  data-testid="new-bot-takeover"
  role="dialog"
  aria-modal="true"
  aria-labelledby="new-bot-takeover-title"
  tabindex="-1"
  style={`--new-bot-wallpaper: url("${wallpaper}")`}
  use:portal
>
  <div class="new-bot-takeover-shade" aria-hidden="true"></div>
  <header class="new-bot-takeover-header">
    <span class="new-bot-takeover-wordmark">HQ</span>
    <button
      type="button"
      class="new-bot-takeover-cancel"
      data-testid="new-bot-takeover-cancel"
      use:focusOnMount
      onclick={oncancel}
    >
      Cancel
    </button>
  </header>

  <main class="new-bot-takeover-stage">
    <div class="new-bot-takeover-card">
      {#if oncreate && oncomplete && loadProvisionOptions && companies.length}
        <NewBotCreateScreen
          {companies}
          {currentCompanyUid}
          {runtimeReady}
          loadProvisionOptions={loadProvisionOptions}
          oncreate={oncreate}
          oncomplete={oncomplete}
        />
      {:else}
        <p class="new-bot-takeover-kicker">A new teammate</p>
        <h1 id="new-bot-takeover-title">
          Meet your <em>next</em> bot.
        </h1>
        <p class="new-bot-takeover-copy">
          Give it a name, choose a brain, and it will be ready to talk in HQ.
        </p>
        <p class="new-bot-takeover-next">Name and brain are next.</p>
      {/if}

      {#if canCreateLocalBot && onopenlocal}
        <button
          type="button"
          class="new-bot-takeover-local"
          data-testid="new-bot-takeover-local"
          onclick={onopenlocal}
        >
          Create a local bot instead
        </button>
      {/if}
    </div>
  </main>
</div>
