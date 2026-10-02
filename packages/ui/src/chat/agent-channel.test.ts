import { describe, expect, it } from "vitest";
import {
  agentChatReadiness,
  agentComposerPlaceholder,
  isAgentConversationRow,
  provisioningFromMessages,
  AGENT_HELLO_REQUEST_LEAD,
  agentHelloArrived,
  buildAgentHelloRequest,
} from "./agent-channel.js";
import type { ConversationRow } from "./sidebar-model.js";
import type { ConversationMessageWire } from "./chat-api.js";

function row(
  partial: Partial<ConversationRow> & Pick<ConversationRow, "id">,
): ConversationRow {
  return {
    kind: "channel",
    title: "Ada",
    companyUid: "cmp_a",
    unreadDot: false,
    lastActivityAt: 0,
    pinned: false,
    ...partial,
  };
}

describe("isAgentConversationRow", () => {
  it("is true when a member uid is an agent", () => {
    expect(
      isAgentConversationRow(
        row({
          id: "ch:chn_a",
          members: [{ personUid: "agt_1", displayName: "Ada" }],
        }),
      ),
    ).toBe(true);
  });

  it("is false for ordinary company channels", () => {
    expect(
      isAgentConversationRow(
        row({
          id: "ch:chn_co",
          members: [{ personUid: "prs_o", displayName: "Corey" }],
        }),
      ),
    ).toBe(false);
  });
});

describe("provisioningFromMessages", () => {
  it("reads the latest status card", () => {
    const messages: ConversationMessageWire[] = [
      {
        eventId: "e1",
        createdAt: "2026-09-03T10:00:00.000Z",
        body: "",
        systemEvent: {
          type: "lifecycle_card",
          kind: "status",
          state: "pending",
          fields: [
            { id: "agentUid", value: "agt_1" },
            { id: "summary", value: "Provisioning Ada…" },
          ],
        },
      },
    ];
    const view = provisioningFromMessages(messages);
    expect(view.state).toBe("pending");
    expect(view.agentName).toBe("Ada");
    expect(view.machineStartedAt).toBe("2026-09-03T10:00:00.000Z");
    expect(agentComposerPlaceholder(view.agentName)).toBe(
      "Ada is still setting up",
    );
  });

  it("flips to done when the status card is done", () => {
    const messages: ConversationMessageWire[] = [
      {
        eventId: "e1",
        createdAt: "2026-09-03T10:01:00.000Z",
        body: "",
        systemEvent: {
          type: "lifecycle_card",
          kind: "status",
          state: "done",
          fields: [
            { id: "agentUid", value: "agt_1" },
            { id: "summary", value: "Ada is ready" },
          ],
        },
      },
    ];
    const view = provisioningFromMessages(messages);
    expect(view.state).toBe("done");
    expect(view.checkedInAt).toBe("2026-09-03T10:01:00.000Z");
  });
});

describe("agentChatReadiness", () => {
  // Shape recorded from production on 2026-10-02 for a bot whose company file
  // download ran for 21 minutes after the sign-in.
  const steps = (audit: string, runtimeInstall = "pending") => [
    { name: "identity", status: "done" },
    { name: "membership", status: "done" },
    { name: "vault", status: "done" },
    { name: "runtime", status: "done" },
    { name: "codex-auth", status: "done" },
    { name: "sync", status: "done", backgroundFirstSync: true },
    { name: "channels", status: "done" },
    { name: "audit", status: audit },
    { name: "runtime-install", status: runtimeInstall },
  ];

  it("lets the person chat while the file download and final checks are still running", () => {
    // Regression (owner, 2026-10-02): the flow waited 25 minutes for phase
    // "ready" although the server finishes the file sync in the background.
    expect(
      agentChatReadiness({
        agent: { runtime: { firstSyncStartedAt: "2026-10-02T06:07:47.798Z" } },
        setupState: { phase: "waiting", steps: steps("waiting") },
      }),
    ).toEqual({ chatReady: true, catchingUp: true, failed: false });
  });

  it("is not chat-ready before the sign-in or before the computer checks in", () => {
    const signInWaiting = steps("pending").map((step) =>
      ["codex-auth", "sync", "channels"].includes(step.name) ? { ...step, status: step.name === "codex-auth" ? "waiting" : "pending" } : step,
    );
    expect(agentChatReadiness({ setupState: { phase: "waiting", steps: signInWaiting } }).chatReady).toBe(false);
    const syncWaiting = steps("pending").map((step) => (step.name === "sync" ? { ...step, status: "waiting" } : step));
    expect(agentChatReadiness({ setupState: { phase: "waiting", steps: syncWaiting } }).chatReady).toBe(false);
  });

  it("stops saying the bot is catching up once the files are in", () => {
    expect(
      agentChatReadiness({
        agent: { runtime: { syncOkAt: "2026-10-02T06:28:52.808Z" } },
        setupState: { phase: "ready", steps: steps("done", "done") },
      }),
    ).toEqual({ chatReady: true, catchingUp: false, failed: false });
  });

  it("never treats a failed setup as chat-ready", () => {
    expect(agentChatReadiness({ setupState: { phase: "failed", steps: steps("failed") } })).toEqual({
      chatReady: false,
      catchingUp: false,
      failed: true,
    });
  });

  it("falls back to the phase when the payload has no step list", () => {
    expect(agentChatReadiness({ setupState: { phase: "creating" } }).chatReady).toBe(false);
    expect(agentChatReadiness({ setupState: { phase: "ready" } })).toEqual({ chatReady: true, catchingUp: false, failed: false });
    expect(agentChatReadiness(null).chatReady).toBe(false);
  });
});

describe("the new bot's first message", () => {
  it("asks on the bot's behalf without telling the person to do anything", () => {
    const text = buildAgentHelloRequest({ personName: "Stefan", filesStillDownloading: true });
    expect(text.startsWith(AGENT_HELLO_REQUEST_LEAD)).toBe(true);
    expect(text).toContain("Stefan cannot see this message");
    expect(text).toContain("still downloading");
    expect(buildAgentHelloRequest({ personName: "Stefan", filesStillDownloading: false })).not.toContain("downloading");
    // No name known: the request still reads as a sentence and never shows an id.
    expect(buildAgentHelloRequest({ personName: " ", filesStillDownloading: false })).toContain(
      "the person who created you cannot see this message",
    );
  });

  const JOINED = { fromPersonUid: "agt_nova", body: "Nova (an agent) just joined Acme.", createdAt: "2026-10-02T13:50:42.000Z" };
  const REQUEST = {
    fromPersonUid: "prs_me",
    body: buildAgentHelloRequest({ personName: "Stefan", filesStillDownloading: true }),
    createdAt: "2026-10-02T13:53:50.000Z",
  };
  const HELLO = { fromPersonUid: "agt_nova", body: "Hi Stefan, I'm Nova.", createdAt: "2026-10-02T13:54:20.000Z" };

  it("does not take the joined notice for the bot's first message", () => {
    // The server posts "just joined" in the direct message the moment the bot
    // is created, minutes before the bot can answer anything.
    expect(agentHelloArrived([JOINED], { agentUid: "agt_nova", askedAtMs: Date.parse(REQUEST.createdAt) })).toBe(false);
    expect(agentHelloArrived([REQUEST, JOINED], { agentUid: "agt_nova" })).toBe(false);
  });

  it("sees the first message once the bot wrote after the request", () => {
    expect(agentHelloArrived([HELLO, REQUEST, JOINED], { agentUid: "agt_nova" })).toBe(true);
  });

  it("falls back to the time of asking when the page leaves the request out", () => {
    const askedAtMs = Date.parse(REQUEST.createdAt);
    expect(agentHelloArrived([HELLO, JOINED], { agentUid: "agt_nova", askedAtMs })).toBe(true);
    expect(agentHelloArrived([HELLO, JOINED], { agentUid: "agt_nova" })).toBe(false);
    expect(agentHelloArrived([HELLO, JOINED], { agentUid: "agt_other", askedAtMs })).toBe(false);
  });
});
