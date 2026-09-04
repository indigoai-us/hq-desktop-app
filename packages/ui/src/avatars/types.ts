/** One image in an avatar pack. */
export interface AvatarPackItem {
  id: string;
  name: string;
  /** Tile src — a bundled asset, or a presigned marketplace thumb URL. */
  src: string;
  /** Optional full-size presigned URL (remote packs). */
  fullUrl?: string;
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
  expiresAt?: number;
}

export type AvatarSelection =
  | { kind: "generated" }
  | { kind: "item"; packId: string; itemId: string };

export const GENERATED_MARKS_PACK_ID = "generated-marks";
export const GENERATED_MARKS_PACK_NAME = "Generated marks";
export const GENERATED_MARKS_AUTHOR = "Default";
export const GENERATED_MARKS_BASE_URL = "builtin:generated-marks";

export const HQ_AGENT_MASCOTS_PACK_ID = "hq-agent-mascots";
export const HQ_AGENT_MASCOTS_PACK_NAME = "Animals";
export const HQ_AGENT_MASCOTS_AUTHOR = "Lizzy";
export const HQ_AGENT_MASCOTS_BASE_URL =
  "https://hq-agent-mascots.indigo-hq.com";

export const GALLERY_CACHE_STORAGE_KEY = "hq-avatar-packs-gallery";
