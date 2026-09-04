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
  it("selects a remote pack item through the adapter and skips the upload path", async () => {
    const updateAgentProfile = vi.fn();
    const selectAgentAvatar = vi.fn(async (uid: string, input: { packId: string; itemId: string }) => {
      expect(uid).toBe("agt_scout");
      expect(input).toEqual({ packId: "hq-agent-mascots", itemId: "v2-dot" });
      return {
        ok: true as const,
        value: {
          uid,
          avatarUrl: "https://hq-marketplace-assets-hq-prod.s3.us-east-1.amazonaws.com/agents/agt_scout/hash.png",
          slackUpdated: false,
        },
      };
    });
    const result = await saveAgentAvatar(
      "agt_scout",
      { kind: "item", packId: "hq-agent-mascots", itemId: "v2-dot" },
      {
        packs,
        fetchBytes: async () => {
          throw new Error("should not fetch pack bytes");
        },
        prepareAvatar: async () => {
          throw new Error("should not prepare pack bytes");
        },
        updateAgentProfile,
        selectAgentAvatar,
      },
    );
    expect(updateAgentProfile).not.toHaveBeenCalled();
    expect(selectAgentAvatar).toHaveBeenCalledTimes(1);
    expect(result.previewDataUrl).toContain("/agents/agt_scout/");
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
            message: "should not PATCH",
          }),
          selectAgentAvatar: async () => ({
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
