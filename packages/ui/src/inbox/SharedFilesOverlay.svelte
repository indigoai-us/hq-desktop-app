<script lang="ts">
  import RailIcon from "../common/button/RailIcon.svelte";
  /**
   * The global destination for file-share notifications. Share events do not
   * carry a company UID, so this surface intentionally lists only the server
   * granted share metadata. It never guesses a company, a local path, or a
   * presigned URL; file preview remains in a company-scoped project channel.
   */
  import { API_ERROR_COPY, classifyApiError, type PlatformAdapter } from "@hq/platform";
  import PageHeader from "../shell/PageHeader.svelte";
  import CompanyLabel from "../company/CompanyLabel.svelte";
  import { parseListPage } from "../shell/vault-list-page.js";
  import { sharedFolderEntries, type SharedFolderEntry } from "../files/explorer/vault-model.js";
  import type { SharedFolderFocus } from "../shell/navigation-history.js";

  /** Pages of `GET /v1/files/list` read for one shared folder before the list stops. */
  const SHARED_FOLDER_MAX_PAGES = 10;
  /**
   * A whole-company share (`prefix === ""`) lists from the vault root, where
   * each page can hold thousands of keys and the view only needs the
   * top-level names. Every page is one request against the hourly files
   * rate limit, so the root listing stops sooner.
   */
  const SHARED_ROOT_MAX_PAGES = 3;

  /** Why a folder listing could not be shown; `retry` says whether trying again can help. */
  type FolderListError = { message: string; retry: boolean };
  const FOLDER_LIST_DENIED: FolderListError = { message: API_ERROR_COPY.forbidden, retry: false };
  const FOLDER_LIST_RATE_LIMITED: FolderListError = {
    message: "You've opened a lot of folders in a short time. Wait a few minutes and open it again.",
    retry: false,
  };
  const FOLDER_LIST_FAILED: FolderListError = {
    message: "Couldn't list this folder. Check your connection and try again.",
    retry: true,
  };
  const FOLDER_LIST_UNSUPPORTED: FolderListError = { message: "This folder can't be listed from here.", retry: false };
  const RATE_LIMITED = /rate.?limit|too many/i;
  const DENIED = /denied|forbidden|membership|unauthori[sz]ed|not a member/i;

  /** Map a failed listing result to product copy. The code and reason never reach the DOM. */
  function classifyFolderListFailure(res: { code?: string | null; reason?: string | null; message?: string | null }): FolderListError {
    const code = res.code ?? "";
    const text = [code, res.reason ?? "", res.message ?? ""].join(" ");
    if (code === "http-429" || RATE_LIMITED.test(text)) return FOLDER_LIST_RATE_LIMITED;
    const kind = classifyApiError({ code, message: res.message ?? null });
    if (kind === "forbidden" || kind === "signedOut" || DENIED.test(text)) return FOLDER_LIST_DENIED;
    return FOLDER_LIST_FAILED;
  }

  interface ShareEvent {
    id: string;
    issuer: string;
    paths: string[];
    createdAt: string;
  }

  interface Props {
    adapter: {
      notifications: Pick<PlatformAdapter["notifications"], "fetchSharedWithMe">;
      /** ACL-filtered vault listing; absent on hosts without it. */
      files?: Partial<Pick<PlatformAdapter["files"], "listVaultPrefix">> | null;
    };
    /**
     * A DM folder share whose company is not synced on this computer. The view
     * then lists that folder from the vault (names only, no preview or
     * download) and says which company to sync to open it in Files.
     */
    folder?: SharedFolderFocus | null;
    onback?: () => void;
  }

  let { adapter, folder = null, onback }: Props = $props();
  let folderLoading = $state(false);
  let folderEntries = $state<SharedFolderEntry[]>([]);
  let folderError = $state<FolderListError | null>(null);
  let folderTruncated = $state(false);

  const folderName = $derived.by(() => {
    const prefix = folder?.prefix ?? "";
    return prefix.split("/").filter(Boolean).pop() || folder?.companyLabel || "Shared folder";
  });
  /** The company-relative folder path, as the share names it. */
  const folderPath = $derived(folder ? folder.prefix || "/" : "");
  const folderSyncNote = $derived(
    folder ? `${folder.companyLabel} isn't synced on this Mac yet. Sync it to open this folder in Files.` : "",
  );

  async function loadFolder(focus: SharedFolderFocus): Promise<void> {
    const list = adapter.files?.listVaultPrefix;
    folderLoading = true;
    folderError = null;
    folderTruncated = false;
    folderEntries = [];
    if (!list) {
      folderLoading = false;
      folderError = FOLDER_LIST_UNSUPPORTED;
      return;
    }
    const maxPages = focus.prefix === "" ? SHARED_ROOT_MAX_PAGES : SHARED_FOLDER_MAX_PAGES;
    try {
      const keys: string[] = [];
      let cursor: string | undefined;
      let truncated = false;
      for (let page = 0; ; page += 1) {
        if (page >= maxPages) {
          truncated = true;
          break;
        }
        const res = await list(focus.companyUid, focus.prefix, cursor);
        if (!res.ok) {
          if (focus === folder) folderError = classifyFolderListFailure(res);
          return;
        }
        const parsed = parseListPage(res.value);
        for (const obj of parsed.objects) keys.push(obj.key);
        if (!parsed.cursor) break;
        cursor = parsed.cursor;
      }
      if (focus !== folder) return;
      folderEntries = sharedFolderEntries(focus.prefix, keys);
      folderTruncated = truncated;
    } catch {
      if (focus !== folder) return;
      folderError = FOLDER_LIST_FAILED;
    } finally {
      if (focus === folder) folderLoading = false;
    }
  }
  let loading = $state(true);
  let events = $state<ShareEvent[]>([]);
  let error = $state<string | null>(null);
  let nextCursor = $state<string | null>(null);
  let loadingMore = $state(false);
  let loadMoreError = $state<string | null>(null);

  function record(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }

  function strings(value: unknown): string[] {
    return Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
      : [];
  }

  function parsePage(value: unknown): { events: ShareEvent[]; nextCursor: string | null } {
    const body = record(value);
    const rawEvents = Array.isArray(body?.events) ? body.events : [];
    const events = rawEvents.flatMap((entry) => {
      const row = record(entry);
      const id = typeof row?.eventId === "string" ? row.eventId.trim() : "";
      if (!id) return [];
      return [{
        id,
        issuer:
          (typeof row?.issuerDisplayName === "string" && row.issuerDisplayName.trim()) ||
          (typeof row?.issuerEmail === "string" && row.issuerEmail.trim()) ||
          "Someone",
        paths: strings(row?.paths),
        createdAt: typeof row?.createdAt === "string" ? row.createdAt : "",
      }];
    });
    const cursor = body?.nextCursor ?? body?.next_cursor;
    return {
      events,
      nextCursor: typeof cursor === "string" && cursor.trim() ? cursor : null,
    };
  }

  function appendEvents(current: ShareEvent[], next: ShareEvent[]): ShareEvent[] {
    const ids = new Set(current.map((event) => event.id));
    return [...current, ...next.filter((event) => !ids.has(event.id))];
  }

  function fileName(path: string): string {
    return path.split("/").filter(Boolean).pop() || "Shared file";
  }

  async function load(): Promise<void> {
    loading = true;
    error = null;
    loadMoreError = null;
    nextCursor = null;
    try {
      const result = await adapter.notifications.fetchSharedWithMe({ limit: 50 });
      if (!result.ok) {
        error = "Couldn't load shared files. Check your connection and try again.";
        events = [];
        return;
      }
      const page = parsePage(result.value);
      events = page.events;
      nextCursor = page.nextCursor;
    } catch {
      error = "Couldn't load shared files. Check your connection and try again.";
      events = [];
    } finally {
      loading = false;
    }
  }

  async function loadMore(): Promise<void> {
    const cursor = nextCursor;
    if (!cursor || loadingMore) return;
    loadingMore = true;
    loadMoreError = null;
    try {
      const result = await adapter.notifications.fetchSharedWithMe({ limit: 50, cursor });
      if (!result.ok) {
        loadMoreError = "Couldn't load more shared files. Check your connection and try again.";
        return;
      }
      const page = parsePage(result.value);
      events = appendEvents(events, page.events);
      nextCursor = page.nextCursor;
    } catch {
      loadMoreError = "Couldn't load more shared files. Check your connection and try again.";
    } finally {
      loadingMore = false;
    }
  }

  $effect(() => {
    const focus = folder;
    if (focus) void loadFolder(focus);
    else void load();
  });
</script>

<section class="shared-files" aria-label="Shared files" data-testid="shared-files-overlay">
  {#if folder}
    <PageHeader
      title={folderName}
      titleTestId="shared-folder-title"
      backTestId="shared-files-back"
      onback={() => onback?.()}
      variant="embedded"
    >
      <span class="shared-folder-scope" data-testid="shared-folder-scope"
        >Shared from <CompanyLabel name={folder.companyLabel} companyUid={folder.companyUid} /> · <span
          class="shared-folder-path">{folderPath}</span></span
      >
    </PageHeader>
    <p class="shared-files-status shared-folder-note" data-testid="shared-folder-sync-note" role="note">
      {folderSyncNote}
    </p>
    {#if folderLoading}
      <p class="shared-files-status" data-testid="shared-folder-loading" role="status">Listing folder…</p>
    {:else if folderError}
      <div class="shared-files-status" data-testid="shared-folder-error" role="alert">
        <p>{folderError.message}</p>
        {#if folderError.retry}
          <button type="button" data-testid="shared-folder-retry" onclick={() => { if (folder) void loadFolder(folder); }}><RailIcon name="refresh" />Retry</button>
        {/if}
      </div>
    {:else if folderEntries.length === 0}
      <p class="shared-files-status" data-testid="shared-folder-empty" role="status">This folder is empty, or nothing in it is shared with you.</p>
    {:else}
      <ul class="shared-files-list shared-folder-list" aria-label="Shared folder contents">
        {#each folderEntries as entry (`${entry.isDir ? "d" : "f"}:${entry.name}`)}
          <li data-testid="shared-folder-entry" data-kind={entry.isDir ? "folder" : "file"}>
            <RailIcon name={entry.isDir ? "folder" : "file"} />
            <span class="shared-file-name">{entry.isDir ? `${entry.name}/` : entry.name}</span>
          </li>
        {/each}
      </ul>
      {#if folderTruncated}
        <p class="shared-files-status" data-testid="shared-folder-truncated" role="status">
          Showing the first part of a large folder. Sync {folder.companyLabel} to see everything.
        </p>
      {/if}
    {/if}
  {:else}
  <PageHeader
    title="Shared files"
    subtitle="Files are shown from share-scoped notifications. Open a company project to preview a file."
    subtitleTestId="shared-files-scope"
    backTestId="shared-files-back"
    onback={() => onback?.()}
    variant="embedded"
  />

  {#if loading}
    <p class="shared-files-status" data-testid="shared-files-loading" role="status">Loading shared files…</p>
  {:else if error}
    <div class="shared-files-status" data-testid="shared-files-error" role="alert">
      <p>{error}</p>
      <button type="button" data-testid="shared-files-retry" onclick={() => void load()}><RailIcon name="refresh" />Retry</button>
    </div>
  {:else if events.length === 0}
    <p class="shared-files-status" data-testid="shared-files-empty" role="status">No files have been shared with you yet.</p>
  {:else}
    <ul class="shared-files-list" aria-label="Shared file events">
      {#each events as event (event.id)}
        <li data-testid="shared-files-event">
          <strong>{event.issuer}</strong>
          {#if event.paths.length === 0}
            <span> shared files with you.</span>
          {:else}
            <span> shared </span>
            {#each event.paths as path, index (path)}
              {#if index > 0}, {/if}<span class="shared-file-name" title={path}>{fileName(path)}</span>
            {/each}
            <span>.</span>
          {/if}
        </li>
      {/each}
    </ul>
    {#if loadMoreError}
      <p class="shared-files-status" data-testid="shared-files-load-more-error" role="alert">
        {loadMoreError}
      </p>
    {/if}
    {#if nextCursor}
      <div class="shared-files-status">
        <button
          type="button"
          data-testid="shared-files-load-more"
          disabled={loadingMore}
          aria-busy={loadingMore}
          onclick={() => void loadMore()}
        ><RailIcon name="chevron-down" />{loadingMore ? "Loading…" : "Load more"}</button>
      </div>
    {/if}
  {/if}
  {/if}
</section>

<style>
  .shared-files {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: auto;
    color: var(--t1);
    background: var(--v4-bg, var(--desktop-bg, #0c0c0c));
  }
  .shared-files-status button { border: 1px solid var(--line2); border-radius: 6px; padding: 5px 9px; background: transparent; color: inherit; font: inherit; cursor: pointer; }
  .shared-files-status, .shared-files-list { max-width: 760px; margin: 16px auto 24px; padding: 0 20px; }
  .shared-files-status { color: var(--t2); }
  .shared-files-list { display: grid; gap: 8px; padding: 0; list-style: none; }
  .shared-files-list li { padding: 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--raised); }
  .shared-file-name { color: var(--t1); font-family: var(--font-mono, ui-monospace, monospace); }
  .shared-folder-note { margin-bottom: 0; }
  .shared-folder-scope { display: inline-flex; align-items: center; gap: 4px; min-width: 0; color: var(--t2); font-size: 12px; white-space: nowrap; }
  .shared-folder-path { overflow: hidden; text-overflow: ellipsis; font-family: var(--font-mono, ui-monospace, monospace); }
  .shared-folder-list li { display: flex; align-items: center; gap: 8px; }
</style>
