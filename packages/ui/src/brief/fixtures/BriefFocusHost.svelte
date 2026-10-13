<script lang="ts">
  /**
   * Test host for BriefFocus: provides the brief context (the state
   * DailyBrief normally creates) so one card and its peek render alone under
   * vitest. The launch seam records nothing; `logos` feeds the company logos.
   * Not read in production.
   */
  import type { ComponentProps } from "svelte";
  import BriefFocus from "../BriefFocus.svelte";
  import BriefPeek from "../BriefPeek.svelte";
  import { BriefState, provideBrief, type BriefCompanyLogo } from "../brief-context.svelte.js";

  type Props = { logos?: BriefCompanyLogo[] } & ComponentProps<typeof BriefFocus>;
  let { logos = [], ...card }: Props = $props();
  provideBrief(new BriefState(async () => null, () => logos));
</script>

<div class="daily-brief">
  <BriefFocus {...card} />
  <BriefPeek />
</div>
