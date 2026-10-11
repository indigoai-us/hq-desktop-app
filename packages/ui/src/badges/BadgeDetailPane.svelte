<script lang="ts">
  /**
   * One badge, opened from a profile: the large mark, what earns it, the
   * levels with the one reached, and when it was earned.
   */
  import RailIcon from "../common/button/RailIcon.svelte";
  import FullBadge from "./FullBadge.svelte";
  import BadgeCardModal from "./BadgeCardModal.svelte";
  import { badgeLevels } from "./badge-levels.js";
  import { TIER_NAME, type ResolvedBadge } from "./badge-catalog.js";
  import { PROFILE_PANE_WIDTH } from "../shell/profile-panes/profile-pane-model.js";

  interface Props {
    badge: ResolvedBadge;
    /** Who earned it, shown in the meta line. */
    owner?: string;
    onback?: () => void;
    /** Names where Back goes: the profile, or the Badges page. */
    backLabel?: string;
    onclose?: () => void;
  }

  let { badge, owner = "", onback, backLabel = "Back to profile", onclose }: Props = $props();
  /** The card, on its dark stage. */
  let cardOpen = $state(false);
  /** WebKit does not focus a clicked button, so the opener is named for the return. */
  let viewCardEl = $state<HTMLButtonElement | null>(null);
  const levels = $derived(badgeLevels(badge.def, badge.tier));
  const earnedOn = $derived.by(() => {
    const d = new Date(`${badge.earnedAt}T12:00:00`);
    return Number.isNaN(d.getTime()) ? badge.earnedAt : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  });
</script>

<aside class="pane" style:width="{PROFILE_PANE_WIDTH}px" aria-label="{badge.def.name} badge" data-testid="badge-detail-pane">
  <header class="head">
    <button type="button" class="icon" data-testid="badge-detail-back" aria-label={backLabel} onclick={() => onback?.()}><RailIcon name="caret-left" size={14} /></button>
    <span>Badge</span>
    <span class="grow"></span>
    <button type="button" class="icon" data-testid="badge-detail-close" aria-label="Close" onclick={() => onclose?.()}><RailIcon name="x" size={14} /></button>
  </header>
  <div class="body">
    <div class="hero">
      <FullBadge badge={badge.def} tier={badge.tier} label="{badge.def.name}, {TIER_NAME[badge.tier]}" />
      <div class="nm">{badge.def.name}</div>
      <p class="crit">{badge.def.crit}.</p>
      <div class="meta">{TIER_NAME[badge.tier]} · Earned {earnedOn}{owner ? ` by ${owner}` : ""}</div>
      <button type="button" class="link" data-testid="badge-detail-view-card" bind:this={viewCardEl} onclick={() => (cardOpen = true)}><RailIcon name="cards" />View card</button>
    </div>
    <div class="k">Levels</div>
    <ol class="levels">
      {#each levels as level (level.label)}
        <li class:reached={level.reached} class:current={level.current} data-testid="badge-level">
          <span class="dot" aria-hidden="true"></span>
          <span class="tier">{level.tier}</span>
          <span class="need" title={level.label}>{level.label}</span>
          <!-- A single-level badge is reached by being earned; saying so again
               only squeezes its label onto two lines. -->
          {#if level.current && levels.length > 1}<span class="you">Reached</span>{/if}
        </li>
      {/each}
    </ol>
  </div>
</aside>
<BadgeCardModal open={cardOpen} {badge} owner={owner || null} returnFocus={viewCardEl} onclose={() => (cardOpen = false)} />

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
  .body { overflow: auto; padding: 16px 20px 24px; min-height: 0; }
  .hero { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 4px; }
  .nm { margin-top: 8px; font-size: 20px; line-height: 1.25; font-weight: 500; }
  /* The tier line and the description share one type size. */
  .meta, .crit { margin: 0; font: 400 13px/1.45 var(--font-ui, var(--font-sans)); }
  .meta { color: var(--v4-text-3); }
  .crit { color: var(--v4-text-2); }
  .link {
    display: inline-flex; align-items: center; gap: 6px; margin-top: 8px; padding: 0; border: 0;
    background: none; font: inherit; color: var(--v4-text-2); white-space: nowrap; cursor: pointer;
  }
  /* Text buttons dim on hover; no underline. */
  .link:hover { color: var(--v4-text-3); }
  .link:focus-visible { outline: 2px solid var(--v4-focus, var(--v4-text-2)); outline-offset: 2px; border-radius: 4px; }
  .k {
    margin: 20px 0 8px;
    font: 500 10px/1.4 var(--font-mono, "Geist Mono", monospace); letter-spacing: 0.1em; text-transform: uppercase;
    color: var(--v4-text-3);
  }
  .levels { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
  .levels li {
    display: grid; grid-template-columns: 10px 64px minmax(0, 1fr) auto; align-items: center; gap: 8px;
    min-height: 30px; padding: 0 8px; border-radius: 6px; color: var(--v4-text-3);
  }
  .levels li.reached { color: var(--v4-text-2); }
  .levels li.current { background: var(--v4-control-bg); color: var(--v4-text-1); }
  .dot { width: 6px; height: 6px; border-radius: 50%; box-shadow: inset 0 0 0 1px currentColor; }
  .reached .dot { background: currentColor; box-shadow: none; }
  .you { color: var(--v4-text-3); }
  /* Each level stays on one line. */
  /* What each level asks for reads muted beside its tier name. */
  .need { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--v4-text-3); }
</style>
