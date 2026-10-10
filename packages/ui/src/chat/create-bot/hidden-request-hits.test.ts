/**
 * Message search leaves out the requests the app writes to a bot (review B-3),
 * and never a message from the bot or from another person.
 */
import { describe, expect, it } from "vitest";

import {
  AGENT_HELLO_REQUEST_LEAD,
  buildAgentHelloRequest,
  buildAgentSlackConnectedNotice,
  buildAgentToolConnectedNotice,
} from "../agent-channel.js";
import { firstRunSettledNotice } from "../first-run/visual-first-run.js";
import type { MessageSearchHit } from "../sidebar-model.js";
import { isHiddenRequestHit, withoutHiddenRequestHits } from "./hidden-request-hits.js";

const HELLO = buildAgentHelloRequest({ personName: "Ada", filesStillDownloading: false, companyApps: "" });

function hit(overrides: Partial<MessageSearchHit> & Record<string, unknown> = {}): MessageSearchHit {
  return {
    messageId: "evt_1",
    scope: "dm",
    counterpartyUid: "agt_nova",
    body: HELLO,
    createdAt: "2026-10-02T10:00:00.000Z",
    ...overrides,
  } as MessageSearchHit;
}

describe("isHiddenRequestHit", () => {
  it("leaves out every request the app writes to a bot, from this person's side", () => {
    const requests = [
      HELLO,
      buildAgentToolConnectedNotice({ personName: "Ada", name: "Linear", connectionId: "con_1" }),
      buildAgentSlackConnectedNotice({ personName: "Ada", botName: "nova" }),
    ];
    for (const body of requests) {
      expect(body.startsWith(AGENT_HELLO_REQUEST_LEAD)).toBe(true);
      expect(isHiddenRequestHit(hit({ body, direction: "out" }), "prs_ada")).toBe(true);
      expect(isHiddenRequestHit(hit({ body, fromPersonUid: "prs_ada" }), "prs_ada")).toBe(true);
      expect(isHiddenRequestHit(hit({ body, audience: "agent" }), "prs_ada")).toBe(true);
    }
  });

  it("reads the lead from the snippet when the hit has no body", () => {
    expect(isHiddenRequestHit(hit({ body: null, snippet: `  ${HELLO.slice(0, 80)}`, direction: "out" }))).toBe(true);
  });

  it("never leaves out a message from the bot or from another person", () => {
    // The bot quoting the request back is still the bot's message.
    expect(isHiddenRequestHit(hit({ direction: "in" }), "prs_ada")).toBe(false);
    expect(isHiddenRequestHit(hit({ fromPersonUid: "agt_nova" }), "prs_ada")).toBe(false);
    expect(isHiddenRequestHit(hit({ fromPersonUid: "prs_grace", scope: "channel", channelId: "chn_1" }), "prs_ada")).toBe(false);
    // A sender is named and nobody is known to be the viewer: kept.
    expect(isHiddenRequestHit(hit({ fromPersonUid: "prs_ada" }), null)).toBe(false);
  });

  it("keeps a message that only mentions the lead, or opens with other words", () => {
    expect(isHiddenRequestHit(hit({ body: `What is "${AGENT_HELLO_REQUEST_LEAD}" about?`, direction: "out" }), "prs_ada")).toBe(false);
    expect(isHiddenRequestHit(hit({ body: "Hello Nova", direction: "out" }), "prs_ada")).toBe(false);
    expect(isHiddenRequestHit(hit({ body: "Hello Nova", audience: "agent" }), "prs_ada")).toBe(false);
    expect(isHiddenRequestHit(hit({ body: null, snippet: null }), "prs_ada")).toBe(false);
  });

  it("when the host does not say who sent it, leaves it out only in a direct message with a bot", () => {
    // The desktop search command returns neither sender nor direction.
    expect(isHiddenRequestHit(hit(), "prs_ada")).toBe(true);
    expect(isHiddenRequestHit(hit({ counterpartyUid: "prs_grace" }), "prs_ada")).toBe(false);
    expect(isHiddenRequestHit(hit({ counterpartyUid: null }), "prs_ada")).toBe(false);
    expect(isHiddenRequestHit(hit({ scope: "channel", channelId: "chn_1", counterpartyUid: null }), "prs_ada")).toBe(false);
    expect(isHiddenRequestHit(hit({ scope: "channel", channelId: "chn_1", counterpartyUid: "agt_nova" }), "prs_ada")).toBe(false);
  });
});

describe("withoutHiddenRequestHits", () => {
  it("drops the app's requests and keeps everything else in order", () => {
    const hits = [
      hit({ messageId: "evt_request" }),
      hit({ messageId: "evt_bot", body: "Hello Ada, I am Nova.", direction: "in" }),
      hit({ messageId: "evt_person", body: "Can you draft the launch note?", direction: "out" }),
      hit({ messageId: "evt_channel", scope: "channel", channelId: "chn_1", counterpartyUid: null, body: HELLO }),
    ];

    expect(withoutHiddenRequestHits(hits, "prs_ada").map((entry) => entry.messageId)).toEqual([
      "evt_bot",
      "evt_person",
      "evt_channel",
    ]);
  });
});

describe("the visual first run's notes to the setup assistant", () => {
  const settled = firstRunSettledNotice({ imported: null, team: { kind: "personal" }, apps: null })!;

  it("are left out of search like the app's other requests to a bot", () => {
    expect(isHiddenRequestHit(hit({ body: settled, counterpartyUid: "agt_setup" }))).toBe(true);
    expect(isHiddenRequestHit(hit({ body: settled, fromPersonUid: "prs_ada" }), "prs_ada")).toBe(true);
    expect(isHiddenRequestHit(hit({ body: settled, direction: "out" }), "prs_ada")).toBe(true);
    // A snippet cut from the middle still carries the handoff.
    const snippet = settled.slice(settled.indexOf("Handoff from the app:"));
    expect(isHiddenRequestHit(hit({ body: "", snippet, counterpartyUid: "agt_setup" }))).toBe(true);
  });

  it("are kept when the bot or another person wrote them", () => {
    expect(isHiddenRequestHit(hit({ body: settled, fromPersonUid: "agt_setup" }), "prs_ada")).toBe(false);
    expect(isHiddenRequestHit(hit({ body: settled, direction: "in" }), "prs_ada")).toBe(false);
  });
});
