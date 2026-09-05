/**
 * Accept the hq-pro directory envelope or a looser channels/rows array and
 * return the contractVersion-2 snapshot the sidebar reconciler expects.
 */

import type {
  ChannelDirectoryFeed,
  ChannelDirectoryRow,
} from "./channel-directory-reconciler.js";

export type { ChannelDirectoryRow };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** hq-pro message routes only accept minted `chn_*` ids — never project slugs. */
function asMintedChannelId(...values: unknown[]): string {
  for (const value of values) {
    const text = asString(value).trim();
    if (text.startsWith("chn_")) return text;
  }
  return "";
}

function asMembers(value: unknown): ChannelDirectoryRow["members"] | undefined {
  if (!Array.isArray(value)) return undefined;
  const members: NonNullable<ChannelDirectoryRow["members"]> = [];
  for (const item of value) {
    const rec = asRecord(item);
    if (!rec) continue;
    const personUid = asString(rec.personUid ?? rec.person_uid).trim();
    if (!personUid) continue;
    members.push({
      personUid,
      displayName: asString(rec.displayName ?? rec.display_name),
    });
  }
  return members.length > 0 ? members : undefined;
}

function pickActivity(...values: unknown[]): string | null {
  for (const value of values) {
    const text = asString(value);
    if (text) return text;
  }
  return null;
}

/**
 * hq-pro list payloads nest the fabric row on `directoryRow` and leave the
 * top-level `name` / `lastActivityAt` / `type` empty for group DMs. Prefer
 * the nested row, then fill members + projectId from the parent.
 */
function asRow(value: unknown): ChannelDirectoryRow | null {
  const rec = asRecord(value);
  if (!rec) return null;
  const nested = asRecord(rec.directoryRow);
  // Prefer explicit channelId fields, then id — but only minted chn_* values.
  // Falling back to project slugs (proj-*) produced CHANNEL_NOT_FOUND on send.
  const channelId = asMintedChannelId(
    rec.channelId,
    rec.channel_id,
    nested?.channelId,
    nested?.channel_id,
    rec.id,
    nested?.id,
  );
  if (!channelId) return null;
  const members = asMembers(rec.members) ?? asMembers(nested?.members);
  const type = asString(rec.type) || asString(nested?.type) || undefined;
  const scope =
    asString(rec.scope) ||
    asString(nested?.scope) ||
    (type === "project" ? "project" : "company");
  const name = asString(rec.name ?? rec.title) || asString(nested?.name);
  const explicitProjectId = asString(
    rec.projectId ?? rec.project_id ?? nested?.projectId,
  );
  const nameSlug = name.replace(/^#\s*/, "").trim();
  const projectId =
    explicitProjectId ||
    ((scope === "project" || type === "project") &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(nameSlug)
      ? nameSlug
      : "") ||
    null;
  return {
    channelId,
    type,
    scope,
    companyUid:
      asString(
        rec.companyUid ?? rec.company_uid ?? rec.cloudUid ?? nested?.companyUid,
      ) || null,
    companyName:
      asString(
        rec.companyName ?? rec.company_name ?? nested?.companyName,
      ) || null,
    projectId,
    name,
    subtitle: asString(rec.subtitle) || asString(nested?.subtitle) || undefined,
    lastActivityAt: pickActivity(
      rec.lastActivityAt ?? rec.last_activity_at,
      nested?.lastActivityAt ?? nested?.last_activity_at,
    ),
    createdAt: pickActivity(rec.createdAt ?? rec.created_at, nested?.createdAt),
    updatedAt: pickActivity(rec.updatedAt ?? rec.updated_at, nested?.updatedAt),
    unreadCount:
      typeof rec.unreadCount === "number"
        ? rec.unreadCount
        : typeof rec.unread_count === "number"
          ? rec.unread_count
          : typeof nested?.unreadCount === "number"
            ? nested.unreadCount
            : undefined,
    mentionFlag:
      rec.mentionFlag === true || nested?.mentionFlag === true
        ? true
        : undefined,
    memberCount:
      typeof rec.memberCount === "number"
        ? rec.memberCount
        : typeof rec.member_count === "number"
          ? rec.member_count
          : typeof nested?.memberCount === "number"
            ? nested.memberCount
            : members?.length,
    ...(members ? { members } : {}),
  };
}

export function snapshotDirectoryFeed(
  rows: ChannelDirectoryRow[],
): ChannelDirectoryFeed {
  const now = Date.now();
  return {
    contractVersion: 2,
    snapshot: true,
    cursor: "livefeed0000000000000000000000000000",
    cursorExpiresAt: new Date(now + 30 * 86_400_000).toISOString(),
    rows,
  };
}

function looksLikeProjectSlug(value: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

function enrichDirectoryRow(row: ChannelDirectoryRow): ChannelDirectoryRow {
  const type = row.type ?? "";
  const scope = row.scope || (type === "project" ? "project" : row.scope);
  const nameSlug = (row.name ?? "").replace(/^#\s*/, "").trim();
  const projectId =
    (row.projectId ?? "").trim() ||
    ((scope === "project" || type === "project") &&
    looksLikeProjectSlug(nameSlug)
      ? nameSlug
      : "");
  if (scope === row.scope && projectId === (row.projectId ?? "")) return row;
  return {
    ...row,
    scope,
    projectId: projectId || row.projectId || null,
  };
}

export function normalizeDirectoryFeed(raw: unknown): ChannelDirectoryFeed {
  const rec = asRecord(raw);
  if (rec && typeof rec.snapshot === "boolean" && asString(rec.cursor)) {
    const feed = raw as ChannelDirectoryFeed;
    const rows = Array.isArray(feed.rows)
      ? feed.rows.map(enrichDirectoryRow)
      : feed.rows;
    const changed = Array.isArray(rows)
      ? rows.some((row, i) => row !== feed.rows?.[i])
      : false;
    return changed ? { ...feed, rows } : feed;
  }
  const list = Array.isArray(rec?.rows)
    ? rec.rows
    : Array.isArray(rec?.channels)
      ? rec.channels
      : Array.isArray(rec?.changed)
        ? rec.changed
        : Array.isArray(raw)
          ? raw
          : [];
  return snapshotDirectoryFeed(list.map(asRow).filter((row) => row != null));
}

export function directoryRowCount(feed: ChannelDirectoryFeed): number {
  return (feed.rows?.length ?? 0) + (feed.changed?.length ?? 0);
}
