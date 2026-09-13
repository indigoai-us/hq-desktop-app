/** Meet area barrel — the shared, platform-pure office-hours surface (US-018). */
export { default as CallView } from "./CallView.svelte";
export { default as MediaControls } from "./MediaControls.svelte";
export { default as MediaPermissionCard } from "./MediaPermissionCard.svelte";
export {
  CALL_TILE_LIMIT,
  DEVICE_PREFS_KEY,
  canModerate,
  deriveCallView,
  emptyDevicePreferences,
  parseDevicePreferences,
  resolveDevice,
  tileColumns,
  type CallPeerView,
  type CallRole,
  type CallSnapshotView,
  type CallTile,
  type CallViewInput,
  type CallViewLayout,
  type DevicePreferences,
  type MediaDeviceOption,
  type MediaDevicesPort,
  type SelfMediaView,
  type TileConnection,
} from "./call-view-model.js";
export { default as KnockCard } from "./KnockCard.svelte";
export {
  KNOCK_FRIENDLY,
  KNOCK_LIMITS,
  KNOCK_STATES,
  cannedReply,
  expireKnock,
  isKnockActionable,
  isNoteTooLong,
  knockFailure,
  knockSecondsLeft,
  mergeKnock,
  noteByteLength,
  parseKnock,
  parseKnockList,
  sortKnocks,
  type Knock,
  type KnockCapability,
  type KnockDirection,
  type KnockError,
  type KnockSendOutcome,
  type KnockState,
} from "./knocks.js";
export {
  createKnockStore,
  type KnockRoomBinding,
  type KnockState as KnockStoreState,
  type KnockStore,
  type KnockStoreOptions,
} from "./knocks.svelte.js";
export { default as OfficeHours } from "./OfficeHours.svelte";
export { default as OfficePanel } from "./OfficePanel.svelte";
export type { OfficeCallsHost, OfficeCallTarget } from "./office-host.js";
export {
  createOfficeStore,
  expireOfficePerson,
  isRoomJoinable,
  isWalkIn,
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
  type OfficeRoomVisibility,
  type OfficeState,
  type OfficeStatus,
  type OfficeStore,
  type OfficeStoreOptions,
  type OfficeWillingness,
} from "./office-store.svelte.js";
