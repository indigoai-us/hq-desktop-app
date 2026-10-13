<script lang="ts">
  /**
   * Test harness: mounts BriefResolved inside a brief context with the peek
   * card, the way DailyBrief does, so a test can hover rows and press Start.
   */
  import BriefPeek from "./BriefPeek.svelte";
  import BriefResolved from "./BriefResolved.svelte";
  import { BriefState, provideBrief, type BriefCompanyLogo, type BriefLaunch } from "./brief-context.svelte.js";
  import type { BriefRecovered } from "./brief-types.js";

  interface Props {
    recovered: BriefRecovered[];
    prompts?: Record<string, string>;
    now: string;
    rows: number;
    companies?: BriefCompanyLogo[];
    onlaunch?: BriefLaunch;
  }

  let { recovered, prompts = {}, now, rows, companies = [], onlaunch = async () => null }: Props = $props();
  const state = new BriefState((engine, prompt) => onlaunch(engine, prompt), () => companies);
  provideBrief(state);
</script>

<div class="daily-brief">
  <BriefResolved {recovered} {prompts} {now} {rows} />
  <BriefPeek />
</div>
