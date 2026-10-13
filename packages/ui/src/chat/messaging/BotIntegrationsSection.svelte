<script lang="ts">
  /**
   * Per-bot integration control: one switch per company connection, bound to the
   * flag `desktop.bot-integration-control-v1` (default off). The section is a
   * no-op without the flag, a companyUid, or a botUid.
   *
   * See `companies/indigo/projects/desktop-new-bot-flow/per-bot-integrations-plan.md`
   * for the five-state model and the server contract. Live decision for the
   * switch: `dec-20261012191758-lvn1` (Option A, flag off by default).
   */
  import { onDestroy } from "svelte";
  import type { PlatformAdapter } from "@hq/platform";
  import { BOT_INTEGRATION_CONTROL_FLAG } from "@hq/platform";
  import {
    readCompanyConnections,
    type CompanyConnection,
  } from "./integration-cards-model.js";
  import {
    botConnectionAccessState,
    botConnectionIsInteractive,
    botConnectionIsOn,
    readConnectionAccess,
    type BotConnectionAccessState,
    type ConnectionAccess,
  } from "./bot-integration-access-model.js";

  interface Props {
    /** The company whose connections we show for this bot. "" or null → section hidden. */
    companyUid: string | null;
    /** The bot's agent uid. "" or null → section hidden. */
    botUid: string | null;
    /** The bot's company role, if the panel knows it (owner | admin | member | ""). */
    botRole?: string | null;
    /** The platform adapter. Needs `integrations` and `identity`. */
    adapter: Pick<PlatformAdapter, "integrations" | "identity">;
    /** Test seam: pre-resolve the flag read; omitted → read via `identity.hasFeature`. */
    flagEnabled?: boolean | null;
  }

  let { companyUid, botUid, botRole = null, adapter, flagEnabled = null }: Props = $props();

  type RowState = {
    connection: CompanyConnection;
    access: ConnectionAccess | null;
    pending: boolean;
    error: string | null;
  };

  let flagOn = $state<boolean | null>(null);
  let loading = $state(false);
  let listError = $state<string | null>(null);
  let rows = $state<RowState[]>([]);
  let generation = 0;
  let destroyed = false;

  const roleLower = $derived((botRole ?? "").toLowerCase());

  const canRender = $derived(
    flagOn === true && !!companyUid && !!botUid,
  );

  function resetAll(): void {
    rows = [];
    listError = null;
  }

  async function resolveFlag(coUid: string | null): Promise<void> {
    if (flagEnabled !== null) {
      flagOn = flagEnabled;
      return;
    }
    if (!coUid) {
      flagOn = false;
      return;
    }
    if (!adapter.identity || typeof adapter.identity.hasFeature !== "function") {
      flagOn = false;
      return;
    }
    const result = await adapter.identity.hasFeature(
      BOT_INTEGRATION_CONTROL_FLAG,
      { companyUid: coUid },
    );
    flagOn = result.ok ? result.value === true : false;
  }

  async function loadAccessFor(
    coUid: string,
    connectionId: string,
  ): Promise<ConnectionAccess | null> {
    try {
      const result = await adapter.integrations.getConnectionAccess({
        companyUid: coUid,
        connectionId,
      });
      if (!result.ok) return null;
      return readConnectionAccess(result.value);
    } catch {
      return null;
    }
  }

  async function loadAll(coUid: string, botForLoad: string): Promise<void> {
    if (destroyed) return;
    loading = true;
    listError = null;
    const myGen = ++generation;
    try {
      const listResult = await adapter.integrations.listConnections(coUid);
      if (myGen !== generation || destroyed) return;
      if (!listResult.ok) {
        listError = "We could not load connected apps. Try again in a moment.";
        rows = [];
        return;
      }
      const facts = readCompanyConnections(listResult.value);
      const connections = facts?.connections ?? [];
      const nextRows: RowState[] = connections.map((connection) => ({
        connection,
        access: null,
        pending: false,
        error: null,
      }));
      rows = nextRows;
      await Promise.all(
        nextRows.map(async (row, idx) => {
          const access = await loadAccessFor(coUid, row.connection.id);
          if (myGen !== generation || destroyed) return;
          if (botForLoad !== (botUid ?? "")) return;
          rows[idx] = { ...rows[idx], access };
        }),
      );
    } finally {
      if (myGen === generation) loading = false;
    }
  }

  $effect(() => {
    // Read all prop dependencies synchronously so the effect re-runs when
    // the panel switches to a different bot or role under the same company.
    const coUid = companyUid;
    const bot = botUid;
    // Reading botRole (via roleLower) registers it as a tracked dependency.
    void roleLower;
    void (async () => {
      await resolveFlag(coUid);
      if (destroyed) return;
      if (flagOn !== true || !coUid || !bot) {
        resetAll();
        return;
      }
      await loadAll(coUid, bot);
    })();
  });

  onDestroy(() => {
    destroyed = true;
    generation++;
  });

  function stateFor(row: RowState): BotConnectionAccessState | null {
    if (!row.access) return null;
    return botConnectionAccessState({
      botUid: botUid ?? "",
      botRole: roleLower,
      mode: row.connection.mode,
      access: row.access,
    });
  }

  function helpTextFor(state: BotConnectionAccessState): string {
    if (state === "read-only") {
      return "Ask the connection's owner or a company admin to change sharing.";
    }
    if (state === "on-admin") {
      return "Company owners and admins already have access.";
    }
    if (state === "on-everyone") {
      return "This app is open to everyone in the company.";
    }
    return "";
  }

  function ariaLabelFor(
    name: string,
    state: BotConnectionAccessState,
    interactive: boolean,
    switchOn: boolean,
  ): string {
    if (!interactive) {
      if (state === "read-only") return `${name} access is locked`;
      if (state === "on-admin") return `${name} is on for admins`;
      if (state === "on-everyone") return `${name} is on for everyone`;
      return `${name} access`;
    }
    return switchOn ? `Turn off ${name}` : `Turn on ${name}`;
  }

  async function toggle(row: RowState, index: number): Promise<void> {
    if (!companyUid || !botUid || row.pending || !row.access) return;
    const state = stateFor(row);
    if (!state || !botConnectionIsInteractive(state)) return;
    const nextIsOn = state === "off";
    rows[index] = { ...row, pending: true, error: null };
    try {
      const call = nextIsOn
        ? adapter.integrations.grantConnectionAccess
        : adapter.integrations.revokeConnectionAccess;
      const result = await call({
        companyUid,
        connectionId: row.connection.id,
        granteeUid: botUid,
      });
      if (!result.ok) {
        rows[index] = {
          ...rows[index],
          pending: false,
          error: nextIsOn
            ? "Could not turn this app on. Try again in a moment."
            : "Could not turn this app off. Try again in a moment.",
        };
        return;
      }
      const fresh = await loadAccessFor(companyUid, row.connection.id);
      if (fresh === null) {
        rows[index] = {
          ...rows[index],
          pending: false,
          error:
            "Saved, but HQ could not re-read this app's sharing. Reopen the panel to check.",
        };
        return;
      }
      rows[index] = {
        ...rows[index],
        access: fresh,
        pending: false,
        error: null,
      };
    } catch {
      rows[index] = {
        ...rows[index],
        pending: false,
        error: "Could not update this app's access. Try again in a moment.",
      };
    }
  }
</script>

{#if canRender}
  <section class="ad-section" data-testid="bot-integrations-section">
    <h3 class="ad-kicker">Apps this bot can use</h3>
    {#if loading && rows.length === 0}
      <p class="ad-muted">Loading apps…</p>
    {:else if listError}
      <p class="ad-muted" data-testid="bot-integrations-error">{listError}</p>
    {:else if rows.length === 0}
      <p class="ad-muted">No company apps are connected yet.</p>
    {:else}
      <ul class="ad-rows" data-testid="bot-integrations-rows">
        {#each rows as row, index (row.connection.id)}
          {@const state = stateFor(row)}
          {@const interactive = state ? botConnectionIsInteractive(state) : false}
          {@const switchOn = state ? botConnectionIsOn(state) : false}
          {@const help = state ? helpTextFor(state) : ""}
          <li data-testid="bot-integrations-row">
            <span class="ad-row-title">{row.connection.name}</span>
            {#if row.access === null}
              <span class="ad-row-meta">Loading…</span>
            {:else}
              <button
                type="button"
                class="bis-switch"
                role="switch"
                aria-checked={switchOn}
                aria-label={state ? ariaLabelFor(row.connection.name, state, interactive, switchOn) : row.connection.name}
                data-testid="bot-integrations-switch"
                data-state={state ?? ""}
                data-on={switchOn ? "true" : "false"}
                disabled={!interactive || row.pending}
                onclick={() => void toggle(row, index)}
              >
                <span class="bis-track" aria-hidden="true">
                  <span class="bis-thumb"></span>
                </span>
                <span class="bis-label">
                  {#if row.pending}
                    Saving…
                  {:else if switchOn}
                    On
                  {:else}
                    Off
                  {/if}
                </span>
              </button>
            {/if}
            {#if help}
              <span class="ad-row-meta bis-help" data-testid="bot-integrations-help">{help}</span>
            {/if}
            {#if row.error}
              <span class="ad-row-meta bis-error" role="alert">{row.error}</span>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </section>
{/if}

<style>
  .bis-switch {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.125rem 0.25rem;
    border: 0;
    background: transparent;
    cursor: pointer;
    color: inherit;
    font: inherit;
  }
  .bis-switch:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }
  .bis-track {
    position: relative;
    width: 1.75rem;
    height: 1rem;
    border-radius: 999px;
    background: var(--chat-switch-track-off, rgba(140, 140, 140, 0.4));
    transition: background-color 120ms ease;
  }
  .bis-switch[data-on="true"] .bis-track {
    background: var(--chat-switch-track-on, var(--chat-accent, #2c7));
  }
  .bis-thumb {
    position: absolute;
    top: 0.125rem;
    left: 0.125rem;
    width: 0.75rem;
    height: 0.75rem;
    border-radius: 999px;
    background: var(--chat-switch-thumb, #fff);
    transition: transform 120ms ease;
  }
  .bis-switch[data-on="true"] .bis-thumb {
    transform: translateX(0.75rem);
  }
  .bis-label {
    font-size: 0.75rem;
    letter-spacing: 0.02em;
  }
  .bis-help {
    display: block;
    width: 100%;
    font-size: 0.75rem;
    opacity: 0.75;
  }
  .bis-error {
    display: block;
    width: 100%;
    color: var(--chat-error, #c33);
  }
</style>
