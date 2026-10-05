import { describe, expect, it } from "vitest";

import {
  APP_TIMEOUT_NOTE,
  MAX_BRIEF_CHARS,
  MAX_FALLBACK_APPS,
  PRESS_CLOCK_SKEW_MS,
  CONNECTIONS_RETRY_BASE_MS,
  CONNECTIONS_RETRY_MAX_MS,
  ROW_SETTLE_MS,
  appChosenItems,
  slackFirst,
  appLogo,
  botCanUse,
  botReason,
  catalogMatchFor,
  companyAppsBrief,
  connectActionFor,
  connectFailureSentence,
  connectRowReady,
  connectionsRetryMs,
  connectionAnswersPress,
  connectionForDomain,
  connectionForItem,
  defaultAppName,
  domainsToLookUp,
  integrationCardView,
  isSlackConnection,
  keyRejectedSentence,
  readCompanyConnections,
  readKeyBlueprint,
  rowAwaitsList,
  recentCallsFor,
  type CatalogLookup,
  type CompanyConnections,
  type IntegrationCardInput,
} from "./integration-cards-model.js";
import {
  CONNECTING_TIMEOUT_MS,
  connectionActionKey,
  markAppConnecting,
  markAppDeclined,
  recordGrant,
  toolFacts,
} from "./connection-card-model.js";
import { brandMarkFor } from "./app-brand-marks.js";
import { parseRichContent, type ConnectItem } from "./richMessageContent.js";

const NOW = Date.parse("2026-10-02T15:00:00.000Z");

const connection = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "acct_linear",
  provider: "factory:linear",
  status: "connected",
  createdBy: "prs_me",
  createdAt: "2026-10-02T14:10:00.000Z",
  access: { mode: "private", grantCount: 0 },
  installation: { displayName: "Linear", domain: "linear.app" },
  ...over,
});

const envelope = (connections: unknown[] = [], over: Record<string, unknown> = {}): Record<string, unknown> => ({
  companyUid: "cmp_acme",
  viewer: { personUid: "prs_me", role: "owner", canManageGovernance: true, canManageIntegrations: true },
  connections,
  audit: [],
  ...over,
});

const facts = (connections: unknown[] = [], over: Record<string, unknown> = {}): CompanyConnections =>
  readCompanyConnections(envelope(connections, over))!;

const LINEAR: CatalogLookup = { domain: "linear.app", name: "Linear", authClass: "oauth" };
const KEYED: CatalogLookup = { domain: "example.com", name: "Example", authClass: "key", entryId: "cat_ex" };

function input(over: Partial<IntegrationCardInput> = {}): IntegrationCardInput {
  return { botName: "Nova", now: NOW, lookup: "unknown", ...over };
}

describe("readCompanyConnections", () => {
  it("reads the viewer, the connected connections and their domains, and nothing else", () => {
    const read = readCompanyConnections(
      envelope([
        connection(),
        connection({ id: "acct_old", status: "revoked" }),
        connection({ id: "acct_dup" }),
        connection({ id: "acct_linear" }),
        "junk",
        connection({ id: "acct_gmail", provider: "gmail", installation: { displayName: "Gmail (Stefan)", domain: "MCP.Gmail.com" }, access: { mode: "everyone" } }),
      ]),
    )!;
    expect(read.viewerUid).toBe("prs_me");
    expect(read.canManage).toBe(true);
    expect(read.connections.map((c) => [c.id, c.provider, c.name, c.domain, c.mode])).toEqual([
      ["acct_linear", "linear", "Linear", "linear.app", "private"],
      ["acct_dup", "linear", "Linear", "linear.app", "private"],
      ["acct_gmail", "gmail", "Gmail (Stefan)", "gmail.com", "everyone"],
    ]);
  });

  it("names a connection by its provider when it has no display name, and keeps no domain it cannot read", () => {
    const read = readCompanyConnections(envelope([connection({ installation: {} })]))!;
    expect(read.connections[0]).toMatchObject({ name: "Linear", domain: null });
  });

  it("counts the recent audit rows per provider and per connection", () => {
    const read = readCompanyConnections(
      envelope([connection()], {
        audit: [
          { provider: "factory:linear", connectionId: "acct_linear", toolName: "t" },
          { provider: "factory:linear", toolName: "t" },
          { provider: "gmail", connectionId: "acct_gmail" },
          "junk",
        ],
      }),
    )!;
    expect(read.recentCallsByProvider).toEqual({ linear: 2, gmail: 1 });
    expect(read.recentCallsByConnection).toEqual({ acct_linear: 1, acct_gmail: 1 });
    expect(recentCallsFor(read, read.connections[0]!)).toBe(1);
  });

  it("is null for anything that is not the envelope, and knows a member cannot manage", () => {
    expect(readCompanyConnections(null)).toBeNull();
    expect(readCompanyConnections("x")).toBeNull();
    const member = readCompanyConnections(envelope([], { viewer: { personUid: "prs_m", role: "member" } }))!;
    expect(member.canManage).toBe(false);
    expect(member.viewerUid).toBe("prs_m");
  });

  it("reads the summary view (view=summary) the same as the full view", () => {
    // The summary view leaves out write policy, Slack destinations, creator
    // names and audit actor names. The cards and the hello never read them.
    const rows = [
      connection(),
      connection({ id: "acct_gmail", provider: "gmail", createdBy: "prs_other", installation: { displayName: "Gmail", domain: "gmail.com" }, access: { mode: "everyone", grantCount: 0 } }),
      connection({ id: "acct_shared", provider: "notion", installation: { displayName: "Notion", domain: "notion.so" }, access: { mode: "shared", grantCount: 2 } }),
    ];
    const audit = [
      { provider: "factory:linear", connectionId: "acct_linear", toolName: "t" },
      { provider: "gmail", connectionId: "acct_gmail", toolName: "t" },
    ];
    const full = envelope(
      rows.map((row) => ({
        ...row,
        writePolicy: "ask",
        writePolicyUpdatedAt: "2026-10-02T14:11:00.000Z",
        writeAllowlist: ["create_issue"],
        slackDestinations: [],
        createdByName: "Stefan",
        createdByEmail: "stefan@example.com",
      })),
      { audit: audit.map((row) => ({ ...row, memberOrAgentName: "Stefan", memberOrAgentEmail: "stefan@example.com" })) },
    );
    const summary = envelope(rows, { view: "summary", audit });
    expect(readCompanyConnections(summary)).toEqual(readCompanyConnections(full));
    expect(toolFacts(summary, null)).toEqual(toolFacts(full, null));
    const read = readCompanyConnections(summary)!;
    expect(read.connections.map((c) => [c.id, c.mode, c.createdBy])).toEqual([
      ["acct_linear", "private", "prs_me"],
      ["acct_gmail", "everyone", "prs_other"],
      ["acct_shared", "shared", "prs_me"],
    ]);
    expect(read.recentCallsByConnection).toEqual({ acct_linear: 1, acct_gmail: 1 });
    expect(toolFacts(summary, null).waiting.map((c) => c.id)).toEqual(["acct_linear", "acct_shared"]);
  });
});

describe("connectionForDomain and botCanUse", () => {
  it("matches by the listed domain, exactly first, then parent or subdomain, newest first", () => {
    const f = facts([
      connection({ id: "acct_a", createdAt: "2026-10-01T00:00:00.000Z" }),
      connection({ id: "acct_a2", createdAt: "2026-10-03T00:00:00.000Z" }),
      connection({ id: "acct_sub", createdAt: "2026-10-04T00:00:00.000Z", installation: { displayName: "Linear API", domain: "api.linear.app" } }),
      connection({ id: "acct_notion", provider: "factory:notion", installation: { displayName: "Notion", domain: "makenotion.com" } }),
    ]);
    // Two list linear.app exactly: the newer of them wins, ahead of the newer subdomain.
    expect(connectionForDomain(f, "www.linear.app")?.id).toBe("acct_a2");
    expect(connectionForDomain(f, "mcp.linear.app")?.id).toBe("acct_a2");
    expect(connectionForDomain(f, "api.linear.app")?.id).toBe("acct_sub");
    // A subdomain nobody lists exactly falls to the connections of its site, newest first.
    expect(connectionForDomain(f, "docs.linear.app")?.id).toBe("acct_a2");
    expect(connectionForDomain(f, "makenotion.com")?.id).toBe("acct_notion");
    expect(connectionForDomain(f, "asana.com")).toBeNull();
    expect(connectionForDomain(null, "linear.app")).toBeNull();
    expect(connectionForDomain(f, "nope")).toBeNull();
  });

  it("never matches a connection by its provider name: the first label of a domain proves nothing", () => {
    const f = facts([
      connection({ id: "acct_linear", installation: { displayName: "Linear", domain: "linear.app" } }),
      connection({ id: "acct_bare", provider: "factory:gmail", installation: { displayName: "Gmail (Stefan)" } }),
      connection({ id: "acct_notion", provider: "factory:notion", installation: { displayName: "Notion", domain: "makenotion.com" } }),
    ]);
    // A domain that only starts with the provider's name is some other site.
    for (const domain of ["linear.com", "linear.example.org", "linear.app.example.org", "notion.so", "notion.example.org", "gmail.com", "gmail.example.org"]) {
      expect(connectionForDomain(f, domain), domain).toBeNull();
    }
    // Nor does a longer name that merely ends with the listed one.
    expect(connectionForDomain(f, "notlinear.app")).toBeNull();
    // So a bot naming a lookalike gets no "connected" card for the company's real connection.
    expect(integrationCardView({ domain: "linear.example.org" }, input({ facts: f, lookup: "not-found" }))).toBeNull();
    expect(integrationCardView({ domain: "gmail.com" }, input({ facts: f, lookup: "not-found" }))).toBeNull();
  });

  it("finds a connection the list gives no domain for by its id, which only the app's own pick carries", () => {
    const f = facts([connection({ id: "acct_bare", provider: "factory:gmail", installation: { displayName: "Gmail (Stefan)" } }), connection()]);
    expect(connectionForItem(f, { domain: "gmail.com", connectionId: "acct_bare" })?.id).toBe("acct_bare");
    expect(connectionForItem(f, { domain: "gmail.com" })).toBeNull();
    // An id the list no longer has falls back to the domain.
    expect(connectionForItem(f, { domain: "linear.app", connectionId: "acct_gone" })?.id).toBe("acct_linear");
    expect(connectionForItem(f, { domain: "gmail.com", connectionId: "acct_gone" })).toBeNull();
    expect(connectionForItem(null, { domain: "linear.app", connectionId: "acct_linear" })).toBeNull();
    const view = integrationCardView({ domain: "gmail.com", connectionId: "acct_bare" }, input({ facts: f, lookup: "unknown" }))!;
    expect(view).toMatchObject({ state: "connected", title: "Gmail (Stefan)", connectionId: "acct_bare", primaryLabel: "Let Nova use it", domain: "gmail.com" });
    // A bot's block cannot carry the id: the parser reads app, domain and why only.
    const fromBot = parseRichContent({ v: 1, blocks: [{ kind: "connect", items: [{ domain: "gmail.com", connectionId: "acct_bare" }] }] });
    expect(fromBot?.blocks[0]).toEqual({ kind: "connect", items: [{ domain: "gmail.com" }] });
  });

  it("gives the bot a connection with no second press only when it answers a fresh press exactly", () => {
    const since = NOW - 60_000;
    const entry = { state: "connecting" as const, since };
    const made = (over: Record<string, unknown> = {}) =>
      facts([connection({ createdAt: new Date(since + 30_000).toISOString(), ...over })]).connections[0]!;
    expect(connectionAnswersPress(entry, made(), "linear.app", NOW)).toBe(true);
    expect(connectionAnswersPress(entry, made(), "www.linear.app", NOW)).toBe(true);
    // A stale press: the entry sat in storage past the wait.
    expect(connectionAnswersPress({ state: "connecting", since: NOW - CONNECTING_TIMEOUT_MS - 1 }, made({ createdAt: new Date(NOW - 1_000).toISOString() }), "linear.app", NOW)).toBe(false);
    expect(connectionAnswersPress({ state: "connecting", since: NOW - CONNECTING_TIMEOUT_MS }, made({ createdAt: new Date(NOW - 1_000).toISOString() }), "linear.app", NOW)).toBe(true);
    // A connection that was already there when the button was pressed.
    expect(connectionAnswersPress(entry, made({ createdAt: new Date(since).toISOString() }), "linear.app", NOW)).toBe(false);
    expect(connectionAnswersPress(entry, made({ createdAt: new Date(since - 86_400_000).toISOString() }), "linear.app", NOW)).toBe(false);
    expect(connectionAnswersPress(entry, made({ createdAt: "" }), "linear.app", NOW)).toBe(false);
    expect(connectionAnswersPress(entry, made({ createdAt: "not a date" }), "linear.app", NOW)).toBe(false);
    // A domain that is not exactly the card's: a subdomain, a lookalike, none listed.
    expect(connectionAnswersPress(entry, made({ installation: { displayName: "Linear", domain: "api.linear.app" } }), "linear.app", NOW)).toBe(false);
    expect(connectionAnswersPress(entry, made(), "api.linear.app", NOW)).toBe(false);
    expect(connectionAnswersPress(entry, made(), "linear.com", NOW)).toBe(false);
    expect(connectionAnswersPress(entry, made({ installation: { displayName: "Linear" } }), "linear.app", NOW)).toBe(false);
    // A press dated in the future is no press: a record whose time is ahead of
    // this device's clock (edited storage, a clock set back) would otherwise
    // never go stale, and any connection made before that time would be shut
    // out while one made after it is handed over.
    const ahead = (ms: number) => ({ state: "connecting" as const, since: NOW + ms });
    const after = (ms: number) => made({ createdAt: new Date(NOW + ms + 1_000).toISOString() });
    expect(connectionAnswersPress(ahead(60_000), after(60_000), "linear.app", NOW)).toBe(false);
    expect(connectionAnswersPress(ahead(86_400_000), after(86_400_000), "linear.app", NOW)).toBe(false);
    expect(connectionAnswersPress(ahead(PRESS_CLOCK_SKEW_MS + 1), after(PRESS_CLOCK_SKEW_MS + 1), "linear.app", NOW)).toBe(false);
    expect(connectionAnswersPress({ state: "connecting", since: Number.POSITIVE_INFINITY }, made(), "linear.app", NOW)).toBe(false);
    // The host's clock for the cards moves on its checks, so a press can be a
    // few seconds newer than the "now" it passes. That much is allowed.
    expect(PRESS_CLOCK_SKEW_MS).toBe(5_000);
    expect(connectionAnswersPress(ahead(PRESS_CLOCK_SKEW_MS), after(PRESS_CLOCK_SKEW_MS), "linear.app", NOW)).toBe(true);
    expect(connectionAnswersPress(ahead(2_000), after(2_000), "linear.app", NOW)).toBe(true);
    expect(connectionAnswersPress(ahead(0), after(0), "linear.app", NOW)).toBe(true);
    // No press, a "Not now", no connection.
    expect(connectionAnswersPress(null, made(), "linear.app", NOW)).toBe(false);
    expect(connectionAnswersPress({ state: "declined", since }, made(), "linear.app", NOW)).toBe(false);
    expect(connectionAnswersPress(entry, null, "linear.app", NOW)).toBe(false);
  });

  it("the bot can use an app open to everyone, or one granted from here", () => {
    const f = facts([connection(), connection({ id: "acct_open", access: { mode: "everyone" } })]);
    const [mine, open] = f.connections;
    expect(botCanUse(open!, null)).toBe(true);
    expect(botCanUse(mine!, null)).toBe(false);
    expect(botCanUse(mine!, recordGrant(null, "acct_linear", "Linear", NOW))).toBe(true);
  });
});

describe("catalogMatchFor", () => {
  const CATALOG = {
    ok: true,
    entries: [
      { name: "Linear", domain: "linear.app", authClass: "oauth", mcpReady: true },
      { name: "Example", domain: "WWW.example.com", authClass: "key", entryId: "cat_ex" },
      { name: "Mystery", domain: "mystery.io" },
      "junk",
    ],
  };

  it("finds the entry whose domain is the item's, with its auth class and entry id", () => {
    expect(catalogMatchFor(CATALOG, "linear.app")).toEqual({ domain: "linear.app", name: "Linear", authClass: "oauth" });
    expect(catalogMatchFor(CATALOG, "example.com")).toEqual({ domain: "example.com", name: "Example", authClass: "key", entryId: "cat_ex" });
  });

  it("is not-found for another domain, an entry with no auth class, or a bad answer", () => {
    expect(catalogMatchFor(CATALOG, "asana.com")).toBe("not-found");
    expect(catalogMatchFor(CATALOG, "mystery.io")).toBe("not-found");
    expect(catalogMatchFor(null, "linear.app")).toBe("not-found");
    expect(catalogMatchFor({ entries: "x" }, "linear.app")).toBe("not-found");
  });

  it("falls back to the domain's first label as a name", () => {
    expect(catalogMatchFor({ entries: [{ domain: "asana.com", authClass: "none" }] }, "asana.com")).toEqual({
      domain: "asana.com",
      name: "Asana",
      authClass: "none",
    });
    expect(defaultAppName("quickbooks.intuit.com")).toBe("Quickbooks");
  });
});

describe("the logo", () => {
  it("is the bundled mark when the app has one, else nothing; never a badge from the name", () => {
    expect(appLogo("linear.app")).toEqual({ mark: brandMarkFor("linear.app") });
    expect(appLogo("linear.app").mark?.title).toBe("Linear");
    expect(appLogo("mcp.linear.app").mark?.title).toBe("Linear");
    // An app with no bundled mark: the generic glyph.
    expect(appLogo("example.com")).toEqual({ mark: null });
    expect(appLogo("nope")).toEqual({ mark: null });
    expect(Object.keys(appLogo("github.com"))).not.toContain("monogram");
  });

  it("never builds an image address from the domain", () => {
    // The app's image policy allows one remote origin, the marketplace assets
    // host. A favicon service address built from a domain the bot named would
    // make the webview call a third party with no click.
    for (const domain of ["linear.app", "example.com", "deepwiki.com", "evil.example.org"]) {
      const logo = appLogo(domain);
      expect(Object.keys(logo)).toEqual(["mark"]);
      expect(JSON.stringify(logo)).not.toMatch(/https?:/);
    }
    const view = integrationCardView({ domain: "example.com" }, input({ facts: facts(), lookup: KEYED }))!;
    expect(JSON.stringify(view)).not.toMatch(/https?:/);
  });
});

describe("integrationCardView", () => {
  it("draws no card for a domain that is neither connected nor in the catalog, or not looked up yet", () => {
    expect(integrationCardView({ domain: "asana.com" }, input({ facts: facts(), lookup: "unknown" }))).toBeNull();
    expect(integrationCardView({ domain: "asana.com" }, input({ facts: facts(), lookup: "not-found" }))).toBeNull();
    expect(integrationCardView({ domain: "not a domain" }, input({ lookup: LINEAR }))).toBeNull();
  });

  it("offers a connectable app with its name, logo, auth class and the bot's reason", () => {
    const view = integrationCardView({ domain: "linear.app", why: "Your issues live here" }, input({ facts: facts(), lookup: LINEAR }))!;
    expect(view).toMatchObject({
      target: "integration",
      kind: "integration",
      domain: "linear.app",
      title: "Linear",
      state: "offered",
      // The app's own sentence, which says the bot gets access. The bot's reason is a second line, named as the bot's.
      line: "Connect Linear so Nova can use it.",
      reason: "Nova says: Your issues live here",
      primaryLabel: "Connect Linear",
      primaryAction: "connect",
      primaryPending: false,
      declineLabel: "Not now",
      mark: null,
      note: null,
      authClass: "oauth",
      connectionId: null,
      logo: { mark: { title: "Linear" } },
    });
    expect(view.logo).toEqual({ mark: brandMarkFor("linear.app") });
  });

  it("never lets the bot's reason stand in for the sentence that says the bot gets access", () => {
    const pushy = "Just a quick read-only sign in";
    const view = integrationCardView({ domain: "linear.app", why: pushy }, input({ facts: facts(), lookup: LINEAR }))!;
    expect(view.line).toBe("Connect Linear so Nova can use it.");
    expect(view.line).not.toContain(pushy);
    expect(view.reason).toBe(`Nova says: ${pushy}`);
    expect(botReason("  Nova ", " x ")).toBe("Nova says: x");
    expect(botReason("", "x")).toBe("your bot says: x");
    // No reason, or a blank one: no second line.
    expect(integrationCardView({ domain: "linear.app" }, input({ facts: facts(), lookup: LINEAR }))!.reason).toBeNull();
    expect(integrationCardView({ domain: "linear.app", why: "   " }, input({ facts: facts(), lookup: LINEAR }))!.reason).toBeNull();
  });

  it("shows the reason only while the app is offered, and gives its place to a note", () => {
    const item = { domain: "linear.app", why: "Your issues live here" };
    // A failure or a timeout note takes the second line: the card is one fixed height.
    expect(integrationCardView(item, input({ facts: facts(), lookup: LINEAR, note: "Could not start the connection. Try again." }))).toMatchObject({
      line: "Connect Linear so Nova can use it.",
      reason: null,
      note: "Could not start the connection. Try again.",
    });
    const timedOut = integrationCardView(item, input({ facts: facts(), lookup: LINEAR, record: markAppConnecting(null, "linear.app", NOW - CONNECTING_TIMEOUT_MS - 1) }))!;
    expect(timedOut).toMatchObject({ state: "offered", reason: null, note: APP_TIMEOUT_NOTE("Linear") });
    // Every other state says its own sentence and nothing of the bot's.
    const connecting = integrationCardView(item, input({ facts: facts(), lookup: LINEAR, record: markAppConnecting(null, "linear.app", NOW) }))!;
    const declined = integrationCardView(item, input({ facts: facts(), lookup: LINEAR, record: markAppDeclined(null, "linear.app", NOW) }))!;
    const connected = integrationCardView(item, input({ facts: facts([connection()]), lookup: "unknown" }))!;
    const noAdmin = integrationCardView(item, input({ facts: facts([], { viewer: { personUid: "prs_me", canManageIntegrations: false } }), lookup: LINEAR }))!;
    for (const view of [connecting, declined, connected, noAdmin]) {
      expect(view.reason ?? null, view.state).toBeNull();
      expect(view.line).not.toContain("Your issues live here");
    }
  });

  it("writes its own line when the bot gives no reason, and opens the modal for a key app", () => {
    const view = integrationCardView({ domain: "example.com" }, input({ facts: facts(), lookup: KEYED }))!;
    expect(view.line).toBe("Connect Example so Nova can use it.");
    expect(view.primaryAction).toBe("open");
    expect(view.primaryLabel).toBe("Connect Example");
    expect(connectActionFor("none")).toBe("connect");
    expect(connectActionFor("oauth")).toBe("connect");
    expect(connectActionFor("key")).toBe("open");
  });

  it("shows a connected app the bot can use, with no button", () => {
    const open = facts([connection({ access: { mode: "everyone" } })]);
    const view = integrationCardView({ domain: "linear.app" }, input({ facts: open }))!;
    expect(view).toMatchObject({ state: "connected", line: "Nova can use it.", primaryLabel: null, declineLabel: null, mark: "Connected", connectionId: "acct_linear" });
    const granted = integrationCardView(
      { domain: "linear.app" },
      input({ facts: facts([connection()]), record: recordGrant(null, "acct_linear", "Linear", NOW) }),
    )!;
    expect(granted.line).toBe("Nova can use it.");
    expect(granted.primaryLabel).toBeNull();
  });

  it("offers to let the bot use the person's own connection, with the connection on the press", () => {
    const view = integrationCardView({ domain: "linear.app" }, input({ facts: facts([connection()]) }))!;
    expect(view).toMatchObject({
      state: "connected",
      line: "Let Nova use it?",
      primaryLabel: "Let Nova use it",
      primaryAction: "allow",
      connectionId: "acct_linear",
      declineLabel: null,
      mark: "Connected",
    });
    const pending = new Set([connectionActionKey("integration", "allow", "acct_linear", "linear.app")]);
    expect(integrationCardView({ domain: "linear.app" }, input({ facts: facts([connection()]), inFlight: pending }))!.primaryPending).toBe(true);
  });

  it("names a teammate's connection as theirs to share, with no button", () => {
    const theirs = facts([connection({ createdBy: "prs_teammate" })]);
    const view = integrationCardView({ domain: "linear.app" }, input({ facts: theirs }))!;
    expect(view.line).toBe("A teammate connected this. Ask them to share it with Nova.");
    expect(view.primaryLabel).toBeNull();
    expect(view.state).toBe("connected");
    // A list that does not say who is looking is not this person's to share either.
    const anon = facts([connection()], { viewer: { canManageIntegrations: true } });
    expect(integrationCardView({ domain: "linear.app" }, input({ facts: anon }))!.primaryLabel).toBeNull();
  });

  it("draws no integration card for Slack's domain, whatever the company has connected", () => {
    // Slack in a bot's conversation is the bot's own Slack card. A teammate's
    // Slack integration connection must never be read as the bot's state.
    const f = facts([connection({ id: "acct_slack", provider: "factory:slack", createdBy: "prs_teammate", installation: { displayName: "Slack", domain: "slack.com" } })]);
    const slackMatch = { domain: "slack.com", name: "Slack", authClass: "oauth" as const };
    for (const domain of ["slack.com", "www.slack.com", "https://slack.com/", "acme.slack.com"]) {
      expect(integrationCardView({ domain }, input({ facts: f })), domain).toBeNull();
      expect(integrationCardView({ domain, connectionId: "acct_slack" }, input({ facts: f })), domain).toBeNull();
      expect(integrationCardView({ domain }, input({ facts: f, lookup: slackMatch })), domain).toBeNull();
    }
  });

  it("never repeats the Connected mark in the line under it, in any connected state", () => {
    // Owner, 2026-10-04: a green "Connected" mark with a line that also began
    // "Connected" read as the same word twice, and the one-row clamp then cut
    // the instruction off.
    const usable = integrationCardView({ domain: "linear.app" }, input({ facts: facts([connection({ access: { mode: "everyone" } })]) }))!;
    const own = integrationCardView({ domain: "linear.app" }, input({ facts: facts([connection()]) }))!;
    const theirs = integrationCardView({ domain: "linear.app" }, input({ facts: facts([connection({ createdBy: "prs_teammate" })]) }))!;
    for (const view of [usable, own, theirs]) {
      expect(view.mark).toBe("Connected");
      expect(view.line).not.toMatch(/^connected\b/i);
      expect(view.line.toLowerCase().startsWith(view.mark!.toLowerCase())).toBe(false);
    }
    expect([usable.line, own.line, theirs.line]).toEqual([
      "Nova can use it.",
      "Let Nova use it?",
      "A teammate connected this. Ask them to share it with Nova.",
    ]);
  });

  it("a connection wins over the catalog, a decline and a wait", () => {
    const record = markAppConnecting(markAppDeclined(null, "linear.app", NOW - 1), "linear.app", NOW);
    const view = integrationCardView({ domain: "linear.app" }, input({ facts: facts([connection()]), lookup: LINEAR, record }))!;
    expect(view.state).toBe("connected");
    expect(view.title).toBe("Linear");
  });

  it("tells a member to ask an admin, with no button", () => {
    const member = facts([], { viewer: { personUid: "prs_m", role: "member", canManageIntegrations: false } });
    const view = integrationCardView({ domain: "linear.app" }, input({ facts: member, lookup: LINEAR }))!;
    expect(view).toMatchObject({ state: "offered", line: "Ask a company admin to connect Linear.", primaryLabel: null, declineLabel: null });
  });

  it("shows connecting after Connect was pressed, then times out back to offered with a note", () => {
    const record = markAppConnecting(null, "linear.app", NOW);
    const waiting = integrationCardView({ domain: "linear.app" }, input({ facts: facts(), lookup: LINEAR, record, now: NOW + 60_000 }))!;
    expect(waiting).toMatchObject({
      state: "connecting",
      line: "Finish in your browser. This card updates when Linear is connected.",
      primaryLabel: "Open again",
      primaryAction: "connect",
      declineLabel: "Not now",
      note: null,
    });
    const late = integrationCardView({ domain: "linear.app" }, input({ facts: facts(), lookup: LINEAR, record, now: NOW + CONNECTING_TIMEOUT_MS + 1 }))!;
    expect(late.state).toBe("offered");
    expect(late.primaryLabel).toBe("Connect Linear");
    expect(late.note).toBe(APP_TIMEOUT_NOTE("Linear"));
    expect(late.note).toBe("Linear was not connected. You can try again any time.");
    // A host note takes the place of the timeout note.
    expect(integrationCardView({ domain: "linear.app" }, input({ facts: facts(), lookup: LINEAR, record, now: NOW + CONNECTING_TIMEOUT_MS + 1, note: "Nope." }))!.note).toBe("Nope.");
  });

  it("dims a declined card, and offers it again in a message newer than the Not now", () => {
    const record = markAppDeclined(null, "linear.app", NOW);
    const declined = integrationCardView({ domain: "linear.app" }, input({ facts: facts(), lookup: LINEAR, record }))!;
    expect(declined).toMatchObject({ state: "declined", line: "Not connected. Ask Nova any time.", primaryLabel: null, declineLabel: null, note: null });
    const again = integrationCardView({ domain: "linear.app" }, input({ facts: facts(), lookup: LINEAR, record, messageAt: NOW + 1 }))!;
    expect(again.state).toBe("offered");
  });

  it("shows the host's in-flight connect as a disabled button", () => {
    const inFlight = new Set([connectionActionKey("integration", "connect", null, "linear.app")]);
    expect(integrationCardView({ domain: "linear.app" }, input({ facts: facts(), lookup: LINEAR, inFlight }))!.primaryPending).toBe(true);
    // Another app's press is not this card's.
    const other = new Set([connectionActionKey("integration", "connect", null, "notion.so")]);
    expect(integrationCardView({ domain: "linear.app" }, input({ facts: facts(), lookup: LINEAR, inFlight: other }))!.primaryPending).toBe(false);
  });

  it("offers the button while the list is unknown but the catalog matched", () => {
    const view = integrationCardView({ domain: "linear.app" }, input({ facts: null, lookup: LINEAR }))!;
    expect(view.primaryLabel).toBe("Connect Linear");
  });
});

describe("a row draws as one unit when the host passes its catalog answers", () => {
  // Owner, 2026-10-05: "it showed immediately but the other cards took a while to show up".
  const f = () => facts([connection()]);
  const items = [{ app: "slack" as const }, { domain: "linear.app" }, { domain: "notion.so" }];

  it("waits while an app that is not a connection has no catalog answer yet", () => {
    const lookupFor = (domain: string) => (domain === "notion.so" ? ("unknown" as const) : ("not-found" as const));
    expect(rowAwaitsList(items, f(), lookupFor)).toBe(true);
    expect(connectRowReady(items, { facts: f(), since: NOW, now: NOW, lookupFor })).toBe(false);
  });

  it("is ready once every app is a connection or answered, a match or not found", () => {
    expect(rowAwaitsList(items, f(), () => "not-found")).toBe(false);
    expect(rowAwaitsList(items, f(), () => LINEAR)).toBe(false);
    // The connected Linear needs no answer of its own.
    expect(rowAwaitsList([{ domain: "linear.app" }], f(), () => "unknown")).toBe(false);
  });

  it("stops waiting after the settle time, and draws what is known", () => {
    const lookupFor = () => "unknown" as const;
    expect(connectRowReady(items, { facts: f(), since: NOW, now: NOW + ROW_SETTLE_MS - 1, lookupFor })).toBe(false);
    expect(connectRowReady(items, { facts: f(), since: NOW, now: NOW + ROW_SETTLE_MS, lookupFor })).toBe(true);
  });
});

describe("the row waits for the company's list, never for one app's lookup", () => {
  it("is ready as soon as the list is known, whatever is still being looked up", () => {
    const f = facts([connection()]);
    // Slack, a connection, and an app that still needs a catalog lookup: the
    // row draws, and the app being looked up has no card yet.
    const items = [{ app: "slack" as const }, { domain: "linear.app" }, { domain: "notion.so" }];
    expect(connectRowReady(items, { facts: f, since: NOW, now: NOW })).toBe(true);
    expect(integrationCardView({ domain: "linear.app" }, input({ facts: f }))).not.toBeNull();
    expect(integrationCardView({ domain: "notion.so" }, input({ facts: f, lookup: "unknown" }))).toBeNull();
    // Every app still being looked up: the row is ready all the same, and empty until one answers.
    expect(connectRowReady([{ domain: "notion.so" }, { domain: "asana.com" }], { facts: facts(), since: NOW, now: NOW })).toBe(true);
  });

  it("holds a row that names an app while the list itself is unknown, and no other row", () => {
    // Only built-in cards: ready at once, even with no list.
    expect(connectRowReady([{ app: "slack" }], { facts: null, since: NOW, now: NOW })).toBe(true);
    // No list yet: nothing can be said about an app, so its row waits.
    expect(connectRowReady([{ domain: "linear.app" }], { facts: null, since: NOW, now: NOW })).toBe(false);
    expect(connectRowReady([{ app: "slack" }, { domain: "linear.app" }], { facts: undefined, since: NOW, now: NOW })).toBe(false);
    // A domain that is not one is decided (it draws nothing).
    expect(connectRowReady([{ domain: "nope" }], { facts: null, since: NOW, now: NOW })).toBe(true);
  });

  it("says which rows have to wait for the list: one that names an app, while the list is unknown", () => {
    expect(rowAwaitsList([{ app: "slack" }, { domain: "linear.app" }], null)).toBe(true);
    expect(rowAwaitsList([{ domain: "https://www.notion.so/" }], undefined)).toBe(true);
    expect(rowAwaitsList([{ app: "slack" }, { app: "tools" }], null)).toBe(false);
    expect(rowAwaitsList([{ domain: "nope" }], null)).toBe(false);
    expect(rowAwaitsList([], null)).toBe(false);
    // The list is known: no row waits, whatever it names.
    expect(rowAwaitsList([{ app: "slack" }, { domain: "linear.app" }, { domain: "notion.so" }], facts())).toBe(false);
  });

  it("gives up waiting for the list after the settle time", () => {
    const items = [{ app: "slack" as const }, { domain: "notion.so" }];
    expect(connectRowReady(items, { facts: null, since: NOW, now: NOW + ROW_SETTLE_MS - 1 })).toBe(false);
    expect(connectRowReady(items, { facts: null, since: NOW, now: NOW + ROW_SETTLE_MS })).toBe(true);
  });

  it("tries a failed list read again after 2 s, then twice as long each time, never more than a minute", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 50].map(connectionsRetryMs)).toEqual([2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000]);
    expect(connectionsRetryMs(1)).toBe(CONNECTIONS_RETRY_BASE_MS);
    expect(connectionsRetryMs(1_000)).toBe(CONNECTIONS_RETRY_MAX_MS);
    // A count that is not one is the first try.
    expect(connectionsRetryMs(0)).toBe(2_000);
    expect(connectionsRetryMs(Number.NaN)).toBe(2_000);
  });

  it("names the domains that need a lookup: not built-ins, not connections, each once", () => {
    const f = facts([connection()]);
    const items = [{ app: "slack" as const }, { domain: "linear.app" }, { domain: "notion.so" }, { domain: "www.notion.so" }, { domain: "bad" }];
    expect(domainsToLookUp(items, f)).toEqual(["notion.so"]);
    expect(domainsToLookUp(items, null)).toEqual([]);
  });
});

describe("connect failures in one sentence", () => {
  it("names each case the brief lists", () => {
    expect(connectFailureSentence({ status: 402, code: "PLAN_LIMIT_REACHED" }, "Linear")).toEqual({
      sentence: "Your plan's integration limit is reached.",
      withLink: false,
      retry: false,
    });
    expect(connectFailureSentence({ status: 409, code: "INTEGRATION_FACTORY_INSTALL_IN_PROGRESS" }, "Linear").sentence).toBe(
      "A connection for Linear is already in progress. Give it a minute.",
    );
    for (const code of ["OAUTH_DISCOVERY_FAILED", "CLIENT_REGISTRATION_REFUSED", "OAUTH_REGISTRATION_FAILED", "OAUTH_REGISTRATION_UNSUPPORTED"]) {
      expect(connectFailureSentence({ status: 502, code }, "Linear")).toEqual({
        sentence: "Linear could not be connected from here. Try it from HQ Integrations.",
        withLink: true,
        retry: false,
      });
    }
    expect(connectFailureSentence({ status: 403, code: "INTEGRATION_FACTORY_FORBIDDEN" }, "Linear").sentence).toBe(
      "Only a company owner or admin can connect apps.",
    );
    expect(connectFailureSentence({ status: 500, code: "http-500" }, "Linear")).toEqual({
      sentence: "Could not start the connection. Try again.",
      withLink: false,
      retry: true,
    });
    expect(connectFailureSentence(null, "Linear").sentence).toBe("Could not start the connection. Try again.");
    // A 409 with another code is not "in progress".
    expect(connectFailureSentence({ status: 409, code: "OTHER" }, "Linear").sentence).toBe("Could not start the connection. Try again.");
  });

  it("says a rejected key in one sentence, and never repeats the key", () => {
    expect(keyRejectedSentence({ status: 401, code: "http-401" }, "Example")).toBe("Example did not accept that key. Check it and try again.");
    expect(keyRejectedSentence({ status: 400, code: "DIRECT_MCP_TOKEN_REJECTED" }, "Example")).toBe("Example did not accept that key. Check it and try again.");
    expect(keyRejectedSentence({ status: 402 }, "Example")).toBe("Your plan's integration limit is reached.");
    expect(keyRejectedSentence({ status: 500 }, "Example")).toBe("Could not start the connection. Try again.");
  });
});

describe("readKeyBlueprint", () => {
  const BLUEPRINT = {
    ok: true,
    companyUid: "cmp_acme",
    blueprint: {
      provider: "example",
      displayName: "Example",
      domain: "example.com",
      credentials: [
        { id: "other", type: "api_key", label: "Other key", generateUrl: "https://example.com/other" },
        { id: "api_key", type: "api_key", label: "API key", generateUrl: "https://example.com/settings/api" },
      ],
      surfaces: [
        { kind: "http", slug: "rest", name: "REST", url: "https://api.example.com", authStatus: "required", credentialIds: ["api_key"] },
        { kind: "mcp", slug: "mcp", name: "MCP", url: "https://mcp.example.com/mcp", authStatus: "required", credentialIds: ["api_key"] },
      ],
      recommendedSurface: { kind: "http", slug: "rest", name: "REST", url: "https://api.example.com", authStatus: "required", credentialIds: ["api_key"] },
      warnings: [],
    },
  };

  it("takes the MCP surface's URL and the credential that surface names, with its label and link", () => {
    expect(readKeyBlueprint(BLUEPRINT)).toEqual({
      mcpUrl: "https://mcp.example.com/mcp",
      provider: "example",
      displayName: "Example",
      label: "API key",
      generateUrl: "https://example.com/settings/api",
    });
  });

  it("prefers the recommended surface when it is MCP, and falls back to the first credential and the label Key", () => {
    const recommended = {
      blueprint: {
        ...BLUEPRINT.blueprint,
        recommendedSurface: { kind: "mcp", slug: "m2", name: "MCP 2", url: "https://mcp2.example.com/mcp", authStatus: "required", credentialIds: [] },
        credentials: [{ id: "k", type: "api_key" }],
      },
    };
    expect(readKeyBlueprint(recommended)).toMatchObject({ mcpUrl: "https://mcp2.example.com/mcp", label: "Key", generateUrl: null });
  });

  it("has no MCP URL when the blueprint has no MCP surface, and drops a link that is not https", () => {
    const none = {
      blueprint: {
        ...BLUEPRINT.blueprint,
        surfaces: [BLUEPRINT.blueprint.surfaces[0]],
        recommendedSurface: undefined,
        credentials: [{ id: "api_key", label: "API key", generateUrl: "javascript:alert(1)" }],
      },
    };
    expect(readKeyBlueprint(none)).toEqual({ mcpUrl: null, provider: "example", displayName: "Example", label: "API key", generateUrl: null });
    expect(readKeyBlueprint(null)).toEqual({ mcpUrl: null, provider: null, displayName: null, label: "Key", generateUrl: null });
  });
});

describe("appChosenItems: the cards the app picks when the bot does not", () => {
  const own = (id: string, name: string, domain: string | undefined, createdAt: string, over: Record<string, unknown> = {}) =>
    connection({ id, provider: `factory:${name.toLowerCase()}`, createdAt, installation: { displayName: name, ...(domain ? { domain } : {}) }, ...over });

  // Rewritten (2026-10-05): it used to leave Slack out once the bot was in
  // Slack. Owner: "make sure that Slack is the first card every time". The
  // card stays, first, and shows the bot as in Slack.
  it("is Slack alone with no list, whether or not the bot is in Slack", () => {
    expect(appChosenItems(null, null)).toEqual([{ app: "slack" }]);
    expect(appChosenItems(facts(), null)).toEqual([{ app: "slack" }]);
  });

  it("adds the person's own apps the bot cannot use yet, newest first, three cards in all with Slack counting as one", () => {
    const f = facts([
      own("a1", "Linear", "linear.app", "2026-10-01T00:00:00.000Z"),
      own("a2", "Notion", "notion.so", "2026-10-03T00:00:00.000Z"),
      own("a3", "Asana", "asana.com", "2026-10-02T00:00:00.000Z"),
      own("a4", "Hubspot", "hubspot.com", "2026-09-01T00:00:00.000Z"),
      own("a5", "Gmail", "gmail.com", "2026-10-04T00:00:00.000Z", { createdBy: "prs_teammate" }),
      own("a6", "Figma", "figma.com", "2026-10-05T00:00:00.000Z", { access: { mode: "everyone" } }),
    ]);
    // Owner, 2026-10-03: "We shouldn't show 4 cards - max 3".
    expect(MAX_FALLBACK_APPS).toBe(3);
    const notion = { domain: "notion.so", connectionId: "a2" };
    const asana = { domain: "asana.com", connectionId: "a3" };
    const linear = { domain: "linear.app", connectionId: "a1" };
    expect(appChosenItems(f, null)).toEqual([{ app: "slack" }, notion, asana]);
    // One the person already let the bot use is not offered again.
    expect(appChosenItems(f, recordGrant(null, "a2", "Notion", NOW))).toEqual([{ app: "slack" }, asana, linear]);
  });

  it("names an app with no domain by its provider, and skips what it cannot name", () => {
    const f = facts([own("a1", "Linear", undefined, "2026-10-01T00:00:00.000Z"), connection({ id: "a2", provider: "", installation: {} })]);
    expect(appChosenItems(f, null).slice(1)).toEqual([{ domain: "linear.com", connectionId: "a1" }]);
    // The card finds the connection by the id the app put on the item, never by the guessed name.
    expect(connectionForItem(f, appChosenItems(f, null).slice(1)[0]!)?.id).toBe("a1");
    expect(connectionForDomain(f, "linear.com")).toBeNull();
    const view = integrationCardView(appChosenItems(f, null).slice(1)[0] as { domain: string; connectionId: string }, input({ facts: f }))!;
    expect(view).toMatchObject({ state: "connected", connectionId: "a1", primaryLabel: "Let Nova use it" });
    // Its row is settled and asks the catalog nothing.
    expect(domainsToLookUp(appChosenItems(f, null).slice(1), f)).toEqual([]);
    expect(connectRowReady(appChosenItems(f, null).slice(1), { facts: f, since: NOW, now: NOW })).toBe(true);
  });

  it("offers Slack once, as the bot's own card: the person's own Slack integration connection is never a second card", () => {
    const f = facts([
      own("a1", "Slack", "slack.com", "2026-10-05T00:00:00.000Z"),
      own("a2", "Notion", "notion.so", "2026-10-03T00:00:00.000Z"),
      own("a3", "Slack", "acme.slack.com", "2026-10-04T00:00:00.000Z"),
      // No domain on the list: it would be named slack.com from its provider.
      connection({ id: "a4", provider: "slack", createdAt: "2026-10-06T00:00:00.000Z", installation: { displayName: "Slack" } }),
    ]);
    const notion = { domain: "notion.so", connectionId: "a2" };
    // Slack once, first, as the bot's own card, whether or not the bot is in Slack.
    expect(appChosenItems(f, null)).toEqual([{ app: "slack" }, notion]);
    expect(isSlackConnection({ domain: "slack.com", provider: "slack" })).toBe(true);
    expect(isSlackConnection({ domain: null, provider: "slack" })).toBe(true);
    expect(isSlackConnection({ domain: "linear.app", provider: "slack" })).toBe(false);
    expect(isSlackConnection({ domain: null, provider: "linear" })).toBe(false);
  });

  it("offers only Slack of a list that does not say who is looking", () => {
    const anon = facts([own("a1", "Linear", "linear.app", "2026-10-01T00:00:00.000Z")], { viewer: {} });
    expect(appChosenItems(anon, null)).toEqual([{ app: "slack" }]);
  });
});

describe("companyAppsBrief: what the bot is told about the company's apps", () => {
  const rows = (over: Record<string, unknown> = {}) =>
    envelope(
      [
        connection(),
        connection({ id: "acct_gmail", provider: "gmail", createdBy: "prs_teammate", createdAt: "2026-10-02T14:20:00.000Z", installation: { displayName: "Gmail (Stefan)", domain: "gmail.com" } }),
        connection({ id: "acct_notion", provider: "factory:notion", createdAt: "2026-10-02T14:30:00.000Z", access: { mode: "everyone" }, installation: { displayName: "Notion", domain: "notion.so" } }),
      ],
      over,
    );

  it("writes one line per connected app, most called first then newest first, with the count only when there is one", () => {
    const f = readCompanyConnections(
      rows({ audit: [...Array.from({ length: 12 }, () => ({ provider: "factory:linear", connectionId: "acct_linear" })), { provider: "gmail" }] as unknown[] }),
    );
    expect(companyAppsBrief({ facts: f, record: null })).toBe(
      [
        "- Linear (linear.app): connected, not shared with you, 12 recent calls",
        "- Gmail (Stefan) (gmail.com): connected, not shared with you, 1 recent call",
        "- Notion (notion.so): connected, you can use it",
      ].join("\n"),
    );
  });

  it("says what was granted from here as usable", () => {
    const f = readCompanyConnections(rows());
    const brief = companyAppsBrief({ facts: f, record: recordGrant(null, "acct_linear", "Linear", NOW) });
    expect(brief).toContain("- Linear (linear.app): connected, you can use it");
  });

  it("is empty with no apps, and with no list", () => {
    expect(companyAppsBrief({ facts: readCompanyConnections(envelope()) })).toBe("");
    expect(companyAppsBrief({ facts: null })).toBe("");
  });

  it("leaves the company's Slack integration connection out: Slack is the bot's own, said in the request", () => {
    // Live, 2026-10-04: the brief listed a teammate's connection as
    // "Slack (slack.com): connected, not shared with you", the bot named
    // slack.com as an app to connect, and its card then showed the
    // teammate's connection as if the bot were in Slack.
    const slack = (over: Record<string, unknown> = {}) =>
      connection({ id: "acct_slack", provider: "factory:slack", createdBy: "prs_teammate", installation: { displayName: "Slack", domain: "slack.com" }, ...over });
    for (const row of [
      slack(),
      slack({ installation: { displayName: "Slack", domain: "https://acme.slack.com/" } }),
      // No domain on the list: named by its provider.
      slack({ provider: "slack", installation: { displayName: "Slack" } }),
      // Open to everyone, and called a lot: still not an app in the bot's list.
      slack({ access: { mode: "everyone" } }),
    ]) {
      const f = readCompanyConnections(envelope([connection(), row], { audit: Array.from({ length: 9 }, () => ({ connectionId: "acct_slack" })) }));
      const brief = companyAppsBrief({ facts: f });
      expect(brief).toBe("- Linear (linear.app): connected, not shared with you");
      expect(brief.toLowerCase()).not.toContain("slack");
    }
    // Slack alone leaves nothing to list.
    expect(companyAppsBrief({ facts: readCompanyConnections(envelope([slack()])) })).toBe("");
    // A name that only resembles Slack's is some other app, and is listed.
    const other = connection({ id: "acct_x", provider: "factory:slackbot-tools", installation: { displayName: "Slack Tools", domain: "slack-tools.com" } });
    expect(companyAppsBrief({ facts: readCompanyConnections(envelope([other])) })).toBe("- Slack Tools (slack-tools.com): connected, not shared with you");
  });

  it("names an app with no domain by its provider, and keeps a name to one clean line", () => {
    const f = readCompanyConnections(
      envelope([connection({ installation: { displayName: "Linear\n(prod) `x`" } }), connection({ id: "acct_x", provider: "", installation: { displayName: "" } })]),
    );
    expect(companyAppsBrief({ facts: f })).toBe(
      ["- Linear (prod) x (provider linear): connected, not shared with you", "- App: connected, not shared with you"].join("\n"),
    );
  });

  it("lists at most 25 apps and stays under the cap by dropping lines from the end", () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      connection({
        id: `acct_${i}`,
        provider: `factory:app${i}`,
        createdAt: `2026-10-02T14:${String(59 - i).padStart(2, "0")}:00.000Z`,
        installation: { displayName: `A very long application name number ${i} for the cap`, domain: `app${i}.example-company-tools.com` },
      }),
    );
    const brief = companyAppsBrief({ facts: readCompanyConnections(envelope(many)) });
    const lines = brief.split("\n");
    expect(lines.length).toBeLessThanOrEqual(25);
    expect(brief.length).toBeLessThanOrEqual(MAX_BRIEF_CHARS);
    expect(lines[0]).toContain("number 0 ");
    expect(lines[lines.length - 1]).toContain(`number ${lines.length - 1} `);
    expect(brief).not.toContain("number 25 ");
  });
});

describe("slackFirst: every row of a cloud bot's cards starts with its own Slack card", () => {
  // Owner, 2026-10-05: "can we make sure that Slack is the first card every time? It's important."
  const items = (blocks: unknown) => {
    const block = parseRichContent({ v: 1, blocks: [{ kind: "connect", items: blocks }] })!.blocks[0] as { items: ConnectItem[] };
    return block.items;
  };

  it("adds Slack in front of a row that does not name it", () => {
    expect(slackFirst(items([{ domain: "notion.so" }, { domain: "sentry.io" }, { domain: "mixpanel.com" }]))).toEqual([
      { app: "slack" },
      { domain: "notion.so" },
      { domain: "sentry.io" },
      { domain: "mixpanel.com" },
    ]);
  });

  it("moves Slack named third to the front, once, with the bot's reason", () => {
    expect(slackFirst(items([{ domain: "notion.so" }, { domain: "sentry.io" }, { app: "slack", why: "Team chat" }]))).toEqual([
      { app: "slack", why: "Team chat" },
      { domain: "notion.so" },
      { domain: "sentry.io" },
    ]);
  });

  it("reads Slack named by slack.com as the same card", () => {
    expect(slackFirst(items([{ domain: "notion.so" }, { domain: "https://www.slack.com/" }]))).toEqual([{ app: "slack" }, { domain: "notion.so" }]);
  });

  it("leaves the app's own picks as they are: Slack is already first", () => {
    const picks = appChosenItems(null, null);
    expect(slackFirst(picks)).toEqual(picks);
  });
});
