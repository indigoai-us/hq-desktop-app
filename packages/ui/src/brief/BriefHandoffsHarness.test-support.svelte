<script lang="ts">
  /**
   * Test-only host for BriefHandoffs. DailyBrief provides the brief context
   * (launch seam, company logos, peek state) and renders the peek layer; this
   * does the same for one card so vitest can mount it alone. Not used by the
   * page.
   */
  import BriefHandoffs from "./BriefHandoffs.svelte";
  import BriefPeek from "./BriefPeek.svelte";
  import { BriefState, provideBrief, type BriefCompanyLogo, type BriefLaunch } from "./brief-context.svelte.js";
  import type { BriefHandoff } from "./brief-types.js";

  let {
    handoffs,
    prompts = {},
    now,
    rows,
    companies = [],
    launch = async () => null,
  }: {
    handoffs: BriefHandoff[];
    prompts?: Record<string, string>;
    now: string;
    rows: number;
    companies?: BriefCompanyLogo[];
    launch?: BriefLaunch;
  } = $props();
  provideBrief(new BriefState((engine, prompt) => launch(engine, prompt), () => companies));
</script>

<div class="daily-brief">
  <BriefHandoffs {handoffs} {prompts} {now} {rows} />
  <BriefPeek />
</div>
