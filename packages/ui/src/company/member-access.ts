/**
 * OWNER-R9: the files and secrets one member can reach, from
 * `GET /files/{companyUid}/members/{personUid}/access` (the same read the web
 * console's member pane uses). Pure mapping; the pane renders it.
 */

export interface AccessRow {
  path: string;
  level: string;
  reason: string;
  /** Where the grant comes from, first source first. */
  sources: GrantSource[];
  /** Group name when a source is a group grant. */
  groupName?: string;
}

/** Why a member can reach a path. */
export type GrantSource = "group" | "created" | "company-wide" | "direct" | "other";

export interface MemberAccessView {
  groups: string[];
  files: AccessRow[];
  secrets: AccessRow[];
  /** Owner/admin reach every file regardless of grants. */
  filesBypass: boolean;
  secretsBypass: boolean;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

const LEVEL: Record<string, string> = { read: "read", write: "read + write", "read-write": "read + write", readwrite: "read + write", admin: "admin" };

export function levelLabel(permission: string): string {
  return LEVEL[permission.toLowerCase()] ?? permission;
}

function reasonOf(source: Record<string, unknown>): string {
  switch (str(source.via)) {
    case "group":
      return str(source.groupName) ? `via ${str(source.groupName)}` : "via a group";
    case "creator":
      return "they created it";
    case "company-wide":
    case "open":
      return "shared company-wide";
    case "email":
    case "person":
      return "granted directly";
    default:
      return "";
  }
}

function sourceOf(source: Record<string, unknown>): GrantSource {
  switch (str(source.via)) {
    case "group":
      return "group";
    case "creator":
      return "created";
    case "company-wide":
    case "open":
      return "company-wide";
    case "email":
    case "person":
      return "direct";
    default:
      return "other";
  }
}

function grants(value: unknown): AccessRow[] {
  if (!Array.isArray(value)) return [];
  const out: AccessRow[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const g = raw as Record<string, unknown>;
    const path = str(g.path);
    if (!path) continue;
    const sources = Array.isArray(g.sources) ? (g.sources as Record<string, unknown>[]) : [];
    const reasons = [...new Set(sources.map(reasonOf).filter(Boolean))];
    const kinds = [...new Set(sources.map(sourceOf))];
    const groupName = sources.map((s) => (str(s.via) === "group" ? str(s.groupName) : "")).find(Boolean);
    out.push({
      path,
      level: levelLabel(str(g.permission)),
      reason: reasons.join(", "),
      sources: kinds.length > 0 ? kinds : ["other"],
      ...(groupName ? { groupName } : {}),
    });
  }
  return out;
}

export function memberAccessView(payload: unknown): MemberAccessView {
  const rec = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const identity = (rec.identity ?? {}) as Record<string, unknown>;
  const files = (rec.files ?? {}) as Record<string, unknown>;
  const secrets = (rec.secrets ?? {}) as Record<string, unknown>;
  const groups = Array.isArray(identity.groups)
    ? (identity.groups as Record<string, unknown>[]).map((g) => str(g.name) || "Unnamed group")
    : [];
  return {
    groups,
    files: grants(files.grants),
    secrets: grants(secrets.grants),
    filesBypass: files.roleBypass === true,
    secretsBypass: secrets.roleBypass === true,
  };
}

/** One collapsed line of the access summary: same source, same top folder. */
export interface GrantGroup {
  key: string;
  source: GrantSource;
  /** "because they created them", "via Finance", "shared company-wide", "granted directly". */
  why: string;
  /** Top-level folder with a trailing slash ("agents/"), or "Everything" for "*". */
  prefix: string;
  /** One level when every row shares it, else "mixed levels". */
  level: string;
  rows: AccessRow[];
}

export interface AccessSide {
  /** Role reaches every item; per-path grants are not listed. */
  bypass: boolean;
  total: number;
  groups: GrantGroup[];
}

export interface AccessSummary {
  /** One line of truth when the role reaches every file and secret. */
  everything: string | null;
  files: AccessSide;
  secrets: AccessSide;
}

const SOURCE_ORDER: Record<GrantSource, number> = {
  "company-wide": 0,
  group: 1,
  direct: 2,
  created: 3,
  other: 4,
};

function whyFor(source: GrantSource, groupName: string | undefined, many: boolean): string {
  switch (source) {
    case "created":
      return many ? "because they created them" : "because they created it";
    case "group":
      return groupName ? `via ${groupName}` : "via a group";
    case "company-wide":
      return "shared company-wide";
    case "direct":
      return "granted directly";
    default:
      return "other grants";
  }
}

/** "agents/a bot/*" → "agents/", "knowledge/" → "knowledge/", "*" → "Everything". */
export function topPrefix(path: string): string {
  const clean = path.trim().replace(/^\/+/, "");
  if (clean === "" || clean === "*" || clean === "/*") return "Everything";
  const first = clean.split("/")[0] ?? clean;
  return clean.includes("/") ? `${first}/` : first;
}

function side(rows: readonly AccessRow[], bypass: boolean): AccessSide {
  if (bypass) return { bypass: true, total: rows.length, groups: [] };
  const byKey = new Map<string, { source: GrantSource; groupName?: string; prefix: string; rows: AccessRow[] }>();
  for (const row of rows) {
    const source = row.sources[0] ?? "other";
    const prefix = topPrefix(row.path);
    const groupName = source === "group" ? row.groupName : undefined;
    const key = `${source}|${groupName ?? ""}|${prefix}`;
    const entry = byKey.get(key) ?? { source, groupName, prefix, rows: [] };
    entry.rows.push(row);
    byKey.set(key, entry);
  }
  const groups: GrantGroup[] = [...byKey.entries()].map(([key, g]) => {
    const levels = new Set(g.rows.map((r) => r.level));
    return {
      key,
      source: g.source,
      why: whyFor(g.source, g.groupName, g.rows.length > 1),
      prefix: g.prefix,
      level: levels.size === 1 ? [...levels][0]! : "mixed levels",
      rows: [...g.rows].sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true })),
    };
  });
  groups.sort(
    (a, b) =>
      SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source] ||
      b.rows.length - a.rows.length ||
      a.prefix.localeCompare(b.prefix),
  );
  return { bypass: false, total: rows.length, groups };
}

/**
 * A high-level, explorable summary of what a member can reach. When the role
 * reaches every file and every secret there is one line of truth and no
 * per-path list; otherwise grants roll up by source and top-level folder.
 */
export function summarizeAccess(
  view: MemberAccessView,
  opts: { role?: string; companyLabel?: string } = {},
): AccessSummary {
  const role = opts.role?.trim() || "Owner";
  const company = opts.companyLabel?.trim() || "this company";
  const everything =
    view.filesBypass && view.secretsBypass ? `${role}: every file and secret in ${company}` : null;
  return {
    everything,
    files: side(view.files, view.filesBypass),
    secrets: side(view.secrets, view.secretsBypass),
  };
}

/** "46 prefixes", "1 prefix". */
export function prefixCount(n: number): string {
  return `${n} ${n === 1 ? "prefix" : "prefixes"}`;
}

/** Replace any agt_ id segment in a path with the bot's name when known. */
export function pathWithBotNames(path: string, botName: (id: string) => string | null): string {
  return path.replace(/\b(agt_[A-Za-z0-9]{6,})\b/g, (id) => botName(id) ?? "a bot");
}
