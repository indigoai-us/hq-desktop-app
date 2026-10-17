/**
 * Visual first-run setup (owner plan, 2026-10-08), slice 1.
 *
 * With `desktop.visual-first-run` on, a first run opens the New bot
 * step-through takeover instead of auto-starting the setup bot's chat. The
 * first bot IS the setup bot (it still runs the `setup` worker), named by the
 * person. The setup chat stays the fallback ("Continue in chat") and the
 * place the rest of setup happens.
 *
 * The plan has seven screens: 1 Name your HQ assistant, 2 Your team,
 * 3 Your coding tools, 4 Bring in your context, 5 Note taker, 6 Project
 * management, 7 Done. Slice 1 shipped 1, 3 and 7; slice 4 added 4 (the
 * knowledge tree, knowledge-tree/); slices 2 and 5 add 2, 5 and 6
 * (team-step.ts, app-step.ts). The step list below is data: the progress
 * bars, "Next: <step>" labels and Back follow it, and `firstRunStepsFor`
 * leaves out the screens a host cannot run.
 *
 * This module is pure: steps, copy, the name rule, the handoff note, the
 * "never again" marker, the routing decision and the one-create-at-a-time
 * starter. `DesktopApp.svelte` hosts the takeover on top of it.
 */

import type { LocalBotRow } from "@hq/platform";

import { LOCAL_BOT_RUNTIMES } from "../local-bots.js";
import { FIRST_RUN_HANDOFF_MARKER, FIRST_RUN_NOTE_LEAD } from "../agent-channel.js";
import { SETUP_BOT_RUNTIME_ORDER, type SetupBotRef } from "../setup-bot.js";
import type { FlagLateOutcome } from "./first-run-timing.js";

export type FirstRunRuntime = LocalBotRow["runtime"];

/** Every screen of the flow. */
export type FirstRunStepId = "name" | "team" | "tools" | "context" | "notes" | "projects" | "apps" | "done";

export interface FirstRunStep {
  id: FirstRunStepId;
  /** The step's name in "Next: <label>". */
  label: string;
}

/** The screens of the flow, in order. The last one is always Done. */
export const FIRST_RUN_STEPS: readonly FirstRunStep[] = [
  { id: "name", label: "Name your assistant" },
  { id: "team", label: "Your team" },
  { id: "tools", label: "Your coding tools" },
  { id: "context", label: "Bring in your context" },
  { id: "notes", label: "Note taker" },
  { id: "projects", label: "Project management" },
  { id: "done", label: "Done" },
];

/**
 * The flow with "Your apps" (integration auto-detect MVP, flag
 * `desktop.first-run-found-apps-v1`): one step listing every app found on
 * this computer replaces Note taker and Project management, so the first run
 * has one step fewer. Owner decision dec-20261012015131-z0g0.
 */
export const FIRST_RUN_STEPS_YOUR_APPS: readonly FirstRunStep[] = FIRST_RUN_STEPS.flatMap((step) =>
  step.id === "notes" ? [{ id: "apps" as const, label: "Your apps" }] : step.id === "projects" ? [] : [step],
);

/** What the host can run, which decides the screens shown. */
export interface FirstRunHostCaps {
  /** The context scan on this computer (the desktop app). */
  canImport: boolean;
  /** Reading the person's companies and invites, joining and creating one. */
  canTeam?: boolean;
  /** Reading the integrations catalog and connecting an app. */
  canConnectApps?: boolean;
  /**
   * The person works alone ("Just me"): no company to connect apps to, so
   * the Note taker and Project management screens are left out.
   */
  personal?: boolean;
}

/**
 * The steps a host can show. A screen the host cannot run is left out
 * rather than shown broken: "Bring in your context" needs the scan, "Your
 * team" the company reads, and the two app screens the integrations
 * catalog and a company to connect to.
 */
export function firstRunStepsFor(
  host: FirstRunHostCaps,
  steps: readonly FirstRunStep[] = FIRST_RUN_STEPS,
): readonly FirstRunStep[] {
  const apps = host.canConnectApps === true && host.personal !== true;
  return steps.filter((step) => {
    if (step.id === "context") return host.canImport;
    if (step.id === "team") return host.canTeam === true;
    if (step.id === "notes" || step.id === "projects" || step.id === "apps") return apps;
    return true;
  });
}

function indexOfStep(id: FirstRunStepId, steps: readonly FirstRunStep[]): number {
  return steps.findIndex((step) => step.id === id);
}

/** 1-based place of a step in the progress bars; 0 when it is not shown. */
export function firstRunStepNumber(id: FirstRunStepId, steps: readonly FirstRunStep[] = FIRST_RUN_STEPS): number {
  return indexOfStep(id, steps) + 1;
}

export function nextFirstRunStep(
  id: FirstRunStepId,
  steps: readonly FirstRunStep[] = FIRST_RUN_STEPS,
): FirstRunStepId | null {
  const at = indexOfStep(id, steps);
  return at >= 0 && at + 1 < steps.length ? steps[at + 1]!.id : null;
}

export function prevFirstRunStep(
  id: FirstRunStepId,
  steps: readonly FirstRunStep[] = FIRST_RUN_STEPS,
): FirstRunStepId | null {
  const at = indexOfStep(id, steps);
  return at > 0 ? steps[at - 1]!.id : null;
}

/** "Next: Your coding tools", or "" on the last step. */
export function firstRunNextLabel(id: FirstRunStepId, steps: readonly FirstRunStep[] = FIRST_RUN_STEPS): string {
  const next = nextFirstRunStep(id, steps);
  const label = next ? steps.find((step) => step.id === next)?.label : null;
  return label ? `Next: ${label}` : "";
}

/**
 * True on the steps that come before "Bring in your context" in this flow.
 * The import is the payoff of first run (owner, 2026-10-10): no control on
 * these steps may jump past it. False everywhere when the host has no
 * import step.
 */
export function firstRunBeforeImport(id: FirstRunStepId, steps: readonly FirstRunStep[] = FIRST_RUN_STEPS): boolean {
  const context = indexOfStep("context", steps);
  const at = indexOfStep(id, steps);
  return context >= 0 && at >= 0 && at < context;
}

/**
 * "Finish with defaults" sits beside "Next" on every step from the import
 * on whose next step is not the last one. Before the import only Next moves
 * forward, so nobody finishes past it. Next to the last step both buttons
 * would do the same thing, so the step shows only Next.
 */
export function firstRunOffersFinish(id: FirstRunStepId, steps: readonly FirstRunStep[] = FIRST_RUN_STEPS): boolean {
  if (firstRunBeforeImport(id, steps)) return false;
  const next = nextFirstRunStep(id, steps);
  return next !== null && nextFirstRunStep(next, steps) !== null;
}

/** True when at least one coding tool is signed in on this computer. */
export function anyToolReady(ready: Record<string, boolean> | null | undefined): boolean {
  return SETUP_BOT_RUNTIME_ORDER.some((runtime) => ready?.[runtime] === true);
}

/**
 * Where "Finish with defaults" pressed on `from` lands: Done, unless a
 * required step is still open. The coding tools step is required only while
 * no tool is ready, and from a step before "Bring in your context" the
 * import comes first, so a finish never lands past it.
 */
export function firstRunFinishTarget(
  ready: Record<string, boolean> | null | undefined,
  steps: readonly FirstRunStep[] = FIRST_RUN_STEPS,
  from: FirstRunStepId = steps[0]?.id ?? "name",
): FirstRunStepId {
  if (!anyToolReady(ready) && indexOfStep("tools", steps) >= 0) return "tools";
  if (firstRunBeforeImport(from, steps)) return "context";
  return steps[steps.length - 1]?.id ?? "done";
}

/**
 * Whether a step shows "Continue in chat" (the header's way out, and the
 * same link beside a failed team join or a failed create). Leaving for chat
 * ends the takeover, so before the import it would skip the import. It shows
 * after the import step. On the import step itself the scene's own buttons
 * are the way on (Bring it in, or the quiet Skip for now), so it shows only
 * when the scene could not load (`importLoadFailed`) and would otherwise
 * leave the person with no way out.
 *
 * Never on the coding tools step, in any state and on any host (owner,
 * 2026-10-10): the assistant runs on a signed-in coding tool, so that screen
 * helps the person sign in (FirstRunToolsSignIn) instead of offering a way
 * around it. `ready` stays in the signature for the callers.
 */
export function firstRunOffersChat(
  id: FirstRunStepId,
  ready: Record<string, boolean> | null | undefined,
  steps: readonly FirstRunStep[] = FIRST_RUN_STEPS,
  opts: { importLoadFailed?: boolean } = {},
): boolean {
  void ready;
  if (id === "tools") return false;
  if (id === "context" && indexOfStep("context", steps) >= 0) return opts.importLoadFailed === true;
  return !firstRunBeforeImport(id, steps);
}

/** Whether a step lets the person move on. */
export function firstRunCanLeave(
  id: FirstRunStepId,
  ready: Record<string, boolean> | null | undefined,
): boolean {
  return id === "tools" ? anyToolReady(ready) : true;
}

/** Dashes the copy never uses (owner rule: plain copy without em or en dashes). */
export const FIRST_RUN_BANNED_DASHES = [String.fromCharCode(0x2014), String.fromCharCode(0x2013)] as const;

// ── copy ────────────────────────────────────────────────────────────────────

export interface FirstRunTitle {
  kicker: string;
  lead: string;
  em: string;
  copy: string;
}

export const FIRST_RUN_NAME_TITLE: FirstRunTitle = {
  kicker: "Welcome to HQ",
  lead: "Name your HQ",
  em: "assistant.",
  copy: "Your assistant finishes setting up HQ with you and stays to help afterwards. Keep this name or pick your own.",
};

/** `{name}` is the assistant's name; `noun` is "Mac", "PC" or "computer". */
export function firstRunToolsTitle(name: string, noun = "computer"): FirstRunTitle {
  const shown = name.trim() || "Your assistant";
  return {
    kicker: "Your coding tools",
    lead: "Connect a",
    em: "coding tool.",
    copy: `${shown} thinks with a coding tool signed in on this ${noun}, under your own login. One is enough.`,
  };
}

export function firstRunDoneTitle(name: string): FirstRunTitle {
  const shown = name.trim() || "your assistant";
  return {
    kicker: "All set",
    lead: "Meet",
    em: `${shown}.`,
    copy: `${shown} picks up the rest of setup in chat, starting after the steps you just finished.`,
  };
}

export const FIRST_RUN_COPY = {
  /** The header's way out, after the import step (see firstRunOffersChat). */
  continueInChat: "Continue in chat",
  finish: "Finish with defaults",
  /** Shown on the name step once the assistant is being created. */
  nameLocked: "This name is taken into setup now. You can rename your assistant later from its profile.",
  opening: "Opening…",
  retry: "Retry",
  retrying: "Retrying…",
} as const;

/** The tool button while HQ is installed into that tool. The tool stays closed. */
export function firstRunOpeningLabel(toolName: string): string {
  return toolName.trim() ? `Setting up ${toolName.trim()}…` : "Setting up…";
}

export function firstRunTalkLabel(name: string): string {
  return `Talk to ${name.trim() || "your assistant"}`;
}

export function runtimeLabel(runtime: FirstRunRuntime): string {
  return LOCAL_BOT_RUNTIMES.find((r) => r.id === runtime)?.label ?? runtime;
}

// ── decision (US-007) ───────────────────────────────────────────────────────

/**
 * The first run after the blocking install: the knowledge tree fills in, then
 * one question, continue in the coding tool used most or name the bot. The
 * old company, Bring it in, Coding tools and name steps are gone from it.
 */
export const FIRST_RUN_FLOW = ["decision", "done"] as const;
export type FirstRunFlowScreen = (typeof FIRST_RUN_FLOW)[number];

/** One coding tool's session counts, as the local scan reports them. */
export interface FirstRunToolUsage {
  tool: string;
  sessions_total: number;
  sessions_last_30d: number;
  last_active_at: number | null;
}

/** The scan's tool ids, mapped to the bot runtimes they run as. */
const SCAN_TOOL_RUNTIME: Readonly<Record<string, FirstRunRuntime>> = {
  "claude-code": "claude",
  codex: "codex",
};

/**
 * The coding tool this person uses most on this computer, from the local
 * scan alone (no sign-in probe, no model turn). Most sessions in the last 30
 * days wins, then most sessions overall, then the newest session, then the
 * setup order. A tool with no sessions at all does not count.
 */
export function mostUsedTool(tools: readonly FirstRunToolUsage[] | null | undefined): FirstRunRuntime | null {
  const ranked = (tools ?? [])
    .map((usage) => ({ usage, runtime: SCAN_TOOL_RUNTIME[usage.tool] }))
    .filter((row): row is { usage: FirstRunToolUsage; runtime: FirstRunRuntime } =>
      row.runtime !== undefined && row.usage.sessions_total > 0,
    )
    .sort(
      (a, b) =>
        b.usage.sessions_last_30d - a.usage.sessions_last_30d ||
        b.usage.sessions_total - a.usage.sessions_total ||
        (b.usage.last_active_at ?? 0) - (a.usage.last_active_at ?? 0) ||
        SETUP_BOT_RUNTIME_ORDER.indexOf(a.runtime) - SETUP_BOT_RUNTIME_ORDER.indexOf(b.runtime),
    );
  return ranked[0]?.runtime ?? null;
}

/**
 * The tool the decision offers to continue in: the most used one, else the
 * first installed tool in setup order (installed, read from the tools
 * without a model turn), else null and the person sees only the bot path.
 */
/** How many sessions the scan counted for a tool, or null when it did not count it. */
export function toolSessionCount(tools: readonly FirstRunToolUsage[] | null | undefined, runtime: FirstRunRuntime): number | null {
  const usage = (tools ?? []).find((row) => SCAN_TOOL_RUNTIME[row.tool] === runtime);
  return usage && usage.sessions_total > 0 ? usage.sessions_total : null;
}

export function decisionToolFor(
  tools: readonly FirstRunToolUsage[] | null | undefined,
  installed: Record<string, boolean> | null | undefined,
): FirstRunRuntime | null {
  return mostUsedTool(tools) ?? SETUP_BOT_RUNTIME_ORDER.find((runtime) => installed?.[runtime] === true) ?? null;
}

/** The decision's copy. `{tool}` is a coding tool's label. */
export const FIRST_RUN_DECISION_COPY = {
  kicker: "Your context",
  toolQuestion: "Where do you want to keep working?",
  // The reason for the recommendation (Jacob, HQ Dev Standup 2026-10-15; owner
  // agreed): the person sees why this tool is offered, with the scan's count
  // when it has one, and the assistant stays the equal other path.
  toolLead: (tool: string, noun = "Mac", sessions: number | null = null) =>
    sessions !== null && sessions > 0
      ? `We noticed you use ${tool} the most on this ${noun}, ${sessions === 1 ? "1 session" : `${sessions} sessions`} so far. Want to keep working there?`
      : `We noticed ${tool} on this ${noun}. Want to keep working there?`,
  toolPrimary: (tool: string) => `Continue in ${tool}`,
  // The HQ Anywhere callout above Continue (owner, 2026-10-17). Enable is not
  // preselected. Continue installs only after Enable.
  anywhereTitle: "Enable HQ Anywhere",
  anywhereBody: (tool: string) =>
    `Use HQ in every project, not only in your HQ folder. ${tool} gets HQ's instructions, skills and tools wherever you open it. You can change this later in Settings.`,
  anywhereEnable: "Enable",
  anywhereNotNow: "Not now",
  anywhereOn: "HQ Anywhere is on. Continue sets it up.",
  anywhereUndo: "Undo",
  anywhereOff: "HQ Anywhere is off. Turn it on later in Settings.",
  // Two equal paths (owner, 2026-10-15): the tool and naming the assistant.
  toolOther: "Name Your Assistant",
  botQuestion: "Name your assistant.",
  botLead: "Your assistant works alongside you in HQ and starts out knowing what it found here.",
  botPrimary: "Continue",
  backToTool: (tool: string) => `Continue in ${tool} instead`,
  scanning: "Looking through this Mac first.",
} as const;

// ── name ────────────────────────────────────────────────────────────────────

/** `hq bot create --display-name` limit (Slack's display-name bound). */
export const ASSISTANT_NAME_MAX = 35;

/**
 * The name as the host keeps it (`validate_display_name`): runs of
 * whitespace, tabs included, become one space, ends trimmed. Every place the
 * name goes (the create, the hello, the handoff note) uses this.
 */
export function normalizeAssistantName(name: string): string {
  return name.split(/\s+/).filter(Boolean).join(" ");
}

/**
 * Why a name cannot be the assistant's display name, or null. The same rule
 * as the host's `validate_display_name` (apps/sync bots.rs): a letter first,
 * then letters, numbers, spaces, apostrophes, periods and hyphens, at most 35.
 */
export function assistantNameIssue(name: string): string | null {
  const collapsed = normalizeAssistantName(name);
  if (!collapsed) return "Give your assistant a name.";
  if ([...collapsed].length > ASSISTANT_NAME_MAX) return `Keep the name under ${ASSISTANT_NAME_MAX} characters.`;
  if (!/^\p{L}[\p{L}\p{N} .'-]*$/u.test(collapsed)) return "Use letters, numbers, spaces, apostrophes, periods and hyphens.";
  return null;
}

// ── handoff ─────────────────────────────────────────────────────────────────

/**
 * What "Bring in your context" found: the scan's summary counts and the path
 * of the report it wrote on this computer. Never the report's contents.
 */
export interface FirstRunImportHandoff {
  summary: Readonly<Record<string, number>>;
  report: string | null;
}

/**
 * "Your team": the company the person works in, or alone. `how` says
 * whether they joined it from an invite, started it here, or already
 * belonged to it. Only the display name and slug go to the bot.
 */
export type FirstRunTeamHandoff =
  | { kind: "personal" }
  | { kind: "company"; how: "joined" | "created" | "existing"; name: string; slug: string | null };

/** An app connected on Note taker or Project management, or the screen skipped (null). */
export interface FirstRunAppHandoff {
  name: string;
  domain: string;
}

/**
 * The two app screens. A key is present once its screen was passed; null there
 * means skipped. "Your apps" fills both (its first note taker and project
 * tool, or skipped) and lists every other connected app in `others`.
 */
export interface FirstRunAppsHandoff {
  notes?: FirstRunAppHandoff | null;
  projects?: FirstRunAppHandoff | null;
  others?: FirstRunAppHandoff[];
}

/** At most this many other apps go in the handoff. */
export const FIRST_RUN_OTHER_APPS_MAX = 12;

/** What the takeover settled, handed to the setup bot so it never asks again. */
export interface FirstRunHandoff {
  /** The assistant's display name, as the person confirmed it. */
  name: string;
  /** The coding tool the assistant runs on. */
  runtime: FirstRunRuntime;
  /** Every coding tool signed in when the assistant was created. */
  toolsReady: readonly FirstRunRuntime[];
  /**
   * False when the real sign-in check (`hq bot probe`) did not pass for
   * `runtime` (it could not tell): the hello and the handoff note then do not say
   * the tool is signed in. Missing means it passed.
   */
  signInChecked?: boolean;
  /** The context scan, when it finished before this was written. */
  imported?: FirstRunImportHandoff | null;
  /** "Your team", once settled. */
  team?: FirstRunTeamHandoff | null;
  /** Note taker and Project management, once passed. */
  apps?: FirstRunAppsHandoff | null;
}

/** Setup steps the takeover finished. Later slices add theirs. */
export const FIRST_RUN_SETTLED_STEPS = ["name", "codingTools"] as const;
/** Marked done once the context scan finished. */
export const FIRST_RUN_IMPORT_STEP = "import";
/** Marked done once "Your team" is settled (the setup worker's company question). */
export const FIRST_RUN_TEAM_STEP = "company";
/** Marked done once the Note taker screen was passed (connected or skipped). */
export const FIRST_RUN_NOTES_STEP = "noteTaker";
/** Marked done once the Project management screen was passed (connected or skipped). */
export const FIRST_RUN_PROJECTS_STEP = "projectManagement";

const TEAM_NAME_MAX = 60;
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const APP_NAME_MAX = 40;
const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** A display name as the bot may see it: one line, no path-like or control text, capped. */
function handoffLabel(value: string, max: number): string | null {
  const flat = value.split(/\s+/).filter(Boolean).join(" ");
  if (!flat || hasControlChars(flat)) return null;
  if (/[\\/]/.test(flat) || flat.startsWith("~")) return null;
  return [...flat].slice(0, max).join("");
}

/** The team part of the handoff JSON, or null when nothing clean is left. */
export function firstRunTeamJson(team: FirstRunTeamHandoff): Record<string, string> | null {
  if (team.kind === "personal") return { kind: "personal" };
  const name = handoffLabel(team.name, TEAM_NAME_MAX);
  if (!name) return null;
  const slug = team.slug && SLUG.test(team.slug) ? team.slug : null;
  return { kind: "company", how: team.how, name, ...(slug ? { slug } : {}) };
}

function appJson(app: FirstRunAppHandoff | null | undefined): Record<string, string> | null {
  if (!app) return null;
  const name = handoffLabel(app.name, APP_NAME_MAX);
  const domain = app.domain.trim().toLowerCase();
  if (!name || domain.length > 80 || !DOMAIN.test(domain)) return null;
  return { name, domain };
}

/**
 * The apps part of the handoff JSON: each passed screen, its app or
 * "skipped", and the other apps "Your apps" connected (clean ones only,
 * capped).
 */
export function firstRunAppsJson(
  apps: FirstRunAppsHandoff,
): Record<string, Record<string, string> | "skipped" | Record<string, string>[]> {
  const out: Record<string, Record<string, string> | "skipped" | Record<string, string>[]> = {};
  if ("notes" in apps) out.notes = appJson(apps.notes) ?? "skipped";
  if ("projects" in apps) out.projects = appJson(apps.projects) ?? "skipped";
  const others = (apps.others ?? [])
    .map((app) => appJson(app))
    .filter((app): app is Record<string, string> => app !== null)
    .slice(0, FIRST_RUN_OTHER_APPS_MAX);
  if (others.length) out.others = others;
  return out;
}

/** The settled step keys for a handoff, in the flow's order. */
export function firstRunDoneSteps(handoff: Pick<FirstRunHandoff, "imported" | "team" | "apps">): string[] {
  const done: string[] = [...FIRST_RUN_SETTLED_STEPS];
  if (handoff.team && firstRunTeamJson(handoff.team)) done.push(FIRST_RUN_TEAM_STEP);
  if (handoff.imported) done.push(FIRST_RUN_IMPORT_STEP);
  if (handoff.apps && "notes" in handoff.apps) done.push(FIRST_RUN_NOTES_STEP);
  if (handoff.apps && "projects" in handoff.apps) done.push(FIRST_RUN_PROJECTS_STEP);
  return done;
}

/** Report paths longer than this are left out of the handoff (the counts still go). */
export const FIRST_RUN_REPORT_PATH_MAX = 240;
const COUNT_KEY = /^[a-z][a-z0-9_-]*$/;
const MAX_HANDOFF_COUNTS = 6;

function hasControlChars(text: string): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * The report path as the setup bot may see it: relative to the HQ folder
 * (the desktop host strips the HQ folder from the scan's absolute path).
 * Anything absolute (it would name the person's home folder), home-relative,
 * or climbing out with `..` is left out.
 */
export function handoffReportPath(report: string | null | undefined): string | null {
  if (!report || report.length > FIRST_RUN_REPORT_PATH_MAX || hasControlChars(report)) return null;
  if (/^[/\\~]/.test(report) || /^[A-Za-z]:/.test(report)) return null;
  if (report.split(/[/\\]/).some((part) => part === "..")) return null;
  return report;
}

/**
 * The import part of the handoff JSON: whole, non-negative counts under
 * plain keys (at most 6) and the HQ-relative report path, nothing else.
 */
export function firstRunImportJson(imported: FirstRunImportHandoff): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  let n = 0;
  for (const [key, value] of Object.entries(imported.summary)) {
    if (n >= MAX_HANDOFF_COUNTS) break;
    if (key.length > 32 || !COUNT_KEY.test(key) || key === "report") continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) continue;
    out[key] = Math.floor(value);
    n += 1;
  }
  const report = handoffReportPath(imported.report);
  if (report) out.report = report;
  return out;
}

/** The machine-readable part of the handoff note: one JSON object, one line. */
export function firstRunHandoffNote(handoff: FirstRunHandoff): string {
  const team = handoff.team ? firstRunTeamJson(handoff.team) : null;
  const apps = handoff.apps ? firstRunAppsJson(handoff.apps) : null;
  return JSON.stringify({
    from: "desktop-visual-first-run",
    v: 1,
    done: firstRunDoneSteps(handoff),
    name: normalizeAssistantName(handoff.name),
    runtime: handoff.runtime,
    toolsReady: [...new Set(handoff.toolsReady)],
    ...(handoff.imported ? { import: firstRunImportJson(handoff.imported) } : {}),
    ...(team ? { team } : {}),
    ...(apps && Object.keys(apps).length ? { apps } : {}),
  });
}

/** The words the handoff note adds about the team and the apps, when settled. */
function settledSentence(handoff: Pick<FirstRunHandoff, "team" | "apps">): string {
  let out = "";
  const team = handoff.team ? firstRunTeamJson(handoff.team) : null;
  if (team) {
    out +=
      team.kind === "personal"
        ? "I chose to work alone for now, so the company question is settled: do not ask me to join or start a company. "
        : // The company's name stays inside the JSON: an inviter chose it, so
          // it is data for the bot, never words it reads as an instruction.
          `The company question is settled (${team.how === "created" ? "I started a company" : team.how === "joined" ? "I joined a company" : "I work in a company"}, named in "team" in the handoff): do not ask it again. `;
  }
  const apps = handoff.apps ? firstRunAppsJson(handoff.apps) : null;
  if (apps && Object.keys(apps).length) {
    out += "others" in apps
      ? "The note taker, project management and other app choices are in the handoff: do not ask about them again. "
      : "The note taker and project management choices are in the handoff: do not ask about them again. ";
  }
  return out;
}

/**
 * The assistant's name in prose only when it passes the display-name rule
 * (a letter, then letters, numbers, spaces, apostrophes, periods, hyphens);
 * anything else is named by its place in the JSON.
 */
function proseName(name: string, before: string, after: string, otherwise: string): string {
  return name && !assistantNameIssue(name) ? `${before}${name}${after}` : otherwise;
}

/** The words the handoff note adds about the import, when it ran. */
function importSentence(imported: FirstRunImportHandoff | null | undefined): string {
  if (!imported) return "";
  const report = typeof firstRunImportJson(imported).report === "string";
  return report
    ? "The context import is finished (counts and report path are in the handoff): do not offer it, ask me about it or scan this computer again. "
    : "The context import is finished (counts are in the handoff): do not offer it, ask me about it or scan this computer again. ";
}

/**
 * The longest handoff note. It goes as a bot-only DM, not through
 * `hq bot create --kickoff` (2000), so it shares the bound of the app's other
 * DMs to a bot (`AGENT_HELLO_REQUEST_MAX_CHARS`, 4000), with room to spare.
 */
export const FIRST_RUN_HANDOFF_NOTICE_MAX = 3000;

/**
 * Everything the takeover settled, for the setup assistant, in ONE bot-only
 * DM sent when the takeover closes (Done or Continue in chat). This is how
 * the assistant's setup conversation starts after the visual first run: the
 * app creates the assistant without a kickoff while the takeover is open, so
 * no model turn runs (and nothing is said to the person) until every screen
 * is settled. The same note goes to an assistant that already existed (a
 * reinstall or a second computer).
 *
 * One line, no control characters, under `FIRST_RUN_HANDOFF_NOTICE_MAX`.
 * Opens with `FIRST_RUN_NOTE_LEAD`, so the person's view hides it.
 */
export function firstRunHandoffNotice(handoff: FirstRunHandoff, opts: { noun?: string } = {}): string {
  const noun = opts.noun?.trim() || "computer";
  const name = normalizeAssistantName(handoff.name);
  const tool = runtimeLabel(handoff.runtime);
  const notice =
    `${FIRST_RUN_NOTE_LEAD} I just finished the app's visual setup, and this note is where setup with you starts. ` +
    `${FIRST_RUN_HANDOFF_MARKER} ${firstRunHandoffNote(handoff)}. ` +
    "Every step in \"done\" is settled: never ask about it, offer it or redo it, and record it as done in your setup-progress.md note. " +
    `${proseName(name, "I named you ", ", so use that name. ", "I named you (\"name\" in the handoff), so use that name. ")}` +
    (handoff.signInChecked === false
      ? `I picked ${tool} on this ${noun} and you run on it, so do not ask me to pick a coding tool. HQ could not confirm its sign-in, so if a turn fails to sign in, say so in one line. `
      : `The coding tool sign-in is finished: ${tool} is signed in on this ${noun} and you run on it, so do not ask me to pick or sign in to a coding tool. `) +
    importSentence(handoff.imported) +
    settledSentence(handoff) +
    "Your hello already went out, so do not greet me again, do not repeat the plan, and do not ask whether I want HQ explained first. " +
    "First work out where this HQ stands, quietly: read your setup-progress.md note if there is one, " +
    "check whether I am signed in to HQ Cloud and as whom, whether this HQ has a company, and whether any other tool HQ leans on is missing, and fix what you can yourself. " +
    "Tell me in one line what you found or fixed, then begin the first unfinished step that is not in \"done\", " +
    "ending with exactly one concrete question or one concrete action for me. " +
    "If setup is already finished, say so in one line and offer two or three concrete next moves drawn from this HQ, then ask which to start. " +
    "Never end with an open question like \"what would you like to do?\"";
  // eslint-disable-next-line no-control-regex
  return notice.replace(/[\u0000-\u001f\u007f]/g, " ");
}

/**
 * True when the hello and the note may say `runtime` is signed in: Claude Code
 * and Codex only after the real check passed (a missing check is not a pass, it
 * was signed out on a cold computer); other runtimes are not checked here.
 */
export function signInPassedOrUnchecked(runtime: string, checks: Readonly<Record<string, unknown>>): boolean {
  if (runtime !== "claude" && runtime !== "codex") return true;
  return checks[runtime] === "passed";
}

/**
 * The bot's hello (`hq bot create --intro`, under 500 characters, one line)
 * when it was named in the takeover: it already knows its name and tool. It
 * promises nothing before the takeover closes: the assistant runs no turn
 * until the app hands it everything the takeover settled.
 */
export function firstRunIntro(
  handoff: Pick<FirstRunHandoff, "name" | "runtime" | "signInChecked">,
  opts: { noun?: string; autoNamed?: boolean } = {},
): string {
  const name = normalizeAssistantName(handoff.name) || "your HQ assistant";
  const tool = runtimeLabel(handoff.runtime);
  // Only a passing real check may say "signed in": a stored login can be dead.
  // Signed out says nothing about the tool: the repair card asks for the sign-in.
  // The hello says only what is true (owner, PR 1647): an assistant named for
  // the person on "Continue in <tool>" was not named by them, so it claims
  // neither the name nor the sign-in (no new words for that path).
  const settled = opts.autoNamed
    ? ""
    : handoff.signInChecked === false
      ? "You've named me, so I won't ask about that again. "
      : `You've named me and signed in ${tool}, so I won't ask about those again. `;
  return (
    `Hi, I'm ${name}, your HQ assistant. ${settled}` +
    "As soon as you finish setting up in the app, I'll pick up from there and post my next question here."
  );
}

// ── never again ────────────────────────────────────────────────────────────

/**
 * Set when the person leaves the takeover through Done ("Talk to <Name>") or
 * "Continue in chat". From then on the takeover never opens again on this
 * computer, whatever the flag says.
 */
export const VISUAL_FIRST_RUN_DONE_KEY = "hq.setup.visual-first-run.done.v1";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function firstRunStorage(storage?: StorageLike | null): StorageLike | null {
  if (storage) return storage;
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function hasFinishedVisualFirstRun(storage?: StorageLike | null): boolean {
  try {
    return firstRunStorage(storage)?.getItem(VISUAL_FIRST_RUN_DONE_KEY) === "1";
  } catch {
    return false;
  }
}

export function markVisualFirstRunFinished(storage?: StorageLike | null): void {
  try {
    firstRunStorage(storage)?.setItem(VISUAL_FIRST_RUN_DONE_KEY, "1");
  } catch {
    // Storage unavailable: the in-session close still holds.
  }
}

/** Drop a finished marker an earlier install left (see finishedMarkerLeftOver). */
export function forgetVisualFirstRunFinished(storage?: StorageLike | null): void {
  try {
    (firstRunStorage(storage) as Partial<Pick<Storage, "removeItem">> | null)?.removeItem?.(VISUAL_FIRST_RUN_DONE_KEY);
  } catch {
    // Storage unavailable: the in-session reset still holds.
  }
}

/**
 * Was the finished marker left by an earlier install? The window's storage
 * outlives a reinstall that wipes ~/.hq and the HQ folder, so the marker can
 * be there on a computer that is starting over. Finishing the takeover leaves
 * the assistant on this computer, so a marker on a computer that still owes
 * setup (the host's answer) and lists no bots of its own is a leftover.
 * null until both answers are in. A listing that failed (localBots null once
 * read) keeps the marker.
 */
export function finishedMarkerLeftOver(input: {
  welcomeSetupOwed: boolean | null;
  localBotsRead: boolean;
  localBots: number | null;
}): boolean | null {
  if (input.welcomeSetupOwed === false) return false;
  if (!input.localBotsRead) return null;
  if (input.localBots === null || input.localBots > 0) return false;
  if (input.welcomeSetupOwed === null) return null;
  return true;
}

// ── routing ─────────────────────────────────────────────────────────────────

/**
 * Which first run this launch gets:
 *   "legacy"  today's path (the setup bot starts by itself in its chat), and
 *             every launch that is not a first run;
 *   "visual"  the takeover;
 *   "pending" the flag or the host's "setup owed" answer is not in yet, so
 *             nothing auto-starts until it is.
 * Flag off is "legacy" the moment the flag answers.
 */
export type FirstRunRoute = "legacy" | "visual" | "pending";

/**
 * How long the flag may still answer after the host's "setup owed" answer is
 * in. Both are read from mount, so with the flag off a first run waits at
 * most this much longer than it did before the flag existed, and not at all
 * when the flag answers first.
 */
export const VISUAL_FIRST_RUN_FLAG_GRACE_MS = 1000;

/**
 * The same wait when the host says setup is owed (a new install). A cold
 * start reads the flag right after sign-in, and that read can take well over
 * a second (2.8 s on a cold VM); counting it as off sends a new install to
 * the old setup. In line with the other first-run waits.
 */
export const VISUAL_FIRST_RUN_FLAG_OWED_WAIT_MS = 5_000;

/**
 * The longest the takeover waits for the bot listings (this computer's and
 * the account's) before its name step opens anyway. Within it, an account
 * that already has an assistant is offered that assistant's name; after it,
 * a slow listing means a friendly free name, as for a new account.
 */
export const FIRST_RUN_LISTINGS_WAIT_MS = 5_000;

/**
 * How long after its wait ran out a flag answer may still open the takeover.
 * By then the old setup has been on screen for this long, so a later answer
 * leaves it there.
 */
export const VISUAL_FIRST_RUN_FLAG_LATE_WINDOW_MS = 5_000;

/**
 * What a flag answer that lands after its wait ran out does (the flag counted
 * as off, the route went legacy). Null when it is "off" or setup is not owed:
 * nothing to say. Otherwise "too-late" when it came more than the late window
 * after the timeout, "legacy-started" when the person had already started on
 * the old setup (a setup run, a bot, the tour, an install or sign-in, another
 * row, a sent message), and "applied" when the takeover opens after all.
 */
export function lateFlagVerdict(input: {
  value: boolean;
  welcomeSetupOwed: boolean | null;
  legacyStarted: boolean;
  sinceTimeoutMs: number;
}): FlagLateOutcome | null {
  if (!input.value || input.welcomeSetupOwed !== true) return null;
  if (input.sinceTimeoutMs > VISUAL_FIRST_RUN_FLAG_LATE_WINDOW_MS) return "too-late";
  if (input.legacyStarted) return "legacy-started";
  return "applied";
}

export interface FirstRunRouteInput {
  /** The host can run local bots (desktop app). */
  hasBots: boolean;
  /** Setup was already run from #welcome on this computer. */
  welcomeSetupRun: boolean;
  /** The host says this computer still owes setup; null until it answers. */
  welcomeSetupOwed: boolean | null;
  /** `desktop.visual-first-run`; null until it answers. */
  flag: boolean | null;
  /** The takeover was finished or left for chat on this computer. */
  finished: boolean;
  /** A finished marker from before this launch is still being checked (finishedMarkerLeftOver). */
  finishedUnconfirmed?: boolean;
}

export function firstRunRoute(input: FirstRunRouteInput): FirstRunRoute {
  if (input.hasBots && input.finishedUnconfirmed) return "pending";
  if (!input.hasBots || input.welcomeSetupRun || input.finished) return "legacy";
  if (input.flag === null) return "pending";
  if (!input.flag) return "legacy";
  if (input.welcomeSetupOwed === null) return "pending";
  return input.welcomeSetupOwed ? "visual" : "legacy";
}

// ── creating the assistant ─────────────────────────────────────────────────

/**
 * Where creating the assistant stands, as the takeover shows it. The host
 * works it out from the assistant's owner and the bot list
 * (chat/assistant-owner.ts); nothing here stores it.
 */
export type FirstRunCreation =
  | { state: "idle" }
  | { state: "creating"; name: string }
  | { state: "ready"; name: string; bot: SetupBotRef }
  | { state: "failed"; name: string; reason: string };

