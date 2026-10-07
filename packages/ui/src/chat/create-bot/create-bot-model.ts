/**
 * Pure state for the New bot flow (bots-v2 step 2).
 *
 * The bot is named first, then the person picks Cloud or Local, then the
 * steps for that home, all on one draft. Everything the steps need to decide
 * "can I advance / can I create" lives here so the Svelte components stay
 * thin and the rules are unit-testable without a DOM.
 *
 * Every AI teammate is a bot. A Local bot picks its coding tool, with a
 * template and the advanced settings (handle, who it is for, permissions,
 * memory) one click away; its title, avatar and model are asked in its first
 * message instead (`newBotKickoff`). A Cloud bot is named, sized and given a
 * brain. The company channel's "Create a bot" card is retired, so this flow
 * is the ONLY place a cloud bot is named. A suggested name is a prefill the
 * person can see and change, never a silent default.
 */

import type {
  AgentProvisionOptionsView,
  LocalBotCreateInput,
  LocalBotKind,
  LocalBotWorkerOption,
} from "@hq/platform";
import { LOCAL_BOT_RUNTIMES, isValidLocalBotName } from "../local-bots.js";
import { runtimeBlocksNext, runtimeStatusOf, runtimeStepIssue, type RuntimeStatus } from "./runtime-status.js";

export type CreateBotStep = "home" | "details";
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
  /** Cloud-only size rung, chosen from the current company quote. */
  size: "basic" | "power" | "dev" | "";
  companyUid?: string;
  /** Local only: personal (acts as you) or company (acts as itself). */
  scope: BotScope;
  /** Local company bots: the company slugs it belongs to (at least one). */
  companySlugs: string[];
  name: string;
  /**
   * Optional job title ("Ad account analyst"), asked on the cloud details
   * step only. The cloud `create_agent` card sequence asks only for name,
   * handle, runtime and size, so the host PATCHes it onto the agent profile
   * once the bot has a uid. A Local bot asks for its title in its first
   * message (`newBotKickoff`).
   */
  title: string;
  /**
   * The @handle the bot is created under. Empty means "follow the name" —
   * the slug of the display name. Both homes use it: a Local bot's handle is
   * its folder name and what the CLI knows it as, so it is derived, shown,
   * and only edited by hand when the derived one collides or is empty.
   */
  handle: string;
  autoApprove: boolean;
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
  /**
   * The state behind that boolean, per runtime. `runtimeReady` cannot tell
   * not-installed from couldn't-check from signed-out, and the wizard has to
   * say which. Absent → fall back to the boolean.
   */
  runtimeStatus?: Record<string, RuntimeStatus> | null;
  /** Handles already taken by the user's local bots. */
  existingNames: readonly string[];
  companies: ReadonlyArray<{ companyUid: string; label: string }>;
  /** The owner's companies a Local company bot can belong to (slugs). */
  ownerCompanies: ReadonlyArray<{ slug: string; label: string }>;
  templates: readonly LocalBotWorkerOption[];
  /** Server-resolved hq-flags value. Claude stays hidden until this is true. */
  claudeProviderEnabled?: boolean;
  /**
   * `agents.desktop-agent-creation` is on for a company in this modal. Cloud
   * bots then default to Claude, with Codex and Grok offered, and Claude needs
   * no second flag.
   */
  directCloudOn?: boolean;
  /** Tenant-specific options from GET /v1/agents/provision-options. */
  cloudProvisionOptions?: AgentProvisionOptionsView | null;
  cloudQuoteStatus?: "loading" | "ready" | "error";
  /**
   * Plain-language name for the host machine ("Mac", "PC", or "computer")
   * from `hostComputerNoun`. Absent means "not ready"; the copy stays neutral.
   */
  hostNoun?: string;
}

/**
 * One-line copy for each bot scope, shown beside the choice. `noun` is
 * "Mac", "PC", or "computer" from `hostComputerNoun`; neutral fallback when
 * the probe is not ready.
 */
export function botScopeCopy(opts: { noun?: string } = {}): Record<BotScope, { title: string; sub: string }> {
  const noun = opts.noun?.trim() || "computer";
  return {
    personal: {
      title: "Personal · acts as you",
      sub: `Works under your account, with everything you can reach. Stays on this ${noun}. It has no company identity, so teammates can’t find it. Make it a company bot to share it.`,
    },
    company: {
      title: "For a company",
      sub: "Has its own identity and only reaches its companies' files. Can move to the cloud later.",
    },
  };
}

/** Display names are a label, not a description. */
export const NAME_MAX = 60;
/** Agent-profile titles are a one-line label, not a description. */
export const TITLE_MAX = 60;

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

export function initialDraft(
  ctx: Pick<CreateBotContext, "canLocal" | "canCloud" | "existingNames" | "companies" | "runtimeReady"> &
    Partial<Pick<CreateBotContext, "ownerCompanies" | "claudeProviderEnabled" | "directCloudOn">>,
  preferredCompanyUid: string | null = null,
  preferredCompanySlug: string | null = null,
  /**
   * Where the person said the bot should run, on the New bot choice screen.
   * Honoured only when that home can be used; otherwise the usual default.
   */
  preferredHome: "local" | "cloud" | null = null,
  /** The name the person already gave on the first New bot step. */
  preferredName: string | null = null,
): CreateBotDraft {
  // Opened from a company's page: start on that company, not the first one.
  const preferred = preferredCompanyUid
    ? ctx.companies.find((c) => c.companyUid === preferredCompanyUid)
    : undefined;
  // QA-043: a Local bot opened from a company starts as that company's bot.
  const ownerSlug = preferredCompanySlug?.trim()
    ? (ctx.ownerCompanies ?? []).find((c) => c.slug === preferredCompanySlug.trim())?.slug
    : undefined;
  const local =
    preferredHome === "cloud" && ctx.canCloud
      ? false
      : preferredHome === "local" && ctx.canLocal
        ? true
        : ctx.canLocal;
  return {
    kind: "blank",
    home: local ? "local" : "cloud",
    runtime: local ? firstReadyRuntime(ctx.runtimeReady) : defaultCloudRuntime(ctx),
    size: "",
    companyUid: preferred?.companyUid ?? ctx.companies[0]?.companyUid,
    scope: ownerSlug ? "company" : "personal",
    companySlugs: ownerSlug ? [ownerSlug] : [],
    name: preferredName?.trim() || suggestBotName(ctx.existingNames),
    title: "",
    handle: "",
    autoApprove: true,
    memory: "synced",
  };
}

/** Claude can run a Cloud bot: the direct-create flag is on, or the Claude provider flag is. */
export function claudeAllowedForCloud(
  ctx: Partial<Pick<CreateBotContext, "claudeProviderEnabled" | "directCloudOn">>,
): boolean {
  return ctx.directCloudOn === true || ctx.claudeProviderEnabled === true;
}

/** The brain a new Cloud bot starts on: Claude when allowed, otherwise Codex. */
export function defaultCloudRuntime(
  ctx: Partial<Pick<CreateBotContext, "claudeProviderEnabled" | "directCloudOn">>,
): "claude" | "codex" {
  return claudeAllowedForCloud(ctx) ? "claude" : "codex";
}

/** The first signed-in runtime in picker order; claude when nothing is known. */
export function firstReadyRuntime(ready: Record<string, boolean> | null | undefined): BotRuntime {
  if (!ready) return "claude";
  return LOCAL_BOT_RUNTIMES.find((r) => ready[r.id] !== false)?.id ?? "claude";
}

/**
 * The brains the full-window New Bot flow offers. Claude is offered only when
 * the host read the Claude provider flag as on: the server refuses a Claude
 * bot for everyone else (403 CLAUDE_PROVIDER_NOT_ENABLED), so a brain that is
 * not offered must never be shown or preselected.
 */
export function cloudBrainChoices(claudeEnabled: boolean): BotRuntime[] {
  return claudeEnabled ? ["codex", "claude", "grok"] : ["codex", "grok"];
}

/**
 * Cloud creation is subscription-only. Prefer the provider already signed in
 * on this Mac, but make Codex the predictable first choice when none are.
 * `offered` narrows the answer to the brains the caller shows: a signed-in
 * brain that is not offered is never the answer.
 */
export function firstSignedInCloudRuntime(
  ready: Record<string, boolean> | null | undefined,
  offered?: readonly BotRuntime[],
): BotRuntime {
  const candidates = offered
    ? LOCAL_BOT_RUNTIMES.filter((runtime) => offered.includes(runtime.id))
    : LOCAL_BOT_RUNTIMES;
  const fallback = !offered || offered.includes("codex") ? "codex" : candidates[0]?.id ?? "codex";
  return candidates.find((runtime) => ready?.[runtime.id] === true)?.id ?? fallback;
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

/**
 * Validation for a bot's DISPLAY name — the free-form label a person types
 * ("Dr Love"). Spaces and capitals are fine here; the handle rules live in
 * `handleIssue`/`localHandleIssue`, which judge the derived slug instead.
 */
export function displayNameIssue(name: string): string | null {
  const n = name.trim();
  if (!n) return "Give your bot a name.";
  if (n.length > NAME_MAX) return `Keep the name under ${NAME_MAX} characters.`;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(name)) {
    return "The name can\u2019t contain control characters.";
  }
  return null;
}

/**
 * Validation for the handle a LOCAL bot is created under: the slug derived
 * from its display name, or the one the person typed into "edit handle".
 * This is the field that must stay unique and CLI-safe, so a collision or an
 * unslugifiable name is reported here rather than against the display name.
 */
export function localHandleIssue(
  draft: Pick<CreateBotDraft, "name" | "handle">,
  existing: readonly string[],
): string | null {
  const handle = botHandle(draft);
  if (!handle) {
    return "That name has no letters or digits. Give the bot a handle, for example \u201cscout-2\u201d.";
  }
  if (!isValidLocalBotName(handle)) {
    return "Handles are lowercase letters, digits, and single hyphens, for example \u201cscout-2\u201d.";
  }
  if (taken(handle, existing)) return `You already have a bot with the handle @${handle}.`;
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
 * character rules; `handleIssue` covers those.
 */
export function cloudNameIssue(name: string): string | null {
  return displayNameIssue(name);
}

/** Validation for the @handle a Cloud bot is created under; null when fine. */
export function handleIssue(draft: Pick<CreateBotDraft, "name" | "handle">): string | null {
  const handle = botHandle(draft);
  if (!handle) return "Give your bot a handle with letters and digits.";
  if (!isValidLocalBotName(handle)) {
    return "Lowercase letters, digits, and single hyphens, for example “scout-2”.";
  }
  return null;
}

/**
 * What the first New bot step says about the name typed there, or null. The
 * name is asked before Cloud or Local, so it must suit both: a label the
 * person can read, with letters or digits a handle can be made from.
 */
export function newBotNameIssue(name: string): string | null {
  return displayNameIssue(name) ?? (handleIssue({ name, handle: "" }) ? NEW_BOT_NAME_UNUSABLE : null);
}

/** Same words as the cloud create's refusal of such a name. */
export const NEW_BOT_NAME_UNUSABLE = "That name can't be used for a bot. Try letters and numbers.";

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

// ── title ──────────────────────────────────────────────────────────────────

/** Validation for the optional job title; null when it is fine. */
export function titleIssue(title: string): string | null {
  if (title.trim().length > TITLE_MAX) return `Keep the title under ${TITLE_MAX} characters.`;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(title)) {
    return "The title can’t contain control characters.";
  }
  return null;
}

// ── kickoff ────────────────────────────────────────────────────────────────

/**
 * The first task a new Local bot runs by itself right after its hello
 * (`hq bot create --kickoff`, at most 2000 characters, one line). The create
 * screens no longer ask for a title, an avatar or a model: the bot asks for
 * them in its first message, so setup goes on in the conversation. A bot
 * made from a template already has a role, so it only checks that role.
 */
export function newBotKickoff(opts: { template?: boolean } = {}): string {
  const role = opts.template
    ? "whether the role your template gives you fits, or what I would change"
    : "what your role is, as a short job title like \"Ad account analyst\"";
  return (
    "Kickoff: you were just created in HQ. If you already said hello, do not greet again. " +
    "Finish your setup with me in one short message that asks three things as a numbered list: " +
    `1) ${role}, ` +
    "2) what avatar or look I want for you, " +
    "3) whether I have a model preference, or the default is fine. " +
    "End the message with that question and nothing else. " +
    "When I answer, keep my answers in your notes and use them from then on, " +
    "and tell me in one line anything I need to set myself in HQ."
  );
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

/** `{product}`-style scaffold placeholders a worker.yaml never filled in. */
const PLACEHOLDER = /\{[A-Za-z_][\w-]*\}/g;

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * The company slug a template belongs to. `hq bot workers` passes through
 * whatever worker.yaml says, which can be a stringified object
 * ("[object Object]") or an unfilled "{product}"; the worker's folder
 * (`companies/<slug>/workers/...`) is the reliable answer then.
 */
export function templateCompany(option: LocalBotWorkerOption): string | null {
  const declared = cleanText(option.company);
  if (declared && !declared.includes("[object") && !declared.includes("{")) return declared;
  const fromPath = /^companies\/([^/]+)\//.exec(cleanText(option.path))?.[1] ?? null;
  return fromPath && !fromPath.includes("{") ? fromPath : null;
}

/** Fill `{product}` placeholders with the company name, or drop them. */
function fillPlaceholders(text: string, company: string | null): string {
  if (!text.includes("{")) return text;
  const label = company ? companyLabelFor(company) : "";
  return text
    .replace(PLACEHOLDER, label)
    .replace(/\s*-\s*$/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function templateSummary(option: LocalBotWorkerOption): string {
  const text = cleanText(option.summary) || firstSentence(cleanText(option.description));
  return fillPlaceholders(text, templateCompany(option));
}

export function templateName(option: LocalBotWorkerOption): string {
  const explicit = fillPlaceholders(cleanText(option.name), templateCompany(option));
  if (explicit) return explicit;
  return option.id
    .replace(PLACEHOLDER, "")
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
}

export function templateCard(option: LocalBotWorkerOption): TemplateCard {
  const company = templateCompany(option);
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
  const byCompany = new Map<string | null, Map<string, TemplateCard>>();
  for (const option of options) {
    const card = templateCard(option);
    if (!matchesTemplate(card, q)) continue;
    // Dedupe by id per group. `group.templates` is rendered as a keyed
    // Svelte each block below (`(card.id)`), and a repeated key throws
    // `svelte.dev/e/each_key_duplicate` and blanks the wizard to the error
    // boundary. A backend that ships two workers with the same id (or two
    // entries after a re-add) must not be able to crash the UI: keep the
    // first-seen entry, drop the rest.
    const bucket = byCompany.get(card.company) ?? new Map<string, TemplateCard>();
    if (!bucket.has(card.id)) bucket.set(card.id, card);
    byCompany.set(card.company, bucket);
  }
  const keys = [...byCompany.keys()].sort((a, b) => {
    if (a === null) return -1;
    if (b === null) return 1;
    return a.localeCompare(b);
  });
  return keys.map((company) => ({
    company,
    label: companyLabelFor(company),
    templates: [...(byCompany.get(company)?.values() ?? [])].sort((a, b) =>
      a.name.localeCompare(b.name),
    ),
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
 * The steps this draft walks after the name and the Cloud or Local question,
 * one question per screen. A local bot picks its coding tool (a template and
 * the advanced settings sit on that screen, folded away). A cloud bot picks
 * its company first when there is a choice (the price is that company's),
 * then is named and sized on one screen.
 */
export function stepsFor(draft: Pick<CreateBotDraft, "home">, opts: StepOptions = {}): CreateBotStep[] {
  if (draft.home === "local") return LOCAL_STEPS;
  return opts.pickCompany ? ["home", "details"] : ["details"];
}

/**
 * `pickCompany`: a cloud bot gets a "Pick the company" step. Off when there is
 * one company and it is already selected.
 */
export interface StepOptions {
  pickCompany?: boolean;
}

/** Local steps after the name and the Cloud or Local question. */
export const LOCAL_STEPS: CreateBotStep[] = ["home"];

export interface StepTitle {
  kicker: string;
  lead: string;
  em: string;
  tail?: string;
  copy: string;
}

/**
 * Each step's heading: a plain lead and the word that matters set apart
 * ("Enter a <name.>"). The copy names "this computer"; the flow swaps in
 * the host's own noun.
 */
export const LOCAL_STEP_TITLES: Record<"home", StepTitle> = {
  home: { kicker: "How it thinks", lead: "Pick the", em: "coding tool.", copy: "Your bot thinks with a coding tool signed in on this computer." },
};

/** The first New bot step, the same on every path. */
export const NAME_STEP_TITLE: StepTitle = {
  kicker: "A new teammate",
  lead: "Enter a",
  em: "name.",
  copy: "This is how your new teammate will appear in HQ.",
};

export const CLOUD_STEP_TITLES: Record<"home" | "details", StepTitle> = {
  home: { kicker: "Where it lives", lead: "Pick the", em: "company.", copy: "The bot runs in that company's cloud and is billed to its plan." },
  details: { kicker: "A new teammate", lead: "Enter a", em: "name.", copy: "It runs in your company's cloud and stays on when this computer is asleep." },
};

/** Headings for the step on screen. */
export function stepTitle(step: CreateBotStep, home: CreateBotDraft["home"]): StepTitle {
  if (home === "cloud") return CLOUD_STEP_TITLES[step];
  return step === "home" ? LOCAL_STEP_TITLES.home : NAME_STEP_TITLE;
}

export function nextStep(step: CreateBotStep, draft: Pick<CreateBotDraft, "home">, opts: StepOptions = {}): CreateBotStep | null {
  const steps = stepsFor(draft, opts);
  const at = steps.indexOf(step);
  return at >= 0 ? (steps[at + 1] ?? null) : null;
}

export function prevStep(step: CreateBotStep, draft: Pick<CreateBotDraft, "home">, opts: StepOptions = {}): CreateBotStep | null {
  const steps = stepsFor(draft, opts);
  const at = steps.indexOf(step);
  return at > 0 ? (steps[at - 1] ?? null) : null;
}

/** Why this step cannot advance yet; null when it can. */
export function stepIssue(step: CreateBotStep, draft: CreateBotDraft, ctx: CreateBotContext, opts: StepOptions = {}): string | null {
  switch (step) {
    case "home":
      if (draft.home === "local") {
        const host = ctx.hostNoun?.trim() || "computer";
        if (!ctx.canLocal) return `Bots can’t run on this ${host}.`;
        // The name, template and advanced settings are all answered by the
        // time this, the only local step, is on screen, so they are checked
        // here too: Create bot never runs with one of them unusable.
        const settingsIssue = localSettingsIssue(draft, ctx);
        if (settingsIssue) return settingsIssue;
        {
          const label = LOCAL_BOT_RUNTIMES.find((r) => r.id === draft.runtime)?.label ?? draft.runtime;
          const status = runtimeStatusOf(ctx.runtimeStatus, draft.runtime);
          // The status is the authority when the host has one: it names WHICH
          // problem, so the person is not told to sign in to a CLI that is not
          // installed. The boolean is the fallback for hosts without it.
          if (status) return runtimeBlocksNext(status) ? runtimeStepIssue(status, label, host) : null;
          if (!runtimeIsReady(ctx.runtimeReady, draft.runtime)) {
            return `${label} is not signed in on this ${host}.`;
          }
        }
        return null;
      }
      if (!ctx.canCloud) return "No company can host a bot right now.";
      if (!draft.companyUid || !ctx.companies.some((c) => c.companyUid === draft.companyUid)) {
        return "Pick a company.";
      }
      return null;
    case "details":
      if (draft.home === "cloud") {
        const fieldsIssue =
          cloudNameIssue(draft.name) ?? handleIssue(draft) ?? titleIssue(draft.title);
        if (fieldsIssue) return fieldsIssue;
        if (draft.runtime === "claude" && !claudeAllowedForCloud(ctx)) {
          return "Claude isn’t available for this account.";
        }
        if (ctx.cloudQuoteStatus !== "ready" || !ctx.cloudProvisionOptions) {
          return ctx.cloudQuoteStatus === "error"
            ? "Couldn’t load company pricing. Try again."
            : "Checking company pricing…";
        }
        const quotedSize = ctx.cloudProvisionOptions.options.find(
          (option) => option.key === draft.size,
        );
        if (!quotedSize?.selectable || quotedSize.netMonthlyCents === null) {
          return "Choose an available size.";
        }
        return null;
      }
      return localSettingsIssue(draft, ctx);
  }
}

/**
 * What stops a Local draft's name, handle, template or "who is it for?" from
 * being used, or null. The coding tool is judged separately.
 */
export function localSettingsIssue(
  draft: CreateBotDraft,
  ctx: Pick<CreateBotContext, "existingNames" | "ownerCompanies">,
): string | null {
  return (
    displayNameIssue(draft.name) ??
    localHandleIssue(draft, ctx.existingNames) ??
    (draft.kind === "template" && !draft.templateId ? "Pick a template." : null) ??
    scopeIssue(draft, ctx)
  );
}

/** A company bot needs at least one of the owner's companies; personal needs nothing. */
export function scopeIssue(
  draft: Pick<CreateBotDraft, "scope" | "companySlugs">,
  ctx: Pick<CreateBotContext, "ownerCompanies">,
): string | null {
  if (draft.scope !== "company") return null;
  if (ctx.ownerCompanies.length === 0) return "You are not in a company yet. Make it personal for now.";
  const known = new Set(ctx.ownerCompanies.map((c) => c.slug));
  if (!draft.companySlugs.some((slug) => known.has(slug))) return "Pick at least one company.";
  return null;
}

export function canAdvance(step: CreateBotStep, draft: CreateBotDraft, ctx: CreateBotContext, opts: StepOptions = {}): boolean {
  if (nextStep(step, draft, opts) === null) return false;
  return stepIssue(step, draft, ctx, opts) === null;
}

/** Every step the draft walks is valid → Cmd-Enter may create from anywhere. */
export function canCreate(draft: CreateBotDraft, ctx: CreateBotContext, opts: StepOptions = {}): boolean {
  return stepsFor(draft, opts).every((step) => stepIssue(step, draft, ctx, opts) === null);
}

/** The first step that still needs the user; null when the draft is complete. */
export function firstBlockingStep(draft: CreateBotDraft, ctx: CreateBotContext, opts: StepOptions = {}): CreateBotStep | null {
  return stepsFor(draft, opts).find((step) => stepIssue(step, draft, ctx, opts) !== null) ?? null;
}

/**
 * The CLI input for a Local draft (Cloud drafts never reach the CLI). It
 * carries a kickoff, so the bot's first message asks for the title, avatar
 * and model the create screens no longer ask for.
 */
export function toCreateInput(draft: CreateBotDraft): LocalBotCreateInput {
  const worker = draft.kind === "template" ? (draft.templateId ?? "").trim() : "";
  const companies = draft.scope === "company" ? [...new Set(draft.companySlugs.map((c) => c.trim()).filter(Boolean))] : [];
  return {
    name: botHandle(draft),
    runtime: draft.runtime,
    autoApprove: draft.autoApprove,
    ...(worker ? { worker } : {}),
    kickoff: newBotKickoff({ template: !!worker }),
    ...(draft.memory !== "synced" ? { memory: draft.memory } : {}),
    // Personal is the CLI's default, so it is not passed: a desktop build
    // against an hq that predates `--kind` keeps creating personal/setup bots.
    ...(draft.scope === "company" ? { kind: "company" as const, companies } : {}),
  };
}

/**
 * The display name to store for this draft, or "" when there is nothing to
 * store. A name that is already its own slug ("scout") needs no display name:
 * the handle is the label, and bots made before display names existed read
 * the same way.
 */
export function botDisplayName(draft: Pick<CreateBotDraft, "name" | "handle">): string {
  const display = draft.name.trim();
  if (!display || display === botHandle(draft)) return "";
  return display;
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
  return `thinks with ${runtime}`;
}


// ── Why the New Bot flow cannot price a company ────────────────────────────

/**
 * Why the company's bot options could not be loaded. "permission": the
 * server says this person may not add bots there. "load": the read failed
 * for any other reason, and asking again may work. "unpriced": the options
 * came back, and not one of them has a price this company could be charged,
 * so there is nothing Create bot could ask for.
 */
export interface ProvisionOptionsProblem {
  kind: "permission" | "load" | "unpriced";
  /** People who can add a bot or allow it, as the server named them. At most three. */
  askNames: string[];
}

/** The server's code for a member without the capability to add bots. */
export const CREATE_AGENTS_NOT_ALLOWED_CODE = "CREATE_AGENTS_NOT_ALLOWED";

/**
 * Read a failed provision-options answer. The shape is loose on purpose:
 * hosts differ in what they keep of the server's refusal (`code`, `status`,
 * `admins`), and a thrown read arrives as null. Never throws.
 */
export function provisionOptionsProblem(result: unknown): ProvisionOptionsProblem {
  const answer = typeof result === "object" && result !== null ? (result as Record<string, unknown>) : null;
  const code = typeof answer?.code === "string" ? answer.code.trim() : "";
  const message = typeof answer?.message === "string" ? answer.message : "";
  const refused =
    code === CREATE_AGENTS_NOT_ALLOWED_CODE ||
    code === "http-403" ||
    answer?.status === 403 ||
    /\bforbidden\b|createAgents capability/i.test(message);
  if (!refused) return { kind: "load", askNames: [] };
  const askNames: string[] = [];
  for (const entry of Array.isArray(answer?.admins) ? answer.admins : []) {
    const row = typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : null;
    const name = typeof row?.displayName === "string" ? row.displayName.trim() : "";
    // The server falls back to the person's id when it has no name for them.
    if (!name || /^prs_/i.test(name) || askNames.includes(name)) continue;
    askNames.push(name);
    if (askNames.length >= 3) break;
  }
  return { kind: "permission", askNames };
}

/** "Corey", "Corey or Dana", "Corey, Dana or Lee". */
function oneOf(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
}

/** The one line the New Bot screen shows when Create bot is off for this reason. */
export function provisionOptionsProblemLine(problem: ProvisionOptionsProblem, companyLabel: string): string {
  const company = companyLabel.trim() || "this company";
  if (problem.kind === "permission") {
    const ask = problem.askNames.length ? oneOf(problem.askNames) : "an owner or admin";
    return `You don't have permission to add bots in ${company}. Ask ${ask}.`;
  }
  if (problem.kind === "unpriced") {
    return `We don't have a price for a bot in ${company} right now. Try again in a moment.`;
  }
  return `We couldn't load the price for ${company}. Check your connection and try again.`;
}

/**
 * True when a bot can be created from these options: at least one size the
 * person may pick has a price.
 */
export function provisionOptionsPriced(options: { options?: ReadonlyArray<{ selectable?: boolean; netMonthlyCents?: number | null }> } | null | undefined): boolean {
  return (options?.options ?? []).some(
    (option) => option.selectable === true && typeof option.netMonthlyCents === "number",
  );
}

/**
 * Shown when the company selected on the New Bot screen is no longer one of
 * the companies the screen offers. Create bot is off: nothing is sent to it.
 */
export const NEW_BOT_COMPANY_GONE_REASON =
  "This company can't be used for a new bot right now. Close this screen and try again.";

/** What the New Bot screen's second way out is called when it leads only to a local bot. */
export const NEW_BOT_LOCAL_LABEL = "Create a local bot instead";

/**
 * The label of the New Bot screen's second way out, the button that opens
 * the "+" window's own bot step. That step makes local bots, and cloud bots
 * in the companies this screen does not offer, so the label says which of
 * the two a person can reach through it. Empty when it leads nowhere.
 */
export function newBotOtherWayLabel(input: { local: boolean; otherCompanies: boolean }): string {
  if (input.local && input.otherCompanies) return "Another company or a local bot";
  if (input.otherCompanies) return "Create in another company";
  return input.local ? NEW_BOT_LOCAL_LABEL : "";
}

/** The line on the last step that says where the bot will be made. */
export function newBotTargetLine(name: string, companyLabel: string): string {
  return `${name.trim() || "This bot"} will be created in ${companyLabel.trim()}.`;
}

/** What the New Bot screen says while the host looks for a bot whose create got no answer. */
export function newBotCheckingLine(name: string): string {
  return `Checking whether ${name.trim() || "your bot"} was created...`;
}
