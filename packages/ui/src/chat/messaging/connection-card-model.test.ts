import { describe, expect, it } from "vitest";

import {
  BOT_CONNECTION_CARDS_STORAGE_KEY,
  CONNECTING_TIMEOUT_MS,
  MAX_BOT_CONNECTION_RECORDS,
  SLACK_TIMEOUT_NOTE,
  TOOLS_TIMEOUT_NOTE,
  companyUidFromStatus,
  connectionActionKey,
  connectionCardView,
  loadConnectionRecords,
  markConnecting,
  markDeclined,
  markSlackAnnounced,
  markToolAnnounced,
  pendingAnnouncements,
  recordGrant,
  saveConnectionRecords,
  slackFactsFromStatus,
  toolFacts,
  withBotRecord,
  withoutBotRecord,
  type BotConnectionRecord,
  type BotConnectionRecords,
  type ConnectionCardInput,
} from "./connection-card-model.js";

const NOW = Date.parse("2026-10-02T15:00:00.000Z");
const BOT = "agt_nova";

function memoryStorage(seed: Record<string, string> = {}) {
  const values = new Map(Object.entries(seed));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    values,
  };
}

function connection(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "acct_linear",
    provider: "factory:linear",
    status: "connected",
    createdBy: "prs_me",
    createdAt: "2026-10-02T14:00:00.000Z",
    updatedAt: "2026-10-02T14:00:00.000Z",
    access: { mode: "everyone", grantCount: 0 },
    installation: { displayName: "Linear" },
    ...over,
  };
}

function list(connections: unknown[], viewer: Record<string, unknown> = {}): unknown {
  return {
    companyUid: "cmp_acme",
    viewer: { personUid: "prs_me", role: "owner", canManageGovernance: true, canManageIntegrations: true, ...viewer },
    factoryEnabled: true,
    connections,
    audit: [],
  };
}

function input(over: Partial<ConnectionCardInput> = {}): ConnectionCardInput {
  return { botName: "Nova", now: NOW, ...over };
}

describe("the persisted record", () => {
  it("round trips through storage under its own key", () => {
    const storage = memoryStorage();
    const records: BotConnectionRecords = {
      [BOT]: {
        helloEventId: "e2",
        slack: { state: "connecting", since: NOW, announced: true },
        tools: { state: "declined", since: NOW },
        granted: { acct_linear: { name: "Linear", at: NOW } },
        announced: ["acct_linear"],
      },
    };
    saveConnectionRecords(storage, records);
    expect(storage.values.has(BOT_CONNECTION_CARDS_STORAGE_KEY)).toBe(true);
    expect(loadConnectionRecords(storage)).toEqual(records);
  });

  it("treats missing or malformed storage as empty", () => {
    expect(loadConnectionRecords(null)).toEqual({});
    expect(loadConnectionRecords(memoryStorage())).toEqual({});
    for (const raw of ["", "not json", "[]", "7", "null", '"text"']) {
      expect(loadConnectionRecords(memoryStorage({ [BOT_CONNECTION_CARDS_STORAGE_KEY]: raw }))).toEqual({});
    }
  });

  it("drops malformed entries and fields, and keeps the rest", () => {
    const raw = JSON.stringify({
      [BOT]: {
        helloEventId: 7,
        slack: { state: "connected", since: NOW },
        tools: { state: "connecting", since: "yesterday", baselineIds: ["a"] },
        granted: { acct_1: "yes", acct_2: { name: "", at: "x" } },
        announced: ["a", "a", 3, ""],
      },
      agt_other: "nope",
      prs_person: { helloEventId: "e1" },
      agt_good: { helloEventId: "e9", tools: { state: "connecting", since: 5, baselineIds: ["x", 1, "x"] } },
    });
    expect(loadConnectionRecords(memoryStorage({ [BOT_CONNECTION_CARDS_STORAGE_KEY]: raw }))).toEqual({
      [BOT]: { granted: { acct_2: { name: "acct_2", at: 0 } }, announced: ["a"] },
      agt_good: { helloEventId: "e9", tools: { state: "connecting", since: 5, baselineIds: ["x"] } },
    });
  });

  it("never stores a connected state", () => {
    const raw = JSON.stringify({ [BOT]: { slack: { state: "connected", since: NOW }, tools: { state: "connected", since: NOW } } });
    expect(loadConnectionRecords(memoryStorage({ [BOT_CONNECTION_CARDS_STORAGE_KEY]: raw }))).toEqual({ [BOT]: {} });
  });

  it("never throws from load or save when storage does", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("full");
      },
    };
    expect(loadConnectionRecords(broken)).toEqual({});
    expect(() => saveConnectionRecords(broken, { [BOT]: {} })).not.toThrow();
    expect(() => saveConnectionRecords(null, { [BOT]: {} })).not.toThrow();
  });

  it("keeps the newest bot first and at most fifty bots", () => {
    let records: BotConnectionRecords = {};
    for (let i = 0; i < MAX_BOT_CONNECTION_RECORDS + 5; i += 1) {
      records = withBotRecord(records, `agt_${i}`, { helloEventId: `e${i}` });
    }
    const uids = Object.keys(records);
    expect(uids).toHaveLength(MAX_BOT_CONNECTION_RECORDS);
    expect(uids[0]).toBe(`agt_${MAX_BOT_CONNECTION_RECORDS + 4}`);
    expect(uids).not.toContain("agt_0");
    // Touching an old bot moves it to the front without duplicating it.
    const touched = withBotRecord(records, "agt_10", { helloEventId: "again" });
    expect(Object.keys(touched)[0]).toBe("agt_10");
    expect(Object.keys(touched)).toHaveLength(MAX_BOT_CONNECTION_RECORDS);
    expect(touched.agt_10).toEqual({ helloEventId: "again" });
    expect(withBotRecord(records, " ", {})).toBe(records);
  });

  it("caps what a stored file can load", () => {
    const many: Record<string, unknown> = {};
    for (let i = 0; i < 80; i += 1) many[`agt_${i}`] = { helloEventId: `e${i}` };
    const loaded = loadConnectionRecords(memoryStorage({ [BOT_CONNECTION_CARDS_STORAGE_KEY]: JSON.stringify(many) }));
    expect(Object.keys(loaded)).toHaveLength(MAX_BOT_CONNECTION_RECORDS);
    expect(Object.keys(loaded)[0]).toBe("agt_0");
  });

  it("forgets one bot", () => {
    const records = { [BOT]: {}, agt_other: {} };
    expect(withoutBotRecord(records, BOT)).toEqual({ agt_other: {} });
    expect(withoutBotRecord(records, "agt_missing")).toBe(records);
  });
});

describe("what the person did", () => {
  it("records a Slack connect and keeps that the bot was already told", () => {
    expect(markConnecting(null, "slack", NOW)).toEqual({ slack: { state: "connecting", since: NOW } });
    const told: BotConnectionRecord = { helloEventId: "e2", slack: { state: "declined", since: 1, announced: true } };
    expect(markConnecting(told, "slack", NOW)).toEqual({
      helloEventId: "e2",
      slack: { state: "connecting", since: NOW, announced: true },
    });
  });

  it("records a tools connect with the ids that exist now", () => {
    expect(markConnecting({ helloEventId: "e2" }, "tools", NOW, ["a", "b", "a"])).toEqual({
      helloEventId: "e2",
      tools: { state: "connecting", since: NOW, baselineIds: ["a", "b"] },
    });
    expect(markConnecting(null, "tools", NOW, [])).toEqual({ tools: { state: "connecting", since: NOW, baselineIds: [] } });
  });

  it("keeps the first baseline for Open again, and drops it when the list is unknown", () => {
    const first = markConnecting(null, "tools", NOW, ["a"]);
    expect(markConnecting(first, "tools", NOW + 5, "keep")).toEqual({
      tools: { state: "connecting", since: NOW + 5, baselineIds: ["a"] },
    });
    expect(markConnecting(first, "tools", NOW + 5, null)).toEqual({ tools: { state: "connecting", since: NOW + 5 } });
    expect(markConnecting(first, "tools", NOW + 5, ["a", "b"])).toEqual({
      tools: { state: "connecting", since: NOW + 5, baselineIds: ["a", "b"] },
    });
  });

  it("records Not now with its time, and drops the tools baseline", () => {
    expect(markDeclined(null, "slack", NOW)).toEqual({ slack: { state: "declined", since: NOW } });
    expect(markDeclined(markConnecting(null, "tools", 1, ["a"]), "tools", NOW)).toEqual({
      tools: { state: "declined", since: NOW },
    });
  });

  it("records a grant and what the bot was told, once", () => {
    const granted = recordGrant({ helloEventId: "e2" }, "acct_linear", "Linear", NOW);
    expect(granted).toEqual({ helloEventId: "e2", granted: { acct_linear: { name: "Linear", at: NOW } } });
    const told = markToolAnnounced(granted, "acct_linear");
    expect(told.announced).toEqual(["acct_linear"]);
    expect(markToolAnnounced(told, "acct_linear")).toBe(told);
    const slack = markSlackAnnounced(markConnecting(null, "slack", NOW));
    expect(slack.slack).toEqual({ state: "connecting", since: NOW, announced: true });
    expect(markSlackAnnounced(slack)).toBe(slack);
    // Nothing to mark when the person never pressed Connect.
    expect(markSlackAnnounced({})).toEqual({});
  });
});

describe("slackFactsFromStatus", () => {
  const status = (agent: Record<string, unknown>) => ({ agent, setupState: { phase: "ready" } });

  it("is connected only when the bot can receive messages", () => {
    for (const capability of ["ok", "socket-mode"]) {
      expect(
        slackFactsFromStatus(status({ channelDiagnostics: { slack: { inboundCapability: capability } } })),
      ).toEqual({ state: "connected" });
    }
  });

  it("is pending when Slack is set up but waiting for approval", () => {
    expect(
      slackFactsFromStatus(
        status({ channels: { slack: { appId: "A1" } }, channelDiagnostics: { slack: { inboundCapability: "pending-install" } } }),
        "Nova",
      ),
    ).toEqual({ state: "pending", note: "Waiting for the app to be approved in Slack." });
  });

  it("is pending, never connected, when the app is installed but cannot receive", () => {
    for (const capability of ["outbound-only", "missing-signing-secret", "missing-event-subscription", "legacy-runtime", "unknown", ""]) {
      expect(
        slackFactsFromStatus(
          status({ channels: { slack: { appId: "A1" } }, channelDiagnostics: { slack: { inboundCapability: capability } } }),
          "Nova",
        ),
      ).toEqual({ state: "pending", note: "Slack is set up but Nova cannot receive messages there yet." });
    }
    // No diagnostics at all, but the channel is configured.
    expect(slackFactsFromStatus(status({ channels: { slack: {} } }), "Nova").state).toBe("pending");
    expect(slackFactsFromStatus(status({ channels: { slack: {} } })).note).toBe(
      "Slack is set up but your bot cannot receive messages there yet.",
    );
  });

  it("is none when Slack is not set up or the answer is unreadable", () => {
    expect(slackFactsFromStatus(status({}))).toEqual({ state: "none" });
    expect(slackFactsFromStatus(status({ channels: null }))).toEqual({ state: "none" });
    expect(slackFactsFromStatus(status({ channels: { slack: null } }))).toEqual({ state: "none" });
    expect(
      slackFactsFromStatus(status({ channels: {}, channelDiagnostics: { slack: { inboundCapability: "pending-install" } } })),
    ).toEqual({ state: "none" });
    for (const junk of [null, undefined, "x", 7, [], { agent: "x" }, { agent: { channelDiagnostics: "x", channels: 3 } }]) {
      expect(slackFactsFromStatus(junk)).toEqual({ state: "none" });
    }
  });

  it("reads an answer that is the agent itself", () => {
    expect(slackFactsFromStatus({ channelDiagnostics: { slack: { inboundCapability: "ok" } } })).toEqual({
      state: "connected",
    });
  });

  it("finds the bot's company", () => {
    expect(companyUidFromStatus(status({ companyUid: "cmp_acme" }))).toBe("cmp_acme");
    expect(companyUidFromStatus(status({ companyUid: "acme" }))).toBeNull();
    expect(companyUidFromStatus(null)).toBeNull();
  });
});

describe("toolFacts", () => {
  it("counts a connection open to everyone as usable", () => {
    const facts = toolFacts(
      list([
        connection(),
        connection({ id: "acct_notion", provider: "factory:notion", installation: null, access: { mode: "legacy-open", grantCount: 0 } }),
      ]),
      null,
    );
    expect(facts.usable.map((c) => c.name)).toEqual(["Linear", "Notion"]);
    expect(facts.usable.map((c) => c.provider)).toEqual(["linear", "notion"]);
    expect(facts.waiting).toEqual([]);
    expect(facts.canConnect).toBe(true);
    expect(facts.ids).toEqual(["acct_linear", "acct_notion"]);
  });

  it("puts private and shared connections in waiting, newest first, until allowed from here", () => {
    const json = list([
      connection({ id: "acct_old", createdAt: "2026-09-01T00:00:00.000Z", access: { mode: "private", grantCount: 0 } }),
      connection({ id: "acct_new", createdAt: "2026-10-02T00:00:00.000Z", access: { mode: "shared", grantCount: 2 } }),
      connection({ id: "acct_mid", createdAt: "2026-09-15T00:00:00.000Z", access: { mode: "private", grantCount: 0 } }),
    ]);
    const before = toolFacts(json, { tools: { state: "connecting", since: NOW, baselineIds: ["acct_old", "acct_mid"] } });
    expect(before.usable).toEqual([]);
    expect(before.waiting.map((c) => c.id)).toEqual(["acct_new", "acct_mid", "acct_old"]);
    expect(before.waiting.map((c) => c.isNew)).toEqual([true, false, false]);
    const after = toolFacts(json, recordGrant(null, "acct_new", "Linear", NOW));
    expect(after.usable.map((c) => c.id)).toEqual(["acct_new"]);
    expect(after.usable[0]?.granted).toBe(true);
    expect(after.waiting.map((c) => c.id)).toEqual(["acct_mid", "acct_old"]);
  });

  it("a teammate's connection is never offered", () => {
    const facts = toolFacts(
      list([
        connection({ id: "acct_mine", access: { mode: "private", grantCount: 0 } }),
        connection({ id: "acct_theirs_private", createdBy: "prs_teammate", access: { mode: "private", grantCount: 0 } }),
        connection({ id: "acct_theirs_shared", createdBy: "prs_teammate", access: { mode: "shared", grantCount: 3 } }),
        connection({ id: "acct_theirs_open", createdBy: "prs_teammate" }),
      ]),
      null,
    );
    expect(facts.waiting.map((c) => c.id)).toEqual(["acct_mine"]);
    // What the bot can already use is unchanged, whoever connected it.
    expect(facts.usable.map((c) => c.id)).toEqual(["acct_theirs_open"]);
    // Every connected connection still counts for the baseline.
    expect(facts.ids).toEqual(["acct_mine", "acct_theirs_private", "acct_theirs_shared", "acct_theirs_open"]);
  });

  it("does not offer a connection when the list does not say who is looking or who connected it", () => {
    const mine = connection({ id: "acct_mine", access: { mode: "private", grantCount: 0 } });
    const anon = connection({ id: "acct_anon", createdBy: undefined, access: { mode: "private", grantCount: 0 } });
    const blank = connection({ id: "acct_blank", createdBy: "  ", access: { mode: "shared", grantCount: 0 } });
    expect(toolFacts(list([mine, anon, blank]), null).waiting.map((c) => c.id)).toEqual(["acct_mine"]);
    for (const personUid of [undefined, null, "", 7]) {
      const facts = toolFacts(list([mine, anon, blank], { personUid }), null);
      expect(facts.waiting).toEqual([]);
      expect(facts.ids).toEqual(["acct_mine", "acct_anon", "acct_blank"]);
    }
    expect(toolFacts({ connections: [mine] }, null).waiting).toEqual([]);
  });

  it("keeps a teammate's connection usable once it was allowed from here", () => {
    const json = list([connection({ id: "acct_theirs", createdBy: "prs_teammate", access: { mode: "shared", grantCount: 1 } })]);
    expect(toolFacts(json, null).usable).toEqual([]);
    const facts = toolFacts(json, recordGrant(null, "acct_theirs", "Linear", NOW));
    expect(facts.usable.map((c) => c.id)).toEqual(["acct_theirs"]);
    expect(facts.waiting).toEqual([]);
  });

  it("marks nothing as new without a baseline", () => {
    const facts = toolFacts(list([connection(), connection({ id: "acct_p", access: { mode: "private", grantCount: 0 } })]), {});
    expect([...facts.usable, ...facts.waiting].some((c) => c.isNew)).toBe(false);
  });

  it("leaves out revoked, failing and unknown-mode connections", () => {
    const facts = toolFacts(
      list([
        connection({ id: "acct_revoked", status: "revoked" }),
        connection({ id: "acct_error", status: "error", access: { mode: "private", grantCount: 0 } }),
        connection({ id: "acct_future", access: { mode: "team-only", grantCount: 0 } }),
        connection({ id: "acct_bare", access: undefined }),
        connection({ id: "" }),
        "junk",
        null,
      ]),
      null,
    );
    expect(facts.usable).toEqual([]);
    expect(facts.waiting).toEqual([]);
    // Connected ones still count for the baseline, whatever their mode.
    expect(facts.ids).toEqual(["acct_future", "acct_bare"]);
  });

  it("names a connection by its display name, else by its provider", () => {
    const names = (over: Record<string, unknown>) => toolFacts(list([connection(over)]), null).usable[0]?.name;
    expect(names({ installation: { displayName: " Linear (Acme) " } })).toBe("Linear (Acme)");
    expect(names({ installation: null, provider: "factory:google-drive" })).toBe("Google-drive");
    expect(names({ installation: { displayName: "" }, provider: "hubspot" })).toBe("Hubspot");
    expect(names({ installation: null, provider: "" })).toBe("App");
  });

  it("lets only owners and admins add apps", () => {
    expect(toolFacts(list([], { canManageIntegrations: false }), null).canConnect).toBe(false);
    expect(toolFacts(list([], { canManageIntegrations: "yes" }), null).canConnect).toBe(false);
    expect(toolFacts({ connections: [] }, null).canConnect).toBe(false);
  });

  it("tolerates anything that is not a list answer", () => {
    for (const junk of [null, undefined, "x", 3, [], { connections: "x" }, { viewer: 4, connections: [7] }]) {
      expect(toolFacts(junk, null)).toEqual({ usable: [], waiting: [], canConnect: false, ids: [] });
    }
  });

  it("knows who connected it", () => {
    const facts = toolFacts(
      list([connection(), connection({ id: "acct_theirs", createdBy: "prs_teammate" }), connection({ id: "acct_anon", createdBy: undefined })]),
      null,
    );
    expect(facts.usable.map((c) => c.byViewer)).toEqual([true, false, true]);
  });
});

describe("pendingAnnouncements", () => {
  it("announces Slack once, when it connects after the person pressed Connect", () => {
    const connecting = markConnecting(null, "slack", NOW);
    expect(pendingAnnouncements(connecting, { state: "connected" }, null).slack).toBe(true);
    expect(pendingAnnouncements(connecting, { state: "pending" }, null).slack).toBe(false);
    expect(pendingAnnouncements(connecting, null, null).slack).toBe(false);
    expect(pendingAnnouncements(markSlackAnnounced(connecting), { state: "connected" }, null).slack).toBe(false);
    // Already connected when the DM opened, or declined: nothing to say.
    expect(pendingAnnouncements({}, { state: "connected" }, null).slack).toBe(false);
    expect(pendingAnnouncements(markDeclined(null, "slack", NOW), { state: "connected" }, null).slack).toBe(false);
  });

  it("announces an open connection that is new since the person pressed Connect", () => {
    const record = markConnecting(null, "tools", NOW, ["acct_linear"]);
    const json = list([connection(), connection({ id: "acct_notion", provider: "factory:notion", installation: { displayName: "Notion" } })]);
    expect(pendingAnnouncements(record, null, toolFacts(json, record)).tools.map((c) => c.id)).toEqual(["acct_notion"]);
    const told = markToolAnnounced(record, "acct_notion");
    expect(pendingAnnouncements(told, null, toolFacts(json, told)).tools).toEqual([]);
  });

  it("never announces a connection the bot cannot use", () => {
    const record = markConnecting(null, "tools", NOW, []);
    const json = list([
      connection({ id: "acct_private", access: { mode: "private", grantCount: 0 } }),
      connection({ id: "acct_shared", access: { mode: "shared", grantCount: 1 } }),
      connection({ id: "acct_revoked", status: "revoked" }),
    ]);
    expect(pendingAnnouncements(record, null, toolFacts(json, record)).tools).toEqual([]);
  });

  it("announces a connection the person allowed from here", () => {
    const record = recordGrant(null, "acct_private", "Linear", NOW);
    const json = list([connection({ id: "acct_private", access: { mode: "private", grantCount: 1 } })]);
    expect(pendingAnnouncements(record, null, toolFacts(json, record)).tools.map((c) => c.id)).toEqual(["acct_private"]);
  });

  it("does not announce what was already there, or what a teammate connected", () => {
    const untouched = toolFacts(list([connection()]), {});
    expect(pendingAnnouncements({}, null, untouched).tools).toEqual([]);
    const record = markConnecting(null, "tools", NOW, []);
    const theirs = toolFacts(list([connection({ createdBy: "prs_teammate" })]), record);
    expect(pendingAnnouncements(record, null, theirs).tools).toEqual([]);
    // After "Not now" a later connection is not the answer to the card.
    const declined = markDeclined(record, "tools", NOW);
    expect(pendingAnnouncements(declined, null, toolFacts(list([connection()]), declined)).tools).toEqual([]);
  });
});

describe("connectionCardView: Slack", () => {
  it("offers Slack", () => {
    expect(connectionCardView("slack", input())).toEqual({
      target: "slack",
      state: "offered",
      title: "Slack",
      line: "Talk to Nova in Slack and let it post there.",
      primaryLabel: "Connect Slack",
      primaryPending: false,
      declineLabel: "Not now",
      mark: null,
      note: null,
      usable: [],
      waiting: [],
      moreWaiting: null,
    });
  });

  it("shows connecting after Connect, with the server's reason when there is one", () => {
    const record = markConnecting(null, "slack", NOW - 60_000);
    const view = connectionCardView("slack", input({ record }));
    expect(view.state).toBe("connecting");
    expect(view.line).toBe("Finish in your browser. This card updates when Slack is connected.");
    expect(view.primaryLabel).toBe("Open again");
    expect(view.declineLabel).toBe("Not now");
    expect(view.note).toBeNull();
    const pending = connectionCardView(
      "slack",
      input({ record, slack: { state: "pending", note: "Waiting for the app to be approved in Slack." } }),
    );
    expect(pending.state).toBe("connecting");
    expect(pending.note).toBe("Waiting for the app to be approved in Slack.");
  });

  it("shows connected from the server, whatever was pressed here", () => {
    for (const record of [null, markConnecting(null, "slack", NOW), markDeclined(null, "slack", NOW)]) {
      const view = connectionCardView("slack", input({ record, slack: { state: "connected" } }));
      expect(view.state).toBe("connected");
      expect(view.line).toBe("Nova is in Slack.");
      expect(view.primaryLabel).toBeNull();
      expect(view.declineLabel).toBeNull();
      expect(view.mark).toBe("Connected");
    }
  });

  it("is never connected from the record alone", () => {
    const record = markSlackAnnounced(markConnecting(null, "slack", NOW));
    expect(connectionCardView("slack", input({ record })).state).toBe("connecting");
    expect(connectionCardView("slack", input({ record, slack: { state: "none" } })).state).toBe("connecting");
  });

  it("shows declined with no button after Not now", () => {
    const view = connectionCardView("slack", input({ record: markDeclined(null, "slack", NOW - 1000) }));
    expect(view.state).toBe("declined");
    expect(view.line).toBe("Not connected. Ask Nova about Slack any time.");
    expect(view.primaryLabel).toBeNull();
    expect(view.declineLabel).toBeNull();
  });

  it("offers again only in a message newer than the Not now", () => {
    const record = markDeclined(null, "slack", NOW);
    expect(connectionCardView("slack", input({ record, messageAt: NOW - 1 })).state).toBe("declined");
    expect(connectionCardView("slack", input({ record, messageAt: NOW })).state).toBe("declined");
    expect(connectionCardView("slack", input({ record, messageAt: null })).state).toBe("declined");
    expect(connectionCardView("slack", input({ record, messageAt: Number.NaN })).state).toBe("declined");
    const again = connectionCardView("slack", input({ record, messageAt: NOW + 1 }));
    expect(again.state).toBe("offered");
    expect(again.primaryLabel).toBe("Connect Slack");
  });

  it("goes back to offered with a reason after ten minutes of connecting", () => {
    const record = markConnecting(null, "slack", NOW - CONNECTING_TIMEOUT_MS);
    expect(connectionCardView("slack", input({ record })).state).toBe("connecting");
    const late = connectionCardView("slack", input({ record, now: NOW + 1 }));
    expect(late.state).toBe("offered");
    expect(late.primaryLabel).toBe("Connect Slack");
    expect(late.note).toBe(SLACK_TIMEOUT_NOTE);
    expect(SLACK_TIMEOUT_NOTE).toBe("Slack was not connected. You can try again any time.");
  });

  it("shows the server's reason on an offered card too", () => {
    const view = connectionCardView("slack", input({ slack: { state: "pending", note: "Waiting for the app to be approved in Slack." } }));
    expect(view.state).toBe("offered");
    expect(view.note).toBe("Waiting for the app to be approved in Slack.");
  });

  it("shows the host's sentence first, and marks a press in flight", () => {
    const view = connectionCardView(
      "slack",
      input({
        notes: { slack: "Could not open Slack setup. Try again in a moment." },
        slack: { state: "pending", note: "Waiting for the app to be approved in Slack." },
        inFlight: new Set([connectionActionKey("slack", "connect")]),
      }),
    );
    expect(view.note).toBe("Could not open Slack setup. Try again in a moment.");
    expect(view.primaryPending).toBe(true);
    expect(connectionCardView("slack", input({ inFlight: new Set([connectionActionKey("tools", "connect")]) })).primaryPending).toBe(false);
  });

  it("falls back to a plain name for a bot without one", () => {
    expect(connectionCardView("slack", input({ botName: " " })).line).toBe("Talk to your bot in Slack and let it post there.");
  });
});

describe("connectionCardView: tools", () => {
  const open = (id: string, name: string, over: Record<string, unknown> = {}) =>
    connection({ id, provider: `factory:${name.toLowerCase()}`, installation: { displayName: name }, ...over });
  const closed = (id: string, name: string, createdAt = "2026-10-02T14:00:00.000Z") =>
    open(id, name, { access: { mode: "private", grantCount: 0 }, createdAt });

  it("offers tools without naming any app", () => {
    const view = connectionCardView("tools", input({ tools: toolFacts(list([]), null) }));
    expect(view).toEqual({
      target: "tools",
      state: "offered",
      title: "Connect your tools",
      line: "Add any app through HQ Integrations so Nova can work with it.",
      primaryLabel: "Connect a tool",
      primaryPending: false,
      declineLabel: "Not now",
      mark: null,
      note: null,
      usable: [],
      waiting: [],
      moreWaiting: null,
    });
  });

  it("offers the button while the list has not loaded", () => {
    const view = connectionCardView("tools", input({ tools: null }));
    expect(view.state).toBe("offered");
    expect(view.primaryLabel).toBe("Connect a tool");
  });

  it("sends someone who cannot add apps to an admin, with no button", () => {
    const view = connectionCardView("tools", input({ tools: toolFacts(list([], { canManageIntegrations: false }), null) }));
    expect(view.state).toBe("offered");
    expect(view.line).toBe("Ask a company admin to connect apps in HQ Integrations.");
    expect(view.primaryLabel).toBeNull();
    expect(view.declineLabel).toBeNull();
  });

  it("shows connecting after Connect until a new connection appears", () => {
    const record = markConnecting(null, "tools", NOW - 30_000, ["acct_linear"]);
    const same = connectionCardView("tools", input({ record, tools: toolFacts(list([closed("acct_linear", "Linear")]), record) }));
    expect(same.state).toBe("connecting");
    expect(same.line).toBe("Finish in your browser. This card updates when a tool is connected.");
    expect(same.primaryLabel).toBe("Open again");
    expect(same.declineLabel).toBe("Not now");
    // Rows for what was already there still show while connecting.
    expect(same.waiting.map((row) => row.name)).toEqual(["Linear"]);
    const arrived = connectionCardView(
      "tools",
      input({ record, tools: toolFacts(list([closed("acct_linear", "Linear"), closed("acct_notion", "Notion", "2026-10-02T14:30:00.000Z")]), record) }),
    );
    expect(arrived.state).toBe("offered");
    expect(arrived.note).toBeNull();
    expect(arrived.waiting).toEqual([
      { connectionId: "acct_notion", name: "Notion", label: "Let Nova use it", pending: false, isNew: true },
      { connectionId: "acct_linear", name: "Linear", label: "Let Nova use it", pending: false, isNew: false },
    ]);
  });

  it("shows connected with the names the bot can use, and still offers another", () => {
    const view = connectionCardView("tools", input({ tools: toolFacts(list([open("a", "Linear"), open("b", "Notion")]), null) }));
    expect(view.state).toBe("connected");
    expect(view.line).toBe("Nova can use: Linear, Notion.");
    expect(view.primaryLabel).toBe("Connect another");
    expect(view.declineLabel).toBeNull();
    expect(view.mark).toBe("Connected");
    expect(view.usable).toEqual(["Linear", "Notion"]);
  });

  it("names at most six and counts the rest", () => {
    const names = ["A", "B", "C", "D", "E", "F", "G", "H"];
    const view = connectionCardView("tools", input({ tools: toolFacts(list(names.map((n) => open(`acct_${n}`, n))), null) }));
    expect(view.line).toBe("Nova can use: A, B, C, D, E, F and 2 more.");
    const six = connectionCardView("tools", input({ tools: toolFacts(list(names.slice(0, 6).map((n) => open(`acct_${n}`, n))), null) }));
    expect(six.line).toBe("Nova can use: A, B, C, D, E, F.");
  });

  it("offers no Connect another to someone who cannot add apps", () => {
    const view = connectionCardView(
      "tools",
      input({ tools: toolFacts(list([open("a", "Linear")], { canManageIntegrations: false }), null) }),
    );
    expect(view.state).toBe("connected");
    expect(view.primaryLabel).toBeNull();
  });

  it("shows at most four waiting rows and counts the rest", () => {
    const rows = Array.from({ length: 7 }, (_, i) => closed(`acct_${i}`, `App${i}`, `2026-10-0${i + 1}T00:00:00.000Z`));
    const view = connectionCardView("tools", input({ tools: toolFacts(list(rows), null) }));
    expect(view.waiting.map((row) => row.name)).toEqual(["App6", "App5", "App4", "App3"]);
    expect(view.moreWaiting).toBe("+3 more in HQ Integrations");
    expect(connectionCardView("tools", input({ tools: toolFacts(list(rows.slice(0, 4)), null) })).moreWaiting).toBeNull();
  });

  it("counts only the person's own waiting connections in +N more", () => {
    const mine = Array.from({ length: 6 }, (_, i) => closed(`acct_mine_${i}`, `Mine${i}`, `2026-10-0${i + 1}T00:00:00.000Z`));
    const theirs = Array.from({ length: 77 }, (_, i) => ({
      ...closed(`acct_theirs_${i}`, `Gmail (Teammate ${i})`, "2026-10-09T00:00:00.000Z"),
      createdBy: `prs_teammate_${i}`,
    }));
    const view = connectionCardView("tools", input({ tools: toolFacts(list([...theirs, ...mine]), null) }));
    expect(view.waiting.map((row) => row.name)).toEqual(["Mine5", "Mine4", "Mine3", "Mine2"]);
    expect(view.moreWaiting).toBe("+2 more in HQ Integrations");
    // Four of the person's own and any number of a teammate's: nothing was left out.
    const four = connectionCardView("tools", input({ tools: toolFacts(list([...theirs, ...mine.slice(0, 4)]), null) }));
    expect(four.waiting).toHaveLength(4);
    expect(four.moreWaiting).toBeNull();
    // Only a teammate's connections: no rows and no count.
    const none = connectionCardView("tools", input({ tools: toolFacts(list(theirs), null) }));
    expect(none.waiting).toEqual([]);
    expect(none.moreWaiting).toBeNull();
    expect(none.state).toBe("offered");
  });

  it("moves an allowed connection from waiting to usable", () => {
    const json = list([closed("acct_linear", "Linear")]);
    const record = recordGrant(null, "acct_linear", "Linear", NOW);
    const view = connectionCardView("tools", input({ record, tools: toolFacts(json, record) }));
    expect(view.state).toBe("connected");
    expect(view.line).toBe("Nova can use: Linear.");
    expect(view.waiting).toEqual([]);
  });

  it("disables the row whose allow is on its way", () => {
    const view = connectionCardView(
      "tools",
      input({
        tools: toolFacts(list([closed("acct_linear", "Linear"), closed("acct_notion", "Notion")]), null),
        inFlight: new Set([connectionActionKey("tools", "allow", "acct_notion")]),
      }),
    );
    expect(view.waiting.map((row) => [row.name, row.pending])).toEqual([
      ["Linear", false],
      ["Notion", true],
    ]);
  });

  it("shows declined with no button and no rows after Not now", () => {
    const record = markDeclined(null, "tools", NOW);
    const view = connectionCardView("tools", input({ record, tools: toolFacts(list([closed("acct_linear", "Linear")]), record) }));
    expect(view.state).toBe("declined");
    expect(view.line).toBe("No tools connected. Ask Nova any time.");
    expect(view.primaryLabel).toBeNull();
    expect(view.declineLabel).toBeNull();
    expect(view.waiting).toEqual([]);
    expect(view.moreWaiting).toBeNull();
  });

  it("offers again only in a message newer than the Not now", () => {
    const record = markDeclined(null, "tools", NOW);
    const tools = toolFacts(list([]), record);
    expect(connectionCardView("tools", input({ record, tools, messageAt: NOW - 1 })).state).toBe("declined");
    expect(connectionCardView("tools", input({ record, tools, messageAt: NOW + 1 })).state).toBe("offered");
  });

  it("never says no tools are connected when the bot can use one", () => {
    const record = markDeclined(null, "tools", NOW);
    const view = connectionCardView("tools", input({ record, tools: toolFacts(list([open("a", "Linear")]), record) }));
    expect(view.state).toBe("connected");
    expect(view.line).toBe("Nova can use: Linear.");
  });

  it("goes back to offered with a reason after ten minutes of connecting", () => {
    const record = markConnecting(null, "tools", NOW - CONNECTING_TIMEOUT_MS, []);
    const tools = toolFacts(list([]), record);
    expect(connectionCardView("tools", input({ record, tools })).state).toBe("connecting");
    const late = connectionCardView("tools", input({ record, tools, now: NOW + 1 }));
    expect(late.state).toBe("offered");
    expect(late.primaryLabel).toBe("Connect a tool");
    expect(late.note).toBe(TOOLS_TIMEOUT_NOTE);
    expect(TOOLS_TIMEOUT_NOTE).toBe("No new tool was connected. You can try again any time.");
  });

  it("shows the host's sentence, for example a failed share", () => {
    const view = connectionCardView(
      "tools",
      input({
        tools: toolFacts(list([closed("acct_linear", "Linear")]), null),
        notes: { tools: "Could not share Linear. Try again." },
      }),
    );
    expect(view.note).toBe("Could not share Linear. Try again.");
    expect(view.waiting).toHaveLength(1);
  });

  it("uses no jargon and no long dash in anything a person reads", () => {
    const record = markConnecting(null, "tools", NOW, []);
    const views = [
      connectionCardView("slack", input()),
      connectionCardView("slack", input({ record: markConnecting(null, "slack", NOW) })),
      connectionCardView("slack", input({ slack: { state: "connected" } })),
      connectionCardView("slack", input({ record: markDeclined(null, "slack", NOW) })),
      connectionCardView("tools", input()),
      connectionCardView("tools", input({ record, tools: toolFacts(list([]), record) })),
      connectionCardView("tools", input({ tools: toolFacts(list([open("a", "Linear"), closed("b", "Notion")]), null) })),
      connectionCardView("tools", input({ record: markDeclined(null, "tools", NOW) })),
    ];
    const copy = JSON.stringify(views);
    expect(copy).not.toMatch(/\u2014|OAuth|ACL|grant/i);
  });
});
