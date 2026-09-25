/**
 * A local bot that is mid-turn keeps its thinking indicator.
 *
 * The indicator used to end on the first message from the bot, so a progress
 * note in the middle of a long turn made the DM look finished while the bot
 * was still working. `busy` comes from the CLI's in-flight marker.
 */
import { describe, expect, it } from "vitest";
import type { LocalBotRow } from "@hq/platform";
import { busyLocalBotUids } from "./local-bots.js";

function bot(over: Partial<LocalBotRow>): LocalBotRow {
  return {
    name: "setup",
    agentUid: "agent-1",
    ownerUid: "owner-1",
    runtime: "claude",
    state: "running",
    pid: 42,
    processAlive: true,
    online: true,
    lastHeartbeatAt: null,
    daemonInstalled: true,
    daemonLoaded: true,
    dir: "/tmp/setup",
    ...over,
  } as LocalBotRow;
}

describe("busyLocalBotUids", () => {
  it("lists the bots that are answering right now", () => {
    expect(
      busyLocalBotUids([
        bot({ agentUid: "a", busy: true }),
        bot({ agentUid: "b", busy: false }),
        bot({ agentUid: "c", busy: true }),
      ]),
    ).toEqual(["a", "c"]);
  });

  it("treats an older CLI with no busy field as not busy", () => {
    expect(busyLocalBotUids([bot({ agentUid: "a" })])).toEqual([]);
  });

  it("is empty for no rows", () => {
    expect(busyLocalBotUids(null)).toEqual([]);
    expect(busyLocalBotUids([])).toEqual([]);
  });
});
