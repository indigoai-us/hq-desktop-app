// A pick on the team card runs the right runner, replies to the setup bot once
// with an idempotency key, and settles; a failure is a plain sentence.

import { describe, expect, it, vi } from "vitest";

import {
  createTeamCardReplies,
  runTeamCardPick,
  teamCardIdempotencyKey,
  teamCardLockName,
  teamCardResume,
  teamCardStoredLast,
  TEAM_CARD_FAILURE,
} from "./team-card-pick";
import { saveTeamCardCreating, saveTeamCardReplyFailures, saveTeamCardUnsentCreate } from "./team-card-record";

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
    // A create that throws may still have made the company: its outcome stays unknown.
    expect(result).toEqual({ ok: false, reason: TEAM_CARD_FAILURE, creating: true });
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
      replyFailures: 1,
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

describe("a create whose reply fails", () => {
  const created = {
    kind: "company" as const,
    how: "created" as const,
    company: { companyUid: "cmp_new", slug: "pickle", name: "Pickle" },
  };

  it("keeps the created company before the reply is sent", async () => {
    const d = deps();
    const order: string[] = [];
    const kept = vi.fn(() => void order.push("created"));
    d.reply.mockImplementation(() => void order.push("reply"));
    await runTeamCardPick({ kind: "create", name: "Pickle" }, { ...d, created: kept });
    expect(kept).toHaveBeenCalledWith(created);
    expect(order).toEqual(["created", "reply"]);
  });

  it("a failure to keep it still sends the reply and settles", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const d = deps();
    const result = await runTeamCardPick(
      { kind: "create", name: "Pickle" },
      {
        ...d,
        created: () => {
          throw new Error("quota");
        },
      },
    );
    expect(d.reply).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ ok: true, settled: "Created Pickle" });
  });

  it("join, open and Just me keep nothing", async () => {
    const d = deps();
    const kept = vi.fn();
    await runTeamCardPick({ kind: "invite", company: acme }, { ...d, created: kept });
    await runTeamCardPick({ kind: "existing", company: acme }, { ...d, created: kept });
    await runTeamCardPick({ kind: "personal" }, { ...d, created: kept });
    expect(kept).not.toHaveBeenCalled();
  });

  it("returns the created company, and a press with another name resends its reply without creating again", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const d = deps();
    d.reply.mockImplementationOnce(() => {
      throw new Error("send failed");
    });
    const first = await runTeamCardPick({ kind: "create", name: "Pickle" }, d);
    expect(first).toEqual({ ok: false, reason: TEAM_CARD_FAILURE, completed: created, replyFailures: 1 });

    const run = teamCardResume({ kind: "create", name: "Brine" }, { pick: { kind: "create", name: "Pickle" }, completed: created });
    const second = await runTeamCardPick(run.pick, { ...d, completed: run.completed });
    expect(d.create).toHaveBeenCalledOnce();
    expect(d.reply).toHaveBeenLastCalledWith("I created Pickle.", "first-run-team:agt_setup:create:pickle");
    expect(second).toMatchObject({ ok: true, settled: "Created Pickle" });
  });
});

describe("teamCardResume", () => {
  const created = {
    kind: "company" as const,
    how: "created" as const,
    company: { companyUid: "cmp_new", slug: "pickle", name: "Pickle" },
  };
  const joined = { kind: "company" as const, how: "joined" as const, company: acme };

  it("nothing done yet: runs the press as it is", () => {
    expect(teamCardResume({ kind: "create", name: "Brine" }, null)).toEqual({ pick: { kind: "create", name: "Brine" } });
    expect(teamCardResume({ kind: "personal" }, { pick: { kind: "create", name: "Pickle" } })).toEqual({
      pick: { kind: "personal" },
    });
  });

  it("a created company wins over any press: another name, another row, or Just me", () => {
    const last = { pick: { kind: "create" as const, name: "Pickle" }, completed: created };
    for (const press of [
      { kind: "create" as const, name: "Brine" },
      { kind: "invite" as const, company: acme },
      { kind: "existing" as const, company: acme },
      { kind: "personal" as const },
    ]) {
      expect(teamCardResume(press, last)).toEqual({ pick: { kind: "create", name: "Pickle" }, completed: created });
    }
  });

  it("a failed join reply is resent for the same row only", () => {
    const last = { pick: { kind: "invite" as const, company: acme }, completed: joined };
    expect(teamCardResume({ kind: "invite", company: acme }, last)).toEqual({ pick: last.pick, completed: joined });
    expect(teamCardResume({ kind: "personal" }, last)).toEqual({ pick: { kind: "personal" } });
  });
});

describe("a create whose outcome is unknown", () => {
  const pickle = { companyUid: "cmp_pickle", slug: "pickle", name: "Pickle" };
  const created = { kind: "company" as const, how: "created" as const, company: pickle };

  it("is kept before it is sent", async () => {
    const d = deps();
    const order: string[] = [];
    const creating = vi.fn(() => void order.push("creating"));
    d.create.mockImplementation(async (name: string) => {
      order.push("create");
      return { ok: true as const, choice: { kind: "company" as const, how: "created" as const, company: { ...pickle, name } } };
    });
    await runTeamCardPick({ kind: "create", name: "Pickle" }, { ...d, creating });
    expect(creating).toHaveBeenCalledWith({ name: "Pickle", slug: "pickle" });
    expect(order).toEqual(["creating", "create"]);
  });

  it("a failure that may have made the company stays unknown; a refusal clears it", async () => {
    const notCreating = vi.fn();
    const unknown = deps({ create: vi.fn(async () => ({ ok: false, reason: "No answer." })) });
    expect(await runTeamCardPick({ kind: "create", name: "Pickle" }, { ...unknown, notCreating })).toEqual({
      ok: false,
      reason: "No answer.",
      creating: true,
    });
    expect(notCreating).not.toHaveBeenCalled();

    const refused = deps({ create: vi.fn(async () => ({ ok: false, reason: "That handle is taken.", blocked: true })) });
    expect(await runTeamCardPick({ kind: "create", name: "Pickle" }, { ...refused, notCreating })).toEqual({
      ok: false,
      reason: "That handle is taken.",
    });
    expect(notCreating).toHaveBeenCalledOnce();
  });

  it("the next press looks for the company first and keeps it as created, without creating", async () => {
    const d = deps();
    const findCreated = vi.fn(async () => pickle);
    const kept = vi.fn();
    const run = teamCardResume({ kind: "create", name: "Brine" }, { pick: { kind: "create", name: "Pickle" }, creating: true });
    expect(run).toEqual({ pick: { kind: "create", name: "Pickle" }, unresolved: true });
    const result = await runTeamCardPick(run.pick, { ...d, host: { ...d.host, findCreated }, unresolved: true, created: kept });
    expect(findCreated).toHaveBeenCalledWith("Pickle");
    expect(d.create).not.toHaveBeenCalled();
    expect(d.pin).toHaveBeenCalledWith("cmp_pickle");
    expect(kept).toHaveBeenCalledWith(created);
    expect(d.reply).toHaveBeenCalledWith("I created Pickle.", "first-run-team:agt_setup:create:pickle");
    expect(result).toMatchObject({ ok: true, settled: "Created Pickle" });
  });

  it("not found within the bound: creates the same name again", async () => {
    const d = deps();
    const creating = vi.fn();
    const host = { ...d.host, findCreated: vi.fn(async () => null) };
    const result = await runTeamCardPick({ kind: "create", name: "Pickle" }, { ...d, host, unresolved: true, creating });
    expect(d.create).toHaveBeenCalledWith("Pickle");
    expect(creating).toHaveBeenCalledWith({ name: "Pickle", slug: "pickle" });
    expect(result).toMatchObject({ ok: true, settled: "Created Pickle" });
  });

  it("not found, then refused: the slug may be that company's, so the card stays on it and looks again", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const create = vi.fn(async () => ({ ok: false, reason: "That handle is taken.", blocked: true }));
    const d = deps({ create });
    const notCreating = vi.fn();
    const findCreated = vi.fn(async () => null);
    const host = { ...d.host, findCreated };
    const result = await runTeamCardPick({ kind: "create", name: "Pickle" }, { ...d, host, unresolved: true, notCreating });
    expect(result).toEqual({ ok: false, reason: TEAM_CARD_FAILURE, creating: true, refused: true });
    expect(notCreating).not.toHaveBeenCalled();
    // Looked before the create and again after the refusal.
    expect(findCreated).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledOnce();
  });

  it("refused, then found on the look after it: kept as created", async () => {
    const d = deps({ create: vi.fn(async () => ({ ok: false, reason: "That handle is taken.", blocked: true })) });
    const findCreated = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(pickle);
    const kept = vi.fn();
    const result = await runTeamCardPick(
      { kind: "create", name: "Pickle" },
      { ...d, host: { ...d.host, findCreated }, unresolved: true, created: kept },
    );
    expect(kept).toHaveBeenCalledWith(created);
    expect(result).toMatchObject({ ok: true, settled: "Created Pickle" });
  });

  it("once refused, a press only looks: another name never creates", async () => {
    const d = deps();
    const notCreating = vi.fn();
    const last = { pick: { kind: "create" as const, name: "Pickle" }, creating: true, refused: true };
    const run = teamCardResume({ kind: "create", name: "Brine" }, last);
    expect(run).toEqual({ pick: { kind: "create", name: "Pickle" }, unresolved: true, refused: true });

    const missing = { ...d.host, findCreated: vi.fn(async () => null) };
    expect(await runTeamCardPick(run.pick, { ...d, host: missing, unresolved: true, refused: true, notCreating })).toEqual({
      ok: false,
      reason: TEAM_CARD_FAILURE,
      creating: true,
      refused: true,
    });
    expect(d.create).not.toHaveBeenCalled();
    expect(notCreating).not.toHaveBeenCalled();

    const found = { ...d.host, findCreated: vi.fn(async () => pickle) };
    const result = await runTeamCardPick(run.pick, { ...d, host: found, unresolved: true, refused: true });
    expect(d.create).not.toHaveBeenCalled();
    expect(d.reply).toHaveBeenCalledWith("I created Pickle.", "first-run-team:agt_setup:create:pickle");
    expect(result).toMatchObject({ ok: true, settled: "Created Pickle" });
  });

  it("a company the host found on retry is kept as created", async () => {
    const d = deps({ create: vi.fn(async () => ({ ok: true, choice: { kind: "company", how: "existing", company: pickle } })) });
    const kept = vi.fn();
    const result = await runTeamCardPick({ kind: "create", name: "Pickle" }, { ...d, created: kept });
    expect(kept).toHaveBeenCalledWith(created);
    expect(result).toMatchObject({ ok: true, settled: "Created Pickle", choice: created });
  });

  it("the lock name follows a made company, then an unknown create, and nothing else", () => {
    expect(teamCardLockName({ pick: { kind: "create", name: "Brine" }, completed: created })).toBe("Pickle");
    expect(teamCardLockName({ pick: { kind: "create", name: "Pickle" }, creating: true })).toBe("Pickle");
    expect(teamCardLockName({ pick: { kind: "create", name: "Pickle" } })).toBeNull();
    expect(teamCardLockName({ pick: { kind: "personal" } })).toBeNull();
    expect(teamCardLockName(null)).toBeNull();
  });

  it("storage after a restart reads as a made company or an unknown create", () => {
    const data = new Map<string, string>();
    const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
    expect(teamCardStoredLast(storage, "me:bot")).toBeNull();
    saveTeamCardCreating(storage, "me:bot", { name: "Pickle", slug: "pickle" });
    expect(teamCardStoredLast(storage, "me:bot")).toEqual({ pick: { kind: "create", name: "Pickle" }, creating: true });
    saveTeamCardUnsentCreate(storage, "me:bot", { created: pickle, name: "Pickle" });
    expect(teamCardStoredLast(storage, "me:bot")).toEqual({ pick: { kind: "create", name: "Pickle" }, completed: created });
  });

  it("storage after a restart keeps the failed sends of a made company's reply", () => {
    const data = new Map<string, string>();
    const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
    saveTeamCardUnsentCreate(storage, "me:bot", { created: pickle, name: "Pickle" });
    expect(saveTeamCardReplyFailures(storage, "me:bot", 2)).toBe(true);
    expect(teamCardStoredLast(storage, "me:bot")).toEqual({
      pick: { kind: "create", name: "Pickle" },
      completed: created,
      replyFailures: 2,
    });
  });
});

describe("a reply that keeps failing", () => {
  it("settles after the first try and two Retries, and logs it once", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const d = deps();
    d.reply.mockImplementation(() => {
      throw new Error("send failed");
    });
    const log = vi.fn();
    const first = await runTeamCardPick({ kind: "personal" }, { ...d, log });
    expect(first).toMatchObject({ ok: false, replyFailures: 1 });
    const second = await runTeamCardPick({ kind: "personal" }, { ...d, log, replyFailures: 1, completed: { kind: "personal" } });
    expect(second).toMatchObject({ ok: false, replyFailures: 2 });
    expect(log).not.toHaveBeenCalled();
    const third = await runTeamCardPick({ kind: "personal" }, { ...d, log, replyFailures: 2, completed: { kind: "personal" } });
    expect(third).toEqual({ ok: true, settled: "Working solo", choice: { kind: "personal" } });
    expect(log).toHaveBeenCalledWith("kind=team-card event=reply-abandoned");
    expect(d.reply).toHaveBeenCalledTimes(3);
  });

  it("the failure count carries over a resumed press", () => {
    const created = { kind: "company" as const, how: "created" as const, company: acme };
    expect(teamCardResume({ kind: "personal" }, { pick: { kind: "create", name: "Acme" }, completed: created, replyFailures: 2 })).toEqual({
      pick: { kind: "create", name: "Acme" },
      completed: created,
      replyFailures: 2,
    });
  });
});
