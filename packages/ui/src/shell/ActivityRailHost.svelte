<script lang="ts">
  /**
   * Company Activity mount. The page module loads after the first frame
   * so it stays off the boot path. The loader is that first frame.
   */
  import { onMount } from "svelte";
  import ReadLoader from "../common/ReadLoader.svelte";
  import type { PlatformAdapter } from "@hq/platform";

  interface Props {
    slug: string;
    companyLabel: string;
    adapter?: Pick<PlatformAdapter, "company"> | null;
    companyUid?: string | null;
    avatarByUid?: Readonly<Record<string, string>>;
    onsignin?: () => void | Promise<void>;
  }

  let { slug, companyLabel, adapter = null, companyUid = null, avatarByUid = {}, onsignin }: Props = $props();

  let View = $state<typeof import("../activity/ActivityView.svelte").default | null>(null);

  onMount(() => {
    void import("../activity/ActivityView.svelte").then((mod) => {
      View = mod.default;
    });
  });
</script>

<div class="host" data-testid="activity-host">
  {#if View}
    <View {slug} {companyLabel} {adapter} {companyUid} {avatarByUid} {onsignin} />
  {:else}
    <div class="loading">
      <ReadLoader testid="activity-loading" />
    </div>
  {/if}
</div>

<style>
  .host { height: 100%; min-height: 0; }
  .loading { padding: 16px; }
</style>
