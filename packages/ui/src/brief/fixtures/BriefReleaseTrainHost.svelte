<script lang="ts">
  /**
   * Test host for BriefReleaseTrain: provides the brief context (the state
   * DailyBrief normally creates) so one card and its peek render alone under
   * vitest. The launch seam records nothing; `companies` feeds the logos.
   * Not read in production.
   */
  import type { ComponentProps } from "svelte";
  import BriefPeek from "../BriefPeek.svelte";
  import BriefReleaseTrain from "../BriefReleaseTrain.svelte";
  import { BriefState, provideBrief, type BriefCompanyLogo } from "../brief-context.svelte.js";

  type Props = { companies?: BriefCompanyLogo[] } & ComponentProps<typeof BriefReleaseTrain>;
  let { companies = [], ...card }: Props = $props();
  provideBrief(new BriefState(async () => null, () => companies));
</script>

<div class="daily-brief">
  <BriefReleaseTrain {...card} />
  <BriefPeek />
</div>
