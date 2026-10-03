<!--
  Meetings canvas host (console-rail US-021). Shows the live meeting canvas
  for the selected row, or the classic agenda (MeetingsPage) when agenda mode
  is on or there is no meeting to show. MeetingsPage stays mounted underneath
  either way: it owns the existing poll and focus refresh, so the canvas adds
  no new pollers.
-->
<script lang="ts">
  import { onMount, untrack, type Snippet } from "svelte";
  import LiveNowCard from "../common/LiveNowCard.svelte";
  import {
    activeMeetings,
    recordingMemberships,
    setRecordingCompany,
    startRecording,
    stopRecording,
  } from "./active-meetings";
  import MeetingCanvas from "./MeetingCanvas.svelte";
  import { meetingsStore } from "./meetings-store.svelte";
  import { withRecordedEvents } from "./recorded-meetings";
  import { meetingsRailState } from "./meetings-rail-state.svelte";
  import { defaultMeetingId, meetingsRailSections } from "./meetings-rail-model";
  import { botForEvent, pickLiveMeeting } from "./meetings-model";
  import { meetingPhase } from "./meeting-states-model";
  import MeetingsStatesDoor from "./MeetingsStatesDoor.svelte";
  import { pushToast } from "../shell/toast-stack.svelte.js";

  interface Props {
    /** The classic agenda page, rendered by the shell with its own props. */
    agenda: Snippet;
    openExternal?: (url: string) => void;
    /** Deep link (notification, palette) to one meeting. */
    focusMeetingId?: string | null;
  }

  let { agenda, openExternal, focusMeetingId = null }: Props = $props();

  onMount(() => meetingsRailState.registerCanvasHost());

  // A meeting the desktop detected keeps its recording controls on the
  // visible canvas; the agenda below is hidden while agenda mode is off.
  const nativeLiveMeeting = $derived(pickLiveMeeting($activeMeetings));

  let focused: string | null = null;
  $effect.pre(() => {
    if (!focusMeetingId || focusMeetingId === focused) return;
    focused = focusMeetingId;
    meetingsRailState.select(focusMeetingId);
  });

  const events = $derived(
    withRecordedEvents(
      [...meetingsRailState.localMeetings, ...meetingsStore.events],
      meetingsStore.recorded,
    ),
  );
  const sections = $derived(
    meetingsRailSections({
      events,
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
      : (events.find((e) => e.id === selectedId) ?? null),
  );
  const bot = $derived(
    event ? botForEvent(event, meetingsStore.botsByEventId, meetingsStore.scheduledBots) : undefined,
  );
  const phase = $derived(event ? meetingPhase(event, new Date(), bot) : null);
  // A recorded past meeting loads its saved notes from the server when opened;
  // the canvas shows them, or one quiet line when there are none.
  const recordedId = $derived(phase === "past" ? (event?.recorded?.meetingId ?? null) : null);
  $effect(() => {
    const id = recordedId;
    if (!id) return;
    const companyUid = event?.sourceCompanyUid ?? null;
    untrack(() => void meetingsStore.loadRecordedNotes(id, companyUid));
  });
  const notesEntry = $derived(recordedId ? meetingsStore.recordedNotes[recordedId] : undefined);
  const shownEvent = $derived(
    event && notesEntry?.signals ? { ...event, signals: notesEntry.signals } : event,
  );
  const notesLoading = $derived(Boolean(recordedId) && (!notesEntry || notesEntry.status === "loading"));
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

{#if nativeLiveMeeting && meetingsRailState.hostOwnsLiveCard}
  <LiveNowCard
    meeting={nativeLiveMeeting}
    memberships={$recordingMemberships}
    onstart={startRecording}
    onstop={stopRecording}
    oncompany={setRecordingCompany}
    {openExternal}
  />
{/if}
{#if event && phase === "live"}
  <MeetingCanvas
    {event}
    {bot}
    {companyName}
    {openExternal}
    oncopy={(url) => void copy(url)}
    onmore={() => meetingsRailState.showAgenda()}
  />
{/if}
{#if meetingsRailState.sheetOpen && (meetingsRailState.agenda || phase === "live")}
  <MeetingsStatesDoor
    sheetOnly
    mode="empty"
    sheetOpen
    sheetLink={meetingsRailState.sheetLink}
    {openExternal}
    oncopy={(text: string) => void copy(text)}
    oncloseSheet={() => meetingsRailState.openSheet(false)}
    oncreate={(created: import("./meetings-model").MeetingEvent) => meetingsRailState.addLocalMeeting(created)}
  />
{:else if !meetingsRailState.agenda && phase !== "live"}
  <MeetingsStatesDoor
    mode={phase === "past" ? "recap" : phase === "upcoming" ? "upcoming" : "empty"}
    event={shownEvent}
    {notesLoading}
    {bot}
    {companyName}
    {sections}
    sheetOpen={meetingsRailState.sheetOpen}
    sheetLink={meetingsRailState.sheetLink}
    {openExternal}
    oncopy={(text: string) => void copy(text)}
    onselect={(id: string) => meetingsRailState.select(id)}
    onopenSheet={(link?: string) => meetingsRailState.openSheet(true, link ?? null)}
    oncloseSheet={() => meetingsRailState.openSheet(false)}
    oncreate={(created: import("./meetings-model").MeetingEvent) => meetingsRailState.addLocalMeeting(created)}
  />
{/if}
<div class="agenda-slot" style:display={meetingsRailState.agenda ? "contents" : "none"} data-testid="meetings-agenda-slot">
  {@render agenda()}
</div>
