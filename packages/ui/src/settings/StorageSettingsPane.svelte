<script lang="ts">
  /**
   * Settings › Storage — how much disk HQ backups use, and deleting old ones.
   *
   * Reads `hq storage status --json` and prunes with `hq storage prune` via
   * the desktop-only `adapter.storage` group. Every delete is previewed first
   * (dry run) and needs an explicit confirm. Copy stays plain; raw CLI errors
   * never reach the screen.
   */
  import { onMount } from "svelte";
  import type {
    PlatformAdapter,
    StoragePruneRequest,
    StoragePruneResult,
    StorageStatus,
  } from "@hq/platform";
  import RailButton from "../common/button/RailButton.svelte";
  import ConfirmDialog from "../common/ConfirmDialog.svelte";
  import CompanyLabel from "../company/CompanyLabel.svelte";
  import ReadLoader from "../common/ReadLoader.svelte";
  import UnavailableNote from "../common/UnavailableNote.svelte";
  import { formatBytes } from "../common/sync-model.js";
  import {
    UPDATE_HQ_CODE,
    isBandSelected,
    isProtectedBand,
    pruneRequests,
    selectedBytes,
    storageErrorCopy,
    toggleBand,
    type BandCutoff,
    type StorageBand,
  } from "./storage-model.js";

  interface Props {
    adapter?: PlatformAdapter | null;
  }

  let { adapter = null }: Props = $props();

  type Phase = "idle" | "previewing" | "confirm" | "deleting" | "done";

  let status = $state<StorageStatus | null>(null);
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let localCutoff = $state<BandCutoff>(null);
  let cloudCutoffs = $state<Record<string, BandCutoff>>({});
  let phase = $state<Phase>("idle");
  let preview = $state<{ bytes: number; lines: string[] } | null>(null);
  let actionError = $state<string | null>(null);
  let result = $state<{ freed: number; errors: string[] } | null>(null);

  const api = $derived(adapter?.storage ?? null);

  const localBands = $derived<StorageBand[]>(
    (status?.local.tranches ?? []).map((t) => ({
      id: t.id,
      label: t.label,
      count: t.commit_count,
      bytes: t.est_bytes,
      to: t.to ?? null,
    })),
  );

  const cloudEntries = $derived(
    (status?.cloud ?? []).map((c) => ({
      ...c,
      bands: (c.tranches ?? []).map<StorageBand>((t) => ({
        id: t.id,
        label: t.label,
        count: t.count,
        bytes: t.bytes,
      })),
    })),
  );

  const selectedTotal = $derived(
    selectedBytes(localBands, localCutoff) +
      cloudEntries.reduce(
        (sum, c) => sum + selectedBytes(c.bands, cloudCutoffs[c.company] ?? null),
        0,
      ),
  );

  function currentRequests(): StoragePruneRequest[] {
    return pruneRequests(
      { bands: localBands, cutoff: localCutoff },
      cloudEntries.map((c) => ({
        company: c.company,
        bands: c.bands,
        cutoff: cloudCutoffs[c.company] ?? null,
      })),
    );
  }

  async function load(): Promise<void> {
    if (!api) {
      loading = false;
      return;
    }
    loading = true;
    loadError = null;
    const res = await api.status();
    loading = false;
    if (res.ok) {
      status = res.value;
      localCutoff = null;
      cloudCutoffs = {};
    } else {
      console.error("storage status failed:", res.message);
      loadError = res.message ?? "error";
    }
  }

  function freedBytes(r: StoragePruneResult): number {
    return (
      (r.local?.freed_bytes ?? 0) +
      (r.cloud ?? []).reduce((sum, c) => sum + (c.freed_bytes ?? 0), 0)
    );
  }

  function describeRequest(req: StoragePruneRequest): string {
    if (req.localBefore) {
      return `Backups on this Mac from before ${req.localBefore}`;
    }
    return `Old file versions in ${req.company} from before ${req.cloudBefore}`;
  }

  async function startDelete(): Promise<void> {
    if (!api || phase !== "idle") return;
    const requests = currentRequests();
    if (requests.length === 0) return;
    phase = "previewing";
    actionError = null;
    result = null;
    let bytes = 0;
    const lines: string[] = [];
    for (const req of requests) {
      const res = await api.previewPrune(req);
      if (!res.ok) {
        console.error("storage prune preview failed:", res.message);
        actionError = res.message?.includes(UPDATE_HQ_CODE)
          ? "Update HQ to manage storage."
          : "We couldn't check what would be deleted. Try again in a moment.";
        phase = "idle";
        return;
      }
      const freed = freedBytes(res.value);
      bytes += freed;
      lines.push(`${describeRequest(req)} (about ${formatBytes(freed)})`);
    }
    preview = { bytes, lines };
    phase = "confirm";
  }

  async function confirmDelete(): Promise<void> {
    if (!api || phase !== "confirm") return;
    phase = "deleting";
    let freed = 0;
    const errors: string[] = [];
    for (const req of currentRequests()) {
      const res = await api.prune(req);
      const where = req.company ?? "this Mac";
      if (!res.ok) {
        console.error("storage prune failed:", res.message);
        errors.push(`${where}: couldn't delete. Try again later.`);
        continue;
      }
      freed += freedBytes(res.value);
      if (res.value.local?.error) errors.push("this Mac: some backups couldn't be deleted.");
      for (const c of res.value.cloud ?? []) {
        if (c.error) errors.push(`${c.company}: some old versions couldn't be deleted.`);
      }
    }
    result = { freed, errors };
    preview = null;
    phase = "done";
    await load();
    phase = "idle";
  }

  function cancelDelete(): void {
    preview = null;
    phase = "idle";
  }

  const confirmMessage = $derived(
    preview
      ? `${preview.lines.join(". ")}. This frees about ${formatBytes(preview.bytes)}. This can't be undone. You won't be able to restore these old versions.`
      : "",
  );

  onMount(() => {
    void load();
  });
</script>

<div class="storage-pane" data-testid="settings-storage-pane">
  {#if !api}
    <UnavailableNote
      label="Storage"
      message="Backup storage is managed from the HQ desktop app."
      testid="settings-storage-unavailable"
    />
  {:else if loading && !status}
    <ReadLoader onretry={() => void load()} testid="settings-storage-loading" />
  {:else if loadError && !status}
    <div class="set-row" data-testid="settings-storage-error" role="alert">
      <div><div class="sn">Storage</div><div class="sd">{storageErrorCopy(loadError)}</div></div>
      {#if !loadError.includes(UPDATE_HQ_CODE)}
        <RailButton icon="refresh" onclick={() => void load()}>Try again</RailButton>
      {/if}
    </div>
  {:else if status}
    <div class="set-row" data-testid="settings-storage-header">
      <div>
        <div class="sn" data-testid="settings-storage-total">
          HQ backups on this Mac: {status.local.available ? formatBytes(status.local.git_dir_bytes) : "unknown"}
        </div>
        <div class="sd">
          {#if status.local.available}
            Your HQ folder itself uses {formatBytes(status.local.working_tree_bytes)}.
          {:else}
            Update HQ to see your backup history.
          {/if}
        </div>
      </div>
      <RailButton
        icon="refresh"
        onclick={() => void load()}
        disabled={loading || phase !== "idle"}
        aria-busy={loading}
        data-testid="settings-storage-refresh"
      >{loading ? "Refreshing…" : "Refresh"}</RailButton>
    </div>

    <div class="set-subhead"><div class="sn">Local backup history</div>
      <div class="sd">HQ keeps a snapshot every time your files change. Older snapshots can be deleted to free space. The last 7 days are always kept.</div>
    </div>
    {#if !status.local.available}
      <div class="set-row unavailable" data-testid="settings-storage-local-unavailable">
        <div class="sd">Update HQ to manage backups on this Mac.</div>
      </div>
    {:else if localBands.length === 0}
      <div class="set-row"><div class="sd">No backup history yet.</div></div>
    {:else}
      <table class="bands" data-testid="settings-storage-local-table">
        <thead><tr><th></th><th>Age</th><th class="num">Snapshots</th><th class="num">Size</th></tr></thead>
        <tbody>
          {#each localBands as band, i (band.id)}
            {@const locked = isProtectedBand(band, i)}
            <tr class:locked>
              <td>
                <input
                  type="checkbox"
                  aria-label={`Delete ${band.label}`}
                  data-testid={`storage-local-band-${band.id}`}
                  checked={isBandSelected(localCutoff, i)}
                  disabled={locked || phase !== "idle"}
                  onchange={() => (localCutoff = toggleBand(localBands, localCutoff, i))}
                />
              </td>
              <td>{band.label}{#if locked}<span class="kept"> · always kept</span>{/if}</td>
              <td class="num">{band.count.toLocaleString()}</td>
              <td class="num">~{formatBytes(band.bytes)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}

    <div class="set-subhead"><div class="sn">Cloud file history</div>
      <div class="sd">Old versions of files your companies keep in the cloud. Current files are never touched.</div>
    </div>
    {#if cloudEntries.length === 0}
      <div class="set-row"><div class="sd">No cloud companies on this Mac.</div></div>
    {/if}
    {#each cloudEntries as entry (entry.company)}
      <div class="cloud-company" data-testid={`settings-storage-cloud-${entry.company}`}>
        <div class="set-row">
          <div>
            <div class="sn"><CompanyLabel name={entry.company} /></div>
            <div class="sd">
              {#if entry.available}
                {formatBytes(entry.noncurrent_bytes)} in {entry.noncurrent_count.toLocaleString()} old versions{#if entry.delete_markers > 0}, {entry.delete_markers.toLocaleString()} deleted-file markers{/if}
              {:else}
                We couldn't read this company's file history.
              {/if}
            </div>
          </div>
        </div>
        {#if entry.available && entry.bands.length > 0}
          {@const cutoff = cloudCutoffs[entry.company] ?? null}
          <table class="bands">
            <thead><tr><th></th><th>Age</th><th class="num">Old versions</th><th class="num">Size</th></tr></thead>
            <tbody>
              {#each entry.bands as band, i (band.id)}
                {@const locked = isProtectedBand(band, i)}
                <tr class:locked>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Delete ${entry.company} ${band.label}`}
                      data-testid={`storage-cloud-${entry.company}-band-${band.id}`}
                      checked={isBandSelected(cutoff, i)}
                      disabled={locked || phase !== "idle"}
                      onchange={() =>
                        (cloudCutoffs = {
                          ...cloudCutoffs,
                          [entry.company]: toggleBand(entry.bands, cutoff, i),
                        })}
                    />
                  </td>
                  <td>{band.label}{#if locked}<span class="kept"> · always kept</span>{/if}</td>
                  <td class="num">{band.count.toLocaleString()}</td>
                  <td class="num">~{formatBytes(band.bytes)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/if}
      </div>
    {/each}

    <div class="set-row actions">
      <div>
        <div class="sn" data-testid="settings-storage-free-up">
          {selectedTotal > 0 ? `Free up ~${formatBytes(selectedTotal)}` : "Nothing selected"}
        </div>
        {#if actionError}
          <div class="sd error" role="alert" data-testid="settings-storage-action-error">{actionError}</div>
        {/if}
        {#if phase === "deleting"}
          <div class="sd" role="status" data-testid="settings-storage-deleting">Deleting old backups. This can take a few minutes.</div>
        {/if}
        {#if result}
          <div class="sd" role="status" data-testid="settings-storage-result">
            Freed {formatBytes(result.freed)}.
            {#each result.errors as err (err)}<br />{err}{/each}
          </div>
        {/if}
      </div>
      <RailButton
        icon="trash"
        variant="danger"
        disabled={selectedTotal === 0 || phase !== "idle"}
        aria-busy={phase === "previewing" || phase === "deleting"}
        onclick={() => void startDelete()}
        data-testid="settings-storage-delete"
      >{phase === "previewing" ? "Checking…" : phase === "deleting" ? "Deleting…" : "Delete selected"}</RailButton>
    </div>
  {/if}
</div>

<ConfirmDialog
  open={phase === "confirm"}
  title="Delete old backups?"
  message={confirmMessage}
  confirmLabel="Delete"
  danger
  onconfirm={() => void confirmDelete()}
  oncancel={cancelDelete}
/>

<style>
  .storage-pane {
    display: flex;
    flex-direction: column;
    gap: 10px;
    max-width: 640px;
  }

  .set-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    border-top: 1px solid var(--line);
    padding: 14px 16px;
  }

  .set-row.unavailable {
    color: var(--t3);
  }

  .set-subhead {
    padding: 18px 16px 6px;
    border-top: 1px solid var(--line);
  }

  .sn {
    font-weight: 500;
    font-size: 13px;
    color: var(--t1);
  }

  .sd {
    margin-top: 2px;
    color: var(--t2);
    font-size: 12px;
    line-height: 1.45;
  }

  .sd.error {
    color: var(--v4-danger, #dcaaa0);
  }

  .bands {
    width: calc(100% - 32px);
    margin: 0 16px;
    border-collapse: collapse;
    font-size: 13px;
    color: var(--t1);
  }

  .bands th {
    text-align: left;
    font-weight: 500;
    font-size: 12px;
    color: var(--t3);
    padding: 6px 8px;
  }

  .bands td {
    padding: 8px;
    border-top: 1px solid var(--line);
  }

  .bands th:first-child,
  .bands td:first-child {
    width: 24px;
    padding-left: 0;
  }

  .bands .num {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  .bands tr.locked td {
    color: var(--t3);
  }

  .kept {
    color: var(--t3);
  }
</style>
