<script lang="ts">
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
    fixturePersonalRail,
    personalSecretsErrorReason,
    personalSecretsFromSource,
    readPersonalRailCache,
    writePersonalRailCache,
    type BotPolicy,
    type PersonalRailCache,
  } from "./personal-rail-model.js";

  interface Props {
    page: "secrets" | "connections";
    /** Perf harness and design scenes only. The running app never sets this. */
    fixtures?: boolean;
  }

  let { page, fixtures = false }: Props = $props();

  // Fixture mode is fixed for the life of the page.
  const useFixtures = untrack(() => fixtures);
  const cachedAtOpen = useFixtures ? null : readPersonalRailCache("personal");
  let data = $state<PersonalRailCache>(
    useFixtures
      ? fixturePersonalRail()
      : cachedAtOpen ?? { secrets: [], connections: fixturePersonalRail().connections },
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
    <div class="pane-head">{page === "secrets" ? "Secrets" : "Connections"}</div>
    {#if page === "secrets"}
      <button class="nav" type="button" aria-current={secretTab === "all"} onclick={() => (secretTab = "all")}>All <span>{data.secrets.length}</span></button>
      <button class="nav" type="button" aria-current={secretTab === "standard"} onclick={() => (secretTab = "standard")}>Standard</button>
      <button class="nav" type="button" aria-current={secretTab === "proxy"} onclick={() => (secretTab = "proxy")}>Proxy-only</button>
      <p class="sec">Scopes</p>
      <button class="nav" type="button" aria-current="true" data-testid="scope-personal">Personal <span>{data.secrets.length}</span></button>
      <p class="sec">Needs attention</p>
      <button class="nav" type="button" aria-current={secretTab === "stale"} onclick={() => (secretTab = "stale")}>Not rotated in 90 d</button>
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
        <span class="chip" data-testid="personal-secrets-count">{countLabel("Secrets", secretRows.length)}</span>
        <span class="chip">values never shown</span>
        <span class="grow"></span>
        <input class="search" placeholder="Search by name" bind:value={query} />
        <button class="btn" type="button" data-testid="secrets-exec" onclick={() => secretCurrent && copyExec(secretCurrent.name)}>
          {copied || "hq secrets exec…"}
        </button>
        <button class="btn primary" type="button" data-testid="new-secret" onclick={() => (sheet = "new-secret")}>New secret</button>
      </header>
      <div class="split secrets">
        <div class="list" data-testid="personal-secrets-list">
          <div class="head"><span>Name</span><span>Scope</span><span>Mode</span><span>Last rotated</span><span>Bound apps</span></div>
          {#if secretsError && secretsState === "ready"}
            <p class="meta" data-testid="personal-secrets-stale">
              Showing saved rows. {secretsError}
              <button class="btn tiny-btn" type="button" onclick={() => void refresh(true)}>Retry</button>
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
              <button class="btn" type="button" data-testid="personal-secrets-retry" onclick={() => void refresh(true)}>Retry</button>
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
              <span class="mono">{row.rotated}</span>
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
            <h2 class="mono">{shareView.name}</h2>
            <p class="meta mono">secrets/personal/{shareView.name}</p>
            <dl class="kv">
              <dt>Mode</dt><dd>{secretCurrent.kind === "proxy" ? "Proxy-only" : "Standard · injected as env"}</dd>
              <dt>Version</dt><dd class="mono">{secretCurrent.version}</dd>
              <dt>Last rotated</dt><dd>{secretCurrent.rotated}</dd>
              <dt>Created</dt><dd>{secretCurrent.created}</dd>
              <dt>Used by</dt><dd>{secretCurrent.usedBy}</dd>
            </dl>
            <div class="act">
              <button class="btn primary" type="button" data-testid="rotate-secret" onclick={() => (sheet = "rotate")}>Rotate</button>
              <button class="btn" type="button" data-testid="bind-secret" onclick={() => (sheet = "bind")}>Bind to app</button>
              <button class="btn" type="button" data-testid="share-secret" onclick={() => (sheet = "share-secret")}>Share read</button>
            </div>
            <p class="meta">Who can read · {secretCurrent.readers}</p>
          {/if}
        </aside>
      </div>
    {:else}
      <header class="toolbar">
        <h1>Connections</h1>
        <span class="sub">{connectionTab === "agents" ? "Agents & MCP · your bots and servers, acting as you" : "Apps you personally use · yours across every company"}</span>
        <span class="chip live">{connectedCount} connected</span>
        {#if attentionCount > 0}<span class="chip err">{attentionCount} needs attention</span>{/if}
        <span class="grow"></span>
        <button class="btn primary" type="button" data-testid="add-connection" onclick={() => (sheet = "connect")}>Add connection</button>
      </header>
      <div class="split">
        <div class="list" data-testid="connections-list">
          {#if connectionTab === "agents"}
            <div class="head agents"><span>Connection</span><span>MCP server</span><span>Tools</span><span>Bot policy</span></div>
            {#each connectionPage.rows as row (row.id)}
              <div class="agent" data-off={row.status === "available" ? "true" : undefined}>
                <div class="srow agent-row" role="button" tabindex="0" aria-current={row.id === connectionCurrent?.id} onclick={() => (selectedConnection = row.id)} onkeydown={(event) => { if (event.key === "Enter") selectedConnection = row.id; }}>
                  <span><span class="mark">{row.mark}</span> <span class="nm">{row.name}</span><span class="meta">{row.detail}</span></span>
                  <span class="mono">{row.mcpServer}<span class="meta">{row.mcpNote}</span></span>
                  <span>{row.tools}</span>
                  <span class="pol" data-testid={`policy-${row.id}`}>
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
              <button class="srow" type="button" aria-current={row.id === connectionCurrent?.id} data-off={row.status === "available" ? "true" : undefined} onclick={() => (selectedConnection = row.id)}>
                <span><span class="mark">{row.mark}</span> <span class="nm">{row.name}</span><span class="meta">{row.detail}</span></span>
                <span class="chip" data-status={row.status}>{row.status === "connected" ? "Connected" : row.status === "reconnect" ? "Reconnect" : "Not connected"}</span>
                <span>{row.scopes}</span>
                <span class="mono">{row.lastUsed}</span>
                <span class="btn tiny" role="presentation">{row.status === "available" ? "Connect" : row.status === "reconnect" ? "Reconnect" : "Disconnect"}</span>
              </button>
            {/each}
            {#if connectionPage.remaining > 0}
              <ShowMoreRow shown={connectionPage.rows.length} total={connectionPage.total} next={connectionPage.next} noun="connections" testid="connections-show-more" onmore={() => (connectionPages += 1)} />
            {/if}
            <p class="foot">Personal connections act as you. Company-level apps stay inside each company pane.</p>
          {/if}
        </div>
        <aside class="inspector" data-testid="connection-inspector">
          {#if connectionCurrent}
            <p class="kind">{connectionTab === "agents" ? "personal mcp server" : "personal connection"} · {connectionCurrent.status}</p>
            <h2>{connectionCurrent.name}</h2>
            <p class="meta">{connectionCurrent.account}</p>
            <div class="act">
              <button class="btn" type="button" onclick={() => openConnect(connectionCurrent.name)}>
                {connectionCurrent.status === "available" ? "Connect" : "Reconnect"}
              </button>
              <button class="btn" type="button" data-testid="disconnect" onclick={() => (sheet = "confirm-disconnect")}>Disconnect</button>
            </div>
            <dl class="kv">
              <dt>Scopes</dt><dd class="mono">{connectionCurrent.scopes}</dd>
              <dt>Last used</dt><dd>{connectionCurrent.lastUsed || "—"}</dd>
              {#if connectionCurrent.secretName}
                <dt>Secret</dt><dd class="mono">{connectionCurrent.secretName}</dd>
              {/if}
              <dt>MCP</dt><dd class="mono">{connectionCurrent.mcpServer}</dd>
            </dl>
            <p class="kind">When bots act</p>
            <div class="pol" data-testid="detail-policy">
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
        <button class="btn primary" type="button" data-testid="connect-open" onclick={() => openConnect(query || "Notion")}>Open in browser</button>
      {:else if sheet === "connect-waiting" && connect}
        <h2 data-testid="connect-waiting">Waiting for {connect.app}</h2>
        <p>Finish sign-in in the browser. This sheet stays until the deep link returns.</p>
        <button class="btn" type="button" data-testid="connect-return" onclick={simulateReturn}>Deep link returned</button>
      {:else if sheet === "confirm-disconnect"}
        <h2>Disconnect {connectionCurrent?.name}?</h2>
        <p class="meta">Bots lose this connection on their next run.</p>
      {/if}
      <button class="btn" type="button" onclick={() => (sheet = null)}>Close</button>
    </div>
  {/if}
</section>

<style>
  .page { display: grid; grid-template-columns: 260px minmax(0, 1fr); height: 100%; min-height: 0; color: var(--v4-text-1); background: var(--v4-ground); position: relative; }
  .pane { border-right: 1px solid var(--v4-rowline); padding: 12px; overflow: auto; background: var(--v4-secondary-sidebar); }
  .pane-head, h1 { font-size: var(--type-section, 17px); font-weight: 600; margin: 0; }
  .nav, .tab, .btn { background: transparent; color: var(--v4-text-2); border: 0; border-radius: 6px; padding: 6px 8px; text-align: left; }
  .nav { display: flex; justify-content: space-between; width: 100%; }
  .nav[aria-current="true"], .tab[aria-pressed="true"], .srow[aria-current="true"] { background: var(--v4-active-row, var(--v4-hover)); color: var(--v4-text-1); }
  .main { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
  .toolbar { display: flex; align-items: center; gap: 8px; padding: 12px 16px; }
  .grow { flex: 1; }
  .sub, .meta, .kind, .foot, .sec { color: var(--v4-text-3); font-size: var(--type-metadata, 13px); margin: 8px 0; }
  .chip { font-size: var(--type-metadata, 13px); color: var(--v4-text-3); border: 1px solid var(--v4-rowline); border-radius: 999px; padding: 2px 8px; }
  .chip.err, .chip[data-status="reconnect"] { color: var(--v4-error); }
  .chip.live, .chip[data-status="connected"] { color: var(--v4-ok); }
  .search, .secret { height: 28px; border-radius: 6px; border: 1px solid var(--v4-control-border); background: var(--v4-control-faint); color: var(--v4-text-1); padding: 0 8px; }
  .btn { border: 1px solid var(--v4-control-border); background: var(--v4-control-faint); height: 28px; }
  .btn.primary { background: var(--v4-primary-bg); color: var(--v4-primary-fg); border-color: transparent; }
  .split { display: grid; grid-template-columns: minmax(0, 1fr) 320px; min-height: 0; flex: 1; }
  .list, .inspector { min-height: 0; overflow: auto; }
  .inspector { border-left: 1px solid var(--v4-rowline); background: var(--v4-secondary-sidebar); padding: 16px; }
  .head, .srow { display: grid; grid-template-columns: minmax(0, 1.4fr) 90px 100px 90px minmax(0, 1fr); gap: 8px; align-items: center; padding: 8px; }
  .head.agents, .agent-row { grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr) 64px 186px; }
  .head { font-family: var(--font-mono, ui-monospace, monospace); font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--v4-text-3); }
  .srow { width: 100%; text-align: left; border: 0; border-bottom: 1px solid var(--v4-rowline); background: transparent; color: var(--v4-text-2); border-radius: 6px; }
  .srow:hover { background: var(--v4-hover); }
  .srow[data-off="true"] { color: var(--v4-text-3); }
  .nm { color: var(--v4-text-1); }
  .mono { font-family: var(--font-mono, ui-monospace, monospace); }
  .mark { display: inline-grid; place-items: center; width: 18px; height: 18px; border-radius: 4px; background: var(--v4-control-faint); font-size: 9px; }
  .kv { display: grid; grid-template-columns: 100px minmax(0, 1fr); gap: 4px 10px; font-size: var(--type-metadata, 13px); }
  .kv dt { color: var(--v4-text-3); margin: 0; }
  .kv dd { margin: 0; }
  .act, .pol { display: flex; gap: 6px; flex-wrap: wrap; margin: 8px 0; }
  .pol { justify-content: flex-end; }
  .tab { border: 1px solid var(--v4-control-border); padding: 3px 6px; font-size: 11px; }
  .bot { margin: 2px 8px; font-size: 12px; color: var(--v4-text-2); }
  h2 { font-size: var(--type-body, 15px); margin: 4px 0; }
  .sheet { position: absolute; right: 16px; bottom: 16px; width: 320px; padding: 16px; border: 1px solid var(--v4-rowline); border-radius: 10px; background: var(--v4-raised, var(--v4-ground)); display: flex; flex-direction: column; gap: 8px; }
  .tiny { pointer-events: none; }
  .state { padding: 16px 8px; color: var(--v4-text-2); font-size: var(--type-metadata, 13px); }
  .state p { margin: 0 0 8px; }
  .tiny-btn { height: 22px; padding: 0 8px; margin-left: 6px; }
  .skel { height: 36px; margin: 8px; border-radius: 6px; background: linear-gradient(90deg, var(--v4-control-faint), var(--v4-hover), var(--v4-control-faint)); background-size: 200% 100%; animation: personal-row-skel 1.1s linear infinite; }
  @keyframes personal-row-skel { from { background-position: 100% 0; } to { background-position: -100% 0; } }
</style>
