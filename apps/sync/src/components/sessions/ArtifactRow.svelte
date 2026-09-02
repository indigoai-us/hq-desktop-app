<script lang="ts">
  /**
   * One file the agent produced — name, muted path, and the three things you
   * can do with it: Open, Share, Deploy.
   *
   * Lives only inside an EXPANDED tool group, so it costs the collapsed
   * conversation nothing. The row stats its path when it appears (the file
   * may have been deleted since) and greys every action out while it waits;
   * a missing file says so and offers nothing.
   *
   * Share shows the minted link ONCE, here, with a Copy button — the minting
   * turn is the only surface allowed to show it. Dismissing the card drops
   * the URL from state; it is never logged or written anywhere.
   */
  import { SHARE_VAULT_ONLY_HINT, type ArtifactActions, type ArtifactShare, type ArtifactStat } from './session-artifacts';
  import type { ToolArtifact } from './transcript-adapter';

  interface Props {
    artifact: ToolArtifact;
    actions: ArtifactActions;
  }

  let { artifact, actions }: Props = $props();

  let stat = $state<ArtifactStat | null>(null);
  let statFailed = $state(false);
  let busy = $state<'' | 'open' | 'share'>('');
  let error = $state('');
  let share = $state<ArtifactShare | null>(null);
  let copied = $state(false);

  $effect(() => {
    const path = artifact.path;
    let live = true;
    stat = null;
    statFailed = false;
    actions.stat(path).then(
      (result) => {
        if (live) stat = result;
      },
      () => {
        if (live) statFailed = true;
      },
    );
    return () => {
      live = false;
    };
  });

  const missing = $derived(statFailed || (stat !== null && !stat.exists));
  const pending = $derived(stat === null && !statFailed);
  const canOpen = $derived(!pending && !missing && busy === '');
  const canShare = $derived(!pending && !missing && Boolean(stat?.shareable) && busy === '');
  const canDeploy = $derived(!pending && !missing && Boolean(stat?.deployable) && busy === '');
  const shareHint = $derived(
    !pending && !missing && stat !== null && !stat.shareable ? SHARE_VAULT_ONLY_HINT : undefined,
  );

  async function onOpen() {
    if (!canOpen) return;
    busy = 'open';
    error = '';
    try {
      await actions.open(artifact.path);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      busy = '';
    }
  }

  async function onShare() {
    if (!canShare) return;
    busy = 'share';
    error = '';
    try {
      share = await actions.share(artifact.path);
      copied = false;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      busy = '';
    }
  }

  function onDeploy() {
    if (!canDeploy) return;
    error = '';
    actions.deploy(artifact.path);
  }

  async function copyLink() {
    if (!share) return;
    try {
      await navigator.clipboard.writeText(share.url);
      copied = true;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  function dismissShare() {
    share = null;
    copied = false;
  }
</script>

<li class="artifact" data-testid="session-artifact" data-path={artifact.path} data-missing={missing ? 'true' : 'false'}>
  <div class="line">
    <span class="name">{artifact.name}</span>
    <span class="path" title={artifact.path}>{artifact.path}</span>
    {#if missing}
      <span class="tag" data-testid="session-artifact-missing">missing</span>
    {/if}
    <span class="actions">
      <button
        type="button"
        class="action"
        data-testid="session-artifact-open"
        disabled={!canOpen}
        onclick={onOpen}
      >
        Open
      </button>
      <button
        type="button"
        class="action"
        data-testid="session-artifact-share"
        disabled={!canShare}
        title={shareHint}
        aria-label={shareHint ? `Share — ${shareHint}` : 'Share'}
        onclick={onShare}
      >
        {busy === 'share' ? 'Sharing…' : 'Share'}
      </button>
      <button
        type="button"
        class="action"
        data-testid="session-artifact-deploy"
        disabled={!canDeploy}
        onclick={onDeploy}
      >
        Deploy
      </button>
    </span>
  </div>

  {#if share}
    <div class="share-card" data-testid="session-artifact-share-card" role="status">
      <span class="share-label">Share link · expires in {share.expiresInMinutes} min · single use</span>
      <span class="share-url" data-testid="session-artifact-share-url">{share.url}</span>
      <span class="share-actions">
        <button type="button" class="action" data-testid="session-artifact-copy" onclick={copyLink}>
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button
          type="button"
          class="action"
          data-testid="session-artifact-share-dismiss"
          aria-label="Dismiss share link"
          onclick={dismissShare}
        >
          Dismiss
        </button>
      </span>
    </div>
  {/if}

  {#if error}
    <p class="error" data-testid="session-artifact-error">{error}</p>
  {/if}
</li>

<style>
  .artifact {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 11.5px;
    line-height: 1.6;
    color: var(--v4-text-3);
  }

  .line {
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
  }

  .name {
    flex: none;
    color: var(--v4-text-2);
  }

  .path {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tag {
    flex: none;
    font-family: var(--font-sans);
    font-size: var(--type-metadata);
    color: var(--v4-text-3);
  }

  .actions,
  .share-actions {
    display: inline-flex;
    flex: none;
    gap: 2px;
    margin-left: auto;
    opacity: 0;
    transition: opacity 120ms ease;
  }

  .artifact:hover .actions,
  .artifact:focus-within .actions,
  .share-actions {
    opacity: 1;
  }

  .action {
    padding: 0 6px;
    border: 0;
    border-radius: var(--v4-radius-button);
    background: transparent;
    color: var(--v4-text-2);
    font-family: var(--font-sans);
    font-size: var(--type-metadata);
    line-height: 1.6;
    cursor: pointer;
  }

  .action:hover:not(:disabled) {
    color: var(--v4-text-1);
    background: var(--v4-active-row);
  }

  .action:disabled {
    color: var(--v4-text-3);
    cursor: default;
    opacity: 0.6;
  }

  .share-card {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 10px;
    padding: 6px 8px;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-button);
    background: var(--v4-control-faint, var(--v4-raised));
    font-family: var(--font-sans);
    font-size: var(--type-metadata);
    color: var(--v4-text-2);
  }

  .share-label {
    flex: none;
  }

  .share-url {
    flex: 1 1 200px;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--font-mono, ui-monospace, monospace);
    color: var(--v4-text-1);
    user-select: all;
  }

  .error {
    margin: 0;
    font-family: var(--font-sans);
    font-size: var(--type-metadata);
    color: var(--v4-error, var(--v4-text-2));
    overflow-wrap: anywhere;
  }

  @media (prefers-reduced-motion: reduce) {
    .actions {
      transition: none;
    }
  }
</style>
