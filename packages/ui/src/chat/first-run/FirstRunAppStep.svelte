<script lang="ts">
  /**
   * Note taker and Project management (visual first run, slice 5): the body
   * of either screen. The catalog's apps of one kind, each with its logo
   * (the bot connection cards' `ConnectionCardLogo`, bundled marks only) and
   * a Connect button. One app connects at a time and the screen never waits
   * for it: the takeover's Next and Finish stay live, and a connect still
   * running finishes on its own.
   *
   * The knowledge tree is a full-window scene on its own step, so a
   * connected app shows here as a connected-state line rather than a new
   * node on the tree.
   */
  import ConnectionCardLogo from "../messaging/ConnectionCardLogo.svelte";
  import { appLogo } from "../messaging/integration-cards-model.js";
  import {
    APP_COPY,
    APPS_SHOWN_MAX,
    type AppCatalogState,
    type AppConnectState,
    type AppStepCopy,
    type FirstRunApp,
  } from "./app-step.js";

  interface Props {
    kind: "notes" | "projects";
    copy: AppStepCopy;
    company: string;
    catalog: AppCatalogState;
    connect: AppConnectState;
    onconnect: (app: FirstRunApp) => void;
    onreload: () => void;
  }

  let { kind, copy, company, catalog, connect, onconnect, onreload }: Props = $props();

  let filter = $state("");

  const apps = $derived(catalog.state === "loading" || !catalog.ok ? [] : catalog.apps);
  const already = $derived(new Set(catalog.state !== "loading" && catalog.ok ? catalog.connected : []));
  const needsFilter = $derived(apps.length > APPS_SHOWN_MAX);
  const matched = $derived.by(() => {
    const q = filter.trim().toLocaleLowerCase();
    return q ? apps.filter((app) => app.name.toLocaleLowerCase().includes(q) || app.domain.includes(q)) : apps;
  });
  const shown = $derived(matched.slice(0, APPS_SHOWN_MAX));
  const connectedApp = $derived(connect.state === "connected" ? connect.app : null);
  const busyDomain = $derived(connect.state === "connecting" ? connect.domain : null);

  function buttonLabel(app: FirstRunApp): string {
    if (connectedApp?.domain === app.domain || already.has(app.domain)) return APP_COPY.connected;
    if (busyDomain === app.domain) return app.authClass === "oauth" ? APP_COPY.waiting : APP_COPY.connecting;
    return APP_COPY.connect;
  }
</script>

<p class="new-bot-create-copy">{copy.copy}</p>
{#if catalog.state === "loading"}
  <p class="new-bot-muted" data-testid={`first-run-${kind}-loading`} aria-busy="true">{APP_COPY.loading}</p>
{:else if !catalog.ok}
  <p class="new-bot-price first-run-status" data-testid={`first-run-${kind}-catalog-failed`}>
    {catalog.reason}
    {#if catalog.retry}<button type="button" class="new-bot-inline-link" data-testid={`first-run-${kind}-reload`} onclick={onreload}>Retry</button>{/if}
  </p>
{:else if apps.length === 0}
  <p class="new-bot-muted" data-testid={`first-run-${kind}-empty`}>{copy.empty}</p>
{:else}
  {#if needsFilter}
    <label class="new-bot-filter-label" for={`first-run-${kind}-filter`}>Find an app</label>
    <input
      id={`first-run-${kind}-filter`}
      class="new-bot-create-input"
      data-testid={`first-run-${kind}-filter`}
      value={filter}
      autocomplete="off"
      oninput={(event) => (filter = (event.currentTarget as HTMLInputElement).value)}
    />
  {/if}
  <ul class="first-run-apps" data-testid={`first-run-${kind}-apps`}>
    {#each shown as app (app.domain)}
      {@const isConnected = connectedApp?.domain === app.domain || already.has(app.domain)}
      {@const pending = busyDomain === app.domain}
      {@const note = app.authClass === "key" && !isConnected ? APP_COPY.needsKey : app.description || app.domain}
      <li class="first-run-app" class:connected={isConnected} data-testid={`first-run-app-${app.domain}`}>
        <ConnectionCardLogo logo={appLogo(app.domain)} size={30} />
        <span class="first-run-app-text">
          <span class="first-run-app-name">{app.name}</span>
          <span class="first-run-app-note" title={note}>{note}</span>
        </span>
        {#if app.authClass !== "key" || isConnected}
          <button
            type="button"
            class="first-run-app-connect"
            data-testid={`first-run-connect-${app.domain}`}
            disabled={isConnected || pending || connect.state === "connecting" || !!connectedApp}
            aria-busy={pending ? "true" : undefined}
            onclick={() => onconnect(app)}
          >{buttonLabel(app)}</button>
        {/if}
      </li>
    {/each}
  </ul>
  {#if needsFilter && matched.length === 0}<p class="new-bot-company-empty">No app matches that.</p>{/if}
{/if}
{#if connectedApp}
  <p class="new-bot-price first-run-app-line" data-testid={`first-run-${kind}-connected`}>
    <span class="first-run-app-dot" aria-hidden="true"></span>{connectedApp.name} is connected to {company}.
  </p>
{/if}

<style>
  .first-run-apps {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .first-run-app {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
    min-height: 52px;
    border: 1px solid var(--new-bot-line);
    border-radius: 12px;
    padding: 8px 10px;
    background: rgba(9, 9, 11, 0.36);
  }
  .first-run-app.connected {
    background: rgba(255, 255, 255, 0.12);
  }
  .first-run-app-text {
    display: grid;
    flex: 1 1 auto;
    gap: 1px;
    min-width: 0;
  }
  .first-run-app-name {
    overflow: hidden;
    font-size: 13px;
    font-weight: 500;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .first-run-app-note {
    overflow: hidden;
    color: var(--new-bot-muted);
    font-size: 12px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .first-run-app-connect {
    flex: 0 0 auto;
    border: 1px solid var(--new-bot-line);
    border-radius: 999px;
    padding: 5px 11px;
    background: rgba(255, 255, 255, 0.08);
    color: var(--new-bot-ink);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  .first-run-app-connect:disabled {
    cursor: default;
    opacity: 0.7;
  }
  .first-run-app-connect:focus-visible {
    outline: 1px solid var(--new-bot-ink);
    outline-offset: 2px;
  }
  .first-run-app-line {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .first-run-app-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #4ade80;
    box-shadow: 0 0 10px rgba(74, 222, 128, 0.55);
  }
</style>
