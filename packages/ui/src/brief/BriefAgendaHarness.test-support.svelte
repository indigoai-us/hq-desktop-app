<script lang="ts">
  /** Test harness: mounts BriefAgenda with a brief context and the peek card, as DailyBrief would. */
  import BriefAgenda from "./BriefAgenda.svelte";
  import BriefPeek from "./BriefPeek.svelte";
  import { BriefState, provideBrief, type BriefLaunch } from "./brief-context.svelte.js";
  import type { BriefCalendarEvent } from "./brief-types.js";

  let {
    events,
    rows = 2,
    cols = 2,
    now = null,
    sample = false,
    onopenmeetings,
    launch = async () => null,
  }: {
    events: BriefCalendarEvent[];
    rows?: number;
    cols?: number;
    now?: string | null;
    sample?: boolean;
    onopenmeetings?: () => void;
    launch?: BriefLaunch;
  } = $props();

  const state = new BriefState((engine, prompt) => launch(engine, prompt), () => []);
  provideBrief(state);
</script>

<div class="daily-brief">
  <BriefAgenda {events} {rows} {cols} {now} {sample} {onopenmeetings} />
  <BriefPeek />
</div>
