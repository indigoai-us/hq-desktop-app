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

  /**
   * `?crowd=1` adds a company-sized map (about 1,900 objects with a few huge
   * folders and long names) to the smoke graph, to judge the layout at the
   * scale a real vault has. The first 40 projects use a repo and cite a
   * knowledge file and a policy, so hovering a project lights its relations.
   * Deterministic.
   */
  function crowdGraph<G extends { nodes: unknown[]; edges?: unknown[] }>(base: G, scale: number): G {
    const now = Date.UTC(2026, 8, 30, 12);
    const sizes = { project: 700, knowledge: 520, policy: 430, repo: 22, worker: 60, skill: 90 } as const;
    const folders = { project: "projects", knowledge: "knowledge", policy: "policies", repo: "repos", worker: "workers", skill: "skills" } as const;
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
    const nodes = [...base.nodes];
    for (const [type, total] of Object.entries(sizes) as [keyof typeof sizes, number][]) {
      for (let i = 0; i < Math.round(total * scale); i += 1) {
        const roll = rand();
        const count = roll > 0.985 ? 4000 + Math.round(rand() * 20000) : roll > 0.9 ? 40 + Math.round(rand() * 300) : 1 + Math.round(rand() * 8);
        const age = rand() > 0.93 ? rand() * 2 : 5 + rand() * 120;
        const label = type === "policy" && i % 7 === 0 ? `indigo sentry feedback check already fixed stale ${i}` : `${type} item ${i}`;
        nodes.push({
          id: `${type}:${folders[type]}/crowd-${i}/`,
          type,
          label,
          path: `${folders[type]}/crowd-${i}/`,
          folder: true,
          count,
          touched: now - age * 86_400_000,
          created: now - (age + 30) * 86_400_000,
          ...(type === "project" ? { stories: { done: Math.round(rand() * 4), total: 1 + Math.round(rand() * (roll > 0.9 ? 80 : 9)) } } : {}),
        });
      }
    }
    const edges = [...(base.edges ?? [])];
    for (let i = 0; i < Math.min(40, Math.round(sizes.project * scale)); i += 1) {
      const source = `project:projects/crowd-${i}/`;
      const pick = (type: keyof typeof sizes, n: number) => `${type}:${folders[type]}/crowd-${n % Math.max(1, Math.round(sizes[type] * scale))}/`;
      edges.push({ source, target: pick("repo", i), kind: "uses" });
      edges.push({ source, target: pick("knowledge", i * 7), kind: "cites" });
      edges.push({ source, target: pick("policy", i * 11), kind: "cites" });
    }
    return { ...base, nodes, edges };
  }

  onMount(() => {
    theme = new URLSearchParams(location.search).get("theme") ?? "dark";
    void loadAtlas().then((m) => {
      const crowd = new URLSearchParams(location.search).get("crowd");
      const graph = crowd ? crowdGraph(m.smokeAtlasGraph("Indigo"), Number(crowd) || 1) : m.smokeAtlasGraph("Indigo");
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
