<script lang="ts">
  /**
   * ProjectsHome: the Projects page. One company at a time, picked from the
   * companies this person belongs to that have a folder on this Mac, with that
   * company's project board below (CompanyProjectsPage: Board/List of projects,
   * and each project's task board, detail and files).
   */
  import type { PlatformAdapter } from "@hq/platform";
  import type { Workspace } from "../chat/workspaces.js";
  import CompanyProjectsPage from "./CompanyProjectsPage.svelte";

  interface Props {
    adapter: PlatformAdapter;
    companies: Workspace[] | null | undefined;
    /**
     * Company to show; falls back to the preferred one, then the last one
     * picked on this Mac, then the first.
     */
    slug?: string | null;
    /** Company the rest of the app is scoped to, used when `slug` is unset. */
    preferredSlug?: string | null;
    onslugchange?: (slug: string) => void;
  }

  let { adapter, companies, slug = null, preferredSlug = null, onslugchange }: Props = $props();

  /** Companies with projects on this Mac, by name. */
  const choices = $derived(
    (companies ?? [])
      .filter(
        (c) =>
          c.kind === "company" &&
          c.hasLocalFolder &&
          (c.membershipStatus ?? "active") === "active" &&
          c.slug !== "personal",
      )
      .sort((a, b) => (a.displayName || a.slug).localeCompare(b.displayName || b.slug)),
  );

  const LAST_COMPANY_KEY = "hq.projects.lastCompany";

  function readLastCompany(): string | null {
    try {
      return globalThis.localStorage?.getItem(LAST_COMPANY_KEY) ?? null;
    } catch {
      return null;
    }
  }

  let lastPicked = $state<string | null>(readLastCompany());

  const current = $derived(
    choices.find((c) => c.slug === slug) ??
      choices.find((c) => c.slug === preferredSlug) ??
      choices.find((c) => c.slug === lastPicked) ??
      choices[0] ??
      null,
  );

  let menuOpen = $state(false);

  function choose(next: string): void {
    menuOpen = false;
    const previous = current?.slug;
    lastPicked = next;
    try {
      globalThis.localStorage?.setItem(LAST_COMPANY_KEY, next);
    } catch {
      // Storage can be unavailable; the pick still applies for this visit.
    }
    if (next !== previous) onslugchange?.(next);
  }

  function initial(c: Workspace): string {
    return (c.displayName || c.slug).trim()[0]?.toUpperCase() ?? "?";
  }
</script>

<div class="ph" data-testid="projects-home">
  {#if !current}
    <div class="ph-empty" data-testid="projects-home-empty">
      <h2>Projects</h2>
      <p>No company folders on this Mac yet. Projects show up here once a company has synced.</p>
    </div>
  {:else}
    <div class="ph-body">
      <div class="ph-bar">
        <div class="ph-company">
          <button
            type="button"
            class="ph-company-btn"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            data-testid="projects-company-switcher"
            onclick={() => (menuOpen = !menuOpen)}
          >
            <span class="ph-avatar">{initial(current)}</span>
            <span class="ph-name">{current.displayName || current.slug}</span>
            <svg viewBox="0 0 16 16" class="ph-caret" aria-hidden="true">
              <path d="M4.5 6.5 8 10l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>
          {#if menuOpen}
            <div class="ph-menu" role="menu" aria-label="Companies">
              {#each choices as c (c.slug)}
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={c.slug === current.slug}
                  class="ph-menu-item"
                  class:is-current={c.slug === current.slug}
                  onclick={() => choose(c.slug)}
                >
                  <span class="ph-avatar small">{initial(c)}</span>
                  <span>{c.displayName || c.slug}</span>
                </button>
              {/each}
            </div>
          {/if}
        </div>
      </div>
      {#key current.slug}
        <CompanyProjectsPage {adapter} slug={current.slug} companyUid={current.cloudUid ?? null} />
      {/key}
    </div>
  {/if}
</div>

<style>
  .ph {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    height: 100%;
  }
  /* Lives inside the .ph-body scroller and scrolls away with the page, so
     nothing slides under a fixed bar. z-index keeps its menu above the sticky
     board column headers further down. */
  .ph-bar {
    position: relative;
    z-index: 3;
    display: flex;
    align-items: center;
    padding: 12px 0 8px;
    background: transparent;
  }
  .ph-company {
    position: relative;
    /* Pull the button's own inset back so the avatar lines up with the page
       content's left edge; the hover fill extends outward instead. */
    margin-left: -7px;
  }
  .ph-company-btn {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 5px 10px 5px 6px;
    border: 1px solid transparent;
    border-radius: 8px;
    background: transparent;
    color: var(--v4-text-1);
    font: inherit;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
  }
  .ph-company-btn:hover,
  .ph-company-btn[aria-expanded="true"] {
    border-color: var(--v4-hairline);
    background: var(--v4-control-faint);
  }
  .ph-avatar {
    display: inline-grid;
    place-items: center;
    width: 22px;
    height: 22px;
    border-radius: 6px;
    background: var(--v4-control-faint);
    color: var(--v4-text-2);
    font-size: 12px;
    font-weight: 600;
  }
  .ph-avatar.small {
    width: 18px;
    height: 18px;
    font-size: 10px;
  }
  .ph-caret {
    width: 14px;
    height: 14px;
    color: var(--v4-text-3);
  }
  .ph-menu {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    z-index: 30;
    display: grid;
    min-width: 220px;
    max-height: 60vh;
    overflow-y: auto;
    padding: 4px;
    border: 1px solid var(--v4-hairline);
    border-radius: 10px;
    background: var(--v4-popover-strong);
    box-shadow: var(--v4-shadow-popover);
  }
  .ph-menu-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 8px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--v4-text-1);
    font: inherit;
    font-size: 13px;
    text-align: left;
    cursor: pointer;
  }
  .ph-menu-item:hover,
  .ph-menu-item.is-current {
    background: var(--v4-active-row);
  }
  /* The one vertical scroller for the whole page: board columns and task
     columns grow to their natural height and their headers stick to its top. */
  .ph-body {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
    padding: 0 24px 24px;
  }
  /* Content-height pages: the page scroller owns all vertical scrolling. */
  .ph-body :global(.company-projects) {
    height: auto;
  }
  /* A project scrolls as one page here: its header scrolls away and the task
     board keeps its own height, instead of the board squeezing into what is
     left under a fixed header. */
  .ph-body :global(.project-detail) {
    flex: none;
    height: auto;
  }
  .ph-body :global(.project-detail .detail-body) {
    overflow: visible;
  }
  .ph-empty {
    margin: 64px auto;
    max-width: 420px;
    color: var(--v4-text-2);
    text-align: center;
  }
  .ph-empty h2 {
    margin: 0 0 8px;
    color: var(--v4-text-1);
    font-size: 20px;
  }
</style>
