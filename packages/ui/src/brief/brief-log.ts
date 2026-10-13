/**
 * The brief preference log, `personal/brief/brief-log.jsonl`: one JSON line
 * per thing the person did with a brief. The daily-brief writer folds it into
 * brief-prefs.yaml weekly (a widget dismissed three times in a row loses a
 * point, one launched from three times gains one), so the app records what it
 * showed and what the person did with it. The host appends the line; this
 * module only shapes it and keeps a failed append from touching the page.
 */

import type { AdapterPromise } from "@hq/platform";

export const BRIEF_LOG_PATH = "personal/brief/brief-log.jsonl";

export type BriefLogEventKind = "shown" | "dismiss" | "launch" | "pin" | "hide";

export interface BriefLogEvent {
  event: BriefLogEventKind;
  /** The run the brief on screen came from. */
  runId: string;
  /** The item acted on (`d1`, `p2`, …); absent for `shown`. */
  itemId?: string;
  /** The engine a prompt was launched in. */
  engine?: string;
}

/** The JSON line for one event; `at` is read from the clock by the caller. */
export function briefLogLine(event: BriefLogEvent, at: Date): string {
  const row: Record<string, string> = { at: at.toISOString(), event: event.event, run_id: event.runId };
  if (event.itemId) row.item_id = event.itemId;
  if (event.engine) row.engine = event.engine;
  return JSON.stringify(row);
}

export type BriefLogAppend = (line: string) => AdapterPromise<void>;

/**
 * A fire-and-forget logger over the host's append. `shown` is recorded once
 * per run for the logger's life, so re-rendering the same brief does not count
 * as seeing it again. A missing host append (web, harness) logs nothing; a
 * failed append is reported once per message and never thrown.
 */
export function createBriefLogger(
  append: BriefLogAppend | null | undefined,
  opts: { now?: () => Date; warn?: (message: string) => void } = {},
): (event: BriefLogEvent) => void {
  const now = opts.now ?? (() => new Date());
  const warn = opts.warn ?? ((m) => console.warn(`[daily-brief] ${m}`));
  const shown = new Set<string>();
  const warned = new Set<string>();
  return (event) => {
    if (!append) return;
    if (event.event === "shown") {
      if (shown.has(event.runId)) return;
      shown.add(event.runId);
    }
    const line = briefLogLine(event, now());
    void Promise.resolve()
      .then(() => append(line))
      .then((res) => {
        if (res && typeof res === "object" && "ok" in res && res.ok === false) {
          const why = ("message" in res && typeof res.message === "string" && res.message) || ("reason" in res ? String(res.reason) : "refused");
          if (!warned.has(why)) {
            warned.add(why);
            warn(`brief log append failed: ${why}`);
          }
        }
      })
      .catch((err: unknown) => {
        const why = err instanceof Error ? err.message : String(err);
        if (!warned.has(why)) {
          warned.add(why);
          warn(`brief log append failed: ${why}`);
        }
      });
  };
}
