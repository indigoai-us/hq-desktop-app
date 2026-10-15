/**
 * Report action cards: each suggested piece of work in a brief, with the data
 * the person needs to decide and where to do it (the assistant, Claude Code
 * or Codex).
 */

import type { AdapterResult } from "@hq/platform";

import { ASSISTANT_FALLBACK_NAME } from "../chat/assistant-owner.js";
import type { BriefDecision } from "./brief-types.js";

export interface BriefActionCardData {
  id: string;
  /** What it is. */
  title: string;
  /** Why now: brief.json `detail.why`, else the item's summary. */
  why: string;
  /** The evidence the brief gathered: `detail.unlocks` lines and `detail.source`. */
  evidence: string[];
  /** The launch prompt: the run's prompt for the item, else the item's own `prompt`. */
  prompt: string;
}

/** Where a card's work can be done. */
export interface BriefActionDestinations {
  /** The assistant's name inside a sentence; null when no assistant runs on this computer. */
  assistantName: string | null;
  claudeCode: boolean;
  codex: boolean;
}

/** The shell inputs for the report action cards. */
export interface BriefActions {
  destinations: BriefActionDestinations;
  /** Sends the prompt to the assistant DM; resolves to the note to show (sent or failed). */
  onassistant: (prompt: string, idempotencyKey: string) => Promise<string | null>;
}

/** The assistant's name inside a sentence: "your assistant" when it has no name yet. */
export function assistantNameInSentence(name: string): string {
  return name === ASSISTANT_FALLBACK_NAME ? "your assistant" : name;
}

/**
 * The report action cards' destinations and assistant send. The assistant
 * button shows only when the assistant runs on this computer: a cloud-only
 * one would accept the DM and nothing would happen here. A send always
 * leaves a note, so success is distinguishable from nothing.
 */
export function briefActionsFor(
  assistant: { uid: string; name: string; runsHere: boolean } | null,
  cli: { claudeCode: boolean; codex: boolean },
  send: (uid: string, prompt: string, idempotencyKey: string) => Promise<AdapterResult<unknown>>,
): BriefActions {
  const here = assistant?.runsHere ? assistant : null;
  const name = here ? assistantNameInSentence(here.name) : null;
  return {
    destinations: { assistantName: name, claudeCode: cli.claudeCode, codex: cli.codex },
    async onassistant(prompt, idempotencyKey) {
      if (!here) return "Your assistant is not set up on this computer yet.";
      const failed = `Could not send this to ${name}. Try again in a moment.`;
      let res: AdapterResult<unknown>;
      try {
        res = await send(here.uid, prompt, idempotencyKey);
      } catch (err) {
        console.warn("[daily-brief] action send threw", err);
        return failed;
      }
      if (res.ok) return `Sent to ${name}.`;
      console.warn("[daily-brief] action send failed", res.reason, res.code ?? "", res.message ?? "");
      return failed;
    },
  };
}

export function actionCardData(d: BriefDecision, prompts: Record<string, string> = {}): BriefActionCardData | null {
  const prompt = (prompts[d.id] ?? d.prompt ?? "").trim();
  if (!prompt) return null;
  const evidence = [
    ...(d.detail?.unlocks ?? []).map((l) => (l.state ? `${l.label}: ${l.state}` : l.label)),
    ...(d.detail?.source ? [d.detail.source] : []),
  ].filter((s) => s.trim());
  return { id: d.id, title: d.title, why: d.detail?.why?.trim() || d.summary, evidence, prompt };
}

/**
 * One send per run and item, so a repeated click reaches the assistant once.
 * A brief with no run id is keyed by its local day, so the same item on a
 * later day's brief can be sent again.
 */
export function assistantIdempotencyKey(runId: string | null | undefined, itemId: string, now: string): string {
  return `brief-action:${runId ?? `day-${localDay(now)}`}:${itemId}`;
}

function localDay(now: string): string {
  const d = new Date(now);
  if (Number.isNaN(d.getTime())) return "unknown";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
