<script lang="ts">
  import ReadLoader from "../../common/ReadLoader.svelte";
  import RailButton from "../../common/button/RailButton.svelte";
  /**
   * Vault, Integrations, Secrets, Deployments (US-029).
   * First frame is the cache or a skeleton. Refresh runs after paint.
   * Secret values are never written into the DOM or this window: creating
   * and rotating hand off to `hq secrets set`, which prompts in a terminal.
   * Styling follows the shipped Messages surfaces (chat/), not a new scale.
   */
  import type { AdapterPromise, FilesApi, Json, PlatformAdapter, SettingsApi, ShellApi } from "@hq/platform";
  import type { DeployAppsPage } from "../../library/personal-deployments.js";
  import { dismissable } from "../../common/dismissable.js";
  import ShowMoreRow from "../../shell/ShowMoreRow.svelte";
  import ListEmptyState from "../../common/ListEmptyState.svelte";
  import { publishCompanyPageCount } from "../../shell/company-page-counts.svelte.js";
  import { countLabel, pageRows } from "../../shell/list-paging.js";
  import CompanyFileTree from "../../files/CompanyFileTree.svelte";
  import FilePreviewPane from "../../files/FilePreviewPane.svelte";
  import type { DirEntry } from "../../files/file-tree.js";
  import { withCompanyReadScope } from "../../files/company-read-scope.js";
  import { cachedChildren, folderSummary, rememberChildren, resolveUploadName, type ConflictPolicy } from "../../projects/project-files.js";
  import { fileIntegrity, presignUrlFromResult, putChatAttachmentDirect } from "../../chat/messaging/upload-chat-attachments.js";
  import { openAgentWorkflow, type AgentWorkflowApi } from "../agent-workflow.js";
  import "../../home/tokens.css";
  import "../../chat/chat-tokens.css";
  import { companyStore } from "../company-store.svelte.js";
  import DeployAccessForm from "./DeployAccessForm.svelte";
  import type { DeployAccessRequest } from "./deploy-access.js";
  import {
    ACCESS_LEVELS,
    applyDeepLink,
    beginConnect,
    clampAccess,
    companyDeploymentRows,
    deployPrompt,
    deploymentRowsFromSource,
    findDeploySources,
    emptyCompanyCache,
    fileSharePrompt,
    isEmail,
    memberOptions,
    filterIntegrations,
    companyIntegrationRows,
    filterSecrets,
    filterVault,
    readFilesConnectCache,
    recentVaultFiles,
    redeployAllowed,
    redeployPrompt,
    secretBindPrompt,
    secretRowsFromSource,
    secretSetPrompt,
    secretSharePrompt,
    shareAccessPrompt,
    shareSheet,
    statusLabel,
    vaultUploadKey,
    writeFilesConnectCache,
    type AccessLevel,
    type ConnectSession,
    type DeploymentRowModel,
    type DeploySourceScan,
    type FilesConnectCache,
    type FilesConnectPageId,
    type IntegrationRow,
    type MemberOption,
    type SecretRow,
  } from "./files-connect-model.js";
  import { parseListPage, type AtlasListedObject } from "../../shell/vault-list-page.js";

  interface Props {
    page: FilesConnectPageId;
    slug: string;
    files: FilesApi | null;
    shell: ShellApi | null;
    settings: SettingsApi | null;
    openExternal?: (url: string) => void;
    /** Full platform adapter, when the host has one: binds the company read
     *  scope and turns on the desktop Open and Reveal actions in the preview. */
    adapter?: PlatformAdapter | null;
    /** Cloud uid of the company, for vault uploads. */
    companyUid?: string | null;
    /** hq-deploy apps for one scope; the same client as personal Deployments. */
    listDeployApps?: (scope: string) => AdapterPromise<Json>;
    /** hq-deploy access routes for the Access sheet (QA-059). */
    deployAccessRequest?: DeployAccessRequest;
    /** RELEASE-001 gate: false hides Redeploy and the Selected people access mode. */
    deployActions?: boolean;
  }

  let { page, slug, files, shell, settings, openExternal, adapter = null, companyUid = null, listDeployApps, deployAccessRequest, deployActions = true }: Props = $props();

  const workflow = $derived({ settings, shell } as AgentWorkflowApi);

  function cachedSecrets(s: string): SecretRow[] | null {
    const list = companyStore.secrets?.(s);
    return Array.isArray(list) ? secretRowsFromSource(list) : null;
  }
  function cachedDeployments(s: string): DeploymentRowModel[] | null {
    const list = companyStore.deployments?.(s);
    return Array.isArray(list) ? deploymentRowsFromSource(list, s) : null;
  }

  let data = $state<FilesConnectCache>(emptyCompanyCache());
  // Real lists only. null = not loaded yet (skeleton), never sample rows.
  let secrets = $state<SecretRow[] | null>(null);
  let deployments = $state<DeploymentRowModel[] | null>(null);
  let secretsError = $state<string | null>(null);
  // Connected apps from hq-pro; null = not loaded yet. The catalog in
  // data.integrations is only the list of apps that can be connected.
  let connectedApps = $state<IntegrationRow[] | null>(null);
  let integrationsError = $state<string | null>(null);
  let deploymentsError = $state<string | null>(null);
  let query = $state("");
  let vaultTab = $state<"all" | "new">("all");
  let integrationTab = $state<"connected" | "available" | "mcp">("connected");
  let secretTab = $state<"all" | "standard" | "proxy">("all");
  let selectedVault = $state<string>("storyboard");
  let selectedIntegration = $state<string>("slack");
  let selectedSecret = $state<string | null>(null);
  let selectedDeploy = $state<string | null>(null);
  let grantLevel = $state<AccessLevel>("read");
  let sheet = $state<string | null>(null);
  let connect = $state<ConnectSession | null>(null);
  let secretName = $state("");
  let status = $state("");
  let redeployName = $state("");
  let busy = $state(false);

  $effect(() => {
    const s = slug;
    // Never another tenant's rows: no cache means an empty company (QA-028).
    data = readFilesConnectCache(s) ?? emptyCompanyCache();
    // A company switch drops every open sheet and selection (QA-023).
    sheet = null;
    selectedSecret = null;
    selectedDeploy = null;
    grantLevel = "read";
    members = null;
    membersFor = "";
    secrets = cachedSecrets(s);
    deployments = cachedDeployments(s);
    connectedApps = null;
    integrationsError = null;
    let live = true;
    queueMicrotask(() => {
      if (live) void refresh(s, () => live);
    });
    return () => {
      live = false;
    };
  });

  async function refresh(s: string, alive: () => boolean): Promise<void> {
    await Promise.all([refreshSecrets(s, alive), refreshDeployments(s, alive), refreshIntegrations(s, alive)]);
    writeFilesConnectCache(s, data);
  }

  async function refreshSecrets(s: string, alive: () => boolean): Promise<void> {
    try {
      const loaded = await companyStore.loadSecrets(s, false);
      if (!alive()) return;
      secrets = secretRowsFromSource(Array.isArray(loaded) ? loaded : []);
      secretsError = null;
    } catch (err) {
      console.error("secrets load failed:", err);
      if (!alive()) return;
      secretsError = "Could not load secrets.";
      secrets = secrets ?? [];
    }
  }

  async function refreshDeployments(s: string, alive: () => boolean): Promise<void> {
    try {
      // Names come from the real hq-deploy apps (QA-013), else the legacy list.
      const list = listDeployApps ?? adapter?.company?.listDeployApps;
      let rows: DeploymentRowModel[];
      if (list) {
        const res = await list(s);
        if (!res.ok) throw new Error(res.message ?? res.reason);
        rows = companyDeploymentRows(res.value as DeployAppsPage, s);
      } else {
        const loaded = await companyStore.loadDeployments(s, false);
        rows = deploymentRowsFromSource(Array.isArray(loaded) ? loaded : [], s);
      }
      if (!alive()) return;
      deployments = rows;
      deploymentsError = null;
    } catch (err) {
      console.error("deployments load failed:", err);
      if (!alive()) return;
      deploymentsError = "Could not load deployments.";
      deployments = deployments ?? [];
    }
  }

  async function refreshIntegrations(s: string, alive: () => boolean): Promise<void> {
    const list = adapter?.company?.listIntegrations;
    // No cloud company (or no desktop read): nothing is connected in the cloud.
    if (!list || !companyUid) {
      if (!alive()) return;
      connectedApps = [];
      integrationsError = null;
      return;
    }
    try {
      const res = await list(companyUid);
      if (!res.ok) throw new Error(res.message ?? res.reason);
      const rows = companyIntegrationRows(res.value);
      if (!alive()) return;
      connectedApps = rows;
      integrationsError = null;
    } catch (err) {
      console.error("integrations load failed:", err);
      if (!alive() || slug !== s) return;
      integrationsError = "Could not load connected apps.";
      connectedApps = connectedApps ?? [];
    }
  }

  // AUDIT-3: Try again after a failed secrets or deployments read.
  function retryRefresh(): void {
    const s = slug;
    void refresh(s, () => slug === s);
  }

  const vaultRows = $derived(filterVault(data.nodes, vaultTab, query));

  // The sidepane shows these same totals (QA-014): every row, before tabs and search.
  $effect(() => {
    if (secrets) publishCompanyPageCount(slug, "secrets", secrets.length);
  });
  $effect(() => {
    if (deployments) publishCompanyPageCount(slug, "deployments", deployments.length);
  });

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
  let treeNonce = $state(0);

  // The native gate refuses company reads until this window binds the
  // company (QA-011). Bind once per slug, before the first listing.
  const scopedListDir = $derived(
    withCompanyReadScope(
      adapter?.appShell?.setActiveCompany ? (s: string) => adapter!.appShell.setActiveCompany(s) : null,
      (relPath: string) => (files ? files.listDir(relPath) : Promise.reject(new Error("files unavailable"))),
    ),
  );

  function loadVaultChildren(relPath: string): Promise<DirEntry[]> {
    if (!files) return Promise.resolve([]);
    const fresh = scopedListDir(relPath).then((result) => {
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
    void treeNonce;
    vaultFile = null;
    const cached = cachedChildren(root);
    vaultRootSummary = cached ? folderSummary(cached) : null;
    if (!files) return;
    let alive = true;
    loadVaultChildren(root)
      .then((entries) => {
        if (alive) vaultRootSummary = folderSummary(entries);
      })
      .catch((err) => {
        console.error("vault folder summary failed:", err);
        if (alive) vaultRootSummary = "";
      });
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
  const hasExplorer = $derived(files !== null);
  const showVaultTree = $derived(hasExplorer && vaultTab === "all");
  const showRecent = $derived(hasExplorer && vaultTab === "new");

  // ---- What's new (QA-070) --------------------------------------------------
  // The recent-files list: the synced company listing when this machine has
  // it, else the cloud vault listing. Always loading, error, empty or rows.
  const RECENT_MAX_PAGES = 20;
  let recentObjects = $state<AtlasListedObject[] | null>(null);
  let recentError = $state<string | null>(null);
  let recentNonce = $state(0);
  const recentRows = $derived(recentObjects ? recentVaultFiles(slug, recentObjects, Date.now(), query) : []);
  const recentPage = $derived(pageRows(recentRows, vaultPages));

  async function loadRecentObjects(s: string): Promise<AtlasListedObject[]> {
    const local = files?.atlasLocal;
    if (local) {
      const res = await local.listing(s);
      if (!res.ok) throw new Error(`local listing ${res.code ?? res.reason}`);
      if (res.value != null) return parseListPage(res.value).objects;
    }
    if (companyUid && files?.listVaultPrefix) {
      const objects: AtlasListedObject[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < RECENT_MAX_PAGES; i += 1) {
        const res = await files.listVaultPrefix(companyUid, "", cursor);
        if (!res.ok) throw new Error(`vault listing ${res.code ?? res.reason}`);
        const pageResult = parseListPage(res.value);
        objects.push(...pageResult.objects);
        if (!pageResult.cursor) break;
        cursor = pageResult.cursor;
      }
      return objects;
    }
    throw new Error("no recent-files source on this host");
  }

  $effect(() => {
    const s = slug;
    void recentNonce;
    if (!showRecent) return;
    recentObjects = null;
    recentError = null;
    vaultFile = null;
    let alive = true;
    loadRecentObjects(s)
      .then((objects) => {
        if (alive) recentObjects = objects;
      })
      .catch((err) => {
        console.error("vault recent files failed:", err);
        if (alive) recentError = "Could not load recent files.";
      });
    return () => {
      alive = false;
    };
  });

  const allIntegrations = $derived([
    ...(connectedApps ?? []),
    ...data.integrations.filter((row) => row.kind !== "connected"),
  ]);
  const integrationRows = $derived(filterIntegrations(allIntegrations, integrationTab, query));
  // Only the Connected tab reads the server; Available is the local catalog.
  const connectedLoading = $derived(integrationTab === "connected" && connectedApps === null);
  const connectedFailed = $derived(
    integrationTab === "connected" && !!integrationsError && (connectedApps?.length ?? 0) === 0,
  );
  const secretRows = $derived(filterSecrets(secrets ?? [], secretTab, query));
  // Rows in the current Integrations tab before the search, for the no-match total.
  const integrationTabTotal = $derived(filterIntegrations(allIntegrations, integrationTab, "").length);
  const vaultPage = $derived(pageRows(vaultRows, vaultPages));
  const integrationPage = $derived(pageRows(integrationRows, integrationPages));
  const secretPage = $derived(pageRows(secretRows, secretPages));
  const deployPage = $derived(pageRows(deployments ?? [], deployPages));
  const vaultCurrent = $derived(data.nodes.find((node) => node.id === selectedVault) ?? data.nodes[0]);
  /** The Access panel's target; null hides the panel rather than leave it headless. */
  const accessTarget = $derived(
    showVaultTree ? (vaultFolder ?? slug) : showRecent ? (vaultFolder ?? null) : (vaultCurrent?.name ?? null),
  );
  const integrationCurrent = $derived(
    integrationRows.find((row) => row.id === selectedIntegration) ?? integrationRows[0],
  );
  // The inspector reads the filtered rows (QA-058): a secret the tab or search
  // hides is never inspected, and its actions never stay on screen.
  const secretCurrent = $derived(secretRows.find((row) => row.id === selectedSecret) ?? secretRows[0]);
  $effect(() => {
    if (selectedSecret && !secretRows.some((row) => row.id === selectedSecret)) selectedSecret = null;
  });
  const secretsFiltered = $derived(secretTab !== "all" || query.trim() !== "");
  function clearSecretFilters() {
    query = "";
    secretTab = "all";
  }
  const deployCurrent = $derived(
    (deployments ?? []).find((row) => row.id === selectedDeploy) ?? (deployments ?? [])[0],
  );
  const shareView = $derived(secretCurrent ? shareSheet(secretCurrent) : null);

  // ---- grant access (QA-025) ------------------------------------------------
  let members = $state<MemberOption[] | null>(null);
  let membersFor = "";
  let grantRecipient = $state("");
  const grantPath = $derived(vaultFolder ? `${vaultRoot}/${vaultFolder}` : vaultRoot);

  function openGrant(): void {
    grantRecipient = "";
    sheet = "grant";
    loadMembers();
  }

  function openDeployAccess(): void {
    sheet = "deploy-access";
    loadMembers();
  }

  const accessRequest = $derived<DeployAccessRequest | null>(
    deployAccessRequest ?? (adapter?.company?.deployAccessRequest as DeployAccessRequest | undefined) ?? null,
  );

  function loadMembers(): void {
    const s = slug;
    const list = adapter?.company?.listMembers;
    if (!list || membersFor === s) return;
    membersFor = s;
    members = null;
    void list(s)
      .then((res) => {
        if (slug !== s) return;
        members = res.ok && Array.isArray(res.value) ? memberOptions(res.value) : [];
      })
      .catch((err) => {
        console.error("member list failed:", err);
        if (slug === s) members = [];
      });
  }

  /** Share always opens fresh for the current company and page (QA-023). */
  function openShare(kind: "share" | "share-secret"): void {
    grantLevel = "read";
    sheet = kind;
  }

  function closeSheet(): void {
    sheet = null;
    busy = false;
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

  async function handOff(prompt: string, label: string): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      const result = await openAgentWorkflow(workflow, prompt, label);
      status = result.message;
      sheet = null;
    } finally {
      busy = false;
    }
  }

  // ---- deploy sources (QA-044) ----------------------------------------------
  // null = scanning (skeleton). Real project folders only, never samples.
  let deployScan = $state<DeploySourceScan | null>(null);
  let deployScanFor = "";
  let deploySource = $state<string>("");
  const deploySourceCurrent = $derived(deployScan?.sources.find((source) => source.id === deploySource) ?? null);

  function openDeploy(): void {
    sheet = "deploy";
    const s = slug;
    if (deployScanFor === s && deployScan) return;
    deployScanFor = s;
    deployScan = null;
    deploySource = "";
    if (!files) {
      deployScan = { sources: [], reason: "Project files are not available in this window, so there is nothing to pick from." };
      return;
    }
    void findDeploySources(s, async (path) => {
      const res = await scopedListDir(path);
      if (!res.ok) throw new Error(res.message ?? "Could not list files");
      return res.value as unknown as DirEntry[];
    })
      .then((scan) => {
        if (slug !== s) return;
        deployScan = scan;
        deploySource = scan.sources[0]?.id ?? "";
      })
      .catch((err) => {
        console.error("deploy source scan failed:", err);
        if (slug !== s) return;
        deployScanFor = "";
        deployScan = { sources: [], reason: "Could not read this company's projects. Close this and try again." };
      });
  }

  async function runDeploy(artifact: string): Promise<void> {
    if (!artifact) return;
    await handOff(deployPrompt(slug || "company", artifact), "deploy workflow");
  }

  async function runRedeploy(): Promise<void> {
    if (!redeployAllowed(true) || !deployCurrent) return;
    await handOff(redeployPrompt(slug || "company", redeployName || deployCurrent.name), "redeploy");
  }

  function askRedeploy(row: DeploymentRowModel): void {
    redeployName = row.name;
    sheet = "confirm-redeploy";
  }

  function openNewSecret(): void {
    secretName = "";
    sheet = "new-secret";
  }

  const secretNameValid = $derived(/^[A-Z][A-Z0-9_]*$/.test(secretName.trim()));

  async function saveSecret(rotate: boolean): Promise<void> {
    const name = rotate ? secretCurrent?.name ?? "" : secretName.trim();
    if (!name || (!rotate && !secretNameValid)) return;
    await handOff(secretSetPrompt(slug, name, rotate), rotate ? "secret rotation" : "new secret");
  }

  // ---- upload (US-025 upload scene) -----------------------------------------
  let picked = $state<File[]>([]);
  let fileInput = $state<HTMLInputElement | null>(null);
  let uploadFolder = $state("");
  let conflict = $state<ConflictPolicy>("keep-both");
  interface UploadRow {
    name: string;
    dest: string | null;
    status: "queued" | "uploading" | "done" | "failed" | "skipped";
    detail: string;
  }
  let uploads = $state<UploadRow[]>([]);
  const canUpload = $derived(Boolean(companyUid && files?.presignVaultPut));

  function openUpload(): void {
    picked = [];
    uploads = [];
    uploadFolder = vaultFile ? vaultFile.slice(0, vaultFile.lastIndexOf("/")) : vaultRoot;
    sheet = "upload";
  }

  function addFiles(list: FileList | null): void {
    if (list) picked = [...picked, ...Array.from(list)];
  }

  async function startUpload(): Promise<void> {
    const api = files;
    const uid = companyUid;
    if (!api || !uid || picked.length === 0) return;
    let existing = new Set<string>();
    try {
      existing = new Set((await loadVaultChildren(uploadFolder)).map((entry) => entry.name));
    } catch (err) {
      console.error("upload destination list failed:", err);
    }
    uploads = picked.map((file) => {
      const dest = resolveUploadName(file.name, existing, conflict);
      if (dest && conflict === "keep-both") existing.add(dest);
      return dest
        ? { name: file.name, dest, status: "queued" as const, detail: "Waiting" }
        : { name: file.name, dest: null, status: "skipped" as const, detail: "Skipped, name already in this folder" };
    });
    sheet = "upload-progress";
    // Only these app-written sentences may reach the row; anything else is raw.
    const UPLOAD_COPY = new Set([
      "That folder is outside this company.",
      "Could not prepare the upload.",
      "The upload did not finish.",
    ]);
    for (let index = 0; index < picked.length; index += 1) {
      const row = uploads[index];
      const file = picked[index];
      if (!row || !file || !row.dest) continue;
      uploads[index] = { ...row, status: "uploading", detail: "Uploading" };
      try {
        const key = vaultUploadKey(vaultRoot, uploadFolder, row.dest);
        if (!key) throw new Error("That folder is outside this company.");
        const contentType = file.type || "application/octet-stream";
        const signed = await api.presignVaultPut(uid, key, contentType, await fileIntegrity(file));
        if (!signed.ok) {
          // AUDIT-3c: the presign failure text is server text; log it, show app copy.
          console.warn("[files] upload presign failed", signed.code, signed.message);
          throw new Error("Could not prepare the upload.");
        }
        const target = presignUrlFromResult(signed.value);
        if (!target) throw new Error("Could not prepare the upload.");
        const put = await putChatAttachmentDirect(target.url, target.headers, file);
        if (!put.ok) throw new Error("The upload did not finish.");
        uploads[index] = { ...row, status: "done", detail: "Uploaded. It appears here after the next sync." };
      } catch (err) {
        console.warn("[files] vault upload failed", err);
        uploads[index] = {
          ...row,
          status: "failed",
          detail:
            err instanceof Error && UPLOAD_COPY.has(err.message)
              ? err.message
              : "Could not upload this file. Try again.",
        };
      }
    }
    treeNonce += 1;
  }

  const uploadHint = $derived.by(() => {
    const done = uploads.filter((row) => row.status === "done").length;
    const failed = uploads.filter((row) => row.status === "failed").length;
    const active = uploads.filter((row) => row.status === "uploading" || row.status === "queued").length;
    return `${done} done · ${active} in progress · ${failed} failed`;
  });

  function formatBytes(size: number): string {
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }

  const sheetTitle = $derived.by(() => {
    switch (sheet) {
      case "share":
      case "share-secret":
        return "Share";
      case "grant":
        return "Grant access";
      case "connect":
        return "Connect app";
      case "connect-waiting":
        return connect ? `Waiting for ${connect.app}` : "Connect app";
      case "new-secret":
        return "New secret";
      case "rotate":
        return "Rotate secret";
      case "bind":
        return "Bind secret";
      case "bind-outpost":
        return "Bind to outpost";
      case "deploy":
        return "Deploy from project";
      case "deploy-allowlist":
        return "Allowlist";
      case "deploy-access":
        return "Deploy access";
      case "confirm-redeploy":
        return `Redeploy ${redeployName}?`;
      case "upload":
        return "Upload";
      case "upload-progress":
        return "Uploading";
      default:
        return "";
    }
  });
</script>

{#snippet statusDot(value: string)}
  <span class="st" data-status={value}><i class="dot" aria-hidden="true"></i>{statusLabel(value)}</span>
{/snippet}

{#snippet skeletonRows()}
  <div class="skel" aria-busy="true" data-testid="files-connect-skeleton">
    {#each [0, 1, 2, 3, 4] as row (row)}
      <span class="skel-row"><i class="skel-icon"></i><i class="skel-line" style:width="{70 - row * 8}%"></i></span>
    {/each}
  </div>
{/snippet}

<section class="page" data-testid="files-connect" data-page={page}>
  {#if page === "vault"}
    <header class="toolbar">
      <h1>Vault</h1>
      {#if vaultRootSummary}<span class="count">{vaultRootSummary}</span>{/if}
      <span class="grow"></span>
      <div class="fc-seg" role="tablist" aria-label="Vault view">
        <button class="fc-seg-tab" role="tab" aria-selected={vaultTab === "all"} onclick={() => (vaultTab = "all")}>All</button>
        <button class="fc-seg-tab" role="tab" aria-selected={vaultTab === "new"} data-testid="vault-whats-new" onclick={() => (vaultTab = "new")}>What's new</button>
      </div>
      <input class="field search" placeholder="Search files" bind:value={query} />
      <RailButton icon="upload" data-testid="vault-upload" onclick={openUpload}>Upload</RailButton>
      <RailButton icon="link" data-testid="vault-share" onclick={() => openShare("share")}>Share</RailButton>
    </header>
    <div class="split vault-split" class:has-tree={hasExplorer} class:no-access={accessTarget === null}>
      {#if showRecent}
        <div class="vault-tree list" data-testid="vault-recent" aria-busy={recentObjects === null && recentError === null}>
          {#if recentError}
            <div class="empty" role="alert" data-testid="vault-recent-error">
              <span class="empty-title">{recentError}</span>
              <RailButton icon="refresh" onclick={() => (recentNonce += 1)}>Try again</RailButton>
            </div>
          {:else if recentObjects === null}
            <div data-testid="vault-recent-loading">{@render skeletonRows()}</div>
          {:else if recentRows.length === 0}
            <div class="empty" data-testid="vault-recent-empty">
              <span class="empty-title">{query.trim() ? "No recent files match this search" : "No files changed in the last 7 days"}</span>
            </div>
          {:else}
            {#each recentPage.rows as row (row.key)}
              <button class="row" type="button" data-testid="vault-recent-row" data-path={row.path} aria-current={row.path === vaultFile} title={row.key} onclick={() => (vaultFile = row.path)}>
                <span class="nm">{row.name}</span>
                <span class="meta">{row.ago}</span>
              </button>
            {/each}
            {#if recentPage.remaining > 0}
              <ShowMoreRow shown={recentPage.rows.length} total={recentPage.total} next={recentPage.next} noun="files" testid="vault-recent-show-more" onmore={() => (vaultPages += 1)} />
            {/if}
          {/if}
        </div>
      {:else if showVaultTree}
        <div class="vault-tree" data-testid="vault-tree">
          <div class="vault-root mono" title={vaultRoot}>{vaultRoot}</div>
          {#key `${vaultRoot}:${treeNonce}`}
            <CompanyFileTree
              rootPath={vaultRoot}
              loadChildren={loadVaultChildren}
              selectedPath={vaultFile}
              filterQuery={query}
              onclearfilter={() => (query = "")}
              onselect={(path) => (vaultFile = path)}
            />
          {/key}
        </div>
      {:else}
        <div class="list" data-testid="vault-list">
          {#if vaultPage.rows.length === 0}
            <div class="empty" data-testid="vault-list-empty">
              <span class="empty-title">{vaultTab === "new" ? "No files changed in the last 7 days" : "No files to show"}</span>
            </div>
          {/if}
          {#each vaultPage.rows as node (node.id)}
            <button class="row" type="button" aria-current={node.id === vaultCurrent?.id} onclick={() => (selectedVault = node.id)}>
              <span class="nm" style:padding-left="{(node.depth - 1) * 12}px">{node.name}</span>
              <span class="meta">{node.acl}</span>
              <span class="meta">{node.editedBy}</span>
            </button>
          {/each}
          {#if vaultPage.remaining > 0}
            <ShowMoreRow shown={vaultPage.rows.length} total={vaultPage.total} next={vaultPage.next} noun="files" testid="vault-show-more" onmore={() => (vaultPages += 1)} />
          {/if}
        </div>
      {/if}
      {#if hasExplorer}
        <section class="vault-preview" aria-label="File preview" data-testid="vault-preview">
          {#if vaultFile}
            <FilePreviewPane
              adapter={previewAdapter}
              path={vaultFile}
              scopeRoot={vaultRoot}
              scopeLabel="vault"
              onopenpath={(p) => (vaultFile = p)}
            />
          {:else}
            <div class="empty" data-testid="vault-preview-empty">
              <span class="empty-title">Select a file</span>
              {#if showVaultTree}
                <p class="mono" title={vaultRoot}>{vaultRoot}</p>
                {#if vaultRootSummary === null}<ReadLoader testid="vault-summary-loader" onretry={() => (treeNonce += 1)} />{:else}<p data-testid="vault-summary">{vaultRootSummary}</p>{/if}
              {:else}
                <p>Pick a recently changed file to preview it.</p>
              {/if}
            </div>
          {/if}
        </section>
      {/if}
      {#if accessTarget !== null}
      <aside class="pane" data-testid="vault-access">
        <header class="pane-h"><span class="pane-kind">Access</span></header>
        <div class="pane-b">
          <h2>{accessTarget}</h2>
          {#if !hasExplorer}
            <pre class="preview">{vaultCurrent?.preview}</pre>
          {/if}
          <div class="grants">
            {#if data.grants.length === 0}<p class="meta">Grant access to share this folder with a teammate.</p>{/if}
            {#each data.grants as grant (grant.id)}
              <div class="grant">
                <span class="nm">{grant.name}</span>
                <span class="meta">{grant.level}</span>
              </div>
            {/each}
          </div>
          <div class="actions">
            <div class="fc-seg" role="tablist" aria-label="Grant level">
              {#each ACCESS_LEVELS as level (level)}
                <button class="fc-seg-tab" type="button" role="tab" aria-selected={grantLevel === level} onclick={() => (grantLevel = level)}>{level === "read" ? "Read" : "Write"}</button>
              {/each}
            </div>
            <RailButton icon="user-plus" data-testid="grant-access" onclick={openGrant}>Grant access</RailButton>
          </div>
        </div>
      </aside>
      {/if}
    </div>
  {:else if page === "integrations"}
    <header class="toolbar">
      <h1>Integrations</h1>
      <!-- No count while connected apps load, or beside a failed read with nothing loaded. -->
      {#if !connectedLoading && !connectedFailed}<span class="count" data-testid="integrations-count">{countLabel("Integrations", integrationRows.length)}</span>{/if}
      <span class="grow"></span>
      <div class="fc-seg" role="tablist" aria-label="Integrations view">
        <button class="fc-seg-tab" role="tab" aria-selected={integrationTab === "connected"} onclick={() => (integrationTab = "connected")}>Connected</button>
        <button class="fc-seg-tab" role="tab" aria-selected={integrationTab === "available"} onclick={() => (integrationTab = "available")}>Available</button>
        <button class="fc-seg-tab" role="tab" aria-selected={integrationTab === "mcp"} data-testid="integrations-mcp" onclick={() => (integrationTab = "mcp")}>Agents & MCP</button>
      </div>
      <input class="field search" placeholder="App name or website" bind:value={query} />
      <RailButton icon="plug" variant="primary" data-testid="connect-app" onclick={() => (sheet = "connect")}>Connect app</RailButton>
    </header>
    <div class="split">
      <div class="list" data-testid="integrations-list">
        {#if connectedLoading}
          {@render skeletonRows()}
          <ReadLoader testid="integrations-loader" onretry={retryRefresh} />
        {:else if connectedFailed}
          <div class="empty" role="alert" data-testid="integrations-empty">
            <span class="empty-title">{integrationsError}</span>
            <RailButton icon="refresh" data-testid="integrations-retry" onclick={retryRefresh}>Try again</RailButton>
          </div>
        {:else}
        {#each integrationPage.rows as row (row.id)}
          <button class="row" type="button" aria-current={row.id === integrationCurrent?.id} onclick={() => (selectedIntegration = row.id)}>
            <span class="mark" aria-hidden="true">{row.mark}</span>
            <span class="nm">{row.name}</span>
            <span class="meta grow-meta">{row.detail}</span>
            {@render statusDot(row.status)}
          </button>
        {/each}
        {#if integrationRows.length === 0}
          {#if query.trim() && integrationTabTotal > 0}
            <ListEmptyState
              total={integrationTabTotal}
              shown={0}
              {query}
              noun={["app", "apps"]}
              scope="in this view"
              onclear={() => (query = "")}
              testid="integrations-empty"
            />
          {:else}
            <p class="empty-line" data-testid="integrations-empty">{integrationTab === "connected" ? "No connected apps yet" : integrationTab === "mcp" ? "No agent tools connected yet" : "No apps available"}</p>
          {/if}
        {/if}
        {#if integrationPage.remaining > 0}
          <ShowMoreRow shown={integrationPage.rows.length} total={integrationPage.total} next={integrationPage.next} noun="integrations" testid="integrations-show-more" onmore={() => (integrationPages += 1)} />
        {/if}
        {/if}
      </div>
      <aside class="pane">
        {#if integrationCurrent && !connectedLoading && !connectedFailed}
          <header class="pane-h"><span class="pane-kind">{integrationCurrent.kind === "mcp" ? "Agents & MCP" : integrationCurrent.kind === "available" ? "Available" : "Connected"}</span></header>
          <div class="pane-b">
            <h2>{integrationCurrent.name}</h2>
            <p class="meta">{integrationCurrent.detail}</p>
            {@render statusDot(integrationCurrent.status)}
            <div class="actions">
              <RailButton icon="plug" onclick={() => openConnect(integrationCurrent.name)}>
                {integrationCurrent.status === "active" ? "Manage" : "Connect"}
              </RailButton>
            </div>
          </div>
        {/if}
      </aside>
    </div>
  {:else if page === "secrets"}
    <header class="toolbar">
      <h1>Secrets</h1>
      <!-- BLANK-2: no "Secrets · 0" next to a failed read with nothing loaded. -->
      {#if secrets && !(secretsError && secrets.length === 0)}<span class="count" data-testid="secrets-count">{countLabel("Secrets", secretRows.length)}{secretsFiltered ? ` of ${secrets.length.toLocaleString()}` : ""}</span>{/if}
      <span class="grow"></span>
      <div class="fc-seg" role="tablist" aria-label="Secret kind">
        <button class="fc-seg-tab" role="tab" aria-selected={secretTab === "all"} onclick={() => (secretTab = "all")}>All</button>
        <button class="fc-seg-tab" role="tab" aria-selected={secretTab === "standard"} onclick={() => (secretTab = "standard")}>Standard</button>
        <button class="fc-seg-tab" role="tab" aria-selected={secretTab === "proxy"} onclick={() => (secretTab = "proxy")}>Proxy-only</button>
      </div>
      <input class="field search" placeholder="Search secrets" bind:value={query} />
      <RailButton icon="plus" variant="primary" data-testid="new-secret" onclick={openNewSecret}>New secret</RailButton>
    </header>
    <div class="split">
      <div class="list" data-testid="secrets-list">
        {#if secrets === null}
          {@render skeletonRows()}
          <ReadLoader testid="secrets-loader" onretry={retryRefresh} />
        {:else if secretRows.length === 0}
          {#if secretsError}
            <div class="empty" role="alert" data-testid="secrets-empty">
              <span class="empty-title">{secretsError}</span>
              <RailButton icon="refresh" data-testid="secrets-retry" onclick={retryRefresh}>Try again</RailButton>
            </div>
          {:else}
            <ListEmptyState
              total={secrets.length}
              shown={0}
              {query}
              filtered={secretTab !== "all"}
              noun={["secret", "secrets"]}
              scope="in this company"
              emptyCopy="No secrets yet"
              onclear={clearSecretFilters}
              testid="secrets-empty"
            />
          {/if}
        {:else}
          {#each secretPage.rows as row (row.id)}
            <button class="row" type="button" data-testid="secret-row" aria-current={row.id === secretCurrent?.id} onclick={() => (selectedSecret = row.id)}>
              <span class="nm mono">{row.name}</span>
              <span class="meta grow-meta">{row.scope}</span>
              <span class="meta">{row.rotated}</span>
            </button>
          {/each}
          {#if secretPage.remaining > 0}
            <ShowMoreRow shown={secretPage.rows.length} total={secretPage.total} next={secretPage.next} noun="secrets" testid="secrets-show-more" onmore={() => (secretPages += 1)} />
          {/if}
        {/if}
      </div>
      <aside class="pane" data-testid="secret-inspector">
        {#if secretCurrent && shareView}
          <header class="pane-h"><span class="pane-kind">{secretCurrent.kind === "proxy" ? "Proxy-only secret" : "Secret"}</span></header>
          <div class="pane-b">
            <h2 class="mono">{shareView.name}</h2>
            <dl class="facts">
              <dt>Scope</dt><dd>{secretCurrent.scope}</dd>
              <dt>Rotated</dt><dd>{secretCurrent.rotated}</dd>
              {#if secretCurrent.host}<dt>Host</dt><dd class="mono">{secretCurrent.host}</dd>{/if}
            </dl>
            <p class="meta">The value is never shown here.</p>
            <div class="actions">
              <RailButton icon="refresh" data-testid="rotate-secret" onclick={() => (sheet = "rotate")}>Rotate</RailButton>
              <RailButton icon="link" data-testid="share-secret" onclick={() => openShare("share-secret")}>Share</RailButton>
              <RailButton icon="link" data-testid="bind-secret" onclick={() => (sheet = "bind")}>Bind</RailButton>
              <RailButton icon="link" data-testid="bind-outpost" onclick={() => (sheet = "bind-outpost")}>Bind to outpost</RailButton>
            </div>
          </div>
        {/if}
      </aside>
    </div>
  {:else}
    <header class="toolbar">
      <h1>Deployments</h1>
      {#if deployments && !(deploymentsError && deployments.length === 0)}<span class="count" data-testid="deployments-count">{countLabel("Deployments", deployments.length)}</span>{/if}
      <span class="grow"></span>
      <RailButton icon="send" variant="primary" data-testid="deploy-from-project" onclick={openDeploy}>Deploy</RailButton>
    </header>
    {#if deployments === null}
      <div class="list" data-testid="deployments-skeleton" aria-busy="true">{@render skeletonRows()}</div>
      <ReadLoader testid="deployments-loader" onretry={retryRefresh} />
    {:else if deployments.length === 0}
      <div class="empty" data-testid="deployments-empty">
        {#if deploymentsError}
          <p role="alert">{deploymentsError}</p>
          <RailButton icon="refresh" data-testid="deployments-retry" onclick={retryRefresh}>Try again</RailButton>
        {:else}
          <p>Nothing deployed yet</p>
          <RailButton icon="send" onclick={openDeploy}>Deploy from a project</RailButton>
        {/if}
      </div>
    {:else}
      <div class="split">
        <div class="list" data-testid="deployments-list">
          {#each deployPage.rows as row (row.id)}
            <button class="row" type="button" aria-current={row.id === deployCurrent?.id} onclick={() => (selectedDeploy = row.id)}>
              <span class="nm">{row.name}</span>
              <span class="meta grow-meta">{row.project}</span>
              {@render statusDot(row.status)}
            </button>
          {/each}
          {#if deployPage.remaining > 0}
            <ShowMoreRow shown={deployPage.rows.length} total={deployPage.total} next={deployPage.next} noun="deployments" testid="deployments-show-more" onmore={() => (deployPages += 1)} />
          {/if}
        </div>
        <aside class="pane">
          {#if deployCurrent}
            <header class="pane-h"><span class="pane-kind">Deployment</span></header>
            <div class="pane-b">
              <h2>{deployCurrent.name}</h2>
              {@render statusDot(deployCurrent.status)}
              {#if deployCurrent.url}<p class="mono meta url">{deployCurrent.url}</p>{/if}
              <div class="actions">
                <RailButton icon="external" disabled={!deployCurrent.url} onclick={() => openExternal?.(deployCurrent.url)}>Open</RailButton>
                {#if deployActions}<RailButton icon="refresh" data-testid="redeploy" onclick={() => askRedeploy(deployCurrent)}>Redeploy</RailButton>{/if}
                {#if deployCurrent.appId}<RailButton icon="key" data-testid="deploy-access" onclick={openDeployAccess}>Access</RailButton>{/if}
              </div>
              {#if !deployCurrent.appId}<p class="meta" data-testid="deploy-access-unmanaged">Access for this deployment is managed where it was deployed.</p>{/if}
            </div>
          {/if}
        </aside>
      </div>
    {/if}
  {/if}

  {#if status}<p class="status" data-testid="files-connect-status">{status}</p>{/if}
</section>

{#if sheet}
  <div class="scrim" role="presentation" onclick={closeSheet}></div>
  <div class="sheet" role="dialog" aria-modal="true" aria-label={sheetTitle} data-testid={`sheet-${sheet}`} use:dismissable={{ onclose: closeSheet, outside: true }}>
    <header class="sh">
      <span>{sheetTitle}</span>
      <span class="grow"></span>
      <button class="icon" type="button" aria-label="Close" data-testid="sheet-close" onclick={closeSheet}>
        <svg viewBox="0 0 14 14" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><path d="M3.5 3.5l7 7M10.5 3.5l-7 7" /></svg>
      </button>
    </header>
    {#if sheet === "deploy-access" && deployCurrent?.appId}
      <DeployAccessForm
        appId={deployCurrent.appId}
        appName={deployCurrent.name}
        scope={slug}
        request={accessRequest}
        {companyUid}
        hint={deployCurrent.accessHint}
        members={members}
        selectedPeople={deployActions}
        onclose={closeSheet}
        ondone={(message) => (status = message)}
      />
    {:else}
    <div class="sb">
      {#if sheet === "share" || sheet === "share-secret"}
        <div class="fr"><span class="lb">Item</span><span class={sheet === "share-secret" ? "mono" : ""}>{sheet === "share-secret" ? shareView?.name : vaultFile ?? vaultRoot}</span></div>
        <div class="fr">
          <span class="lb">Access</span>
          <div class="fc-seg" role="tablist">
            {#each ACCESS_LEVELS as level (level)}
              <button class="fc-seg-tab" type="button" role="tab" aria-selected={grantLevel === level} onclick={() => (grantLevel = clampAccess(level))}>{level === "read" ? "Read" : "Write"}</button>
            {/each}
          </div>
        </div>
        {#if sheet === "share-secret"}<p class="hint" data-testid="share-no-value">No secret value is included.</p>{/if}
      {:else if sheet === "grant"}
        <div class="fr"><span class="lb">Folder</span><span class="mono">{grantPath}</span></div>
        <label class="fr"><span class="lb">Person</span>
          <input class="field" type="email" list="fc-grant-members" data-testid="grant-recipient" placeholder={members === null && adapter?.company ? "Loading people…" : "name@company.com"} autocomplete="off" bind:value={grantRecipient} />
        </label>
        <datalist id="fc-grant-members">
          {#each members ?? [] as m (m.email)}<option value={m.email}>{m.label}</option>{/each}
        </datalist>
        <div class="fr">
          <span class="lb">Access</span>
          <div class="fc-seg" role="tablist">
            {#each ACCESS_LEVELS as level (level)}
              <button class="fc-seg-tab" type="button" role="tab" aria-selected={grantLevel === level} onclick={() => (grantLevel = level)}>{level === "read" ? "Read" : "Write"}</button>
            {/each}
          </div>
        </div>
        <p class="hint">Runs hq files share for this folder and reads the access back.</p>
      {:else if sheet === "connect"}
        <div class="fr"><span class="lb">App</span><span>{query || "Slack"}</span></div>
        <p class="hint">Sign-in finishes in your browser.</p>
      {:else if sheet === "connect-waiting" && connect}
        <p class="hint" data-testid="connect-waiting">Finish sign-in in the browser. This stays open until the app returns.</p>
      {:else if sheet === "new-secret" || sheet === "rotate"}
        {#if sheet === "new-secret"}
          <label class="fr"><span class="lb">Name</span>
            <input class="field" data-testid="secret-name" placeholder="STRIPE_SECRET_KEY" autocomplete="off" spellcheck="false" bind:value={secretName} />
          </label>
        {:else}
          <div class="fr"><span class="lb">Name</span><span class="mono">{secretCurrent?.name}</span></div>
        {/if}
        <p class="hint">Save opens a terminal prompt for the value. The value never passes through this window.</p>
      {:else if sheet === "bind" || sheet === "bind-outpost"}
        <div class="fr"><span class="lb">Secret</span><span class="mono">{secretCurrent?.name}</span></div>
        <p class="hint">The binding stores the name, not the value.</p>
      {:else if sheet === "deploy"}
        {#if deployScan === null}
          <div data-testid="deploy-sources-skeleton">{@render skeletonRows()}</div>
        {:else if deployScan.sources.length === 0}
          <div class="empty" data-testid="deploy-sources-empty">
            <span class="empty-title">Nothing to deploy yet</span>
            <p class="wrap">{deployScan.reason}</p>
          </div>
        {:else}
          <label class="fr"><span class="lb">Project</span>
            <select class="field" data-testid="deploy-source" bind:value={deploySource}>
              {#each deployScan.sources as source (source.id)}
                <option value={source.id}>{source.dir === "." ? source.project : `${source.project} · ${source.dir}`}</option>
              {/each}
            </select>
          </label>
          {#if deploySourceCurrent}<p class="hint mono" data-testid="deploy-source-path" title={deploySourceCurrent.path}>{deploySourceCurrent.path}</p>{/if}
        {/if}
        <div class="fr"><span class="lb">Who can open</span><button class="link" type="button" onclick={() => (sheet = "deploy-allowlist")}>Company members</button></div>
        <p class="hint">Runs the hq-deploy command and returns the link.</p>
      {:else if sheet === "deploy-allowlist"}
        <p class="hint">Company members with read access can open the link.</p>
      {:else if sheet === "confirm-redeploy"}
        <p class="hint">This runs the existing hq-deploy command again.</p>
      {:else if sheet === "upload"}
        <div class="fr">
          <span class="lb">Files</span>
          <div class="pick">
            <RailButton icon="file" data-testid="upload-choose" onclick={() => fileInput?.click()}>Choose files…</RailButton>
            <input bind:this={fileInput} type="file" multiple hidden onchange={(event) => addFiles((event.currentTarget as HTMLInputElement).files)} />
            {#each picked as file, index (file.name + index)}
              <span class="picked"><span class="nm">{file.name}</span><span class="meta">{formatBytes(file.size)}</span>
                <button class="icon" type="button" aria-label={`Remove ${file.name}`} onclick={() => (picked = picked.filter((_, i) => i !== index))}>
                  <svg viewBox="0 0 14 14" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><path d="M3.5 3.5l7 7M10.5 3.5l-7 7" /></svg>
                </button>
              </span>
            {/each}
          </div>
        </div>
        <div class="fr"><span class="lb">Folder</span><span class="mono">{uploadFolder}/</span></div>
        <div class="fr">
          <span class="lb">On conflict</span>
          <div class="fc-seg" role="radiogroup" aria-label="On conflict">
            {#each [["keep-both", "Keep both"], ["replace", "Replace"], ["skip", "Skip"]] as [id, label] (id)}
              <button class="fc-seg-tab" type="button" role="radio" aria-checked={conflict === id} aria-selected={conflict === id} onclick={() => (conflict = id as ConflictPolicy)}>{label}</button>
            {/each}
          </div>
        </div>
        {#if !canUpload}<p class="hint" data-testid="upload-unavailable">Uploading needs this company connected to HQ cloud.</p>{/if}
      {:else if sheet === "upload-progress"}
        {#each uploads as row (row.name + (row.dest ?? ""))}
          <div class="fr" data-status={row.status}><span class="lb">{row.status === "done" ? "Done" : row.status === "failed" ? "Failed" : row.status === "skipped" ? "Skipped" : "Uploading"}</span><span><span class="nm">{row.dest ?? row.name}</span><span class="meta"> · {row.detail}</span></span></div>
        {/each}
      {/if}
    </div>
    <footer class="sf">
      <span class="hint grow">{sheet === "upload" ? `${picked.length} files` : sheet === "upload-progress" ? uploadHint : ""}</span>
      {#if sheet === "share" || sheet === "share-secret"}
        <RailButton icon="x" onclick={closeSheet}>Cancel</RailButton>
        <RailButton icon="link" variant="primary" data-testid="share-save" disabled={busy} onclick={() => void handOff(sheet === "share-secret" ? secretSharePrompt(slug, shareView?.name ?? "", grantLevel) : shareAccessPrompt(slug, vaultFile ?? vaultRoot, grantLevel), "share")}>Share</RailButton>
      {:else if sheet === "grant"}
        <RailButton icon="x" onclick={closeSheet}>Cancel</RailButton>
        <RailButton icon="user-plus" variant="primary" data-testid="grant-save" disabled={busy || !isEmail(grantRecipient)} onclick={() => void handOff(fileSharePrompt(slug, grantPath, grantRecipient, grantLevel), "grant")}>Grant</RailButton>
      {:else if sheet === "connect"}
        <RailButton icon="x" onclick={closeSheet}>Cancel</RailButton>
        <RailButton icon="external" variant="primary" data-testid="connect-open" onclick={() => openConnect(query || "Slack")}>Open in browser</RailButton>
      {:else if sheet === "connect-waiting"}
        <RailButton icon="x" onclick={closeSheet}>Cancel</RailButton>
        <RailButton icon="check" data-testid="connect-return" onclick={simulateReturn}>I've signed in</RailButton>
      {:else if sheet === "new-secret" || sheet === "rotate"}
        <RailButton icon="x" onclick={closeSheet}>Cancel</RailButton>
        <RailButton icon="check" variant="primary" data-testid="secret-save" disabled={busy || (sheet === "new-secret" && !secretNameValid)} onclick={() => void saveSecret(sheet === "rotate")}>Save</RailButton>
      {:else if sheet === "bind" || sheet === "bind-outpost"}
        <RailButton icon="x" onclick={closeSheet}>Cancel</RailButton>
        <RailButton icon="link" variant="primary" data-testid="bind-save" disabled={busy} onclick={() => void handOff(secretBindPrompt(slug, secretCurrent?.name ?? "", sheet === "bind-outpost" ? "outpost" : "app"), "binding")}>Bind</RailButton>
      {:else if sheet === "deploy"}
        <RailButton icon="x" onclick={closeSheet}>Cancel</RailButton>
        <RailButton icon="send" variant="primary" data-testid="run-deploy" disabled={busy || !deploySourceCurrent} onclick={() => void runDeploy(deploySourceCurrent?.path ?? "")}>Deploy</RailButton>
      {:else if sheet === "deploy-allowlist"}
        <RailButton icon="arrow-left" variant="primary" onclick={() => (sheet = "deploy")}>Back to deploy</RailButton>
      {:else if sheet === "confirm-redeploy"}
        <RailButton icon="x" onclick={closeSheet}>Cancel</RailButton>
        <RailButton icon="refresh" variant="primary" data-testid="confirm-redeploy" disabled={busy} onclick={() => void runRedeploy()}>Redeploy</RailButton>
      {:else if sheet === "upload"}
        <RailButton icon="x" onclick={closeSheet}>Cancel</RailButton>
        <RailButton icon="upload" variant="primary" data-testid="upload-start" disabled={!canUpload || picked.length === 0} onclick={() => void startUpload()}>Upload</RailButton>
      {:else}
        <RailButton icon="check" variant="primary" onclick={closeSheet}>Done</RailButton>
      {/if}
    </footer>
    {/if}
  </div>
{/if}

<style>
  /* Messages metrics: chat/chat-tokens.css, chat/ChatSidebar.svelte rows,
     chat/MemberProfilePanel.svelte pane, chat/NewChannelSheet.svelte sheet. */
  .page { display: flex; flex-direction: column; height: 100%; min-height: 0; color: var(--t1, var(--v4-text-1)); background: var(--v4-ground); font: 400 13px/1.45 var(--font-ui, var(--font-sans)); }
  button, input { font: inherit; }
  .toolbar { display: flex; align-items: center; gap: 8px; min-height: 48px; padding: 10px 16px; border-bottom: 1px solid var(--line, var(--v4-rowline)); }
  h1 { font-size: 20px; font-weight: 500; line-height: 1.25; margin: 0; }
  h2 { font-size: 13px; font-weight: 500; line-height: 17px; margin: 0; overflow-wrap: anywhere; }
  .count { color: var(--t3, var(--v4-text-3)); font-variant-numeric: tabular-nums; }
  .grow { flex: 1; }
  .fc-seg { justify-content: flex-start; display: flex; gap: 2px; width: max-content; padding: 2px; border-radius: 6px; border: 1px solid var(--panel-border, var(--v4-hairline)); background: var(--hover, var(--v4-hover)); }
  .fc-seg-tab { border: 0; background: transparent; color: var(--t2, var(--v4-text-2)); padding: 2px 8px; border-radius: 4px; line-height: 18px; cursor: pointer; }
  .fc-seg-tab[aria-selected="true"] { background: var(--v4-active-row, var(--sel)); color: var(--t1, var(--v4-text-1)); }
  .field { height: 28px; border-radius: 6px; border: 1px solid var(--line2, var(--v4-control-border)); background: transparent; color: inherit; padding: 0 8px; min-width: 0; }
  .search { width: 200px; }
  .icon { width: 24px; height: 24px; display: inline-grid; place-items: center; border: 0; border-radius: 6px; background: transparent; color: var(--t3, var(--v4-text-3)); padding: 0; cursor: pointer; }
  .icon:hover { background: var(--hover, var(--v4-hover)); color: var(--t1, var(--v4-text-1)); }
  .link { border: 0; background: transparent; color: var(--t1, var(--v4-text-1)); padding: 0; text-decoration: underline; text-underline-offset: 2px; cursor: pointer; text-align: left; }
  .split { display: grid; grid-template-columns: minmax(0, 1fr) 320px; min-height: 0; flex: 1; }
  .list { min-height: 0; overflow: auto; padding: 6px 8px; display: flex; flex-direction: column; gap: 1px; }
  .row { display: flex; gap: 10px; align-items: center; width: 100%; min-height: 31px; text-align: left; padding: 7px 8px; border: 0; border-radius: 8px; background: transparent; color: var(--t2, var(--v4-text-2)); line-height: 17px; cursor: pointer; }
  .row:hover { background: var(--hover, var(--v4-hover)); }
  .row[aria-current="true"] { background: var(--sel, var(--v4-active-row)); color: var(--t1, var(--v4-text-1)); box-shadow: none; }
  .nm { color: var(--t1, var(--v4-text-1)); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meta { color: var(--t3, var(--v4-text-3)); margin: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .grow-meta { flex: 1; min-width: 0; }
  .mono { font-family: var(--font-mono, ui-monospace, monospace); }
  .mark { width: 24px; height: 24px; flex: 0 0 24px; display: grid; place-items: center; border-radius: 5px; background: var(--raised, var(--v4-control-faint)); color: var(--t2, var(--v4-text-2)); font-size: 12px; font-weight: 500; }
  .st { display: inline-flex; align-items: center; gap: 6px; color: var(--t2, var(--v4-text-2)); white-space: nowrap; }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--t3, var(--v4-text-3)); }
  .st[data-status="active"] .dot, .st[data-status="live"] .dot { background: var(--ok, var(--v4-ok)); }
  .st[data-status="error"] .dot { background: var(--red, var(--v4-danger)); }
  /* Detail pane: Messages profile pane rhythm. */
  .pane { min-height: 0; overflow: auto; border-left: 1px solid var(--line, var(--v4-rowline)); display: flex; flex-direction: column; }
  .pane-h { display: flex; align-items: center; min-height: 48px; padding: 12px 14px; border-bottom: 1px solid var(--line, var(--v4-rowline)); }
  .pane-kind { color: var(--t2, var(--v4-text-2)); font-weight: 500; }
  .pane-b { padding: 20px; display: flex; flex-direction: column; gap: 10px; }
  .pane-b p { margin: 0; }
  .facts { display: grid; grid-template-columns: 72px minmax(0, 1fr); gap: 6px 12px; margin: 0; }
  .facts dt { color: var(--t3, var(--v4-text-3)); }
  .facts dd { margin: 0; color: var(--t1, var(--v4-text-1)); overflow-wrap: anywhere; }
  .url { white-space: normal; overflow-wrap: anywhere; }
  .actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding-top: 4px; }
  .grants { display: flex; flex-direction: column; }
  .grant { display: flex; justify-content: space-between; align-items: center; gap: 8px; min-height: 28px; }
  .preview { white-space: pre-wrap; color: var(--t2, var(--v4-text-2)); font-family: var(--font-mono, ui-monospace, monospace); font-size: 12px; margin: 0; }
  /* Vault: tree · preview · access. */
  .vault-split.has-tree { grid-template-columns: minmax(240px, 300px) minmax(0, 1fr) 280px; }
  .vault-split.has-tree.no-access { grid-template-columns: minmax(240px, 300px) minmax(0, 1fr); }
  .split.no-access:not(.has-tree) { grid-template-columns: minmax(0, 1fr); }
  .vault-tree { min-height: 0; overflow: auto; padding: 8px 8px 16px; border-right: 1px solid var(--line, var(--v4-rowline)); }
  .vault-root { padding: 4px 8px 6px; color: var(--t3, var(--v4-text-3)); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .vault-preview { min-width: 280px; min-height: 0; overflow: auto; }
  /* Narrow window: the tree shrinks and Access moves under the preview
     instead of squeezing the preview to nothing (QA-026). */
  @media (max-width: 1180px) {
    .vault-split.has-tree { grid-template-columns: minmax(160px, 240px) minmax(280px, 1fr); grid-template-rows: minmax(0, 1fr) auto; overflow: auto; }
    .vault-split.has-tree .pane { grid-column: 1 / -1; border-left: 0; border-top: 1px solid var(--line, var(--v4-rowline)); max-height: 40vh; }
  }
  .empty { padding: 48px 16px; color: var(--t3, var(--v4-text-3)); text-align: center; display: flex; flex-direction: column; align-items: center; gap: 4px; }
  .empty p { margin: 0; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .empty :global([data-rail-btn]) { margin-top: 8px; }
  .empty p.wrap { white-space: normal; overflow: visible; }
  .sheet .empty { padding: 24px 20px; }
  .empty-title { color: var(--t2, var(--v4-text-2)); }
  .empty-line { margin: 0; padding: 48px 16px; text-align: center; color: var(--t3, var(--v4-text-3)); }
  .skel { display: flex; flex-direction: column; padding: 6px 8px; }
  .skel-row { display: flex; align-items: center; gap: 10px; height: 36px; padding: 0 8px; }
  .skel-icon { width: 20px; height: 20px; border-radius: 5px; background: var(--line, var(--v4-control-faint)); }
  .skel-line { height: 10px; border-radius: 4px; background: var(--line, var(--v4-control-faint)); }
  .status { margin: 0; padding: 8px 16px; color: var(--t3, var(--v4-text-3)); border-top: 1px solid var(--line, var(--v4-rowline)); }
  /* Sheet: chat/NewChannelSheet.svelte. */
  .scrim { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.45); z-index: 70; }
  .sheet { position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(480px, calc(100vw - 32px)); max-height: calc(100% - 40px); display: flex; flex-direction: column; overflow: hidden; z-index: 71; background: var(--panel-bg, var(--v4-popover)); border: 1px solid var(--panel-border, var(--v4-hairline)); border-radius: 8px; color: var(--t1, var(--v4-text-1)); font: 400 13px/1.45 var(--font-ui, var(--font-sans)); }
  .sh { height: 52px; flex: 0 0 52px; display: flex; align-items: center; gap: 8px; padding: 0 10px 0 20px; border-bottom: 1px solid var(--panel-border, var(--v4-hairline)); font-weight: 500; }
  .sb { overflow: auto; }
  .fr { display: grid; grid-template-columns: 120px minmax(0, 1fr); gap: 12px; align-items: center; min-height: 28px; padding: 10px 20px; border-bottom: 1px solid var(--panel-border, var(--v4-rowline)); }
  .lb { color: var(--t3, var(--v4-text-3)); }
  .hint { margin: 0; padding: 10px 20px; color: var(--t3, var(--v4-text-3)); }
  .sf .hint { padding: 0; }
  .pick { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; min-width: 0; }
  .picked { display: flex; align-items: center; gap: 8px; max-width: 100%; }
  .sf { display: flex; align-items: center; gap: 8px; padding: 12px 20px; border-top: 1px solid var(--panel-border, var(--v4-hairline)); }
</style>
