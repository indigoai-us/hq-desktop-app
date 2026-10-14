/**
 * Shared-folder and access-request timeline cards (console-rail US-015,
 * storyboard scene home-share-request).
 *
 * A DM can carry a vault share ("here is a folder") or an access request
 * ("can I read this folder"). Both arrive as a v1 system-event envelope on an
 * ordinary timeline message. This module parses the envelope and builds the
 * prompt and action ids; the card itself stays zero-network and bubbles the
 * Approve / Deny decision to the host through the existing card-action seam.
 *
 * Grant levels are read and write only. Anything else reads as read.
 */

import { isRecord } from "../../common/is-record.js";
import { buildClaudeCodeUrl } from "../../settings/claude-code-link.js";

export type ShareGrantLevel = "read" | "write";

export interface ShareFileRow {
  name: string;
  sizeLabel: string | null;
}

export interface SharedFolderCardModel {
  kind: "shared_folder";
  id: string;
  path: string;
  level: ShareGrantLevel;
  files: ShareFileRow[];
  sharedBy: string | null;
  companyUid: string | null;
}

export type AccessRequestState = "pending" | "approved" | "denied";

export interface AccessRequestCardModel {
  kind: "access_request";
  id: string;
  path: string;
  level: ShareGrantLevel;
  note: string | null;
  requestedBy: string | null;
  requestedAt: string | null;
  state: AccessRequestState;
  /** Viewer may approve or deny. Absent on the wire → true (the server gates). */
  canAct: boolean;
  companyUid: string | null;
}

export type ShareRequestCardModel = SharedFolderCardModel | AccessRequestCardModel;

const SHARE_TYPES = new Set(["vault_share", "shared_folder", "folder_share"]);
const REQUEST_TYPES = new Set([
  "access_request",
  "vault_access_request",
  "share_request",
  "grant_request",
]);

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function shareGrantLevel(value: unknown): ShareGrantLevel {
  return typeof value === "string" && /^(write|rw|read_write|edit)$/i.test(value.trim())
    ? "write"
    : "read";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function parseFiles(raw: unknown): ShareFileRow[] {
  if (!Array.isArray(raw)) return [];
  const out: ShareFileRow[] = [];
  for (const item of raw) {
    if (typeof item === "string" && item.trim()) {
      out.push({ name: item.trim(), sizeLabel: null });
    } else if (isRecord(item)) {
      const name = str(item.name) ?? str(item.path);
      if (!name) continue;
      const size = typeof item.size === "number" && item.size >= 0 ? item.size : null;
      out.push({ name, sizeLabel: size === null ? null : formatBytes(size) });
    }
  }
  return out;
}

function requestState(value: unknown): AccessRequestState {
  const v = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (v === "approved" || v === "granted") return "approved";
  if (v === "denied" || v === "declined") return "denied";
  return "pending";
}

/**
 * Parse a share or access-request envelope. Unknown versions, unknown types,
 * and envelopes without a path return null so the row falls back to the
 * ordinary message renderer.
 */
export function parseShareRequestEvent(raw: unknown): ShareRequestCardModel | null {
  if (!isRecord(raw)) return null;
  if ("v" in raw && raw.v !== 1 && raw.v !== "1") return null;
  const type = str(raw.type)?.toLowerCase();
  if (!type) return null;
  const path = str(raw.path) ?? str(raw.prefix);
  if (!path) return null;
  const id = str(raw.id) ?? str(raw.requestId) ?? str(raw.shareId) ?? path;
  const companyUid = str(raw.companyUid);
  const level = shareGrantLevel(raw.level ?? raw.access);
  if (SHARE_TYPES.has(type)) {
    return {
      kind: "shared_folder",
      id,
      path,
      level,
      files: parseFiles(raw.files),
      sharedBy: str(raw.sharedBy) ?? str(raw.displayName),
      companyUid,
    };
  }
  if (REQUEST_TYPES.has(type)) {
    return {
      kind: "access_request",
      id,
      path,
      level,
      note: str(raw.note) ?? str(raw.summary),
      requestedBy: str(raw.requestedBy) ?? str(raw.displayName),
      requestedAt: str(raw.requestedAt) ?? str(raw.createdAt),
      state: requestState(raw.state ?? raw.status),
      canAct: raw.canAct !== false,
      companyUid,
    };
  }
  return null;
}

/** Prompt the user pastes into Claude Code or Codex to work in the shared folder. */
export function sharePrompt(model: ShareRequestCardModel): string {
  const verb = model.level === "write" ? "Read and edit" : "Read";
  return `${verb} the shared HQ folder ${model.path} and summarize what is in it. Use /hq-files if access is missing.`;
}

export function shareOpenInClaudeUrl(
  model: ShareRequestCardModel,
  folder: string | null | undefined,
): string {
  return buildClaudeCodeUrl({ folder: folder?.trim() ?? "", prompt: sharePrompt(model) });
}

/** Card-action ids the host posts through `runCardAction`. */
export function accessDecisionActionId(
  decision: "approve" | "deny",
  level: ShareGrantLevel,
): "grant_read" | "grant_write" | "deny" {
  if (decision === "deny") return "deny";
  return level === "write" ? "grant_write" : "grant_read";
}

export function levelLabel(level: ShareGrantLevel): "Read" | "Write" {
  return level === "write" ? "Write" : "Read";
}
