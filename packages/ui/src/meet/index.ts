/** Meet area barrel — the shared, platform-pure office-hours surface (US-018). */
export { default as OfficeHours } from "./OfficeHours.svelte";
export { default as OfficePanel } from "./OfficePanel.svelte";
export type { OfficeCallsHost, OfficeCallTarget } from "./office-host.js";
export {
  createOfficeStore,
  expireOfficePerson,
  isRoomJoinable,
  parseOfficePerson,
  OFFICE_CONNECTIVITY,
  OFFICE_DURATIONS,
  OFFICE_LIMITS,
  OFFICE_WILLINGNESS,
  type OfficeConnectivity,
  type OfficeError,
  type OfficeOccupancy,
  type OfficePerson,
  type OfficeRoom,
  type OfficeState,
  type OfficeStatus,
  type OfficeStore,
  type OfficeStoreOptions,
  type OfficeWillingness,
} from "./office-store.svelte.js";
