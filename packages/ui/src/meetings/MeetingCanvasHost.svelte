<!--
  Meetings canvas host (console-rail US-021). Shows the live meeting canvas
  for the selected row, or the classic agenda (MeetingsPage) when agenda mode
  is on or there is no meeting to show. MeetingsPage stays mounted underneath
  either way: it owns the existing poll and focus refresh, so the canvas adds
  no new pollers.
-->
<script lang="ts">
  import type { Snippet } from "svelte";
  import MeetingCanvas from "./MeetingCanvas.svelte";
  import { meetingsStore } from "./meetings-store.svelte";
  import { meetingsRailState } from "./meetings-rail-state.svelte";
  import { defaultMeetingId, meetingsRailSections } from "./meetings-rail-model";
  import { botForEvent } from "./meetings-model";
  import { pushToast } from "../shell/toast-stack.svelte.js";

  interface Props {
    /** The classic agenda page, rendered by the shell with its own props. */
    agenda: Snippet;
    openExternal?: (url: string) => void;
    /** Deep link (notification, palette) to one meeting. */
    focusMeetingId?: string | null;
  }

  let { agenda, openExternal, focusMeetingId = null }: Props = $props();

  let focused: string | null = null;
  $effect.pre(() => {
    if (!focusMeetingId || focusMeetingId === focused) return;
    focused = focusMeetingId;
    meetingsRailState.select(focusMeetingId);
  });

  const sections = $derived(
    meetingsRailSections({
      events: meetingsStore.events,
      botsByEventId: meetingsStore.botsByEventId,
      scheduledBots: meetingsStore.scheduledBots,
      companyNamesByUid: meetingsStore.companyNamesByUid,
      filter: meetingsRailState.filter,
    }),
  );
  const selectedId = $derived(meetingsRailState.selectedId ?? defaultMeetingId(sections));
  const event = $derived(
    meetingsRailState.agenda || !selectedId
      ? null
      : (meetingsStore.events.find((e) => e.id === selectedId) ?? null),
  );
  const bot = $derived(
    event ? botForEvent(event, meetingsStore.botsByEventId, meetingsStore.scheduledBots) : undefined,
  );
  const companyName = $derived(
    event?.sourceCompanyUid ? (meetingsStore.companyNamesByUid.get(event.sourceCompanyUid) ?? null) : null,
  );

  async function copy(url: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(url);
      pushToast({ title: "Link copied", detail: url, tone: "ok" });
    } catch (err) {
      console.warn("[meetings] copy link failed", err);
      pushToast({ title: "Could not copy the link", detail: url, tone: "err" });
    }
  }
</script>

{#if event}
  <MeetingCanvas
    {event}
    {bot}
    {companyName}
    {openExternal}
    oncopy={(url) => void copy(url)}
    onmore={() => meetingsRailState.showAgenda()}
  />
{/if}
<div class="agenda-slot" style:display={event ? "none" : "contents"} data-testid="meetings-agenda-slot">
  {@render agenda()}
</div>
