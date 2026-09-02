<script lang="ts">
  /**
   * The global destination for file-share notifications. Share events do not
   * carry a company UID, so this surface intentionally lists only the server
   * granted share metadata. It never guesses a company, a local path, or a
   * presigned URL; file preview remains in a company-scoped project channel.
   */
  import type { PlatformAdapter } from "@hq/platform";
  import PageHeader from "../shell/PageHeader.svelte";

  interface ShareEvent {
    id: string;
    issuer: string;
    paths: string[];
    createdAt: string;
  }

  interface Props {
    adapter: {
      notifications: Pick<PlatformAdapter["notifications"], "fetchSharedWithMe">;
    };
    onback?: () => void;
  }

  let { adapter, onback }: Props = $props();
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
    void load();
  });
</script>

<section class="shared-files" aria-label="Shared files" data-testid="shared-files-overlay">
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
      <button type="button" data-testid="shared-files-retry" onclick={() => void load()}>Retry</button>
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
        >{loadingMore ? "Loading…" : "Load more"}</button>
      </div>
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
</style>
