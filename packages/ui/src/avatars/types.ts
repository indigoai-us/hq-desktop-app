/** One image in an avatar pack. */
export interface AvatarPackItem {
  id: string;
  name: string;
  /** Relative to the pack `baseUrl`, or an absolute http(s) URL. */
  src: string;
  tags: string[];
}

/** Versioned catalog of agent avatars served from one host. */
export interface AvatarPack {
  id: string;
  name: string;
  version: string;
  author: string;
  baseUrl: string;
  items: AvatarPackItem[];
}

export type AvatarSelection =
  | { kind: "generated" }
  | { kind: "item"; packId: string; itemId: string };

export const GENERATED_MARKS_PACK_ID = "generated-marks";
export const GENERATED_MARKS_BASE_URL = "builtin:generated-marks";
export const HQ_AGENT_MASCOTS_BASE_URL =
  "https://hq-agent-mascots.indigo-hq.com";

export const PACK_REGISTRY_STORAGE_KEY = "hq-avatar-pack-urls";
