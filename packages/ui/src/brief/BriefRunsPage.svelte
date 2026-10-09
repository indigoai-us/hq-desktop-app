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
  import BriefDawn from "./BriefDawn.svelte";
  import { briefDemoFromUrl } from "./brief-demo.js";
  import type { DawnPhase } from "./brief-dawn.js";
  import { BriefCreateRun, type BriefCreator } from "./brief-create.svelte.js";
  import { adapterSweepSource, gatherBriefInput, readRunHousekeeping, type BriefAdapter, type BriefSweepSource } from "./brief-data.js";
  import type { BriefHousekeeping } from "./brief-run-files.js";
  import { BRIEF_FIX_LABEL, BRIEF_INDEX_PATH, latestReadyRun, parseBriefIndex, runIdTime, type BriefIndexEntry } from "./brief-runs.js";
  import type { BriefLaunch } from "./brief-context.svelte.js";
  import type { BriefInput } from "./brief-types.js";

  interface Props {
    adapter: BriefAdapter;
    companies: { uid: string; slug?: string | null; label: string; iconUrl?: string | null }[];
    onlaunch?: BriefLaunch;
    /** Starts runs on the main local bot. Absent on hosts without local bots. */
    creator?: BriefCreator | null;
    /**
     * The shell's run service. It outlives this page, so a run keeps going
     * (and keeps polling) while the person is elsewhere. Without one the page
     * makes its own from `creator`.
     */
    run?: BriefCreateRun | null;
    /** Opens the DM with this uid in Messages. */
    onopenthread?: (uid: string) => void;
    /** Test seam; defaults to the adapter's HQ file read. */
    source?: BriefSweepSource | null;
  }
  let { adapter, companies, onlaunch, creator = null, run: sharedRun = null, onopenthread, source: sourceProp }: Props = $props();

  const LAST_KEY = "hq.brief.lastOpenedAt";
  // Fixed for the page's life; the host remounts the page for a new adapter.
  const demo = typeof location === "undefined" ? null : briefDemoFromUrl(location.search);
  // svelte-ignore state_referenced_locally
  const source = demo ? demo.source : sourceProp === undefined ? adapterSweepSource(adapter.files) : sourceProp;

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
  const hostCreator = demo ? demo.creator : creator;
  // svelte-ignore state_referenced_locally
  const ownsRun = demo != null || !sharedRun;
  // svelte-ignore state_referenced_locally
  const run: BriefCreateRun | null = !ownsRun
    ? sharedRun
    : hostCreator
      ? new BriefCreateRun({ creator: hostCreator, read: async (path) => (source ? source.readHqFile(path) : null) })
      : null;
  // Ready: show the new brief. Failed: show whatever the run did write.
  const unsubscribe = run?.subscribe(async (phase) => {
    entries = await loadIndex();
    if (alive && phase.runId) await show(phase.runId);
  });

  /**
   * Set when the ready bloom has played, so the sunrise gives way to the
   * brief. A run that finished while the page was closed does not replay it.
   */
  let bloomDone = $state(run?.phase.kind === "ready");
  const cp = $derived(run?.phase ?? { kind: "idle" as const });
  /** Where the sun was when a run failed, so it stalls there. */
  let lastProgress = 0;
  $effect.pre(() => {
    if (cp.kind === "running") lastProgress = cp.progress;
    else if (cp.kind === "waiting" || cp.kind === "dispatching") lastProgress = 0;
  });
  const dawn = $derived.by((): { phase: DawnPhase; progress: number; step: string } | null => {
    if (demo?.frozen != null) {
      return demo.frozen === "fail"
        ? { phase: "failed", progress: 0.45, step: "The sweep could not reach GitHub. Sign in with gh auth login, then try again." }
        : { phase: "running", progress: demo.frozen, step: demo.frozen >= 1 ? "Writing your brief" : demo.frozen > 0 ? "Sweeping your day" : "Checking your setup" };
    }
    switch (cp.kind) {
      case "dispatching":
        return { phase: "running", progress: 0, step: "Waking your bot…" };
      case "waiting":
        return { phase: "running", progress: 0, step: "Waiting for your bot to start" };
      case "running":
        return { phase: "running", progress: cp.progress, step: cp.step };
      case "ready":
        return bloomDone ? null : { phase: "ready", progress: 1, step: "Your brief is ready" };
      case "failed":
        return { phase: "failed", progress: lastProgress, step: cp.message };
      default:
        return null;
    }
  });
  /** No runs yet and a way to make one: the pre-dawn empty state. */
  const empty = $derived(!!run && entries.length === 0 && (cp.kind === "idle" || cp.kind === "blocked"));

  function createBrief(): void {
    bloomDone = false;
    void run?.start();
  }

  onMount(() => {
    void (async () => {
      entries = await loadIndex();
      if (!alive) return;
      // Resume a run already in flight (a reload, or one started elsewhere).
      if (run && !run.busy) void run.rehydrate(entries.filter((e) => e.state === "running").map((e) => e.runId));
      await show(latestReadyRun(entries)?.runId ?? null);
    })();
  });
  onDestroy(() => {
    alive = false;
    unsubscribe?.();
    // A shared run keeps polling in the background; only a page-owned one stops.
    if (ownsRun) run?.stop();
  });
</script>

{#snippet runBar()}
  <BriefRunBar {entries} {selectedRunId} {latestRunId} {now} {missing} create={run} oncreate={createBrief} onselect={(id) => void show(id)} />
{/snippet}

{#snippet dawnScene(size: "page" | "masthead")}
  {#if dawn}
    <BriefDawn
      {size}
      phase={dawn.phase}
      progress={dawn.progress}
      step={dawn.step}
      headline={entries.length === 0 && dawn.phase !== "failed" ? "Your first brief is on its way" : ""}
      onbloomdone={() => (bloomDone = true)}
    >
      {#if dawn.phase === "failed"}
        <button type="button" class="cta" onclick={createBrief} data-testid="brief-retry">Try again</button>
        <button type="button" class="ghost" onclick={() => run?.dismiss()}>Dismiss</button>
      {/if}
    </BriefDawn>
  {:else}
    <BriefDawn {size} phase="idle" progress={0} headline="Your first brief is waiting">
      {#if cp.kind === "blocked"}
        <p class="blocked" data-testid="brief-blocked">{cp.message}</p>
        <button type="button" class="cta" onclick={() => void run?.fix()} data-testid="brief-fix">{BRIEF_FIX_LABEL[cp.fix]}</button>
      {:else}
        <button type="button" class="cta" onclick={createBrief} data-testid="brief-create">Create brief</button>
      {/if}
    </BriefDawn>
  {/if}
{/snippet}

{#if (empty || (dawn && !input) || (dawn && entries.length === 0)) && (input || run)}
  <div class="daily-brief-dawn-page">{@render dawnScene("page")}</div>
{:else if input}
  {#if dawn}<div class="masthead-wrap">{@render dawnScene("masthead")}</div>{/if}
  <DailyBrief dmApi={adapter.messaging ?? null} {onopenthread} {input} {companies} {onlaunch} {housekeeping} header={entries.length || run ? runBar : undefined} />
{:else if failed}
  <p class="failed" data-testid="brief-failed">The Daily Brief could not load. Try again in a moment.</p>
{:else}
  <div class="loading" aria-busy="true">
    <ReadLoader testid="brief-loading" />
  </div>
{/if}

<style>
  .daily-brief-dawn-page,
  .masthead-wrap {
    padding: 22px 26px 0;
    background: #1b1b1e;
    font-family: var(--font-ui, "Geist", -apple-system, system-ui, sans-serif);
  }
  .daily-brief-dawn-page {
    min-height: 100%;
    padding-bottom: 22px;
  }
  .masthead-wrap {
    padding-bottom: 0;
  }
  .cta,
  .ghost {
    font: inherit;
    font-size: 13px;
    border: 0;
    border-radius: 999px;
    padding: 8px 18px;
    cursor: pointer;
  }
  .cta {
    color: #1b1b1e;
    background: #ffb580;
    font-weight: 500;
  }
  .ghost {
    color: rgba(255, 255, 255, 0.7);
    background: transparent;
  }
  .blocked {
    margin: 0;
    font-size: 13px;
    color: rgba(255, 255, 255, 0.75);
  }
  .loading {
    padding: 8px;
  }
  .failed {
    padding: 20px;
  }
</style>
