<script lang="ts">
  /**
   * Lazy token chart (US-026). Bars use --v4-text-1 opacities only.
   * Imported through activity-chart.ts, never from the shell boot path.
   */
  import type { DayBar } from "./activity-model.js";

  interface Props {
    bars: DayBar[];
  }

  let { bars }: Props = $props();
</script>

<div class="at-days" data-testid="token-day-strip" data-days={bars.length}>
  {#each bars as bar (bar.iso)}
    <i
      class:wk={bar.weekend}
      class:today={bar.today}
      style:height="{bar.heightPct}%"
      title={bar.label}
      data-weekend={bar.weekend ? "true" : "false"}
    ></i>
  {/each}
</div>

<style>
  .at-days {
    display: flex;
    align-items: flex-end;
    gap: 3px;
    height: 48px;
    margin: 6px 0 4px;
  }
  .at-days i {
    flex: 1;
    min-width: 0;
    border-radius: 1px 1px 0 0;
    background: color-mix(in srgb, var(--v4-text-1) 38%, transparent);
  }
  .at-days i.wk {
    background: color-mix(in srgb, var(--v4-text-1) 14%, transparent);
  }
  .at-days i.today {
    background: color-mix(in srgb, var(--v4-text-1) 72%, transparent);
  }
</style>
