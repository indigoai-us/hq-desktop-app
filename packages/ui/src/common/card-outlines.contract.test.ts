/**
 * Resting card outlines are invisible.
 *
 * A filled card (board card, thread row, meeting row, stat tile, chart,
 * settings card, …) keeps its 1px border so a semantic state — a selection, a
 * live meeting — can paint one without anything shifting a pixel, but at rest
 * that border is transparent: the raised fill is the edge. Hover changes the
 * fill only; a neutral hover border-color is gone. Focus-visible outlines are
 * untouched.
 *
 * On the console-rail beta two of the original surfaces were redesigned away
 * from cards: meeting rows are flat Messages-sidebar rows (no border, no fill
 * at rest), and the Library overlay's card list became the Marketplace page's
 * cover-art grid (marketplace/MarketplacePanel.svelte, a different card).
 * Meeting rows are pinned below as flat rows; the Marketplace grid is not a
 * resting-outline card and is not covered here.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function styleOf(relPath: string): string {
  const text = readFileSync(new URL(`../${relPath}`, import.meta.url), "utf8");
  return [...text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)]
    .map((m) => m[1])
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Declarations from every rule whose selector list contains `selector`. */
function decls(css: string, selector: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = m[1].split(",").map((s) => s.trim().replace(/\s+/g, " "));
    if (!selectors.includes(selector)) continue;
    for (const d of m[2].split(";")) {
      const i = d.indexOf(":");
      if (i > 0) out.push([d.slice(0, i).trim(), d.slice(i + 1).trim()]);
    }
  }
  return out;
}

const BORDER_PROPS = /^border(-(top|right|bottom|left))?(-color)?$/;
const isTransparent = (value: string) =>
  value === "transparent" || /^1px solid transparent$/.test(value) || value === "0";

type Card = {
  file: string;
  selector: string;
  hover?: string;
  focus?: string;
};

const CARDS: Card[] = [
  { file: "board/BoardView.svelte", selector: ".board-card", hover: ".board-card:hover", focus: ".board-card:focus-visible" },
  { file: "board/ThreadList.svelte", selector: ".thread-row", hover: ".thread-row:hover", focus: ".thread-row:focus-visible" },
  { file: "chat/messaging/BoardTab.svelte", selector: ".board-card", hover: ".board-card:hover", focus: ".board-card:focus-visible" },
  { file: "chat/messaging/RichMessageContent.svelte", selector: ".rich-stat-tile" },
  { file: "chat/messaging/RichMessageContent.svelte", selector: ".rich-chart" },
  { file: "chat/messaging/RichMessageContent.svelte", selector: ".rich-progress-track" },
  { file: "settings/CompaniesSettingsPane.svelte", selector: ".set-row" },
  { file: "settings/SettingsPage.svelte", selector: ".setting-row" },
  { file: "chat/MemberProfilePanel.svelte", selector: ".pp-field" },
];

describe("resting card outlines are transparent", () => {
  for (const card of CARDS) {
    describe(`${card.file} ${card.selector}`, () => {
      const css = styleOf(card.file);
      const base = decls(css, card.selector);

      it("keeps a 1px border, transparent at rest", () => {
        expect(base).toContainEqual(["border", "1px solid transparent"]);
        const visible = base.filter(
          ([prop, value]) => BORDER_PROPS.test(prop) && !isTransparent(value),
        );
        expect(visible).toEqual([]);
      });

      it("still has a visible fill, so the card does not vanish", () => {
        const fills = base.filter(([prop]) => prop === "background" || prop === "background-color");
        expect(fills.length).toBeGreaterThan(0);
        for (const [, value] of fills) {
          expect(value).not.toMatch(/^(transparent|none)$/);
        }
      });

      if (card.hover) {
        it("changes only the fill on hover", () => {
          const hover = decls(css, card.hover!);
          expect(hover.some(([prop]) => prop.startsWith("background"))).toBe(true);
          expect(hover.filter(([prop]) => BORDER_PROPS.test(prop))).toEqual([]);
        });
      }

      if (card.focus) {
        it("keeps its focus-visible outline", () => {
          const focus = decls(css, card.focus!);
          expect(focus.find(([prop]) => prop === "outline")?.[1]).toMatch(/^2px solid /);
        });
      }
    });
  }

  it("meeting rows are flat rows: no outline at rest, fill-only hover, no last-child rule", () => {
    const css = styleOf("meetings/MeetingsAgenda.svelte");
    const base = decls(css, ".meeting-row");
    const borders = base.filter(([prop]) => BORDER_PROPS.test(prop));
    expect(borders.length).toBeGreaterThan(0);
    for (const [, value] of borders) expect(isTransparent(value)).toBe(true);
    const hover = decls(css, ".meeting-row:not(.empty-row):hover");
    expect(hover.some(([prop]) => prop.startsWith("background"))).toBe(true);
    expect(hover.filter(([prop]) => BORDER_PROPS.test(prop))).toEqual([]);
    expect(
      decls(css, ".meeting-row:last-child").filter(([prop]) => BORDER_PROPS.test(prop)),
    ).toEqual([]);
  });

  it("semantic states still paint a border (selection)", () => {
    expect(decls(styleOf("board/BoardView.svelte"), ".board-card.selected")).toContainEqual([
      "border-color",
      "var(--line2)",
    ]);
    expect(decls(styleOf("chat/messaging/BoardTab.svelte"), ".board-card.selected")).toContainEqual([
      "border-color",
      "var(--line2)",
    ]);
  });

  it("inbox rows change only the fill on hover", () => {
    const hover = decls(styleOf("inbox/NotificationsView.svelte"), ".notif-row:hover");
    expect(hover).toContainEqual(["background", "var(--btn-bg)"]);
    expect(hover.filter(([prop]) => BORDER_PROPS.test(prop))).toEqual([]);
  });

  it("a read-only lifecycle value is an outline-free tile; the editable field keeps its border", () => {
    const css = styleOf("chat/messaging/LifecycleCard.svelte");
    expect(decls(css, ".lc-in-ro")).toContainEqual(["border-color", "transparent"]);
    expect(decls(css, ".lc-in")).toContainEqual(["border", "1px solid var(--line2, var(--pop-border))"]);
    expect(decls(css, ".lc-in")).toContainEqual(["background", "var(--raised, var(--pop-hover))"]);
  });
});
