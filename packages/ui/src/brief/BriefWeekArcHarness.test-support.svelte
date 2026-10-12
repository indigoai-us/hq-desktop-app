<script lang="ts">
  /**
   * Test-only host for BriefWeekArc: provides the brief context the card
   * reads (peek state, no launcher, no companies) and mounts the peek card, so
   * brief-week-arc.test.ts can hover discs and rows without a whole DailyBrief.
   */
  import BriefPeek from "./BriefPeek.svelte";
  import BriefWeekArc from "./BriefWeekArc.svelte";
  import { BriefState, provideBrief } from "./brief-context.svelte.js";
  import type { BriefDay } from "./brief-types.js";

  interface Props {
    days: BriefDay[];
    today: string;
    cols: number;
    rows: number;
  }
  let { days, today, cols, rows }: Props = $props();
  provideBrief(new BriefState(async () => null, () => []));
</script>

<div class="daily-brief">
  <BriefWeekArc {days} {today} {cols} {rows} />
  <BriefPeek />
</div>
