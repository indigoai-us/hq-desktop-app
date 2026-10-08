// Regression: the attachment preview sits on a dark scrim in BOTH themes, but
// its text used the themed `--t1`/`--t2`/`--t3` ink, which is near-black in
// light mode. The filename, size, close button, status and download icon were
// invisible. The ink must be fixed light.
//
// The lightbox rebuild folded the tray's own header (kicker + title + close)
// and its thumbnail strip into the preview's single bar, so the close button
// now wears the bar's `.att-preview-ic` style alongside download; the same
// guarantees are asserted on the selectors those elements moved to.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function css(file: string): string {
  const src = readFileSync(new URL(file, import.meta.url), "utf8");
  return (src.split("<style>")[1] ?? "").replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Declarations of the first rule whose selector list is exactly `selector`. */
function rule(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(
    new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`),
  );
  if (!match) throw new Error(`no rule for ${selector}`);
  return match[1];
}

function colorOf(source: string, selector: string): string | undefined {
  return rule(source, selector).match(/(?:^|;)\s*color:\s*([^;]+);/)?.[1].trim();
}

const preview = css("./AttachmentPreview.svelte");
const tray = css("./AttachmentTray.svelte");

describe("attachment preview ink on the dark scrim (light mode)", () => {
  it("defines fixed light ink on the preview root", () => {
    const root = rule(preview, ".att-preview");
    expect(root).toMatch(/--lb-ink:\s*#fff;/);
    expect(root).toMatch(/--lb-ink-mid:\s*rgba\(255, 255, 255, 0\.72\);/);
    expect(root).toMatch(/--lb-ink-dim:\s*rgba\(255, 255, 255, 0\.55\);/);
  });

  it("paints the preview title, meta and status with the fixed light ink", () => {
    expect(colorOf(preview, ".att-preview-name")).toBe("var(--lb-ink)");
    expect(colorOf(preview, ".att-preview-meta")).toBe("var(--lb-ink-dim)");
    expect(colorOf(preview, ".att-preview-status")).toBe("var(--lb-ink-mid)");
    // Download AND close (the tray's `trailing` snippet) share this rule.
    // `--lb-ink` is #fff, asserted on the root above — the same white the
    // old floating download button was painted.
    expect(
      colorOf(preview, ".att-preview-toolbar :global(.att-preview-ic)"),
    ).toBe("var(--lb-ink)");
  });

  it("paints the tray root, its empty-state close and empty text light", () => {
    const card = rule(tray, ".att-tray");
    expect(card).toMatch(/--lb-ink:\s*#fff;/);
    expect(card).toMatch(/--lb-ink-mid:\s*rgba\(255, 255, 255, 0\.72\);/);
    expect(card).toMatch(/--lb-ink-dim:\s*rgba\(255, 255, 255, 0\.55\);/);
    expect(colorOf(tray, ".att-tray")).toBe("var(--lb-ink)");
    expect(
      colorOf(tray, ".att-tray-empty-head :global(.att-preview-ic)"),
    ).toBe("var(--lb-ink)");
    expect(colorOf(tray, ".att-tray-empty")).toBe("var(--lb-ink-dim)");
  });

  it("uses the bar's fixed-ink icon style for the tray's close button", () => {
    const source = readFileSync(
      new URL("./AttachmentTray.svelte", import.meta.url),
      "utf8",
    );
    const close = source.match(
      /<button[^>]*data-testid="attachment-tray-close"[^>]*>/,
    )?.[0];
    expect(close).toContain('class="att-preview-ic"');
  });

  it("never reads the themed --t1/--t2/--t3 ink for a colour on the scrim", () => {
    for (const source of [preview, tray]) {
      expect(source).not.toMatch(/color:\s*var\(--t[123]\b/);
    }
  });
});
