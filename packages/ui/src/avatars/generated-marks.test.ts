import { describe, expect, it } from "vitest";

import { agentAvatarAssets } from "../chat/messaging/agent-avatars.js";
import { cspSafeAvatarSrc, resolvePackItemSrc } from "./parse-pack.js";
import { generatedMarksPack } from "./generated-marks.js";
import {
  GENERATED_MARKS_AUTHOR,
  GENERATED_MARKS_PACK_NAME,
} from "./types.js";

describe("generatedMarksPack", () => {
  it("labels the built-in pack Default, not HQ", () => {
    const pack = generatedMarksPack();
    expect(pack.name).toBe(GENERATED_MARKS_PACK_NAME);
    expect(pack.author).toBe(GENERATED_MARKS_AUTHOR);
    expect(pack.author).toBe("Default");
  });

  it("exposes a resolvable bundled src for every mark", () => {
    const pack = generatedMarksPack();
    expect(pack.items.length).toBe(agentAvatarAssets.length);
    expect(pack.items.length).toBeGreaterThanOrEqual(2);
    for (const item of pack.items) {
      const srcUrl = resolvePackItemSrc(pack, item);
      expect(srcUrl).toBe(item.src);
      expect(cspSafeAvatarSrc(srcUrl)).toBe(srcUrl);
      expect(srcUrl).not.toMatch(/^builtin:/);
      expect(srcUrl).not.toMatch(/^https?:/i);
      expect(agentAvatarAssets).toContain(item.src);
    }
  });
});
