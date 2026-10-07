<!--
  First frame of the live Transcript tab. A quiet line paints at once; the
  body chunk (poller and transcript rendering) loads after. Nothing here is
  on the boot path.
-->
<script lang="ts">
  import RailIcon from "../common/button/RailIcon.svelte";
  import { onMount } from "svelte";
  import type { Component } from "svelte";
  import { loadLiveTranscript } from "./live-transcript-lazy";

  let { ...rest }: Record<string, unknown> = $props();
  let Body = $state<Component | null>(null);
  let failed = $state(false);

  function load(): void {
    failed = false;
    void loadLiveTranscript()
      .then((mod) => {
        Body = mod.default as Component;
      })
      .catch((err) => {
        console.warn("[meetings] live transcript view failed to load", err);
        failed = true;
      });
  }

  onMount(load);
</script>

{#if Body}
  <Body {...rest} />
{:else if failed}
  <button type="button" class="retry" onclick={load}><RailIcon name="refresh" />Tap to retry</button>
{:else}
  <p class="wait" data-testid="live-transcript-skeleton" aria-busy="true">Connecting to the notetaker…</p>
{/if}

<style>
  .wait { margin: 4px 0; color: var(--t2); font-size: 13px; }
  .retry {
    margin: 4px 0;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--t2);
    font: inherit;
    font-size: 13px;
    cursor: pointer;
  }
</style>
