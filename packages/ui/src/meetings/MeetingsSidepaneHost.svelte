<!--
  Meetings sidepane host (console-rail US-021): binds MeetingsSidepane to the
  warm meetings-store snapshot (hydrated from meetings-cache) and the shared
  rail state. Reads only; the store's own refresh runs in the background.
-->
<script lang="ts">
  import MeetingsSidepane from "./MeetingsSidepane.svelte";
  import { meetingsStore } from "./meetings-store.svelte";
  import { meetingsRailState } from "./meetings-rail-state.svelte";
  import { defaultMeetingId, meetingsRailSections } from "./meetings-rail-model";
  import type { SidepaneScrollMemory } from "../shell/sidepane-models.js";

  interface Props {
    memory?: SidepaneScrollMemory;
    onnewmeeting?: () => void;
  }

  let { memory, onnewmeeting }: Props = $props();

  // Recomputed when the snapshot changes; the minute clock lives in the store refresh.
  const sections = $derived(
    meetingsRailSections({
      events: meetingsStore.events,
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
  events={meetingsStore.events}
  companyNamesByUid={meetingsStore.companyNamesByUid}
  {selectedId}
  filter={meetingsRailState.filter}
  loading={meetingsStore.initialLoadPending}
  {memory}
  onselect={(id) => meetingsRailState.select(id)}
  onfilter={(next) => meetingsRailState.setFilter(next)}
  onnewmeeting={() => (onnewmeeting ? onnewmeeting() : meetingsRailState.showAgenda())}
  onearlier={() => meetingsRailState.showAgenda()}
/>
