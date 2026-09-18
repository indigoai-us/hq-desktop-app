import { describe, expect, it } from "vitest";
import {
  contactHasConversation,
  isAgentJoinNoticeEvent,
  mergeContactsWithInbox,
  normalizeConversations,
  normalizeDm,
  type DmContactInput,
} from "./sidebar-model";
import {
  filterAgentStubRows,
  isAgentConversationCandidate,
  loadEngagedAgents,
  rememberEngagedAgent,
  saveEngagedAgents,
  shouldShowAgentConversationRow,
  threadHasRealMessage,
} from "./agent-stubs";
import type { Channel } from "./channels";

const AGENT = "agt_noticefixture";
const HUMAN = "usr_cherie";
const JOIN_BODY = "🤖 Noticefixture (an agent) just joined Indigo.";

function dmRow(overrides: Record<string, unknown> = {}) {
  return {
    id: `dm:${AGENT}`,
    kind: "dm" as const,
    title: "Noticefixture",
    companyUid: "indigo",
    unreadDot: false,
    lastActivityAt: 0,
    pinned: false,
    personUid: AGENT,
    ...overrides,
  };
}

describe("agent rail visibility — a bot is not a conversation until it messages you", () => {
  it("hides an agent with no messages", () => {
    expect(shouldShowAgentConversationRow(dmRow())).toBe(false);
  });

  it("hides an agent whose only signal is the join notice's unread badge", () => {
    expect(
      shouldShowAgentConversationRow(
        dmRow({ unreadCount: 1, lastActivityAt: Date.now() }),
      ),
    ).toBe(false);
  });

  it("shows an agent with an inbound message", () => {
    expect(
      shouldShowAgentConversationRow(dmRow(), {
        engagedAgentUids: [AGENT],
      }),
    ).toBe(true);
  });

  it("shows an agent the user messaged (outbound counts)", () => {
    expect(
      shouldShowAgentConversationRow(dmRow(), { recentDmUids: [AGENT] }),
    ).toBe(true);
  });

  it("shows a pinned agent", () => {
    expect(shouldShowAgentConversationRow(dmRow({ pinned: true }))).toBe(true);
  });

  it("leaves a human DM stub to the existing rule", () => {
    const human = dmRow({ id: `dm:${HUMAN}`, personUid: HUMAN });
    expect(isAgentConversationCandidate(human)).toBe(false);
    expect(shouldShowAgentConversationRow(human)).toBe(true);
  });

  it("leaves a channel without an agent member alone", () => {
    const channel = {
      id: "ch:c1",
      kind: "channel" as const,
      title: "#project-x",
      companyUid: "indigo",
      unreadDot: false,
      lastActivityAt: 0,
      pinned: false,
      channelId: "c1",
    };
    expect(shouldShowAgentConversationRow(channel)).toBe(true);
  });

  it("hides a provisioning agent channel with no durable messages", () => {
    const agentChannel = {
      id: "ch:c2",
      kind: "channel" as const,
      title: "Noticefixture",
      companyUid: "indigo",
      unreadDot: false,
      lastActivityAt: 0,
      pinned: false,
      channelId: "c2",
      members: [{ personUid: AGENT, displayName: "Noticefixture" }],
    };
    expect(shouldShowAgentConversationRow(agentChannel)).toBe(false);
    expect(
      shouldShowAgentConversationRow({
        ...agentChannel,
        messageActivityAt: Date.parse("2026-09-18T10:00:00Z"),
      }),
    ).toBe(true);
  });

  it("shows every agent for the typeahead/palette", () => {
    const rows = [dmRow()];
    expect(
      filterAgentStubRows(rows, { includeAgentsWithoutConversation: true }),
    ).toHaveLength(1);
    expect(filterAgentStubRows(rows)).toHaveLength(0);
  });
});

describe("join notices are not conversations", () => {
  it("recognises the server announcement", () => {
    expect(
      isAgentJoinNoticeEvent({ fromPersonUid: AGENT, body: JOIN_BODY }),
    ).toBe(true);
  });

  it("treats an event with no body as a real message", () => {
    expect(
      isAgentJoinNoticeEvent({ fromPersonUid: AGENT, createdAt: "2026-09-18" }),
    ).toBe(false);
  });

  it("does not stamp activity for a join-notice-only agent", () => {
    const merged = mergeContactsWithInbox(
      [],
      [
        {
          fromPersonUid: AGENT,
          fromDisplayName: "Noticefixture",
          body: JOIN_BODY,
          createdAt: "2026-09-18T10:00:00Z",
        },
      ],
    );
    const agent = merged.find((c) => c.personUid === AGENT);
    expect(agent?.lastMessageAt ?? null).toBeNull();
    expect(agent?.agentJoinOnly).toBe(true);
    expect(contactHasConversation(agent as DmContactInput)).toBe(false);
  });

  it("still stamps a real agent message", () => {
    const merged = mergeContactsWithInbox(
      [],
      [
        {
          fromPersonUid: AGENT,
          body: JOIN_BODY,
          createdAt: "2026-09-18T10:00:00Z",
        },
        {
          fromPersonUid: AGENT,
          body: "US-004 is ready for review.",
          createdAt: "2026-09-18T11:00:00Z",
        },
      ],
    );
    const agent = merged.find((c) => c.personUid === AGENT);
    expect(agent?.lastMessageAt).toBe("2026-09-18T11:00:00Z");
    expect(agent?.agentJoinOnly).toBeUndefined();
  });

  it("never counts a join notice as unread on a message-less conversation", () => {
    const row = normalizeDm({
      personUid: AGENT,
      displayName: "Noticefixture",
      unreadCount: 1,
      lastMessageAt: "2026-09-18T10:00:00Z",
      agentJoinOnly: true,
    });
    expect(row.unreadCount).toBeUndefined();
    expect(row.unreadDot).toBe(false);
  });

  it("keeps unread on an agent the user actually talks to", () => {
    const row = normalizeDm(
      { personUid: AGENT, unreadCount: 3, lastMessageAt: "2026-09-18T10:00:00Z" },
      { engagedAgentUids: [AGENT] },
    );
    expect(row.unreadCount).toBe(3);
  });
});

describe("normalizeConversations — 31 stubs and 2 real conversations", () => {
  const stubs: DmContactInput[] = Array.from({ length: 31 }, (_, i) => ({
    personUid: `agt_stub${i}`,
    displayName: `v3e2e-${i}`,
    unreadCount: 1,
    lastMessageAt: "2026-09-18T10:00:00Z",
    agentJoinOnly: true,
  }));
  const real: DmContactInput[] = [
    {
      personUid: HUMAN,
      displayName: "Corey",
      lastMessageAt: "2026-09-18T09:00:00Z",
    },
    {
      personUid: "agt_izzy",
      displayName: "Izzy",
      lastMessageAt: "2026-09-18T08:00:00Z",
    },
  ];

  it("renders only the two real rows", () => {
    const rows = normalizeConversations([], [...stubs, ...real], {
      engagedAgentUids: ["agt_izzy"],
    });
    expect(rows.map((row) => row.title).sort()).toEqual(["Corey", "Izzy"]);
  });

  it("hides the stubs in every company scope, including All", () => {
    const rows = normalizeConversations([], stubs, {});
    expect(rows).toHaveLength(0);
  });

  it("hides agent provisioning channels with no messages", () => {
    const channels: Channel[] = [
      {
        channelId: "c-agent",
        name: "Noticefixture",
        scope: "company",
        companyUid: "indigo",
        createdAt: "2026-09-18T10:00:00Z",
        lastActivityAt: null,
        unread: 1,
        members: [{ personUid: AGENT, displayName: "Noticefixture" }],
      },
      {
        channelId: "c-team",
        name: "team",
        scope: "company",
        companyUid: "indigo",
        createdAt: "2026-09-18T10:00:00Z",
        lastActivityAt: null,
      },
    ];
    const rows = normalizeConversations(channels, [], {});
    expect(rows.map((row) => row.channelId)).toEqual(["c-team"]);
  });

  it("keeps every agent in the directory view", () => {
    const rows = normalizeConversations([], stubs, {
      includeContactsWithoutConversation: true,
    });
    expect(rows).toHaveLength(31);
  });
});

describe("thread evidence", () => {
  const isJoin = (m: { body?: string | null }) => (m.body ?? "") === JOIN_BODY;

  it("is false for a thread holding only the announcement", () => {
    expect(
      threadHasRealMessage(
        [{ fromPersonUid: AGENT, body: JOIN_BODY }],
        AGENT,
        isJoin,
      ),
    ).toBe(false);
  });

  it("is true once the agent says anything else", () => {
    expect(
      threadHasRealMessage(
        [
          { fromPersonUid: AGENT, body: JOIN_BODY },
          { fromPersonUid: AGENT, body: "ready" },
        ],
        AGENT,
        isJoin,
      ),
    ).toBe(true);
  });

  it("is true when the user sent something", () => {
    expect(
      threadHasRealMessage([{ fromPersonUid: HUMAN, body: "hi" }], AGENT, isJoin),
    ).toBe(true);
  });
});

describe("engaged-agent persistence", () => {
  function fakeStorage() {
    const map = new Map<string, string>();
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
    };
  }

  it("round-trips and ignores non-agent uids", () => {
    const storage = fakeStorage();
    const next = rememberEngagedAgent(
      rememberEngagedAgent(new Set<string>(), AGENT),
      HUMAN,
    );
    saveEngagedAgents(next, storage);
    expect([...loadEngagedAgents(storage)]).toEqual([AGENT]);
  });

  it("degrades to empty on malformed storage", () => {
    const storage = fakeStorage();
    storage.setItem("hq.chat.agent-engaged", "{not json");
    expect(loadEngagedAgents(storage).size).toBe(0);
  });
});
