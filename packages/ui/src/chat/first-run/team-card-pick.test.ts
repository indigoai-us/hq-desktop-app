// A pick on the team card runs the right runner, replies to the setup bot once
// with an idempotency key, and settles; a failure is a plain sentence.

import { describe, expect, it, vi } from "vitest";

import { createTeamCardReplies, runTeamCardPick, teamCardIdempotencyKey, TEAM_CARD_FAILURE } from "./team-card-pick";

const acme = { companyUid: "cmp_acme", slug: "acme", name: "Acme" };

function deps(overrides: Partial<{ join: unknown; create: unknown }> = {}) {
  const join = vi.fn(async () => ({ ok: true as const, choice: { kind: "company" as const, how: "joined" as const, company: acme } }));
  const create = vi.fn(async (name: string) => ({
    ok: true as const,
    choice: { kind: "company" as const, how: "created" as const, company: { companyUid: "cmp_new", slug: "pickle", name } },
  }));
  const host = { join: (overrides.join ?? join) as typeof join, create: (overrides.create ?? create) as typeof create };
  const pin = vi.fn();
  const reply = vi.fn();
  return { host, agentUid: "agt_setup", pin, reply, join, create };
}

describe("runTeamCardPick", () => {
  it("invite: joins, replies once with a key, settles as Joined", async () => {
    const d = deps();
    const result = await runTeamCardPick({ kind: "invite", company: acme }, d);
    expect(d.join).toHaveBeenCalledWith(acme);
    expect(d.reply).toHaveBeenCalledOnce();
    expect(d.reply).toHaveBeenCalledWith("I joined Acme.", "first-run-team:agt_setup:invite:acme");
    expect(result).toMatchObject({ ok: true, settled: "Joined Acme" });
  });

  it("create: creates with the typed name and settles as Created", async () => {
    const d = deps();
    const result = await runTeamCardPick({ kind: "create", name: "Pickle" }, d);
    expect(d.create).toHaveBeenCalledWith("Pickle");
    expect(d.reply).toHaveBeenCalledWith("I created Pickle.", "first-run-team:agt_setup:create:pickle");
    expect(result).toMatchObject({ ok: true, settled: "Created Pickle" });
  });

  it("existing: pins the company and settles as Opened", async () => {
    const d = deps();
    const result = await runTeamCardPick({ kind: "existing", company: acme }, d);
    expect(d.pin).toHaveBeenCalledWith("cmp_acme");
    expect(d.join).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, settled: "Opened Acme" });
  });

  it("personal: runs nothing and settles as Working solo", async () => {
    const d = deps();
    const result = await runTeamCardPick({ kind: "personal" }, d);
    expect(d.join).not.toHaveBeenCalled();
    expect(d.create).not.toHaveBeenCalled();
    expect(d.reply).toHaveBeenCalledWith("Just me for now.", "first-run-team:agt_setup:personal");
    expect(result).toMatchObject({ ok: true, settled: "Working solo" });
  });

  it("a failed join is the runner's plain sentence, and nothing is sent to the bot", async () => {
    const d = deps({ join: vi.fn(async () => ({ ok: false, reason: "Couldn't join the company. Try again." })) });
    const result = await runTeamCardPick({ kind: "invite", company: acme }, d);
    expect(result).toEqual({ ok: false, reason: "Couldn't join the company. Try again." });
    expect(d.reply).not.toHaveBeenCalled();
  });

  it("a create's key names its company, so another name is another reply", () => {
    const key = (name: string) => teamCardIdempotencyKey({ kind: "create", name }, "agt_setup");
    expect(key("Pickle Works")).toBe("first-run-team:agt_setup:create:pickle-works");
    expect(key("Pickle Works")).not.toBe(key("Brine Labs"));
    expect(teamCardIdempotencyKey({ kind: "personal" }, "agt_other")).toBe("first-run-team:agt_other:personal");
  });

  it("a runner that throws never shows the raw error", async () => {
    const d = deps({ create: vi.fn(async () => Promise.reject(new Error("ECONNRESET 502 at create_company"))) });
    const result = await runTeamCardPick({ kind: "create", name: "Pickle" }, d);
    expect(result).toEqual({ ok: false, reason: TEAM_CARD_FAILURE });
    expect(d.reply).not.toHaveBeenCalled();
  });

  it("a failed reply is a plain sentence and hands back the finished choice", async () => {
    const d = deps();
    d.reply.mockRejectedValueOnce(new Error("send failed"));
    const result = await runTeamCardPick({ kind: "invite", company: acme }, d);
    expect(result).toEqual({
      ok: false,
      reason: TEAM_CARD_FAILURE,
      completed: { kind: "company", how: "joined", company: acme },
    });
  });

  it("a retry with the finished choice resends the reply without joining again", async () => {
    const d = deps();
    const completed = { kind: "company" as const, how: "joined" as const, company: acme };
    const result = await runTeamCardPick({ kind: "invite", company: acme }, { ...d, completed });
    expect(d.join).not.toHaveBeenCalled();
    expect(d.reply).toHaveBeenCalledWith("I joined Acme.", "first-run-team:agt_setup:invite:acme");
    expect(result).toMatchObject({ ok: true, settled: "Joined Acme" });
  });
});

describe("createTeamCardReplies", () => {
  it("sends each key once", async () => {
    const send = vi.fn(async () => undefined);
    const reply = createTeamCardReplies(send);
    await reply("Just me for now.", "first-run-team:personal", "agt_setup");
    await reply("Just me for now.", "first-run-team:personal", "agt_setup");
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith("Just me for now.", "first-run-team:personal", "agt_setup");
  });

  it("a failed send frees the key so the next try sends again", async () => {
    const send = vi.fn(async () => undefined);
    send.mockRejectedValueOnce(new Error("send failed"));
    const reply = createTeamCardReplies(send);
    await expect(reply("Just me for now.", "first-run-team:personal", "agt_setup")).rejects.toThrow("send failed");
    await reply("Just me for now.", "first-run-team:personal", "agt_setup");
    expect(send).toHaveBeenCalledTimes(2);
  });
});
