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
  /** Epoch-ms of the row's latest activity; 0 for roster-only contacts. */
  lastActivityAt: number;
  /** Second line under the name: email for people, company for scoped rows. */
  subtitle?: string;
}

export type ForwardOriginKind = "channel" | "dm" | "group";

export interface ForwardOrigin {
  kind: ForwardOriginKind;
  /** Channel or conversation title the message was taken from. */
  label: string;
}

export interface ForwardSource {
  conversationId: string;
  eventId: string;
  /** Company of the source conversation; null when the row has none. */
  companyUid: string | null;
  senderName: string;
  /** Sender principal, for the avatar on the quoted card. */
  senderUid?: string;
  /** ISO time of the source message, for the quoted card. */
  createdAt?: string;
  /** Where the message came from, for the quoted card. */
  origin?: ForwardOrigin;
  body: string;
  artifactKind?: ArtifactKind;
  artifactTitle?: string;
  /** Files hung off the source message (US-010). */
  attachmentCount: number;
  attachmentNames: string[];
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
        lastActivityAt: activityOf(row.lastActivityAt),
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
        lastActivityAt: activityOf(row.lastActivityAt),
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
    const subtitle = clean(contact.email) || clean(contact.companyName);
    out.push({
      id,
      kind: contact.participantType === "agent" || uid.startsWith("agt_") ? "bot" : "person",
      name,
      companyUid: contactCompany,
      principalUid: uid,
      lastActivityAt: 0,
      ...(subtitle ? { subtitle } : {}),
    });
  }
  return out;
}

function activityOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

export type ForwardSectionKey = "recent" | "channels" | "people" | "bots";

export interface ForwardSection {
  key: ForwardSectionKey;
  label: string;
  items: ForwardCandidate[];
}

export const FORWARD_RECENT_LIMIT = 5;

const SECTION_LABEL: Record<ForwardSectionKey, string> = {
  recent: "Recent",
  channels: "Channels",
  people: "People",
  bots: "Bots",
};

/**
 * Group candidates for the picker list. With no query the first section is
 * the most recently active destinations; the rest are split by kind and
 * sorted by recency then name. A query drops the recent section and keeps
 * only matches, so a destination never appears twice.
 */
export function groupForwardCandidates(
  candidates: readonly ForwardCandidate[],
  query: string,
  recentLimit: number = FORWARD_RECENT_LIMIT,
): ForwardSection[] {
  const q = query.trim().toLowerCase();
  const matches = q ? candidates.filter((c) => c.name.toLowerCase().includes(q)) : [...candidates];
  const byRecency = (a: ForwardCandidate, b: ForwardCandidate): number =>
    b.lastActivityAt - a.lastActivityAt || a.name.localeCompare(b.name);
  const out: ForwardSection[] = [];
  const used = new Set<string>();
  if (!q) {
    const recent = matches
      .filter((c) => c.lastActivityAt > 0)
      .sort(byRecency)
      .slice(0, recentLimit);
    if (recent.length > 0) {
      for (const c of recent) used.add(c.id);
      out.push({ key: "recent", label: SECTION_LABEL.recent, items: recent });
    }
  }
  const bucket = (key: ForwardSectionKey, pick: (c: ForwardCandidate) => boolean): void => {
    const items = matches.filter((c) => !used.has(c.id) && pick(c)).sort(byRecency);
    if (items.length > 0) out.push({ key, label: SECTION_LABEL[key], items });
  };
  bucket("channels", (c) => c.kind === "channel" || c.kind === "group");
  bucket("people", (c) => c.kind === "person");
  bucket("bots", (c) => c.kind === "bot");
  return out;
}

/** Flat order of the grouped list, for arrow-key navigation. */
export function flattenForwardSections(sections: readonly ForwardSection[]): ForwardCandidate[] {
  return sections.flatMap((s) => s.items);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Short time for the quoted card: `14:05`, `Yesterday 14:05`, `Oct 3 14:05`, `Oct 3, 2025`. */
export function forwardTimeLabel(createdAt: string | undefined, now: number = Date.now()): string {
  const ms = Date.parse(createdAt ?? "");
  if (!createdAt || Number.isNaN(ms)) return "";
  const d = new Date(ms);
  const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const today = startOfDay(now);
  const day = startOfDay(ms);
  if (day === today) return time;
  if (day === today - 86_400_000) return `Yesterday ${time}`;
  if (d.getFullYear() === new Date(now).getFullYear()) return `${MONTHS[d.getMonth()]} ${d.getDate()} ${time}`;
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

/** "in #welcome", "in Ana, Bo" (group), or "Direct message". */
export function forwardOriginLabel(origin: ForwardOrigin | undefined): string {
  if (!origin) return "";
  const label = clean(origin.label);
  if (origin.kind === "channel") return label ? `in #${label}` : "in a channel";
  if (origin.kind === "group") return label ? `in ${label}` : "in a group message";
  return "Direct message";
}

/** Label for the scope chip inside the search field. */
export function forwardScopeLabel(
  companyChoice: string,
  adminCompanies: readonly ForwardCompany[],
): string {
  const uid = clean(companyChoice);
  if (!uid) return "This conversation";
  return adminCompanies.find((c) => c.uid === uid)?.name ?? uid;
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

const UNTITLED_FILE = "Untitled file";

function plural(n: number): string {
  return `${n} ${n === 1 ? "file" : "files"}`;
}

/** Build the picker source from a timeline message. */
export function forwardSourceFrom(
  msg: ConversationMessageWire,
  conversationId: string,
  companyUid: string | null,
  senderName: string,
  origin?: ForwardOrigin,
): ForwardSource {
  const details = clean(msg.details);
  const prompt = clean(msg.prompt);
  const kind: ArtifactKind | undefined = details ? "details" : prompt ? "prompt" : undefined;
  const text = details || prompt;
  const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];
  const attachmentNames = attachments
    .filter((a) => a && typeof a === "object")
    .map((a) => clean(a.name) || UNTITLED_FILE);
  return {
    conversationId,
    eventId: msg.eventId,
    companyUid: clean(companyUid) || null,
    senderName: clean(senderName) || "Someone",
    ...(clean(msg.fromPersonUid) ? { senderUid: clean(msg.fromPersonUid) } : {}),
    ...(clean(msg.createdAt) ? { createdAt: clean(msg.createdAt) } : {}),
    ...(origin ? { origin } : {}),
    body: typeof msg.body === "string" ? msg.body : "",
    attachmentCount: attachmentNames.length,
    attachmentNames,
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
 * A plain sentence for every code. Never the server's `error` text or any
 * JSON. Prefer `forwardErrorView`, which also names the next action.
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
    case "INVALID_FORWARD_OF":
      return "Couldn't tell which message to forward. Try again.";
    case "INVALID_FILE_ACCESS":
      return "Couldn't apply your file choice. Try again.";
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

export type ForwardErrorAction = "retry" | "pick" | "omit" | "close";

export interface ForwardErrorView {
  text: string;
  action: ForwardErrorAction;
  /** Second action offered next to `retry` (file grant failures). */
  alsoOmit?: boolean;
}

/** Plain sentence plus the next action the picker offers for it (US-010). */
export function forwardErrorView(
  result: Extract<ForwardResult, { ok: false }>,
  ctx: { destinationName: string; sourceCompanyName?: string },
): ForwardErrorView {
  const text = forwardErrorMessage(result, ctx);
  switch (result.code) {
    case "CROSS_COMPANY_FORBIDDEN":
    case "FORWARD_NOT_CONNECTED":
      return { text, action: "pick" };
    case "FORWARD_FILES_NOT_ALLOWED":
    case "FORWARD_FILE_SHARE_FORBIDDEN":
      return { text, action: "omit" };
    case "FORWARD_SOURCE_NOT_FOUND":
    case "FORWARD_NOT_SCHEDULABLE":
    case "FORWARD_BODY_TOO_LARGE":
    case "FORWARD_DETAILS_TOO_LARGE":
    case "FORWARD_PROMPT_TOO_LARGE":
      return { text, action: "close" };
    case "FORWARD_FILE_GRANT_FAILED":
      return { text, action: "retry", alsoOmit: true };
    default:
      return { text, action: "retry" };
  }
}

export const FORWARD_ERROR_ACTION_LABEL: Record<ForwardErrorAction, string> = {
  retry: "Try again",
  pick: "Pick another destination",
  omit: "Send without files",
  close: "Close",
};

/** `This shares 1 file with Ana` / `This shares 2 files with Ana`. */
export function filesPromptTitle(count: number, destinationName: string): string {
  return `This shares ${plural(count)} with ${destinationName || "them"}`;
}

export function crossCompanyText(from: string | null | undefined, to: string | null | undefined): string {
  return `This sends the message from ${from || "this company"} to ${to || "another company"}. Files are not included.`;
}

export type ForwardNotice =
  | { kind: "channel-files"; text: string }
  | { kind: "cross-company"; text: string; from: string; to: string };

/** Notices shown before sending, derived from the source and destination. */
export function forwardNotices(args: {
  source: ForwardSource;
  destination: ForwardCandidate | null;
  sourceCompanyName: string | null;
  destinationCompanyName: string | null;
}): ForwardNotice[] {
  const { source, destination } = args;
  if (!destination) return [];
  const out: ForwardNotice[] = [];
  const count = source.attachmentCount ?? 0;
  if ((destination.kind === "channel" || destination.kind === "group") && count > 0) {
    out.push({
      kind: "channel-files",
      text: `Files are not included in forwards to channels. ${plural(count)} will be left out.`,
    });
  }
  if (source.companyUid && destination.companyUid && source.companyUid !== destination.companyUid) {
    const from = args.sourceCompanyName || "this company";
    const to = args.destinationCompanyName || "another company";
    out.push({ kind: "cross-company", text: crossCompanyText(from, to), from, to });
  }
  return out;
}

export function forwardFileNames(files: readonly ForwardFileRef[]): string[] {
  return files.map((f) => f.name || UNTITLED_FILE);
}
