/**
 * Door into the live transcript chunk. The promise is memoized. The meeting
 * canvas imports only this module and the door component; the poller and
 * the transcript body load when the Transcript tab opens.
 */
export type LiveTranscriptModule = typeof import("./LiveTranscriptBody.svelte");

let pending: Promise<LiveTranscriptModule> | null = null;

export function loadLiveTranscript(): Promise<LiveTranscriptModule> {
  pending ??= import("./LiveTranscriptBody.svelte").catch((err) => {
    pending = null;
    throw err;
  });
  return pending;
}
