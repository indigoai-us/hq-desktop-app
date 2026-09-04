/**
 * Pure model for the project-channel Board tab (US-006).
 *
 * Maps PRD stories + agent sessions + optional PR/CI/reviewer signals into
 * three columns (IN PROGRESS / REVIEW / DONE), card status lines, story detail
 * panels, and activity feeds. No Svelte / Tauri — unit-tested.
 *
 * Poll semantics: the Board tab refreshes on {@link BOARD_POLL_MS} until
 * realtime (US-015) lands.
 */

import {
  isPortfolioLiveStatus,
  sessionHasServerBinding,
  type PortfolioSessionRef,
} from "../chat/portfolio-session";
import { extractStoryId } from "../chat/channel-status-model";

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * Board tab refresh interval (ms). Realtime updates are US-015; until then the
 * tab reloads project/prd/sessions on this cadence.
 */
export const BOARD_POLL_MS = 15_000;

/** Board column identifiers. */
export type BoardColumnId = "in_progress" | "review" | "done";

export const BOARD_COLUMN_ORDER: readonly BoardColumnId[] = [
  "in_progress",
  "review",
  "done",
] as const;

export const BOARD_COLUMN_TITLE: Record<BoardColumnId, string> = {
  in_progress: "DOING",
  review: "WAITING",
  done: "DONE",
};

// ── Inputs ───────────────────────────────────────────────────────────────────

/** One acceptance criterion — string form or explicit done flag for fixtures. */
export type BoardAcInput = string | { text: string; done?: boolean };

/** Story row as consumed by the board (from PRD userStories). */
export interface BoardStoryInput {
  id: string;
  title?: string;
  description?: string;
  /**
   * Acceptance criteria. Strings use story-level pass; objects may set per-item
   * `done` for partial fixtures (e.g. 2 of 4 struck).
   */
  acceptanceCriteria?: BoardAcInput[];
  /** Story-level pass flag — when true (and no per-item flags), all AC done. */
  passes?: boolean;
}

/**
 * Optional per-story signal for PR / CI / human review / ship state.
 *
 * Used by {@link deriveBoardColumns} column placement and status-line vocabulary.
 */
export interface BoardStorySignal {
  /** Open pull request for this story. */
  prOpen?: boolean;
  /**
   * CI state when known: `true` = green, `false` = red, `null`/`undefined` =
   * unknown (status line omits CI when PR is open).
   */
  ciGreen?: boolean | null;
  /** Human reviewer display name when assigned. */
  reviewer?: string | null;
  /** Merged / shipped — forces DONE even if passes is still false. */
  shipped?: boolean;
}

/** Agent session input; extends portfolio session with optional story progress. */
export interface BoardSessionInput extends PortfolioSessionRef {
  /** Optional progress 0–100 when the session reports it. */
  progressPercent?: number | null;
  /** Optional story id the session is working on (US-xxx). */
  storyId?: string | null;
  personUid?: string;
}

/** Project identity for session matching + panel PROJECT field. */
export interface BoardProjectInput {
  id: string;
  title?: string;
  name?: string;
  company?: string;
  prdPath?: string;
}

/** PRD fields needed by the board + story panel. */
export interface BoardPrdInput {
  name?: string;
  branchName?: string | null;
  userStories?: BoardStoryInput[];
  prdPath?: string | null;
}

/** Channel system-event message shape used by activity filtering. */
export interface BoardActivityMessageInput {
  eventId: string;
  createdAt: string;
  body?: string | null;
  messageKind?: string | null;
  systemEvent?: Record<string, unknown> | null;
  details?: string | null;
}

// ── Outputs ──────────────────────────────────────────────────────────────────

/** One card on the board. */
export interface BoardCard {
  storyId: string;
  /** "US-nnn · title" */
  label: string;
  /** Status line vocabulary — see {@link buildStatusLine}. */
  statusLine: string;
  column: BoardColumnId;
  /** True when a live agent session is matched to this story. */
  hasLiveAgent: boolean;
  progressPercent: number | null;
  /** Live agent tool name, reviewer name, or null. */
  assignee: string | null;
}

/** One column with ordered cards. */
export interface BoardColumn {
  id: BoardColumnId;
  title: string;
  cards: BoardCard[];
}

/** Acceptance criterion row in the story panel (story-level pass only). */
export interface BoardAcItem {
  text: string;
  /** Checked + struck when story.passes; never per-criterion state. */
  done: boolean;
}

/** Story detail side-panel model. */
export interface StoryPanelModel {
  id: string;
  title: string;
  /** Same vocabulary as card status lines. */
  statusBadge: string;
  description: string;
  /** Field rows: STATUS / ASSIGNEE / PROJECT / BRANCH. */
  fields: {
    status: string;
    assignee: string;
    project: string;
    branch: string;
  };
  acceptanceCriteria: BoardAcItem[];
  /** "x/y" complete count — story-level pass semantics. */
  acCountLabel: string;
  acComplete: number;
  acTotal: number;
}

/** One activity feed row for a story. */
export interface StoryActivityItem {
  id: string;
  at: string;
  text: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Normalize story ids to `US-NNN` style for comparisons. */
export function normalizeBoardStoryId(raw: string | null | undefined): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return "";
  const extracted = extractStoryId(trimmed);
  if (extracted) return extracted;
  return trimmed.toUpperCase().replace(/_/g, "-");
}

function storyTitle(story: BoardStoryInput): string {
  return (story.title ?? "").trim() || story.id;
}

/** Card label: `US-nnn · title`. */
export function boardCardLabel(story: BoardStoryInput): string {
  const id = (story.id ?? "").trim() || "US-???";
  return `${id} · ${storyTitle(story)}`;
}

/**
 * Whether a live session is matched to a specific story.
 *
 * US-015: match only by explicit `storyId` / `taskId` (normalized). Never
 * grep cwd. Local Sessions-app rows also require a server binding.
 * `project` is accepted for call-site compatibility and ignored.
 */
export function sessionMatchesStory(
  session: BoardSessionInput,
  storyId: string,
  _project?: BoardProjectInput | null,
): boolean {
  if (!isPortfolioLiveStatus(session.status)) return false;
  if (!sessionHasServerBinding(session)) return false;
  const target = normalizeBoardStoryId(storyId);
  if (!target) return false;

  const explicitStory = normalizeBoardStoryId(session.storyId);
  if (explicitStory && explicitStory === target) return true;

  const explicitTask = normalizeBoardStoryId(session.taskId);
  if (explicitTask && explicitTask === target) return true;

  return false;
}

/** First live session matched to a story, preferring `running` over awaiting. */
export function findLiveSessionForStory(
  storyId: string,
  sessions: readonly BoardSessionInput[],
  project?: BoardProjectInput | null,
): BoardSessionInput | null {
  let awaiting: BoardSessionInput | null = null;
  for (const session of sessions) {
    if (!sessionMatchesStory(session, storyId, project)) continue;
    const status = (session.status ?? "").toLowerCase();
    if (status === "running") return session;
    if (!awaiting) awaiting = session;
  }
  return awaiting;
}

/**
 * Whether optional signals put a story into REVIEW (not yet done).
 *
 * Review when any of: PR open, CI state known (true/false), or a reviewer is
 * assigned.
 */
export function hasReviewSignal(
  signal: BoardStorySignal | null | undefined,
): boolean {
  if (!signal) return false;
  if (signal.prOpen === true) return true;
  if (signal.ciGreen === true || signal.ciGreen === false) return true;
  if (
    typeof signal.reviewer === "string" &&
    signal.reviewer.trim().length > 0
  ) {
    return true;
  }
  return false;
}

/**
 * Build the card / panel status-line vocabulary string.
 *
 * Exact forms (D-12):
 * - `AGENT RUNNING · 42%` (live session; omit ` · %` when progress unknown)
 * - `{PERSON} REVIEWING` (reviewer signal, e.g. `MARCUS REVIEWING`)
 * - `DESIGN REVIEW` (review without named person / design flag)
 * - `PR OPEN · CI GREEN` / `PR OPEN · CI RED` / `PR OPEN` (CI unknown)
 * - `SHIPPED` (done)
 * - `QUEUED` (untouched fallback)
 */
export function buildStatusLine(input: {
  passes?: boolean;
  signal?: BoardStorySignal | null;
  liveSession?: BoardSessionInput | null;
}): string {
  const signal = input.signal ?? null;
  if (input.passes === true || signal?.shipped === true) {
    return "SHIPPED";
  }

  const live = input.liveSession ?? null;
  if (live && isPortfolioLiveStatus(live.status)) {
    const progress =
      typeof live.progressPercent === "number" &&
      Number.isFinite(live.progressPercent)
        ? Math.max(0, Math.min(100, Math.round(live.progressPercent)))
        : null;
    return progress != null ? `AGENT RUNNING · ${progress}%` : "AGENT RUNNING";
  }

  const reviewer = signal?.reviewer?.trim();
  if (reviewer) {
    const name = reviewer.toUpperCase();
    // "design" alone → DESIGN REVIEW; named humans → "MARCUS REVIEWING".
    if (name === "DESIGN" || name === "DESIGN REVIEW") return "DESIGN REVIEW";
    return `${name} REVIEWING`;
  }

  if (signal?.prOpen === true) {
    if (signal.ciGreen === true) return "PR OPEN · CI GREEN";
    if (signal.ciGreen === false) return "PR OPEN · CI RED";
    return "PR OPEN";
  }

  // CI known without PR still counts as review signal elsewhere, but vocabulary
  // falls through to QUEUED when neither PR nor reviewer is present.
  return "QUEUED";
}

function sessionAssigneeLabel(
  session: BoardSessionInput | null,
): string | null {
  if (!session) return null;
  const label =
    [session.tool, session.model].filter(Boolean).join(" · ") ||
    session.project ||
    "Agent";
  return label;
}

/**
 * Column mapping for the Board tab.
 *
 * **DONE** — `story.passes === true`, or an available signal says merged /
 * shipped (`signal.shipped === true`).
 *
 * **REVIEW** — not passed, but a signal indicates review: PR open, CI state
 * known (`ciGreen` true/false), or a human reviewer assignment
 * (`reviewer` non-empty). See {@link BoardStorySignal}.
 *
 * **IN PROGRESS** — everything else (including not-yet-started stories). Live-
 * agent stories sort first; remaining stories sit below as queued. All
 * non-review non-done stories go to IN PROGRESS (simple queue model).
 */
export function deriveBoardColumns(
  stories: readonly BoardStoryInput[],
  sessions: readonly BoardSessionInput[] = [],
  signals: Readonly<Record<string, BoardStorySignal>> | null | undefined = null,
  project: BoardProjectInput | null = null,
): BoardColumn[] {
  const buckets: Record<BoardColumnId, BoardCard[]> = {
    in_progress: [],
    review: [],
    done: [],
  };

  for (const story of stories) {
    const storyId = (story.id ?? "").trim();
    if (!storyId) continue;
    const key = normalizeBoardStoryId(storyId);
    const signal =
      signals?.[storyId] ??
      signals?.[key] ??
      signals?.[storyId.toUpperCase()] ??
      null;
    const live = findLiveSessionForStory(storyId, sessions, project);
    const passes = story.passes === true;
    const shipped = signal?.shipped === true;

    let column: BoardColumnId;
    if (passes || shipped) {
      column = "done";
    } else if (hasReviewSignal(signal)) {
      column = "review";
    } else {
      column = "in_progress";
    }

    const statusLine = buildStatusLine({
      passes: passes || shipped,
      signal,
      liveSession: column === "done" ? null : live,
    });

    const assignee =
      live && column !== "done"
        ? sessionAssigneeLabel(live)
        : signal?.reviewer?.trim() || null;

    const progress =
      live &&
      typeof live.progressPercent === "number" &&
      Number.isFinite(live.progressPercent)
        ? Math.max(0, Math.min(100, Math.round(live.progressPercent)))
        : null;

    buckets[column].push({
      storyId,
      label: boardCardLabel(story),
      statusLine,
      column,
      hasLiveAgent: live != null && column !== "done",
      progressPercent: progress,
      assignee,
    });
  }

  // IN PROGRESS: live-agent-first, then queued (preserve relative story order).
  buckets.in_progress.sort((a, b) => {
    if (a.hasLiveAgent !== b.hasLiveAgent) return a.hasLiveAgent ? -1 : 1;
    return 0;
  });

  return BOARD_COLUMN_ORDER.map((id) => ({
    id,
    title: BOARD_COLUMN_TITLE[id],
    cards: buckets[id],
  }));
}

/**
 * Normalize one AC input into text + optional explicit done flag.
 */
export function normalizeAcInput(raw: BoardAcInput): {
  text: string;
  done?: boolean;
} {
  if (typeof raw === "string") return { text: raw };
  return {
    text: (raw.text ?? "").trim() || String(raw),
    done: raw.done,
  };
}

/**
 * Story detail panel model.
 *
 * Acceptance criteria:
 * - Prefer per-item `done` when any criterion supplies it (fixture partials).
 * - Else **story-level pass semantics**: when `story.passes` is true every
 *   criterion is done; otherwise none. Count label is `x/y`.
 */
export function buildStoryPanelModel(
  story: BoardStoryInput,
  project: BoardProjectInput | null | undefined,
  prd: BoardPrdInput | null | undefined,
  sessions: readonly BoardSessionInput[] = [],
  signal: BoardStorySignal | null | undefined = null,
): StoryPanelModel {
  const storyId = (story.id ?? "").trim();
  const live = findLiveSessionForStory(storyId, sessions, project ?? null);
  const passes = story.passes === true || signal?.shipped === true;
  const statusBadge = buildStatusLine({
    passes,
    signal,
    liveSession: passes ? null : live,
  });

  const rawAc = story.acceptanceCriteria ?? [];
  const normalized = rawAc.map(normalizeAcInput);
  const hasPerItemDone = normalized.some((a) => typeof a.done === "boolean");
  const acceptanceCriteria: BoardAcItem[] = normalized.map((a) => ({
    text: a.text,
    // Per-item fixtures win; else story-level pass (NO writes).
    done: hasPerItemDone ? a.done === true : passes,
  }));
  const acTotal = acceptanceCriteria.length;
  const acComplete = acceptanceCriteria.filter((a) => a.done).length;

  const assignee =
    (live && !passes ? sessionAssigneeLabel(live) : null) ||
    signal?.reviewer?.trim() ||
    "—";

  const projectLabel =
    (
      project?.title ||
      project?.name ||
      project?.id ||
      prd?.name ||
      ""
    ).trim() || "—";
  // BRANCH populated during runs (live agent) or from PRD.
  const liveBranch =
    live && isPortfolioLiveStatus(live.status)
      ? (prd?.branchName ?? "").trim() || `story/${storyId.toLowerCase()}`
      : "";
  const branch = liveBranch || (prd?.branchName ?? "").trim() || "—";

  return {
    id: storyId,
    title: storyTitle(story),
    statusBadge,
    description: (story.description ?? "").trim(),
    fields: {
      status: statusBadge,
      assignee,
      project: projectLabel,
      branch,
    },
    acceptanceCriteria,
    acCountLabel: `${acComplete}/${acTotal}`,
    acComplete,
    acTotal,
  };
}

function messageHaystack(msg: BoardActivityMessageInput): string {
  const parts: string[] = [];
  if (msg.body) parts.push(msg.body);
  if (msg.details) parts.push(msg.details);
  if (msg.systemEvent) {
    try {
      parts.push(JSON.stringify(msg.systemEvent));
    } catch {
      // ignore non-serializable
    }
  }
  return parts.join(" ");
}

function isSystemEventMessage(msg: BoardActivityMessageInput): boolean {
  if (msg.systemEvent != null && typeof msg.systemEvent === "object")
    return true;
  const kind = (msg.messageKind ?? "").toLowerCase();
  return (
    kind === "system" || kind === "system_event" || kind === "system-event"
  );
}

function activityText(msg: BoardActivityMessageInput): string {
  const se = msg.systemEvent;
  if (se && typeof se === "object") {
    const title = typeof se.title === "string" ? se.title.trim() : "";
    const summary = typeof se.summary === "string" ? se.summary.trim() : "";
    if (title && summary) return `${title}: ${summary}`;
    if (title) return title;
    if (summary) return summary;
  }
  return (msg.body ?? msg.details ?? "").trim() || "System event";
}

/**
 * Filter channel system-event messages that reference a story id
 * (case-insensitive `US-006` match in body / details / systemEvent payload).
 * Returns newest-last, mapped to `{ id, at, text }`.
 */
export function buildStoryActivity(
  messages: readonly BoardActivityMessageInput[],
  storyId: string,
): StoryActivityItem[] {
  const target = normalizeBoardStoryId(storyId);
  if (!target) return [];
  const needle = target.toLowerCase();
  // Also accept without hyphen variants (us006).
  const compact = needle.replace(/-/g, "");

  const matched: StoryActivityItem[] = [];
  for (const msg of messages) {
    if (!isSystemEventMessage(msg)) continue;
    const hay = messageHaystack(msg).toLowerCase();
    if (!hay) continue;
    if (!hay.includes(needle) && !hay.includes(compact)) continue;
    // Prefer extracted-id equality so "US-0060" does not match US-006.
    const extracted = extractStoryId(messageHaystack(msg));
    if (extracted && normalizeBoardStoryId(extracted) !== target) continue;
    matched.push({
      id: msg.eventId,
      at: msg.createdAt,
      text: activityText(msg),
    });
  }

  // Newest-last: sort ascending by createdAt.
  matched.sort((a, b) => {
    const ta = Date.parse(a.at) || 0;
    const tb = Date.parse(b.at) || 0;
    return ta - tb;
  });
  return matched;
}
