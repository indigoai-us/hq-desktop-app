/**
 * OWNER-R11: team and personal skill usage for the Skills Usage tab.
 *
 * Team runs come from hq-pro `GET /v1/telemetry/company` (the web Activity
 * read): `perMember[].totals.skills.bySkill` gives runs and people per skill,
 * and `daily[].skills.bySkill` gives the last day each skill ran. That read
 * does not say who made the last run, so the Last run column is a date.
 * Your runs come from `GET /v1/telemetry/me`, which sums across all of your
 * companies; the column label says so. The two reads fail independently.
 */

export interface TeamSkillUsage {
  runs: number;
  people: number;
  /** YYYY-MM-DD of the latest day with a run, or "". */
  lastDay: string;
}

export interface SkillUsageRow {
  name: string;
  path: string;
  teamRuns: number | null;
  yourRuns: number | null;
  people: number | null;
  lastDay: string;
}

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/**
 * Match key for a skill name. Telemetry records skills as typed (`/run-project`,
 * `hq:run-project`, `indigo:design-review`); the library lists the bare name.
 * Keys drop a leading slash and lower-case; `namespaceTail` gives the part
 * after the last colon for a second-chance match.
 */
export function skillKey(name: string): string {
  return name.trim().replace(/^\/+/, "").toLowerCase();
}
function namespaceTail(key: string): string {
  const i = key.lastIndexOf(":");
  return i >= 0 ? key.slice(i + 1) : key;
}

function bySkill(skills: unknown): { skill: string; count: number }[] {
  const r = rec(skills);
  if (Array.isArray(r.bySkill)) {
    return r.bySkill.map((s) => ({ skill: String(rec(s).skill ?? ""), count: num(rec(s).count) })).filter((s) => s.skill && s.count > 0);
  }
  // /v1/telemetry/me totals.skills is a { name: count } record.
  return Object.entries(r)
    .filter(([k, v]) => k !== "total" && typeof v === "number")
    .map(([skill, count]) => ({ skill, count: num(count) }))
    .filter((s) => s.skill && s.count > 0);
}

/** Team usage per skill key from a company telemetry body. Throws on a foreign shape. */
export function teamSkillUsage(body: unknown): Map<string, TeamSkillUsage> {
  const root = rec(body);
  if (!Array.isArray(root.perMember)) throw new Error("company telemetry: perMember missing");
  const out = new Map<string, TeamSkillUsage>();
  const at = (key: string) => {
    let row = out.get(key);
    if (!row) out.set(key, (row = { runs: 0, people: 0, lastDay: "" }));
    return row;
  };
  for (const member of root.perMember) {
    for (const s of bySkill(rec(rec(member).totals).skills)) {
      const row = at(skillKey(s.skill));
      row.runs += s.count;
      row.people += 1;
    }
  }
  for (const day of arr(root.daily)) {
    const date = String(rec(day).date ?? "");
    for (const s of bySkill(rec(day).skills)) {
      const row = at(skillKey(s.skill));
      if (date > row.lastDay) row.lastDay = date;
    }
  }
  return out;
}

/** Your runs per skill key from a /v1/telemetry/me body. Throws on a foreign shape. */
export function mySkillUsage(body: unknown): Map<string, number> {
  const totals = rec(rec(body).totals);
  if (!("skills" in totals)) throw new Error("my telemetry: totals.skills missing");
  const out = new Map<string, number>();
  for (const s of bySkill(totals.skills)) {
    const key = skillKey(s.skill);
    out.set(key, (out.get(key) ?? 0) + s.count);
  }
  return out;
}

function lookup<T>(map: Map<string, T> | null, name: string): T | undefined {
  if (!map) return undefined;
  const key = skillKey(name);
  const exact = map.get(key);
  if (exact !== undefined) return exact;
  const tail = namespaceTail(key);
  for (const [k, v] of map) if (namespaceTail(k) === tail) return v;
  return undefined;
}

/**
 * One row per library skill. A failed or missing read gives `null` for its
 * columns (shown as a dash with a plain note); a read that worked but has no
 * runs gives 0 runs, also shown as a dash. Sorted by team runs, then your
 * runs, then name.
 */
export function skillUsageRows(
  skills: { name: string; path: string }[],
  team: Map<string, TeamSkillUsage> | null,
  mine: Map<string, number> | null,
): SkillUsageRow[] {
  return skills
    .map((s) => {
      const t = lookup(team, s.name);
      const m = lookup(mine, s.name);
      return {
        name: s.name,
        path: s.path,
        teamRuns: team ? (t?.runs ?? 0) : null,
        people: team ? (t?.people ?? 0) : null,
        lastDay: t?.lastDay ?? "",
        yourRuns: mine ? (m ?? 0) : null,
      };
    })
    .sort((a, b) => (b.teamRuns ?? -1) - (a.teamRuns ?? -1) || (b.yourRuns ?? -1) - (a.yourRuns ?? -1) || a.name.localeCompare(b.name));
}

/** A count cell: a dash for no runs or no data. */
export function runsCell(n: number | null): string {
  return n == null || n === 0 ? "—" : String(n);
}

/** "Oct 2" from YYYY-MM-DD; a dash when there was no run. */
export function lastRunCell(day: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return "—";
  const d = new Date(`${day}T00:00:00Z`);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}
