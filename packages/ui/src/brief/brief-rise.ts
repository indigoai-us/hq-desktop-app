/**
 * Rise into the sky (round 11b). Pure timing and geometry for the first-brief
 * sunrise, so the horizon-crossing frame is testable without a canvas.
 *
 * Icons are 60 px on the same 8 px pitch as BriefDawn. They are clipped at
 * the waterline (nothing is drawn underwater, and there is no reflection),
 * rise at 140 px/s, and never sit on the sun disc. The count and the finding
 * card update on the frame the icon's centre crosses the horizon.
 */

export const RISE_PITCH = 8;
export const RISE_CELL = 6;
export const RISE_ICON = 60;
export const RISE_SPEED = 140;
export const RISE_PEAK = 224;
export const RISE_FADE_S = 0.9;
export const RISE_RIPPLE_S = 0.6;
export const RISE_GAP_S = 4;
export const RISE_FIRST_S = 9;
export const RISE_CROSSFADE_S = 0.6;
export const RISE_SUN_RADIUS = 72;
export const RISE_LANE_LEFT = -200;
export const RISE_LANE_RIGHT = 184;
export const RISE_REDUCED_HOLD_S = 1.5;

const GATE = "Open a company first";

export interface RiseCounts {
  sessions: number;
  repos: number;
  calendars: number;
}

export interface RiseSource {
  id: string;
  label: string;
  /** Brand mark name when one exists. Company rows use initials. */
  icon?: string;
  counts: Partial<RiseCounts>;
  /** The finding card. Not a second copy of the count line. */
  finding: string;
  /** Smaller line under the finding, when the source has one. */
  detail?: string;
  failed?: boolean;
  /** One calm line. Shown instead of the finding when the source failed. */
  failureLine?: string;
}

export interface RiseCompany {
  id: string;
  name: string;
}

export interface RiseIconFrame {
  id: string;
  /** Centre Y relative to the horizon. Negative is sky. Positive is water. */
  centerY: number;
  /** Horizontal offset from the sun's centre, in px. */
  lane: number;
  opacity: number;
  ripple: boolean;
  /** Seconds since the icon broke the water. -1 when the ring is off. */
  rippleAge: number;
  visible: boolean;
  /** The full 60 px mark is above the waterline. */
  whole: boolean;
  /** True when the 60 px icon would intersect the sun disc. */
  crossesSun: boolean;
}

export interface RiseCardFrame {
  id: string;
  label: string;
  text: string;
  detail: string;
  failed: boolean;
}

export interface RisePixel {
  x: number;
  y: number;
  color: string;
  /** Cell opacity. The halo fades with distance from the mark. */
  alpha: number;
}

/** 6 px cells on the 8 px pitch, sunrise palette, in a ring around the 60 px mark. */
export const RISE_HALO_ALPHA_DARK = 0.45;
export const RISE_HALO_ALPHA_LIGHT = 0.38;
export const RISE_HALO_DARK = ["#ffb580", "#ff809f", "#ffa88c", "#ffbea0", "#ff9696"];
export const RISE_HALO_LIGHT = ["#d67860", "#d46880", "#dc8c6e"];

export function riseHaloCells(theme: "dark" | "light"): RisePixel[] {
  const colors = theme === "light" ? RISE_HALO_LIGHT : RISE_HALO_DARK;
  const peak = theme === "light" ? RISE_HALO_ALPHA_LIGHT : RISE_HALO_ALPHA_DARK;
  const cells: RisePixel[] = [];
  const r0 = RISE_ICON / 2 - 10;
  const r1 = RISE_ICON / 2 + 26;
  const start = -Math.ceil(r1 / RISE_PITCH) * RISE_PITCH;
  for (let gy = start; gy <= r1; gy += RISE_PITCH) {
    for (let gx = start; gx <= r1; gx += RISE_PITCH) {
      const d = Math.hypot(gx + RISE_CELL / 2, gy + RISE_CELL / 2);
      if (d < r0 || d > r1) continue;
      const color = colors[Math.abs((gx / RISE_PITCH + gy / RISE_PITCH) | 0) % colors.length]!;
      // Round 11b: full strength at the mark's edge, fading to nothing at the outer ring.
      const falloff = 1 - (d - r0) / (r1 - r0);
      cells.push({ x: gx, y: gy, color, alpha: Number((peak * falloff).toFixed(3)) });
    }
  }
  return cells;
}

/** Flat pixel ring on the waterline and the two rows under it. Age is seconds since emergence. */
export function riseRippleCells(age: number, theme: "dark" | "light"): RisePixel[] {
  if (age < 0 || age > RISE_RIPPLE_S) return [];
  const rr = RISE_ICON / 2 + age * 70;
  const fade = (1 - age / RISE_RIPPLE_S) * 0.85;
  const color = theme === "light" ? `rgba(176, 100, 98, ${fade.toFixed(3)})` : `rgba(255, 190, 160, ${fade.toFixed(3)})`;
  const cells: RisePixel[] = [];
  const reach = Math.ceil((rr + RISE_PITCH) / RISE_PITCH) * RISE_PITCH;
  // The front half of a flat ellipse on three water rows, from the waterline down,
  // so the sides join the bottom arc and it reads as one ring, not a bracket.
  for (const gy of [0, RISE_PITCH, RISE_PITCH * 2]) {
    for (let gx = -reach; gx <= reach; gx += RISE_PITCH) {
      const ry = gy / (RISE_PITCH * 2);
      const dx = (gx + RISE_CELL / 2) / rr;
      if (Math.abs(Math.hypot(dx, ry * 0.9) - 1) > 0.2) continue;
      cells.push({ x: gx, y: gy, color, alpha: 1 });
    }
  }
  return cells;
}

export interface RiseFrame {
  elapsed: number;
  countText: string;
  cards: RiseCardFrame[];
  icons: RiseIconFrame[];
  /** 0 while the brief is still building, 1 after the cross-fade. */
  briefOpacity: number;
  building: boolean;
  companiesLine: string;
  /** The rise never tells the person to open a company before the brief. */
  companyGate: boolean;
}

export function riseRevealAt(index: number): number {
  return RISE_FIRST_S + index * RISE_GAP_S;
}

export function formatRiseCount(counts: RiseCounts): string {
  const parts: string[] = [];
  if (counts.sessions > 0) {
    parts.push(`${counts.sessions} ${counts.sessions === 1 ? "session" : "sessions"} read`);
  }
  if (counts.repos > 0) parts.push(`${counts.repos} ${counts.repos === 1 ? "repo" : "repos"}`);
  if (counts.calendars > 0) {
    parts.push(`${counts.calendars} ${counts.calendars === 1 ? "calendar" : "calendars"}`);
  }
  return parts.join(" · ");
}

/** Zero companies is a getting-started line. Several companies are named. Never a gate. */
export function riseCompaniesLine(companies: readonly RiseCompany[]): string {
  if (companies.length === 0) return "Your brief starts here, before you join a company.";
  return companies.map((company) => company.name).join(" · ");
}

function emptyCounts(): RiseCounts {
  return { sessions: 0, repos: 0, calendars: 0 };
}

function addCounts(into: RiseCounts, extra: Partial<RiseCounts>): void {
  into.sessions += extra.sessions ?? 0;
  into.repos += extra.repos ?? 0;
  into.calendars += extra.calendars ?? 0;
}

function laneFor(index: number): number {
  return index % 2 === 0 ? RISE_LANE_LEFT : RISE_LANE_RIGHT;
}

function crossesSun(lane: number): boolean {
  return Math.abs(lane) < RISE_SUN_RADIUS + RISE_ICON / 2;
}

function hiddenIcon(id: string, lane: number): RiseIconFrame {
  return { id, centerY: RISE_ICON, lane, opacity: 0, ripple: false, rippleAge: -1, visible: false, whole: false, crossesSun: crossesSun(lane) };
}

function iconAt(source: RiseSource, index: number, t: number, reduced: boolean): RiseIconFrame {
  const lane = laneFor(index);
  const reveal = riseRevealAt(index);
  if (reduced) {
    if (t < reveal) return hiddenIcon(source.id, lane);
    const age = t - reveal;
    if (age > RISE_REDUCED_HOLD_S) return hiddenIcon(source.id, lane);
    // Visible on the reveal frame itself, then faded out before the hold ends.
    const opacity = age < 0.25 ? Math.max(age / 0.25, 0.001) : age > 1 ? Math.max(0, 1 - (age - 1) / 0.5) : 1;
    // Whole mark, sitting just above the water. Nothing is left cut off.
    const centerY = -(RISE_ICON / 2 + RISE_PITCH);
    return { id: source.id, centerY, lane, opacity, ripple: false, rippleAge: -1, visible: opacity > 0, whole: true, crossesSun: crossesSun(lane) };
  }
  const centerY = (reveal - t) * RISE_SPEED;
  const half = RISE_ICON / 2;
  // Entirely below the waterline: not drawn. No underwater smudge, no reflection.
  if (centerY > half) return hiddenIcon(source.id, lane);
  const above = -centerY;
  if (above >= RISE_PEAK) return hiddenIcon(source.id, lane);
  const fadeStart = RISE_PEAK - RISE_FADE_S * RISE_SPEED;
  const opacity = above <= fadeStart ? 1 : Math.max(0, 1 - (above - fadeStart) / (RISE_PEAK - fadeStart));
  const emergedFor = t - (reveal - half / RISE_SPEED);
  // The ring lasts 0.6s from the moment the icon breaks the water, which is
  // long enough for the full mark to clear the horizon while the ring is still on.
  const ripple = emergedFor >= 0 && emergedFor <= RISE_RIPPLE_S;
  const whole = centerY + half <= 0;
  return {
    id: source.id,
    centerY,
    lane,
    opacity,
    ripple,
    rippleAge: ripple ? emergedFor : -1,
    visible: opacity > 0,
    whole,
    crossesSun: crossesSun(lane),
  };
}

/**
 * Dawn progress while the brief builds. It opens from dark and keeps moving
 * past two minutes. It does not jump to the brief.
 */
export function riseDawnProgress(t: number, readyAt: number | null): number {
  const held = 0.62 * (1 - Math.exp(-Math.max(0, t) / 6));
  if (readyAt == null || t < readyAt) return held;
  const fade = Math.min(1, Math.max(0, (t - readyAt) / RISE_CROSSFADE_S));
  return held + (1 - held) * fade;
}

export function riseFrame(
  elapsed: number,
  sources: readonly RiseSource[],
  opts: { reducedMotion?: boolean; readyAt?: number | null; companies?: readonly RiseCompany[] } = {},
): RiseFrame {
  const t = Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0;
  const reduced = opts.reducedMotion === true;
  const readyAt = opts.readyAt ?? null;
  const companies = opts.companies ?? [];
  const counts = emptyCounts();
  const cards: RiseCardFrame[] = [];
  const icons: RiseIconFrame[] = [];
  sources.forEach((source, index) => {
    icons.push(iconAt(source, index, t, reduced));
    if (t + 1e-9 < riseRevealAt(index)) return;
    if (source.failed) {
      cards.push({
        id: source.id,
        label: source.label,
        text: source.failureLine?.trim() || `${source.label} could not be read.`,
        detail: "",
        failed: true,
      });
      return;
    }
    addCounts(counts, source.counts);
    cards.push({ id: source.id, label: source.label, text: source.finding, detail: source.detail?.trim() ?? "", failed: false });
  });
  const companiesLine = riseCompaniesLine(companies);
  const briefOpacity = readyAt == null ? 0 : Math.min(1, Math.max(0, (t - readyAt) / RISE_CROSSFADE_S));
  return {
    elapsed: t,
    countText: formatRiseCount(counts),
    cards,
    icons,
    briefOpacity,
    building: readyAt == null || briefOpacity < 1,
    companiesLine,
    companyGate: companiesLine.includes(GATE) || cards.some((card) => card.text.includes(GATE)),
  };
}

/** Sources for the welcome edition: sessions, then one mark per company. Zero companies stays a getting-started brief. */
export function welcomeRiseSources(companies: readonly { id: string; name: string; failed?: boolean }[]): RiseSource[] {
  const sources: RiseSource[] = [
    { id: "sessions", label: "Sessions", icon: "sessions", counts: { sessions: 1 }, finding: "Reading your sessions" },
  ];
  if (companies.length === 0) {
    sources.push({
      id: "start",
      label: "Getting started",
      icon: "start",
      counts: {},
      finding: "Your brief starts here, before you join a company.",
    });
    return sources;
  }
  for (const company of companies) {
    sources.push({
      id: company.id,
      label: company.name,
      icon: "company",
      counts: company.failed ? {} : { sessions: 1 },
      finding: `Reading ${company.name}`,
      failed: company.failed === true,
      ...(company.failed ? { failureLine: `${company.name} could not be read.` } : {}),
    });
  }
  return sources;
}

/** Round 11b welcome copy for the rise page. */
export const RISE_CRUMB = "Home / Your Daily Brief";
export const RISE_EYEBROW = "Your welcome edition · Taking shape";
export const RISE_HEADLINE = "Your day is coming into focus.";
export const RISE_SUB = "Your agent is finding the threads that matter.";
export const RISE_READING = "Reading your sources";

/** "Saturday, October 17" in the person's locale order, English names. */
export function riseDateLine(now: Date): string {
  return now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}

/** "8 sec elapsed", then "2 min elapsed" past a minute. */
export function riseElapsedText(t: number): string {
  const s = Number.isFinite(t) ? Math.max(0, Math.floor(t)) : 0;
  if (s < 60) return `${s} sec elapsed`;
  return `${Math.floor(s / 60)} min elapsed`;
}

/** What the agent is reading now: the latest source to come up, or the first before any has. */
export function riseStepLine(t: number, sources: readonly RiseSource[]): string {
  if (sources.length === 0) return RISE_READING;
  let index = 0;
  sources.forEach((_, i) => {
    if (t + 1e-9 >= riseRevealAt(i)) index = i;
  });
  const source = sources[index]!;
  const label = source.label.trim();
  if (!label || /sessions?$/i.test(label)) return "Reading your sessions";
  if (source.icon === "start") return "Getting your brief started";
  if (source.icon === "company") return `Reading ${label}`;
  if ((source.counts.sessions ?? 0) > 0) return `Reading your ${label} sessions`;
  return `Reading your ${label.toLowerCase()}`;
}

/** The rise's shortest stage: below this the page scrolls instead of squeezing the sky. */
export const RISE_MIN_HEIGHT = 560;
/** The round 11b stage height the offsets below were drawn at. */
export const RISE_DESIGN_HEIGHT = 780;

export interface RiseGeometry {
  /** Side inset, px. */
  pad: number;
  /** Text and offset scale against the design height, never above 1. */
  scale: number;
  headerTop: number;
  heroTop: number;
  /** Headline size, px. */
  headline: number;
  /** Top of the invite (connect) slot, under the headline. */
  inviteTop: number;
  /** The waterline, px from the top, on the 8 px pitch. */
  horizon: number;
  /** Space kept under the progress block, px. */
  bottom: number;
}

/**
 * Where the rise puts its parts in a stage of this size. Everything follows
 * the stage: offsets scale with its height (floored at RISE_MIN_HEIGHT) and
 * the side inset with its width, so the sky fits the window at any size.
 */
export function riseGeometry(width: number, height: number): RiseGeometry {
  const w = Number.isFinite(width) && width > 0 ? width : 0;
  const h = Math.max(RISE_MIN_HEIGHT, Number.isFinite(height) ? height : 0);
  const scale = Math.min(1, h / RISE_DESIGN_HEIGHT);
  // The horizon keeps its share of a taller stage too, up to 40% more sky.
  const sky = Math.min(1.4, h / RISE_DESIGN_HEIGHT);
  return {
    pad: w ? Math.round(Math.min(52, Math.max(24, w * 0.05))) : 52,
    scale,
    headerTop: Math.round(29 * scale),
    heroTop: Math.round(92 * scale),
    headline: Math.round(56 * scale),
    inviteTop: Math.round(300 * scale),
    horizon: Math.round((320 * sky) / RISE_PITCH) * RISE_PITCH,
    bottom: Math.round(32 * scale),
  };
}

/** Where the striped sea ends: just above the progress block, no longer than the design's run under a taller sky. */
export function riseSeaBottom(horizon: number, readoutTop: number): number {
  const longest = horizon + 224;
  if (!Number.isFinite(readoutTop) || readoutTop <= 0) return longest;
  return Math.max(horizon + 48, Math.min(longest, readoutTop - 14));
}

/** What the rise reports back to its host: the geometry plus the progress block's measured height. */
export interface RiseLayout extends RiseGeometry {
  /** Height of the progress block (status, meter, findings), px. */
  readout: number;
}

/** Space between the invite slot's content and the progress block, px. */
export const RISE_INVITE_GAP = 24;

/**
 * The shortest stage that fits the invite slot's content and the progress
 * block (plus `clear` px of content in the slot and under the block) without
 * overlap. The invite top and the bottom inset scale with the height up to
 * the design height, so below it the height is solved for that scale. Depends
 * only on the content, never on the stage's own height, so it cannot feed
 * back into itself.
 */
export function riseMinHeight(clear: number): number {
  const c = (Number.isFinite(clear) && clear > 0 ? clear : 0) + RISE_INVITE_GAP;
  const scaled = 300 + 32;
  let h = c / (1 - scaled / RISE_DESIGN_HEIGHT);
  if (h >= RISE_DESIGN_HEIGHT) h = scaled + c;
  // Two px for the rounding in riseGeometry.
  return Math.max(RISE_MIN_HEIGHT, Math.ceil(h) + 2);
}
