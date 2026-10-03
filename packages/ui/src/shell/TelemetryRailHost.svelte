<script lang="ts">
  /**
   * Rail mount for My Telemetry. The heavy module loads through the lazy door.
   * The loader is the first frame so the click never paints a blank pane.
   */
  import { onMount } from "svelte";
  import ReadLoader from "../common/ReadLoader.svelte";
  import { loadTelemetry } from "./telemetry-lazy.js";
  import type { MyTelemetryApi } from "../telemetry/telemetry-me.js";

  type TelemetryModule = Awaited<ReturnType<typeof loadTelemetry>>;

  interface Props {
    /** Platform agents API; its getMyTelemetry reads hq-pro /v1/telemetry/me. */
    agents?: MyTelemetryApi | null;
  }

  let { agents = null }: Props = $props();

  let mod = $state<TelemetryModule | null>(null);
  let cache = $state<ReturnType<TelemetryModule["createTelemetryCache"]> | null>(null);

  onMount(() => {
    const storage = typeof localStorage === "undefined" ? null : localStorage;
    void loadTelemetry().then((loaded) => {
      cache = loaded.createTelemetryCache({
        storage,
        fetcher: loaded.createMyTelemetryFetcher(agents),
      });
      mod = loaded;
    });
  });
</script>

<div class="host" data-testid="telemetry-host">
  {#if mod && cache}
    <mod.TelemetryView {cache} />
  {:else}
    <div class="loading" aria-busy="true">
      <ReadLoader testid="telemetry-loading" />
    </div>
  {/if}
</div>

<style>
  .host { height: 100%; min-height: 0; }
  .loading { padding: 8px; }
</style>
