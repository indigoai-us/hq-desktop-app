<script lang="ts">
  /**
   * First view, the connect slot: the integrations HQ suggests and the AI
   * apps not yet connected. Connect opens the existing settings page (or, in
   * "expand" mode, the connect section inline). A harness found on this Mac
   * shows Open, or Connected when this host cannot open it; never Connect.
   */
  import type { Snippet } from "svelte";
  import type { FirstViewConnect, FirstViewAiApp, FirstViewIntegration } from "./brief-first-view.js";
  import type { WelcomeHarnessId } from "./brief-welcome-contract.js";
  import { FV_CONNECTED, FV_FOUND, FV_NOT_CONNECTED, aiAppFound } from "./brief-first-view-copy.js";

  interface Props {
    connect: FirstViewConnect;
    /** Whether this host can open a harness. */
    canOpen?: (harness: WelcomeHarnessId) => boolean;
    onconnectintegration?: ((row: FirstViewIntegration) => void) | null;
    onconnectai?: ((app: FirstViewAiApp) => void) | null;
    onopen?: ((harness: WelcomeHarnessId) => void) | null;
    /** "expand" mode: the inline connect section, shown under the rows once Connect is pressed. */
    expanded?: Snippet | null;
  }
  let { connect, canOpen = () => false, onconnectintegration = null, onconnectai = null, onopen = null, expanded = null }: Props = $props();
  const initials = (name: string) =>
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join("");
  const aiApps = $derived(connect.aiAction ? connect.aiApps : []);
</script>

<div class="w fv-card" data-testid="first-view-connect" data-mode={connect.mode}>
  <ul class="fv-rows">
    {#each aiApps as a (a.harness)}
      {@const found = aiAppFound(a)}
      <li class="fv-row" data-testid="first-view-connect-row" data-harness={a.harness} data-found={found}>
        <span class="fv-mono" aria-hidden="true">{initials(a.name)}</span>
        <span class="fv-rt"><b>{a.name}</b><span class="fv-note">{found ? FV_FOUND : FV_NOT_CONNECTED}</span></span>
        {#if found && onopen && canOpen(a.harness)}
          <button type="button" class="fv-btn" onclick={() => onopen?.(a.harness)}>Open</button>
        {:else if found}
          <span class="fv-chip" data-testid="first-view-connected">{FV_CONNECTED}</span>
        {:else if onconnectai}
          <button type="button" class="fv-btn" onclick={() => onconnectai?.(a)}>Connect</button>
        {/if}
      </li>
    {/each}
    {#each connect.integrations as i (i.slug)}
      <li class="fv-row" data-testid="first-view-connect-row" data-integration={i.slug}>
        <span class="fv-mono" aria-hidden="true">{initials(i.name)}</span>
        <span class="fv-rt"><b>{i.name}</b><span class="fv-note">{FV_NOT_CONNECTED}</span></span>
        {#if onconnectintegration}<button type="button" class="fv-btn" onclick={() => onconnectintegration?.(i)}>Connect</button>{/if}
      </li>
    {/each}
  </ul>
  {#if !aiApps.length && !connect.integrations.length}
    <p class="fv-empty" data-testid="first-view-connect-empty">Every app HQ found is connected.</p>
  {/if}
  {#if expanded}<div class="fv-expanded">{@render expanded()}</div>{/if}
</div>

<style>
  /* The card shares row 1 with the sunrise, so its rows grow to fill the sunrise's height. */
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
    flex: 1 1 auto;
  }
  .fv-row {
    flex: 1 1 auto;
    min-height: 36px;
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
  /* Name and status sit on one line when there is room and wrap, whole words, when there is not. */
  .fv-rt {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    column-gap: 8px;
    min-width: 0;
    flex: 1;
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
