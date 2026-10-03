/**
 * First-run guided tour for the desktop window: a spotlight that walks a new
 * person through eight places (the setup bot, the company vault, creating a
 * bot, inviting teammates, meetings, the web console, the Launch menu, the
 * command palette). This module is the pure part: step definitions,
 * state transitions, target resolution, geometry for the cutout and the card,
 * and the auto-start gate. `GuidedTour.svelte` renders it; `DesktopApp.svelte`
 * drives navigation and persists the "seen" flag.
 *
 * No Svelte, no Tauri, no DOM globals: target lookup takes a query function.
 */

import { SETUP_ROW_ID } from "../chat/setup-channel.js";
import { thisComputerNoun } from "@hq/platform";
import { formatShortcut } from "../common/keyboard-shortcuts.js";

export type TourStepId =
  | "setup-bot"
  | "company-vault"
  | "create-bot"
  | "invite"
  | "meetings"
  | "web-console"
  | "launch"
  | "command-palette";

/** Preferred side of the target for the card. */
export type TourPlacement = "top" | "bottom" | "left" | "right";

/**
 * What the host does when a step becomes current. The tour never navigates:
 * steps point at the control a person clicks to get somewhere, and the only
 * surfaces it opens (`open-*`) are closed again when it leaves the step.
 */
export type TourEnterAction = "none" | "open-launch-menu" | "open-palette";

export interface TourStep {
  id: TourStepId;
  title: string;
  body: string;
  /**
   * Target selectors in priority order; the first visible match wins. Empty
   * means the card is shown centered with no cutout straight away.
   */
  targets: string[];
  /**
   * Extra selectors whose boxes are merged into the spotlight when present
   * (the Launch menu hangs outside its wrapper's box).
   */
  include?: string[];
  placement: TourPlacement;
  onEnter: TourEnterAction;
}

export interface TourContext {
  /** The setup bot's DM is the open conversation. */
  setupBotDmOpen?: boolean;
  /** Agent uid of the setup bot, when one exists. */
  setupBotUid?: string | null;
  /** A company vault exists on this computer (else the tour shows Personal). */
  hasCompanyVault?: boolean;
  /** The account belongs to at least one company (else invites wait for setup). */
  hasCompany?: boolean;
}

/** localStorage fallback for hosts without `markWelcomeTourShown`. */
export const TOUR_SEEN_STORAGE_KEY = "hq.welcome.tour.v1";

/** Wait after the shell settles before auto-starting. */
export const TOUR_AUTO_START_DELAY_MS = 600;

/** Give up looking for a step's target after this long and center the card. */
export const TOUR_TARGET_TIMEOUT_MS = 1500;

/** Space between the target's box and the cutout edge. */
const TOUR_SPOTLIGHT_PADDING = 8;

function attr(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** The eight steps, in order, for the current shell. */
export function tourSteps(ctx: TourContext = {}): TourStep[] {
  const botUid = ctx.setupBotUid?.trim() || null;
  const botRow = botUid ? `.chat-row[data-conversation-id="dm:${attr(botUid)}"]` : null;
  const setupTargets = [
    ...(ctx.setupBotDmOpen ? [".dm-reply-composer"] : []),
    '[data-testid="setup-hero"]',
    '[data-testid="setup-channel-intro"]',
    ...(botRow ? [botRow] : []),
    `.chat-row[data-conversation-id="${SETUP_ROW_ID}"]`,
  ];
  const company = ctx.hasCompanyVault === true;
  const hasCompany = ctx.hasCompany === true;
  return [
    {
      id: "setup-bot",
      title: "Talk to your setup bot",
      body: "It asks a few questions about your company and sets up HQ for you. Reply here any time.",
      targets: setupTargets,
      placement: "top",
      onEnter: "none",
    },
    {
      id: "company-vault",
      title: company ? "Your company's files" : "Your files",
      body: company
        ? `Click here to open your files. Everything HQ knows about your company lives there, synced to ${thisComputerNoun()} and shared with your team.`
        : `Click here to open your files, synced to ${thisComputerNoun()}. Your company's files appear there once setup creates it.`,
      // The rail's Library item opens the Files explorer.
      targets: ['[data-testid="rail-library"]'],
      placement: "right",
      onEnter: "none",
    },
    {
      id: "create-bot",
      title: "Make your own bots",
      body: "Click + to start a new bot: give it a name and pick Claude Code or Codex to run it. It can take on a job for you or your team.",
      // The sidebar "+" opens the create modal, whose picker has New bot.
      targets: ['[data-testid="chat-new-message"]'],
      placement: "right",
      onEnter: "none",
    },
    {
      id: "invite",
      title: "Bring in your team",
      body: hasCompany
        ? "Invite teammates so they share the same files, bots and knowledge. Invites are sent from your company's Team page on hq.computer."
        : "Invite teammates so they share the same files, bots and knowledge. Invites open once setup creates your company.",
      // No send-invite control is mounted in the desktop shell today; the
      // Team panel's Invite button wins if one appears, then the rail's
      // first company tile, then a host sidebar that still lists companies.
      // With no company there is nothing to point at.
      targets: hasCompany
        ? [
            '[data-testid="team-invite"]',
            '[data-testid="rail-company"]',
            '[data-testid="chat-companies-section"]',
          ]
        : [],
      placement: "right",
      onEnter: "none",
    },
    {
      id: "meetings",
      title: "Meetings",
      body: "HQ can take notes on your calls and turn them into summaries and action items.",
      targets: ['[data-testid="rail-meetings"]'],
      placement: "right",
      onEnter: "none",
    },
    {
      id: "web-console",
      title: "Your personal tools",
      body: "Deployments, telemetry, secrets, connections and Outpost live on the left rail.",
      targets: ['[data-testid="rail-deployments"]'],
      placement: "right",
      onEnter: "none",
    },
    {
      id: "launch",
      title: "Work in the tools you know",
      body: "Launch Claude Code or Codex with all of HQ loaded in.",
      targets: [".v4-launch-wrap"],
      include: ['[data-testid="titlebar-launch-menu"]'],
      placement: "bottom",
      onEnter: "open-launch-menu",
    },
    {
      id: "command-palette",
      title: `Find anything with ${formatShortcut("Mod+K")}`,
      body: "Jump to files, people, bots and settings. You can replay this tour from here too.",
      targets: ['[data-testid="command-palette"]'],
      placement: "bottom",
      onEnter: "open-palette",
    },
  ];
}

export type TourState =
  | { status: "idle" }
  | { status: "active"; index: number }
  | { status: "done" }
  | { status: "skipped" };

export const TOUR_IDLE: TourState = { status: "idle" };

export function startTourState(): TourState {
  return { status: "active", index: 0 };
}

/** Next, or Done on the last step. */
export function nextTourState(state: TourState, count: number): TourState {
  if (state.status !== "active") return state;
  if (state.index >= count - 1) return { status: "done" };
  return { status: "active", index: state.index + 1 };
}

/** Back; a no-op on the first step. */
export function backTourState(state: TourState): TourState {
  if (state.status !== "active" || state.index === 0) return state;
  return { status: "active", index: state.index - 1 };
}

export function skipTourState(state: TourState): TourState {
  if (state.status !== "active") return state;
  return { status: "skipped" };
}

/** "N of M" for the card. */
export function tourProgressLabel(index: number, count: number): string {
  return `${index + 1} of ${count}`;
}

/** The primary button's label: Next, or Done on the last step. */
export function tourPrimaryLabel(index: number, count: number): string {
  return index >= count - 1 ? "Done" : "Next";
}

/** Back is offered from step 2 on. */
export function tourCanGoBack(index: number): boolean {
  return index > 0;
}

export interface TourAutoStartInput {
  /** From the host's setup status; only an explicit `true` counts. */
  welcomeSetupOwed: boolean | null;
  /** Host flag or the local fallback says the tour was already shown. */
  tourSeen: boolean;
  /** The shell painted its first conversation. */
  shellReady: boolean;
  /** #welcome or the setup bot's DM is the conversation on screen. */
  welcomeOnScreen: boolean;
  /** The tour already started once in this window. */
  startedThisSession: boolean;
}

/**
 * Start by itself only on a fresh install (guided setup still owed), once,
 * after the shell is up and the setup conversation is what the person sees.
 */
export function shouldAutoStartTour(input: TourAutoStartInput): boolean {
  return (
    input.welcomeSetupOwed === true &&
    !input.tourSeen &&
    input.shellReady &&
    input.welcomeOnScreen &&
    !input.startedThisSession
  );
}

/** Is `rowId` the #welcome channel or the setup bot's DM? */
export function isTourHomeRow(rowId: string | null | undefined, setupBotUid?: string | null): boolean {
  if (!rowId) return false;
  if (rowId === SETUP_ROW_ID) return true;
  const uid = setupBotUid?.trim();
  return Boolean(uid && rowId === `dm:${uid}`);
}

export interface TourRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface TourViewport {
  width: number;
  height: number;
}

export interface ResolvedTourTarget<E> {
  selector: string;
  element: E;
}

/**
 * First selector whose element exists and is usable (the component passes a
 * visibility check). `query` is `querySelector`-shaped.
 */
export function resolveTourTarget<E>(
  selectors: readonly string[],
  query: (selector: string) => E | null,
  usable: (element: E) => boolean = () => true,
): ResolvedTourTarget<E> | null {
  for (const selector of selectors) {
    let element: E | null = null;
    try {
      element = query(selector);
    } catch {
      element = null;
    }
    if (element && usable(element)) return { selector, element };
  }
  return null;
}

/** Smallest rect covering every non-empty rect given. */
export function unionTourRects(rects: readonly (TourRect | null | undefined)[]): TourRect | null {
  let top = Infinity;
  let left = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const rect of rects) {
    if (!rect || rect.width <= 0 || rect.height <= 0) continue;
    top = Math.min(top, rect.top);
    left = Math.min(left, rect.left);
    right = Math.max(right, rect.left + rect.width);
    bottom = Math.max(bottom, rect.top + rect.height);
  }
  if (!Number.isFinite(top)) return null;
  return { top, left, width: right - left, height: bottom - top };
}

/** Target box grown by `padding`, clipped to the viewport. */
export function spotlightRect(
  target: TourRect,
  viewport: TourViewport,
  padding: number = TOUR_SPOTLIGHT_PADDING,
): TourRect {
  const left = Math.max(0, target.left - padding);
  const top = Math.max(0, target.top - padding);
  const right = Math.min(viewport.width, target.left + target.width + padding);
  const bottom = Math.min(viewport.height, target.top + target.height + padding);
  return { top, left, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

/** SVG path for a rectangle, used for the full-window scrim. */
function rectPath(r: TourRect): string {
  return `M${r.left},${r.top}h${r.width}v${r.height}h${-r.width}z`;
}

/** SVG path for a rounded rectangle (the cutout). */
function roundedRectPath(r: TourRect, radius: number): string {
  const rad = Math.max(0, Math.min(radius, r.width / 2, r.height / 2));
  const { left: x, top: y, width: w, height: h } = r;
  return (
    `M${x + rad},${y}` +
    `h${w - 2 * rad}a${rad},${rad} 0 0 1 ${rad},${rad}` +
    `v${h - 2 * rad}a${rad},${rad} 0 0 1 ${-rad},${rad}` +
    `h${-(w - 2 * rad)}a${rad},${rad} 0 0 1 ${-rad},${-rad}` +
    `v${-(h - 2 * rad)}a${rad},${rad} 0 0 1 ${rad},${-rad}z`
  );
}

/**
 * The scrim: the whole window with the cutout punched out (fill-rule
 * evenodd). Pointer hits follow the fill, so the dimmed area blocks clicks
 * and the cutout lets them through.
 */
export function scrimPath(viewport: TourViewport, cutout: TourRect | null, radius = 10): string {
  const outer = rectPath({ top: 0, left: 0, width: viewport.width, height: viewport.height });
  if (!cutout || cutout.width <= 0 || cutout.height <= 0) return outer;
  return `${outer}${roundedRectPath(cutout, radius)}`;
}

export interface TourCardSize {
  width: number;
  height: number;
}

export interface TourCardPosition {
  top: number;
  left: number;
  /** Side of the target the card sits on; `center` when there is no anchor. */
  placement: TourPlacement | "center";
  /** Arrow offset along the card edge facing the target, or null for none. */
  arrow: number | null;
}

const OPPOSITE: Record<TourPlacement, TourPlacement> = {
  top: "bottom",
  bottom: "top",
  left: "right",
  right: "left",
};

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

/**
 * Put the card next to the cutout: the preferred side, then the opposite,
 * then the remaining two. Clamped to the viewport on the cross axis. When no
 * side has room, or there is no target, the card is centered with no arrow.
 */
export function placeTourCard(
  target: TourRect | null,
  card: TourCardSize,
  viewport: TourViewport,
  preference: TourPlacement,
  gap = 12,
  margin = 12,
): TourCardPosition {
  const centered: TourCardPosition = {
    top: Math.max(margin, Math.round((viewport.height - card.height) / 2)),
    left: Math.max(margin, Math.round((viewport.width - card.width) / 2)),
    placement: "center",
    arrow: null,
  };
  if (!target) return centered;
  const order: TourPlacement[] = [preference, OPPOSITE[preference]];
  for (const side of ["bottom", "top", "right", "left"] as TourPlacement[]) {
    if (!order.includes(side)) order.push(side);
  }
  const targetCenterX = target.left + target.width / 2;
  const targetCenterY = target.top + target.height / 2;
  const maxLeft = viewport.width - card.width - margin;
  const maxTop = viewport.height - card.height - margin;
  for (const side of order) {
    let top: number;
    let left: number;
    if (side === "top" || side === "bottom") {
      top = side === "top" ? target.top - gap - card.height : target.top + target.height + gap;
      if (top < margin || top > maxTop) continue;
      left = clamp(targetCenterX - card.width / 2, margin, maxLeft);
      const arrow = clamp(targetCenterX - left, 16, card.width - 16);
      return { top: Math.round(top), left: Math.round(left), placement: side, arrow: Math.round(arrow) };
    }
    left = side === "left" ? target.left - gap - card.width : target.left + target.width + gap;
    if (left < margin || left > maxLeft) continue;
    top = clamp(targetCenterY - card.height / 2, margin, maxTop);
    const arrow = clamp(targetCenterY - top, 16, card.height - 16);
    return { top: Math.round(top), left: Math.round(left), placement: side, arrow: Math.round(arrow) };
  }
  return centered;
}

export interface TourSeenStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Local fallback: has this window's storage recorded the tour? */
export function readTourSeenLocally(storage: TourSeenStorage | null | undefined): boolean {
  try {
    return storage?.getItem(TOUR_SEEN_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeTourSeenLocally(storage: TourSeenStorage | null | undefined): void {
  try {
    storage?.setItem(TOUR_SEEN_STORAGE_KEY, "1");
  } catch {
    // Storage unavailable (private mode, quota): the host flag still holds.
  }
}
