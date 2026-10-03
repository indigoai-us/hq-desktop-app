<script lang="ts">
  /**
   * DEV-ONLY harness for the Atlas map (US-012). Loads the Atlas chunk with
   * the same lazy door the shell will use, feeds it the smoke graph through a
   * stub fetcher, and never touches the network. `?theme=light` matches the
   * atlas-light storyboard scene.
   */
  import { dev } from "$app/environment";
  import { onMount } from "svelte";
  import { loadAtlas } from "@hq/ui";

  type AtlasModule = Awaited<ReturnType<typeof loadAtlas>>;

  let mod = $state<AtlasModule | null>(null);
  let cache = $state<ReturnType<AtlasModule["createAtlasCache"]> | null>(null);
  let theme = $state("dark");

  onMount(() => {
    theme = new URLSearchParams(location.search).get("theme") ?? "dark";
    void loadAtlas().then((m) => {
      const graph = m.smokeAtlasGraph("Indigo");
      cache = m.createAtlasCache({ fetcher: async () => graph });
      mod = m;
    });
  });
</script>

{#if dev}
  <div class="harness" data-theme={theme} data-appearance={theme}>
    {#if mod && cache}
      <mod.AtlasView
        companyUid="cmp_indigo"
        companyName="Indigo"
        {cache}
        nowMs={Date.UTC(2026, 8, 30, 12)}
        presence={[
          { nodeId: "project:projects/hq-desktop-console-rail/", name: "Corey", bot: false, signal: "editing design/design.md · 12 s" },
          { nodeId: "project:projects/hq-desktop-console-rail/", name: "deacon", bot: true, signal: "US-014 · desktop-alt e2e running · 14m" },
          { nodeId: "repo:repos/private/hq-desktop-app/", name: "Eric B.", bot: false, signal: "41m" },
        ]}
        loadDetail={async () => mod?.ATLAS_SMOKE_DETAIL}
      />
    {/if}
  </div>
{/if}

<style>
  .harness {
    position: fixed;
    inset: 0;
  }
</style>
