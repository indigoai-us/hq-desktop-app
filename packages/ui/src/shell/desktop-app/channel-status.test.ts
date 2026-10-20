import { describe, expect, it, vi } from "vitest";

import {
  buildChannelStatusModel,
  type ChannelStatusModel,
  type LiveReadSessionInput,
  type StatusPresenceInput,
} from "../../chat/channel-status-model.js";
import type { ConversationRow } from "../../chat/sidebar-model.js";
import {
  projectRowHasPresence,
  selectedChannelStatus,
  type ChannelRoster,
  type ChannelStatusSources,
} from "./channel-status.js";

function row(over: Partial<ConversationRow> = {}): ConversationRow {
  return {
    id: "ch:ch_1",
    kind: "channel",
    title: "#teams-agent",
    companyUid: "cmp_1",
    unreadDot: false,
    lastActivityAt: 0,
    channelId: "ch_1",
    ...over,
  } as ConversationRow;
}

type Live = { liveSessions: LiveReadSessionInput[]; presence: StatusPresenceInput[] };
const NO_LIVE: Live = { liveSessions: [], presence: [] };

function sources(over: {
  rosters?: Record<string, ChannelRoster>;
  live?: Live;
  online?: string[];
  hostStatus?: ChannelStatusSources["hostStatus"];
  liveTabsStatus?: ChannelStatusModel | null;
  identities?: Record<string, string> | null;
} = {}): ChannelStatusSources {
  const online = new Set(over.online ?? []);
  return {
    channelRosterById: over.rosters ?? {},
    liveInputsFor: vi.fn(() => over.live ?? NO_LIVE),
    presenceStatus: (_company, uid) => (online.has(uid) ? "online" : "offline"),
    hostStatus: over.hostStatus,
    liveTabsStatus: over.liveTabsStatus,
    companyNames: new Map([["cmp_1", "Indigo"]]),
    companyIcons: new Map([["cmp_1", "https://icon.example/indigo.png"]]),
    identities: over.identities ?? null,
  };
}

function session(actorUid: string): LiveReadSessionInput {
  return { sessionId: `s-${actorUid}`, actorUid, actorType: "agent", status: "running" };
}

describe("projectRowHasPresence", () => {
  it("is false for anything that is not a company project channel", () => {
    const s = sources({ online: ["u1"], rosters: { ch_1: [{ personUid: "u1" }] } });
    expect(projectRowHasPresence(row({ kind: "dm" }), s)).toBe(false);
    expect(projectRowHasPresence(row(), s)).toBe(false); // not a project
    expect(projectRowHasPresence(row({ projectId: "p", companyUid: null }), s)).toBe(false);
  });

  it("uses live-read actors first", () => {
    const s = sources({ live: { liveSessions: [session("bot")], presence: [] }, online: ["bot"] });
    expect(projectRowHasPresence(row({ projectId: "p1" }), s)).toBe(true);
    expect(s.liveInputsFor).toHaveBeenCalledWith("cmp_1", "p1");
    const offline = sources({ live: { liveSessions: [session("bot")], presence: [] }, rosters: { ch_1: [{ personUid: "u1" }] }, online: ["u1"] });
    // Live actors win even when the roster has someone online.
    expect(projectRowHasPresence(row({ projectId: "p1" }), offline)).toBe(false);
  });

  it("falls back to the channel roster, then the row's members", () => {
    expect(
      projectRowHasPresence(row({ channelScope: "project" } as Partial<ConversationRow>), sources({ rosters: { ch_1: [{ personUid: "u1" }] }, online: ["u1"] })),
    ).toBe(true);
    expect(
      projectRowHasPresence(
        row({ projectId: "p", members: [{ personUid: "u2" }] } as Partial<ConversationRow>),
        sources({ online: ["u2"] }),
      ),
    ).toBe(true);
  });

  it("stays dark with no project actors", () => {
    expect(projectRowHasPresence(row({ projectId: "p" }), sources({ online: ["anyone"] }))).toBe(false);
  });
});

describe("selectedChannelStatus", () => {
  it("is null with no row, or with no status source at all", () => {
    expect(selectedChannelStatus(null, sources())).toBeNull();
    expect(selectedChannelStatus(row(), sources())).toBeNull();
  });

  it("prefers the host status and does not read later sources", () => {
    const host = buildChannelStatusModel({ project: { id: "host", title: "Host", description: "from host" }, members: [] });
    const s = sources({ hostStatus: () => host });
    let liveTabsRead = false;
    Object.defineProperty(s, "liveTabsStatus", {
      get() {
        liveTabsRead = true;
        return null;
      },
    });
    const status = selectedChannelStatus(row(), s);
    expect(status?.project.description).toBe("from host");
    expect(liveTabsRead).toBe(false);
  });

  it("builds from the roster with the company's name and icon", () => {
    const status = selectedChannelStatus(
      row(),
      sources({
        rosters: { ch_1: [{ personUid: "u1", displayName: "Ada" }, { personUid: "u2" }] },
        online: ["u1"],
        identities: { u2: "Grace" },
      }),
    );
    expect(status?.companyLabel).toBe("Indigo");
    expect(status?.companyIconUrl).toBe("https://icon.example/indigo.png");
    expect(status?.memberCount).toBe(2);
    const names = [...(status?.members ?? []), ...(status?.agents ?? [])].map((m) => m.displayName);
    expect(names).toEqual(expect.arrayContaining(["Ada", "Grace"]));
  });

  it("rebuilds from live sessions over the base status", () => {
    const base = buildChannelStatusModel({
      project: { id: "p1", title: "Base", description: "About p1" },
      members: [{ personUid: "u1", displayName: "Ada" }],
    });
    const status = selectedChannelStatus(
      row({ projectId: "p1" }),
      sources({
        liveTabsStatus: base,
        live: {
          liveSessions: [session("bot")],
          presence: [{ actorUid: "bot", status: "online", actorType: "agent" }],
        },
        online: ["bot"],
      }),
    );
    expect(status?.project.description).toBe("About p1");
    expect(status?.liveAgents.length ?? 0).toBeGreaterThan(0);
  });
});
