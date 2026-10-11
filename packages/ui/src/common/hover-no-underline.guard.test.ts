/**
 * Owner feedback (2026-10-07): "I can still see some of the buttons have the
 * underline hover state. I don't like it." Hover never adds an underline
 * anywhere in the app; interactive text dims instead. Owner decision
 * (2026-10-08): text buttons carry no underline at rest either. Links inside
 * message and document prose (markdown, wikilinks) keep theirs.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOTS = [resolve(HERE, ".."), resolve(HERE, "../../../../apps/sync/src")];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(svelte|css)$/u.test(name)) out.push(p);
  }
  return out;
}

/** Every `selector { body }` whose selector mentions :hover and whose body sets an underline. */
function hoverUnderlines(css: string): string[] {
  const hits: string[] = [];
  for (const m of css.matchAll(/([^{}]*)\{([^{}]*)\}/gu)) {
    if (!m[1].includes(":hover")) continue;
    if (/text-decoration(-line)?\s*:\s*[^;]*underline/u.test(m[2])) hits.push(m[1].trim().split("\n").pop() ?? "");
  }
  return hits;
}

/** Text buttons: rules that set a pointer cursor and an underline, outside prose/markdown links. */
function underlinedTextButtons(css: string): string[] {
  const hits: string[] = [];
  for (const m of css.matchAll(/([^{}]*)\{([^{}]*)\}/gu)) {
    const sel = m[1].trim().split("\n").pop() ?? "";
    if (/markdown|wikilink/u.test(sel)) continue;
    if (/cursor\s*:\s*pointer/u.test(m[2]) && /text-decoration(-line)?\s*:\s*[^;]*underline/u.test(m[2])) hits.push(sel);
  }
  return hits;
}

function scan(find: (css: string) => string[]): string[] {
  const offenders: string[] = [];
  for (const root of ROOTS) {
    for (const file of walk(root)) {
      for (const hit of find(readFileSync(file, "utf8"))) {
        offenders.push(`${relative(resolve(HERE, "../../../.."), file)}: ${hit}`);
      }
    }
  }
  return offenders;
}

describe("hover never underlines", () => {
  it("has no :hover rule that sets an underline", () => {
    expect(scan(hoverUnderlines)).toEqual([]);
  });

  it("has no text button underlined at rest", () => {
    expect(scan(underlinedTextButtons)).toEqual([]);
  });

  it("the text-button guard spares prose links", () => {
    expect(underlinedTextButtons(".link { cursor: pointer; text-decoration: underline; }")).toHaveLength(1);
    expect(underlinedTextButtons(".markdown-body :global(.markdown-wikilink) { cursor: pointer; text-decoration: underline; }")).toHaveLength(0);
  });

  it("the guard catches a hover underline", () => {
    expect(hoverUnderlines(".a:hover { text-decoration: underline; }")).toHaveLength(1);
    expect(hoverUnderlines(".a:hover { opacity: 0.7; }")).toHaveLength(0);
  });

  it("the message author name dims on hover", () => {
    const css = readFileSync(resolve(HERE, "../chat/messaging/ChannelConversation.svelte"), "utf8");
    expect(css).toMatch(/button\.dm-msg-author-btn:hover\s*\{\s*opacity: 0\.7;/u);
  });
});
