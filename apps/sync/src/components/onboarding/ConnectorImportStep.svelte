<script lang="ts">
  import RailIcon from '@hq/ui/rail-icon';
  import { invoke } from '@tauri-apps/api/core';
  import { onMount } from 'svelte';
  import type {
    ConnectorImportOutcome,
    ConnectorImportSourceSet,
    ErrorCategory,
  } from '../../lib/onboarding-setup';

  interface Props {
    oncomplete: () => void;
    /**
     * Called once there is something to show (connectors were found). Until
     * then the step renders nothing, so the welcome flow keeps the screen it
     * was on instead of flashing an empty panel for an auto-skip.
     */
    onoffer?: () => void;
    onTelemetry?: (event: {
      action: 'entered' | 'started' | 'completed' | 'skipped' | 'failed';
      detectedToolCount?: number;
      detectedSourceSet?: ConnectorImportSourceSet;
      outcome?: ConnectorImportOutcome;
      errorCategory?: ErrorCategory;
    }) => void;
  }

  interface ClaudeDesktopConnectors {
    present: boolean;
    count: number;
    outcome: ConnectorImportOutcome;
    inspectedSources: ConnectorImportSourceSet;
  }

  interface ImportResult {
    ok: boolean;
    message: string;
    errorCategory: ErrorCategory;
  }

  let { oncomplete, onoffer, onTelemetry }: Props = $props();
  let connectorCount = $state(0);
  let detectedSourceSet = $state<ConnectorImportSourceSet>('unknown');
  let status = $state<'detecting' | 'offer' | 'importing' | 'success' | 'failure'>(
    'detecting',
  );
  let advanced = false;

  function complete(): void {
    if (advanced) return;
    advanced = true;
    oncomplete();
  }

  onMount(() => {
    onTelemetry?.({ action: 'entered' });
    void (async () => {
      try {
        const result = await invoke<ClaudeDesktopConnectors>(
          'detect_claude_desktop_connectors',
        );
        connectorCount = result.count;
        detectedSourceSet = result.inspectedSources;
        if (result.count === 0) {
          onTelemetry?.({
            action: 'skipped',
            detectedToolCount: 0,
            detectedSourceSet,
            outcome: result.outcome,
          });
          complete();
          return;
        }
        status = 'offer';
        onoffer?.();
      } catch {
        // Detection is optional. Do not make a probe failure block setup.
        onTelemetry?.({
          action: 'skipped',
          detectedToolCount: 0,
          detectedSourceSet: 'unknown',
          outcome: 'command_failed',
        });
        complete();
      }
    })();
  });

  async function importConnectors(): Promise<void> {
    if (status === 'importing') return;
    status = 'importing';
    onTelemetry?.({
      action: 'started',
      detectedToolCount: connectorCount,
      detectedSourceSet,
    });
    try {
      const result = await invoke<ImportResult>('import_claude_desktop_connectors');
      status = result.ok ? 'success' : 'failure';
      onTelemetry?.({
        action: result.ok ? 'completed' : 'failed',
        detectedToolCount: connectorCount,
        detectedSourceSet,
        outcome: result.ok ? 'imported' : 'import_failed',
        ...(result.ok ? {} : { errorCategory: result.errorCategory }),
      });
    } catch {
      status = 'failure';
      onTelemetry?.({
        action: 'failed',
        detectedToolCount: connectorCount,
        detectedSourceSet,
        outcome: 'command_failed',
        errorCategory: 'unknown',
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
    >{#if status === 'importing'}<span class="spinner" aria-hidden="true"></span>Importing…{:else}<RailIcon name="download" />Import{/if}</button>
    <button
      class="btn btn-secondary"
      type="button"
      data-testid="connector-import-skip"
      disabled={status === 'importing'}
      onclick={() => {
        onTelemetry?.({
          action: 'skipped',
          detectedToolCount: connectorCount,
          detectedSourceSet,
          outcome: 'user_skipped',
        });
        complete();
      }}
    ><RailIcon name="arrow-right" />Skip</button>
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
      onclick={() => complete()}
    ><RailIcon name="arrow-right" />Continue</button>
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
      onclick={() => complete()}
    ><RailIcon name="arrow-right" />Continue</button>
  </div>
{/if}

<style>
  /* Rendered inside the welcome flow's dark veil: Fraunces title, Geist body,
     the flow's button geometry. */
  .h { margin: 0; color: var(--c-text); font-family: 'Fraunces', Georgia, 'Times New Roman', serif; font-size: 34px; font-weight: 300; font-variation-settings: 'wght' 300, 'SOFT' 0, 'WONK' 1; line-height: 1.04; letter-spacing: -0.04em; }
  .body { margin: 14px 0 0; color: var(--c-muted); font-size: 15px; line-height: 22px; }
  .body code { font-family: ui-monospace, "SF Mono", Menlo, Monaco, monospace; font-size: 0.92em; }
  .btns { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; margin-top: 28px; }
  .btn { font-family: inherit; font-size: 14px; font-weight: 400; line-height: 20px; padding: 9px 18px; border: none; border-radius: 8px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; }
  .btn-primary { background: var(--c-btn-bg); color: var(--c-btn-fg); }
  .btn-secondary { background: var(--c-btn2-bg); color: var(--c-btn2-fg); }
  .btn:disabled { cursor: default; opacity: .45; }
  .btn:focus-visible { outline: 1.5px solid var(--c-focus-ring, var(--c-text)); outline-offset: var(--c-focus-offset, 2px); }
  .spinner { display: inline-block; width: 11px; height: 11px; border: 1.5px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: spin .7s linear infinite; vertical-align: -1px; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
</style>
