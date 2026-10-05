import { describe, expect, it } from "vitest";

import {
  BOT_CONNECTION_CARDS_STORAGE_KEY,
  CARD_MODAL_TARGETS,
  CONNECTING_TIMEOUT_MS,
  CONNECT_MORE_REQUEST,
  connectMoreAnswerIds,
  isConnectMoreRequest,
  MAX_BOT_CONNECTION_RECORDS,
  MAX_WAITING_ROWS,
  SLACK_ADMIN_LINE,
  SLACK_TIMEOUT_NOTE,
  SLACK_UNFINISHED_LINE,
  cardOpensModal,
  TOOLS_TIMEOUT_NOTE,
  companyUidFromStatus,
  connectionActionKey,
  connectionCardView,
  loadConnectionRecords,
  markConnecting,
  markDeclined,
  messageMayDrawCards,
  markSlackAnnounced,
  markToolAnnounced,
  pendingAnnouncements,
  recordGrant,
  saveConnectionRecords,
  slackFactsFromStatus,
  slackPendingHint,
  toolFacts,
  withBotRecord,
  withoutBotRecord,
  type BotConnectionRecord,
  type BotConnectionRecords,
  type ConnectionCardInput,
  type SlackFacts,
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

  it("is pending, waiting for approval, while the app has not been approved in Slack", () => {
    expect(
      slackFactsFromStatus(
        status({
          channels: { slack: { appId: "A1", workspace: "pending-install", installUrl: "https://slack.com/oauth/v2/authorize?client_id=1" } },
          channelDiagnostics: { slack: { inboundCapability: "pending-install" } },
        }),
      ),
    ).toEqual({ state: "pending", stage: "approve" });
  });

  it("is pending, waiting for the token, once the app is approved and the server asks for one", () => {
    for (const waiting of [
      { appTokenPendingUrl: "https://api.slack.com/apps/A1" },
      { appTokenAccessPending: "HQ is adding you to the app." },
    ]) {
      expect(
        slackFactsFromStatus(
          status({
            channels: { slack: { appId: "A1", workspace: "acme", teamId: "T1", connectionMode: "socket", ...waiting } },
            channelDiagnostics: { slack: { inboundCapability: "socket-mode-degraded" } },
          }),
        ),
      ).toEqual({ state: "pending", stage: "token" });
    }
  });

  it("is pending, never connected, when the app is installed but cannot receive", () => {
    for (const capability of ["outbound-only", "missing-signing-secret", "missing-event-subscription", "legacy-runtime", "socket-mode-degraded", "unknown", ""]) {
      expect(
        slackFactsFromStatus(
          status({ channels: { slack: { appId: "A1" } }, channelDiagnostics: { slack: { inboundCapability: capability } } }),
        ),
      ).toEqual({ state: "pending", stage: "finishing" });
    }
    // No diagnostics at all, but the channel is configured.
    expect(slackFactsFromStatus(status({ channels: { slack: {} } }))).toEqual({ state: "pending", stage: "finishing" });
    // Set up in a form this version cannot read: still pending, nothing for the person to do.
    expect(slackFactsFromStatus(status({ channels: { slack: true } }))).toEqual({ state: "pending", stage: "finishing" });
  });

  it("says what the server waits on at the last step, and only there", () => {
    const stored = { workspace: "acme", teamId: "T0ACME", appId: "A0TEST", connectionMode: "socket" };
    const waitingOnSync = [
      { name: "audit", status: "waiting", lastError: "NEW_BOX_AUDIT_PENDING: box blueprint failed: component-sync" },
      { name: "runtime-install", status: "pending" },
    ];
    const auditStuck = [
      { name: "audit", status: "waiting", lastError: "NEW_BOX_AUDIT_PENDING: box blueprint failed: component-brain" },
      { name: "runtime-install", status: "pending" },
    ];
    const at = (slack: Record<string, unknown>, steps: unknown[]) => ({
      setupState: { phase: "ready", steps },
      agent: { channels: { slack }, channelDiagnostics: { slack: { inboundCapability: "socket-mode-degraded" } } },
    });
    // The bot's file sync is not a wait: no wait field, the ordinary pending state.
    expect(slackFactsFromStatus(at(stored, waitingOnSync))).toEqual({ state: "pending", stage: "finishing" });
    expect(slackFactsFromStatus(at(stored, auditStuck))).toEqual({ state: "pending", stage: "finishing", wait: "audit" });
    // Nothing of the kind in the steps: no wait field at all.
    expect(slackFactsFromStatus(at(stored, []))).toEqual({ state: "pending", stage: "finishing" });
    // Earlier steps never carry it, whatever the steps say.
    expect(slackFactsFromStatus(at({ ...stored, appTokenPendingUrl: "https://api.slack.com/apps/A0TEST" }, waitingOnSync))).toEqual({
      state: "pending",
      stage: "token",
    });
  });

  it("stays connected by the capability alone, whatever the row still says", () => {
    expect(
      slackFactsFromStatus(
        status({
          channels: { slack: { workspace: "pending-install", installUrl: "https://slack.com/oauth/v2/authorize?client_id=1" } },
          channelDiagnostics: { slack: { inboundCapability: "socket-mode" } },
        }),
      ),
    ).toEqual({ state: "connected" });
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
      // The Slack card's main button opens its modal.
      primaryAction: "open",
      primaryPending: false,
      declineLabel: "Not now",
      mark: null,
      note: null,
      usable: [],
      waiting: [],
      moreWaiting: null,
    });
  });

  it("shows the setup as not finished once it was started here", () => {
    const record = markConnecting(null, "slack", NOW - 60_000);
    const view = connectionCardView("slack", input({ record }));
    expect(view.state).toBe("connecting");
    expect(view.line).toBe("Setup is not finished.");
    expect(view.primaryLabel).toBe("Continue");
    expect(view.declineLabel).toBe("Not now");
    expect(view.note).toBeNull();
  });

  it("says what a setup the server has is waiting for, whether or not it was started here", () => {
    const lines: Array<[SlackFacts, string]> = [
      [{ state: "pending", stage: "approve" }, "Setup is not finished. Approve Nova in Slack."],
      [{ state: "pending", stage: "token" }, "Setup is not finished. Paste the token to finish."],
      [{ state: "pending", stage: "finishing" }, "Setup is not finished. Connecting."],
      [{ state: "pending" }, "Setup is not finished. Connecting."],
    ];
    for (const [slack, line] of lines) {
      for (const record of [null, markConnecting(null, "slack", NOW - 60_000)]) {
        const view = connectionCardView("slack", input({ record, slack }));
        expect(view.state).toBe("connecting");
        expect(view.line).toBe(line);
        expect(view.primaryLabel).toBe("Continue");
        expect(view.declineLabel).toBe("Not now");
        expect(view.mark).toBeNull();
        expect(view.note).toBeNull();
      }
    }
    expect(SLACK_UNFINISHED_LINE).toBe("Setup is not finished.");
    expect(slackPendingHint("approve", " ")).toBe("Approve your bot in Slack.");
  });

  it("says at the last step what the server waits on, when the status says", () => {
    const lines: Array<[SlackFacts, string]> = [
      [
        { state: "pending", stage: "finishing", wait: "audit" },
        "Setup is not finished. HQ is finishing the setup on the bot's machine. This can take a few minutes.",
      ],
      [{ state: "pending", stage: "finishing", wait: null }, "Setup is not finished. Connecting."],
    ];
    for (const [slack, line] of lines) {
      const view = connectionCardView("slack", input({ slack }));
      expect(view.state).toBe("connecting");
      expect(view.line).toBe(line);
      expect(view.primaryLabel).toBe("Continue");
      expect(view.note).toBeNull();
    }
    expect(slackPendingHint("finishing", "Nova", "audit")).toBe(
      "HQ is finishing the setup on the bot's machine. This can take a few minutes.",
    );
    // Only the last step reads the wait.
    expect(slackPendingHint("token", "Nova", "audit")).toBe("Paste the token to finish.");
    expect(slackPendingHint("approve", "Nova", "audit")).toBe("Approve Nova in Slack.");
  });

  it("says the ordinary pending line while the install is pending, the audit waits, and the first sync is live", () => {
    const fresh = new Date(NOW - 30_000).toISOString();
    const status = {
      setupState: {
        phase: "ready",
        steps: [
          { name: "channels", status: "done" },
          { name: "audit", status: "waiting", lastError: "NEW_BOX_AUDIT_PENDING: box blueprint failed: component-sync" },
          { name: "runtime-install", status: "pending" },
        ],
      },
      agent: {
        runtime: {
          firstSync: { phase: "pull", filesTotal: 68042, filesDone: 1200, startedAt: new Date(NOW - 60_000).toISOString(), updatedAt: fresh },
          lastHeartbeat: { at: fresh, components: { sync: "degraded", slack: "ok" } },
        },
        channels: { slack: { workspace: "acme", teamId: "T0ACME", appId: "A0TEST", connectionMode: "socket" } },
        channelDiagnostics: { slack: { inboundCapability: "socket-mode-degraded" } },
      },
    };
    const slack = slackFactsFromStatus(status);
    expect(slack).toEqual({ state: "pending", stage: "finishing" });
    const view = connectionCardView("slack", input({ slack }));
    expect(view.state).toBe("connecting");
    expect(view.line).toBe("Setup is not finished. Connecting.");
    expect(view.line).not.toMatch(/sync/i);
  });

  it("never times a setup out while the server has one", () => {
    const longAgo = markConnecting(null, "slack", NOW - CONNECTING_TIMEOUT_MS - 60 * 60_000);
    const view = connectionCardView("slack", input({ record: longAgo, slack: { state: "pending", stage: "token" } }));
    expect(view.state).toBe("connecting");
    expect(view.primaryLabel).toBe("Continue");
    expect(view.note).toBeNull();
  });

  it("keeps Not now over a setup the server has", () => {
    const view = connectionCardView(
      "slack",
      input({ record: markDeclined(null, "slack", NOW - 1000), slack: { state: "pending", stage: "approve" } }),
    );
    expect(view.state).toBe("declined");
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

  it("goes back to offered with a reason after ten minutes, while the server has nothing", () => {
    const record = markConnecting(null, "slack", NOW - CONNECTING_TIMEOUT_MS);
    expect(connectionCardView("slack", input({ record })).state).toBe("connecting");
    for (const slack of [null, { state: "none" } as const]) {
      const late = connectionCardView("slack", input({ record, slack, now: NOW + 1 }));
      expect(late.state).toBe("offered");
      expect(late.primaryLabel).toBe("Connect Slack");
      expect(late.note).toBe(SLACK_TIMEOUT_NOTE);
    }
    expect(SLACK_TIMEOUT_NOTE).toBe("Slack was not connected. You can try again any time.");
  });

  it("shows the host's sentence, and marks a press in flight", () => {
    const view = connectionCardView(
      "slack",
      input({
        notes: { slack: "Could not check Slack right now. You can still connect it." },
        slack: { state: "pending", stage: "approve" },
        inFlight: new Set([connectionActionKey("slack", "open")]),
      }),
    );
    expect(view.note).toBe("Could not check Slack right now. You can still connect it.");
    expect(view.primaryPending).toBe(true);
    expect(connectionCardView("slack", input({ inFlight: new Set([connectionActionKey("tools", "connect")]) })).primaryPending).toBe(false);
  });

  it("falls back to a plain name for a bot without one", () => {
    expect(connectionCardView("slack", input({ botName: " " })).line).toBe("Talk to your bot in Slack and let it post there.");
  });

  it("says who can connect Slack, in place of the button, for a person the server refuses", () => {
    // The status read answered 403: only a company admin may set the bot up.
    // Connect Slack would open a modal that can only end in the same refusal.
    const view = connectionCardView("slack", input({ slackDenied: true }));
    expect(view).toEqual({
      target: "slack",
      state: "offered",
      title: "Slack",
      line: "Ask a company admin to connect Nova to Slack.",
      primaryLabel: null,
      primaryAction: "open",
      primaryPending: false,
      declineLabel: null,
      mark: null,
      note: null,
      usable: [],
      waiting: [],
      moreWaiting: null,
    });
    expect(SLACK_ADMIN_LINE("Nova")).toBe("Ask a company admin to connect Nova to Slack.");
    expect(connectionCardView("slack", input({ slackDenied: true, botName: " " })).line).toBe("Ask a company admin to connect your bot to Slack.");
    // A wait this person started here, and a press in flight, do not bring a button back.
    const started = connectionCardView("slack", input({ slackDenied: true, record: markConnecting(null, "slack", NOW - 60_000), inFlight: new Set([connectionActionKey("slack", "open")]) }));
    expect(started).toMatchObject({ state: "offered", primaryLabel: null, primaryPending: false, declineLabel: null, line: "Ask a company admin to connect Nova to Slack." });
    // The host's sentence still shows.
    expect(connectionCardView("slack", input({ slackDenied: true, notes: { slack: "Could not check Slack right now." } })).note).toBe("Could not check Slack right now.");
  });

  it("keeps what the server and the person already said ahead of the refusal, and offers as before without it", () => {
    expect(connectionCardView("slack", input({ slackDenied: true, slack: { state: "connected" } }))).toMatchObject({ state: "connected", line: "Nova is in Slack." });
    expect(connectionCardView("slack", input({ slackDenied: true, record: markDeclined(null, "slack", NOW) })).state).toBe("declined");
    for (const slackDenied of [false, null, undefined]) {
      expect(connectionCardView("slack", input({ slackDenied }))).toMatchObject({ primaryLabel: "Connect Slack", declineLabel: "Not now" });
    }
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
      primaryAction: "connect",
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

  it("lists every waiting connection up to the cap and counts only the rest", () => {
    const at = (i: number): string => new Date(Date.parse("2026-09-01T00:00:00.000Z") + i * 3_600_000).toISOString();
    const rows = Array.from({ length: MAX_WAITING_ROWS + 3 }, (_, i) => closed(`acct_${i}`, `App${i}`, at(i)));
    // Seventeen, as in the owner's screenshot: all of them, newest first, no count.
    const seventeen = connectionCardView("tools", input({ tools: toolFacts(list(rows.slice(0, 17)), null) }));
    expect(seventeen.waiting.map((row) => row.name)).toEqual(Array.from({ length: 17 }, (_, i) => `App${16 - i}`));
    expect(seventeen.moreWaiting).toBeNull();
    // Exactly the cap: still no count.
    const full = connectionCardView("tools", input({ tools: toolFacts(list(rows.slice(0, MAX_WAITING_ROWS)), null) }));
    expect(full.waiting).toHaveLength(MAX_WAITING_ROWS);
    expect(full.moreWaiting).toBeNull();
    // Beyond the cap: the newest thirty, and a last line for the rest.
    const view = connectionCardView("tools", input({ tools: toolFacts(list(rows), null) }));
    expect(MAX_WAITING_ROWS).toBe(30);
    expect(view.waiting).toHaveLength(MAX_WAITING_ROWS);
    expect(view.waiting[0]?.name).toBe(`App${MAX_WAITING_ROWS + 2}`);
    expect(view.moreWaiting).toBe("+3 more in HQ Integrations");
  });

  it("counts only the person's own waiting connections in +N more", () => {
    const at = (i: number): string => new Date(Date.parse("2026-09-01T00:00:00.000Z") + i * 3_600_000).toISOString();
    const mine = Array.from({ length: MAX_WAITING_ROWS + 2 }, (_, i) => closed(`acct_mine_${i}`, `Mine${i}`, at(i)));
    const theirs = Array.from({ length: 77 }, (_, i) => ({
      ...closed(`acct_theirs_${i}`, `Gmail (Teammate ${i})`, "2026-10-09T00:00:00.000Z"),
      createdBy: `prs_teammate_${i}`,
    }));
    const view = connectionCardView("tools", input({ tools: toolFacts(list([...theirs, ...mine]), null) }));
    expect(view.waiting).toHaveLength(MAX_WAITING_ROWS);
    expect(view.waiting.every((row) => row.name.startsWith("Mine"))).toBe(true);
    expect(view.moreWaiting).toBe("+2 more in HQ Integrations");
    // Six of the person's own and any number of a teammate's: nothing was left out.
    const six = connectionCardView("tools", input({ tools: toolFacts(list([...theirs, ...mine.slice(0, 6)]), null) }));
    expect(six.waiting.map((row) => row.name)).toEqual(["Mine5", "Mine4", "Mine3", "Mine2", "Mine1", "Mine0"]);
    expect(six.moreWaiting).toBeNull();
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

describe("a card whose main button opens a modal", () => {
  const slackOnly = new Set(["slack"] as const);

  const none = new Set<"slack" | "tools">();

  it("marks the Slack card: it opens its modal, the tools card still connects", () => {
    expect([...CARD_MODAL_TARGETS]).toEqual(["slack"]);
    expect(cardOpensModal("slack")).toBe(true);
    expect(cardOpensModal("tools")).toBe(false);
    const states: ConnectionCardInput[] = [
      input(),
      input({ record: markConnecting(null, "slack", NOW) }),
      input({ record: markConnecting(null, "tools", NOW, []) }),
      input({ slack: { state: "pending", stage: "token" } }),
      input({ slack: { state: "connected" } }),
    ];
    for (const state of states) {
      expect(connectionCardView("slack", state).primaryAction).toBe("open");
      expect(connectionCardView("tools", state).primaryAction).toBe("connect");
    }
  });

  it("reads the switch from the set it is given", () => {
    expect(cardOpensModal("slack", slackOnly)).toBe(true);
    expect(cardOpensModal("tools", slackOnly)).toBe(false);
    expect(cardOpensModal("slack", none)).toBe(false);
    // Nothing given means the model's own set.
    expect(cardOpensModal("slack", null)).toBe(true);
    expect(cardOpensModal("slack", undefined)).toBe(true);
    expect(cardOpensModal("tools", null)).toBe(false);
  });

  it("makes the main button of a marked card open its modal, and only that card", () => {
    const marked = input({ modalTargets: slackOnly });
    expect(connectionCardView("slack", marked).primaryAction).toBe("open");
    expect(connectionCardView("tools", marked).primaryAction).toBe("connect");
    const waiting = input({ modalTargets: slackOnly, record: markConnecting(null, "slack", NOW) });
    expect(connectionCardView("slack", waiting).primaryAction).toBe("open");
  });

  it("changes nothing else on the card", () => {
    for (const state of [input(), input({ record: markConnecting(null, "slack", NOW) })]) {
      const { primaryAction: _plain, ...plain } = connectionCardView("slack", { ...state, modalTargets: none });
      const { primaryAction: _marked, ...marked } = connectionCardView("slack", { ...state, modalTargets: slackOnly });
      expect(marked).toEqual(plain);
    }
  });

  it("names the press on its own, so an open and a connect never share a key", () => {
    expect(connectionActionKey("slack", "open")).toBe("slack:open");
    const opening = new Set([connectionActionKey("slack", "open")]);
    expect(connectionCardView("slack", input({ modalTargets: slackOnly, inFlight: opening })).primaryPending).toBe(true);
    // The same press does not hold a card that connects.
    expect(connectionCardView("slack", input({ modalTargets: none, inFlight: opening })).primaryPending).toBe(false);
  });
});

describe("messageMayDrawCards: only the bot of this direct message", () => {
  const from = (uid: string | null | undefined) => ({ fromPersonUid: uid });

  it("draws cards for the bot's message when the host names the bot", () => {
    const who = { botUid: "agt_nova", selfUid: "prs_me" };
    expect(messageMayDrawCards(from("agt_nova"), who)).toBe(true);
    expect(messageMayDrawCards(from(" agt_nova "), who)).toBe(true);
    // The person's own, and anyone else's.
    expect(messageMayDrawCards(from("prs_me"), who)).toBe(false);
    expect(messageMayDrawCards(from("prs_teammate"), who)).toBe(false);
    expect(messageMayDrawCards(from("agt_other"), who)).toBe(false);
  });

  it("never draws cards for the person's own message, whatever the host says the bot is", () => {
    expect(messageMayDrawCards(from("prs_me"), { botUid: "prs_me", selfUid: "prs_me" })).toBe(false);
    expect(messageMayDrawCards(from("prs_me"), { selfUid: "prs_me" })).toBe(false);
    expect(messageMayDrawCards(from("prs_me"), { botUid: null, selfUid: " prs_me " })).toBe(false);
  });

  it("without the bot's uid, draws for a sender who is known not to be the person", () => {
    expect(messageMayDrawCards(from("agt_nova"), { selfUid: "prs_me" })).toBe(true);
    expect(messageMayDrawCards(from("agt_nova"), { botUid: "  ", selfUid: "prs_me" })).toBe(true);
  });

  it("draws none when nobody can say who sent it", () => {
    expect(messageMayDrawCards(from("agt_nova"), {})).toBe(false);
    expect(messageMayDrawCards(from("agt_nova"), { botUid: null, selfUid: null })).toBe(false);
    for (const unknown of [null, undefined, "", "   "]) {
      expect(messageMayDrawCards(from(unknown), { botUid: "agt_nova", selfUid: "prs_me" })).toBe(false);
      expect(messageMayDrawCards(from(unknown), { selfUid: "prs_me" })).toBe(false);
    }
    expect(messageMayDrawCards({}, { botUid: "agt_nova" })).toBe(false);
  });
});

describe("asking for the cards again", () => {
  it("recognises the request whatever its case, spaces or full stop", () => {
    expect(CONNECT_MORE_REQUEST).toBe("Connect more tools");
    for (const text of ["Connect more tools", "connect more tools", "CONNECT MORE TOOLS", "  Connect more tools  ", "Connect more tools.", "connect more tools . ", "\nConnect more tools\n"]) {
      expect(isConnectMoreRequest(text)).toBe(true);
    }
  });

  it("does not take a longer sentence that only contains the phrase", () => {
    for (const text of [
      "Please connect more tools",
      "Connect more tools for the sales team",
      "Connect more tools?",
      "Connect more tools..",
      "Connect more",
      "Connect  more tools",
      "",
      null,
      undefined,
    ]) {
      expect(isConnectMoreRequest(text)).toBe(false);
    }
  });

  type Msg = { eventId: string; fromPersonUid: string; body: string; connect?: boolean };
  const bot = (eventId: string, body: string, connect = false): Msg => ({ eventId, fromPersonUid: BOT, body, connect });
  const me = (eventId: string, body: string): Msg => ({ eventId, fromPersonUid: "prs_me", body });
  const is = { visible: (m: Msg) => m.body.trim() !== "", ownCards: (m: Msg) => m.connect === true };

  it("attaches the cards to the bot's first answer after each request", () => {
    const timeline = [
      bot("b1", "Hello"),
      me("p1", "What do you know?"),
      bot("b2", "A few things."),
      me("p2", "connect more tools."),
      bot("b3", " "),
      bot("b4", "Here you go."),
      bot("b5", "Anything else?"),
      me("p3", "Connect more tools"),
      me("p4", "and thanks"),
      bot("b6", "Of course."),
    ];
    expect(connectMoreAnswerIds(timeline, BOT, is)).toEqual(["b4", "b6"]);
  });

  it("attaches nothing before the bot answers, to an answer with its own cards, or for a longer sentence", () => {
    expect(connectMoreAnswerIds([bot("b1", "Hello"), me("p1", "Connect more tools")], BOT, is)).toEqual([]);
    expect(connectMoreAnswerIds([me("p1", "Connect more tools"), bot("b1", "Here.", true), bot("b2", "And more.")], BOT, is)).toEqual([]);
    expect(connectMoreAnswerIds([me("p1", "Can you connect more tools for me"), bot("b1", "Sure.")], BOT, is)).toEqual([]);
    // The bot saying the phrase is not the person asking.
    expect(connectMoreAnswerIds([bot("b1", "Connect more tools"), bot("b2", "Hm.")], BOT, is)).toEqual([]);
    expect(connectMoreAnswerIds([me("p1", "Connect more tools"), bot("b1", "Sure.")], "", is)).toEqual([]);
  });
});
