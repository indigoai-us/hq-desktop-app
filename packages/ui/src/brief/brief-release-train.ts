/**
 * Release train: what is merged for a product but not yet released, said as
 * the owner reads it. Pure helpers for BriefReleaseTrain.svelte; the gate
 * mirrors the catalogue's releaseTrain.measure so the card and the picker
 * agree on what counts. No toLocale*, no Date.now: `today` and `nowMs` are
 * inputs, weekdays come from arithmetic on YYYY-MM-DD.
 */
import { humanTitle } from "./brief-distill.js";
import { productName } from "./brief-origin.js";
import type { BriefLine, BriefMainHealth, BriefRelease } from "./brief-types.js";

export const DAY_MS = 86_400_000;
/** How many pending days the card shows before "+N more". */
export const CAR_CAP = 5;
/** How many held items sit on the siding before "+N more". */
export const HELD_CAP = 2;

export type TrainLight = BriefRelease["light"];
/** One pending day. `titles` is optional until the sweep writes them (see notes). */
export type TrainCar = BriefRelease["pending"][number] & { titles?: string[] };

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LIGHT_WORD: Record<TrainLight, string> = { ok: "Green", warn: "Amber", red: "Red" };

export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** Stable launch id for a release's prompt: `release:<product>`. */
export const releaseKey = (r: BriefRelease): string => `release:${r.product}`;

/** Day number of a YYYY-MM-DD (ISO datetimes are cut to their date part); null when it is not a date. */
function dayIndex(day: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(day.trim());
  if (!m) return null;
  return Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / DAY_MS);
}

/** The local calendar date of an ISO time, for the component's default `today`. */
export function localDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Same gate as the catalogue: a release is due when 3+ changes wait, anything
 * is held behind it, or the last release is over a day old. Order kept.
 */
export function dueReleases(releases: readonly BriefRelease[] | undefined, nowMs: number): BriefRelease[] {
  return (releases ?? []).filter((r) => {
    const at = r.releasedAt ? Date.parse(r.releasedAt) : NaN;
    return r.pendingCount >= 3 || r.held.length > 0 || (Number.isFinite(at) && nowMs - at > DAY_MS);
  });
}

/** Main-health rows about this release: same repo, or a repo whose product name matches (hq-core and hq-core-staging are both "HQ core"). */
export function healthFor(release: BriefRelease, mainHealth: readonly BriefMainHealth[] | undefined): BriefMainHealth[] {
  const repo = (release.origin.repo ?? "").toLowerCase();
  const product = release.product.trim().toLowerCase();
  return (mainHealth ?? []).filter((m) => {
    if (repo && m.repo.toLowerCase() === repo) return true;
    return productName(m.repo, m.product).trim().toLowerCase() === product;
  });
}

/** The only colour on the card: red when a check on main is red, else the writer's light (amber = waiting on a human cut, green = ready). */
export function trainLight(release: BriefRelease, mainHealth: readonly BriefMainHealth[] | undefined): TrainLight {
  if (release.light === "red") return "red";
  return healthFor(release, mainHealth).some((m) => m.red.length) ? "red" : release.light;
}

/** Pending days oldest first: cars couple in merge order behind the engine. */
export function trainCars(release: BriefRelease): TrainCar[] {
  return [...release.pending].sort((a, b) => a.day.localeCompare(b.day));
}

/** "today", "yesterday", "Thu" within the week, else "Oct 2"; a non-date comes back as is. */
export function dayShort(day: string, today: string): string {
  const d = dayIndex(day);
  const t = dayIndex(today);
  if (d == null) return day;
  const diff = t == null ? 2 : t - d;
  if (diff === 0) return "today";
  if (diff === 1) return "yesterday";
  if (diff >= 2 && diff < 7) return WEEKDAYS[(((d + 4) % 7) + 7) % 7]!.slice(0, 3);
  if (diff < 0) return WEEKDAYS[(((d + 4) % 7) + 7) % 7]!.slice(0, 3);
  return monthDay(day);
}

/** "today", "yesterday", "Thursday" within the week, else "Oct 2". */
export function dayLong(day: string, today: string): string {
  const d = dayIndex(day);
  const t = dayIndex(today);
  if (d == null) return day;
  const diff = t == null ? 2 : t - d;
  if (diff === 0) return "today";
  if (diff === 1) return "yesterday";
  if (diff >= 7) return monthDay(day);
  return WEEKDAYS[(((d + 4) % 7) + 7) % 7]!;
}

function monthDay(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(day.trim())!;
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}`;
}

/** "Thu · 7 changes · onboarding fixes". Never a SHA or a PR number: those stay in the peek, as titles. */
export function carLabel(car: TrainCar, today: string): string {
  const parts = [dayShort(car.day, today), plural(car.count, "change")];
  if (car.theme.trim()) parts.push(car.theme.trim());
  return parts.join(" · ");
}

/** h3, verb-first and under eight words: "Cut the Desktop app release". */
export function trainTitle(release: BriefRelease): string {
  return `Cut the ${release.product.trim()} release`;
}

/** The line under the title: "12 changes waiting since Thursday · 2 held". */
export function trainSub(release: BriefRelease, today: string): string {
  const parts: string[] = [];
  const oldest = trainCars(release)[0];
  if (release.pendingCount > 0) {
    const since = oldest ? dayLong(oldest.day, today) : null;
    const when = since === "today" ? " merged today" : since ? ` waiting since ${since}` : " waiting";
    parts.push(`${plural(release.pendingCount, "change")}${when}`);
  } else {
    parts.push(release.version ? `Nothing merged since ${release.version}` : "Nothing merged since the last release");
  }
  if (release.held.length) parts.push(`${release.held.length} held`);
  return parts.join(" · ");
}

/** "2 days", "5h", "under an hour"; null when the start is unknown. */
export function ageLabel(since: string | null | undefined, nowMs: number): string | null {
  if (!since) return null;
  const t = Date.parse(since);
  if (!Number.isFinite(t)) return null;
  const hours = (nowMs - t) / 3_600_000;
  if (hours < 0) return null;
  if (hours < 1) return "under an hour";
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)} days`;
}

/** The first red check behind this release, with its product and age, or null. */
export function redCheck(release: BriefRelease, mainHealth: readonly BriefMainHealth[] | undefined, nowMs: number): { workflow: string; product: string; age: string | null } | null {
  for (const m of healthFor(release, mainHealth)) {
    const r = m.red[0];
    if (r) return { workflow: r.workflow, product: productName(m.repo, m.product), age: ageLabel(r.since, nowMs) };
  }
  return null;
}

/** Footer, plain: "Red: release gate on HQ core · 2 days" | "Amber: waiting on your cut" | "Green: ready to cut". */
export function trainFooter(release: BriefRelease, mainHealth: readonly BriefMainHealth[] | undefined, nowMs: number): string {
  const light = trainLight(release, mainHealth);
  if (light === "red") {
    const red = redCheck(release, mainHealth, nowMs);
    if (!red) return "Red: a check on main is red";
    return `Red: ${red.workflow} on ${red.product}${red.age ? ` · ${red.age}` : ""}`;
  }
  if (light === "warn") return "Amber: waiting on your cut";
  return "Green: ready to cut";
}

/** "Why not green": main health per product, red first then by name; each line GREEN or RED. */
export function whyNotGreenLines(mainHealth: readonly BriefMainHealth[] | undefined): BriefLine[] {
  const rows = (mainHealth ?? []).map((m) => {
    const product = productName(m.repo, m.product);
    const red = m.red[0];
    return {
      label: red ? `${product} · ${red.workflow}` : product,
      state: red ? "RED" : "GREEN",
      tone: red ? ("red" as const) : ("ok" as const),
    };
  });
  return rows.sort((a, b) => (a.tone === b.tone ? a.label.localeCompare(b.label) : a.tone === "red" ? -1 : 1));
}

/** A car's changes as plain titles (humanTitle), five at most; `more` counts the rest. */
export function carTitles(car: TrainCar): { lines: BriefLine[]; more: number } {
  const titles = (car.titles ?? []).map((t) => humanTitle(t).text).filter(Boolean);
  return { lines: titles.slice(0, CAR_CAP).map((label) => ({ label, state: "" })), more: Math.max(0, titles.length - CAR_CAP) };
}

/** The prompt behind "Cut release in Claude" when the writer gave none. */
export function releasePrompt(release: BriefRelease, mainHealth: readonly BriefMainHealth[] | undefined, nowMs: number, today: string): string {
  const light = trainLight(release, mainHealth);
  const oldest = trainCars(release)[0];
  const since = oldest ? `, the oldest from ${dayLong(oldest.day, today)}` : "";
  const held = release.held.length ? ` Held until it ships: ${release.held.map((h) => h.title).join("; ")}.` : "";
  const red = light === "red" ? redCheck(release, mainHealth, nowMs) : null;
  const gate = light === "red" ? ` A check on main is red${red ? ` (${red.workflow} on ${red.product})` : ""}; fix it or tell me why it can ship anyway before cutting.` : "";
  const repo = release.origin.repo ? ` Repo: ${release.origin.repo}.` : "";
  const after = release.version ? ` The last release was ${release.version}.` : "";
  return (
    `Cut the ${release.product} release.${after} ${plural(release.pendingCount, "change")} ${release.pendingCount === 1 ? "is" : "are"} merged and waiting${since}.${held}${gate}${repo} ` +
    "Walk the release steps, run the checks, draft the notes in plain words, and get it ready. " +
    "Stop and confirm with me before any irreversible step (tag, publish, deploy, or sending a message)."
  );
}

/** "Red", "Amber" or "Green", for peeks and the engine's status line. */
export const lightWord = (light: TrainLight): string => LIGHT_WORD[light];
