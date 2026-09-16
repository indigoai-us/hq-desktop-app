/**
 * Cloud vs Local — the only user-facing split between bots.
 *
 * Every AI teammate is a bot (owner vocabulary, 2026-09-11). A bot either runs
 * in the company's cloud (always on, provisioned through the company channel)
 * or on this Mac under the user's own Claude Code / Codex / Grok login. Code
 * identifiers keep their `agt_` / agent naming; only the copy changed.
 */

import { isAgentUid } from "./agent-thinking.js";
import { localBotRuntimeLabel } from "./local-bots.js";

export type BotKind = "cloud" | "local";

/**
 * Which kind of bot a uid is: "local" when one of the user's local bots owns
 * it, "cloud" for any other bot uid, null for humans and empty uids.
 *
 * `ownedLocalUids` is the owner's own local bots that this computer cannot run
 * right now — a wiped config, a reinstall, a second Mac. They are NOT on this
 * Mac's listing, and drawing them as "Cloud" is what the owner's VM showed
 * happening to four of their own bots the moment the account listing was
 * unavailable. They are local bots with nothing here to run them, so they read
 * "Local"; a bot with no such trace is still cloud, exactly as before.
 */
export function botKindFor(
  uid: string | null | undefined,
  localBots: ReadonlyArray<{ agentUid: string }> | null | undefined,
  ownedLocalUids?: readonly string[] | null,
): BotKind | null {
  const id = (uid ?? "").trim();
  if (!id || !isAgentUid(id)) return null;
  if (localBots?.some((bot) => bot.agentUid.trim() === id)) return "local";
  if (ownedLocalUids?.some((owned) => owned.trim() === id)) return "local";
  return "cloud";
}

/** Chip copy: "Cloud", "Local", or "Local · Claude Code" when the runtime is known. */
export function botKindLabel(kind: BotKind, runtime?: string | null): string {
  if (kind === "cloud") return "Cloud";
  const rt = (runtime ?? "").trim();
  return rt ? `Local · ${localBotRuntimeLabel(rt)}` : "Local";
}
