/**
 * A teammate's recent DMs to the person, read live from the DM thread
 * (messaging.fetchDmThread, the same newest-first page the Messages view
 * reads) and filtered to that sender. Feeds the Team card's row preview, its
 * peek, and the reply prompt, which quotes the actual messages.
 */

import type { AdapterPromise, Json } from "@hq/platform";

export interface BriefDm {
  id: string;
  text: string;
  /** ISO time it was sent. */
  at: string;
  unread: boolean;
  /** Reply-thread or channel name, when the message has one. */
  thread: string | null;
}

export type BriefDmLoad =
  | { state: "loading" }
  | { state: "ready"; dms: BriefDm[] }
  | { state: "error"; message: string };

/** The slice of the messaging API the Team card reads. */
export interface BriefDmApi {
  fetchDmThread?(args: { withPersonUid: string; limit?: number }): AdapterPromise<Json>;
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/**
 * Messages in a DM thread page sent BY `senderUid`, newest first. Messages
 * the person sent, system lines and empty bodies are left out.
 */
export function dmsFromSender(page: unknown, senderUid: string): BriefDm[] {
  const root = rec(page);
  const raw = Array.isArray(root.messages) ? root.messages : Array.isArray(page) ? (page as unknown[]) : [];
  const out: BriefDm[] = [];
  for (const item of raw) {
    const m = rec(item);
    const from = str(m.fromPersonUid) || str(m.senderUid) || str(m.from_uid);
    if (from !== senderUid) continue;
    if (str(m.direction) === "out" || str(m.messageKind) === "system") continue;
    const text = str(m.body);
    const at = str(m.createdAt) || str(m.at);
    if (!text || !Number.isFinite(Date.parse(at))) continue;
    out.push({
      id: str(m.eventId) || `${from}:${at}`,
      text,
      at,
      unread: m.unread === true || m.read === false,
      thread: str(m.threadTitle) || str(m.channelName) || null,
    });
  }
  return out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/** Read one sender's recent DMs. Errors come back as a plain sentence. */
export async function loadSenderDms(api: BriefDmApi | null | undefined, senderUid: string, limit = 40): Promise<BriefDmLoad> {
  if (!api?.fetchDmThread) return { state: "error", message: "Messages are not available here." };
  try {
    const res = await api.fetchDmThread({ withPersonUid: senderUid, limit });
    if (!res.ok) {
      console.warn("[daily-brief] DM thread read failed", res.reason, res.code ?? "");
      return { state: "error", message: "Could not load these messages. Try again in a moment." };
    }
    return { state: "ready", dms: dmsFromSender(res.value, senderUid) };
  } catch (err) {
    console.warn("[daily-brief] DM thread read failed", err);
    return { state: "error", message: "Could not load these messages. Try again in a moment." };
  }
}

/** "Just now", "12m", "3h", "2d" — compact, for a row. */
export function shortAgo(at: string, now: Date = new Date()): string {
  const ms = now.getTime() - Date.parse(at);
  if (!Number.isFinite(ms)) return "";
  if (ms < 60_000) return "now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.floor(ms / 86_400_000)}d`;
}

/** One line of a message, for a row preview. */
export function previewLine(text: string, max = 70): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
}

/**
 * The reply prompt for a teammate: quotes their latest messages (newest
 * last, up to three) so the session works from what they actually said.
 */
export function teammateReplyPrompt(name: string, dms: readonly BriefDm[], isAgent = false): string {
  const who = isAgent ? `${name} (an AI agent)` : name;
  const latest = dms.slice(0, 3).reverse();
  if (!latest.length) {
    return `Open my DM thread with ${who}, read the latest messages, and draft a short reply in my voice. Do not send it; show me the draft.`;
  }
  const quoted = latest
    .map((d) => `- ${new Date(d.at).toISOString().slice(0, 16).replace("T", " ")} UTC${d.thread ? ` in ${d.thread}` : ""}: "${d.text.replace(/\s+/g, " ").trim()}"`)
    .join("\n");
  return (
    `${who} sent me ${latest.length === 1 ? "this message" : "these messages"}:\n${quoted}\n\n` +
    `Check what each one needs from me first (open the thread for anything earlier). ` +
    `Then draft a short reply in my voice that answers it. Do not send it; show me the draft.`
  );
}
