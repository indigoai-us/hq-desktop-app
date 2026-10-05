/**
 * Live transcript poller against a mocked transport: cadence while visible,
 * back-off while hidden, stop when the meeting ends, and 304 handling.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterResult, LiveTranscriptRequest, LiveTranscriptResult } from "@hq/platform";
import {
  LIVE_POLL_VISIBLE_MS,
  LiveTranscriptState,
  startLiveTranscriptPoll,
} from "./live-transcript.svelte";

type Reply = AdapterResult<LiveTranscriptResult>;

const ok = (revision: number, ids: string[], etag = `"e${revision}"`): Reply => ({
  ok: true,
  value: {
    kind: "ok",
    revision,
    etag,
    segments: ids.map((id, i) => ({ segmentId: id, speaker: "Corey", startSeconds: revision * 10 + i, text: `line ${id}` })),
    partial: null,
  },
});
const notModified: Reply = { ok: true, value: { kind: "not-modified" } };

function harness(replies: Reply[], opts: { live?: () => boolean; hidden?: boolean } = {}) {
  const calls: LiveTranscriptRequest[] = [];
  const fetch = vi.fn(async (req: LiveTranscriptRequest): Promise<Reply> => {
    calls.push({ ...req });
    return replies.shift() ?? notModified;
  });
  let hidden = opts.hidden ?? false;
  let onVis: (() => void) | null = null;
  const state = new LiveTranscriptState();
  const stop = startLiveTranscriptPoll({
    recallBotId: "bot_1",
    companyId: "cmp_A",
    state,
    fetch,
    isLive: opts.live ?? (() => true),
    isHidden: () => hidden,
    onVisibilityChange: (cb) => {
      onVis = cb;
      return () => {
        onVis = null;
      };
    },
  });
  return {
    calls,
    fetch,
    state,
    stop,
    setHidden(next: boolean) {
      hidden = next;
      onVis?.();
    },
    get listening() {
      return onVis !== null;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("live transcript poller", () => {
  it("polls at once, then every 3 s while visible", async () => {
    const h = harness([ok(1, ["a"])]);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(LIVE_POLL_VISIBLE_MS - 1);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(LIVE_POLL_VISIBLE_MS * 3);
    expect(h.fetch).toHaveBeenCalledTimes(5);
    h.stop();
  });

  it("sends the cursor and ETag and keeps state on a 304", async () => {
    const h = harness([ok(4, ["a", "b"], '"tag4"'), notModified, ok(6, ["c"], '"tag6"')]);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.calls[0]).toEqual({ recallBotId: "bot_1", companyId: "cmp_A", sinceRevision: null, etag: null });
    await vi.advanceTimersByTimeAsync(LIVE_POLL_VISIBLE_MS);
    expect(h.calls[1]).toMatchObject({ sinceRevision: 4, etag: '"tag4"' });
    expect(h.state.segments.map((s) => s.segmentId)).toEqual(["a", "b"]);
    expect(h.state.status).toBe("live");
    await vi.advanceTimersByTimeAsync(LIVE_POLL_VISIBLE_MS);
    expect(h.calls[2]).toMatchObject({ sinceRevision: 4, etag: '"tag4"' });
    expect(h.state.segments.map((s) => s.segmentId)).toEqual(["a", "b", "c"]);
    expect(h.state.revision).toBe(6);
    expect(h.state.etag).toBe('"tag6"');
    h.stop();
  });

  it("does not poll while hidden and polls at once on return", async () => {
    const h = harness([], { hidden: true });
    await vi.advanceTimersByTimeAsync(LIVE_POLL_VISIBLE_MS * 4);
    expect(h.fetch).not.toHaveBeenCalled();
    h.setHidden(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(LIVE_POLL_VISIBLE_MS);
    expect(h.fetch).toHaveBeenCalledTimes(2);
    h.stop();
  });

  it("stops when the meeting ends and releases the visibility listener", async () => {
    let live = true;
    const h = harness([ok(1, ["a"])], { live: () => live });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    live = false;
    await vi.advanceTimersByTimeAsync(LIVE_POLL_VISIBLE_MS * 5);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.listening).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(h.state.segments).toHaveLength(1);
  });

  it("never polls when the meeting is not live", async () => {
    const h = harness([], { live: () => false });
    await vi.advanceTimersByTimeAsync(LIVE_POLL_VISIBLE_MS * 4);
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("keeps the last good lines on a failed poll and retries", async () => {
    const h = harness([ok(2, ["a"]), { ok: false, reason: "error", code: "http-500", message: "boom" }, ok(3, ["b"])]);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(LIVE_POLL_VISIBLE_MS);
    expect(h.state.failures).toBe(1);
    expect(h.state.segments.map((s) => s.segmentId)).toEqual(["a"]);
    expect(h.state.status).toBe("live");
    await vi.advanceTimersByTimeAsync(LIVE_POLL_VISIBLE_MS);
    expect(h.calls[2]).toMatchObject({ sinceRevision: 2 });
    expect(h.state.failures).toBe(0);
    expect(h.state.segments.map((s) => s.segmentId)).toEqual(["a", "b"]);
    h.stop();
  });

  it("shows listening on not-found and keeps polling", async () => {
    const h = harness([{ ok: true, value: { kind: "not-found" } }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.state.status).toBe("listening");
    await vi.advanceTimersByTimeAsync(LIVE_POLL_VISIBLE_MS);
    expect(h.fetch).toHaveBeenCalledTimes(2);
    h.stop();
  });

  it("stops polling when the server has live transcripts off", async () => {
    const h = harness([{ ok: true, value: { kind: "disabled" } }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.state.status).toBe("off");
    await vi.advanceTimersByTimeAsync(LIVE_POLL_VISIBLE_MS * 4);
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it("replaces retained lines when the server sends a full snapshot", async () => {
    const h = harness([
      ok(4, ["a", "b"]),
      { ok: true, value: { kind: "ok", revision: 2, etag: '"rebuilt"', full: true, segments: [{ segmentId: "c", speaker: "Corey", startSeconds: 1, text: "rebuilt" }], partial: null } },
    ]);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(LIVE_POLL_VISIBLE_MS);
    expect(h.state.segments.map((s) => s.segmentId)).toEqual(["c"]);
    expect(h.state.revision).toBe(2);
    await vi.advanceTimersByTimeAsync(LIVE_POLL_VISIBLE_MS);
    expect(h.calls[2]).toMatchObject({ sinceRevision: 2, etag: '"rebuilt"' });
    h.stop();
  });

  it("does not overlap polls while one is in flight", async () => {
    let release: (r: Reply) => void = () => {};
    const fetch = vi.fn(() => new Promise<Reply>((r) => (release = r)));
    const stop = startLiveTranscriptPoll({
      recallBotId: "bot_1",
      companyId: "cmp_A",
      state: new LiveTranscriptState(),
      fetch,
      isLive: () => true,
      isHidden: () => false,
      onVisibilityChange: () => () => {},
    });
    await vi.advanceTimersByTimeAsync(LIVE_POLL_VISIBLE_MS * 4);
    expect(fetch).toHaveBeenCalledTimes(1);
    release(notModified);
    await vi.advanceTimersByTimeAsync(LIVE_POLL_VISIBLE_MS);
    expect(fetch).toHaveBeenCalledTimes(2);
    stop();
  });
});
