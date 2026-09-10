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
