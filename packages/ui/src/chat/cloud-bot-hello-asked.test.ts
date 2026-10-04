import { describe, expect, it } from "vitest";

import {
  BOT_HELLO_ASKED_STORAGE_KEY,
  MAX_HELLO_ASKED,
  loadHelloAsked,
  saveHelloAsked,
  withHelloAsked,
  withoutHelloAsked,
} from "./cloud-bot-hello-asked.js";

function storage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    data,
  };
}

describe("when each new cloud bot was asked for its first message (B-8)", () => {
  it("keeps the first ask and survives a reload", () => {
    const store = storage();
    let times = withHelloAsked({}, "agt_nova", 1_000);
    // A repeat of the request does not move the time.
    expect(withHelloAsked(times, "agt_nova", 9_000)).toBe(times);
    times = withHelloAsked(times, " agt_polar ", 2_000);
    saveHelloAsked(store, times);
    expect(loadHelloAsked(store)).toEqual({ agt_polar: 2_000, agt_nova: 1_000 });
    expect(Object.keys(loadHelloAsked(store))[0]).toBe("agt_polar");
  });

  it("forgets a bot, and hands back the same object when there is nothing to forget", () => {
    const times = withHelloAsked({}, "agt_nova", 1_000);
    expect(withoutHelloAsked(times, "agt_nova")).toEqual({});
    expect(withoutHelloAsked(times, "agt_other")).toBe(times);
  });

  it("takes no uid that is not a bot's and no time that is not usable", () => {
    const none = {};
    expect(withHelloAsked(none, "prs_me", 1_000)).toBe(none);
    expect(withHelloAsked(none, "", 1_000)).toBe(none);
    for (const at of [Number.NaN, Number.POSITIVE_INFINITY, 0, -5]) {
      expect(withHelloAsked(none, "agt_nova", at)).toBe(none);
    }
  });

  it("reads nothing from storage that is missing, malformed or holds other things", () => {
    expect(loadHelloAsked(null)).toEqual({});
    expect(loadHelloAsked(storage())).toEqual({});
    expect(loadHelloAsked(storage({ [BOT_HELLO_ASKED_STORAGE_KEY]: "not json" }))).toEqual({});
    expect(loadHelloAsked(storage({ [BOT_HELLO_ASKED_STORAGE_KEY]: "[1,2]" }))).toEqual({});
    expect(
      loadHelloAsked(
        storage({
          [BOT_HELLO_ASKED_STORAGE_KEY]: JSON.stringify({ agt_nova: 1_000, agt_bad: "yesterday", agt_null: null, prs_me: 5, agt_zero: 0 }),
        }),
      ),
    ).toEqual({ agt_nova: 1_000 });
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("full");
      },
    };
    expect(loadHelloAsked(throwing)).toEqual({});
    expect(() => saveHelloAsked(throwing, { agt_nova: 1 })).not.toThrow();
  });

  it("keeps a bounded number of bots, newest first", () => {
    let times = {};
    for (let i = 0; i < MAX_HELLO_ASKED + 10; i += 1) times = withHelloAsked(times, `agt_${i}`, 1_000 + i);
    const uids = Object.keys(times);
    expect(uids).toHaveLength(MAX_HELLO_ASKED);
    expect(uids[0]).toBe(`agt_${MAX_HELLO_ASKED + 9}`);
    expect(uids).not.toContain("agt_0");
  });
});
