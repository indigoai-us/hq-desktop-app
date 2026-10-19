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
  import type { BriefLaunch } from "./brief-context.svelte.js";
  import type { BriefWelcome } from "./brief-welcome.js";

  interface Props {
    input: BriefInput;
    actions?: BriefActions;
    report: Record<string, unknown>;
    /** The report turns ready when this does, as the shell's job lands. */
    ready?: boolean;
    onlaunch?: BriefLaunch;
    onopenmeetings?: () => void;
    /** brief.json `welcome`: the first view's actions and found work. */
    welcome?: BriefWelcome | null;
    onconnectcompany?: () => void;
  }
  let { input, actions, report, ready = true, onlaunch = async () => null, onopenmeetings, welcome = null, onconnectcompany }: Props = $props();
</script>

<WelcomeReport {ready} {...report}>
  <DailyBrief {input} {actions} {onlaunch} {onopenmeetings} {welcome} {onconnectcompany} />
</WelcomeReport>
