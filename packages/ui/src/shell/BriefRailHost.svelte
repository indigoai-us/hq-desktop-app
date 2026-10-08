<script lang="ts">
  /**
   * Rail mount for the Daily Brief. The module loads through the lazy door and
   * the loader is the first frame, so the click never paints a blank pane.
   * Reads only; the brief's actions hand prompts to a session via `onlaunch`.
   */
  import { onMount } from "svelte";
  import ReadLoader from "../common/ReadLoader.svelte";
  import { loadBrief } from "./brief-lazy.js";
  import type { BriefAdapter } from "../brief/brief-data.js";
  import type { BriefInput } from "../brief/brief-types.js";
  import type { BriefLaunch } from "../brief/brief-context.svelte.js";

  type BriefModule = Awaited<ReturnType<typeof loadBrief>>;

  interface Props {
    adapter: BriefAdapter;
    /** Companies the brief may detail, with logos. */
    companies: { uid: string; slug?: string | null; label: string; iconUrl?: string | null }[];
    onlaunch?: BriefLaunch;
  }
  let { adapter, companies, onlaunch }: Props = $props();

  const LAST_KEY = "hq.brief.lastOpenedAt";
  let mod = $state<BriefModule | null>(null);
  let input = $state<BriefInput | null>(null);
  let failed = $state(false);

  function storage(): Storage | null {
    try {
      return typeof localStorage === "undefined" ? null : localStorage;
    } catch {
      return null;
    }
  }

  onMount(() => {
    let alive = true;
    const store = storage();
    const lastBriefAt = store?.getItem(LAST_KEY) ?? null;
    void loadBrief()
      .then(async (loaded) => {
        const { input: day, failures } = await loaded.gatherBriefInput(adapter, { companies, lastBriefAt });
        if (failures.length) console.warn("[daily-brief] rendered without", failures.join(", "));
        if (!alive) return;
        mod = loaded;
        input = day;
        store?.setItem(LAST_KEY, day.now);
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
  {#if mod && input}
    <mod.DailyBrief {input} {companies} {onlaunch} />
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
