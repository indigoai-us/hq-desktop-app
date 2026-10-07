/**
 * Door into the US-022 meetings states chunk. The promise is memoized.
 * The shell imports only this module plus the skeleton component.
 */
export type MeetingsStatesModule = typeof import("./MeetingsStatesBody.svelte");

let pending: Promise<MeetingsStatesModule> | null = null;

export function loadMeetingsStates(): Promise<MeetingsStatesModule> {
  pending ??= import("./MeetingsStatesBody.svelte").catch((err) => {
    pending = null;
    throw err;
  });
  return pending;
}
