<script lang="ts">
  import "../common/detail/detail-panel.css";
  import DetailActions from "../common/detail/DetailActions.svelte";
  import DetailFacts from "../common/detail/DetailFacts.svelte";
  import RailIcon from "../common/button/RailIcon.svelte";
  import Dropdown from "../common/LazyDropdown.svelte";
  import ReadLoader from "../common/ReadLoader.svelte";
  import CompanyLabel from "../company/CompanyLabel.svelte";
  import RailButton from "../common/button/RailButton.svelte";
  import { sourceIconUrl, sourceNames } from "./google-source-icons.js";
  import { dismissable } from "../common/dismissable.js";
  /**
   * Personal Secrets and Connections (US-033).
   * First frame is the cache. Refresh runs after paint.
   * Sheets are the US-029 secret and connect sheets. Values never render.
   */
  import { untrack } from "svelte";
  import "../home/tokens.css";
  import "../chat/chat-tokens.css";
  import { companyStore } from "../company/company-store.svelte.js";
  import ShowMoreRow from "../shell/ShowMoreRow.svelte";
  import ListEmptyState from "../common/ListEmptyState.svelte";
  import { countLabel, pageRows } from "../shell/list-paging.js";
  import {
    acceptSecretKey,
    applyDeepLink,
    beginConnect,
    clampAccess,
    shareSheet,
    ACCESS_LEVELS,
    type AccessLevel,
    type ConnectSession,
  } from "../company/files-connect/files-connect-model.js";
  import {
    BOT_POLICIES,
    BOT_POLICY_LABEL,
    execSnippet,
    filterConnections,
    filterPersonalSecretsBy,
    secretPillsAreDefault,
    DEFAULT_SECRET_PILLS,
    type SecretFilterPills,
    emptyPersonalRail,
    fixturePersonalRail,
    personalSecretsErrorReason,
    personalSecretsFromSource,
    readPersonalRailCache,
    writePersonalRailCache,
    type BotPolicy,
    type PersonalRailCache,
  } from "./personal-rail-model.js";
  import {
    PERSONAL_INTEGRATIONS_URL,
    connectedLabel,
    loadPersonalIntegrations,
    readIntegrationsCache,
    writeIntegrationsCache,
    IntegrationsLoadError,
    type PersonalIntegration,
    type PersonalIntegrationsApi,
  } from "./personal-integrations.js";
  import { companyIntegrationsUrl } from "../common/hq-console.js";

  interface Props {
    page: "secrets" | "connections";
    /** Perf harness and design scenes only. The running app never sets this. */
    fixtures?: boolean;
    /** Companies the owner belongs to, for the per-company Integrations links. */
    companies?: { uid: string; label: string }[];
    /** The selected company, when one is; its console Integrations page is linked at the bottom. */
    activeCompany?: { uid: string; label: string; slug?: string } | null;
    onopenintegrations?: (uid: string) => void;
    /** hq-pro personal integration routes (Google, personal Slack). */
    integrationsApi?: PersonalIntegrationsApi | null;
    /** Opens a URL in the system browser. */
    openExternal?: (url: string) => void;
  }

  let {
    page,
    fixtures = false,
    companies = [],
    activeCompany = null,
    onopenintegrations,
    integrationsApi = null,
    openExternal,
  }: Props = $props();

  // Fixture mode is fixed for the life of the page.
  const useFixtures = untrack(() => fixtures);
  const cachedAtOpen = useFixtures ? null : readPersonalRailCache("personal");
  let data = $state<PersonalRailCache>(
    useFixtures
      ? fixturePersonalRail()
      : cachedAtOpen ?? emptyPersonalRail(),
  );
  // "loading" paints the loader; it only shows when nothing is cached yet.
  let secretsState = $state<"loading" | "ready" | "error">(
    useFixtures || cachedAtOpen ? "ready" : "loading",
  );
  let secretsError = $state("");
  let query = $state("");
  // OWNER-R36: Secrets filters are header pills (Mode, Not rotated in 90 d), not a side list.
  let secretPills = $state<SecretFilterPills>({ ...DEFAULT_SECRET_PILLS });
  let connectionTab = $state<"connected" | "available" | "agents" | "attention">("connected");
  let selectedSecret = $state("");
  let selectedConnection = $state("github");
  let sheet = $state<string | null>(null);
  let secretDraft = $state("");
  let grantLevel = $state<AccessLevel>("read");
  let connect = $state<ConnectSession | null>(null);
  let copied = $state("");

  $effect(() => {
    if (useFixtures) return;
    let live = true;
    queueMicrotask(() => {
      if (live) void refresh(false);
    });
    return () => {
      live = false;
    };
  });

  async function refresh(force: boolean): Promise<void> {
    if (secretsState === "error") secretsState = "loading";
    try {
      const loaded = await companyStore.loadSecrets("personal", force);
      const secrets = personalSecretsFromSource(Array.isArray(loaded) ? loaded : []);
      data = { ...data, secrets };
      writePersonalRailCache("personal", data);
      secretsState = "ready";
      secretsError = "";
    } catch (err) {
      console.warn("[personal-rail] secrets load failed", err);
      secretsError = personalSecretsErrorReason(err);
      // Cached rows stay on screen; the error state only replaces an empty list.
      secretsState = data.secrets.length > 0 ? "ready" : "error";
    }
  }

  // Personal integrations: cached rows paint first, refresh runs after paint.
  const cachedIntegrations = useFixtures ? null : readIntegrationsCache();
  let integrations = $state<PersonalIntegration[]>(cachedIntegrations ?? []);
  let integrationsState = $state<"loading" | "ready" | "error">(cachedIntegrations ? "ready" : "loading");
  let integrationsError = $state("");
  let selectedIntegration = $state("");

  $effect(() => {
    if (useFixtures || page !== "connections") return;
    let live = true;
    queueMicrotask(() => {
      if (live) void refreshIntegrations();
    });
    return () => {
      live = false;
    };
  });

  async function refreshIntegrations(): Promise<void> {
    if (integrationsState === "error") integrationsState = "loading";
    try {
      const next = await loadPersonalIntegrations(integrationsApi);
      integrations = next;
      writeIntegrationsCache(next);
      integrationsState = "ready";
      integrationsError = "";
    } catch (err) {
      if (!(err instanceof IntegrationsLoadError)) console.warn("[personal-rail] integrations load failed", err);
      integrationsError = err instanceof IntegrationsLoadError ? err.reason : "Could not load your connections. Check your connection and retry.";
      // Cached rows stay on screen; the error state only replaces an empty list.
      integrationsState = integrations.length > 0 ? "ready" : "error";
    }
  }

  const integrationCurrent = $derived(
    integrations.find((row) => row.id === selectedIntegration) ?? integrations[0],
  );

  function openConsoleIntegrations(): void {
    openExternal?.(PERSONAL_INTEGRATIONS_URL);
  }

  function openCompanyConsoleIntegrations(company: { slug?: string }): void {
    if (company.slug) openExternal?.(companyIntegrationsUrl(company.slug));
  }

  const secretRows = $derived(filterPersonalSecretsBy(data.secrets, secretPills, query));
  const secretModeCounts = $derived({
    standard: data.secrets.filter((row) => row.kind === "standard").length,
    proxy: data.secrets.filter((row) => row.kind === "proxy").length,
  });
  const connectionRows = $derived(
    filterConnections(
      data.connections,
      page === "connections" && connectionTab === "connected" ? "connected" : connectionTab,
      query,
    ),
  );
  // Every list shows all rows, in pages of 50 with a Show more row.
  let secretPages = $state(1);
  let connectionPages = $state(1);
  $effect(() => {
    void page;
    void query;
    void secretPills.mode;
    void secretPills.stale;
    void connectionTab;
    secretPages = connectionPages = 1;
  });
  const secretPage = $derived(pageRows(secretRows, secretPages));
  const connectionPage = $derived(pageRows(connectionRows, connectionPages));
  // QA-058: the inspector follows the visible rows, so a search that hides
  // every secret also clears the inspector instead of keeping a stale row.
  const secretCurrent = $derived(
    secretRows.find((row) => row.id === selectedSecret) ?? secretRows[0],
  );
  const connectionCurrent = $derived(
    data.connections.find((row) => row.id === selectedConnection) ?? data.connections[0],
  );
  const shareView = $derived(secretCurrent ? shareSheet(secretCurrent) : null);
  const connectedCount = $derived(data.connections.filter((row) => row.status === "connected").length);
  const attentionCount = $derived(data.connections.filter((row) => row.status === "reconnect").length);

  function onSecretBeforeInput(event: InputEvent): void {
    if (!acceptSecretKey(event.inputType)) event.preventDefault();
  }

  function setPolicy(id: string, policy: BotPolicy): void {
    data = {
      ...data,
      connections: data.connections.map((row) => (row.id === id ? { ...row, policy } : row)),
    };
    writePersonalRailCache("personal", data);
  }

  async function copyExec(name: string): Promise<void> {
    const snippet = execSnippet(name);
    copied = snippet;
    try {
      await navigator.clipboard?.writeText(snippet);
    } catch {
      /* the snippet stays in the button label */
    }
  }

  function disconnect(id: string): void {
    data = {
      ...data,
      connections: data.connections.map((row) => (row.id === id ? { ...row, status: "available" as const } : row)),
    };
    writePersonalRailCache("personal", data);
    sheet = null;
  }

  function openConnect(app: string): void {
    connect = beginConnect(app);
    sheet = "connect-waiting";
  }

  function simulateReturn(): void {
    if (!connect) return;
    connect = applyDeepLink(connect, "hq://connect?code=ok");
    sheet = null;
  }
</script>

<section class="page" data-testid="personal-rail" data-page={page} data-story="US-033">
  <div class="main">
    {#if page === "secrets"}
      <header class="toolbar">
        <h1>Secrets</h1>
        <!-- BLANK-2: counts wait for a read that succeeded. -->
        {#if secretsState === "ready"}<span class="count" data-testid="personal-secrets-count">{countLabel("Secrets", secretRows.length)}</span>{/if}
        <span class="sub">Values never shown</span>
        <span class="pills" data-testid="secrets-pills">
          <Dropdown
            pill
            active={secretPills.mode !== "all"}
            testid="secrets-mode-pill"
            label="Mode"
            value={secretPills.mode}
            onchange={(v) => (secretPills = { ...secretPills, mode: v as SecretFilterPills["mode"] })}
            options={[
              { value: "all", label: "All modes" },
              { value: "standard", label: "Standard", detail: secretModeCounts.standard.toLocaleString() },
              { value: "proxy", label: "Proxy-only", detail: secretModeCounts.proxy.toLocaleString() },
            ]}
          />
          <button type="button" class="toggle-pill" class:sel={secretPills.stale} aria-pressed={secretPills.stale} data-testid="secrets-stale-pill" onclick={() => (secretPills = { ...secretPills, stale: !secretPills.stale })}>Not rotated in 90 d</button>
          {#if !secretPillsAreDefault(secretPills)}
            <button type="button" class="clear-pills" data-testid="secrets-clear-filters" onclick={() => (secretPills = { ...DEFAULT_SECRET_PILLS })}><RailIcon name="x" />Clear</button>
          {/if}
        </span>
        <span class="grow"></span>
        <input class="search" placeholder="Search by name" bind:value={query} />
        <RailButton icon="copy" type="button" data-testid="secrets-exec" onclick={() => secretCurrent && copyExec(secretCurrent.name)}>
          {copied || "hq secrets exec…"}
        </RailButton>
        <RailButton icon="plus" variant="primary" type="button" data-testid="new-secret" onclick={() => (sheet = "new-secret")}>New secret</RailButton>
      </header>
      <div class="split secrets">
        <div class="list" data-testid="personal-secrets-list">
          <div class="head secret-grid"><span>Name</span><span>Scope</span><span>Mode</span><span>Last rotated</span><span>Bound apps</span></div>
          {#if secretsError && secretsState === "ready"}
            <p class="meta" data-testid="personal-secrets-stale">
              Showing saved rows. {secretsError}
              <RailButton icon="refresh" size="compact" type="button" onclick={() => void refresh(true)}>Retry</RailButton>
            </p>
          {/if}
          {#if secretsState === "loading"}
            <div aria-busy="true">
              <ReadLoader testid="personal-secrets-loader" onretry={() => void refresh(true)} />
            </div>
          {:else if secretsState === "error"}
            <div class="state" role="alert" data-testid="personal-secrets-error">
              <p>{secretsError}</p>
              <RailButton icon="refresh" type="button" data-testid="personal-secrets-retry" onclick={() => void refresh(true)}>Retry</RailButton>
            </div>
          {:else if data.secrets.length === 0}
            <p class="state" data-testid="personal-secrets-empty">
              No personal secrets yet. Add one with New secret or <span class="mono">hq secrets set --personal</span>.
            </p>
          {:else if secretRows.length === 0}
            <ListEmptyState
              total={data.secrets.length}
              shown={0}
              query={query}
              filtered={!secretPillsAreDefault(secretPills)}
              noun={["secret", "secrets"]}
              testid="personal-secrets-no-matches"
              onclear={() => {
                query = "";
                secretPills = { ...DEFAULT_SECRET_PILLS };
              }}
            />
          {/if}
          {#each secretPage.rows as row (row.id)}
            <button class="srow secret-grid" type="button" aria-current={row.id === secretCurrent?.id} onclick={() => (selectedSecret = row.id)}>
              <span class="name-cell">
                <span class="nm mono" title={row.name}>{row.name}</span>
                <span class="meta">{row.version}{row.host ? ` · ${row.host}` : ""}</span>
              </span>
              <span>Personal</span>
              <span>{row.kind === "proxy" ? "Proxy-only" : "Standard"}</span>
              <span>{row.rotated}</span>
              <span>{row.apps}</span>
            </button>
          {/each}
          {#if secretPage.remaining > 0}
            <ShowMoreRow shown={secretPage.rows.length} total={secretPage.total} next={secretPage.next} noun="secrets" testid="personal-secrets-show-more" onmore={() => (secretPages += 1)} />
          {/if}
          <p class="foot">Personal secrets live in your vault and never cross into a company.</p>
        </div>
        <aside class="inspector" data-testid="secret-inspector">
          {#if secretCurrent && shareView}
            <p class="detail-eyebrow">{secretCurrent.kind === "proxy" ? "Proxy secret" : "Standard secret"} · personal</p>
            <h2 class="detail-title">{shareView.name}</h2>
            <p class="detail-path">secrets/personal/{shareView.name}</p>
            <DetailActions
              primary={{ label: "Rotate", icon: "refresh", testid: "rotate-secret", onselect: () => (sheet = "rotate") }}
              secondary={[
                { label: "Bind to app", icon: "link", testid: "bind-secret", onselect: () => (sheet = "bind") },
                { label: "Share read", icon: "user-plus", testid: "share-secret", onselect: () => (sheet = "share-secret") },
              ]}
            />
            <DetailFacts
              testid="secret-facts"
              facts={[
                { label: "Mode", value: secretCurrent.kind === "proxy" ? "Proxy-only" : "Standard · injected as env" },
                { label: "Version", value: secretCurrent.version, mono: true },
                { label: "Last rotated", value: secretCurrent.rotated },
                { label: "Created", value: secretCurrent.created },
                { label: "Used by", value: secretCurrent.usedBy },
              ]}
            />
            <p class="detail-section-label">Who can read</p>
            <ul class="detail-list" data-testid="secret-readers">
              {#each secretCurrent.readers.split(" · ").filter(Boolean) as reader (reader)}<li>{reader}</li>{/each}
            </ul>
          {/if}
        </aside>
      </div>
    {:else if !useFixtures}
      <header class="toolbar">
        <h1>Connections</h1>
        <!-- OWNER-R36: the count sits beside the title; it waits for a read that succeeded. -->
        {#if integrationsState === "ready"}<span class="count" data-testid="personal-integrations-count">{countLabel("Connections", integrations.length)}</span>{/if}
        <span class="sub">Apps connected to you, usable across your sessions, never owned by a company</span>
        <span class="grow"></span>
        <RailButton icon="external" variant="primary" type="button" data-testid="connections-open-console" onclick={openConsoleIntegrations}>Open console</RailButton>
      </header>
      <div class="split">
        <div class="list" data-testid="personal-integrations-list">
          {#if integrationsError && integrationsState === "ready"}
            <p class="meta" data-testid="personal-integrations-stale">
              Showing saved rows. {integrationsError}
              <RailButton icon="refresh" size="compact" type="button" onclick={() => void refreshIntegrations()}>Retry</RailButton>
            </p>
          {/if}
          {#if integrationsState === "loading"}
            <div aria-busy="true">
              <ReadLoader testid="personal-integrations-loader" onretry={() => void refreshIntegrations()} />
            </div>
          {:else if integrationsState === "error"}
            <div class="state" role="alert" data-testid="personal-integrations-error">
              <p>{integrationsError}</p>
              <RailButton icon="refresh" type="button" data-testid="personal-integrations-retry" onclick={() => void refreshIntegrations()}>Retry</RailButton>
            </div>
          {:else if integrations.length === 0}
            <div class="state empty" data-testid="personal-integrations-empty">
              <p>No personal connections yet · <a class="console-link" href={PERSONAL_INTEGRATIONS_URL} data-testid="console-link-empty" onclick={(e) => { e.preventDefault(); openConsoleIntegrations(); }}>Manage in the web console</a></p>
            </div>
          {:else}
            <div class="head irow"><span>App</span><span>Account</span><span>Status</span><span>Connected</span></div>
            {#each integrations as row (row.id)}
              <button class="srow irow" type="button" data-testid={`integration-row-${row.id}`} aria-current={row.id === integrationCurrent?.id} onclick={() => (selectedIntegration = row.id)}>
                <span class="nm">{row.app}</span>
                <span>{row.identity}</span>
                <span class="status"><span class="dot" data-status={row.status === "active" ? "connected" : "reconnect"}></span>{row.status === "active" ? "Active" : "Reconnect"}</span>
                <span>{connectedLabel(row.connectedAt).replace("Connected ", "")}</span>
              </button>
            {/each}
          {/if}
          {#if activeCompany}
            <button class="srow company-link" type="button" data-testid="company-connections-link" onclick={() => openCompanyConsoleIntegrations(activeCompany)}>
              <span>Company connections</span><span class="meta"
                ><CompanyLabel name={activeCompany.label} companyUid={activeCompany.uid} /> Integrations</span
              >
            </button>
          {/if}
        </div>
        <aside class="inspector" data-testid="integration-inspector">
          {#if integrationCurrent}
            <p class="detail-eyebrow"><span class="dot" data-status={integrationCurrent.status === "active" ? "connected" : "reconnect"}></span>{integrationCurrent.status === "active" ? "Active" : "Reconnect needed"}</p>
            <h2 class="detail-title">{integrationCurrent.app}</h2>
            <p class="meta">{integrationCurrent.identity}</p>
            {#if connectedLabel(integrationCurrent.connectedAt)}<p class="meta">{connectedLabel(integrationCurrent.connectedAt)}</p>{/if}
            {@const sources = sourceNames(integrationCurrent.sources)}
            {#if sources.length > 0}
              <p class="detail-section-label">Connected sources</p>
              <ul class="sources" data-testid="integration-sources">
                {#each sources as source (source)}
                  {@const icon = sourceIconUrl(source)}
                  <li data-testid={`integration-source-${source.toLowerCase()}`}>
                    {#if icon}<img class="src-icon" src={icon} alt="" width="16" height="16" />{:else}<span class="src-icon src-fallback"><RailIcon name="circle-dot" size={16} /></span>{/if}
                    <span class="src-name">{source}</span>
                  </li>
                {/each}
              </ul>
            {/if}
          {/if}
        </aside>
      </div>
    {:else}
      <header class="toolbar">
        <h1>Connections</h1>
        <span class="sub">{connectionTab === "agents" ? "Agents & MCP · your bots and servers, acting as you" : "Apps you personally use · yours across every company"}</span>
        <span class="status"><span class="dot" data-status="connected"></span>{connectedCount} connected</span>
        {#if attentionCount > 0}<span class="status"><span class="dot" data-status="reconnect"></span>{attentionCount} needs attention</span>{/if}
        <Dropdown
          pill
          active={connectionTab !== "connected"}
          testid="connections-view-pill"
          label="Show"
          value={connectionTab}
          onchange={(v) => (connectionTab = v as typeof connectionTab)}
          options={[
            { value: "connected", label: "Connected", detail: connectedCount.toLocaleString() },
            { value: "available", label: "Available" },
            { value: "agents", label: "Agents & MCP" },
            { value: "attention", label: "Needs attention", detail: attentionCount.toLocaleString() },
          ]}
        />
        <span class="grow"></span>
        <RailButton icon="plus" variant="primary" type="button" data-testid="add-connection" onclick={() => (sheet = "connect")}>Add connection</RailButton>
      </header>
      <div class="split">
        <div class="list" data-testid="connections-list">
          {#if connectionTab === "agents"}
            <div class="head agents"><span>Connection</span><span>MCP server</span><span>Tools</span><span>Bot policy</span></div>
            {#each connectionPage.rows as row (row.id)}
              <div class="agent" data-off={row.status === "available" ? "true" : undefined}>
                <div class="srow agent-row" role="button" tabindex="0" aria-current={row.id === connectionCurrent?.id} onclick={() => (selectedConnection = row.id)} onkeydown={(event) => { if (event.key === "Enter") selectedConnection = row.id; }}>
                  <span class="cell"><span class="mark">{row.mark}</span><span class="nm">{row.name}</span><span class="meta">{row.detail}</span></span>
                  <span><span class="mono">{row.mcpServer}</span> <span class="meta">{row.mcpNote}</span></span>
                  <span>{row.tools}</span>
                  <span class="seg" data-testid={`policy-${row.id}`}>
                    {#each BOT_POLICIES as policy (policy)}
                      <button
                        class="tab"
                        type="button"
                        aria-pressed={row.policy === policy}
                        onclick={(event) => { event.stopPropagation(); setPolicy(row.id, policy); }}
                      >{BOT_POLICY_LABEL[policy]}</button>
                    {/each}
                  </span>
                </div>
                {#each row.bots as bot (bot.id)}
                  <p class="bot">{bot.name} · {bot.detail} · {BOT_POLICY_LABEL[bot.policy]}</p>
                {/each}
              </div>
            {/each}
            {#if connectionPage.remaining > 0}
              <ShowMoreRow shown={connectionPage.rows.length} total={connectionPage.total} next={connectionPage.next} noun="connections" testid="connections-show-more" onmore={() => (connectionPages += 1)} />
            {/if}
            <p class="foot">Personal connections act as you. Policy here overrides the company default for your bots.</p>
          {:else}
            <div class="head"><span>App</span><span>Status</span><span>Scopes</span><span>Last used</span><span></span></div>
            {#each connectionPage.rows as row (row.id)}
              <div class="srow" role="button" tabindex="0" data-testid={`connection-row-${row.id}`} aria-current={row.id === connectionCurrent?.id} data-off={row.status === "available" ? "true" : undefined} onclick={() => (selectedConnection = row.id)} onkeydown={(event) => { if (event.key === "Enter") selectedConnection = row.id; }}>
                <span class="cell"><span class="mark">{row.mark}</span><span class="nm">{row.name}</span><span class="meta">{row.detail}</span></span>
                <span class="status"><span class="dot" data-status={row.status}></span>{row.status === "connected" ? "Connected" : row.status === "reconnect" ? "Reconnect" : "Not connected"}</span>
                <span class="cell">{row.scopes}</span>
                <span>{row.lastUsed}</span>
                <button
                  class="link"
                  type="button"
                  data-testid={`row-action-${row.id}`}
                  onclick={(event) => {
                    event.stopPropagation();
                    selectedConnection = row.id;
                    if (row.status === "connected") sheet = "confirm-disconnect";
                    else openConnect(row.name);
                  }}
                ><RailIcon name="x" />{row.status === "available" ? "Connect" : row.status === "reconnect" ? "Reconnect" : "Disconnect"}</button>
              </div>
            {/each}
            {#if connectionPage.remaining > 0}
              <ShowMoreRow shown={connectionPage.rows.length} total={connectionPage.total} next={connectionPage.next} noun="connections" testid="connections-show-more" onmore={() => (connectionPages += 1)} />
            {/if}
            <p class="foot">Personal connections act as you. Company-level apps stay inside each company pane.</p>
          {/if}
        </div>
        <aside class="inspector" data-testid="connection-inspector">
          {#if connectionCurrent}
            <p class="detail-eyebrow">{connectionTab === "agents" ? "Personal MCP server" : "Personal connection"} · <span class="dot" data-status={connectionCurrent.status}></span>{connectionCurrent.status === "connected" ? "Connected" : connectionCurrent.status === "reconnect" ? "Reconnect" : "Not connected"}</p>
            <h2 class="detail-title">{connectionCurrent.name}</h2>
            <p class="meta">{connectionCurrent.account}</p>
            <DetailActions
              secondary={[
                { label: connectionCurrent.status === "available" ? "Connect" : "Reconnect", icon: "plug", testid: "reconnect", onselect: () => openConnect(connectionCurrent.name) },
                { label: "Disconnect", icon: "x", testid: "disconnect", onselect: () => (sheet = "confirm-disconnect") },
              ]}
            />
            <DetailFacts
              testid="connection-facts"
              facts={[
                { label: "Scopes", value: connectionCurrent.scopes },
                { label: "Last used", value: connectionCurrent.lastUsed },
                { label: "Secret", value: connectionCurrent.secretName, mono: true },
                { label: "MCP", value: connectionCurrent.mcpServer, mono: true },
              ]}
            />
            <p class="detail-section-label">When bots act</p>
            <div class="seg" data-testid="detail-policy">
              {#each BOT_POLICIES as policy (policy)}
                <button class="tab" type="button" aria-pressed={connectionCurrent.policy === policy} onclick={() => setPolicy(connectionCurrent.id, policy)}>
                  {BOT_POLICY_LABEL[policy]}
                </button>
              {/each}
            </div>
            {#each connectionCurrent.bots as bot (bot.id)}
              <p class="bot">{bot.name} · {bot.detail} · {BOT_POLICY_LABEL[bot.policy]}</p>
            {/each}
          {/if}
        </aside>
      </div>
    {/if}
  </div>

  {#if sheet}
    <div class="sheet" role="dialog" data-testid={`sheet-${sheet}`} use:dismissable={{ onclose: () => (sheet = null), outside: true }}>
      {#if sheet === "new-secret" || sheet === "rotate"}
        <h2>{sheet === "rotate" ? `Rotate ${shareView?.name ?? "secret"}` : "New secret"}</h2>
        <input
          class="secret"
          type="password"
          autocomplete="off"
          data-testid="secret-field"
          placeholder="Paste only"
          bind:value={secretDraft}
          onbeforeinput={onSecretBeforeInput}
        />
        <p class="meta">Pasted once, stored encrypted. Not displayed or downloadable after save.</p>
      {:else if sheet === "share-secret"}
        <h2>Share read</h2>
        <p class="mono">{shareView?.name}</p>
        {#each ACCESS_LEVELS as level (level)}
          <button class="tab" type="button" aria-pressed={grantLevel === level} onclick={() => (grantLevel = clampAccess(level))}>{level}</button>
        {/each}
        <p class="meta" data-testid="share-no-value">No secret value is included.</p>
      {:else if sheet === "bind"}
        <h2>Bind to app</h2>
        <p class="mono">{secretCurrent?.name}</p>
        <p class="meta">The binding stores the name, not the value.</p>
      {:else if sheet === "connect"}
        <h2>Add connection</h2>
        <RailButton icon="external" variant="primary" type="button" data-testid="connect-open" onclick={() => openConnect(query || "Notion")}>Open in browser</RailButton>
      {:else if sheet === "connect-waiting" && connect}
        <h2 data-testid="connect-waiting">Waiting for {connect.app}</h2>
        <p>Finish sign-in in the browser. This sheet stays until the deep link returns.</p>
        <RailButton icon="check" type="button" data-testid="connect-return" onclick={simulateReturn}>Deep link returned</RailButton>
      {:else if sheet === "confirm-disconnect"}
        <h2>Disconnect {connectionCurrent?.name}?</h2>
        <p class="meta">Bots lose this connection on their next run.</p>
        <RailButton icon="x" variant="danger" type="button" data-testid="confirm-disconnect" onclick={() => connectionCurrent && disconnect(connectionCurrent.id)}>Disconnect</RailButton>
      {/if}
      <RailButton icon="x" type="button" onclick={() => (sheet = null)}>Close</RailButton>
    </div>
  {/if}
</section>

<style>
  /* Hit area (AUDIT-2-10..13): every control here has at least a 28x28 px
     clickable box. The ::after pad grows only the axes under 28 px, so the
     drawn size and layout stay as they are. Kept first so a later
     position rule (e.g. absolute) still wins. */
  .srow, .tab, .link, .console-link, .toggle-pill, .clear-pills { position: relative; }
  .toggle-pill::after,
  .clear-pills::after,
  .srow::after,
  .tab::after,
  .link::after,
  .console-link::after {
    content: "";
    position: absolute;
    inset: min(0px, calc(50% - 14px));
  }
  /* Console-rail page chrome measured from Messages (docs/design-standard-console-rail.md):
     one 20px/500 title, 13px everywhere else, 31px rows, status as dot plus text,
     background-only selection, mono only for secret names, paths and MCP ids. */
  .page { display: grid; grid-template-columns: minmax(0, 1fr); height: 100%; min-height: 0; color: var(--t1, var(--v4-text-1)); background: var(--v4-ground); position: relative; font: 400 13px/1.45 var(--font-ui, "Geist", -apple-system, sans-serif); }
  button { font: inherit; font-size: 13px; }
  h1 { font-size: var(--type-title, 20px); font-weight: var(--type-title-weight, 500); line-height: var(--type-title-line, 1.25); margin: 0 4px 0 0; }
  .srow:hover, .link:hover { background: var(--hover, var(--v4-hover)); }
  .seg .tab[aria-pressed="true"], .srow[aria-current="true"] { background: var(--sel, var(--v4-active-row)); color: var(--t1, var(--v4-text-1)); box-shadow: none; }
  .main { display: flex; flex-direction: column; min-width: 0; min-height: 0; container-type: inline-size; }
  /* QA-099: the header wraps at narrow widths instead of pushing the primary
     button past the right edge; the search box is the part that gives. */
  .toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-height: 52px; flex: none; box-sizing: border-box; padding: 10px 20px; border-bottom: 1px solid var(--line, var(--v4-rowline)); }
  .toolbar .search { flex: 0 1 180px; min-width: 96px; }
  .toolbar :global([data-rail-btn]) { flex: none; }
  .grow { flex: 1; }
  /* OWNER-R36: header filter pills, the Deployments pattern (69a00b720). */
  .pills { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .toggle-pill, .clear-pills { min-height: 28px; padding: 0 12px; border: 1px solid var(--v4-hairline, var(--line)); border-radius: 999px; background: transparent; color: var(--t1, var(--v4-text-1)); font: inherit; cursor: pointer; }
  .toggle-pill.sel { background: var(--sel, var(--v4-active-row)); border-color: transparent; }
  .clear-pills { border-color: transparent; color: var(--t2, var(--v4-text-2)); }
  .sub, .meta, .kind, .foot, .count { color: var(--t3, var(--v4-text-3)); font-size: 13px; }
  .meta, .kind, .foot { margin: 8px 0; }
  .label { color: var(--t2, var(--v4-text-2)); font-size: 13px; font-weight: 500; margin: 0; padding: 12px 8px 4px; }
  .label { padding: 16px 0 6px; }
  .count { font-variant-numeric: tabular-nums; }
  .status { display: inline-flex; align-items: center; gap: 6px; color: var(--t2, var(--v4-text-2)); white-space: nowrap; }
  .dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: var(--t3, var(--v4-text-3)); flex: none; margin-right: 6px; }
  .status .dot { margin-right: 0; }
  .dot[data-status="connected"] { background: var(--ok, var(--v4-ok)); }
  .dot[data-status="reconnect"] { background: var(--red, var(--v4-error)); }
  .search, .secret { height: 28px; box-sizing: border-box; border-radius: 6px; border: 1px solid var(--line2, var(--v4-control-border)); background: var(--btn-bg, var(--v4-control-faint)); color: var(--t1, var(--v4-text-1)); padding: 0 8px; font: inherit; font-size: 13px; }
  .link { height: 26px; border: 0; border-radius: 6px; padding: 0 8px; background: transparent; color: var(--t2, var(--v4-text-2)); cursor: pointer; justify-self: end; white-space: nowrap; }
  .split { display: grid; grid-template-columns: minmax(0, 1fr) clamp(240px, 32%, 320px); min-height: 0; flex: 1; }
  .list, .inspector { min-height: 0; overflow: auto; }
  .list { padding: 8px 12px; container-type: inline-size; }
  .inspector { border-left: 1px solid var(--line, var(--v4-rowline)); background: var(--v4-secondary-sidebar); padding: 24px 20px; }
  .head, .srow { display: grid; grid-template-columns: minmax(0, 1.4fr) 110px 100px 90px minmax(0, 1fr); gap: 8px; align-items: center; padding: 0 8px; }
  /* QA-099: Name always keeps a usable share and Scope is a fixed narrow
     column, so names ellipsize instead of collapsing under Scope. */
  .secret-grid { grid-template-columns: minmax(120px, 1.4fr) 72px 92px 84px minmax(0, 1fr); }
  .name-cell { display: flex; align-items: baseline; min-width: 0; }
  .name-cell .nm { display: block; flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .name-cell .meta { flex: 0 1000 auto; min-width: 0; white-space: nowrap; }
  @container (max-width: 560px) {
    .secret-grid { grid-template-columns: minmax(0, 1fr) 72px 92px; }
    .secret-grid > :nth-child(n + 4), .name-cell .meta { display: none; }
  }
  @container (max-width: 640px) {
    .split { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1fr) auto; }
    .inspector { border-left: 0; border-top: 1px solid var(--line, var(--v4-rowline)); max-height: 40%; }
  }
  .head.agents, .agent-row { grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr) 48px auto; }
  .head { height: 31px; color: var(--t3, var(--v4-text-3)); }
  .srow { width: 100%; height: 31px; box-sizing: border-box; text-align: left; border: 0; background: transparent; color: var(--t2, var(--v4-text-2)); border-radius: 8px; cursor: pointer; }
  .srow > span, .cell { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cell { display: flex; align-items: center; gap: 8px; }
  .srow[data-off="true"] { color: var(--t3, var(--v4-text-3)); }
  .nm { color: var(--t1, var(--v4-text-1)); margin-right: 8px; }
  .srow .meta { margin: 0; overflow: hidden; text-overflow: ellipsis; }
  .mono { font-family: var(--font-mono, "Geist Mono", ui-monospace, monospace); }
  .mark { display: inline-grid; place-items: center; width: 16px; height: 16px; border-radius: 4px; background: var(--btn-bg, var(--v4-control-faint)); color: var(--t2, var(--v4-text-2)); font-size: 10px; flex: none; }
  .kv { display: grid; grid-template-columns: 100px minmax(0, 1fr); gap: 6px 10px; margin: 16px 0; }
  .kv dt { color: var(--t3, var(--v4-text-3)); margin: 0; }
  .kv dd { margin: 0; color: var(--t1, var(--v4-text-1)); overflow-wrap: anywhere; }
  .act { display: flex; gap: 6px; flex-wrap: wrap; margin: 12px 0; }
  .seg { display: inline-flex; gap: 2px; padding: 2px; width: max-content; border: 1px solid var(--panel-border, var(--v4-control-border)); border-radius: 6px; background: var(--hover, var(--v4-hover)); justify-self: end; }
  .tab { border: 0; border-radius: 4px; padding: 4px 8px; background: transparent; color: var(--t2, var(--v4-text-2)); cursor: pointer; }
  .tab:hover { color: var(--t1, var(--v4-text-1)); }
  .sheet .tab[aria-pressed="true"] { background: var(--sel, var(--v4-active-row)); color: var(--t1, var(--v4-text-1)); }
  .bot { margin: 0; padding: 4px 8px 4px 32px; min-height: 28px; box-sizing: border-box; color: var(--t2, var(--v4-text-2)); }
  .inspector .bot { padding-left: 0; }
  h2 { font-size: 13px; font-weight: 500; margin: 0 0 2px; color: var(--t1, var(--v4-text-1)); }
  .kind { margin: 0 0 8px; display: flex; align-items: center; }
  .sheet { position: absolute; right: 16px; bottom: 16px; width: 320px; padding: 16px 20px; border: 1px solid var(--panel-border, var(--v4-rowline)); border-radius: 8px; background: var(--overlay-bg, var(--panel-bg, var(--v4-raised, var(--v4-ground)))); box-shadow: var(--panel-shadow, none); display: flex; flex-direction: column; gap: 8px; }
  .irow { grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.4fr) 110px 110px; }
  .company-link { display: flex; gap: 8px; margin-top: 12px; }
  .sources { list-style: none; margin: 4px 0 0; padding: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: 12px; color: var(--t1, var(--v4-text-1)); }
  .sources li { display: flex; align-items: center; gap: 8px; height: 28px; min-width: 0; border-bottom: 1px solid var(--v4-rowline, var(--panel-border)); }
  .src-icon { width: 16px; height: 16px; flex: none; display: inline-grid; place-items: center; }
  .src-fallback { color: var(--t3, var(--v4-text-3)); }
  .src-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 400; }
  .state.empty { text-align: center; padding: 48px 16px; color: var(--t3, var(--v4-text-3)); }
  .state { padding: 16px 8px; color: var(--t2, var(--v4-text-2)); }
  .state p { margin: 0 0 8px; }
  .state :global([data-rail-btn]) { margin: 0 8px 8px 0; }
</style>
