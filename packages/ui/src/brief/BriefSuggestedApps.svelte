<script lang="ts">
  /**
   * The suggested integrations under "Connect your AI apps": the work apps
   * the launch scan found (matchFoundApps), a glass row each with the app,
   * why it was suggested (the evidence line) and a Connect action.
   *
   * With a company, the rows are your-apps.ts's view and every connect goes
   * through the shared `YourAppsHost` (the takeover's "Your apps" flow): one
   * browser sign-in at a time, the no-sign-in auto-connect once per company,
   * Undo kept in the owner's memory.
   *
   * With no company the rows still show. Integrations always belong to a
   * company (the gateway refuses a connect without a `cmp_` uid), so Connect
   * opens the new-company flow first and runs the connect once that company
   * is the report's company.
   */
  import { onDestroy, onMount, untrack } from "svelte";
  import { hostComputerNoun, subscribeHostComputerNoun } from "@hq/platform";
  import ConnectionCardLogo from "../chat/messaging/ConnectionCardLogo.svelte";
  import { appLogo } from "../chat/messaging/integration-cards-model.js";
  import { evidenceLine, type FoundApp, type FoundAppsResult } from "../chat/first-run/found-apps.js";
  import {
    YOUR_APPS_COPY,
    autoConnectPlan,
    opensSignIn,
    signInRunning,
    yourAppsView,
    type AppRun,
    type AppTile,
    type ConnectedChip,
  } from "../chat/first-run/your-apps.js";
  import type { YourAppsLoad } from "../chat/first-run/your-apps-host.js";
  import type { WelcomeConnectMemory, WelcomeSuggest } from "./welcome-ai-apps.js";

  interface Props {
    /** The shared scan, matched to known apps. */
    scan: FoundAppsResult;
    suggest: WelcomeSuggest;
  }
  let { scan, suggest }: Props = $props();

  /** Rows shown before "Show all". */
  const SHOWN = 6;

  let hostNoun = $state(hostComputerNoun());
  onMount(() => subscribeHostComputerNoun((next) => (hostNoun = next)));

  let load = $state.raw<YourAppsLoad | null>(null);
  let appRuns = $state<Record<string, AppRun>>({});
  let undoProblem = $state<string | null>(null);
  let showAll = $state(false);
  /** The app whose Connect is waiting on a new company, and that company once it exists. */
  let pending = $state<string | null>(null);
  let pendingUid = $state<string | null>(null);
  /** Bumped per load: an answer for an older company or an older Retry is dropped. */
  let gen = 0;
  let loading = false;
  let alive = true;
  let abort = new AbortController();
  onDestroy(() => {
    alive = false;
    abort.abort();
  });

  const companyUid = $derived(suggest.company?.uid ?? null);
  /** Memory per company: the owner's when given, else one kept while mounted. */
  const localMemory = new Map<string, WelcomeConnectMemory>();
  function memoryFor(uid: string): WelcomeConnectMemory {
    if (suggest.memory) return suggest.memory;
    let mem = localMemory.get(uid);
    if (!mem) localMemory.set(uid, (mem = { autoRan: false, undone: new Set<string>() }));
    return mem;
  }

  // A different company starts over: its own catalog, connections and runs.
  $effect(() => {
    const uid = companyUid;
    untrack(() => {
      gen += 1;
      loading = false;
      abort.abort();
      abort = new AbortController();
      load = null;
      appRuns = {};
      undoProblem = null;
      if (uid) loadApps(uid);
    });
  });

  function loadApps(uid: string): void {
    if (loading) return;
    loading = true;
    const mine = ++gen;
    void suggest.host.load(uid).then(
      (next) => {
        if (mine !== gen) return;
        loading = false;
        if (alive) load = next;
      },
      (err: unknown) => {
        if (mine !== gen) return;
        loading = false;
        console.warn("[hq-desktop] welcome report apps load threw:", err);
        if (alive) {
          load = { catalog: null, connections: [], installations: {}, canManage: false, problem: { reason: "Couldn't load your apps. Try again.", retry: true } };
        }
      },
    );
  }

  const found = $derived(scan.apps);
  const byDomain = $derived(new Map(found.map((app) => [app.domain, app])));
  const evidence = (app: FoundApp): string => evidenceLine(app.evidence, hostNoun);

  const view = $derived(
    companyUid && load && found.length
      ? yourAppsView({
          found,
          unmatched: scan.unmatched,
          catalog: load.catalog,
          connections: load.connections,
          installations: load.installations,
          canManage: load.canManage,
          runs: appRuns,
          evidence,
        })
      : null,
  );

  type Row =
    | { kind: "chip"; domain: string; name: string; chip: ConnectedChip }
    | { kind: "tile"; domain: string; name: string; tile: AppTile }
    | { kind: "found"; domain: string; name: string; app: FoundApp };

  /** Connected first, then ready to connect, then the ones HQ sets up from a guide. */
  const rows = $derived.by((): Row[] => {
    if (!companyUid) {
      return found.filter((app) => !app.excluded).map((app) => ({ kind: "found", domain: app.domain, name: app.name, app }));
    }
    if (!view) return [];
    return [
      ...view.connected.map((chip): Row => ({ kind: "chip", domain: chip.domain, name: chip.name, chip })),
      ...[...view.ready, ...view.notInHq].map((tile): Row => ({ kind: "tile", domain: tile.domain, name: tile.name, tile })),
    ];
  });
  const shown = $derived(showAll ? rows : rows.slice(0, SHOWN));
  const browserBusy = $derived(view ? signInRunning(view) : false);

  function setRun(domain: string, run: AppRun): void {
    appRuns = { ...appRuns, [domain]: run };
  }

  /** Connect the found no-sign-in catalog apps once per company (owner or admin only). */
  function runAutoConnect(uid: string): void {
    const current = load;
    const remembered = memoryFor(uid);
    if (remembered.autoRan || !current || !found.length) return;
    remembered.autoRan = true;
    const plan = autoConnectPlan(
      { found, catalog: current.catalog, connections: current.connections, canManage: current.canManage, runs: appRuns },
      remembered.undone,
    );
    const mine = gen;
    for (const item of plan) {
      const name = byDomain.get(item.domain)?.name ?? item.domain;
      setRun(item.domain, { state: "connecting", via: "install" });
      void suggest.host.autoConnect(uid, item.entryId, name).then((res) => {
        if (!alive || mine !== gen) return;
        if (res.ok) setRun(item.domain, { state: "connected", how: "auto", connectionId: res.connectionId, installationId: res.installationId });
        else setRun(item.domain, res.reason ? { state: "failed", reason: res.reason, retry: res.retry } : { state: "idle" });
      });
    }
  }

  // Once the new company's apps load, the Connect that waited for it runs.
  $effect(() => {
    if (!view || !companyUid) return;
    const uid = companyUid;
    untrack(() => {
      if (pending && pendingUid === uid) {
        const domain = pending;
        pending = null;
        pendingUid = null;
        const tile = [...view.ready, ...view.notInHq].find((t) => t.domain === domain);
        if (tile && tile.run.state === "idle" && pressable(tile)) press(tile);
      }
      runAutoConnect(uid);
    });
  });

  function connectTile(tile: AppTile): void {
    const uid = companyUid;
    if (!uid) return;
    if (tile.action === "integrations") {
      suggest.onopenintegrations?.(uid);
      return;
    }
    // One browser sign-in at a time.
    if (opensSignIn(tile) && view && signInRunning(view)) return;
    const mine = gen;
    setRun(tile.domain, { state: "connecting", via: tile.action === "install" ? "install" : "browser" });
    void suggest.host.connect(uid, tile, abort.signal).then((res) => {
      if (!alive || mine !== gen) return;
      if (res.ok) setRun(tile.domain, { state: "connected", how: "person", connectionId: res.connectionId });
      else setRun(tile.domain, res.reason ? { state: "failed", reason: res.reason, retry: res.retry } : { state: "idle" });
    });
  }

  function setupTile(tile: AppTile): void {
    const uid = companyUid;
    if (!uid || (view && signInRunning(view))) return;
    const mine = gen;
    setRun(tile.domain, { state: "checking-docs" });
    void suggest.host.setup(uid, tile, abort.signal).then((res) => {
      if (!alive || mine !== gen) return;
      if (res.ok) setRun(tile.domain, { state: "connected", how: "person", connectionId: res.connectionId });
      else if (res.unsupported) setRun(tile.domain, { state: "unsupported" });
      else setRun(tile.domain, res.reason ? { state: "failed", reason: res.reason, retry: res.retry } : { state: "idle" });
    });
  }

  function undoChip(chip: ConnectedChip): void {
    const uid = companyUid;
    const installationId = chip.installationId;
    if (!uid || !installationId) return;
    const before = appRuns[chip.domain] ?? { state: "idle" };
    const mine = gen;
    undoProblem = null;
    setRun(chip.domain, { state: "undoing", connectionId: chip.connectionId, installationId });
    void suggest.host.undo(uid, installationId).then((res) => {
      if (!alive || mine !== gen) return;
      if (res.ok) {
        memoryFor(uid).undone.add(chip.domain);
        if (load && chip.connectionId) load = { ...load, connections: load.connections.filter((c) => c.id !== chip.connectionId) };
        setRun(chip.domain, { state: "idle" });
      } else {
        setRun(chip.domain, before.state === "idle" ? { state: "connected", how: "auto", connectionId: chip.connectionId, installationId } : before);
        undoProblem = res.reason;
      }
    });
  }

  /** No company yet: open the new-company flow, then connect this app in it. */
  async function connectAfterNewCompany(app: FoundApp): Promise<void> {
    const open = suggest.onnewcompany;
    if (!open || pending) return;
    pending = app.domain;
    let uid: string | null = null;
    try {
      uid = await open();
    } catch (err) {
      console.warn("[hq-desktop] welcome report new company threw:", err);
    }
    if (!alive) return;
    if (!uid) {
      pending = null;
      return;
    }
    pendingUid = uid;
  }

  function reload(): void {
    const uid = companyUid;
    if (!uid) return;
    undoProblem = null;
    load = null;
    memoryFor(uid).autoRan = false;
    loadApps(uid);
  }

  // The button rules are FirstRunYourAppsStep's.
  function label(tile: AppTile): string {
    switch (tile.run.state) {
      case "connecting":
        return tile.run.via === "browser" ? YOUR_APPS_COPY.waiting : YOUR_APPS_COPY.connecting;
      case "checking-docs":
        return YOUR_APPS_COPY.checking;
      case "failed":
        return YOUR_APPS_COPY.retry;
      default:
        break;
    }
    switch (tile.action) {
      case "setup":
        return YOUR_APPS_COPY.setup;
      case "not-yet":
        return YOUR_APPS_COPY.notYet;
      default:
        return YOUR_APPS_COPY.connect;
    }
  }

  function pressable(tile: AppTile): boolean {
    if (tile.run.state === "connecting" || tile.run.state === "checking-docs" || tile.run.state === "unsupported") return false;
    if (opensSignIn(tile) && browserBusy) return false;
    if (tile.run.state === "failed") return tile.run.retry;
    return opensSignIn(tile) || tile.action === "install" || tile.action === "integrations";
  }

  function press(tile: AppTile): void {
    if (!pressable(tile)) return;
    if (tile.action === "setup") setupTile(tile);
    else connectTile(tile);
  }

  /** Key, member and Slack rows carry their reason in the note and show no button. */
  function hasButton(tile: AppTile): boolean {
    return tile.action !== "needs-key" && tile.action !== "admin-only" && tile.action !== "later";
  }

  /** Why it was suggested, while nothing else needs saying. */
  function tileNote(tile: AppTile): string {
    const app = byDomain.get(tile.domain);
    if (app && tile.run.state === "idle" && tile.action === "setup") return evidence(app);
    return tile.note;
  }

  function chipNote(chip: ConnectedChip): string {
    return chip.how === "team" ? YOUR_APPS_COPY.team : chip.how === "auto" ? YOUR_APPS_COPY.noSignIn : YOUR_APPS_COPY.you;
  }

  const problem = $derived(undoProblem ? { reason: undoProblem, retry: false } : (load?.problem ?? null));
</script>

{#if problem}
  <p class="problem" role="status" data-testid="suggested-apps-problem">
    {problem.reason}
    {#if problem.retry}<button type="button" class="link" data-testid="suggested-apps-reload" onclick={reload}>Retry</button>{/if}
  </p>
{/if}
{#if rows.length}
  <ul class="rows" data-testid="suggested-apps">
    {#each shown as row (row.domain)}
      <li class="row" data-testid={`suggested-app-${row.domain}`} data-kind={row.kind}>
        <ConnectionCardLogo logo={appLogo(row.domain)} size={30} />
        <span class="text">
          <span class="name">{row.name}</span>
          {#if row.kind === "chip"}
            <span class="note" data-testid={`suggested-app-note-${row.domain}`}>{YOUR_APPS_COPY.groupConnected} · {chipNote(row.chip)}</span>
          {:else if row.kind === "tile"}
            <span class="note" aria-live="polite" title={tileNote(row.tile)} data-testid={`suggested-app-note-${row.domain}`}>{tileNote(row.tile)}</span>
          {:else}
            <span class="note" data-testid={`suggested-app-note-${row.domain}`}>{evidence(row.app)}</span>
          {/if}
        </span>
        {#if row.kind === "chip"}
          <span class="dot" aria-hidden="true"></span>
          {#if row.chip.canUndo}
            <button
              type="button"
              class="ghost"
              data-testid={`suggested-app-undo-${row.domain}`}
              aria-label={`${YOUR_APPS_COPY.undo} ${row.name}`}
              disabled={row.chip.undoing}
              aria-busy={row.chip.undoing ? "true" : undefined}
              onclick={() => undoChip(row.chip)}
            >{YOUR_APPS_COPY.undo}</button>
          {/if}
        {:else if row.kind === "tile"}
          {#if hasButton(row.tile)}
            {@const busy = row.tile.run.state === "connecting" || row.tile.run.state === "checking-docs"}
            <button
              type="button"
              class:ghost={row.tile.action === "setup"}
              data-testid={`suggested-app-connect-${row.domain}`}
              aria-label={`${label(row.tile)} ${row.name}`}
              disabled={!pressable(row.tile)}
              aria-busy={busy ? "true" : undefined}
              onclick={() => press(row.tile)}
            >{label(row.tile)}</button>
          {/if}
        {:else if suggest.onnewcompany}
          <button
            type="button"
            data-testid={`suggested-app-connect-${row.domain}`}
            aria-label={`${pending === row.domain ? YOUR_APPS_COPY.waiting : YOUR_APPS_COPY.connect} ${row.name}`}
            disabled={pending !== null}
            aria-busy={pending === row.domain ? "true" : undefined}
            onclick={() => void connectAfterNewCompany(row.app)}
          >{pending === row.domain ? YOUR_APPS_COPY.waiting : YOUR_APPS_COPY.connect}</button>
        {/if}
      </li>
    {/each}
  </ul>
  {#if !showAll && rows.length > SHOWN}
    <button type="button" class="link more" data-testid="suggested-apps-all" onclick={() => (showAll = true)}>Show all {rows.length}</button>
  {/if}
{/if}

<style>
  .rows {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    gap: 10px;
  }
  /* The brief's glass tile (.daily-brief .b-glass), as one line. */
  .row {
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 12px;
    border-radius: 14px;
    background:
      linear-gradient(180deg, rgba(255, 255, 255, 0.09), rgba(255, 255, 255, 0.025) 42%, rgba(255, 255, 255, 0.015)),
      radial-gradient(120% 60% at 20% 0%, rgba(255, 255, 255, 0.06), transparent 60%);
    border: 1px solid rgba(255, 255, 255, 0.09);
    border-top-color: rgba(255, 255, 255, 0.18);
    box-shadow:
      0 1px 2px rgba(0, 0, 0, 0.3),
      0 8px 20px -8px rgba(0, 0, 0, 0.5);
  }
  .text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .name,
  .note {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .name {
    font-size: 13.5px;
    font-weight: 500;
    letter-spacing: -0.01em;
  }
  .note {
    font-size: 12px;
    color: var(--b-t2, rgba(255, 255, 255, 0.56));
  }
  .dot {
    width: 7px;
    height: 7px;
    flex: none;
    border-radius: 50%;
    background: var(--b-ok, var(--ok, #34c759));
  }
  .problem {
    margin: 0 0 10px;
    font-size: 12.5px;
    color: var(--b-t2, rgba(255, 255, 255, 0.56));
  }
  button {
    flex: none;
    font: inherit;
    font-size: 12px;
    font-weight: 500;
    padding: 5px 12px;
    border-radius: 999px;
    border: 0;
    background: rgba(255, 255, 255, 0.9);
    color: #1b1b1e;
    cursor: pointer;
    transition: opacity 120ms cubic-bezier(0.25, 1, 0.5, 1);
  }
  button.ghost {
    background: rgba(255, 255, 255, 0.08);
    color: var(--b-t1, rgba(255, 255, 255, 0.95));
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.12);
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  button:active:not(:disabled) {
    opacity: 0.7;
  }
  button.link {
    padding: 0;
    margin-left: 6px;
    background: none;
    color: var(--b-t1, rgba(255, 255, 255, 0.95));
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  button.more {
    margin: 10px 0 0;
  }
  @media (prefers-reduced-motion: reduce) {
    button {
      transition: none;
    }
  }
</style>
