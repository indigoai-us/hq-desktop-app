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
  finding: string;
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
  visible: boolean;
  /** True when the 60 px icon would intersect the sun disc. */
  crossesSun: boolean;
}

export interface RiseCardFrame {
  id: string;
  text: string;
  failed: boolean;
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
  return { id, centerY: RISE_ICON, lane, opacity: 0, ripple: false, visible: false, crossesSun: crossesSun(lane) };
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
    return { id: source.id, centerY: 0, lane, opacity, ripple: false, visible: opacity > 0, crossesSun: crossesSun(lane) };
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
  const ripple = emergedFor >= 0 && emergedFor <= RISE_RIPPLE_S && centerY > -RISE_CELL;
  return { id: source.id, centerY, lane, opacity, ripple, visible: opacity > 0, crossesSun: crossesSun(lane) };
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
      cards.push({ id: source.id, text: source.failureLine?.trim() || `${source.label} could not be read.`, failed: true });
      return;
    }
    addCounts(counts, source.counts);
    cards.push({ id: source.id, text: source.finding, failed: false });
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
