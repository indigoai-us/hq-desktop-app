import { describe, expect, it } from "vitest";

import {
  BOT_HELLO_ASKED_STORAGE_KEY,
  MAX_ACCOUNTS,
  MAX_BOTS_MADE,
  MAX_HELLO_ASKED,
  botMadeByAnotherAccount,
  helloAskedFor,
  loadBotsByAccount,
  saveBotsByAccount,
  withBotMadeBy,
  withHelloAsked,
  withoutBot,
  withoutHelloAsked,
  type BotsByAccount,
} from "./cloud-bot-hello-asked.js";

function storage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    data,
  };
}

const ME = "prs_me";
const OTHER = "prs_other";

describe("when each new cloud bot was asked for its first message (B-8)", () => {
  it("keeps the first ask and survives a reload", () => {
    const store = storage();
    let all = withHelloAsked({}, ME, "agt_nova", 1_000);
    // A repeat of the request does not move the time.
    expect(withHelloAsked(all, ME, "agt_nova", 9_000)).toBe(all);
    all = withHelloAsked(all, ME, " agt_polar ", 2_000);
    saveBotsByAccount(store, all);
    const loaded = loadBotsByAccount(store);
    expect(helloAskedFor(loaded, ME)).toEqual({ agt_polar: 2_000, agt_nova: 1_000 });
    expect(Object.keys(helloAskedFor(loaded, ME))[0]).toBe("agt_polar");
  });

  it("forgets a bot's time, and hands back the same object when there is nothing to forget", () => {
    const all = withHelloAsked({}, ME, "agt_nova", 1_000);
    expect(helloAskedFor(withoutHelloAsked(all, ME, "agt_nova"), ME)).toEqual({});
    expect(withoutHelloAsked(all, ME, "agt_other")).toBe(all);
    expect(withoutHelloAsked(all, OTHER, "agt_nova")).toBe(all);
  });

  it("takes no uid that is not a bot's and no time that is not usable", () => {
    const none: BotsByAccount = {};
    expect(withHelloAsked(none, ME, "prs_me", 1_000)).toBe(none);
    expect(withHelloAsked(none, ME, "", 1_000)).toBe(none);
    for (const at of [Number.NaN, Number.POSITIVE_INFINITY, 0, -5]) {
      expect(withHelloAsked(none, ME, "agt_nova", at)).toBe(none);
    }
  });

  it("keeps a bounded number of bots per account, newest first", () => {
    let all: BotsByAccount = {};
    for (let i = 0; i < MAX_HELLO_ASKED + 10; i += 1) all = withHelloAsked(all, ME, `agt_${i}`, 1_000 + i);
    const uids = Object.keys(helloAskedFor(all, ME));
    expect(uids).toHaveLength(MAX_HELLO_ASKED);
    expect(uids[0]).toBe(`agt_${MAX_HELLO_ASKED + 9}`);
    expect(uids).not.toContain("agt_0");
  });
});

describe("what is kept is kept per account (round 2, c)", () => {
  it("a second account on the same Mac does not get the first one's ask times", () => {
    const store = storage();
    saveBotsByAccount(store, withHelloAsked({}, ME, "agt_nova", 1_000));
    const loaded = loadBotsByAccount(store);
    expect(helloAskedFor(loaded, ME)).toEqual({ agt_nova: 1_000 });
    expect(helloAskedFor(loaded, OTHER)).toEqual({});
    // The second account's own ask is its own, and leaves the first one's alone.
    const both = withHelloAsked(loaded, OTHER, "agt_nova", 5_000);
    expect(helloAskedFor(both, OTHER)).toEqual({ agt_nova: 5_000 });
    expect(helloAskedFor(both, ME)).toEqual({ agt_nova: 1_000 });
  });

  it("with nobody signed in, nothing is read and nothing is written", () => {
    const all = withHelloAsked({}, ME, "agt_nova", 1_000);
    for (const nobody of [null, undefined, "", "   "]) {
      expect(helloAskedFor(all, nobody)).toEqual({});
      expect(withHelloAsked(all, nobody, "agt_polar", 2_000)).toBe(all);
      expect(withBotMadeBy(all, nobody, "agt_polar")).toBe(all);
      expect(botMadeByAnotherAccount(all, nobody, "agt_nova")).toBe(false);
    }
    // The same empty object every time, so nothing downstream is re-run for it.
    expect(helloAskedFor(all, null)).toBe(helloAskedFor({}, OTHER));
  });

  it("a bot one account made here is another account's 'made by someone else'", () => {
    const all = withBotMadeBy({}, ME, "agt_nova");
    expect(all[ME]!.made).toEqual(["agt_nova"]);
    expect(withBotMadeBy(all, ME, "agt_nova")).toBe(all);
    expect(botMadeByAnotherAccount(all, ME, "agt_nova")).toBe(false);
    expect(botMadeByAnotherAccount(all, OTHER, "agt_nova")).toBe(true);
    // A bot nobody is recorded as having made is nobody else's.
    expect(botMadeByAnotherAccount(all, OTHER, "agt_unknown")).toBe(false);
    expect(botMadeByAnotherAccount({}, OTHER, "agt_nova")).toBe(false);
  });

  it("a bot has one maker", () => {
    let all = withBotMadeBy({}, ME, "agt_nova");
    all = withBotMadeBy(all, OTHER, "agt_nova");
    expect(all[OTHER]!.made).toEqual(["agt_nova"]);
    expect(all[ME]!.made).toEqual([]);
    expect(botMadeByAnotherAccount(all, ME, "agt_nova")).toBe(true);
  });

  it("a removed bot is forgotten for every account", () => {
    let all = withBotMadeBy({}, ME, "agt_nova");
    all = withHelloAsked(all, ME, "agt_nova", 1_000);
    all = withHelloAsked(all, OTHER, "agt_nova", 2_000);
    all = withBotMadeBy(all, OTHER, "agt_polar");
    const gone = withoutBot(all, "agt_nova");
    expect(gone[ME]).toEqual({ asked: {}, made: [] });
    expect(gone[OTHER]).toEqual({ asked: {}, made: ["agt_polar"] });
    expect(withoutBot(gone, "agt_nova")).toBe(gone);
  });

  it("reads the old shape, which had no accounts, as empty", () => {
    // Written before accounts were kept apart: bots at the top level.
    const old = storage({ [BOT_HELLO_ASKED_STORAGE_KEY]: JSON.stringify({ agt_nova: 1_000, agt_polar: 2_000 }) });
    const loaded = loadBotsByAccount(old);
    expect(loaded).toEqual({});
    expect(helloAskedFor(loaded, ME)).toEqual({});
    expect(botMadeByAnotherAccount(loaded, ME, "agt_nova")).toBe(false);
    // The next write replaces it.
    saveBotsByAccount(old, withHelloAsked(loaded, ME, "agt_nova", 3_000));
    expect(JSON.parse(old.data.get(BOT_HELLO_ASKED_STORAGE_KEY)!)).toEqual({
      v: 2,
      accounts: { [ME]: { asked: { agt_nova: 3_000 }, made: [] } },
    });
  });

  it("reads nothing from storage that is missing, malformed or holds other things", () => {
    expect(loadBotsByAccount(null)).toEqual({});
    expect(loadBotsByAccount(storage())).toEqual({});
    for (const raw of ["not json", "[1,2]", "null", '{"accounts":[]}', '{"accounts":"x"}']) {
      expect(loadBotsByAccount(storage({ [BOT_HELLO_ASKED_STORAGE_KEY]: raw })), raw).toEqual({});
    }
    const mixed = storage({
      [BOT_HELLO_ASKED_STORAGE_KEY]: JSON.stringify({
        v: 2,
        agt_stray: 5,
        accounts: {
          [ME]: {
            asked: { agt_nova: 1_000, agt_bad: "yesterday", agt_null: null, prs_me: 5, agt_zero: 0 },
            made: ["agt_nova", "agt_nova", "prs_me", 7, " agt_polar "],
          },
          agt_nested: { asked: { agt_x: 1 }, made: ["agt_x"] },
          "": { asked: { agt_y: 1 }, made: [] },
          [OTHER]: "junk",
          prs_third: { made: "nope" },
        },
      }),
    });
    expect(loadBotsByAccount(mixed)).toEqual({
      [ME]: { asked: { agt_nova: 1_000 }, made: ["agt_nova", "agt_polar"] },
      prs_third: { asked: {}, made: [] },
    });
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("full");
      },
    };
    expect(loadBotsByAccount(throwing)).toEqual({});
    expect(() => saveBotsByAccount(throwing, { [ME]: { asked: { agt_nova: 1 }, made: [] } })).not.toThrow();
  });

  it("keeps a bounded number of accounts and of bots made, most recent first", () => {
    let all: BotsByAccount = {};
    for (let i = 0; i < MAX_ACCOUNTS + 3; i += 1) all = withBotMadeBy(all, `prs_${i}`, `agt_${i}`);
    expect(Object.keys(all)).toHaveLength(MAX_ACCOUNTS);
    expect(Object.keys(all)[0]).toBe(`prs_${MAX_ACCOUNTS + 2}`);
    expect(all.prs_0).toBeUndefined();
    let mine: BotsByAccount = {};
    for (let i = 0; i < MAX_BOTS_MADE + 5; i += 1) mine = withBotMadeBy(mine, ME, `agt_${i}`);
    expect(mine[ME]!.made).toHaveLength(MAX_BOTS_MADE);
    expect(mine[ME]!.made[0]).toBe(`agt_${MAX_BOTS_MADE + 4}`);
  });
});
