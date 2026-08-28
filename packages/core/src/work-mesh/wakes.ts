/**
 * Ids-only work-mesh doorbell parsers — ported from
 * hq-desktop-core work_mesh_cache.rs so web + desktop share one contract.
 * MQTT never carries message bodies; these wakes only name what to re-read
 * from the machine cache / REST.
 */

export interface BoardWake {
  v: number;
  kind: string;
  companyUid: string;
  projectId?: string;
  storyId?: string;
  mutation: string;
  boardVersion?: string;
}

export function isSafeCacheSegment(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 128) return false;
  if (trimmed === "." || trimmed === ".." || trimmed.includes("..")) {
    return false;
  }
  return /^[A-Za-z0-9_.-]+$/.test(trimmed);
}

function asRecord(raw: unknown): Record<string, unknown> | null {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null;
}

export function parseBoardWake(raw: unknown): BoardWake | null {
  const obj = asRecord(raw);
  if (!obj) return null;
  const v = typeof obj.v === "number" ? obj.v : Number(obj.v);
  const kind = typeof obj.kind === "string" ? obj.kind : "";
  const companyUid =
    typeof obj.companyUid === "string" ? obj.companyUid.trim() : "";
  const mutation = typeof obj.mutation === "string" ? obj.mutation : "";
  if (v !== 1 || kind !== "board" || !isSafeCacheSegment(companyUid)) {
    return null;
  }
  const projectId =
    typeof obj.projectId === "string" ? obj.projectId.trim() : "";
  if (projectId && !isSafeCacheSegment(projectId)) return null;
  return {
    v: 1,
    kind: "board",
    companyUid,
    projectId: projectId || undefined,
    storyId: typeof obj.storyId === "string" ? obj.storyId : undefined,
    mutation,
    boardVersion:
      typeof obj.boardVersion === "string" ? obj.boardVersion : undefined,
  };
}

export function wakeRefreshesProjectView(wake: BoardWake): boolean {
  return (
    wake.mutation === "project-view" ||
    wake.mutation === "story-patch" ||
    wake.mutation === "promote" ||
    wake.mutation === "board-put"
  );
}

/** Returns the `chn_*` to re-read from the channel-messages cache. */
export function parseChannelMessageWake(raw: unknown): string | null {
  const obj = asRecord(raw);
  if (!obj) return null;
  const eventType = typeof obj.eventType === "string" ? obj.eventType : "";
  if (eventType === "channel.directory.changed") return null;
  const wakeType = typeof obj.type === "string" ? obj.type : "";
  if (
    wakeType !== "channel" &&
    wakeType !== "thread" &&
    eventType !== "message.created"
  ) {
    return null;
  }
  const id = typeof obj.channelId === "string" ? obj.channelId.trim() : "";
  return isSafeCacheSegment(id) ? id : null;
}

/** Live project/channel rows come from the machine cache, never fixtures. */
export function isLiveMeshChannelId(
  channelId: string | null | undefined,
): boolean {
  const id = channelId?.trim() ?? "";
  return id.startsWith("chn_") || id.startsWith("cmp_");
}
