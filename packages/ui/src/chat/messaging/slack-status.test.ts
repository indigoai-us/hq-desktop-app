import { describe, expect, it } from "vitest";

import {
  readSlackRow,
  setupStepsFromStatus,
  slackAppPageUrl,
  slackBotUrlFromStatus,
  slackCapabilityFromStatus,
  slackInstallUrl,
  slackRowFromAttach,
  slackRowFromStatus,
  slackRowStage,
  slackSetupWaitFromSteps,
  slackSetupWaitWithSync,
} from "./slack-status.js";

const INSTALL = "https://slack.com/oauth/v2/authorize?client_id=1.2&scope=chat%3Awrite&state=A0TEST";
const APP = "https://api.slack.com/apps/A0TEST";

const status = (slack: unknown, capability?: string) => ({
  setupState: { phase: "ready" },
  agent: {
    companyUid: "cmp_acme",
    channels: slack === undefined ? null : { slack },
    channelDiagnostics: capability === undefined ? {} : { slack: { inboundCapability: capability } },
  },
});

describe("the links a Slack row may carry", () => {
  it("keeps an https link to Slack", () => {
    expect(slackInstallUrl(INSTALL)).toBe(INSTALL);
    expect(slackInstallUrl("https://acme.slack.com/oauth/v2/authorize?x=1")).toBe("https://acme.slack.com/oauth/v2/authorize?x=1");
  });

  it("drops anything that is not an https link to Slack itself", () => {
    for (const bad of [
      "",
      "   ",
      null,
      undefined,
      7,
      "not a link",
      "http://slack.com/oauth/v2/authorize",
      "javascript:alert(1)",
      "https://slack.com.evil.example/oauth",
      "https://evilslack.com/oauth",
      "https://example.com/?next=https://slack.com",
      "https://user:pass@slack.com/oauth",
      "file:///etc/hosts",
    ]) {
      expect(slackInstallUrl(bad)).toBeNull();
      expect(slackAppPageUrl(bad)).toBeNull();
    }
  });

  it("opens the app's page at /general, never with two slashes or twice", () => {
    expect(slackAppPageUrl(APP)).toBe(`${APP}/general`);
    expect(slackAppPageUrl(`${APP}/`)).toBe(`${APP}/general`);
    expect(slackAppPageUrl(`${APP}///`)).toBe(`${APP}/general`);
    expect(slackAppPageUrl(`${APP}/general`)).toBe(`${APP}/general`);
    expect(slackAppPageUrl(`${APP}/general/`)).toBe(`${APP}/general`);
    expect(slackAppPageUrl(`  ${APP}  `)).toBe(`${APP}/general`);
    // A query or a fragment on the server's link is not carried along.
    expect(slackAppPageUrl(`${APP}?x=1#y`)).toBe(`${APP}/general`);
  });
});

describe("readSlackRow", () => {
  it("reads a row that waits for approval", () => {
    const row = readSlackRow({
      workspace: "pending-install",
      installUrl: INSTALL,
      appId: "A0TEST",
      connectionMode: "socket",
      appTokenPendingUrl: APP,
    })!;
    expect(row).toEqual({
      installPending: true,
      installUrl: INSTALL,
      tokenPending: true,
      accessPending: false,
      appPageUrl: `${APP}/general`,
      usesToken: true,
    });
    expect(slackRowStage(row)).toBe("approve");
  });

  it("waits for approval on the workspace marker alone, with no link to offer", () => {
    const row = readSlackRow({ workspace: "pending-install" })!;
    expect(row.installPending).toBe(true);
    expect(row.installUrl).toBeNull();
    expect(slackRowStage(row)).toBe("approve");
  });

  it("still waits for approval when the link is one the app will not open", () => {
    const row = readSlackRow({ installUrl: "https://example.com/install" })!;
    expect(row.installPending).toBe(true);
    expect(row.installUrl).toBeNull();
  });

  it("reads a row that waits for the token", () => {
    const row = readSlackRow({ workspace: "acme", teamId: "T1", connectionMode: "socket", appTokenPendingUrl: APP })!;
    expect(row.installPending).toBe(false);
    expect(row.tokenPending).toBe(true);
    expect(row.accessPending).toBe(false);
    expect(row.appPageUrl).toBe(`${APP}/general`);
    expect(slackRowStage(row)).toBe("token");
  });

  it("reads a row whose app page the person cannot open yet", () => {
    const row = readSlackRow({
      workspace: "acme",
      teamId: "T1",
      connectionMode: "socket",
      appTokenAccessPending: "Adding you as a collaborator on the app.",
    })!;
    expect(row.tokenPending).toBe(true);
    expect(row.accessPending).toBe(true);
    expect(row.appPageUrl).toBeNull();
    expect(slackRowStage(row)).toBe("token");
    // Once the page link is here, the wait for access is over.
    expect(readSlackRow({ appTokenAccessPending: "x", appTokenPendingUrl: APP })!.accessPending).toBe(false);
    expect(readSlackRow({ appTokenAccessPending: true })!.accessPending).toBe(true);
  });

  it("reads a row with nothing left for the person to do", () => {
    const socket = readSlackRow({ workspace: "acme", teamId: "T1", connectionMode: "socket", appId: "A0TEST" })!;
    expect(slackRowStage(socket)).toBe("finishing");
    expect(socket.usesToken).toBe(true);
    const events = readSlackRow({ workspace: "acme", teamId: "T1", connectionMode: "events", appId: "A0TEST" })!;
    expect(slackRowStage(events)).toBe("finishing");
    expect(events.usesToken).toBe(false);
    expect(slackRowStage(readSlackRow({})!)).toBe("finishing");
  });

  it("is null for anything that is not a row", () => {
    for (const junk of [null, undefined, false, true, "x", 3, []]) expect(readSlackRow(junk)).toBeNull();
  });
});

describe("reading the row from the server's answers", () => {
  it("finds it in a status answer, and in an answer that is the agent itself", () => {
    expect(slackRowFromStatus(status({ workspace: "pending-install", installUrl: INSTALL }))?.installUrl).toBe(INSTALL);
    expect(slackRowFromStatus({ channels: { slack: { appTokenPendingUrl: APP } } })?.tokenPending).toBe(true);
  });

  it("is null when the bot has no Slack or the answer is unreadable", () => {
    for (const json of [null, undefined, "x", {}, status(undefined), status(null), status(false), { agent: { channels: 3 } }]) {
      expect(slackRowFromStatus(json)).toBeNull();
    }
  });

  it("finds it in the answer to an attach", () => {
    const answer = { config: { workspace: "pending-install", installUrl: INSTALL, appTokenPendingUrl: APP }, followUpUrl: INSTALL };
    expect(slackRowFromAttach(answer)?.installUrl).toBe(INSTALL);
    for (const junk of [null, undefined, "x", {}, { config: null }, { followUpUrl: INSTALL }]) {
      expect(slackRowFromAttach(junk)).toBeNull();
    }
  });

  it("reads what the bot can receive", () => {
    expect(slackCapabilityFromStatus(status({}, "socket-mode-degraded"))).toBe("socket-mode-degraded");
    expect(slackCapabilityFromStatus(status({}))).toBe("");
    expect(slackCapabilityFromStatus(null)).toBe("");
    expect(slackCapabilityFromStatus({ channelDiagnostics: { slack: { inboundCapability: " ok " } } })).toBe("ok");
  });
});

describe("the bot's place in Slack", () => {
  it("is Slack's web client at the team and the bot user, built from the two ids", () => {
    expect(slackBotUrlFromStatus(status({ teamId: "T0ACME", botUserId: "U0NOVA" }, "socket-mode"))).toBe(
      "https://app.slack.com/client/T0ACME/U0NOVA",
    );
    expect(slackBotUrlFromStatus(status({ teamId: " T0ACME ", botUserId: "U0NOVA " }))).toBe(
      "https://app.slack.com/client/T0ACME/U0NOVA",
    );
  });

  it("is null without both ids, and for an id that is not shaped like Slack's", () => {
    expect(slackBotUrlFromStatus(status({ teamId: "T0ACME" }))).toBeNull();
    expect(slackBotUrlFromStatus(status({ botUserId: "U0NOVA" }))).toBeNull();
    expect(slackBotUrlFromStatus(status({ teamId: "T0ACME", botUserId: "" }))).toBeNull();
    expect(slackBotUrlFromStatus(status({ teamId: "T0ACME", botUserId: "u0nova" }))).toBeNull();
    expect(slackBotUrlFromStatus(status({ teamId: "T0ACME/../x", botUserId: "U0NOVA" }))).toBeNull();
    expect(slackBotUrlFromStatus(status({ teamId: "T0ACME", botUserId: "U0NOVA?x=1" }))).toBeNull();
    expect(slackBotUrlFromStatus(status({ teamId: 1, botUserId: "U0NOVA" }))).toBeNull();
    expect(slackBotUrlFromStatus(status(undefined))).toBeNull();
    expect(slackBotUrlFromStatus(null)).toBeNull();
  });
});

describe("the setup steps in a status answer", () => {
  it("reads name, status and last error, lower-casing the names and statuses", () => {
    const json = {
      setupState: {
        steps: [
          { name: "Channels", status: "DONE" },
          { name: "audit", status: "waiting", lastError: " NEW_BOX_AUDIT_PENDING: box blueprint failed: component-sync " },
          { name: "runtime-install", status: "pending", lastError: "" },
          "not a step",
          null,
        ],
      },
    };
    expect(setupStepsFromStatus(json)).toEqual([
      { name: "channels", status: "done", lastError: null },
      { name: "audit", status: "waiting", lastError: "NEW_BOX_AUDIT_PENDING: box blueprint failed: component-sync" },
      { name: "runtime-install", status: "pending", lastError: null },
    ]);
  });

  it("reads the steps under the agent too, and is empty for anything else", () => {
    expect(setupStepsFromStatus({ agent: { setupState: { steps: [{ name: "sync", status: "done" }] } } })).toEqual([
      { name: "sync", status: "done", lastError: null },
    ]);
    for (const junk of [null, undefined, "x", [], {}, { setupState: {} }, { setupState: { steps: "none" } }]) {
      expect(setupStepsFromStatus(junk)).toEqual([]);
    }
  });
});

describe("what the server waits on at the last step", () => {
  const STORED = { workspace: "acme", teamId: "T0ACME", appId: "A0TEST", connectionMode: "socket" };
  const SYNC_ERROR = "NEW_BOX_AUDIT_PENDING: box blueprint failed: component-sync";
  const OTHER_ERROR = "NEW_BOX_AUDIT_PENDING: box blueprint failed: component-brain";
  const waitingOnSync = [
    { name: "channels", status: "done" },
    { name: "audit", status: "waiting", lastError: SYNC_ERROR },
    { name: "runtime-install", status: "pending" },
  ];
  const at = (slack: unknown, steps: unknown[], capability = "socket-mode-degraded", runtime: Record<string, unknown> = {}) => ({
    setupState: { phase: "ready", steps },
    agent: { runtime, channels: slack === undefined ? null : { slack }, channelDiagnostics: { slack: { inboundCapability: capability } } },
  });

  it("is the sync while the install waits on an audit that names the sync", () => {
    expect(slackSetupWaitFromSteps(at(STORED, waitingOnSync))).toEqual({ kind: "sync", percent: null });
    // The audit may carry no error at all and still be the sync wait.
    const noError = [{ name: "audit", status: "waiting" }, { name: "runtime-install", status: "pending" }];
    expect(slackSetupWaitFromSteps(at(STORED, noError))).toEqual({ kind: "sync", percent: null });
  });

  it("is the audit when its error names something other than the sync", () => {
    const steps = [{ name: "audit", status: "waiting", lastError: OTHER_ERROR }, { name: "runtime-install", status: "pending" }];
    expect(slackSetupWaitFromSteps(at(STORED, steps))).toEqual({ kind: "audit" });
    // The audit's own error wins, whatever the install step says.
    const failed = [{ name: "audit", status: "failed", lastError: OTHER_ERROR }, { name: "runtime-install", status: "done" }];
    expect(slackSetupWaitFromSteps(at(STORED, failed))).toEqual({ kind: "audit" });
  });

  it("is nothing when the steps say nothing of the kind", () => {
    expect(slackSetupWaitFromSteps(at(STORED, []))).toBeNull();
    expect(slackSetupWaitFromSteps(at(STORED, [{ name: "audit", status: "done" }, { name: "runtime-install", status: "running" }]))).toBeNull();
    expect(slackSetupWaitFromSteps(at(STORED, [{ name: "runtime-install", status: "pending" }]))).toBeNull();
    expect(slackSetupWaitFromSteps(at(STORED, [{ name: "audit", status: "waiting" }]))).toBeNull();
  });

  it("is nothing unless Slack's config is stored with nothing left for the person, and the bot cannot receive yet", () => {
    // Connected already.
    expect(slackSetupWaitFromSteps(at(STORED, waitingOnSync, "socket-mode"))).toBeNull();
    expect(slackSetupWaitFromSteps(at(STORED, waitingOnSync, "ok"))).toBeNull();
    // Still to be approved, or still waiting for the token or for access to the app page.
    expect(slackSetupWaitFromSteps(at({ ...STORED, workspace: "pending-install", installUrl: INSTALL }, waitingOnSync, "pending-install"))).toBeNull();
    expect(slackSetupWaitFromSteps(at({ ...STORED, appTokenPendingUrl: APP }, waitingOnSync))).toBeNull();
    expect(slackSetupWaitFromSteps(at({ ...STORED, appTokenAccessPending: "Adding you." }, waitingOnSync))).toBeNull();
    // No team id: nothing stored yet.
    expect(slackSetupWaitFromSteps(at({ workspace: "acme", appId: "A0TEST" }, waitingOnSync))).toBeNull();
    // No Slack at all.
    expect(slackSetupWaitFromSteps(at(undefined, waitingOnSync))).toBeNull();
    expect(slackSetupWaitFromSteps(at(true, waitingOnSync))).toBeNull();
    expect(slackSetupWaitFromSteps(null)).toBeNull();
  });

  it("adds the live percent to a sync wait read from the steps", () => {
    expect(slackSetupWaitWithSync(at(STORED, waitingOnSync), { live: true, percent: 88 })).toEqual({ kind: "sync", percent: 88 });
    expect(slackSetupWaitWithSync(at(STORED, waitingOnSync), { live: false, percent: null })).toEqual({ kind: "sync", percent: null });
  });

  it("reads a sync wait from a live first download with no good sync yet, when the steps say nothing", () => {
    const downloading = { firstSync: { phase: "pull", filesTotal: 10, filesDone: 4 } };
    expect(slackSetupWaitWithSync(at(STORED, [], undefined, downloading), { live: true, percent: 40 })).toEqual({ kind: "sync", percent: 40 });
    // Not live: a frozen snapshot is not a wait.
    expect(slackSetupWaitWithSync(at(STORED, [], undefined, downloading), { live: false, percent: null })).toBeNull();
    // A sync that finished well: the download is over.
    const synced = { ...downloading, syncOkAt: "2026-10-03T16:00:00.000Z" };
    expect(slackSetupWaitWithSync(at(STORED, [], undefined, synced), { live: true, percent: 40 })).toBeNull();
    // No snapshot at all.
    expect(slackSetupWaitWithSync(at(STORED, []), { live: true, percent: 40 })).toBeNull();
    // Connected: nothing to wait on.
    expect(slackSetupWaitWithSync(at(STORED, [], "socket-mode", downloading), { live: true, percent: 40 })).toBeNull();
  });

  it("keeps the audit over a live download", () => {
    const steps = [{ name: "audit", status: "waiting", lastError: OTHER_ERROR }, { name: "runtime-install", status: "pending" }];
    const downloading = { firstSync: { phase: "pull", filesTotal: 10, filesDone: 4 } };
    expect(slackSetupWaitWithSync(at(STORED, steps, undefined, downloading), { live: true, percent: 40 })).toEqual({ kind: "audit" });
  });
});
