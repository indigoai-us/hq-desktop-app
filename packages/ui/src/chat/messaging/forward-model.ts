/**
 * Forward picker model (US-009). Pure: candidates come only from data already
 * in memory (sidebar rows and the @mention contacts roster), so the picker
 * opens with no network call and lists nothing the user cannot already see.
 *
 * Wire contract (hq-pro-core feat/dm-forward): the existing send routes take
 * `forwardOf { conversationId, eventId }`, `body` (the note), optional
 * `fileAccess` and `acknowledgeCrossCompany`.
 */
import type { ConversationRow } from "../sidebar-model.js";
import type { MentionTarget } from "../mentions.js";
import type { ConversationMessageWire } from "../chat-api.js";
import {
  artifactKindLabel,
  artifactPreviewLines,
  artifactTitle,
  type ArtifactKind,
} from "./artifact-model.js";

export type ForwardCandidateKind = "person" | "bot" | "channel" | "group";

export interface ForwardCandidate {
  /** `dm:<principalUid>` or `ch:<channelId>`. */
  id: string;
  kind: ForwardCandidateKind;
  name: string;
  /** Null when the row is not company-scoped (plain DMs, group DMs). */
  companyUid: string | null;
  principalUid?: string;
  channelId?: string;
}

export interface ForwardSource {
  conversationId: string;
  eventId: string;
  /** Company of the source conversation; null when the row has none. */
  companyUid: string | null;
  senderName: string;
  body: string;
  artifactKind?: ArtifactKind;
  artifactTitle?: string;
}

export interface ForwardCompany {
  uid: string;
  name: string;
}

export type ForwardErrorCode =
  | "FORWARD_SOURCE_NOT_FOUND"
  | "INVALID_FORWARD_OF"
  | "INVALID_FILE_ACCESS"
  | "FORWARD_FILES_NOT_ALLOWED"
  | "FORWARD_BODY_TOO_LARGE"
  | "FORWARD_DETAILS_TOO_LARGE"
  | "FORWARD_PROMPT_TOO_LARGE"
  | "FORWARD_NOT_SCHEDULABLE"
  | "FORWARD_NOT_CONNECTED"
  | "CROSS_COMPANY_FORBIDDEN"
  | "CROSS_COMPANY_ACK_REQUIRED"
  | "FORWARD_FILE_ACCESS_REQUIRED"
  | "FORWARD_FILE_SHARE_FORBIDDEN"
  | "FORWARD_FILE_GRANT_FAILED"
  | "NETWORK"
  | "UNKNOWN";

const KNOWN_CODES = new Set<string>([
  "FORWARD_SOURCE_NOT_FOUND",
  "INVALID_FORWARD_OF",
  "INVALID_FILE_ACCESS",
  "FORWARD_FILES_NOT_ALLOWED",
  "FORWARD_BODY_TOO_LARGE",
  "FORWARD_DETAILS_TOO_LARGE",
  "FORWARD_PROMPT_TOO_LARGE",
  "FORWARD_NOT_SCHEDULABLE",
  "FORWARD_NOT_CONNECTED",
  "CROSS_COMPANY_FORBIDDEN",
  "CROSS_COMPANY_ACK_REQUIRED",
  "FORWARD_FILE_ACCESS_REQUIRED",
  "FORWARD_FILE_SHARE_FORBIDDEN",
  "FORWARD_FILE_GRANT_FAILED",
]);

export interface ForwardFileRef {
  id?: string;
  name?: string;
}

export type ForwardResult =
  | { ok: true; omittedAttachments: number; eventId?: string }
  | {
      ok: false;
      code: ForwardErrorCode;
      status: number | null;
      sourceCompany?: ForwardCompany;
      destinationCompany?: ForwardCompany | null;
      files: ForwardFileRef[];
      notShareable: ForwardFileRef[];
      file?: ForwardFileRef;
    };

export interface ForwardRequest {
  destination: ForwardCandidate;
  forwardOf: { conversationId: string; eventId: string };
  note: string;
  fileAccess?: "grant" | "omit";
  acknowledgeCrossCompany?: boolean;
}

const MAX_CANDIDATES_NAME = 200;

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Destinations the user can already message, from the sidebar rows and the
 * contacts roster only. `companyUid` null means "the source scope": rows
 * without a company plus every contact. A company uid keeps rows and contacts
 * of that company, plus company-less rows when it is also the source company.
 */
export function buildForwardCandidates(
  rows: readonly ConversationRow[],
  contacts: readonly MentionTarget[],
  companyUid: string | null,
  sourceCompanyUid: string | null,
): ForwardCandidate[] {
  const target = clean(companyUid) || null;
  const source = clean(sourceCompanyUid) || null;
  const out: ForwardCandidate[] = [];
  const seen = new Set<string>();
  const inScope = (rowCompany: string | null): boolean => {
    if (!rowCompany) return target === null || target === source;
    return target === null ? rowCompany === source || source === null : rowCompany === target;
  };
  for (const row of rows ?? []) {
    if (!row || row.browseOnly || row.membership === "invited") continue;
    const rowCompany = clean(row.companyUid) || null;
    if (!inScope(rowCompany)) continue;
    const name = clean(row.title).slice(0, MAX_CANDIDATES_NAME);
    if (!name) continue;
    if (row.kind === "dm") {
      const uid = clean(row.personUid);
      if (!uid) continue;
      const id = `dm:${uid}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        kind: uid.startsWith("agt_") ? "bot" : "person",
        name,
        companyUid: rowCompany,
        principalUid: uid,
      });
    } else {
      const channelId = clean(row.channelId);
      if (!channelId) continue;
      const id = `ch:${channelId}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        kind: row.kind === "group" ? "group" : "channel",
        name,
        companyUid: rowCompany,
        channelId,
      });
    }
  }
  for (const contact of contacts ?? []) {
    const uid = clean(contact?.participantUid);
    if (!uid || uid === "here") continue;
    const contactCompany = clean(contact.companyUid) || null;
    if (target !== null && contactCompany !== target) continue;
    if (target === null && source !== null && contactCompany !== source) continue;
    const id = `dm:${uid}`;
    if (seen.has(id)) continue;
    const name = clean(contact.displayName).slice(0, MAX_CANDIDATES_NAME);
    if (!name) continue;
    seen.add(id);
    out.push({
      id,
      kind: contact.participantType === "agent" || uid.startsWith("agt_") ? "bot" : "person",
      name,
      companyUid: contactCompany,
      principalUid: uid,
    });
  }
  return out;
}

/** Case-insensitive substring match on the name. */
export function filterForwardCandidates(
  candidates: readonly ForwardCandidate[],
  query: string,
): ForwardCandidate[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...candidates];
  return candidates.filter((c) => c.name.toLowerCase().includes(q));
}

/** Companies where the user is owner or admin. */
export function adminCompaniesOf(
  companies: readonly { cloudUid: string | null; displayName: string; role: string | null }[] | null | undefined,
): ForwardCompany[] {
  const out: ForwardCompany[] = [];
  for (const c of companies ?? []) {
    const uid = clean(c?.cloudUid);
    const role = clean(c?.role).toLowerCase();
    if (!uid || (role !== "owner" && role !== "admin")) continue;
    if (out.some((x) => x.uid === uid)) continue;
    out.push({ uid, name: clean(c.displayName) || uid });
  }
  return out;
}

/**
 * The cross-company control shows only for an owner/admin of more than one
 * company, and only when the source company (if known) is one of them.
 */
export function showCompanyControl(
  adminCompanies: readonly ForwardCompany[],
  sourceCompanyUid: string | null,
): boolean {
  if (adminCompanies.length <= 1) return false;
  const source = clean(sourceCompanyUid);
  return !source || adminCompanies.some((c) => c.uid === source);
}

/** Build the picker source from a timeline message. */
export function forwardSourceFrom(
  msg: ConversationMessageWire,
  conversationId: string,
  companyUid: string | null,
  senderName: string,
): ForwardSource {
  const details = clean(msg.details);
  const prompt = clean(msg.prompt);
  const kind: ArtifactKind | undefined = details ? "details" : prompt ? "prompt" : undefined;
  const text = details || prompt;
  return {
    conversationId,
    eventId: msg.eventId,
    companyUid: clean(companyUid) || null,
    senderName: clean(senderName) || "Someone",
    body: typeof msg.body === "string" ? msg.body : "",
    ...(kind ? { artifactKind: kind, artifactTitle: artifactTitle(text, kind) } : {}),
  };
}

export const FORWARD_PREVIEW_LINES = 3;

export interface ForwardPreview {
  senderName: string;
  lines: string[];
  artifactLabel?: string;
}

export function forwardPreview(source: ForwardSource): ForwardPreview {
  return {
    senderName: source.senderName,
    lines: artifactPreviewLines(source.body ?? "", FORWARD_PREVIEW_LINES),
    ...(source.artifactKind && source.artifactTitle
      ? { artifactLabel: `${artifactKindLabel(source.artifactKind)}: ${source.artifactTitle}` }
      : {}),
  };
}

/** Route + payload for the existing send routes. */
export function buildForwardHttpRequest(req: ForwardRequest): {
  path: string;
  body: Record<string, unknown>;
} {
  const body: Record<string, unknown> = {
    body: req.note.trim(),
    forwardOf: {
      conversationId: req.forwardOf.conversationId,
      eventId: req.forwardOf.eventId,
    },
  };
  if (req.fileAccess) body.fileAccess = req.fileAccess;
  if (req.acknowledgeCrossCompany === true) body.acknowledgeCrossCompany = true;
  const dest = req.destination;
  if (dest.channelId) {
    return {
      path: `/v1/notify/channels/${encodeURIComponent(dest.channelId)}/messages`,
      body,
    };
  }
  return { path: "/v1/notify/dm", body: { toPersonUid: dest.principalUid ?? "", ...body } };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function fileRefs(value: unknown): ForwardFileRef[] {
  if (!Array.isArray(value)) return [];
  const out: ForwardFileRef[] = [];
  for (const item of value) {
    const rec = asRecord(item);
    if (!rec) continue;
    const id = clean(rec.id);
    const name = clean(rec.name);
    out.push({ ...(id ? { id } : {}), ...(name ? { name } : {}) });
  }
  return out;
}

function companyRef(value: unknown): ForwardCompany | undefined {
  const rec = asRecord(value);
  const uid = clean(rec?.uid);
  if (!uid) return undefined;
  return { uid, name: clean(rec?.name) || uid };
}

/** Parse the HTTP answer once. Array fields are coerced here. */
export function parseForwardResponse(status: number | null, text: string): ForwardResult {
  let parsed: unknown = null;
  try {
    parsed = text && text.trim() ? JSON.parse(text) : {};
  } catch {
    parsed = null;
  }
  const rec = asRecord(parsed) ?? {};
  if (status !== null && status >= 200 && status < 300) {
    const omitted = typeof rec.omittedAttachments === "number" && rec.omittedAttachments > 0
      ? Math.floor(rec.omittedAttachments)
      : 0;
    const eventId = clean(rec.eventId);
    return { ok: true, omittedAttachments: omitted, ...(eventId ? { eventId } : {}) };
  }
  const rawCode = clean(rec.code);
  const code: ForwardErrorCode = KNOWN_CODES.has(rawCode)
    ? (rawCode as ForwardErrorCode)
    : status === null
      ? "NETWORK"
      : "UNKNOWN";
  const destination = rec.destinationCompany === null ? null : companyRef(rec.destinationCompany);
  const file = asRecord(rec.file) ? fileRefs([rec.file])[0] : undefined;
  return {
    ok: false,
    code,
    status,
    files: fileRefs(rec.files),
    notShareable: fileRefs(rec.notShareable),
    ...(companyRef(rec.sourceCompany) ? { sourceCompany: companyRef(rec.sourceCompany) } : {}),
    ...(destination !== undefined ? { destinationCompany: destination } : {}),
    ...(file ? { file } : {}),
  };
}

/**
 * A plain sentence and a next action for every code. Never the server's
 * `error` text or any JSON.
 */
export function forwardErrorMessage(
  result: Extract<ForwardResult, { ok: false }>,
  ctx: { destinationName: string; sourceCompanyName?: string },
): string {
  const name = ctx.destinationName || "them";
  switch (result.code) {
    case "FORWARD_SOURCE_NOT_FOUND":
      return "That message is no longer available. Close this and refresh the conversation.";
    case "FORWARD_BODY_TOO_LARGE":
    case "FORWARD_DETAILS_TOO_LARGE":
    case "FORWARD_PROMPT_TOO_LARGE":
      return "This message is too long to forward. Copy the part you need and send it instead.";
    case "FORWARD_NOT_CONNECTED":
      return `You're not connected with ${name} yet. Send them a message first.`;
    case "FORWARD_NOT_SCHEDULABLE":
      return "Scheduled messages can't be forwarded. Pick another message.";
    case "CROSS_COMPANY_FORBIDDEN": {
      const source = result.sourceCompany?.name || ctx.sourceCompanyName || "the original company";
      return `You need to be an owner or admin in both companies to forward there. Pick someone in ${source}.`;
    }
    case "FORWARD_FILES_NOT_ALLOWED":
      return "Files can't be sent to another company. Send without files and try again.";
    case "FORWARD_FILE_SHARE_FORBIDDEN":
      return `You can't share these files with ${name}. Send without files instead.`;
    case "FORWARD_FILE_GRANT_FAILED":
      return `Couldn't share ${result.file?.name || "a file"}. Try again, or send without files.`;
    case "FORWARD_FILE_ACCESS_REQUIRED":
      return `Some files in this message are not shared with ${name}. Share them, or send without files.`;
    case "CROSS_COMPANY_ACK_REQUIRED":
      return "This goes to another company. Confirm to send it.";
    case "NETWORK":
      return "Couldn't reach HQ. Check your connection and try again.";
    default:
      return "Something went wrong forwarding. Try again.";
  }
}

export function forwardConfirmation(destinationName: string, omittedAttachments: number): string {
  const base = `Forwarded to ${destinationName}.`;
  if (omittedAttachments <= 0) return base;
  return `${base} ${omittedAttachments} ${omittedAttachments === 1 ? "file" : "files"} not included.`;
}
