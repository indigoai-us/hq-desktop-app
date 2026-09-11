<script lang="ts">
  /**
   * Company channel header tabs (US-015): Chat · Atlas · Team · Settings.
   * (Integrations was removed — apps are connected in the HQ console.)
   */
  import {
    COMPANY_CHANNEL_TABS,
    type CompanyChannelTabId,
  } from "./tabs/tab-model.js";
  import Chat from "phosphor-svelte/lib/Chat";
  import Compass from "phosphor-svelte/lib/Compass";
  import Users from "phosphor-svelte/lib/Users";
  import Gear from "phosphor-svelte/lib/Gear";

  interface Props {
    active: CompanyChannelTabId;
    onselect: (id: CompanyChannelTabId) => void;
  }

  let { active, onselect }: Props = $props();
</script>

<nav
  class="company-tabs"
  aria-label="Company channel views"
  data-testid="company-channel-tabs"
>
  {#each COMPANY_CHANNEL_TABS as t (t.id)}
    <button
      type="button"
      class="company-tab"
      class:active={active === t.id}
      aria-current={active === t.id ? "page" : undefined}
      data-testid={`company-tab-${t.id}`}
      onclick={() => onselect(t.id)}
    >
      <span class="company-tab-icon" aria-hidden="true">
        {#if t.id === "chat"}
          <Chat size={14} aria-hidden="true" />
        {:else if t.id === "atlas"}
          <Compass size={14} aria-hidden="true" />
        {:else if t.id === "team"}
          <Users size={14} aria-hidden="true" />
        {:else}
          <Gear size={14} aria-hidden="true" />
        {/if}
      </span>
      <span>{t.label}</span>
    </button>
  {/each}
</nav>

<style>
  .company-tabs {
    display: flex;
    align-items: center;
    gap: 2px;
    background: var(--raised);
    border: none;
    border-radius: 8px;
    padding: 2px;
  }

  .company-tab {
    appearance: none;
    -webkit-appearance: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    /* Same 5px icon gap as `.project-tab` — the two tab groups sit in the
       same header slot and had no business reading differently. */
    gap: 5px;
    min-height: 28px;
    padding: 4px 10px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--t2);
    font-family: inherit;
    font-size: 12px;
    font-weight: 500;
    line-height: 1;
    cursor: pointer;
  }

  .company-tab-icon {
    display: inline-flex;
    align-items: center;
    line-height: 0;
  }

  .company-tab:hover {
    color: var(--t1);
  }

  .company-tab.active {
    color: var(--t1);
    background: var(--sel);
  }

  .company-tab:focus-visible {
    outline: 2px solid var(--fg, var(--t1));
    outline-offset: 2px;
  }
</style>
