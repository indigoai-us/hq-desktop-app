// Regressions in the thread pane:
// 1. `.reply-send` hard-coded the dark theme's #c9d6e4 / #101014, so in light
//    mode the thread's Send button kept dark-mode colours while the main
//    composer's `.btn-send` followed the theme.
// 2. The message hover bar was shown on `:focus-within`, so a mouse click on
//    one of its buttons left it pinned over the row after the pointer left.
//    Its keyboard reveal must compile to a RAW `:has(:focus-visible)`: Svelte
//    scopes a plain `:has(:focus-visible)` to this component's own elements,
//    so focus on a button rendered by a child component (the emoji picker,
//    the reaction row) would not reveal the bar.
import { readFileSync } from "node:fs";
import { compile } from "svelte/compiler";
import { describe, expect, it } from "vitest";

const styleOf = (file: string) =>
  (
    readFileSync(new URL(file, import.meta.url), "utf8").split("<style>")[1] ??
    ""
  ).replace(/\/\*[\s\S]*?\*\//g, "");

const reply = styleOf("./ReplyPanel.svelte");
const main = styleOf("./ChannelConversation.svelte");

function rule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`));
  if (!match) throw new Error(`no rule for ${selector}`);
  return match[1];
}

const decl = (block: string, prop: string) =>
  block.match(new RegExp(`(?:^|;)\\s*${prop}:\\s*([^;]+);`))?.[1].trim();

describe("thread Send button follows the theme like the main composer", () => {
  it("uses the main composer's --ice-ink fill and --badge-fg ink", () => {
    const send = rule(reply, ".reply-send");
    const mainSend = rule(main, ".btn-send");
    expect(decl(send, "background")).toBe("var(--ice-ink)");
    expect(decl(send, "color")).toBe("var(--badge-fg)");
    expect(decl(send, "background")).toBe(decl(mainSend, "background"));
    expect(decl(send, "color")).toBe(decl(mainSend, "color"));
    expect(reply).not.toMatch(/#c9d6e4|#101014/i);
  });

  it("matches the main composer's hover and disabled states", () => {
    expect(decl(rule(reply, ".reply-send:hover:not(:disabled)"), "opacity")).toBe(
      decl(
        rule(
          main,
          '.btn-send:hover:not(:disabled):not(.is-idle):not([aria-disabled="true"])',
        ),
        "opacity",
      ),
    );
    const mainDisabled = main.match(
      /\.btn-send:disabled,[^{]*\{([^}]*)\}/,
    )?.[1] ?? "";
    expect(decl(rule(reply, ".reply-send:disabled"), "opacity")).toBe(
      decl(mainDisabled, "opacity"),
    );
  });
});

describe("thread hover bar does not stick after a mouse click", () => {
  it("never reveals a hover bar on :focus-within", () => {
    expect(reply).not.toMatch(/:focus-within\s+\.reply-quick-react/);
  });

  it("reveals the hover bars on keyboard focus via an unscoped :has(:focus-visible)", () => {
    const compiled = compile(
      readFileSync(new URL("./ReplyPanel.svelte", import.meta.url), "utf8"),
      { filename: "ReplyPanel.svelte", css: "external" },
    )
      .css!.code.replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\.svelte-[a-z0-9]+/g, "")
      .replace(/:where\(\)/g, "");
    const selectors = [...compiled.matchAll(/([^{}]+)\{/g)].flatMap((m) =>
      m[1].split(",").map((part) => part.replace(/\s+/g, " ").trim()),
    );
    for (const [row, bar] of [
      [".reply-row", ".reply-quick-react"],
      [".reply-root", ".reply-quick-react-root"],
    ]) {
      // Row focus reveals the bar, and focus inside the bar keeps it up.
      expect(selectors, row).toContain(`${row}:has(:focus-visible) ${bar}`);
      expect(selectors, bar).toContain(`${bar}:has(:focus-visible)`);
    }
    // A scoped inner selector would miss focus inside child components.
    expect(
      compile(
        readFileSync(new URL("./ReplyPanel.svelte", import.meta.url), "utf8"),
        { filename: "ReplyPanel.svelte", css: "external" },
      ).css!.code,
    ).not.toMatch(/:has\(:where\(\.svelte-[a-z0-9]+\):focus-visible\)|:has\(\.svelte-[a-z0-9]+:focus-visible\)/);
  });
});
