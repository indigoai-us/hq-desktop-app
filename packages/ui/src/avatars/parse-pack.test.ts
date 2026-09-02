import { describe, expect, it } from "vitest";

import { parseAvatarPack, resolvePackItemSrc, packJsonUrl } from "./parse-pack.js";
import { HQ_AGENT_MASCOTS_SNAPSHOT } from "./snapshots.js";

const valid = {
  id: "demo",
  name: "Demo pack",
  version: "1.0.0",
  author: "HQ",
  baseUrl: "https://example.test/pack",
  items: [
    { id: "fox", name: "Fox", src: "fox.png", tags: ["animal", "fox"] },
  ],
};

describe("parseAvatarPack", () => {
  it("accepts a well-formed manifest and drops empty tags", () => {
    const parsed = parseAvatarPack({
      ...valid,
      extra: "ignored",
      items: [{ id: "fox", name: "Fox", src: "fox.png", tags: ["fox", " ", 1] }],
    });
    expect(parsed).toEqual({
      ok: true,
      pack: {
        ...valid,
        items: [{ id: "fox", name: "Fox", src: "fox.png", tags: ["fox"] }],
      },
    });
  });

  it("rejects missing required fields and duplicate ids", () => {
    expect(parseAvatarPack(null).ok).toBe(false);
    expect(parseAvatarPack({ ...valid, id: "  " }).ok).toBe(false);
    expect(parseAvatarPack({ ...valid, items: "nope" }).ok).toBe(false);
    expect(
      parseAvatarPack({
        ...valid,
        items: [
          { id: "fox", name: "Fox", src: "a.png" },
          { id: "fox", name: "Fox 2", src: "b.png" },
        ],
      }),
    ).toEqual({ ok: false, error: 'duplicate item id "fox"' });
  });

  it("rejects non-http absolute item sources", () => {
    expect(
      parseAvatarPack({
        ...valid,
        items: [{ id: "x", name: "X", src: "javascript:alert(1)" }],
      }).ok,
    ).toBe(false);
    expect(
      parseAvatarPack({
        ...valid,
        items: [{ id: "x", name: "X", src: "https://cdn.test/x.png" }],
      }).ok,
    ).toBe(true);
  });

  it("treats missing tags as an empty list", () => {
    const parsed = parseAvatarPack({
      ...valid,
      items: [{ id: "fox", name: "Fox", src: "fox.png" }],
    });
    expect(parsed.ok && parsed.pack.items[0]?.tags).toEqual([]);
  });
});

describe("resolvePackItemSrc", () => {
  it("joins relative paths and keeps absolute URLs", () => {
    const pack = {
      ...valid,
      items: [],
    };
    expect(
      resolvePackItemSrc(pack, { id: "a", name: "A", src: "mascots/v2/dot.png", tags: [] }),
    ).toBe("https://example.test/pack/mascots/v2/dot.png");
    expect(
      resolvePackItemSrc(pack, {
        id: "a",
        name: "A",
        src: "https://cdn.test/dot.png",
        tags: [],
      }),
    ).toBe("https://cdn.test/dot.png");
  });

  it("builds the pack.json URL", () => {
    expect(packJsonUrl("https://hq-agent-mascots.indigo-hq.com/")).toBe(
      "https://hq-agent-mascots.indigo-hq.com/pack.json",
    );
  });
});

describe("bundled mascots snapshot", () => {
  it("is a valid 24-item catalog", () => {
    expect(HQ_AGENT_MASCOTS_SNAPSHOT.id).toBe("hq-agent-mascots");
    expect(HQ_AGENT_MASCOTS_SNAPSHOT.items).toHaveLength(24);
    expect(
      HQ_AGENT_MASCOTS_SNAPSHOT.items.map((item) => item.id).sort(),
    ).toEqual(
      HQ_AGENT_MASCOTS_SNAPSHOT.items.map((item) => item.id).sort(),
    );
    expect(
      HQ_AGENT_MASCOTS_SNAPSHOT.items.some((item) => item.id === "v2-dot"),
    ).toBe(true);
  });
});
