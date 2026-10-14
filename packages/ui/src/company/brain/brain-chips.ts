/**
 * Row chips, tag icons and the detail header card for the Brain pages.
 * Pure data; the page renders what these return.
 */

import type { RailIconName } from "../../common/button/rail-icons.js";
import type { KnowledgeFile, PolicyDoc, SkillRow, WorkerRow } from "./brain-model.js";

export type ChipTone = "hard" | "soft" | "ok" | "idle" | "warn" | null;

export interface Chip {
  label: string;
  tone?: ChipTone;
  icon?: RailIconName;
  title?: string;
}

/** Normalize a frontmatter text block: no BOM, LF line endings. */
export function normalizeDoc(text: string): string {
  return text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
}

/**
 * A list-valued frontmatter key, in either YAML form:
 * `tags: [a, "b"]` / `tags: a, b` or a block list (`tags:` then `- a` lines).
 */
export function frontmatterList(text: string, key: string): string[] {
  const src = normalizeDoc(text);
  if (!src.startsWith("---")) return [];
  const end = src.indexOf("\n---", 3);
  if (end < 0) return [];
  const lines = src.slice(3, end).split("\n");
  const want = key.toLowerCase();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const colon = line.indexOf(":");
    if (colon < 1 || /^\s/.test(line)) continue;
    if (line.slice(0, colon).trim().toLowerCase() !== want) continue;
    const inline = line.slice(colon + 1).trim();
    const items: string[] = [];
    if (inline) {
      items.push(...inline.replace(/^\[|\]$/g, "").split(","));
    } else {
      for (let j = i + 1; j < lines.length; j++) {
        const m = lines[j]!.match(/^\s*-\s+(.*)$/);
        if (!m) break;
        items.push(m[1]!);
      }
    }
    return dedupe(items.map(unquote).filter(Boolean));
  }
  return [];
}

function unquote(value: string): string {
  return value.trim().replace(/^["']|["']$/g, "").trim();
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * Deterministic tag → outline icon. The first matching rule wins; anything
 * else gets the neutral dot. Uses the app's own line-icon set.
 */
const TAG_ICON_RULES: ReadonlyArray<readonly [RegExp, RailIconName]> = [
  [/secur|secret|credential|auth|token|permission|acl|privacy|kms/, "key"],
  [/never|block|forbid|ban|deny|danger/, "ban"],
  [/deploy|release|ship|infra|aws|vercel|cloud|dns|lambda|s3/, "cloud"],
  [/integrat|api|mcp|slack|github|linear|webhook|oauth|connector/, "plug"],
  [/design|ui|ux|brand|figma|css|visual|layout/, "eye"],
  [/test|qa|verify|ci|check|e2e/, "check-circle"],
  [/git|pr\b|branch|repo|code|dev|build|tauri|desktop/, "laptop"],
  [/team|people|hire|member|user|customer|client/, "user-plus"],
  [/notif|dm|message|email|comms|meeting/, "bell"],
  [/config|setting|hook|polic|workflow|process/, "sliders"],
  [/archive|deprecat|legacy|retired/, "archive"],
  [/search|research|knowledge|doc|guide|reference/, "search"],
  [/file|vault|storage|sync/, "folder"],
];

export function tagIcon(tag: string): RailIconName {
  const t = tag.toLowerCase();
  for (const [rule, icon] of TAG_ICON_RULES) if (rule.test(t)) return icon;
  return "circle-dot";
}

export function tagChips(tags: readonly string[], limit = Infinity): Chip[] {
  return tags.slice(0, limit).map((tag) => ({ label: tag, icon: tagIcon(tag) }));
}

/** core, company or personal (project policies count as company). */
export function policyScope(row: Pick<PolicyDoc, "path" | "scope">): "core" | "company" | "personal" {
  const path = row.path.replace(/^\/+/, "");
  if (path.startsWith("core/") || path.includes("/core/policies/")) return "core";
  if (path.startsWith("personal/") || path.includes("/personal/policies/")) return "personal";
  const declared = row.scope.trim().toLowerCase();
  if (declared === "core" || declared === "personal") return declared;
  return "company";
}

/** A policy's `when` triggers as short tags. */
export function whenTags(when: string): string[] {
  const raw = unquote(when).replace(/^\[|\]$/g, "");
  if (!raw) return [];
  return dedupe(raw.split(/\s*(?:[,;|]|\bor\b)\s*/).map(unquote).filter(Boolean));
}

export function policyRowChips(row: PolicyDoc): Chip[] {
  return [
    { label: row.enforcement, tone: row.enforcement === "hard" ? "hard" : "soft" },
    { label: policyScope(row) },
  ];
}

/** SCAFFOLD prefix and "Blocked until …" sentence lifted out of a description. */
export interface SkillSummary {
  description: string;
  scaffold: boolean;
  blocked: string | null;
}

export function skillSummary(description: string): SkillSummary {
  let text = description.trim();
  const scaffold = /^scaffold\b[.:\s—-]*/i.test(text);
  if (scaffold) text = text.replace(/^scaffold\b[.:\s—-]*/i, "");
  const blockedMatch = text.match(/(?:^|\.\s+)(Blocked (?:until|on|by)[^.]*\.?)/);
  const blocked = blockedMatch ? blockedMatch[1]!.trim() : null;
  if (blockedMatch) text = text.replace(blockedMatch[1]!, "").trim();
  return { description: text.replace(/\s+/g, " ").trim(), scaffold, blocked };
}

export interface SkillRunInfo {
  runs: number | null;
  lastDay: string | null;
}

export function skillRowChips(row: SkillRow, usage: SkillRunInfo | null = null): Chip[] {
  const s = skillSummary(row.description);
  const chips: Chip[] = [];
  if (s.scaffold) chips.push({ label: "scaffold", tone: "idle" });
  if (s.blocked) chips.push({ label: "blocked", tone: "warn", title: s.blocked });
  if (usage?.runs) chips.push({ label: `${usage.runs} ${usage.runs === 1 ? "run" : "runs"}` });
  if (usage?.lastDay) chips.push({ label: `last ${usage.lastDay}` });
  if (row.owner && row.owner !== "root") chips.push({ label: row.owner });
  return chips;
}

export function workerRowChips(row: WorkerRow): Chip[] {
  const status = row.live ? "live" : row.parked ? "parked" : (row.status || "active").toLowerCase();
  const label = status.charAt(0).toUpperCase() + status.slice(1);
  const chips: Chip[] = [{ label, tone: row.live || status === "active" ? "ok" : "idle" }];
  if (row.type) chips.push({ label: row.type });
  if (row.team) chips.push({ label: row.team });
  if (row.skillCount != null) chips.push({ label: `${row.skillCount} ${row.skillCount === 1 ? "skill" : "skills"}` });
  if (row.model) chips.push({ label: row.model });
  return chips;
}

/**
 * Document body for the viewer: a leading `# Title` that repeats the header
 * card's title is dropped so the title shows once.
 */
export function bodyWithoutTitle(body: string, title: string): string {
  const match = body.match(/^\s*#\s+(.+?)\s*#*\s*(?:\n|$)/);
  if (!match || match[1]!.trim().toLowerCase() !== title.trim().toLowerCase()) return body;
  return body.slice(match[0].length).replace(/^\n+/, "");
}

/** The compact card above a rendered document. */
export interface DocHeader {
  kind: string;
  title: string;
  path: string;
  chips: Chip[];
  tags: Chip[];
}

export function knowledgeHeader(file: KnowledgeFile): DocHeader {
  const chips: Chip[] = [];
  if (file.mark) chips.push({ label: file.mark === "new" ? "new" : "updated", tone: file.mark === "new" ? "ok" : null });
  for (const field of file.fields ?? []) chips.push({ label: `${field.label} ${field.value}` });
  if (file.changed) chips.push({ label: `updated ${file.changed}` });
  return { kind: "Knowledge", title: file.title, path: file.path, chips, tags: tagChips(file.tags ?? []) };
}

export function policyHeader(doc: PolicyDoc): DocHeader {
  const chips: Chip[] = [...policyRowChips(doc)];
  if (doc.satisfiedBy) chips.push({ label: `satisfied by ${doc.satisfiedBy}` });
  if (doc.version) chips.push({ label: `v${doc.version.replace(/^v/i, "")}` });
  if (doc.createdBy) chips.push({ label: `by ${doc.createdBy}` });
  const triggers = whenTags(doc.when);
  // A tag that repeats a trigger shows once, as the trigger.
  const tags = [
    ...triggers.map<Chip>((t) => ({ label: t, icon: "arrow-right", title: "When this applies" })),
    ...tagChips((doc.tags ?? []).filter((t) => !triggers.includes(t))),
  ];
  return { kind: "Policy", title: doc.title, path: doc.path, chips, tags };
}
