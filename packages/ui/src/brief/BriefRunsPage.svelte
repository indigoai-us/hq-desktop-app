<script lang="ts">
  import RailButton from "../common/button/RailButton.svelte";
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
  import BriefCreateButton from "./BriefCreateButton.svelte";
  import BriefDawn from "./BriefDawn.svelte";
  import BriefActivity from "./BriefActivity.svelte";
  import BriefFindings from "./BriefFindings.svelte";
  import { parseFindings, parseSamples } from "./brief-findings.js";
  import { parseActivity } from "./brief-runs.js";
  import { BRIEF_IDLE_MS, elapsedLabel, estimateLabel, stillWorkingLine, waitingStep } from "./brief-runs.js";
  import { briefDemoFromUrl } from "./brief-demo.js";
  import { createBriefLogger } from "./brief-log.js";
  import type { BriefItemEvent } from "./brief-context.svelte.js";
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
    /** Opens the Meetings page. */
    onopenmeetings?: () => void;
    /** Test seam; defaults to the adapter's HQ file read. */
    source?: BriefSweepSource | null;
    /** Open this run first instead of the latest ready one (the design harness's ?briefRun). */
    initialRunId?: string | null;
  }
  let { adapter, companies, onlaunch, creator = null, run: sharedRun = null, onopenthread, onopenmeetings, source: sourceProp, initialRunId = null }: Props = $props();

  const LAST_KEY = "hq.brief.lastOpenedAt";
  // Fixed for the page's life; the host remounts the page for a new adapter.
  const demo = typeof location === "undefined" ? null : briefDemoFromUrl(location.search);
  // svelte-ignore state_referenced_locally
  const source = demo ? demo.source : sourceProp === undefined ? adapterSweepSource(adapter.files) : sourceProp;

  let entries = $state<BriefIndexEntry[]>([]);
  let selectedRunId = $state<string | null>(null);
  /** The run whose brief.json is parsed and on screen; null for the no-run brief. */
  let shownRunId = $state<string | null>(null);
  let input = $state<BriefInput | null>(null);
  let housekeeping = $state<BriefHousekeeping | null>(null);
  let missing = $state<string[]>([]);
  // The run Create brief is writing right now, if any.
  const inFlightRunId = $derived.by(() => {
    const p = run?.phase;
    return p && (p.kind === "dispatching" || p.kind === "waiting" || p.kind === "running") ? p.runId : null;
  });
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
  // The brief log: what was shown and what the person did with it. Hosts
  // without the append (web, harness, demo) log nothing.
  // svelte-ignore state_referenced_locally
  const appendLog = demo ? null : adapter.files?.appendBriefLog?.bind(adapter.files);
  const logBrief = createBriefLogger(appendLog);
  function logItem(event: BriefItemEvent): void {
    if (shownRunId) logBrief({ ...event, runId: shownRunId });
  }

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
      shownRunId = runId;
      if (runId) logBrief({ event: "shown", runId });
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
  /**
   * The run is playing on the full-page scene and that scene can draw: at
   * ready it stays up until its ripple ends and then gives way to the brief
   * in one swap, rather than handing a replayed bloom to the band over the brief.
   */
  let pageLive = $state(false);
  const cp = $derived(run?.phase ?? { kind: "idle" as const });
  /** The ready run the page has already handed off to. */
  let handedOff = $state<string | null>(null);
  $effect.pre(() => {
    if (cp.kind === "ready" && (bloomDone || !pageLive) && shownRunId === cp.runId) handedOff = cp.runId;
  });
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
        return { phase: "running", progress: 0, step: waitingStep(cp.bot) };
      case "running":
        return { phase: "running", progress: cp.progress, step: cp.step };
      case "ready":
        // Hold "Your brief is ready" until the new run's brief is loaded, so
        // the page swaps once and never flashes a placeholder brief.
        // A scene that cannot draw has no bloom to wait for. Once handed off,
        // stepping to another brief never brings the scene back.
        return handedOff === cp.runId || ((bloomDone || !pageLive) && shownRunId === cp.runId) ? null : { phase: "ready", progress: 1, step: "Your brief is ready" };
      case "failed":
        return { phase: "failed", progress: lastProgress, step: cp.message };
      default:
        return null;
    }
  });
  // A run's scene ended: the next one decides afresh where it plays.
  let hadDawn = false;
  $effect.pre(() => {
    if (dawn) hadDawn = true;
    else if (hadDawn) {
      hadDawn = false;
      pageLive = false;
    }
  });
  // A one-second clock while a run is in flight, for the elapsed time and
  // the "still working" line.
  let tickNow = $state(Date.now());
  $effect(() => {
    if (!run?.busy) return;
    const t = setInterval(() => (tickNow = Date.now()), 1000);
    return () => clearInterval(t);
  });
  /** When the activity list last changed, for the idle line. */
  let activityKey = "";
  let activityChangedAt = $state(Date.now());
  $effect.pre(() => {
    const list = cp.kind === "running" ? (cp.activity ?? []) : [];
    const key = list.map((a) => `${a.at}|${a.label}|${a.state}|${a.detail ?? ""}`).join("\n");
    if (key !== activityKey) {
      activityKey = key;
      activityChangedAt = Date.now();
    }
  });
  const liveRunInfo = $derived.by(() => {
    if (demo?.frozen != null && demo.frozen !== "fail") {
      const s = demo.statusAt(demo.frozen);
      return {
        activity: parseActivity(s.activity),
        findings: demo.frozen > 0.1 ? parseFindings(s.findings) : null,
        samples: parseSamples(s.samples, "indigo"),
        elapsed: elapsedLabel(demo.frozen * 18_000 + 1500),
        estimate: "usually ~12 min",
        still: null,
        idle: null,
      };
    }
    if (cp.kind !== "waiting" && cp.kind !== "running") return null;
    return {
      activity: cp.kind === "running" ? (cp.activity ?? []) : [],
      findings: cp.kind === "running" ? (cp.findings ?? null) : null,
      samples: cp.kind === "running" ? parseSamples(cp.samples, run?.company ?? null) : [],
      elapsed: elapsedLabel(tickNow - cp.sentAt),
      estimate: estimateLabel(entries),
      still: stillWorkingLine(cp, tickNow, run?.files ?? null),
      idle:
        cp.kind === "running" && cp.activity?.length && tickNow - activityChangedAt >= BRIEF_IDLE_MS
          ? elapsedLabel(tickNow - activityChangedAt)
          : null,
    };
  });
  // The loader's last frame stays up through "Your brief is ready".
  let heldRunInfo: NonNullable<typeof liveRunInfo> | null = null;
  const runInfo = $derived.by(() => {
    if (liveRunInfo) return (heldRunInfo = liveRunInfo);
    return dawn?.phase === "ready" && heldRunInfo ? { ...heldRunInfo, idle: null, still: null } : null;
  });

  /** No brief before this run: the scene keeps its first-brief headline through ready. */
  const firstRun = $derived(entries.every((e) => cp.kind !== "idle" && "runId" in cp && e.runId === cp.runId));

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
      const wanted = initialRunId && entries.some((e) => e.runId === initialRunId) ? initialRunId : null;
      await show(wanted ?? latestReadyRun(entries)?.runId ?? null);
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
  <!-- A run still being written is not missing anything yet. -->
  <BriefRunBar {entries} {selectedRunId} {latestRunId} {now} missing={inFlightRunId && inFlightRunId === selectedRunId ? [] : missing} onselect={(id) => void show(id)} />
{/snippet}

{#snippet createTool()}
  {#if run}<BriefCreateButton {entries} {now} create={run} oncreate={createBrief} />{/if}
{/snippet}

{#snippet dawnScene(size: "page" | "masthead")}
  {#snippet runStatus()}
    {#if runInfo}
      <BriefActivity
        activity={runInfo.activity}
        visible={runInfo.findings ? 1 : size === "page" ? 5 : 2}
        elapsed={runInfo.elapsed}
        estimate={runInfo.estimate}
        stillWorking={runInfo.still}
        idle={runInfo.idle}
      />
    {/if}
  {/snippet}
  {#snippet loaderBody()}
    {#if runInfo}
      <!-- The bento beside the sun: counter tiles from the first frame, then the sample chips. -->
      <div class="loader" data-testid="brief-loader">
        <BriefFindings findings={runInfo.findings} samples={runInfo.samples} cards={size === "page" ? 3 : 1} {size} {companies} />
      </div>
    {/if}
  {/snippet}
  <!-- One scene from waiting to ready, so Create brief reshapes the same card instead of swapping it. -->
  <BriefDawn
    {size}
    phase={dawn?.phase ?? "idle"}
    progress={dawn?.progress ?? 0}
    step={dawn?.step ?? ""}
    headline={!dawn ? "Your first brief is waiting" : dawn.phase === "failed" ? "" : firstRun ? "Your first brief is on its way" : "Your new brief is on its way"}
    onbloomdone={() => (bloomDone = true)}
    onlive={() => (pageLive = size === "page")}
    actions={!dawn ? idleActions : dawn.phase === "failed" ? failedActions : undefined}
    status={dawn && dawn.phase !== "failed" && runInfo ? runStatus : undefined}
    children={dawn && dawn.phase !== "failed" && runInfo ? loaderBody : undefined}
  />
{/snippet}



{#snippet failedActions()}
  {#if run?.duplicatePrompt}
    <p class="blocked" data-testid="brief-duplicate-prompt">Your last brief is still being written. Wait for it?</p>
    <!-- The app's standard buttons: the way forward primary, the other a quiet ghost. -->
    <!-- svelte-ignore a11y_autofocus -->
    <RailButton icon="check" variant="primary" autofocus onclick={() => run?.waitForLast()} data-testid="brief-wait">Wait for it</RailButton>
    <RailButton icon="play" variant="ghost" onclick={() => { bloomDone = false; void run?.start({ force: true }); }} data-testid="brief-start-new">Start a new one</RailButton>
  {:else}
    <RailButton icon="refresh" variant="primary" onclick={createBrief} data-testid="brief-retry">Try again</RailButton>
    <RailButton icon="x" variant="ghost" onclick={() => run?.dismiss()} data-testid="brief-dismiss">Dismiss</RailButton>
  {/if}
{/snippet}

{#snippet idleActions()}
  {#if cp.kind === "blocked"}
    <p class="blocked" data-testid="brief-blocked">{cp.message}</p>
    <button type="button" class="cta big" onclick={() => void run?.fix()} data-testid="brief-fix">{BRIEF_FIX_LABEL[cp.fix]}<svg viewBox="0 0 256 256" aria-hidden="true"><path d="M221.66,133.66l-72,72a8,8,0,0,1-11.32-11.32L196.69,136H40a8,8,0,0,1,0-16H196.69L138.34,61.66a8,8,0,0,1,11.32-11.32l72,72A8,8,0,0,1,221.66,133.66Z" /></svg></button>
  {:else}
    <button type="button" class="cta big" onclick={createBrief} data-testid="brief-create">Create brief<svg viewBox="0 0 256 256" aria-hidden="true"><path d="M221.66,133.66l-72,72a8,8,0,0,1-11.32-11.32L196.69,136H40a8,8,0,0,1,0-16H196.69L138.34,61.66a8,8,0,0,1,11.32-11.32l72,72A8,8,0,0,1,221.66,133.66Z" /></svg></button>
  {/if}
{/snippet}

{#snippet briefHeader()}
  {#if entries.length || run}{@render runBar()}{/if}
{/snippet}

<!-- Any run in flight, first brief or a refresh, plays on the full-page scene in place of the brief, then hands off to it. -->
{#if (empty || dawn) && (input || run)}
  <!-- The brief's own stage (.daily-brief: tokens, light and dark), so the scene and the brief it becomes match. -->
  <div class="daily-brief daily-brief-dawn-page">{@render dawnScene("page")}</div>
{:else if input}
  <DailyBrief dmApi={adapter.messaging ?? null} {onopenthread} {onopenmeetings} {input} {companies} {onlaunch} {housekeeping} onlog={logItem} header={entries.length || run || dawn ? briefHeader : undefined} tools={run ? createTool : undefined} />
{:else if failed}
  <p class="failed" data-testid="brief-failed">The Daily Brief could not load. Try again in a moment.</p>
{:else}
  <div class="loading" aria-busy="true">
    <ReadLoader testid="brief-loading" />
  </div>
{/if}

<style>
  /* The scene fills the brief view (the stage's own padding around it). */
  .daily-brief-dawn-page {
    display: flex;
    flex-direction: column;
  }
  .loader {
    display: flex;
    width: 100%;
    min-width: 0;
  }
  .cta {
    font: inherit;
    font-size: 13px;
    border: 0;
    border-radius: 8px;
    padding: 8px 18px;
    cursor: pointer;
  }
  .cta {
    color: #1b1b1e;
    background: #ffb580;
    font-weight: 500;
  }
  /* Waiting: the one action, white on the dusk card, in the page's button language: a mono caps
     label and an arrow that nudges forward under the pointer, a faint white ring on hover and focus. */
  .cta.big {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    min-height: 48px;
    padding: 0 22px 0 26px;
    border-radius: 10px;
    font-family: var(--b-code, ui-monospace, monospace);
    font-size: 12px;
    font-weight: 500;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #18181b;
    background: #fff;
    box-shadow: 0 1px 2px rgba(20, 10, 40, 0.12);
    transition:
      background-color 0.15s ease,
      box-shadow 0.15s ease,
      transform 0.1s ease;
  }
  .cta.big :global(svg) {
    width: 14px;
    height: 14px;
    flex: none;
    fill: currentColor;
    transition: transform 0.18s ease;
  }
  .cta.big:hover,
  .cta.big:focus-visible {
    background: rgba(255, 255, 255, 0.92);
    box-shadow:
      0 1px 2px rgba(20, 10, 40, 0.12),
      0 0 0 4px rgba(255, 255, 255, 0.18);
    outline: none;
  }
  .cta.big:hover :global(svg) {
    transform: translateX(3px);
  }
  .cta.big:active {
    transform: translateY(1px);
  }
  @media (prefers-reduced-motion: reduce) {
    .cta.big,
    .cta.big :global(svg) {
      transition: none;
    }
  }
  .blocked {
    margin: 0;
    font-size: 13px;
    color: rgb(var(--b-ink) / 0.75);
  }
  .loading {
    padding: 8px;
  }
  .failed {
    padding: 20px;
  }
</style>
