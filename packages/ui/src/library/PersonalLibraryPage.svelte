<script lang="ts">
  /**
   * Personal Library (US-031). My files and Shared with me.
   * Company rows reuse CompanyLibraryPanel. File rows reuse FilePreviewPane
   * when an adapter is present; the fixture preview paints in the same frame.
   */
  import type { LibraryApi, PlatformAdapter } from "@hq/platform";
  import CompanyLibraryPanel from "../company/CompanyLibraryPanel.svelte";
  import FilePreviewPane from "../files/FilePreviewPane.svelte";
  import "../home/tokens.css";
  import "../chat/chat-tokens.css";
  import {
    activeGrants,
    expiredGrants,
    filesForSection,
    personalLibraryFixture,
    readPersonalLibraryCache,
    sharedGrantPreview,
    writePersonalLibraryCache,
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
  let section = $state<PersonalLibrarySection>("mine");
  let companySlug = $state<string | null>(null);
  let selectedFileId = $state("week-41");
  let selectedGrantId = $state("billing");
  let sharedTab = $state<"active" | "expired">("active");
  let query = $state("");

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
  const selectedFile = $derived(
    mineFiles.find((file) => file.id === selectedFileId) ?? mineFiles[0] ?? null,
  );
  const grantList = $derived(
    sharedTab === "expired" ? expiredGrants(cache.grants) : activeGrants(cache.grants),
  );
  const selectedGrant = $derived(sharedGrantPreview(cache.grants, selectedGrantId));

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
          <span class="mark">{company.mark}</span><span>{company.label}</span><span class="meta">vault</span>
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
              <span>{grant.companyMark} {grant.company}</span>
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
        <div class="tree">
          {#each mineFiles.filter((file) => matches(`${file.name} ${file.path}`)) as file (file.id)}
            <button
              type="button"
              class="frow"
              aria-current={selectedFile?.id === file.id ? "true" : undefined}
              onclick={() => (selectedFileId = file.id)}
            >
              <span>{file.name}</span><span class="meta">{file.meta}</span>
            </button>
          {/each}
        </div>
        {#if selectedFile}
          {@render preview(selectedFile.name, selectedFile.path, selectedFile.meta, selectedFile.preview, null)}
        {/if}
      </div>
    {/if}
  </main>
</div>

{#snippet preview(name: string, path: string, meta: string, text: string, grant: SharedGrant | null)}
  <div class="preview" data-testid="library-preview">
    <div class="ph">
      <b data-testid="library-preview-name">{name}</b>
      <span class="meta">{meta}</span>
    </div>
    {#if adapter?.files && typeof adapter.files.getFileContent === "function"}
      <FilePreviewPane {adapter} {path} />
    {/if}
    <pre data-testid="library-file-preview">{text}</pre>
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
    grid-template-columns: 240px minmax(0, 1fr);
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
  .mark { font-size: 10px; width: 18px; }
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
  .ph { display: flex; flex-wrap: wrap; gap: 6px 10px; margin-bottom: 8px; }
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
</style>
