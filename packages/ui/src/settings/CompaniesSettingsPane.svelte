<script lang="ts">
  /**
   * Settings → Companies. One row per company with the caller's role, whether
   * the company is a cloud vault or local only, the per-company download
   * choice (Sync all / Sync shared → `get_sync_mode` / `set_sync_mode`), and
   * Convert to cloud vault for local-only companies
   * (`connect_workspace_to_cloud` → `hq cloud provision company`).
   *
   * Failures never show raw text: each action retries with backoff, then the
   * control stays usable with a muted "try again" hint. Raw errors go to the
   * console log only.
   */
  import { onMount } from "svelte";
  import type { CompanySyncMode, PlatformAdapter } from "@hq/platform";
  import type { Workspace } from "../chat/workspaces.js";
  import RailIcon from "../common/button/RailIcon.svelte";
  import ConfirmDialog from "../common/ConfirmDialog.svelte";
  import { companyAvatarWash, settingsCompanyLists } from "./shell-settings-model.js";
  import {
    companySettingsRows,
    storageLabel,
    withRetry,
    type CompanySettingsRow,
    type ProfileCompanyRole,
  } from "./companies-settings-model.js";
  import "../chat/tokens.css";
  import "../chat/chat-tokens.css";

  interface Props {
    companies?: Workspace[] | null;
    adapter?: PlatformAdapter | null;
    /** Roles the host resolved from each company's membership roster. */
    roles?: ReadonlyArray<ProfileCompanyRole>;
    personalLabel?: string | null;
    /** Opens the company's own pane (cloud companies only). */
    oncompany?: (uid: string) => void;
    /** Test seam for retry backoff. */
    retryDelayMs?: number;
  }

  let {
    companies = [],
    adapter = null,
    roles = [],
    personalLabel = null,
    oncompany,
    retryDelayMs = 600,
  }: Props = $props();

  // A fresh roster read after a conversion; until then the host's list wins.
  let refreshed = $state<Workspace[] | null>(null);
  const source = $derived(refreshed ?? companies ?? []);
  const rows = $derived(companySettingsRows(source, roles));
  const personal = $derived(settingsCompanyLists(source, personalLabel).personal);

  const canSyncMode = $derived(
    Boolean(adapter?.isAvailable("canSync") && adapter?.sync?.getCompanySyncMode),
  );
  const canConvertHere = $derived(Boolean(adapter?.company?.connectToCloud));

  type ModeState =
    | { phase: "loading" }
    | { phase: "ready"; mode: CompanySyncMode | "custom"; saving: CompanySyncMode | null; hint: string | null }
    | { phase: "retry" };
  let modes = $state<Record<string, ModeState>>({});

  type ConvertState =
    | { phase: "idle" }
    | { phase: "working" }
    | { phase: "done" }
    | { phase: "retry" };
  let converts = $state<Record<string, ConvertState>>({});
  let confirmRow = $state<CompanySettingsRow | null>(null);

  let personalSyncState = $state<"checking" | "synced" | "local" | "unavailable">("checking");
  let personalSyncReadGeneration = 0;

  async function loadMode(slug: string): Promise<void> {
    const sync = adapter?.sync;
    if (!sync?.getCompanySyncMode) return;
    const get = (s: string) => sync.getCompanySyncMode!(s);
    modes[slug] = { phase: "loading" };
    const result = await withRetry(() => get(slug), { baseDelayMs: retryDelayMs });
    if (!result.ok) {
      console.warn("[settings/companies] get_sync_mode failed", slug, result.message);
      modes[slug] = { phase: "retry" };
      return;
    }
    const mode = result.value.syncMode;
    modes[slug] = { phase: "ready", mode, saving: null, hint: null };
  }

  async function chooseMode(slug: string, next: CompanySyncMode): Promise<void> {
    const sync = adapter?.sync;
    const set = sync?.setCompanySyncMode
      ? (s: string, m: CompanySyncMode) => sync.setCompanySyncMode!(s, m)
      : null;
    const current = modes[slug];
    if (!set || current?.phase !== "ready" || current.saving) return;
    if (current.mode === next) return;
    modes[slug] = { ...current, saving: next, hint: null };
    const result = await withRetry(() => set(slug, next), { baseDelayMs: retryDelayMs });
    if (!result.ok) {
      console.warn("[settings/companies] set_sync_mode failed", slug, result.message);
      modes[slug] = { ...current, saving: null, hint: "Didn’t save. Tap again to retry." };
      return;
    }
    modes[slug] = {
      phase: "ready",
      mode: result.value.syncMode,
      saving: null,
      hint: "Saved. Applies on the next sync.",
    };
  }

  async function refreshRoster(): Promise<void> {
    const sync = adapter?.sync;
    if (!sync?.listSyncableWorkspaces) return;
    const result = await sync.listSyncableWorkspaces();
    if (!result.ok) {
      console.warn("[settings/companies] roster refresh failed", result.message);
      return;
    }
    const value = result.value as unknown;
    const envelope = value as { workspaces?: unknown };
    const next = Array.isArray(value)
      ? value
      : Array.isArray(envelope?.workspaces)
        ? envelope.workspaces
        : null;
    if (next) refreshed = next as Workspace[];
  }

  async function convert(row: CompanySettingsRow): Promise<void> {
    confirmRow = null;
    const company = adapter?.company;
    if (!company?.connectToCloud || converts[row.slug]?.phase === "working") return;
    const connect = (slug: string) => company.connectToCloud(slug);
    converts[row.slug] = { phase: "working" };
    const result = await withRetry(() => connect(row.slug), { baseDelayMs: retryDelayMs });
    if (!result.ok) {
      console.warn("[settings/companies] connect_workspace_to_cloud failed", row.slug, result.message);
      converts[row.slug] = { phase: "retry" };
      return;
    }
    converts[row.slug] = { phase: "done" };
    await refreshRoster();
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("hq:workspace-sync-enabled-changed"));
    }
  }

  async function refreshPersonalSyncState(): Promise<void> {
    const generation = ++personalSyncReadGeneration;
    if (!adapter?.isAvailable("canSync") || !adapter.settings?.getSettings) {
      personalSyncState = "unavailable";
      return;
    }
    const result = await adapter.settings.getSettings();
    if (generation !== personalSyncReadGeneration) return;
    if (!result.ok) {
      personalSyncState = "unavailable";
      return;
    }
    const settings = result.value as Record<string, unknown>;
    personalSyncState = settings.personalSyncEnabled === false ? "local" : "synced";
  }

  // Load each cloud company's mode once it appears (also after a conversion).
  $effect(() => {
    if (!canSyncMode) return;
    for (const row of rows) {
      if (row.canChooseSyncMode && modes[row.slug] === undefined) {
        void loadMode(row.slug);
      }
    }
  });

  onMount(() => {
    const refresh = () => void refreshPersonalSyncState();
    window.addEventListener("focus", refresh);
    window.addEventListener("hq:workspace-sync-enabled-changed", refresh);
    refresh();
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener("hq:workspace-sync-enabled-changed", refresh);
    };
  });

  const MODE_OPTIONS: ReadonlyArray<{ id: CompanySyncMode; label: string }> = [
    { id: "all", label: "Sync all" },
    { id: "shared", label: "Sync shared" },
  ];
</script>

<div class="co-pane" data-testid="settings-companies-pane">
  <p class="co-note" data-testid="settings-companies-note">
    {"Each company's role, where its files live, and what downloads to this computer. Sync all downloads every folder you can open. Sync shared downloads only folders shared with you."}
  </p>

  {#if rows.length === 0}
    <p class="co-empty" data-testid="settings-companies-empty">
      No companies on this account yet.
    </p>
  {/if}

  {#each rows as row (row.slug)}
    {@const wash = companyAvatarWash(row.uid ?? row.slug)}
    {@const mode = modes[row.slug]}
    {@const conv = converts[row.slug] ?? { phase: "idle" }}
    <div
      class="set-row co-row"
      data-testid="settings-company-row"
      data-company-slug={row.slug}
    >
      <div class="co-main">
        <button
          type="button"
          class="co-id"
          disabled={!row.uid || !oncompany}
          onclick={() => row.uid && oncompany?.(row.uid)}
        >
          <span
            class="co-av"
            style={`background:${wash.bg};color:${wash.fg}`}
            aria-hidden="true">{row.name.slice(0, 1).toUpperCase()}</span
          >
          <span class="co-name">{row.name}</span>
        </button>
        <div class="co-meta">
          {#if row.role}
            <span class="co-tag" data-testid="settings-company-role">{row.role}</span>
          {/if}
          <span
            class="co-tag"
            class:co-tag-local={row.storage !== "cloud"}
            data-testid="settings-company-storage"
          >{storageLabel(row.storage)}</span>
        </div>
      </div>

      <div class="co-controls">
        {#if row.canChooseSyncMode && canSyncMode}
          {#if mode?.phase === "ready"}
            <div class="co-modes" role="radiogroup" aria-label={`What downloads for ${row.name}`}>
              {#each MODE_OPTIONS as option (option.id)}
                <button
                  type="button"
                  class="chip"
                  class:on={(mode.saving ?? mode.mode) === option.id}
                  role="radio"
                  aria-checked={(mode.saving ?? mode.mode) === option.id}
                  disabled={mode.saving !== null}
                  data-testid={`settings-company-mode-${option.id}`}
                  onclick={() => void chooseMode(row.slug, option.id)}
                >{option.label}</button>
              {/each}
            </div>
            {#if mode.mode === "custom" && !mode.saving}
              <span class="co-hint" data-testid="settings-company-mode-hint">Custom folders set from the hq command line</span>
            {:else if mode.hint}
              <span class="co-hint" data-testid="settings-company-mode-hint">{mode.hint}</span>
            {:else if mode.mode === "shared" && row.isOwnerOrAdmin}
              <span class="co-hint" data-testid="settings-company-mode-hint">Your owner access stays the same; unshared folders don't download</span>
            {/if}
          {:else if mode?.phase === "retry"}
            <button
              type="button"
              class="chip co-quiet"
              data-testid="settings-company-mode-retry"
              onclick={() => void loadMode(row.slug)}
            ><RailIcon name="refresh" /> Tap to retry</button>
          {:else}
            <span class="co-hint" data-testid="settings-company-mode-loading">Checking…</span>
          {/if}
        {:else if row.canConvert && canConvertHere}
          {#if conv.phase === "done"}
            <span class="co-hint" data-testid="settings-company-convert-done">Now a cloud vault</span>
          {:else}
            <button
              type="button"
              class="chip"
              data-testid="settings-company-convert"
              disabled={conv.phase === "working"}
              onclick={() => (confirmRow = row)}
            ><RailIcon name="upload" />
              {conv.phase === "working"
                ? "Converting…"
                : row.storage === "reconnect"
                  ? "Reconnect to cloud"
                  : "Convert to cloud vault"}
            </button>
            {#if conv.phase === "retry"}
              <span class="co-hint" data-testid="settings-company-convert-retry">Didn’t finish. Tap to try again.</span>
            {:else if conv.phase === "working"}
              <span class="co-hint">Uploading company files. This can take a few minutes.</span>
            {/if}
          {/if}
        {/if}
      </div>
    </div>
  {/each}

  {#if personal}
    {@const wash = companyAvatarWash(personal.id)}
    <div class="set-row co-row">
      <div class="co-main">
        <div class="co-id">
          <span
            class="co-av"
            style={`background:${wash.bg};color:${wash.fg}`}
            aria-hidden="true">{personal.initials}</span
          >
          <span class="co-name">{personal.name}</span>
        </div>
        <div class="co-meta">
          <span class="co-tag">Owner</span>
          <span class="co-tag" data-testid="settings-personal-sync-state">
            {personalSyncState === "synced"
              ? "Synced"
              : personalSyncState === "local"
                ? "Local"
                : personalSyncState === "checking"
                  ? "Checking"
                  : "Unavailable"}
          </span>
        </div>
      </div>
    </div>
  {/if}
</div>

<ConfirmDialog
  open={confirmRow !== null}
  title={confirmRow?.storage === "reconnect" ? "Reconnect to cloud" : "Convert to cloud vault"}
  message={confirmRow?.storage === "reconnect"
    ? `This links the ${confirmRow.name} folder on this computer back to its HQ cloud vault and uploads any changes. Your local files stay where they are.`
    : confirmRow
      ? `This uploads the ${confirmRow.name} folder on this computer to a new HQ cloud vault so it syncs and teammates can join. Your local files stay where they are.`
      : ""}
  confirmLabel={confirmRow?.storage === "reconnect" ? "Reconnect" : "Convert"}
  oncancel={() => (confirmRow = null)}
  onconfirm={() => confirmRow && void convert(confirmRow)}
/>

<style>
  .co-pane {
    display: flex;
    flex-direction: column;
    gap: 0;
    max-width: 640px;
  }

  .co-note,
  .co-empty {
    margin: 0 0 12px;
    color: var(--t3);
    font-size: 12px;
    line-height: 1.45;
  }

  .set-row {
    display: flex;
    align-items: center;
    gap: 12px;
    border-top: 1px solid var(--line);
    padding: 14px 16px;
  }

  .co-main {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
    flex: 1 1 auto;
  }

  .co-id {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
    background: none;
    border: none;
    padding: 0;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .co-id:disabled {
    cursor: default;
  }

  .co-av {
    display: grid;
    place-items: center;
    flex: 0 0 auto;
    width: 24px;
    height: 24px;
    font-size: 11px;
    font-weight: 500;
  }

  .co-name {
    font-size: 13px;
    font-weight: 500;
    color: var(--t1);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .co-meta {
    display: flex;
    gap: 6px;
    padding-left: 34px;
  }

  .co-tag {
    padding: 1px 6px;
    border: 1px solid var(--line2);
    color: var(--t2);
    font-family: var(--font-mono, ui-monospace, Menlo, monospace);
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .co-tag-local {
    color: var(--t3);
  }

  .co-controls {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 6px;
    flex: 0 0 auto;
    max-width: 55%;
  }

  .co-modes {
    display: flex;
    gap: 6px;
  }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 10px;
    border: 1px solid var(--line2);
    border-radius: 0;
    background: none;
    color: var(--t2);
    font: inherit;
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
  }

  .chip.on {
    background: var(--hover, var(--overlay-hover));
    color: var(--t1);
  }

  .chip:disabled {
    opacity: 0.6;
    cursor: default;
  }

  .co-quiet {
    color: var(--t3);
  }

  .co-hint {
    color: var(--t3);
    font-size: 11px;
    line-height: 1.4;
    text-align: right;
  }
</style>
