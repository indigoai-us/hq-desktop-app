import { describe, expect, it } from "vitest";

import {
  addPackUrl,
  DEFAULT_REMOTE_PACK_URLS,
  normalizePackUrl,
  parsePackRegistry,
  readPackRegistry,
  removePackUrl,
  writePackRegistry,
} from "./registry.js";
import { HQ_AGENT_MASCOTS_BASE_URL, PACK_REGISTRY_STORAGE_KEY } from "./types.js";

function memoryStorage(seed: Record<string, string> = {}) {
  const store = { ...seed };
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
  };
}

describe("pack registry", () => {
  it("defaults to the mascots pack URL", () => {
    expect(parsePackRegistry(null)).toEqual([HQ_AGENT_MASCOTS_BASE_URL]);
    expect(DEFAULT_REMOTE_PACK_URLS).toEqual([HQ_AGENT_MASCOTS_BASE_URL]);
    expect(readPackRegistry(memoryStorage())).toEqual([HQ_AGENT_MASCOTS_BASE_URL]);
  });

  it("adds and removes a remote pack URL, stripping a trailing slash", () => {
    const storage = memoryStorage();
    const added = addPackUrl("https://avatars.example.test/pack/", storage);
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(added.urls).toEqual([
      HQ_AGENT_MASCOTS_BASE_URL,
      "https://avatars.example.test/pack",
    ]);
    expect(removePackUrl("https://avatars.example.test/pack/", storage)).toEqual([
      HQ_AGENT_MASCOTS_BASE_URL,
    ]);
  });

  it("rejects non-http URLs and ignores the builtin token", () => {
    const storage = memoryStorage();
    expect(addPackUrl("ftp://x", storage).ok).toBe(false);
    expect(addPackUrl("builtin:generated-marks", storage).ok).toBe(false);
    expect(normalizePackUrl("not a url")).toBeNull();
  });

  it("does not duplicate an already-registered URL", () => {
    const storage = memoryStorage();
    const again = addPackUrl(`${HQ_AGENT_MASCOTS_BASE_URL}/`, storage);
    expect(again.ok && again.urls).toEqual([HQ_AGENT_MASCOTS_BASE_URL]);
  });

  it("can remove the default mascots URL", () => {
    const storage = memoryStorage();
    expect(removePackUrl(HQ_AGENT_MASCOTS_BASE_URL, storage)).toEqual([]);
    expect(JSON.parse(storage.getItem(PACK_REGISTRY_STORAGE_KEY) ?? "[]")).toEqual(
      [],
    );
  });

  it("round-trips writePackRegistry", () => {
    const storage = memoryStorage();
    const urls = writePackRegistry(
      ["https://one.test/", "https://one.test", "nope", "builtin:generated-marks"],
      storage,
    );
    expect(urls).toEqual(["https://one.test"]);
    expect(readPackRegistry(storage)).toEqual(["https://one.test"]);
  });
});
