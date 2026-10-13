<script lang="ts">
  /** Test harness: mounts BriefBlockedByMe with a brief context and the peek card, as DailyBrief would. */
  import BriefBlockedByMe from "./BriefBlockedByMe.svelte";
  import BriefPeek from "./BriefPeek.svelte";
  import { BriefState, provideBrief, type BriefCompanyLogo, type BriefLaunch } from "./brief-context.svelte.js";
  import type { BriefDecision } from "./brief-types.js";

  let {
    decisions,
    prompts = {},
    cols = 2,
    rows = 2,
    companies = [],
    launch = async () => null,
  }: {
    decisions: BriefDecision[];
    prompts?: Record<string, string>;
    cols?: number;
    rows?: number;
    companies?: BriefCompanyLogo[];
    launch?: BriefLaunch;
  } = $props();

  const state = new BriefState((engine, prompt) => launch(engine, prompt), () => companies);
  provideBrief(state);
</script>

<div class="daily-brief">
  <BriefBlockedByMe {decisions} {prompts} {cols} {rows} />
  <BriefPeek />
</div>
