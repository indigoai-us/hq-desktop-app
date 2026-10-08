import { describe, expect, it } from "vitest";
import { parseShareRequestEvent } from "../messaging/share-request-card.js";
import {
  botSetupAsksAccess,
  botSetupCardId,
  botSetupMatchesRow,
  botSetupShareCommand,
  botSetupUidFromCardId,
  botSetupWires,
  type BotSetupEntry,
} from "./bot-setup-thread.js";

function entry(patch: Partial<BotSetupEntry> = {}): BotSetupEntry {
  return {
    agentUid: "agt_01LEDGER",
    kind: "cloud",
    name: "Ledger",
    email: null,
    companySlug: "indigo",
    companyUid: "cmp_indigo",
    rowId: "dm:agt_01LEDGER",
    channelId: null,
    createdAt: Date.parse("2026-10-02T12:00:00Z"),
    online: false,
    access: { state: "pending", level: "read" },
    ...patch,
  };
}

describe("bot setup thread", () => {
  it("a cloud bot greets, asks for access with the existing access-request card, and asks for skills", () => {
    const wires = botSetupWires(entry());
    expect(wires.every((w) => w.fromPersonUid === "agt_01LEDGER" && w.direction === "in")).toBe(true);
    expect(wires[0]!.body).toBe(
      "Hi, I'm Ledger. Two things before I start: grant me access to the company context, and pick my skills.",
    );
    const card = parseShareRequestEvent(wires[1]!.systemEvent);
    expect(card).toMatchObject({ kind: "access_request", path: "knowledge/", level: "read", state: "pending", requestedBy: "Ledger" });
    expect(card?.id).toBe(botSetupCardId("agt_01LEDGER"));
    expect(wires.some((w) => w.body?.startsWith("Pick my skills"))).toBe(true);
    expect(wires.some((w) => w.body?.startsWith("Verified"))).toBe(false);
  });

  it("a local bot never asks for access: no card, no grant lines, no skills line, a plain hello", () => {
    // Picking the company in New bot is the grant; a local bot runs with the
    // person's own access. Any access state it carries changes nothing.
    for (const access of [
      { state: "pending", level: "read" },
      { state: "approved", level: "write" },
      { state: "denied", level: "read" },
    ] as const) {
      const wires = botSetupWires(entry({ kind: "local", access }));
      expect(wires.map((w) => w.body)).toEqual(["Hi, I'm Ledger. I'll ask a few quick questions to finish my setup."]);
      expect(wires.some((w) => w.systemEvent)).toBe(false);
      expect(wires.some((w) => w.eventId === botSetupCardId("agt_01LEDGER"))).toBe(false);
      expect(JSON.stringify(wires)).not.toMatch(/access|grant|hq files share|Pick my skills/i);
    }
    expect(botSetupWires(entry({ kind: "local", online: true })).map((w) => w.body)).toEqual([
      "Hi, I'm Ledger. I'll ask a few quick questions to finish my setup.",
      "Verified, I'm ready. Send me a first task here.",
    ]);
    expect(botSetupAsksAccess({ kind: "local" })).toBe(false);
    expect(botSetupAsksAccess({ kind: "cloud" })).toBe(true);
  });

  it("answers an approval with the real share command and never an agent uid as the grantee", () => {
    const approved = botSetupWires(entry({ access: { state: "approved", level: "write" } }));
    const grant = approved.find((w) => w.eventId.endsWith(":grant"))!;
    expect(grant.prompt).toBe("hq files share knowledge/ --with <bot email> --permission write --company indigo");
    expect(grant.prompt).not.toContain("agt_");
    expect(botSetupShareCommand(entry({ email: "ledger@indigo.hq.computer" }))).toContain("--with ledger@indigo.hq.computer --permission read");
    const denied = botSetupWires(entry({ access: { state: "denied", level: "read" } }));
    expect(denied.find((w) => w.eventId.endsWith(":grant"))?.prompt).toBeUndefined();
  });

  it("says it is verified once online", () => {
    const wires = botSetupWires(entry({ online: true }));
    expect(wires.at(-1)!.body).toBe("Verified, I'm ready. Send me a first task here.");
  });

  it("matches its own thread and recognises its own card ids", () => {
    expect(botSetupMatchesRow(entry(), { id: "dm:agt_01LEDGER" })).toBe(true);
    expect(botSetupMatchesRow(entry({ rowId: null, channelId: "chn_1" }), { id: "x", channelId: "chn_1" })).toBe(true);
    expect(botSetupMatchesRow(entry(), { id: "dm:agt_other" })).toBe(false);
    expect(botSetupUidFromCardId(botSetupCardId("agt_01LEDGER"))).toBe("agt_01LEDGER");
    expect(botSetupUidFromCardId("card_123")).toBeNull();
  });

  it("never carries a secret or enroll value", () => {
    const text = JSON.stringify(botSetupWires(entry({ online: true, access: { state: "approved", level: "read" } })));
    expect(text).not.toMatch(/sk_live_|rk_live_|enroll_[A-Za-z0-9]{8}/);
  });
});
