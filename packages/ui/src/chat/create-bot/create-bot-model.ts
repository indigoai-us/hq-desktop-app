/**
 * Pure state for the New bot flow (bots-v2 step 2).
 *
 * Three steps — kind → home → details — and one draft. Everything the steps
 * need to decide "can I advance / can I create" lives here so the Svelte
 * components stay thin and the rules are unit-testable without a DOM.
 *
 * Every AI teammate is a bot. Cloud bots are company-hosted and their details
 * are collected by the server card flow, so a Cloud draft ends at the home
 * step; a Local draft continues to details (name, avatar, intro, advanced).
 */

import type { LocalBotCreateInput, LocalBotWorkerOption } from "@hq/platform";
import type { AvatarSelection } from "../../avatars/types.js";
import { LOCAL_BOT_RUNTIMES, isValidLocalBotName } from "../local-bots.js";

export type CreateBotStep = "kind" | "home" | "details";
export type BotKindChoice = "blank" | "template" | "clone";
export type BotHome = "local" | "cloud";
export type BotRuntime = LocalBotCreateInput["runtime"];
export type BotMemory = "synced" | "local";

export interface CreateBotDraft {
  kind: BotKindChoice;
  templateId?: string;
  cloneUid?: string;
  home: BotHome;
  runtime: BotRuntime;
  companyUid?: string;
  name: string;
  intro: string;
  avatar?: AvatarSelection;
  autoApprove: boolean;
  model: string;
  memory: BotMemory;
}

/** What the host knows that the rules depend on. */
export interface CreateBotContext {
  /** This Mac can host a bot (the host wired `oncreatebot`). */
  canLocal: boolean;
  /** At least one company can take a Cloud bot. */
  canCloud: boolean;
  /** `{ claude: true, codex: false }`; null → unknown, treated as ready. */
  runtimeReady: Record<string, boolean> | null;
  /** Names already taken by the user's local bots. */
  existingNames: readonly string[];
  companies: ReadonlyArray<{ companyUid: string; label: string }>;
  templates: readonly LocalBotWorkerOption[];
}

export const INTRO_MAX = 500;

export const BOT_NAME_SUGGESTIONS: readonly string[] = [
  "assistant",
  "scout",
  "buddy",
  "atlas",
  "quill",
  "pixel",
  "echo",
  "sage",
  "nova",
  "ember",
  "juniper",
  "orbit",
];

export function initialDraft(ctx: Pick<CreateBotContext, "canLocal" | "canCloud" | "existingNames" | "companies" | "runtimeReady">): CreateBotDraft {
  return {
    kind: "blank",
    home: ctx.canLocal ? "local" : "cloud",
    runtime: firstReadyRuntime(ctx.runtimeReady),
    companyUid: ctx.companies[0]?.companyUid,
    name: suggestBotName(ctx.existingNames),
    intro: "",
    autoApprove: true,
    model: "",
    memory: "synced",
  };
}

/** The first signed-in runtime in picker order; claude when nothing is known. */
export function firstReadyRuntime(ready: Record<string, boolean> | null | undefined): BotRuntime {
  if (!ready) return "claude";
  return LOCAL_BOT_RUNTIMES.find((r) => ready[r.id] !== false)?.id ?? "claude";
}

export function runtimeIsReady(ready: Record<string, boolean> | null | undefined, id: string): boolean {
  if (!ready) return true;
  return ready[id] !== false;
}

// ── names ──────────────────────────────────────────────────────────────────

export function normalizeBotName(name: string): string {
  return name.trim().toLowerCase();
}

/** Turn a display name ("Izzy Bot") into a candidate slug ("izzy-bot"). */
export function slugifyBotName(display: string): string {
  return display
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

function taken(name: string, existing: readonly string[]): boolean {
  const n = normalizeBotName(name);
  return existing.some((e) => normalizeBotName(e) === n);
}

/** Validation message for the name field; null when the name is fine. */
export function nameIssue(name: string, existing: readonly string[]): string | null {
  const n = normalizeBotName(name);
  if (!n) return "Give your bot a name.";
  if (!isValidLocalBotName(n)) {
    return "Lowercase letters, digits, and single hyphens — for example “scout-2”.";
  }
  if (taken(n, existing)) return `You already have a bot named ${n}.`;
  return null;
}

/** First free name from the suggestion list; a numbered fallback otherwise. */
export function suggestBotName(existing: readonly string[], pool: readonly string[] = BOT_NAME_SUGGESTIONS): string {
  const free = pool.find((n) => !taken(n, existing));
  if (free) return free;
  const base = pool[0] ?? "assistant";
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${base}-${i}`;
    if (!taken(candidate, existing)) return candidate;
  }
  return base;
}

/** Up to `count` free suggestions (never the current name). */
export function suggestBotNames(
  existing: readonly string[],
  count = 4,
  current = "",
  pool: readonly string[] = BOT_NAME_SUGGESTIONS,
): string[] {
  const out: string[] = [];
  for (const n of pool) {
    if (out.length >= count) break;
    if (taken(n, existing) || n === normalizeBotName(current)) continue;
    out.push(n);
  }
  return out;
}

/** A free slug derived from a display name (clone prefill). */
export function freeSlugFrom(display: string, existing: readonly string[]): string {
  const base = slugifyBotName(display) || "bot";
  if (!taken(base, existing)) return base;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${base.slice(0, 40 - String(i).length - 1)}-${i}`;
    if (!taken(candidate, existing)) return candidate;
  }
  return base;
}

// ── intro ──────────────────────────────────────────────────────────────────

export function introIssue(intro: string): string | null {
  if (intro.length > INTRO_MAX) return `Keep the intro under ${INTRO_MAX} characters.`;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(intro)) {
    return "The intro can’t contain control characters.";
  }
  return null;
}

// ── templates ──────────────────────────────────────────────────────────────

export interface TemplateCard {
  id: string;
  name: string;
  summary: string;
  skillCount: number | null;
  company: string | null;
  source: "core" | "company";
}

export interface TemplateGroup {
  /** Company slug, or null for core/shared templates. */
  company: string | null;
  label: string;
  templates: TemplateCard[];
}

export function firstSentence(text: string | null | undefined): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  const m = /^(.+?[.!?])(?:\s|$)/.exec(t);
  return (m?.[1] ?? t).slice(0, 160);
}

export function templateSummary(option: LocalBotWorkerOption): string {
  return (option.summary ?? "").trim() || firstSentence(option.description);
}

export function templateName(option: LocalBotWorkerOption): string {
  const explicit = (option.name ?? "").trim();
  if (explicit) return explicit;
  return option.id
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
}

export function templateCard(option: LocalBotWorkerOption): TemplateCard {
  const company = (option.company ?? "").trim() || null;
  return {
    id: option.id,
    name: templateName(option),
    summary: templateSummary(option),
    skillCount: typeof option.skillCount === "number" && option.skillCount >= 0 ? option.skillCount : null,
    company,
    source: option.source ?? (company ? "company" : "core"),
  };
}

export function companyLabelFor(slug: string | null): string {
  if (!slug) return "HQ core";
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
}

function matchesTemplate(card: TemplateCard, query: string): boolean {
  if (!query) return true;
  const hay = `${card.id} ${card.name} ${card.summary} ${card.company ?? ""}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => hay.includes(term));
}

/**
 * Cards grouped by company (core first, then companies alphabetically),
 * filtered by a free-text query over id/name/summary/company. Empty groups
 * are dropped; card order within a group is by name.
 */
export function groupTemplates(options: readonly LocalBotWorkerOption[], query = ""): TemplateGroup[] {
  const q = query.trim();
  const byCompany = new Map<string | null, TemplateCard[]>();
  for (const option of options) {
    const card = templateCard(option);
    if (!matchesTemplate(card, q)) continue;
    const list = byCompany.get(card.company) ?? [];
    list.push(card);
    byCompany.set(card.company, list);
  }
  const keys = [...byCompany.keys()].sort((a, b) => {
    if (a === null) return -1;
    if (b === null) return 1;
    return a.localeCompare(b);
  });
  return keys.map((company) => ({
    company,
    label: companyLabelFor(company),
    templates: (byCompany.get(company) ?? []).sort((a, b) => a.name.localeCompare(b.name)),
  }));
}

/** "Instructions, 4 skills, and Indigo policies" for the details step. */
export function templateBringsLine(card: TemplateCard | null): string {
  if (!card) return "";
  const parts = ["its instructions"];
  if (card.skillCount != null) {
    parts.push(card.skillCount === 1 ? "1 skill" : `${card.skillCount} skills`);
  }
  if (card.company) parts.push(`${companyLabelFor(card.company)} policies`);
  if (parts.length === 1) return `Brings ${parts[0]}.`;
  return `Brings ${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}.`;
}

// ── clone ──────────────────────────────────────────────────────────────────

export interface CloneCandidate {
  uid: string;
  displayName: string;
  description?: string | null;
  avatarUrl?: string | null;
  kind: "cloud" | "local";
}

/** Copy a bot's persona (name, description as intro, avatar) into a fresh Local draft. */
export function draftFromClone(
  bot: CloneCandidate,
  base: CreateBotDraft,
  existingNames: readonly string[],
): CreateBotDraft {
  const intro = (bot.description ?? "").replace(/\s+/g, " ").trim().slice(0, INTRO_MAX);
  return {
    ...base,
    kind: "clone",
    cloneUid: bot.uid,
    templateId: undefined,
    home: "local",
    name: freeSlugFrom(bot.displayName, existingNames),
    intro,
  };
}

// ── steps ──────────────────────────────────────────────────────────────────

/** The steps this draft walks: Cloud stops at home, Local continues to details. */
export function stepsFor(draft: Pick<CreateBotDraft, "home">): CreateBotStep[] {
  return draft.home === "cloud" ? ["kind", "home"] : ["kind", "home", "details"];
}

export function nextStep(step: CreateBotStep, draft: Pick<CreateBotDraft, "home">): CreateBotStep | null {
  const steps = stepsFor(draft);
  const at = steps.indexOf(step);
  return at >= 0 ? (steps[at + 1] ?? null) : null;
}

export function prevStep(step: CreateBotStep, draft: Pick<CreateBotDraft, "home">): CreateBotStep | null {
  const steps = stepsFor(draft);
  const at = steps.indexOf(step);
  return at > 0 ? (steps[at - 1] ?? null) : null;
}

/** Why this step cannot advance yet; null when it can. */
export function stepIssue(step: CreateBotStep, draft: CreateBotDraft, ctx: CreateBotContext): string | null {
  switch (step) {
    case "kind":
      if (draft.kind === "template" && !draft.templateId) return "Pick a template.";
      if (draft.kind === "clone" && !draft.cloneUid) return "Pick a bot to clone.";
      return null;
    case "home":
      if (draft.home === "local") {
        if (!ctx.canLocal) return "Bots can’t run on this computer.";
        if (!runtimeIsReady(ctx.runtimeReady, draft.runtime)) {
          const label = LOCAL_BOT_RUNTIMES.find((r) => r.id === draft.runtime)?.label ?? draft.runtime;
          return `${label} is not signed in on this Mac.`;
        }
        return null;
      }
      if (!ctx.canCloud) return "No company can host a bot right now.";
      if (!draft.companyUid || !ctx.companies.some((c) => c.companyUid === draft.companyUid)) {
        return "Pick a company.";
      }
      return null;
    case "details":
      return nameIssue(draft.name, ctx.existingNames) ?? introIssue(draft.intro);
  }
}

export function canAdvance(step: CreateBotStep, draft: CreateBotDraft, ctx: CreateBotContext): boolean {
  if (nextStep(step, draft) === null) return false;
  return stepIssue(step, draft, ctx) === null;
}

/** Every step the draft walks is valid → Cmd-Enter may create from anywhere. */
export function canCreate(draft: CreateBotDraft, ctx: CreateBotContext): boolean {
  return stepsFor(draft).every((step) => stepIssue(step, draft, ctx) === null);
}

/** The first step that still needs the user; null when the draft is complete. */
export function firstBlockingStep(draft: CreateBotDraft, ctx: CreateBotContext): CreateBotStep | null {
  return stepsFor(draft).find((step) => stepIssue(step, draft, ctx) !== null) ?? null;
}

/** The CLI input for a Local draft (Cloud drafts never reach the CLI). */
export function toCreateInput(draft: CreateBotDraft): LocalBotCreateInput {
  const model = draft.model.trim();
  const intro = draft.intro.trim();
  const worker = draft.kind === "template" ? (draft.templateId ?? "").trim() : "";
  return {
    name: normalizeBotName(draft.name),
    runtime: draft.runtime,
    autoApprove: draft.autoApprove,
    ...(model ? { model } : {}),
    ...(worker ? { worker } : {}),
    ...(intro ? { intro } : {}),
    ...(draft.memory !== "synced" ? { memory: draft.memory } : {}),
  };
}

/** "thinks with Claude Code" / "hosted by Indigo" for the preview card. */
export function thinksWithLine(draft: CreateBotDraft, ctx: Pick<CreateBotContext, "companies">): string {
  if (draft.home === "cloud") {
    const company = ctx.companies.find((c) => c.companyUid === draft.companyUid);
    return company ? `hosted by ${company.label}` : "hosted in the cloud";
  }
  const runtime = LOCAL_BOT_RUNTIMES.find((r) => r.id === draft.runtime)?.label ?? draft.runtime;
  const model = draft.model.trim();
  return model ? `thinks with ${runtime} · ${model}` : `thinks with ${runtime}`;
}

export const STEP_TITLES: Record<CreateBotStep, string> = {
  kind: "What kind of bot?",
  home: "Where does it run?",
  details: "Details",
};
