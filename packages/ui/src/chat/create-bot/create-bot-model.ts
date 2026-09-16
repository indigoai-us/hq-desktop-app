/**
 * Pure state for the New bot flow (bots-v2 step 2).
 *
 * Three steps — kind → home → details — and one draft. Everything the steps
 * need to decide "can I advance / can I create" lives here so the Svelte
 * components stay thin and the rules are unit-testable without a DOM.
 *
 * Every AI teammate is a bot. Both homes walk all three steps: the details
 * a Local bot needs (name, avatar, intro, advanced) and the two a Cloud bot
 * needs (name and @handle). The company channel's own "Create a bot" card is
 * retired, so this flow is the ONLY place a cloud bot is named — a suggested
 * name is a prefill the person can see and change, never a silent default.
 */

import type { LocalBotCreateInput, LocalBotKind, LocalBotWorkerOption } from "@hq/platform";
import type { AvatarSelection } from "../../avatars/types.js";
import { LOCAL_BOT_RUNTIMES, isValidLocalBotName } from "../local-bots.js";

export type CreateBotStep = "kind" | "home" | "details";
export type BotKindChoice = "blank" | "template";
export type BotHome = "local" | "cloud";
export type BotRuntime = LocalBotCreateInput["runtime"];
export type BotMemory = "synced" | "local";
/** Who a Local bot acts as (bot-kinds): the owner, or itself inside its companies. */
export type BotScope = LocalBotKind;

export interface CreateBotDraft {
  kind: BotKindChoice;
  templateId?: string;
  home: BotHome;
  runtime: BotRuntime;
  companyUid?: string;
  /** Local only: personal (acts as you) or company (acts as itself). */
  scope: BotScope;
  /** Local company bots: the company slugs it belongs to (at least one). */
  companySlugs: string[];
  name: string;
  /** Cloud only: the @handle. Empty means "follow the name". */
  handle: string;
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
  /** The owner's companies a Local company bot can belong to (slugs). */
  ownerCompanies: ReadonlyArray<{ slug: string; label: string }>;
  templates: readonly LocalBotWorkerOption[];
}

/** One-line copy for each bot scope, shown beside the choice. */
export const BOT_SCOPE_COPY: Record<BotScope, { title: string; sub: string }> = {
  personal: {
    title: "Personal — acts as you",
    sub: "Works under your account, with everything you can reach. Stays on this Mac.",
  },
  company: {
    title: "For a company",
    sub: "Has its own identity and only reaches its companies' files. Can move to the cloud later.",
  },
};

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
    scope: "personal",
    companySlugs: [],
    name: suggestBotName(ctx.existingNames),
    handle: "",
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

/** The @handle a cloud bot gets: the person's own, else one made from the name. */
export function botHandle(draft: Pick<CreateBotDraft, "name" | "handle">): string {
  const chosen = draft.handle.trim().replace(/^@/, "");
  return slugifyBotName(chosen || draft.name);
}

/**
 * Validation for a Cloud bot's display name. A cloud bot's name is a label the
 * company sees ("Polar"), not the @handle, so it is not held to the handle's
 * character rules — `handleIssue` covers those.
 */
export function cloudNameIssue(name: string): string | null {
  const n = name.trim();
  if (!n) return "Give your bot a name.";
  if (n.length > 60) return "Keep the name under 60 characters.";
  return null;
}

/** Validation for the @handle a Cloud bot is created under; null when fine. */
export function handleIssue(draft: Pick<CreateBotDraft, "name" | "handle">): string | null {
  const handle = botHandle(draft);
  if (!handle) return "Give your bot a handle — letters and digits.";
  if (!isValidLocalBotName(handle)) {
    return "Lowercase letters, digits, and single hyphens — for example “scout-2”.";
  }
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
 * Only company workers can start a bot from a template; HQ core workers
 * (setup and friends) are never offered.
 */
export function companyTemplates(options: readonly LocalBotWorkerOption[]): LocalBotWorkerOption[] {
  return options.filter((option) => templateCard(option).source === "company");
}

/**
 * Cards grouped by company (companies alphabetically),
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

// ── steps ──────────────────────────────────────────────────────────────────

/**
 * The steps this draft walks. Both homes walk all three: a cloud bot's name
 * and @handle are chosen here, in front of the person, because the company
 * channel's card that used to ask for them is no longer shown.
 */
export function stepsFor(_draft: Pick<CreateBotDraft, "home">): CreateBotStep[] {
  return ["kind", "home", "details"];
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
      return null;
    case "home":
      if (draft.home === "local") {
        if (!ctx.canLocal) return "Bots can’t run on this computer.";
        if (!runtimeIsReady(ctx.runtimeReady, draft.runtime)) {
          const label = LOCAL_BOT_RUNTIMES.find((r) => r.id === draft.runtime)?.label ?? draft.runtime;
          return `${label} is not signed in on this Mac.`;
        }
        return scopeIssue(draft, ctx);
      }
      if (!ctx.canCloud) return "No company can host a bot right now.";
      if (!draft.companyUid || !ctx.companies.some((c) => c.companyUid === draft.companyUid)) {
        return "Pick a company.";
      }
      return null;
    case "details":
      if (draft.home === "cloud") return cloudNameIssue(draft.name) ?? handleIssue(draft);
      return nameIssue(draft.name, ctx.existingNames) ?? introIssue(draft.intro);
  }
}

/** A company bot needs at least one of the owner's companies; personal needs nothing. */
export function scopeIssue(
  draft: Pick<CreateBotDraft, "scope" | "companySlugs">,
  ctx: Pick<CreateBotContext, "ownerCompanies">,
): string | null {
  if (draft.scope !== "company") return null;
  if (ctx.ownerCompanies.length === 0) return "You are not in a company yet — make it personal for now.";
  const known = new Set(ctx.ownerCompanies.map((c) => c.slug));
  if (!draft.companySlugs.some((slug) => known.has(slug))) return "Pick at least one company.";
  return null;
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
  const companies = draft.scope === "company" ? [...new Set(draft.companySlugs.map((c) => c.trim()).filter(Boolean))] : [];
  return {
    name: normalizeBotName(draft.name),
    runtime: draft.runtime,
    autoApprove: draft.autoApprove,
    ...(model ? { model } : {}),
    ...(worker ? { worker } : {}),
    ...(intro ? { intro } : {}),
    ...(draft.memory !== "synced" ? { memory: draft.memory } : {}),
    // Personal is the CLI's default, so it is not passed: a desktop build
    // against an hq that predates `--kind` keeps creating personal/setup bots.
    ...(draft.scope === "company" ? { kind: "company" as const, companies } : {}),
  };
}

/** "acts as you" / "for Indigo and Ridge" for the preview card. */
export function scopeLine(draft: Pick<CreateBotDraft, "home" | "scope" | "companySlugs">, ctx: Pick<CreateBotContext, "ownerCompanies">): string {
  if (draft.home !== "local") return "";
  if (draft.scope !== "company") return "acts as you";
  const labels = draft.companySlugs.map((slug) => ctx.ownerCompanies.find((c) => c.slug === slug)?.label ?? slug);
  if (labels.length === 0) return "for a company";
  if (labels.length === 1) return `for ${labels[0]}`;
  return `for ${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
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
