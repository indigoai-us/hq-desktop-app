<script lang="ts">
  /**
   * Company channel header: in-app tabs plus a gear that
   * opens the company in the HQ console. Team and Settings are not desktop
   * tabs.
   */
  import { companyConsoleUrl } from "../common/hq-console.js";
  import {
    COMPANY_CHANNEL_TABS,
    type CompanyChannelTabId,
  } from "./tabs/tab-model.js";

  const HIDDEN_TABS = new Set<CompanyChannelTabId>([
    "chat",
    "team",
    "settings",
    "atlas",
  ]);

  interface Props {
    slug: string;
    onopenurl?: (url: string) => void;
    active?: CompanyChannelTabId;
    tabs?: ReadonlyArray<{ id: CompanyChannelTabId; label: string }>;
    onselect?: (id: CompanyChannelTabId) => void;
  }

  let {
    slug,
    onopenurl,
    active = "chat",
    tabs = COMPANY_CHANNEL_TABS,
    onselect,
  }: Props = $props();

  const visibleTabs = $derived(tabs.filter((t) => !HIDDEN_TABS.has(t.id)));
  const href = $derived(slug.trim() ? companyConsoleUrl(slug.trim()) : "");

  function openConsole(): void {
    if (!href) return;
    if (onopenurl) {
      onopenurl(href);
      return;
    }
    if (typeof window !== "undefined") {
      window.open(href, "_blank", "noopener,noreferrer");
    }
  }
</script>

<div class="company-header-tools">
  {#if visibleTabs.length > 0}
    <nav
      class="company-tabs"
      aria-label="Company channel views"
      data-testid="company-channel-tabs"
    >
      {#each visibleTabs as t (t.id)}
        <button
          type="button"
          class="company-tab"
          class:active={active === t.id}
          aria-current={active === t.id ? "page" : undefined}
          data-testid={`company-tab-${t.id}`}
          onclick={() => onselect?.(t.id)}
        >
          <span>{t.label}</span>
        </button>
      {/each}
    </nav>
  {/if}
  <button
    type="button"
    class="company-console-gear"
    data-testid="company-console-gear"
    aria-label="Open company in HQ console"
    title="Open in HQ console"
    disabled={!href}
    onclick={openConsole}
  >
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">
      <path
        d="M6.4 1.75h3.2l.45 1.55a4.7 4.7 0 0 1 1.15.66l1.55-.45 1.6 2.77-1.1 1.15c.08.4.12.8.12 1.22s-.04.82-.12 1.22l1.1 1.15-1.6 2.77-1.55-.45a4.7 4.7 0 0 1-1.15.66L9.6 14.25H6.4l-.45-1.55a4.7 4.7 0 0 1-1.15-.66l-1.55.45-1.6-2.77 1.1-1.15A5.3 5.3 0 0 1 2.63 8c0-.42.04-.82.12 1.22l-1.1-1.15 1.6-2.77 1.55.45c.35-.27.74-.5 1.15-.66L6.4 1.75Z"
        stroke="currentColor"
        stroke-width="1.2"
        stroke-linejoin="round"
      />
      <circle cx="8" cy="8" r="2.1" stroke="currentColor" stroke-width="1.2" />
    </svg>
  </button>
</div>

<style>
  .company-header-tools {
    display: flex;
    align-items: center;
    gap: 8px;
  }

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

  .company-console-gear {
    appearance: none;
    -webkit-appearance: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    padding: 0;
    border: 1px solid var(--line2, var(--panel-border));
    border-radius: 6px;
    background: transparent;
    color: var(--t2);
    cursor: pointer;
  }

  .company-console-gear:hover:not(:disabled) {
    color: var(--t1);
    background: var(--hover);
  }

  .company-console-gear:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .company-console-gear:focus-visible {
    outline: 2px solid var(--fg, var(--t1));
    outline-offset: 2px;
  }
</style>
