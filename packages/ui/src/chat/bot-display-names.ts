/**
 * Display names for local bots.
 *
 * A bot's handle ("dr-love") is what the CLI, the filesystem and every
 * mention know it as. Its display name ("Dr Love") is a label, stored on the
 * agent profile in HQ Cloud — and, because `hq bot list` reports only the
 * handle, mirrored here so the sidebar and settings can show it without a
 * round trip. Every read falls back to the handle, so bots created before
 * display names existed read exactly as they always did.
 */

import type { LocalBotRow } from "@hq/platform";

const STORAGE_KEY = "hq.bot-display-names.v1";

/** agentUid → display name. */
export type BotDisplayNames = Record<string, string>;

function storageOrNull(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    return (
      (globalThis as { window?: { localStorage?: Storage } }).window?.localStorage ??
      (globalThis.localStorage as Storage | undefined) ??
      null
    );
  } catch {
    // Safari with storage blocked throws on access, not on use.
    return null;
  }
}

/** The saved map; `{}` when nothing is saved or the record is unreadable. */
export function loadBotDisplayNames(
  storage: Pick<Storage, "getItem"> | null = storageOrNull(),
): BotDisplayNames {
  let raw: string | null = null;
  try {
    raw = storage?.getItem(STORAGE_KEY) ?? null;
  } catch (err) {
    console.warn("[hq-desktop] bot display names unreadable:", err);
    return {};
  }
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: BotDisplayNames = {};
    for (const [uid, name] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof name === "string" && uid.trim() && name.trim()) out[uid.trim()] = name.trim();
    }
    return out;
  } catch (err) {
    console.warn("[hq-desktop] bot display names unparseable:", err);
    return {};
  }
}

/**
 * The map with `uid` set to `displayName` (or removed when it is empty),
 * saved. Returns the new map so a caller holding reactive state can assign it.
 */
export function rememberBotDisplayName(
  current: BotDisplayNames,
  uid: string,
  displayName: string,
  storage: Pick<Storage, "setItem"> | null = storageOrNull(),
): BotDisplayNames {
  const key = uid.trim();
  if (!key) return current;
  const name = displayName.trim();
  const next = { ...current };
  if (name) next[key] = name;
  else delete next[key];
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch (err) {
    // The name still shows this session; only its persistence is lost.
    console.warn("[hq-desktop] bot display name save failed:", err);
  }
  return next;
}

/** What to call this bot: its display name where there is one, else its handle. */
export function botRowDisplayName(
  bot: Pick<LocalBotRow, "name" | "agentUid"> & { displayName?: string },
  names: BotDisplayNames | null | undefined,
): string {
  return bot.displayName?.trim() || names?.[bot.agentUid.trim()]?.trim() || bot.name;
}
