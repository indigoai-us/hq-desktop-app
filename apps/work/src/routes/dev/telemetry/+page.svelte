<script lang="ts">
  /**
   * DEV-ONLY harness for My Telemetry (US-032). Same lazy door the rail uses.
   */
  import { dev } from "$app/environment";
  import { onMount } from "svelte";
  import { loadTelemetry } from "@hq/ui";

  type TelemetryModule = Awaited<ReturnType<typeof loadTelemetry>>;

  let mod = $state<TelemetryModule | null>(null);
  let cache = $state<ReturnType<TelemetryModule["createTelemetryCache"]> | null>(null);

  onMount(() => {
    void loadTelemetry().then((loaded) => {
      cache = loaded.createTelemetryCache({
        fetcher: async () => loaded.TELEMETRY_SMOKE,
        storage: null,
      });
      mod = loaded;
    });
  });
</script>

{#if dev}
  <div class="harness">
    {#if mod && cache}
      <mod.TelemetryView {cache} />
    {:else}
      <div data-testid="telemetry-skeleton" aria-busy="true"></div>
    {/if}
  </div>
{/if}

<style>
  .harness { position: fixed; inset: 0; }
</style>
