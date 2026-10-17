<script lang="ts">
  /** Test harness: mounts BriefMeetings with a brief context and the peek card, as DailyBrief would. */
  import BriefMeetings from "./BriefMeetings.svelte";
  import BriefPeek from "./BriefPeek.svelte";
  import { BriefState, provideBrief, type BriefCompanyLogo, type BriefLaunch } from "./brief-context.svelte.js";
  import type { BriefDay, BriefMeeting } from "./brief-types.js";

  let {
    meetings,
    rows = 2,
    cols = 2,
    now = null,
    windowFrom = null,
    days = [],
    today = null,
    companies = [],
    launch = async () => null,
    settled = false,
  }: {
    meetings: BriefMeeting[];
    rows?: number;
    cols?: number;
    now?: string | null;
    windowFrom?: string | null;
    days?: BriefDay[];
    today?: string | null;
    companies?: BriefCompanyLogo[];
    launch?: BriefLaunch;
    settled?: boolean;
  } = $props();

  const state = new BriefState((engine, prompt) => launch(engine, prompt), () => companies);
  provideBrief(state);
</script>

<div class="daily-brief">
  <BriefMeetings {meetings} {rows} {cols} {now} {windowFrom} {days} {today} {settled} />
  <BriefPeek />
</div>
