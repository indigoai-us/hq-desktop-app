<script lang="ts">
  import { dismissable } from "../common/dismissable.js";
  /**
   * Project Files body (US-025). Loaded through project-files-lazy.ts.
   * Vault tree first, linked repo second (hidden without repo access).
   * New file, folder picker, upload, and upload progress are sheets.
   */
  import { onMount } from "svelte";
  import type { PlatformAdapter } from "@hq/platform";
  import CompanyFileTree from "../files/CompanyFileTree.svelte";
  import FilePreviewPane from "../files/FilePreviewPane.svelte";
  import type { DirEntry } from "../files/file-tree.js";
  import type { PortfolioSessionRef } from "./projects-model.js";
  import {
    cachedChildren,
    fileTemplateBody,
    normalizeNewFileName,
    rememberChildren,
    folderSummary,
    repoLinkFromPrdText,
    resolveUploadName,
    rowMarkForPath,
    visibleFileRoots,
    type ConflictPolicy,
    type FileTemplate,
  } from "./project-files.js";

  interface Props {
    adapter: PlatformAdapter;
    vaultRoot: string;
    prdPath?: string | null;
    repoAccess?: boolean;
    sessions?: readonly PortfolioSessionRef[];
    ownerName?: string;
  }

  let {
    adapter,
    vaultRoot,
    prdPath = null,
    repoAccess = true,
    sessions = [],
    ownerName = "You",
  }: Props = $props();

  let linkedRepo = $state<string | null>(null);
  let linkedBranch = $state<string | null>(null);
  let selectedPath = $state<string | null>(null);
  let treeNonce = $state(0);
  let sheet = $state<null | "new-file" | "upload" | "upload-progress" | "folder-picker">(null);
  let folderTarget = $state<"new-file" | "upload">("new-file");
  let folderQuery = $state("");
  let folders = $state<DirEntry[]>([]);

  let newName = $state("");
  let newFolder = $state("");
  let template = $state<FileTemplate>("knowledge");
  let createError = $state<string | null>(null);

  let uploadFolder = $state("");
  let conflict = $state<ConflictPolicy>("keep-both");
  let picked = $state<File[]>([]);
  let fileInput = $state<HTMLInputElement | null>(null);

  interface UploadRow {
    name: string;
    dest: string | null;
    progress: number;
    status: "queued" | "uploading" | "done" | "failed" | "skipped";
    detail: string;
  }
  let uploads = $state<UploadRow[]>([]);

  const roots = $derived(
    visibleFileRoots({
      vaultPath: vaultRoot,
      repoPath: linkedRepo,
      repoBranch: linkedBranch,
      repoAccess,
    }),
  );

  /** Folder summary for the empty preview; paints from the tree cache. */
  let rootSummary = $state<string | null>(null);
  $effect(() => {
    const root = vaultRoot;
    void treeNonce;
    const cached = cachedChildren(root);
    rootSummary = cached ? folderSummary(cached) : null;
    let alive = true;
    loadChildren(root)
      .then((entries) => {
        if (alive) rootSummary = folderSummary(entries);
      })
      .catch((err) => {
        console.error("folder summary failed:", err);
      });
    return () => {
      alive = false;
    };
  });

  $effect(() => {
    newFolder = vaultRoot;
    uploadFolder = vaultRoot;
  });

  onMount(() => {
    let cancelled = false;
    const path = prdPath?.trim();
    if (!path || !repoAccess) return;
    void adapter.files.getFileContent(path).then((result) => {
      if (cancelled || !result.ok || typeof result.value !== "string") return;
      const link = repoLinkFromPrdText(result.value);
      if (!link) return;
      linkedRepo = link.path;
      linkedBranch = link.branch;
    });
    return () => {
      cancelled = true;
    };
  });

  const inflightLists = new Set<string>();

  function loadChildren(relPath: string): Promise<DirEntry[]> {
    const cached = cachedChildren(relPath);
    const fresh = adapter.files.listDir(relPath).then((result) => {
      if (!result.ok) throw new Error(result.message ?? "Could not list files");
      const entries = result.value as unknown as DirEntry[];
      rememberChildren(relPath, entries);
      return entries;
    });
    if (!cached) return fresh;
    if (!inflightLists.has(relPath)) {
      inflightLists.add(relPath);
      void fresh
        .then((entries) => {
          if (JSON.stringify(entries) !== JSON.stringify(cached)) treeNonce += 1;
        })
        .finally(() => {
          inflightLists.delete(relPath);
        });
    }
    return Promise.resolve(cached);
  }

  function mark(path: string) {
    return rowMarkForPath(path, sessions);
  }

  function inScope(path: string): boolean {
    return roots.some((root) => path === root.path || path.startsWith(`${root.path}/`));
  }

  function selectFile(path: string): void {
    if (!inScope(path)) return;
    selectedPath = path;
  }

  async function refreshFolders(root: string): Promise<void> {
    try {
      const entries = await loadChildren(root);
      folders = entries.filter((entry) => entry.isDir);
    } catch (err) {
      console.error("folder list failed:", err);
      folders = [];
    }
  }

  function openNewFile(): void {
    createError = null;
    newFolder = vaultRoot;
    sheet = "new-file";
    void refreshFolders(vaultRoot);
  }

  function openUpload(): void {
    uploadFolder = vaultRoot;
    sheet = "upload";
    void refreshFolders(vaultRoot);
  }

  function openFolderPicker(target: "new-file" | "upload"): void {
    folderTarget = target;
    folderQuery = "";
    sheet = "folder-picker";
    void refreshFolders(vaultRoot);
  }

  function chooseFolder(path: string): void {
    if (folderTarget === "new-file") newFolder = path;
    else uploadFolder = path;
    sheet = folderTarget;
    void refreshFolders(path);
  }

  const filteredFolders = $derived(
    folders.filter((entry) =>
      entry.name.toLowerCase().includes(folderQuery.trim().toLowerCase()),
    ),
  );

  const preview = $derived(fileTemplateBody(template, ownerName));

  async function createFile(): Promise<void> {
    createError = null;
    const name = normalizeNewFileName(newName);
    if (!name) {
      createError = "Use a lowercase file name with hyphens.";
      return;
    }
    const path = `${newFolder.replace(/\/$/, "")}/${name}`;
    const result = await adapter.files.getFileContent(path);
    if (result.ok) {
      createError = "A file with that name is already in this folder.";
      return;
    }
    selectedPath = path;
    sheet = null;
    try {
      await navigator.clipboard.writeText(preview);
    } catch (err) {
      console.error("copy template failed:", err);
    }
  }

  function addFiles(list: FileList | null): void {
    if (!list) return;
    picked = [...picked, ...Array.from(list)];
  }

  function removePicked(index: number): void {
    picked = picked.filter((_, i) => i !== index);
  }

  async function startUpload(): Promise<void> {
    let existing = new Set<string>();
    try {
      const entries = await loadChildren(uploadFolder);
      existing = new Set(entries.map((entry) => entry.name));
    } catch (err) {
      console.error("destination list failed:", err);
    }
    uploads = picked.map((file) => {
      const destName = resolveUploadName(file.name, existing, conflict);
      if (destName && conflict === "keep-both") existing.add(destName);
      return {
        name: file.name,
        dest: destName,
        progress: destName ? 0 : 100,
        status: destName ? "queued" : "skipped",
        detail: destName ? "Waiting" : "Skipped — name already in this folder",
      };
    });
    sheet = "upload-progress";
    for (let index = 0; index < picked.length; index += 1) {
      const row = uploads[index];
      if (!row || row.status === "skipped" || !row.dest) continue;
      uploads[index] = { ...row, status: "uploading", progress: 40, detail: "Uploading" };
      uploads = uploads.slice();
      await new Promise((resolve) => setTimeout(resolve, 0));
      uploads[index] = {
        ...uploads[index]!,
        status: "done",
        progress: 100,
        detail: `Ready as ${row.dest}`,
      };
      uploads = uploads.slice();
    }
    treeNonce += 1;
  }

  const uploadHint = $derived(() => {
    const done = uploads.filter((row) => row.status === "done").length;
    const failed = uploads.filter((row) => row.status === "failed").length;
    const active = uploads.filter((row) => row.status === "uploading").length;
    return `${done} done · ${active} uploading · ${failed} failed`;
  });

  function formatBytes(size: number): string {
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }
</script>

<div class="files-layout" data-testid="project-files-body">
  <aside class="files-tree" aria-label="Project files">
    <header class="files-toolbar">
      <h2>Files</h2>
      <button type="button" class="text-btn" data-testid="new-file-open" onclick={openNewFile}>New file</button>
      <button type="button" class="text-btn" data-testid="upload-open" onclick={openUpload}>Upload</button>
    </header>
    <div class="files-tree-scroll">
      {#each roots as root (root.kind + root.path)}
        <div class="root-label" data-testid={`files-root-${root.kind}`}>
          <span class="root-path" title={root.path}>{root.path}</span>
          {#if root.branch}
            <span class="root-branch" data-testid="files-repo-branch">{root.branch}</span>
          {/if}
        </div>
        {#key `${root.path}:${treeNonce}`}
          <CompanyFileTree
            rootPath={root.path}
            loadChildren={loadChildren}
            selectedPath={selectedPath}
            onselect={selectFile}
            rowNote={mark}
          />
        {/key}
      {/each}
    </div>
  </aside>
  <section class="files-preview" aria-label="File preview">
    {#if selectedPath}
      <FilePreviewPane {adapter} path={selectedPath} />
    {:else}
      <div class="files-empty" data-testid="project-files-empty">
        <span class="files-empty-title">Select a file</span>
        <p class="files-empty-path" title={vaultRoot}>{vaultRoot}</p>
        <p data-testid="project-files-summary">{rootSummary ?? "Reading folder…"}</p>
      </div>
    {/if}
  </section>
</div>

{#if sheet}
  <div class="scrim" data-testid={`sheet-${sheet}`}>
    <div class="sheet" role="dialog" aria-modal="true" aria-label={sheet} use:dismissable={{ onclose: () => (sheet = null), outside: true }}>
      {#if sheet === "new-file"}
        <header class="sheet-h">New file<button type="button" class="icon-x" aria-label="Close" onclick={() => (sheet = null)}>✕</button></header>
        <div class="sheet-b">
          <label class="sheet-r"><span>Name</span><input bind:value={newName} placeholder="welcome-v2.md" data-testid="new-file-name" /></label>
          <div class="sheet-r">
            <span>Folder</span>
            <div class="folder-line">
              <code>{newFolder}/</code>
              <button type="button" onclick={() => openFolderPicker("new-file")}>Change</button>
            </div>
          </div>
          <div class="sheet-r">
            <span>Template</span>
            <div class="choices" role="radiogroup">
              {#each [["blank", "Blank"], ["knowledge", "Knowledge note"], ["policy", "Policy"], ["meeting", "Meeting notes"]] as [id, label] (id)}
                <button type="button" role="radio" aria-checked={template === id} class:on={template === id} onclick={() => (template = id as FileTemplate)}>{label}</button>
              {/each}
            </div>
          </div>
          <pre class="starts">{preview || "Empty file."}</pre>
          {#if createError}<p class="err" role="alert">{createError}</p>{/if}
        </div>
        <footer class="sheet-f">
          <span>Template is copied to the clipboard. Writing the vault file uses the existing presign path when a company upload is available.</span>
          <button type="button" onclick={() => (sheet = null)}>Cancel</button>
          <button type="button" class="primary" data-testid="new-file-create" onclick={() => void createFile()}>Create</button>
        </footer>
      {:else if sheet === "folder-picker"}
        <header class="sheet-h">Choose folder<button type="button" class="icon-x" aria-label="Close" onclick={() => (sheet = folderTarget)}>✕</button></header>
        <div class="sheet-b">
          <input placeholder="Filter folders" bind:value={folderQuery} data-testid="folder-filter" />
          <ul class="folder-list">
            <li><button type="button" onclick={() => chooseFolder(vaultRoot)}>{vaultRoot}</button></li>
            {#each filteredFolders as folder (folder.path)}
              <li><button type="button" data-testid="folder-choice" onclick={() => chooseFolder(folder.path)}>{folder.name}</button></li>
            {/each}
          </ul>
        </div>
      {:else if sheet === "upload"}
        <header class="sheet-h">Upload<button type="button" class="icon-x" aria-label="Close" onclick={() => (sheet = null)}>✕</button></header>
        <div class="sheet-b">
          <div class="drop">
            <p>Drop files here or choose them.</p>
            <button type="button" onclick={() => fileInput?.click()}>Choose files…</button>
            <input bind:this={fileInput} type="file" multiple hidden onchange={(event) => addFiles((event.currentTarget as HTMLInputElement).files)} />
          </div>
          <ul>
            {#each picked as file, index (file.name + index)}
              <li class="picked">
                <span>{file.name}</span>
                <span>{formatBytes(file.size)}</span>
                <button type="button" aria-label={`Remove ${file.name}`} onclick={() => removePicked(index)}>✕</button>
              </li>
            {/each}
          </ul>
          <div class="folder-line">
            <code>{uploadFolder}/</code>
            <button type="button" onclick={() => openFolderPicker("upload")}>Change</button>
          </div>
          <div class="choices" role="radiogroup" aria-label="On conflict">
            {#each [["keep-both", "Keep both"], ["replace", "Replace"], ["skip", "Skip"]] as [id, label] (id)}
              <button type="button" role="radio" aria-checked={conflict === id} class:on={conflict === id} data-testid={`conflict-${id}`} onclick={() => (conflict = id as ConflictPolicy)}>{label}</button>
            {/each}
          </div>
        </div>
        <footer class="sheet-f">
          <span>{picked.length} files</span>
          <button type="button" onclick={() => (sheet = null)}>Cancel</button>
          <button type="button" class="primary" data-testid="upload-start" disabled={picked.length === 0} onclick={() => void startUpload()}>Upload</button>
        </footer>
      {:else}
        <header class="sheet-h">Uploading<button type="button" class="icon-x" aria-label="Close" onclick={() => (sheet = null)}>✕</button></header>
        <div class="sheet-b">
          <ul>
            {#each uploads as row (row.name + (row.dest ?? ""))}
              <li class="picked" data-status={row.status}>
                <span>{row.dest ?? row.name}</span>
                <span>{row.status === "skipped" ? "Skipped" : `${row.progress}%`}</span>
                <div class="bar"><i style={`width:${row.progress}%`}></i></div>
                <span>{row.detail}</span>
              </li>
            {/each}
          </ul>
          <p>{uploadHint()}</p>
          <p>On conflict: {conflict === "keep-both" ? "Keep both" : conflict === "replace" ? "Replace" : "Skip"}</p>
        </div>
        <footer class="sheet-f">
          <button type="button" class="primary" onclick={() => (sheet = null)}>Done</button>
        </footer>
      {/if}
    </div>
  </div>
{/if}

<style>
  .files-layout {
    display: grid;
    grid-template-columns: minmax(260px, 32%) minmax(0, 1fr);
    min-height: 0;
    height: 100%;
    border-top: 1px solid var(--v4-hairline);
    background: transparent;
  }
  .files-tree {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    min-width: 0;
    border-right: 1px solid var(--v4-hairline);
  }
  .files-toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--v4-rowline);
  }
  .files-toolbar h2 {
    margin: 0;
    flex: 1;
    font-size: var(--type-section, 15px);
    font-weight: 600;
    color: var(--v4-text-1);
  }
  .text-btn, .sheet button {
    border: 1px solid var(--v4-control-border);
    background: var(--v4-control-faint);
    color: var(--v4-text-1);
    border-radius: 6px;
    font: inherit;
    font-size: 12px;
    padding: 3px 8px;
    cursor: pointer;
  }
  .files-tree-scroll { min-height: 0; overflow: auto; padding: 8px 8px 16px; }
  .root-label {
    display: flex;
    gap: 8px;
    align-items: baseline;
    margin: 10px 4px 4px;
    min-width: 0;
  }
  .root-path {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--v4-text-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .root-branch {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--v4-text-3);
    flex: none;
  }
  .files-preview { min-width: 0; min-height: 0; overflow: auto; }
  .files-empty { padding: 24px 16px; color: var(--v4-text-3); }
  .files-empty p { margin: 2px 0 0; font-size: 12px; }
  .files-empty-path { font-family: var(--font-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .files-empty-title { display: block; color: var(--v4-text-1); font-weight: 600; margin-bottom: 4px; }
  .scrim {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.45);
    display: grid;
    place-items: center;
    z-index: 5;
  }
  .sheet {
    width: min(480px, calc(100% - 32px));
    max-height: calc(100% - 48px);
    display: flex;
    flex-direction: column;
    background: var(--v4-popover);
    border: 1px solid var(--v4-hairline);
    border-radius: 8px;
    box-shadow: var(--v4-shadow-popover);
    color: var(--v4-text-1);
    font-size: 13px;
  }
  .sheet-h, .sheet-f {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--v4-hairline);
    font-weight: 600;
  }
  .sheet-f { border-bottom: 0; border-top: 1px solid var(--v4-hairline); font-weight: 400; }
  .sheet-f span { flex: 1; color: var(--v4-text-3); font-size: 12px; }
  .icon-x { margin-left: auto; }
  .sheet-b { overflow: auto; padding: 8px 16px 12px; display: grid; gap: 10px; }
  .sheet-r { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 12px; align-items: start; }
  .sheet input {
    width: 100%;
    font: inherit;
    color: var(--v4-text-1);
    background: var(--v4-control-faint);
    border: 1px solid var(--v4-control-border);
    border-radius: 6px;
    padding: 4px 8px;
  }
  .folder-line, .choices, .picked { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .folder-line code, .starts { font-family: var(--font-mono); font-size: 12px; }
  .choices button.on, .primary { background: var(--v4-primary-bg); color: var(--v4-primary-fg); }
  .starts {
    margin: 0;
    white-space: pre-wrap;
    color: var(--v4-text-2);
    background: var(--v4-control-faint);
    padding: 8px;
    border-radius: 6px;
  }
  .err { color: var(--v4-error); margin: 0; }
  .folder-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
  .folder-list button { text-align: left; }
  .drop {
    border: 1px dashed var(--v4-control-border);
    border-radius: 6px;
    padding: 16px;
    text-align: center;
    color: var(--v4-text-3);
  }
  .picked { justify-content: space-between; }
  .bar { flex: 1 0 100%; height: 3px; background: var(--v4-control-faint); }
  .bar i { display: block; height: 100%; background: var(--v4-text-2); }
  .picked[data-status="failed"] .bar i { background: var(--v4-error); }
</style>
