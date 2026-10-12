<script lang="ts">
  /**
   * Test host for BriefFleetRecovery: provides the brief context (BriefState)
   * around the card and renders the peek, so the card can be mounted on its
   * own in tests. Not used by the app.
   */
  import BriefFleetRecovery from "./BriefFleetRecovery.svelte";
  import BriefPeek from "./BriefPeek.svelte";
  import { BriefState, launchBriefPromptViaClipboard, provideBrief, type BriefCompanyLogo, type BriefLaunch } from "./brief-context.svelte.js";
  import type { ComponentProps } from "svelte";

  interface Props {
    card: ComponentProps<typeof BriefFleetRecovery>;
    onlaunch?: BriefLaunch;
    companies?: readonly BriefCompanyLogo[];
  }
  let { card, onlaunch = launchBriefPromptViaClipboard, companies = [] }: Props = $props();
  provideBrief(new BriefState((engine, prompt) => onlaunch(engine, prompt), () => companies));
</script>

<div class="daily-brief">
  <BriefFleetRecovery {...card} />
  <BriefPeek />
</div>
