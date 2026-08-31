<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import { onMount } from 'svelte';

  interface Props {
    oncomplete: (action: 'completed' | 'skipped' | 'failed') => void;
    onTelemetry?: (event: {
      action: 'entered' | 'started' | 'completed' | 'skipped' | 'failed';
      detectedToolCount?: number;
      outcome?: string;
    }) => void;
  }

  interface ClaudeDesktopConnectors {
    present: boolean;
    count: number;
    path: string;
  }

  interface ImportResult {
    ok: boolean;
    message: string;
  }

  let { oncomplete, onTelemetry }: Props = $props();
  let connectorCount = $state(0);
  let status = $state<'detecting' | 'offer' | 'importing' | 'success' | 'failure'>(
    'detecting',
  );
  let advanced = false;

  function complete(action: 'completed' | 'skipped' | 'failed'): void {
    if (advanced) return;
    advanced = true;
    oncomplete(action);
  }

  onMount(() => {
    onTelemetry?.({ action: 'entered' });
    void (async () => {
      try {
        const result = await invoke<ClaudeDesktopConnectors>(
          'detect_claude_desktop_connectors',
        );
        connectorCount = result.count;
        if (result.count === 0) {
          onTelemetry?.({
            action: 'skipped',
            detectedToolCount: 0,
            outcome: 'none_detected',
          });
          complete('skipped');
          return;
        }
        status = 'offer';
      } catch {
        // Detection is optional. Do not make a probe failure block setup.
        onTelemetry?.({
          action: 'skipped',
          detectedToolCount: 0,
          outcome: 'detection_unavailable',
        });
        complete('skipped');
      }
    })();
  });

  async function importConnectors(): Promise<void> {
    if (status === 'importing') return;
    status = 'importing';
    onTelemetry?.({ action: 'started', detectedToolCount: connectorCount });
    try {
      const result = await invoke<ImportResult>('import_claude_desktop_connectors');
      status = result.ok ? 'success' : 'failure';
      onTelemetry?.({
        action: result.ok ? 'completed' : 'failed',
        detectedToolCount: connectorCount,
        outcome: result.ok ? 'imported' : 'import_failed',
      });
    } catch {
      status = 'failure';
      onTelemetry?.({
        action: 'failed',
        detectedToolCount: connectorCount,
        outcome: 'command_failed',
      });
    }
  }
</script>

{#if status === 'offer' || status === 'importing'}
  <h2 class="h" id="onboarding-title-connector-import">Import Claude Desktop connectors?</h2>
  <p class="body" data-testid="connector-import-offer">
    We found {connectorCount} Claude Desktop connector{connectorCount === 1 ? '' : 's'}.
    Import them into your HQ integrations?
  </p>
  <div class="btns">
    <button
      class="btn btn-primary"
      type="button"
      data-testid="connector-import-import"
      disabled={status === 'importing'}
      aria-busy={status === 'importing'}
      onclick={() => void importConnectors()}
    >{#if status === 'importing'}<span class="spinner" aria-hidden="true"></span>Importing…{:else}Import{/if}</button>
    <button
      class="btn btn-secondary"
      type="button"
      data-testid="connector-import-skip"
      disabled={status === 'importing'}
      onclick={() => {
        onTelemetry?.({
          action: 'skipped',
          detectedToolCount: connectorCount,
          outcome: 'user_skipped',
        });
        complete('skipped');
      }}
    >Skip</button>
  </div>
{:else if status === 'success'}
  <h2 class="h" id="onboarding-title-connector-import">Imported</h2>
  <p class="body" data-testid="connector-import-success">
    Your Claude Desktop connectors are now available in HQ integrations.
  </p>
  <div class="btns">
    <button
      class="btn btn-primary"
      type="button"
      data-testid="connector-import-continue"
      onclick={() => complete('completed')}
    >Continue</button>
  </div>
{:else if status === 'failure'}
  <h2 class="h" id="onboarding-title-connector-import">Couldn’t import</h2>
  <p class="body" data-testid="connector-import-failure">
    Couldn't import — you can run <code>hq integrations import</code> later.
  </p>
  <div class="btns">
    <button
      class="btn btn-primary"
      type="button"
      data-testid="connector-import-continue"
      onclick={() => complete('failed')}
    >Continue</button>
  </div>
{/if}

<style>
  .h { margin: 0; color: var(--c-text); font-size: 22px; font-weight: 500; line-height: 28px; letter-spacing: -0.4px; }
  .body { margin: 12px 0 0; color: var(--c-muted); font-size: 14px; line-height: 20px; }
  .body code { font-family: ui-monospace, "SF Mono", Menlo, Monaco, monospace; font-size: 0.92em; }
  .btns { display: flex; flex-wrap: wrap; gap: 8px; margin-top: auto; }
  .btn { font-family: inherit; font-size: 14px; font-weight: 400; line-height: 20px; padding: 10px 16px; border: none; border-radius: 8px; cursor: pointer; }
  .btn-primary { background: var(--c-btn-bg); color: var(--c-btn-fg); }
  .btn-secondary { background: var(--c-btn2-bg); color: var(--c-btn2-fg); }
  .btn:disabled { cursor: not-allowed; opacity: .48; }
  .btn:focus-visible { outline: 1.5px solid var(--c-focus-ring, var(--c-text)); outline-offset: var(--c-focus-offset, 2px); }
  .spinner { display: inline-block; width: 11px; height: 11px; margin-right: 6px; border: 1.5px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: spin .7s linear infinite; vertical-align: -1px; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
