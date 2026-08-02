<script lang="ts">
  /**
   * InstalledPacksPanel — the desktop-alt **Installed** tab body (US-009).
   *
   * This is the unified home for *installed* HQ packs. It absorbs the function
   * of the old standalone Packages window (`src/packages/PackagesApp.svelte`,
   * removed in US-009) so packages are no longer split between a separate window
   * / Settings entry and the marketplace — installed packs and browsable
   * (Marketplace tab) packs now live in ONE coherent Library surface.
   *
   * It reuses the SAME Tauri commands the old window used — `list_packages`,
   * `check_package_updates`, `install_package`, `update_package`,
   * `uninstall_package` — and the same `packages:*` event stream, so the
   * install / update / uninstall flows are byte-for-byte the behaviour that
   * shipped, just re-housed. Nothing about the install pipeline changed; only
   * the surface that hosts it.
   *
   * Visual language matches LibraryList / MarketplacePanel: desktop-alt CSS
   * variables only (no hardcoded colors), Foundry-style tiles, monospace
   * micro-labels, hairline borders, and the shared light/dark/reduced-* contract.
   */
  import { onMount } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { listen, type UnlistenFn } from '@tauri-apps/api/event';
  import { safeUnlisten } from '../../lib/listener-registry';
  import {
    shortSource,
    packIdentity,
    isPromptRenderable,
    friendlyPackagesError,
    isMissingPackagesToolError,
    type PackagesView,
    type InstalledPack,
    type AvailablePack,
    type PackagesProgress,
    type PackagesDone,
  } from '../../lib/packages';

  let view = $state<PackagesView | null>(null);
  let loading = $state(true);
  let refreshing = $state(false);
  let busy = $state<{ op: string; id: string; label: string } | null>(null);
  let logLines = $state<string[]>([]);
  let errorMsg = $state<string | null>(null);
  let errorContext = $state<'read' | 'mutation'>('read');
  let updateProbeError = $state<string | null>(null);
  let repairCommandState = $state<'idle' | 'copying' | 'copied' | 'failed'>('idle');
  let repairCommandError = $state<string | null>(null);
  let repairCommandTimer: ReturnType<typeof setTimeout> | null = null;
  let confirmUninstall = $state<string | null>(null);
  // Per-pack "copied" feedback for the Get started copy button, keyed by pack name.
  let copiedPack = $state<string | null>(null);
  let copyingPack = $state<string | null>(null);
  let copiedTimer: ReturnType<typeof setTimeout> | null = null;
  // Separate "copied" feedback for the (moderation-gated) setup-prompt copy button.
  let copiedPrompt = $state<string | null>(null);
  let copyingPrompt = $state<string | null>(null);
  let copiedPromptTimer: ReturnType<typeof setTimeout> | null = null;
  type ClipboardAction = 'get-started' | 'setup-prompt';
  interface ClipboardFailure {
    action: ClipboardAction;
    message: string;
  }
  let clipboardFailures = $state<Record<string, ClipboardFailure | undefined>>({});

  const installed = $derived(view?.packs?.installed ?? []);
  const installedIdentities = $derived(
    new Set(
      installed
        .flatMap((pack) => [packIdentity(pack.name), packIdentity(pack.source)])
        .filter(Boolean),
    ),
  );
  const available = $derived(
    (view?.packs?.available ?? []).filter((pack) => {
      const identity = packIdentity(pack.source);
      return identity !== '' && !installedIdentities.has(identity);
    }),
  );
  const registryAvailable = $derived(
    (view?.registry?.available ?? []).filter((pack) => {
      const identity = packIdentity(pack.slug);
      return identity !== '' && !installedIdentities.has(identity);
    }),
  );
  const hasPackSnapshot = $derived(Boolean(view?.packs));
  const updatesCount = $derived(installed.filter((p) => p.updateAvailable).length);
  const HQ_CLI_INSTALL_COMMAND = 'npm install -g @indigoai-us/hq-cli@latest';

  function actionErrorMessage(error: unknown): string {
    if (error instanceof Error && error.message) return error.message;
    if (typeof error === 'string' && error.trim()) return error;
    return 'Clipboard access was rejected.';
  }

  async function refresh(): Promise<void> {
    if (refreshing) return;
    refreshing = true;
    try {
      const next = await invoke<PackagesView>('list_packages');
      if (next.packs) {
        view = next;
        errorMsg = null;
      } else {
        // Preserve a successful snapshot when a later refresh cannot start the
        // CLI. On a cold load retain the failed payload so the empty state stays
        // honest while the actionable error is shown.
        if (!view) view = next;
        errorMsg = next.error ?? 'Installed packs could not be loaded';
        errorContext = 'read';
      }
    } catch (e) {
      errorMsg = String(e);
      errorContext = 'read';
    } finally {
      refreshing = false;
    }
  }

  async function copyRepairCommand(): Promise<void> {
    if (repairCommandState === 'copying') return;
    repairCommandState = 'copying';
    try {
      await navigator.clipboard.writeText(HQ_CLI_INSTALL_COMMAND);
      repairCommandState = 'copied';
      repairCommandError = null;
      if (repairCommandTimer) clearTimeout(repairCommandTimer);
      repairCommandTimer = setTimeout(() => {
        repairCommandState = 'idle';
        repairCommandTimer = null;
      }, 1800);
    } catch (error) {
      console.error('installed-packs: repair command copy failed', error);
      repairCommandState = 'failed';
      repairCommandError = actionErrorMessage(error);
    }
  }

  async function install(source: string, registry = false): Promise<void> {
    busy = { op: 'install', id: source, label: shortSource(source) };
    logLines = [];
    errorMsg = null;
    try {
      await invoke('install_package', { source, registry });
    } catch (e) {
      errorMsg = String(e);
      errorContext = 'mutation';
      busy = null;
    }
  }

  async function update(name: string): Promise<void> {
    busy = { op: 'update', id: name, label: name };
    logLines = [];
    errorMsg = null;
    try {
      await invoke('update_package', { name });
    } catch (e) {
      errorMsg = String(e);
      errorContext = 'mutation';
      busy = null;
    }
  }

  async function uninstall(name: string): Promise<void> {
    busy = { op: 'uninstall', id: name, label: name };
    logLines = [];
    errorMsg = null;
    try {
      await invoke('uninstall_package', { name });
      logLines = [`Uninstalled ${name}.`];
      await refresh();
      confirmUninstall = null;
    } catch (e) {
      errorMsg = String(e);
      errorContext = 'mutation';
    } finally {
      busy = null;
    }
  }

  function checkUpdates(): void {
    invoke('check_package_updates').catch(() => {});
  }

  onMount(() => {
    const unlisteners: UnlistenFn[] = [];
    void (async () => {
      unlisteners.push(
        await listen<PackagesProgress>('packages:progress', (e) => {
          logLines = [...logLines.slice(-200), e.payload.line];
        }),
      );
      unlisteners.push(
        await listen<PackagesDone>('packages:complete', async () => {
          busy = null;
          await refresh();
        }),
      );
      unlisteners.push(
        await listen<PackagesDone>('packages:error', (e) => {
          errorMsg = e.payload.message ?? 'Operation failed';
          errorContext = 'mutation';
          busy = null;
        }),
      );
      unlisteners.push(
        await listen<PackagesView>('packages:updates', (e) => {
          if (e.payload.error || !e.payload.packs) {
            // A background network/update probe must never erase a valid local
            // installed-pack snapshot.
            updateProbeError = e.payload.error ?? 'Update check failed';
            return;
          }
          view = {
            packs: e.payload.packs,
            registry: e.payload.registry ?? view?.registry ?? null,
            error: null,
          };
          updateProbeError = null;
        }),
      );

      // No window-ready handshake here (this is an in-Library tab, not a
      // secondary window) — just cold-load on mount.
      await refresh();
      loading = false;
      // Kick off the slower update probe in the background.
      checkUpdates();
    })();

    return () => {
      unlisteners.forEach((u) => safeUnlisten(u)());
      if (repairCommandTimer) clearTimeout(repairCommandTimer);
    };
  });

  function contributeSummary(p: InstalledPack): string {
    const parts = Object.entries(p.contributes).map(([k, n]) => `${n} ${k}`);
    return parts.join(', ') || 'no contributions';
  }

  /**
   * Normalize a pack's `initialization.entrypoint` into a slash-prefixed command
   * token (e.g. `email-assistant` → `/email-assistant`). Returns `null` when the
   * pack declares no usable entrypoint, so the Get started affordance is hidden.
   *
   * PHASE 1: we render ONLY this safe, author-declared entrypoint — never the
   * free-text `initialization.prompt` prose (that is a later, moderation-gated
   * story). Deriving the line purely from the entrypoint keeps it un-spoofable.
   */
  function getStartedCommand(p: InstalledPack): string | null {
    const raw = p.initialization?.entrypoint?.trim();
    if (!raw) return null;
    return raw.startsWith('/') ? raw : `/${raw}`;
  }

  /** The ready-to-paste line for a pack — the same text the copy button writes. */
  function getStartedLine(p: InstalledPack): string | null {
    const cmd = getStartedCommand(p);
    return cmd ? `Run ${cmd} to get started` : null;
  }

  function clipboardFailureKey(p: InstalledPack, action: ClipboardAction): string {
    return `${action}:${p.name}:${p.source ?? p.transport ?? ''}`;
  }

  function clipboardFailure(
    p: InstalledPack,
    action: ClipboardAction,
  ): ClipboardFailure | undefined {
    return clipboardFailures[clipboardFailureKey(p, action)];
  }

  function clearClipboardFailure(p: InstalledPack, action: ClipboardAction): void {
    clipboardFailures = {
      ...clipboardFailures,
      [clipboardFailureKey(p, action)]: undefined,
    };
  }

  function setClipboardFailure(
    p: InstalledPack,
    action: ClipboardAction,
    error: unknown,
  ): void {
    clipboardFailures = {
      ...clipboardFailures,
      [clipboardFailureKey(p, action)]: {
        action,
        message: actionErrorMessage(error),
      },
    };
  }

  function retryClipboardAction(p: InstalledPack, action: ClipboardAction): Promise<void> {
    return action === 'get-started' ? copyGetStarted(p) : copySetupPrompt(p);
  }

  async function copyGetStarted(p: InstalledPack): Promise<void> {
    const line = getStartedLine(p);
    if (!line || copyingPack) return;
    copyingPack = p.name;
    try {
      await navigator.clipboard.writeText(line);
      copiedPack = p.name;
      clearClipboardFailure(p, 'get-started');
      if (copiedTimer) clearTimeout(copiedTimer);
      copiedTimer = setTimeout(() => {
        copiedPack = null;
        copiedTimer = null;
      }, 1800);
    } catch (err) {
      console.error('installed-packs: clipboard write failed', err);
      setClipboardFailure(p, 'get-started', err);
    } finally {
      copyingPack = null;
    }
  }

  /**
   * Copy the pack author's full setup `prompt` to the clipboard.
   *
   * SAFETY: this is only ever wired to a pack for which `isPromptRenderable(p)`
   * is true — i.e. the pack came from the MODERATED marketplace/registry origin
   * AND its prose carries the explicit server-set `promptModerated === true`
   * approval signal. We re-check the predicate here as defense-in-depth so a
   * stray caller can never exfiltrate un-moderated prose to the clipboard.
   */
  async function copySetupPrompt(p: InstalledPack): Promise<void> {
    if (!isPromptRenderable(p) || copyingPrompt) return;
    const prompt = p.initialization?.prompt;
    if (!prompt) return;
    copyingPrompt = p.name;
    try {
      await navigator.clipboard.writeText(prompt);
      copiedPrompt = p.name;
      clearClipboardFailure(p, 'setup-prompt');
      if (copiedPromptTimer) clearTimeout(copiedPromptTimer);
      copiedPromptTimer = setTimeout(() => {
        copiedPrompt = null;
        copiedPromptTimer = null;
      }, 1800);
    } catch (err) {
      console.error('installed-packs: setup-prompt clipboard write failed', err);
      setClipboardFailure(p, 'setup-prompt', err);
    } finally {
      copyingPrompt = null;
    }
  }

  function isGatedOff(a: AvailablePack): boolean {
    return a.conditionalStatus === 'fail';
  }

  function isPackBusy(op: 'install' | 'update' | 'uninstall', id: string): boolean {
    return busy?.op === op && busy.id === id;
  }
</script>

<div class="installed-packs" data-testid="installed-packs-panel">
  <div class="toolbar">
    <p class="count" aria-live="polite">
      {#if loading}
        Loading…
      {:else if !hasPackSnapshot}
        Installed packs unavailable
      {:else}
        {installed.length}
        {installed.length === 1 ? 'pack' : 'packs'} installed
        {#if updatesCount > 0}
          <span class="badge" data-testid="installed-updates-badge"
            >{updatesCount} update{updatesCount === 1 ? '' : 's'}</span
          >
        {/if}
      {/if}
    </p>
    <button
      type="button"
      class="refresh"
      data-testid="installed-refresh"
      onclick={refresh}
      disabled={!!busy || refreshing}
      aria-busy={refreshing}>{refreshing ? 'Refreshing…' : 'Refresh'}</button
    >
  </div>

  {#if errorMsg}
    <div class="state-error" role="alert" data-testid="installed-error">
      <div class="state-error-copy">
        <strong>{friendlyPackagesError(errorMsg)}</strong>
        <span>
          {errorContext === 'read'
            ? hasPackSnapshot
              ? 'The last successful installed-pack view is preserved.'
              : 'No installed-pack data was available yet. Repair the HQ CLI, then refresh.'
            : 'The operation did not finish. Review the details before retrying.'}
        </span>
      </div>
      {#if !hasPackSnapshot || isMissingPackagesToolError(errorMsg)}
        <button
          type="button"
          class="repair-link"
          onclick={copyRepairCommand}
          disabled={repairCommandState === 'copying'}
          aria-busy={repairCommandState === 'copying'}
          title={HQ_CLI_INSTALL_COMMAND}
        >
          {repairCommandState === 'copying'
            ? 'Copying…'
            : repairCommandState === 'copied'
              ? 'Command copied'
              : repairCommandState === 'failed'
                ? 'Copy failed'
                : hasPackSnapshot
                  ? 'Copy repair command'
                  : 'Copy install command'}
        </button>
        {#if repairCommandError}
          <span class="pack-action-error" role="alert" title={repairCommandError}>
            Couldn’t copy to the clipboard.
            <button
              type="button"
              onclick={copyRepairCommand}
              disabled={repairCommandState === 'copying'}
              aria-busy={repairCommandState === 'copying'}
            >
              {repairCommandState === 'copying' ? 'Retrying…' : 'Retry'}
            </button>
          </span>
        {/if}
      {/if}
      <details>
        <summary>Technical details</summary>
        <code>{errorMsg}</code>
      </details>
    </div>
  {/if}

  {#if updateProbeError}
    <p class="probe-note" role="status" title={updateProbeError}>
      Update availability could not be refreshed. Installed packs remain available.
    </p>
  {/if}

  {#if busy}
    <section class="op" data-testid="installed-op">
      <div class="op-head">
        <span class="spinner" aria-hidden="true"></span>
        {busy.op === 'install' ? 'Installing' : busy.op === 'update' ? 'Updating' : 'Uninstalling'}
        <strong>{busy.label}</strong>…
      </div>
      {#if logLines.length}
        <pre class="log" data-testid="installed-log">{logLines.join('\n')}</pre>
      {/if}
    </section>
  {/if}

  {#if loading}
    <div class="grid-skeleton" aria-busy="true">
      {#each [0, 1, 2, 3] as cell (cell)}
        <div class="card-skeleton"></div>
      {/each}
    </div>
  {:else if hasPackSnapshot}
    <section class="group" data-testid="installed-group">
      <h2 class="group-title">Installed</h2>
      {#if installed.length === 0}
        <div class="state-empty">
          <p>No packs installed</p>
          <span>Browse the Marketplace tab to find and install packs.</span>
        </div>
      {/if}
      <!--
        `hq packs list` can surface the same display name more than once while
        legacy package and pack records coexist. Names are therefore not valid
        Svelte identities. Include origin + position so duplicate rows remain
        inspectable instead of crashing the entire Library surface.
      -->
      {#each installed as p, index (`installed:${p.name}:${p.source ?? p.transport ?? ''}:${index}`)}
        <div class="row" data-testid="installed-row">
          <div class="row-main">
            <div class="row-title">
              <span class="row-name">{p.name}</span>
              {#if p.version}<span class="pill ver">v{p.version}</span>{/if}
              {#if p.updateAvailable}<span class="pill update">update</span>{/if}
              {#if p.hqCoreSatisfied === false}<span class="pill warn"
                  >needs HQ {p.requiresHqCore}</span
                >{/if}
              {#if p.links.broken > 0}<span class="pill warn"
                  >{p.links.broken} broken link{p.links.broken === 1 ? '' : 's'}</span
                >{/if}
            </div>
            <div class="row-sub">
              {#if p.error}{p.error}{:else}{contributeSummary(p)}{/if}
            </div>
            {#if getStartedCommand(p)}
              {@const cmd = getStartedCommand(p)}
              <div class="get-started" data-testid="installed-get-started">
                <span class="get-started-label">Get started</span>
                <code class="get-started-cmd">{cmd}</code>
                <button
                  type="button"
                  class="get-started-copy"
                  data-testid="installed-get-started-copy"
                  onclick={() => copyGetStarted(p)}
                  disabled={!!copyingPack}
                  aria-busy={copyingPack === p.name}
                  aria-label={`Copy "Run ${cmd} to get started"`}
                  title={`Run ${cmd} to get started`}
                >
                  {copyingPack === p.name
                    ? 'Copying…'
                    : copiedPack === p.name
                      ? 'Copied'
                      : 'Copy'}
                </button>
              </div>
              {#if clipboardFailure(p, 'get-started')}
                {@const failure = clipboardFailure(p, 'get-started') as ClipboardFailure}
                <p class="pack-action-error" role="alert" title={failure.message}>
                  <span>Couldn’t copy to the clipboard.</span>
                  <button
                    type="button"
                    onclick={() => retryClipboardAction(p, failure.action)}
                    disabled={copyingPack === p.name}
                    aria-busy={copyingPack === p.name}
                  >
                    {copyingPack === p.name ? 'Retrying…' : 'Retry'}
                  </button>
                </p>
              {/if}
            {/if}
            <!--
              Moderation-approved setup prose (US-009). SUPPRESSED by default:
              `isPromptRenderable` only returns true when the pack came from the
              MODERATED marketplace/registry origin AND its prose carries the
              explicit server-set `promptModerated === true` approval signal. A
              local-path / git-URL install never qualifies, and because the
              server does not emit `promptModerated` yet (a known follow-up) this
              block stays hidden for every pack today — the safe default. The
              entrypoint chip above is always the primary affordance; this only
              ever appears beneath it as an additive option.
            -->
            {#if isPromptRenderable(p)}
              <div class="setup-prompt" data-testid="installed-setup-prompt">
                <div class="setup-prompt-head">
                  <span class="setup-prompt-label">Setup prompt</span>
                  <button
                    type="button"
                    class="setup-prompt-copy"
                    data-testid="installed-setup-prompt-copy"
                    onclick={() => copySetupPrompt(p)}
                    disabled={!!copyingPrompt}
                    aria-busy={copyingPrompt === p.name}
                    aria-label={`Copy ${p.name} setup prompt`}
                    title="Copy the pack author's setup prompt"
                  >
                    {copyingPrompt === p.name
                      ? 'Copying…'
                      : copiedPrompt === p.name
                        ? 'Copied'
                        : 'Copy setup prompt'}
                  </button>
                </div>
                <pre class="setup-prompt-text">{p.initialization?.prompt}</pre>
                <p class="setup-prompt-note">The pack author's setup prompt.</p>
              </div>
              {#if clipboardFailure(p, 'setup-prompt')}
                {@const failure = clipboardFailure(p, 'setup-prompt') as ClipboardFailure}
                <p class="pack-action-error" role="alert" title={failure.message}>
                  <span>Couldn’t copy to the clipboard.</span>
                  <button
                    type="button"
                    onclick={() => retryClipboardAction(p, failure.action)}
                    disabled={copyingPrompt === p.name}
                    aria-busy={copyingPrompt === p.name}
                  >
                    {copyingPrompt === p.name ? 'Retrying…' : 'Retry'}
                  </button>
                </p>
              {/if}
            {/if}
          </div>
          <div class="row-actions">
            {#if p.updateAvailable}
              <button
                class="action primary"
                onclick={() => update(p.name)}
                disabled={!!busy}
                aria-busy={isPackBusy('update', p.name)}
                aria-label={isPackBusy('update', p.name) ? `Updating ${p.name}` : `Update ${p.name}`}
              >
                {isPackBusy('update', p.name) ? 'Updating…' : 'Update'}
              </button>
            {/if}
            <button
              class="action danger"
              onclick={() => (confirmUninstall = p.name)}
              disabled={!!busy}
              aria-busy={isPackBusy('uninstall', p.name)}
              aria-label={isPackBusy('uninstall', p.name) ? `Removing ${p.name}` : `Uninstall ${p.name}`}
            >
              {isPackBusy('uninstall', p.name) ? 'Removing…' : 'Uninstall'}
            </button>
          </div>
        </div>
        {#if confirmUninstall === p.name}
          <div class="confirm" data-testid="installed-confirm">
            Remove <strong>{p.name}</strong> and its host links?
            <button
              class="action danger"
              onclick={() => uninstall(p.name)}
              disabled={!!busy}
              aria-busy={isPackBusy('uninstall', p.name)}
              aria-label={isPackBusy('uninstall', p.name) ? `Removing ${p.name}` : `Remove ${p.name}`}
            >
              {isPackBusy('uninstall', p.name) ? 'Removing…' : 'Remove'}
            </button>
            <button
              class="action ghost"
              onclick={() => (confirmUninstall = null)}
              disabled={!!busy}
            >
              Cancel
            </button>
          </div>
        {/if}
      {/each}
    </section>

    {#if available.length > 0 || registryAvailable.length > 0}
      <section class="group" data-testid="installed-available-group">
        <h2 class="group-title">Available from packs.yaml</h2>
        {#each available as a, index (`available:${a.source}:${index}`)}
          <div class="row">
            <div class="row-main">
              <div class="row-title">
                <span class="row-name">{shortSource(a.source)}</span>
                {#if isGatedOff(a)}<span class="pill warn">gated off</span>{/if}
              </div>
              {#if a.description}<div class="row-sub">{a.description}</div>{/if}
            </div>
            <div class="row-actions">
              <button
                class="action primary"
                onclick={() => install(a.source, false)}
                disabled={!!busy}
                aria-busy={isPackBusy('install', a.source)}
                aria-label={isPackBusy('install', a.source) ? `Installing ${shortSource(a.source)}` : `Install ${shortSource(a.source)}`}
              >
                {isPackBusy('install', a.source) ? 'Installing…' : 'Install'}
              </button>
            </div>
          </div>
        {/each}
        {#each registryAvailable as r, index (`registry:${r.slug}:${index}`)}
          <div class="row">
            <div class="row-main">
              <div class="row-title">
                <span class="row-name">{r.slug}</span>
                {#if r.tier}<span class="pill ver">{r.tier}</span>{/if}
              </div>
              <div class="row-sub">Registry package</div>
            </div>
            <div class="row-actions">
              <button
                class="action primary"
                onclick={() => install(r.slug, true)}
                disabled={!!busy}
                aria-busy={isPackBusy('install', r.slug)}
                aria-label={isPackBusy('install', r.slug) ? `Installing ${shortSource(r.slug)}` : `Install ${shortSource(r.slug)}`}
              >
                {isPackBusy('install', r.slug) ? 'Installing…' : 'Install'}
              </button>
            </div>
          </div>
        {/each}
      </section>
    {/if}

    {#if view?.registry?.offline}
      <p class="offline-note">Registry offline — showing local data only.</p>
    {/if}
  {/if}
</div>

<style>
  .installed-packs {
    display: flex;
    flex-direction: column;
    gap: var(--v4-space-4);
    min-width: 0;
  }

  .toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--v4-space-3);
    min-width: 0;
  }

  .count {
    display: inline-flex;
    align-items: center;
    gap: var(--v4-space-2);
    margin: 0;
    color: var(--v4-text-3);
    font-size: var(--text-base);
  }

  .badge {
    display: inline-flex;
    align-items: center;
    padding: 1px 8px;
    border-radius: 999px;
    background: var(--v4-active-row);
    color: var(--v4-text-2);
    font-size: var(--text-micro);
    font-weight: 600;
  }

  .refresh {
    height: 32px;
    padding: 0 var(--v4-space-3);
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-button);
    background: var(--v4-control-faint);
    color: var(--v4-text-1);
    font: inherit;
    font-size: var(--text-base);
    cursor: pointer;
    transition:
      background 140ms ease,
      border-color 140ms ease;
  }

  .refresh:hover:not(:disabled) {
    border-color: var(--v4-control-border);
    background: var(--v4-active-row);
  }

  .refresh:focus-visible {
    outline: 2px solid var(--v4-control-border);
    outline-offset: 2px;
  }

  .refresh:disabled {
    opacity: 0.55;
    cursor: default;
  }

  /* ---- in-flight op + log ----------------------------------------------- */
  .op {
    padding: var(--v4-space-3) 0 0;
    border: 0;
    border-top: 1px solid var(--v4-hairline);
    border-radius: 0;
    background: transparent;
    box-shadow: none;
  }

  .op-head {
    display: flex;
    align-items: center;
    gap: var(--v4-space-2);
    color: var(--v4-text-1);
    font-size: var(--text-base);
  }

  .log {
    margin: var(--v4-space-2) 0 0;
    max-height: 160px;
    padding: var(--v4-space-2) var(--v4-space-3);
    overflow: auto;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-structure);
    background: var(--v4-raised);
    color: var(--v4-text-2);
    font-family: var(--font-mono);
    font-size: var(--text-micro);
    line-height: 15px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .spinner {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    border: 2px solid var(--v4-control-border);
    border-top-color: var(--v4-text-1);
    animation: installed-spin 0.7s linear infinite;
    display: inline-block;
  }

  @keyframes installed-spin {
    to {
      transform: rotate(360deg);
    }
  }

  /* ---- groups + rows ---------------------------------------------------- */
  .group {
    display: flex;
    flex-direction: column;
    gap: 0;
    min-width: 0;
  }

  .group-title {
    margin: 0 0 var(--v4-space-2);
    color: var(--v4-text-3);
    font-family: var(--font-mono);
    font-size: var(--text-micro);
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .row {
    display: flex;
    align-items: center;
    gap: var(--v4-space-3);
    min-width: 0;
    padding: var(--v4-space-3) var(--v4-space-3) var(--v4-space-3) calc(var(--v4-space-3) + 4px);
    border: 0;
    border-radius: 0;
    background: transparent;
    box-shadow: none;
  }

  .row + .row {
    border-top: 1px solid var(--v4-hairline);
  }

  .confirm + .row {
    border-top: 1px solid var(--v4-hairline);
  }

  .row-main {
    flex: 1;
    min-width: 0;
  }

  .row-title {
    display: flex;
    align-items: center;
    gap: var(--v4-space-2);
    flex-wrap: wrap;
    min-width: 0;
  }

  .row-name {
    color: var(--v4-text-1);
    font-size: var(--text-base);
    font-weight: 600;
  }

  .row-sub {
    margin-top: 2px;
    overflow: hidden;
    color: var(--v4-text-3);
    font-size: var(--text-base);
    line-height: 16px;
    text-overflow: ellipsis;
  }

  /* ---- post-install "Get started" affordance (entrypoint-derived only) --- */
  .get-started {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--v4-space-2);
    margin-top: var(--v4-space-2);
    min-width: 0;
  }

  .get-started-label {
    color: var(--v4-text-3);
    font-family: var(--font-mono);
    font-size: var(--text-micro);
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .get-started-cmd {
    padding: 1px 7px;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-button);
    background: var(--v4-active-row);
    color: var(--v4-text-1);
    font-family: var(--font-mono);
    font-size: var(--text-micro);
    line-height: 15px;
    white-space: nowrap;
  }

  .get-started-copy {
    height: 22px;
    padding: 0 var(--v4-space-2);
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-button);
    background: var(--v4-active-row);
    color: var(--v4-text-3);
    font: inherit;
    font-family: var(--font-mono);
    font-size: var(--text-micro);
    font-weight: 600;
    letter-spacing: 0.04em;
    cursor: pointer;
    transition:
      background 140ms ease,
      border-color 140ms ease,
      color 140ms ease;
  }

  .get-started-copy:hover:not(:disabled) {
    border-color: var(--v4-control-border);
    background: var(--v4-control-faint);
    color: var(--v4-text-1);
  }

  .get-started-copy:focus-visible {
    outline: 2px solid var(--v4-control-border);
    outline-offset: 2px;
  }

  .get-started-copy:disabled,
  .setup-prompt-copy:disabled {
    opacity: 0.58;
    cursor: wait;
  }

  .pack-action-error {
    display: inline-flex;
    align-items: baseline;
    gap: var(--v4-space-2);
    margin: var(--v4-space-1) 0 0;
    color: var(--v4-error);
    font-size: var(--text-micro);
    line-height: 15px;
  }

  .pack-action-error button {
    flex: 0 0 auto;
    padding: 0;
    border: 0;
    border-bottom: 1px solid currentcolor;
    border-radius: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    font-weight: 700;
    cursor: pointer;
  }

  .pack-action-error button:disabled {
    opacity: 0.58;
    cursor: wait;
  }

  /* ---- moderation-approved author setup prompt (US-009, gated) ----------- */
  .setup-prompt {
    display: flex;
    flex-direction: column;
    gap: var(--v4-space-1);
    margin-top: var(--v4-space-2);
    padding: var(--v4-space-2) 0 0;
    border: 0;
    border-top: 1px solid var(--v4-hairline);
    border-radius: 0;
    background: transparent;
    min-width: 0;
  }

  .setup-prompt-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: var(--v4-space-2);
    min-width: 0;
  }

  .setup-prompt-label {
    color: var(--v4-text-3);
    font-family: var(--font-mono);
    font-size: var(--text-micro);
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .setup-prompt-copy {
    height: 22px;
    padding: 0 var(--v4-space-2);
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-button);
    background: var(--v4-active-row);
    color: var(--v4-text-3);
    font: inherit;
    font-family: var(--font-mono);
    font-size: var(--text-micro);
    font-weight: 600;
    letter-spacing: 0.04em;
    cursor: pointer;
    transition:
      background 140ms ease,
      border-color 140ms ease,
      color 140ms ease;
  }

  .setup-prompt-copy:hover:not(:disabled) {
    border-color: var(--v4-control-border);
    background: var(--v4-control-faint);
    color: var(--v4-text-1);
  }

  .setup-prompt-copy:focus-visible {
    outline: 2px solid var(--v4-control-border);
    outline-offset: 2px;
  }

  .setup-prompt-text {
    margin: 0;
    max-height: 200px;
    padding: var(--v4-space-2) var(--v4-space-3);
    overflow: auto;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-structure);
    background: var(--v4-control-faint);
    color: var(--v4-text-1);
    font-family: var(--font-mono);
    font-size: var(--text-micro);
    line-height: 16px;
    /* Preserve the author's line breaks, wrap long lines. */
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .setup-prompt-note {
    margin: 0;
    color: var(--v4-text-3);
    font-size: var(--text-micro);
    line-height: 15px;
  }

  .row-actions {
    display: flex;
    flex-shrink: 0;
    gap: var(--v4-space-2);
  }

  .pill {
    display: inline-flex;
    align-items: center;
    padding: 1px 7px;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-button);
    background: var(--v4-active-row);
    color: var(--v4-text-2);
    font-family: var(--font-mono);
    font-size: var(--text-micro);
    font-weight: 600;
    letter-spacing: 0.05em;
    line-height: 15px;
    white-space: nowrap;
  }

  .pill.ver {
    color: var(--v4-text-2);
  }

  .pill.update {
    border-color: var(--v4-hairline);
    color: var(--v4-text-2);
  }

  .pill.warn {
    border-color: color-mix(in srgb, var(--v4-error) 40%, transparent);
    color: var(--v4-error);
  }

  .action {
    height: 28px;
    padding: 0 var(--v4-space-3);
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-button);
    background: var(--v4-active-row);
    color: var(--v4-text-1);
    font: inherit;
    font-size: var(--text-base);
    font-weight: 600;
    cursor: pointer;
    transition:
      background 140ms ease,
      border-color 140ms ease,
      filter 140ms ease;
  }

  .action:hover:not(:disabled) {
    border-color: var(--v4-control-border);
    background: var(--v4-control-faint);
  }

  .action:focus-visible {
    outline: 2px solid var(--v4-control-border);
    outline-offset: 2px;
  }

  .action:disabled {
    opacity: 0.55;
    cursor: default;
  }

  .action.primary {
    border-color: transparent;
    background: var(--v4-primary-bg);
    color: var(--v4-primary-fg);
  }

  .action.primary:hover:not(:disabled) {
    filter: brightness(0.92);
    background: var(--v4-primary-bg);
  }

  .action.danger {
    border-color: color-mix(in srgb, var(--v4-error) 45%, transparent);
    color: var(--v4-error);
    background: transparent;
  }

  .action.danger:hover:not(:disabled) {
    background: color-mix(in srgb, var(--v4-error) 10%, transparent);
  }

  .action.ghost {
    background: transparent;
  }

  .confirm {
    display: flex;
    align-items: center;
    gap: var(--v4-space-2);
    padding: var(--v4-space-2) 0;
    border: 0;
    border-top: 1px solid var(--v4-rowline);
    border-radius: 0;
    background: transparent;
    color: var(--v4-text-2);
    font-size: var(--text-base);
  }

  /* ---- states ----------------------------------------------------------- */
  .state-error {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--v4-space-3);
    padding: var(--v4-space-3) 0;
    border: 0;
    border-top: 1px solid var(--v4-rowline);
    border-radius: 0;
    background: transparent;
    color: var(--v4-text-2);
    font-size: var(--text-base);
  }

  .state-error-copy {
    display: flex;
    flex: 1 1 320px;
    flex-direction: column;
    gap: 2px;
  }

  .state-error-copy strong {
    color: var(--v4-text-1);
    font-weight: 600;
  }

  .state-error-copy span {
    color: var(--v4-text-3);
  }

  .repair-link {
    padding: 0;
    border: 0;
    border-bottom: 1px solid var(--v4-rowline);
    border-radius: 0;
    background: transparent;
    color: var(--v4-text-1);
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }

  .repair-link:hover:not(:disabled) {
    border-bottom-color: var(--v4-text-2);
  }

  .repair-link:disabled {
    color: var(--v4-text-3);
    cursor: wait;
  }

  .state-error details {
    flex: 0 0 100%;
    color: var(--v4-text-3);
    font-size: var(--text-micro);
  }

  .state-error summary {
    width: fit-content;
    cursor: pointer;
  }

  .state-error code {
    display: block;
    margin-top: var(--v4-space-2);
    color: var(--v4-text-3);
    font-family: var(--font-mono);
    overflow-wrap: anywhere;
  }

  .state-empty {
    padding: var(--v4-space-6);
    border: 0;
    border-radius: 0;
    background: transparent;
    box-shadow: none;
    text-align: center;
  }

  .state-empty p {
    margin: 0 0 var(--v4-space-1);
    color: var(--v4-text-1);
    font-weight: 650;
  }

  .state-empty span {
    color: var(--v4-text-3);
    font-size: var(--text-base);
  }

  .offline-note,
  .probe-note {
    margin: 0;
    color: var(--v4-text-3);
    font-size: var(--text-micro);
  }

  .grid-skeleton {
    display: flex;
    flex-direction: column;
    gap: var(--v4-space-2);
  }

  .card-skeleton {
    height: 56px;
    border: 0;
    border-bottom: 1px solid var(--v4-hairline);
    border-radius: 0;
    background:
      linear-gradient(var(--v4-control-faint), var(--v4-control-faint)) 0 13px / 36% 10px no-repeat,
      linear-gradient(var(--v4-control-faint), var(--v4-control-faint)) 0 33px / 62% 8px no-repeat;
    animation: installed-skeleton-pulse 1.3s ease-in-out infinite;
  }

  @keyframes installed-skeleton-pulse {
    0%,
    100% {
      opacity: 0.5;
    }
    50% {
      opacity: 1;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .refresh,
    .action,
    .repair-link,
    .get-started-copy,
    .setup-prompt-copy {
      transition: none;
    }
    .spinner,
    .card-skeleton {
      animation: none;
    }
  }
</style>
