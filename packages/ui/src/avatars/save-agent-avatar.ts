import { agentAvatarFor } from "../chat/messaging/agent-avatars.js";
import { resolvePackItemSrc } from "./parse-pack.js";
import {
  GENERATED_MARKS_AUTHOR,
  GENERATED_MARKS_PACK_ID,
  GENERATED_MARKS_PACK_NAME,
  type AvatarPack,
  type AvatarSelection,
} from "./types.js";

export interface PreparedAvatarBytes {
  base64: string;
  previewDataUrl: string;
}

export interface AgentProfileUpdateInput {
  avatarBase64: string;
}

export interface AgentProfileUpdateResult {
  uid?: string;
  profile?: { avatarBase64?: string; displayName?: string; description?: string };
  slackUpdated?: boolean;
}

export type AdapterResultLike<T> =
  | { ok: true; value: T }
  | { ok: false; reason?: string; message?: string; code?: string };

export interface SaveAgentAvatarDeps {
  packs: readonly AvatarPack[];
  fetchBytes: (url: string) => Promise<Uint8Array>;
  prepareAvatar: (bytes: Uint8Array) => Promise<PreparedAvatarBytes>;
  updateAgentProfile: (
    agentUid: string,
    input: AgentProfileUpdateInput,
  ) => Promise<AdapterResultLike<AgentProfileUpdateResult>>;
}

export interface SaveAgentAvatarResult {
  previewDataUrl: string;
  src: string;
  profile: AgentProfileUpdateResult | null;
}

function itemForSelection(
  packs: readonly AvatarPack[],
  selection: AvatarSelection,
  agentUid: string,
): { pack: AvatarPack; src: string } {
  if (selection.kind === "generated") {
    const generated =
      packs.find((pack) => pack.id === GENERATED_MARKS_PACK_ID) ?? null;
    const src = agentAvatarFor(agentUid) ?? generated?.items[0]?.src ?? "";
    if (!src) {
      throw new Error("No generated mark is bundled for this agent.");
    }
    return {
      pack: generated ?? {
        id: GENERATED_MARKS_PACK_ID,
        name: GENERATED_MARKS_PACK_NAME,
        version: "1.0.0",
        author: GENERATED_MARKS_AUTHOR,
        baseUrl: "builtin:generated-marks",
        items: [],
      },
      src,
    };
  }
  const pack = packs.find((entry) => entry.id === selection.packId);
  const item = pack?.items.find((entry) => entry.id === selection.itemId);
  if (!pack || !item) {
    throw new Error("That avatar is no longer in the loaded packs.");
  }
  return { pack, src: resolvePackItemSrc(pack, item) };
}

export async function saveAgentAvatar(
  agentUid: string,
  selection: AvatarSelection,
  deps: SaveAgentAvatarDeps,
): Promise<SaveAgentAvatarResult> {
  const uid = agentUid.trim();
  if (!uid) throw new Error("Missing agent.");
  const { src } = itemForSelection(deps.packs, selection, uid);
  const bytes = await deps.fetchBytes(src);
  if (bytes.byteLength === 0) {
    throw new Error("Could not download that avatar image.");
  }
  const prepared = await deps.prepareAvatar(bytes);
  const result = await deps.updateAgentProfile(uid, {
    avatarBase64: prepared.base64,
  });
  if (!result.ok) {
    throw new Error(result.message?.trim() || "Could not save the agent avatar.");
  }
  return {
    previewDataUrl: prepared.previewDataUrl,
    src,
    profile: result.value ?? null,
  };
}

export async function fetchBytesWith(
  fetchFn: (url: string, init?: RequestInit) => Promise<Response>,
  url: string,
): Promise<Uint8Array> {
  const response = await fetchFn(url, { credentials: "include" });
  if (!response.ok) {
    throw new Error(`Could not download avatar (${response.status}).`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

/** personUid → avatarUrl from a contacts payload (bare array or `{ contacts }`). */
/** Roster + contacts + self + session overrides. Overrides win so a just-saved
 *  photo paints before the next presign lands. */
export function composeAvatarByUid(input: {
  rosters?: Iterable<{ personUid?: string | null; avatarUrl?: string | null }>;
  contacts?: Record<string, string>;
  selfUid?: string | null;
  selfAvatarUrl?: string | null;
  overrides?: Record<string, string>;
}): Record<string, string> {
  const map: Record<string, string> = { ...(input.contacts ?? {}) };
  for (const row of input.rosters ?? []) {
    const uid = row.personUid?.trim();
    const url = row.avatarUrl?.trim();
    if (uid && url) map[uid] = url;
  }
  const selfUid = input.selfUid?.trim();
  const selfUrl = input.selfAvatarUrl?.trim();
  if (selfUid && selfUrl) map[selfUid] = selfUrl;
  return { ...map, ...(input.overrides ?? {}) };
}

export function avatarsFromContactPayload(
  value: unknown,
): Record<string, string> {
  const rows = Array.isArray(value)
    ? value
    : value &&
        typeof value === "object" &&
        Array.isArray((value as { contacts?: unknown }).contacts)
      ? (value as { contacts: unknown[] }).contacts
      : [];
  const map: Record<string, string> = {};
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const rec = row as Record<string, unknown>;
    const uid =
      typeof rec.personUid === "string"
        ? rec.personUid.trim()
        : typeof rec.uid === "string"
          ? rec.uid.trim()
          : "";
    const url =
      typeof rec.avatarUrl === "string"
        ? rec.avatarUrl.trim()
        : typeof rec.avatar_url === "string"
          ? rec.avatar_url.trim()
          : "";
    if (uid && url) map[uid] = url;
  }
  return map;
}
