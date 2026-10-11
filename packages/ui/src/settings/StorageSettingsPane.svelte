<script lang="ts">
  /**
   * Settings › Storage — how much disk HQ backups use, and deleting old ones.
   *
   * Big files (top, the page's primary action): `hq storage offload` moves big
   * idle files and old copies of big files to HQ cloud and leaves `.hqcloud`
   * placeholders. Previewed with `--dry-run`, then confirmed in plain words.
   *
   * Reads `hq storage status --json` and prunes with `hq storage prune` via
   * the desktop-only `adapter.storage` group. Every delete is previewed first
   * (dry run) and needs an explicit confirm. Copy stays plain; raw CLI errors
   * never reach the screen.
   */
  import { onMount } from "svelte";
  import { hostComputerNoun, subscribeHostComputerNoun } from "@hq/platform";
  import type {
    PlatformAdapter,
    StorageOffloadResult,
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
    BIG_FILE_MB,
    IDLE_DAYS,
    OFFLOAD_CONFIRM_COPY,
    OFFLOAD_CURRENT_COPY,
    currentOffloadAvailable,
    offloadCandidates,
    offloadFreedBytes,
    offloadIncludesCurrent,
    offloadOutcome,
    offloadPreviewBlocker,
    offloadReclaimAfter,
    offloadSummary,
    offloadUnavailableCopy,
    CLOUD_ADMIN_ONLY_COPY,
    bookmarksCopy,
    canDeleteCloud,
    isPermissionError,
    refsToRemove,
    holderLabel,
    historyHeld,
    historyHeldCopy,
    holdersCopy,
    localTime,
    pruneConfirmCopy,
    pruneHolders,
    pruneOutcome,
    pruneReclaimAfter,
    rolesFromMemberships,
    isBandSelected,
    isProtectedBand,
    pruneRequests,
    prunedBytes,
    selectedBytes,
    storageErrorCopy,
    toggleBand,
    type BandCutoff,
    type StorageBand,
  } from "./storage-model.js";

  import type { StorageHoldingRef } from "@hq/platform";
  import { isStorageFeatureDisabled } from "./storage-feature.js";

  interface Props {
    adapter?: PlatformAdapter | null;
    /** Off where the host page already titles the section. */
    showHeading?: boolean;
    /** The CLI refused with `feature_disabled`: the host hides Storage. */
    onfeaturedisabled?: () => void;
  }

  let { adapter = null, showHeading = true, onfeaturedisabled }: Props = $props();
  /** Set when `hq storage` says the hq-storage flag is off for this person. */
  let featureDisabled = $state(false);

  /** "this Mac" / "this PC" / "this computer". */
  let hostNoun = $state(hostComputerNoun());
  const device = $derived(`this ${hostNoun}`);

  type Phase = "idle" | "previewing" | "confirm" | "deleting" | "done";

  let status = $state<StorageStatus | null>(null);
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let localCutoff = $state<BandCutoff>(null);
  let cloudCutoffs = $state<Record<string, BandCutoff>>({});
  let phase = $state<Phase>("idle");
  let preview = $state<{
    bytes: number;
    lines: string[];
    notes: string[];
    local: boolean;
    cloud: boolean;
    reclaimAfter: string | null;
  } | null>(null);
  let actionError = $state<string | null>(null);
  /** Branches or saved versions keeping old history, shown under the error. */
  let holders = $state<StorageHoldingRef[]>([]);
  let result = $state<{ lines: string[]; errors: string[] } | null>(null);
  /** Company slug → the person's role, from their memberships. */
  let roles = $state<Map<string, string>>(new Map());

  const api = $derived(adapter?.storage ?? null);

  type OffloadPhase = "idle" | "previewing" | "confirm" | "moving";
  let offloadPhase = $state<OffloadPhase>("idle");
  let offloadPreview = $state<StorageOffloadResult | null>(null);
  let offloadError = $state<string | null>(null);
  let offloadResult = $state<{ ok: boolean; lines: string[] } | null>(null);

  const bigFiles = $derived(offloadCandidates(status?.offload));
  /** Current files are listed only once the CLI can move them. */
  const showCurrent = $derived(currentOffloadAvailable(status?.offload));
  const placeholders = $derived(status?.offload?.placeholders ?? null);
  /** Old big files other worktrees still use; they stay on this computer. */
  const held = $derived(historyHeld(status?.offload));
  /** Either flow running locks the whole page. */
  const busy = $derived(phase !== "idle" || offloadPhase !== "idle");

  async function startOffload(): Promise<void> {
    if (!api || busy) return;
    offloadPhase = "previewing";
    offloadError = null;
    offloadResult = null;
    const res = await api.previewOffload();
    if (!res.ok) {
      console.error("storage offload preview failed:", res.message);
      offloadError = res.message?.includes(UPDATE_HQ_CODE)
        ? "Update HQ to move big files to the cloud."
        : "We couldn't check which files would move. Try again in a moment.";
      offloadPhase = "idle";
      return;
    }
    const blocker = offloadPreviewBlocker(res.value);
    if (blocker) {
      offloadError = blocker;
      offloadPhase = "idle";
      return;
    }
    offloadPreview = res.value;
    offloadPhase = "confirm";
  }

  async function confirmOffload(): Promise<void> {
    if (!api || offloadPhase !== "confirm") return;
    offloadPhase = "moving";
    const res = await api.offload();
    offloadPreview = null;
    if (!res.ok) {
      console.error("storage offload failed:", res.message);
      offloadError = res.message?.includes(UPDATE_HQ_CODE)
        ? "Update HQ to move big files to the cloud."
        : `We couldn't move your files. Nothing was removed from ${device}. Try again in a moment.`;
    } else {
      offloadResult = offloadOutcome(res.value, device);
    }
    await load();
    offloadPhase = "idle";
  }

  function cancelOffload(): void {
    offloadPreview = null;
    offloadPhase = "idle";
  }

  function offloadBy(r: StorageOffloadResult): string {
    const by = localTime(offloadReclaimAfter(r));
    return by ? ` by ${by}` : "";
  }

  const offloadConfirmMessage = $derived(
    offloadPreview
      ? `${offloadSummary(offloadPreview)}. This frees about ${formatBytes(offloadFreedBytes(offloadPreview))}${offloadBy(offloadPreview)}. ${OFFLOAD_CONFIRM_COPY}${offloadIncludesCurrent(offloadPreview) ? ` ${OFFLOAD_CURRENT_COPY}` : ""}`
      : "",
  );

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
      if (isStorageFeatureDisabled(res.message)) {
        // Allowlist gate, fail closed: render nothing and let the host hide the entry.
        featureDisabled = true;
        onfeaturedisabled?.();
        return;
      }
      console.error("storage status failed:", res.message);
      loadError = res.message ?? "error";
    }
  }

  function describeRequest(req: StoragePruneRequest): string {
    if (req.localBefore) {
      return `backups on ${device} from before ${req.localBefore}`;
    }
    return `old file versions in ${req.company} from before ${req.cloudBefore}`;
  }

  async function startDelete(): Promise<void> {
    if (!api || busy) return;
    const requests = currentRequests();
    if (requests.length === 0) return;
    phase = "previewing";
    actionError = null;
    holders = [];
    result = null;
    let bytes = 0;
    const lines: string[] = [];
    const notes: string[] = [];
    const previews: StoragePruneResult[] = [];
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
      const held = pruneHolders(res.value);
      if (held) {
        // Nothing would be freed; say why instead of offering "about 0 B".
        actionError = holdersCopy(held.count, held.refs);
        holders = held.refs;
        phase = "idle";
        return;
      }
      previews.push(res.value);
      const freed = prunedBytes(res.value);
      bytes += freed;
      lines.push(`${describeRequest(req)} (about ${formatBytes(freed)})`);
      const bookmarks = bookmarksCopy(refsToRemove(res.value));
      if (bookmarks) notes.push(bookmarks);
    }
    preview = {
      bytes,
      lines,
      notes,
      local: requests.some((r) => Boolean(r.localBefore)),
      cloud: requests.some((r) => Boolean(r.cloudBefore)),
      reclaimAfter: pruneReclaimAfter(previews),
    };
    phase = "confirm";
  }

  async function confirmDelete(): Promise<void> {
    if (!api || phase !== "confirm") return;
    phase = "deleting";
    const done: StoragePruneResult[] = [];
    const errors: string[] = [];
    for (const req of currentRequests()) {
      const res = await api.prune(req);
      const where = req.company ?? device;
      if (!res.ok) {
        console.error("storage prune failed:", res.message);
        errors.push(`${where}: couldn't delete. Try again later.`);
        continue;
      }
      done.push(res.value);
      for (const c of res.value.cloud ?? []) {
        const errs = c.errors ?? [];
        if (errs.some(isPermissionError)) errors.push(`${c.company}: ${CLOUD_ADMIN_ONLY_COPY}`);
        else if (errs.length > 0) errors.push(`${c.company}: some old versions couldn't be deleted.`);
      }
    }
    const outcome = pruneOutcome(done, device);
    result = { lines: outcome.lines, errors: [...outcome.errors, ...errors] };
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
      ? pruneConfirmCopy({
          parts: preview.lines,
          bytes: preview.bytes,
          notes: preview.notes,
          local: preview.local,
          cloud: preview.cloud,
          reclaimAfter: preview.reclaimAfter,
        })
      : "",
  );

  /** Status says branches or saved versions hold all old history. */
  const statusHolders = $derived.by(() => {
    const local = status?.local;
    const count = local?.holding_refs_count ?? local?.holding_refs?.length ?? 0;
    const deletable = localBands.slice(1).some((b) => b.bytes > 0);
    return local?.available && count > 0 && !deletable ? { count, refs: local.holding_refs ?? [] } : null;
  });

  const pendingReclaim = $derived.by(() => {
    const local = status?.local;
    const bytes = local?.pending_reclaim_bytes ?? 0;
    const by = localTime(local?.reclaim_after);
    return local?.available && bytes > 0 && by ? `${formatBytes(bytes)} will be freed by ${by}.` : null;
  });

  async function loadRoles(): Promise<void> {
    const res = await adapter?.identity?.listWorkspaces?.().catch(() => null);
    if (res?.ok) roles = rolesFromMemberships(res.value as Record<string, unknown>[]);
  }

  onMount(() => {
    void load();
    void loadRoles();
    return subscribeHostComputerNoun((next) => (hostNoun = next));
  });
</script>

<div class="storage-pane" data-testid="settings-storage-pane">
  {#if featureDisabled}
    <!-- hq-storage is off for this person: nothing to show. -->
  {:else if !api}
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
    {#if showHeading}
      <div class="pane-head" data-testid="settings-storage-heading">
        <h2>Storage</h2>
        <div class="sd">Space HQ uses on {device}, and ways to free it.</div>
      </div>
    {/if}
    <div class="set-row" data-testid="settings-storage-header">
      <div>
        <div class="sn" data-testid="settings-storage-total">
          HQ backups on {device}: {status.local.available ? formatBytes(status.local.git_dir_bytes) : "unknown"}
        </div>
        <div class="sd">
          {#if status.local.available}
            Your HQ folder itself uses {formatBytes(status.local.working_tree_bytes)}.
            {#if pendingReclaim}<span data-testid="settings-storage-pending-reclaim">{pendingReclaim}</span>{/if}
          {:else}
            Update HQ to see your backup history.
          {/if}
        </div>
      </div>
      <RailButton
        icon="refresh"
        onclick={() => void load()}
        disabled={loading || busy}
        aria-busy={loading}
        data-testid="settings-storage-refresh"
      >{loading ? "Refreshing…" : "Refresh"}</RailButton>
    </div>

    <div class="set-subhead" data-testid="settings-storage-big-files"><div class="sn">Big files</div>
      <div class="sd" data-testid="settings-storage-big-files-copy">
        {OFFLOAD_CONFIRM_COPY} Moving them frees space on {device}.{#if showCurrent} Files over {BIG_FILE_MB} MB you haven't opened in {IDLE_DAYS} days move too. {OFFLOAD_CURRENT_COPY}{/if}
      </div>
    </div>
    {#if !status.offload}
      <div class="set-row unavailable" data-testid="settings-storage-big-files-update">
        <div class="sd">Update HQ to move big files to the cloud.</div>
      </div>
    {:else if status.offload.available === false}
      <div class="set-row unavailable" data-testid="settings-storage-big-files-unavailable">
        <div class="sd">{offloadUnavailableCopy(status.offload.reason)}</div>
      </div>
    {:else}
      <div class="set-row actions">
        <div>
          <div class="sn" data-testid="settings-storage-big-files-total">
            {bigFiles.count > 0 ? `${formatBytes(bigFiles.bytes)} in big files` : "No big files to move"}
          </div>
          {#if bigFiles.count > 0}
            <div class="sd" data-testid="settings-storage-big-files-breakdown">
              {status.offload.history_candidates.count.toLocaleString()} old copies in backup history ({formatBytes(status.offload.history_candidates.bytes)}){#if showCurrent} · {status.offload.current_candidates.count.toLocaleString()} idle files in your HQ folder ({formatBytes(status.offload.current_candidates.bytes)}){/if}
            </div>
          {/if}
          {#if held}
            <div class="sd" data-testid="settings-storage-history-held">{historyHeldCopy(held, device)}</div>
            {#if held.names.length > 0}
              <details class="holders" data-testid="settings-storage-history-held-list">
                <summary>What's still using it</summary>
                <ul>
                  {#each held.names as name, i (i)}<li>Worktree {name}</li>{/each}
                </ul>
              </details>
            {/if}
          {/if}
          {#if placeholders && placeholders.count > 0}
            <div class="sd" data-testid="settings-storage-placeholders">
              {placeholders.count.toLocaleString()} {placeholders.count === 1 ? "file is" : "files are"} already in HQ cloud ({formatBytes(placeholders.bytes)}).
            </div>
          {/if}
          {#if offloadError}
            <div class="sd error" role="alert" data-testid="settings-storage-offload-error">{offloadError}</div>
          {/if}
          {#if offloadPhase === "moving"}
            <div class="sd" role="status" data-testid="settings-storage-offloading">Uploading and checking each file before freeing space. This can take a while for big files.</div>
          {/if}
          {#if offloadResult}
            <div
              class="sd"
              class:error={!offloadResult.ok}
              role={offloadResult.ok ? "status" : "alert"}
              data-testid="settings-storage-offload-result"
            >
              {#each offloadResult.lines as line, i (i)}{#if i > 0}<br />{/if}{line}{/each}
            </div>
          {/if}
        </div>
        <RailButton
          icon="upload"
          variant="primary"
          disabled={bigFiles.bytes === 0 || busy}
          aria-busy={offloadPhase === "previewing" || offloadPhase === "moving"}
          onclick={() => void startOffload()}
          data-testid="settings-storage-offload"
        >{offloadPhase === "previewing" ? "Checking…" : offloadPhase === "moving" ? "Moving…" : `Move to cloud and free ~${formatBytes(bigFiles.bytes)}`}</RailButton>
      </div>
    {/if}

    <div class="set-subhead"><div class="sn">Local backup history</div>
      <div class="sd">HQ keeps a snapshot every time your files change. Older snapshots can be deleted to free space. The last 7 days are always kept.</div>
    </div>
    {#if !status.local.available}
      <div class="set-row unavailable" data-testid="settings-storage-local-unavailable">
        <div class="sd">Update HQ to manage backups on {device}.</div>
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
                  disabled={locked || busy}
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
      {#if statusHolders}
        <div class="set-row" data-testid="settings-storage-local-held">
          <div>
            <div class="sd">{holdersCopy(statusHolders.count, statusHolders.refs)}</div>
            {#if statusHolders.refs.length > 0}
              <details class="holders">
                <summary>What's still using it</summary>
                <ul>
                  {#each statusHolders.refs as ref (ref.name)}<li>{holderLabel(ref)}</li>{/each}
                </ul>
              </details>
            {/if}
          </div>
        </div>
      {/if}
    {/if}

    <div class="set-subhead"><div class="sn">Cloud file history</div>
      <div class="sd">Old versions of files your companies keep in the cloud. Current files are never touched.</div>
    </div>
    {#if cloudEntries.length === 0}
      <div class="set-row"><div class="sd">No cloud companies on {device}.</div></div>
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
        {#if entry.available && entry.bands.length > 0 && !canDeleteCloud(roles, entry.company, entry.can_delete)}
          <div class="set-row"><div class="sd" data-testid={`settings-storage-cloud-${entry.company}-admin-only`}>{CLOUD_ADMIN_ONLY_COPY}</div></div>
        {/if}
        {#if entry.available && entry.bands.length > 0}
          {@const cutoff = cloudCutoffs[entry.company] ?? null}
          {@const canDelete = canDeleteCloud(roles, entry.company, entry.can_delete)}
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
                      disabled={locked || !canDelete || busy}
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
          {#if holders.length > 0}
            <details class="holders" data-testid="settings-storage-holders">
              <summary>What's still using it</summary>
              <ul>
                {#each holders as ref (ref.name)}<li>{holderLabel(ref)}</li>{/each}
              </ul>
            </details>
          {/if}
        {/if}
        {#if phase === "deleting"}
          <div class="sd" role="status" data-testid="settings-storage-deleting">Deleting old backups. This can take a few minutes.</div>
        {/if}
        {#if result}
          <div class="sd" role="status" data-testid="settings-storage-result">
            {#each [...result.lines, ...result.errors] as line, i (i)}{#if i > 0}<br />{/if}{line}{/each}
          </div>
        {/if}
      </div>
      <RailButton
        icon="trash"
        variant="danger"
        disabled={selectedTotal === 0 || busy}
        aria-busy={phase === "previewing" || phase === "deleting"}
        onclick={() => void startDelete()}
        data-testid="settings-storage-delete"
      >{phase === "previewing" ? "Checking…" : phase === "deleting" ? "Deleting…" : "Delete selected"}</RailButton>
    </div>
  {/if}
</div>

<ConfirmDialog
  open={offloadPhase === "confirm"}
  title="Move big files to HQ cloud?"
  message={offloadConfirmMessage}
  confirmLabel="Move to cloud"
  onconfirm={() => void confirmOffload()}
  oncancel={cancelOffload}
/>

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

  .pane-head {
    padding: 4px 16px 6px;
  }

  .pane-head h2 {
    margin: 0 0 4px;
    font-size: inherit;
    font-weight: 600;
  }

  .holders summary {
    cursor: pointer;
  }

  .holders ul {
    margin: 4px 0 0;
    padding-left: 18px;
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
