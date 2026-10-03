<script lang="ts">
  /**
   * Rail mount for personal Outpost.
   * The skeleton is the first frame. The body loads through the lazy door.
   */
  import { onMount } from "svelte";
  import { loadOutpost } from "./outpost-lazy.js";
  import type { OutpostReadApi } from "../outpost/outpost-live.js";

  interface Props {
    /** The desktop hq-pro client (adapter.agents). */
    api?: OutpostReadApi | null;
    openExternal?: (url: string) => void;
    /** RELEASE-001 gate: false keeps only the status card and host settings. */
    full?: boolean;
  }

  let { api = null, openExternal, full = true }: Props = $props();

  let Body = $state<typeof import("../outpost/OutpostPage.svelte").default | null>(null);

  onMount(() => {
    void loadOutpost().then((mod) => {
      Body = mod.default;
    });
  });
</script>

<div class="host" data-testid="outpost-rail-host">
  {#if Body}
    <Body {api} {openExternal} {full} />
  {:else}
    <div class="skeleton" data-testid="outpost-skeleton" aria-busy="true">
      <aside>
        <div class="bar"></div>
        <div class="bar"></div>
        <div class="bar"></div>
        <div class="bar"></div>
      </aside>
      <main>
        <div class="title"></div>
        <div class="row"></div>
        <div class="row"></div>
        <div class="row"></div>
      </main>
    </div>
  {/if}
</div>

<style>
  .host { height: 100%; min-height: 0; }
  .skeleton {
    display: grid;
    grid-template-columns: 260px minmax(0, 1fr);
    height: 100%;
    gap: 16px;
    padding: 16px;
  }
  .bar, .title, .row {
    border-radius: 6px;
    background: linear-gradient(90deg, var(--v4-control-faint), var(--v4-hover), var(--v4-control-faint));
    background-size: 200% 100%;
    animation: outpost-skel 1.1s linear infinite;
  }
  .bar { height: 28px; margin-bottom: 8px; }
  .title { height: 28px; width: 180px; }
  .row { height: 36px; margin-top: 8px; }
  @keyframes outpost-skel { from { background-position: 100% 0; } to { background-position: -100% 0; } }
</style>
