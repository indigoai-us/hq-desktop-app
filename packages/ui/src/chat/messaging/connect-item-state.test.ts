/**
 * Connection cards drawn from the bot's own state (bot-generated cards, PR 6).
 *
 * A runtime with `show_connection_cards` state sends each `connect` item with
 * what it looked up: `state` on an app, `slack` on Slack, and `asOf`. The app
 * keeps only the fields it knows, with the server's shapes, and draws the card
 * from them plus what it knows about the person looking.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  clearRichContentMemo,
  connectItemCarriesState,
  parseRichContent,
  richContentForMessage,
  type ConnectBlock,
  type ConnectItem,
} from "./richMessageContent.js";
import {
  APP_NOT_CONNECTABLE_NOTE,
  connectItemStateAt,
  connectionForStateItem,
  integrationCardViewFromState,
  readCompanyConnections,
  slackFactsFromItem,
  slackFirst,
  stateIsCurrent,
  type StateCardInput,
} from "./integration-cards-model.js";
import { connectionCardView } from "./connection-card-model.js";
import { connectionNoticeAfter, isConnectionChangedNotice, buildAgentSlackConnectedNotice, buildAgentToolConnectedNotice, buildAgentHelloRequest } from "../agent-channel.js";

afterEach(() => clearRichContentMemo());

const connectItems = (items: unknown[]): ConnectItem[] => {
  const model = parseRichContent({ v: 1, blocks: [{ kind: "connect", items }] });
  const block = model?.blocks.find((b): b is ConnectBlock => b.kind === "connect");
  return block?.items ?? [];
};

const AS_OF = "2026-10-05T12:00:00.000Z";
const STATE = {
  connected: true,
  usableByBot: false,
  connectionId: "acct_linear",
  createdByPersonUid: "prs_me",
  accessMode: "private",
};

describe("parsing a connect item's state", () => {
  it("keeps the known fields of an app's state, Slack's state and asOf", () => {
    const items = connectItems([
      { app: "slack", why: "Talk to me there", slack: { installed: "pending", workspaceName: "Acme" }, asOf: AS_OF },
      { domain: "linear.app", why: "Track issues", state: STATE, asOf: AS_OF },
    ]);
    expect(items).toEqual([
      { app: "slack", why: "Talk to me there", slack: { installed: "pending", workspaceName: "Acme" }, asOf: AS_OF },
      {
        domain: "linear.app",
        why: "Track issues",
        state: { connected: true, usableByBot: false, connectionId: "acct_linear", createdByPersonUid: "prs_me", accessMode: "private" },
        asOf: AS_OF,
      },
    ]);
    expect(items.every(connectItemCarriesState)).toBe(true);
  });

  it("reads Slack's installed as a boolean or as one of three words, and the server's `state` word", () => {
    expect(connectItems([{ app: "slack", slack: { installed: true } }])[0]?.slack).toEqual({ installed: "installed" });
    expect(connectItems([{ app: "slack", slack: { installed: false } }])[0]?.slack).toEqual({ installed: "absent" });
    expect(connectItems([{ app: "slack", slack: { installed: "absent" } }])[0]?.slack).toEqual({ installed: "absent" });
    expect(connectItems([{ app: "slack", slack: { state: "installed" } }])[0]?.slack).toEqual({ installed: "installed" });
    // slack.com is the same Slack item, state and all.
    expect(connectItems([{ domain: "slack.com", slack: { installed: "pending" } }])[0]).toEqual({ app: "slack", slack: { installed: "pending" } });
  });

  it("drops a state it cannot trust, and keeps the item as one without state", () => {
    const garbage: unknown[] = [
      { domain: "a.com", state: "connected" },
      { domain: "b.com", state: { connected: "yes", usableByBot: false } },
      { domain: "c.com", state: { connected: true } },
      // A bot cannot use what is not connected.
      { domain: "d.com", state: { connected: false, usableByBot: true } },
    ];
    for (const entry of garbage) {
      const [item] = connectItems([entry]);
      expect(item).toEqual({ domain: (entry as { domain: string }).domain });
      expect(connectItemCarriesState(item!)).toBe(false);
    }
    expect(connectItems([{ app: "slack", slack: { installed: "maybe" } }])[0]).toEqual({ app: "slack" });
    expect(connectItems([{ app: "slack", slack: "installed" }])[0]).toEqual({ app: "slack" });
  });

  it("keeps only optional fields with the server's shape, and no field it does not know", () => {
    const [item] = connectItems([
      {
        domain: "linear.app",
        state: {
          connected: true,
          usableByBot: true,
          connectionId: "acct linear; drop table",
          createdByPersonUid: { uid: "prs_me" },
          accessMode: "public",
          url: "https://evil.example.com",
        },
        asOf: "yesterday",
        label: "Click me",
      },
    ]);
    expect(item).toEqual({ domain: "linear.app", state: { connected: true, usableByBot: true } });
  });

  it("puts no state on the legacy tools card, and none on Slack from an app's `state`", () => {
    expect(connectItems(["tools"])[0]).toEqual({ app: "tools" });
    expect(connectItemCarriesState({ app: "tools" })).toBe(false);
    expect(connectItems([{ app: "slack", state: STATE }])[0]).toEqual({ app: "slack" });
    expect(connectItems([{ domain: "linear.app", slack: { installed: true } }])[0]).toEqual({ domain: "linear.app" });
  });

  it("reads state from the message's richContent field before the body's fence, three items at most", () => {
    const message = {
      eventId: "m1",
      body: "Apps: Slack (not added yet), Linear (connected, not shared with me)",
      richContent: {
        v: 1,
        blocks: [
          {
            kind: "connect",
            items: [
              { app: "slack", slack: { installed: "absent" }, asOf: AS_OF },
              { domain: "linear.app", state: STATE, asOf: AS_OF },
              { domain: "notion.so", state: { connected: false, usableByBot: false }, asOf: AS_OF },
              { domain: "figma.com", state: { connected: false, usableByBot: false }, asOf: AS_OF },
            ],
          },
        ],
      },
    };
    const { text, rich } = richContentForMessage(message);
    // The body is shown as the bot wrote it: nothing is scrubbed from it.
    expect(text).toBe(message.body);
    const block = rich?.blocks.find((b): b is ConnectBlock => b.kind === "connect");
    expect(block?.items.map((i) => i.app ?? i.domain)).toEqual(["slack", "linear.app", "notion.so"]);
    expect(block?.items.every(connectItemCarriesState)).toBe(true);
  });
});

describe("an integration card drawn from the bot's state", () => {
  const input = (over: Partial<StateCardInput> = {}): StateCardInput => ({
    botName: "Nova",
    viewerUid: "prs_me",
    canManage: true,
    now: Date.parse("2026-10-05T12:01:00.000Z"),
    ...over,
  });
  const view = (state: Record<string, unknown>, over: Partial<StateCardInput> = {}) =>
    integrationCardViewFromState(
      { domain: "linear.app", why: "Track issues", state: { connected: false, usableByBot: false, ...state } as never },
      input(over),
    );

  it("usable by the bot: says so, with no button", () => {
    const v = view({ connected: true, usableByBot: true, connectionId: "acct_linear" });
    expect(v).toMatchObject({ state: "connected", line: "Nova can use it.", primaryLabel: null, mark: "Connected", fromState: true });
  });

  it("connected by the person looking: offers to let the bot use it, for that connection", () => {
    const v = view({ connected: true, connectionId: "acct_linear", createdByPersonUid: "prs_me" });
    expect(v).toMatchObject({
      state: "connected",
      line: "Let Nova use it?",
      primaryLabel: "Let Nova use it",
      primaryAction: "allow",
      connectionId: "acct_linear",
      fromState: true,
    });
  });

  it("connected by a teammate: asks the person to ask them, with no button", () => {
    const v = view({ connected: true, connectionId: "acct_linear", createdByPersonUid: "prs_teammate" });
    expect(v).toMatchObject({ line: "A teammate connected this. Ask them to share it with Nova.", primaryLabel: null });
    // Nobody signed in to compare with: never offered as the person's own.
    expect(view({ connected: true, createdByPersonUid: "prs_me" }, { viewerUid: null })?.primaryLabel).toBeNull();
  });

  it("let in from this device since the message: usable", () => {
    const v = view(
      { connected: true, connectionId: "acct_linear", createdByPersonUid: "prs_me" },
      { record: { granted: { acct_linear: { name: "Linear", at: 1 } } } },
    );
    expect(v?.line).toBe("Nova can use it.");
  });

  it("not connected, the person may add apps: Connect, with the bot's reason", () => {
    const v = view({});
    expect(v).toMatchObject({
      state: "offered",
      title: "Linear",
      line: "Connect Linear so Nova can use it.",
      reason: "Nova says: Track issues",
      primaryLabel: "Connect Linear",
      primaryAction: "connect",
      declineLabel: "Not now",
    });
    // The catalog's answer, when the app has it, names the card and picks the button.
    const keyed = view({}, { lookup: { domain: "linear.app", name: "Linear (Key)", authClass: "key" } });
    expect(keyed).toMatchObject({ title: "Linear (Key)", primaryAction: "open" });
  });

  it("not connected, the person may not add apps: ask an admin; unknown still offers Connect", () => {
    expect(view({}, { canManage: false })).toMatchObject({ line: "Ask a company admin to connect Linear.", primaryLabel: null });
    expect(view({}, { canManage: null })?.primaryLabel).toBe("Connect Linear");
  });

  it("a Not now or a Connect pressed on this device shows as on any card", () => {
    const now = Date.parse("2026-10-05T12:01:00.000Z");
    expect(view({}, { record: { apps: { "linear.app": { state: "declined", since: now - 1_000 } } }, messageAt: now - 60_000 })?.state).toBe(
      "declined",
    );
    expect(view({}, { record: { apps: { "linear.app": { state: "connecting", since: now - 1_000 } } } })).toMatchObject({
      state: "connecting",
      primaryLabel: "Open again",
    });
  });

  it("is no card for Slack's domain or a name that is not a domain", () => {
    expect(integrationCardViewFromState({ domain: "slack.com", state: { connected: true, usableByBot: true } }, input())).toBeNull();
    expect(integrationCardViewFromState({ domain: "localhost", state: { connected: true, usableByBot: true } }, input())).toBeNull();
  });

  it("says plainly when the app cannot be connected from the card", () => {
    expect(APP_NOT_CONNECTABLE_NOTE("Linear")).toBe("Linear could not be connected from here. Try it from HQ Integrations.");
  });
});

describe("the Slack card drawn from the bot's state", () => {
  const card = (installed: "installed" | "pending" | "absent") =>
    connectionCardView("slack", { botName: "Nova", now: 0, slack: slackFactsFromItem({ installed }) });

  it("installed, pending and absent", () => {
    expect(card("installed")).toMatchObject({ state: "connected", line: "Nova is in Slack.", mark: "Connected" });
    expect(card("pending")).toMatchObject({ state: "connecting", primaryLabel: "Continue" });
    expect(card("absent")).toMatchObject({ state: "offered", primaryLabel: "Connect Slack" });
  });
});

describe("which state a card draws from", () => {
  it("the bot's state, unless a live read for a press or a notice is newer", () => {
    const at = Date.parse(AS_OF);
    expect(stateIsCurrent(at, undefined)).toBe(true);
    expect(stateIsCurrent(at, at - 1)).toBe(true);
    expect(stateIsCurrent(at, at + 1)).toBe(false);
    expect(stateIsCurrent(null, at)).toBe(false);
  });

  it("an item's state time is its asOf, else its message's", () => {
    expect(connectItemStateAt({ asOf: AS_OF }, 5)).toBe(Date.parse(AS_OF));
    expect(connectItemStateAt({}, 5)).toBe(5);
    expect(connectItemStateAt({}, null)).toBeNull();
  });

  it("the bot's connection id stands for the card only when the list says it is that app's", () => {
    const facts = readCompanyConnections({
      viewer: { personUid: "prs_me", canManageIntegrations: true },
      connections: [
        { id: "acct_gmail", provider: "factory:gmail", status: "connected", createdAt: "2026-10-01", installation: { displayName: "Gmail", domain: "gmail.com" } },
        { id: "acct_linear", provider: "factory:linear", status: "connected", createdAt: "2026-10-02", installation: { displayName: "Linear", domain: "linear.app" } },
      ],
    });
    expect(connectionForStateItem(facts, { domain: "linear.app", connectionId: "acct_linear" })?.id).toBe("acct_linear");
    // A card for Linear never shares Gmail.
    expect(connectionForStateItem(facts, { domain: "linear.app", connectionId: "acct_gmail" })?.id).toBe("acct_linear");
    expect(connectionForStateItem(facts, { domain: "notion.so", connectionId: "acct_gmail" })).toBeNull();
    expect(connectionForStateItem(null, { domain: "linear.app" })).toBeNull();
  });

  it("Slack stays first and the row three cards for state-carrying items", () => {
    const items = connectItems([
      { domain: "linear.app", state: STATE },
      { domain: "notion.so", state: { connected: false, usableByBot: false } },
      { app: "slack", slack: { installed: true } },
    ]);
    const row = slackFirst(items);
    expect(row.map((i) => ("app" in i && i.app) || (i as ConnectItem).domain)).toEqual(["slack", "linear.app", "notion.so"]);
    expect((row[0] as ConnectItem).slack).toEqual({ installed: "installed" });
  });
});

describe("connection-changed notices", () => {
  it("are the tool and Slack notices, never the hello request", () => {
    expect(isConnectionChangedNotice(buildAgentToolConnectedNotice({ personName: "Corey", name: "Linear", connectionId: "acct_linear" }))).toBe(true);
    expect(isConnectionChangedNotice(buildAgentSlackConnectedNotice({ personName: "Corey", botName: "Nova" }))).toBe(true);
    expect(isConnectionChangedNotice(buildAgentHelloRequest({ personName: "Corey", filesStillDownloading: false }))).toBe(false);
    expect(isConnectionChangedNotice("Corey just connected Linear for the company and allowed you to use it")).toBe(false);
  });

  it("the newest one after a time, not written by the bot", () => {
    const notice = buildAgentSlackConnectedNotice({ personName: "Corey", botName: "Nova" });
    const rows = [
      { eventId: "n1", fromPersonUid: "prs_me", body: notice, createdAt: "2026-10-05T11:00:00.000Z" },
      { eventId: "n2", fromPersonUid: "prs_me", body: notice, createdAt: "2026-10-05T13:00:00.000Z" },
      { eventId: "b1", fromPersonUid: "agt_nova", body: notice, createdAt: "2026-10-05T14:00:00.000Z" },
    ];
    expect(connectionNoticeAfter(rows, { agentUid: "agt_nova", afterMs: Date.parse(AS_OF) })).toEqual({
      eventId: "n2",
      at: Date.parse("2026-10-05T13:00:00.000Z"),
    });
    expect(connectionNoticeAfter(rows, { agentUid: "agt_nova", afterMs: Date.parse("2026-10-05T13:30:00.000Z") })).toBeNull();
  });
});
