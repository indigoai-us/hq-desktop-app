/**
 * Shared shape of the stacked usage bar (UsageStackBar.svelte), drawn by the
 * Core menu meter and every Settings > Usage line.
 */

/** One coloured part of the bar: a usage group, or the trial total. */
export interface StackSegment {
  id: string;
  label: string;
  cents: number;
}

/** A labelled limit on the bar: the spend limit or the trial cap. */
export interface StackMarker {
  cents: number;
  label: string;
}

/** `ok` calm, `near` from 80% of a limit (amber), `at` at the limit or paused (red). */
export type StackTone = "ok" | "near" | "at";

/** The colour each segment id draws with; legend dots use the same. */
export function segmentColor(id: string): string {
  switch (id) {
    case "agents":
      return "var(--vio, #8b5cf6)";
    case "sync":
      return "var(--ice-ink, #5b7a99)";
    // Trial usage is one total, not a group: a neutral ink no group uses.
    case "trial":
      return "var(--t1, #222)";
    case "storage":
      return "var(--t2, #888)";
    default:
      return "var(--t3, #aaa)";
  }
}
