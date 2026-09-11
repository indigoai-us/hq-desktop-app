import { describe, expect, it } from "vitest";
import {
  channelSessionOriginKey,
  channelSessionStoryDraft,
  findDuplicateChannelSessionStory,
  nextUsStoryId,
} from "./channel-session-task.js";
import type { MeshStory } from "./types.js";

const stories: MeshStory[] = [
  { id: "US-007", title: "Accept matrix", status: "in_progress" },
  {
    id: "US-008",
    title: "Paste images",
    status: "done",
    description: "hq-channel-session:message:evt_old",
  },
];

describe("channel-session-task", () => {
  it("keys message and channel origins separately", () => {
    expect(channelSessionOriginKey({ kind: "message", eventId: "evt_1" })).toBe(
      "hq-channel-session:message:evt_1",
    );
    expect(channelSessionOriginKey({ kind: "channel", channelId: "chn_1" })).toBe(
      "hq-channel-session:channel:chn_1",
    );
  });

  it("reuses a story whose description carries the origin key", () => {
    const found = findDuplicateChannelSessionStory(
      stories,
      "hq-channel-session:message:evt_old",
      "Something else",
    );
    expect(found?.id).toBe("US-008");
  });

  it("does not reuse a story just because the title matches", () => {
    const found = findDuplicateChannelSessionStory(
      [...stories, { id: "US-009", title: "Cache models", status: "queued" }],
      "hq-channel-session:message:new",
      "Cache models",
    );
    expect(found).toBeNull();
  });

  it("allocates the next US- id", () => {
    expect(nextUsStoryId(stories)).toBe("US-009");
    expect(nextUsStoryId([])).toBe("US-001");
  });

  it("embeds the origin key in the created description", () => {
    const draft = channelSessionStoryDraft({
      originKey: "hq-channel-session:message:evt_1",
      title: "Cache models",
      excerpt: "Let's cache the models list",
    });
    expect(draft.description).toContain("hq-channel-session:message:evt_1");
    expect(draft.status).toBe("in_progress");
  });
});
