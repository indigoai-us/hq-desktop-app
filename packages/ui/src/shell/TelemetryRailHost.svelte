<script lang="ts">
  /**
   * Rail mount for My Telemetry. The heavy module loads through the lazy door.
   * The skeleton is the first frame so the click never paints a blank pane.
   */
  import { onMount } from "svelte";
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
    <div class="skeleton" data-testid="telemetry-skeleton" aria-busy="true">
      <aside>
        <div class="bar"></div>
        <div class="bar"></div>
        <div class="bar"></div>
      </aside>
      <main>
        <div class="title"></div>
        <div class="stats"></div>
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
  .bar, .title, .stats {
    border-radius: 6px;
    background: linear-gradient(90deg, var(--v4-control-faint), var(--v4-hover), var(--v4-control-faint));
    background-size: 200% 100%;
    animation: telem-skel 1.1s linear infinite;
  }
  .bar { height: 31px; margin-bottom: 2px; border-radius: 8px; }
  .title { height: 25px; width: 180px; }
  .stats { height: 72px; margin-top: 16px; }
  @keyframes telem-skel { from { background-position: 100% 0; } to { background-position: -100% 0; } }
</style>
