<script lang="ts">
  /**
   * An account's company level with its progress to the next (US-019): the
   * level coin, "Level 4 Momentum", a thin track filled toward the next
   * threshold by the best month, and the next threshold ("$1k"). Shown on
   * each Settings > Usage line and in the Core menu meter.
   *
   * The track's fill is the level's own colour, so the chip previews what the
   * bar looks like at this level. The full next-level sentence is the
   * tooltip (dense settings: explanations live in tooltips).
   */
  import UsageLevelMark from "./UsageLevelMark.svelte";
  import { levelTheme } from "./usage-level-theme.js";
  import { formatUsd } from "./core-usage-model.js";
  import { levelInfo, levelProgress, levelThresholdText, monthName, nextLevel, nextLevelLine } from "./usage-levels.js";

  interface Props {
    level: number;
    bestCents: number;
    bestMonth?: string | null;
    /** `row`: one line (Settings > Usage); `menu`: the Core menu meter. */
    variant?: "row" | "menu";
    [key: string]: unknown;
  }

  let { level, bestCents, bestMonth = null, variant = "row", ...rest }: Props = $props();

  const info = $derived(levelInfo(level));
  const next = $derived(nextLevel(level));
  const progress = $derived(levelProgress(bestCents, level));
  const fill = $derived(levelTheme(level)?.mark ?? levelTheme(1)?.mark ?? "var(--t2)");
  const title = $derived(
    `${info ? `Level ${info.n} ${info.name}` : "No level yet"}. Best month ${formatUsd(bestCents)}${bestMonth ? ` (${monthName(bestMonth)})` : ""}. ${nextLevelLine(level)}.`,
  );
</script>

<span class="ulc" data-variant={variant} data-level={level} data-testid="usage-level-chip" title={title} {...rest}>
  <UsageLevelMark {level} size={variant === "menu" ? 18 : 16} />
  <span class="name" data-testid="usage-level-name">{info ? `Level ${info.n} ${info.name}` : "No level yet"}</span>
  {#if next}
    <span
      class="track"
      role="progressbar"
      aria-label={`Progress to Level ${next.n} ${next.name}`}
      aria-valuemin="0"
      aria-valuemax="100"
      aria-valuenow={Math.round(progress * 100)}
      data-testid="usage-level-progress"
    ><span class="fill" style:width="{Math.round(progress * 100)}%" style:background={fill}></span></span>
    <span class="next" data-testid="usage-level-next">{levelThresholdText(next.cents)}</span>
  {:else}
    <span class="next top" data-testid="usage-level-next">Top level</span>
  {/if}
</span>

<style>
  .ulc {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    color: var(--t2);
    font-size: 11.5px;
    line-height: 16px;
    white-space: nowrap;
  }

  .name {
    color: var(--t1);
    font-weight: 500;
  }

  .track {
    position: relative;
    display: block;
    width: 44px;
    height: 3px;
    overflow: hidden;
    border-radius: 999px;
    background: var(--v4-control-faint, var(--line2, rgba(127, 127, 127, 0.2)));
  }

  .ulc[data-variant="menu"] .track {
    width: 56px;
  }

  .fill {
    display: block;
    height: 100%;
    border-radius: inherit;
  }

  .next {
    font-variant-numeric: tabular-nums;
  }
</style>
