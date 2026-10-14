<script lang="ts">
  /**
   * Test-only host for BriefFirsts. DailyBrief provides the BriefState
   * context (peek card, engine, launch seam) through a module-private key, so
   * a card cannot be mounted alone; this probe provides the same state and
   * renders the card beside the peek, nothing else.
   */
  import BriefFirsts from "./BriefFirsts.svelte";
  import BriefPeek from "./BriefPeek.svelte";
  import { BriefState, provideBrief, type BriefCompanyLogo, type BriefLaunch } from "./brief-context.svelte.js";
  import type { BriefShipped } from "./brief-types.js";

  interface Props {
    shipped: BriefShipped[];
    cols: number;
    rows: number;
    prompts?: Record<string, string>;
    reducedMotion?: boolean | null;
    companies?: readonly BriefCompanyLogo[];
    onlaunch?: BriefLaunch;
  }
  let { shipped, cols, rows, prompts = {}, reducedMotion = true, companies = [], onlaunch = async () => null }: Props = $props();

  provideBrief(new BriefState((engine, prompt) => onlaunch(engine, prompt), () => companies));
</script>

<div class="daily-brief">
  <BriefFirsts {shipped} {cols} {rows} {prompts} {reducedMotion} />
  <BriefPeek />
</div>
