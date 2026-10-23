import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Layout is not something happy-dom computes, so these contracts are read
// from the stylesheets.
const read = (file: string): string =>
  readFileSync(resolve(process.cwd(), "src/chat/messaging", file), "utf8");

describe("author tag on a name row", () => {
  // Owner, 2026-10-21: the BOT tag sat low beside the name. The name rows
  // align on the text baseline, and a tag's baseline is its small mono label,
  // so the tag has to be centred on the row instead.
  it.each([
    ["ChannelConversation.svelte", "dm-msg-meta"],
    ["ReplyPanel.svelte", "reply-meta"],
  ])("%s centres a tag on .%s", (file, row) => {
    const css = read(file);
    expect(css).toMatch(new RegExp(`\\.${row} \\{[^}]*align-items: baseline`));
    expect(css).toMatch(
      new RegExp(`\\.${row} > :global\\(\\.hq-tag\\) \\{[^}]*align-self: center`),
    );
  });
});

describe("message attachments row", () => {
  // Owner, 2026-10-21: a file card beside a screenshot stretched to the
  // image's height. Each attachment keeps its own height.
  it("does not stretch attachments to the tallest one", () => {
    const rule =
      read("MessageAttachments.svelte").match(/\n  \.msg-attachments \{([^}]*)\}/)?.[1] ?? "";
    expect(rule).toMatch(/display: flex/);
    expect(rule).toMatch(/align-items: flex-start/);
  });
});
