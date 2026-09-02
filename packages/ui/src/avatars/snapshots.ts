import { parseAvatarPack } from "./parse-pack.js";
import {
  HQ_AGENT_MASCOTS_BASE_URL,
  type AvatarPack,
} from "./types.js";
import hqAgentMascots from "./packs/hq-agent-mascots.json" with { type: "json" };

const MASCOTS = parseAvatarPack(hqAgentMascots);

if (!MASCOTS.ok) {
  throw new Error(`bundled mascots snapshot is invalid: ${MASCOTS.error}`);
}

const BY_BASE_URL: Record<string, AvatarPack> = {
  [HQ_AGENT_MASCOTS_BASE_URL]: MASCOTS.pack,
};

export function bundledSnapshotFor(baseUrl: string): AvatarPack | null {
  const key = baseUrl.trim().replace(/\/+$/, "");
  return BY_BASE_URL[key] ?? null;
}

export const HQ_AGENT_MASCOTS_SNAPSHOT: AvatarPack = MASCOTS.pack;
