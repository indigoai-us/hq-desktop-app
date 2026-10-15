/**
 * Report action cards: each suggested piece of work in a brief, with the data
 * the person needs to decide and where to do it (the assistant, Claude Code
 * or Codex).
 */

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
  /** The assistant's display name; null when no assistant exists yet. */
  assistantName: string | null;
  claudeCode: boolean;
  codex: boolean;
}

/** The shell inputs for the report action cards. */
export interface BriefActions {
  destinations: BriefActionDestinations;
  /** Sends the prompt to the assistant DM; resolves to an error message or null. */
  onassistant: (prompt: string, idempotencyKey: string) => Promise<string | null>;
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

/** One send per run and item, so a repeated click reaches the assistant once. */
export function assistantIdempotencyKey(runId: string | null | undefined, itemId: string): string {
  return `brief-action:${runId ?? "local"}:${itemId}`;
}
