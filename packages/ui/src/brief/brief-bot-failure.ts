/**
 * Did the bot's turn on the brief job fail? When a local bot's model turn
 * fails, hq-cli writes no status.json; it posts a reply into the bot's DM
 * instead (a `runtime-repair` block, or on older CLIs a plain "I couldn't
 * answer that one (claude kept failing: …)" line). The brief reads that reply
 * so a failed run ends at once with a sentence the person can act on, rather
 * than after the five-minute start window (owner report, 2026-10-16: the
 * assistant's Claude turn failed in under a second and the page kept waiting).
 *
 * Pure: matching and copy are unit tested without a host.
 */

import { plainBotFailureReply, botRuntimeLabel } from "../chat/bot-runtime-failure.js";
import { repairPayloadForMessage, type RepairClass } from "../chat/messaging/runtime-repair-model.js";

export interface BriefBotMessage {
  fromPersonUid?: string | null;
  body?: string | null;
  createdAt: string;
  richContent?: unknown;
  metadata?: unknown;
}

/** The sentence for each failure class. `{bot}` and `{tool}` are filled in. */
const CLASS_LINE: Readonly<Record<RepairClass, string>> = {
  "signed-out": "{bot} is signed out of {tool}, so it could not make your brief. Sign it in from its messages, then try again.",
  "cli-outdated": "{bot} needs a newer {tool} to make your brief. Update it from its messages, then try again.",
  "model-unsupported": "{bot} is set to a model {tool} cannot run. Pick another model in its messages, then try again.",
  transient: "{bot} could not start your brief because {tool} ran into a problem. Try again in a moment.",
};

function fill(line: string, bot: string, tool: string): string {
  return line.replaceAll("{bot}", bot).replaceAll("{tool}", tool);
}

/**
 * The plain sentence for the first failure reply the bot posted at or after
 * `sinceMs`, or null when it posted none. `bot` is the name the page uses
 * for it ("Your assistant"); `runtime` is its coding tool id.
 */
export function briefBotFailure(
  messages: readonly BriefBotMessage[],
  opts: { agentUid: string; sinceMs: number; bot: string; runtime?: string | null },
): string | null {
  const tool = botRuntimeLabel(opts.runtime);
  const ordered = [...messages]
    .filter((m) => (m.fromPersonUid ?? "").trim() === opts.agentUid)
    .filter((m) => {
      const at = Date.parse(m.createdAt);
      return Number.isFinite(at) && at >= opts.sinceMs;
    })
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  for (const m of ordered) {
    const repair = repairPayloadForMessage(m);
    if (repair) return fill(CLASS_LINE[repair.class], opts.bot, tool);
    const plain = plainBotFailureReply(m.body);
    if (!plain) continue;
    if (plain.runtimeMissing) return `${opts.bot} needs ${tool} on this computer to make your brief. Install it and sign in, then try again.`;
    if (/signed out/.test(plain.body)) return fill(CLASS_LINE["signed-out"], opts.bot, tool);
    return fill(CLASS_LINE.transient, opts.bot, tool);
  }
  return null;
}
