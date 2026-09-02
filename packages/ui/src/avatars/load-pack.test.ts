import { describe, expect, it } from "vitest";

import { loadPackFromUrl, loadRegisteredPacks } from "./load-pack.js";
import { HQ_AGENT_MASCOTS_SNAPSHOT } from "./snapshots.js";
import { HQ_AGENT_MASCOTS_BASE_URL, PACK_REGISTRY_STORAGE_KEY } from "./types.js";
import { GENERATED_MARKS_PACK_ID } from "./types.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("loadPackFromUrl", () => {
  it("prefers a live pack.json over the bundled snapshot", async () => {
    const live = {
      id: "hq-agent-mascots",
      name: "Live mascots",
      version: "9.0.0",
      author: "Lizzy",
      baseUrl: HQ_AGENT_MASCOTS_BASE_URL,
      items: [{ id: "dot", name: "Dot", src: "dot.png", tags: [] }],
    };
    const loaded = await loadPackFromUrl(HQ_AGENT_MASCOTS_BASE_URL, {
      fetch: async (url) => {
        expect(url).toBe(`${HQ_AGENT_MASCOTS_BASE_URL}/pack.json`);
        return jsonResponse(live);
      },
    });
    expect(loaded.source).toBe("remote");
    expect(loaded.pack.name).toBe("Live mascots");
    expect(loaded.pack.items).toHaveLength(1);
  });

  it("falls back to the bundled snapshot when pack.json is missing", async () => {
    const loaded = await loadPackFromUrl(HQ_AGENT_MASCOTS_BASE_URL, {
      fetch: async () => jsonResponse({ error: "nope" }, 404),
    });
    expect(loaded.source).toBe("fallback");
    expect(loaded.pack.items).toHaveLength(HQ_AGENT_MASCOTS_SNAPSHOT.items.length);
    expect(loaded.pack.id).toBe("hq-agent-mascots");
  });

  it("falls back when the live body fails validation", async () => {
    const loaded = await loadPackFromUrl(HQ_AGENT_MASCOTS_BASE_URL, {
      fetch: async () => jsonResponse({ id: "broken" }),
    });
    expect(loaded.source).toBe("fallback");
  });

  it("falls back when fetch throws", async () => {
    const loaded = await loadPackFromUrl(HQ_AGENT_MASCOTS_BASE_URL, {
      fetch: async () => {
        throw new Error("gated");
      },
    });
    expect(loaded.source).toBe("fallback");
  });

  it("throws when there is no snapshot for an unknown host", async () => {
    await expect(
      loadPackFromUrl("https://unknown-pack.test", {
        fetch: async () => jsonResponse({}, 404),
      }),
    ).rejects.toThrow(/Could not load avatar pack/);
  });
});

describe("loadRegisteredPacks", () => {
  it("always includes generated marks, then remote packs", async () => {
    const storage = {
      getItem: () => JSON.stringify([HQ_AGENT_MASCOTS_BASE_URL]),
      setItem: () => {},
    };
    const loaded = await loadRegisteredPacks({
      storage,
      fetch: async () => jsonResponse({}, 404),
      generated: {
        id: GENERATED_MARKS_PACK_ID,
        name: "Generated marks",
        version: "1.0.0",
        author: "HQ",
        baseUrl: "builtin:generated-marks",
        items: [{ id: "agent-01", name: "Mark 01", src: "a.png", tags: ["generated"] }],
      },
    });
    expect(loaded.map((row) => row.pack.id)).toEqual([
      GENERATED_MARKS_PACK_ID,
      "hq-agent-mascots",
    ]);
    expect(loaded[0]?.source).toBe("builtin");
    expect(loaded[1]?.source).toBe("fallback");
  });

  it("skips remote URLs that fail without a snapshot", async () => {
    const storage = {
      getItem: (key: string) =>
        key === PACK_REGISTRY_STORAGE_KEY
          ? JSON.stringify(["https://missing-pack.test"])
          : null,
      setItem: () => {},
    };
    const loaded = await loadRegisteredPacks({
      storage,
      fetch: async () => jsonResponse({}, 404),
      generated: {
        id: GENERATED_MARKS_PACK_ID,
        name: "Generated marks",
        version: "1.0.0",
        author: "HQ",
        baseUrl: "builtin:generated-marks",
        items: [],
      },
    });
    expect(loaded.map((row) => row.pack.id)).toEqual([GENERATED_MARKS_PACK_ID]);
  });
});
