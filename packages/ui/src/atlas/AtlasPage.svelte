<script lang="ts">
  /**
   * Atlas v0 — company roster crossed with active projects (US-016).
   *
   * Data: one GET /v1/work-mesh/live on open (when getJson is provided), then
   * the bound LiveReadStore + PresenceStore / live wakes. No polling loop.
   * Visibility (private vs transparent) is enforced by the server filter.
   */
  import { onMount } from "svelte";
  import {
    fetchLiveRead,
    type LivePresence,
    type LiveReadResponse,
  } from "@hq/core";
  import PageHeader from "../shell/PageHeader.svelte";
  import { liveReadFor } from "../chat/live-read-store.svelte.js";
  import { presenceSnapshot } from "../chat/presence-store.svelte.js";
  import {
    buildAtlasView,
    type AtlasViewModel,
  } from "./atlas-model.js";
  import { requestLiveRefresh } from "./live-refresh.js";
  import type { MigrateCompanyOption } from "../chat/session-migrate.js";
  import "../home/tokens.css";

  interface Props {
    companyUid: string;
    companyLabel?: string | null;
    /** Injected live snapshot for tests / harness (skips store + fetch). */
    live?: LiveReadResponse | null;
    /**
     * Optional presence overrides (tests). When omitted, PresenceStore snapshot
     * for `companyUid` is used.
     */
    presenceByActor?: ReadonlyMap<string, LivePresence> | null;
    /** One-shot JSON getter for GET /v1/work-mesh/live on open. */
    getJson?: ((path: string) => Promise<unknown>) | null;
    /** Feature gate: null = loading, false = hidden, true = show. */
    featureEnabled?: boolean | null;
    /** Project id → display label. */
    projectLabels?: ReadonlyMap<string, string> | Readonly<Record<string, string>> | null;
    onback?: () => void;
    /** Header variant for shell vs classic desktop-alt chrome. */
    headerVariant?: "window" | "embedded";
    /**
     * Company owner/admin + at least one destination (US-017B). Shell owns the
     * confirm dialog; Atlas only raises sessionId.
     */
    canMigrate?: boolean;
    migrateDestinations?: readonly MigrateCompanyOption[];
    onmigratesession?: (sessionId: string) => void;
    migratingSessionId?: string | null;
  }

  let {
    companyUid,
    companyLabel = null,
    live = null,
    presenceByActor = null,
    getJson = null,
    featureEnabled = true,
    projectLabels = null,
    onback,
    headerVariant = "embedded",
    canMigrate = false,
    migrateDestinations = [],
    onmigratesession,
    migratingSessionId = null,
  }: Props = $props();

  const showMigrate = $derived(
    Boolean(canMigrate && onmigratesession && migrateDestinations.length > 0),
  );

  let fetchedLive = $state<LiveReadResponse | null>(null);
  let loadError = $state<string | null>(null);
  let loading = $state(false);
  /** Set true after the open fetch settles (or is skipped) — blocks any poll. */
  let openFetchDone = $state(false);

  const storeLive = $derived(liveReadFor(companyUid.trim()));

  const resolvedLive = $derived<LiveReadResponse | null | undefined>(
    live ?? fetchedLive ?? storeLive,
  );

  const storePresence = $derived.by(() => {
    const map = new Map<string, LivePresence>();
    const company = presenceSnapshot().get(companyUid.trim());
    if (!company) return map;
    for (const [actorUid, entry] of company) {
      map.set(actorUid, entry.status);
    }
    return map;
  });

  const atlas = $derived<AtlasViewModel>(
    buildAtlasView({
      live: resolvedLive,
      presenceByActor: presenceByActor ?? storePresence,
      projectLabels,
      includeUnassigned: true,
    }),
  );

  const subtitle = $derived.by(() => {
    const parts: string[] = [];
    if (companyLabel?.trim()) parts.push(companyLabel.trim());
    parts.push(
      `${atlas.onlineCount} online`,
      atlas.offlineCount === 1
        ? "1 offline"
        : `${atlas.offlineCount} offline`,
    );
    return parts.join(" · ");
  });

  onMount(() => {
    let cancelled = false;
    const uid = companyUid.trim();
    // One refresh on open only — subsequent updates come from the live-read
    // store (MeshClient wake coalescer) and presence store. Never setInterval.
    if (live != null || !uid) {
      openFetchDone = true;
      return () => {
        cancelled = true;
      };
    }

    // Prefer the host MeshClient coalescer (bound via bindLiveRefresh).
    requestLiveRefresh(uid);

    if (!getJson) {
      openFetchDone = true;
      return () => {
        cancelled = true;
      };
    }

    loading = true;
    void fetchLiveRead(uid, getJson)
      .then((response) => {
        if (cancelled) return;
        fetchedLive = response;
        loadError = null;
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        loadError =
          err instanceof Error && err.message
            ? err.message
            : "Could not load live roster";
      })
      .finally(() => {
        if (!cancelled) {
          loading = false;
          openFetchDone = true;
        }
      });
    return () => {
      cancelled = true;
    };
  });
</script>

{#if featureEnabled === false}
  <div class="atlas-feature-hidden" data-testid="atlas-feature-hidden" role="status">
    Atlas is not available for this account.
  </div>
{/if}

<section
  class="atlas"
  class:hidden-by-gate={featureEnabled === false}
  aria-labelledby="atlas-page-title"
  data-testid="atlas-page"
  data-open-fetch-done={openFetchDone ? "true" : "false"}
>
  <PageHeader
    title="Atlas"
    titleId="atlas-page-title"
    titleTestId="atlas-title"
    subtitle={subtitle}
    subtitleTestId="atlas-subtitle"
    {onback}
    backTestId="atlas-back"
    backAriaLabel="Back"
    variant={headerVariant}
    testId="atlas-header"
  />

  {#if loading && !resolvedLive}
    <p class="atlas-status" data-testid="atlas-loading" role="status">Loading live roster…</p>
  {:else if loadError && !resolvedLive}
    <p class="atlas-status atlas-error" data-testid="atlas-error" role="alert">{loadError}</p>
  {:else if atlas.empty}
    <div class="atlas-empty" data-testid="atlas-empty" role="status">
      <p class="atlas-empty-title">No one is online</p>
      <p class="atlas-empty-body">
        When people and agents start work in this company, they appear here on
        their projects.
      </p>
    </div>
  {:else}
    <div class="atlas-body" data-testid="atlas-body">
      {#if atlas.offlineCount > 0}
        <p class="atlas-offline-summary" data-testid="atlas-offline-count">
          {atlas.offlineCount}
          {atlas.offlineCount === 1 ? "person offline" : "people offline"}
        </p>
      {/if}

      {#each atlas.projects as project (project.projectId)}
        <article
          class="atlas-project"
          data-testid="atlas-project"
          data-project-id={project.projectId}
        >
          <header class="atlas-project-header">
            <h2 class="atlas-project-title">{project.label}</h2>
            {#if project.offlineCount > 0}
              <span class="atlas-project-offline" data-testid="atlas-project-offline">
                {project.offlineCount} offline
              </span>
            {/if}
          </header>
          <ul class="atlas-actor-list" aria-label={`Online on ${project.label}`}>
            {#each project.onlineActors as actor (actor.sessionId)}
              <li
                class="atlas-actor"
                data-testid="atlas-actor"
                data-actor-uid={actor.actorUid}
                data-actor-type={actor.actorType}
                data-session-id={actor.sessionId}
                data-online="true"
              >
                <span
                  class="atlas-dot"
                  class:agent={actor.actorType === "agent"}
                  aria-hidden="true"
                ></span>
                <span class="atlas-actor-name">{actor.displayName}</span>
                <span class="atlas-actor-meta">
                  {#if actor.taskId}
                    <span class="atlas-task" data-testid="atlas-task">{actor.taskId}</span>
                  {/if}
                  <span class="atlas-harness" data-testid="atlas-harness">{actor.harness}</span>
                </span>
                {#if showMigrate}
                  <button
                    type="button"
                    class="atlas-migrate"
                    data-testid="atlas-session-migrate"
                    aria-label="Move to another company"
                    title="Move to another company"
                    disabled={migratingSessionId === actor.sessionId}
                    onclick={() => onmigratesession?.(actor.sessionId)}
                  >
                    {#if migratingSessionId === actor.sessionId}…{:else}Move{/if}
                  </button>
                {/if}
              </li>
            {/each}
          </ul>
        </article>
      {/each}

      {#if atlas.unassigned.length > 0}
        <article
          class="atlas-project atlas-unassigned"
          data-testid="atlas-unassigned"
        >
          <header class="atlas-project-header">
            <h2 class="atlas-project-title">Unassigned</h2>
          </header>
          <ul class="atlas-actor-list" aria-label="Unassigned sessions">
            {#each atlas.unassigned as actor (actor.sessionId)}
              <li
                class="atlas-actor"
                data-testid="atlas-actor"
                data-actor-uid={actor.actorUid}
                data-actor-type={actor.actorType}
                data-session-id={actor.sessionId}
                data-online="true"
                data-unassigned="true"
              >
                <span
                  class="atlas-dot"
                  class:agent={actor.actorType === "agent"}
                  aria-hidden="true"
                ></span>
                <span class="atlas-actor-name">{actor.displayName}</span>
                <span class="atlas-actor-meta">
                  <span class="atlas-harness" data-testid="atlas-harness">{actor.harness}</span>
                </span>
                {#if showMigrate}
                  <button
                    type="button"
                    class="atlas-migrate"
                    data-testid="atlas-session-migrate"
                    aria-label="Move to another company"
                    title="Move to another company"
                    disabled={migratingSessionId === actor.sessionId}
                    onclick={() => onmigratesession?.(actor.sessionId)}
                  >
                    {#if migratingSessionId === actor.sessionId}…{:else}Move{/if}
                  </button>
                {/if}
              </li>
            {/each}
          </ul>
        </article>
      {/if}
    </div>
  {/if}
</section>

<style>
  .atlas {
    /* Compact company atlas column — desktop widget width. */
    width: 100%;
    max-width: 360px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: var(--v4-space-4, 12px);
    min-height: 0;
    font-family: var(--font-sans, system-ui, sans-serif);
    color: var(--v4-text-1, #111);
    box-sizing: border-box;
    padding: var(--v4-space-4, 12px);
  }

  .atlas.hidden-by-gate {
    display: none;
  }

  .atlas-feature-hidden {
    padding: var(--v4-space-4, 12px);
    color: var(--v4-text-2, #666);
    font-size: var(--type-body, 15px);
  }

  .atlas-status {
    margin: 0;
    color: var(--v4-text-2, #666);
    font-size: var(--type-secondary, 14px);
  }

  .atlas-error {
    color: var(--v4-error, #c44);
  }

  .atlas-empty {
    padding: var(--v4-space-5, 16px) 0;
  }

  .atlas-empty-title {
    margin: 0 0 6px;
    color: var(--v4-text-1, #111);
    font-size: var(--type-section, 17px);
    font-weight: 600;
  }

  .atlas-empty-body {
    margin: 0;
    color: var(--v4-text-3, #888);
    font-size: var(--type-secondary, 14px);
    line-height: 1.4;
  }

  .atlas-body {
    display: flex;
    flex-direction: column;
    gap: var(--v4-space-4, 12px);
    min-height: 0;
  }

  .atlas-offline-summary {
    margin: 0;
    color: var(--v4-text-3, #888);
    font-size: var(--type-metadata, 13px);
  }

  .atlas-project {
    border: 1px solid var(--v4-hairline, rgb(0 0 0 / 0.08));
    border-radius: var(--v4-radius-md, 10px);
    background: color-mix(in srgb, var(--v4-ground, #eee) 70%, transparent);
    padding: var(--v4-space-3, 10px) var(--v4-space-4, 12px);
  }

  .atlas-project-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 8px;
  }

  .atlas-project-title {
    margin: 0;
    color: var(--v4-text-1, #111);
    font-size: var(--type-secondary, 14px);
    font-weight: 600;
  }

  .atlas-project-offline {
    color: var(--v4-text-3, #888);
    font-size: var(--type-metadata, 13px);
    white-space: nowrap;
  }

  .atlas-actor-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .atlas-actor {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .atlas-dot {
    flex: 0 0 8px;
    width: 8px;
    height: 8px;
    border-radius: var(--v4-radius-pill, 999px);
    background: var(--v4-ok, #2f9e44);
  }

  .atlas-dot.agent {
    background: var(--v4-ok, #2f9e44);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--v4-ok, #2f9e44) 28%, transparent);
  }

  .atlas-actor-name {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--v4-text-1, #111);
    font-size: var(--type-body, 15px);
    font-weight: 500;
  }

  .atlas-actor-meta {
    margin-left: auto;
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
    color: var(--v4-text-3, #888);
    font-size: var(--type-metadata, 13px);
  }

  .atlas-task {
    color: var(--v4-text-2, #666);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 96px;
  }

  .atlas-harness {
    text-transform: lowercase;
  }

  .atlas-migrate {
    flex: 0 0 auto;
    appearance: none;
    -webkit-appearance: none;
    padding: 2px 6px;
    border: 1px solid var(--v4-hairline, rgb(0 0 0 / 0.12));
    border-radius: 6px;
    background: transparent;
    color: var(--v4-text-2, #666);
    font: 500 11px/1.2 var(--font-sans, system-ui, sans-serif);
    cursor: pointer;
  }

  .atlas-migrate:hover:not(:disabled),
  .atlas-migrate:focus-visible:not(:disabled) {
    color: var(--v4-text-1, #111);
    border-color: var(--v4-text-3, #888);
    outline: none;
  }

  .atlas-migrate:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .atlas-unassigned .atlas-project-title {
    color: var(--v4-text-2, #666);
  }
</style>
