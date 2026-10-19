<script lang="ts">
  /**
   * First view, the connect slot: the integrations HQ suggests and the AI
   * apps not yet connected. Connect opens the existing settings page (or, in
   * "expand" mode, the connect section inline). A harness found on this Mac
   * (sessions here, or its CLI installed) shows Open, or Connected when this
   * host cannot open it; one connected in Settings shows Connected. Neither
   * is offered Connect.
   */
  import type { Snippet } from "svelte";
  import type { FirstViewConnect, FirstViewAiApp, FirstViewIntegration } from "./brief-first-view.js";
  import { WELCOME_HARNESS_NAME, type WelcomeHarnessId } from "./brief-welcome-contract.js";
  import { FV_CONNECTED, FV_FOUND, FV_NOT_CONNECTED, aiAppFound } from "./brief-first-view-copy.js";

  interface Props {
    connect: FirstViewConnect;
    /** Harnesses connected in Settings; the model leaves them out of aiApps, the card shows them Connected. */
    connected?: readonly WelcomeHarnessId[];
    /** Harnesses whose CLI is installed here: found even with no history. */
    installed?: readonly WelcomeHarnessId[];
    /** Whether this host can open a harness. */
    canOpen?: (harness: WelcomeHarnessId) => boolean;
    onconnectintegration?: ((row: FirstViewIntegration) => void) | null;
    onconnectai?: ((app: FirstViewAiApp) => void) | null;
    onopen?: ((harness: WelcomeHarnessId) => void) | null;
    /** "expand" mode: the inline connect section, shown under the rows once Connect is pressed. */
    expanded?: Snippet | null;
  }
  let { connect, connected = [], installed = [], canOpen = () => false, onconnectintegration = null, onconnectai = null, onopen = null, expanded = null }: Props = $props();
  const initials = (name: string) =>
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join("");
  const ORDER: readonly WelcomeHarnessId[] = ["claude-code", "codex", "cursor"];
  type AiRow = FirstViewAiApp & { connected: boolean };
  const aiApps = $derived.by((): AiRow[] => {
    if (!connect.aiAction) return [];
    const rows: AiRow[] = connect.aiApps.map((a) => ({ ...a, connected: false }));
    for (const h of connected) {
      if (!rows.some((r) => r.harness === h)) rows.push({ harness: h, name: WELCOME_HARNESS_NAME[h], sessions: 0, connected: true });
    }
    return rows.sort((x, y) => ORDER.indexOf(x.harness) - ORDER.indexOf(y.harness));
  });
</script>

<div class="w fv-card" data-testid="first-view-connect" data-mode={connect.mode}>
  <ul class="fv-rows">
    {#each aiApps as a (a.harness)}
      {@const found = aiAppFound(a, installed)}
      <li class="fv-row" data-testid="first-view-connect-row" data-harness={a.harness} data-found={found} data-connected={a.connected}>
        <span class="fv-mono" aria-hidden="true">{initials(a.name)}</span>
        <span class="fv-rt"><b>{a.name}</b>{#if !a.connected}<span class="fv-note">{found ? FV_FOUND : FV_NOT_CONNECTED}</span>{/if}</span>
        {#if a.connected}
          <span class="fv-chip" data-testid="first-view-connected">{FV_CONNECTED}</span>
        {:else if found && onopen && canOpen(a.harness)}
          <button type="button" class="fv-btn" aria-label="Open {a.name}" onclick={() => onopen?.(a.harness)}>Open</button>
        {:else if found}
          <span class="fv-chip" data-testid="first-view-connected">{FV_CONNECTED}</span>
        {:else if onconnectai}
          <button type="button" class="fv-btn" aria-label="Connect {a.name}" onclick={() => onconnectai?.({ harness: a.harness, name: a.name, sessions: a.sessions })}>Connect</button>
        {/if}
      </li>
    {/each}
    {#each connect.integrations as i (i.slug)}
      <li class="fv-row" data-testid="first-view-connect-row" data-integration={i.slug}>
        <span class="fv-mono" aria-hidden="true">{initials(i.name)}</span>
        <span class="fv-rt"><b>{i.name}</b><span class="fv-note">{FV_NOT_CONNECTED}</span></span>
        {#if onconnectintegration}<button type="button" class="fv-btn" aria-label="Connect {i.name}" onclick={() => onconnectintegration?.(i)}>Connect</button>{/if}
      </li>
    {/each}
  </ul>
  {#if !aiApps.length && !connect.integrations.length}
    <p class="fv-empty" data-testid="first-view-connect-empty">Every app HQ found is connected.</p>
  {/if}
  {#if expanded}<div class="fv-expanded">{@render expanded()}</div>{/if}
</div>

<style>
  /* The card shares row 1 with the sunrise; its rows keep their own height and sit at the top. */
  .fv-card {
    padding-top: 48px;
    display: flex;
    flex-direction: column;
  }
  .fv-rows {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .fv-row {
    min-height: 40px;
    box-sizing: border-box;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 6px 5px 8px;
    border-radius: 8px;
    background: var(--b-row-bg, rgba(255, 255, 255, 0.14));
    border: 1px solid var(--b-row-line, rgba(255, 255, 255, 0.2));
    min-width: 0;
  }
  .fv-mono {
    flex: none;
    width: 24px;
    height: 24px;
    border-radius: 999px;
    display: grid;
    place-items: center;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.02em;
    background: rgb(var(--b-ink) / 0.18);
  }
  /* Name and status sit on one line when there is room; when not, the status moves under the name whole. */
  .fv-rt {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    column-gap: 8px;
    min-width: 0;
    flex: 1;
  }
  .fv-rt b,
  .fv-note {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 100%;
  }
  .fv-rt b {
    font-weight: 500;
    font-size: 13px;
  }
  .fv-note {
    font-size: 11px;
    color: var(--b-t3);
  }
  .fv-btn {
    flex: none;
    font: inherit;
    font-size: 12px;
    font-weight: 500;
    padding: 4px 11px;
    border-radius: 999px;
    border: 0;
    cursor: pointer;
    background: rgb(var(--b-ink) / 0.92);
    color: #1b1b22;
  }
  .fv-chip {
    flex: none;
    font-size: 12px;
    padding: 4px 10px;
    border-radius: 999px;
    background: rgb(var(--b-ink) / 0.14);
  }
  .fv-empty {
    margin: 0;
    font-size: 13px;
    color: var(--b-t2);
  }
  .fv-expanded {
    margin-top: 10px;
  }
</style>
