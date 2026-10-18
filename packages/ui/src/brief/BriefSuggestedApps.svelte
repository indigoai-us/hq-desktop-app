<script lang="ts">
  /**
   * The suggested integrations under "Connect your AI apps": the work apps
   * the launch scan found (matchFoundApps), a glass row each with the app,
   * why it was suggested (the evidence line) and a Connect action.
   *
   * With a company, the rows are your-apps.ts's view and every connect goes
   * through the shared `YourAppsHost` (the takeover's "Your apps" flow): one
   * browser sign-in at a time, the no-sign-in auto-connect once per company,
   * Undo kept in the owner's session (welcome-connect-session.svelte.ts),
   * so a remount (the report turning ready) keeps a sign-in running.
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
    type AppTile,
    type ConnectedChip,
  } from "../chat/first-run/your-apps.js";
  import type { WelcomeSuggest } from "./welcome-ai-apps.js";
  import { WelcomeConnectSession } from "./welcome-connect-session.svelte.js";

  interface Props {
    /** The shared scan, matched to known apps. */
    scan: FoundAppsResult;
    suggest: WelcomeSuggest;
    /** The owner's connect session; without one the card keeps its own while mounted. */
    session?: WelcomeConnectSession | null;
  }
  let { scan, suggest, session: given = null }: Props = $props();

  /** Rows shown before "Show all". */
  const SHOWN = 6;

  let hostNoun = $state(hostComputerNoun());
  onMount(() => subscribeHostComputerNoun((next) => (hostNoun = next)));

  const local = untrack(() => given) ? null : new WelcomeConnectSession();
  onDestroy(() => local?.dispose());
  const session = $derived(given ?? (local as WelcomeConnectSession));

  let showAll = $state(false);

  const companyUid = $derived(suggest.company?.uid ?? null);

  // A different company starts over in the session; the same one (a remount) keeps its runs.
  $effect(() => {
    const uid = companyUid;
    untrack(() => session.setCompany(suggest.host, uid));
  });

  const load = $derived(session.load);
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
          runs: session.runs,
          evidence,
        })
      : null,
  );

  type Row =
    | { kind: "chip"; domain: string; name: string; chip: ConnectedChip }
    | { kind: "tile"; domain: string; name: string; tile: AppTile }
    | { kind: "found"; domain: string; name: string; app: FoundApp };

  function foundRows(): Row[] {
    return found.filter((app) => !app.excluded).map((app) => ({ kind: "found" as const, domain: app.domain, name: app.name, app }));
  }

  /** Connected first, then ready to connect, then the ones HQ sets up from a guide. */
  const rows = $derived.by((): Row[] => {
    if (!companyUid) return foundRows();
    // Catalog still out, but a Connect is waiting or already ran out: keep the
    // found row so it can say Waiting, then Didn't connect. An empty list here
    // hid the button for the whole hang.
    if (!view && (session.pending || session.waitFailed)) return foundRows();
    if (!view) return [];
    return [
      ...view.connected.map((chip): Row => ({ kind: "chip", domain: chip.domain, name: chip.name, chip })),
      ...[...view.ready, ...view.notInHq].map((tile): Row => ({ kind: "tile", domain: tile.domain, name: tile.name, tile })),
    ];
  });
  const shown = $derived(showAll ? rows : rows.slice(0, SHOWN));
  const browserBusy = $derived(view ? signInRunning(view) : false);

  /** Connect the found no-sign-in catalog apps once per company (owner or admin only). */
  function runAutoConnect(uid: string): void {
    const current = load;
    const remembered = session.memoryFor(uid);
    if (remembered.autoRan || !current || !found.length) return;
    remembered.autoRan = true;
    const plan = autoConnectPlan(
      { found, catalog: current.catalog, connections: current.connections, canManage: current.canManage, runs: session.runs },
      remembered.undone,
    );
    session.autoConnect(plan.map((item) => ({ domain: item.domain, entryId: item.entryId, name: byDomain.get(item.domain)?.name ?? item.domain })));
  }

  // Once the new company's apps load, the Connect that waited for it runs
  // (also when the shell switched to the company before the step answered).
  $effect(() => {
    void session.pendingUid;
    if (!view || !companyUid) return;
    const uid = companyUid;
    untrack(() => {
      const domain = session.takePending(uid);
      if (domain) {
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
    session.connect(tile);
  }

  function setupTile(tile: AppTile): void {
    if (!companyUid || (view && signInRunning(view))) return;
    session.setup(tile);
  }

  /** No company yet: open the new-company flow, then connect this app in it. */
  function connectAfterNewCompany(app: FoundApp): void {
    const open = suggest.onnewcompany;
    if (open) void session.connectAfterNewCompany(app.domain, open);
  }

  /** Found row: a company whose catalog hung retries the load. Otherwise open the sheet. */
  function pressFound(app: FoundApp): void {
    if (companyUid && session.waitFailed === app.domain) {
      session.retryCatalog(app.domain);
      return;
    }
    connectAfterNewCompany(app);
  }

  /** The found row's button: Connect, Waiting while the new company is made, Try again once the wait ran out. */
  function foundLabel(domain: string): string {
    if (session.pending === domain) return YOUR_APPS_COPY.waiting;
    return session.waitFailed === domain ? YOUR_APPS_COPY.retry : YOUR_APPS_COPY.connect;
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

  const problem = $derived(session.undoProblem ? { reason: session.undoProblem, retry: false } : (load?.problem ?? null));
</script>

{#if problem}
  <p class="problem" role="status" data-testid="suggested-apps-problem">
    {problem.reason}
    {#if problem.retry}<button type="button" class="link" data-testid="suggested-apps-reload" onclick={() => session.reload()}>Retry</button>{/if}
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
            <span class="note" data-testid={`suggested-app-note-${row.domain}`}>{session.waitFailed === row.domain ? YOUR_APPS_COPY.failed : evidence(row.app)}</span>
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
              onclick={() => session.undo(row.chip)}
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
            aria-label={`${foundLabel(row.domain)} ${row.name}`}
            disabled={session.pending !== null}
            aria-busy={session.pending === row.domain ? "true" : undefined}
            onclick={() => pressFound(row.app)}
          >{foundLabel(row.domain)}</button>
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
