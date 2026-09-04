import { agentAvatarAssets } from "../chat/messaging/agent-avatars.js";
import {
  GENERATED_MARKS_AUTHOR,
  GENERATED_MARKS_BASE_URL,
  GENERATED_MARKS_PACK_ID,
  GENERATED_MARKS_PACK_NAME,
  type AvatarPack,
} from "./types.js";

function itemIdForAsset(src: string, index: number): string {
  const match = /agent-(\d+)/i.exec(src);
  if (match?.[1]) return `agent-${match[1]}`;
  return `agent-${String(index + 1).padStart(2, "0")}`;
}

function itemNameForId(id: string, index: number): string {
  const match = /agent-(\d+)/i.exec(id);
  const n = match?.[1] ?? String(index + 1).padStart(2, "0");
  return `Mark ${n}`;
}

/** Built-in pack wrapping the deterministic generated-avatar PNGs. */
export function generatedMarksPack(
  assets: readonly string[] = agentAvatarAssets,
): AvatarPack {
  return {
    id: GENERATED_MARKS_PACK_ID,
    name: GENERATED_MARKS_PACK_NAME,
    version: "1.0.0",
    author: GENERATED_MARKS_AUTHOR,
    baseUrl: GENERATED_MARKS_BASE_URL,
    items: assets.map((src, index) => {
      const id = itemIdForAsset(src, index);
      return {
        id,
        name: itemNameForId(id, index),
        src,
        tags: ["generated", "mark"],
      };
    }),
  };
}
