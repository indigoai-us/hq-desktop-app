/**
 * Pure helpers for personal local bots in the chat shell (local-bots US-009).
 *
 * The host polls `adapter.bots.list()` (the hq CLI's `hq bot list --json`) and
 * hands the rows here; the sidebar and thread derive presence from them. No
 * timestamps are interpreted client-side — `online` is the server's verdict
 * (heartbeat < 90 s) as relayed by the CLI, and `processAlive` is the local
 * supervisor's.
 */

import type { LocalBotRow } from "@hq/platform";
import type { ConversationRow } from "./sidebar-model.js";

export const LOCAL_BOTS_POLL_MS = 30_000;

/** Runtimes a bot can think with, in picker order. */
export const LOCAL_BOT_RUNTIMES: ReadonlyArray<{ id: LocalBotRow["runtime"]; label: string }> = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "grok", label: "Grok" },
];

/** Same rule as the CLI's validateBotName and the Tauri command's validate_name. */
export function isValidLocalBotName(name: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(name) && !name.includes("--");
}

export function localBotRuntimeLabel(id: string): string {
  return LOCAL_BOT_RUNTIMES.find((r) => r.id === id)?.label ?? id;
}

/**
 * Contacts plus the user's own local bots (as DM contacts), skipping any bot
 * the server roster already listed. Bots carry no company.
 */
export function localBotsAsContacts<T extends { personUid: string }>(
  contacts: readonly T[],
  bots: readonly LocalBotRow[] | null | undefined,
): Array<T | { personUid: string; displayName: string; companyUid: null }> {
  if (!bots || bots.length === 0) return [...contacts];
  const seen = new Set(contacts.map((c) => c.personUid.trim()));
  const extra: Array<{ personUid: string; displayName: string; companyUid: null }> = [];
  for (const bot of bots) {
    const uid = bot.agentUid.trim();
    if (!uid || seen.has(uid)) continue;
    seen.add(uid);
    extra.push({ personUid: uid, displayName: bot.name, companyUid: null });
  }
  return [...contacts, ...extra];
}

/** Result of the sidebar "New bot" entry point (see CreateModal). */
export type LocalBotEntryResult =
  | { ok: true; agentUid: string; name: string }
  | {
      ok: false;
      /** Plain sentence, safe to render (see `plainBotFailure`). */
      reason: string;
      /**
       * The host's / CLI's own words, kept for logs and for matching known
       * conditions (see `isAlreadyExistsFailure`). NEVER rendered: it can be
       * hq-pro's raw `HQ API /v1/agents → 409: Entity with type="agent" and
       * slug="setup-…" already exists`, relayed verbatim by `hq bot create`.
       */
      raw?: string;
    };

/**
 * Shapes that mean "this text came from a machine, not for a person". The
 * bots API shells out to `hq bot …`, whose stderr is the CLI's (and often
 * hq-pro's) own message, so anything here can and did reach a person on the
 * #welcome hero. A match is replaced by a written sentence; the raw text is
 * logged instead.
 */
const RAW_FAILURE_SHAPES: readonly RegExp[] = [
  /\bHQ API\b/i,
  /https?:\/\//i,
  /\/v\d+\//,
  /→\s*\d{3}\b/,
  /\b(?:HTTP|status)\s*[:=]?\s*\d{3}\b/i,
  /\b\d{3}\s+(?:Bad Request|Unauthorized|Forbidden|Not Found|Conflict|Internal Server Error)\b/i,
  /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/,
  /type="|slug="|uid="/,
  /\b(?:Error|TypeError|RangeError|SyntaxError):/,
  /\bat\s+\S+\s+\([^)]*:\d+:\d+\)/,
  /\{[\s\S]*"\w+"\s*:/,
  /(?:^|\s)\/(?:Users|home|private|tmp|var|opt)\//,
  /\bhq\s+bot\b/,
];

/** True when `raw` is machine text that must not be shown to a person. */
export function isRawBotFailureText(raw: string | null | undefined): boolean {
  const text = (raw ?? "").trim();
  if (!text) return false;
  return RAW_FAILURE_SHAPES.some((shape) => shape.test(text));
}

/**
 * A sentence a person can act on. Plain host messages ("Claude Code is not
 * signed in.") pass through unchanged; machine text falls back to `fallback`.
 * Only the first line survives either way — a CLI message often appends a
 * "run this command" line that means nothing inside the app.
 */
export function plainBotFailure(raw: string | null | undefined, fallback: string): string {
  const text = (raw ?? "").trim();
  if (!text || isRawBotFailureText(text)) return fallback;
  const firstLine = (text.split(/\r?\n/)[0] ?? "").trim();
  if (!firstLine || firstLine.length > 200 || isRawBotFailureText(firstLine)) return fallback;
  return firstLine;
}

/**
 * The create failed because the bot is already there — a 409 from
 * `POST /v1/agents` (the cloud account still owns the agent entity after a
 * local wipe, or two callers raced), or the CLI's own "already exists" for a
 * bot folder on this Mac. Both mean "adopt it", never "show an error".
 */
export function isAlreadyExistsFailure(raw: string | null | undefined): boolean {
  const text = (raw ?? "").toLowerCase();
  if (!text) return false;
  if (/already exists/.test(text)) return true;
  if (/\b(?:entity_exists|already_exists|duplicate_entity)\b/.test(text)) return true;
  if (/→\s*409\b/.test(text)) return true;
  return /\b409\b/.test(text) && /conflict/.test(text);
}

export type LocalBotPresence = "online" | "offline";

/** The local bot behind a DM row, if that agent lives on this machine. */
export function localBotForRow(
  bots: readonly LocalBotRow[],
  row: Pick<ConversationRow, "kind" | "personUid"> | null | undefined,
): LocalBotRow | null {
  if (!row || row.kind !== "dm") return null;
  const uid = (row.personUid ?? "").trim();
  if (!uid) return null;
  return bots.find((b) => b.agentUid === uid) ?? null;
}

/**
 * Presence for a local bot's DM row. Online only when hq-pro says so; a bot
 * whose process is alive but whose heartbeat has not landed yet still reads
 * offline (never claim online from local state alone). Null for rows that are
 * not local bots.
 */
export function localBotPresence(
  bots: readonly LocalBotRow[],
  row: Pick<ConversationRow, "kind" | "personUid"> | null | undefined,
): LocalBotPresence | null {
  const bot = localBotForRow(bots, row);
  if (!bot) return null;
  return bot.online === true ? "online" : "offline";
}

/** One-line thread notice for an offline local bot. */
export function localBotOfflineNotice(bot: LocalBotRow): string {
  if (bot.promotionHold) {
    return `${bot.name} is paused for cloud promotion. Open its profile to continue.`;
  }
  if (bot.state === "failed") {
    return `${bot.name} stopped after repeated errors. Start it again to retry.`;
  }
  if (bot.processAlive) {
    return `${bot.name} is starting up — it will answer as soon as it checks in.`;
  }
  return `${bot.name} is offline — its computer is off or the bot is stopped.`;
}

/** Relative "checked in 12s ago" label; null when there was never a heartbeat. */
export function lastHeartbeatLabel(
  iso: string | null | undefined,
  nowMs: number,
): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const s = Math.max(0, Math.round((nowMs - t) / 1000));
  if (s < 60) return `checked in ${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `checked in ${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `checked in ${h}h ago`;
  return `checked in ${Math.round(h / 24)}d ago`;
}


/** Completed promotions leave the local-control registry, retaining their UID
 * in the server DM/agent registry so existing conversations use cloud details. */
export function locallyHostedBots(bots: readonly LocalBotRow[]): LocalBotRow[] {
  return bots.filter(bot => bot.hosting !== "cloud");
}


export function promotedBotCompany(bots: readonly LocalBotRow[], agentUid: string): string | null {
  const row = bots.find(bot => bot.agentUid === agentUid && bot.hosting === "cloud");
  return row?.promotionHold?.companyUid ?? null;
}

/**
 * "Personal · acts as you" or "Company · indigo, ridge" (bot-kinds). Null when
 * the CLI predates bot kinds, so older rows show nothing new.
 */
export function localBotKindLabel(bot: Pick<LocalBotRow, "kind" | "companies">): string | null {
  if (bot.kind === "personal") return "Personal · acts as you";
  if (bot.kind === "company") {
    const slugs = (bot.companies ?? []).map((s) => s.trim()).filter(Boolean);
    return slugs.length ? `Company · ${slugs.join(", ")}` : "Company";
  }
  return null;
}

/**
 * The owner's companies a Local company bot can belong to: cloud-backed company
 * workspaces, keyed by slug (what `hq bot create --company` takes).
 */
export function localBotCompanies(
  workspaces: ReadonlyArray<{ slug: string; displayName?: string | null; kind: string; cloudUid: string | null }> | null | undefined,
): Array<{ slug: string; label: string }> {
  return (workspaces ?? [])
    .filter((w) => w.kind !== "personal" && Boolean(w.cloudUid) && w.slug.trim())
    .map((w) => ({ slug: w.slug.trim(), label: w.displayName?.trim() || w.slug.trim() }));
}
