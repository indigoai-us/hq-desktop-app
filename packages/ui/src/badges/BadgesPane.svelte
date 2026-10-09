<script lang="ts">
  /**
   * All of someone's badges, opened by "See all" on a profile. Two views:
   *
   * Badges: every badge in the catalog grouped by tier. Earned ones show
   * their mark and tier and open the badge's page; the rest are dim outlines
   * with what earns them and plain progress.
   *
   * Cards: the person's cards, one for each earned badge, laid out like a
   * binder page of nine pockets. A card opens on the dark stage.
   */
  import RailIcon from "../common/button/RailIcon.svelte";
  import BadgeMark from "./BadgeMark.svelte";
  import BadgeCard from "./BadgeCard.svelte";
  import BadgeCardModal from "./BadgeCardModal.svelte";
  import { BADGES, TIER_NAME, resolveEarned, type EarnedBadge, type ResolvedBadge } from "./badge-catalog.js";
  import { badgeCollection } from "./badge-collection.js";
  import type { BadgeProgress } from "./badge-source.js";
  import { PROFILE_PANE_WIDTH } from "../shell/profile-panes/profile-pane-model.js";

  type Tab = "badges" | "cards";

  interface Props {
    badges: readonly EarnedBadge[];
    progress?: readonly BadgeProgress[];
    /** Whose badges these are. */
    owner?: string;
    tab?: Tab;
    onselect?: (badge: ResolvedBadge) => void;
    onback?: () => void;
    onclose?: () => void;
  }

  let { badges, progress = [], owner = "", tab = $bindable("badges"), onselect, onback, onclose }: Props = $props();

  const groups = $derived(badgeCollection(badges, progress));
  const earned = $derived(resolveEarned(badges));
  /** A binder page holds nine cards; a tenth card starts a second page, and
   *  the last page keeps its empty pockets. */
  const POCKETS = 9;
  const pages = $derived(
    Array.from({ length: Math.ceil(earned.length / POCKETS) }, (_, i) => {
      const cards = earned.slice(i * POCKETS, (i + 1) * POCKETS);
      return { cards, empty: POCKETS - cards.length };
    }),
  );

  let cardOpen = $state<ResolvedBadge | null>(null);
  let cardOpener = $state<HTMLElement | null>(null);

  function openCard(badge: ResolvedBadge, event: MouseEvent): void {
    cardOpener = event.currentTarget as HTMLElement;
    cardOpen = badge;
  }

  function onTabKey(event: KeyboardEvent): void {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    tab = tab === "badges" ? "cards" : "badges";
    (event.currentTarget as HTMLElement).parentElement?.querySelector<HTMLElement>(`[data-tab="${tab}"]`)?.focus();
  }
</script>

<aside class="pane" style:width="{PROFILE_PANE_WIDTH}px" aria-label={owner ? `${owner}'s badges` : "Badges"} data-testid="badges-pane" data-tab={tab}>
  <header class="head">
    <button type="button" class="icon" data-testid="badges-pane-back" aria-label="Back to profile" onclick={() => onback?.()}><RailIcon name="caret-left" size={14} /></button>
    <span>Badges</span>
    <span class="grow"></span>
    <button type="button" class="icon" data-testid="badges-pane-close" aria-label="Close" onclick={() => onclose?.()}><RailIcon name="x" size={14} /></button>
  </header>
  <div class="stabs" role="tablist" aria-label="Show">
    {#each [["badges", "Badges"], ["cards", "Cards"]] as [id, text] (id)}
      <button
        type="button"
        class="tab"
        role="tab"
        id="badges-tab-{id}"
        data-tab={id}
        data-testid="badges-pane-tab-{id}"
        aria-selected={tab === id}
        aria-controls="badges-panel"
        tabindex={tab === id ? 0 : -1}
        onclick={() => (tab = id as Tab)}
        onkeydown={onTabKey}
      >{text}</button>
    {/each}
  </div>
  <div class="body" id="badges-panel" role="tabpanel" aria-labelledby="badges-tab-{tab}">
    <p class="sum" data-testid="badges-pane-summary">{earned.length} of {BADGES.length} earned</p>
    {#if tab === "badges"}
      {#each groups as group (group.tier)}
        <section aria-label="{group.label} badges" data-testid="badges-group" data-tier={group.tier}>
          <div class="k">{group.label} <span class="count">{group.earned}/{group.tiles.length}</span></div>
          <ul class="grid">
            {#each group.tiles as tile (tile.def.id)}
              <li>
                {#if tile.earned}
                  {@const badge = tile.earned}
                  <button
                    type="button"
                    class="b"
                    data-testid="badges-tile"
                    data-badge-id={tile.def.id}
                    data-state="earned"
                    aria-describedby="badge-hc-{tile.def.id}"
                    disabled={!onselect}
                    onclick={() => onselect?.(badge)}
                  >
                    <BadgeMark badge={tile.def} tier={tile.tier} label="{tile.def.name}, {TIER_NAME[tile.tier]}" />
                    <span class="nm">{tile.def.name}</span>
                    <span class="tr">{TIER_NAME[tile.tier]}</span>
                    <span class="hc" role="tooltip" aria-hidden="true" id="badge-hc-{tile.def.id}" data-testid="badges-hover-card">{tile.def.crit}</span>
                  </button>
                {:else}
                  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
                  <div
                    class="b locked"
                    data-testid="badges-tile"
                    data-badge-id={tile.def.id}
                    data-state="locked"
                    tabindex="0"
                    aria-describedby="badge-hc-{tile.def.id}"
                  >
                    <span class="mark"><BadgeMark badge={tile.def} tier={tile.tier} locked label="{tile.def.name}, not earned yet" /></span>
                    <span class="nm">{tile.def.name}</span>
                    <span class="pg" data-testid="badges-progress">{tile.progress}</span>
                    <span class="hc" role="tooltip" aria-hidden="true" id="badge-hc-{tile.def.id}" data-testid="badges-hover-card">{tile.def.crit}</span>
                  </div>
                {/if}
              </li>
            {/each}
          </ul>
        </section>
      {/each}
    {:else if earned.length}
      <div class="binder-pages" data-testid="badges-binder">
      {#each pages as page, p (p)}
      <ul class="binder" aria-label={pages.length > 1 ? `Cards, page ${p + 1} of ${pages.length}` : "Cards"} data-testid="badges-binder-page">
        {#each page.cards as badge (badge.def.id)}
          <li class="pocket">
            <button
              type="button"
              class="sleeve"
              data-testid="badges-card"
              data-badge-id={badge.def.id}
              aria-label="Open the {badge.def.name} card, {TIER_NAME[badge.tier]}"
              onclick={(event) => openCard(badge, event)}
            >
              <BadgeCard {badge} foil={false} interactive={false} />
            </button>
          </li>
        {/each}
        {#each { length: page.empty } as _, i (i)}
          <li class="pocket empty" aria-hidden="true" data-testid="badges-empty-pocket"></li>
        {/each}
      </ul>
      {/each}
      </div>
    {:else}
      <p class="none">Cards appear here as badges are earned.</p>
    {/if}
  </div>
</aside>
{#if cardOpen}
  <BadgeCardModal open badge={cardOpen} owner={owner || null} returnFocus={cardOpener} onclose={() => (cardOpen = null)} />
{/if}

<style>
  .pane {
    box-sizing: border-box; max-width: 100%; height: 100%; min-height: 0;
    display: flex; flex-direction: column;
    background: var(--side-bg, var(--v4-secondary-sidebar));
    color: var(--v4-text-1);
    font: 400 13px/1.45 var(--font-ui, var(--font-sans));
  }
  .head {
    flex: none; display: flex; align-items: center; gap: 8px;
    padding: 12px 14px; border-bottom: 1px solid var(--v4-rowline, var(--line));
    font-size: 13px; font-weight: 500;
  }
  .grow { flex: 1; }
  .icon {
    display: inline-flex; align-items: center; justify-content: center;
    width: 24px; height: 24px; padding: 0; border: 0; border-radius: 6px;
    background: transparent; color: var(--v4-text-2); font-size: 13px; cursor: pointer;
  }
  .icon:hover { background: var(--hover, var(--v4-hover)); color: var(--v4-text-1); }
  .stabs { flex: none; display: flex; gap: 2px; padding: 8px 12px; border-bottom: 1px solid var(--v4-rowline, var(--line)); }
  .tab {
    border: 0; background: transparent; color: var(--v4-text-2); font: inherit; font-size: 13px;
    padding: 4px 8px; border-radius: 6px; cursor: pointer; white-space: nowrap;
  }
  .tab:hover { color: var(--v4-text-1); }
  .tab[aria-selected="true"] { background: var(--v4-active-row, var(--v4-hover)); color: var(--v4-text-1); }
  .tab:focus-visible, .b:focus-visible, .sleeve:focus-visible { outline: 2px solid var(--v4-focus, var(--v4-text-2)); outline-offset: -2px; }
  .body { overflow: auto; padding: 12px 20px 24px; min-height: 0; }
  .sum { margin: 0; color: var(--v4-text-3); }
  .none { margin: 16px 0 0; color: var(--v4-text-3); }
  /* Section label: the mono caps label style shared by the profile panes. */
  .k {
    display: flex; align-items: baseline; gap: 6px; margin: 20px 0 8px;
    font: 500 10px/1.4 var(--font-mono, "Geist Mono", monospace); letter-spacing: 0.1em; text-transform: uppercase;
    color: var(--v4-text-3);
  }
  .count { font-variant-numeric: tabular-nums; }
  .grid { list-style: none; margin: 0 -4px; padding: 0; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 4px; }
  .b {
    box-sizing: border-box; width: 100%; height: 100%; min-width: 0;
    display: flex; flex-direction: column; align-items: center; gap: 2px;
    padding: 6px 4px 10px; border: 0; border-radius: 8px; background: transparent;
    color: inherit; font: inherit; text-align: center; cursor: pointer;
    transition: background-color 120ms ease;
  }
  button.b:hover:not(:disabled) { background: var(--hover, var(--v4-hover)); }
  .b:disabled { cursor: default; }
  .b.locked { cursor: default; }
  /* Locked: a dim outline of the mark; the words stay readable. */
  .mark { display: block; opacity: 0.45; }
  /* Same sizes as the profile's Badges section: the name 12px, the level
     or progress under it 11px (owner review 2026-10-08). */
  .nm { max-width: 100%; font-size: 12px; color: var(--v4-text-1); line-height: 1.3; overflow-wrap: anywhere; }
  .locked .nm { color: var(--v4-text-2); }
  .tr { font-size: 11px; line-height: 1.4; color: var(--v4-text-3); }
  .pg { margin-top: 2px; font-size: 11px; line-height: 1.4; color: var(--v4-text-3); font-variant-numeric: tabular-nums; }
  .b:focus-visible { outline: 2px solid var(--v4-focus, var(--v4-text-2)); outline-offset: -2px; }

  /* What earns the badge: a small hover card under the tile (on hover or
     keyboard focus) instead of a paragraph in the grid. The outer columns
     align to their edge so the card stays inside the pane. */
  .b { position: relative; }
  .hc {
    position: absolute; top: calc(100% - 6px); left: 50%; z-index: 5;
    transform: translateX(-50%);
    box-sizing: border-box; width: max-content; max-width: 180px; padding: 6px 9px;
    border: 1px solid var(--panel-border, var(--line2)); border-radius: 7px;
    background: var(--overlay-bg, var(--v4-popover, var(--v4-surface-solid)));
    box-shadow: var(--panel-shadow, 0 4px 12px rgba(0, 0, 0, 0.22));
    color: var(--v4-text-1); font: 400 12px/1.4 var(--font-ui, var(--font-sans)); text-align: left;
    opacity: 0; visibility: hidden; pointer-events: none;
    transition: opacity 120ms ease, visibility 0s linear 120ms;
  }
  .grid li:nth-child(3n + 1) .hc { left: 4px; transform: none; }
  .grid li:nth-child(3n) .hc { left: auto; right: 4px; transform: none; }
  .b:hover .hc, .b:focus-visible .hc {
    opacity: 1; visibility: visible;
    transition: opacity 120ms ease 600ms, visibility 0s linear 600ms;
  }
  @media (prefers-reduced-motion: reduce) { .hc, .b:hover .hc, .b:focus-visible .hc { transition: none; } }

  /* The binder: a page of nine pockets, three across. */
  .binder-pages { display: grid; gap: 12px; margin: 16px 0 0; }
  .binder {
    list-style: none; margin: 0; padding: 10px;
    display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px;
    border-radius: 10px; background: var(--v4-control-bg);
  }
  .pocket { min-width: 0; aspect-ratio: 5 / 7; border-radius: 6px; }
  .pocket.empty { box-shadow: inset 0 0 0 1px var(--v4-hairline, var(--v4-rowline, var(--line))); }
  .sleeve {
    display: block; width: 100%; height: 100%; padding: 0; border: 0; border-radius: 6px;
    background: transparent; cursor: pointer;
    transition: transform 120ms ease;
  }
  .sleeve:hover { transform: translateY(-2px); }
  @media (prefers-reduced-motion: reduce) {
    .b, .sleeve { transition: none; }
    .sleeve:hover { transform: none; }
  }
</style>
