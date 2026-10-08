/**
 * Bot and user profile panes, the live bot session, and the edit-bot sheet
 * (console-rail US-019).
 *
 * Pure data. The panes paint from the snapshot the shell already holds
 * (the roster row) and refresh later. Nothing here runs at boot.
 *
 * Edit tabs are the new-agent stepper steps except Verify: the sheet reuses
 * that step list instead of inventing a second information architecture.
 */

import { STEP_COPY, type AgentStep } from "../../agents/agent-stepper-model.js";

/** Storyboard pane width. Matches the Atlas inspector. */
export const PROFILE_PANE_WIDTH = 340;

/** Transcript rows past this count are windowed. */
export const TRANSCRIPT_VIRTUALIZE_THRESHOLD = 200;

export const TRANSCRIPT_ROW_HEIGHT = 36;
export const TRANSCRIPT_OVERSCAN = 8;

/**
 * Scroll budget for the profile body and the session transcript. Rows are
 * text and chips; no images are decoded while scrolling.
 */
export const metadata = {
  performanceBudget: {
    scrollDroppedFramesPct: 0.01,
    worstFrameMs: 33,
  },
};

/** Stepper steps as tabs, in the edit-sheet order (Verify stays on create). */
export const EDIT_BOT_TABS = [
  "identity",
  "membership",
  "access",
  "capabilities",
  "runtime",
] as const satisfies readonly Exclude<AgentStep, "verify">[];

export type EditBotTab = (typeof EDIT_BOT_TABS)[number];

export function editBotTabLabel(tab: EditBotTab): string {
  return STEP_COPY[tab].title;
}

export type ProfilePhase = "ready" | "shimmer";

/** First frame: a name from cache paints; a missing name shimmers. */
export function profilePhase(name: string | null | undefined): ProfilePhase {
  return (name ?? "").trim() ? "ready" : "shimmer";
}

export interface ProfileCompany {
  mark: string;
  name: string;
  role: string;
}

export interface ProfileRun {
  id: string;
  title: string;
  meta: string;
  state: "live" | "done" | "failed";
  trailing: string;
}

export interface BotProfileSnapshot {
  name: string;
  handle: string;
  email: string;
  owner: string;
  live: boolean;
  /** Idle copy when the bot is not live. */
  idleNote: string;
  nowTitle: string;
  nowMeta: string[];
  runtime: { label: string; value: string }[];
  runtimeVersion: string;
  companies: ProfileCompany[];
  /**
   * "all": `companies` is the bot's full membership list (every company, with
   * role). "current": only the viewing company's row is known, so the pane
   * labels it "In this company" and claims no count.
   */
  companiesScope: "all" | "current";
  capabilities: string[];
  runs: ProfileRun[];
  jobs: ProfileRun[];
  grants: { path: string; level: string }[];
}

export interface UserProfileSnapshot {
  name: string;
  email: string;
  live: boolean;
  roleChips: string[];
  now: string;
  session: string;
  localTime: string;
  lastSeen: string;
  bots: { name: string; live: boolean; note: string }[];
  channels: string[];
  files: { name: string; meta: string }[];
}

export function botProfileFromCache(input: {
  name: string;
  email?: string | null;
  owner?: string | null;
  live?: boolean;
  company?: string | null;
}): BotProfileSnapshot {
  const name = input.name.trim() || "Bot";
  const handle = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "bot";
  const company = input.company?.trim() || "Company";
  const live = Boolean(input.live);
  return {
    name,
    handle: `@${handle}`,
    email: input.email?.trim() || `${handle}@hq.ai`,
    owner: input.owner?.trim() || "You",
    live,
    idleNote: "Idle · last signal cached",
    nowTitle: live ? "Working from the cached session" : "Nothing running",
    nowMeta: live ? [company] : ["wakes on DM or schedule"],
    runtime: [
      { label: "Hosted", value: "Cached · refresh in the background" },
      { label: "Agent", value: "Claude Code" },
    ],
    runtimeVersion: "",
    companies: [{ mark: company.slice(0, 2).toUpperCase(), name: company, role: "Member" }],
    companiesScope: "current",
    capabilities: [],
    runs: [],
    jobs: [],
    grants: [],
  };
}

function membershipRole(raw: unknown): string {
  const role = typeof raw === "string" ? raw.trim() : "";
  if (!role) return "Member";
  return role.charAt(0).toUpperCase() + role.slice(1).toLowerCase();
}

/**
 * The bot's real memberships from an hq-pro agent payload (status or roster
 * row). Agents are first-class principals with one membership row per
 * company; this reads `memberships` (or `companies`) and returns null when the
 * payload carries no list, so callers keep the current-company fallback.
 */
export function botMembershipsFromPayload(payload: unknown): ProfileCompany[] | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const list = Array.isArray(record.memberships)
    ? record.memberships
    : Array.isArray(record.companies)
      ? record.companies
      : null;
  if (!list) return null;
  const rows: ProfileCompany[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const status = typeof row.status === "string" ? row.status.toLowerCase() : "active";
    if (status === "revoked" || status === "removed") continue;
    const key = String(row.companyUid ?? row.companySlug ?? row.slug ?? row.companyName ?? row.name ?? "").trim();
    const name = String(row.companyName ?? row.name ?? row.companySlug ?? row.slug ?? "").trim();
    if (!key || !name || seen.has(key)) continue;
    seen.add(key);
    rows.push({ mark: name.slice(0, 2).toUpperCase(), name, role: membershipRole(row.role) });
  }
  return rows.length ? rows : null;
}

export { botSubjectName, profileViewingCompanyUid } from "./bot-subject-name.js";

/** Display name from an hq-pro agent status/roster payload, when it has one. */
export function botNameFromPayload(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const record = payload as Record<string, unknown>;
  const agent =
    record.agent && typeof record.agent === "object"
      ? (record.agent as Record<string, unknown>)
      : record;
  for (const key of ["displayName", "name"]) {
    const value = agent[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/** Swap in the bot's full membership list once a refresh returns one. */
export function withBotMemberships(
  snapshot: BotProfileSnapshot,
  memberships: ProfileCompany[] | null,
): BotProfileSnapshot {
  if (!memberships?.length) return snapshot;
  return { ...snapshot, companies: memberships, companiesScope: "all" };
}

export function userProfileFromCache(input: {
  name: string;
  email?: string | null;
  role?: string | null;
  live?: boolean;
  company?: string | null;
}): UserProfileSnapshot {
  const company = input.company?.trim();
  const role = input.role?.trim();
  return {
    name: input.name.trim() || "Person",
    email: input.email?.trim() || "",
    live: Boolean(input.live),
    roleChips: company ? [`${role || "Member"} · ${company}`] : role ? [role] : [],
    now: input.live ? "Live" : "Away",
    session: "Cached presence",
    localTime: "",
    lastSeen: input.live ? "Now" : "Cached",
    bots: [],
    channels: [],
    files: [],
  };
}

export type SessionLine =
  | { id: string; kind: "speech"; at: string; who: string; text: string }
  | {
      id: string;
      kind: "tool";
      at: string;
      name: string;
      detail: string;
      result: string | null;
      running?: boolean;
    };

export type SessionPhase = "live" | "confirm-stop" | "ended";

export interface SessionTotals {
  elapsed: string;
  tokensIn: string;
  tokensOut: string;
  turns: number;
  model: string;
  outcome: string;
}

export function requestStop(phase: SessionPhase): SessionPhase {
  return phase === "live" ? "confirm-stop" : phase;
}

export function cancelStop(phase: SessionPhase): SessionPhase {
  return phase === "confirm-stop" ? "live" : phase;
}

/** Confirmed Stop is the only path into the ended state. */
export function confirmStop(phase: SessionPhase): SessionPhase {
  return phase === "confirm-stop" ? "ended" : phase;
}

export function appendTranscript(lines: readonly SessionLine[], line: SessionLine): SessionLine[] {
  return [...lines, line];
}

export interface TranscriptWindow {
  windowed: boolean;
  start: number;
  end: number;
  padTop: number;
  padBottom: number;
}

export function transcriptWindow(
  count: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight = TRANSCRIPT_ROW_HEIGHT,
  overscan = TRANSCRIPT_OVERSCAN,
): TranscriptWindow {
  if (count <= TRANSCRIPT_VIRTUALIZE_THRESHOLD) {
    return { windowed: false, start: 0, end: count, padTop: 0, padBottom: 0 };
  }
  const view = Math.max(1, Math.ceil(viewportHeight / rowHeight));
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const last = Math.min(count, first + view + overscan * 2);
  return {
    windowed: true,
    start: first,
    end: last,
    padTop: first * rowHeight,
    padBottom: Math.max(0, (count - last) * rowHeight),
  };
}

