/**
 * Live transcript state and poller for one meeting (Recall real-time).
 *
 * Polls `GET /v1/meetings/{recallBotId}?view=live` through the platform
 * adapter every 3 s while the meeting is live and the window is visible.
 * It makes no requests while the window is hidden and stops when the meeting
 * ends. Returning to the window resumes with an immediate fresh read.
 * Each poll sends the last revision and ETag, so an unchanged transcript
 * costs a 304. A failed poll keeps the last good lines and tries again on
 * the next tick; errors go to the console, never to the screen.
 *
 * Only the lazy live-transcript body imports this file.
 */
import type {
  AdapterResult,
  LiveTranscriptPartialWire,
  LiveTranscriptRequest,
  LiveTranscriptResult,
  LiveTranscriptSegmentWire,
} from "@hq/platform";
import { mergeSegments } from "./live-transcript-model";

export const LIVE_POLL_VISIBLE_MS = 3_000;

export type LiveTranscriptFetch = (
  req: LiveTranscriptRequest,
) => Promise<AdapterResult<LiveTranscriptResult>>;

/**
 * - `connecting`: no answer yet.
 * - `listening`: the server has no snapshot yet, or it has no lines.
 * - `live`: lines are arriving.
 * - `off`: the server has live transcripts turned off for this meeting.
 * - `unavailable`: this host cannot fetch a live transcript.
 */
export type LiveTranscriptStatus = "connecting" | "listening" | "live" | "off" | "unavailable";

export class LiveTranscriptState {
  segments = $state<LiveTranscriptSegmentWire[]>([]);
  partial = $state<LiveTranscriptPartialWire | null>(null);
  status = $state<LiveTranscriptStatus>("connecting");
  /** Consecutive failed polls; reset by any answer from the server. */
  failures = $state(0);
  revision: number | null = null;
  etag: string | null = null;

  apply(result: LiveTranscriptResult): void {
    this.failures = 0;
    switch (result.kind) {
      case "ok": {
        const segments = Array.isArray(result.segments) ? result.segments : [];
        this.segments = result.full ? mergeSegments([], segments) : mergeSegments(this.segments, segments);
        this.partial = result.partial ?? null;
        // A rebuilt server snapshot can have a lower revision. Its `full`
        // marker means the client must adopt that cursor with the replacement
        // body or every later request keeps forcing another full snapshot.
        this.revision = result.full
          ? Number(result.revision) || 0
          : Math.max(this.revision ?? 0, Number(result.revision) || 0);
        this.etag = result.etag ?? null;
        this.status = this.segments.length || this.partial ? "live" : "listening";
        return;
      }
      case "not-modified":
        if (this.status === "connecting") this.status = "listening";
        return;
      case "not-found":
        if (!this.segments.length) this.status = "listening";
        return;
      case "disabled":
        this.status = "off";
        this.partial = null;
        return;
    }
  }

  fail(): void {
    this.failures += 1;
  }
}

export interface LivePollOptions {
  recallBotId: string;
  companyId: string;
  state: LiveTranscriptState;
  fetch: LiveTranscriptFetch;
  /** Read on every tick; polling stops the first time it returns false. */
  isLive: () => boolean;
  /** Defaults to `document.visibilityState === "hidden"`. */
  isHidden?: () => boolean;
  /** Defaults to a `visibilitychange` listener on `document`. */
  onVisibilityChange?: (cb: () => void) => () => void;
}

function documentHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

function documentVisibility(cb: () => void): () => void {
  if (typeof document === "undefined") return () => {};
  document.addEventListener("visibilitychange", cb);
  return () => document.removeEventListener("visibilitychange", cb);
}

/**
 * Start polling. Returns a stop function. The first poll runs at once;
 * the next one is scheduled only after the previous answer, so polls never
 * overlap.
 */
export function startLiveTranscriptPoll(opts: LivePollOptions): () => void {
  const isHidden = opts.isHidden ?? documentHidden;
  const watchVisibility = opts.onVisibilityChange ?? documentVisibility;
  let stopped = false;
  let inFlight = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clear = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clear();
    unwatch();
  };

  const schedule = () => {
    clear();
    if (stopped) return;
    timer = setTimeout(() => void tick(), isHidden() ? LIVE_POLL_HIDDEN_MS : LIVE_POLL_VISIBLE_MS);
  };

  async function tick(): Promise<void> {
    timer = null;
    if (stopped) return;
    if (!opts.isLive()) {
      stop();
      return;
    }
    // Background windows do not poll. The visibility listener below starts an
    // immediate read once the user returns.
    if (isHidden()) return;
    inFlight = true;
    try {
      const res = await opts.fetch({
        recallBotId: opts.recallBotId,
        companyId: opts.companyId,
        sinceRevision: opts.state.revision,
        etag: opts.state.etag,
      });
      if (stopped) return;
      if (res.ok) opts.state.apply(res.value);
      else {
        opts.state.fail();
        console.warn("[meetings] live transcript poll failed", res.reason, res.code ?? "", res.message ?? "");
      }
    } catch (err) {
      if (stopped) return;
      opts.state.fail();
      console.warn("[meetings] live transcript poll failed", err);
    } finally {
      inFlight = false;
    }
    if (opts.state.status === "off") {
      stop();
      return;
    }
    if (!isHidden()) schedule();
  }

  // Coming back to the window polls at once instead of waiting for a timer.
  const unwatch = watchVisibility(() => {
    if (stopped || inFlight || isHidden()) return;
    clear();
    void tick();
  });

  void tick();
  return stop;
}
