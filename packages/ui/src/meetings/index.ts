/** Meetings area barrel — desktop-alt Meetings surface, platform-pure. */
export { default as MeetingsPage } from "./MeetingsPage.svelte";
export { default as MeetingsAgenda } from "./MeetingsAgenda.svelte";
export {
  configureMeetingsApi,
  meetingsStore,
  setMeetingsViewActive,
  startMeetingsStore,
  stopMeetingsStore,
  type BeginCalendarConnectResult,
  type MeetingBotAction,
  type MeetingsStoreApi,
  type ToastDescriptor,
} from "./meetings-store.svelte";
export * from "./meetings-model";
export * from "./meetings-view-model";
export {
  activeMeetings,
  recordingMemberships,
  configureRecordingControls,
  upsertActiveMeeting,
  updateActiveMeeting,
  removeActiveMeeting,
  startRecording,
  stopRecording,
  setRecordingCompany,
  type ActiveMeeting,
  type ActiveMeetingState,
  type RecordingControls,
  type RecordingMembership,
} from "./active-meetings";
export { HQ_CONSOLE_INTEGRATIONS_URL } from "../common/hq-console";
export { isAlreadyScheduledError, isPlanRequiredError } from "./invite-errors";
export { loadMeetingsCache, saveMeetingsCache } from "./meetings-cache";
