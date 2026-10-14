import { describe, expect, it } from "vitest";
import {
  isAtBottom,
  liveTurns,
  mergeSegments,
  notetakerInCall,
  offsetLabel,
  partialLine,
} from "./live-transcript-model";

const seg = (segmentId: string, speaker: string, startSeconds: number, text: string, endSeconds?: number) => ({
  segmentId,
  speaker,
  startSeconds,
  endSeconds: endSeconds ?? startSeconds + 2,
  text,
});

describe("live transcript model", () => {
  it("formats offsets as m:ss and h:mm:ss", () => {
    expect(offsetLabel(0)).toBe("0:00");
    expect(offsetLabel(812.4)).toBe("13:32");
    expect(offsetLabel(3725)).toBe("1:02:05");
    expect(offsetLabel(Number.NaN)).toBe("0:00");
  });

  it("merges deltas in start order without duplicates", () => {
    const first = mergeSegments([], [seg("a", "Corey", 1, "one"), seg("c", "Eric", 9, "three")]);
    const next = mergeSegments(first, [seg("b", "Stefan", 5, "two"), seg("a", "Corey", 1, "one")]);
    expect(next.map((s) => s.segmentId)).toEqual(["a", "b", "c"]);
  });

  it("drops rows without an id or text", () => {
    const next = mergeSegments([], [seg("", "X", 1, "x"), seg("e", "X", 2, "   ")]);
    expect(next).toEqual([]);
  });

  it("groups consecutive segments from one speaker into a turn", () => {
    const turns = liveTurns([
      seg("a", "Corey", 1, "Hello"),
      seg("b", "Corey", 3, "team."),
      seg("c", "Eric", 6, "Hi"),
      seg("d", "Corey", 9, "Next."),
    ]);
    expect(turns.map((t) => [t.speaker, t.at, t.text])).toEqual([
      ["Corey", "0:01", "Hello team."],
      ["Eric", "0:06", "Hi"],
      ["Corey", "0:09", "Next."],
    ]);
    expect(turns[0].initials).toBe("CO");
  });

  it("names an unnamed speaker by participant id", () => {
    const turns = liveTurns([{ segmentId: "a", participantId: "100", startSeconds: 0, text: "hey" }]);
    expect(turns[0].speaker).toBe("Speaker 100");
  });

  it("shows the partial only when it starts after the last final line", () => {
    const segments = [seg("a", "Corey", 10, "Done", 12)];
    expect(partialLine({ speaker: "Eric", startSeconds: 13, text: "So the" }, segments)).toEqual({
      speaker: "Eric",
      at: "0:13",
      text: "So the",
    });
    expect(partialLine({ speaker: "Corey", startSeconds: 11, text: "stale" }, segments)).toBeNull();
    expect(partialLine(null, segments)).toBeNull();
  });

  it("reads in-call bot statuses", () => {
    expect(notetakerInCall("in_call_recording")).toBe(true);
    expect(notetakerInCall("recording")).toBe(true);
    expect(notetakerInCall("joining")).toBe(false);
    expect(notetakerInCall(null)).toBe(false);
  });

  it("treats the last 24px as the bottom", () => {
    expect(isAtBottom({ scrollTop: 780, clientHeight: 200, scrollHeight: 1000 })).toBe(true);
    expect(isAtBottom({ scrollTop: 500, clientHeight: 200, scrollHeight: 1000 })).toBe(false);
  });
});
