import { describe, expect, it } from "vitest";

import {
  cspSafeAvatarSrc,
  isResolvedPackItemSrc,
  packJsonUrl,
  parseAvatarPack,
  resolvePackItemSrc,
} from "./parse-pack.js";
import { generatedMarksPack } from "./generated-marks.js";
import {
  GENERATED_MARKS_AUTHOR,
  GENERATED_MARKS_PACK_NAME,
} from "./types.js";

const valid = {
  id: "demo",
  name: "Demo pack",
  version: "1.0.0",
  author: "Tester",
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

  it("does not prefix Vite asset URLs with the builtin: pack base", () => {
    const pack = generatedMarksPack(["/assets/agent-01.png", "/assets/agent-02.svg"]);
    expect(pack.author).toBe(GENERATED_MARKS_AUTHOR);
    expect(pack.name).toBe(GENERATED_MARKS_PACK_NAME);
    expect(resolvePackItemSrc(pack, pack.items[0]!)).toBe("/assets/agent-01.png");
    expect(resolvePackItemSrc(pack, pack.items[1]!)).toBe("/assets/agent-02.svg");
    expect(isResolvedPackItemSrc("/assets/agent-01.png")).toBe(true);
    expect(isResolvedPackItemSrc("blob:https://app/local")).toBe(true);
  });

  it("builds the pack.json URL", () => {
    expect(packJsonUrl("https://hq-agent-mascots.indigo-hq.com/")).toBe(
      "https://hq-agent-mascots.indigo-hq.com/pack.json",
    );
  });
});

describe("cspSafeAvatarSrc", () => {
  it("keeps bundled assets, raster data URLs, and blob URLs", () => {
    expect(cspSafeAvatarSrc("/assets/agent-01.png")).toBe("/assets/agent-01.png");
    expect(cspSafeAvatarSrc("blob:https://app.local/id")).toBe("blob:https://app.local/id");
    expect(cspSafeAvatarSrc("data:image/png;base64,iVBORw0KGgo=")).toBe(
      "data:image/png;base64,iVBORw0KGgo=",
    );
  });

  it("rejects remote and privileged schemes the packaged CSP would block", () => {
    expect(cspSafeAvatarSrc("https://hq-agent-mascots.indigo-hq.com/mascots/v2/dot.png")).toBeNull();
    expect(cspSafeAvatarSrc("builtin:generated-marks/assets/agent-01.png")).toBeNull();
    expect(cspSafeAvatarSrc("javascript:alert(1)")).toBeNull();
  });
});


