import { describe, expect, it, vi } from "vitest";

import {
  avatarsFromContactPayload,
  composeAvatarByUid,
  saveAgentAvatar,
} from "./save-agent-avatar.js";
import type { AvatarPack } from "./types.js";

const packs: AvatarPack[] = [
  {
    id: "generated-marks",
    name: "Generated marks",
    version: "1.0.0",
    author: "Default",
    baseUrl: "builtin:generated-marks",
    items: [
      { id: "agent-01", name: "Mark 01", src: "/assets/agent-01.png", tags: [] },
    ],
  },
  {
    id: "hq-agent-mascots",
    name: "Animals",
    version: "1.0.0",
    author: "Lizzy",
    baseUrl: "https://hq-agent-mascots.indigo-hq.com",
    items: [
      {
        id: "v2-dot",
        name: "Dot · simplified",
        src: "/src/avatars/packs/hq-agent-mascots/mascots/v2/dot.png",
        tags: ["v2"],
      },
    ],
  },
];

describe("saveAgentAvatar", () => {
  it("downloads the pack image and PATCHes avatarBase64", async () => {
    const updateAgentProfile = vi.fn(async (uid: string, input: { avatarBase64: string }) => {
      expect(uid).toBe("agt_scout");
      expect(input.avatarBase64).toBe("YmFzZTY0");
      return { ok: true as const, value: { uid, slackUpdated: false } };
    });
    const fetchBytes = vi.fn(async (url: string) => {
      expect(url).toBe(
        "/src/avatars/packs/hq-agent-mascots/mascots/v2/dot.png",
      );
      return new Uint8Array([1, 2, 3]);
    });
    const result = await saveAgentAvatar(
      "agt_scout",
      { kind: "item", packId: "hq-agent-mascots", itemId: "v2-dot" },
      {
        packs,
        fetchBytes,
        prepareAvatar: async (bytes) => {
          expect(Array.from(bytes)).toEqual([1, 2, 3]);
          return { base64: "YmFzZTY0", previewDataUrl: "data:image/jpeg;base64,YmFzZTY0" };
        },
        updateAgentProfile,
      },
    );
    expect(updateAgentProfile).toHaveBeenCalledTimes(1);
    expect(result.previewDataUrl).toContain("data:image/jpeg");
  });

  it("uploads the generated mark for the Use generated mark path", async () => {
    const updateAgentProfile = vi.fn(async () => ({
      ok: true as const,
      value: { uid: "agt_scout" },
    }));
    const fetchBytes = vi.fn(async (url: string) => {
      expect(url.length).toBeGreaterThan(0);
      return new Uint8Array([9]);
    });
    await saveAgentAvatar("agt_scout", { kind: "generated" }, {
      packs,
      fetchBytes,
      prepareAvatar: async () => ({
        base64: "Z2Vu",
        previewDataUrl: "data:image/jpeg;base64,Z2Vu",
      }),
      updateAgentProfile,
    });
    expect(updateAgentProfile).toHaveBeenCalledWith("agt_scout", {
      avatarBase64: "Z2Vu",
    });
  });

  it("surfaces adapter failures", async () => {
    await expect(
      saveAgentAvatar(
        "agt_scout",
        { kind: "item", packId: "hq-agent-mascots", itemId: "v2-dot" },
        {
          packs,
          fetchBytes: async () => new Uint8Array([1]),
          prepareAvatar: async () => ({
            base64: "x",
            previewDataUrl: "data:image/jpeg;base64,x",
          }),
          updateAgentProfile: async () => ({
            ok: false,
            message: "not authorized",
          }),
        },
      ),
    ).rejects.toThrow("not authorized");
  });
});

describe("composeAvatarByUid", () => {
  it("lets a post-save override win over roster and contacts", () => {
    expect(
      composeAvatarByUid({
        rosters: [{ personUid: "agt_a", avatarUrl: "https://cdn/old.png" }],
        contacts: { agt_a: "https://cdn/contact.png" },
        overrides: { agt_a: "data:image/jpeg;base64,xx" },
      }).agt_a,
    ).toBe("data:image/jpeg;base64,xx");
  });

  it("includes roster and signed-in profile photos for people", () => {
    expect(
      composeAvatarByUid({
        rosters: [{ personUid: "prs_ada", avatarUrl: "https://cdn/ada.jpg" }],
        selfUid: "prs_me",
        selfAvatarUrl: "https://cdn/me.jpg",
      }),
    ).toEqual({
      prs_ada: "https://cdn/ada.jpg",
      prs_me: "https://cdn/me.jpg",
    });
  });
});

describe("avatarsFromContactPayload", () => {
  it("reads avatarUrl from a contacts envelope or bare array", () => {
    expect(
      avatarsFromContactPayload({
        contacts: [{ personUid: "agt_a", avatarUrl: "https://cdn/a.png" }],
      }),
    ).toEqual({ agt_a: "https://cdn/a.png" });
    expect(
      avatarsFromContactPayload([
        { uid: "agt_b", avatar_url: "https://cdn/b.png" },
      ]),
    ).toEqual({ agt_b: "https://cdn/b.png" });
  });
});
