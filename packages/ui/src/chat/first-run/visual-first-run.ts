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
 * This module is pure: steps, copy, the name rule, the handoff kickoff, the
 * "never again" marker, the routing decision and the one-create-at-a-time
 * starter. `DesktopApp.svelte` hosts the takeover on top of it.
 */

import type { LocalBotRow } from "@hq/platform";

import { LOCAL_BOT_RUNTIMES } from "../local-bots.js";
import { SETUP_BOT_KICKOFF_PREFIX, SETUP_BOT_RUNTIME_ORDER, type SetupBotRef } from "../setup-bot.js";

export type FirstRunRuntime = LocalBotRow["runtime"];

/** Every screen of the flow. */
export type FirstRunStepId = "name" | "team" | "tools" | "context" | "notes" | "projects" | "done";

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
    if (step.id === "notes" || step.id === "projects") return apps;
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
 * "Finish with defaults" sits beside "Next" on every step whose next step is
 * not the last one. Next to the last step both buttons would do the same
 * thing, so the step shows only Next.
 */
export function firstRunOffersFinish(id: FirstRunStepId, steps: readonly FirstRunStep[] = FIRST_RUN_STEPS): boolean {
  const next = nextFirstRunStep(id, steps);
  return next !== null && nextFirstRunStep(next, steps) !== null;
}

/** True when at least one coding tool is signed in on this computer. */
export function anyToolReady(ready: Record<string, boolean> | null | undefined): boolean {
  return SETUP_BOT_RUNTIME_ORDER.some((runtime) => ready?.[runtime] === true);
}

/**
 * Where "Finish with defaults" lands: Done, unless a required step is still
 * open. The coding tools step is required only while no tool is ready.
 */
export function firstRunFinishTarget(
  ready: Record<string, boolean> | null | undefined,
  steps: readonly FirstRunStep[] = FIRST_RUN_STEPS,
): FirstRunStepId {
  if (!anyToolReady(ready) && indexOfStep("tools", steps) >= 0) return "tools";
  return steps[steps.length - 1]?.id ?? "done";
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
  /** The header's way out, on every screen. */
  continueInChat: "Continue in chat",
  finish: "Finish with defaults",
  /** Shown on the name step once the assistant is being created. */
  nameLocked: "This name is taken into setup now. You can rename your assistant later from its profile.",
  opening: "Opening…",
  retry: "Retry",
  retrying: "Retrying…",
} as const;

export function firstRunTalkLabel(name: string): string {
  return `Talk to ${name.trim() || "your assistant"}`;
}

export function runtimeLabel(runtime: FirstRunRuntime): string {
  return LOCAL_BOT_RUNTIMES.find((r) => r.id === runtime)?.label ?? runtime;
}

// ── name ────────────────────────────────────────────────────────────────────

/** `hq bot create --display-name` limit (Slack's display-name bound). */
export const ASSISTANT_NAME_MAX = 35;

/**
 * The name as the host keeps it (`validate_display_name`): runs of
 * whitespace, tabs included, become one space, ends trimmed. Every place the
 * name goes (the create, the kickoff, the hello, the handoff note) uses this.
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

/** The two app screens. A key is present once its screen was passed; null there means skipped. */
export interface FirstRunAppsHandoff {
  notes?: FirstRunAppHandoff | null;
  projects?: FirstRunAppHandoff | null;
}

/** What the takeover settled, handed to the setup bot so it never asks again. */
export interface FirstRunHandoff {
  /** The assistant's display name, as the person confirmed it. */
  name: string;
  /** The coding tool the assistant runs on. */
  runtime: FirstRunRuntime;
  /** Every coding tool signed in when the assistant was created. */
  toolsReady: readonly FirstRunRuntime[];
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

/** The apps part of the handoff JSON: each passed screen, its app or "skipped". */
export function firstRunAppsJson(apps: FirstRunAppsHandoff): Record<string, Record<string, string> | "skipped"> {
  const out: Record<string, Record<string, string> | "skipped"> = {};
  if ("notes" in apps) out.notes = appJson(apps.notes) ?? "skipped";
  if ("projects" in apps) out.projects = appJson(apps.projects) ?? "skipped";
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

/** The machine-readable part of the kickoff: one JSON object, one line. */
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

/** The words the kickoff and the notices add about the team and the apps, when settled. */
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
    out += "The note taker and project management choices are in the handoff: do not ask about them again. ";
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

/** The words the kickoff and the notices add about the import, when it ran. */
function importSentence(imported: FirstRunImportHandoff | null | undefined): string {
  if (!imported) return "";
  const report = typeof firstRunImportJson(imported).report === "string";
  return report
    ? "The context import is finished (counts and report path are in the handoff): do not ask me to import it again. "
    : "The context import is finished (counts are in the handoff): do not ask me to import it again. ";
}

/** Under the CLI's `--kickoff` bound (2000) with room to spare. */
export const FIRST_RUN_KICKOFF_MAX = 1900;

/**
 * The setup bot's first task (`hq bot create --kickoff`) when it was named in
 * the takeover. Same contract as `setupBotKickoff`: starts with the prefix
 * the setup template recognises, one line, no control characters, under 2000
 * characters. It says which steps are done (the JSON handoff and the same in
 * words) so the bot skips them, and otherwise follows the usual opening.
 */
export function firstRunKickoff(handoff: FirstRunHandoff, opts: { noun?: string } = {}): string {
  return firstRunKickoffCarry(handoff, opts).kickoff;
}

/** A kickoff and what it carried, so the host can send the rest as a note. */
export interface FirstRunKickoffCarry {
  kickoff: string;
  /** The team and app screens rode in the kickoff. */
  settled: boolean;
  /** The import rode in the kickoff with its report path (when it had one). */
  importWhole: boolean;
}

/**
 * The kickoff, kept under `FIRST_RUN_KICKOFF_MAX`. What does not fit is left
 * for a bot-only note, never lost: first the team and app choices (the host
 * sends them with `firstRunSettledNotice`), and only if it still does not
 * fit, the report path (the host then sends `firstRunImportNotice`, which
 * always keeps it). The counts and the settled-step words always stay.
 */
export function firstRunKickoffCarry(handoff: FirstRunHandoff, opts: { noun?: string } = {}): FirstRunKickoffCarry {
  const hasSettled = !!(handoff.team || (handoff.apps && Object.keys(handoff.apps).length));
  const hasReport = !!(handoff.imported && handoffReportPath(handoff.imported.report));
  const full = buildKickoff(handoff, opts);
  if (full.length <= FIRST_RUN_KICKOFF_MAX) return { kickoff: full, settled: hasSettled, importWhole: true };
  const lean: FirstRunHandoff = { ...handoff, team: null, apps: null };
  const withoutSettled = buildKickoff(lean, opts);
  if (withoutSettled.length <= FIRST_RUN_KICKOFF_MAX || !hasReport) {
    return { kickoff: withoutSettled, settled: false, importWhole: true };
  }
  return {
    kickoff: buildKickoff({ ...lean, imported: { ...handoff.imported!, report: null } }, opts),
    settled: false,
    importWhole: false,
  };
}

function buildKickoff(handoff: FirstRunHandoff, opts: { noun?: string }): string {
  const noun = opts.noun?.trim() || "computer";
  const name = normalizeAssistantName(handoff.name);
  const tool = runtimeLabel(handoff.runtime);
  const kickoff =
    `${SETUP_BOT_KICKOFF_PREFIX} setup started in the HQ desktop app's visual setup, where I already finished some steps, ` +
    "and your hello already went out, so do not greet again or repeat the plan. " +
    `Handoff from the app: ${firstRunHandoffNote(handoff)}. ` +
    "Every step in \"done\" is settled: never ask about it again and record it as done in your setup-progress.md note. " +
    `${proseName(name, "I chose your name, ", ", so keep it. ", "I chose your name (\"name\" in the handoff), so keep it. ")}` +
    `The coding tool sign-in is finished: ${tool} is signed in on this ${noun} and you run on it, so do not ask me to pick or sign in to a coding tool. ` +
    importSentence(handoff.imported) +
    settledSentence(handoff) +
    "First work out where this HQ stands, quietly: read your setup-progress.md note if there is one, " +
    "check whether I am signed in to HQ Cloud and as whom, whether this HQ has a company, and whether any other tool HQ leans on is missing, and fix what you can yourself. " +
    "I chose to jump straight in, so do not ask whether I want HQ explained first. " +
    "Tell me in one line what you found or fixed, then begin the first unfinished step that is not in \"done\", " +
    "ending each message with exactly one concrete question or one concrete action for me. " +
    "If setup is already finished, say so in one line and offer two or three concrete next moves drawn from this HQ, then ask which to start. " +
    "Never end with an open question like \"what would you like to do?\"";
  // eslint-disable-next-line no-control-regex
  return kickoff.replace(/[\u0000-\u001f\u007f]/g, " ");
}

/**
 * The same handoff for a setup bot that already existed (a reinstall, or a
 * second computer): its kickoff ran long ago, so the app sends this as a
 * bot-only message in its DM instead. Not a kickoff (no prefix): the bot
 * carries on from where it is, minus the settled steps. One line, no control
 * characters, under 2000 characters.
 */
export function firstRunHandoffNotice(handoff: FirstRunHandoff, opts: { noun?: string } = {}): string {
  const noun = opts.noun?.trim() || "computer";
  const name = normalizeAssistantName(handoff.name);
  const tools = [...new Set(handoff.toolsReady)].map(runtimeLabel).join(", ") || runtimeLabel(handoff.runtime);
  const notice =
    "Setup note from the HQ desktop app: I just went through the app's visual setup, which finished some setup steps for you. " +
    `Handoff from the app: ${firstRunHandoffNote(handoff)}. ` +
    "Every step in \"done\" is settled: never ask about it again and record it as done in your setup-progress.md note. " +
    `${proseName(name, "I named you ", ", so use that name. ", "I named you (\"name\" in the handoff), so use that name. ")}` +
    `The coding tool sign-in is finished: signed in on this ${noun}: ${tools}. Do not ask me to pick or sign in to a coding tool. ` +
    importSentence(handoff.imported) +
    settledSentence(handoff) +
    "Do not greet me again. When I next write, carry on from the first unfinished step that is not in \"done\".";
  // eslint-disable-next-line no-control-regex
  return notice.replace(/[\u0000-\u001f\u007f]/g, " ");
}

/**
 * The import result for an assistant whose kickoff already went out before
 * the scan finished: a bot-only note in its DM. One line, no control
 * characters, under 2000 characters. Only counts and the report path, never
 * what the report says.
 */
export function firstRunImportNotice(imported: FirstRunImportHandoff): string {
  const note = JSON.stringify({
    from: "desktop-visual-first-run",
    v: 1,
    done: [FIRST_RUN_IMPORT_STEP],
    import: firstRunImportJson(imported),
  });
  const notice =
    "Setup note from the HQ desktop app: I just finished the context import in the app's visual setup. " +
    `Handoff from the app: ${note}. ` +
    "Every step in \"done\" is settled: never ask about it again and record it as done in your setup-progress.md note. " +
    importSentence(imported) +
    "Do not greet me again. When I next write, carry on from the first unfinished step that is not in \"done\".";
  // eslint-disable-next-line no-control-regex
  return notice.replace(/[\u0000-\u001f\u007f]/g, " ");
}

/** The parts of the later screens that are delivered to the bot one by one. */
export type FirstRunSettledPart = "team" | "notes" | "projects";
/** What the bot already has of each part: the part's JSON when it was sent. */
export type FirstRunSettledSent = Partial<Record<FirstRunSettledPart, string>>;

/** Each settled part's JSON, for the parts present. */
export function firstRunSettledParts(settled: Pick<FirstRunHandoff, "team" | "apps">): FirstRunSettledSent {
  const out: FirstRunSettledSent = {};
  const team = settled.team ? firstRunTeamJson(settled.team) : null;
  if (team) out.team = JSON.stringify(team);
  const apps = settled.apps ? firstRunAppsJson(settled.apps) : {};
  if (apps.notes !== undefined) out.notes = JSON.stringify(apps.notes);
  if (apps.projects !== undefined) out.projects = JSON.stringify(apps.projects);
  return out;
}

/**
 * The parts the bot does not have yet (or has with another value): what a
 * settled notice still needs to carry after the kickoff or an earlier note.
 */
export function firstRunSettledSince(
  settled: Pick<FirstRunHandoff, "team" | "apps">,
  sent: FirstRunSettledSent,
): Pick<FirstRunHandoff, "team" | "apps"> {
  const now = firstRunSettledParts(settled);
  const apps: FirstRunAppsHandoff = {};
  if (now.notes !== undefined && now.notes !== sent.notes) apps.notes = settled.apps?.notes ?? null;
  if (now.projects !== undefined && now.projects !== sent.projects) apps.projects = settled.apps?.projects ?? null;
  return {
    team: now.team !== undefined && now.team !== sent.team ? (settled.team ?? null) : null,
    apps,
  };
}

/**
 * What the later screens settled ("Your team", Note taker, Project
 * management, and the import when it is not delivered yet), for an
 * assistant whose kickoff already went out: a bot-only note in its DM. One
 * line, no control characters, under 2000 characters. Null when nothing is
 * left to say.
 */
export function firstRunSettledNotice(
  settled: Pick<FirstRunHandoff, "imported" | "team" | "apps">,
): string | null {
  const team = settled.team ? firstRunTeamJson(settled.team) : null;
  const apps = settled.apps ? firstRunAppsJson(settled.apps) : null;
  const done = firstRunDoneSteps(settled).filter((step) => !(FIRST_RUN_SETTLED_STEPS as readonly string[]).includes(step));
  if (!done.length) return null;
  const note = JSON.stringify({
    from: "desktop-visual-first-run",
    v: 1,
    done,
    ...(settled.imported ? { import: firstRunImportJson(settled.imported) } : {}),
    ...(team ? { team } : {}),
    ...(apps && Object.keys(apps).length ? { apps } : {}),
  });
  const notice =
    "Setup note from the HQ desktop app: I just finished more of the app's visual setup. " +
    `Handoff from the app: ${note}. ` +
    "Every step in \"done\" is settled: never ask about it again and record it as done in your setup-progress.md note. " +
    importSentence(settled.imported) +
    settledSentence(settled) +
    "Do not greet me again. When I next write, carry on from the first unfinished step that is not in \"done\".";
  // eslint-disable-next-line no-control-regex
  return notice.replace(/[\u0000-\u001f\u007f]/g, " ");
}

/**
 * The bot's hello (`hq bot create --intro`, under 500 characters, one line)
 * when it was named in the takeover: it already knows its name and tool.
 */
export function firstRunIntro(handoff: Pick<FirstRunHandoff, "name" | "runtime">, opts: { noun?: string } = {}): string {
  const noun = opts.noun?.trim() || "computer";
  const name = normalizeAssistantName(handoff.name) || "your HQ assistant";
  return (
    `Hi, I'm ${name}, your HQ assistant. You've named me and signed in ${runtimeLabel(handoff.runtime)}, so I won't ask about those again. ` +
    `I'm checking your ${noun} now, which can take a minute, and I'll post my next question here as soon as I'm done.`
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
}

export function firstRunRoute(input: FirstRunRouteInput): FirstRunRoute {
  if (!input.hasBots || input.welcomeSetupRun || input.finished) return "legacy";
  if (input.flag === null) return "pending";
  if (!input.flag) return "legacy";
  if (input.welcomeSetupOwed === null) return "pending";
  return input.welcomeSetupOwed ? "visual" : "legacy";
}

// ── creating the assistant ─────────────────────────────────────────────────

export type FirstRunAssistantResult = { ok: true; bot: SetupBotRef } | { ok: false; reason: string };

/** Where creating the assistant stands, as the takeover shows it. */
export type FirstRunCreation =
  | { state: "idle" }
  | { state: "creating"; name: string }
  | { state: "ready"; name: string; bot: SetupBotRef }
  | { state: "failed"; name: string; reason: string };

export interface FirstRunAssistantStarter {
  /**
   * Start creating the assistant under this name. A call while one is in
   * flight, or after one succeeded, does nothing: a double click or a second
   * Enter never creates a second bot. After a failure it runs again (Retry).
   */
  start(name: string): void;
  /** Run again with the last name, after a failure. */
  retry(): void;
  current(): FirstRunCreation;
}

/**
 * The single-flight creator behind the takeover. `run` creates (or adopts)
 * the setup bot; `onchange` gets every state, starting with "creating"
 * synchronously so the pending state shows on the same frame as the click.
 */
export function createFirstRunAssistantStarter(
  run: (name: string) => Promise<FirstRunAssistantResult>,
  onchange: (state: FirstRunCreation) => void,
): FirstRunAssistantStarter {
  let state: FirstRunCreation = { state: "idle" };
  let lastName = "";
  const set = (next: FirstRunCreation): void => {
    state = next;
    onchange(next);
  };
  function start(name: string): void {
    if (state.state === "creating" || state.state === "ready") return;
    const trimmed = name.trim();
    if (!trimmed) return;
    lastName = trimmed;
    set({ state: "creating", name: trimmed });
    void Promise.resolve()
      .then(() => run(trimmed))
      .then(
        (result) =>
          set(result.ok ? { state: "ready", name: trimmed, bot: result.bot } : { state: "failed", name: trimmed, reason: result.reason }),
        (err: unknown) => {
          console.warn("[hq-desktop] first-run assistant create threw:", err);
          set({ state: "failed", name: trimmed, reason: "Could not start your assistant. Please try again." });
        },
      );
  }
  return {
    start,
    retry() {
      if (state.state === "failed" && lastName) start(lastName);
    },
    current: () => state,
  };
}
