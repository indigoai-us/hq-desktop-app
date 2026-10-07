<script lang="ts">
  /**
   * Rail mount for personal Outpost.
   * The loader is the first frame. The body loads through the lazy door.
   */
  import { onMount } from "svelte";
  import ReadLoader from "../common/ReadLoader.svelte";
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
    <div class="loading" aria-busy="true">
      <ReadLoader testid="outpost-loading" />
    </div>
  {/if}
</div>

<style>
  .host { height: 100%; min-height: 0; }
  .loading { padding: 16px; }
</style>
