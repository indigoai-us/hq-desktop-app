<script lang="ts">
  /**
   * Company Goals mount. The page module loads after the first frame.
   */
  import { onMount } from "svelte";
  import ReadLoader from "../common/ReadLoader.svelte";
  import type { PlatformAdapter } from "@hq/platform";

  interface Props {
    adapter: PlatformAdapter;
    slug: string;
    canEdit?: boolean;
    onopenproject?: (projectId: string) => void;
  }

  let { adapter, slug, canEdit = true, onopenproject }: Props = $props();

  let View = $state<typeof import("../goals/GoalsView.svelte").default | null>(null);

  onMount(() => {
    void import("../goals/GoalsView.svelte").then((mod) => {
      View = mod.default;
    });
  });
</script>

<div class="host" data-testid="goals-host">
  {#if View}
    <View {adapter} {slug} {canEdit} {onopenproject} />
  {:else}
    <div class="loading" aria-busy="true">
      <ReadLoader testid="goals-loading" />
    </div>
  {/if}
</div>

<style>
  .host { height: 100%; min-height: 0; }
  .loading { padding: 16px; }
</style>
