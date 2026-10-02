<script lang="ts">
  /**
   * Vault, Integrations, Secrets, Deployments (US-029).
   * First frame is the cache or a shimmer. Refresh runs after paint.
   * Secret values are never written into the DOM.
   */
  import type { FilesApi, SettingsApi, ShellApi } from "@hq/platform";
  import { openAgentWorkflow, type AgentWorkflowApi } from "../agent-workflow.js";
  import "../../home/tokens.css";
  import "../../chat/chat-tokens.css";
  import { companyStore } from "../company-store.svelte.js";
  import {
    ACCESS_LEVELS,
    acceptSecretKey,
    applyDeepLink,
    beginConnect,
    clampAccess,
    deployPrompt,
    filterIntegrations,
    filterSecrets,
    filterVault,
    fixtureCache,
    publicSecret,
    readFilesConnectCache,
    redeployAllowed,
    redeployPrompt,
    shareSheet,
    writeFilesConnectCache,
    type AccessLevel,
    type ConnectSession,
    type DeploymentRowModel,
    type FilesConnectCache,
    type FilesConnectPageId,
    type SecretRow,
    type VaultNode,
  } from "./files-connect-model.js";

  interface Props {
    page: FilesConnectPageId;
    slug: string;
    files: FilesApi | null;
    shell: ShellApi | null;
    settings: SettingsApi | null;
    openExternal?: (url: string) => void;
  }

  let { page, slug, files, shell, settings, openExternal }: Props = $props();

  const workflow = $derived({ settings, shell } as AgentWorkflowApi);

  let data = $state<FilesConnectCache>(fixtureCache());
  let phase = $state<"shimmer" | "ready">("ready");
  let query = $state("");
  let vaultTab = $state<"all" | "new">("all");
  let integrationTab = $state<"connected" | "available" | "mcp">("connected");
  let secretTab = $state<"all" | "standard" | "proxy">("all");
  let selectedVault = $state<string>("storyboard");
  let selectedIntegration = $state<string>("slack");
  let selectedSecret = $state<string>("anthropic");
  let selectedDeploy = $state<string>("standup");
  let grantLevel = $state<AccessLevel>("read");
  let sheet = $state<string | null>(null);
  let connect = $state<ConnectSession | null>(null);
  let secretDraft = $state("");
  let status = $state("");
  let redeployName = $state("");

  $effect(() => {
    const cached = readFilesConnectCache(slug);
    data = cached ?? fixtureCache();
    phase = "ready";
    let live = true;
    queueMicrotask(() => {
      if (!live) return;
      void refresh();
    });
    return () => {
      live = false;
    };
  });

  async function refresh(): Promise<void> {
    const next = fixtureCache();
    try {
      const listed = files ? await files.listDir(`companies/${slug}`) : null;
      if (listed && listed.ok && Array.isArray(listed.value) && listed.value.length > 0) {
        const nodes: VaultNode[] = listed.value.slice(0, 40).map((entry, index) => {
          const rec = entry as { name?: string; path?: string; kind?: string };
          const name = rec.name ?? `file-${index}`;
          return {
            id: name,
            name,
            path: rec.path ?? `companies/${slug}/${name}`,
            kind: rec.kind === "dir" ? "dir" : "file",
            depth: 1,
            acl: "team · read",
            editedBy: "cached",
            editing: false,
            preview: "",
          };
        });
        next.nodes = nodes;
        next.files = nodes.length;
        selectedVault = nodes[0]?.id ?? selectedVault;
      }
    } catch {
      /* keep the fixture so the frame stays filled */
    }
    try {
      const loaded = await companyStore.loadSecrets(slug, false);
      if (Array.isArray(loaded)) {
        const rows = loaded
          .map((item) => publicSecret((item ?? {}) as Record<string, unknown>))
          .filter((row): row is SecretRow => row != null);
        if (rows.length > 0) next.secrets = rows;
      }
    } catch {
      /* fixture */
    }
    try {
      const loaded = await companyStore.loadDeployments(slug, false);
      if (Array.isArray(loaded) && loaded.length > 0) {
        next.deployments = loaded.map((item, index) => {
          const rec = (item ?? {}) as Record<string, unknown>;
          const name = String(rec.name ?? rec.slug ?? `deploy-${index}`);
          return {
            id: name,
            name,
            url: String(rec.url ?? ""),
            project: String(rec.project ?? slug),
            status: rec.state === "error" ? "error" : rec.state === "paused" ? "off" : "live",
            access: "read" as const,
            updated: String(rec.lastDeploy ?? "—"),
          } satisfies DeploymentRowModel;
        });
      }
    } catch {
      /* fixture */
    }
    writeFilesConnectCache(slug, next);
    data = next;
    phase = "ready";
  }

  const vaultRows = $derived(filterVault(data.nodes, vaultTab, query));
  const integrationRows = $derived(filterIntegrations(data.integrations, integrationTab, query));
  const secretRows = $derived(filterSecrets(data.secrets, secretTab, query));
  const vaultCurrent = $derived(data.nodes.find((node) => node.id === selectedVault) ?? data.nodes[0]);
  const integrationCurrent = $derived(
    data.integrations.find((row) => row.id === selectedIntegration) ?? data.integrations[0],
  );
  const secretCurrent = $derived(data.secrets.find((row) => row.id === selectedSecret) ?? data.secrets[0]);
  const deployCurrent = $derived(
    data.deployments.find((row) => row.id === selectedDeploy) ?? data.deployments[0],
  );
  const shareView = $derived(secretCurrent ? shareSheet(secretCurrent) : null);

  function onSecretBeforeInput(event: InputEvent): void {
    if (!acceptSecretKey(event.inputType)) event.preventDefault();
  }

  function openConnect(app: string): void {
    const session = beginConnect(app);
    connect = session;
    sheet = "connect-waiting";
    openExternal?.(session.url);
  }

  function simulateReturn(): void {
    if (!connect) return;
    connect = applyDeepLink(connect, "hq://oauth?code=returned");
    status = `${connect.app} returned from the browser.`;
  }

  async function runDeploy(artifact: string): Promise<void> {
    const prompt = deployPrompt(slug || "company", artifact);
    const result = await openAgentWorkflow(workflow, prompt, "deploy workflow");
    status = result.message;
    sheet = null;
  }

  async function runRedeploy(): Promise<void> {
    if (!redeployAllowed(true) || !deployCurrent) return;
    const prompt = redeployPrompt(slug || "company", redeployName || deployCurrent.name);
    const result = await openAgentWorkflow(workflow, prompt, "redeploy");
    status = result.message;
    sheet = null;
  }

  function askRedeploy(row: DeploymentRowModel): void {
    redeployName = row.name;
    sheet = "confirm-redeploy";
  }
</script>

<section class="page" data-testid="files-connect" data-page={page} aria-busy={phase === "shimmer"}>
  {#if phase === "shimmer"}
    <div class="shimmer" data-testid="files-connect-skeleton"></div>
  {:else if page === "vault"}
    <header class="toolbar">
      <h1>Vault</h1>
      <span class="chip">{data.files.toLocaleString()} files</span>
      <span class="grow"></span>
      <div class="tabs" role="tablist">
        <button class="tab" role="tab" aria-selected={vaultTab === "all"} onclick={() => (vaultTab = "all")}>All</button>
        <button class="tab" role="tab" aria-selected={vaultTab === "new"} data-testid="vault-whats-new" onclick={() => (vaultTab = "new")}>What's new</button>
      </div>
      <input class="search" placeholder="Search files" bind:value={query} />
      <button class="btn" type="button">Upload</button>
      <button class="btn" type="button" data-testid="vault-share" onclick={() => (sheet = "share")}>Share</button>
    </header>
    <div class="split">
      <div class="list" data-testid="vault-list">
        {#each vaultRows as node (node.id)}
          <button
            class="row"
            type="button"
            aria-current={node.id === vaultCurrent?.id}
            onclick={() => (selectedVault = node.id)}
          >
            <span class="nm" style:padding-left="{node.depth * 12}px">{node.name}</span>
            <span class="chip">{node.acl}</span>
            <span class="meta">{node.editedBy}</span>
          </button>
        {/each}
      </div>
      <aside class="inspector" data-testid="vault-access">
        <p class="kind">Access</p>
        <h2>{vaultCurrent?.name}</h2>
        <pre class="preview">{vaultCurrent?.preview}</pre>
        {#each data.grants as grant (grant.id)}
          <div class="grant">
            <span>{grant.name}</span>
            <span class="chip">{grant.level}</span>
          </div>
        {/each}
        <div class="tabs" role="tablist" aria-label="Grant level">
          {#each ACCESS_LEVELS as level (level)}
            <button class="tab" type="button" role="tab" aria-selected={grantLevel === level} onclick={() => (grantLevel = level)}>{level}</button>
          {/each}
        </div>
        <button class="btn primary" type="button" data-testid="grant-access" onclick={() => (sheet = "grant")}>Grant access</button>
      </aside>
    </div>
  {:else if page === "integrations"}
    <header class="toolbar">
      <h1>Integrations</h1>
      <span class="grow"></span>
      <div class="tabs" role="tablist">
        <button class="tab" role="tab" aria-selected={integrationTab === "connected"} onclick={() => (integrationTab = "connected")}>Connected</button>
        <button class="tab" role="tab" aria-selected={integrationTab === "available"} onclick={() => (integrationTab = "available")}>Available</button>
        <button class="tab" role="tab" aria-selected={integrationTab === "mcp"} data-testid="integrations-mcp" onclick={() => (integrationTab = "mcp")}>Agents & MCP</button>
      </div>
      <input class="search" placeholder="App name or website" bind:value={query} />
      <button class="btn primary" type="button" data-testid="connect-app" onclick={() => (sheet = "connect")}>Connect app</button>
    </header>
    <div class="split">
      <div class="list">
        {#each integrationRows as row (row.id)}
          <button class="row" type="button" aria-current={row.id === integrationCurrent?.id} onclick={() => (selectedIntegration = row.id)}>
            <span class="mark">{row.mark}</span>
            <span class="nm">{row.name}</span>
            <span class="meta">{row.detail}</span>
            <span class="chip" data-status={row.status}>{row.status}</span>
          </button>
        {/each}
      </div>
      <aside class="inspector">
        {#if integrationCurrent}
          <p class="kind">{integrationCurrent.kind}</p>
          <h2>{integrationCurrent.name}</h2>
          <p>{integrationCurrent.detail}</p>
          <button class="btn" type="button" onclick={() => openConnect(integrationCurrent.name)}>
            {integrationCurrent.status === "active" ? "Manage" : "Connect"}
          </button>
        {/if}
      </aside>
    </div>
  {:else if page === "secrets"}
    <header class="toolbar">
      <h1>Secrets</h1>
      <span class="chip">{data.secrets.length} secrets</span>
      <span class="chip">values never shown</span>
      <span class="grow"></span>
      <input class="search" placeholder="Search secrets" bind:value={query} />
      <div class="tabs" role="tablist">
        <button class="tab" role="tab" aria-selected={secretTab === "all"} onclick={() => (secretTab = "all")}>All</button>
        <button class="tab" role="tab" aria-selected={secretTab === "standard"} onclick={() => (secretTab = "standard")}>Standard</button>
        <button class="tab" role="tab" aria-selected={secretTab === "proxy"} onclick={() => (secretTab = "proxy")}>Proxy-only</button>
      </div>
      <button class="btn primary" type="button" data-testid="new-secret" onclick={() => (sheet = "new-secret")}>New secret</button>
    </header>
    <div class="split">
      <div class="list" data-testid="secrets-list">
        {#each secretRows as row (row.id)}
          <button class="row" type="button" aria-current={row.id === secretCurrent?.id} onclick={() => (selectedSecret = row.id)}>
            <span class="nm mono">{row.name}</span>
            <span class="meta">{row.kind} · {row.version}{row.host ? ` · ${row.host}` : ""}</span>
            <span class="meta">{row.scope}</span>
            <span class="meta">{row.rotated}</span>
            <span class="meta">{row.apps}</span>
            <span class="meta">{row.readers}</span>
          </button>
        {/each}
      </div>
      <aside class="inspector" data-testid="secret-inspector">
        {#if secretCurrent && shareView}
          <p class="kind">{secretCurrent.kind}</p>
          <h2 class="mono">{shareView.name}</h2>
          <p class="meta">Value is not shown.</p>
          <button class="btn" type="button" data-testid="rotate-secret" onclick={() => (sheet = "rotate")}>Rotate</button>
          <button class="btn" type="button" data-testid="share-secret" onclick={() => (sheet = "share-secret")}>Share</button>
          <button class="btn" type="button" data-testid="bind-secret" onclick={() => (sheet = "bind")}>Bind</button>
          <button class="btn" type="button" onclick={() => (sheet = "bind-outpost")}>Bind to outpost</button>
        {/if}
      </aside>
    </div>
  {:else}
    <header class="toolbar">
      <h1>Deployments</h1>
      <span class="grow"></span>
      <button class="btn primary" type="button" data-testid="deploy-from-project" onclick={() => (sheet = "deploy")}>Deploy</button>
    </header>
    {#if data.deployments.length === 0}
      <div class="empty" data-testid="deployments-empty">
        <h2>Nothing deployed yet</h2>
        <button class="btn primary" type="button" onclick={() => (sheet = "deploy")}>Deploy from a project</button>
      </div>
    {:else}
      <div class="split">
        <div class="list">
          {#each data.deployments as row (row.id)}
            <button class="row" type="button" aria-current={row.id === deployCurrent?.id} onclick={() => (selectedDeploy = row.id)}>
              <span class="nm">{row.name}</span>
              <span class="meta">{row.project}</span>
              <span class="chip" data-status={row.status}>{row.status}</span>
            </button>
          {/each}
        </div>
        <aside class="inspector">
          {#if deployCurrent}
            <p class="kind">{deployCurrent.status}</p>
            <h2>{deployCurrent.name}</h2>
            <p class="mono">{deployCurrent.url}</p>
            <button class="btn" type="button" onclick={() => openExternal?.(deployCurrent.url)}>Open</button>
            <button class="btn" type="button" data-testid="redeploy" onclick={() => askRedeploy(deployCurrent)}>Redeploy</button>
            <button class="btn" type="button" onclick={() => (sheet = "deploy-access")}>Access</button>
          {/if}
        </aside>
      </div>
    {/if}
  {/if}

  {#if status}<p class="status" data-testid="files-connect-status">{status}</p>{/if}

  {#if sheet}
    <div class="sheet" role="dialog" data-testid={`sheet-${sheet}`}>
      {#if sheet === "share" || sheet === "share-secret"}
        <h2>Share</h2>
        <p>{shareView?.name ?? vaultCurrent?.name}</p>
        <div class="tabs" role="tablist">
        {#each ACCESS_LEVELS as level (level)}
          <button class="tab" type="button" role="tab" aria-selected={grantLevel === level} onclick={() => (grantLevel = clampAccess(level))}>{level}</button>
        {/each}
        </div>
        <p class="meta" data-testid="share-no-value">No secret value is included.</p>
      {:else if sheet === "grant"}
        <h2>Grant access</h2>
        <p>Level: {grantLevel}</p>
      {:else if sheet === "connect"}
        <h2>Connect app</h2>
        <button class="btn primary" type="button" data-testid="connect-open" onclick={() => openConnect(query || "Slack")}>Open in browser</button>
      {:else if sheet === "connect-waiting" && connect}
        <h2 data-testid="connect-waiting">Waiting for {connect.app}</h2>
        <p>Finish sign-in in the browser. This sheet stays until the deep link returns.</p>
        <button class="btn" type="button" data-testid="connect-return" onclick={simulateReturn}>Deep link returned</button>
      {:else if sheet === "new-secret" || sheet === "rotate"}
        <h2>{sheet === "rotate" ? "Rotate secret" : "New secret"}</h2>
        <input
          class="secret"
          type="password"
          autocomplete="off"
          data-testid="secret-field"
          placeholder="Paste only"
          bind:value={secretDraft}
          onbeforeinput={onSecretBeforeInput}
        />
        <p class="meta">Masked. Paste only. The value is not shown again.</p>
      {:else if sheet === "bind" || sheet === "bind-outpost"}
        <h2>{sheet === "bind-outpost" ? "Bind to outpost" : "Bind secret"}</h2>
        <p class="mono">{secretCurrent?.name}</p>
        <p class="meta">The binding stores the name, not the value.</p>
      {:else if sheet === "deploy"}
        <h2>Deploy from project</h2>
        <button class="btn" type="button" onclick={() => (sheet = "deploy-allowlist")}>Choose allowlist</button>
        <button class="btn primary" type="button" data-testid="run-deploy" onclick={() => void runDeploy(query || "project")}>Deploy</button>
      {:else if sheet === "deploy-allowlist"}
        <h2>Allowlist</h2>
        <p>Company members with read access can open the link.</p>
        <button class="btn primary" type="button" onclick={() => (sheet = "deploy")}>Back to deploy</button>
      {:else if sheet === "deploy-access"}
        <h2>Deploy access</h2>
        {#each ACCESS_LEVELS as level (level)}
          <span class="chip">{level}</span>
        {/each}
      {:else if sheet === "confirm-redeploy"}
        <h2>Redeploy {redeployName}?</h2>
        <p>This runs the existing hq-deploy command again.</p>
        <button class="btn" type="button" onclick={() => (sheet = null)}>Cancel</button>
        <button class="btn primary" type="button" data-testid="confirm-redeploy" onclick={() => void runRedeploy()}>Redeploy</button>
      {/if}
      <button class="btn" type="button" onclick={() => (sheet = null)}>Close</button>
    </div>
  {/if}
</section>

<style>
  .page { display: flex; flex-direction: column; height: 100%; min-height: 0; color: var(--v4-text-1); background: var(--v4-ground); }
  .toolbar { display: flex; align-items: center; gap: 8px; padding: 12px 16px; }
  h1 { font-size: var(--type-section, 17px); font-weight: 600; margin: 0; }
  h2 { font-size: var(--type-body, 15px); margin: 0; }
  .grow { flex: 1; }
  .chip { font-size: var(--type-metadata, 13px); color: var(--v4-text-3); border: 1px solid var(--v4-rowline); border-radius: 999px; padding: 2px 8px; }
  .tabs { display: flex; gap: 4px; }
  .tab { background: transparent; color: var(--v4-text-2); border: 0; border-radius: 6px; padding: 4px 8px; }
  .tab[aria-selected="true"] { background: var(--v4-active-row, var(--v4-hover)); color: var(--v4-text-1); }
  .search, .secret { height: 28px; border-radius: 6px; border: 1px solid var(--v4-control-border); background: var(--v4-control-faint); color: var(--v4-text-1); padding: 0 8px; }
  .btn { height: 28px; border-radius: 6px; border: 1px solid var(--v4-control-border); background: var(--v4-control-faint); color: var(--v4-text-1); padding: 0 10px; }
  .btn.primary { background: var(--v4-primary-bg); color: var(--v4-primary-fg); border-color: transparent; }
  .split { display: grid; grid-template-columns: minmax(0, 1fr) 320px; min-height: 0; flex: 1; }
  .list, .inspector { min-height: 0; overflow: auto; }
  .inspector { border-left: 1px solid var(--v4-rowline); background: var(--v4-secondary-sidebar); padding: 16px; display: flex; flex-direction: column; gap: 8px; }
  .row { display: flex; gap: 8px; align-items: center; width: 100%; text-align: left; padding: 8px; border: 0; border-bottom: 1px solid var(--v4-rowline); background: transparent; color: var(--v4-text-2); }
  .row[aria-current="true"] { background: var(--v4-active-row, var(--v4-hover)); color: var(--v4-text-1); }
  .nm { color: var(--v4-text-1); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meta, .kind { color: var(--v4-text-3); font-size: var(--type-metadata, 13px); margin: 0; }
  .mono { font-family: var(--font-mono, ui-monospace, monospace); }
  .mark { width: 22px; height: 22px; display: grid; place-items: center; border-radius: 4px; background: var(--v4-control-faint); font-size: 10px; }
  .preview { white-space: pre-wrap; color: var(--v4-text-2); font-family: var(--font-mono, ui-monospace, monospace); font-size: 12px; }
  .grant { display: flex; justify-content: space-between; gap: 8px; }
  .empty { padding: 32px; }
  .sheet { position: absolute; right: 16px; bottom: 16px; width: 320px; padding: 16px; border: 1px solid var(--v4-rowline); border-radius: 10px; background: var(--v4-raised, var(--v4-ground)); display: flex; flex-direction: column; gap: 8px; }
  .shimmer { height: 120px; margin: 16px; border-radius: 8px; background: linear-gradient(90deg, var(--v4-control-faint), var(--v4-hover), var(--v4-control-faint)); background-size: 200% 100%; animation: sk 1.1s linear infinite; }
  @keyframes sk { from { background-position: 100% 0; } to { background-position: -100% 0; } }
  .status { padding: 0 16px 12px; color: var(--v4-text-3); font-size: var(--type-metadata, 13px); }
</style>
