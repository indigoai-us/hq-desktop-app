<!--
  Atlas landing (console-rail US-009). A company tile lands here.

  The Atlas chunk loads through the lazy door; the first frame is the
  atlas-loading skeleton so the click never paints a blank or spinner-only
  pane. When the chunk resolves (US-013) the map mounts with the company's
  cached graph and refreshes it in the background; live halos, docked actor
  chips and the people filter come from the shell's presence stores.
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { loadAtlas } from "./atlas-lazy.js";
  import type { AtlasLiveActor, AtlasWorkingNow } from "./atlas-landing.js";
  import { HQ_CONSOLE_BASE } from "../common/hq-console.js";
  import { useCompanySummary } from "../company/company-summary.svelte.js";

  type AtlasModule = Awaited<ReturnType<typeof loadAtlas>>;
  type AtlasCache = ReturnType<AtlasModule["createAtlasCache"]>;

  interface Props {
    companyLabel: string;
    workingNow: readonly AtlasWorkingNow[];
    /** Company slug for the cached summary; projects in progress come from it. */
    slug?: string | null;
    /** False when the host has no company backend (summary stays empty). */
    summaryEnabled?: boolean;
    onopenperson?: (uid: string) => void;
    /** Company uid for the Atlas graph; without one the map stays unmounted. */
    companyUid?: string | null;
    /** Live actors from PresenceStore + LiveReadStore (US-013). */
    actors?: readonly AtlasLiveActor[];
    /** Sidepane people filter (actor uid) and its clear action. */
    filterActor?: string | null;
    onclearfilter?: () => void;
    /** Injected graph cache (tests); defaults to the shared Console cache. */
    atlasCache?: AtlasCache | null;
  }

  let {
    companyLabel,
    workingNow,
    slug = null,
    summaryEnabled = false,
    onopenperson,
    companyUid = null,
    actors = [],
    filterActor = null,
    onclearfilter,
    atlasCache = null,
  }: Props = $props();

  // Shared cache with the company sidepane: paints the warm summary first and
  // refreshes in the background. No poller.
  const summary = useCompanySummary({
    slug: () => slug?.trim() || null,
    enabled: () => summaryEnabled,
  });
  const projectsInProgress = $derived(summary.summary.board);

  let mod = $state<AtlasModule | null>(null);
  const cache = $derived(mod ? (atlasCache ?? mod.sharedAtlasCache(HQ_CONSOLE_BASE)) : null);

  onMount(() => {
    let alive = true;
    loadAtlas()
      .then((loaded) => {
        if (alive) mod = loaded;
      })
      .catch((err) => {
        console.error("Atlas chunk failed to load:", err);
      });
    return () => {
      alive = false;
    };
  });

  function selectWho(id: string): void {
    if (id.startsWith("person:")) onopenperson?.(id.slice("person:".length));
  }
</script>

<section class="atlas-landing" data-testid="atlas-landing" aria-busy={mod ? undefined : "true"}>
  {#if mod && cache && companyUid}
    <mod.AtlasView
      {companyUid}
      companyName={companyLabel}
      {cache}
      {actors}
      {filterActor}
      {onclearfilter}
      onopenperson={(uid) => onopenperson?.(uid)}
      onmessage={(who) => {
        if (who.actorUid) onopenperson?.(who.actorUid);
      }}
    />
  {:else}
  <header class="toolbar">
    <h1>Atlas</h1>
  </header>
  <div class="body">
    <div class="stage" aria-hidden="true">
      <svg viewBox="0 0 900 640" preserveAspectRatio="xMidYMid meet">
        <circle class="ring" cx="450" cy="320" r="250" />
        <circle class="ring" cx="450" cy="320" r="150" />
      </svg>
      {#if !mod}<div class="note">Loading {companyLabel}</div>{/if}
    </div>
    {#if mod}
      <mod.AtlasInspector
        node={null}
        detail={undefined}
        detailLoading={false}
        related={[]}
        presence={[...workingNow]}
        company={companyLabel}
        objectCount={null}
        {projectsInProgress}
        nowMs={Date.now()}
        onselect={selectWho}
      />
    {:else}
      <aside class="inspector-skeleton" data-testid="atlas-landing-skeleton" aria-hidden="true">
        <span class="sk" style="width:64px;height:8px"></span>
        <span class="sk" style="width:140px;height:14px"></span>
        <div class="chips">
          <span class="sk pill" style="width:96px"></span>
          <span class="sk pill" style="width:72px"></span>
        </div>
        <div class="hr"></div>
        <span class="sk" style="width:54px;height:8px"></span>
        <div class="who"><span class="sk dot"></span><span class="sk" style="width:90px;height:10px"></span></div>
        <div class="who"><span class="sk dot sq"></span><span class="sk" style="width:120px;height:10px"></span></div>
      </aside>
    {/if}
  </div>
  {/if}
</section>

<style>
  .atlas-landing {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    font-family: var(--font-sans);
  }
  .toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 44px;
    padding: 0 var(--v4-space-4);
    border-bottom: 1px solid var(--v4-rowline);
  }
  h1 {
    margin: 0;
    font-size: var(--type-section);
    font-weight: 600;
  }
  .body {
    display: flex;
    flex: 1 1 auto;
    min-height: 0;
  }
  .stage {
    position: relative;
    flex: 1 1 auto;
    min-width: 0;
  }
  .stage svg {
    width: 100%;
    height: 100%;
  }
  .ring {
    fill: none;
    stroke: var(--v4-rowline);
    stroke-width: 1;
    stroke-dasharray: 3 6;
  }
  .note {
    position: absolute;
    left: 50%;
    bottom: 14px;
    transform: translateX(-50%);
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--v4-text-3);
  }
  .inspector-skeleton {
    display: flex;
    flex-direction: column;
    gap: 10px;
    width: 340px;
    box-sizing: border-box;
    padding: var(--v4-space-4);
    border-left: 1px solid var(--v4-rowline);
    background: var(--v4-secondary-sidebar);
  }
  .chips,
  .who {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .hr {
    height: 1px;
    margin: 6px 0;
    background: var(--v4-rowline);
  }
  .sk {
    display: inline-block;
    border-radius: 4px;
    background: var(--v4-control-bg);
    animation: atlas-landing-pulse 1.8s ease-in-out infinite;
  }
  .sk.pill {
    height: 16px;
    border-radius: var(--v4-radius-pill);
  }
  .sk.dot {
    flex: none;
    width: 16px;
    height: 16px;
    border-radius: 50%;
  }
  .sk.dot.sq {
    border-radius: 5px;
  }
  @keyframes atlas-landing-pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.45;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .sk {
      animation: none;
    }
  }
</style>
