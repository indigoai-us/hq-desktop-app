<script lang="ts">
  /**
   * "Connect your AI apps" on the welcome report: the AI apps found on this
   * computer, each with the same setup and Copy button as Settings → AI tools
   * (CONNECTOR_APPS and copyConnectorSetup). Left out when nothing matches.
   */
  import { onDestroy, onMount } from "svelte";
  import type { FoundWorkApps } from "@hq/platform";
  import { copyConnectorSetup, foundConnectorApps, type ConnectorApp } from "../settings/hq-connector-setup.js";

  interface Props {
    /** The launch scan (names only). */
    detect: () => Promise<FoundWorkApps | null>;
    /** Claude Code and the Codex CLI, as the launch detection found them. */
    cli: { claudeCode: boolean; codex: boolean };
    /**
     * The connector whose HQ install succeeded. That row says it is set up
     * and has no Copy prompt. Null keeps every row's Copy option.
     */
    installedId?: string | null;
  }
  let { detect, cli, installedId = null }: Props = $props();

  let scanApps = $state.raw<FoundWorkApps["apps"]>([]);
  let alive = true;
  onDestroy(() => {
    alive = false;
    clearTimeout(copyTimer);
  });
  onMount(() => {
    void detect().then(
      (found) => {
        if (alive) scanApps = found?.apps ?? [];
      },
      () => undefined,
    );
  });

  const apps = $derived(foundConnectorApps(scanApps, cli));

  let copiedId = $state<string | null>(null);
  let copyFailedId = $state<string | null>(null);
  let copyTimer: ReturnType<typeof setTimeout> | undefined;

  async function copy(app: ConnectorApp): Promise<void> {
    clearTimeout(copyTimer);
    copiedId = null;
    copyFailedId = null;
    if (await copyConnectorSetup(app.copyText)) {
      copiedId = app.id;
      copyTimer = setTimeout(() => (copiedId = null), 1500);
    } else {
      copyFailedId = app.id;
    }
  }
</script>

{#if apps.length}
  <section class="ai-apps" data-testid="connect-ai-apps-card">
    <h2>Connect your AI apps</h2>
    <p class="lede">Let the apps you already use read and write your HQ.</p>
    <ul>
      {#each apps as app (app.id)}
        <li data-testid={`connect-ai-app-${app.id}`}>
          <div class="text">
            <div class="name">{app.name}</div>
            {#if installedId === app.id}
              <div class="help">HQ is already installed in {app.name}.</div>
            {:else}
              <div class="help">{app.help}</div>
              {#if app.steps}
                <ol class="help steps">
                  {#each app.steps as step}<li>{step}</li>{/each}
                </ol>
              {/if}
              {#if copyFailedId === app.id}
                <pre class="help manual" data-testid={`connect-ai-app-${app.id}-manual`}>{app.copyText}</pre>
                <div class="help" role="status">Copy didn't work. Select the text above, or tap the button to try again.</div>
              {/if}
            {/if}
          </div>
          {#if installedId === app.id}
            <span class="status" data-testid={`connect-ai-app-${app.id}-setup`}>Set up</span>
          {:else}
            <button type="button" data-testid={`connect-ai-app-${app.id}-copy`} onclick={() => void copy(app)}>
              {copiedId === app.id ? "Copied" : app.copyLabel || "Copy"}
            </button>
          {/if}
        </li>
      {/each}
    </ul>
  </section>
{/if}

<style>
  .ai-apps {
    border-radius: var(--b-r, 22px);
    background: var(--b-card, #222226);
    padding: 20px 22px;
  }
  h2 {
    margin: 0 0 4px;
    font-size: 16px;
    font-weight: 500;
    color: rgba(255, 255, 255, 0.95);
  }
  .lede {
    margin: 0 0 12px;
    font-size: 13px;
    color: rgba(255, 255, 255, 0.72);
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  ul > li {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
  }
  .text {
    min-width: 0;
  }
  .name {
    font-size: 13px;
    font-weight: 600;
  }
  .help {
    font-size: 12px;
    color: rgba(255, 255, 255, 0.56);
  }
  .steps {
    margin: 6px 0 0;
    padding-left: 18px;
  }
  .manual {
    margin: 6px 0 0;
    white-space: pre-wrap;
    word-break: break-word;
    user-select: text;
  }
  button {
    flex: none;
    font: inherit;
    font-size: 12px;
    padding: 6px 12px;
    border-radius: 999px;
    border: 1px solid rgba(255, 255, 255, 0.14);
    background: rgba(255, 255, 255, 0.06);
    color: inherit;
    cursor: pointer;
    transition: opacity 120ms cubic-bezier(0.25, 1, 0.5, 1);
  }
  button:active {
    opacity: 0.7;
  }
  .status {
    flex: none;
    font-size: 12px;
    line-height: 16px;
    color: rgba(255, 255, 255, 0.72);
  }
  @media (prefers-reduced-motion: reduce) {
    button {
      transition: none;
    }
  }
</style>
