import { describe, expect, it } from "vitest";

import { WEB_PATHS } from "../web/index.js";
import { createSyncPlatformAdapter, imageContentType } from "./sync-adapter.js";

interface Invocation {
  cmd: string;
  args?: Record<string, unknown>;
}

function makeAdapter(response: unknown = { handle: "drake", avatarUrl: "https://x/a.jpg" }) {
  const calls: Invocation[] = [];
  const adapter = createSyncPlatformAdapter({
    invoke: async (cmd, args) => {
      calls.push({ cmd, args });
      return { status: 200, body: JSON.stringify(response) };
    },
  });
  return { adapter, calls };
}

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00]);

describe("imageContentType", () => {
  it("recognises the image types the avatar route accepts", () => {
    expect(imageContentType(JPEG)).toBe("image/jpeg");
    expect(imageContentType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d]))).toBe("image/png");
    expect(imageContentType(new Uint8Array([0x47, 0x49, 0x46, 0x38]))).toBe("image/gif");
    expect(
      imageContentType(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])),
    ).toBe("image/webp");
    expect(imageContentType(new Uint8Array([0x25, 0x50, 0x44, 0x46]))).toBeNull();
  });
});

describe("sync adapter creator avatar upload", () => {
  it("posts cropped photo bytes to the creator avatar route", async () => {
    const { adapter, calls } = makeAdapter();
    const res = await adapter.marketplace.uploadCreatorAvatar(JPEG);
    expect(res.ok).toBe(true);
    expect(calls).toEqual([
      {
        cmd: "hq_pro_fetch",
        args: {
          url: WEB_PATHS.creatorAvatar,
          method: "POST",
          body: JSON.stringify({ contentType: "image/jpeg", data: "/9j/4AA=" }),
        },
      },
    ]);
  });

  it("keeps the native file-path upload for a path", async () => {
    const { adapter, calls } = makeAdapter("https://x/a.jpg");
    await adapter.marketplace.uploadCreatorAvatar("/tmp/me.png");
    expect(calls).toEqual([{ cmd: "upload_creator_avatar", args: { filePath: "/tmp/me.png" } }]);
  });

  it("refuses bytes that aren't an accepted image or are too large", async () => {
    const { adapter, calls } = makeAdapter();
    const pdf = await adapter.marketplace.uploadCreatorAvatar(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
    expect(pdf.ok).toBe(false);
    const big = new Uint8Array(2 * 1024 * 1024 + 1);
    big.set(JPEG);
    const tooBig = await adapter.marketplace.uploadCreatorAvatar(big);
    expect(tooBig.ok).toBe(false);
    expect(calls).toEqual([]);
  });
});
