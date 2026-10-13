/**
 * The brief's event log: what the person did with each brief, one JSON line
 * per event, appended by the host to personal/brief/brief-log.jsonl. The
 * writer skill folds it weekly into brief-prefs.yaml (a card dismissed three
 * briefs running loses a point; a card launched from three times in a week
 * gains one; the engine used most becomes the default).
 *
 * Events: `shown` once per run with the cards on the page, `dismiss` when an
 * item is cleared without a launch, `launch` when a prompt starts a session
 * (with the engine), `pin` and `hide` when a card is pinned or hidden. The log
 * is best effort: a host without the append seam keeps no log, and a failed
 * append is reported once and never blocks the brief.
 */
import type { AdapterPromise } from "@hq/platform";
import type { BriefEngine } from "./brief-context.svelte.js";
import type { BriefInput, BriefWidgetKind } from "./brief-types.js";

/**
 * The card each item id sits on, so a dismiss or launch names its card. Ids
 * the catalogue does not know (a peek's resume prompt, a thank-you) stay off
 * the map and log with no kind.
 */
export function briefItemKinds(input: BriefInput): Record<string, BriefWidgetKind> {
  const kinds: Record<string, BriefWidgetKind> = {};
  for (const d of input.decisions) kinds[d.id] = "needs";
  for (const a of input.actionItems) kinds[a.id] = "needs";
  for (const r of input.risks) kinds[r.id] = r.severity === "incident" ? "incident" : "risk";
  for (const w of input.waitingOn) kinds[w.id] = "waiting";
  for (const c of input.carry ?? []) kinds[c.id] = "carry";
  for (const h of input.handoffs ?? []) kinds[h.id] = "handoffs";
  for (const r of input.reminders ?? []) kinds[r.id] = "reminders";
  return kinds;
}

export type BriefLogEventKind = "shown" | "dismiss" | "launch" | "pin" | "hide";

export interface BriefLogEvent {
  event: BriefLogEventKind;
  /** The run the brief came from; null for a brief with no run (the seed). */
  run_id: string | null;
  /** The card the item sat on, when known. */
  kind?: BriefWidgetKind | null;
  /** The item acted on (a decision, reminder, prompt id). */
  item_id?: string;
  /** The engine a launch went to. */
  engine?: BriefEngine;
  /** The cards on the page, for `shown`. */
  widgets?: BriefWidgetKind[];
}

export interface BriefLogSink {
  append(event: BriefLogEvent): void;
}

/** The host seam: the adapter's files surface, when it can append. */
export interface BriefLogFiles {
  appendBriefLogLine?(line: string): AdapterPromise<void>;
}

/** One log line: the event plus its time, keys in a stable order, no newlines. */
export function briefLogLine(event: BriefLogEvent, at: Date = new Date()): string {
  const line: Record<string, unknown> = { at: at.toISOString(), event: event.event, run_id: event.run_id };
  if (event.kind !== undefined) line.kind = event.kind;
  if (event.item_id !== undefined) line.item_id = event.item_id;
  if (event.engine !== undefined) line.engine = event.engine;
  if (event.widgets !== undefined) line.widgets = event.widgets;
  return JSON.stringify(line);
}

/**
 * A sink over the host's append seam, or null when the host has none. Appends
 * are fire-and-forget and run in order; the first failure logs one warning.
 */
export function adapterBriefLog(files: BriefLogFiles | null | undefined, now: () => Date = () => new Date()): BriefLogSink | null {
  const append = files?.appendBriefLogLine;
  if (!append) return null;
  let warned = false;
  let chain: Promise<unknown> = Promise.resolve();
  return {
    append(event) {
      const line = briefLogLine(event, now());
      chain = chain
        .then(() => append.call(files, line))
        .then(
          (res) => {
            if (res && res.ok === false && !warned) {
              warned = true;
              console.warn(`[daily-brief] could not write the brief log: ${res.message ?? res.reason}`);
            }
          },
          (err) => {
            if (!warned) {
              warned = true;
              console.warn(`[daily-brief] could not write the brief log: ${String(err)}`);
            }
          },
        );
    },
  };
}
