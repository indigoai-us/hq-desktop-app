import { beforeEach, describe, expect, it, vi } from "vitest";

import { beginWakingSession, type WakingBotSession } from "./waking-model.js";
import {
  loadWakingSessions,
  resetWakingSessionStores,
  serializeWakingSessions,
  upsertWakingSession,
  WAKING_BOTS_STORAGE_KEY,
  WAKING_SESSION_MAX_AGE_MS,
  wakingSessionCurrent,
  wakingSessionKey,
  wakingSessionStore,
  withoutWakingSession,
} from "./waking-sessions.js";

const NOW = 1_800_000_000_000;

function memoryStorage(): Pick<Storage, "getItem" | "setItem"> & { values: Map<string, string>; clear(): void } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    clear: () => values.clear(),
  };
}

function session(agentUid: string, patch: Partial<WakingBotSession> = {}): WakingBotSession {
  return {
    ...beginWakingSession({ agentUid, channelId: "", companyUid: "cmp_acme", name: agentUid.replace("agt_", ""), brain: "codex", now: Date.now() }),
    ...patch,
  };
}

beforeEach(() => {
  resetWakingSessionStores();
});

describe("one entry per bot", () => {
  it("knows a session by its bot, or by its channel when the server named no bot", () => {
    expect(wakingSessionKey({ agentUid: " agt_nova ", channelId: "chn_x" })).toBe("agt_nova");
    expect(wakingSessionKey({ agentUid: "", channelId: "chn_x" })).toBe("ch:chn_x");
    expect(wakingSessionKey({ agentUid: "", channelId: "" })).toBe("");
  });

  it("adds a second bot beside the first, and replaces only the same bot", () => {
    const nova = session("agt_nova");
    const second = session("agt_second");
    const both = upsertWakingSession([nova], second);
    expect(both.map((entry) => entry.agentUid)).toEqual(["agt_second", "agt_nova"]);
    const moved = { ...nova, progress: 40 };
    expect(upsertWakingSession(both, moved)).toEqual([second, moved]);
    expect(withoutWakingSession(both, "agt_nova")).toEqual([second]);
    expect(withoutWakingSession(both, "")).toEqual(both);
    // A session with nothing to know it by is not kept.
    expect(upsertWakingSession(both, session(""))).toEqual(both);
  });
});

describe("what is waited for", () => {
  it("is a bot that is starting, failed, or behind a signed-out app, for up to a day", () => {
    const base = session("agt_nova", { startedAt: NOW });
    expect(wakingSessionCurrent(base, NOW)).toBe(true);
    expect(wakingSessionCurrent({ ...base, phase: "failed" }, NOW)).toBe(true);
    expect(wakingSessionCurrent({ ...base, phase: "stopped", stopped: "signed-out" }, NOW)).toBe(true);
    expect(wakingSessionCurrent({ ...base, phase: "ready" }, NOW)).toBe(false);
    expect(wakingSessionCurrent({ ...base, phase: "stopped", stopped: "removed" }, NOW)).toBe(false);
    expect(wakingSessionCurrent({ ...base, phase: "stopped", stopped: "no-access" }, NOW)).toBe(false);
    expect(wakingSessionCurrent(base, NOW + WAKING_SESSION_MAX_AGE_MS)).toBe(true);
    expect(wakingSessionCurrent(base, NOW + WAKING_SESSION_MAX_AGE_MS + 1)).toBe(false);
  });
});

describe("what is written down", () => {
  const approval = { provider: "codex" as const, url: "https://auth.openai.com/codex/device", code: "TEST-CODE", capturedAt: "2026-10-04T00:00:00.000Z" };

  it("is enough to find the bot and resume the wait, and never the sign-in", () => {
    const text = serializeWakingSessions([
      session("agt_nova", { startedAt: NOW, approval, approvalSince: NOW, askedApproval: true, signedInAt: NOW + 5_000 }),
    ], NOW);
    expect(text).not.toContain("TEST-CODE");
    expect(text).not.toContain("auth.openai.com");
    expect(JSON.parse(text)).toEqual([
      {
        agentUid: "agt_nova",
        channelId: "",
        companyUid: "cmp_acme",
        name: "nova",
        brain: "codex",
        startedAt: NOW,
        estimateMs: 180_000,
        phase: "waking",
        signedInAt: NOW + 5_000,
        askedApproval: true,
        chatReadyAt: null,
        helloAskedAt: null,
      },
    ]);
  });

  it("leaves out a bot known only by channel, a live bot and a bot that is gone", () => {
    const text = serializeWakingSessions([
      session("", { channelId: "chn_x", startedAt: NOW }),
      session("agt_live", { phase: "ready", startedAt: NOW }),
      session("agt_gone", { phase: "stopped", stopped: "removed", startedAt: NOW }),
      session("agt_failed", { phase: "failed", startedAt: NOW }),
      session("agt_out", { phase: "stopped", stopped: "signed-out", startedAt: NOW }),
    ], NOW);
    expect(JSON.parse(text).map((entry: { agentUid: string; phase: string }) => [entry.agentUid, entry.phase])).toEqual([
      ["agt_failed", "failed"],
      // Resumes as a wait once the app is signed in again.
      ["agt_out", "waking"],
    ]);
  });

  it("reads back what it wrote, without a sign-in on screen", () => {
    const storage = memoryStorage();
    storage.setItem(
      WAKING_BOTS_STORAGE_KEY,
      serializeWakingSessions([session("agt_nova", { startedAt: NOW, approval, signedInAt: null, askedApproval: true })], NOW),
    );
    expect(loadWakingSessions(storage, NOW + 60_000)).toMatchObject([
      { agentUid: "agt_nova", companyUid: "cmp_acme", brain: "codex", phase: "waking", approval: null, askedApproval: true, consecutiveCheckFailures: 0 },
    ]);
  });

  it("keeps the moment the bot could chat only together with the request for its first message", () => {
    const storage = memoryStorage();
    storage.setItem(
      WAKING_BOTS_STORAGE_KEY,
      serializeWakingSessions([
        session("agt_asked", { startedAt: NOW, chatReadyAt: NOW + 1_000, helloAskedAt: NOW + 2_000 }),
        session("agt_not_asked", { startedAt: NOW, chatReadyAt: NOW + 1_000 }),
      ], NOW),
    );
    const [asked, notAsked] = loadWakingSessions(storage, NOW + 60_000);
    expect(asked).toMatchObject({ chatReadyAt: NOW + 1_000, helloAskedAt: NOW + 2_000 });
    // The wait for the first message has not begun: it begins when the screen is opened again.
    expect(notAsked).toMatchObject({ chatReadyAt: null, helloAskedAt: null });
  });

  it("reads nothing from missing or damaged storage, and skips rows it cannot use", () => {
    expect(loadWakingSessions(null)).toEqual([]);
    const storage = memoryStorage();
    expect(loadWakingSessions(storage)).toEqual([]);
    storage.setItem(WAKING_BOTS_STORAGE_KEY, "{not json");
    expect(loadWakingSessions(storage)).toEqual([]);
    storage.setItem(WAKING_BOTS_STORAGE_KEY, '{"agentUid":"agt_x"}');
    expect(loadWakingSessions(storage)).toEqual([]);
    storage.setItem(
      WAKING_BOTS_STORAGE_KEY,
      JSON.stringify([
        null,
        { agentUid: "", startedAt: NOW },
        { agentUid: "agt_no_time" },
        { agentUid: "agt_old", startedAt: NOW - WAKING_SESSION_MAX_AGE_MS - 1 },
        { agentUid: "agt_ok", startedAt: NOW, brain: "gpt", name: "" },
        { agentUid: "agt_ok", startedAt: NOW, name: "Twice" },
      ]),
    );
    expect(loadWakingSessions(storage, NOW)).toMatchObject([{ agentUid: "agt_ok", name: "Your bot", brain: null, phase: "waking" }]);
    expect(loadWakingSessions(storage, NOW)).toHaveLength(1);
  });
});

describe("a hello request that was begun (review item 8)", () => {
  it("is written down with its key, and read back", () => {
    const text = serializeWakingSessions([
      session("agt_nova", { startedAt: NOW, helloAskingAt: NOW + 40_000, helloKey: "new-bot-hello-agt_nova" }),
    ], NOW + 50_000);
    expect(JSON.parse(text)[0]).toMatchObject({ helloAskingAt: NOW + 40_000, helloKey: "new-bot-hello-agt_nova", helloAskedAt: null });

    const [restored] = loadWakingSessions({ getItem: () => text }, NOW + 60_000);
    expect(restored).toMatchObject({ helloAskingAt: NOW + 40_000, helloKey: "new-bot-hello-agt_nova", helloAskedAt: null });
  });

  it("reads a session without one as having none", () => {
    const text = serializeWakingSessions([session("agt_nova", { startedAt: NOW })], NOW);
    expect("helloAskingAt" in JSON.parse(text)[0]).toBe(false);
    const [restored] = loadWakingSessions({ getItem: () => text }, NOW);
    expect(restored).toMatchObject({ helloAskingAt: null, helloKey: null });
  });

  it("hands a restored bot out again when the first sidebar gave it back", () => {
    resetWakingSessionStores();
    const storage = memoryStorage();
    storage.setItem(WAKING_BOTS_STORAGE_KEY, serializeWakingSessions([session("agt_nova", { startedAt: Date.now() })]));
    const store = wakingSessionStore("acct_1", storage);
    expect(store.takeRestored()).toEqual(["agt_nova"]);
    expect(store.takeRestored()).toEqual([]);
    store.deferRestored("agt_nova");
    expect(store.takeRestored()).toEqual(["agt_nova"]);
  });
});

describe("the account's list", () => {
  it("is one list for every sidebar of the account, and each hears of every change", () => {
    const storage = memoryStorage();
    const first = wakingSessionStore("acct_1", storage);
    const second = wakingSessionStore("acct_1", storage);
    expect(second).toBe(first);
    const heard = vi.fn();
    const stop = second.subscribe(heard);

    // The first sidebar is gone by now; the answer to its create still lands.
    first.update((sessions) => upsertWakingSession(sessions, session("agt_nova")));
    expect(heard).toHaveBeenCalledTimes(1);
    expect(second.get().map((entry) => entry.agentUid)).toEqual(["agt_nova"]);
    expect(JSON.parse(storage.values.get(WAKING_BOTS_STORAGE_KEY)!)).toMatchObject([{ agentUid: "agt_nova" }]);

    stop();
    first.update((sessions) => withoutWakingSession(sessions, "agt_nova"));
    expect(heard).toHaveBeenCalledTimes(1);
    expect(storage.values.get(WAKING_BOTS_STORAGE_KEY)).toBe("[]");
  });

  it("keeps accounts apart", () => {
    const one = wakingSessionStore("acct_1", memoryStorage());
    const two = wakingSessionStore("acct_2", memoryStorage());
    one.update((sessions) => upsertWakingSession(sessions, session("agt_nova")));
    expect(two.get()).toEqual([]);
  });

  it("is there again after a restart, and names the bots nobody has checked on yet, once", () => {
    const storage = memoryStorage();
    wakingSessionStore("acct_1", storage).update((sessions) => upsertWakingSession(sessions, session("agt_nova")));
    expect(wakingSessionStore("acct_1", storage).takeRestored()).toEqual([]);

    resetWakingSessionStores();
    const afterRestart = wakingSessionStore("acct_1", storage);
    expect(afterRestart.get().map((entry) => entry.agentUid)).toEqual(["agt_nova"]);
    expect(afterRestart.takeRestored()).toEqual(["agt_nova"]);
    expect(afterRestart.takeRestored()).toEqual([]);
  });

  it("drops a bot that is live or gone as soon as it is told so", () => {
    const store = wakingSessionStore("acct_1", memoryStorage());
    store.update((sessions) => upsertWakingSession(sessions, session("agt_nova")));
    store.update((sessions) => upsertWakingSession(sessions, session("agt_nova", { phase: "ready" })));
    expect(store.get()).toEqual([]);
  });

  it("keeps what only memory holds while the bot stays listed, and follows storage when something else changes it", () => {
    const storage = memoryStorage();
    const store = wakingSessionStore("acct_1", storage);
    const approval = { provider: "codex" as const, url: "https://auth.openai.com/codex/device", code: "TEST-CODE", capturedAt: null };
    store.update((sessions) => upsertWakingSession(sessions, session("agt_nova", { approval })));
    expect(store.get()[0]!.approval).toEqual(approval);

    // Another window added a bot: this one keeps its sign-in, and gains the other.
    const other = JSON.parse(storage.values.get(WAKING_BOTS_STORAGE_KEY)!);
    storage.setItem(WAKING_BOTS_STORAGE_KEY, JSON.stringify([...other, { ...other[0], agentUid: "agt_elsewhere", name: "Elsewhere" }]));
    expect(store.get().map((entry) => [entry.agentUid, entry.approval?.code ?? null])).toEqual([
      ["agt_nova", "TEST-CODE"],
      ["agt_elsewhere", null],
    ]);
    // The one that came from storage has not been checked on.
    expect(store.takeRestored()).toEqual(["agt_elsewhere"]);

    // The site's data was cleared: the list is empty.
    storage.clear();
    expect(store.get()).toEqual([]);
  });

  it("gives a caller with no account a list of its own that is written nowhere", () => {
    const storage = memoryStorage();
    const mine = wakingSessionStore(null, storage);
    const yours = wakingSessionStore("  ", storage);
    mine.update((sessions) => upsertWakingSession(sessions, session("agt_nova")));
    expect(mine.get().map((entry) => entry.agentUid)).toEqual(["agt_nova"]);
    expect(yours.get()).toEqual([]);
    expect(storage.values.size).toBe(0);
  });
});
