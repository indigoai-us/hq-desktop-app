// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import Host from "./fixtures/BriefReleaseTrainHost.svelte";
import {
  CAR_CAP,
  HELD_CAP,
  ageLabel,
  carLabel,
  carTitles,
  dayLong,
  dayShort,
  dueReleases,
  healthFor,
  localDay,
  releaseKey,
  releasePrompt,
  trainCars,
  trainFooter,
  trainLight,
  trainSub,
  trainTitle,
  whyNotGreenLines,
} from "./brief-release-train.js";
import type { BriefMainHealth, BriefRelease } from "./brief-types.js";

const NOW = "2026-10-11T14:54:00.000Z"; // a Sunday
const TODAY = "2026-10-11";
const nowMs = Date.parse(NOW);
const hoursAgo = (h: number) => new Date(nowMs - h * 3_600_000).toISOString();
const INDIGO = "cmp_indigo";

/** Twelve changes over six days, three held, the writer's light amber. */
function desktop(extra: Partial<BriefRelease> = {}): BriefRelease {
  return {
    product: "Desktop app",
    version: "1.4",
    origin: { companyUid: INDIGO, repo: "indigoai-us/hq-desktop-app", product: "Desktop app" },
    releasedAt: hoursAgo(70),
    pending: [
      { day: "2026-10-08", count: 4, theme: "onboarding fixes" },
      { day: "2026-10-05", count: 3, theme: "sync" },
      { day: "2026-10-06", count: 2, theme: "" },
      { day: "2026-10-07", count: 1, theme: "settings" },
      { day: "2026-10-09", count: 1, theme: "brief" },
      { day: "2026-10-10", count: 1, theme: "runs page" },
    ],
    pendingCount: 12,
    held: [
      { title: "Docs release", why: "The docs describe the new onboarding; they go out with it." },
      { title: "Pricing page copy", why: "Waits on the settings change." },
      { title: "Sync announcement", why: "Needs the fix live first." },
    ],
    light: "warn",
    ...extra,
  };
}

const HEALTH: BriefMainHealth[] = [
  { repo: "indigoai-us/hq-desktop-app", product: "Desktop app", companyUid: INDIGO, workflows: 6, red: [] },
  { repo: "indigoai-us/hq-core-staging", product: "HQ core", companyUid: INDIGO, workflows: 18, red: [{ workflow: "release gate", since: hoursAgo(48), mergesOnTop: 3 }] },
  { repo: "indigoai-us/hq-cloud", product: null, companyUid: INDIGO, workflows: 4, red: [] },
];
const RED_DESKTOP: BriefMainHealth[] = [
  { repo: "indigoai-us/hq-desktop-app", product: "Desktop app", companyUid: INDIGO, workflows: 6, red: [{ workflow: "release gate", since: hoursAgo(48), mergesOnTop: 2 }] },
  ...HEALTH.slice(1),
];

const SHA_OR_PR = /\b[0-9a-f]{7,40}\b|#\d+|\bPR\s*\d+/i;

describe("release train gate (mirrors the catalogue)", () => {
  it("is hidden with two pending changes under a day and nothing held", () => {
    const quiet = desktop({ pending: [{ day: TODAY, count: 2, theme: "fixes" }], pendingCount: 2, held: [], releasedAt: hoursAgo(10) });
    expect(dueReleases([quiet], nowMs)).toEqual([]);
    expect(dueReleases(undefined, nowMs)).toEqual([]);
  });

  it("is due at three pending changes, at anything held, or when the last release is over a day old", () => {
    const base = { pending: [{ day: TODAY, count: 1, theme: "" }], pendingCount: 1, held: [], releasedAt: hoursAgo(10) };
    expect(dueReleases([desktop({ ...base, pendingCount: 3 })], nowMs)).toHaveLength(1);
    expect(dueReleases([desktop({ ...base, held: [{ title: "Docs", why: "" }] })], nowMs)).toHaveLength(1);
    expect(dueReleases([desktop({ ...base, releasedAt: hoursAgo(30) })], nowMs)).toHaveLength(1);
    expect(dueReleases([desktop({ ...base, releasedAt: null })], nowMs)).toHaveLength(0);
    expect(dueReleases([desktop({ ...base, releasedAt: "not a date" })], nowMs)).toHaveLength(0);
  });
});

describe("days and cars", () => {
  it("names days by arithmetic: today, yesterday, a weekday inside the week, else month and day", () => {
    expect(dayShort(TODAY, TODAY)).toBe("today");
    expect(dayShort("2026-10-10", TODAY)).toBe("yesterday");
    expect(dayShort("2026-10-08", TODAY)).toBe("Thu");
    expect(dayShort("2026-10-05", TODAY)).toBe("Mon");
    expect(dayShort("2026-10-03", TODAY)).toBe("Oct 3");
    expect(dayShort("2026-10-08T15:00:00Z", TODAY)).toBe("Thu");
    expect(dayShort("last week", TODAY)).toBe("last week");
    expect(dayLong("2026-10-08", TODAY)).toBe("Thursday");
    expect(dayLong("2026-10-01", TODAY)).toBe("Oct 1");
    expect(localDay("2026-10-11T09:00:00")).toBe("2026-10-11");
    expect(localDay("junk")).toBe("");
  });

  it("orders cars oldest first and labels them by day, count and theme, never by SHA or PR number", () => {
    const cars = trainCars(desktop());
    expect(cars.map((c) => c.day)).toEqual(["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10"]);
    expect(carLabel(cars[3]!, TODAY)).toBe("Thu · 4 changes · onboarding fixes");
    expect(carLabel(cars[1]!, TODAY)).toBe("Tue · 2 changes");
    expect(carLabel({ day: "2026-10-09", count: 1, theme: "brief" }, TODAY)).toBe("Fri · 1 change · brief");
    for (const c of cars) expect(carLabel(c, TODAY)).not.toMatch(SHA_OR_PR);
  });

  it("turns a car's titles into plain to-dos, five at most, and counts the rest", () => {
    const titles = ["hq-desktop-app #1217: feat(brief): add the release train", "fix(sync): retry on 502", "docs: cli reference", "chore: bump", "feat: runs page", "fix: typo", "feat: seventh"];
    const t = carTitles({ day: TODAY, count: 7, theme: "", titles });
    expect(t.lines.map((l) => l.label)).toEqual(["Add the release train", "Retry on 502", "Cli reference", "Bump", "Runs page"]);
    expect(t.lines).toHaveLength(CAR_CAP);
    expect(t.more).toBe(2);
    for (const l of t.lines) expect(l.label).not.toMatch(SHA_OR_PR);
    expect(carTitles({ day: TODAY, count: 2, theme: "" })).toEqual({ lines: [], more: 0 });
  });
});

describe("title, light and footer", () => {
  it("h3 is verb-first and under eight words; the sub carries the count, the wait and the held", () => {
    const title = trainTitle(desktop());
    expect(title).toBe("Cut the Desktop app release");
    expect(title.split(/\s+/).length).toBeLessThanOrEqual(8);
    expect(title).toMatch(/^Cut /);
    expect(trainSub(desktop(), TODAY)).toBe("12 changes waiting since Monday · 3 held");
    expect(trainSub(desktop({ held: [] }), TODAY)).toBe("12 changes waiting since Monday");
    expect(trainSub(desktop({ pending: [{ day: TODAY, count: 3, theme: "" }], pendingCount: 3, held: [] }), TODAY)).toBe("3 changes merged today");
    expect(trainSub(desktop({ pending: [], pendingCount: 0 }), TODAY)).toBe("Nothing merged since 1.4 · 3 held");
    expect(trainSub(desktop({ pending: [], pendingCount: 0, version: null, held: [{ title: "Docs", why: "" }] }), TODAY)).toBe("Nothing merged since the last release · 1 held");
  });

  it("the light is red only when a check on main is red for this product, else the writer's light", () => {
    expect(trainLight(desktop(), HEALTH)).toBe("warn");
    expect(trainLight(desktop({ light: "ok" }), HEALTH)).toBe("ok");
    expect(trainLight(desktop(), RED_DESKTOP)).toBe("red");
    expect(trainLight(desktop({ light: "red" }), [])).toBe("red");
    expect(trainLight(desktop(), undefined)).toBe("warn");
    // hq-core and hq-core-staging are both "HQ core": a red staging gate colours an HQ core release.
    const core = desktop({ product: "HQ core", origin: { companyUid: INDIGO, repo: "indigoai-us/hq-core", product: "HQ core" } });
    expect(healthFor(core, HEALTH).map((m) => m.repo)).toEqual(["indigoai-us/hq-core-staging"]);
    expect(trainLight(core, HEALTH)).toBe("red");
  });

  it("the footer is plain and names the red check, its product and age", () => {
    expect(trainFooter(desktop(), RED_DESKTOP, nowMs)).toBe("Red: release gate on Desktop app · 2 days");
    expect(trainFooter(desktop({ light: "red" }), [], nowMs)).toBe("Red: a check on main is red");
    expect(trainFooter(desktop(), HEALTH, nowMs)).toBe("Amber: waiting on your cut");
    expect(trainFooter(desktop({ light: "ok" }), HEALTH, nowMs)).toBe("Green: ready to cut");
    expect(ageLabel(hoursAgo(0.5), nowMs)).toBe("under an hour");
    expect(ageLabel(hoursAgo(5), nowMs)).toBe("5h");
    expect(ageLabel(hoursAgo(47), nowMs)).toBe("47h");
    expect(ageLabel(hoursAgo(72), nowMs)).toBe("3 days");
    expect(ageLabel(null, nowMs)).toBeNull();
    expect(ageLabel("nope", nowMs)).toBeNull();
  });

  it("Why not green lists main health per product, red first, as GREEN or RED", () => {
    const lines = whyNotGreenLines(HEALTH);
    expect(lines.map((l) => [l.label, l.state, l.tone])).toEqual([
      ["HQ core · release gate", "RED", "red"],
      ["Desktop app", "GREEN", "ok"],
      ["HQ Cloud", "GREEN", "ok"],
    ]);
    expect(whyNotGreenLines([])).toEqual([]);
  });

  it("writes a cut prompt that names the product, the wait, the held work and the guard, with no SHA or PR number", () => {
    const p = releasePrompt(desktop(), RED_DESKTOP, nowMs, TODAY);
    expect(p).toMatch(/^Cut the Desktop app release\. The last release was 1\.4\. 12 changes are merged and waiting, the oldest from Monday\./);
    expect(p).toContain("Held until it ships: Docs release; Pricing page copy; Sync announcement.");
    expect(p).toContain("A check on main is red (release gate on Desktop app)");
    expect(p).toContain("Repo: indigoai-us/hq-desktop-app.");
    expect(p).toMatch(/confirm with me before any irreversible step/);
    expect(p).not.toMatch(SHA_OR_PR);
    expect(releasePrompt(desktop({ light: "warn" }), HEALTH, nowMs, TODAY)).not.toContain("A check on main is red");
    expect(releaseKey(desktop())).toBe("release:Desktop app");
  });
});

// ---------------------------------------------------------------------------
// Rendered card
// ---------------------------------------------------------------------------

let app: ReturnType<typeof mount> | null = null;
let target: HTMLElement;

function render(props: Record<string, unknown> = {}) {
  target = document.createElement("div");
  document.body.appendChild(target);
  app = mount(Host, {
    target,
    props: { releases: [desktop()], mainHealth: HEALTH, prompts: {}, cols: 3, rows: 1, now: NOW, today: TODAY, companies: [{ uid: INDIGO, label: "Indigo", iconUrl: null }], ...props },
  });
  flushSync();
}
const q = (sel: string) => target.querySelector<HTMLElement>(sel);
const qa = (sel: string) => [...target.querySelectorAll<HTMLElement>(sel)];
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
async function hover(el: Element): Promise<void> {
  el.dispatchEvent(new MouseEvent("mouseenter"));
  await new Promise((r) => setTimeout(r, 260));
  flushSync();
}
/** "label state" per peek line (the two cells are adjacent elements with no whitespace between them). */
const peekLines = () => qa('[data-testid="brief-peek-line"]').map((li) => [text(li.querySelector("div")), text(li.querySelector("span"))].filter(Boolean).join(" "));

afterEach(() => {
  if (app) unmount(app);
  app = null;
  target?.remove();
});

describe("BriefReleaseTrain", () => {
  it("renders the eyebrow, a verb-first title, the sub, the engine with an amber light, the company logo and the plain footer", () => {
    render();
    const card = q('[data-testid="brief-release-train"]')!;
    expect(card).not.toBeNull();
    expect(card.classList.contains("w")).toBe(true);
    expect(card.className).not.toMatch(/\bc-/);
    expect(card.getAttribute("data-light")).toBe("warn");
    expect(text(q(".eyebrow"))).toBe("Ready to release");
    expect(text(q('[data-testid="brief-release-title"]'))).toBe("Cut the Desktop app release");
    expect(text(q('[data-testid="brief-release-sub"]'))).toBe("12 changes waiting since Monday · 3 held");
    expect(text(q('[data-testid="brief-release-engine"]'))).toBe("Desktop app next after 1.4");
    expect(q('[data-testid="brief-release-light"]')!.classList.contains("warn")).toBe(true);
    expect(q('[data-testid="brief-release-light"]')!.classList.contains("blink")).toBe(true);
    expect(q('[data-testid="brief-origin"]')).not.toBeNull();
    expect(text(q('[data-testid="brief-origin-label"]'))).toBe("Desktop app");
    expect(text(q('[data-testid="brief-release-foot"]'))).toBe("Amber: waiting on your cut");
    expect(text(q('[data-testid="brief-release-why"]'))).toBe("Why not green");
    expect(text(q('[data-testid="brief-release-cut"] .cutlbl'))).toBe("Cut release in");
    expect(text(q('[data-testid="brief-start"]'))).toBe("Claude");
    expect(text(card)).not.toMatch(SHA_OR_PR);
  });

  it("caps the cars at five with a +N more car whose peek lists the rest, oldest first", async () => {
    render();
    const cars = qa('[data-testid="brief-release-car"]');
    expect(cars).toHaveLength(CAR_CAP);
    expect(cars.map((c) => c.getAttribute("aria-label"))).toEqual([
      "Mon · 3 changes · sync",
      "Tue · 2 changes",
      "Wed · 1 change · settings",
      "Thu · 4 changes · onboarding fixes",
      "Fri · 1 change · brief",
    ]);
    const more = q('[data-testid="brief-release-car-more"]')!;
    expect(text(more)).toBe("+1 more");
    await hover(more);
    expect(text(q('[data-testid="brief-peek"] .ttl'))).toBe("1 more day");
    expect(peekLines()).toEqual(["yesterday · 1 change · runs page"]);
  });

  it("a narrow one-row slot shows three cars; a two-row slot stacks the rail and shows five", () => {
    render({ cols: 2, rows: 1 });
    expect(qa('[data-testid="brief-release-car"]')).toHaveLength(3);
    expect(text(q('[data-testid="brief-release-car-more"]'))).toBe("+3 more");
    expect(q('[data-testid="brief-release-rail"]')!.classList.contains("vertical")).toBe(false);
    if (app) unmount(app);
    render({ cols: 2, rows: 2 });
    expect(qa('[data-testid="brief-release-car"]')).toHaveLength(5);
    expect(q('[data-testid="brief-release-rail"]')!.classList.contains("vertical")).toBe(true);
    expect(q('[data-testid="brief-release-train"]')!.classList.contains("tall")).toBe(true);
  });

  it("held work sits in dashed boxes under the rail, two at most, then +N more held with a peek", async () => {
    render();
    const held = qa('[data-testid="brief-release-held"]');
    expect(held).toHaveLength(HELD_CAP);
    expect(held.map((h) => h.getAttribute("aria-label"))).toEqual(["Docs release", "Pricing page copy"]);
    expect(text(held[0]!)).toBe("Docs release held until this ships");
    const more = q('[data-testid="brief-release-held-more"]')!;
    expect(text(more)).toBe("+1 more held");
    await hover(more);
    expect(peekLines()).toEqual(["Sync announcement"]);
    if (app) unmount(app);
    render({ releases: [desktop({ held: [] })] });
    expect(q('[data-testid="brief-release-siding"]')).toBeNull();
  });

  it("a held box's peek quotes why it is held", async () => {
    render();
    await hover(q('[data-testid="brief-release-held"]')!);
    const peek = q('[data-testid="brief-peek"]')!;
    expect(text(peek.querySelector(".ttl"))).toBe("Docs release");
    expect(text(peek)).toContain("Held until this release ships");
    expect(text(peek)).toContain("The docs describe the new onboarding; they go out with it.");
  });

  it("takes the light from main health: a red check on the product turns it red and the footer names it", () => {
    render({ mainHealth: RED_DESKTOP });
    expect(q('[data-testid="brief-release-train"]')!.getAttribute("data-light")).toBe("red");
    expect(q('[data-testid="brief-release-light"]')!.classList.contains("red")).toBe(true);
    expect(q('[data-testid="brief-release-light"]')!.classList.contains("blink")).toBe(false);
    expect(text(q('[data-testid="brief-release-foot"]'))).toBe("Red: release gate on Desktop app · 2 days");
  });

  it("Why not green peeks main health per product as GREEN or RED, red first", async () => {
    render();
    await hover(q('[data-testid="brief-release-why"]')!);
    expect(text(q('[data-testid="brief-peek"] .ttl'))).toBe("Why not green");
    expect(peekLines()).toEqual(["HQ core · release gate RED", "Desktop app GREEN", "HQ Cloud GREEN"]);
    const tones = qa('[data-testid="brief-peek-line"] span').map((s) => ["tone-red", "tone-ok", "tone-warn", "tone-neutral"].find((t) => s.classList.contains(t)));
    expect(tones).toEqual(["tone-red", "tone-ok", "tone-ok"]);
  });

  it("a green release says Main health instead of Why not green", () => {
    render({ releases: [desktop({ light: "ok" })], mainHealth: [HEALTH[0]!] });
    expect(text(q('[data-testid="brief-release-why"]'))).toBe("Main health");
    expect(text(q('[data-testid="brief-release-foot"]'))).toBe("Green: ready to cut");
    expect(q('[data-testid="brief-release-light"]')!.classList.contains("blink")).toBe(false);
  });

  it("a car's peek shows plain change titles when the sweep wrote them, else the day's count and theme", async () => {
    const withTitles = desktop();
    (withTitles.pending[0] as { titles?: string[] }).titles = ["hq-desktop-app #1301: feat(brief): add the release train", "fix(sync): retry on 502"];
    render({ releases: [withTitles] });
    // pending[0] is Oct 8 (Thursday), the fourth car once sorted.
    await hover(qa('[data-testid="brief-release-car"]')[3]!);
    let peek = q('[data-testid="brief-peek"]')!;
    expect(text(peek.querySelector(".ttl"))).toBe("Thursday · 4 changes");
    expect(peekLines()).toEqual(["Add the release train", "Retry on 502"]);
    expect(text(peek)).not.toMatch(SHA_OR_PR);
    peek.dispatchEvent(new MouseEvent("mouseleave"));
    await new Promise((r) => setTimeout(r, 200));
    await hover(qa('[data-testid="brief-release-car"]')[0]!);
    peek = q('[data-testid="brief-peek"]')!;
    expect(text(peek.querySelector(".ttl"))).toBe("Monday · 3 changes");
    expect(text(peek)).toContain("3 changes merged Monday, mostly sync.");
  });

  it("the engine's peek is compact with a checklist and a Cut release in Claude button", async () => {
    render();
    await hover(q('[data-testid="brief-release-engine"]')!);
    const peek = q('[data-testid="brief-peek"]')!;
    expect(peek.classList.contains("compact")).toBe(true);
    expect(text(peek.querySelector(".ttl"))).toBe("Desktop app next");
    expect(text(peek.querySelector(".st"))).toBe("Amber: waiting on your cut");
    expect(peekLines()).toEqual(["Checks on main GREEN", "Waiting to ship 12 changes", "Held behind it 3", "Last release 1.4"]);
    expect(text(q('[data-testid="brief-peek-resume"]'))).toBe("Cut release in Claude");
  });

  it("Start hands the release prompt to the launch seam: the writer's prompt first, then the release's own, then a written one", async () => {
    render({ prompts: { "release:Desktop app": "Writer prompt." } });
    q('[data-testid="brief-start"]')!.click();
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
    expect(text(q('[data-testid="brief-release-train"] .launch-note'))).toBe("Started in Claude.");
    expect(q('[data-testid="brief-release-cut"]')).toBeNull();
    if (app) unmount(app);
    // No writer prompt: the card still has one to hand over.
    render({ releases: [desktop({ prompt: undefined })] });
    await hover(q('[data-testid="brief-release-engine"]')!);
    expect(q('[data-testid="brief-peek-resume"]')).not.toBeNull();
  });

  it("shows a +N more chip when several releases are due, with a peek listing them by light", async () => {
    const cloud = desktop({ product: "HQ Cloud", version: null, origin: { companyUid: INDIGO, repo: "indigoai-us/hq-cloud", product: "HQ Cloud" }, pending: [{ day: "2026-10-09", count: 5, theme: "sync" }], pendingCount: 5, held: [], light: "ok" });
    render({ releases: [desktop(), cloud] });
    expect(qa('[data-testid="brief-release-train"]')).toHaveLength(1);
    const chip = q('[data-testid="brief-release-others"]')!;
    expect(text(chip)).toBe("+1 more");
    await hover(chip);
    expect(peekLines()).toEqual(["HQ Cloud · 5 changes GREEN"]);
  });

  it("renders nothing when no release is due", () => {
    render({ releases: [desktop({ pending: [{ day: TODAY, count: 2, theme: "fixes" }], pendingCount: 2, held: [], releasedAt: hoursAgo(10) })] });
    expect(q('[data-testid="brief-release-train"]')).toBeNull();
    if (app) unmount(app);
    render({ releases: [] });
    expect(q('[data-testid="brief-release-train"]')).toBeNull();
  });
});
