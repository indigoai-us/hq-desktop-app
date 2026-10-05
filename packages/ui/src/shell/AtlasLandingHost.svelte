<!--
  Atlas landing (console-rail US-009). A company tile lands here.

  The Atlas chunk loads through the lazy door; the first frame is the
  atlas loader so the click never paints a blank or spinner-only
  pane. When the chunk resolves (US-013) the map mounts with the company's
  cached graph and refreshes it in the background; live halos, docked actor
  chips and the people filter come from the shell's presence stores.
-->
<script lang="ts">
  import { onMount } from "svelte";
  import ReadLoader from "../common/ReadLoader.svelte";
  import { loadAtlas } from "./atlas-lazy.js";
  import type { AtlasLiveActor, AtlasWorkingNow } from "./atlas-landing.js";
  import { HQ_CONSOLE_BASE } from "../common/hq-console.js";
  import { useCompanySummary } from "../company/company-summary.svelte.js";
  import type { AtlasLocalSource, AtlasVaultSource } from "./atlas-landing.js";
  import { atlasNodeDestination, type AtlasActionNode } from "./atlas-landing.js";
  import type { NavigationDestination } from "./navigation-history.js";
  import { loadLocalProjects, ProjectsUnavailableError } from "../projects/local-projects.js";
  import { boardProjectsInProgress } from "../projects/projects-model.js";
  import { requestLiveRefresh } from "../mesh/live-refresh.js";

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
    /** Empty company prompts (US-014): open a company page by sidepane row id. */
    onopenpage?: (rowId: string) => void;
    /** Shell navigation for the inspector's Open files / Open board (QA-066). */
    onnavigate?: (destination: NavigationDestination) => void;
    /** Injected graph cache (tests); defaults to the shared Console cache. */
    atlasCache?: AtlasCache | null;
    /**
     * Native hosts: build the graph from the vault through the platform
     * adapter (the app's own HQ sign-in). Without it the Console endpoint,
     * which needs a web session, is used (QA-016).
     */
    atlasSource?: AtlasVaultSource | null;
    /**
     * Native hosts: the company folder synced to this machine. Paints the
     * district roots at once and fills the rest from a revision-cached
     * listing; `atlasSource` is the fallback when the folder is missing.
     */
    atlasLocal?: AtlasLocalSource | null;
    /** OWNER-R4: company telemetry for the Atlas People & agents list. */
    loadPeople?: (() => Promise<unknown>) | null;
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
    onopenpage,
    onnavigate,
    atlasCache = null,
    atlasSource = null,
    atlasLocal = null,
    loadPeople = null,
  }: Props = $props();

  // Who is working now comes from the live read. Ask for it when Atlas opens
  // on a company: until now it only arrived on a realtime reconnect or a live
  // wake, so a company with no wake since launch showed "Nobody is working".
  $effect(() => {
    const uid = companyUid?.trim();
    if (uid) requestLiveRefresh(uid);
  });

  // Shared cache with the company sidepane: paints the warm summary first and
  // refreshes in the background. No poller.
  const summary = useCompanySummary({
    slug: () => slug?.trim() || null,
    enabled: () => summaryEnabled,
  });
  // In progress comes from the same projects and board status helper as the
  // Projects page (QA-065); the cached summary only fills in until it loads.
  let boardInProgress = $state<number | null>(null);
  let boardRequest = 0;
  $effect(() => {
    const boardSlug = slug?.trim() || null;
    const request = ++boardRequest;
    boardInProgress = null;
    if (!boardSlug) return;
    loadLocalProjects()
      .then((projects) => {
        if (request === boardRequest) boardInProgress = boardProjectsInProgress(projects, boardSlug);
      })
      .catch((err) => {
        if (!(err instanceof ProjectsUnavailableError)) {
          console.warn(`Atlas projects in progress for ${boardSlug} failed:`, err);
        }
      });
  });
  const projectsInProgress = $derived(boardInProgress ?? summary.summary.board);

  let mod = $state<AtlasModule | null>(null);
  const cache = $derived.by(() => {
    if (!mod) return null;
    if (atlasCache) return atlasCache;
    const localSlug = slug?.trim();
    if (atlasLocal && localSlug) {
      return mod.sharedAtlasCache(`local:${localSlug}`, mod.localAtlasFetcher(atlasLocal, localSlug, atlasSource));
    }
    if (atlasSource) return mod.sharedAtlasCache("vault", mod.vaultAtlasFetcher(atlasSource));
    return mod.sharedAtlasCache(HQ_CONSOLE_BASE);
  });

  // A failed chunk load used to leave "Loading" up forever (QA-016).
  let chunkFailed = $state(false);
  let alive = true;

  function loadChunk(): void {
    chunkFailed = false;
    loadAtlas()
      .then((loaded) => {
        if (alive) mod = loaded;
      })
      .catch((err) => {
        console.error("Atlas chunk failed to load:", err);
        if (alive) chunkFailed = true;
      });
  }

  onMount(() => {
    alive = true;
    loadChunk();
    return () => {
      alive = false;
    };
  });

  function openNode(node: AtlasActionNode, action: "files" | "board"): void {
    const destination = atlasNodeDestination(node, slug, action);
    if (destination) onnavigate?.(destination);
  }

  function selectWho(id: string): void {
    if (id.startsWith("person:")) onopenperson?.(id.slice("person:".length));
  }
</script>

<section class="atlas-landing" data-testid="atlas-landing" aria-busy={mod || chunkFailed ? undefined : "true"}>
  {#if mod && cache && companyUid}
    <mod.AtlasView
      {companyUid}
      companyName={companyLabel}
      {cache}
      {actors}
      {filterActor}
      {onclearfilter}
      {onopenpage}
      projectsInProgress={boardInProgress}
      {loadPeople}
      onopenfiles={(node) => openNode(node, "files")}
      onopenboard={(node) => openNode(node, "board")}
      onopenperson={(uid) => onopenperson?.(uid)}
      onmessage={(who) => {
        if (who.actorUid) onopenperson?.(who.actorUid);
      }}
    />
  {:else}
  <header class="toolbar">
    <h1>Atlas</h1>
  </header>
  {#if !mod && !chunkFailed}<ReadLoader testid="atlas-landing-loading" surface="atlas" onretry={loadChunk} />{/if}
  <div class="body">
    <div class="stage" aria-hidden="true">
      <svg viewBox="0 0 900 640" preserveAspectRatio="xMidYMid meet">
        <circle class="ring" cx="450" cy="320" r="250" />
        <circle class="ring" cx="450" cy="320" r="150" />
      </svg>
      {#if chunkFailed}
        <div class="note" data-testid="atlas-landing-error" role="alert">
          The map didn't load.
          <button type="button" data-testid="atlas-landing-retry" onclick={loadChunk}>Retry</button>
        </div>
      {:else if mod && !companyUid}<div class="note" data-testid="atlas-landing-unlinked">This company isn't linked to HQ cloud yet, so there is no map to show.</div>{/if}
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
</style>
