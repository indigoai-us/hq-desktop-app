/**
 * The welcome report's "made this report" line. "<Name> made this report."
 * only once the brief job's report has landed; with no assistant yet, "Your
 * assistant will make the next one." (null). With an assistant but no report
 * from it (a failed or held-back job, Create brief still to press), the line
 * is left out (undefined) so it never claims a report that does not exist.
 */
export function welcomeMadeBy(
  assistant: { name: string; onmeet: () => void } | null,
  reportLanded: boolean,
): { name: string; onmeet: () => void } | null | undefined {
  if (!assistant) return null;
  return reportLanded ? assistant : undefined;
}
