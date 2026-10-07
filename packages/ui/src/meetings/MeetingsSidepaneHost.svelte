<!--
  Meetings sidepane host (console-rail US-021): binds MeetingsSidepane to the
  warm meetings-store snapshot (hydrated from meetings-cache) and the shared
  rail state. Reads only; the store's own refresh runs in the background.
-->
<script lang="ts">
  import MeetingsSidepane from "./MeetingsSidepane.svelte";
  import InviteNotetakerSheet from "./InviteNotetakerSheet.svelte";
  import { meetingsStore } from "./meetings-store.svelte";
  import { activeMeetings } from "./active-meetings";
  import { withRecordedEvents } from "./recorded-meetings";
  import { meetingsRailState } from "./meetings-rail-state.svelte";
  import { defaultMeetingId, meetingsRailSections } from "./meetings-rail-model";
  import { withDetectedRecordingEvents } from "./meetings-model";
  import type { SidepaneScrollMemory } from "../shell/sidepane-models.js";

  interface Props {
    memory?: SidepaneScrollMemory;
  }

  let { memory }: Props = $props();
  let inviting = $state(false);

  // Recomputed when the snapshot changes; the minute clock lives in the store refresh.
  const events = $derived(withDetectedRecordingEvents(
    withRecordedEvents(meetingsStore.events, meetingsStore.recorded),
    $activeMeetings,
  ));
  const sections = $derived(
    meetingsRailSections({
      events,
      botsByEventId: meetingsStore.botsByEventId,
      scheduledBots: meetingsStore.scheduledBots,
      companyNamesByUid: meetingsStore.companyNamesByUid,
      filter: meetingsRailState.filter,
    }),
  );
  const selectedId = $derived(
    meetingsRailState.agenda ? null : (meetingsRailState.selectedId ?? defaultMeetingId(sections)),
  );
</script>

<MeetingsSidepane
  {sections}
  events={events}
  companyNamesByUid={meetingsStore.companyNamesByUid}
  {selectedId}
  filter={meetingsRailState.filter}
  loading={meetingsStore.initialLoadPending}
  error={meetingsStore.recordedError}
  onretry={() => void meetingsStore.refresh()}
  {memory}
  onselect={(id) => meetingsRailState.select(id)}
  onfilter={(next) => meetingsRailState.setFilter(next)}
  oninvite={() => (inviting = true)}
  onearlier={() => meetingsRailState.showAgenda()}
/>
{#if inviting}
  <InviteNotetakerSheet onclose={() => (inviting = false)} />
{/if}
