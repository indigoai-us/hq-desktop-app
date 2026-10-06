/**
 * Detail side panel facts (owner, 2026-10-05: "improve this design" on the
 * secret inspector). An empty fact renders as nothing: no row, no em dash
 * (policy hq-ui-no-placeholder-glyph-for-empty-slot).
 */
export interface DetailFact {
  label: string;
  value: string | number | null | undefined;
  mono?: boolean;
}

const PLACEHOLDERS = new Set(["", "—", "–", "-"]);

export function isEmptyFactValue(value: DetailFact["value"]): boolean {
  if (value === null || value === undefined) return true;
  return PLACEHOLDERS.has(String(value).trim());
}

export function visibleFacts(facts: readonly DetailFact[]): DetailFact[] {
  return facts.filter((fact) => !isEmptyFactValue(fact.value));
}
