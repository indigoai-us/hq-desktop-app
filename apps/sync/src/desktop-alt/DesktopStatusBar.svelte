<script lang="ts">
  import type { SyncProgress, SyncState } from './lib/sync-model';
  import VersionPopout from './components/VersionPopout.svelte';

  interface Props {
    version: string;
    state?: SyncState;
    progress?: SyncProgress | null;
    filesProgressed?: number;
    totalFiles?: number;
    workspaceCount?: number;
    observedBytes?: number;
    nextMeetingLabel?: string | null;
    onOpenSettings?: () => void;
  }

  // Rename `state` → `syncStateProp` so `$state(...)` runes below are not
  // misread as a Svelte store subscription on the `state` prop binding.
  let {
    version,
    state: syncStateProp,
    progress,
    filesProgressed,
    totalFiles,
    workspaceCount,
    observedBytes,
    nextMeetingLabel,
    onOpenSettings,
  }: Props = $props();

  const currentState = $derived(syncStateProp ?? 'idle');
  const currentProgress = $derived(progress ?? null);
  const currentFilesProgressed = $derived(filesProgressed ?? 0);
  const currentTotalFiles = $derived(totalFiles ?? 0);
  const currentWorkspaceCount = $derived(workspaceCount ?? 0);
  const currentObservedBytes = $derived(observedBytes ?? 0);
  const currentNextMeetingLabel = $derived(nextMeetingLabel ?? null);

  let versionOpen = $state(false);
  let versionContainer: HTMLDivElement | null = $state(null);

  const tone = $derived.by(() => {
    if (currentState === 'syncing') return 'syncing';
    if (currentState === 'error') return 'error';
    if (currentState === 'conflict' || currentState === 'setup-needed') return 'conflict';
    return 'idle';
  });

  const syncPercent = $derived(
    currentTotalFiles > 0
      ? Math.min(100, Math.max(0, Math.round((currentFilesProgressed / currentTotalFiles) * 100)))
      : 0,
  );

  const stateLabel = $derived(
    currentState === 'error'
      ? 'Sync error'
      : currentState === 'auth-error'
        ? 'Sign in to keep syncing'
      : currentState === 'conflict'
        ? 'Conflict'
        : currentState === 'setup-needed'
          ? 'Setup needed'
          : 'Idle · all safe',
  );

  function formatMb(bytes: number): string {
    if (bytes <= 0) return '0 MB';
    const mb = bytes / (1024 * 1024);
    if (mb < 1) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    if (mb < 1000) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
    return `${(mb / 1024).toFixed(1)} GB`;
  }

  const bytesLabel = $derived(formatMb(currentObservedBytes));

  function toggleVersionPopout() {
    versionOpen = !versionOpen;
  }

  function closeVersionPopout() {
    versionOpen = false;
  }

  $effect(() => {
    if (!versionOpen) return;

    function onMouseDown(event: MouseEvent) {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (versionContainer && !versionContainer.contains(target)) {
        versionOpen = false;
      }
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        versionOpen = false;
      }
    }

    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  });
</script>

<footer class="desktop-status-bar live-strip" aria-label="Status">
  <div class="ls-left">
    {#if currentState === 'syncing' && currentProgress}
      <svg class="ls-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M12 5v14" />
        <path d="m19 12-7 7-7-7" />
      </svg>
      <span class="ls-path mono">{currentProgress.path}</span>
      <span class="ls-progress" aria-hidden="true"><span style={`width:${syncPercent}%`}></span></span>
      <span class="ls-count mono">{currentFilesProgressed}/{currentTotalFiles} files</span>
    {:else}
      <span class={`ls-dot ${tone}`} aria-hidden="true"></span>
      <span class="ls-state">{stateLabel}</span>
      {#if currentObservedBytes > 0}
        <span class="ls-count mono">{bytesLabel} synced</span>
      {/if}
    {/if}
  </div>

  <div class="ls-right">
    {#if currentNextMeetingLabel}
      <span class="ls-meta">next <span class="mono">{currentNextMeetingLabel}</span></span>
      <span class="ls-div" aria-hidden="true"></span>
    {/if}
    <span class="ls-meta">watching <span class="mono">{currentWorkspaceCount}</span> workspace{currentWorkspaceCount === 1 ? '' : 's'}</span>
    <span class="ls-div" aria-hidden="true"></span>
    <div class="ls-version-wrap" bind:this={versionContainer}>
      <button
        type="button"
        class="ls-version mono"
        data-testid="version-label"
        aria-expanded={versionOpen}
        aria-haspopup="dialog"
        aria-label={`Version v${version}`}
        onclick={toggleVersionPopout}
      >
        v{version}
      </button>
      {#if versionOpen}
        <VersionPopout
          {version}
          onOpenSettings={() => onOpenSettings?.()}
          onclose={closeVersionPopout}
        />
      {/if}
    </div>
  </div>
</footer>

<style>
  .ls-left,
  .ls-right {
    display: flex;
    align-items: center;
    min-width: 0;
    gap: 12px;
  }

  .ls-left {
    overflow: hidden;
  }

  .ls-right {
    flex: 0 0 auto;
  }

  .mono {
    font-family: var(--font-mono);
    color: var(--fg-data);
  }

  .ls-glyph {
    flex: 0 0 auto;
    width: 12px;
    height: 12px;
    color: var(--muted);
  }

  .ls-path {
    min-width: 0;
    overflow: hidden;
    color: var(--fg-data);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ls-progress {
    flex: 0 0 auto;
    width: 80px;
    height: 3px;
    border-radius: 2px;
    background: var(--row-active);
    overflow: hidden;
  }

  .ls-progress span {
    display: block;
    height: 100%;
    background: var(--fg);
    border-radius: 2px;
    transition: width 240ms cubic-bezier(.2, .7, .2, 1);
  }

  .ls-count {
    flex: 0 0 auto;
    white-space: nowrap;
  }

  .ls-dot {
    flex: 0 0 auto;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--muted-2);
  }

  .ls-dot.idle {
    background: var(--emerald);
  }
  .ls-dot.syncing {
    background: var(--blue);
  }
  .ls-dot.error {
    background: var(--red);
  }
  .ls-dot.conflict {
    background: var(--amber);
  }

  .ls-state {
    flex: 0 0 auto;
    color: var(--muted);
    white-space: nowrap;
  }

  .ls-meta {
    flex: 0 0 auto;
    color: var(--muted);
    white-space: nowrap;
  }

  .ls-div {
    width: 1px;
    height: 12px;
    background: var(--border-strong);
  }

  .ls-version-wrap {
    position: relative;
    flex: 0 0 auto;
  }

  .ls-version {
    flex: 0 0 auto;
    margin: 0;
    padding: 0;
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    font-family: var(--font-mono);
    cursor: pointer;
  }

  .ls-version:hover {
    color: var(--fg);
  }

  @media (prefers-reduced-motion: no-preference) {
    .ls-dot.syncing {
      animation: status-breathe 1.2s ease-in-out infinite;
    }
  }

  @keyframes status-breathe {
    0%,
    100% {
      opacity: 0.7;
    }
    50% {
      opacity: 1;
    }
  }

  @media (max-width: 720px) {
    .ls-meta:first-child {
      display: none;
    }
  }
</style>
