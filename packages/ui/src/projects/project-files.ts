/**
 * Project Files tab (US-025). Pure helpers: which roots a viewer may see,
 * upload name conflicts, new-file templates, and a process-local directory
 * cache so the tab paints last-known children before the refresh returns.
 */
import type { DirEntry } from "../files/file-tree.js";
import type { PortfolioSessionRef } from "./projects-model.js";
import { isPortfolioLiveStatus } from "./projects-model.js";

export type ConflictPolicy = "keep-both" | "replace" | "skip";

export type FileTemplate = "blank" | "knowledge" | "policy" | "meeting";

export interface FileRoot {
  kind: "vault" | "repo";
  /** HQ-relative directory. */
  path: string;
  /** Repo branch label; vault roots leave this null. */
  branch: string | null;
}

export interface RowMark {
  label: string;
  live: boolean;
}

const childCache = new Map<string, DirEntry[]>();

export function cachedChildren(path: string): DirEntry[] | null {
  return childCache.get(path) ?? null;
}

export function rememberChildren(path: string, entries: readonly DirEntry[]): void {
  childCache.set(path, entries.slice());
}

/** Test-only. */
export function clearFileChildCache(): void {
  childCache.clear();
}

/**
 * Vault first, linked repo second. Guests with vault access and no repo
 * access never see the repo root, even when a path is linked.
 */
export function visibleFileRoots(input: {
  vaultPath: string | null;
  repoPath?: string | null;
  repoBranch?: string | null;
  repoAccess: boolean;
}): FileRoot[] {
  const roots: FileRoot[] = [];
  const vault = (input.vaultPath ?? "").trim();
  if (vault) roots.push({ kind: "vault", path: vault, branch: null });
  const repo = (input.repoPath ?? "").trim();
  if (input.repoAccess && repo) {
    roots.push({
      kind: "repo",
      path: repo,
      branch: (input.repoBranch ?? "").trim() || null,
    });
  }
  return roots;
}

/** Read an optional repo link out of a project prd.json body. */
export function repoLinkFromPrdText(
  text: string,
): { path: string; branch: string | null } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  const raw = record.repo ?? record.repository ?? record.repoPath;
  if (typeof raw !== "string" || !raw.trim()) return null;
  const path = raw.trim().replace(/\\/g, "/").replace(/^\//, "");
  if (!path || path.includes("..")) return null;
  const branch =
    typeof record.branch === "string" && record.branch.trim()
      ? record.branch.trim()
      : null;
  return { path, branch };
}

export function fileTemplateBody(
  template: FileTemplate,
  owner: string,
): string {
  const who = owner.trim() || "owner";
  if (template === "blank") return "";
  if (template === "knowledge") {
    return `---\nscope: company\ntype: knowledge\nstatus: draft\nowner: ${who}\n---\n\n`;
  }
  if (template === "policy") {
    return `---\ntype: policy\nstrength: soft\nowner: ${who}\n---\n\n# Policy\n\n`;
  }
  return `---\ntype: meeting-notes\nowner: ${who}\n---\n\n## Attendees\n\n## Decisions\n\n## Actions\n\n`;
}

/** Safe file name: lowercase, hyphens, a single extension. */
export function normalizeNewFileName(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed || trimmed.includes("/") || trimmed.includes("\\")) return null;
  const slug = trimmed
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9._-]/g, "")
    .replace(/-+/g, "-");
  if (!slug || slug.startsWith(".")) return null;
  return slug.includes(".") ? slug : `${slug}.md`;
}

function splitName(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return { stem: name, ext: "" };
  return { stem: name.slice(0, dot), ext: name.slice(dot) };
}

/**
 * Destination file name under a conflict policy.
 * `null` means skip this file.
 */
export function resolveUploadName(
  name: string,
  existing: ReadonlySet<string>,
  policy: ConflictPolicy,
): string | null {
  if (!existing.has(name)) return name;
  if (policy === "skip") return null;
  if (policy === "replace") return name;
  const { stem, ext } = splitName(name);
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${stem}-${n}${ext}`;
    if (!existing.has(candidate)) return candidate;
  }
  return null;
}

/** Last editor / live dot for a tree row, from sessions whose cwd contains it. */
export function rowMarkForPath(
  path: string,
  sessions: readonly PortfolioSessionRef[],
): RowMark | null {
  const normalized = path.replace(/\\/g, "/");
  let best: PortfolioSessionRef | null = null;
  for (const session of sessions) {
    const cwd = (session.cwd ?? "").replace(/\\/g, "/");
    if (!cwd) continue;
    if (cwd !== normalized && !cwd.endsWith(`/${normalized}`) && !normalized.endsWith(cwd)) {
      continue;
    }
    if (!best) {
      best = session;
      continue;
    }
    const a = best.lastActivityAt ?? "";
    const b = session.lastActivityAt ?? "";
    if (b > a) best = session;
  }
  if (!best) return null;
  const label = (best.agent || best.tool || "session").trim();
  return { label, live: isPortfolioLiveStatus(best.status) };
}

/** "2 folders · 3 files" for the empty preview; "Empty folder" when none. */
export function folderSummary(entries: readonly Pick<DirEntry, "isDir">[]): string {
  const folders = entries.filter((entry) => entry.isDir).length;
  const files = entries.length - folders;
  const parts: string[] = [];
  if (folders > 0) parts.push(`${folders} ${folders === 1 ? "folder" : "folders"}`);
  if (files > 0) parts.push(`${files} ${files === 1 ? "file" : "files"}`);
  return parts.length > 0 ? parts.join(" · ") : "Empty folder";
}
