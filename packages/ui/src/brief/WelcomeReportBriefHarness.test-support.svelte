<script lang="ts">
  /**
   * Test-only host: the welcome report with a real Daily Brief as its page,
   * the way the shell nests them, so a test can see where the connect card
   * lands inside the report body.
   */
  import WelcomeReport from "./WelcomeReport.svelte";
  import DailyBrief from "./DailyBrief.svelte";
  import type { BriefActions } from "./brief-action-cards.js";
  import type { BriefInput } from "./brief-types.js";

  interface Props {
    input: BriefInput;
    actions?: BriefActions;
    report: Record<string, unknown>;
    /** The report turns ready when this does, as the shell's job lands. */
    ready?: boolean;
  }
  let { input, actions, report, ready = true }: Props = $props();
</script>

<WelcomeReport {ready} {...report}>
  <DailyBrief {input} {actions} onlaunch={async () => null} />
</WelcomeReport>
