import { describe, expect, it } from "vitest";
import {
  isLiveMeshChannelId,
  isSafeCacheSegment,
  parseBoardWake,
  parseChannelMessageWake,
  wakeRefreshesProjectView,
} from "./wakes.js";

describe("work-mesh ids-only wakes", () => {
  it("parses a project-view doorbell", () => {
    const wake = parseBoardWake({
      v: 1,
      kind: "board",
      companyUid: "cmp_01KQ2RYAHXHDPCTY9GPQPTH3DG",
      projectId: "work-mesh-testing",
      mutation: "project-view",
    });
    expect(wake?.projectId).toBe("work-mesh-testing");
    expect(wakeRefreshesProjectView(wake!)).toBe(true);
  });

  it("ignores thread wakes and directory doorbells", () => {
    expect(
      parseBoardWake({
        contractVersion: 2,
        eventType: "work.changed",
        scope: "work",
      }),
    ).toBeNull();
    expect(
      parseChannelMessageWake({
        eventType: "channel.directory.changed",
        resourceId: "chn_abc",
      }),
    ).toBeNull();
  });

  it("reads chn_* from a channel message wake", () => {
    expect(
      parseChannelMessageWake({
        type: "channel",
        channelId: "chn_01M042QAH55HG4B5M4CXNZ5YSY",
        eventId: "0074152a",
      }),
    ).toBe("chn_01M042QAH55HG4B5M4CXNZ5YSY");
  });

  it("rejects path-escape cache segments", () => {
    expect(isSafeCacheSegment("../etc")).toBe(false);
    expect(isSafeCacheSegment("work-mesh-testing")).toBe(true);
    expect(isLiveMeshChannelId("chn_01M03653ACNS94XM3M84ZBA05E")).toBe(true);
    expect(isLiveMeshChannelId("agent-orchestrator")).toBe(false);
  });
});
