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
export type LocalBotEntryResult = { ok: true; agentUid: string; name: string } | { ok: false; reason: string };

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
