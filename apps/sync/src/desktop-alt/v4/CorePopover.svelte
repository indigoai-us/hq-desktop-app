<script lang="ts">
  /**
   * Core popover (US-016) — opened from the titlebar "● Core ⌄" pill.
   *
   * Contains: conflict rescue card, HQ core version/drift row, desktop app
   * update row, Library stub, expandable PACKS list + marketplace, and a
   * cloud-paused notice. Model logic lives in core-popover-model.ts.
   */
  import { invoke } from '@tauri-apps/api/core';
  import { listen, type UnlistenFn } from '@tauri-apps/api/event';
  import CopyPromptButton from '../../components/CopyPromptButton.svelte';
  import type { Issue } from '../../lib/copy-prompts';
  import { safeUnlisten } from '../../lib/listener-registry';
  import type { HomeConflict } from './home-model';
  import {
    buildCorePopoverViewModel,
    coreNeedsRestore,
    CORE_POPOVER_FIXTURE_PACKS,
    type CorePopoverConflict,
    type CorePopoverPack,
  } from './core-popover-model';
  import './tokens.css';

  interface Props {
    /** Desktop app version string (from __APP_VERSION__). */
    appVersion: string;
    /** Live conflict list from DesktopApp (sync:conflict stream). */
    conflicts?: HomeConflict[];
    /** Settings-backed Cloud Off flag. */
    cloudPaused?: boolean;
    /**
     * When true (default in visual QA), inject fixture packs/update if the
     * live sources are empty so Core always demos conflict/update/packs/paused.
     */
    useFixtures?: boolean;
    /** Sync/hydration recovery card from the titlebar status model (D-04). */
    recovery?: {
      sentence: string;
      label: string;
      busy: boolean;
      copyIssue: Issue | null;
    } | null;
    onrecovery?: () => void | Promise<void>;
    onclose?: () => void;
    onresolve?: (path: string, strategy: 'keep-local' | 'keep-remote') => void | Promise<void>;
    onopeneditor?: (path: string) => void | Promise<void>;
    onopendrift?: () => void | Promise<void>;
    onopenLibrary?: () => void;
    onopenMarketplace?: () => void;
  }

  interface UpdateInfo {
    version: string;
    body?: string;
    date?: string;
  }

  interface CoreStateWire {
    channel?: 'release' | 'staging';
    targetVersion?: string;
    localVersion?: string | null;
    versionBehind?: boolean;
    driftReport?: { count?: number };
  }

  interface PackagesViewWire {
    packs?: {
      installed?: Array<{ name?: string; version?: string }>;
    };
  }

  let {
    appVersion,
    conflicts = [],
    cloudPaused = false,
    useFixtures = true,
    recovery = null,
    onrecovery,
    onclose,
    onresolve,
    onopeneditor,
    onopendrift,
    onopenLibrary,
    onopenMarketplace,
  }: Props = $props();

  let packsExpanded = $state(true);
  let hqVersion = $state<string | null>(null);
  let coreState = $state<CoreStateWire | null>(null);
  let updateAvailable = $state(false);
  let updateInstalling = $state(false);
  let coreRestoring = $state(false);
  let packs = $state<CorePopoverPack[]>([]);
  let loadError = $state<string | null>(null);
  let disposed = false;
  let loadGeneration = 0;
  /** Fixture conflict timestamp for "· Nm ago" header. */
  const fixtureConflictAt = Date.now() - 3 * 60_000;

  const modelConflicts = $derived.by((): CorePopoverConflict[] => {
    const live = conflicts.map((c) => ({
      path: c.path,
      status: (c.status === 'error'
        ? 'error'
        : c.status === 'resolving'
          ? 'resolving'
          : 'pending') as CorePopoverConflict['status'],
      error: c.error,
    }));
    if (live.length > 0) return live;
    // D-08: demo conflict card when live stream is empty.
    if (useFixtures) {
      return [
        {
          path: 'companies/indigo/knowledge/runbook.md',
          status: 'pending',
        },
      ];
    }
    return [];
  });

  const modelPacks = $derived.by((): CorePopoverPack[] => {
    if (packs.length > 0) return packs;
    return useFixtures ? CORE_POPOVER_FIXTURE_PACKS : [];
  });

  const modelUpdateAvailable = $derived(
    updateAvailable || (useFixtures && packs.length === 0),
  );

  const model = $derived(
    buildCorePopoverViewModel({
      conflicts: modelConflicts,
      conflictUpdatedAtMs: modelConflicts.length > 0 ? fixtureConflictAt : null,
      core: {
        hqVersion: hqVersion ?? coreState?.localVersion ?? null,
        driftCount: coreState?.driftReport?.count ?? 0,
        needsRestore: coreNeedsRestore(
          Boolean(coreState?.versionBehind),
          coreState?.driftReport?.count ?? 0,
        ),
        channel: coreState?.channel ?? null,
      },
      appVersion,
      updateAvailable: modelUpdateAvailable,
      packs: modelPacks,
      cloudPaused,
      packsExpanded,
    }),
  );

  async function refresh(): Promise<void> {
    const generation = ++loadGeneration;
    loadError = null;
    try {
      const [version, state, pending, packages] = await Promise.all([
        invoke<string | null>('get_hq_version').catch(() => null),
        invoke<CoreStateWire | null>('check_core_state').catch(() => null),
        invoke<UpdateInfo | null>('get_pending_update').catch(() => null),
        invoke<PackagesViewWire>('list_packages').catch(() => null),
      ]);
      if (disposed || generation !== loadGeneration) return;
      hqVersion = version;
      coreState = state;
      const pendingVersion =
        pending && typeof pending === 'object' && 'version' in pending
          ? (pending as UpdateInfo).version
          : null;
      updateAvailable = Boolean(pendingVersion);
      const installed = (packages?.packs?.installed ?? [])
        .map((p) => ({
          name: (p.name ?? '').trim(),
          version: p.version ?? null,
        }))
        .filter((p) => p.name.length > 0);
      // Prefer live packs; otherwise D-08 fixtures (4 packs, one NEW).
      packs =
        installed.length > 0
          ? installed
          : useFixtures
            ? CORE_POPOVER_FIXTURE_PACKS
            : [];
    } catch (err) {
      if (disposed || generation !== loadGeneration) return;
      console.error('core-popover: refresh failed', err);
      loadError = 'Could not load Core status';
    }
  }

  async function handleRestore(): Promise<void> {
    if (coreRestoring || !coreState) return;
    coreRestoring = true;
    try {
      const command =
        coreState.channel === 'staging' ? 'run_replace_from_staging' : 'install_hq_core_update';
      await invoke(command);
      await refresh();
    } catch (err) {
      console.error('core-popover: core restore failed', err);
    } finally {
      coreRestoring = false;
    }
  }

  async function handleUpdate(): Promise<void> {
    if (updateInstalling || !updateAvailable) return;
    updateInstalling = true;
    try {
      await invoke('install_update');
      updateAvailable = false;
    } catch (err) {
      console.error('core-popover: install_update failed', err);
    } finally {
      updateInstalling = false;
    }
  }

  async function handleOpenDrift(): Promise<void> {
    if (!model.driftOpenable) return;
    if (onopendrift) {
      await onopendrift();
      return;
    }
    // Parent didn't wire a handler — open with the live core-state report when
    // we have one (same command DesktopApp / Settings use).
    const report = (coreState as { driftReport?: unknown } | null)?.driftReport;
    if (!report) return;
    try {
      await invoke('open_drift_detail', { report });
    } catch (err) {
      console.error('core-popover: open_drift_detail failed', err);
    }
  }

  $effect(() => {
    disposed = false;
    let cancelled = false;
    let unlistenAvailable: UnlistenFn | undefined;
    let unlistenCleared: UnlistenFn | undefined;

    void refresh();

    try {
      void listen<UpdateInfo>('update:available', (event) => {
        if (cancelled) return;
        if (event.payload?.version) updateAvailable = true;
      })
        .then((off) => {
          if (cancelled) {
            safeUnlisten(off)();
            return;
          }
          unlistenAvailable = safeUnlisten(off);
        })
        .catch(() => {
          // Non-Tauri / test environments (listen IPC unavailable).
        });
      void listen('update:cleared', () => {
        if (cancelled) return;
        updateAvailable = false;
      })
        .then((off) => {
          if (cancelled) {
            safeUnlisten(off)();
            return;
          }
          unlistenCleared = safeUnlisten(off);
        })
        .catch(() => {
          // Non-Tauri / test environments.
        });
    } catch {
      // Non-Tauri / test environments.
    }

    return () => {
      cancelled = true;
      disposed = true;
      loadGeneration += 1;
      safeUnlisten(unlistenAvailable)();
      safeUnlisten(unlistenCleared)();
    };
  });
</script>

<div
  class="core-popover"
  role="dialog"
  aria-label="Core"
  data-testid="core-popover"
  data-tauri-drag-region="false"
>
  {#if recovery}
    <div class="core-recovery" data-testid="core-popover-recovery" role="status">
      <span class="core-recovery-sentence">{recovery.sentence}</span>
      <div class="core-recovery-actions">
        <button
          type="button"
          class="core-btn primary"
          data-testid="core-popover-recovery-action"
          disabled={recovery.busy}
          aria-busy={recovery.busy}
          onclick={() => void onrecovery?.()}
        >
          {recovery.label}
        </button>
        {#if recovery.copyIssue}
          <CopyPromptButton variant="inline" label="Copy prompt" issue={recovery.copyIssue} />
        {/if}
      </div>
    </div>
  {/if}

  {#if model.cloudPaused && model.pausedNotice}
    <div class="core-paused" data-testid="core-popover-paused" data-kind="cloud-paused" role="status">
      <span class="core-paused-title">Cloud is off</span>
      <span class="core-paused-body">Sync is paused on this device. Turn Cloud on to resume.</span>
    </div>
  {/if}

  {#if model.conflictCount > 0}
    <section class="core-conflicts" data-testid="core-popover-rescue-card" aria-label="Conflicts">
      <header class="core-section-header" data-testid="core-popover-conflict-header">
        {model.conflictHeader}
      </header>
      <ul class="core-conflict-list">
        {#each model.conflictRows as row (row.path)}
          <li class="core-conflict-row" data-testid="core-popover-conflict-row">
            <div class="core-conflict-meta">
              <span class="core-conflict-name">{row.fileName}</span>
              <span class="core-conflict-path" data-testid="conflict-row-path" title={row.path}>
                {row.companyPath}
              </span>
              {#if row.error}
                <span class="core-conflict-error">{row.error}</span>
              {/if}
            </div>
            <div class="core-conflict-actions">
              <button
                type="button"
                class="core-btn primary"
                data-testid="core-popover-keep-local"
                disabled={row.actionsDisabled}
                onclick={() => void onresolve?.(row.path, 'keep-local')}
              >
                Keep local
              </button>
              <button
                type="button"
                class="core-btn primary"
                data-testid="core-popover-keep-cloud"
                disabled={row.actionsDisabled}
                onclick={() => void onresolve?.(row.path, 'keep-remote')}
              >
                Keep cloud
              </button>
              <button
                type="button"
                class="core-btn secondary"
                data-testid="core-popover-open-editor"
                disabled={row.actionsDisabled}
                onclick={() => void onopeneditor?.(row.path)}
              >
                Open in editor
              </button>
            </div>
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  <div class="core-rows" data-testid="core-popover-version-rows">
    <div class="core-row" data-testid="core-popover-core-row">
      <span class="core-row-label">{model.hqVersionLabel}</span>
      <span class="core-row-actions">
        {#if model.driftOpenable}
          <button
            type="button"
            class="core-pill drifted"
            data-testid="core-popover-drift-count"
            onclick={() => void handleOpenDrift()}
            title="Show drifted files"
          >
            {model.driftPill}
          </button>
        {:else}
          <span class="core-pill" data-testid="core-popover-no-drift">{model.driftPill}</span>
        {/if}
        {#if model.showRestore}
          <button
            type="button"
            class="core-btn primary"
            data-testid="core-popover-core-restore"
            disabled={coreRestoring}
            aria-busy={coreRestoring}
            onclick={() => void handleRestore()}
          >
            {coreRestoring ? 'Restoring…' : 'Restore'}
          </button>
        {/if}
      </span>
    </div>

    <div class="core-row" data-testid="core-popover-app-row">
      <span class="core-row-label">{model.appVersionLabel}</span>
      <span class="core-row-actions">
        {#if model.updateAvailable}
          <button
            type="button"
            class="core-btn primary"
            data-testid="core-popover-app-update"
            disabled={updateInstalling}
            aria-busy={updateInstalling}
            onclick={() => void handleUpdate()}
          >
            {updateInstalling ? 'Installing…' : 'Update'}
          </button>
        {:else}
          <span class="core-pill" data-testid="core-popover-app-up-to-date">Up to date</span>
        {/if}
      </span>
    </div>

    <button
      type="button"
      class="core-row core-row-button"
      data-testid="core-popover-library-row"
      onclick={() => {
        onopenLibrary?.();
        onclose?.();
      }}
    >
      <span class="core-row-label">Library</span>
      <span class="core-row-chevron" aria-hidden="true">›</span>
    </button>
  </div>

  <section class="core-packs" data-testid="core-popover-packs">
    <button
      type="button"
      class="core-packs-toggle"
      data-testid="core-popover-packs-toggle"
      aria-expanded={packsExpanded}
      onclick={() => (packsExpanded = !packsExpanded)}
    >
      <span class="core-packs-label">PACKS</span>
      <span class="core-packs-meta">{model.packsSummary}</span>
      <span class="core-row-chevron" class:open={packsExpanded} aria-hidden="true">›</span>
    </button>
    {#if packsExpanded}
      <ul class="core-pack-list" data-testid="core-popover-pack-list">
        {#if packs.length === 0}
          <li class="core-pack-empty">No packs installed</li>
        {:else}
          {#each model.packs as pack (pack.name)}
            <li class="core-pack-row" data-testid="core-popover-pack-row">
              <span class="core-pack-name">{pack.name}</span>
              {#if pack.isNew}
                <span class="core-pack-new" data-testid="core-popover-pack-new">NEW</span>
              {/if}
              {#if pack.version}
                <span class="core-pack-version">v{pack.version}</span>
              {/if}
            </li>
          {/each}
        {/if}
      </ul>
      <button
        type="button"
        class="core-btn secondary core-marketplace"
        data-testid="core-popover-open-marketplace"
        onclick={() => {
          onopenMarketplace?.();
          onclose?.();
        }}
      >
        Open marketplace
      </button>
    {/if}
  </section>

  {#if loadError}
    <p class="core-load-error" role="status">{loadError}</p>
  {/if}
</div>

<style>
  .core-popover {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    z-index: 10000;
    display: flex;
    flex-direction: column;
    gap: 0;
    width: min(300px, calc(100vw - 24px));
    max-height: min(70vh, 520px);
    overflow: auto;
    padding: 6px;
    border: 1px solid var(--panel-border);
    border-radius: 12px;
    /* Frosted glass panel — Daybook .panel. */
    background: var(--panel-bg);
    box-shadow: var(--panel-shadow);
    color: var(--t1);
    font: 400 13px/1.45 var(--font-ui);
    backdrop-filter: blur(40px) saturate(1.5);
    -webkit-backdrop-filter: blur(40px) saturate(1.5);
  }

  .core-recovery {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 10px 12px;
    margin-bottom: 6px;
    border-radius: 10px;
    background: var(--raised);
  }

  .core-recovery-sentence {
    color: var(--t1);
    font-size: 13px;
    font-weight: 500;
  }

  .core-recovery-actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .core-paused {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 10px 12px;
    margin-bottom: 6px;
    border: none;
    border-radius: 10px;
    background: var(--raised);
  }

  .core-paused-title {
    font-size: 13px;
    font-weight: 500;
    color: var(--t1);
  }

  .core-paused-body {
    font-size: 11px;
    color: var(--t2);
    line-height: 1.35;
  }

  .core-pack-new {
    flex: 0 0 auto;
    padding: 0;
    border: none;
    color: var(--ice-ink);
    font-family: var(--font-mono);
    font-size: 10px;
    font-weight: 400;
    letter-spacing: 0;
    line-height: 1.2;
  }

  .core-conflicts {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: 2px 0 6px;
    padding: 8px 10px;
    border: 1px solid color-mix(in srgb, var(--warn) 30%, transparent);
    border-radius: 8px;
    background: color-mix(in srgb, var(--warn) 8%, transparent);
  }

  .core-section-header {
    font-size: 13px;
    font-weight: 500;
    color: var(--t1);
  }

  .core-conflict-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .core-conflict-row {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .core-conflict-meta {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .core-conflict-name {
    overflow: hidden;
    font-size: 11px;
    line-height: 1.35;
    color: var(--warn-ink);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .core-conflict-path {
    overflow: hidden;
    color: var(--t3);
    font-family: var(--font-mono);
    font-size: 10px;
    line-height: 1.35;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .core-conflict-error {
    color: var(--warn-ink);
    font-size: 10px;
  }

  .core-conflict-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .core-rows {
    display: grid;
    gap: 2px;
  }

  .core-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    min-height: 28px;
    padding: 6px 8px;
    border-radius: 8px;
  }

  .core-row-button {
    appearance: none;
    width: 100%;
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .core-row-button:hover {
    background: var(--hover);
  }

  .core-row-label {
    min-width: 0;
    overflow: hidden;
    color: var(--t1);
    font-size: 12px;
    font-weight: 400;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .core-row-actions {
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    gap: 4px;
  }

  .core-row-chevron {
    color: var(--t3);
    font-size: 14px;
    line-height: 1;
    transition: transform 120ms ease;
  }

  .core-row-chevron.open {
    transform: rotate(90deg);
  }

  .core-pill {
    display: inline-flex;
    align-items: center;
    min-height: 18px;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--ok-ink);
    font-family: var(--font-mono);
    font-size: 10px;
    font-weight: 400;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    white-space: nowrap;
  }

  button.core-pill {
    cursor: pointer;
  }

  .core-pill.drifted {
    color: var(--warn-ink);
  }

  button.core-pill:hover:not(:disabled) {
    color: var(--t1);
  }

  .core-btn {
    appearance: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    padding: 3px 10px;
    border: 1px solid transparent;
    border-radius: 6px;
    background: var(--btn-bg);
    color: var(--t1);
    font: inherit;
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
  }

  .core-btn:hover:not(:disabled) {
    border-color: var(--line2);
  }

  .core-btn:active:not(:disabled) {
    border-color: var(--border-active);
  }

  .core-btn.primary {
    border: none;
    background: var(--ice-ink);
    color: var(--badge-fg);
  }

  .core-btn.primary:hover:not(:disabled) {
    border: none;
    opacity: 0.88;
  }

  .core-btn.secondary {
    color: var(--t2);
    background: transparent;
    border-color: var(--line2);
  }

  .core-btn.secondary:hover:not(:disabled) {
    background: var(--hover);
    color: var(--t1);
    border-color: var(--line2);
  }

  .core-btn:disabled {
    cursor: default;
    opacity: 0.55;
  }

  .core-btn:focus-visible,
  .core-row-button:focus-visible,
  .core-packs-toggle:focus-visible,
  button.core-pill:focus-visible {
    outline: 2px solid var(--v4-focus-ring, var(--v4-control-border));
    outline-offset: var(--v4-focus-offset, 2px);
  }

  .core-packs {
    display: flex;
    flex-direction: column;
    gap: 0;
    border: none;
    border-radius: 10px;
    background: var(--raised);
    padding: 4px 0;
    margin-top: 4px;
    transition: background 0.12s;
  }

  .core-packs-toggle {
    appearance: none;
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 8px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }

  .core-packs-toggle:hover {
    background: transparent;
  }

  .core-packs:has(.core-packs-toggle:hover) {
    background: var(--btn-bg);
  }

  .core-packs-label {
    font-size: 12px;
    font-weight: 400;
    color: var(--t1);
  }

  .core-packs-meta {
    flex: 1 1 auto;
    min-width: 0;
    margin-left: auto;
    color: var(--t3);
    font-family: var(--font-mono);
    font-size: 10px;
    text-align: right;
    text-transform: uppercase;
  }

  .core-pack-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0;
  }

  .core-pack-row,
  .core-pack-empty {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin: 0 6px;
    padding: 4px 8px 4px 24px;
    border-radius: 6px;
    color: var(--t1);
    font-size: 12px;
  }

  .core-pack-row:hover {
    background: var(--hover);
  }

  .core-pack-name {
    overflow: hidden;
    color: var(--t1);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .core-pack-version {
    flex-shrink: 0;
    margin-left: auto;
    color: var(--t3);
    font-family: var(--font-mono);
    font-size: 10px;
    font-variant-numeric: tabular-nums;
  }

  .core-marketplace {
    align-self: flex-start;
    margin: 0 6px 2px;
  }

  .core-load-error {
    margin: 0;
    color: var(--warn-ink);
    font-size: 11px;
  }

  @media (prefers-reduced-transparency: reduce) {
    .core-popover {
      backdrop-filter: none;
      -webkit-backdrop-filter: none;
    }
  }
</style>
