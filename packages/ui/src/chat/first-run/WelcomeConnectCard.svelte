<script lang="ts">
  /**
   * The welcome report's first card (US-009): the apps the launch scan found
   * on this computer, each one connected inline, one browser sign-in at a
   * time. Detection, the catalog lookup and every connect go through the
   * shared `YourAppsHost`; the tiles are `FirstRunYourAppsStep`'s and the
   * grouping, auto-connect plan and sign-in rule are your-apps.ts's, the same
   * ones the takeover's "Your apps" step used.
   *
   * Only what the scan found is offered: with nothing found (or a scan that
   * could not run) the card is not shown.
   */
  import { onDestroy, onMount, untrack } from "svelte";
  import { hostComputerNoun, subscribeHostComputerNoun } from "@hq/platform";
  import FirstRunYourAppsStep from "./FirstRunYourAppsStep.svelte";
  import { evidenceLine, matchFoundApps, type FoundAppsResult } from "./found-apps.js";
  import {
    autoConnectPlan,
    opensSignIn,
    signInRunning,
    yourAppsLead,
    yourAppsView,
    type AppRun,
    type AppTile,
    type ConnectedChip,
  } from "./your-apps.js";
  import type { YourAppsHost, YourAppsLoad } from "./your-apps-host.js";

  interface Props {
    host: YourAppsHost;
    /** The company the apps connect to. */
    company: { uid: string; name: string };
    /** The assistant's name, for the lead line. */
    assistantName: string;
    /** "Connect from Integrations" tiles open the company's Integrations page. */
    onopenintegrations?: (companyUid: string) => void;
  }
  let { host, company, assistantName, onopenintegrations }: Props = $props();

  let hostNoun = $state(hostComputerNoun());
  onMount(() => subscribeHostComputerNoun((next) => (hostNoun = next)));

  /** What the names-only scan found, matched to known apps; null until it answers. */
  let workScan = $state.raw<FoundAppsResult | null>(null);
  let load = $state.raw<YourAppsLoad | null>(null);
  let loading = false;
  let appRuns = $state<Record<string, AppRun>>({});
  /** Domains the person undid here: never auto-connected again. */
  const undone = new Set<string>();
  let autoRan = false;
  let undoProblem = $state<string | null>(null);
  /** Bumped by Retry: an older answer is dropped. */
  let gen = 0;
  let alive = true;
  const abort = new AbortController();
  onDestroy(() => {
    alive = false;
    abort.abort();
  });

  // The card is mounted for one company; a different one remounts it.
  // svelte-ignore state_referenced_locally
  const companyUid = company.uid;

  onMount(() => {
    void host.detect().then(
      (found) => {
        if (alive) workScan = matchFoundApps(found);
      },
      () => {
        if (alive) workScan = matchFoundApps(null);
      },
    );
    loadApps();
  });

  function loadApps(): void {
    if (loading) return;
    loading = true;
    const mine = ++gen;
    void host.load(companyUid).then(
      (next) => {
        loading = false;
        if (alive && mine === gen) load = next;
      },
      (err: unknown) => {
        loading = false;
        console.warn("[hq-desktop] welcome report apps load threw:", err);
        if (alive && mine === gen) {
          load = { catalog: null, connections: [], installations: {}, canManage: false, problem: { reason: "Couldn't load your apps. Try again.", retry: true } };
        }
      },
    );
  }

  const found = $derived(workScan?.apps ?? []);
  const view = $derived(
    load && found.length
      ? yourAppsView({
          found,
          unmatched: workScan?.unmatched ?? 0,
          catalog: load.catalog,
          connections: load.connections,
          installations: load.installations,
          canManage: load.canManage,
          runs: appRuns,
          evidence: (app) => evidenceLine(app.evidence, hostNoun),
        })
      : null,
  );

  function setRun(domain: string, run: AppRun): void {
    appRuns = { ...appRuns, [domain]: run };
  }

  /** Connect the found no-sign-in catalog apps once (owner or admin only). */
  function runAutoConnect(): void {
    const current = load;
    if (autoRan || !current || !found.length) return;
    autoRan = true;
    const plan = autoConnectPlan(
      { found, catalog: current.catalog, connections: current.connections, canManage: current.canManage, runs: appRuns },
      undone,
    );
    for (const item of plan) {
      const name = found.find((a) => a.domain === item.domain)?.name ?? item.domain;
      setRun(item.domain, { state: "connecting", via: "install" });
      void host.autoConnect(companyUid, item.entryId, name).then((res) => {
        if (!alive) return;
        if (res.ok) setRun(item.domain, { state: "connected", how: "auto", connectionId: res.connectionId, installationId: res.installationId });
        else setRun(item.domain, res.reason ? { state: "failed", reason: res.reason, retry: res.retry } : { state: "idle" });
      });
    }
  }
  $effect(() => {
    if (!load || !found.length) return;
    untrack(() => runAutoConnect());
  });

  function connectTile(tile: AppTile): void {
    if (tile.action === "integrations") {
      onopenintegrations?.(companyUid);
      return;
    }
    // One browser sign-in at a time.
    if (opensSignIn(tile) && view && signInRunning(view)) return;
    setRun(tile.domain, { state: "connecting", via: tile.action === "install" ? "install" : "browser" });
    void host.connect(companyUid, tile, abort.signal).then((res) => {
      if (!alive) return;
      if (res.ok) setRun(tile.domain, { state: "connected", how: "person", connectionId: res.connectionId });
      else setRun(tile.domain, res.reason ? { state: "failed", reason: res.reason, retry: res.retry } : { state: "idle" });
    });
  }

  function setupTile(tile: AppTile): void {
    if (view && signInRunning(view)) return;
    setRun(tile.domain, { state: "checking-docs" });
    void host.setup(companyUid, tile, abort.signal).then((res) => {
      if (!alive) return;
      if (res.ok) setRun(tile.domain, { state: "connected", how: "person", connectionId: res.connectionId });
      else if (res.unsupported) setRun(tile.domain, { state: "unsupported" });
      else setRun(tile.domain, res.reason ? { state: "failed", reason: res.reason, retry: res.retry } : { state: "idle" });
    });
  }

  function undoChip(chip: ConnectedChip): void {
    const installationId = chip.installationId;
    if (!installationId) return;
    const before = appRuns[chip.domain] ?? { state: "idle" };
    undoProblem = null;
    setRun(chip.domain, { state: "undoing", connectionId: chip.connectionId, installationId });
    void host.undo(companyUid, installationId).then((res) => {
      if (!alive) return;
      if (res.ok) {
        undone.add(chip.domain);
        if (load && chip.connectionId) load = { ...load, connections: load.connections.filter((c) => c.id !== chip.connectionId) };
        setRun(chip.domain, { state: "idle" });
      } else {
        setRun(chip.domain, before.state === "idle" ? { state: "connected", how: "auto", connectionId: chip.connectionId, installationId } : before);
        undoProblem = res.reason;
      }
    });
  }
</script>

{#if view}
  <section class="card" data-testid="welcome-connect-card" aria-label="Connect your apps">
    <FirstRunYourAppsStep
      lead={yourAppsLead(view.foundCount, assistantName, hostNoun)}
      {view}
      problem={undoProblem ? { reason: undoProblem, retry: false } : (load?.problem ?? null)}
      onconnect={connectTile}
      onsetup={setupTile}
      onundo={undoChip}
      onreload={() => {
        undoProblem = null;
        load = null;
        autoRan = false;
        loadApps();
      }}
    />
  </section>
{/if}

<style>
  .card {
    border-radius: 22px;
    background: #121216;
    padding: 22px 24px;
    color: rgba(255, 255, 255, 0.92);
  }
</style>
