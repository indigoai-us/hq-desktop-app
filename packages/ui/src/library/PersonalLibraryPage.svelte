<script lang="ts">
  import CompanyLabel from "../company/CompanyLabel.svelte";
  import RailButton from "../common/button/RailButton.svelte";
  import RailIcon from "../common/button/RailIcon.svelte";
  /**
   * Personal Library (US-031). My files and Shared with me.
   * Company rows reuse CompanyLibraryPanel. File rows reuse FilePreviewPane
   * when an adapter is present; the fixture preview paints in the same frame.
   */
  import type { LibraryApi, PlatformAdapter } from "@hq/platform";
  import CompanyLibraryPanel from "../company/CompanyLibraryPanel.svelte";
  import FilePreviewPane from "../files/FilePreviewPane.svelte";
  import ShareFileSheet from "../files/explorer/ShareFileSheet.svelte";
  import type { ShareTarget } from "../files/explorer/vault-model.js";
  import "../home/tokens.css";
  import "../chat/chat-tokens.css";
  import {
    activeGrants,
    expiredGrants,
    filesForSection,
    libraryFolderTree,
    personalLibraryFixture,
    readPersonalLibraryCache,
    sharedGrantPreview,
    writePersonalLibraryCache,
    type LibraryTreeNode,
    type PersonalLibraryCache,
    type PersonalLibrarySection,
    type SharedGrant,
  } from "./personal-library.js";

  interface CompanyRef {
    slug: string;
    label: string;
    mark: string;
  }

  interface Props {
    accountId?: string;
    adapter?: PlatformAdapter | null;
    library?: LibraryApi | null;
    companies?: CompanyRef[];
  }

  let {
    accountId = "local",
    adapter = null,
    library = null,
    companies = [
      { slug: "indigo", label: "Indigo", mark: "IN" },
      { slug: "liverecover", label: "LiveRecover", mark: "LR" },
    ],
  }: Props = $props();

  let cache = $state<PersonalLibraryCache>(personalLibraryFixture());
  let shareFor = $state<{ path: string; grant: SharedGrant | null } | null>(null);

  function libraryShareTarget(path: string, grant: SharedGrant | null): ShareTarget {
    if (grant) {
      return {
        path,
        company: grant.company,
        available: false,
        reason: `${grant.owner} shared this path with you. Only the owner can share it further.`,
      };
    }
    return {
      path,
      company: null,
      available: false,
      reason:
        "Personal files live only in your HQ folder on this computer. Sharing grants access to a company vault path, so a personal file has to move into a company vault before anyone else can open it.",
    };
  }
  let section = $state<PersonalLibrarySection>("mine");
  let companySlug = $state<string | null>(null);
  let selectedFileId = $state("week-41");
  let selectedGrantId = $state("billing");
  let sharedTab = $state<"active" | "expired">("active");
  let query = $state("");
  let collapsed = $state<Record<string, boolean>>({});

  $effect(() => {
    const warm = readPersonalLibraryCache(accountId);
    cache = warm ?? personalLibraryFixture();
    let live = true;
    queueMicrotask(() => {
      if (!live) return;
      const next = personalLibraryFixture();
      cache = next;
      writePersonalLibraryCache(accountId, next);
    });
    return () => {
      live = false;
    };
  });

  const mineFiles = $derived(filesForSection(cache, section === "starred" || section === "recent" ? section : "mine"));
  const fileTree = $derived(libraryFolderTree(mineFiles.filter((file) => matches(`${file.name} ${file.path}`))));
  const selectedFile = $derived(
    mineFiles.find((file) => file.id === selectedFileId) ?? mineFiles[0] ?? null,
  );
  const grantList = $derived(
    sharedTab === "expired" ? expiredGrants(cache.grants) : activeGrants(cache.grants),
  );
  const selectedGrant = $derived(sharedGrantPreview(cache.grants, selectedGrantId));

  /** A relative Markdown link in the preview selects that library file (QA-104). */
  function openLibraryPath(target: string): void {
    const file = cache.files.find((f) => f.path === target);
    if (file) {
      selectedFileId = file.id;
      return;
    }
    const grant = cache.grants.find((g) => g.path === target);
    if (grant) selectedGrantId = grant.id;
  }

  function selectSection(next: PersonalLibrarySection, slug: string | null = null): void {
    section = next;
    companySlug = slug;
  }

  function matches(text: string): boolean {
    const q = query.trim().toLowerCase();
    return !q || text.toLowerCase().includes(q);
  }
</script>

<div class="library" data-testid="personal-library">
  <aside class="pane" aria-label="Library">
    <div class="pane-head">Library</div>
    <div class="pane-list">
      <button type="button" class="row" aria-current={section === "mine" ? "true" : undefined} onclick={() => selectSection("mine")}>
        <span>My files</span><span class="meta">{cache.fileCount.toLocaleString()}</span>
      </button>
      <button type="button" class="row" data-testid="library-shared-tab" aria-current={section === "shared" ? "true" : undefined} onclick={() => selectSection("shared")}>
        <span>Shared with me</span><span class="count">{activeGrants(cache.grants).length}</span>
      </button>
      <button type="button" class="row" aria-current={section === "recent" ? "true" : undefined} onclick={() => selectSection("recent")}>
        <span>Recent</span>
      </button>
      <button type="button" class="row" aria-current={section === "starred" ? "true" : undefined} onclick={() => selectSection("starred")}>
        <span>Starred</span><span class="meta">{filesForSection(cache, "starred").length}</span>
      </button>
      <div class="sec">Companies</div>
      {#each companies as company (company.slug)}
        <button type="button" class="row" aria-current={section === "company" && companySlug === company.slug ? "true" : undefined} onclick={() => selectSection("company", company.slug)}>
          <CompanyLabel name={company.label} companyUid={company.slug} /><span class="meta">vault</span>
        </button>
      {/each}
      <div class="sec">Local</div>
      <button type="button" class="row" aria-current={section === "local" ? "true" : undefined} onclick={() => selectSection("local")}>
        <span>HQ folder</span><span class="meta">~/Documents/HQ</span>
      </button>
    </div>
  </aside>

  <main class="content">
    {#if section === "company" && companySlug && library}
      <CompanyLibraryPanel slug={companySlug} {library} />
    {:else if section === "company"}
      <div class="empty" data-testid="library-company-empty">Company library loads when this account's library API is connected.</div>
    {:else if section === "shared"}
      <div class="toolbar">
        <b>Shared with me</b>
        <span class="grow"></span>
        <button type="button" class="tab" role="tab" aria-selected={sharedTab === "active"} onclick={() => (sharedTab = "active")}>Active</button>
        <button type="button" class="tab" role="tab" aria-selected={sharedTab === "expired"} onclick={() => (sharedTab = "expired")}>Expired</button>
        <input class="search" type="search" placeholder="Search shared" aria-label="Search shared" bind:value={query} />
      </div>
      <div class="split">
        <div class="list" data-testid="library-shared-list">
          <div class="hd"><span>Path</span><span>Owner</span><span>Company</span><span>Access</span><span>Expires</span></div>
          {#each grantList.filter((grant) => matches(`${grant.name} ${grant.owner} ${grant.company}`)) as grant (grant.id)}
            <button
              type="button"
              class="srow"
              class:gone={grant.expired}
              data-testid="library-shared-row"
              aria-current={selectedGrant?.id === grant.id ? "true" : undefined}
              onclick={() => (selectedGrantId = grant.id)}
            >
              <span class="nm">{grant.name}<span>{grant.parent}</span></span>
              <span>{grant.ownerMark} {grant.owner}</span>
              <span><CompanyLabel name={grant.company} /></span>
              <span class="mono">{grant.access}</span>
              <span class="mono">{grant.expires}</span>
            </button>
          {/each}
          <p class="foot">You can open what is shared with you. Only the owner can change a grant. Levels are read and write.</p>
        </div>
        {#if selectedGrant}
          {@render preview(selectedGrant.name, selectedGrant.path, `${selectedGrant.company} · ${selectedGrant.access}`, selectedGrant.preview, selectedGrant)}
        {/if}
      </div>
    {:else}
      <div class="toolbar">
        <b>{section === "starred" ? "Starred" : section === "recent" ? "Recent" : "My files"}</b>
        <span class="grow"></span>
        <input class="search" type="search" placeholder="Search my files" aria-label="Search my files" bind:value={query} />
      </div>
      <div class="split">
        <div class="tree" data-testid="library-folder-tree">
          {@render treeNodes(fileTree, 0)}
        </div>
        {#if selectedFile}
          {@render preview(selectedFile.name, selectedFile.path, selectedFile.meta, selectedFile.preview, null)}
        {/if}
      </div>
    {/if}
  </main>
</div>

{#if shareFor}
  <ShareFileSheet target={libraryShareTarget(shareFor.path, shareFor.grant)} onclose={() => (shareFor = null)} />
{/if}

{#snippet treeNodes(nodes: LibraryTreeNode[], depth: number)}
  {#each nodes as node (node.id)}
    {#if node.file}
      <button
        type="button"
        class="frow"
        style:padding-left={`${10 + depth * 14}px`}
        aria-current={selectedFile?.id === node.file.id ? "true" : undefined}
        onclick={() => (selectedFileId = node.file!.id)}
      >
        <span>{node.name}</span>
      </button>
    {:else}
      <button
        type="button"
        class="frow folder"
        style:padding-left={`${10 + depth * 14}px`}
        aria-expanded={!collapsed[node.id]}
        data-testid="library-folder"
        onclick={() => (collapsed = { ...collapsed, [node.id]: !collapsed[node.id] })}
      >
        <span class="folder-label"><RailIcon name={collapsed[node.id] ? "caret-right" : "chevron-down"} size={12} />{node.name}</span>
      </button>
      {#if !collapsed[node.id]}
        {@render treeNodes(node.children, depth + 1)}
      {/if}
    {/if}
  {/each}
{/snippet}

{#snippet preview(name: string, path: string, meta: string, text: string, grant: SharedGrant | null)}
  <div class="preview" data-testid="library-preview">
    {#if adapter?.files && typeof adapter.files.getFileContent === "function"}
      <!-- FilePreviewPane carries the name, path and its own Open / Copy path
           / Reveal actions; repeating them here showed every action twice. -->
      <FilePreviewPane {adapter} {path} scopeLabel="library" onopenpath={openLibraryPath} />
      <div class="act solo" data-testid="library-preview-actions">
        <RailButton icon="link" data-testid="library-preview-share" onclick={() => (shareFor = { path, grant })}>Share</RailButton>
      </div>
    {:else}
      <div class="ph">
        <div class="ph-copy">
          <b data-testid="library-preview-name">{name}</b>
          <span class="meta">{meta}</span>
        </div>
        <div class="act" data-testid="library-preview-actions">
          <RailButton icon="copy" onclick={() => void navigator.clipboard?.writeText(path)}>Copy path</RailButton>
          <RailButton icon="link" data-testid="library-preview-share" onclick={() => (shareFor = { path, grant })}>Share</RailButton>
        </div>
      </div>
      <pre data-testid="library-file-preview">{text}</pre>
    {/if}
    {#if grant}
      <dl class="access" data-testid="library-your-access">
        <dt>Owner</dt><dd>{grant.owner} · {grant.company}</dd>
        <dt>Level</dt><dd>{grant.access}</dd>
        <dt>Expires</dt><dd>{grant.expires}</dd>
      </dl>
    {:else}
      <p class="foot">Company vaults stay separate. personal/ is visible to a company only when you share a path.</p>
    {/if}
  </div>
{/snippet}

<style>
  .library {
    display: grid;
    grid-template-columns: 260px minmax(0, 1fr);
    height: 100%;
    min-height: 0;
    background: var(--v4-bg, transparent);
    color: var(--v4-text-1);
  }
  .pane { border-right: 1px solid var(--v4-rowline); min-height: 0; overflow: auto; }
  .pane-head, .toolbar, .sec, .mono { font-family: var(--font-mono); }
  .pane-head { padding: 12px 14px; font-size: 13px; font-weight: 600; font-family: var(--font-sans, inherit); }
  .sec { padding: 12px 14px 4px; font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--v4-text-3); }
  .row, .frow, .srow {
    display: flex;
    width: 100%;
    gap: 8px;
    align-items: center;
    text-align: left;
    border: 0;
    background: transparent;
    color: var(--v4-text-2);
    padding: 7px 10px;
    border-radius: 6px;
    cursor: pointer;
  }
  .row { justify-content: flex-start; }
  .row .meta, .row .count, .frow .meta { margin-left: auto; color: var(--v4-text-3); font-size: 12px; }
  .row:hover, .frow:hover, .srow:hover { background: var(--v4-hover); }
  .row[aria-current="true"], .frow[aria-current="true"], .srow[aria-current="true"] {
    background: var(--v4-active-row);
    color: var(--v4-text-1);
  }
  .content { min-width: 0; min-height: 0; display: flex; flex-direction: column; }
  .toolbar { display: flex; align-items: center; gap: 8px; padding: 10px 16px; }
  .grow { flex: 1; }
  .search {
    width: 180px;
    height: 26px;
    border: 1px solid var(--v4-rowline);
    border-radius: 6px;
    background: var(--v4-control-bg);
    color: var(--v4-text-1);
    padding: 0 8px;
  }
  .tab { border: 0; background: transparent; color: var(--v4-text-2); padding: 4px 8px; cursor: pointer; }
  .tab[aria-selected="true"] { background: var(--v4-active-row); color: var(--v4-text-1); border-radius: 6px; }
  .split { display: grid; grid-template-columns: minmax(0, 1fr) 340px; min-height: 0; flex: 1; }
  .tree, .list, .preview { min-width: 0; min-height: 0; overflow: auto; }
  .list { border-right: 1px solid var(--v4-rowline); padding: 8px 12px; }
  .hd, .srow { display: grid; grid-template-columns: minmax(0, 1.4fr) 1fr 1fr 64px 110px; gap: 8px; }
  .hd { font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--v4-text-3); padding: 4px 8px; }
  .srow { font-size: 13px; border-bottom: 1px solid var(--v4-rowline); }
  .nm { display: flex; flex-direction: column; min-width: 0; color: var(--v4-text-1); }
  .nm span, .meta, .foot, .empty { color: var(--v4-text-3); font-size: 12px; }
  .gone { opacity: 0.55; }
  .preview { border-left: 1px solid var(--v4-rowline); padding: 12px 16px; background: var(--v4-secondary-sidebar); }
  .ph { display: flex; align-items: flex-start; gap: 8px; margin-bottom: 8px; min-width: 0; }
  .ph-copy { min-width: 0; flex: 1 1 auto; }
  .ph-copy b, .ph-copy .meta { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .act.solo { justify-content: flex-start; margin-top: 12px; }
  .act { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; flex: 0 1 auto; max-width: 100%; }
  pre {
    margin: 0;
    white-space: pre-wrap;
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--v4-text-2);
  }
  .access { display: grid; grid-template-columns: 84px minmax(0, 1fr); gap: 6px 10px; font-size: 12px; margin-top: 12px; }
  .access dt { color: var(--v4-text-3); }
  .access dd { margin: 0; color: var(--v4-text-1); }
  .foot, .empty { padding: 12px; line-height: 1.5; }
  .frow { border-bottom: 1px solid var(--v4-rowline); }
  .folder-label { display: inline-flex; align-items: center; gap: 4px; }
</style>
