<script lang="ts">
  /**
   * Company channel header tabs (US-015): Chat · Atlas · Team · Integrations · Settings.
   */
  import {
    COMPANY_CHANNEL_TABS,
    type CompanyChannelTabId,
  } from "./tabs/tab-model.js";

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
