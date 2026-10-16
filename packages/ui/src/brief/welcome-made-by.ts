/**
 * The welcome report's "made this report" line. "<Name> made this report."
 * only once the brief job's report has landed and the page is showing that
 * same run: the run bar can put an earlier brief on screen, and the line must
 * not claim it. With no assistant, or no landed report on screen (a failed or
 * held-back job, Create brief still to press, an earlier run picked), the line
 * is left out (undefined) so it never claims a report that does not exist.
 */
export function welcomeMadeBy(
  assistant: { name: string; onmeet: () => void } | null,
  landedRunId: string | null,
  shownRunId: string | null,
): { name: string; onmeet: () => void } | undefined {
  if (!assistant || !landedRunId) return undefined;
  return landedRunId === shownRunId ? assistant : undefined;
}
