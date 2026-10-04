/**
 * The New Bot flow's company flag cache: one read per company per five
 * minutes, shared while it is out, off on any failure, forgotten on clear.
 */
import { describe, expect, it, vi } from "vitest";

import {
  NEW_BOT_FLAG_TTL_MS,
  createNewBotCompanyFlags,
} from "./new-bot-companies.js";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (err: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createNewBotCompanyFlags", () => {
  it("is five minutes", () => {
    expect(NEW_BOT_FLAG_TTL_MS).toBe(300_000);
  });

  it("returns only the companies whose flag is on, in the order given", async () => {
    const read = vi.fn(async (uid: string) => uid !== "cmp_off");
    const flags = createNewBotCompanyFlags(read);
    expect(flags.peek(["cmp_b", "cmp_off", "cmp_a"])).toEqual([]);
    expect(await flags.resolve(["cmp_b", "cmp_off", "cmp_a"])).toEqual(["cmp_b", "cmp_a"]);
    expect(flags.peek(["cmp_a", "cmp_off", "cmp_b"])).toEqual(["cmp_a", "cmp_b"]);
    expect(read.mock.calls.map((call) => call[0])).toEqual(["cmp_b", "cmp_off", "cmp_a"]);
  });

  it("reads each company once per five minutes, on or off", async () => {
    let at = 1_000;
    const read = vi.fn(async (uid: string) => uid === "cmp_on");
    const flags = createNewBotCompanyFlags(read, { now: () => at });
    await flags.resolve(["cmp_on", "cmp_off"]);
    expect(read).toHaveBeenCalledTimes(2);

    // Asked again and again inside the window: answered from memory.
    at += NEW_BOT_FLAG_TTL_MS - 1;
    for (let i = 0; i < 20; i += 1) {
      expect(await flags.resolve(["cmp_on", "cmp_off"])).toEqual(["cmp_on"]);
    }
    expect(read).toHaveBeenCalledTimes(2);

    // Five minutes after the answer: one more read each.
    at += 1;
    expect(await flags.resolve(["cmp_on", "cmp_off"])).toEqual(["cmp_on"]);
    expect(read).toHaveBeenCalledTimes(4);
  });

  it("shares one read between asks made while it is out", async () => {
    const gate = deferred<boolean>();
    const read = vi.fn(() => gate.promise);
    const flags = createNewBotCompanyFlags(read);
    const first = flags.resolve(["cmp_a"]);
    const second = flags.resolve(["cmp_a", "cmp_a"]);
    const third = flags.resolve(["cmp_a"]);
    expect(read).toHaveBeenCalledTimes(1);
    gate.resolve(true);
    expect(await Promise.all([first, second, third])).toEqual([["cmp_a"], ["cmp_a"], ["cmp_a"]]);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("reads only the company that is new when the list grows", async () => {
    const read = vi.fn(async (_uid: string) => true);
    const flags = createNewBotCompanyFlags(read);
    await flags.resolve(["cmp_a"]);
    await flags.resolve(["cmp_a", "cmp_b"]);
    expect(read.mock.calls.map((call) => call[0])).toEqual(["cmp_a", "cmp_b"]);
  });

  it("counts a failed read as off and does not ask again inside five minutes", async () => {
    let at = 0;
    const read = vi.fn(async (): Promise<boolean> => {
      throw new Error("offline");
    });
    const flags = createNewBotCompanyFlags(read, { now: () => at });
    expect(await flags.resolve(["cmp_a"])).toEqual([]);
    expect(await flags.resolve(["cmp_a"])).toEqual([]);
    expect(read).toHaveBeenCalledTimes(1);
    at += NEW_BOT_FLAG_TTL_MS;
    expect(await flags.resolve(["cmp_a"])).toEqual([]);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("counts a read that throws before it returns a promise as off", async () => {
    const flags = createNewBotCompanyFlags(() => {
      throw new Error("no adapter");
    });
    expect(await flags.resolve(["cmp_a"])).toEqual([]);
  });

  it("is on only for an exact true", async () => {
    const flags = createNewBotCompanyFlags(
      async (uid) => (uid === "cmp_true" ? true : ("yes" as unknown as boolean)),
    );
    expect(await flags.resolve(["cmp_true", "cmp_truthy"])).toEqual(["cmp_true"]);
  });

  it("keeps the last answer on show while it is read again", async () => {
    let at = 0;
    const gate = deferred<boolean>();
    const read = vi
      .fn<(uid: string) => Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockReturnValueOnce(gate.promise);
    const flags = createNewBotCompanyFlags(read, { now: () => at });
    await flags.resolve(["cmp_a"]);
    at += NEW_BOT_FLAG_TTL_MS;
    const again = flags.resolve(["cmp_a"]);
    // The read is out. The flow does not drop away meanwhile.
    expect(flags.peek(["cmp_a"])).toEqual(["cmp_a"]);
    gate.resolve(false);
    expect(await again).toEqual([]);
    expect(flags.peek(["cmp_a"])).toEqual([]);
  });

  it("forgets everything on clear and disowns a read that was out", async () => {
    const gate = deferred<boolean>();
    const read = vi
      .fn<(uid: string) => Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockReturnValueOnce(gate.promise)
      .mockResolvedValue(false);
    const flags = createNewBotCompanyFlags(read);
    await flags.resolve(["cmp_a"]);
    expect(flags.peek(["cmp_a"])).toEqual(["cmp_a"]);

    const stale = flags.resolve(["cmp_b"]);
    flags.clear();
    expect(flags.peek(["cmp_a"])).toEqual([]);
    // The other account's answer arrives late: it is not used and not kept.
    gate.resolve(true);
    expect(await stale).toBeNull();
    expect(flags.peek(["cmp_b"])).toEqual([]);

    // The new account is read afresh.
    expect(await flags.resolve(["cmp_a", "cmp_b"])).toEqual([]);
    expect(read).toHaveBeenCalledTimes(4);
  });

  it("ignores blank uids and asks nothing for an empty list", async () => {
    const read = vi.fn(async (_uid: string) => true);
    const flags = createNewBotCompanyFlags(read);
    expect(await flags.resolve([])).toEqual([]);
    expect(await flags.resolve(["  ", ""])).toEqual([]);
    expect(read).not.toHaveBeenCalled();
    expect(await flags.resolve([" cmp_a "])).toEqual(["cmp_a"]);
    expect(read).toHaveBeenCalledWith("cmp_a");
  });
});
