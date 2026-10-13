<script lang="ts">
  /**
   * Test host for BriefRunway: provides the brief context (the state
   * DailyBrief normally creates) so the card and its peek render alone under
   * vitest. The launch seam records nothing. Not read in production.
   */
  import type { ComponentProps } from "svelte";
  import BriefPeek from "../BriefPeek.svelte";
  import BriefRunway from "../BriefRunway.svelte";
  import { BriefState, provideBrief } from "../brief-context.svelte.js";

  type Props = ComponentProps<typeof BriefRunway>;
  let { ...card }: Props = $props();
  provideBrief(new BriefState(async () => null, () => []));
</script>

<div class="daily-brief">
  <BriefRunway {...card} />
  <BriefPeek />
</div>
