import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { slackFactsFromStatus } from "./connection-card-model.js";
import {
  SLACK_APPROVE_DETAIL,
  SLACK_ATTACH_RETRY_SENTENCE,
  SLACK_AUDIT_WAIT_SENTENCE,
  SLACK_FINISHING_SLOW_MS,
  SLACK_TOKEN_ACCEPT_GRACE_MS,
  SLACK_TOKEN_REJECTED_SENTENCE,
  SLACK_TOKEN_RETRY_SENTENCE,
  SLACK_TOKEN_SHAPE_SENTENCE,
  SLACK_TOKEN_SCOPE,
  SLACK_APP_TOKEN_SHAPE,
  SLACK_ATTACH_SETTLE_MS,
  SLACK_ATTACH_STILL_WORKING_SENTENCE,
  checkSlackAppToken,
  isWholeSlackAppToken,
  readSlackAttachAnswer,
  readSlackTokenAnswer,
  shouldAutoSubmitSlackToken,
  slackAccessPendingSentence,
  slackAttachMayRetry,
  slackBlockedCopy,
  slackConnectTitle,
  slackConnectView,
  slackConnectedSentence,
  slackFinishingSentence,
  slackLastStepSentence,
  slackStatusDenied,
  slackTokenSteps,
  slackTokenWhySentence,
  type SlackBlockedReason,
  type SlackConnectInput,
} from "./slack-connect-model.js";

const NOW = Date.parse("2026-10-02T15:00:00.000Z");
const INSTALL = "https://slack.com/oauth/v2/authorize?client_id=1.2&scope=chat%3Awrite&state=A0TEST";
const FRESH_INSTALL = "https://slack.com/oauth/v2/authorize?client_id=1.2&scope=chat%3Awrite&state=A0FRESH";
const APP = "https://api.slack.com/apps/A0TEST";
/** An obviously fake app-level token. Never a real one. */
const TOKEN = "xapp-test-0000";

/** A status answer shaped like `GET /v1/agents/{uid}/status`. */
function status(slack: Record<string, unknown> | null, capability = "unknown") {
  return {
    setupState: { phase: "ready" },
    agent: {
      uid: "agt_nova",
      companyUid: "cmp_acme",
      runtime: { syncOkAt: "2026-10-02T14:20:00.000Z" },
      channels: slack ? { slack } : null,
      channelDiagnostics: { slack: { inboundCapability: capability } },
    },
  };
}

// What the server shows at each point of the path most bots take today.
const NO_SLACK = status(null);
const WAITING_FOR_APPROVAL = status(
  { workspace: "pending-install", installUrl: INSTALL, appId: "A0TEST", connectionMode: "socket", appTokenPendingUrl: APP },
  "pending-install",
);
const WAITING_FOR_TOKEN = status(
  { workspace: "acme", teamId: "T0ACME", appId: "A0TEST", connectionMode: "socket", appTokenPendingUrl: APP },
  "socket-mode-degraded",
);
const WAITING_FOR_ACCESS = status(
  {
    workspace: "acme",
    teamId: "T0ACME",
    appId: "A0TEST",
    connectionMode: "socket",
    appTokenAccessPending: "Adding you as a collaborator on the app.",
  },
  "socket-mode-degraded",
);
const TOKEN_STORED = status(
  { workspace: "acme", teamId: "T0ACME", appId: "A0TEST", connectionMode: "socket" },
  "socket-mode-degraded",
);
const CONNECTED_SOCKET = status({ workspace: "acme", teamId: "T0ACME", appId: "A0TEST", connectionMode: "socket" }, "socket-mode");
// The path with no token: the server chose the mode that needs none.
const EVENTS_WAITING_FOR_APPROVAL = status(
  { workspace: "pending-install", installUrl: INSTALL, appId: "A0TEST", connectionMode: "events" },
  "pending-install",
);
const EVENTS_INSTALLED = status({ workspace: "acme", teamId: "T0ACME", appId: "A0TEST", connectionMode: "events" }, "unknown");
const EVENTS_CONNECTED = status({ workspace: "acme", teamId: "T0ACME", appId: "A0TEST", connectionMode: "events" }, "ok");

const ATTACHED_SOCKET = {
  config: { workspace: "pending-install", installUrl: INSTALL, appId: "A0TEST", connectionMode: "socket", appTokenPendingUrl: APP },
  followUpUrl: INSTALL,
};
const ATTACHED_EVENTS = {
  config: { workspace: "pending-install", installUrl: INSTALL, appId: "A0TEST", connectionMode: "events" },
  followUpUrl: INSTALL,
};

function view(over: Partial<SlackConnectInput> = {}) {
  return slackConnectView({ status: NO_SLACK, botName: "Nova", now: NOW, ...over });
}

const stepStates = (v: ReturnType<typeof view>) => v.steps.map((step) => `${step.number}:${step.key}:${step.state}`);

describe("slackConnectView: the stage", () => {
  it("opens on the first step while the bot has no Slack, and says the attach is needed", () => {
    const v = view();
    expect(v.stage).toBe("approve");
    expect(v.needsAttach).toBe(true);
    expect(v.title).toBe("Connect Nova to Slack");
    // The list is there from the start, with the path most bots take.
    expect(stepStates(v)).toEqual(["1:approve:current", "2:token:todo", "3:finishing:todo"]);
    expect(v.indicator).toEqual({ labels: ["Approve in Slack", "Add the token", "Connecting"], current: 0 });
    expect(v.statusKnown).toBe(true);
    expect(v.busy).toBe(false);
    // No link to open until the server has answered.
    expect(v.installUrl).toBeNull();
    expect(v.appPageUrl).toBeNull();
    expect(v.blocked).toBeNull();
  });

  it("opens on the first step, and says it does not know, before any status answer", () => {
    const v = view({ status: null });
    expect(v.stage).toBe("approve");
    expect(v.needsAttach).toBe(true);
    expect(v.statusKnown).toBe(false);
    expect(stepStates(v)).toEqual(["1:approve:current", "2:token:todo", "3:finishing:todo"]);
  });

  it("needs no attach once the status or an attach answer shows Slack for the bot", () => {
    for (const json of [WAITING_FOR_APPROVAL, WAITING_FOR_TOKEN, WAITING_FOR_ACCESS, TOKEN_STORED, CONNECTED_SOCKET, EVENTS_INSTALLED]) {
      expect(view({ status: json }).needsAttach).toBe(false);
    }
    expect(view({ attached: ATTACHED_SOCKET }).needsAttach).toBe(false);
    expect(view({ status: null, attached: ATTACHED_SOCKET }).needsAttach).toBe(false);
    expect(view({ blocked: "not-admin" }).needsAttach).toBe(false);
    expect(view({ status: null, statusDenied: true }).needsAttach).toBe(false);
  });

  it("is approve while the app waits to be approved in Slack", () => {
    const v = view({ status: WAITING_FOR_APPROVAL });
    expect(v.stage).toBe("approve");
    expect(v.needsAttach).toBe(false);
    expect(v.installUrl).toBe(INSTALL);
    expect(stepStates(v)).toEqual(["1:approve:current", "2:token:todo", "3:finishing:todo"]);
    expect(v.steps.map((step) => step.text)).toEqual([
      "Approve Nova in Slack",
      "Create a token for Nova",
      "HQ finishes the setup",
    ]);
    expect(v.indicator).toEqual({ labels: ["Approve in Slack", "Add the token", "Connecting"], current: 0 });
  });

  it("is approve on the workspace marker alone, with no link to open", () => {
    const v = view({ status: status({ workspace: "pending-install", appId: "A0TEST" }, "pending-install") });
    expect(v.stage).toBe("approve");
    expect(v.installUrl).toBeNull();
  });

  it("is token once the app is approved and the server wants the token", () => {
    const v = view({ status: WAITING_FOR_TOKEN });
    expect(v.stage).toBe("token");
    expect(v.accessPending).toBe(false);
    expect(v.appPageUrl).toBe(`${APP}/general`);
    expect(v.installUrl).toBeNull();
    expect(stepStates(v)).toEqual(["1:approve:done", "2:token:current", "3:finishing:todo"]);
    expect(v.indicator).toEqual({ labels: ["Approve in Slack", "Add the token", "Connecting"], current: 1 });
  });

  it("is token with access pending while HQ is still adding the person to the app", () => {
    const v = view({ status: WAITING_FOR_ACCESS });
    expect(v.stage).toBe("token");
    expect(v.accessPending).toBe(true);
    expect(v.appPageUrl).toBeNull();
    expect(stepStates(v)).toEqual(["1:approve:done", "2:token:current", "3:finishing:todo"]);
  });

  it("is finishing when nothing is pending on the person and the bot cannot receive yet", () => {
    const v = view({ status: TOKEN_STORED });
    expect(v.stage).toBe("finishing");
    expect(v.slow).toBe(false);
    expect(stepStates(v)).toEqual(["1:approve:done", "2:token:done", "3:finishing:current"]);
    expect(v.indicator).toEqual({ labels: ["Approve in Slack", "Add the token", "Connecting"], current: 2 });
  });

  it("is connected exactly when the Slack card says so", () => {
    for (const json of [CONNECTED_SOCKET, EVENTS_CONNECTED]) {
      expect(slackFactsFromStatus(json).state).toBe("connected");
      expect(view({ status: json }).stage).toBe("connected");
    }
    for (const json of [NO_SLACK, WAITING_FOR_APPROVAL, WAITING_FOR_TOKEN, WAITING_FOR_ACCESS, TOKEN_STORED, EVENTS_INSTALLED]) {
      expect(slackFactsFromStatus(json).state).not.toBe("connected");
      expect(view({ status: json }).stage).not.toBe("connected");
    }
    const v = view({ status: CONNECTED_SOCKET });
    expect(stepStates(v)).toEqual(["1:approve:done", "2:token:done", "3:finishing:done"]);
    expect(v.indicator).toEqual({ labels: ["Approve in Slack", "Add the token", "Connected"], current: 2 });
  });

  it("offers the bot's place in Slack once connected, only with both ids, and never before", () => {
    const withBot = { workspace: "acme", teamId: "T0ACME", botUserId: "U0NOVA", appId: "A0TEST", connectionMode: "socket" };
    expect(view({ status: status(withBot, "socket-mode") }).botUrl).toBe("https://app.slack.com/client/T0ACME/U0NOVA");
    expect(view({ status: CONNECTED_SOCKET }).botUrl).toBeNull();
    // The ids are there before the end too, but the link is offered only at the end.
    expect(view({ status: status({ ...withBot, appTokenPendingUrl: APP }, "socket-mode-degraded") }).botUrl).toBeNull();
    expect(view({ status: status(withBot, "socket-mode-degraded") }).botUrl).toBeNull();
  });

  it("is connected over everything the modal remembers", () => {
    const v = view({ status: CONNECTED_SOCKET, blocked: "not-admin", attachError: "x", tokenError: "y" });
    expect(v.stage).toBe("connected");
    expect(v.blocked).toBeNull();
    expect(v.attachError).toBeNull();
    expect(v.tokenError).toBeNull();
  });

  it("waits, with nothing to do, on a Slack setup it cannot read", () => {
    const odd = { agent: { channels: { slack: true }, channelDiagnostics: {} } };
    const v = view({ status: odd });
    expect(v.stage).toBe("finishing");
    expect(stepStates(v)).toEqual(["1:approve:done", "2:finishing:current"]);
  });

  it("falls back to a plain name for a bot without one", () => {
    const v = view({ status: WAITING_FOR_APPROVAL, botName: "  " });
    expect(v.title).toBe("Connect your bot to Slack");
    expect(v.steps[0]!.text).toBe("Approve your bot in Slack");
  });
});

describe("slackConnectView: two steps or three", () => {
  it("shows three steps, the first current, while the attach is on its way", () => {
    const v = view({ attachInFlight: true });
    expect(v.stage).toBe("approve");
    expect(v.busy).toBe(true);
    expect(stepStates(v)).toEqual(["1:approve:current", "2:token:todo", "3:finishing:todo"]);
    expect(v.installUrl).toBeNull();
  });

  it("has three steps when the attach answer asks for a token", () => {
    const v = view({ attached: ATTACHED_SOCKET });
    expect(v.stage).toBe("approve");
    expect(v.installUrl).toBe(INSTALL);
    expect(stepStates(v)).toEqual(["1:approve:current", "2:token:todo", "3:finishing:todo"]);
  });

  it("has three steps when the attach answer says access to the app page is still pending", () => {
    const attached = { config: { workspace: "pending-install", installUrl: INSTALL, appTokenAccessPending: "Adding you." } };
    expect(stepStates(view({ attached }))).toEqual(["1:approve:current", "2:token:todo", "3:finishing:todo"]);
  });

  it("has two steps when the attach answer asks for no token, and never shows a token step", () => {
    const approve = view({ attached: ATTACHED_EVENTS });
    expect(approve.stage).toBe("approve");
    expect(stepStates(approve)).toEqual(["1:approve:current", "2:finishing:todo"]);
    expect(approve.indicator).toEqual({ labels: ["Approve in Slack", "Connecting"], current: 0 });

    const installed = view({ attached: ATTACHED_EVENTS, status: EVENTS_INSTALLED });
    expect(installed.stage).toBe("finishing");
    expect(stepStates(installed)).toEqual(["1:approve:done", "2:finishing:current"]);

    const done = view({ attached: ATTACHED_EVENTS, status: EVENTS_CONNECTED });
    expect(done.stage).toBe("connected");
    expect(stepStates(done)).toEqual(["1:approve:done", "2:finishing:done"]);
    expect(done.indicator).toEqual({ labels: ["Approve in Slack", "Connected"], current: 1 });

    for (const v of [approve, installed, done]) expect(v.steps.some((step) => step.key === "token")).toBe(false);
  });

  it("reads the same lists from the status alone, when the modal is opened again", () => {
    expect(stepStates(view({ status: EVENTS_WAITING_FOR_APPROVAL }))).toEqual(["1:approve:current", "2:finishing:todo"]);
    expect(stepStates(view({ status: EVENTS_INSTALLED }))).toEqual(["1:approve:done", "2:finishing:current"]);
    expect(stepStates(view({ status: EVENTS_CONNECTED }))).toEqual(["1:approve:done", "2:finishing:done"]);
    expect(stepStates(view({ status: WAITING_FOR_APPROVAL }))).toHaveLength(3);
    expect(stepStates(view({ status: TOKEN_STORED }))).toHaveLength(3);
    expect(stepStates(view({ status: CONNECTED_SOCKET }))).toHaveLength(3);
  });

  it("keeps the token step once a token was accepted here", () => {
    const bare = status({ workspace: "acme", teamId: "T0ACME", appId: "A0TEST" }, "unknown");
    expect(stepStates(view({ status: bare }))).toEqual(["1:approve:done", "2:finishing:current"]);
    expect(stepStates(view({ status: bare, tokenAcceptedAt: NOW - 1000 }))).toEqual([
      "1:approve:done",
      "2:token:done",
      "3:finishing:current",
    ]);
  });
});

describe("slackConnectView: the attach answer and the status together", () => {
  it("uses the attach answer until the status shows the row", () => {
    expect(view({ status: NO_SLACK, attached: ATTACHED_SOCKET }).stage).toBe("approve");
    expect(view({ status: null, attached: ATTACHED_SOCKET }).stage).toBe("approve");
  });

  it("believes the status over the attach answer", () => {
    expect(view({ status: WAITING_FOR_TOKEN, attached: ATTACHED_SOCKET }).stage).toBe("token");
    expect(view({ status: CONNECTED_SOCKET, attached: ATTACHED_SOCKET }).stage).toBe("connected");
  });

  it("uses a fresher install link from the status", () => {
    const fresher = status(
      { workspace: "pending-install", installUrl: FRESH_INSTALL, appId: "A0TEST", connectionMode: "socket", appTokenPendingUrl: APP },
      "pending-install",
    );
    expect(view({ status: fresher, attached: ATTACHED_SOCKET }).installUrl).toBe(FRESH_INSTALL);
  });

  it("falls back to the attach answer's link when the status row has none it can open", () => {
    const noLink = status({ workspace: "pending-install", appId: "A0TEST" }, "pending-install");
    expect(view({ status: noLink, attached: ATTACHED_SOCKET }).installUrl).toBe(INSTALL);
  });

  it("never opens a link that is not Slack's", () => {
    const evil = status({ workspace: "pending-install", installUrl: "https://example.com/phish" }, "pending-install");
    const v = view({ status: evil });
    expect(v.stage).toBe("approve");
    expect(v.installUrl).toBeNull();
    const evilPage = status({ workspace: "acme", teamId: "T1", appTokenPendingUrl: "https://example.com/apps/A1" });
    const t = view({ status: evilPage });
    expect(t.stage).toBe("token");
    expect(t.appPageUrl).toBeNull();
  });
});

describe("slackConnectView: what the modal has done", () => {
  it("is busy while a request is on its way", () => {
    expect(view({ attachInFlight: true }).busy).toBe(true);
    expect(view({ status: WAITING_FOR_TOKEN, tokenInFlight: true }).busy).toBe(true);
    expect(view({ status: WAITING_FOR_TOKEN }).busy).toBe(false);
  });

  it("shows an attach that can be tried again under the first step, with the list still there", () => {
    const v = view({ attachError: SLACK_ATTACH_RETRY_SENTENCE });
    expect(v.stage).toBe("approve");
    expect(v.needsAttach).toBe(true);
    expect(v.attachError).toBe("Slack did not answer. Try again.");
    expect(stepStates(v)).toEqual(["1:approve:current", "2:token:todo", "3:finishing:todo"]);
    expect(v.installUrl).toBeNull();
    // Never once a later step is reached.
    expect(view({ status: WAITING_FOR_TOKEN, attachError: SLACK_ATTACH_RETRY_SENTENCE }).attachError).toBeNull();
    expect(view({ status: TOKEN_STORED, attachError: SLACK_ATTACH_RETRY_SENTENCE }).attachError).toBeNull();
  });

  it("shows the token's sentence on the token step, and nowhere else", () => {
    expect(view({ status: WAITING_FOR_TOKEN, tokenError: SLACK_TOKEN_REJECTED_SENTENCE }).tokenError).toBe(
      SLACK_TOKEN_REJECTED_SENTENCE,
    );
    expect(view({ status: TOKEN_STORED, tokenError: SLACK_TOKEN_REJECTED_SENTENCE }).tokenError).toBeNull();
  });

  it("moves to the last step the moment the token is accepted, before the status catches up", () => {
    const v = view({ status: WAITING_FOR_TOKEN, tokenAcceptedAt: NOW - 1000 });
    expect(v.stage).toBe("finishing");
    expect(stepStates(v)).toEqual(["1:approve:done", "2:token:done", "3:finishing:current"]);
  });

  it("believes a status that still asks for the token once the answer is no longer fresh", () => {
    const v = view({ status: WAITING_FOR_TOKEN, tokenAcceptedAt: NOW - SLACK_TOKEN_ACCEPT_GRACE_MS });
    expect(v.stage).toBe("token");
    expect(SLACK_TOKEN_ACCEPT_GRACE_MS).toBe(30_000);
  });

  it("shows a blocked state with its sentence and button", () => {
    const v = view({ blocked: "company-not-connected" });
    expect(v.stage).toBe("blocked");
    expect(v.steps).toEqual([]);
    expect(v.indicator).toBeNull();
    expect(v.blocked).toEqual({
      reason: "company-not-connected",
      sentence:
        "Your company's Slack is not connected to HQ yet. A company admin connects it once in HQ Integrations, then you can add Nova here.",
      action: { label: "Open HQ Integrations", page: "integrations" },
    });
  });

  it("is blocked for a person who may not read the bot's status", () => {
    const v = view({ status: null, statusDenied: true });
    expect(v.stage).toBe("blocked");
    expect(v.blocked?.reason).toBe("not-admin");
    expect(v.blocked?.sentence).toBe("Only a company owner or admin can connect a bot to Slack.");
    // A status the app already has wins over a later refusal.
    expect(view({ status: WAITING_FOR_APPROVAL, statusDenied: true }).stage).toBe("approve");
  });
});

describe("slackConnectView: a long wait in the last step", () => {
  it("says the usual line for the first three minutes", () => {
    const v = view({ status: TOKEN_STORED, waitingSince: NOW - SLACK_FINISHING_SLOW_MS });
    expect(v.stage).toBe("finishing");
    expect(v.slow).toBe(false);
    expect(v.wait).toBeNull();
    expect(v.finishingSentence).toBe("Connecting Nova to Slack. This usually takes a minute or two.");
    expect(slackFinishingSentence("Nova", v.slow)).toBe(v.finishingSentence);
    // The line belongs to the last step only.
    expect(view({ status: WAITING_FOR_TOKEN }).finishingSentence).toBeNull();
    expect(view({ status: CONNECTED_SOCKET }).finishingSentence).toBeNull();
  });

  it("says the calmer line after three minutes, and stays in the same stage", () => {
    const v = view({ status: TOKEN_STORED, waitingSince: NOW - SLACK_FINISHING_SLOW_MS - 1 });
    expect(v.stage).toBe("finishing");
    expect(v.slow).toBe(true);
    expect(v.blocked).toBeNull();
    expect(stepStates(v)).toEqual(["1:approve:done", "2:token:done", "3:finishing:current"]);
    expect(v.finishingSentence).toBe("Still connecting. You can close this. The Slack card updates when Nova is in Slack.");
    expect(slackFinishingSentence("Nova", v.slow)).toBe(v.finishingSentence);
    expect(SLACK_FINISHING_SLOW_MS).toBe(180_000);
  });

  it("counts from when the token was accepted when the modal saw nothing earlier", () => {
    expect(view({ status: TOKEN_STORED, tokenAcceptedAt: NOW - SLACK_FINISHING_SLOW_MS - 1 }).slow).toBe(true);
    expect(view({ status: TOKEN_STORED, tokenAcceptedAt: NOW - 1000 }).slow).toBe(false);
  });

  it("is never slow without a start, or outside the last step", () => {
    expect(view({ status: TOKEN_STORED }).slow).toBe(false);
    expect(view({ status: WAITING_FOR_TOKEN, waitingSince: NOW - 10 * SLACK_FINISHING_SLOW_MS }).slow).toBe(false);
    expect(view({ status: CONNECTED_SOCKET, waitingSince: NOW - 10 * SLACK_FINISHING_SLOW_MS }).slow).toBe(false);
  });
});

describe("slackConnectView: what the server waits on at the last step", () => {
  const STORED = { workspace: "acme", teamId: "T0ACME", appId: "A0TEST", connectionMode: "socket" };
  const FRESH = new Date(NOW - 30_000).toISOString();
  const SYNC_ERROR = "NEW_BOX_AUDIT_PENDING: box blueprint failed: component-sync";

  /** A status at the last step, with the setup steps and runtime a live bot reports. */
  function finishing(over: { steps?: unknown[]; runtime?: Record<string, unknown>; capability?: string }) {
    return {
      setupState: { phase: "ready", steps: over.steps ?? [] },
      agent: {
        uid: "agt_nova",
        companyUid: "cmp_acme",
        runtime: over.runtime ?? {},
        channels: { slack: STORED },
        channelDiagnostics: { slack: { inboundCapability: over.capability ?? "socket-mode-degraded" } },
      },
    };
  }
  const WAITING_ON_SYNC_STEPS = [
    { name: "channels", status: "done" },
    { name: "audit", status: "waiting", lastError: SYNC_ERROR },
    { name: "runtime-install", status: "pending" },
  ];
  const LIVE_SYNC = {
    firstSync: { phase: "pull", filesTotal: 68042, filesDone: 60268, startedAt: new Date(NOW - 600_000).toISOString(), updatedAt: FRESH },
    lastHeartbeat: { at: FRESH, components: { sync: "degraded", slack: "ok" } },
  };

  it("says the ordinary connecting line while the install is pending, the audit waits, and the first sync is live", () => {
    // The state of the 2026-10-03 walkthrough: Slack connected while the
    // sync had barely started. The sync is not what Slack waits on.
    const v = view({ status: finishing({ steps: WAITING_ON_SYNC_STEPS, runtime: LIVE_SYNC }) });
    expect(v.stage).toBe("finishing");
    expect(v.wait).toBeNull();
    expect(v.slow).toBe(false);
    expect(v.finishingSentence).toBe("Connecting Nova to Slack. This usually takes a minute or two.");
    expect(v.finishingSentence).not.toMatch(/sync|%/i);
  });

  it("says the same whatever the sync is doing: no steps, no live count, a stale count, a finished sync", () => {
    const stale = { ...LIVE_SYNC, firstSync: { ...LIVE_SYNC.firstSync, updatedAt: new Date(NOW - 20 * 60_000).toISOString() } };
    const synced = { ...LIVE_SYNC, syncOkAt: FRESH };
    const statuses = [
      finishing({ steps: WAITING_ON_SYNC_STEPS }),
      finishing({ steps: WAITING_ON_SYNC_STEPS, runtime: stale }),
      finishing({ runtime: LIVE_SYNC }),
      finishing({ runtime: synced }),
      finishing({ steps: [{ name: "audit", status: "waiting" }, { name: "runtime-install", status: "pending" }], runtime: LIVE_SYNC }),
    ];
    for (const status of statuses) {
      const v = view({ status });
      expect(v.stage).toBe("finishing");
      expect(v.wait).toBeNull();
      expect(v.finishingSentence).toBe("Connecting Nova to Slack. This usually takes a minute or two.");
    }
  });

  it("says the calmer line after three minutes in that state, still without a word about the sync", () => {
    const v = view({
      status: finishing({ steps: WAITING_ON_SYNC_STEPS, runtime: LIVE_SYNC }),
      waitingSince: NOW - SLACK_FINISHING_SLOW_MS - 1,
    });
    expect(v.slow).toBe(true);
    expect(v.wait).toBeNull();
    expect(v.finishingSentence).toBe("Still connecting. You can close this. The Slack card updates when Nova is in Slack.");
    expect(v.finishingSentence).not.toMatch(/sync|%/i);
  });

  it("says HQ is finishing the setup when the audit has stopped on something other than the sync", () => {
    const steps = [
      { name: "audit", status: "waiting", lastError: "NEW_BOX_AUDIT_PENDING: box blueprint failed: component-brain" },
      { name: "runtime-install", status: "pending" },
    ];
    const v = view({ status: finishing({ steps, runtime: LIVE_SYNC }) });
    expect(v.wait).toEqual({ kind: "audit" });
    expect(v.finishingSentence).toBe("HQ is finishing the setup on the bot's machine. This can take a few minutes.");
    expect(SLACK_AUDIT_WAIT_SENTENCE).toBe(v.finishingSentence);
  });

  it("keeps the audit's line over the calmer long-wait line, and never shows a wait outside the last step", () => {
    const auditSteps = [
      { name: "audit", status: "waiting", lastError: "NEW_BOX_AUDIT_PENDING: box blueprint failed: component-brain" },
      { name: "runtime-install", status: "pending" },
    ];
    const long = view({ status: finishing({ steps: auditSteps }), waitingSince: NOW - SLACK_FINISHING_SLOW_MS - 1 });
    expect(long.slow).toBe(true);
    expect(long.finishingSentence).toBe(SLACK_AUDIT_WAIT_SENTENCE);
    const connected = view({ status: finishing({ steps: auditSteps, capability: "socket-mode" }) });
    expect(connected.stage).toBe("connected");
    expect(connected.wait).toBeNull();
    const atToken = finishing({ steps: auditSteps });
    const token = { ...atToken, agent: { ...atToken.agent, channels: { slack: { ...STORED, appTokenPendingUrl: APP } } } };
    expect(view({ status: token }).stage).toBe("token");
    expect(view({ status: token }).wait).toBeNull();
  });

  it("says the ordinary line when the steps say nothing of the kind", () => {
    const steps = [{ name: "audit", status: "done" }, { name: "runtime-install", status: "running" }];
    const v = view({ status: finishing({ steps }) });
    expect(v.wait).toBeNull();
    expect(v.finishingSentence).toBe("Connecting Nova to Slack. This usually takes a minute or two.");
    expect(slackLastStepSentence("Nova", null, false)).toBe(v.finishingSentence);
    expect(slackLastStepSentence("Nova", null, true)).toBe(slackFinishingSentence("Nova", true));
    expect(slackLastStepSentence("Nova", { kind: "audit" }, true)).toBe(SLACK_AUDIT_WAIT_SENTENCE);
  });
});

describe("readSlackAttachAnswer", () => {
  const refused = (code: string, httpStatus?: number) => ({
    ok: false,
    reason: "error",
    code,
    message: "server text that is never shown",
    ...(httpStatus ? { status: httpStatus } : {}),
  });

  it("keeps the server's answer when the bot was set up", () => {
    expect(readSlackAttachAnswer({ ok: true, value: ATTACHED_SOCKET })).toEqual({ kind: "attached", attached: ATTACHED_SOCKET });
  });

  it("is not an error when the bot already has Slack", () => {
    expect(readSlackAttachAnswer(refused("SLACK_ATTACH_ALREADY_CONNECTED", 409))).toEqual({ kind: "continue" });
  });

  it("can be tried again when Slack did not answer", () => {
    const sentence = "Slack did not answer. Try again.";
    // The server's own word that the setup failed: nothing is under way, a retry may go at once.
    const failed = { kind: "retry", sentence, unanswered: false };
    expect(readSlackAttachAnswer(refused("SLACK_FACTORY_ROTATE_UNAVAILABLE", 409))).toEqual(failed);
    expect(readSlackAttachAnswer(refused("CHANNEL_ATTACH_FAILED", 502))).toEqual(failed);
    expect(readSlackAttachAnswer({ ...refused("CHANNEL_ATTACH_FAILED", 502), upstreamCode: "invalid_auth" })).toEqual(failed);
    // A refusal this version does not know, but a refusal: a 4xx starts nothing.
    expect(readSlackAttachAnswer(refused("SOMETHING_NEW", 400))).toEqual(failed);
    expect(readSlackAttachAnswer(refused("http-429", 429))).toEqual(failed);
    // No answer of the server's own: the network, a gateway, a request that threw, an unreadable answer.
    // The server may still be working on the request.
    const unanswered = { kind: "retry", sentence, unanswered: true };
    expect(readSlackAttachAnswer(refused("network"))).toEqual(unanswered);
    expect(readSlackAttachAnswer(refused("invoke"))).toEqual(unanswered);
    expect(readSlackAttachAnswer(refused("timeout"))).toEqual(unanswered);
    expect(readSlackAttachAnswer(refused("http-500", 500))).toEqual(unanswered);
    expect(readSlackAttachAnswer(refused("http-502", 502))).toEqual(unanswered);
    expect(readSlackAttachAnswer(refused("http-504", 504))).toEqual(unanswered);
    for (const junk of [null, undefined, "x", 3, []]) expect(readSlackAttachAnswer(junk)).toEqual(unanswered);
    expect(SLACK_ATTACH_RETRY_SENTENCE).toBe("Slack did not answer. Try again.");
  });

  it("holds a second setup request back while the first, unanswered, may still be running", () => {
    const NOW = Date.parse("2026-10-02T15:00:00.000Z");
    expect(SLACK_ATTACH_SETTLE_MS).toBe(120_000);
    // Nothing unanswered: a request may go.
    expect(slackAttachMayRetry(null, NOW)).toBe(true);
    expect(slackAttachMayRetry(undefined, NOW)).toBe(true);
    expect(slackAttachMayRetry(Number.NaN, NOW)).toBe(true);
    // One went unanswered a moment ago: not yet.
    expect(slackAttachMayRetry(NOW, NOW)).toBe(false);
    expect(slackAttachMayRetry(NOW - 30_000, NOW)).toBe(false);
    expect(slackAttachMayRetry(NOW - SLACK_ATTACH_SETTLE_MS + 1, NOW)).toBe(false);
    // The wait has passed and the status still shows nothing: it did not land.
    expect(slackAttachMayRetry(NOW - SLACK_ATTACH_SETTLE_MS, NOW)).toBe(true);
    expect(SLACK_ATTACH_STILL_WORKING_SENTENCE).toBe("Slack may still be setting this up. Wait a minute, then try again.");
  });

  it("is blocked for a person who is not an owner or admin", () => {
    const blocked = { kind: "blocked", reason: "not-admin" };
    expect(readSlackAttachAnswer(refused("http-404", 404))).toEqual(blocked);
    expect(readSlackAttachAnswer(refused("http-403", 403))).toEqual(blocked);
    // The status alone, with a server code this version does not know.
    expect(readSlackAttachAnswer(refused("FORBIDDEN", 403))).toEqual(blocked);
    // The code alone, from an adapter that carries no status.
    expect(readSlackAttachAnswer(refused("http-404"))).toEqual(blocked);
  });

  it("names each refusal the modal cannot get past", () => {
    const cases: Array<[string, number, SlackBlockedReason]> = [
      ["FACTORY_ROOT_MISSING", 400, "company-not-connected"],
      ["SLACK_PASTE_REQUIRED", 409, "own-app"],
      ["LEGACY_FACTORY_CONFIG_TOKEN_DEAD", 400, "config-dead"],
      ["SLACK_ATTACH_APP_SWITCH_NOT_WIRED", 400, "app-switch"],
    ];
    for (const [code, httpStatus, reason] of cases) {
      expect(readSlackAttachAnswer(refused(code, httpStatus))).toEqual({ kind: "blocked", reason });
    }
  });

  it("reads a known code before the status it came with", () => {
    expect(readSlackAttachAnswer(refused("SLACK_ATTACH_ALREADY_CONNECTED", 404))).toEqual({ kind: "continue" });
  });
});

describe("slackBlockedCopy", () => {
  it("says each blocked state in one plain sentence, with at most one button", () => {
    expect(slackBlockedCopy("not-admin", "Nova")).toEqual({
      sentence: "Only a company owner or admin can connect a bot to Slack.",
      action: null,
    });
    expect(slackBlockedCopy("company-not-connected", "Nova")).toEqual({
      sentence:
        "Your company's Slack is not connected to HQ yet. A company admin connects it once in HQ Integrations, then you can add Nova here.",
      action: { label: "Open HQ Integrations", page: "integrations" },
    });
    expect(slackBlockedCopy("own-app", "Nova")).toEqual({
      sentence: "Your company connects bots with its own Slack app. That setup is on the web for now.",
      action: { label: "Open Slack setup", page: "slack-setup" },
    });
    for (const reason of ["config-dead", "app-switch"] as const) {
      expect(slackBlockedCopy(reason, "Nova")).toEqual({
        sentence: "Nova could not be added to Slack from here. Contact HQ support.",
        action: null,
      });
    }
  });
});

describe("readSlackTokenAnswer", () => {
  const refused = (code: string, httpStatus?: number) => ({
    ok: false,
    reason: "error",
    code,
    message: "server text that is never shown",
    ...(httpStatus ? { status: httpStatus } : {}),
  });

  it("accepts", () => {
    expect(readSlackTokenAnswer({ ok: true, value: { ok: true } })).toEqual({ kind: "accepted" });
  });

  it("says Slack did not accept the token, for either rejection", () => {
    const rejected = {
      kind: "rejected",
      sentence: "Slack did not accept that token. Check that it starts with xapp- and has the connections:write scope.",
    };
    expect(readSlackTokenAnswer(refused("SLACK_APP_TOKEN_INVALID", 400))).toEqual(rejected);
    expect(readSlackTokenAnswer(refused("SLACK_APP_TOKEN_REJECTED", 400))).toEqual(rejected);
  });

  it("goes on from the status when the server was not waiting for a token", () => {
    expect(readSlackTokenAnswer(refused("SLACK_APP_TOKEN_NOT_AWAITED", 409))).toEqual({ kind: "continue" });
  });

  it("can be tried again when the token could not be checked", () => {
    const retry = { kind: "retry", sentence: "Could not check the token with Slack. Try again." };
    expect(readSlackTokenAnswer(refused("SLACK_APP_TOKEN_VERIFY_UNAVAILABLE", 502))).toEqual(retry);
    expect(readSlackTokenAnswer(refused("network"))).toEqual(retry);
    expect(readSlackTokenAnswer(refused("http-500", 500))).toEqual(retry);
    for (const junk of [null, undefined, "x"]) expect(readSlackTokenAnswer(junk)).toEqual(retry);
    expect(SLACK_TOKEN_RETRY_SENTENCE).toBe("Could not check the token with Slack. Try again.");
  });

  it("is blocked for a person who is not an owner or admin", () => {
    expect(readSlackTokenAnswer(refused("http-404", 404))).toEqual({ kind: "blocked", reason: "not-admin" });
  });
});

describe("checkSlackAppToken", () => {
  it("passes a token that starts with xapp-, with the spaces around it taken off", () => {
    expect(checkSlackAppToken(TOKEN)).toEqual({ ok: true, token: TOKEN });
    expect(checkSlackAppToken(`  ${TOKEN}\n`)).toEqual({ ok: true, token: TOKEN });
  });

  it("stops anything else before it is sent, with one sentence", () => {
    const wrongKind = "bot-test-0000";
    for (const bad of ["", "   ", "xapp-", wrongKind, "XAPP-test-0000", "xapp test", "xapp-test 0000", "xapp-test\t0000", `token ${TOKEN}`]) {
      expect(checkSlackAppToken(bad)).toEqual({
        ok: false,
        sentence: "That does not look like the right token. It starts with xapp-.",
      });
    }
    expect(SLACK_TOKEN_SHAPE_SENTENCE).toBe("That does not look like the right token. It starts with xapp-.");
  });

  it("never repeats what was pasted", () => {
    const answer = checkSlackAppToken("bot-test-0000 extra");
    expect(JSON.stringify(answer)).not.toContain("bot-test-0000");
  });
});

describe("slackStatusDenied", () => {
  it("is true only for the refusal a person who may not manage the bot gets", () => {
    expect(slackStatusDenied({ ok: false, reason: "error", code: "http-404", message: "Not found" })).toBe(true);
    expect(slackStatusDenied({ ok: false, reason: "error", code: "http-403" })).toBe(true);
    expect(slackStatusDenied({ ok: false, reason: "error", code: "http-500" })).toBe(false);
    expect(slackStatusDenied({ ok: false, reason: "error", code: "network" })).toBe(false);
    expect(slackStatusDenied({ ok: true, value: {} })).toBe(false);
    expect(slackStatusDenied(null)).toBe(false);
  });
});

describe("the words of the flow", () => {
  it("says under Open Slack what to click, once, and nothing that repeats it", () => {
    expect(SLACK_APPROVE_DETAIL).toBe("Slack opens in your browser. Click Allow, then come back here.");
  });

  it("says in one line why there is a token step, then the three things to do", () => {
    expect(slackTokenWhySentence("Nova")).toBe(
      "Slack needs a token so Nova can listen for messages. Slack only lets a person create it.",
    );
    expect(slackTokenSteps("Nova")).toEqual([
      { key: "open", text: "Open Nova's app page" },
      { key: "scope", text: "Under App-Level Tokens, click Generate Token and Scopes. Add the scope" },
      { key: "paste", text: "Paste the token here." },
    ]);
    expect(SLACK_TOKEN_SCOPE).toBe("connections:write");
  });

  it("knows a whole pasted token from anything that still needs Connect", () => {
    // Obviously fake values in the exact shape Slack writes: xapp-, a digit, the app id, a number, 64 hex digits.
    // Put together here so no token-shaped text sits in the source.
    const fake = (hex: string, app = "A0FAKE0TEST") => ["xapp", "1", app, "0000000000000", hex.repeat(64)].join("-");
    for (const whole of [fake("0"), ` ${fake("a")} `, `${fake("f")}\n`, fake("3", "A1"), ["xapp", "2", "A0FAKE0TEST", "7", "b".repeat(64)].join("-")]) {
      expect(isWholeSlackAppToken(whole), "a whole token").toBe(true);
    }
    const notWhole = [
      "",
      "xapp-",
      "xapp-short",
      TOKEN,
      // What the looser rule used to send by itself.
      "xapp-test-0000-aaaa-bbbb",
      "xapp-0000000000",
      // One hex digit short, one too many, capitals in the hex, a letter that is not hex.
      fake("0").slice(0, -1),
      `${fake("0")}0`,
      fake("A"),
      fake("g"),
      // The app id in lower case, a missing part, a space, another prefix.
      fake("0", "a0fake0test"),
      ["xapp", "1", "A0FAKE0TEST", "0".repeat(64)].join("-"),
      ["xapp", "A0FAKE0TEST", "0000000000000", "0".repeat(64)].join("-"),
      fake("0").replace("-A0", " A0"),
      fake("0").replace("xapp", "xoxb"),
      fake("0").replace("xapp", "Xapp"),
      `${fake("0")} trailing words`,
    ];
    for (const value of notWhole) expect(isWholeSlackAppToken(value), `not whole: ${value.length} characters`).toBe(false);
    expect(SLACK_APP_TOKEN_SHAPE.source).toBe("^xapp-\\d-[A-Z0-9]+-\\d+-[a-f0-9]{64}$");
  });

  it("sends by itself only a whole token that was pasted, once per value, and never anything typed", () => {
    const whole = ["xapp", "1", "A0FAKE0TEST", "0000000000000", "0".repeat(64)].join("-");
    expect(shouldAutoSubmitSlackToken({ value: whole, pasted: true, alreadySent: null })).toBe(true);
    expect(shouldAutoSubmitSlackToken({ value: `  ${whole} `, pasted: true, alreadySent: null })).toBe(true);
    // Typed, even when it ends up whole: Connect sends it.
    expect(shouldAutoSubmitSlackToken({ value: whole, pasted: false, alreadySent: null })).toBe(false);
    // Typed and still on its way to being whole: the old rule sent this, got a refusal, and cleared the field under the person.
    for (const typing of ["xapp-1-A0FAKE0TE", "xapp-1-A0FAKE0TEST-0000", whole.slice(0, -1)]) {
      expect(shouldAutoSubmitSlackToken({ value: typing, pasted: false, alreadySent: null })).toBe(false);
      expect(shouldAutoSubmitSlackToken({ value: typing, pasted: true, alreadySent: null })).toBe(false);
    }
    // Pasted, but not a whole token.
    for (const partial of ["xapp-", TOKEN, "xapp-test-0000-aaaa-bbbb", `${whole} and more`]) {
      expect(shouldAutoSubmitSlackToken({ value: partial, pasted: true, alreadySent: null })).toBe(false);
    }
    // The same value this modal already sent by itself goes through Connect.
    expect(shouldAutoSubmitSlackToken({ value: whole, pasted: true, alreadySent: whole })).toBe(false);
    expect(shouldAutoSubmitSlackToken({ value: whole, pasted: true, alreadySent: whole.replace(/0$/, "1") })).toBe(true);
    // Connect still takes any value that starts with xapp-.
    expect(checkSlackAppToken("xapp-test-0000")).toEqual({ ok: true, token: "xapp-test-0000" });
    expect(checkSlackAppToken(whole)).toEqual({ ok: true, token: whole });
  });

  it("says the wait for access, the end, and the title", () => {
    expect(slackAccessPendingSentence("Nova")).toBe(
      "HQ is giving you access to Nova's app in Slack. This can take up to 15 minutes. This screen updates by itself.",
    );
    expect(slackConnectedSentence("Nova")).toBe("Nova is in Slack. Invite it to a channel or send it a direct message.");
    expect(slackConnectTitle("Nova")).toBe("Connect Nova to Slack");
  });

  it("uses no long dash and no jargon in anything a person reads", () => {
    const reasons: SlackBlockedReason[] = ["not-admin", "company-not-connected", "own-app", "config-dead", "app-switch"];
    const everything = [
      slackConnectTitle("Nova"),
      SLACK_APPROVE_DETAIL,
      SLACK_AUDIT_WAIT_SENTENCE,
      slackTokenWhySentence("Nova"),
      ...slackTokenSteps("Nova").map((step) => step.text),
      slackAccessPendingSentence("Nova"),
      slackFinishingSentence("Nova", false),
      slackFinishingSentence("Nova", true),
      slackConnectedSentence("Nova"),
      SLACK_ATTACH_RETRY_SENTENCE,
      SLACK_ATTACH_STILL_WORKING_SENTENCE,
      SLACK_TOKEN_REJECTED_SENTENCE,
      SLACK_TOKEN_RETRY_SENTENCE,
      SLACK_TOKEN_SHAPE_SENTENCE,
      ...reasons.flatMap((reason) => {
        const copy = slackBlockedCopy(reason, "Nova");
        return [copy.sentence, copy.action?.label ?? ""];
      }),
      ...view({ status: WAITING_FOR_APPROVAL }).steps.map((step) => step.text),
      ...(view({ status: WAITING_FOR_APPROVAL }).indicator?.labels ?? []),
    ].join("\n");
    expect(everything).not.toMatch(/\u2014|\u2013|OAuth|socket|manifest|webhook|API\b/i);
  });
});

describe("the old sync wait is gone from the product", () => {
  // Slack does not wait for the bot's file sync, so no surface may say it
  // does. The phrase is built from its halves so this file is not a match.
  const PHRASE = ["finish", "syncing"].join(" ");
  const REPO = fileURLToPath(new URL("../../../../..", import.meta.url));
  const SKIP = new Set(["node_modules", "dist", "target", "build", "gen"]);

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      if (SKIP.has(entry) || entry.startsWith(".")) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.(ts|js|svelte|html|rs|md)$/.test(entry)) out.push(full);
    }
    return out;
  }

  it("has no line that says Slack waits for the files to sync, under packages/ui/src or apps", () => {
    const roots = [join(REPO, "packages", "ui", "src"), join(REPO, "apps")];
    for (const root of roots) expect(existsSync(root)).toBe(true);
    const files = roots.flatMap((root) => walk(root));
    expect(files.length).toBeGreaterThan(100);
    const hits = files.filter((file) => readFileSync(file, "utf8").toLowerCase().includes(PHRASE));
    expect(hits).toEqual([]);
  });
});
