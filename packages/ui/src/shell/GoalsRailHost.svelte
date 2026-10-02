<script lang="ts">
  /**
   * Company Goals mount. The page module loads after the first frame.
   */
  import { onMount } from "svelte";
  import type { PlatformAdapter } from "@hq/platform";

  interface Props {
    adapter: PlatformAdapter;
    slug: string;
  }

  let { adapter, slug }: Props = $props();

  let View = $state<typeof import("../goals/GoalsView.svelte").default | null>(null);

  onMount(() => {
    void import("../goals/GoalsView.svelte").then((mod) => {
      View = mod.default;
    });
  });
</script>

<div class="host" data-testid="goals-host">
  {#if View}
    <View {adapter} {slug} />
  {:else}
    <div class="skeleton" data-testid="goals-skeleton" aria-busy="true">
      <div class="title"></div>
      <div class="row"></div>
      <div class="row"></div>
    </div>
  {/if}
</div>

<style>
  .host { height: 100%; min-height: 0; }
  .skeleton { padding: 16px; }
  .title, .row {
    border-radius: 6px;
    background: linear-gradient(90deg, var(--v4-control-faint), var(--v4-hover), var(--v4-control-faint));
    background-size: 200% 100%;
  }
  .title { height: 28px; width: 160px; }
  .row { height: 64px; margin-top: 10px; }
</style>
