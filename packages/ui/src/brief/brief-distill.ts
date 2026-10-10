/**
 * Turns a repo's merged PR list into something a person can take in at a
 * glance: a one-line mix by kind and the three changes most worth knowing.
 */
import type { BriefLine } from "./brief-types.js";

const KINDS: [RegExp, string][] = [
  [/^(feat|promote)\b/i, "feature"],
  [/^fix\b/i, "fix"],
  [/^docs?\b/i, "docs"],
  [/^(chore|ci|build|refactor|test)\b/i, "chore"],
];

interface Parsed {
  kind: string;
  text: string;
}

/** "1217 feat(conduct): on by default in v16" -> { kind: "feature", text: "On by default in v16" }. */
export function parsePr(label: string): Parsed {
  const body = label.replace(/^#?\d+\s+/, "");
  const m = body.match(/^([a-z-]+)(\([^)]*\))?!?:\s*(.+)$/i);
  const prefix = m?.[1] ?? "";
  const kind = KINDS.find(([re]) => re.test(prefix))?.[1] ?? "change";
  const text = (m?.[3] ?? body).trim();
  return { kind, text: text.charAt(0).toUpperCase() + text.slice(1) };
}

export function shippedDigest(lines: readonly BriefLine[], max = 3): { mix: string; highlights: BriefLine[] } {
  const parsed = lines.map((l) => parsePr(l.label));
  const counts = new Map<string, number>();
  for (const p of parsed) counts.set(p.kind, (counts.get(p.kind) ?? 0) + 1);
  const order = ["feature", "fix", "change", "docs", "chore"];
  const mix = order
    .filter((k) => counts.get(k))
    .map((k) => `${counts.get(k)} ${k}${counts.get(k) === 1 ? "" : k === "fix" ? "es" : "s"}`)
    .join(" · ");
  const rank = (k: string) => order.indexOf(k);
  const highlights = parsed
    .map((p, i) => ({ p, i }))
    .sort((a, b) => rank(a.p.kind) - rank(b.p.kind) || a.i - b.i)
    .slice(0, max)
    .map(({ p }) => ({ label: p.text.length > 72 ? `${p.text.slice(0, 71)}…` : p.text, state: p.kind.toUpperCase(), tone: "ok" as const }));
  return { mix, highlights };
}
