// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import DailyBrief from "./DailyBrief.svelte";
import { empty } from "./brief-catalogue-fixtures.js";
import { octoberEightBrief } from "./brief-fixture.js";
import { generateBrief } from "./brief-generate.js";
import type { BriefInput, BriefShipped } from "./brief-types.js";

const INDIGO = "cmp_indigo";
let app: ReturnType<typeof mount> | null = null;
let target: HTMLElement;

function render(input: BriefInput) {
  target = document.createElement("div");
  document.body.appendChild(target);
  app = mount(DailyBrief, { target, props: { input, companies: [{ uid: INDIGO, label: "Indigo", iconUrl: null }] } });
  flushSync();
}
const q = (sel: string) => target.querySelector<HTMLElement>(sel);
const qa = (sel: string) => [...target.querySelectorAll<HTMLElement>(sel)];
async function hover(el: Element): Promise<void> {
  el.dispatchEvent(new MouseEvent("mouseenter"));
  await new Promise((r) => setTimeout(r, 260));
  flushSync();
}
const card = () => q('[data-widget="shipped"]')!;
const text = (el: Element | null) => el?.textContent?.replace(/\s+/g, " ").trim() ?? "";

afterEach(() => {
  if (app) unmount(app);
  app = null;
  target?.remove();
});

const merged = (label: string) => ({ label, state: "MERGED", tone: "ok" as const });
function row(repo: string, labels: string[], extra: Partial<BriefShipped> = {}): BriefShipped {
  return { id: `ship:${repo}`, title: repo, status: `${labels.length} merged`, note: "nothing open", origin: { companyUid: INDIGO, repo: `indigoai-us/${repo}` }, lines: labels.map(merged), ...extra };
}

/** A Thursday with only shipped work: the picker gives it template 2, so the card renders at L (3x2). */
function shippedOnly(): BriefInput {
  return {
    ...empty("2026-10-08T07:42:00.000Z", "2026-10-08"),
    shipped: [
      row("hq-desktop-app", ["1501 Wait for Apple dev tools", "1504 feat(cards): rich card icons", "1506 fix(login): login item for installed HQ only", "1553 Release 0.11.3"]),
      row("hq-core-staging", ["1220 chore(v16): remove /plan stub", "1217 feat(conduct): on by default in v16", "1204 fix(grok): cover the 1.0.40+ hook contract"]),
      row("hq-pro", ["4890 feat(api): keys stay inside their company"], { first: true, mergeHoursMedian: 3.33 }),
      row("hq-pro-agents", ["1132 fix(disk): prune fleet disks"]),
      row("hq-cloud", ["913 fix(sync): cloud-only placeholders"]),
      row("hq-deploy", ["200 Preview pass: short-lived viewer links"]),
      row("hq-cli", ["55 feat(storage): hq storage status and prune"]),
    ],
    merged: 12,
    opened: 4,
  };
}

describe("BriefShipped", () => {
  it("at L: one glass tile per product with its logo and human name, five tiles then +N more, two plain highlight lines, FIRST on the first", () => {
    const input = shippedOnly();
    const plan = generateBrief(input);
    const w = plan.widgets.find((x) => x.kind === "shipped")!;
    expect([w.cols, w.rows]).toEqual([3, 2]);
    render(input);
    const tiles = qa('[data-testid="brief-shipped-tile"]');
    expect(tiles).toHaveLength(5);
    expect(text(q('[data-testid="brief-shipped-more"]'))).toBe("+2 more");
    // Products, never repo short names; the first-of-its-kind ship leads, then the most merged, then the name.
    const labels = tiles.map((t) => text(t.querySelector('[data-testid="brief-origin-label"]')));
    expect(labels).toEqual(["HQ Pro", "Desktop app", "HQ core", "CLI", "Deploy"]);
    for (const l of labels) expect(l).not.toMatch(/^hq-|indigoai-us/);
    expect(tiles.map((t) => text(t.querySelector('[data-testid="brief-shipped-headline"]')))).toEqual(["1 merged", "4 merged", "3 merged", "1 merged", "1 merged"]);
    // Company logo on every tile.
    for (const t of tiles) expect(t.querySelector('[data-testid="brief-logo"]')).not.toBeNull();
    // FIRST foil only where earned.
    expect(qa('[data-testid="brief-shipped-first"]')).toHaveLength(1);
    expect(tiles[0]!.querySelector('[data-testid="brief-shipped-first"]')).not.toBeNull();
    // Two highlight lines at L, in plain words: no PR numbers, no conventional prefixes, no repo slugs on the face.
    const desk = tiles[1]!;
    expect([...desk.querySelectorAll('[data-testid="brief-shipped-highlight"]')].map(text)).toEqual(["Rich card icons", "Login item for installed HQ only"]);
    expect(text(card())).not.toMatch(/#\d+|\b\d{3,4}\b\s|\b(feat|fix|chore|docs)\(|indigoai-us|hq-core-staging/);
    // Totals keep the sweep's numbers.
    expect(text(card())).toContain("merged");
    expect(text(card())).toContain("opened");
  });

  it("tile peek: product chip, headline, mix, 'a first', highlights, release and median pace", async () => {
    render(shippedOnly());
    const tiles = qa('[data-testid="brief-shipped-tile"]');
    await hover(tiles[0]!);
    let peek = q('[data-testid="brief-peek"]')!;
    expect(text(peek.querySelector('[data-testid="brief-peek-eyebrow"]'))).toBe("Shipped · yesterday");
    expect(text(peek.querySelector('[data-testid="brief-peek-origin"]'))).toContain("HQ Pro");
    expect(text(peek)).toContain("HQ Pro · 1 merged");
    expect(text(peek)).toContain("1 feature · a first");
    expect(text(peek)).toContain("Keys stay inside their company");
    expect(text(peek)).toContain("Median 3h 20m from open to merge");
    expect(text(peek)).not.toMatch(/4890|feat\(/);
    tiles[0]!.dispatchEvent(new MouseEvent("mouseleave"));
    await hover(tiles[1]!);
    peek = q('[data-testid="brief-peek"]')!;
    expect(text(peek)).toContain("Desktop app · 4 merged");
    expect(text(peek)).toContain("Release 0.11.3");
    expect(text(peek)).toContain("RELEASE");
    expect(text(peek)).not.toContain("Median");
  });

  it("+N more peeks the remaining products with their counts", async () => {
    render(shippedOnly());
    await hover(q('[data-testid="brief-shipped-more"]')!);
    const peek = q('[data-testid="brief-peek"]')!;
    expect(text(peek)).toContain("2 more products");
    const lines = [...peek.querySelectorAll('[data-testid="brief-peek-line"]')].map((l) => [text(l.querySelector("div")), text(l.querySelector("span"))]);
    expect(lines).toEqual([
      ["Fleet", "1 merged"],
      ["HQ Cloud", "1 merged"],
    ]);
  });

  it("on the Oct 8 fixture (one-row W slot) the card shows two product tiles, one highlight line each at most, and folds the rest", () => {
    const input = { ...octoberEightBrief(new Date(2026, 9, 8, 7, 42)), today: "2026-10-08" };
    const w = generateBrief(input).widgets.find((x) => x.kind === "shipped")!;
    expect(w.rows).toBe(1);
    render(input);
    const tiles = qa('[data-testid="brief-shipped-tile"]');
    expect(tiles).toHaveLength(w.cols >= 3 ? 3 : 2);
    // Tiles fill the card's height, so each shows what was worth knowing (one line on a two-column card).
    for (const t of tiles) expect(t.querySelectorAll('[data-testid="brief-shipped-highlight"]').length).toBeLessThanOrEqual(w.cols >= 3 ? 2 : 1);
    const products = new Set(input.shipped.map((s) => s.origin.repo));
    expect(text(q('[data-testid="brief-shipped-more"]'))).toBe(`+${products.size - tiles.length} more`);
    const labels = tiles.map((t) => text(t.querySelector('[data-testid="brief-origin-label"]')));
    expect(labels[0]).toBe("Desktop app");
    for (const l of labels) expect(l).not.toMatch(/^hq-/);
    expect(text(card())).not.toMatch(/#\d+|\b(feat|fix|chore)\(/);
  });

  it("with totals but no rows the card says so instead of leaving a hole", () => {
    render({ ...shippedOnly(), shipped: [], merged: 3 });
    expect(q('[data-testid="brief-shipped-empty"]')).not.toBeNull();
    expect(qa('[data-testid="brief-shipped-tile"]')).toHaveLength(0);
  });
});
