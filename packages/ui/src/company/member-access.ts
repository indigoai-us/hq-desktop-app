/**
 * OWNER-R9: the files and secrets one member can reach, from
 * `GET /files/{companyUid}/members/{personUid}/access` (the same read the web
 * console's member pane uses). Pure mapping; the pane renders it.
 */

export interface AccessRow {
  path: string;
  level: string;
  reason: string;
}

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
    out.push({ path, level: levelLabel(str(g.permission)), reason: reasons.join(", ") });
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

/** Replace any agt_ id segment in a path with the bot's name when known. */
export function pathWithBotNames(path: string, botName: (id: string) => string | null): string {
  return path.replace(/\b(agt_[A-Za-z0-9]{6,})\b/g, (id) => botName(id) ?? "a bot");
}
