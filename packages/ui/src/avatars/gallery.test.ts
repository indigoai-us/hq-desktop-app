import { describe, expect, it } from "vitest";
import { ok, type AdapterResult } from "@hq/platform";
import {
  clearAvatarGalleryCache,
  loadAvatarGallery,
  packFromDetail,
} from "./gallery.js";
import type { AvatarPackDetailPayload, AvatarPackListPayload } from "@hq/platform";
import { GENERATED_MARKS_PACK_ID } from "./types.js";

const EXPIRES = Date.now() + 60 * 60 * 1000;

const ANIMALS_DETAIL: AvatarPackDetailPayload = {
  id: "animals",
  name: "Animals",
  version: "1.0.0",
  author: { handle: "lizzy", displayName: "Lizzy" },
  count: 1,
  expiresAt: EXPIRES,
  items: [
    {
      id: "v2-dot",
      name: "Dot",
      tags: ["rabbit"],
      thumbUrl:
        "https://hq-marketplace-assets-hq-prod.s3.us-east-1.amazonaws.com/avatar-packs/animals/thumbs/v2-dot.png?X-Amz-Expires=7200",
      fullUrl:
        "https://hq-marketplace-assets-hq-prod.s3.us-east-1.amazonaws.com/avatar-packs/animals/items/v2-dot.png?X-Amz-Expires=7200",
    },
  ],
};

const LIST: AvatarPackListPayload = {
  packs: [
    {
      id: "animals",
      name: "Animals",
      version: "1.0.0",
      author: { handle: "lizzy", displayName: "Lizzy" },
      count: 1,
      thumbnailUrl: ANIMALS_DETAIL.items[0]?.thumbUrl,
    },
  ],
  expiresAt: EXPIRES,
};

function memoryStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

describe("loadAvatarGallery", () => {
  it("loads pack list + details from the API and prepends generated marks", async () => {
    clearAvatarGalleryCache(memoryStorage());
    let listCalls = 0;
    let detailCalls = 0;
    const loaded = await loadAvatarGallery(
      {
        listAvatarPacks: async () => {
          listCalls += 1;
          return ok(LIST);
        },
        getAvatarPack: async (id) => {
          detailCalls += 1;
          expect(id).toBe("animals");
          return ok(ANIMALS_DETAIL);
        },
      },
      { storage: memoryStorage(), generated: {
        id: GENERATED_MARKS_PACK_ID,
        name: "Generated marks",
        version: "1.0.0",
        author: "Default",
        baseUrl: "builtin:generated-marks",
        items: [],
      } },
    );
    expect(listCalls).toBe(1);
    expect(detailCalls).toBe(1);
    expect(loaded.source).toBe("network");
    expect(loaded.packs.map((pack) => pack.id)).toEqual([
      GENERATED_MARKS_PACK_ID,
      "animals",
    ]);
    expect(loaded.packs[1]?.name).toBe("Animals");
    expect(loaded.packs[1]?.items[0]?.src).toContain("/avatar-packs/");
  });

  it("reuses a cached list within the presign expiry", async () => {
    const storage = memoryStorage();
    clearAvatarGalleryCache(storage);
    let listCalls = 0;
    const api = {
      listAvatarPacks: async (): Promise<AdapterResult<AvatarPackListPayload>> => {
        listCalls += 1;
        return ok(LIST);
      },
      getAvatarPack: async () => ok(ANIMALS_DETAIL),
    };
    await loadAvatarGallery(api, { storage, now: Date.now() });
    const again = await loadAvatarGallery(api, { storage, now: Date.now() });
    expect(listCalls).toBe(1);
    expect(again.source).toBe("cache");
    expect(again.packs.some((pack) => pack.id === "animals")).toBe(true);
  });
});

describe("packFromDetail", () => {
  it("maps thumbUrl onto item.src and keeps fullUrl", () => {
    const pack = packFromDetail(ANIMALS_DETAIL);
    expect(pack.author).toBe("Lizzy");
    expect(pack.items[0]?.src).toBe(ANIMALS_DETAIL.items[0]?.thumbUrl);
    expect(pack.items[0]?.fullUrl).toBe(ANIMALS_DETAIL.items[0]?.fullUrl);
  });
});
