<script lang="ts">
  /**
   * Test host for BriefReminders: provides the brief context (the state
   * DailyBrief normally creates) so one card and its peek render alone under
   * vitest. `onlaunch` lets a test record what Start hands to the engine;
   * by default the launch seam records nothing. Not read in production.
   */
  import type { ComponentProps } from "svelte";
  import BriefPeek from "../BriefPeek.svelte";
  import BriefReminders from "../BriefReminders.svelte";
  import { BriefState, provideBrief, type BriefLaunch } from "../brief-context.svelte.js";

  type Props = { onlaunch?: BriefLaunch } & ComponentProps<typeof BriefReminders>;
  let { onlaunch, ...card }: Props = $props();
  provideBrief(new BriefState((engine, prompt) => (onlaunch ?? (async () => null))(engine, prompt), () => []));
</script>

<div class="daily-brief">
  <BriefReminders {...card} />
  <BriefPeek />
</div>
