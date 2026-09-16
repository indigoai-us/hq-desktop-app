import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const replyPanel = readFileSync(
  new URL("./ReplyPanel.svelte", import.meta.url),
  "utf8",
);
const channelConversation = readFileSync(
  new URL("./ChannelConversation.svelte", import.meta.url),
  "utf8",
);

/** Pull the declarations of the first `@media (hover: none)` block that
 *  mentions `selector`, so the assertion is about the touch rule specifically
 *  and not about a hover rule that happens to contain the same text. */
function touchRuleFor(source: string, selector: string): string | undefined {
  const blocks = source.match(/@media \(hover: none\) \{[\s\S]*?\n {2}\}/g);
  return blocks?.find((block) => block.includes(`.${selector} {`));
}

describe("conversation pane captures clicks on a transparent macOS window", () => {
  it("gives the isolated conversation layer a hittable fill", () => {
    const block = channelConversation.match(/\.conversation \{[\s\S]*?\n {2}\}/);
    expect(block?.[0]).toContain("isolation: isolate;");
    expect(block?.[0]).toContain("pointer-events: auto;");
    expect(block?.[0]).toMatch(/color-mix\(in srgb, var\(--t1(?:, #111)?\) 1%, transparent\)/);
  });
});

describe("quick-react toolbar on touch input", () => {
  it.each([
    ["reply root", () => touchRuleFor(replyPanel, "reply-quick-react-root")],
    ["reply row", () => touchRuleFor(replyPanel, "reply-quick-react")],
    ["main chat", () => touchRuleFor(channelConversation, "dm-quick-react")],
  ])("keeps the %s toolbar reachable without hover", (_label, rule) => {
    // Touch screens never fire :hover, so a hover-only reveal makes the
    // reaction buttons impossible to reach on a touch device.
    const found = rule();
    expect(found).toBeDefined();
    expect(found).toContain("opacity: 1;");
    expect(found).toContain("pointer-events: auto;");
  });
});
