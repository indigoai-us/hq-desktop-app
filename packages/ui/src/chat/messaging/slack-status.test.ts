import { describe, expect, it } from "vitest";

import {
  readSlackRow,
  slackAppPageUrl,
  slackCapabilityFromStatus,
  slackInstallUrl,
  slackRowFromAttach,
  slackRowFromStatus,
  slackRowStage,
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
