/**
 * The key a New Bot create is sent under (review A-C5).
 *
 * One key per draft, minted at the press, written down before the request
 * leaves, and handed out again for the same draft until the server answers.
 */
import { describe, expect, it } from "vitest";

import {
  CREATE_KEYS_STORAGE_KEY,
  CREATE_KEY_MAX_AGE_MS,
  createDraftSignature,
  loadPendingCreateKeys,
  mintCreateKey,
  releaseCreateKey,
  releaseCreateKeysFor,
  takeCreateKey,
} from "./create-key.js";

function memoryStorage(initial: Record<string, string> = {}): Pick<Storage, "getItem" | "setItem"> & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => (key in data ? data[key]! : null),
    setItem: (key, value) => {
      data[key] = value;
    },
  };
}

const NOVA = { name: "Nova", handle: "", runtime: "codex", size: "basic", authMode: "subscription" } as const;

describe("createDraftSignature", () => {
  it("is the same for the same create and differs when anything the server is asked to make differs", () => {
    const base = createDraftSignature("cmp_indigo", NOVA);
    expect(createDraftSignature(" cmp_indigo ", { ...NOVA })).toBe(base);
    expect(createDraftSignature("cmp_other", NOVA)).not.toBe(base);
    expect(createDraftSignature("cmp_indigo", { ...NOVA, name: "Vega" })).not.toBe(base);
    expect(createDraftSignature("cmp_indigo", { ...NOVA, runtime: "claude" })).not.toBe(base);
    expect(createDraftSignature("cmp_indigo", { ...NOVA, size: "power" })).not.toBe(base);
    expect(createDraftSignature("cmp_indigo", { ...NOVA, authMode: "apiKey" })).not.toBe(base);
  });

  it("goes by the handle the bot is created under, typed or made from the name", () => {
    expect(createDraftSignature("cmp_indigo", { ...NOVA, handle: "@nova" })).toBe(
      createDraftSignature("cmp_indigo", NOVA),
    );
    expect(createDraftSignature("cmp_indigo", { ...NOVA, handle: "nova-2" })).not.toBe(
      createDraftSignature("cmp_indigo", NOVA),
    );
  });
});

describe("takeCreateKey", () => {
  it("mints a key for a new draft and writes it down before it is used", () => {
    const storage = memoryStorage();
    const taken = takeCreateKey(storage, "sig-a", { now: 1_000, mint: () => "key-1" });

    expect(taken).toEqual({ key: "key-1", reused: false });
    expect(JSON.parse(storage.data[CREATE_KEYS_STORAGE_KEY]!)).toEqual([
      { key: "key-1", signature: "sig-a", mintedAt: 1_000 },
    ]);
  });

  it("hands the same key out again for the same draft until it is released", () => {
    const storage = memoryStorage();
    let n = 0;
    const mint = (): string => `key-${(n += 1)}`;

    expect(takeCreateKey(storage, "sig-a", { now: 1_000, mint })).toEqual({ key: "key-1", reused: false });
    expect(takeCreateKey(storage, "sig-a", { now: 2_000, mint })).toEqual({ key: "key-1", reused: true });
    // A different draft is a different create.
    expect(takeCreateKey(storage, "sig-b", { now: 2_000, mint })).toEqual({ key: "key-2", reused: false });

    releaseCreateKey(storage, "key-1");
    expect(takeCreateKey(storage, "sig-a", { now: 3_000, mint })).toEqual({ key: "key-3", reused: false });
    // The other draft's key was left alone.
    expect(takeCreateKey(storage, "sig-b", { now: 3_000, mint })).toEqual({ key: "key-2", reused: true });
  });

  it("survives a restart: a second reader of the same storage gets the key back", () => {
    const storage = memoryStorage();
    takeCreateKey(storage, "sig-a", { now: 1_000, mint: () => "key-1" });
    const afterRestart = memoryStorage(storage.data);

    expect(takeCreateKey(afterRestart, "sig-a", { now: 5_000, mint: () => "key-2" })).toEqual({
      key: "key-1",
      reused: true,
    });
  });

  it("treats a create whose outcome is still unknown after a day as a new one", () => {
    const storage = memoryStorage();
    takeCreateKey(storage, "sig-a", { now: 1_000, mint: () => "key-1" });

    expect(
      takeCreateKey(storage, "sig-a", { now: 1_000 + CREATE_KEY_MAX_AGE_MS + 1, mint: () => "key-2" }),
    ).toEqual({ key: "key-2", reused: false });
  });

  it("reads damaged storage as nothing kept, and still hands out a key", () => {
    expect(loadPendingCreateKeys(memoryStorage({ [CREATE_KEYS_STORAGE_KEY]: "{not json" }))).toEqual([]);
    expect(loadPendingCreateKeys(memoryStorage({ [CREATE_KEYS_STORAGE_KEY]: '{"key":"x"}' }))).toEqual([]);
    expect(
      loadPendingCreateKeys(
        memoryStorage({ [CREATE_KEYS_STORAGE_KEY]: JSON.stringify([null, { key: "", signature: "s", mintedAt: 1 }]) }),
      ),
    ).toEqual([]);
    const broken = {
      getItem: () => {
        return "[]";
      },
      setItem: () => {
        throw new Error("full");
      },
    };
    expect(takeCreateKey(broken, "sig-a", { mint: () => "key-1" })).toEqual({ key: "key-1", reused: false });
    expect(takeCreateKey(null, "sig-a", { mint: () => "key-1" })).toEqual({ key: "key-1", reused: false });
  });

  it("mints keys that differ", () => {
    const a = mintCreateKey();
    const b = mintCreateKey();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(10);
  });
});

describe("releaseCreateKeysFor (review item 6)", () => {
  it("lets go of every key kept for that bot in that company, and no other", () => {
    const storage = memoryStorage();
    const mint = (key: string) => ({ now: 1_000, mint: () => key });
    takeCreateKey(storage, createDraftSignature("cmp_indigo", NOVA), mint("key-nova-codex"));
    takeCreateKey(storage, createDraftSignature("cmp_indigo", { ...NOVA, runtime: "grok" }), mint("key-nova-grok"));
    takeCreateKey(storage, createDraftSignature("cmp_indigo", { ...NOVA, name: "Novalis" }), mint("key-novalis"));
    takeCreateKey(storage, createDraftSignature("cmp_acme", NOVA), mint("key-acme-nova"));

    expect(releaseCreateKeysFor(storage, " cmp_indigo ", "Nova").sort()).toEqual(["key-nova-codex", "key-nova-grok"]);
    expect(
      (JSON.parse(storage.data[CREATE_KEYS_STORAGE_KEY]!) as Array<{ key: string }>).map((entry) => entry.key).sort(),
    ).toEqual(["key-acme-nova", "key-novalis"]);
  });

  it("does nothing without a company or a handle", () => {
    const storage = memoryStorage();
    takeCreateKey(storage, createDraftSignature("cmp_indigo", NOVA), { now: 1_000, mint: () => "key-1" });
    expect(releaseCreateKeysFor(storage, "", "nova")).toEqual([]);
    expect(releaseCreateKeysFor(storage, "cmp_indigo", " ")).toEqual([]);
    expect(releaseCreateKeysFor(null, "cmp_indigo", "nova")).toEqual([]);
    expect(JSON.parse(storage.data[CREATE_KEYS_STORAGE_KEY]!)).toHaveLength(1);
  });
});
