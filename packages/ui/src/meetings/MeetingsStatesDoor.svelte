<!--
  First frame for US-022 states. Skeleton paints immediately; the body chunk
  loads after. Nothing here is on the boot path before the Meetings route.
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { loadMeetingsStates } from "./meetings-states-lazy";
  import type { Component } from "svelte";

  let { ...rest }: Record<string, unknown> = $props();
  let Body = $state<Component | null>(null);
  let failed = $state(false);

  onMount(() => {
    let alive = true;
    void loadMeetingsStates()
      .then((mod) => {
        if (alive) Body = mod.default as Component;
      })
      .catch(() => {
        if (alive) failed = true;
      });
    return () => {
      alive = false;
    };
  });
</script>

{#if Body}
  <Body {...rest} />
{:else}
  <div class="sk" data-testid="meetings-states-skeleton" aria-busy="true" aria-label="Loading meeting">
    <div class="bar"></div>
    <div class="line"></div>
    <div class="line short"></div>
    {#if failed}<p>Could not open this meeting view.</p>{/if}
  </div>
{/if}

<style>
  .sk { padding: 16px 24px; }
  .bar, .line {
    height: 12px;
    margin: 10px 0;
    border-radius: 6px;
    background: var(--hover);
  }
  .bar { width: 40%; height: 18px; }
  .line.short { width: 55%; }
  p { color: var(--t2); font-size: 13px; }
</style>
