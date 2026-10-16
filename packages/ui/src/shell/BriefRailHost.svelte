<script lang="ts">
  /**
   * Rail mount for the Daily Brief. The module loads through the lazy door and
   * the loader is the first frame, so the click never paints a blank pane.
   * The page reads brief runs; `creator` lets it start one on the main local
   * bot, and the brief's actions hand prompts to a session via `onlaunch`.
   */
  import { onMount } from "svelte";
  import ReadLoader from "../common/ReadLoader.svelte";
  import { loadBrief } from "./brief-lazy.js";
  import type { BriefAdapter } from "../brief/brief-data.js";
  import type { BriefLaunch } from "../brief/brief-context.svelte.js";
  import type { BriefCreateRun, BriefCreator } from "../brief/brief-create.svelte.js";
  import type { BriefActions } from "../brief/brief-action-cards.js";

  type BriefModule = Awaited<ReturnType<typeof loadBrief>>;

  interface Props {
    adapter: BriefAdapter;
    /** Companies the brief may detail, with logos. */
    companies: { uid: string; slug?: string | null; label: string; iconUrl?: string | null }[];
    onlaunch?: BriefLaunch;
    creator?: BriefCreator | null;
    /** The shell's run service, so a run outlives this page. */
    run?: BriefCreateRun | null;
    /** Opens the DM with this uid in Messages. */
    onopenthread?: (uid: string) => void;
    onopenmeetings?: () => void;
    /** Report action cards on the brief page. */
    actions?: BriefActions | null;
    /** Told which run the brief page has on screen. */
    onshown?: (runId: string | null) => void;
  }
  let { adapter, companies, onlaunch, creator = null, run = null, onopenthread, onopenmeetings, actions = null, onshown }: Props = $props();

  let mod = $state<BriefModule | null>(null);
  let failed = $state(false);

  onMount(() => {
    let alive = true;
    void loadBrief()
      .then((loaded) => {
        if (alive) mod = loaded;
      })
      .catch((err) => {
        console.error("[daily-brief] could not load", err);
        if (alive) failed = true;
      });
    return () => {
      alive = false;
    };
  });
</script>

<div class="host" data-testid="brief-host">
  {#if mod}
    <mod.BriefRunsPage {adapter} {companies} {onlaunch} {creator} {run} {onopenthread} {onopenmeetings} {actions} {onshown} />
  {:else if failed}
    <p class="failed" data-testid="brief-failed">The Daily Brief could not load. Try again in a moment.</p>
  {:else}
    <div class="loading" aria-busy="true">
      <ReadLoader testid="brief-loading" />
    </div>
  {/if}
</div>

<style>
  .host { height: 100%; min-height: 0; }
  .loading { padding: 8px; }
  .failed { padding: 20px; }
</style>
