<script lang="ts">
  /**
   * Badges section for the person and bot profile panes: the newest few
   * earned badges as small marks, each with its name and tier. Clicking one
   * opens its detail view.
   */
  import BadgeMark from "./BadgeMark.svelte";
  import { TIER_NAME, resolveEarned, type EarnedBadge, type ResolvedBadge } from "./badge-catalog.js";

  interface Props {
    badges: readonly EarnedBadge[];
    /** How many to show; "See all" opens every badge, locked ones and the cards. */
    max?: number;
    onselect?: (badge: ResolvedBadge) => void;
    onseeall?: () => void;
  }

  let { badges, max = 4, onselect, onseeall }: Props = $props();
  const earned = $derived(resolveEarned(badges));
  const shown = $derived(earned.slice(0, max));
</script>

{#if shown.length}
  <section class="badges" data-testid="profile-badges" aria-label="Badges">
    <div class="k">
      Badges <span class="count">{earned.length}</span>
      {#if onseeall}
        <button type="button" class="link" data-testid="profile-badges-all" onclick={() => onseeall?.()}>See all</button>
      {/if}
    </div>
    <ul class="grid">
      {#each shown as item (item.def.id)}
        <li>
          <button
            type="button"
            class="b"
            data-testid="profile-badge"
            data-badge-id={item.def.id}
            aria-describedby="profile-badge-hc-{item.def.id}"
            disabled={!onselect}
            onclick={() => onselect?.(item)}
          >
            <BadgeMark badge={item.def} tier={item.tier} label="{item.def.name}, {TIER_NAME[item.tier]}" />
            <span class="nm">{item.def.name}</span>
            <span class="tr">{TIER_NAME[item.tier]}</span>
            <span class="hc" role="tooltip" aria-hidden="true" id="profile-badge-hc-{item.def.id}" data-testid="profile-badge-hover-card">{item.def.crit}</span>
          </button>
        </li>
      {/each}
    </ul>
  </section>
{/if}

<style>
  /* Section label: the mono caps label style shared by the profile panes. */
  .k {
    display: flex; align-items: baseline; gap: 6px; margin: 20px 0 8px;
    font: 500 10px/1.4 var(--font-mono, "Geist Mono", monospace); letter-spacing: 0.1em; text-transform: uppercase;
    color: var(--v4-text-3);
  }
  .count { font-variant-numeric: tabular-nums; }
  /* A text button, not part of the mono caps label it sits in. */
  .link { margin-left: auto; padding: 0; border: 0; background: none; font: 400 12px/1.4 var(--font-ui, var(--font-sans)); letter-spacing: normal; text-transform: none; color: var(--v4-text-2); cursor: pointer; }
  /* Text buttons dim on hover; no underline. */
  .link:hover { color: var(--v4-text-3); }
  .grid { list-style: none; margin: 0 -4px; padding: 0; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 4px; }
  .b {
    width: 100%; min-width: 0; display: flex; flex-direction: column; align-items: center; gap: 2px;
    padding: 6px 2px 8px; border: 0; border-radius: 8px; background: transparent;
    color: inherit; font: inherit; text-align: center; cursor: pointer;
    transition: background-color 120ms ease;
  }
  .b:hover:not(:disabled) { background: var(--hover, var(--v4-hover)); }
  .b:focus-visible { outline: 2px solid var(--v4-focus, var(--v4-text-2)); outline-offset: -2px; }
  .b:disabled { cursor: default; }
  /* Small under the mark, so a two-word name and its level stay compact
     (owner review 2026-10-08). */
  .nm { max-width: 100%; font-size: 12px; color: var(--v4-text-1); line-height: 1.3; overflow-wrap: anywhere; }
  /* The level reads quieter than the name. */
  .tr { font-size: 11px; line-height: 1.4; color: var(--v4-text-3); }
  /* What earns the badge: the app's hover-card style (not the system
     tooltip), under the badge on hover or keyboard focus. The outer columns
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
  .grid li:nth-child(4n + 1) .hc { left: 0; transform: none; }
  .grid li:nth-child(4n) .hc { left: auto; right: 0; transform: none; }
  .b:hover .hc, .b:focus-visible .hc {
    opacity: 1; visibility: visible;
    transition: opacity 120ms ease 600ms, visibility 0s linear 600ms;
  }
  @media (prefers-reduced-motion: reduce) { .b, .hc, .b:hover .hc, .b:focus-visible .hc { transition: none; } }
</style>
