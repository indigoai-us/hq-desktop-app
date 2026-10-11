/**
 * The assistant's one owner (assistant-owner.ts), and the rules that come
 * with it: one name lookup that never shows a handle or slug, start and error
 * state worked out from the bot list, one operation at a time, and the CLI
 * version gate. Regression coverage for the architecture review of
 * 2026-10-11 (findings 1, 3, 4 and 6).
 */
import { describe, expect, it, vi } from "vitest";
import type { LocalBotRow } from "@hq/platform";

import {
  ASSISTANT_CLI_MIN_VERSION,
  ASSISTANT_FALLBACK_NAME,
  assistantName,
  assistantStatus,
  cliOwnsAssistantCreate,
  createAssistantOwner,
  isAssistantAlreadyThere,
  personFacingAgentName,
  withAssistantNames,
  type AssistantCreateResult,
  type AssistantOwnerHost,
} from "./assistant-owner.js";

const UID = "agt_assistant";

function row(over: Partial<LocalBotRow> & { role?: string } = {}): LocalBotRow {
  return {
    name: "setup",
    agentUid: UID,
    ownerUid: "prs_me",
    runtime: "claude",
    state: "running",
    pid: 1,
    processAlive: true,
    online: true,
    lastHeartbeatAt: null,
    daemonInstalled: true,
    daemonLoaded: true,
    dir: "/tmp/.hq/bots/setup",
    ...over,
  } as LocalBotRow;
}

/** A host whose bot list is `list` and whose calls are spies. */
function host(over: Partial<AssistantOwnerHost> & { list?: () => LocalBotRow[] } = {}) {
  let rows: LocalBotRow[] = [];
  const list = over.list ?? (() => rows);
  const base = {
    refreshLocal: vi.fn(async () => list()),
    runtime: vi.fn(async () => "claude" as const),
    cliOwnsCreate: vi.fn(async () => false),
    create: vi.fn(async (): Promise<AssistantCreateResult> => {
      rows = [row()];
      return { ok: true, agentUid: UID, outcome: null };
    }),
    adopt: vi.fn(async () => {
      rows = [row()];
      return { ok: true as const };
    }),
    rename: vi.fn(async () => undefined),
    findCloud: vi.fn(async () => null),
    copy: {
      noRuntime: () => "HQ needs a coding tool signed in on this computer to finish setup.",
      unavailable: "unavailable",
      alreadyElsewhere: "elsewhere",
      couldNotStart: (name: string | null) => (name ? `Couldn't start ${name}. Try again in a moment.` : "generic"),
    },
    cloudAssistant: undefined as (() => { ref: { agentUid: string; handle: string }; adoptable: boolean } | null) | undefined,
  };
  const h = { ...base, ...over } as typeof base;
  return { h, setRows: (next: LocalBotRow[]) => (rows = next) };
}

describe("one name lookup (finding 3)", () => {
  it("never returns the handle or the cloud slug, and falls back to Your assistant", () => {
    expect(assistantName({})).toBe(ASSISTANT_FALLBACK_NAME);
    expect(assistantName({ listed: "setup", cloud: "setup-rg13gzm4", cached: " Setup " })).toBe("Your assistant");
    expect(assistantName({ listed: "setup", cached: "Hazel" })).toBe("Hazel");
  });

  it("puts the name the person confirmed first, then the cloud name", () => {
    expect(assistantName({ confirmed: "Hazel", listed: "Popcorn", cloud: "Popcorn", cached: "Popcorn" })).toBe("Hazel");
    // An older hq-cli lists its own config file, which can hold yesterday's
    // name: the cloud name and this computer's copy come before it.
    expect(assistantName({ listed: "Popcorn", cached: "Hazel" })).toBe("Hazel");
    expect(assistantName({ listed: "Popcorn", cloud: "Hazel" })).toBe("Hazel");
    // A new enough hq-cli lists the cloud name: it wins over the cache.
    expect(assistantName({ listed: "Hazel", cached: "Popcorn", listIsCloudName: true })).toBe("Hazel");
  });

  it("maps only the assistant's handle or slug when all a surface has is a sender name", () => {
    expect(personFacingAgentName("setup")).toBe("Your assistant");
    expect(personFacingAgentName("setup-ab12cd34")).toBe("Your assistant");
    expect(personFacingAgentName("Scout")).toBe("Scout");
  });

  it("renames the assistant's rows by uid, and any agent row still named by the slug", () => {
    const rows = [
      { personUid: UID, displayName: "setup" },
      { personUid: "agt_other_setup", displayName: "setup" },
      { personUid: "agt_marked", displayName: "", agentRole: "assistant" },
      { personUid: "agt_scout", displayName: "Scout" },
      { personUid: "prs_setup", displayName: "setup" },
    ];
    const out = withAssistantNames(rows, { agentUid: UID, name: "Hazel" }, "personUid", "displayName");
    expect(out.map((r) => r.displayName)).toEqual(["Hazel", "Your assistant", "Your assistant", "Scout", "setup"]);
    // Untouched rows are the same objects.
    expect(out[3]).toBe(rows[3]);
    const none = [{ personUid: "agt_scout", displayName: "Scout" }];
    expect(withAssistantNames(none, null, "personUid", "displayName")).toBe(none);
  });
});

describe("start and error state come from the bot list (finding 4)", () => {
  it("is never failed while the assistant is in the list, whatever the last attempt said", () => {
    const here = { agentUid: UID, handle: "setup" };
    const failed = { state: "failed" as const, name: "Hazel", reason: "Couldn't start Hazel. Try again in a moment." };
    expect(assistantStatus(failed, here)).toEqual({ state: "ready", bot: here });
    expect(assistantStatus(failed, null)).toEqual({ state: "failed", name: "Hazel", reason: failed.reason });
    expect(assistantStatus({ state: "idle" }, null)).toEqual({ state: "absent" });
    expect(assistantStatus({ state: "running", name: "Hazel" }, null)).toEqual({ state: "starting", name: "Hazel" });
  });
});

describe("the version gate", () => {
  it("counts every CLI as older until the release is known, and unknown versions as older", () => {
    expect(ASSISTANT_CLI_MIN_VERSION).toBeNull();
    expect(cliOwnsAssistantCreate("9.9.9")).toBe(false);
    expect(cliOwnsAssistantCreate("5.346.0", "5.346.0")).toBe(true);
    expect(cliOwnsAssistantCreate("5.347.1", "5.346.0")).toBe(true);
    expect(cliOwnsAssistantCreate("5.345.85", "5.346.0")).toBe(false);
    expect(cliOwnsAssistantCreate(null, "5.346.0")).toBe(false);
    expect(cliOwnsAssistantCreate("dev", "5.346.0")).toBe(false);
  });
});

describe("the owner", () => {
  it("treats hq-cli's 'already set up on this computer' as the assistant being here (finding 1)", () => {
    expect(
      isAssistantAlreadyThere(
        'Bot "setup" is already set up on this computer (/Users/admin/.hq/bots/setup). Start it with: hq bot start setup',
      ),
    ).toBe(true);
    expect(isAssistantAlreadyThere('HQ API /v1/agents → 409: Entity with type="agent" already exists')).toBe(true);
    expect(isAssistantAlreadyThere("Claude Code is not signed in.")).toBe(false);
  });

  it("a create that loses to another writer ends as the assistant, named, with no error", async () => {
    const { h, setRows } = host();
    h.create.mockImplementation(async () => {
      // The other writer got there first; the old CLI's create refuses.
      setRows([row({ displayName: "Popcorn" })]);
      return {
        ok: false,
        reason: "Could not create setup.",
        raw: 'Bot "setup" is already set up on this computer (/Users/admin/.hq/bots/setup).',
      };
    });
    const changes: string[] = [];
    const owner = createAssistantOwner({ ...h, onchange: (a) => changes.push(a.state) });
    const result = await owner.start({ name: "Hazel" });
    expect(result).toEqual({ ok: true, bot: { agentUid: UID, handle: "setup" }, outcome: "existing" });
    expect(h.rename).toHaveBeenCalledWith({ agentUid: UID, handle: "setup" }, "Hazel");
    expect(changes).toEqual(["running", "done"]);
    expect(owner.attempt().state).toBe("done");
  });

  it("runs one operation at a time: two starts at once make one create, and both get the assistant", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { h, setRows } = host();
    h.create.mockImplementation(async () => {
      await gate;
      setRows([row()]);
      return { ok: true, agentUid: UID, outcome: null };
    });
    const owner = createAssistantOwner(h);
    const first = owner.start({ name: "Hazel" });
    const second = owner.start({ nameIfNew: "Pickles" });
    const recovered = owner.recover();
    expect(owner.busy()).toBe(true);
    release();
    const [a, b, c] = await Promise.all([first, second, recovered]);
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.create).toHaveBeenCalledWith("Hazel", "claude");
    expect(a).toMatchObject({ ok: true, outcome: "created" });
    expect(b).toMatchObject({ ok: true, outcome: "existing" });
    expect(c).toMatchObject({ ok: true, outcome: "existing" });
    // The second caller had no name of its own to apply.
    expect(h.rename).not.toHaveBeenCalled();
    expect(h.adopt).not.toHaveBeenCalled();
    expect(owner.busy()).toBe(false);
  });

  it("trusts only the bot list between operations: a bot that left the list is not assumed here", async () => {
    let rows: LocalBotRow[] = [];
    const { h } = host({ list: () => rows });
    h.create.mockImplementation(async () => {
      rows = [row()];
      return { ok: true, agentUid: UID, outcome: null };
    });
    const owner = createAssistantOwner(h);
    expect(await owner.start({ name: "Hazel" })).toMatchObject({ ok: true, outcome: "created" });
    // The bot was removed (or the list says it is gone): recovery adopts it
    // again instead of answering from memory.
    rows = [];
    h.adopt.mockImplementation(async () => {
      rows = [row()];
      return { ok: true as const };
    });
    expect(await owner.recover()).toMatchObject({ ok: true, outcome: "adopted" });
    expect(h.adopt).toHaveBeenCalledTimes(1);
    // A start after the list lost it again creates; it does not answer "existing" from memory.
    rows = [];
    await owner.start({ nameIfNew: "Pickles" });
    expect(h.create).toHaveBeenCalledTimes(2);
  });

  it("an older CLI names an assistant that is already here through the app; a newer one through create", async () => {
    const older = host();
    older.setRows([row()]);
    const ownerOld = createAssistantOwner(older.h);
    await ownerOld.start({ name: "Hazel" });
    expect(older.h.create).not.toHaveBeenCalled();
    expect(older.h.rename).toHaveBeenCalledWith({ agentUid: UID, handle: "setup" }, "Hazel");

    const newer = host({ cliOwnsCreate: vi.fn(async () => true) });
    newer.setRows([row()]);
    newer.h.create.mockImplementation(async () => ({ ok: true, agentUid: UID, outcome: "existing" }));
    const ownerNew = createAssistantOwner(newer.h);
    expect(await ownerNew.start({ name: "Hazel" })).toMatchObject({ ok: true, outcome: "existing" });
    expect(newer.h.create).toHaveBeenCalledWith("Hazel", "claude");
    expect(newer.h.rename).not.toHaveBeenCalled();
  });

  it("never gives an assistant that is already here a picked name", async () => {
    const { h, setRows } = host();
    setRows([row({ displayName: "Hazel" })]);
    const owner = createAssistantOwner(h);
    await owner.start({ nameIfNew: "Pickles" });
    expect(h.rename).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
  });

  it("brings back the account's assistant as it is when nobody chose a name", async () => {
    const { h } = host({ cloudAssistant: () => ({ ref: { agentUid: UID, handle: "setup" }, adoptable: true }) });
    const owner = createAssistantOwner(h);
    const result = await owner.start({ nameIfNew: "Pickles" });
    expect(result).toMatchObject({ ok: true, outcome: "adopted" });
    expect(h.adopt).toHaveBeenCalledWith("setup");
    expect(h.create).not.toHaveBeenCalled();
  });

  it("recover adopts only when the assistant is not here", async () => {
    const { h, setRows } = host();
    const owner = createAssistantOwner(h);
    expect(await owner.recover()).toMatchObject({ ok: true, outcome: "adopted" });
    setRows([row()]);
    expect(await owner.recover()).toMatchObject({ ok: true, outcome: "existing" });
    expect(h.adopt).toHaveBeenCalledTimes(1);
  });

  it("a real failure is a sentence, and the next start clears it", async () => {
    const { h, setRows } = host();
    h.create.mockImplementationOnce(async () => ({ ok: false, reason: "Claude Code is not signed in." }));
    const owner = createAssistantOwner(h);
    expect(await owner.start({ name: "Hazel" })).toEqual({ ok: false, reason: "Claude Code is not signed in." });
    expect(assistantStatus(owner.attempt(), null)).toMatchObject({ state: "failed" });
    // The bot turns up (any path): nothing says it could not start.
    setRows([row()]);
    expect(assistantStatus(owner.attempt(), { agentUid: UID, handle: "setup" }).state).toBe("ready");
  });

  it("no coding tool: says so, unless the assistant is already here", async () => {
    const { h, setRows } = host({ runtime: vi.fn(async () => null) });
    const owner = createAssistantOwner(h);
    expect(await owner.start({ name: "Hazel" })).toMatchObject({ ok: false, reason: expect.stringContaining("coding tool") });
    setRows([row()]);
    expect(await owner.start({ name: "Hazel" })).toMatchObject({ ok: true, outcome: "existing" });
  });

  it("a host that throws ends as a written sentence, never a stack", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { h } = host();
    h.create.mockImplementation(async () => {
      throw new Error("boom");
    });
    const owner = createAssistantOwner(h);
    expect(await owner.start({ name: "Hazel" })).toEqual({ ok: false, reason: "Couldn't start Hazel. Try again in a moment." });
    warn.mockRestore();
  });

  it("never takes an assistant that is running on another computer: it is opened, not adopted or created", async () => {
    const { h } = host({ cloudAssistant: () => ({ ref: { agentUid: UID, handle: "setup" }, adoptable: false }) });
    const owner = createAssistantOwner(h);
    expect(await owner.start({ nameIfNew: "Pickles" })).toEqual({
      ok: true,
      bot: { agentUid: UID, handle: "setup" },
      outcome: "existing",
    });
    expect(h.adopt).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
    expect(h.rename).not.toHaveBeenCalled();
  });

  it("says it is busy from the moment an operation is queued until the last one ends", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const busy: boolean[] = [];
    const { h } = host({ onbusy: (b: boolean) => busy.push(b) } as never);
    h.create.mockImplementation(async () => {
      await gate;
      return { ok: true, agentUid: UID, outcome: null };
    });
    const owner = createAssistantOwner(h);
    const a = owner.start({ name: "Hazel" });
    const b = owner.recover();
    expect(busy).toEqual([true]);
    release();
    await Promise.all([a, b]);
    expect(busy).toEqual([true, false]);
  });

  it("an assistant only the cloud roster shows is opened but not remembered as being here", async () => {
    const { h } = host({ findCloud: vi.fn(async () => ({ agentUid: UID, handle: "setup" })) });
    const owner = createAssistantOwner(h);
    expect(await owner.start({ nameIfNew: "Pickles" })).toMatchObject({ ok: true, outcome: "existing" });
    expect(h.create).not.toHaveBeenCalled();
    // A later start with a chosen name still brings it here.
    h.findCloud.mockResolvedValue(null);
    await owner.start({ name: "Hazel" });
    expect(h.create).toHaveBeenCalledWith("Hazel", "claude");
  });

  it("exclusive writes wait for the operation in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { h } = host();
    const order: string[] = [];
    h.create.mockImplementation(async () => {
      await gate;
      order.push("create finished");
      return { ok: true, agentUid: UID, outcome: null };
    });
    const owner = createAssistantOwner(h);
    const start = owner.start({ name: "Hazel" });
    const write = owner.exclusive(async () => order.push("adopt"));
    await Promise.resolve();
    expect(order).toEqual([]);
    release();
    await Promise.all([start, write]);
    expect(order).toEqual(["create finished", "adopt"]);
  });
});
