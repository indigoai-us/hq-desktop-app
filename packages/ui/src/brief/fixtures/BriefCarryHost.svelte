<script lang="ts">
  /**
   * Test host for BriefCarry: provides the brief context (the state DailyBrief
   * normally creates) so one card and its peek render alone under vitest.
   * `onlaunch` records what a Start button hands over; `companies` feeds the
   * logos. Not read in production.
   */
  import type { ComponentProps } from "svelte";
  import BriefCarry from "../BriefCarry.svelte";
  import BriefPeek from "../BriefPeek.svelte";
  import { BriefState, provideBrief, type BriefCompanyLogo, type BriefLaunch } from "../brief-context.svelte.js";

  type Props = { companies?: BriefCompanyLogo[]; onlaunch?: BriefLaunch } & ComponentProps<typeof BriefCarry>;
  let { companies = [], onlaunch, ...card }: Props = $props();
  provideBrief(new BriefState((engine, prompt) => (onlaunch ? onlaunch(engine, prompt) : Promise.resolve(null)), () => companies));
</script>

<div class="daily-brief">
  <BriefCarry {...card} />
  <BriefPeek />
</div>
