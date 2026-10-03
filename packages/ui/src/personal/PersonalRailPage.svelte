<script lang="ts">
  import RailButton from "../common/button/RailButton.svelte";
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
    filterPersonalSecrets,
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
    disconnectPersonalIntegration,
    loadPersonalIntegrations,
    readIntegrationsCache,
    writeIntegrationsCache,
    IntegrationsLoadError,
    type PersonalIntegration,
    type PersonalIntegrationsApi,
  } from "./personal-integrations.js";

  interface Props {
    page: "secrets" | "connections";
    /** Perf harness and design scenes only. The running app never sets this. */
    fixtures?: boolean;
    /** Companies the owner belongs to, for the per-company Integrations links. */
    companies?: { uid: string; label: string }[];
    /** The selected company, when one is; its Integrations page is linked at the bottom. */
    activeCompany?: { uid: string; label: string } | null;
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
  // "loading" paints the skeleton; it only shows when nothing is cached yet.
  let secretsState = $state<"loading" | "ready" | "error">(
    useFixtures || cachedAtOpen ? "ready" : "loading",
  );
  let secretsError = $state("");
  let query = $state("");
  let secretTab = $state<"all" | "standard" | "proxy" | "stale">("all");
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
  let disconnecting = $state(false);
  let disconnectError = $state("");

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

  async function confirmDisconnect(row: PersonalIntegration): Promise<void> {
    if (disconnecting) return;
    disconnecting = true;
    disconnectError = "";
    const error = await disconnectPersonalIntegration(integrationsApi, row);
    disconnecting = false;
    if (error) {
      disconnectError = error;
      return;
    }
    integrations = integrations.filter((item) => item.id !== row.id);
    writeIntegrationsCache(integrations);
    sheet = null;
  }

  const secretRows = $derived(filterPersonalSecrets(data.secrets, secretTab, query));
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
    void secretTab;
    void connectionTab;
    secretPages = connectionPages = 1;
  });
  const secretPage = $derived(pageRows(secretRows, secretPages));
  const connectionPage = $derived(pageRows(connectionRows, connectionPages));
  const secretCurrent = $derived(
    data.secrets.find((row) => row.id === selectedSecret) ?? secretRows[0] ?? data.secrets[0],
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
  <aside class="pane" aria-label={page === "secrets" ? "Secrets" : "Connections"}>
    {#if page === "secrets"}
      <button class="nav" type="button" aria-current={secretTab === "all"} onclick={() => (secretTab = "all")}>All <span>{data.secrets.length}</span></button>
      <button class="nav" type="button" aria-current={secretTab === "standard"} onclick={() => (secretTab = "standard")}>Standard</button>
      <button class="nav" type="button" aria-current={secretTab === "proxy"} onclick={() => (secretTab = "proxy")}>Proxy-only</button>
      <p class="sec">Scopes</p>
      <button class="nav" type="button" aria-current="true" data-testid="scope-personal">Personal <span>{data.secrets.length}</span></button>
      <p class="sec">Needs attention</p>
      <button class="nav" type="button" aria-current={secretTab === "stale"} onclick={() => (secretTab = "stale")}>Not rotated in 90 d</button>
    {:else if !useFixtures}
      <button class="nav" type="button" aria-current="true" data-testid="connections-personal-nav">Personal <span>{integrations.length}</span></button>
    {:else}
      <button class="nav" type="button" aria-current={connectionTab === "connected"} onclick={() => (connectionTab = "connected")}>Connected <span>{connectedCount}</span></button>
      <button class="nav" type="button" aria-current={connectionTab === "available"} onclick={() => (connectionTab = "available")}>Available</button>
      <button class="nav" type="button" aria-current={connectionTab === "agents"} data-testid="agents-mcp" onclick={() => (connectionTab = "agents")}>Agents & MCP</button>
      <button class="nav" type="button" aria-current={connectionTab === "attention"} onclick={() => (connectionTab = "attention")}>Needs attention <span>{attentionCount}</span></button>
    {/if}
  </aside>

  <div class="main">
    {#if page === "secrets"}
      <header class="toolbar">
        <h1>Secrets</h1>
        <span class="count" data-testid="personal-secrets-count">{countLabel("Secrets", secretRows.length)}</span>
        <span class="sub">Values never shown</span>
        <span class="grow"></span>
        <input class="search" placeholder="Search by name" bind:value={query} />
        <RailButton icon="copy" type="button" data-testid="secrets-exec" onclick={() => secretCurrent && copyExec(secretCurrent.name)}>
          {copied || "hq secrets exec…"}
        </RailButton>
        <RailButton icon="plus" variant="primary" type="button" data-testid="new-secret" onclick={() => (sheet = "new-secret")}>New secret</RailButton>
      </header>
      <div class="split secrets">
        <div class="list" data-testid="personal-secrets-list">
          <div class="head"><span>Name</span><span>Scope</span><span>Mode</span><span>Last rotated</span><span>Bound apps</span></div>
          {#if secretsError && secretsState === "ready"}
            <p class="meta" data-testid="personal-secrets-stale">
              Showing saved rows. {secretsError}
              <RailButton icon="refresh" size="compact" type="button" onclick={() => void refresh(true)}>Retry</RailButton>
            </p>
          {/if}
          <p class="sec">Personal</p>
          {#if secretsState === "loading"}
            <div data-testid="personal-secrets-skeleton" aria-busy="true">
              {#each [0, 1, 2, 3] as i (i)}<div class="skel"></div>{/each}
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
          {/if}
          {#each secretPage.rows as row (row.id)}
            <button class="srow" type="button" aria-current={row.id === secretCurrent?.id} onclick={() => (selectedSecret = row.id)}>
              <span>
                <span class="nm mono">{row.name}</span>
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
            <p class="kind">Standard secret · personal</p>
            <h2>{shareView.name}</h2>
            <p class="meta mono">secrets/personal/{shareView.name}</p>
            <dl class="kv">
              <dt>Mode</dt><dd>{secretCurrent.kind === "proxy" ? "Proxy-only" : "Standard · injected as env"}</dd>
              <dt>Version</dt><dd class="mono">{secretCurrent.version}</dd>
              <dt>Last rotated</dt><dd>{secretCurrent.rotated}</dd>
              <dt>Created</dt><dd>{secretCurrent.created}</dd>
              <dt>Used by</dt><dd>{secretCurrent.usedBy}</dd>
            </dl>
            <div class="act">
              <RailButton icon="refresh" variant="primary" type="button" data-testid="rotate-secret" onclick={() => (sheet = "rotate")}>Rotate</RailButton>
              <RailButton icon="link" type="button" data-testid="bind-secret" onclick={() => (sheet = "bind")}>Bind to app</RailButton>
              <RailButton icon="user-plus" type="button" data-testid="share-secret" onclick={() => (sheet = "share-secret")}>Share read</RailButton>
            </div>
            <p class="meta">Who can read · {secretCurrent.readers}</p>
          {/if}
        </aside>
      </div>
    {:else if !useFixtures}
      <header class="toolbar">
        <h1>Connections</h1>
        <span class="sub">Apps connected to you, usable across your sessions, never owned by a company</span>
        <span class="grow"></span>
        <RailButton icon="plus" variant="primary" type="button" data-testid="add-integration" onclick={openConsoleIntegrations}>Add integration</RailButton>
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
            <div data-testid="personal-integrations-skeleton" aria-busy="true">
              {#each [0, 1, 2] as i (i)}<div class="skel"></div>{/each}
            </div>
          {:else if integrationsState === "error"}
            <div class="state" role="alert" data-testid="personal-integrations-error">
              <p>{integrationsError}</p>
              <RailButton icon="refresh" type="button" data-testid="personal-integrations-retry" onclick={() => void refreshIntegrations()}>Retry</RailButton>
            </div>
          {:else if integrations.length === 0}
            <div class="state empty" data-testid="personal-integrations-empty">
              <p>No personal connections yet</p>
              <RailButton icon="plus" type="button" onclick={openConsoleIntegrations}>Add integration</RailButton>
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
            <button class="srow company-link" type="button" data-testid="company-connections-link" onclick={() => onopenintegrations?.(activeCompany.uid)}>
              <span>Company connections</span><span class="meta">{activeCompany.label} Integrations</span>
            </button>
          {/if}
        </div>
        <aside class="inspector" data-testid="integration-inspector">
          {#if integrationCurrent}
            <p class="kind"><span class="dot" data-status={integrationCurrent.status === "active" ? "connected" : "reconnect"}></span>{integrationCurrent.status === "active" ? "Active" : "Reconnect needed"}</p>
            <h2>{integrationCurrent.app}</h2>
            <p class="meta">{integrationCurrent.identity}</p>
            {#if connectedLabel(integrationCurrent.connectedAt)}<p class="meta">{connectedLabel(integrationCurrent.connectedAt)}</p>{/if}
            {#if integrationCurrent.sources.length > 0}
              <p class="label">Connected sources</p>
              <ul class="sources" data-testid="integration-sources">
                {#each integrationCurrent.sources as source (source)}<li>{source}</li>{/each}
              </ul>
            {/if}
            <div class="act">
              <RailButton icon="external" type="button" data-testid="integration-manage" onclick={openConsoleIntegrations}>Manage</RailButton>
              <RailButton icon="x" type="button" data-testid="integration-disconnect" onclick={() => { disconnectError = ""; sheet = "confirm-integration-disconnect"; }}>Disconnect</RailButton>
            </div>
          {/if}
        </aside>
      </div>
    {:else}
      <header class="toolbar">
        <h1>Connections</h1>
        <span class="sub">{connectionTab === "agents" ? "Agents & MCP · your bots and servers, acting as you" : "Apps you personally use · yours across every company"}</span>
        <span class="status"><span class="dot" data-status="connected"></span>{connectedCount} connected</span>
        {#if attentionCount > 0}<span class="status"><span class="dot" data-status="reconnect"></span>{attentionCount} needs attention</span>{/if}
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
                >{row.status === "available" ? "Connect" : row.status === "reconnect" ? "Reconnect" : "Disconnect"}</button>
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
            <p class="kind">{connectionTab === "agents" ? "Personal MCP server" : "Personal connection"} · <span class="dot" data-status={connectionCurrent.status}></span>{connectionCurrent.status === "connected" ? "Connected" : connectionCurrent.status === "reconnect" ? "Reconnect" : "Not connected"}</p>
            <h2>{connectionCurrent.name}</h2>
            <p class="meta">{connectionCurrent.account}</p>
            <div class="act">
              <RailButton icon="plug" type="button" data-testid="reconnect" onclick={() => openConnect(connectionCurrent.name)}>
                {connectionCurrent.status === "available" ? "Connect" : "Reconnect"}
              </RailButton>
              <RailButton icon="x" type="button" data-testid="disconnect" onclick={() => (sheet = "confirm-disconnect")}>Disconnect</RailButton>
            </div>
            <dl class="kv">
              <dt>Scopes</dt><dd>{connectionCurrent.scopes}</dd>
              <dt>Last used</dt><dd>{connectionCurrent.lastUsed || "—"}</dd>
              {#if connectionCurrent.secretName}
                <dt>Secret</dt><dd class="mono">{connectionCurrent.secretName}</dd>
              {/if}
              <dt>MCP</dt><dd class="mono">{connectionCurrent.mcpServer}</dd>
            </dl>
            <p class="label">When bots act</p>
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
      {:else if sheet === "confirm-integration-disconnect" && integrationCurrent}
        <h2>Disconnect {integrationCurrent.app}?</h2>
        <p class="meta">{integrationCurrent.identity}. HQ stops reading this account until you connect it again.</p>
        {#if disconnectError}<p class="meta" role="alert" data-testid="integration-disconnect-error">{disconnectError}</p>{/if}
        <RailButton icon="x" variant="danger" type="button" data-testid="confirm-integration-disconnect" disabled={disconnecting} onclick={() => void confirmDisconnect(integrationCurrent)}>{disconnecting ? "Disconnecting…" : "Disconnect"}</RailButton>
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
  /* Console-rail page chrome measured from Messages (docs/design-standard-console-rail.md):
     one 20px/500 title, 13px everywhere else, 31px rows, status as dot plus text,
     background-only selection, mono only for secret names, paths and MCP ids. */
  .page { display: grid; grid-template-columns: 260px minmax(0, 1fr); height: 100%; min-height: 0; color: var(--t1, var(--v4-text-1)); background: var(--v4-ground); position: relative; font: 400 13px/1.45 var(--font-ui, "Geist", -apple-system, sans-serif); }
  button { font: inherit; font-size: 13px; }
  .pane { border-right: 1px solid var(--line, var(--v4-rowline)); padding: 12px 14px; overflow: auto; background: var(--v4-secondary-sidebar); display: flex; flex-direction: column; gap: 1px; }
  h1 { font-size: var(--type-title, 20px); font-weight: var(--type-title-weight, 500); line-height: var(--type-title-line, 1.25); margin: 0 4px 0 0; }
  .nav { display: flex; justify-content: space-between; align-items: center; width: 100%; height: 31px; box-sizing: border-box; padding: 7px 8px; border: 0; border-radius: 8px; background: transparent; color: var(--t2, var(--v4-text-2)); text-align: left; cursor: pointer; }
  .nav span { color: var(--t3, var(--v4-text-3)); font-variant-numeric: tabular-nums; }
  .nav:hover, .srow:hover, .link:hover { background: var(--hover, var(--v4-hover)); }
  .nav[aria-current="true"], .seg .tab[aria-pressed="true"], .srow[aria-current="true"] { background: var(--sel, var(--v4-active-row)); color: var(--t1, var(--v4-text-1)); box-shadow: none; }
  .main { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
  .toolbar { display: flex; align-items: center; gap: 8px; height: 52px; flex: none; box-sizing: border-box; padding: 0 20px; border-bottom: 1px solid var(--line, var(--v4-rowline)); }
  .grow { flex: 1; }
  .sub, .meta, .kind, .foot, .count { color: var(--t3, var(--v4-text-3)); font-size: 13px; }
  .meta, .kind, .foot { margin: 8px 0; }
  .sec, .label { color: var(--t2, var(--v4-text-2)); font-size: 13px; font-weight: 500; margin: 0; padding: 12px 8px 4px; }
  .label { padding: 16px 0 6px; }
  .count { font-variant-numeric: tabular-nums; }
  .status { display: inline-flex; align-items: center; gap: 6px; color: var(--t2, var(--v4-text-2)); white-space: nowrap; }
  .dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: var(--t3, var(--v4-text-3)); flex: none; margin-right: 6px; }
  .status .dot { margin-right: 0; }
  .dot[data-status="connected"] { background: var(--ok, var(--v4-ok)); }
  .dot[data-status="reconnect"] { background: var(--red, var(--v4-error)); }
  .search, .secret { height: 28px; box-sizing: border-box; border-radius: 6px; border: 1px solid var(--line2, var(--v4-control-border)); background: var(--btn-bg, var(--v4-control-faint)); color: var(--t1, var(--v4-text-1)); padding: 0 8px; font: inherit; font-size: 13px; }
  .link { height: 26px; border: 0; border-radius: 6px; padding: 0 8px; background: transparent; color: var(--t2, var(--v4-text-2)); cursor: pointer; justify-self: end; white-space: nowrap; }
  .split { display: grid; grid-template-columns: minmax(0, 1fr) 320px; min-height: 0; flex: 1; }
  .list, .inspector { min-height: 0; overflow: auto; }
  .list { padding: 8px 12px; }
  .inspector { border-left: 1px solid var(--line, var(--v4-rowline)); background: var(--v4-secondary-sidebar); padding: 24px 20px; }
  .head, .srow { display: grid; grid-template-columns: minmax(0, 1.4fr) 110px 100px 90px minmax(0, 1fr); gap: 8px; align-items: center; padding: 0 8px; }
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
  .sheet { position: absolute; right: 16px; bottom: 16px; width: 320px; padding: 16px 20px; border: 1px solid var(--panel-border, var(--v4-rowline)); border-radius: 8px; background: var(--panel-bg, var(--v4-raised, var(--v4-ground))); box-shadow: var(--panel-shadow, none); display: flex; flex-direction: column; gap: 8px; }
  .irow { grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.4fr) 110px 110px; }
  .company-link { display: flex; gap: 8px; margin-top: 12px; }
  .sources { list-style: none; margin: 0; padding: 0; color: var(--t2, var(--v4-text-2)); }
  .sources li { height: 28px; line-height: 28px; }
  .state.empty { text-align: center; padding: 48px 16px; color: var(--t3, var(--v4-text-3)); }
  .state { padding: 16px 8px; color: var(--t2, var(--v4-text-2)); }
  .state p { margin: 0 0 8px; }
  .state :global([data-rail-btn]) { margin: 0 8px 8px 0; }
  .skel { height: 31px; margin: 0 0 2px; border-radius: 8px; background: linear-gradient(90deg, var(--btn-bg, var(--v4-control-faint)), var(--hover, var(--v4-hover)), var(--btn-bg, var(--v4-control-faint))); background-size: 200% 100%; animation: personal-row-skel 1.1s linear infinite; }
  @keyframes personal-row-skel { from { background-position: 100% 0; } to { background-position: -100% 0; } }
</style>
