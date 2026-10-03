/**
 * OWNER-R4: the Atlas "People & agents" list, from the same read the web
 * Atlas uses (hq-pro `GET /v1/telemetry/company`, last 30 days): one row per
 * member or agent with tokens, sessions, stories, top skill and a daily trend,
 * sorted by tokens like the web pane (hq-console atlas-people.ts).
 *
 * The web also matches each person to projects and repos through the Console
 * work-mesh lens, which this app does not read. Here a person lights up the
 * skills they ran (`totals.skills.bySkill`), which the read does carry.
 */

import type { AtlasNode } from "./atlas-model.js";

export interface AtlasPerson {
  id: string;
  name: string;
  bot: boolean;
  tokens: number;
  sessions: number;
  stories: number;
  topSkill: string;
  trend: number[];
  skills: string[];
}

export type AtlasPeopleState =
  | { status: "idle" | "loading" }
  | { status: "ok"; people: AtlasPerson[] }
  | { status: "failed"; forbidden: boolean };

export const ATLAS_PEOPLE_DAYS = 30;

const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function tokenTotal(rows: unknown): number {
  return arr(rows).reduce<number>((sum, row) => {
    const r = rec(row);
    return sum + num(r.input) + num(r.output) + num(r.cacheCreation) + num(r.cacheRead);
  }, 0);
}

/** Parse the company telemetry body. Throws on a foreign shape. */
export function atlasPeopleFromTelemetry(body: unknown): AtlasPerson[] {
  const root = rec(body);
  if (!Array.isArray(root.perMember)) throw new Error("company telemetry: perMember missing");
  const out: AtlasPerson[] = [];
  for (const raw of root.perMember) {
    const m = rec(raw);
    const id = String(m.personUid ?? m.agentUid ?? "");
    if (!id) continue;
    const totals = rec(m.totals);
    const bot = id.startsWith("agt_") || m.kind === "agent";
    const label = [m.label, m.displayName].find((v): v is string => typeof v === "string" && !!v.trim())?.trim() ?? "";
    const email = typeof m.email === "string" ? m.email.trim() : "";
    // Never an id on screen.
    const name = label && !/^(prs|agt)_/.test(label) ? label : email || (bot ? "Unknown bot" : "Unnamed member");
    const bySkill = arr(rec(totals.skills).bySkill)
      .map((s) => ({ skill: String(rec(s).skill ?? ""), count: num(rec(s).count) }))
      .filter((s) => s.skill && s.count > 0)
      .sort((a, b) => b.count - a.count);
    const tokens = tokenTotal(totals.tokensByModel);
    const sessions = num(totals.distinctSessions);
    if (tokens === 0 && sessions === 0 && bySkill.length === 0) continue;
    out.push({
      id,
      name,
      bot,
      tokens,
      sessions,
      stories: num(rec(rec(m.outcomes).byType).storyCompleted),
      topSkill: bySkill[0]?.skill ?? "",
      trend: arr(m.trend).map(num),
      skills: bySkill.map((s) => s.skill),
    });
  }
  return out.sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name));
}

const skillKey = (s: string) => {
  const k = s.trim().replace(/^\/+/, "").toLowerCase();
  const i = k.lastIndexOf(":");
  return i >= 0 ? k.slice(i + 1) : k;
};

/** Skill objects on the map that this person ran in the window. */
export function atlasPersonNodeIds(person: AtlasPerson, nodes: readonly AtlasNode[]): Set<string> {
  const keys = new Set(person.skills.map(skillKey));
  return new Set(nodes.filter((n) => n.type === "skill" && keys.has(skillKey(n.label))).map((n) => n.id));
}

/** 1.2M / 340k / 900, like the web's compact token count. */
export function compactTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1).replace(/\.0$/, "")}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/** A failed read is "forbidden" when the caller is not an owner or admin. */
export function isForbidden(err: unknown): boolean {
  const text = err instanceof Error ? `${(err as Error & { code?: string }).code ?? ""} ${err.message}` : String(err);
  return /403|forbidden|not.?allowed|permission/i.test(text);
}
