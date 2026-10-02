<script lang="ts">
  /**
   * Vault, Integrations, Secrets, Deployments (US-029).
   * First frame is the cache or a shimmer. Refresh runs after paint.
   * Secret values are never written into the DOM.
   */
  import type { FilesApi, PlatformAdapter, SettingsApi, ShellApi } from "@hq/platform";
  import CompanyFileTree from "../../files/CompanyFileTree.svelte";
  import FilePreviewPane from "../../files/FilePreviewPane.svelte";
  import type { DirEntry } from "../../files/file-tree.js";
  import { cachedChildren, folderSummary, rememberChildren } from "../../projects/project-files.js";
  import { openAgentWorkflow, type AgentWorkflowApi } from "../agent-workflow.js";
  import "../../home/tokens.css";
  import "../../chat/chat-tokens.css";
  import { companyStore } from "../company-store.svelte.js";
  import ShowMoreRow from "../../shell/ShowMoreRow.svelte";
  import { countLabel, pageRows } from "../../shell/list-paging.js";
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
    /** Full platform adapter, when the host has one: turns on the desktop
     *  Open and Reveal actions in the vault preview. */
    adapter?: PlatformAdapter | null;
  }

  let { page, slug, files, shell, settings, openExternal, adapter = null }: Props = $props();

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
        const nodes: VaultNode[] = listed.value.map((entry, index) => {
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

  // Every list shows all rows, in pages of 50 with a Show more row.
  let vaultPages = $state(1);
  let integrationPages = $state(1);
  let secretPages = $state(1);
  let deployPages = $state(1);
  $effect(() => {
    void page;
    void query;
    void vaultTab;
    void integrationTab;
    void secretTab;
    vaultPages = integrationPages = secretPages = deployPages = 1;
  });

  // Vault tree (All tab): the same lazy, cached tree as the project Files
  // tab, so a reopened folder paints from cache in the click frame.
  const vaultRoot = $derived(`companies/${slug}`);
  let vaultFile = $state<string | null>(null);
  let vaultRootSummary = $state<string | null>(null);

  function loadVaultChildren(relPath: string): Promise<DirEntry[]> {
    const api = files;
    if (!api) return Promise.resolve([]);
    const fresh = api.listDir(relPath).then((result) => {
      if (!result.ok) throw new Error(result.message ?? "Could not list files");
      const entries = result.value as unknown as DirEntry[];
      rememberChildren(relPath, entries);
      return entries;
    });
    const cached = cachedChildren(relPath);
    if (!cached) return fresh;
    void fresh.catch((err) => console.error("vault folder refresh failed:", err));
    return Promise.resolve(cached);
  }

  $effect(() => {
    const root = vaultRoot;
    vaultFile = null;
    const cached = cachedChildren(root);
    vaultRootSummary = cached ? folderSummary(cached) : null;
    if (!files) return;
    let alive = true;
    loadVaultChildren(root)
      .then((entries) => {
        if (alive) vaultRootSummary = folderSummary(entries);
      })
      .catch((err) => console.error("vault folder summary failed:", err));
    return () => {
      alive = false;
    };
  });

  /** Preview seam: the host adapter when given, else files-only (no
   *  desktop actions, so no dead buttons). */
  const previewAdapter = $derived(
    adapter ??
      ({ files, shell, isAvailable: () => false } as unknown as PlatformAdapter),
  );
  /** Top-level vault folder of the picked file, for the Access header. */
  const vaultFolder = $derived(
    vaultFile ? (vaultFile.slice(vaultRoot.length + 1).split("/")[0] ?? null) : null,
  );
  const showVaultTree = $derived(files !== null && vaultTab === "all");
  const integrationRows = $derived(filterIntegrations(data.integrations, integrationTab, query));
  const secretRows = $derived(filterSecrets(data.secrets, secretTab, query));
  const vaultPage = $derived(pageRows(vaultRows, vaultPages));
  const integrationPage = $derived(pageRows(integrationRows, integrationPages));
  const secretPage = $derived(pageRows(secretRows, secretPages));
  const deployPage = $derived(pageRows(data.deployments, deployPages));
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
    <div class="split vault-split" class:has-tree={showVaultTree}>
      {#if showVaultTree}
        <div class="vault-tree" data-testid="vault-tree">
          <div class="vault-root mono" title={vaultRoot}>{vaultRoot}</div>
          {#key vaultRoot}
            <CompanyFileTree
              rootPath={vaultRoot}
              loadChildren={loadVaultChildren}
              selectedPath={vaultFile}
              filterQuery={query}
              onselect={(path) => (vaultFile = path)}
            />
          {/key}
        </div>
      {:else}
      <div class="list" data-testid="vault-list">
        {#each vaultPage.rows as node (node.id)}
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
        {#if vaultPage.remaining > 0}
          <ShowMoreRow shown={vaultPage.rows.length} total={vaultPage.total} next={vaultPage.next} noun="files" testid="vault-show-more" onmore={() => (vaultPages += 1)} />
        {/if}
      </div>
      {/if}
      {#if showVaultTree}
        <section class="vault-preview" aria-label="File preview" data-testid="vault-preview">
          {#if vaultFile}
            <FilePreviewPane adapter={previewAdapter} path={vaultFile} />
          {:else}
            <div class="vault-empty" data-testid="vault-preview-empty">
              <span class="vault-empty-title">Select a file</span>
              <p class="mono" title={vaultRoot}>{vaultRoot}</p>
              <p data-testid="vault-summary">{vaultRootSummary ?? "Reading folder…"}</p>
            </div>
          {/if}
        </section>
      {/if}
      <aside class="inspector" data-testid="vault-access">
        <p class="kind">Access</p>
        {#if showVaultTree}
          <h2>{vaultFolder ?? slug}</h2>
        {:else}
          <h2>{vaultCurrent?.name}</h2>
          <pre class="preview">{vaultCurrent?.preview}</pre>
        {/if}
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
      <span class="chip" data-testid="integrations-count">{countLabel("Integrations", integrationRows.length)}</span>
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
        {#each integrationPage.rows as row (row.id)}
          <button class="row" type="button" aria-current={row.id === integrationCurrent?.id} onclick={() => (selectedIntegration = row.id)}>
            <span class="mark">{row.mark}</span>
            <span class="nm">{row.name}</span>
            <span class="meta">{row.detail}</span>
            <span class="chip" data-status={row.status}>{row.status}</span>
          </button>
        {/each}
        {#if integrationPage.remaining > 0}
          <ShowMoreRow shown={integrationPage.rows.length} total={integrationPage.total} next={integrationPage.next} noun="integrations" testid="integrations-show-more" onmore={() => (integrationPages += 1)} />
        {/if}
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
      <span class="chip" data-testid="secrets-count">{countLabel("Secrets", secretRows.length)}</span>
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
        {#each secretPage.rows as row (row.id)}
          <button class="row" type="button" aria-current={row.id === secretCurrent?.id} onclick={() => (selectedSecret = row.id)}>
            <span class="nm mono">{row.name}</span>
            <span class="meta">{row.kind} · {row.version}{row.host ? ` · ${row.host}` : ""}</span>
            <span class="meta">{row.scope}</span>
            <span class="meta">{row.rotated}</span>
            <span class="meta">{row.apps}</span>
            <span class="meta">{row.readers}</span>
          </button>
        {/each}
        {#if secretPage.remaining > 0}
          <ShowMoreRow shown={secretPage.rows.length} total={secretPage.total} next={secretPage.next} noun="secrets" testid="secrets-show-more" onmore={() => (secretPages += 1)} />
        {/if}
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
      <span class="chip" data-testid="deployments-count">{countLabel("Deployments", data.deployments.length)}</span>
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
        <div class="list" data-testid="deployments-list">
          {#each deployPage.rows as row (row.id)}
            <button class="row" type="button" aria-current={row.id === deployCurrent?.id} onclick={() => (selectedDeploy = row.id)}>
              <span class="nm">{row.name}</span>
              <span class="meta">{row.project}</span>
              <span class="chip" data-status={row.status}>{row.status}</span>
            </button>
          {/each}
          {#if deployPage.remaining > 0}
            <ShowMoreRow shown={deployPage.rows.length} total={deployPage.total} next={deployPage.next} noun="deployments" testid="deployments-show-more" onmore={() => (deployPages += 1)} />
          {/if}
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
  /* Vault: tree · preview · access, matching the vault storyboard scene. */
  .vault-split.has-tree { grid-template-columns: minmax(240px, 320px) minmax(0, 1fr) 280px; }
  .vault-tree { min-height: 0; overflow: auto; padding: 8px 8px 16px; border-right: 1px solid var(--v4-rowline); }
  .vault-root { padding: 4px 8px 6px; color: var(--v4-text-3); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .vault-preview { min-width: 0; min-height: 0; overflow: auto; }
  .vault-empty { padding: 24px 16px; color: var(--v4-text-3); }
  .vault-empty p { margin: 2px 0 0; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .vault-empty-title { display: block; margin-bottom: 4px; color: var(--v4-text-1); font-weight: 600; }
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
