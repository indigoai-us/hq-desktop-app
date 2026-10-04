import { describe, expect, it } from "vitest";

import {
  withCancelledBotRows,
  type CancelledSidebarBot,
  type ConversationRow,
} from "./sidebar-model.js";

function dm(agentUid: string, title: string): ConversationRow {
  return {
    id: `dm:${agentUid}`,
    kind: "dm",
    title,
    companyUid: null,
    unreadDot: false,
    lastActivityAt: 1,
    pinned: false,
    personUid: agentUid,
  };
}

function channel(channelId: string, title: string): ConversationRow {
  return {
    id: `ch:${channelId}`,
    kind: "channel",
    title,
    companyUid: "cmp_acme",
    unreadDot: false,
    lastActivityAt: 1,
    pinned: false,
    channelId,
    channelScope: "company",
  };
}

function bot(patch: Partial<CancelledSidebarBot>): CancelledSidebarBot {
  return {
    agentUid: "agt_nova",
    channelId: "",
    name: "Nova",
    phase: "removing",
    hadRow: false,
    startedAt: 100,
    ...patch,
  };
}

const OTHER = dm("prs_ana", "Ana");

describe("withCancelledBotRows", () => {
  it("leaves the list alone when nothing was cancelled", () => {
    const rows = [OTHER, dm("agt_nova", "Nova")];
    expect(withCancelledBotRows(rows, [])).toEqual(rows);
  });

  it("adds no row for a bot cancelled before it had one, while it is being removed", () => {
    const rows = withCancelledBotRows([OTHER], [bot({ phase: "removing", hadRow: false })]);
    expect(rows.map((row) => row.id)).toEqual(["dm:prs_ana"]);
  });

  it("leaves out a row the directory already lists for a bot cancelled before it had one", () => {
    const rows = withCancelledBotRows(
      [OTHER, dm("agt_nova", "Nova"), channel("chn_nova", "nova")],
      [bot({ phase: "removing", hadRow: false, channelId: "chn_nova" })],
    );
    expect(rows.map((row) => row.id)).toEqual(["dm:prs_ana"]);
  });

  it("keeps the row of a bot that was already starting, marked as being removed", () => {
    const rows = withCancelledBotRows([OTHER], [bot({ phase: "removing", hadRow: true })]);
    expect(rows[0]).toMatchObject({
      id: "dm:agt_nova",
      title: "Nova",
      removingBot: { agentUid: "agt_nova", phase: "removing" },
    });
    expect(rows).toHaveLength(2);
  });

  it("shows a bot that was not removed, whether or not it had a row", () => {
    for (const hadRow of [true, false]) {
      const rows = withCancelledBotRows(
        [OTHER, { ...dm("agt_nova", "Nova"), wakingBot: { agentUid: "agt_nova", progress: 20 } }],
        [bot({ phase: "failed", hadRow })],
      );
      const row = rows.find((candidate) => candidate.id === "dm:agt_nova");
      expect(row?.removingBot).toEqual({ agentUid: "agt_nova", phase: "failed" });
      // It is no longer shown as waking up.
      expect(row?.wakingBot).toBeNull();
    }
  });

  it("removes the bot's rows once the server says it is gone, even if the directory still lists them", () => {
    const rows = withCancelledBotRows(
      [OTHER, dm("agt_nova", "Nova"), channel("chn_nova", "nova")],
      [bot({ phase: "removed", channelId: "chn_nova" })],
    );
    expect(rows.map((row) => row.id)).toEqual(["dm:prs_ana"]);
  });

  it("keeps bots removed in an earlier session off the list", () => {
    const rows = withCancelledBotRows([OTHER, dm("agt_old", "Old")], [], ["agt_old"]);
    expect(rows.map((row) => row.id)).toEqual(["dm:prs_ana"]);
  });

  it("does nothing for a cancel that is still waiting on the create request, or that made no bot", () => {
    const rows = [OTHER];
    expect(withCancelledBotRows(rows, [bot({ agentUid: "", phase: "stopping" })])).toEqual(rows);
    expect(withCancelledBotRows(rows, [bot({ agentUid: "", phase: "not-created" })])).toEqual(rows);
  });
});
