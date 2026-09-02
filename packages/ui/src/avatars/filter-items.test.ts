import { describe, expect, it } from "vitest";

import {
  filterPacks,
  flattenVisible,
  moveIndex,
  selectionEquals,
} from "./filter-items.js";
import type { AvatarPack } from "./types.js";

const generated: AvatarPack = {
  id: "generated-marks",
  name: "Generated marks",
  version: "1.0.0",
  author: "HQ",
  baseUrl: "builtin:generated-marks",
  items: [
    { id: "agent-01", name: "Mark 01", src: "a.png", tags: ["generated"] },
    { id: "agent-02", name: "Mark 02", src: "b.png", tags: ["generated"] },
  ],
};

const mascots: AvatarPack = {
  id: "hq-agent-mascots",
  name: "HQ agent mascots",
  version: "1.0.0",
  author: "Lizzy",
  baseUrl: "https://hq-agent-mascots.indigo-hq.com",
  items: [
    {
      id: "v2-dot",
      name: "Dot · simplified",
      src: "mascots/v2/dot.png",
      tags: ["v2", "rabbit", "generalist"],
    },
    {
      id: "v1-fox",
      name: "Fox · retro cel",
      src: "mascots/v1/fox.png",
      tags: ["v1", "fox", "growth"],
    },
  ],
};

describe("picker filtering and selection", () => {
  it("filters by name, tag, and pack name", () => {
    expect(filterPacks([generated, mascots], "dot")[0]?.items.map((i) => i.id)).toEqual([
      "v2-dot",
    ]);
    expect(filterPacks([generated, mascots], "growth")[0]?.items.map((i) => i.id)).toEqual([
      "v1-fox",
    ]);
    expect(filterPacks([generated, mascots], "generated marks")).toHaveLength(1);
    expect(filterPacks([generated, mascots], "nope")).toEqual([]);
  });

  it("flattens visible items for keyboard navigation", () => {
    const rows = flattenVisible(filterPacks([generated, mascots], ""));
    expect(rows.map((row) => row.key)).toEqual([
      "generated-marks:agent-01",
      "generated-marks:agent-02",
      "hq-agent-mascots:v2-dot",
      "hq-agent-mascots:v1-fox",
    ]);
    expect(rows[2]?.src).toBe(
      "https://hq-agent-mascots.indigo-hq.com/mascots/v2/dot.png",
    );
  });

  it("compares selections", () => {
    expect(
      selectionEquals({ kind: "generated" }, { kind: "generated" }),
    ).toBe(true);
    expect(
      selectionEquals(
        { kind: "item", packId: "p", itemId: "a" },
        { kind: "item", packId: "p", itemId: "a" },
      ),
    ).toBe(true);
    expect(
      selectionEquals(
        { kind: "item", packId: "p", itemId: "a" },
        { kind: "generated" },
      ),
    ).toBe(false);
  });

  it("moves the keyboard cursor within the flattened grid", () => {
    expect(moveIndex(0, 1, 5)).toBe(1);
    expect(moveIndex(0, -1, 5)).toBe(4);
    expect(moveIndex(1, 4, 5, 4)).toBe(1);
    expect(moveIndex(0, 4, 6, 4)).toBe(4);
  });
});
