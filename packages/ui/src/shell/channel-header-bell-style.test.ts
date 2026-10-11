/**
 * The channel header's notification button pairs with the members button
 * beside it (owner review 2026-10-09): the app's one icon tone (--t2, as the
 * sidebar's add, search and filter icons), kept on hover, and the caret 12px
 * in from the edge rather than against it.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const read = (file: string) => readFileSync(join(here, file), "utf8");
const block = (src: string, sel: string) => src.match(new RegExp(`\\n  ${sel.replace(/[.]/g, "\\.")} \\{([^}]*)\\}`))?.[1] ?? "";

describe("notification button matches the members button", () => {
  const bell = read("../chat/ChannelMuteControl.svelte");
  const app = read("DesktopApp.svelte");

  it("uses the app's icon tone and does not darken on hover", () => {
    expect(block(app, ".member-count-icon")).toContain("color: var(--t2);");
    expect(app).toMatch(/data-testid="channel-members"[\s\S]{0,700}<Caret tone="var\(--t2\)"/);
    expect(block(bell, ".mute-wrap")).toContain("color: var(--t2);");
    expect(read("../chat/messaging/ChannelConversation.svelte")).toMatch(/\n  \.dm-quick-react-btn \{[^}]*color: var\(--t2\);/);
    expect(bell).not.toMatch(/\.mute-(toggle|chevron):hover[^{]*\{[^}]*color:/);
  });

  // One icon size, icon gap, end padding and caret for every header button
  // (owner review 2026-10-09), read from the button standard.
  it("spaces icon, label and caret by the button standard, as the Launch pill", () => {
    const bar = read("../home/V4TitleBar.svelte");
    expect(block(app, ".member-count-btn")).toContain("gap: var(--hq-btn-gap);");
    expect(block(app, ".member-count-btn")).toContain("padding: 0 var(--hq-btn-pad-inline);");
    expect(bell).toMatch(/\n  \.mute-toggle \{[^}]*padding: 0 calc\(var\(--hq-btn-gap\) \/ 2\) 0 var\(--hq-btn-pad-inline\);/);
    expect(bell).toMatch(/\n  \.mute-chevron \{[^}]*padding: 0 var\(--hq-btn-pad-inline\) 0 calc\(var\(--hq-btn-gap\) \/ 2\);/);
    for (const src of [bar, app, bell]) expect(src).toContain('size="var(--hq-btn-caret)"');
    expect(bar).toContain('<Caret tone="var(--t2)" size="var(--hq-btn-caret)" />');
  });
});
