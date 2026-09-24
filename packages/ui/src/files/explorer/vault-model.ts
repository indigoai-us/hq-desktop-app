/**
 * Pure model for the Files explorer: which vaults a person can open, how a
 * vault's tree is filtered, and the Obsidian-style note features (wikilink
 * resolution, backlinks, outline, properties, quick-switcher matching).
 *
 * No Svelte, no Tauri. The explorer reads the local HQ folder through the
 * platform `files` seam; everything here works on the plain data it returns.
 */

import type { VaultIndexedFile } from "@hq/platform";
import type { Workspace } from "../../chat/workspaces.js";
import { fileAccessibleCompanies } from "../file-tree.js";

/** One vault the explorer can open. */
export interface Vault {
  /** Stable id: `personal` or `company:<slug>`. */
  id: string;
  kind: "personal" | "company";
  label: string;
  /** HQ-relative root: `""` for personal, `companies/<slug>` for a company. */
  root: string;
  /** Company slug (the desktop read scope); null for personal. */
  slug: string | null;
}

export const PERSONAL_VAULT: Vault = {
  id: "personal",
  kind: "personal",
  label: "Personal",
  root: "",
  slug: null,
};

/**
 * Personal first, then every company the person can read that has a folder
 * on this Mac, alphabetically.
 */
export function vaultsFor(workspaces: readonly Workspace[] | null | undefined): Vault[] {
  const companies = fileAccessibleCompanies(workspaces ?? [])
    .filter((w) => w.hasLocalFolder && w.slug !== "personal")
    .map<Vault>((w) => ({
      id: `company:${w.slug}`,
      kind: "company",
      label: w.displayName?.trim() || w.slug,
      root: `companies/${w.slug}`,
      slug: w.slug,
    }))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
  return [PERSONAL_VAULT, ...companies];
}

/** Top-level folders that belong to other vaults, not the personal one. */
const PERSONAL_EXCLUDED_TOP_LEVEL = new Set([".git", "companies", "repos", "workspace"]);

/**
 * HQ system folders in the personal vault. They are HQ's own scaffold, not
 * the person's notes, so they sit behind "Show system folders".
 */
const PERSONAL_SYSTEM_TOP_LEVEL = new Set([
  "core",
  "docs",
  "sync-manifests",
  "AGENTS.md",
  "CLAUDE.md",
  "LICENSE",
  "README.md",
]);

/**
 * Names the explorer never shows: `settings/` folders and credential files.
 * Mirrors Rust `vault_index::is_sensitive_name`, which keeps them out of the
 * index; this keeps them out of the lazily listed tree.
 */
export function isSensitiveName(name: string, isDir: boolean): boolean {
  const lower = name.toLowerCase();
  if (isDir) return lower === "settings" || lower === "secrets" || lower === ".ssh";
  if (lower === ".env" || (lower.startsWith(".env.") && lower !== ".env.example")) return true;
  if ([".netrc", ".npmrc", "id_rsa", "id_ed25519"].includes(lower)) return true;
  if ([".pem", ".key", ".p12", ".pfx", ".keystore"].some((ext) => lower.endsWith(ext))) return true;
  const dataFile = [".json", ".txt", ".yaml", ".yml", ".toml"].some((ext) => lower.endsWith(ext));
  return lower.includes("credential") || lower.includes("secret") || (dataFile && lower.includes("token"));
}

export interface TreeEntry {
  name: string;
  path: string;
  isDir: boolean;
  hasChildren: boolean;
}

/**
 * Filter one listed folder for display. Always drops sensitive names; at the
 * personal vault's top level, drops other vaults' folders and (unless asked)
 * HQ's own system folders.
 */
export function visibleEntries(
  vault: Vault,
  parentPath: string,
  entries: readonly TreeEntry[],
  options: { showSystem?: boolean } = {},
): TreeEntry[] {
  const atPersonalTop = vault.kind === "personal" && parentPath === "";
  return entries.filter((e) => {
    if (isSensitiveName(e.name, e.isDir)) return false;
    // Dotfiles (.gitignore, sync journals) are tooling, not notes.
    if (!options.showSystem && e.name.startsWith(".")) return false;
    if (!atPersonalTop) return true;
    if (e.isDir && PERSONAL_EXCLUDED_TOP_LEVEL.has(e.name)) return false;
    if (!options.showSystem && PERSONAL_SYSTEM_TOP_LEVEL.has(e.name)) return false;
    return true;
  });
}

/** Parse a `list_hq_dir` row defensively. */
export function toTreeEntry(raw: unknown): TreeEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== "string" || typeof r.path !== "string") return null;
  return {
    name: r.name,
    path: r.path,
    isDir: r.isDir === true,
    hasChildren: r.hasChildren === true,
  };
}

/** True for HQ scaffold paths in the personal vault (hidden unless asked). */
export function isSystemPath(vault: Vault, path: string): boolean {
  if (path.split("/").some((part) => part.startsWith("."))) return true;
  if (vault.kind !== "personal") return false;
  return PERSONAL_SYSTEM_TOP_LEVEL.has(path.split("/")[0] ?? "");
}

/** "1 file", "3 files". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

/** True when `path` is inside the vault (the personal vault excludes the others). */
export function pathInVault(vault: Vault, path: string): boolean {
  if (vault.kind === "company") return path === vault.root || path.startsWith(`${vault.root}/`);
  const top = path.split("/")[0] ?? "";
  return !PERSONAL_EXCLUDED_TOP_LEVEL.has(top);
}

/** Path shown to people: relative to the vault root. */
export function vaultRelativePath(vault: Vault, path: string): string {
  if (vault.kind === "company" && path.startsWith(`${vault.root}/`)) {
    return path.slice(vault.root.length + 1);
  }
  return path;
}

/** Breadcrumb segments for `path` inside `vault`, with the path each one opens. */
export function breadcrumbs(vault: Vault, path: string): Array<{ label: string; path: string }> {
  const rel = vaultRelativePath(vault, path);
  const parts = rel.split("/").filter(Boolean);
  const base = vault.kind === "company" ? vault.root : "";
  const out: Array<{ label: string; path: string }> = [];
  let acc = base;
  for (const part of parts) {
    acc = acc ? `${acc}/${part}` : part;
    out.push({ label: part, path: acc });
  }
  return out;
}

/** File name without a Markdown extension, as notes are titled. */
export function noteTitle(path: string): string {
  const name = path.split("/").pop() ?? path;
  return name.replace(/\.(md|markdown)$/i, "");
}

export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown)$/i.test(path);
}

// ---- Wikilinks and backlinks ----------------------------------------------

/** Lookup tables built once per index. */
export interface LinkResolver {
  resolve(target: string, fromPath: string): string | null;
}

function stripMdExt(p: string): string {
  return p.replace(/\.(md|markdown)$/i, "");
}

/**
 * Resolve `[[target]]` the way Obsidian does, restricted to one vault:
 * an exact vault-relative path first (with or without `.md`), then a path
 * relative to the linking note's folder, then a unique-ish file name match
 * (shortest path wins, like Obsidian's "shortest path when possible").
 */
export function createLinkResolver(vault: Vault, files: readonly VaultIndexedFile[]): LinkResolver {
  const byRelPath = new Map<string, string>();
  const byName = new Map<string, string[]>();
  for (const f of files) {
    const rel = vaultRelativePath(vault, f.path).toLowerCase();
    byRelPath.set(rel, f.path);
    byRelPath.set(stripMdExt(rel), byRelPath.get(stripMdExt(rel)) ?? f.path);
    const name = f.name.toLowerCase();
    for (const key of new Set([name, stripMdExt(name)])) {
      const list = byName.get(key) ?? [];
      list.push(f.path);
      byName.set(key, list);
    }
  }
  for (const list of byName.values()) {
    list.sort((a, b) => a.split("/").length - b.split("/").length || a.length - b.length);
  }
  return {
    resolve(target, fromPath) {
      const clean = target.trim().replace(/^\/+/, "").replace(/\\/g, "/").toLowerCase();
      if (!clean) return null;
      const exact = byRelPath.get(clean);
      if (exact) return exact;
      const fromDir = vaultRelativePath(vault, fromPath).split("/").slice(0, -1);
      const relParts = [...fromDir];
      for (const part of clean.split("/")) {
        if (part === "..") relParts.pop();
        else if (part !== ".") relParts.push(part);
      }
      const relative = byRelPath.get(relParts.join("/"));
      if (relative) return relative;
      const last = clean.split("/").pop() ?? clean;
      const candidates = byName.get(last) ?? [];
      if (candidates.length === 0) return null;
      if (clean.includes("/")) {
        const suffix = `/${stripMdExt(clean)}`;
        const match = candidates.find((c) => stripMdExt(c.toLowerCase()).endsWith(suffix));
        if (match) return match;
      }
      return candidates[0] ?? null;
    },
  };
}

/** Notes that link to `path`, by title. */
export function backlinksFor(
  path: string,
  files: readonly VaultIndexedFile[],
  resolver: LinkResolver,
): VaultIndexedFile[] {
  return files
    .filter((f) => f.path !== path && f.links.some((t) => resolver.resolve(t, f.path) === path))
    .sort((a, b) => noteTitle(a.path).localeCompare(noteTitle(b.path)));
}

// ---- Note content ------------------------------------------------------------

export interface NoteProperty {
  key: string;
  value: string | string[];
}

/**
 * Read a leading YAML frontmatter block into flat properties: `key: value`,
 * inline lists `[a, b]`, and block lists (`- item`). Nested maps are shown as
 * their raw text. Returns the body without the block.
 */
export function splitFrontmatter(source: string): { properties: NoteProperty[]; body: string } {
  const text = source.startsWith("﻿") ? source.slice(1) : source;
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") return { properties: [], body: text };
  const end = lines.slice(1, 201).findIndex((l) => /^(---|\.\.\.)\s*$/.test(l));
  if (end < 0) return { properties: [], body: text };
  const meta = lines.slice(1, end + 1);
  const properties: NoteProperty[] = [];
  let current: NoteProperty | null = null;
  for (const raw of meta) {
    const line = raw.replace(/\r$/, "");
    const item = line.match(/^\s+-\s+(.*)$/) ?? line.match(/^-\s+(.*)$/);
    if (item && current) {
      const list = Array.isArray(current.value) ? current.value : current.value ? [current.value] : [];
      list.push(unquote(item[1]));
      current.value = list;
      continue;
    }
    const kv = line.match(/^([A-Za-z_][\w.-]*)\s*:\s*(.*)$/);
    if (kv) {
      const rawValue = kv[2].trim();
      const inline = rawValue.match(/^\[(.*)\]$/);
      current = {
        key: kv[1],
        value: inline
          ? inline[1].split(",").map((v) => unquote(v.trim())).filter(Boolean)
          : unquote(rawValue),
      };
      properties.push(current);
      continue;
    }
    if (current && /^\s+\S/.test(line) && !Array.isArray(current.value)) {
      current.value = `${current.value ? `${current.value} ` : ""}${line.trim()}`;
    }
  }
  if (properties.length === 0) return { properties: [], body: text };
  return { properties, body: lines.slice(end + 2).join("\n").replace(/^\s*\n/, "") };
}

function unquote(v: string): string {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

export interface OutlineItem {
  level: number;
  text: string;
  /** 0-based index among the document's headings, used to scroll to it. */
  index: number;
}

/** ATX headings outside fenced code, with inline markup stripped. */
export function outlineOf(body: string): OutlineItem[] {
  const out: OutlineItem[] = [];
  let fence = false;
  for (const line of body.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    const m = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (!m) continue;
    const text = m[2]
      .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
      .replace(/\[\[([^\]]+)\]\]/g, (_s, t: string) => t.split("/").pop() ?? t)
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/[*_`~]/g, "")
      .trim();
    if (text) out.push({ level: m[1].length, text, index: out.length });
  }
  return out;
}

// ---- Quick switcher ---------------------------------------------------------

/**
 * Fuzzy score of `query` against a file: every query character must appear in
 * order. Matches in the file name beat matches in folders; consecutive and
 * word-start matches score higher. Null when it does not match.
 */
export function fuzzyScore(query: string, path: string): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const lower = path.toLowerCase();
  const nameStart = lower.lastIndexOf("/") + 1;
  let score = 0;
  let from = 0;
  let prev = -2;
  for (const ch of q) {
    if (ch === " ") continue;
    const idx = lower.indexOf(ch, from);
    if (idx < 0) return null;
    score += 1;
    if (idx >= nameStart) score += 2;
    if (idx === prev + 1) score += 3;
    const before = lower[idx - 1];
    if (idx === 0 || before === "/" || before === "-" || before === "_" || before === " " || before === ".") {
      score += 2;
    }
    prev = idx;
    from = idx + 1;
  }
  if (lower.slice(nameStart).startsWith(q)) score += 10;
  return score - lower.length * 0.01;
}

export function quickSwitch(
  query: string,
  files: readonly VaultIndexedFile[],
  vault: Vault,
  limit = 50,
): VaultIndexedFile[] {
  if (!query.trim()) {
    return files.filter((f) => f.isMarkdown).slice(0, limit);
  }
  const scored: Array<{ f: VaultIndexedFile; s: number }> = [];
  for (const f of files) {
    const s = fuzzyScore(query, vaultRelativePath(vault, f.path));
    if (s !== null) scored.push({ f, s: s + (f.isMarkdown ? 1 : 0) });
  }
  return scored.sort((a, b) => b.s - a.s).slice(0, limit).map((x) => x.f);
}

/** Counts for the vault home. */
export function vaultStats(files: readonly VaultIndexedFile[]): { notes: number; files: number; links: number } {
  let notes = 0;
  let links = 0;
  for (const f of files) {
    if (f.isMarkdown) notes += 1;
    links += f.links.length;
  }
  return { notes, files: files.length, links };
}
