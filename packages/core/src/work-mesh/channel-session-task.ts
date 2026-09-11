import type { MeshStory } from "./types.js";

export const CHANNEL_SESSION_ORIGIN_PREFIX = "hq-channel-session:";

export function channelSessionOriginKey(
  origin:
    | { kind: "message"; eventId: string }
    | { kind: "channel"; channelId: string },
): string {
  return origin.kind === "message"
    ? `${CHANNEL_SESSION_ORIGIN_PREFIX}message:${origin.eventId}`
    : `${CHANNEL_SESSION_ORIGIN_PREFIX}channel:${origin.channelId}`;
}

export function findDuplicateChannelSessionStory(
  stories: readonly MeshStory[],
  originKey: string,
  _title?: string,
): MeshStory | null {
  const key = originKey.trim();
  if (!key) return null;
  return (
    stories.find((story) => (story.description ?? "").includes(key)) ?? null
  );
}

export function nextUsStoryId(stories: readonly MeshStory[]): string {
  let max = 0;
  for (const story of stories) {
    const match = /^US-(\d+)$/i.exec((story.id ?? "").trim());
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `US-${String(max + 1).padStart(3, "0")}`;
}

export function channelSessionStoryDraft(input: {
  originKey: string;
  title: string;
  excerpt?: string;
}): { title: string; description: string; status: string; passes: boolean } {
  const excerpt = (input.excerpt ?? "").trim();
  const description = excerpt
    ? `${input.originKey}\n\n${excerpt}`
    : input.originKey;
  return {
    title: input.title.trim() || "Channel session",
    description,
    status: "in_progress",
    passes: false,
  };
}
