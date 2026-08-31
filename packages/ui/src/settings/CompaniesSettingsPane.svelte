<script lang="ts">
  /**
   * Settings → Companies — port of hq-desktop-preview-v2 ?view=v2:
   * colored monogram, name, role pill, SYNCED/LOCAL toggle.
   */
  import type { Workspace } from "../chat/workspaces.js";
  import { companyConsoleUrl, HQ_CONSOLE_BASE } from "../common/hq-console.js";
  import {
    companyAvatarWash,
    settingsCompanyLists,
    type SettingsCompanyRow,
  } from "./shell-settings-model.js";
  import "../chat/tokens.css";
  import "../chat/chat-tokens.css";

  import { readSettingsPrefs, writeSettingsPrefs } from "./settings-prefs.js";

  interface Props {
    companies?: Workspace[] | null;
    personalLabel?: string | null;
    onopenconsole?: (url: string) => Promise<void> | void;
    consoleBase?: string;
    /** Local folder sync per company — desktop only. */
    canSync?: boolean;
  }

  let {
    companies = [],
    personalLabel = null,
    onopenconsole,
    consoleBase = HQ_CONSOLE_BASE,
    canSync = false,
  }: Props = $props();

  const lists = $derived(settingsCompanyLists(companies, personalLabel));
  let prefs = $state(readSettingsPrefs());
  let externalError = $state<string | null>(null);

  function isOn(row: SettingsCompanyRow): boolean {
    if (row.id in prefs.companySync) return prefs.companySync[row.id]!;
    return row.statusKey === "active";
  }

  function toggle(row: SettingsCompanyRow): void {
    prefs = writeSettingsPrefs({
      companySync: { [row.id]: !isOn(row) },
    });
  }

  function companyUrl(slug: string): string {
    const base = consoleBase.replace(/\/$/, "");
    if (base === HQ_CONSOLE_BASE) return companyConsoleUrl(slug);
    return `${base}/companies/${encodeURIComponent(slug)}`;
  }

  async function openCompany(slug: string): Promise<void> {
    externalError = null;
    if (!onopenconsole) {
      externalError = 'HQ Console is unavailable in this host.';
      return;
    }
    try {
      await onopenconsole(companyUrl(slug));
    } catch (error) {
      externalError = `Couldn’t open this company in HQ Console: ${String(error)}`;
    }
  }
</script>

<div class="co-pane" data-testid="settings-companies-pane">
  {#if externalError}
    <p class="co-external-error" data-testid="settings-company-open-error" role="alert">
      {externalError}
    </p>
  {/if}
  {#if lists.active.length === 0}
    <p class="co-empty" data-testid="settings-companies-empty">
      No company memberships on this account yet.
    </p>
  {:else}
    {#each lists.active as row (row.id)}
      {@const wash = companyAvatarWash(row.id)}
      {@const on = isOn(row)}
      <div class="set-row" data-testid="settings-company-row">
        <button
          type="button"
          class="co-id"
          onclick={() => void openCompany(row.slug)}
        >
          <span
            class="co-av"
            style={`background:${wash.bg};color:${wash.fg}`}
            aria-hidden="true">{row.initials}</span
          >
          <span class="co-name">{row.name}</span>
          <span class="co-role">{row.role}</span>
        </button>
        {#if canSync}
          <span class="co-state" class:on>{on ? "Synced" : "Local"}</span>
          <button
            type="button"
            class="toggle"
            class:on
            role="switch"
            aria-checked={on}
            aria-label={`${row.name} ${on ? "synced" : "local"}`}
            onclick={() => toggle(row)}
          ></button>
        {:else}
          <span class="co-state on">Member</span>
        {/if}
      </div>
    {/each}
  {/if}

  {#if lists.pending.length > 0}
    {#each lists.pending as row (row.id)}
      {@const wash = companyAvatarWash(row.id)}
      <div class="set-row" data-testid="settings-company-invite">
        <div class="co-id">
          <span
            class="co-av"
            style={`background:${wash.bg};color:${wash.fg}`}
            aria-hidden="true">{row.initials}</span
          >
          <span class="co-name">{row.name}</span>
          <span class="co-role">Invite</span>
        </div>
      </div>
    {/each}
  {/if}

  {#if lists.personal}
    {@const wash = companyAvatarWash(lists.personal.id)}
    <div class="co-split" aria-hidden="true"></div>
    <div class="set-row">
      <div class="co-id">
        <span
          class="co-av"
          style={`background:${wash.bg};color:${wash.fg}`}
          aria-hidden="true">{lists.personal.initials}</span
        >
        <span class="co-name">{lists.personal.name}</span>
        <span class="co-role">Owner</span>
      </div>
      <span class="co-state">Local</span>
      <span class="toggle" aria-hidden="true"></span>
    </div>
  {/if}
</div>

<style>
  /* Port of hq-desktop-unified / preview-v2 settings rows. */
  .co-pane {
    display: flex;
    flex-direction: column;
    gap: 10px;
    max-width: 760px;
  }

  .co-empty {
    margin: 0;
    color: var(--t3);
    font-size: 13px;
  }

  .set-row {
    display: flex;
    align-items: center;
    gap: 12px;
    background: var(--raised);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 14px 16px;
  }

  .co-id {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
    flex: 1 1 auto;
    background: none;
    border: none;
    padding: 0;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .co-av {
    display: grid;
    place-items: center;
    flex: 0 0 auto;
    width: 32px;
    height: 32px;
    border-radius: 8px;
    font-size: 11px;
    font-weight: 600;
  }

  .co-name {
    font-size: 13px;
    font-weight: 500;
    color: var(--t1);
  }

  .co-role {
    flex: 0 0 auto;
    padding: 1px 7px;
    border: 1px solid var(--line2);
    border-radius: 6px;
    color: var(--t3);
    font-family: var(--font-mono, ui-monospace, Menlo, monospace);
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .co-state {
    margin-left: auto;
    flex: 0 0 auto;
    color: var(--t3);
    font-family: var(--font-mono, ui-monospace, Menlo, monospace);
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .co-state.on {
    color: var(--ok);
  }

  .toggle {
    margin-left: 0;
    width: 34px;
    height: 20px;
    border: none;
    border-radius: 10px;
    background: var(--line2);
    position: relative;
    flex-shrink: 0;
    cursor: pointer;
    padding: 0;
  }

  .toggle::after {
    content: "";
    position: absolute;
    top: 3px;
    left: 3px;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--t2);
    transition: all 0.15s;
  }

  .toggle.on {
    background: #2a3644;
  }

  .toggle.on::after {
    left: 17px;
    background: var(--ok, #4ade80);
  }

  .co-split {
    height: 1px;
    margin: 6px 4px;
    background: var(--line);
  }
</style>
