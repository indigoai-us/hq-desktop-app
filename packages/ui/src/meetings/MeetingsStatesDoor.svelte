<!--
  First frame for US-022 states. The loader paints immediately; the body chunk
  loads after. Nothing here is on the boot path before the Meetings route.
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { loadMeetingsStates } from "./meetings-states-lazy";
  import ReadLoader from "../common/ReadLoader.svelte";
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
  <div class="sk" aria-busy={failed ? undefined : "true"} aria-label="Loading meeting">
    {#if failed}<p>Could not open this meeting view.</p>{:else}<ReadLoader testid="meetings-states-loading" surface="meetings" />{/if}
  </div>
{/if}

<style>
  .sk { padding: 16px 24px; }
  p { color: var(--t2); font-size: 13px; }
</style>
