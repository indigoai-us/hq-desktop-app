<script lang="ts">
  /**
   * The Daily Brief page over brief runs. Reads workspace/brief/index.jsonl,
   * shows the newest ready run (or, with no runs yet, the per-day sweep and
   * live adapter data as before), lets the person step through older runs,
   * and starts new ones through the host's `creator`.
   */
  import { onDestroy, onMount } from "svelte";
  import ReadLoader from "../common/ReadLoader.svelte";
  import DailyBrief from "./DailyBrief.svelte";
  import BriefRunBar from "./BriefRunBar.svelte";
  import { BriefCreateRun, type BriefCreator } from "./brief-create.svelte.js";
  import { adapterSweepSource, gatherBriefInput, readRunHousekeeping, type BriefAdapter, type BriefSweepSource } from "./brief-data.js";
  import type { BriefHousekeeping } from "./brief-run-files.js";
  import { BRIEF_INDEX_PATH, latestReadyRun, parseBriefIndex, runIdTime, type BriefIndexEntry } from "./brief-runs.js";
  import type { BriefLaunch } from "./brief-context.svelte.js";
  import type { BriefInput } from "./brief-types.js";

  interface Props {
    adapter: BriefAdapter;
    companies: { uid: string; slug?: string | null; label: string; iconUrl?: string | null }[];
    onlaunch?: BriefLaunch;
    /** Starts runs on the main local bot. Absent on hosts without local bots. */
    creator?: BriefCreator | null;
    /** Test seam; defaults to the adapter's HQ file read. */
    source?: BriefSweepSource | null;
  }
  let { adapter, companies, onlaunch, creator = null, source: sourceProp }: Props = $props();

  const LAST_KEY = "hq.brief.lastOpenedAt";
  // Fixed for the page's life; the host remounts the page for a new adapter.
  // svelte-ignore state_referenced_locally
  const source = sourceProp === undefined ? adapterSweepSource(adapter.files) : sourceProp;

  let entries = $state<BriefIndexEntry[]>([]);
  let selectedRunId = $state<string | null>(null);
  let input = $state<BriefInput | null>(null);
  let housekeeping = $state<BriefHousekeeping | null>(null);
  let missing = $state<string[]>([]);
  let failed = $state(false);
  let now = $state(new Date());
  let alive = true;
  let seq = 0;
  const latestRunId = $derived(latestReadyRun(entries)?.runId ?? null);

  function storage(): Storage | null {
    try {
      return typeof localStorage === "undefined" ? null : localStorage;
    } catch {
      return null;
    }
  }
  const store = storage();
  const openedBefore = store?.getItem(LAST_KEY) ?? null;

  async function loadIndex(): Promise<BriefIndexEntry[]> {
    if (!source) return [];
    try {
      const text = await source.readHqFile(BRIEF_INDEX_PATH);
      if (text == null) return [];
      const { entries: parsed, skipped } = parseBriefIndex(text);
      if (skipped) console.warn(`[daily-brief] index.jsonl: skipped ${skipped} unreadable line(s)`);
      return parsed;
    } catch (err) {
      console.warn("[daily-brief] could not read index.jsonl", err);
      return [];
    }
  }

  /** Render one run, or the no-run brief when `runId` is null. */
  async function show(runId: string | null): Promise<void> {
    const mine = ++seq;
    selectedRunId = runId;
    const at = entries.findIndex((e) => e.runId === runId);
    const entry = at >= 0 ? entries[at]! : null;
    const created = entry ? new Date(entry.createdAt) : runId ? runIdTime(runId) : null;
    // The brief before this one sets "days away", so a run renders as it did when made.
    const previous = at >= 0 ? (entries.slice(at + 1).find((e) => e.state === "ready") ?? null) : null;
    try {
      const { input: day, failures } = await gatherBriefInput(adapter, {
        companies,
        now: created ?? new Date(),
        lastBriefAt: runId ? (previous?.createdAt ?? null) : openedBefore,
        runId,
        sweep: source,
      });
      if (failures.length) console.warn("[daily-brief] rendered without", failures.join(", "));
      const hk = runId && source ? await readRunHousekeeping(source, runId) : null;
      if (!alive || mine !== seq) return;
      input = day;
      housekeeping = hk;
      missing = runId ? failures.filter((f) => f.endsWith(".json")) : [];
      now = new Date();
      if (!runId || runId === latestRunId) store?.setItem(LAST_KEY, day.now);
    } catch (err) {
      console.error("[daily-brief] could not load", err);
      if (alive && mine === seq) failed = true;
    }
  }

  // The host passes one creator for the page's life.
  // svelte-ignore state_referenced_locally
  const hostCreator = creator;
  const run = hostCreator
    ? new BriefCreateRun({
        creator: hostCreator,
        read: async (path) => (source ? source.readHqFile(path) : null),
        onfinish: async (phase) => {
          entries = await loadIndex();
          if (!alive) return;
          // Ready: show the new brief. Failed: show whatever the run did write.
          if (phase.runId) await show(phase.runId);
        },
      })
    : null;

  onMount(() => {
    void (async () => {
      entries = await loadIndex();
      if (!alive) return;
      await show(latestReadyRun(entries)?.runId ?? null);
    })();
  });
  onDestroy(() => {
    alive = false;
    run?.stop();
  });
</script>

{#snippet runBar()}
  <BriefRunBar {entries} {selectedRunId} {latestRunId} {now} {missing} create={run} onselect={(id) => void show(id)} />
{/snippet}

{#if input}
  <DailyBrief {input} {companies} {onlaunch} {housekeeping} header={entries.length || run ? runBar : undefined} />
{:else if failed}
  <p class="failed" data-testid="brief-failed">The Daily Brief could not load. Try again in a moment.</p>
{:else}
  <div class="loading" aria-busy="true">
    <ReadLoader testid="brief-loading" />
  </div>
{/if}

<style>
  .loading {
    padding: 8px;
  }
  .failed {
    padding: 20px;
  }
</style>
